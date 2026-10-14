"""Portable contract and control-flow tests; no Linux execution claim."""
import base64
import errno
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub" / "worker"))
import r2_supervisor as supervisor
import r2_runtime as runtime
from r2_runtime import resolve_tool_link
from stage_protocol import StageError


class R2SupervisorTests(unittest.TestCase):
    def test_publication_uses_noreplace_without_an_overwrite_fallback(self):
        native = Mock()
        native.renameat2.return_value = 0
        with patch.object(runtime.ctypes, "CDLL", return_value=native):
            runtime.publish_new(42, ".gate.pending-fixture", "gate.json")
        native.renameat2.assert_called_once_with(42, b".gate.pending-fixture", 42, b"gate.json", 1)
        native.renameat2.return_value = -1
        with patch.object(runtime.ctypes, "CDLL", return_value=native), \
             patch.object(runtime.ctypes, "get_errno", return_value=errno.EEXIST):
            with self.assertRaises(FileExistsError):
                runtime.publish_new(42, ".gate.pending-fixture", "gate.json")
        with patch.object(runtime.ctypes, "CDLL", return_value=object()):
            with self.assertRaisesRegex(StageError, "R2_ATOMIC_PUBLICATION_UNAVAILABLE"):
                runtime.publish_new(42, ".gate.pending-fixture", "gate.json")

    def test_symlink_resolution_never_accepts_escape_then_return(self):
        self.assertEqual(resolve_tool_link("/usr/bin", "python3.14"), "/usr/bin/python3.14")
        self.assertEqual(resolve_tool_link("/usr/bin", "../lib/python3.14"), "/usr/lib/python3.14")
        for target in ("/tmp/python3", "../../tmp/inside", "/usr2/python", "../../../etc/passwd", "bad\0path"):
            with self.subTest(target=target), self.assertRaises(StageError):
                resolve_tool_link("/usr/bin", target)

    def test_systemd_show_accepts_not_found_only_at_explicit_boundaries(self):
        unit = object.__new__(supervisor.OwnedUnit)
        unit.control = Mock(return_value=subprocess.CompletedProcess([], 4, b"LoadState=not-found\n", b""))
        with self.assertRaises(StageError):
            unit.show()
        self.assertEqual(unit.show(allow_not_found=True), {"LoadState": "not-found"})
        unit.control.return_value = subprocess.CompletedProcess([], 4, b"LoadState=loaded\n", b"")
        with self.assertRaises(StageError):
            unit.show(allow_not_found=True)
        unit.control.return_value = subprocess.CompletedProcess([], 1, b"LoadState=not-found\n", b"")
        with self.assertRaises(StageError):
            unit.show(allow_not_found=True)

    def test_systemd_properties_duplicate_unknown_or_unframed_are_rejected(self):
        for content in (b"LoadState=loaded\nLoadState=not-found\n", b"garbage\n", b"Secret=x\n", b"x" * 32769):
            with self.subTest(content=content[:50]), self.assertRaises(StageError):
                supervisor.properties(content)

    def test_cleanup_stops_only_the_previously_verified_unit_after_zero(self):
        unit = object.__new__(supervisor.OwnedUnit)
        unit.verify = Mock(return_value={})
        unit.populated_zero = Mock(return_value=True)
        unit.control = Mock(return_value=subprocess.CompletedProcess([], 0, b"", b""))
        unit.show = Mock(return_value={"LoadState": "not-found"})
        unit.invocation = "b" * 32
        result = unit.cleanup()
        self.assertTrue(result["cleanupVerified"])
        self.assertTrue(result["populatedZeroObserved"])
        unit.control.assert_called_once_with("stop")
        self.assertEqual(unit.verify.call_count, 2)

    def test_changed_unit_identity_never_triggers_kill_or_stop(self):
        unit = object.__new__(supervisor.OwnedUnit)
        unit.verify = Mock(side_effect=StageError("R2_UNIT_IDENTITY_CHANGED"))
        unit.control = Mock()
        result = unit.cleanup()
        self.assertFalse(result["cleanupVerified"])
        self.assertFalse(result["identityPreserved"])
        unit.control.assert_not_called()

    def test_disappearing_cgroup_is_unknown_not_clean(self):
        unit = object.__new__(supervisor.OwnedUnit)
        unit.verify = Mock(return_value={})
        unit.populated_zero = Mock(side_effect=FileNotFoundError())
        unit.control = Mock()
        result = unit.cleanup()
        self.assertFalse(result["cleanupVerified"])
        self.assertFalse(result["populatedZeroObserved"])
        unit.control.assert_not_called()

    def test_cgroup_events_requires_real_populated_field(self):
        unit = object.__new__(supervisor.OwnedUnit)
        unit.events_fd = 42
        with patch.object(supervisor.os, "lseek"), patch.object(supervisor.os, "read", return_value=b"populated 0\nfrozen 0\n"):
            self.assertTrue(unit.populated_zero())
        for data in (b"", b"populated 1\n", b"populated 0\npopulated 1\n", b"populated 2\n", b"other 0\n"):
            with patch.object(supervisor.os, "lseek"), patch.object(supervisor.os, "read", return_value=data):
                if data == b"populated 1\n":
                    self.assertFalse(unit.populated_zero())
                else:
                    with self.assertRaises(StageError):
                        unit.populated_zero()

    def test_generated_guard_compiles_and_gates_before_synthetic_writes(self):
        folder = Path(__file__).resolve().parents[1] / "hub/worker"
        bundle = {name: base64.b64encode(zlib.compress((folder / name).read_bytes())).decode("ascii")
                  for name in ("stage_protocol.py", "r2_contract.py")}
        outer = {name: 100 + i for i, name in enumerate(supervisor.NAMESPACES)}
        with patch.object(supervisor, "SOURCE_BUNDLE", bundle):
            source = supervisor.guard_program(outer, 1000)
        compile(source, "guard-contract-test", "exec")
        self.assertLess(source.index("verify_isolation(measurement"), source.index('fd=os.open(name'))
        self.assertNotIn("socket", source)
        self.assertNotIn("/home", source.split('data=b"Project Hub')[1])

    def test_generated_service_is_fixed_catalog_and_rejects_new_entry(self):
        folder = Path(__file__).resolve().parents[1] / "hub/worker"
        names = ("stage_protocol.py", "r2_policy.py", "r2_contract.py", "r2_runtime.py", "r2_supervisor.py")
        bundle = {name: base64.b64encode(zlib.compress((folder / name).read_bytes())).decode("ascii") for name in names}
        rows = [{"name": name, "bytes": (folder / name).stat().st_size,
                 "sha256": hashlib.sha256((folder / name).read_bytes()).hexdigest()} for name in names]
        with patch.object(supervisor, "SOURCE_BUNDLE", bundle), patch.object(supervisor, "SOURCE_IDENTITIES", rows), \
             patch.object(supervisor, "CATALOG_SHA256", "c" * 64), patch.object(supervisor, "SOURCE_BUNDLE_SHA256", "d" * 64):
            source = supervisor.source_program("service_main", {"request": "fixture-only"})
            compile(source, "service-contract-test", "exec")
            self.assertLessEqual(len(source.encode("ascii")), 120 * 1024)
            with self.assertRaises(StageError):
                supervisor.source_program("run_shell", {})

    def test_emitter_cannot_override_protocol_identity(self):
        emitter = supervisor.Emitter("a" * 64)
        for fields in ({"nonce": "b" * 64}, {"sequence": 999}, {"protocol": 2}, {"op": "run"}):
            with self.subTest(fields=fields), self.assertRaises(StageError):
                emitter.send("heartbeat", **fields)


if __name__ == "__main__":
    unittest.main()
