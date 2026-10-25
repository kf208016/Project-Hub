# One-use read-only R2 inspection

This component follows the user-approved
[2026-10-15 diagnostic design](superpowers/specs/2026-10-15-r2-readonly-diagnostic-design.md).
It is a separate native build bound to one completed v2 registration and one
failed synthetic run. The existing activated broker/catalog remains immutable.

`hub/lib/ssh-r2-diagnostic.js` compiles the reviewed native sources and a fixed
trust capsule. The capsule fixes the original manifest, registration binding,
run nonce/permit/catalog, UID/boot, review document, failure evidence and new
owner-only grant root. No password enters this controller. `ensure({capsule})`
returns the native image identity; `buildRequest(grant, build)` and
`invoke(build, grant)` accept only the 30-field grant described by
`hub/windows/ssh-r2-diagnostic.schema.json`.

Native admission holds the exact helper/SSH/old broker images, original roots,
already-existing transaction/registration locks and evidence bytes. It validates
the completed history, source tomb, pending receipt, activation, pointer, run
receipt and failure evidence. A create-only DPAPI consumption record is written
and read back before the single exact-target Credential Manager read. No
credential enumeration/write/delete or credential UI is imported by the
production read-only store. The fixed SSH operation uses an owned Windows Job
and private ASKPASS peer checks, with a 45-second deadline and bounded output.

The independently bundled `r2_inspect.py` opens existing Linux directories and
ten fixed run/lease JSON files through held directory/file descriptors. It
checks ownership receipts, nonce, permit digest, UID/boot, owner-only metadata,
single links, canonical closed JSON, sizes and readback changes. Missing,
rejected and changed records remain distinct. It reads exact unit properties
using the saved root-owned systemctl identity and reads only the five fixed
cgroup files if the original unit/cgroup identity still matches.

The helper never starts or stops a R2 service, reruns a case or deletes its
lease. Its own directly spawned and still-unreaped read-only systemctl child
can be terminated and reaped on the inspection deadline or output overflow;
this does not signal an inspected service or a process from stored metadata.
SSH and the operating system may record login/access times.

The result uses `worker-r2-inspect-result.schema.json`. Python, native and
controller gates reject unknown vocabulary, extra fields and raw diagnostic
strings. The controller implements only this schema's closed subset, not a
general JSON Schema engine. A valid outer `diagnostic-result` means the bounded
frame was received and validated; `diagnostic.ok/code` describes completeness
of the current inspection. `cleanupHistorical` always remains `unknown`,
`providerReady` is always false and `snapshotAtomic` is always false. Current
unit absence, an empty cgroup or a valid historical measurement cannot recreate
missing historical cleanup evidence.

Each grant lasts at most ten minutes and allows one session. Failure, expiry,
changed bindings or a consumed grant never triggers another grant, credential,
password prompt or SSH attempt. Public examples are synthetic. Actual target,
vault metadata and filesystem references belong only in task-private operators.
Digests/DPAPI receipts are local identity evidence, not signatures, WORM,
external attestation or protection against a malicious process under the same
Windows account.
