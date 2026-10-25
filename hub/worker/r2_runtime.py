"""Linux held-descriptor, private lease and bounded process primitives for R2."""
try:
    import fcntl
except ImportError:  # Portable contract tests; execution still requires Linux.
    fcntl = None
import hashlib
import ctypes
import errno
import os
import posixpath
try:
    import pwd
except ImportError:  # Windows can inspect/test contracts, never open Linux roots.
    pwd = None
import re
import select
import secrets
import stat
import subprocess
import time
from stage_protocol import canonical_bytes, decode_json, require


def identity(meta):
    return {"device": meta.st_dev, "inode": meta.st_ino, "uid": meta.st_uid}


def resolve_tool_link(current, target):
    require(type(current) is str and type(target) is str and "\0" not in target,
            "R2_RUNTIME_LINK_ESCAPED")
    resolved = posixpath.normpath(target if target.startswith("/") else current + "/" + target)
    require(resolved == "/usr" or resolved.startswith("/usr/"), "R2_RUNTIME_LINK_ESCAPED")
    return resolved


def owned_usage(directory, budget=None, depth=0):
    if budget is None:
        budget = [4096, 0]
    require(depth <= 16, "R2_PRIVATE_TREE_BOUND")
    for name in os.listdir(directory):
        budget[0] -= 1
        require(budget[0] >= 0 and name not in (".", "..") and "/" not in name, "R2_PRIVATE_TREE_BOUND")
        metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
        require(metadata.st_uid == os.geteuid() and not metadata.st_mode & 0o022,
                "R2_PRIVATE_OWNER_REJECTED")
        if stat.S_ISDIR(metadata.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                require(identity(os.fstat(child)) == identity(metadata), "R2_PRIVATE_TREE_CHANGED")
                owned_usage(child, budget, depth + 1)
            finally:
                os.close(child)
        else:
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
                    "R2_PRIVATE_LINK_OR_TYPE_REJECTED")
            budget[1] += metadata.st_size
            require(budget[1] + 256 * 1024 <= 8 * 1024**3, "R2_PERSISTENT_QUOTA_REJECTED")
    return budget[1]


def read_fd(fd, maximum=32768):
    meta = os.fstat(fd)
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_size <= maximum,
            "R2_FILE_METADATA_REJECTED")
    os.lseek(fd, 0, os.SEEK_SET)
    value = os.read(fd, maximum + 1)
    require(len(value) == meta.st_size, "R2_FILE_CHANGED")
    return value


def read_at(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        meta = os.fstat(fd)
        require(meta.st_uid == os.geteuid() and not meta.st_mode & 0o022, "R2_FILE_OWNER_REJECTED")
        return read_fd(fd)
    finally:
        os.close(fd)


def create_at(parent, name, data):
    require(re.fullmatch(r"[a-z0-9.-]{1,100}", name) and name not in (".", "..")
            and type(data) is bytes and len(data) <= 32768, "R2_CREATE_INPUT_REJECTED")
    temporary = "." + name + ".pending-" + secrets.token_hex(8)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        at = 0
        while at < len(data):
            count = os.write(fd, data[at:])
            require(count > 0, "R2_WRITE_FAILED")
            at += count
        os.fchmod(fd, 0o400)
        os.fsync(fd)
    finally:
        os.close(fd)
        os.fsync(parent)
    publish_new(parent, temporary, name)
    os.fsync(parent)
    require(read_at(parent, name) == data, "R2_WRITE_READBACK_REJECTED")


def publish_new(parent, temporary, name):
    """Linux create-only publication; a failed rename leaves the owned temp."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    require(rename is not None, "R2_ATOMIC_PUBLICATION_UNAVAILABLE")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    outcome = rename(parent, temporary.encode("ascii"), parent, name.encode("ascii"), 1)
    if outcome != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(error, "R2_CREATE_ONLY_TARGET_EXISTS")
        raise OSError(error, "R2_CREATE_ONLY_PUBLICATION_FAILED")


def open_dir(parent, name, *, uid, private=False, create=False):
    require(type(name) is str and name not in ("", ".", "..") and "/" not in name
            and "\0" not in name, "R2_DIRECTORY_NAME_REJECTED")
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        meta = os.fstat(fd)
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == uid and not meta.st_mode & 0o022
                and (not private or stat.S_IMODE(meta.st_mode) == 0o700), "R2_DIRECTORY_OWNER_REJECTED")
        require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity(meta),
                "R2_DIRECTORY_CHANGED")
        return fd
    except BaseException:
        os.close(fd)
        raise


class RuntimePin:
    """Keep component/link/target identities open; permit only /usr resolutions."""
    def __init__(self):
        self.fds, self.observations, self.tools = [], [], {}

    def open(self, original, *, directory=False):
        require(original == "/usr" or original.startswith("/usr/"), "R2_RUNTIME_PATH_REJECTED")
        pending, links = original, 0
        while True:
            root = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.fds.append(root)
            root_meta = os.fstat(root)
            require(root_meta.st_uid == 0 and not root_meta.st_mode & 0o022, "R2_RUNTIME_OWNER_REJECTED")
            parent, current, restart = root, "", False
            parts = pending[1:].split("/")
            require(all(re.fullmatch(r"[A-Za-z0-9._+@-]{1,255}", p) and p not in (".", "..") for p in parts),
                    "R2_RUNTIME_PATH_REJECTED")
            for index, name in enumerate(parts):
                meta = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(meta.st_uid == 0, "R2_RUNTIME_OWNER_REJECTED")
                if stat.S_ISLNK(meta.st_mode):
                    links += 1
                    require(links <= 16, "R2_RUNTIME_LINK_BOUND")
                    fd = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
                    self.fds.append(fd)
                    require(identity(os.fstat(fd)) == identity(meta), "R2_RUNTIME_CHANGED")
                    target = os.readlink(name, dir_fd=parent)
                    resolved = resolve_tool_link(current, target)
                    self.observations.append((parent, name, fd, identity(meta)))
                    pending = resolved + ("/" + "/".join(parts[index + 1:]) if index + 1 < len(parts) else "")
                    restart = True
                    break
                is_directory = index < len(parts) - 1 or directory
                require(not meta.st_mode & 0o022 and (stat.S_ISDIR(meta.st_mode) if is_directory
                        else stat.S_ISREG(meta.st_mode) and not meta.st_mode & 0o6000), "R2_RUNTIME_TYPE_REJECTED")
                flags = os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if is_directory else 0)
                fd = os.open(name, flags, dir_fd=parent)
                self.fds.append(fd)
                require(identity(os.fstat(fd)) == identity(meta), "R2_RUNTIME_CHANGED")
                self.observations.append((parent, name, fd, identity(meta)))
                parent, current = fd, current + "/" + name
            if not restart:
                if not directory:
                    meta = os.fstat(parent)
                    require(meta.st_size <= 64 * 1024**2, "R2_RUNTIME_BINARY_BOUND")
                    with os.fdopen(os.dup(parent), "rb") as stream:
                        digest = hashlib.file_digest(stream, "sha256").hexdigest()
                    self.tools[original] = {"resolved": current, "fd": parent, "sha256": digest,
                                            **identity(meta)}
                return parent

    def verify(self):
        for parent, name, fd, expected in self.observations:
            require(identity(os.fstat(fd)) == expected
                    and identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected,
                    "R2_RUNTIME_CHANGED")

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()


class PrivateState:
    def __init__(self, *, controller=True):
        self.fds, self.active_bytes, self.run_fd, self.root_fd = [], None, None, None
        try:
            self._open(controller)
        except BaseException:
            self.close()
            raise

    def _open(self, controller):
        require(fcntl is not None and pwd is not None, "R2_LINUX_REQUIRED")
        uid = os.geteuid()
        home = pwd.getpwuid(uid).pw_dir
        require(home.startswith("/") and "\0" not in home and posixpath.normpath(home) == home,
                "R2_HOME_REJECTED")
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fds.append(fd)
        for part in home[1:].split("/"):
            meta = os.stat(part, dir_fd=fd, follow_symlinks=False)
            require(meta.st_uid in (0, uid), "R2_HOME_OWNER_REJECTED")
            fd = open_dir(fd, part, uid=meta.st_uid)
            self.fds.append(fd)
        require(os.fstat(fd).st_uid == uid, "R2_HOME_OWNER_REJECTED")
        self.home = home
        for part in (".local", "share", "project-hub-worker"):
            fd = open_dir(fd, part, uid=uid, private=part == "project-hub-worker")
            self.fds.append(fd)
        expected = {"schemaVersion": 1, "program": "project-hub-private-cli-stage-v1",
                    "rootIdentity": identity(os.fstat(fd))}
        require(read_at(fd, "ownership.json") == canonical_bytes(expected), "R2_EXISTING_WORKER_UNOWNED")
        self.worker_fd = fd
        created = False
        if controller:
            try:
                os.mkdir("r2", 0o700, dir_fd=fd)
                os.fsync(fd)
                created = True
            except FileExistsError:
                pass
        fd = open_dir(fd, "r2", uid=uid, private=True)
        self.fds.append(fd)
        self.root_fd = fd
        receipt = canonical_bytes({"schemaVersion": 1, "program": "project-hub-r2-state-v1",
                                   "rootIdentity": identity(os.fstat(fd))})
        if created:
            create_at(fd, "ownership.json", receipt)
        require(read_at(fd, "ownership.json") == receipt, "R2_EXISTING_STATE_UNOWNED")
        if controller:
            lock = os.open("controller.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            self.fds.append(lock)
            meta = os.fstat(lock)
            require(stat.S_ISREG(meta.st_mode) and meta.st_uid == uid and meta.st_nlink == 1
                    and stat.S_IMODE(meta.st_mode) == 0o600, "R2_LOCK_METADATA_REJECTED")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.runs_fd = open_dir(fd, "runs", uid=uid, private=True, create=controller)
        self.fds.append(self.runs_fd)

    def open_run(self, nonce):
        require(type(nonce) is str and re.fullmatch(r"[a-f0-9]{64}", nonce), "R2_NONCE_REJECTED")
        self.run_fd = open_dir(self.runs_fd, nonce, uid=os.geteuid(), private=True)
        self.fds.append(self.run_fd)
        return self.run_fd

    def begin(self, request):
        # An unknown prior lease is never reclaimed on guessed PID/age alone.
        try:
            os.stat("active.json", dir_fd=self.root_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            require(False, "R2_ACTIVE_OR_UNKNOWN_LEASE")
        owned_usage(self.worker_fd)
        require(len(os.listdir(self.runs_fd)) < 4096, "R2_JOURNAL_COUNT_BOUND")
        os.mkdir(request["nonce"], 0o700, dir_fd=self.runs_fd)
        os.fsync(self.runs_fd)
        self.open_run(request["nonce"])
        intent = {"request": request, "state": "preparing", "rootIdentity": identity(os.fstat(self.root_fd)),
                  "runIdentity": identity(os.fstat(self.run_fd))}
        create_at(self.run_fd, "intent.json", canonical_bytes(intent))
        self.active_bytes = canonical_bytes(intent)
        create_at(self.root_fd, "active.json", self.active_bytes)
        self.run_path = self.home + "/.local/share/project-hub-worker/r2/runs/" + request["nonce"]

    def finish(self, result):
        if self.run_fd is not None:
            create_at(self.run_fd, "result.json", canonical_bytes({**result,
                       "completionState": "lease-release-pending"}))
        if (result.get("cleanup", {}).get("cleanupVerified") is True
                or result.get("notStartedConfirmed") is True) and self.active_bytes is not None:
            require(read_at(self.root_fd, "active.json") == self.active_bytes, "R2_LEASE_CHANGED")
            os.unlink("active.json", dir_fd=self.root_fd)
            os.fsync(self.root_fd)
            create_at(self.run_fd, "closed.json", canonical_bytes({**result, "completionState": "closed"}))

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()


def admission(home):
    with open("/proc/meminfo", encoding="ascii") as stream:
        rows = dict(row.split(":", 1) for row in stream if ":" in row)
    available = int(rows["MemAvailable"].split()[0]) * 1024
    disk = os.statvfs(home)
    free = disk.f_bavail * disk.f_frsize
    require(available >= 10 * 1024**3 and free >= 20 * 1024**3, "R2_ADMISSION_REJECTED")
    return {"availableMemoryBytes": available, "availableDiskBytes": free}


def proc_identity(pid):
    with open("/proc/" + str(pid) + "/stat", encoding="ascii") as stream:
        text = stream.read(8192)
    fields = text[text.rfind(")") + 2:].split()
    return {"pid": pid, "startTicks": int(fields[19]), "state": fields[0]}


def bounded_command(argv, env, *, timeout=3, executable_fd=None):
    require(type(executable_fd) is int and executable_fd >= 0, "R2_EXECUTABLE_FD_REQUIRED")
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env, close_fds=True,
                             executable="/proc/self/fd/" + str(executable_fd),
                             pass_fds=(executable_fd,))
    stdout, stderr = bytearray(), bytearray()
    streams = {child.stdout.fileno(): (child.stdout, stdout), child.stderr.fileno(): (child.stderr, stderr)}
    deadline = time.monotonic() + timeout
    try:
        while streams:
            require(time.monotonic() < deadline, "R2_TOOL_DEADLINE")
            readable, _, _ = select.select(list(streams), [], [], max(0, min(0.1, deadline - time.monotonic())))
            for fd in readable:
                stream, data = streams[fd]
                part = os.read(fd, 4096)
                if part:
                    data.extend(part)
                    require(len(stdout) + len(stderr) <= 32768, "R2_TOOL_OUTPUT_BOUND")
                else:
                    stream.close()
                    del streams[fd]
        code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
        return subprocess.CompletedProcess(argv, code, bytes(stdout), bytes(stderr))
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=2)
        child.stdout.close()
        child.stderr.close()
