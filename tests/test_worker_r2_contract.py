"""Portable refusal tests; fixture dictionaries are not Linux measurements."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub" / "worker"))
from stage_protocol import StageError
from r2_contract import (NAMESPACES, TMPFS, cleanup_result, no_execution_cleanup,
                         parse_cgroup, validate_request, verify_isolation, verify_limits)

CATALOG = "c" * 64
BOOT = "12345678-1234-4234-8234-123456789abc"


def request():
    return {"protocol": 1, "op": "run-r2-synthetic-v1", "sequence": 1, "nonce": "a" * 64,
            "catalogSHA256": CATALOG, "bootId": BOOT, "uid": 1000, "case": "isolation-v1",
            "expiresAtUnixSeconds": 100060, "runtimeSeconds": 60}


def validate(value):
    return validate_request(value, catalog=CATALOG, boot=BOOT, uid=1000, now=100000)


def measurement():
    return {"schemaVersion": 1, "kind": "project-hub-r2-isolation-measurement",
            "namespaces": {name: 200 + i for i, name in enumerate(NAMESPACES)}, "uid": 1000,
            "capabilities": {name: "0000000000000000" for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")},
            "noNewPrivs": "1", "interfaces": ["lo"], "openFDs": [0, 1, 2],
            "rootReadOnly": True, "usrReadOnly": True,
            "forbiddenPathsVisible": {name: False for name in ("/home", "/root", "/sys/fs/cgroup",
                                       "/run/user", "/run/dbus", "/var/run/docker.sock")},
            "tmpfsCapacityBytes": dict(TMPFS), "providerExecuted": False}


OUTER = {name: 100 + i for i, name in enumerate(NAMESPACES)}


class R2ContractTests(unittest.TestCase):
    def test_fixed_request_is_detached_and_exact(self):
        original = request()
        accepted = validate(original)
        self.assertEqual(original, accepted)
        self.assertIsNot(original, accepted)
        for value in (None, [], {}, dict(original, command="id"), dict(original, source="print(1)"),
                      dict(original, path="/home"), dict(original, argv=[]), dict(original, env={}),
                      dict(original, limits={}), dict(original, expiresAtUnixMs=100060000)):
            with self.subTest(value=value), self.assertRaises(StageError):
                validate(value)

    def test_request_replay_sequence_case_and_boolean_coercion_are_rejected(self):
        for key, values in {"protocol": [True, 2], "sequence": [True, 0, 2],
                            "op": ["run", "stage", "probe"], "case": ["claude", "grok", "isolation-v2"],
                            "runtimeSeconds": [True, 59, 61, 60.0], "uid": [True, 0, 1001]}.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(StageError):
                    validate(dict(request(), **{key: value}))

    def test_expiry_is_short_signed_integer_seconds(self):
        for expiry in (True, 100000, 99999, 100121, 100060.0, 2147483648):
            with self.subTest(expiry=expiry), self.assertRaises(StageError):
                validate(dict(request(), expiresAtUnixSeconds=expiry))
        for expiry in (100001, 100120):
            self.assertEqual(validate(dict(request(), expiresAtUnixSeconds=expiry))["expiresAtUnixSeconds"], expiry)

    def test_exact_boot_uid_catalog_and_nonce_are_not_substitutable(self):
        for key, value in (("nonce", "a" * 63), ("nonce", "0" * 64), ("nonce", "A" * 64),
                           ("nonce", "a" * 64 + "\n"), ("bootId", BOOT.upper()),
                           ("catalogSHA256", "d" * 64), ("uid", 0)):
            with self.subTest(key=key), self.assertRaises(StageError):
                validate(dict(request(), **{key: value}))

    def test_kernel_limits_need_actual_exact_values(self):
        limits = {"memory.max": "6442450944", "memory.swap.max": "0", "pids.max": "256", "cpu.max": "150000 100000"}
        self.assertTrue(verify_limits(limits))
        for key, value in (("memory.max", "max"), ("memory.max", 6442450944), ("memory.swap.max", "1"),
                           ("pids.max", "max"), ("cpu.max", "max 100000"), ("cpu.max", "149999 100000"),
                           ("cpu.max", "150000 0"), ("cpu.max", "150000 100000\n")):
            with self.subTest(key=key, value=value), self.assertRaises(StageError):
                verify_limits(dict(limits, **{key: value}))
        with self.assertRaises(StageError):
            verify_limits(dict(limits, verified=True))

    def test_each_namespace_must_change_and_no_namespace_may_be_omitted(self):
        self.assertTrue(verify_isolation(measurement(), OUTER, 1000))
        for name in NAMESPACES:
            for kind in ("unchanged", "missing", "bool"):
                sample = measurement()
                if kind == "missing":
                    del sample["namespaces"][name]
                else:
                    sample["namespaces"][name] = OUTER[name] if kind == "unchanged" else True
                with self.subTest(name=name, kind=kind), self.assertRaises(StageError):
                    verify_isolation(sample, OUTER, 1000)

    def test_extra_fds_caps_network_paths_mount_or_quota_fail_before_payload(self):
        changes = [("uid", 0), ("uid", True), ("noNewPrivs", "0"), ("interfaces", ["lo", "eth0"]),
                   ("openFDs", [0, 1, 2, 3]), ("openFDs", [0, True, 2]), ("rootReadOnly", False),
                   ("usrReadOnly", 1), ("providerExecuted", True), ("schemaVersion", True)]
        for key, value in changes:
            sample = measurement()
            sample[key] = value
            with self.subTest(key=key), self.assertRaises(StageError):
                verify_isolation(sample, OUTER, 1000)
        for group, key, value in (("capabilities", "CapEff", "0000000000000001"),
                                  ("capabilities", "CapBnd", "0000000000000001"),
                                  ("forbiddenPathsVisible", "/run/user", True),
                                  ("tmpfsCapacityBytes", "/work", TMPFS["/work"] + 4096)):
            sample = measurement()
            sample[group][key] = value
            with self.subTest(group=group, key=key), self.assertRaises(StageError):
                verify_isolation(sample, OUTER, 1000)

    def test_cgroup_path_is_single_v2_and_exact_owned_unit(self):
        unit = "project-hub-r2-" + "a" * 64 + ".service"
        self.assertEqual(parse_cgroup("0::/user.slice/user-1000.slice/" + unit + "\n", unit)[-1], unit)
        for text in ("0::/../../" + unit, "0::/x//" + unit, "0::/x/another.service", "1:cpu:/" + unit,
                     "0::/x/" + unit + "\n0::/x/" + unit, "0::/x/" + unit + "/child"):
            with self.subTest(text=text), self.assertRaises(StageError):
                parse_cgroup(text, unit)

    def test_cleanup_never_conflates_unit_absence_or_eof_with_populated_zero(self):
        for missing in range(4):
            values = [True] * 4
            values[missing] = False
            result = cleanup_result(populated_zero=values[0], unit_stopped=values[1],
                                    identity_preserved=values[2], outputs_closed=values[3])
            self.assertFalse(result["cleanupVerified"])
        self.assertTrue(cleanup_result(populated_zero=True, unit_stopped=True,
                                       identity_preserved=True, outputs_closed=True)["cleanupVerified"])
        untouched = no_execution_cleanup()
        self.assertTrue(untouched["cleanupVerified"])
        self.assertFalse(untouched["populatedZeroObserved"])
        self.assertEqual(untouched["basis"], "no-process-start-attempt")


if __name__ == "__main__":
    unittest.main()
