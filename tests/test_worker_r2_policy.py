import ast
import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub" / "worker"))
from r2_policy import PolicyError, SYNTHETIC_SOURCE, build_policy


def request():
    return {"schemaVersion": 1, "case": "isolation-v1", "runNonce": "a" * 64,
            "bootId": "12345678-1234-4234-8234-123456789abc", "workerSHA256": "b" * 64,
            "runtimeSeconds": 60}


class R2PolicyTests(unittest.TestCase):
    def test_only_exact_builtin_request_fields_and_types(self):
        for value in (None, [], "x", {}, dict(request(), command="id"),
                      dict(request(), env={"SSH_AUTH_SOCK": "/tmp/agent"}),
                      dict(request(), runtime={}), dict(request(), hostpath="/home"),
                      dict(request(), issuedAt=0), dict(request(), permit=True),
                      dict(request(), schemaVersion=True), dict(request(), schemaVersion=2)):
            with self.subTest(value=value), self.assertRaises(PolicyError):
                build_policy(value)
        class RequestSubclass(dict):
            pass
        with self.assertRaises(PolicyError):
            build_policy(RequestSubclass(request()))

    def test_rejects_arbitrary_provider_and_synthetic_commands(self):
        for case in ("claude", "grok", "--version", "owned-descendants-v1", "", None, True,
                     "isolation-v1\n", "isolation-v1;id"):
            with self.subTest(case=case), self.assertRaisesRegex(PolicyError, "R2_SYNTHETIC_CASE_REJECTED"):
                build_policy(dict(request(), case=case))

    def test_nonce_worker_hash_and_boot_binding_are_strict(self):
        for field in ("runNonce", "workerSHA256"):
            for value in (None, True, "a" * 63, "A" * 64, "0" * 64, "a" * 64 + "\n"):
                with self.subTest(field=field, value=value), self.assertRaises(PolicyError):
                    build_policy(dict(request(), **{field: value}))
        for value in (None, "12345678-1234-4234-8234-123456789ABc", "0" * 36,
                      "00000000-0000-0000-0000-000000000000", request()["bootId"] + "\n"):
            with self.subTest(value=value), self.assertRaises(PolicyError):
                build_policy(dict(request(), bootId=value))

    def test_runtime_duration_has_hard_bound_without_bool_coercion(self):
        for value in (0, -1, 1801, True, False, 1.0, "60", None):
            with self.subTest(value=value), self.assertRaisesRegex(PolicyError, "R2_RUNTIME_LIMIT_REJECTED"):
                build_policy(dict(request(), runtimeSeconds=value))
        for value in (1, 1800):
            self.assertEqual(build_policy(dict(request(), runtimeSeconds=value))["limits"]["runtimeSeconds"], value)

    def test_namespace_flags_are_strict_and_never_optional(self):
        argv = build_policy(request())["bwrapArgv"]
        for flag in ("--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc",
                     "--unshare-uts", "--unshare-cgroup"):
            self.assertEqual(argv.count(flag), 1)
        self.assertNotIn("--unshare-all", argv)
        self.assertFalse(any(flag.endswith("-try") or flag.startswith("--share-") for flag in argv))
        self.assertEqual(argv[argv.index("--cap-drop") + 1], "ALL")
        self.assertIn("--clearenv", argv)

    def test_tmpfs_limits_apply_to_the_correct_next_mount(self):
        argv = build_policy(request())["bwrapArgv"]
        measured = {}
        for index, value in enumerate(argv):
            if value == "--tmpfs":
                self.assertEqual(argv[index - 4:index - 1], ["--perms", "0700", "--size"])
                measured[argv[index + 1]] = int(argv[index - 1])
        self.assertEqual(measured, {"/work": 2147483648, "/profile": 268435456, "/tmp": 536870912})
        self.assertIn("--remount-ro", argv)
        self.assertEqual(argv[argv.index("--remount-ro") + 1], "/")

    def test_resources_and_cgroup_lifecycle_are_explicit(self):
        policy = build_policy(request())
        properties = policy["systemd"]["propertyArgv"]
        for required in ("MemoryMax=6442450944", "MemorySwapMax=0", "CPUQuota=150%",
                         "TasksMax=256", "RuntimeMaxSec=60s", "KillMode=control-group",
                         "Delegate=no", "Restart=no", "NoNewPrivileges=yes", "RemainAfterExit=yes"):
            self.assertIn("--property=" + required, properties)
        self.assertTrue(policy["systemd"]["requiresPopulatedZeroBeforeCollection"])
        self.assertIn("--expand-environment=no", policy["systemd"]["fixedArgv"])
        self.assertTrue(policy["systemd"]["requiresInvocationIdAndCgroupIdentity"])
        self.assertEqual(policy["limits"]["activeRuns"], 1)
        self.assertEqual(policy["limits"]["admissionAvailableMemoryBytes"], 10 * 1024**3)
        self.assertEqual(policy["limits"]["admissionAvailableDiskBytes"], 20 * 1024**3)

    def test_fixed_runtime_cannot_bind_host_home_auth_or_manager_paths(self):
        policy = build_policy(request())
        mounts = policy["runtimeRequirements"]["mounts"]
        self.assertEqual([(row["source"], row["destination"], row["readOnly"]) for row in mounts],
                         [("/usr", "/usr", True)])
        argv = policy["bwrapArgv"][:-1]
        for forbidden in ("/home", "/root", "/run/user", "/sys/fs/cgroup", "--bind", "--bind-try",
                          "--preserve-fds", "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS"):
            self.assertNotIn(forbidden, argv)
        self.assertEqual(policy["fileDescriptors"]["preservedExtraFDs"], [])
        self.assertFalse(policy["fileDescriptors"]["retainsTmpfsAfterExit"])

    def test_runtime_tool_type_is_checked_after_confined_symlink_resolution(self):
        runtime = build_policy(request())["runtimeRequirements"]
        self.assertNotIn("requiresResolvedSymlinkIdentity", runtime)
        self.assertEqual(runtime["toolResolution"], {
            "typeAppliesTo": "resolved-target", "allowedResolvedRoot": "/usr",
            "rejectAnySymlinkTargetOutsideRoot": True,
            "requireHeldIdentitiesForAllComponentsLinksAndTarget": True,
            "requireRootOwnerForAllComponentsLinksAndTarget": True,
            "directoryAndTargetRejectModeBits": 0o022,
            "symlinkModeBitsAreNotWriteProtection": True,
        })
        self.assertIn("/usr/bin/python3", [row["path"] for row in runtime["tools"]])
        self.assertTrue(all(row["type"] == "regular" and row["ownerUid"] == 0
                            and row["rejectModeBits"] == 0o6022
                            and row["requiresHeldDescriptorAndSHA256"]
                            for row in runtime["tools"]))

    def test_payload_is_fixed_valid_python_and_has_no_command_input(self):
        compile(SYNTHETIC_SOURCE, "r2-synthetic", "exec")
        policy = build_policy(request())
        self.assertEqual(policy["bwrapArgv"][-5:], ["/usr/bin/python3", "-I", "-B", "-c", SYNTHETIC_SOURCE])
        imports = [node for node in ast.walk(ast.parse(SYNTHETIC_SOURCE)) if isinstance(node, ast.Import)]
        self.assertEqual([alias.name for node in imports for alias in node.names], ["json", "os"])
        self.assertEqual(policy["syntheticSourceSHA256"], hashlib.sha256(SYNTHETIC_SOURCE.encode("ascii")).hexdigest())

    def test_hash_is_canonical_binds_context_and_no_input_is_mutated(self):
        original = request()
        saved = copy.deepcopy(original)
        policy = build_policy(original)
        self.assertEqual(original, saved)
        expected = dict(policy)
        digest = expected.pop("policySHA256")
        encoded = json.dumps(expected, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                             allow_nan=False).encode("ascii")
        self.assertEqual(hashlib.sha256(encoded).hexdigest(), digest)
        self.assertEqual(build_policy(dict(reversed(list(original.items())))), policy)
        for key, value in (("runNonce", "c" * 64), ("workerSHA256", "d" * 64),
                           ("bootId", "12345678-1234-4234-8234-123456789abd"), ("runtimeSeconds", 61)):
            self.assertNotEqual(build_policy(dict(original, **{key: value}))["policySHA256"], digest)

    def test_results_are_detached_and_never_claim_authorized_or_ready(self):
        first = build_policy(request())
        first["bwrapArgv"].append("bad")
        first["runtimeRequirements"]["mounts"][0]["source"] = "/home"
        second = build_policy(request())
        self.assertNotEqual(first, second)
        self.assertEqual(second["scope"], {"policyOnly": True, "runAuthorized": False,
            "providerReady": False, "runtimeVerified": False, "supervisorImplemented": False,
            "cleanupVerified": False})
        self.assertFalse(second["runtimeRequirements"]["verificationPerformed"])

    def test_schema_closes_request_and_output_fields_and_fixes_commands(self):
        filename = Path(__file__).resolve().parents[1] / "hub/windows/worker-r2-policy.schema.json"
        schema = json.loads(filename.read_text(encoding="utf-8"))
        request_schema, policy_schema = (schema["$defs"][name] for name in ("request", "policy"))
        self.assertEqual(schema["oneOf"], [{"$ref": "#/$defs/request"}, {"$ref": "#/$defs/policy"}])
        for definition, instance in ((request_schema, request()), (policy_schema, build_policy(request()))):
            self.assertFalse(definition["additionalProperties"])
            self.assertEqual(set(definition["required"]), set(instance))
            self.assertEqual(set(definition["properties"]), set(instance))
        request_properties = request_schema["properties"]
        self.assertEqual(request_properties["schemaVersion"], {"type": "integer", "const": 1})
        self.assertEqual(request_properties["runtimeSeconds"], {"type": "integer", "minimum": 1, "maximum": 1800})
        policy = build_policy(request())
        props = policy_schema["properties"]
        for key in ("bwrapArgv", "scope", "runtimeRequirements", "fileDescriptors",
                    "executionRequirements", "syntheticSourceSHA256"):
            self.assertEqual(props[key], {"const": policy[key]})
        for key in ("binding", "limits", "systemd"):
            self.assertFalse(props[key]["additionalProperties"])
            self.assertEqual(set(props[key]["required"]), set(policy[key]))
            self.assertEqual(set(props[key]["properties"]), set(policy[key]))
        unit_schema = props["systemd"]["properties"]["unit"]
        self.assertEqual(len(policy["systemd"]["unit"]), unit_schema["minLength"])
        self.assertEqual(unit_schema["minLength"], unit_schema["maxLength"])
        self.assertRegex(policy["systemd"]["unit"], unit_schema["pattern"])
        declared_args = props["systemd"]["properties"]["propertyArgv"]
        self.assertFalse(declared_args["items"])
        self.assertEqual(declared_args["minItems"], len(policy["systemd"]["propertyArgv"]))
        self.assertEqual(declared_args["maxItems"], declared_args["minItems"])
        for index, spec in enumerate(declared_args["prefixItems"]):
            if index != 4:
                self.assertEqual(spec, {"const": policy["systemd"]["propertyArgv"][index]})
        duration_pattern = declared_args["prefixItems"][4]["pattern"]
        for seconds in (1, 60, 999, 1000, 1799, 1800):
            self.assertIsNotNone(re.fullmatch(duration_pattern, "--property=RuntimeMaxSec=" + str(seconds) + "s"))
        for seconds in (0, 1801, 1999, 2000):
            self.assertIsNone(re.fullmatch(duration_pattern, "--property=RuntimeMaxSec=" + str(seconds) + "s"))

    def test_examples_match_real_builder_and_rejections(self):
        filename = Path(__file__).resolve().parents[1] / "hub/windows/worker-r2-policy-examples.json"
        examples = json.loads(filename.read_text(encoding="utf-8"))
        self.assertEqual(build_policy(examples["request"]), examples["policy"])
        for rejected in examples["rejectedRequests"]:
            with self.subTest(rejected=rejected), self.assertRaises(PolicyError):
                build_policy(rejected)


if __name__ == "__main__":
    unittest.main()
