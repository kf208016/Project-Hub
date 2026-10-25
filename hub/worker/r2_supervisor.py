"""Fixed Linux R2 synthetic supervisor. No provider, auth, network or shell RPC.

The bootstrap injects the reviewed catalog and raw source bundle below. A single
bounded request is followed by EOF. Disconnect detection uses parent death and
bounded stdout heartbeats; a transient systemd service has its own deadline.
Unknown cleanup retains the private lease. This is not full provider R2.
"""
import base64
import ctypes
import errno
import hashlib
import io
import json
import os
import platform
import re
import select
import signal
import struct
import subprocess
import sys
import time
import zlib
from stage_protocol import StageError, canonical_bytes, decode_json, read_frame, require
from r2_contract import (CASE, NAMESPACES, OPERATION, cleanup_result, parse_cgroup,
                         no_execution_cleanup, validate_request, verify_isolation, verify_limits)
from r2_policy import SYNTHETIC_SOURCE, build_policy
from r2_runtime import (PrivateState, RuntimePin, admission, bounded_command, create_at,
                        identity, proc_identity, read_at)

CATALOG_SHA256 = None
SOURCE_BUNDLE_SHA256 = None
SOURCE_BUNDLE = None
SOURCE_IDENTITIES = None
MAX_OUTPUT = 128 * 1024


def boot_id():
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        return stream.read(128).strip()


def namespaces():
    return {name: os.stat("/proc/self/ns/" + name).st_ino for name in NAMESPACES}


def runtime_pin():
    pin = RuntimePin()
    try:
        for directory in ("/usr", "/usr/bin", "/usr/lib", "/usr/lib64"):
            pin.open(directory, directory=True)
        for tool in ("/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/systemd-run", "/usr/bin/systemctl"):
            pin.open(tool)
        pin.verify()
        return pin
    except BaseException:
        pin.close()
        raise


def source_program(entry, config):
    """Rebuild only this fixed catalog in a child; request carries no source."""
    require(entry == "service_main" and type(SOURCE_BUNDLE) is dict, "R2_SOURCE_CATALOG_MISSING")
    chunks = ["import base64,zlib,types,sys"]
    for row in SOURCE_IDENTITIES:
        name = row["name"][:-3]
        compressed = SOURCE_BUNDLE[row["name"]]
        chunks += ['m=types.ModuleType(' + repr(name) + ');sys.modules[' + repr(name) + ']=m',
                   'exec(compile(zlib.decompress(base64.b64decode(' + repr(compressed) + ')),'
                   + repr(row["name"]) + ',"exec"),m.__dict__)']
    encoded = base64.b64encode(canonical_bytes(config)).decode("ascii")
    chunks += ['m=sys.modules["r2_supervisor"]',
               'm.CATALOG_SHA256=' + repr(CATALOG_SHA256),
               'm.SOURCE_BUNDLE_SHA256=' + repr(SOURCE_BUNDLE_SHA256),
               'm.SOURCE_BUNDLE=' + repr(SOURCE_BUNDLE),
               'm.SOURCE_IDENTITIES=' + repr(SOURCE_IDENTITIES),
               'sys.exit(m.service_main(__import__("json").loads(base64.b64decode(' + repr(encoded) + '))))']
    program = "\n".join(chunks)
    require(len(program.encode("ascii")) <= 120 * 1024, "R2_SERVICE_PROGRAM_BOUND")
    return program


def guard_program(outer, uid):
    # Only trusted measurement/validation precedes the bounded file round trip.
    # Load two fixed modules from the reviewed bundle; nothing from /profile.
    chunks = ["import base64,zlib,types,sys,io,contextlib,json,os,errno"]
    for filename in ("stage_protocol.py", "r2_contract.py"):
        name = filename[:-3]
        chunks += ['m=types.ModuleType(' + repr(name) + ');sys.modules[' + repr(name) + ']=m',
                   'exec(compile(zlib.decompress(base64.b64decode(' + repr(SOURCE_BUNDLE[filename]) + ')),'
                   + repr(filename) + ',"exec"),m.__dict__)']
    chunks += ["output=io.StringIO()", "with contextlib.redirect_stdout(output):",
               " exec(compile(" + repr(SYNTHETIC_SOURCE) + ',"fixed-measurement","exec"),{})',
               "measurement=json.loads(output.getvalue())",
               'sys.modules["r2_contract"].verify_isolation(measurement,' + repr(outer) + ',' + str(uid) + ')',
               'data=b"Project Hub fixed R2 synthetic file\\n"',
               'for directory in ("/work","/profile","/tmp"):',
               ' name=directory+"/synthetic.txt"',
               ' fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)',
               ' try:', '  if os.write(fd,data)!=len(data):raise RuntimeError("R2_SYNTHETIC_WRITE")',
               ' finally:os.close(fd)',
               ' with open(name,"rb") as stream:',
               '  if stream.read(len(data)+1)!=data:raise RuntimeError("R2_SYNTHETIC_READBACK")',
               ' os.unlink(name)',
               'print(json.dumps({"kind":"project-hub-r2-guard-result","guardPassed":True,"measurement":measurement,"tmpfsRoundTrip":True,"providerReady":False},sort_keys=True,separators=(",",":")))']
    return "\n".join(chunks)


def service_main(config):
    """Trusted service entry: validate kernel limits before starting bwrap."""
    pin = None
    state = state_owner = None
    child = None
    try:
        require(type(config) is dict and set(config) == {"request", "runIdentity", "outerNamespaces"},
                "R2_SERVICE_CONFIGURATION_REJECTED")
        request = validate_request(config["request"], catalog=CATALOG_SHA256,
                                   boot=boot_id(), uid=os.geteuid(), now=time.time())
        os.umask(0o077)
        pin = runtime_pin()
        unit = "project-hub-r2-" + request["nonce"] + ".service"
        with open("/proc/self/cgroup", encoding="ascii") as stream:
            parts = parse_cgroup(stream.read(8192), unit)
        cgroup = "/sys/fs/cgroup/" + "/".join(parts)
        limits = {}
        for name in ("memory.max", "memory.swap.max", "pids.max", "cpu.max"):
            with open(cgroup + "/" + name, encoding="ascii") as stream:
                limits[name] = stream.read(128).strip()
        verify_limits(limits)
        invocation = os.environ.get("INVOCATION_ID", "")
        require(re.fullmatch(r"[0-9a-f]{32}", invocation), "R2_SERVICE_INVOCATION_REJECTED")
        # Hold all private path components, without acquiring the controller's
        # already-held lock or accepting any caller-provided filesystem path.
        state_owner = PrivateState(controller=False)
        state = state_owner.open_run(request["nonce"])
        require(identity(os.fstat(state)) == config["runIdentity"], "R2_SERVICE_ROOT_CHANGED")
        require(decode_json(read_at(state, "intent.json"))["request"] == request,
                "R2_SERVICE_INTENT_CHANGED")
        metadata = {"schemaVersion": 1, "uid": os.geteuid(), "bootId": boot_id(),
                    "catalogSHA256": CATALOG_SHA256, "invocationId": invocation,
                    "unit": unit, "cgroup": "/" + "/".join(parts),
                    "process": proc_identity(os.getpid()), "limits": limits}
        create_at(state, "service-kernel.json", canonical_bytes(metadata))
        gate = canonical_bytes({"nonce": request["nonce"], "catalogSHA256": CATALOG_SHA256,
                                "invocationId": invocation, "pid": metadata["process"]["pid"],
                                "startTicks": metadata["process"]["startTicks"]})
        gate_deadline = time.monotonic() + 10
        while True:
            require(time.monotonic() < gate_deadline and time.time() < request["expiresAtUnixSeconds"],
                    "R2_EXECUTION_GATE_EXPIRED")
            try:
                require(read_at(state, "execution-gate.json") == gate, "R2_EXECUTION_GATE_REJECTED")
                break
            except FileNotFoundError:
                time.sleep(0.05)
        policy = build_policy({"schemaVersion": 1, "case": CASE, "runNonce": request["nonce"],
                               "bootId": request["bootId"], "workerSHA256": SOURCE_BUNDLE_SHA256,
                               "runtimeSeconds": 60})
        argv = policy["bwrapArgv"][:-1] + [guard_program(config["outerNamespaces"], request["uid"])]
        pin.verify()
        bwrap_fd = pin.tools["/usr/bin/bwrap"]["fd"]
        child = subprocess.Popen(argv, executable="/proc/self/fd/" + str(bwrap_fd),
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    close_fds=True, pass_fds=(bwrap_fd,),
                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        stdout, stderr = bytearray(), bytearray()
        pending = {child.stdout.fileno(): (child.stdout, stdout, 32768),
                   child.stderr.fileno(): (child.stderr, stderr, 8192)}
        started = time.monotonic()
        while pending:
            require(time.monotonic() - started < 45, "R2_SANDBOX_DEADLINE")
            readable, _, _ = select.select(list(pending), [], [], 0.1)
            for fd in readable:
                stream, data, maximum = pending[fd]
                part = os.read(fd, 4096)
                if part:
                    data.extend(part)
                    require(len(data) <= maximum, "R2_SANDBOX_OUTPUT_BOUND")
                else:
                    stream.close()
                    del pending[fd]
        require(child.wait(timeout=2) == 0, "R2_SANDBOX_FAILED")
        measured = decode_json(bytes(stdout).strip())
        require(set(measured) == {"kind", "guardPassed", "measurement", "tmpfsRoundTrip", "providerReady"}
                and measured["kind"] == "project-hub-r2-guard-result" and measured["guardPassed"] is True
                and measured["tmpfsRoundTrip"] is True and measured["providerReady"] is False,
                "R2_SANDBOX_RESULT_REJECTED")
        verify_isolation(measured["measurement"], config["outerNamespaces"], request["uid"])
        pin.verify()
        create_at(state, "measurement.json", canonical_bytes(measured))
        return 0
    except BaseException as error:
        if state is not None:
            try:
                code = error.code if isinstance(error, StageError) else "R2_SERVICE_FAILED"
                create_at(state, "service-error.json", canonical_bytes({"code": code}))
            except BaseException:
                pass
        return 1
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        if child is not None:
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
        if state_owner is not None:
            state_owner.close()
        if pin is not None:
            pin.close()


class Emitter:
    def __init__(self, nonce):
        self.nonce, self.sequence, self.total = nonce, 0, 0

    def send(self, operation, **fields):
        require(operation in ("accepted", "heartbeat", "result")
                and not set(fields) & {"protocol", "sequence", "nonce", "op"}, "R2_RESPONSE_FIELDS_REJECTED")
        self.sequence += 1
        message = {"protocol": 1, "sequence": self.sequence, "nonce": self.nonce,
                   "op": operation, **fields}
        body = canonical_bytes(message)
        data = struct.pack("!I", len(body)) + body
        self.total += len(data)
        require(len(body) <= 32768 and self.sequence <= 128 and self.total <= MAX_OUTPUT,
                "R2_RESPONSE_BOUND")
        at, deadline = 0, time.monotonic() + 1
        while at < len(data):
            left = deadline - time.monotonic()
            require(left > 0, "R2_CONTROLLER_NOT_READING")
            _, writable, _ = select.select([], [1], [], left)
            require(writable, "R2_CONTROLLER_NOT_READING")
            count = os.write(1, data[at:])
            require(count > 0, "R2_CONTROLLER_DISCONNECTED")
            at += count


def properties(stdout):
    require(len(stdout) <= 32768, "R2_SYSTEMD_OUTPUT_BOUND")
    result = {}
    for row in stdout.decode("utf-8", errors="strict").splitlines():
        key, separator, value = row.partition("=")
        require(separator and key not in result and key in {"LoadState", "ActiveState", "SubState", "InvocationID",
                "MainPID", "ControlGroup", "ExecMainStatus", "Result"}, "R2_SYSTEMD_PROPERTIES_REJECTED")
        result[key] = value
    return result


class OwnedUnit:
    def __init__(self, pin, request):
        self.pin, self.request = pin, request
        self.name = "project-hub-r2-" + request["nonce"] + ".service"
        self.invocation = None
        self.cgroup_fd = None
        self.cgroup_identity = None
        self.cgroup_path = None
        self.events_fd = None
        self.launch_attempted = False
        self.main_identity = None
        self.expected_cmdline = None
        uid = request["uid"]
        self.env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "XDG_RUNTIME_DIR": "/run/user/" + str(uid),
                    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/" + str(uid) + "/bus"}

    def control(self, *args):
        self.pin.verify()
        tool = self.pin.tools["/usr/bin/systemctl"]["resolved"]
        return bounded_command([tool, "--user", *args, self.name], self.env,
                               executable_fd=self.pin.tools["/usr/bin/systemctl"]["fd"])

    def show(self, *, allow_not_found=False):
        result = self.control("show", "--property=LoadState,ActiveState,SubState,InvocationID,MainPID,ControlGroup,ExecMainStatus,Result")
        parsed = properties(result.stdout)
        require(result.returncode == 0 or (allow_not_found and result.returncode == 4
                and parsed.get("LoadState") == "not-found"), "R2_SYSTEMD_QUERY_FAILED")
        return parsed

    def verify(self):
        current = self.show()
        require(self.invocation is not None and current.get("InvocationID") == self.invocation
                and current.get("ControlGroup") == self.cgroup_path, "R2_UNIT_IDENTITY_CHANGED")
        require(identity(os.fstat(self.cgroup_fd)) == self.cgroup_identity, "R2_CGROUP_IDENTITY_CHANGED")
        require(identity(os.stat("/sys/fs/cgroup" + self.cgroup_path, follow_symlinks=False))
                == self.cgroup_identity, "R2_CGROUP_PATH_CHANGED")
        return current

    def start(self, state, config):
        initial = self.show(allow_not_found=True)
        require(initial.get("LoadState") == "not-found", "R2_UNIT_PREEXISTS")
        policy = build_policy({"schemaVersion": 1, "case": CASE, "runNonce": self.request["nonce"],
                               "bootId": self.request["bootId"], "workerSHA256": SOURCE_BUNDLE_SHA256,
                               "runtimeSeconds": 60})
        program = source_program("service_main", config)
        args = [self.pin.tools["/usr/bin/systemd-run"]["resolved"], *policy["systemd"]["fixedArgv"],
                "--unit=" + self.name, *policy["systemd"]["propertyArgv"],
                "--property=StandardInput=null", "--property=StandardOutput=null", "--property=StandardError=null",
                "--", "/proc/" + str(os.getpid()) + "/fd/" + str(self.pin.tools["/usr/bin/python3"]["fd"]),
                "-I", "-B", "-c", program]
        self.expected_cmdline = b"\0".join(part.encode("ascii") for part in args[args.index("--") + 1:]) + b"\0"
        self.pin.verify()
        self.launch_attempted = True
        result = bounded_command(args, self.env, timeout=5,
                                 executable_fd=self.pin.tools["/usr/bin/systemd-run"]["fd"])
        require(result.returncode == 0, "R2_UNIT_START_FAILED")
        end = time.monotonic() + 5
        while time.monotonic() < end:
            current = self.show()
            invocation = current.get("InvocationID", "")
            cgroup = current.get("ControlGroup", "")
            if re.fullmatch(r"[0-9a-f]{32}", invocation) and cgroup:
                parts = parse_cgroup("0::" + cgroup, self.name)
                fd = os.open("/sys/fs/cgroup", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    for part in parts:
                        new_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        os.close(fd)
                        fd = new_fd
                    self.cgroup_fd = fd
                    fd = None
                finally:
                    if fd is not None:
                        os.close(fd)
                self.cgroup_identity = identity(os.fstat(self.cgroup_fd))
                self.cgroup_path, self.invocation = cgroup, invocation
                self.events_fd = os.open("cgroup.events", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.cgroup_fd)
                self.verify()
                create_at(state.run_fd, "unit.json", canonical_bytes({"unit": self.name,
                          "invocationId": invocation, "cgroupIdentity": self.cgroup_identity,
                          "cgroupPathSHA256": hashlib.sha256(cgroup.encode("ascii")).hexdigest()}))
                self.authorize_payload(state)
                return
            time.sleep(0.05)
        require(False, "R2_UNIT_IDENTITY_UNAVAILABLE")

    def authorize_payload(self, state):
        deadline = time.monotonic() + 5
        kernel = None
        while time.monotonic() < deadline:
            try:
                kernel = decode_json(read_at(state.run_fd, "service-kernel.json"))
                break
            except FileNotFoundError:
                time.sleep(0.05)
        require(kernel is not None, "R2_KERNEL_GATE_UNAVAILABLE")
        current = self.verify()
        require(kernel.get("invocationId") == self.invocation and kernel.get("unit") == self.name
                and kernel.get("cgroup") == self.cgroup_path and kernel.get("catalogSHA256") == CATALOG_SHA256
                and kernel.get("bootId") == self.request["bootId"] and kernel.get("uid") == self.request["uid"],
                "R2_KERNEL_GATE_BINDING_REJECTED")
        verify_limits(kernel["limits"])
        process = kernel["process"]
        require(type(process) is dict and set(process) == {"pid", "startTicks", "state"}
                and type(process["pid"]) is int and process["pid"] > 1
                and type(process["startTicks"]) is int and process["startTicks"] > 0
                and current.get("MainPID") == str(process["pid"]), "R2_SERVICE_PROCESS_REJECTED")
        pid = process["pid"]
        before = proc_identity(pid)
        require(before["startTicks"] == process["startTicks"], "R2_SERVICE_PROCESS_REUSED")
        executable = os.stat("/proc/" + str(pid) + "/exe")
        expected = self.pin.tools["/usr/bin/python3"]
        require(identity(executable) == {key: expected[key] for key in ("device", "inode", "uid")},
                "R2_SERVICE_EXECUTABLE_REJECTED")
        with open("/proc/" + str(pid) + "/cmdline", "rb") as stream:
            command = stream.read(128 * 1024)
        require(command == self.expected_cmdline and proc_identity(pid)["startTicks"] == process["startTicks"],
                "R2_SERVICE_COMMAND_REJECTED")
        self.main_identity = {"pid": pid, "startTicks": process["startTicks"]}
        create_at(state.run_fd, "execution-gate.json", canonical_bytes({"nonce": self.request["nonce"],
                  "catalogSHA256": CATALOG_SHA256, "invocationId": self.invocation, **self.main_identity}))

    def populated_zero(self):
        require(self.events_fd is not None, "R2_CGROUP_EVENTS_UNAVAILABLE")
        os.lseek(self.events_fd, 0, os.SEEK_SET)
        data = os.read(self.events_fd, 1024).decode("ascii")
        rows = {}
        for row in data.splitlines():
            parts = row.split(" ")
            require(len(parts) == 2 and parts[0] not in rows and parts[1] in ("0", "1"),
                    "R2_CGROUP_EVENTS_REJECTED")
            rows[parts[0]] = parts[1]
        require("populated" in rows and set(rows) <= {"populated", "frozen"}, "R2_CGROUP_EVENTS_REJECTED")
        return rows["populated"] == "0"

    def cleanup(self):
        zero, stopped, same, outputs_closed = False, False, False, False
        try:
            self.verify()
            same = True
            if not self.populated_zero():
                self.verify()
                outcome = self.control("kill", "--kill-whom=all", "--signal=SIGKILL")
                require(outcome.returncode == 0, "R2_UNIT_KILL_FAILED")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if self.populated_zero():
                    zero = True
                    break
                time.sleep(0.05)
            # Closing the owned cgroup is not inferred from a missing unit.
            # Empty was observed first on its held cgroup.events descriptor.
            self.verify()
            require(self.control("stop").returncode == 0, "R2_UNIT_STOP_FAILED")
            final = self.show(allow_not_found=True)
            stopped = final.get("LoadState") == "not-found" or (
                final.get("InvocationID") in ("", self.invocation)
                and final.get("ActiveState") == "inactive" and final.get("SubState") == "dead")
            outputs_closed = zero  # all service/bwrap descriptors died with the empty owned cgroup
        except BaseException:
            same = False
        return cleanup_result(populated_zero=zero, unit_stopped=stopped,
                              identity_preserved=same, outputs_closed=outputs_closed)

    def close(self):
        if self.events_fd is not None:
            os.close(self.events_fd)
        if self.cgroup_fd is not None:
            os.close(self.cgroup_fd)


def parent_death_guard():
    parent = os.getppid()
    require(parent > 1, "R2_PARENT_IDENTITY_REJECTED")
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0 and os.getppid() == parent,
            "R2_PARENT_DEATH_GUARD_FAILED")


def main():
    state = pin = unit = emitter = None
    result = None
    try:
        require(sys.platform == "linux" and platform.machine() == "x86_64" and os.geteuid() != 0,
                "R2_NONROOT_LINUX_X64_REQUIRED")
        require(type(CATALOG_SHA256) is str and type(SOURCE_BUNDLE_SHA256) is str
                and type(SOURCE_BUNDLE) is dict, "R2_SOURCE_CATALOG_MISSING")
        def interrupted(signum, frame):
            raise StageError("R2_REMOTE_DEADLINE" if signum == signal.SIGALRM else "R2_CONTROLLER_DISCONNECTED")
        signal.signal(signal.SIGALRM, interrupted)
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGHUP, interrupted)
        signal.alarm(15)
        parent_death_guard()
        os.umask(0o077)
        request = read_frame(sys.stdin.buffer)
        require(len(canonical_bytes(request)) <= 8192, "R2_REQUEST_SIZE_BOUND")
        nonce = request.get("nonce")
        if type(nonce) is str and re.fullmatch(r"[0-9a-f]{64}", nonce):
            os.set_blocking(1, False)
            emitter = Emitter(nonce)
        # Fixed native input closes after exactly one manifest, not a command channel.
        require(sys.stdin.buffer.read(1) == b"", "R2_EXTRA_INPUT_REJECTED")
        request = validate_request(request, catalog=CATALOG_SHA256, boot=boot_id(),
                                   uid=os.geteuid(), now=time.time())
        signal.alarm(80)
        deadline = time.monotonic() + min(60, request["expiresAtUnixSeconds"] - time.time())
        pin = runtime_pin()
        state = PrivateState()
        baseline = admission(state.home)
        state.begin(request)
        config = {"request": request, "runIdentity": identity(os.fstat(state.run_fd)),
                  "outerNamespaces": namespaces()}
        create_at(state.run_fd, "runtime.json", canonical_bytes({"baseline": baseline,
                  "tools": {key: {k: v for k, v in row.items() if k != "fd"} for key, row in pin.tools.items()}}))
        emitter.send("accepted", catalogSHA256=CATALOG_SHA256, sourceBundleSHA256=SOURCE_BUNDLE_SHA256,
                     bootId=request["bootId"], uid=request["uid"], case=CASE, providerReady=False)
        unit = OwnedUnit(pin, request)
        unit.start(state, config)
        next_heartbeat = time.monotonic()
        measurement = None
        while time.monotonic() < deadline:
            require(boot_id() == request["bootId"], "R2_BOOT_CHANGED")
            current = unit.verify()
            if current.get("ActiveState") == "failed":
                raise StageError("R2_SERVICE_FAILED")
            if current.get("ActiveState") == "active" and current.get("SubState") == "exited":
                require(current.get("ExecMainStatus") == "0", "R2_SERVICE_FAILED")
                kernel = decode_json(read_at(state.run_fd, "service-kernel.json"))
                require(kernel.get("catalogSHA256") == CATALOG_SHA256 and kernel.get("invocationId") == unit.invocation
                        and kernel.get("cgroup") == unit.cgroup_path and kernel.get("uid") == request["uid"]
                        and kernel.get("bootId") == request["bootId"], "R2_SERVICE_BINDING_REJECTED")
                verify_limits(kernel["limits"])
                measurement = decode_json(read_at(state.run_fd, "measurement.json"))
                verify_isolation(measurement["measurement"], config["outerNamespaces"], request["uid"])
                require(measurement.get("guardPassed") is True and measurement.get("tmpfsRoundTrip") is True,
                        "R2_CASE_FAILED")
                break
            if time.monotonic() >= next_heartbeat:
                emitter.send("heartbeat", phase="synthetic-running", providerReady=False)
                next_heartbeat = time.monotonic() + 1
            time.sleep(0.05)
        require(measurement is not None, "R2_REMOTE_DEADLINE")
        result = {"ok": True, "case": CASE, "providerReady": False,
                  "fullR2Verified": False, "syntheticMeasurement": measurement,
                  "catalogSHA256": CATALOG_SHA256}
    except BaseException as error:
        code = error.code if isinstance(error, StageError) else "R2_OPERATION_FAILED"
        result = {"ok": False, "code": code, "case": CASE, "providerReady": False,
                  "fullR2Verified": False, "catalogSHA256": CATALOG_SHA256}
    finally:
        if sys.platform == "linux":
            signal.alarm(15)
        not_started = unit is None or not unit.launch_attempted
        cleanup = (no_execution_cleanup() if not_started else unit.cleanup() if unit.invocation is not None else
                   cleanup_result(populated_zero=False, unit_stopped=False,
                                  identity_preserved=False, outputs_closed=False))
        result["cleanup"] = cleanup
        result["cleanupVerified"] = cleanup["cleanupVerified"]
        result["notStartedConfirmed"] = not_started
        if result["ok"] and not cleanup["cleanupVerified"]:
            result["ok"], result["code"] = False, "R2_CLEANUP_UNKNOWN"
        if state is not None:
            try:
                state.finish(result)
            except BaseException:
                result["ok"], result["code"] = False, "R2_RESULT_PERSISTENCE_FAILED"
        if unit is not None:
            unit.close()
        if pin is not None:
            pin.close()
        if state is not None:
            state.close()
        try:
            if emitter is not None:
                emitter.send("result", **result)
            elif sys.platform != "linux":
                sys.stderr.write("R2_NONROOT_LINUX_X64_REQUIRED\n")
        except BaseException:
            pass
        if sys.platform == "linux":
            signal.alarm(0)
    return 0 if result["ok"] else 1
