"""Create-only, fixed-identity Linux CLI staging; never execute staged binaries.

The SSH operator authorizes staging; there is deliberately no run RPC here.
Directory descriptor operations reject links, traversal and unknown ownership.
"""
import base64
import hashlib
import os
import platform
import pwd
import re
import signal
import stat
import sys
from stage_protocol import StageError, canonical_bytes, decode_json, envelope, read_frame, require, write_frame
from stage_fs_checks import run_checks

ASSETS = (
    {"path": "bin/claude", "bytes": 256113848, "sha256": "4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358", "mode": 0o555},
    {"path": "bin/grok", "bytes": 183493408, "sha256": "c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5", "mode": 0o555},
    {"path": "bin/socat", "bytes": 503584, "sha256": "04a9246f5c027f6f127acb9caf1ad960a640682e7ee2fdb8d05d95b56f927a1b", "mode": 0o555},
    {"path": "lib/libwrap.so.0", "bytes": 44144, "sha256": "959804509a16ed54797dc263ed3e0fe7caaf3d416f5197641db32956a056192c", "mode": 0o444},
    {"path": "notices/socat.txt", "bytes": 4931, "sha256": "9b611e7f1af31fe54f79e4dbf6c9e9a64fd341ecd677711f8b0e730ebc51da73", "mode": 0o444},
    {"path": "notices/libwrap0.txt", "bytes": 4285, "sha256": "3433ea51eb4b9272c97d159c5ae5e0d3f592bbf9fc946dac813e1594aa6fa16f", "mode": 0o444},
)
BUNDLE = {"schemaVersion": 1, "kind": "project-hub-private-cli-stage", "assets": list(ASSETS),
          "providers": {"claude": "2.1.295", "grok": "1.0.50"},
          "grokPublisherSignatureVerified": False,
          "grokTrustLimit": "Official HTTPS artifacts and observed SHA-256 consistency; no independent publisher signature or source-build attestation.",
          "providerReady": False}
BUNDLE_SHA = hashlib.sha256(canonical_bytes(BUNDLE)).hexdigest()
PROGRAM = "project-hub-private-cli-stage-v1"
CHUNK_LIMIT = 256 * 1024
PERSISTENT_LIMIT = 8 * 1024**3


def identity(metadata):
    return {"device": metadata.st_dev, "inode": metadata.st_ino, "uid": metadata.st_uid}


def directory_ok(metadata, *, private=False):
    require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.geteuid()
            and not metadata.st_mode & 0o022, "DIRECTORY_OWNER_OR_MODE_REJECTED")
    if private:
        require(stat.S_IMODE(metadata.st_mode) == 0o700, "PRIVATE_DIRECTORY_MODE_REJECTED")


def open_child_directory(parent, name, *, create=False, private=False):
    require(type(name) is str and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name)
            and name not in (".", ".."), "DIRECTORY_NAME_REJECTED")
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        directory_ok(os.fstat(descriptor), private=private)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def write_new(parent, name, data, mode=0o444):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        position = 0
        while position < len(data):
            written = os.write(descriptor, data[position:])
            require(written > 0, "FILE_WRITE_FAILED")
            position += written
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        return identity(os.fstat(descriptor))
    finally:
        os.close(descriptor)
        os.fsync(parent)


def read_small(parent, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.geteuid()
                and metadata.st_nlink == 1 and metadata.st_size <= 16384, "OWNERSHIP_RECEIPT_INVALID")
        return decode_json(os.read(descriptor, 16385))
    finally:
        os.close(descriptor)


def owned_usage(directory, budget=None):
    if budget is None:
        budget = [4096, 0]
    for name in os.listdir(directory):
        budget[0] -= 1
        require(budget[0] >= 0 and name not in (".", "..") and "/" not in name
                and "\0" not in name, "PRIVATE_TREE_BOUND")
        metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
        require(metadata.st_uid == os.geteuid() and not metadata.st_mode & 0o022,
                "PRIVATE_TREE_OWNER_REJECTED")
        if stat.S_ISDIR(metadata.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                require(identity(os.fstat(child)) == identity(metadata), "PRIVATE_TREE_CHANGED")
                owned_usage(child, budget)
            finally:
                os.close(child)
        else:
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1,
                    "PRIVATE_TREE_LINK_OR_TYPE_REJECTED")
            budget[1] += metadata.st_size
            require(budget[1] <= PERSISTENT_LIMIT, "PERSISTENT_QUOTA_REJECTED")
    return budget[1]


def open_root(home):
    home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = [home_fd]
    try:
        directory_ok(os.fstat(home_fd))
        local = open_child_directory(home_fd, ".local", create=True)
        opened.append(local)
        share = open_child_directory(local, "share", create=True)
        opened.append(share)
        new = False
        try:
            os.mkdir("project-hub-worker", 0o700, dir_fd=share)
            os.fsync(share)
            new = True
        except FileExistsError:
            pass
        root = open_child_directory(share, "project-hub-worker", private=True)
        root_identity = identity(os.fstat(root))
        receipt = {"schemaVersion": 1, "program": PROGRAM, "rootIdentity": root_identity}
        try:
            if new:
                write_new(root, "ownership.json", canonical_bytes(receipt))
            else:
                require(read_small(root, "ownership.json") == receipt, "EXISTING_ROOT_UNOWNED")
            # Verify the named entry still resolves to the held root object.
            require(identity(os.stat("project-hub-worker", dir_fd=share, follow_symlinks=False))
                    == root_identity, "ROOT_IDENTITY_CHANGED")
            return root, root_identity
        except BaseException:
            os.close(root)
            raise
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def admission(home):
    require(sys.platform == "linux" and os.geteuid() != 0 and platform.machine() == "x86_64",
            "NONROOT_LINUX_X64_REQUIRED")
    memory = {}
    with open("/proc/meminfo", encoding="ascii") as stream:
        for line in stream:
            name, value = line.split(":", 1)
            if name == "MemAvailable":
                memory[name] = int(value.split()[0]) * 1024
    require(memory.get("MemAvailable", 0) >= 10 * 1024**3, "MEMORY_ADMISSION_REJECTED")
    disk = os.statvfs(home)
    require(disk.f_bavail * disk.f_frsize >= 20 * 1024**3, "DISK_ADMISSION_REJECTED")
    version = os.confstr("CS_GNU_LIBC_VERSION")
    match = re.fullmatch(r"glibc (\d+)\.(\d+)", version or "")
    require(match is not None and tuple(map(int, match.groups())) >= (2, 42), "GLIBC_VERSION_REJECTED")
    libraries = {}
    for name in ("libssl.so.3", "libcrypto.so.3"):
        filename = "/usr/lib/x86_64-linux-gnu/" + name
        descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            metadata = os.fstat(descriptor)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0
                    and not metadata.st_mode & 0o022 and metadata.st_size <= 32 * 1024**2,
                    "SYSTEM_LIBRARY_IDENTITY_REJECTED")
            with os.fdopen(os.dup(descriptor), "rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            libraries[name] = {"sha256": digest, "bytes": metadata.st_size, **identity(metadata)}
        finally:
            os.close(descriptor)
    return {"glibc": version, "availableMemoryBytes": memory["MemAvailable"],
            "availableDiskBytes": disk.f_bavail * disk.f_frsize, "libraries": libraries}


def receive_asset(stream_in, stream_out, directory, asset, nonce, sequence, home):
    first = read_frame(stream_in)
    envelope(first, nonce=nonce, sequence=sequence, operation="file-begin", fields=("path",))
    require(first["path"] == asset["path"], "ASSET_ORDER_OR_PATH_REJECTED")
    descriptor = os.open(asset["path"].split("/")[1], os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
    total = 0
    digest = hashlib.sha256()
    sequence += 1
    write_frame(stream_out, {"op": "file-ready", "sequence": sequence - 1, "path": asset["path"], "nonce": nonce})
    try:
        while total < asset["bytes"]:
            message = read_frame(stream_in)
            envelope(message, nonce=nonce, sequence=sequence, operation="file-chunk", fields=("data",))
            require(type(message["data"]) is str and len(message["data"]) <= 4 * ((CHUNK_LIMIT + 2) // 3),
                    "CHUNK_BYTE_BOUND")
            try:
                data = base64.b64decode(message["data"], validate=True)
            except (ValueError, UnicodeError) as error:
                raise StageError("CHUNK_ENCODING_INVALID") from error
            require(0 < len(data) <= CHUNK_LIMIT and total + len(data) <= asset["bytes"], "ASSET_BYTE_BOUND")
            # write() can return short writes; hash only once after all bytes land.
            position = 0
            while position < len(data):
                written = os.write(descriptor, data[position:])
                require(written > 0, "FILE_WRITE_FAILED")
                position += written
            digest.update(data)
            total += len(data)
            if total // (16 * 1024**2) != (total - len(data)) // (16 * 1024**2):
                admission(home)
            write_frame(stream_out, {"op": "chunk-accepted", "sequence": sequence, "nonce": nonce,
                                     "receivedBytes": total})
            sequence += 1
        require(digest.hexdigest() == asset["sha256"], "ASSET_DIGEST_REJECTED")
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
                and metadata.st_uid == os.geteuid() and metadata.st_size == asset["bytes"], "ASSET_IDENTITY_REJECTED")
        os.lseek(descriptor, 0, os.SEEK_SET)
        with os.fdopen(os.dup(descriptor), "rb") as verification:
            require(hashlib.file_digest(verification, "sha256").hexdigest() == asset["sha256"], "ASSET_READBACK_REJECTED")
        os.fchmod(descriptor, asset["mode"])
        os.fsync(descriptor)
        os.fsync(directory)
        write_frame(stream_out, {"op": "file-verified", "sequence": sequence - 1,
                                 "nonce": nonce, "path": asset["path"], "sha256": asset["sha256"]})
        return sequence, {"path": asset["path"], "sha256": asset["sha256"],
                          "bytes": total, **identity(os.fstat(descriptor))}
    finally:
        os.close(descriptor)


def serve(stream_in, stream_out):
    require(sys.platform == "linux", "LINUX_REQUIRED")
    signal.alarm(540)
    os.umask(0o077)
    hello = read_frame(stream_in)
    nonce = hello.get("nonce")
    require(type(nonce) is str and re.fullmatch(r"[a-f0-9]{64}", nonce), "NONCE_INVALID")
    envelope(hello, nonce=nonce, sequence=1, operation="hello", fields=("bundleSHA256",))
    require(hello["bundleSHA256"] == BUNDLE_SHA, "BUNDLE_IDENTITY_REJECTED")
    home = pwd.getpwuid(os.geteuid()).pw_dir
    baseline = admission(home)
    boot_id = open("/proc/sys/kernel/random/boot_id", encoding="ascii").read().strip()
    require(re.fullmatch(r"[a-f0-9-]{36}", boot_id), "BOOT_ID_INVALID")
    write_frame(stream_out, {"op": "hello", "sequence": 1, "nonce": nonce, "protocol": 1,
                             "bundleSHA256": BUNDLE_SHA, "bootId": boot_id, "uid": os.geteuid(),
                             "home": home, "baseline": baseline, "providerReady": False})
    begin = read_frame(stream_in)
    envelope(begin, nonce=nonce, sequence=2, operation="begin", fields=("bundleSHA256",))
    require(begin["bundleSHA256"] == BUNDLE_SHA, "BUNDLE_IDENTITY_REJECTED")
    admission(home)
    root, root_identity = open_root(home)
    opened = [root]
    try:
        filesystem_checks = run_checks(root, nonce, globals())
        releases = open_child_directory(root, "releases", create=True, private=True)
        opened.append(releases)
        require(owned_usage(root) + sum(asset["bytes"] for asset in ASSETS) + 1024**2
                <= PERSISTENT_LIMIT, "PERSISTENT_QUOTA_REJECTED")
        # A failed attempt is preserved; a fresh attempt never overwrites it.
        release_id = "sha256-" + BUNDLE_SHA + "-" + nonce[:16]
        os.mkdir(release_id, 0o700, dir_fd=releases)
        os.fsync(releases)
        release = open_child_directory(releases, release_id, private=True)
        opened.append(release)
        write_new(release, "intent.json", canonical_bytes({"schemaVersion": 1, "bundleSHA256": BUNDLE_SHA,
                    "nonce": nonce, "bootId": boot_id, "rootIdentity": root_identity, "state": "receiving"}))
        folders = {}
        for name in ("bin", "lib", "notices"):
            folder = open_child_directory(release, name, create=True, private=True)
            folders[name] = folder
            opened.append(folder)
        write_frame(stream_out, {"op": "stage-ready", "sequence": 2, "nonce": nonce,
                    "rootIdentity": root_identity, "releaseIdentity": identity(os.fstat(release)), "releaseId": release_id,
                    "filesystemChecks": filesystem_checks})
        sequence = 3
        verified = []
        for asset in ASSETS:
            sequence, row = receive_asset(stream_in, stream_out, folders[asset["path"].split("/")[0]], asset, nonce, sequence, home)
            verified.append(row)
        commit = read_frame(stream_in)
        envelope(commit, nonce=nonce, sequence=sequence, operation="commit", fields=("bundleSHA256",))
        require(commit["bundleSHA256"] == BUNDLE_SHA and identity(os.fstat(root)) == root_identity,
                "COMMIT_IDENTITY_REJECTED")
        require(identity(os.stat(release_id, dir_fd=releases, follow_symlinks=False))
                == identity(os.fstat(release)), "RELEASE_IDENTITY_CHANGED")
        require(owned_usage(root) <= PERSISTENT_LIMIT, "PERSISTENT_QUOTA_REJECTED")
        admission(home)
        receipt = {"schemaVersion": 1, "bundleSHA256": BUNDLE_SHA, "bundle": BUNDLE,
                   "bootId": boot_id, "rootIdentity": root_identity, "releaseIdentity": identity(os.fstat(release)),
                   "files": verified, "stageComplete": True, "providerReady": False,
                   "binariesExecuted": False, "providerAuthRead": False, "modelsInvoked": False,
                   "filesystemChecks": filesystem_checks}
        write_new(release, "manifest.json", canonical_bytes(receipt))
        for folder in folders.values():
            os.fchmod(folder, 0o555)
            os.fsync(folder)
        os.fchmod(release, 0o555)
        os.fsync(release)
        os.fsync(releases)
        write_frame(stream_out, {"op": "stage-complete", "sequence": sequence, "nonce": nonce,
                     "receipt": receipt, "receiptSHA256": hashlib.sha256(canonical_bytes(receipt)).hexdigest()})
        return 0
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def main():
    try:
        return serve(sys.stdin.buffer, sys.stdout.buffer)
    except StageError as error:
        write_frame(sys.stdout.buffer, {"op": "error", "code": error.code, "stageComplete": False,
                                        "providerReady": False, "partialMayExist": True})
        return 1
    except (OSError, ValueError, KeyError, UnicodeError):
        write_frame(sys.stdout.buffer, {"op": "error", "code": "PRIVATE_STAGE_FAILED", "stageComplete": False,
                                        "providerReady": False, "partialMayExist": True})
        return 1


if __name__ == "__main__":
    sys.exit(main())
