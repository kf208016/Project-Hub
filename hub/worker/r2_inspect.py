"""One fixed, read-only R2 inspection; independently bundled, never a controller.

The loader injects EXPECTED_BINDING and DIAGNOSTIC_CATALOG_SHA256. No paths,
commands, source, environment, or provider choices are accepted on the wire.
Only the directly spawned, unreaped systemctl inspection child may be killed
and reaped on a deadline/overflow. Existing units and other processes are never
stopped or signalled. Historical cleanup is always unknown, including when a
current cgroup happens to be empty. Multiple reads are not an atomic snapshot.
"""
import hashlib
import os
import posixpath
try:
    import pwd
except ImportError:
    pwd = None
import re
import select
import signal
import stat
import struct
import subprocess
import sys
import time

from stage_protocol import StageError, canonical_bytes, decode_json, read_exact, require

EXPECTED_BINDING = None
DIAGNOSTIC_CATALOG_SHA256 = None
MAX_JSON = 32768
MAX_TOTAL = 327680
MAX_OUTPUT = 131072
DEADLINE_SECONDS = 45
NAMES = ("intent.json", "runtime.json", "unit.json", "service-kernel.json",
         "execution-gate.json", "service-error.json", "measurement.json", "result.json",
         "closed.json", "active.json")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
BOOT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
PROPERTIES = ("LoadState", "ActiveState", "SubState", "InvocationID", "MainPID",
              "ControlGroup", "ExecMainCode", "ExecMainStatus", "Result")
LOAD_STATES = ("loaded", "not-found", "error", "masked", "stub", "merged")
ACTIVE_STATES = ("active", "reloading", "inactive", "failed", "activating", "deactivating",
                 "maintenance", "refreshing")
SUB_STATES = ("dead", "condition", "start-pre", "start", "start-post", "running", "exited",
              "reload", "reload-signal", "reload-notify", "stop", "stop-watchdog", "stop-sigterm",
              "stop-sigkill", "stop-post", "final-watchdog", "final-sigterm", "final-sigkill",
              "failed", "auto-restart", "auto-restart-queued", "cleaning")
UNIT_RESULTS = ("success", "resources", "protocol", "timeout", "exit-code", "signal",
                "core-dump", "watchdog", "start-limit-hit", "oom-kill", "exec-condition", "skip-condition")
STATUSES = ("valid", "missing", "rejected", "changed", "unread", "unknown")
CODES = ("OK", "NOT_READ", "MISSING", "JSON_REJECTED", "SCHEMA_REJECTED", "BINDING_REJECTED",
         "METADATA_REJECTED", "IDENTITY_CHANGED", "CONTENT_CHANGED", "SIZE_BOUND", "TOTAL_BOUND",
         "IO_REJECTED", "LINUX_REQUIRED", "ROOT_REJECTED", "DEADLINE", "REQUEST_REJECTED",
         "REQUEST_EXPIRED", "BOOT_REJECTED", "UID_REJECTED", "RECEIPT_REJECTED", "LEASE_REJECTED",
         "RUNTIME_REJECTED", "TOOL_FAILED", "TOOL_OUTPUT_BOUND", "UNIT_REJECTED", "UNIT_MISSING",
         "SAVED_IDENTITY_UNAVAILABLE", "UNIT_IDENTITY_CHANGED", "CGROUP_REJECTED", "CGROUP_MISSING",
         "CGROUP_IDENTITY_CHANGED", "INSPECTION_FAILED", "PARTIAL", "OUTPUT_REJECTED")
# Fixed reviewed vocabulary. An unrecognized recorded code rejects that record;
# it is never echoed or included in an exception message in the wire response.
RECORDED_CODES = tuple("""R2_UNIT_IDENTITY_CHANGED R2_OPERATION_FAILED R2_SERVICE_FAILED
R2_BOOT_CHANGED R2_CAPABILITIES_REJECTED R2_CASE_FAILED R2_CGROUP_EVENTS_REJECTED
R2_CGROUP_IDENTITY_CHANGED R2_CGROUP_IDENTITY_REJECTED R2_CGROUP_PATH_CHANGED
R2_CGROUP_V2_REQUIRED R2_CLEANUP_UNKNOWN R2_CONTROLLER_DISCONNECTED R2_CONTROLLER_NOT_READING
R2_DIRECTORY_CHANGED R2_DIRECTORY_OWNER_REJECTED R2_EXECUTION_GATE_EXPIRED
R2_EXECUTION_GATE_REJECTED R2_EXTRA_FD_REJECTED R2_FILE_CHANGED R2_FILE_METADATA_REJECTED
R2_FILE_OWNER_REJECTED R2_FORBIDDEN_PATH_VISIBLE R2_KERNEL_GATE_BINDING_REJECTED
R2_KERNEL_GATE_UNAVAILABLE R2_KERNEL_LIMITS_REJECTED R2_MEASUREMENT_REJECTED
R2_NAMESPACE_REJECTED R2_NETWORK_NAMESPACE_REJECTED R2_PARENT_DEATH_GUARD_FAILED
R2_PARENT_IDENTITY_REJECTED R2_READONLY_RUNTIME_REJECTED R2_REMOTE_DEADLINE
R2_RESULT_PERSISTENCE_FAILED R2_RUNTIME_CHANGED R2_RUNTIME_LINK_ESCAPED
R2_RUNTIME_OWNER_REJECTED R2_RUNTIME_PATH_REJECTED R2_RUNTIME_TYPE_REJECTED
R2_SANDBOX_DEADLINE R2_SANDBOX_FAILED R2_SANDBOX_OUTPUT_BOUND R2_SANDBOX_RESULT_REJECTED
R2_SANDBOX_UID_REJECTED R2_SERVICE_BINDING_REJECTED R2_SERVICE_COMMAND_REJECTED
R2_SERVICE_CONFIGURATION_REJECTED R2_SERVICE_EXECUTABLE_REJECTED R2_SERVICE_INTENT_CHANGED
R2_SERVICE_INVOCATION_REJECTED R2_SERVICE_PROCESS_REJECTED R2_SERVICE_PROCESS_REUSED
R2_SERVICE_PROGRAM_BOUND R2_SERVICE_ROOT_CHANGED R2_SYNTHETIC_READBACK R2_SYNTHETIC_WRITE
R2_SYSTEMD_OUTPUT_BOUND R2_SYSTEMD_PROPERTIES_REJECTED R2_SYSTEMD_QUERY_FAILED
R2_TMPFS_LIMIT_REJECTED R2_TOOL_DEADLINE R2_TOOL_OUTPUT_BOUND R2_UNIT_IDENTITY_UNAVAILABLE
R2_UNIT_KILL_FAILED R2_UNIT_START_FAILED R2_UNIT_STOP_FAILED R2_WRITE_FAILED
R2_WRITE_READBACK_REJECTED R2_CREATE_ONLY_PUBLICATION_FAILED R2_CREATE_ONLY_TARGET_EXISTS
R2_CREATE_INPUT_REJECTED R2_ATOMIC_PUBLICATION_UNAVAILABLE""".split())
FACT_KEYS = ("bindingMatches", "recordedCode", "recordedOk", "recordedCleanupVerified",
             "completionState", "recordedGuardPassed", "measurementShapeValid", "invocationId",
             "pid", "startTicks", "cgroupPathSHA256")


def check(condition, code="SCHEMA_REJECTED"):
    require(condition, code)


def closed(value, keys):
    check(type(value) is dict and set(value) == set(keys))


def integer(value, minimum=0, maximum=2**53 - 1):
    check(type(value) is int and minimum <= value <= maximum)
    return value


def hexvalue(value, pattern=HEX64):
    check(type(value) is str and pattern.fullmatch(value) is not None)
    return value


def ident(meta):
    return {"device": meta.st_dev, "inode": meta.st_ino, "uid": meta.st_uid}


def validate_identity(value):
    closed(value, ("device", "inode", "uid"))
    for key in value:
        integer(value[key], 1 if key == "inode" else 0)


def stamp(meta):
    return (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_gid, meta.st_mode,
            meta.st_nlink, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns)


def validate_binding(binding):
    closed(binding, ("nonce", "originalCatalogSHA256", "uid", "bootId", "runPermitSHA256"))
    for key in ("nonce", "originalCatalogSHA256", "runPermitSHA256"):
        hexvalue(binding[key])
        check(binding[key] != "0" * 64, "BINDING_REJECTED")
    integer(binding["uid"], 1, 2147483647)
    check(type(binding["bootId"]) is str and BOOT.fullmatch(binding["bootId"])
          and binding["bootId"] != "00000000-0000-0000-0000-000000000000", "BINDING_REJECTED")
    return dict(binding)


def validate_request(value, binding, now):
    validate_binding(binding)
    closed(value, ("protocol", "op", "sequence", "nonce", "originalCatalogSHA256", "uid",
                   "bootId", "expiresAtUnixSeconds"))
    check(type(value["protocol"]) is int and value["protocol"] == 1
          and type(value["sequence"]) is int and value["sequence"] == 1
          and value["op"] == "inspect-r2-run-v1", "REQUEST_REJECTED")
    for key in ("nonce", "originalCatalogSHA256", "uid", "bootId"):
        check(type(value[key]) is type(binding[key]) and value[key] == binding[key], "BINDING_REJECTED")
    expiry = integer(value["expiresAtUnixSeconds"], 1, 2147483647)
    check(0 < expiry - now <= 600, "REQUEST_EXPIRED")
    return dict(value)


def read_request(stream, binding, now):
    size = struct.unpack("!I", read_exact(stream, 4))[0]
    check(1 <= size <= 4096, "REQUEST_REJECTED")
    raw = read_exact(stream, size)
    value = decode_json(raw)
    check(canonical_bytes(value) == raw and stream.read(1) == b"", "REQUEST_REJECTED")
    return validate_request(value, binding, now)


def empty_facts():
    return dict.fromkeys(FACT_KEYS)


def empty_record(name):
    return {"name": name, "status": "unread", "code": "NOT_READ", "sha256": None, "facts": empty_facts()}


def empty_unit():
    return {"status": "unknown", "code": "NOT_READ", "loadState": None, "activeState": None,
            "subState": None, "invocationId": None, "mainPID": None, "execMainCode": None,
            "execMainStatus": None, "result": None, "savedIdentityMatches": False}


def empty_cgroup():
    return {"status": "unknown", "code": "NOT_READ", "identityMatches": False,
            "populated": None, "frozen": None, "memoryMax": None, "memorySwapMax": None,
            "pidsMax": None, "cpuQuota": None, "cpuPeriod": None}


def initial_result(binding):
    return {"protocol": 1, "op": "inspection-result", "sequence": 1, "nonce": binding["nonce"],
            "uid": binding["uid"], "bootId": binding["bootId"], "ok": False,
            "code": "INSPECTION_FAILED", "records": [empty_record(n) for n in NAMES],
            "unit": empty_unit(), "cgroup": empty_cgroup(), "cleanupHistorical": "unknown",
            "providerReady": False, "snapshotAtomic": False}


def safe_code(error):
    return error.code if isinstance(error, StageError) and error.code in CODES else "IO_REJECTED"


class ReadOnlyTree:
    """Held directory and file identities; never create, rename, chmod or unlink."""
    def __init__(self, uid, deadline):
        self.uid, self.deadline = uid, deadline
        self.fds, self.dirs, self.files, self.absences = [], [], [], []
        self.total = 0

    def tick(self):
        check(time.monotonic() < self.deadline, "DEADLINE")

    def root(self):
        self.tick()
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fds.append(fd)
        meta = os.fstat(fd)
        check(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and not meta.st_mode & 0o022, "ROOT_REJECTED")
        self.dirs.append((None, "/", fd, (meta.st_dev, meta.st_ino, meta.st_uid, meta.st_mode)))
        return fd

    def directory(self, parent, name, owners, private=False):
        self.tick()
        check(type(name) is str and name not in ("", ".", "..") and "/" not in name and "\0" not in name,
              "ROOT_REJECTED")
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        check(stat.S_ISDIR(before.st_mode) and before.st_uid in owners and not before.st_mode & 0o022
              and (not private or stat.S_IMODE(before.st_mode) == 0o700), "ROOT_REJECTED")
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.fds.append(fd)
        after = os.fstat(fd)
        check(ident(after) == ident(before) and after.st_mode == before.st_mode, "IDENTITY_CHANGED")
        self.dirs.append((parent, name, fd, (after.st_dev, after.st_ino, after.st_uid, after.st_mode)))
        return fd

    def verify_dirs(self):
        for parent, name, fd, expected in self.dirs:
            self.tick()
            for meta in (os.fstat(fd), os.stat(name, dir_fd=parent, follow_symlinks=False)):
                check((meta.st_dev, meta.st_ino, meta.st_uid, meta.st_mode) == expected, "IDENTITY_CHANGED")

    def read_json(self, parent, name):
        self.tick()
        try:
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            self.absences.append((parent, name))
            raise
        check(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == self.uid
              and stat.S_IMODE(before.st_mode) in (0o400, 0o600), "METADATA_REJECTED")
        check(0 < before.st_size <= MAX_JSON, "SIZE_BOUND")
        check(self.total + before.st_size <= MAX_TOTAL, "TOTAL_BOUND")
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        self.fds.append(fd)
        check(stamp(os.fstat(fd)) == stamp(before), "IDENTITY_CHANGED")
        raw = self.read_bytes(fd, MAX_JSON)
        check(len(raw) == before.st_size, "CONTENT_CHANGED")
        check(stamp(os.fstat(fd)) == stamp(before), "CONTENT_CHANGED")
        check(stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == stamp(before), "IDENTITY_CHANGED")
        self.total += len(raw)
        digest = hashlib.sha256(raw).hexdigest()
        self.files.append((parent, name, fd, stamp(before), digest))
        try:
            value = decode_json(raw)
            check(canonical_bytes(value) == raw, "JSON_REJECTED")
        except StageError as error:
            raise StageError("JSON_REJECTED") from error
        return value, raw, digest

    def read_bytes(self, fd, maximum):
        os.lseek(fd, 0, os.SEEK_SET)
        chunks, count = [], 0
        while True:
            self.tick()
            data = os.read(fd, min(4096, maximum + 1 - count))
            if not data:
                return b"".join(chunks)
            chunks.append(data)
            count += len(data)
            check(count <= maximum, "SIZE_BOUND")

    def recheck(self):
        """Return changed filenames, and separately reject a changed directory."""
        self.verify_dirs()
        changed = {}
        for parent, name, fd, expected, digest in self.files:
            self.tick()
            try:
                check(stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected,
                      "IDENTITY_CHANGED")
                check(stamp(os.fstat(fd)) == expected, "CONTENT_CHANGED")
                check(hashlib.sha256(self.read_bytes(fd, MAX_JSON)).hexdigest() == digest, "CONTENT_CHANGED")
                check(stamp(os.fstat(fd)) == expected, "CONTENT_CHANGED")
            except (OSError, StageError) as error:
                changed[name] = safe_code(error)
        for parent, name in self.absences:
            self.tick()
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
                changed[name] = "IDENTITY_CHANGED"
            except FileNotFoundError:
                pass
        return changed

    def open_state(self, nonce):
        check(pwd is not None, "LINUX_REQUIRED")
        home = pwd.getpwuid(self.uid).pw_dir
        check(type(home) is str and home.startswith("/") and home != "/"
              and "\0" not in home and posixpath.normpath(home) == home, "ROOT_REJECTED")
        fd = self.root()
        for name in home[1:].split("/"):
            fd = self.directory(fd, name, (0, self.uid))
        check(os.fstat(fd).st_uid == self.uid, "ROOT_REJECTED")
        for name in (".local", "share", "project-hub-worker"):
            fd = self.directory(fd, name, (self.uid,), name == "project-hub-worker")
        self.receipt(fd, "project-hub-private-cli-stage-v1")
        root = self.directory(fd, "r2", (self.uid,), True)
        self.receipt(root, "project-hub-r2-state-v1")
        runs = self.directory(root, "runs", (self.uid,), True)
        run = self.directory(runs, nonce, (self.uid,), True)
        return root, run

    def receipt(self, fd, program):
        value, _, _ = self.read_json(fd, "ownership.json")
        closed(value, ("schemaVersion", "program", "rootIdentity"))
        validate_identity(value["rootIdentity"])
        check(value == {"schemaVersion": 1, "program": program, "rootIdentity": ident(os.fstat(fd))}
              and type(value.get("schemaVersion")) is int, "RECEIPT_REJECTED")

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()


def old_request(value, binding):
    closed(value, ("protocol", "op", "sequence", "nonce", "catalogSHA256", "bootId", "uid", "case",
                   "expiresAtUnixSeconds", "runtimeSeconds"))
    check(type(value["protocol"]) is int and value["protocol"] == 1
          and type(value["sequence"]) is int and value["sequence"] == 1
          and value["op"] == "run-r2-synthetic-v1" and value["case"] == "isolation-v1"
          and type(value["runtimeSeconds"]) is int and value["runtimeSeconds"] == 60, "BINDING_REJECTED")
    integer(value["expiresAtUnixSeconds"], 1, 2147483647)  # Historical expiry is not current authorization.
    for key, other in (("nonce", "nonce"), ("catalogSHA256", "originalCatalogSHA256"), ("bootId", "bootId"), ("uid", "uid")):
        check(type(value[key]) is type(binding[other]) and value[key] == binding[other], "BINDING_REJECTED")
    check(hashlib.sha256(canonical_bytes(value)).hexdigest() == binding["runPermitSHA256"], "BINDING_REJECTED")


def cgroup_path(value, unit):
    check(type(value) is str and value.startswith("/") and len(value) <= 4096, "CGROUP_REJECTED")
    parts = value[1:].split("/")
    check(parts[-1] == unit and all(re.fullmatch(r"[A-Za-z0-9_.:@-]{1,255}", p)
          and p not in (".", "..") for p in parts), "CGROUP_REJECTED")
    return parts


def limits(value):
    closed(value, ("memory.max", "memory.swap.max", "pids.max", "cpu.max"))
    check(value["memory.max"] == "6442450944" and value["memory.swap.max"] == "0"
          and value["pids.max"] == "256" and type(value["cpu.max"]) is str)
    match = re.fullmatch(r"([1-9][0-9]{0,9}) ([1-9][0-9]{0,9})", value["cpu.max"])
    check(match is not None and int(match[1]) * 100 == int(match[2]) * 150)


def measurement(value, uid):
    closed(value, ("kind", "guardPassed", "measurement", "tmpfsRoundTrip", "providerReady"))
    check(value["kind"] == "project-hub-r2-guard-result" and value["guardPassed"] is True
          and value["tmpfsRoundTrip"] is True and value["providerReady"] is False)
    m = value["measurement"]
    closed(m, ("schemaVersion", "kind", "namespaces", "uid", "capabilities", "noNewPrivs", "interfaces",
               "openFDs", "rootReadOnly", "usrReadOnly", "forbiddenPathsVisible", "tmpfsCapacityBytes", "providerExecuted"))
    check(type(m["schemaVersion"]) is int and m["schemaVersion"] == 1
          and m["kind"] == "project-hub-r2-isolation-measurement"
          and type(m["uid"]) is int and m["uid"] == uid and m["providerExecuted"] is False)
    closed(m["namespaces"], ("user", "mnt", "pid", "net", "ipc", "uts", "cgroup"))
    for value in m["namespaces"].values():
        integer(value, 1)
    closed(m["capabilities"], ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
    check(all(v == "0000000000000000" for v in m["capabilities"].values()) and m["noNewPrivs"] == "1"
          and type(m["interfaces"]) is list and m["interfaces"] in ([], ["lo"])
          and type(m["openFDs"]) is list and m["openFDs"] == [0, 1, 2]
          and all(type(v) is int for v in m["openFDs"])
          and m["rootReadOnly"] is True and m["usrReadOnly"] is True)
    closed(m["forbiddenPathsVisible"], ("/home", "/root", "/sys/fs/cgroup", "/run/user", "/run/dbus", "/var/run/docker.sock"))
    check(all(v is False for v in m["forbiddenPathsVisible"].values()))
    closed(m["tmpfsCapacityBytes"], ("/work", "/profile", "/tmp"))
    check(m["tmpfsCapacityBytes"] == {"/work": 2147483648, "/profile": 268435456, "/tmp": 536870912}
          and all(type(v) is int for v in m["tmpfsCapacityBytes"].values()))


def sanitize_record(name, value, binding, root_identity, run_identity):
    """Validate every input field, then project only a fixed set of typed facts."""
    facts = empty_facts()
    unit = "project-hub-r2-" + binding["nonce"] + ".service"
    if name in ("intent.json", "active.json"):
        closed(value, ("request", "state", "rootIdentity", "runIdentity"))
        old_request(value["request"], binding)
        validate_identity(value["rootIdentity"])
        validate_identity(value["runIdentity"])
        check(value["state"] == "preparing" and value["rootIdentity"] == root_identity
              and value["runIdentity"] == run_identity, "BINDING_REJECTED")
        facts["bindingMatches"] = True
    elif name == "runtime.json":
        closed(value, ("baseline", "tools"))
        closed(value["baseline"], ("availableMemoryBytes", "availableDiskBytes"))
        for number in value["baseline"].values():
            integer(number, 1)
        closed(value["tools"], ("/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"))
        for tool in value["tools"].values():
            closed(tool, ("resolved", "sha256", "device", "inode", "uid"))
            validate_identity({key: tool[key] for key in ("device", "inode", "uid")})
            check(tool["uid"] == 0 and type(tool["resolved"]) is str and tool["resolved"].startswith("/usr/")
                  and posixpath.normpath(tool["resolved"]) == tool["resolved"]
                  and all(re.fullmatch(r"[A-Za-z0-9._+@-]{1,255}", p) for p in tool["resolved"][1:].split("/")))
            hexvalue(tool["sha256"])
    elif name == "unit.json":
        closed(value, ("unit", "invocationId", "cgroupIdentity", "cgroupPathSHA256"))
        check(value["unit"] == unit, "BINDING_REJECTED")
        validate_identity(value["cgroupIdentity"])
        check(value["cgroupIdentity"]["uid"] in (0, binding["uid"]), "BINDING_REJECTED")
        facts["invocationId"] = hexvalue(value["invocationId"], HEX32)
        facts["cgroupPathSHA256"] = hexvalue(value["cgroupPathSHA256"])
    elif name == "service-kernel.json":
        closed(value, ("schemaVersion", "uid", "bootId", "catalogSHA256", "invocationId", "unit", "cgroup", "process", "limits"))
        check(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
              and type(value["uid"]) is int and value["uid"] == binding["uid"]
              and value["bootId"] == binding["bootId"] and value["catalogSHA256"] == binding["originalCatalogSHA256"]
              and value["unit"] == unit, "BINDING_REJECTED")
        cgroup_path(value["cgroup"], unit)
        closed(value["process"], ("pid", "startTicks", "state"))
        check(value["process"]["state"] in ("R", "S", "D", "Z", "T", "t", "X", "x", "K", "W", "P", "I"))
        facts["pid"] = integer(value["process"]["pid"], 2, 2147483647)
        facts["startTicks"] = integer(value["process"]["startTicks"], 1)
        facts["invocationId"] = hexvalue(value["invocationId"], HEX32)
        facts["cgroupPathSHA256"] = hashlib.sha256(value["cgroup"].encode("ascii")).hexdigest()
        limits(value["limits"])
        facts["bindingMatches"] = True
    elif name == "execution-gate.json":
        closed(value, ("nonce", "catalogSHA256", "invocationId", "pid", "startTicks"))
        check(value["nonce"] == binding["nonce"] and value["catalogSHA256"] == binding["originalCatalogSHA256"], "BINDING_REJECTED")
        facts["invocationId"] = hexvalue(value["invocationId"], HEX32)
        facts["pid"] = integer(value["pid"], 2, 2147483647)
        facts["startTicks"] = integer(value["startTicks"], 1)
        facts["bindingMatches"] = True
    elif name == "service-error.json":
        closed(value, ("code",))
        check(type(value["code"]) is str and value["code"] in RECORDED_CODES)
        facts["recordedCode"] = value["code"]
    elif name == "measurement.json":
        measurement(value, binding["uid"])
        facts["recordedGuardPassed"], facts["measurementShapeValid"] = True, True
    elif name in ("result.json", "closed.json"):
        base = {"ok", "case", "providerReady", "fullR2Verified", "catalogSHA256", "cleanup",
                "cleanupVerified", "notStartedConfirmed", "completionState"}
        check(type(value) is dict and base <= set(value) and set(value) <= base | {"code", "syntheticMeasurement"})
        check(type(value["ok"]) is bool and value["case"] == "isolation-v1"
              and value["providerReady"] is False and value["fullR2Verified"] is False
              and value["catalogSHA256"] == binding["originalCatalogSHA256"], "BINDING_REJECTED")
        check(value["completionState"] == ("closed" if name == "closed.json" else "lease-release-pending"))
        check(type(value["cleanupVerified"]) is bool and type(value["notStartedConfirmed"]) is bool)
        cleanup = value["cleanup"]
        closed(cleanup, ("populatedZeroObserved", "unitStopped", "identityPreserved", "ownedOutputsClosed", "cleanupVerified", "basis"))
        check(cleanup["basis"] in ("owned-cgroup-events", "no-process-start-attempt")
              and all(type(cleanup[k]) is bool for k in cleanup if k != "basis")
              and cleanup["cleanupVerified"] == value["cleanupVerified"])
        if cleanup["basis"] == "owned-cgroup-events":
            check(cleanup["cleanupVerified"] == all(cleanup[k] for k in ("populatedZeroObserved", "unitStopped", "identityPreserved", "ownedOutputsClosed")))
        else:
            check(cleanup["cleanupVerified"] is True and value["notStartedConfirmed"] is True
                  and all(cleanup[k] is False for k in ("populatedZeroObserved", "unitStopped", "identityPreserved", "ownedOutputsClosed")))
        if "code" in value:
            check(type(value["code"]) is str and value["code"] in RECORDED_CODES)
            facts["recordedCode"] = value["code"]
        check(value["ok"] or "code" in value)
        if "syntheticMeasurement" in value:
            measurement(value["syntheticMeasurement"], binding["uid"])
            facts["recordedGuardPassed"], facts["measurementShapeValid"] = True, True
        check(not value["ok"] or "syntheticMeasurement" in value)
        facts.update(recordedOk=value["ok"], recordedCleanupVerified=value["cleanupVerified"], completionState=value["completionState"])
    else:
        check(False)
    return facts


def read_records(tree, root, run, binding, result):
    values, raws = {}, {}
    for record in result["records"]:
        name = record["name"]
        try:
            value, raw, digest = tree.read_json(root if name == "active.json" else run, name)
            facts = sanitize_record(name, value, binding, ident(os.fstat(root)), ident(os.fstat(run)))
            record.update(status="valid", code="OK", sha256=digest, facts=facts)
            values[name], raws[name] = value, raw
        except FileNotFoundError:
            record.update(status="missing", code="MISSING")
        except (OSError, StageError) as error:
            code = safe_code(error)
            record.update(status="changed" if code in ("IDENTITY_CHANGED", "CONTENT_CHANGED") else "rejected", code=code)
    check("intent.json" in values and "active.json" in values
          and raws["intent.json"] == raws["active.json"], "LEASE_REJECTED")
    unit, kernel, gate = (values.get(n) for n in ("unit.json", "service-kernel.json", "execution-gate.json"))
    if unit is not None and kernel is not None:
        check(unit["invocationId"] == kernel["invocationId"]
              and unit["cgroupPathSHA256"] == hashlib.sha256(kernel["cgroup"].encode("ascii")).hexdigest(), "BINDING_REJECTED")
    if gate is not None and kernel is not None:
        check(gate["invocationId"] == kernel["invocationId"] and gate["pid"] == kernel["process"]["pid"]
              and gate["startTicks"] == kernel["process"]["startTicks"], "BINDING_REJECTED")
    return values


def open_systemctl(tree):
    """Fixed /usr runtime; root-owned symlinks held, all resolutions stay in /usr."""
    pending, links, observations = "/usr/bin/systemctl", 0, []
    while True:
        parent, prefix = tree.root(), ""
        parts, restart = pending[1:].split("/"), False
        check(all(re.fullmatch(r"[A-Za-z0-9._+@-]{1,255}", p) and p not in (".", "..") for p in parts), "RUNTIME_REJECTED")
        for index, name in enumerate(parts):
            tree.tick()
            meta = os.stat(name, dir_fd=parent, follow_symlinks=False)
            check(meta.st_uid == 0, "RUNTIME_REJECTED")
            if stat.S_ISLNK(meta.st_mode):
                links += 1
                check(links <= 16, "RUNTIME_REJECTED")
                fd = os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent)
                tree.fds.append(fd)
                check(stamp(os.fstat(fd)) == stamp(meta), "IDENTITY_CHANGED")
                target = os.readlink(name, dir_fd=parent)
                resolved = posixpath.normpath(target if target.startswith("/") else prefix + "/" + target)
                check(resolved == "/usr" or resolved.startswith("/usr/"), "RUNTIME_REJECTED")
                observations.append((parent, name, fd, stamp(meta)))
                pending = resolved + ("/" + "/".join(parts[index + 1:]) if index + 1 < len(parts) else "")
                restart = True
                break
            if index < len(parts) - 1:
                parent = tree.directory(parent, name, (0,))
                prefix += "/" + name
            else:
                check(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and not meta.st_mode & 0o6022
                      and 0 < meta.st_size <= 64 * 1024**2, "RUNTIME_REJECTED")
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                tree.fds.append(fd)
                check(stamp(os.fstat(fd)) == stamp(meta), "IDENTITY_CHANGED")
                observations.append((parent, name, fd, stamp(meta)))
        if not restart:
            return fd, observations


def verify_tool(tree, observations):
    tree.verify_dirs()
    for parent, name, fd, expected in observations:
        check(stamp(os.fstat(fd)) == expected
              and stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected, "IDENTITY_CHANGED")


def query_unit(tree, unit, uid, expected_tool):
    fd, observations = open_systemctl(tree)
    verify_tool(tree, observations)
    check(expected_tool is not None and ident(os.fstat(fd)) ==
          {key: expected_tool[key] for key in ("device", "inode", "uid")}, "RUNTIME_REJECTED")
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        tree.tick()
        part = os.read(fd, 65536)
        if not part:
            break
        digest.update(part)
    check(digest.hexdigest() == expected_tool["sha256"], "RUNTIME_REJECTED")
    verify_tool(tree, observations)
    argv = ["/usr/bin/systemctl", "--user", "--no-pager", "show", unit, "--property=" + ",".join(PROPERTIES)]
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": "/run/user/" + str(uid),
           "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/" + str(uid) + "/bus"}
    child = subprocess.Popen(argv, executable="/proc/self/fd/" + str(fd), pass_fds=(fd,),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env=env, close_fds=True)
    streams, stdout, total = {child.stdout.fileno(): child.stdout, child.stderr.fileno(): child.stderr}, bytearray(), 0
    deadline = min(tree.deadline, time.monotonic() + 8)
    try:
        while streams:
            check(time.monotonic() < deadline, "DEADLINE")
            readable, _, _ = select.select(list(streams), [], [], max(0, min(.1, deadline - time.monotonic())))
            for number in readable:
                part = os.read(number, 4096)
                total += len(part)
                check(total <= MAX_JSON, "TOOL_OUTPUT_BOUND")
                if number == child.stdout.fileno():
                    stdout.extend(part)
                if not part:
                    del streams[number]
        code = child.wait(timeout=max(.001, deadline - time.monotonic()))
        verify_tool(tree, observations)
        return code, bytes(stdout)
    finally:
        # This is only our still-unreaped, directly-created inspection child.
        # Never signal the inspected unit, a process from its metadata, or a PID search result.
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()
        child.stderr.close()


def parse_unit(code, raw, saved, kernel, unit_name):
    check(type(raw) is bytes and len(raw) <= MAX_JSON and code in (0, 4), "TOOL_FAILED")
    try:
        rows = raw.decode("ascii", errors="strict").splitlines()
    except UnicodeError as error:
        raise StageError("UNIT_REJECTED") from error
    values = {}
    for row in rows:
        check("=" in row, "UNIT_REJECTED")
        key, value = row.split("=", 1)
        check(key in PROPERTIES and key not in values, "UNIT_REJECTED")
        values[key] = value
    check(set(values) == set(PROPERTIES), "UNIT_REJECTED")
    check(values["LoadState"] in LOAD_STATES and values["ActiveState"] in ACTIVE_STATES
          and values["SubState"] in SUB_STATES
          and (values["Result"] in UNIT_RESULTS or values["LoadState"] == "not-found" and values["Result"] == ""),
          "UNIT_REJECTED")
    check(code == 0 or values["LoadState"] == "not-found", "UNIT_REJECTED")
    parsed = empty_unit()
    parsed.update(status="valid", code="OK", loadState=values["LoadState"], activeState=values["ActiveState"],
                  subState=values["SubState"], result=values["Result"] or None)
    for source, dest, maximum in (("MainPID", "mainPID", 2147483647), ("ExecMainCode", "execMainCode", 255), ("ExecMainStatus", "execMainStatus", 255)):
        check(re.fullmatch(r"0|[1-9][0-9]{0,9}", values[source]) is not None, "UNIT_REJECTED")
        parsed[dest] = integer(int(values[source]), 0, maximum)
    inv = values["InvocationID"]
    check(inv == "" or HEX32.fullmatch(inv) is not None, "UNIT_REJECTED")
    parsed["invocationId"] = inv or None
    path = values["ControlGroup"]
    if path:
        cgroup_path(path, unit_name)
    if values["LoadState"] == "not-found":
        check(not inv and not path and parsed["mainPID"] == 0
              and values["ActiveState"] == "inactive" and values["SubState"] == "dead", "UNIT_REJECTED")
        parsed.update(status="missing", code="UNIT_MISSING")
    elif saved is None or kernel is None:
        parsed["code"] = "SAVED_IDENTITY_UNAVAILABLE"
    elif inv == saved["invocationId"] == kernel["invocationId"] and path == kernel["cgroup"]:
        parsed["savedIdentityMatches"] = True
    else:
        parsed["code"] = "UNIT_IDENTITY_CHANGED"
    return parsed


def read_cgroup(tree, saved, kernel, unit_name):
    parts = cgroup_path(kernel["cgroup"], unit_name)
    check(hashlib.sha256(kernel["cgroup"].encode("ascii")).hexdigest() == saved["cgroupPathSHA256"], "CGROUP_IDENTITY_CHANGED")
    fd = tree.root()
    for name in ("sys", "fs", "cgroup"):
        fd = tree.directory(fd, name, (0,))
    for name in parts:
        fd = tree.directory(fd, name, (0, tree.uid))
    check(ident(os.fstat(fd)) == saved["cgroupIdentity"], "CGROUP_IDENTITY_CHANGED")
    values = {}
    for name in ("cgroup.events", "memory.max", "memory.swap.max", "pids.max", "cpu.max"):
        meta = os.stat(name, dir_fd=fd, follow_symlinks=False)
        check(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1 and meta.st_uid in (0, tree.uid)
              and not meta.st_mode & 0o022, "CGROUP_REJECTED")
        item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        tree.fds.append(item)
        check(ident(os.fstat(item)) == ident(meta), "CGROUP_IDENTITY_CHANGED")
        first = tree.read_bytes(item, 1024)
        check(first == tree.read_bytes(item, 1024), "CONTENT_CHANGED")
        check(ident(os.stat(name, dir_fd=fd, follow_symlinks=False)) == ident(meta), "CGROUP_IDENTITY_CHANGED")
        try:
            values[name] = first.decode("ascii", errors="strict").strip()
        except UnicodeError as error:
            raise StageError("CGROUP_REJECTED") from error
    events = {}
    for row in values.pop("cgroup.events").splitlines():
        match = re.fullmatch(r"(populated|frozen) ([01])", row)
        check(match is not None and match[1] not in events, "CGROUP_REJECTED")
        events[match[1]] = int(match[2])
    check(set(events) == {"populated", "frozen"}, "CGROUP_REJECTED")
    limits(values)
    quota, period = (int(v) for v in values["cpu.max"].split(" "))
    tree.verify_dirs()
    return {"status": "valid", "code": "OK", "identityMatches": True, **events,
            "memoryMax": int(values["memory.max"]), "memorySwapMax": int(values["memory.swap.max"]),
            "pidsMax": int(values["pids.max"]), "cpuQuota": quota, "cpuPeriod": period}


def inspect(binding, deadline):
    validate_binding(binding)
    output = initial_result(binding)
    tree = ReadOnlyTree(binding["uid"], deadline)
    try:
        check(sys.platform == "linux" and pwd is not None, "LINUX_REQUIRED")
        check(os.getuid() == os.geteuid() == binding["uid"], "UID_REJECTED")
        with open("/proc/sys/kernel/random/boot_id", "rb") as stream:
            boot = stream.read(100)
        check(boot == (binding["bootId"] + "\n").encode("ascii"), "BOOT_REJECTED")
        root, run = tree.open_state(binding["nonce"])
        values = read_records(tree, root, run, binding, output)
        changed = tree.recheck()
        check(not changed, "CONTENT_CHANGED")
        unit_name = "project-hub-r2-" + binding["nonce"] + ".service"
        saved, kernel = values.get("unit.json"), values.get("service-kernel.json")
        try:
            runtime = values.get("runtime.json")
            check(runtime is not None, "RUNTIME_REJECTED")
            code, raw = query_unit(tree, unit_name, binding["uid"], runtime["tools"]["/usr/bin/systemctl"])
            output["unit"] = parse_unit(code, raw, saved, kernel, unit_name)
        except (OSError, StageError, subprocess.SubprocessError) as error:
            output["unit"].update(status="rejected", code=safe_code(error))
        if output["unit"]["savedIdentityMatches"]:
            try:
                output["cgroup"] = read_cgroup(tree, saved, kernel, unit_name)
            except FileNotFoundError:
                output["cgroup"].update(code="CGROUP_MISSING")
            except (OSError, StageError) as error:
                output["cgroup"].update(code=safe_code(error))
        else:
            output["cgroup"]["code"] = ("UNIT_MISSING" if output["unit"]["status"] == "missing" else
                                         "UNIT_IDENTITY_CHANGED" if output["unit"]["status"] == "valid" else "SAVED_IDENTITY_UNAVAILABLE")
        output["ok"] = all(r["status"] in ("valid", "missing") for r in output["records"]) and output["unit"]["status"] in ("valid", "missing")
        output["code"] = "OK" if output["ok"] else "PARTIAL"
    except (OSError, StageError, ValueError) as error:
        output["code"] = safe_code(error)
    finally:
        try:
            changes = tree.recheck()
            for record in output["records"]:
                if record["name"] in changes:
                    record.update(status="changed", code=changes[record["name"]], sha256=None, facts=empty_facts())
            if changes:
                output["ok"], output["code"] = False, "CONTENT_CHANGED"
                output["unit"]["savedIdentityMatches"] = False
                output["cgroup"] = empty_cgroup()
                output["cgroup"]["code"] = "CONTENT_CHANGED"
        except (OSError, StageError) as error:
            output["ok"], output["code"] = False, safe_code(error)
            for record in output["records"]:
                if record["status"] == "valid":
                    record.update(status="changed", code=output["code"], sha256=None, facts=empty_facts())
            output["unit"]["savedIdentityMatches"] = False
            output["cgroup"] = empty_cgroup()
            output["cgroup"]["code"] = output["code"]
        tree.close()
    return validate_output(output, binding)


def validate_output(value, binding):
    """Second, independent closed vocabulary gate before any bytes leave stdout."""
    closed(value, initial_result(binding))
    for key in ("protocol", "op", "sequence", "nonce", "uid", "bootId", "cleanupHistorical", "providerReady", "snapshotAtomic"):
        expected = initial_result(binding)[key]
        check(type(value[key]) is type(expected) and value[key] == expected, "OUTPUT_REJECTED")
    check(type(value["ok"]) is bool and value["code"] in CODES, "OUTPUT_REJECTED")
    check(type(value["records"]) is list and len(value["records"]) == len(NAMES), "OUTPUT_REJECTED")
    for record, name in zip(value["records"], NAMES):
        closed(record, empty_record(name))
        check(record["name"] == name and record["status"] in STATUSES and record["code"] in CODES, "OUTPUT_REJECTED")
        check(record["sha256"] is None or type(record["sha256"]) is str and HEX64.fullmatch(record["sha256"]), "OUTPUT_REJECTED")
        facts = record["facts"]
        closed(facts, FACT_KEYS)
        for key in ("bindingMatches", "recordedOk", "recordedCleanupVerified", "recordedGuardPassed", "measurementShapeValid"):
            check(facts[key] is None or type(facts[key]) is bool, "OUTPUT_REJECTED")
        check(facts["recordedCode"] is None or facts["recordedCode"] in RECORDED_CODES, "OUTPUT_REJECTED")
        check(facts["completionState"] in (None, "closed", "lease-release-pending"), "OUTPUT_REJECTED")
        for key, pattern in (("invocationId", HEX32), ("cgroupPathSHA256", HEX64)):
            check(facts[key] is None or type(facts[key]) is str and pattern.fullmatch(facts[key]), "OUTPUT_REJECTED")
        for key in ("pid", "startTicks"):
            if facts[key] is not None:
                integer(facts[key], 1)
    unit = value["unit"]
    closed(unit, empty_unit())
    check(unit["status"] in STATUSES and unit["code"] in CODES and type(unit["savedIdentityMatches"]) is bool, "OUTPUT_REJECTED")
    for key, allowed in (("loadState", LOAD_STATES), ("activeState", ACTIVE_STATES), ("subState", SUB_STATES), ("result", UNIT_RESULTS)):
        check(unit[key] is None or unit[key] in allowed, "OUTPUT_REJECTED")
    check(unit["invocationId"] is None or type(unit["invocationId"]) is str and HEX32.fullmatch(unit["invocationId"]), "OUTPUT_REJECTED")
    for key in ("mainPID", "execMainCode", "execMainStatus"):
        if unit[key] is not None:
            integer(unit[key], 0, 2147483647 if key == "mainPID" else 255)
    group = value["cgroup"]
    closed(group, empty_cgroup())
    check(group["status"] in STATUSES and group["code"] in CODES and type(group["identityMatches"]) is bool, "OUTPUT_REJECTED")
    for key in ("populated", "frozen", "memoryMax", "memorySwapMax", "pidsMax", "cpuQuota", "cpuPeriod"):
        if group[key] is not None:
            integer(group[key], 0, 1 if key in ("populated", "frozen") else 2**53 - 1)
    check(len(canonical_bytes(value)) + 4 <= MAX_OUTPUT, "OUTPUT_REJECTED")
    return value


def emit_output(stream_fd, value, binding, deadline):
    raw = canonical_bytes(validate_output(value, binding))
    frame = memoryview(struct.pack("!I", len(raw)) + raw)
    os.set_blocking(stream_fd, False)
    while frame:
        check(time.monotonic() < deadline, "DEADLINE")
        _, ready, _ = select.select([], [stream_fd], [], max(0, min(.1, deadline - time.monotonic())))
        if ready:
            try:
                count = os.write(stream_fd, frame[:4096])
            except BlockingIOError:
                continue
            check(count > 0, "IO_REJECTED")
            frame = frame[count:]


def request_deadline(request, binding, operation_deadline, *, now, monotonic):
    """Fresh admission after input read; grant expiry also bounds live reads/output."""
    validate_request(request, binding, now)
    remaining = request["expiresAtUnixSeconds"] - now
    deadline = min(operation_deadline, monotonic + remaining)
    check(deadline > monotonic, "DEADLINE")
    return deadline


def main():
    binding = validate_binding(EXPECTED_BINDING)
    hexvalue(DIAGNOSTIC_CATALOG_SHA256)
    output = initial_result(binding)
    previous = None
    deadline = time.monotonic() + DEADLINE_SECONDS
    try:
        check(sys.platform == "linux", "LINUX_REQUIRED")
        def expired(_signum, _frame):
            raise StageError("DEADLINE")
        previous = signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, DEADLINE_SECONDS)
        request = read_request(sys.stdin.buffer, binding, time.time())
        # Capture monotonic first, so the conversion is conservative by the
        # elapsed time between clock reads rather than extending authorization.
        current_monotonic, current_utc = time.monotonic(), time.time()
        deadline = request_deadline(request, binding, deadline, now=current_utc, monotonic=current_monotonic)
        signal.setitimer(signal.ITIMER_REAL, max(.000001, deadline - time.monotonic()))
        output = inspect(binding, deadline)
    except BaseException as error:
        output["code"] = safe_code(error)
    finally:
        try:
            if sys.platform != "linux" and output["code"] == "LINUX_REQUIRED":
                # Portable bootstrap rejection only: no input/remote state/tool
                # was accessed. Windows pipes do not support select(). The
                # local bootstrap test caller owns its bounded process timeout.
                raw = canonical_bytes(validate_output(output, binding))
                sys.stdout.buffer.write(struct.pack("!I", len(raw)) + raw)
                sys.stdout.buffer.flush()
            else:
                emit_output(sys.stdout.fileno(), output, binding, deadline)
        finally:
            if previous is not None:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, previous)
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
