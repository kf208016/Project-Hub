# Saved SSH registration maintenance

This implementation follows the user-approved
[maintenance design](superpowers/specs/2026-10-14-ssh-vault-maintenance-design.md).
It copies one exact product credential through native buffers, validates the
new broker twice, switches the pinned product pointer, then precisely retires
the old entry. No password prompt, credential enumeration, provider login,
model invocation or general shell operation is exposed.

## Components and immutable bindings

- `hub/lib/ssh-vault-maintenance.js`: closed nonsecret manifest/request
  validation, reproducible source/catalog identity, separate helper and broker
  compilation, bounded events and process supervision.
- `hub/windows/ssh-maintenance-*.cs`: native vault access, exclusive locks,
  DPAPI receipts, owned-process validation capabilities and recovery.
- `hub/lib/worker-r2-bootstrap.js`: fixed source catalog embedded at compile time.
- `hub/windows/ssh-vault-maintenance.schema.json`,
  `ssh-maintenance-recovery.schema.json`, `ssh-maintenance-state.schema.json`
  and `worker-r2-run.schema.json`: closed document formats. Native code also
  enforces cross-field, code/root identity, clock and state requirements.

The old descriptor, original receipt and executable remain unchanged. The
new descriptor has its own registration ID, root and exact Credential Manager
target. Native binaries must be built from the final reviewed source before
preparing the manifest; a later source/catalog change is a new maintenance
operation. Digests are change detection, not publisher signatures or external
attestation. Windows Generic credentials remain within the same-user/admin
trust domain.

Source, destination and pointer roots must be separate siblings or otherwise
nonoverlapping directories. The pointer implementation uses a held directory
handle for relative file operations. Unlike the frozen registration root pin,
its final directory must permit write sharing for NTFS child renames, while
denying deletion; ancestors retain the strict pin. No path-based write fallback
is allowed. The dedicated native pointer tests must pass before migration.

Replacing an existing pointer preserves the displaced file: open the exact
target with read/delete access while denying write/delete sharing, verify its
bytes, move that held file to a create-only backup, then publish the new file
without replacement. An unexpected destination or backup is preserved and
refused. There can be a temporary missing-pointer interval; brokers fail closed
during that interval. Fixed backup/temporary identities participate in recovery
state, allowing a stopped operation to finish or restore its exact prior bytes.
This is deliberately a recoverable sequence, not an atomic pointer replacement.

## Operation order

1. Prepare fresh owner-only roots and a bounded migration manifest. Inspect
   its exact source/destination identities and immutable code/catalog hashes.
   Task-specific host/user/SID/target values belong in private operator files,
   not examples or distributable packages.
2. Call `invokeHelper('migrate', manifest, {onEvent})`. The native helper probes
   the frozen source, writes durable intents, copies/readbacks the exact secret,
   launches two separate pending-registration validation brokers through
   one-use private capabilities, activates the pointer, and retires the source.
3. Inspect `invokeHelper('status', manifest)` and independently probe the active
   destination. A completed migration proves registration/SSH identity only.
4. Build a new short-lived closed R2 request after a fresh identity probe, then
   use `launch('broker', 'run-r2-synthetic-v1', manifest, {runRequest})`. Consume
   its bounded framed output and require a successful terminal frame, verified
   cleanup and normal process close. No caller-provided payload is accepted.

The initial migration grant can expire without expiring an already activated
registration. Each R2 run has a separate short-lived permit. No error triggers
a password prompt, another credential, a new grant or a weaker isolation mode.

## Recovery

`status` is read-only and returns an `observedStateSHA256` derived under locks
from exact nonsecret file identities, credential existence/validated metadata
and whether the two native secret buffers are equal. It never returns a secret
or password digest. Unknown metadata/pointer bytes cause refusal.

- `resume`: continue this same migration after checking its durable state.
- `rollback`: only while the source is still retained, restore exact prior
  pointer bytes and precisely remove the owned destination. It cannot recreate
  an already retired source credential.
- `recover-pointer`: after proven source retirement and destination activation,
  restore only a missing pointer. An existing unknown pointer is refused.

Expired mutation authority requires an explicit fresh `recoveryGrant`, bound to
the original manifest SHA, operation and the actual locked observed state, with
a lifetime of at most 30 minutes. Pointer recovery always requires this grant.
The operator must inspect the reported state before deliberately issuing it;
elapsed time or a failure never issues approval automatically. An interrupted
pointer recovery may resume its exact persisted grant. Stale-state grants are
rejected. Forward migration is refused after a completed rollback.

The migration is a recoverable multi-step operation, not an atomic transaction
across Credential Manager and NTFS. File flushes and injected process stops do
not prove power-loss durability for all storage devices. Keep partial evidence
and both known entries when safe recovery cannot be established.

## Verification commands

```powershell
node --test hub/test/ssh-maintenance-contract.test.js hub/test/worker-r2-bootstrap.test.js
$env:HUB_RUN_MAINTENANCE_PROCESS_TEST = '1'
node --test hub/test/ssh-maintenance-process.test.js
$env:HUB_RUN_MAINTENANCE_NATIVE_TEST = '1'
node --test hub/test/ssh-maintenance.test.js
$env:PYTHONPATH = 'src'
python -m unittest discover -s tests -v
```

The native opt-in suites use freshly owned loopback/synthetic credentials and
their exact cleanup helper, not the user's saved registration. Run them in a
normal Windows process context: tool sandbox restrictions can prevent Job,
named-pipe and Git/MSYS startup. A skipped opt-in test is not a pass. Production
builds omit fault injection, fixture inspection/cleanup and capability-test
entrypoints. Real migration, Linux isolation and provider readiness each need
their own dated evidence; test success must not be substituted for those gates.
