"""Offline-review candidate. Import/default/describe never construct a CLR backend.

The explicit native mode is NOT an isolation grant or a provider readiness test.
Only a future reviewed controller may supply the fixed runtime/environment/budgets.
See README.md for the pinned public hosting declarations and the execution boundary.
"""
import json
import os
import re
import struct
import sys


MAX_REQUEST_BYTES = 1024
RUNTIME_VERSION = "v4.0.30319"
REQUEST_KIND = "project-hub-clr-host-request-v1"
RESULT_KIND = "project-hub-clr-host-result-v1"
NONCE_RE = re.compile(r"[0-9a-f]{64}\Z")
REQUEST_KEYS = {"schemaVersion", "kind", "nonce", "runtimeVersion"}
STAGES = ("create_instance", "get_runtime", "get_interface", "start", "stop")
PUBLIC_GUIDS = {
    "CLSID_CLRMetaHost": "9280188d-0e8e-4867-b30c-7fa83884e8de",
    "IID_ICLRMetaHost": "d332db9e-b9b3-4125-8207-a14884f53216",
    "IID_ICLRRuntimeInfo": "bd39d1d2-ba2f-486a-89b0-b4b0cb466891",
    "CLSID_CLRRuntimeHost": "90f1a06e-7712-4762-86b5-7a5eba6bdb02",
    "IID_ICLRRuntimeHost": "90f1a06c-7712-4762-86b5-7a5eba6bdb02",
}
VTABLE_SLOTS = {"GetRuntime": 3, "GetInterface": 9, "Start": 3, "Stop": 4, "Release": 2}
ERROR_CODES = {"DUPLICATE_JSON_KEY", "JSON_INVALID", "REQUEST_FIELDS_INVALID",
               "REQUEST_VERSION_INVALID", "REQUEST_KIND_INVALID", "NONCE_INVALID",
               "RUNTIME_VERSION_INVALID", "REQUEST_SIZE_INVALID", "RUNTIME_IDENTITY_INVALID",
               "PLATFORM_UNSUPPORTED", "PYTHON_VERSION_UNSUPPORTED", "PYTHON_ISOLATION_REQUIRED",
               "AMBIENT_CLR_ENVIRONMENT_REJECTED", "BACKEND_CONTRACT_INVALID",
               "EXPLICIT_FLAG_REQUIRED", "RUNNER_ALREADY_USED", "INPUT_UNAVAILABLE",
               "ARGUMENTS_INVALID"}


class DiagnosticError(Exception):
    """A fixed public code; never serialize the caught underlying exception."""

    def __init__(self, code):
        super().__init__(code if type(code) is str and code in ERROR_CODES else "INPUT_UNAVAILABLE")


class NativeModulePathError(Exception):
    """No path value is stored in this fixed internal failure."""


def _reject(code):
    raise DiagnosticError(code)


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _reject("DUPLICATE_JSON_KEY")
        value[key] = item
    return value


def _invalid_constant(_value):
    _reject("JSON_INVALID")


def validate_request(value):
    if type(value) is not dict or set(value) != REQUEST_KEYS:
        _reject("REQUEST_FIELDS_INVALID")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        _reject("REQUEST_VERSION_INVALID")
    if value["kind"] != REQUEST_KIND or type(value["kind"]) is not str:
        _reject("REQUEST_KIND_INVALID")
    nonce = value["nonce"]
    if type(nonce) is not str or not NONCE_RE.fullmatch(nonce) or nonce == "0" * 64:
        _reject("NONCE_INVALID")
    if type(value["runtimeVersion"]) is not str or value["runtimeVersion"] != RUNTIME_VERSION:
        _reject("RUNTIME_VERSION_INVALID")
    return dict(value)


def read_request(stream):
    # One bounded read, including one sentinel byte, before JSON decoding/allocation.
    data = stream.read(MAX_REQUEST_BYTES + 1)
    if type(data) is not bytes or not 0 < len(data) <= MAX_REQUEST_BYTES:
        _reject("REQUEST_SIZE_INVALID")
    try:
        text = data.decode("utf-8", "strict")
        value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_invalid_constant)
    except DiagnosticError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        _reject("JSON_INVALID")
    return validate_request(value)


def current_identity():
    """Read process identity only; no registry, filesystem enumeration, or CLR API."""
    # CPython's build tag avoids platform.machine(), which can query WMI.
    # This is process metadata, not a substitute for future snapshot PE/hash binding.
    machine = "AMD64" if re.search(r"\b64 bit \(AMD64\)\]", sys.version) else "unsupported"
    return {"platform": sys.platform, "machine": machine,
            "pointerBits": struct.calcsize("P") * 8, "implementation": sys.implementation.name,
            "version": tuple(sys.version_info), "isolated": sys.flags.isolated,
            "noSite": sys.flags.no_site, "ignoreEnvironment": sys.flags.ignore_environment}


def validate_identity(identity):
    if type(identity) is not dict or set(identity) != {
            "platform", "machine", "pointerBits", "implementation", "version",
            "isolated", "noSite", "ignoreEnvironment"}:
        _reject("RUNTIME_IDENTITY_INVALID")
    if identity["platform"] != "win32" or identity["machine"] != "AMD64" or \
            type(identity["pointerBits"]) is not int or identity["pointerBits"] != 64:
        _reject("PLATFORM_UNSUPPORTED")
    version = identity["version"]
    if identity["implementation"] != "cpython" or type(version) is not tuple or \
            len(version) != 5 or any(type(version[i]) is not int for i in (0, 1, 2, 4)) or \
            version != (3, 12, 14, "final", 0):
        _reject("PYTHON_VERSION_UNSUPPORTED")
    if any(type(identity[key]) is not int or identity[key] != 1
           for key in ("isolated", "noSite", "ignoreEnvironment")):
        _reject("PYTHON_ISOLATION_REQUIRED")


def validate_native_environment(environment):
    # The future controller must also construct its full allowlist. This local
    # refusal prevents inherited CLR/profiler/startup configuration being used.
    for key in environment:
        if type(key) is not str or key.upper() == "DEVPATH" or \
                key.upper().startswith(("COR_", "CORECLR_", "COMPLUS_", "DOTNET_")):
            _reject("AMBIENT_CLR_ENVIRONMENT_REJECTED")


def _hr(value):
    if type(value) is not int or not -(2 ** 31) <= value <= 2 ** 32 - 1:
        _reject("BACKEND_CONTRACT_INVALID")
    return value & 0xffffffff


def _step(stage, hresult):
    number = _hr(hresult)
    failed = bool(number & 0x80000000)
    classification = "unknown_failure" if number == 0x80004005 else \
        "hresult_failure" if failed else "succeeded"
    return {"stage": stage, "hresult": "0x%08X" % number, "classification": classification}


def _guid_bytes(name):
    parts = PUBLIC_GUIDS[name].split("-")
    return struct.pack("<IHH8B", int(parts[0], 16), int(parts[1], 16), int(parts[2], 16),
                       *bytes.fromhex(parts[3] + parts[4]))


def _fixed_windows_path(value):
    if type(value) is not str or len(value) < 4 or not re.match(r"^[A-Za-z]:\\", value) or \
            any(ord(char) < 32 or char in '/<>:"|?*' for char in value[3:]):
        raise NativeModulePathError()
    if any(not part or part in (".", "..") or part.endswith((" ", ".")) for part in value[3:].split("\\")):
        raise NativeModulePathError()
    return value


def _load_system32_mscoree(c):
    # Kernel32 is an OS KnownDLL. Do not use an ambient Windows directory value.
    kernel = c.WinDLL("kernel32.dll", winmode=0x00000800)
    get_directory = kernel.GetSystemDirectoryW
    get_directory.argtypes = [c.POINTER(c.c_wchar), c.c_uint32]
    get_directory.restype = c.c_uint32
    get_filename = kernel.GetModuleFileNameW
    get_filename.argtypes = [c.c_void_p, c.POINTER(c.c_wchar), c.c_uint32]
    get_filename.restype = c.c_uint32
    capacity = 32768
    directory = c.create_unicode_buffer(capacity)
    length = get_directory(directory, capacity)
    if type(length) is not int or not 0 < length < capacity or len(directory.value) != length:
        raise NativeModulePathError()
    expected = _fixed_windows_path(directory.value) + "\\mscoree.dll"
    module = c.WinDLL(expected, winmode=0x00000800)
    filename = c.create_unicode_buffer(capacity)
    length = get_filename(module._handle, filename, capacity)
    if type(length) is not int or not 0 < length < capacity or len(filename.value) != length or \
            _fixed_windows_path(filename.value).lower() != expected.lower():
        raise NativeModulePathError()
    return module


class NativeBackend:
    """Fixed public API only. Constructed lazily after all admission checks.

    Pointers, reference counts, DLL paths, and OS error strings are never serialized.
    There is no assembly execution, arbitrary COM activation, or request-selected API.
    """

    def __init__(self):
        import ctypes
        self._ctypes = ctypes
        self._interfaces = {}

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                        ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

        self._GUID = GUID
        self._guids = {name: GUID.from_buffer_copy(_guid_bytes(name)) for name in PUBLIC_GUIDS}
        self._dll = _load_system32_mscoree(ctypes)
        self._create = self._dll.CLRCreateInstance
        self._create.argtypes = [ctypes.POINTER(GUID), ctypes.POINTER(GUID),
                                 ctypes.POINTER(ctypes.c_void_p)]
        self._create.restype = ctypes.c_int32

    def _method(self, interface, slot, *args):
        c = self._ctypes
        pointer = self._interfaces[interface]
        vtable = c.cast(pointer, c.POINTER(c.POINTER(c.c_void_p))).contents
        return c.WINFUNCTYPE(c.c_int32, c.c_void_p, *args)(vtable[slot])

    def _retain(self, name, pointer, hresult):
        # Even a non-null failure output must be released; it is never invoked.
        present = bool(pointer.value)
        if present:
            self._interfaces[name] = pointer
        return hresult, present

    def create_instance(self):
        c = self._ctypes
        pointer = c.c_void_p()
        hr = self._create(c.byref(self._guids["CLSID_CLRMetaHost"]),
                          c.byref(self._guids["IID_ICLRMetaHost"]), c.byref(pointer))
        return self._retain("meta", pointer, hr)

    def get_runtime(self):
        c = self._ctypes
        pointer = c.c_void_p()
        method = self._method("meta", VTABLE_SLOTS["GetRuntime"], c.c_wchar_p,
                              c.POINTER(self._GUID), c.POINTER(c.c_void_p))
        hr = method(self._interfaces["meta"], RUNTIME_VERSION,
                    c.byref(self._guids["IID_ICLRRuntimeInfo"]), c.byref(pointer))
        return self._retain("runtime", pointer, hr)

    def get_interface(self):
        c = self._ctypes
        pointer = c.c_void_p()
        method = self._method("runtime", VTABLE_SLOTS["GetInterface"],
                              c.POINTER(self._GUID), c.POINTER(self._GUID),
                              c.POINTER(c.c_void_p))
        hr = method(self._interfaces["runtime"], c.byref(self._guids["CLSID_CLRRuntimeHost"]),
                    c.byref(self._guids["IID_ICLRRuntimeHost"]), c.byref(pointer))
        return self._retain("host", pointer, hr)

    def start(self):
        return self._method("host", VTABLE_SLOTS["Start"])(self._interfaces["host"])

    def stop(self):
        return self._method("host", VTABLE_SLOTS["Stop"])(self._interfaces["host"])

    def release(self, name):
        c = self._ctypes
        pointer = self._interfaces.pop(name)
        vtable = c.cast(pointer, c.POINTER(c.POINTER(c.c_void_p))).contents
        method = c.WINFUNCTYPE(c.c_uint32, c.c_void_p)(vtable[VTABLE_SLOTS["Release"]])
        method(pointer)  # ULONG refcount is deliberately not serialized.


class Runner:
    """One execution per instance, not a persistent/cross-process replay ledger."""

    def __init__(self, backend_factory=None, identity_provider=current_identity):
        self._factory = NativeBackend if backend_factory is None else backend_factory
        self._evidence = "native-api" if backend_factory is None else "fake-backend"
        self._identity = identity_provider
        self._used = False

    def run(self, request, *, native_requested=False):
        request = validate_request(request)
        if native_requested is not True:
            _reject("EXPLICIT_FLAG_REQUIRED")
        validate_identity(self._identity())
        if self._used:
            _reject("RUNNER_ALREADY_USED")
        if self._evidence == "native-api":
            validate_native_environment(os.environ)
        self._used = True
        result = {"schemaVersion": 1, "kind": RESULT_KIND, "nonce": request["nonce"],
                  "runtimeVersion": RUNTIME_VERSION, "evidenceKind": self._evidence,
                  "status": "failed", "stage": "backend_load", "hresult": None,
                  "classification": "native_backend_unavailable", "steps": [], "releases": [],
                  "clrStarted": False, "stopAttempted": False, "interfacesReleased": True,
                  "providerExecuted": False, "lpacVerified": False}
        backend = None
        acquired = []
        try:
            backend = self._factory()
            for stage, interface in zip(STAGES[:3], ("meta", "runtime", "host")):
                result.update(stage=stage, hresult=None, classification="native_call_failed")
                reply = getattr(backend, stage)()
                if type(reply) is not tuple or len(reply) != 2 or type(reply[1]) is not bool:
                    _reject("BACKEND_CONTRACT_INVALID")
                hresult, present = reply
                if present:
                    acquired.append(interface)
                step = _step(stage, hresult)
                result["steps"].append(step)
                result.update(stage=stage, hresult=step["hresult"], classification=step["classification"])
                if step["classification"] != "succeeded":
                    return result
                if not present:
                    result["classification"] = "interface_missing"
                    return result
            result.update(stage="start", hresult=None, classification="native_call_failed")
            step = _step("start", backend.start())
            result["steps"].append(step)
            result.update(hresult=step["hresult"], classification=step["classification"])
            if step["classification"] != "succeeded":
                return result
            result["clrStarted"] = True
            result["stopAttempted"] = True
            result.update(stage="stop", hresult=None, classification="native_call_failed")
            step = _step("stop", backend.stop())
            result["steps"].append(step)
            result.update(hresult=step["hresult"], classification=step["classification"])
            if step["classification"] == "succeeded":
                result["status"] = "completed"
        except NativeModulePathError:
            result["classification"] = "native_module_path_rejected"
        except DiagnosticError:
            result["classification"] = "backend_contract_invalid"
        except Exception:
            # Never propagate exception strings, paths, pointers, or credentials.
            pass
        finally:
            for interface in reversed(acquired):
                released = False
                try:
                    backend.release(interface)
                    released = True
                except Exception:
                    result["interfacesReleased"] = False
                result["releases"].append({"interface": interface,
                                            "status": "released" if released else "release_failed"})
            if not result["interfacesReleased"] and result["status"] == "completed":
                result.update(status="failed", stage="release", hresult=None,
                              classification="release_incomplete")
        return result


def describe():
    return {"schemaVersion": 1, "kind": "project-hub-clr-host-description-v1",
            "nativeExecution": False, "runtimeVersion": RUNTIME_VERSION,
            "pythonVersion": "3.12.14", "architecture": "Windows AMD64",
            "maxRequestBytes": MAX_REQUEST_BYTES, "nativeFlag": "--run-native-diagnostic",
            "nonceScope": "binding-only; one call per runner; no cross-process replay ledger",
            "readinessVerified": False}


def main(argv=None, *, stdin=None, stdout=None, runner_factory=Runner):
    argv = sys.argv[1:] if argv is None else argv
    stdout = sys.stdout if stdout is None else stdout
    if not argv or argv == ["--describe"]:
        value, code = describe(), 0
    elif argv == ["--run-native-diagnostic"]:
        try:
            stream = sys.stdin.buffer if stdin is None else stdin
            request = read_request(stream)
            value = runner_factory().run(request, native_requested=True)
            code = 0 if value["status"] == "completed" else 1
        except DiagnosticError as error:
            value, code = {"schemaVersion": 1, "kind": "project-hub-clr-host-refusal-v1",
                           "stage": "admission", "code": str(error), "nativeExecution": False}, 2
        except Exception:
            value, code = {"schemaVersion": 1, "kind": "project-hub-clr-host-refusal-v1",
                           "stage": "admission", "code": "INPUT_UNAVAILABLE", "nativeExecution": False}, 2
    else:
        value, code = {"schemaVersion": 1, "kind": "project-hub-clr-host-refusal-v1",
                       "stage": "admission", "code": "ARGUMENTS_INVALID", "nativeExecution": False}, 2
    stdout.write(json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
