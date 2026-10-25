# Linux private CLI stage

This first worker component receives only the fixed native Claude 2.1.295,
Grok 1.0.50, socat 1.8.1.1-1ubuntu0.1 and libwrap0 artifacts and their notices.
It uses bounded, ordered JSON frames, exact digests, directory descriptors,
create-only files and a private ownership receipt under the SSH user's
`~/.local/share/project-hub-worker`.

It does not execute a binary, log in a provider, invoke a model or make a
provider ready. `stageComplete` means the staged file bytes and receipt were
flushed and verified. Grok's official HTTPS distribution consistency remains
distinct from a publisher signature or source-build attestation.

Each attempt receives a separate release directory identified by the bundle
digest and request nonce. Partial attempts remain for inspection and count
towards the 8 GiB private storage admission limit. Existing unknown ownership,
links, path changes, resource shortfall or digest failures are rejected.

`private_stage.py` requires nonroot x86_64 Linux, glibc >= 2.42, root-owned
OpenSSL runtime libraries, available RAM >= 10 GiB and disk >= 20 GiB. It has
a 540-second remote deadline and no arbitrary command or path operation.
The operator's SSH transport remains responsible for authentication, exact
host pin and its own independent deadline; an unconfirmed disconnect is not
proof of remote completion or cleanup.

The Windows operator uses `../lib/worker-bootstrap.js`: a Python loader command
bounded to 1024 UTF-8 bytes, followed by a four-byte length and compressed source
on SSH stdin. Fixed length/digests, bounded decompression and the same buffered
stdin preserve subsequent typed frames. This avoids observed truncation of long
quoted argv by Git/MSYS when launched from native Windows Node. Dynamic source
bootstrap belongs only to the approved owner deployment password channel; it
must not be accepted by a future restricted connection-key entrypoint.

`stage-request.example.json` uses the exact digest of this fixed artifact set.
Its example nonce must be replaced with a fresh cryptographic nonce for a real
connection. Runtime input must also satisfy `../windows/worker-stage.schema.json`
and the stricter ordered protocol state checks.

Portable protocol validation:

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

Linux filesystem containment, resource limits, offline CLI protocol and Hub
integration require their separate real validation gates described in the
approved SSH worker design and implementation plan.

## R2 synthetic policy (no execution)

`r2_policy.build_policy(request)` constructs a deterministic specification for
the single fixed `isolation-v1` synthetic Python measurement. It does not spawn
a process, connect over SSH, access credentials or execute either provider.
Its exact request fields are `schemaVersion: 1`, `case: "isolation-v1"`, a fresh
64-character lowercase hexadecimal `runNonce`, a canonical lowercase Linux
`bootId`, the fixed worker source `workerSHA256`, and integer `runtimeSeconds`
from 1 through 1800. Unknown fields, commands, environment, host paths, cases,
noncanonical identities and out-of-range values are rejected.

The returned policy includes a canonical SHA-256, strict namespace flags
(without optional `-try` namespace fallbacks), a read-only merged `/usr`
runtime, task/profile/tmp tmpfs limits of 2 GiB/256 MiB/512 MiB, and transient
user-service properties for 6 GiB memory, zero swap, CPU 150%, 256 tasks and
the selected deadline. Required runtime paths and root ownership checks are
explicit. They are requirements for a trusted caller holding verified runtime
descriptors; this pure builder has not inspected those files or proved their
identity. A different runtime layout is rejected by that future caller, not
silently supplied as an arbitrary bind path.

For runtime tools, `type: "regular"` applies **after symlink resolution**:
the expected `/usr/bin/python3` symlink is permitted when its complete chain
resolves within `/usr`. `toolResolution` requires the trusted caller to hold
and verify every traversed directory, symlink and final target identity, all
owned by root. Traversed directories and the resolved target must not be
group/other writable; the final tool additionally must not be setuid/setgid.
Symlink mode bits do not provide write protection: hold the link identity and
verify its owner and protected parent directory instead. Any link target
outside `/usr` is rejected, including a chain that would later return inside.
These are fixed requirements, not a filesystem check performed by the builder.

`../windows/worker-r2-policy.schema.json` describes both the closed request
and the returned policy; `worker-r2-policy-examples.json` contains a clearly
synthetic request, its exact builder output and rejected examples. The schema
fixes the complete measurement argv and environment. Cross-field nonce/unit,
runtime limit and canonical digest consistency are builder contracts, not
claims that JSON Schema alone can authenticate or authorize execution.
Systemd arguments explicitly disable manager environment expansion with
`--expand-environment=no`. Flag semantics follow the pinned
[bubblewrap 0.11.1 manual](https://raw.githubusercontent.com/containers/bubblewrap/v0.11.1/bwrap.xml)
and [systemd 259 manual](https://raw.githubusercontent.com/systemd/systemd/v259/man/systemd-run.xml);
compatibility with the actual host remains to be measured.

The policy is **not a run permit**. It binds the intended nonce, boot identity
and worker digest, but cannot verify them, enforce replay protection, establish
a clock/lease or authorize execution. It never marks a provider ready. A real
supervisor still needs independent deadlines, held runtime identity checks,
kernel resource checks before payload execution, unit invocation/cgroup
ownership, disconnect handling and complete-tree cleanup evidence. The
synthetic measurement only reports observations; its JSON is not a trusted
isolation or readiness attestation.

No extra file descriptor is preserved into this fixed measurement. Its tmpfs
data is therefore not promised to survive sandbox exit. SCM_RIGHTS directory
handoff, retained tmpfs roots, collection after `populated=0`, profiles,
secrets, allowed-destination egress, lifecycle failure injection and real
Linux/SSH execution remain unimplemented and unverified by this component.
This policy must not be substituted for those R2 gates or for provider tests.

## Fixed synthetic supervisor

`r2_contract.py`, `r2_runtime.py` and `r2_supervisor.py` implement the bounded
`run-r2-synthetic-v1` operation. `../lib/worker-r2-bootstrap.js` has a no-argument
builder: its catalog includes only the five fixed source modules and their
digests. The new Windows maintenance broker embeds this catalog and supplies
its complete input itself. Caller stdin cannot replace or append a program.
This is a separate broker registration, not an extension of the frozen stage
channel. The closed run request is described by
`../windows/worker-r2-run.schema.json`; migration and recovery are documented
in `../../docs/ssh-vault-maintenance.md`.

The request has a fresh nonce, exact catalog/UID/boot identity, at most a
120-second admission permit and a fixed 60-second service runtime. The
supervisor holds verified root-owned runtime descriptors, invokes the tools
through those descriptors, and verifies the exact service invocation,
MainPID/start time/executable, cgroup limits and namespace configuration before
releasing its execution gate. The gate and service metadata are published
create-only with Linux `renameat2(RENAME_NOREPLACE)` after complete writes.
Unsupported kernels, tool layouts or user-service configurations fail closed.

An owner-only lease serializes attempts. Accepted and heartbeat frames precede
the terminal result. A successful result requires kernel measurements and
confirmed cleanup of the owned cgroup. If no start was attempted, cleanup is
reported on that limited basis without inventing cgroup evidence. If a start
was attempted but identity or complete-tree cleanup cannot be proved, the
lease is retained and the result is not successful. Disconnect, remote alarm
and service runtime limits are independent safeguards; a lost local connection
alone never proves remote cleanup.

This operation tests fixed Python isolation and small temporary file I/O.
It does not run Claude/Grok, read provider authentication, call a model,
implement retained artifact collection, or enable a provider. Its result
always has `providerReady: false` and `fullR2Verified: false`. Portable tests
and a Windows import test are distinct from a real Linux execution; consult
the dated task verification report for that execution's actual outcome.
