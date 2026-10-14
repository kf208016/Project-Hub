"""Pure policy construction for a fixed, offline R2 synthetic measurement.

No process, filesystem, credential or network operation occurs in this module.
The result is a specification, not a permit or a verified runtime. A trusted
supervisor must verify the declared runtime using held descriptors, bind its
clock/lease/unit identities, and enforce cleanup before executing the argv.
"""
import hashlib
import json
import re


class PolicyError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _require(condition, code):
    if not condition:
        raise PolicyError(code)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


# This program only measures its own sandbox. In particular, it does not make
# connection attempts, read an auth/profile file or execute a provider.
SYNTHETIC_SOURCE = '''import json,os
names=("user","mnt","pid","net","ipc","uts","cgroup")
status={row.split(":",1)[0]:row.split(":",1)[1].strip() for row in open("/proc/self/status",encoding="ascii") if ":" in row}
mounts=[row.split() for row in open("/proc/self/mountinfo",encoding="ascii")]
interfaces=[row.split(":",1)[0].strip() for row in open("/proc/net/dev",encoding="ascii") if ":" in row]
fds=[]
for name in os.listdir("/proc/self/fd"):
 try:
  os.fstat(int(name));fds.append(int(name))
 except OSError:pass
result={"schemaVersion":1,"kind":"project-hub-r2-isolation-measurement","namespaces":{name:os.stat("/proc/self/ns/"+name).st_ino for name in names},"uid":os.geteuid(),"capabilities":{name:status.get(name) for name in ("CapInh","CapPrm","CapEff","CapBnd","CapAmb")},"noNewPrivs":status.get("NoNewPrivs"),"interfaces":sorted(interfaces),"openFDs":sorted(fds),"rootReadOnly":any(row[4]=="/" and "ro" in row[5].split(",") for row in mounts),"usrReadOnly":any(row[4]=="/usr" and "ro" in row[5].split(",") for row in mounts),"forbiddenPathsVisible":{name:os.path.exists(name) for name in ("/home","/root","/sys/fs/cgroup","/run/user","/run/dbus","/var/run/docker.sock")},"tmpfsCapacityBytes":{name:os.statvfs(name).f_blocks*os.statvfs(name).f_frsize for name in ("/work","/profile","/tmp")},"providerExecuted":False}
print(json.dumps(result,sort_keys=True,separators=(",",":")))
'''

_REQUEST_FIELDS = frozenset(("schemaVersion", "case", "runNonce", "bootId",
                             "workerSHA256", "runtimeSeconds"))
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_BOOT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_NAMESPACE_FLAGS = ("--unshare-user", "--unshare-pid", "--unshare-net",
                    "--unshare-ipc", "--unshare-uts", "--unshare-cgroup")
_TMPFS = (("/work", 2 * 1024**3), ("/profile", 256 * 1024**2),
          ("/tmp", 512 * 1024**2))


def build_policy(request):
    """Return a fresh deterministic policy; reject every undeclared input.

    runNonce/bootId/workerSHA256 bind the specification's intended context.
    They do not authenticate that context. No clock is accepted: this builder
    cannot issue, refresh, expire or replay a run permit. Only isolation-v1 is
    implemented; provider commands, filenames and environment are fixed here.
    """
    _require(type(request) is dict and set(request) == _REQUEST_FIELDS,
             "R2_POLICY_FIELDS_REJECTED")
    _require(type(request["schemaVersion"]) is int and request["schemaVersion"] == 1,
             "R2_POLICY_VERSION_REJECTED")
    _require(type(request["case"]) is str and request["case"] == "isolation-v1",
             "R2_SYNTHETIC_CASE_REJECTED")
    for key in ("runNonce", "workerSHA256"):
        _require(type(request[key]) is str and _HEX64.fullmatch(request[key]) is not None
                 and request[key] != "0" * 64, "R2_POLICY_BINDING_REJECTED")
    boot_id = request["bootId"]
    _require(type(boot_id) is str and _BOOT_ID.fullmatch(boot_id) is not None
             and boot_id != "00000000-0000-0000-0000-000000000000",
             "R2_POLICY_BINDING_REJECTED")
    seconds = request["runtimeSeconds"]
    _require(type(seconds) is int and 1 <= seconds <= 1800,
             "R2_RUNTIME_LIMIT_REJECTED")

    # A merged-/usr runtime is deliberately fixed. A host with a different
    # layout must be rejected, not supplied arbitrary alternative bind paths.
    requirements = {
        "mounts": [{"source": "/usr", "destination": "/usr", "readOnly": True,
                    "type": "directory", "ownerUid": 0, "rejectModeBits": 0o022}],
        "symlinks": [{"path": "/bin", "target": "usr/bin"},
                     {"path": "/lib", "target": "usr/lib"},
                     {"path": "/lib64", "target": "usr/lib64"}],
        "tools": [{"path": name, "type": "regular", "ownerUid": 0,
                   "rejectModeBits": 0o6022, "requiresHeldDescriptorAndSHA256": True}
                  for name in ("/usr/bin/bwrap", "/usr/bin/python3",
                               "/usr/bin/systemd-run", "/usr/bin/systemctl")],
        "requiredDirectories": ["/usr/bin", "/usr/lib", "/usr/lib64"],
        "toolResolution": {
            "typeAppliesTo": "resolved-target", "allowedResolvedRoot": "/usr",
            "rejectAnySymlinkTargetOutsideRoot": True,
            "requireHeldIdentitiesForAllComponentsLinksAndTarget": True,
            "requireRootOwnerForAllComponentsLinksAndTarget": True,
            "directoryAndTargetRejectModeBits": 0o022,
            "symlinkModeBitsAreNotWriteProtection": True,
        },
        "verificationPerformed": False,
    }
    argv = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", *_NAMESPACE_FLAGS,
            "--cap-drop", "ALL", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
            "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", "/profile",
            "--setenv", "TMPDIR", "/tmp", "--ro-bind", "/usr", "/usr"]
    for row in requirements["symlinks"]:
        argv += ["--symlink", row["target"], row["path"]]
    argv += ["--proc", "/proc", "--dev", "/dev", "--dir", "/run",
             "--dir", "/etc", "--dir", "/var"]
    for destination, size in _TMPFS:
        argv += ["--perms", "0700", "--size", str(size), "--tmpfs", destination]
    argv += ["--remount-ro", "/", "--chdir", "/work", "--", "/usr/bin/python3",
             "-I", "-B", "-c", SYNTHETIC_SOURCE]
    properties = ["MemoryMax=6442450944", "MemorySwapMax=0", "CPUQuota=150%",
                  "TasksMax=256", "RuntimeMaxSec=" + str(seconds) + "s",
                  "KillMode=control-group", "TimeoutStopSec=2s", "SendSIGKILL=yes",
                  "Restart=no", "NoNewPrivileges=yes", "UMask=0077",
                  "Delegate=no", "RemainAfterExit=yes"]
    policy = {
        "schemaVersion": 1, "kind": "project-hub-r2-synthetic-policy",
        "case": request["case"],
        "binding": {key: request[key] for key in ("runNonce", "bootId", "workerSHA256")},
        "scope": {"policyOnly": True, "runAuthorized": False, "providerReady": False,
                  "runtimeVerified": False, "supervisorImplemented": False,
                  "cleanupVerified": False},
        "limits": {"activeRuns": 1, "memoryBytes": 6 * 1024**3, "swapBytes": 0,
                   "cpuQuotaPercent": 150, "tasksMax": 256, "runtimeSeconds": seconds,
                   "tmpfs": {name: size for name, size in _TMPFS},
                   "admissionAvailableMemoryBytes": 10 * 1024**3,
                   "admissionAvailableDiskBytes": 20 * 1024**3},
        "runtimeRequirements": requirements,
        "bwrapArgv": argv,
        "systemd": {"unit": "project-hub-r2-" + request["runNonce"] + ".service",
                    "scope": "user", "serviceType": "exec",
                    "fixedArgv": ["--user", "--quiet", "--service-type=exec",
                                  "--expand-environment=no", "--working-directory=/"],
                    "propertyArgv":
                    ["--property=" + value for value in properties],
                    "requiresInvocationIdAndCgroupIdentity": True,
                    "requiresPopulatedZeroBeforeCollection": True},
        "fileDescriptors": {"stdin": "devnull", "stdout": "bounded-measurement-pipe",
                            "stderr": "bounded-diagnostic-pipe", "preservedExtraFDs": [],
                            "retainsTmpfsAfterExit": False},
        "executionRequirements": ["fresh-monotonic-permit-and-single-run-lease",
                                  "held-runtime-identity-and-digest-verification",
                                  "strict-namespace-and-bwrap-option-support",
                                  "kernel-resource-limit-verification-before-payload",
                                  "independent-remote-deadline-and-disconnect-handling",
                                  "owned-unit-and-cgroup-cleanup-verification"],
        "syntheticSourceSHA256": hashlib.sha256(SYNTHETIC_SOURCE.encode("ascii")).hexdigest(),
    }
    policy["policySHA256"] = hashlib.sha256(_canonical(policy)).hexdigest()
    return policy
