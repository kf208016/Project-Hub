"""Offline-only tests. No real CLR API, LPAC profile, or runtime snapshot."""
import ast
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "hub" / "windows" / "diagnostics"
SOURCE = DIRECTORY / "clr-host-diagnostic.py"
SPEC = importlib.util.spec_from_file_location("clr_host_diagnostic", SOURCE)
diagnostic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnostic)
SECRET = "private-token-value-C:/private/login.txt-0x12345678"


def request():
    return {"schemaVersion": 1, "kind": diagnostic.REQUEST_KIND,
            "nonce": "a" * 64, "runtimeVersion": diagnostic.RUNTIME_VERSION}


def identity():
    return {"platform": "win32", "machine": "AMD64", "pointerBits": 64,
            "implementation": "cpython", "version": (3, 12, 14, "final", 0),
            "isolated": 1, "noSite": 1, "ignoreEnvironment": 1}


class FakeBackend:
    def __init__(self, fail=None, hr=0x80004005, throw=None, release_fail=None,
                 missing=None, failure_pointer=False, malformed=None):
        self.calls = []
        self.fail, self.hr, self.throw = fail, hr, throw
        self.release_fail, self.missing = release_fail, missing
        self.failure_pointer, self.malformed = failure_pointer, malformed

    def call(self, stage, acquisition=False):
        self.calls.append(stage)
        if self.throw == stage:
            raise RuntimeError(SECRET)
        if self.malformed == stage:
            return (True, True) if acquisition else True
        hr = self.hr if self.fail == stage else 0
        return (hr, stage != self.missing and (stage != self.fail or self.failure_pointer)) \
            if acquisition else hr

    def create_instance(self):
        return self.call("create_instance", True)

    def get_runtime(self):
        return self.call("get_runtime", True)

    def get_interface(self):
        return self.call("get_interface", True)

    def start(self):
        return self.call("start")

    def stop(self):
        return self.call("stop")

    def release(self, name):
        self.calls.append("release:" + name)
        if self.release_fail == name:
            raise RuntimeError(SECRET)


class FakeFunction:
    def __init__(self, callback):
        self.callback = callback

    def __call__(self, *args):
        return self.callback(*args)


class FakeLoader:
    """Pure objects; never import ctypes or load any DLL."""
    c_wchar, c_uint32, c_void_p = object(), object(), object()

    def __init__(self, directory=r"C:\Windows\System32", filename=None,
                 directory_length=None, filename_length=None):
        self.directory = directory
        self.filename = directory + r"\mscoree.dll" if filename is None else filename
        self.directory_length, self.filename_length = directory_length, filename_length
        self.calls = []
        self.module = SimpleNamespace(_handle=123)
        self.kernel = SimpleNamespace(GetSystemDirectoryW=FakeFunction(self.get_directory),
                                      GetModuleFileNameW=FakeFunction(self.get_filename))

    @staticmethod
    def POINTER(value):
        return ("pointer", value)

    @staticmethod
    def create_unicode_buffer(capacity):
        return SimpleNamespace(value="", capacity=capacity)

    def WinDLL(self, name, *, winmode):
        self.calls.append((name, winmode))
        return self.kernel if name == "kernel32.dll" else self.module

    def get_directory(self, buffer, capacity):
        if capacity != buffer.capacity:
            raise AssertionError("wrong capacity")
        buffer.value = self.directory
        return len(self.directory) if self.directory_length is None else self.directory_length

    def get_filename(self, handle, buffer, capacity):
        if handle != self.module._handle or capacity != buffer.capacity:
            raise AssertionError("wrong handle or capacity")
        buffer.value = self.filename
        return len(self.filename) if self.filename_length is None else self.filename_length


def run(fake):
    return diagnostic.Runner(lambda: fake, identity).run(request(), native_requested=True)


class ClrHostAdmissionTests(unittest.TestCase):
    def test_request_exact_detached_and_closed(self):
        original = request()
        accepted = diagnostic.validate_request(original)
        self.assertEqual(accepted, original)
        self.assertIsNot(accepted, original)
        for value in (None, [], {}, dict(original, dll="mscoree.dll"),
                      dict(original, clsid="public"), dict(original, assembly="app.exe"),
                      dict(original, env={}), dict(original, grant=True)):
            with self.subTest(value=value), self.assertRaises(diagnostic.DiagnosticError):
                diagnostic.validate_request(value)

    def test_request_field_types_and_fixed_runtime(self):
        changes = {"schemaVersion": [True, 1.0, 2, "1"], "kind": [False, None, "run"],
                   "runtimeVersion": [None, 4, "v2.0.50727", "v4.0.30319\n"],
                   "nonce": [True, None, "a" * 63, "A" * 64, "0" * 64, "a" * 64 + "\n"]}
        for key, values in changes.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(diagnostic.DiagnosticError):
                    diagnostic.validate_request(dict(request(), **{key: value}))

    def test_strict_unicode_json_duplicates_and_nonfinite(self):
        valid = json.dumps(request()).encode()
        self.assertEqual(diagnostic.read_request(io.BytesIO(valid)), request())
        for data in (b'\xff', b'\xef\xbb\xbf{}', b'{"nonce":"a","nonce":"b"}',
                     b'{"nonce":"\\ud800"}', b'{"nonce":NaN}', b'{"nonce":Infinity}',
                     b'{} {}', b'[' * 1024):
            with self.subTest(data=data[:40]), self.assertRaises(diagnostic.DiagnosticError):
                diagnostic.read_request(io.BytesIO(data))
        escaped = valid.replace(b'"' + b'a' * 64 + b'"', b'"\\ud800"')
        with self.assertRaisesRegex(diagnostic.DiagnosticError, "NONCE_INVALID"):
            diagnostic.read_request(io.BytesIO(escaped))

    def test_byte_bound_before_decode(self):
        class BoundedStream:
            def __init__(self, data):
                self.data, self.reads = data, []

            def read(self, count):
                self.reads.append(count)
                return self.data[:count]

        valid = json.dumps(request()).encode()
        exact = valid + b" " * (1024 - len(valid))
        stream = BoundedStream(exact)
        self.assertEqual(diagnostic.read_request(stream), request())
        self.assertEqual(stream.reads, [1025])
        for data in (b"", exact + b" ", b"x" * 100000):
            stream = BoundedStream(data)
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "REQUEST_SIZE_INVALID"):
                diagnostic.read_request(stream)
            self.assertEqual(stream.reads, [1025])

    def test_platform_version_and_isolation_before_factory(self):
        changes = {"platform": ["linux", "darwin"], "machine": ["ARM64", "x86", "amd64"],
                   "pointerBits": [32, True, 64.0], "implementation": ["pypy"],
                   "version": [(3, 14, 0, "final", 0), (3, 12, 13, "final", 0),
                               (3, 12, 14, "candidate", 1), [3, 12, 14, "final", 0],
                               (3.0, 12, 14, "final", 0)],
                   "isolated": [0, True], "noSite": [0, True], "ignoreEnvironment": [0, True]}
        for key, values in changes.items():
            for value in values:
                calls = []
                runner = diagnostic.Runner(lambda: calls.append("constructed"),
                                           lambda: dict(identity(), **{key: value}))
                with self.subTest(key=key, value=value), self.assertRaises(diagnostic.DiagnosticError):
                    runner.run(request(), native_requested=True)
                self.assertEqual(calls, [])

    def test_invalid_input_or_flag_does_not_construct_backend(self):
        calls = []
        runner = diagnostic.Runner(lambda: calls.append("constructed"), identity)
        for flag in (False, 1, "yes", None):
            with self.subTest(flag=flag), self.assertRaisesRegex(diagnostic.DiagnosticError, "EXPLICIT_FLAG_REQUIRED"):
                runner.run(request(), native_requested=flag)
        with self.assertRaises(diagnostic.DiagnosticError):
            runner.run(dict(request(), path=SECRET), native_requested=True)
        self.assertEqual(calls, [])

    def test_ambient_clr_overrides_are_refused_without_values(self):
        diagnostic.validate_native_environment({"SystemRoot": "unused", "TMP": "unused"})
        for name in ("COR_ENABLE_PROFILING", "COR_PROFILER", "CoreClr_Profiler",
                     "complus_InstallRoot", "COMPLUS_Version", "DOTNET_STARTUP_HOOKS", "DEVPATH"):
            with self.subTest(name=name), self.assertRaisesRegex(
                    diagnostic.DiagnosticError, "^AMBIENT_CLR_ENVIRONMENT_REJECTED$") as caught:
                diagnostic.validate_native_environment({name: SECRET})
            self.assertNotIn(SECRET, str(caught.exception))

    def test_default_native_factory_not_constructed_with_ambient_override(self):
        with patch.object(diagnostic, "NativeBackend", side_effect=AssertionError("native called")) as factory:
            runner = diagnostic.Runner(identity_provider=identity)
            with patch.dict(diagnostic.os.environ, {"COMPLUS_Version": "v4.0.30319"}, clear=True), \
                    self.assertRaisesRegex(diagnostic.DiagnosticError, "AMBIENT_CLR_ENVIRONMENT_REJECTED"):
                runner.run(request(), native_requested=True)
            factory.assert_not_called()

    def test_same_runner_cannot_execute_twice_even_with_a_new_nonce(self):
        calls = []
        runner = diagnostic.Runner(lambda: calls.append(1) or FakeBackend(), identity)
        runner.run(request(), native_requested=True)
        for sample in (request(), dict(request(), nonce="b" * 64)):
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "RUNNER_ALREADY_USED"):
                runner.run(sample, native_requested=True)
        self.assertEqual(calls, [1])

    def test_no_cross_runner_replay_claim(self):
        # This deliberately succeeds twice: nonce binds a result, it is no grant.
        self.assertEqual(run(FakeBackend())["nonce"], run(FakeBackend())["nonce"])
        self.assertIn("no cross-process", diagnostic.describe()["nonceScope"])


class ClrHostRunnerTests(unittest.TestCase):
    def test_success_flow_and_release_reverse_order(self):
        fake = FakeBackend()
        result = run(fake)
        self.assertEqual(fake.calls, list(diagnostic.STAGES) +
                         ["release:host", "release:runtime", "release:meta"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["stage"], "stop")
        self.assertTrue(result["clrStarted"] and result["stopAttempted"] and result["interfacesReleased"])
        self.assertEqual(result["evidenceKind"], "fake-backend")
        self.assertFalse(result["providerExecuted"] or result["lpacVerified"])

    def test_every_hresult_failure_stops_at_its_stage_and_releases_acquired_only(self):
        for index, stage in enumerate(diagnostic.STAGES):
            for hr in (0x80004005, -2147467259, 0x80070005):
                with self.subTest(stage=stage, hr=hr):
                    fake = FakeBackend(fail=stage, hr=hr)
                    result = run(fake)
                    acquired = ["meta", "runtime", "host"][:min(index, 3)]
                    self.assertEqual(fake.calls, list(diagnostic.STAGES[:index + 1]) +
                                     ["release:" + name for name in reversed(acquired)])
                    self.assertEqual(result["status"], "failed")
                    self.assertEqual(result["stage"], stage)
                    self.assertEqual(result["hresult"], "0x%08X" % (hr & 0xffffffff))
                    self.assertEqual(result["classification"],
                                     "unknown_failure" if hr & 0xffffffff == 0x80004005 else "hresult_failure")
                    self.assertEqual(result["stopAttempted"], stage == "stop")

    def test_failure_output_interface_is_released_but_not_invoked(self):
        for index, stage in enumerate(diagnostic.STAGES[:3]):
            with self.subTest(stage=stage):
                fake = FakeBackend(fail=stage, failure_pointer=True)
                result = run(fake)
                self.assertEqual([r["interface"] for r in result["releases"]],
                                 list(reversed(["meta", "runtime", "host"][:index + 1])))
                self.assertNotIn("start", fake.calls)

    def test_success_with_missing_interface_is_not_success(self):
        for stage in diagnostic.STAGES[:3]:
            with self.subTest(stage=stage):
                result = run(FakeBackend(missing=stage))
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["classification"], "interface_missing")
                self.assertFalse(result["clrStarted"] or result["stopAttempted"])

    def test_native_exceptions_each_stage_keep_privacy_and_release(self):
        for index, stage in enumerate(diagnostic.STAGES):
            with self.subTest(stage=stage):
                result = run(FakeBackend(throw=stage))
                self.assertEqual(result["stage"], stage)
                self.assertEqual(result["classification"], "native_call_failed")
                self.assertIsNone(result["hresult"])
                self.assertEqual(len(result["releases"]), min(index, 3))
                self.assertNotIn(SECRET, json.dumps(result))

    def test_backend_load_exception_has_no_release_or_private_details(self):
        def factory():
            raise OSError(SECRET)
        result = diagnostic.Runner(factory, identity).run(request(), native_requested=True)
        self.assertEqual(result["stage"], "backend_load")
        self.assertEqual(result["classification"], "native_backend_unavailable")
        self.assertEqual(result["steps"], [])
        self.assertEqual(result["releases"], [])
        self.assertNotIn(SECRET, json.dumps(result))

    def test_module_path_rejection_has_a_fixed_private_result(self):
        def factory():
            raise diagnostic.NativeModulePathError()
        result = diagnostic.Runner(factory, identity).run(request(), native_requested=True)
        self.assertEqual(result["stage"], "backend_load")
        self.assertEqual(result["classification"], "native_module_path_rejected")
        self.assertEqual(result["steps"], [])
        self.assertEqual(result["releases"], [])

    def test_each_release_failure_continues_later_releases_and_fails_outcome(self):
        for name in ("host", "runtime", "meta"):
            with self.subTest(name=name):
                fake = FakeBackend(release_fail=name)
                result = run(fake)
                self.assertEqual(fake.calls[-3:], ["release:host", "release:runtime", "release:meta"])
                self.assertFalse(result["interfacesReleased"])
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["stage"], "release")
                self.assertEqual(result["classification"], "release_incomplete")
                self.assertNotIn(SECRET, json.dumps(result))

    def test_release_failure_does_not_replace_primary_failure(self):
        result = run(FakeBackend(fail="start", release_fail="host"))
        self.assertEqual(result["stage"], "start")
        self.assertEqual(result["hresult"], "0x80004005")
        self.assertEqual(result["classification"], "unknown_failure")
        self.assertFalse(result["interfacesReleased"] or result["stopAttempted"])

    def test_stop_failure_remains_distinct_from_start(self):
        result = run(FakeBackend(fail="stop", hr=0x80070005))
        self.assertTrue(result["clrStarted"] and result["stopAttempted"])
        self.assertEqual(result["steps"][-2]["classification"], "succeeded")
        self.assertEqual(result["steps"][-1]["hresult"], "0x80070005")
        self.assertEqual(result["status"], "failed")

    def test_hresult_contract_rejects_bool_without_skipping_release(self):
        for stage in diagnostic.STAGES:
            with self.subTest(stage=stage):
                result = run(FakeBackend(malformed=stage))
                self.assertEqual(result["classification"], "backend_contract_invalid")
                self.assertEqual(result["status"], "failed")
                self.assertTrue(result["interfacesReleased"])
        for value in (True, None, 0.0, -2147483649, 4294967296, SECRET):
            with self.subTest(value=value), self.assertRaises(diagnostic.DiagnosticError):
                diagnostic._hr(value)

    def test_nonnegative_hresult_uses_hresult_semantics(self):
        fake = FakeBackend(fail="start", hr=1)
        result = run(fake)
        self.assertEqual(result["status"], "completed")
        self.assertIn("stop", fake.calls)
        self.assertEqual(result["steps"][3]["hresult"], "0x00000001")


class ClrHostCliAndContractTests(unittest.TestCase):
    def test_default_describe_and_bad_arguments_never_read_stdin_or_construct_runner(self):
        class NoRead:
            def read(self, _size):
                self.fail("stdin read")
        def forbidden():
            raise AssertionError("runner constructed")
        for argv in ([], ["--describe"], ["--run"], ["--describe", "--run-native-diagnostic"]):
            output = io.StringIO()
            code = diagnostic.main(argv, stdin=NoRead(), stdout=output, runner_factory=forbidden)
            value = json.loads(output.getvalue())
            self.assertFalse(value["nativeExecution"])
            self.assertEqual(code, 0 if argv in ([], ["--describe"]) else 2)

    def test_cli_valid_request_fake_result_and_failure_exit_codes(self):
        for fail, expected in ((None, 0), ("start", 1)):
            output = io.StringIO()
            code = diagnostic.main(["--run-native-diagnostic"],
                                   stdin=io.BytesIO(json.dumps(request()).encode()), stdout=output,
                                   runner_factory=lambda: diagnostic.Runner(lambda: FakeBackend(fail=fail), identity))
            self.assertEqual(code, expected)
            self.assertEqual(json.loads(output.getvalue())["evidenceKind"], "fake-backend")
            self.assertEqual(output.getvalue().count("\n"), 1)

    def test_cli_invalid_request_does_not_construct_runner_or_echo_input(self):
        for data in (b"{}", json.dumps(dict(request(), token=SECRET)).encode()):
            output = io.StringIO()
            with patch.object(diagnostic, "NativeBackend", side_effect=AssertionError("native called")) as factory:
                code = diagnostic.main(["--run-native-diagnostic"], stdin=io.BytesIO(data), stdout=output)
            self.assertEqual(code, 2)
            self.assertNotIn(SECRET, output.getvalue())
            self.assertFalse(json.loads(output.getvalue())["nativeExecution"])
            factory.assert_not_called()

    def test_public_errors_are_closed_and_never_accept_exception_text(self):
        output = io.StringIO()
        def factory():
            raise diagnostic.DiagnosticError(SECRET)
        diagnostic.main(["--run-native-diagnostic"], stdin=io.BytesIO(json.dumps(request()).encode()),
                        stdout=output, runner_factory=factory)
        self.assertEqual(json.loads(output.getvalue())["code"], "INPUT_UNAVAILABLE")
        self.assertNotIn(SECRET, output.getvalue())

    def test_fixed_native_loader_and_public_only_api_surface(self):
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        loads = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == "WinDLL"]
        self.assertEqual(len(loads), 2)
        self.assertEqual(ast.literal_eval(loads[0].args[0]), "kernel32.dll")
        self.assertIsInstance(loads[1].args[0], ast.Name)
        self.assertEqual(loads[1].args[0].id, "expected")
        for load in loads:
            self.assertEqual({k.arg: ast.literal_eval(k.value) for k in load.keywords}, {"winmode": 0x800})
        self.assertEqual(diagnostic.VTABLE_SLOTS, {"GetRuntime": 3, "GetInterface": 9,
                                                "Start": 3, "Stop": 4, "Release": 2})
        source = SOURCE.read_text(encoding="utf-8").lower()
        for forbidden in ("f7721072", "07c4e752", "executein", "executeapplication", "subprocess", "winreg", "import uuid"):
            self.assertNotIn(forbidden, source)

    def test_guid_bytes_are_hardcoded_public_windows_abi(self):
        expected = {
            "CLSID_CLRMetaHost": "8d1880928e0e6748b30c7fa83884e8de",
            "IID_ICLRMetaHost": "9edb32d3b3b925418207a14884f53216",
            "IID_ICLRRuntimeInfo": "d2d139bd2fba6a4889b0b4b0cb466891",
            "CLSID_CLRRuntimeHost": "6ea0f1901277624786b57a5eba6bdb02",
            "IID_ICLRRuntimeHost": "6ca0f1901277624786b57a5eba6bdb02"}
        self.assertEqual(set(expected), set(diagnostic.PUBLIC_GUIDS))
        for name, value in expected.items():
            self.assertEqual(diagnostic._guid_bytes(name).hex(), value)
            self.assertEqual(len(diagnostic._guid_bytes(name)), 16)

    def test_fake_loader_uses_os_directory_and_verifies_module_path(self):
        for filename in (None, r"c:\WINDOWS\system32\MSCOREE.dll"):
            fake = FakeLoader(filename=filename)
            self.assertIs(diagnostic._load_system32_mscoree(fake), fake.module)
            self.assertEqual(fake.calls, [("kernel32.dll", 0x800), (r"C:\Windows\System32\mscoree.dll", 0x800)])
            self.assertEqual(fake.kernel.GetSystemDirectoryW.restype, fake.c_uint32)
            self.assertEqual(fake.kernel.GetModuleFileNameW.argtypes[0], fake.c_void_p)

    def test_fake_loader_rejects_reused_wrong_module_and_truncated_api_values(self):
        changes = [{"filename": r"C:\private\mscoree.dll"}, {"filename": ""},
                   {"directory_length": 0}, {"directory_length": 32768}, {"directory_length": 32769},
                   {"directory_length": True}, {"directory_length": 4},
                   {"filename_length": 0}, {"filename_length": 32768}, {"filename_length": 2}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(diagnostic.NativeModulePathError):
                diagnostic._load_system32_mscoree(FakeLoader(**change))

    def test_fake_loader_rejects_nonstandard_os_path_without_loading_clr(self):
        for directory in (r"relative\System32", r"\\server\System32", r"C:\Windows\..\System32",
                          r"C:\Windows\System32:ads", "C:\\Windows\\System32\\", r"C:\Windows\System32.",
                          "C:\\Windows\\\x00System32", r"C:/Windows/System32"):
            fake = FakeLoader(directory=directory)
            with self.subTest(directory=directory), self.assertRaises(diagnostic.NativeModulePathError):
                diagnostic._load_system32_mscoree(fake)
            self.assertEqual(fake.calls, [("kernel32.dll", 0x800)])

    def test_fixed_official_source_pins_match_used_guids_and_vtable(self):
        pins = json.loads((DIRECTORY / "public-hosting-source-pins.json").read_text(encoding="utf-8"))
        self.assertEqual(pins["commit"], "0f012441d654d3bb7de898fdc664b5fcad52bdcc")
        self.assertEqual(pins["publicGUIDs"], diagnostic.PUBLIC_GUIDS)
        self.assertEqual(pins["vtableSlots"], diagnostic.VTABLE_SLOTS)
        self.assertFalse(pins["runtimeEvidence"])
        self.assertEqual([(f["bytes"], f["sha256"]) for f in pins["files"]], [
            (80113, "0a1b1a6f98eab20c3439b3b68437c7a215594dd8af753fc55017855f18003af9"),
            (292182, "6c4710c5cde0809360c0094f390c2c53e251c99486f3d35f26339af4590f284c")])
        for file in pins["files"]:
            self.assertEqual(file["url"], "https://raw.githubusercontent.com/microsoft/win32metadata/" +
                             pins["commit"] + "/" + file["path"])

    def test_schema_closed_shapes_and_examples_match_generated_values(self):
        # Selected structural/keyword consistency checks, not a JSON Schema engine.
        schema = json.loads((DIRECTORY / "clr-host-diagnostic.schema.json").read_text(encoding="utf-8"))
        definitions = schema["$defs"]
        examples = json.loads((DIRECTORY / "examples.json").read_text(encoding="utf-8"))
        self.assertEqual(examples["request"], request())
        self.assertEqual(examples["description"], diagnostic.describe())
        self.assertEqual(examples["fakeSuccess"], run(FakeBackend()))
        self.assertEqual(examples["fakeStartFailure"], run(FakeBackend(fail="start")))
        values = {"request": examples["request"], "description": examples["description"],
                  "result": examples["fakeSuccess"], "refusal": examples["refusal"]}
        for name, value in values.items():
            shape = definitions[name]
            self.assertFalse(shape["additionalProperties"])
            self.assertEqual(set(shape["required"]), set(shape["properties"]))
            self.assertEqual(set(value), set(shape["required"]))
            for field, rule in shape["properties"].items():
                if "const" in rule:
                    self.assertEqual(value[field], rule["const"])
                if "enum" in rule:
                    self.assertIn(value[field], rule["enum"])
        self.assertEqual(set(definitions["refusal"]["properties"]["code"]["enum"]), diagnostic.ERROR_CODES)
        for name in ("step", "release"):
            self.assertFalse(definitions[name]["additionalProperties"])
            self.assertEqual(set(definitions[name]["required"]), set(definitions[name]["properties"]))
        self.assertEqual(definitions["result"]["properties"]["steps"]["maxItems"], 5)
        self.assertEqual(definitions["result"]["properties"]["releases"]["maxItems"], 3)
        self.assertEqual(definitions["description"]["properties"]["maxRequestBytes"]["const"], 1024)
        self.assertEqual(definitions["nonce"]["maxLength"], 64)


if __name__ == "__main__":
    unittest.main()
