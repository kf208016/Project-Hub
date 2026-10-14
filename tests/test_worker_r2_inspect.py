import copy
import hashlib
import io
import os
from pathlib import Path
import stat
import struct
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER = str(Path(__file__).resolve().parents[1] / "hub" / "worker")
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)
import r2_inspect as inspect
from stage_protocol import StageError, canonical_bytes


NONCE = "c" * 64
CATALOG = "d" * 64
BOOT = "26e557d3-2e76-4a6e-a732-1bd0d4c45482"
ROOT = {"device": 1, "inode": 20, "uid": 1000}
RUN = {"device": 1, "inode": 30, "uid": 1000}
GROUP = {"device": 2, "inode": 40, "uid": 1000}
INVOCATION = "a" * 32
UNIT = "project-hub-r2-" + NONCE + ".service"
CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice/" + UNIT
OLD_REQUEST = {"protocol": 1, "op": "run-r2-synthetic-v1", "sequence": 1, "nonce": NONCE,
               "catalogSHA256": CATALOG, "bootId": BOOT, "uid": 1000, "case": "isolation-v1",
               "expiresAtUnixSeconds": 100, "runtimeSeconds": 60}
BINDING = {"nonce": NONCE, "originalCatalogSHA256": CATALOG, "uid": 1000, "bootId": BOOT,
           "runPermitSHA256": hashlib.sha256(canonical_bytes(OLD_REQUEST)).hexdigest()}


def request():
    return {"protocol": 1, "op": "inspect-r2-run-v1", "sequence": 1, "nonce": NONCE,
            "originalCatalogSHA256": CATALOG, "uid": 1000, "bootId": BOOT, "expiresAtUnixSeconds": 1100}


def meta(data=b"", inode=90, uid=1000, mode=stat.S_IFREG | 0o400, nlink=1):
    return SimpleNamespace(st_dev=1, st_ino=inode, st_uid=uid, st_gid=1000,
                           st_mode=mode, st_nlink=nlink, st_size=len(data), st_mtime_ns=1, st_ctime_ns=1)


def measured():
    return {"kind": "project-hub-r2-guard-result", "guardPassed": True,
            "tmpfsRoundTrip": True, "providerReady": False, "measurement": {
                "schemaVersion": 1, "kind": "project-hub-r2-isolation-measurement", "uid": 1000,
                "providerExecuted": False, "namespaces": dict.fromkeys(("user", "mnt", "pid", "net", "ipc", "uts", "cgroup"), 500),
                "capabilities": dict.fromkeys(("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"), "0000000000000000"),
                "noNewPrivs": "1", "interfaces": ["lo"], "openFDs": [0, 1, 2], "rootReadOnly": True,
                "usrReadOnly": True, "forbiddenPathsVisible": dict.fromkeys(("/home", "/root", "/sys/fs/cgroup", "/run/user", "/run/dbus", "/var/run/docker.sock"), False),
                "tmpfsCapacityBytes": {"/work": 2147483648, "/profile": 268435456, "/tmp": 536870912}}}


def records():
    intent = {"request": OLD_REQUEST, "state": "preparing", "rootIdentity": ROOT, "runIdentity": RUN}
    tools = {path: {"resolved": path, "sha256": "b" * 64, "device": 1, "inode": 80, "uid": 0}
             for path in ("/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl")}
    cleanup = {"populatedZeroObserved": False, "unitStopped": False, "identityPreserved": False,
               "ownedOutputsClosed": False, "cleanupVerified": False, "basis": "owned-cgroup-events"}
    result = {"ok": False, "code": "R2_UNIT_IDENTITY_CHANGED", "case": "isolation-v1", "providerReady": False,
              "fullR2Verified": False, "catalogSHA256": CATALOG, "cleanup": cleanup,
              "cleanupVerified": False, "notStartedConfirmed": False, "completionState": "lease-release-pending"}
    return {"intent.json": intent, "active.json": intent,
            "runtime.json": {"baseline": {"availableMemoryBytes": 100, "availableDiskBytes": 200}, "tools": tools},
            "unit.json": {"unit": UNIT, "invocationId": INVOCATION, "cgroupIdentity": GROUP,
                          "cgroupPathSHA256": hashlib.sha256(CGROUP.encode()).hexdigest()},
            "service-kernel.json": {"schemaVersion": 1, "uid": 1000, "bootId": BOOT, "catalogSHA256": CATALOG,
                                    "unit": UNIT, "invocationId": INVOCATION, "cgroup": CGROUP,
                                    "process": {"pid": 100, "startTicks": 333, "state": "S"},
                                    "limits": {"memory.max": "6442450944", "memory.swap.max": "0", "pids.max": "256", "cpu.max": "150000 100000"}},
            "execution-gate.json": {"nonce": NONCE, "catalogSHA256": CATALOG, "invocationId": INVOCATION,
                                    "pid": 100, "startTicks": 333},
            "service-error.json": {"code": "R2_SANDBOX_FAILED"}, "measurement.json": measured(),
            "result.json": result}


def unit_output(**changes):
    value = {"LoadState": "loaded", "ActiveState": "active", "SubState": "exited", "InvocationID": INVOCATION,
             "MainPID": "0", "ControlGroup": "", "ExecMainCode": "1", "ExecMainStatus": "0", "Result": "success"}
    value.update(changes)
    return ("\n".join(k + "=" + v for k, v in value.items()) + "\n").encode()


class SingleFile:
    """Portable FD fixture: verifies read flags and simulates metadata races."""
    def __init__(self, raw, metadata=None):
        self.raw, self.metadata, self.offset = raw, metadata or meta(raw), 0
        self.open_flags = []

    def stat(self, *_args, **_kwargs):
        return self.metadata

    def open(self, _name, flags, **kwargs):
        self.open_flags.append(flags)
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
            raise AssertionError("write open attempted")
        return 20

    def read(self, _fd, size):
        data = self.raw[self.offset:self.offset + size]
        self.offset += len(data)
        return data

    def seek(self, _fd, offset, _whence):
        self.offset = offset

    def patches(self):
        return patch.multiple(inspect.os, stat=self.stat, fstat=self.stat, open=self.open,
                              read=self.read, lseek=self.seek,
                              O_NOFOLLOW=getattr(os, "O_NOFOLLOW", 0x20000),
                              O_NONBLOCK=getattr(os, "O_NONBLOCK", 0x40000), create=True)


class RecordTree:
    def __init__(self, uid=1000, deadline=None, values=None, changes=None):
        self.values = copy.deepcopy(records() if values is None else values)
        self.changes = changes or {}
        self.closed = False

    def open_state(self, nonce):
        assert nonce == NONCE
        return 20, 30

    def read_json(self, parent, name):
        assert parent == (20 if name == "active.json" else 30)
        if name not in self.values:
            raise FileNotFoundError()
        value = self.values[name]
        if isinstance(value, BaseException):
            raise value
        raw = canonical_bytes(value)
        return value, raw, hashlib.sha256(raw).hexdigest()

    def recheck(self):
        return self.changes

    def close(self):
        self.closed = True


class InspectContractTests(unittest.TestCase):
    def assert_rejected(self, action, code=None):
        with self.assertRaises(StageError) as result:
            action()
        if code:
            self.assertEqual(result.exception.code, code)

    def test_request_exact_frame_and_historical_permit_expiry(self):
        raw = canonical_bytes(request())
        stream = io.BytesIO(struct.pack("!I", len(raw)) + raw)
        self.assertEqual(inspect.read_request(stream, BINDING, 1000), request())
        inspect.old_request(OLD_REQUEST, BINDING)  # expiry=100 remains a valid historical binding.

    def test_request_rejects_extra_fields_wrong_types_bindings_and_expiry(self):
        for key, value in (("source", "secret"), ("path", "/tmp"), ("nonce", "f" * 64), ("uid", True),
                           ("bootId", "wrong"), ("originalCatalogSHA256", "f" * 64),
                           ("expiresAtUnixSeconds", 1000), ("expiresAtUnixSeconds", 1601), ("sequence", True)):
            candidate = request()
            candidate[key] = value
            with self.subTest(key=key, value=value):
                self.assert_rejected(lambda: inspect.validate_request(candidate, BINDING, 1000))

    def test_request_rejects_duplicate_noncanonical_trailing_and_oversize(self):
        raw = canonical_bytes(request())
        for body, suffix in ((raw, b"x"), (raw + b" ", b""), (b'{"protocol":1,"protocol":1}', b""), (b"x" * 4097, b"")):
            self.assert_rejected(lambda: inspect.read_request(io.BytesIO(struct.pack("!I", len(body)) + body + suffix), BINDING, 1000))

    def test_grant_expiry_bounds_live_deadline_without_rounding_extra_second(self):
        value = request()
        value["expiresAtUnixSeconds"] = 1001
        self.assertAlmostEqual(inspect.request_deadline(value, BINDING, 545, now=1000.75, monotonic=500), 500.25)
        value["expiresAtUnixSeconds"] = 1100
        self.assertEqual(inspect.request_deadline(value, BINDING, 545, now=1000, monotonic=500), 545)
        self.assert_rejected(lambda: inspect.request_deadline(value, BINDING, 545, now=1100, monotonic=500), "REQUEST_EXPIRED")
        self.assert_rejected(lambda: inspect.request_deadline(value, BINDING, 499, now=1000, monotonic=500), "DEADLINE")

    def test_all_record_sanitizers_and_unknown_fields_do_not_leak(self):
        for name, value in records().items():
            with self.subTest(name=name):
                facts = inspect.sanitize_record(name, value, BINDING, ROOT, RUN)
                self.assertEqual(set(facts), set(inspect.FACT_KEYS))
                damaged = copy.deepcopy(value)
                damaged["secret"] = "never-export-this"
                self.assert_rejected(lambda: inspect.sanitize_record(name, damaged, BINDING, ROOT, RUN))
        with self.assertRaises(StageError):
            inspect.sanitize_record("service-error.json", {"code": "password-secret"}, BINDING, ROOT, RUN)

    def test_record_binding_nonce_uid_boot_receipt_and_hash_rejected(self):
        for name, field, value in (("service-kernel.json", "uid", 1001), ("service-kernel.json", "bootId", "bad"),
                                   ("execution-gate.json", "nonce", "0" * 64), ("unit.json", "unit", "ssh.service")):
            candidate = records()[name]
            candidate[field] = value
            self.assert_rejected(lambda: inspect.sanitize_record(name, candidate, BINDING, ROOT, RUN))
        candidate = records()["intent.json"]
        candidate["rootIdentity"] = {**ROOT, "uid": True}
        self.assert_rejected(lambda: inspect.sanitize_record("intent.json", candidate, BINDING, ROOT, RUN))

    def test_measurement_is_recorded_shape_not_historical_cleanup(self):
        facts = inspect.sanitize_record("measurement.json", measured(), BINDING, ROOT, RUN)
        self.assertTrue(facts["recordedGuardPassed"])
        self.assertTrue(facts["measurementShapeValid"])
        self.assertIsNone(facts["recordedCleanupVerified"])
        for change in (lambda v: v.update(providerReady=True),
                       lambda v: v["measurement"].update(providerExecuted=True),
                       lambda v: v["measurement"].update(openFDs=[False, 1, 2])):
            value = measured()
            change(value)
            self.assert_rejected(lambda: inspect.measurement(value, 1000))

    def test_result_closed_schema_and_cleanup_consistency(self):
        value = records()["result.json"]
        value["cleanupVerified"] = True
        self.assert_rejected(lambda: inspect.sanitize_record("result.json", value, BINDING, ROOT, RUN))
        value = records()["result.json"]
        value["completionState"] = "closed"
        self.assertIsNotNone(inspect.sanitize_record("closed.json", value, BINDING, ROOT, RUN))

    def test_closed_output_refuses_secret_or_promoted_readiness(self):
        result = inspect.initial_result(BINDING)
        self.assertEqual(inspect.validate_output(result, BINDING), result)
        for field, value in (("providerReady", True), ("cleanupHistorical", "verified"), ("snapshotAtomic", True), ("raw", "secret")):
            candidate = copy.deepcopy(result)
            candidate[field] = value
            self.assert_rejected(lambda: inspect.validate_output(candidate, BINDING))
        result["records"][0]["facts"]["recordedCode"] = "my-secret"
        self.assert_rejected(lambda: inspect.validate_output(result, BINDING))

    def test_unit_exited_mainpid_zero_is_observation_not_pid_failure(self):
        data = records()
        result = inspect.parse_unit(0, unit_output(), data["unit.json"], data["service-kernel.json"], UNIT)
        self.assertEqual(result["mainPID"], 0)
        self.assertEqual(result["subState"], "exited")
        self.assertEqual(result["code"], "UNIT_IDENTITY_CHANGED")
        self.assertFalse(result["savedIdentityMatches"])
        self.assertNotIn(CGROUP, canonical_bytes(result).decode())

    def test_unit_live_identity_and_missing_semantics(self):
        data = records()
        live = inspect.parse_unit(0, unit_output(ControlGroup=CGROUP, MainPID="100", SubState="running"), data["unit.json"], data["service-kernel.json"], UNIT)
        self.assertTrue(live["savedIdentityMatches"])
        missing = inspect.parse_unit(4, unit_output(LoadState="not-found", ActiveState="inactive", SubState="dead", InvocationID="", Result=""), data["unit.json"], data["service-kernel.json"], UNIT)
        self.assertEqual(missing["status"], "missing")
        self.assertIsNone(missing["result"])
        self.assert_rejected(lambda: inspect.parse_unit(0, unit_output(Result=""), None, None, UNIT))
        self.assert_rejected(lambda: inspect.parse_unit(4, unit_output(LoadState="not-found", Result="", InvocationID=""), None, None, UNIT))

    def test_unit_unknown_duplicate_unbounded_or_arbitrary_fields_rejected(self):
        for raw in (unit_output(Result="private-token"), unit_output(ControlGroup="/other.service"),
                    unit_output() + b"MainPID=999\n", unit_output() + b"Secret=token\n", b"x" * 32769):
            self.assert_rejected(lambda: inspect.parse_unit(0, raw, None, None, UNIT))


class ReadOnlyFileTests(unittest.TestCase):
    def tree(self):
        return inspect.ReadOnlyTree(1000, time.monotonic() + 30)

    def test_valid_file_read_is_readonly_and_held(self):
        fixture = SingleFile(b'{"value":1}')
        with fixture.patches():
            tree = self.tree()
            value, raw, digest = tree.read_json(10, "intent.json")
            self.assertEqual(value, {"value": 1})
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            self.assertEqual(len(tree.files), 1)
            self.assertEqual(tree.recheck(), {})
            self.assertTrue(all(flags & inspect.os.O_NOFOLLOW for flags in fixture.open_flags))

    def test_missing_is_distinct_from_bad_json(self):
        with patch.object(inspect.os, "stat", side_effect=FileNotFoundError()):
            with self.assertRaises(FileNotFoundError):
                self.tree().read_json(10, "intent.json")
        for data in (b"broken", b'{"a":1,"a":2}', b'{"a":1} ', b'{"a":1.2}'):
            fixture = SingleFile(data)
            with fixture.patches(), self.assertRaisesRegex(StageError, "JSON_REJECTED"):
                self.tree().read_json(10, "intent.json")

    def test_symlink_hardlink_wrong_owner_and_nonprivate_mode_rejected_before_open(self):
        for changes in ({"st_mode": stat.S_IFLNK | 0o777}, {"st_nlink": 2}, {"st_uid": 0},
                        {"st_mode": stat.S_IFREG | 0o644}, {"st_mode": stat.S_IFREG | 0o700}):
            fixture = SingleFile(b"{}")
            fixture.metadata.__dict__.update(changes)
            with fixture.patches(), self.assertRaisesRegex(StageError, "METADATA_REJECTED"):
                self.tree().read_json(10, "intent.json")
            self.assertEqual(fixture.open_flags, [])

    def test_per_file_and_aggregate_bounds_before_read(self):
        fixture = SingleFile(b"x" * 32769)
        with fixture.patches(), self.assertRaisesRegex(StageError, "SIZE_BOUND"):
            self.tree().read_json(10, "intent.json")
        fixture = SingleFile(b"{}")
        tree = self.tree()
        tree.total = inspect.MAX_TOTAL - 1
        with fixture.patches(), self.assertRaisesRegex(StageError, "TOTAL_BOUND"):
            tree.read_json(10, "intent.json")

    def test_open_race_and_content_change_are_not_valid_data(self):
        fixture = SingleFile(b'{"a":1}')
        other = meta(fixture.raw, inode=999)
        with fixture.patches(), patch.object(inspect.os, "fstat", return_value=other), self.assertRaisesRegex(StageError, "IDENTITY_CHANGED"):
            self.tree().read_json(10, "intent.json")
        fixture = SingleFile(b'{"a":1}')
        with fixture.patches():
            tree = self.tree()
            tree.read_json(10, "intent.json")
            fixture.raw = b'{"a":2}'
            self.assertEqual(tree.recheck(), {"intent.json": "CONTENT_CHANGED"})

    def test_deadline_precedes_file_access(self):
        tree = inspect.ReadOnlyTree(1000, time.monotonic() - 1)
        with patch.object(inspect.os, "stat", side_effect=AssertionError("access after deadline")), self.assertRaisesRegex(StageError, "DEADLINE"):
            tree.read_json(10, "intent.json")


class InspectionLifecycleTests(unittest.TestCase):
    def run_inspection(self, tree=None, boot=None, query=None):
        tree = tree or RecordTree()
        def fstat(fd):
            return meta(inode=fd)
        with patch.object(inspect.sys, "platform", "linux"), patch.object(inspect, "pwd", object()), \
             patch.object(inspect.os, "getuid", return_value=1000, create=True), \
             patch.object(inspect.os, "geteuid", return_value=1000, create=True), \
             patch.object(inspect.os, "fstat", side_effect=fstat), \
             patch("builtins.open", return_value=io.BytesIO((boot or BOOT).encode() + b"\n")), \
             patch.object(inspect, "ReadOnlyTree", return_value=tree), \
             patch.object(inspect, "query_unit", return_value=(0, query or unit_output())) as called, \
             patch.object(inspect, "read_cgroup", side_effect=AssertionError("must not follow absent/replaced cgroup")), \
             patch.object(inspect.os, "unlink", side_effect=AssertionError("remote write")), \
             patch.object(inspect.os, "mkdir", side_effect=AssertionError("remote write")), \
             patch.object(inspect.os, "kill", side_effect=AssertionError("unit/process signal")):
            result = inspect.inspect(BINDING, time.monotonic() + 30)
        return result, called

    def test_exited_unit_inspection_preserves_unknown_lease_no_provider(self):
        tree = RecordTree()
        before = copy.deepcopy(tree.values)
        result, called = self.run_inspection(tree)
        self.assertTrue(result["ok"])
        self.assertEqual(result["cleanupHistorical"], "unknown")
        self.assertFalse(result["providerReady"])
        self.assertEqual(result["cgroup"]["code"], "UNIT_IDENTITY_CHANGED")
        self.assertEqual(tree.values, before)
        self.assertTrue(tree.closed)
        called.assert_called_once()
        self.assertLess(len(canonical_bytes(result)), inspect.MAX_OUTPUT)

    def test_rejected_record_is_sanitized_and_not_raw_exported(self):
        tree = RecordTree()
        tree.values["service-error.json"] = {"code": "secret-password-from-file"}
        result, _ = self.run_inspection(tree)
        self.assertFalse(result["ok"])
        error = next(r for r in result["records"] if r["name"] == "service-error.json")
        self.assertEqual(error["status"], "rejected")
        self.assertNotIn(b"secret-password", canonical_bytes(result))

    def test_wrong_boot_and_missing_or_changed_lease_block_systemctl(self):
        result, called = self.run_inspection(boot="wrong-boot")
        self.assertEqual(result["code"], "BOOT_REJECTED")
        called.assert_not_called()
        tree = RecordTree()
        del tree.values["active.json"]
        result, called = self.run_inspection(tree)
        self.assertEqual(result["code"], "LEASE_REJECTED")
        called.assert_not_called()
        tree = RecordTree(changes={"active.json": "CONTENT_CHANGED"})
        result, called = self.run_inspection(tree)
        self.assertEqual(result["code"], "CONTENT_CHANGED")
        self.assertEqual(result["records"][-1]["status"], "changed")
        called.assert_not_called()

    def test_cross_record_invocation_mismatch_blocks_query(self):
        tree = RecordTree()
        tree.values["execution-gate.json"]["invocationId"] = "f" * 32
        result, called = self.run_inspection(tree)
        self.assertEqual(result["code"], "BINDING_REJECTED")
        called.assert_not_called()


class RuntimeAndCgroupTests(unittest.TestCase):
    def test_exact_query_uses_held_tool_fd_and_fixed_arguments(self):
        raw_tool = b"synthetic-ELF-not-executed"
        tool = {"device": 1, "inode": 90, "uid": 0,
                "sha256": hashlib.sha256(raw_tool).hexdigest()}
        tree = SimpleNamespace(tick=lambda: None, deadline=time.monotonic() + 20)
        stdout = SimpleNamespace(fileno=lambda: 101, close=lambda: None)
        stderr = SimpleNamespace(fileno=lambda: 102, close=lambda: None)
        child = SimpleNamespace(stdout=stdout, stderr=stderr, wait=lambda **_kwargs: 0,
                                poll=lambda: 0, kill=lambda: self.fail("completed child killed"))
        reads = {20: [raw_tool, b""], 101: [unit_output(), b""], 102: [b""]}
        with patch.object(inspect, "open_systemctl", return_value=(20, [])), \
             patch.object(inspect, "verify_tool"), patch.object(inspect.os, "fstat", return_value=meta(uid=0)), \
             patch.object(inspect.os, "lseek"), patch.object(inspect.os, "read", side_effect=lambda fd, _n: reads[fd].pop(0)), \
             patch.object(inspect.select, "select", side_effect=lambda fds, *_args: (fds, [], [])), \
             patch.object(inspect.subprocess, "Popen", return_value=child) as popen:
            code, raw = inspect.query_unit(tree, UNIT, 1000, tool)
        self.assertEqual((code, raw), (0, unit_output()))
        args, kwargs = popen.call_args
        self.assertEqual(args[0], ["/usr/bin/systemctl", "--user", "--no-pager", "show", UNIT,
                                  "--property=" + ",".join(inspect.PROPERTIES)])
        self.assertEqual(kwargs["executable"], "/proc/self/fd/20")
        self.assertEqual(kwargs["pass_fds"], (20,))
        self.assertEqual(set(kwargs["env"]), {"PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"})

    def test_tool_mismatch_blocks_spawn(self):
        tree = SimpleNamespace(tick=lambda: None, deadline=time.monotonic() + 20)
        with patch.object(inspect, "open_systemctl", return_value=(20, [])), \
             patch.object(inspect, "verify_tool"), patch.object(inspect.os, "fstat", return_value=meta(uid=0)), \
             patch.object(inspect.subprocess, "Popen", side_effect=AssertionError("must not spawn")), \
             self.assertRaisesRegex(StageError, "RUNTIME_REJECTED"):
            inspect.query_unit(tree, UNIT, 1000, {"device": 99, "inode": 90, "uid": 0})

    def test_output_overflow_kills_only_owned_unreaped_inspection_child(self):
        raw_tool = b"fixture"
        tool = {"device": 1, "inode": 90, "uid": 0, "sha256": hashlib.sha256(raw_tool).hexdigest()}
        tree = SimpleNamespace(tick=lambda: None, deadline=time.monotonic() + 20)
        events = []
        stdout = SimpleNamespace(fileno=lambda: 101, close=lambda: events.append("stdout-close"))
        stderr = SimpleNamespace(fileno=lambda: 102, close=lambda: events.append("stderr-close"))
        child = SimpleNamespace(stdout=stdout, stderr=stderr, poll=lambda: None,
                                wait=lambda: events.append("wait"), kill=lambda: events.append("owned-kill"))
        reads = [raw_tool, b""]
        with patch.object(inspect, "open_systemctl", return_value=(20, [])), \
             patch.object(inspect, "verify_tool"), patch.object(inspect.os, "fstat", return_value=meta(uid=0)), \
             patch.object(inspect.os, "lseek"), \
             patch.object(inspect.os, "read", side_effect=lambda fd, _n: reads.pop(0) if fd == 20 else b"x" * 4096), \
             patch.object(inspect.select, "select", side_effect=lambda fds, *_args: (fds, [], [])), \
             patch.object(inspect.subprocess, "Popen", return_value=child), \
             patch.object(inspect.os, "kill", side_effect=AssertionError("arbitrary pid signal")), \
             self.assertRaisesRegex(StageError, "TOOL_OUTPUT_BOUND"):
            inspect.query_unit(tree, UNIT, 1000, tool)
        self.assertEqual(events, ["owned-kill", "wait", "stdout-close", "stderr-close"])

    def test_cgroup_saved_inode_checked_before_reading_fixed_files(self):
        data = records()
        opened = []
        tree = SimpleNamespace(uid=1000, fds=[], root=lambda: 1,
                               directory=lambda parent, name, owners: opened.append(name) or 40)
        with patch.object(inspect.os, "fstat", return_value=meta(inode=999)), \
             patch.object(inspect.os, "open", side_effect=AssertionError("must not open cgroup file")), \
             self.assertRaisesRegex(StageError, "CGROUP_IDENTITY_CHANGED"):
            inspect.read_cgroup(tree, data["unit.json"], data["service-kernel.json"], UNIT)
        self.assertEqual(opened[-1], UNIT)

    def test_cgroup_fixed_five_files_and_values_without_historical_claim(self):
        data = records()
        group_meta = meta(inode=40)
        group_meta.st_dev = 2
        contents = {"cgroup.events": b"populated 0\nfrozen 0\n", "memory.max": b"6442450944\n",
                    "memory.swap.max": b"0\n", "pids.max": b"256\n", "cpu.max": b"150000 100000\n"}
        opened, mapped = [], {}
        def open_file(name, flags, **kwargs):
            self.assertEqual(kwargs, {"dir_fd": 40})
            self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            opened.append(name)
            mapped[len(opened) + 100] = name
            return len(opened) + 100
        tree = SimpleNamespace(uid=1000, fds=[], root=lambda: 1, verify_dirs=lambda: None,
                               directory=lambda *_args: 40,
                               read_bytes=lambda fd, _maximum: contents[mapped[fd]])
        with patch.object(inspect.os, "fstat", side_effect=lambda fd: group_meta if fd == 40 else meta()), \
             patch.object(inspect.os, "stat", return_value=meta()), \
             patch.object(inspect.os, "open", side_effect=open_file), \
             patch.object(inspect.os, "O_NOFOLLOW", 0x20000, create=True):
            result = inspect.read_cgroup(tree, data["unit.json"], data["service-kernel.json"], UNIT)
        self.assertEqual(opened, list(contents))
        self.assertEqual(result["populated"], 0)
        self.assertTrue(result["identityMatches"])
        self.assertNotIn("cleanupVerified", result)

    def test_emit_is_bounded_framed_and_backpressure_deadline_holds(self):
        parts = []
        result = inspect.initial_result(BINDING)
        with patch.object(inspect.os, "set_blocking") as nonblock, \
             patch.object(inspect.select, "select", side_effect=lambda _r, w, *_args: ([], w, [])), \
             patch.object(inspect.os, "write", side_effect=lambda _fd, part: parts.append(bytes(part)) or len(part)):
            inspect.emit_output(3, result, BINDING, time.monotonic() + 10)
        nonblock.assert_called_once_with(3, False)
        frame = b"".join(parts)
        self.assertEqual(struct.unpack("!I", frame[:4])[0], len(frame) - 4)
        self.assertEqual(frame[4:], canonical_bytes(result))
        with patch.object(inspect.os, "set_blocking"), \
             patch.object(inspect.os, "write", side_effect=AssertionError("write after deadline")), \
             self.assertRaisesRegex(StageError, "DEADLINE"):
            inspect.emit_output(3, result, BINDING, time.monotonic() - 1)


if __name__ == "__main__":
    unittest.main()
