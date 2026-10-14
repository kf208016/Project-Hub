"""Closed, synthetic-only R2 request and evidence validation. No execution."""
import re
from stage_protocol import StageError, require

OPERATION = "run-r2-synthetic-v1"
CASE = "isolation-v1"
NAMESPACES = ("user", "mnt", "pid", "net", "ipc", "uts", "cgroup")
TMPFS = {"/work": 2147483648, "/profile": 268435456, "/tmp": 536870912}
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
BOOT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


def validate_request(value, *, catalog, boot, uid, now):
    fields = {"protocol", "op", "sequence", "nonce", "catalogSHA256", "bootId", "uid",
              "case", "expiresAtUnixSeconds", "runtimeSeconds"}
    require(type(value) is dict and set(value) == fields, "R2_REQUEST_FIELDS_REJECTED")
    require(type(value["protocol"]) is int and value["protocol"] == 1
            and type(value["sequence"]) is int and value["sequence"] == 1,
            "R2_REQUEST_SEQUENCE_REJECTED")
    require(value["op"] == OPERATION and type(value["op"]) is str
            and value["case"] == CASE and type(value["case"]) is str,
            "R2_OPERATION_REJECTED")
    require(type(value["nonce"]) is str and HEX64.fullmatch(value["nonce"])
            and value["nonce"] != "0" * 64, "R2_NONCE_REJECTED")
    require(type(catalog) is str and HEX64.fullmatch(catalog)
            and type(value["catalogSHA256"]) is str and value["catalogSHA256"] == catalog,
            "R2_CATALOG_REJECTED")
    require(type(boot) is str and BOOT.fullmatch(boot) and type(value["bootId"]) is str
            and value["bootId"] == boot, "R2_BOOT_REJECTED")
    require(type(uid) is int and 0 < uid < 2147483647 and type(value["uid"]) is int
            and value["uid"] == uid, "R2_UID_REJECTED")
    expiry = value["expiresAtUnixSeconds"]
    require(type(now) in (int, float) and type(expiry) is int and 0 < expiry <= 2147483647
            and 0 < expiry - now <= 120, "R2_REQUEST_EXPIRED")
    require(type(value["runtimeSeconds"]) is int and value["runtimeSeconds"] == 60,
            "R2_RUNTIME_REJECTED")
    return dict(value)


def verify_limits(limits):
    require(type(limits) is dict and set(limits) == {"memory.max", "memory.swap.max", "pids.max", "cpu.max"},
            "R2_KERNEL_LIMITS_REJECTED")
    require(limits["memory.max"] == "6442450944" and limits["memory.swap.max"] == "0"
            and limits["pids.max"] == "256" and type(limits["cpu.max"]) is str,
            "R2_KERNEL_LIMITS_REJECTED")
    match = re.fullmatch(r"([1-9][0-9]{0,9}) ([1-9][0-9]{0,9})", limits["cpu.max"])
    require(match is not None and int(match[1]) * 100 == int(match[2]) * 150,
            "R2_KERNEL_LIMITS_REJECTED")
    return True


def verify_isolation(value, outer, uid):
    require(type(value) is dict and set(value) == {"schemaVersion", "kind", "namespaces", "uid",
            "capabilities", "noNewPrivs", "interfaces", "openFDs", "rootReadOnly", "usrReadOnly",
            "forbiddenPathsVisible", "tmpfsCapacityBytes", "providerExecuted"}, "R2_MEASUREMENT_REJECTED")
    require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1
            and value["kind"] == "project-hub-r2-isolation-measurement"
            and value["providerExecuted"] is False, "R2_MEASUREMENT_REJECTED")
    ns = value["namespaces"]
    require(type(ns) is dict and set(ns) == set(NAMESPACES)
            and type(outer) is dict and set(outer) == set(NAMESPACES), "R2_NAMESPACE_REJECTED")
    require(all(type(ns[n]) is int and ns[n] > 0 and type(outer[n]) is int
                and outer[n] > 0 and ns[n] != outer[n] for n in NAMESPACES), "R2_NAMESPACE_REJECTED")
    require(type(value["uid"]) is int and value["uid"] == uid and uid > 0,
            "R2_SANDBOX_UID_REJECTED")
    caps = value["capabilities"]
    require(type(caps) is dict and set(caps) == {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"}
            and all(c == "0000000000000000" for c in caps.values())
            and value["noNewPrivs"] == "1", "R2_CAPABILITIES_REJECTED")
    require(type(value["interfaces"]) is list and value["interfaces"] in ([], ["lo"]),
            "R2_NETWORK_NAMESPACE_REJECTED")
    require(type(value["openFDs"]) is list and value["openFDs"] == [0, 1, 2]
            and all(type(fd) is int for fd in value["openFDs"]), "R2_EXTRA_FD_REJECTED")
    require(value["rootReadOnly"] is True and value["usrReadOnly"] is True,
            "R2_READONLY_RUNTIME_REJECTED")
    paths = value["forbiddenPathsVisible"]
    require(type(paths) is dict and set(paths) == {"/home", "/root", "/sys/fs/cgroup", "/run/user",
            "/run/dbus", "/var/run/docker.sock"} and all(v is False for v in paths.values()),
            "R2_FORBIDDEN_PATH_VISIBLE")
    sizes = value["tmpfsCapacityBytes"]
    require(type(sizes) is dict and sizes == TMPFS and all(type(v) is int for v in sizes.values()),
            "R2_TMPFS_LIMIT_REJECTED")
    return True


def parse_cgroup(text, unit):
    rows = text.splitlines()
    require(len(rows) == 1 and rows[0].startswith("0::/"), "R2_CGROUP_V2_REQUIRED")
    path = rows[0][3:]
    parts = path[1:].split("/")
    require(len(path) <= 4096 and all(re.fullmatch(r"[A-Za-z0-9_.:@-]{1,255}", part)
            and part not in (".", "..") for part in parts) and parts[-1] == unit,
            "R2_CGROUP_IDENTITY_REJECTED")
    return parts


def cleanup_result(*, populated_zero, unit_stopped, identity_preserved, outputs_closed):
    values = (populated_zero, unit_stopped, identity_preserved, outputs_closed)
    require(all(type(v) is bool for v in values), "R2_CLEANUP_EVIDENCE_REJECTED")
    return {"populatedZeroObserved": populated_zero, "unitStopped": unit_stopped,
            "identityPreserved": identity_preserved, "ownedOutputsClosed": outputs_closed,
            "cleanupVerified": all(values), "basis": "owned-cgroup-events"}


def no_execution_cleanup():
    return {"populatedZeroObserved": False, "unitStopped": False,
            "identityPreserved": False, "ownedOutputsClosed": False,
            "cleanupVerified": True, "basis": "no-process-start-attempt"}
