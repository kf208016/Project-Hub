# Windows native commands and files

These modules are verified on native AMD64 Windows build 26200, local NTFS,
and reviewed Codex CLI 0.154.0 / 0.164.0 artifacts (exact per-version hashes). Unsupported builds, architecture, filesystems and Codex
initialize versions fail closed. They are internal primitives; server and
browser authorization must be connected and tested separately.

## Standalone commands

`CommandIntents` accepts `{resolve, execute, record?, now?, monotonic?, ttlMs?}`. The resolver is
called as `resolve(project, task, scope)` on request and immediately before
approval. It must verify that the original capability run is still valid,
the task hash matches, and the native root fingerprint is unchanged.

The scope has the original capability `id`, `project`, `task`, `run`, `taskHash`, `root`, `rootFingerprint`.
`request(scope, {argv, cwd, expectedHash, timeoutMs?})` creates a pending
execute-once intent. `get(scope, id)` restricts results to that exact run and
task. `list()` is for the authenticated owner UI. `decide(body)` requires an
explicit browser decision, exact argv/cwd/task hash/root fingerprint, and
both `ackBroaderRead` and `ackNetworkLimits`. `cancelRun(run)` must be called
on capability revocation. `active()` includes cleanup in progress.
Wall and monotonic deadlines both apply. Invalid/backwards clocks revoke
pending work and cancel running work; completion remains busy until cleanup.
Approval close to expiry does not extend the grant: a running command is
canceled at its remaining monotonic deadline and still waits for cleanup.
The public `capId` is the original non-secret grant ID. The latest grant call
budget must still have at least one call when approval is accepted; exhausting
the budget with a final request/poll does not authorize later execution.
The optional `record(intent)` callback must persist the approval before
execution; a failure prevents spawning. Scope is checked again afterward.
Terminal rows expire and can be pruned under the 128-row bound; active rows
are never evicted to make space. `state:completed` means execution ended,
while `outcome` and the actual `exitCode` indicate command success/failure.

The executor receives `(intent, {root, rootFingerprint})` and returns
`{promise, cancel}`. `codex-commands.run(codexFile, options)` implements this
with a standalone app-server `command/exec`: no thread, turn, or model call.
It fixes `workspaceWrite`, one writable task root, `networkAccess=false`,
and excluded temporary roots. Hub and known AI credential environment
variables are removed.

Read access is broader than the task directory. A synthetic sibling marker
was readable by the dedicated sandbox account. `networkAccess=false` does
not constitute a complete network boundary. The browser must disclose both
limits before each approval. No claim is made about all host read paths or
all external network paths.

The retained 0.154.0 Windows contract rejects streaming commands and custom `outputBytesCap`, and
does not register its buffered commands for protocol `command/exec/terminate`.
The adapter uses buffered output plus an independent 1 MiB transport bound.
Cancellation closes the connection, then signals the owned supervisor if
shutdown has not finished. The result stays busy until the supervisor exits.

`managed-process.spawn(..., {dirPin:{root, rootFingerprint}})` pins every
directory ancestor using native handles that deny write and delete sharing.
The supervisor creates the CLI suspended, assigns its Job, rechecks the
identity, then resumes it. On cancellation or owner death it terminates the
owned Job, waits for no active processes, and releases the pins. The default
spawn behavior without `dirPin` remains supported. Pins control path identity
and lifetime; they do not provide an OS sandbox by themselves.

## File creation and overwrite

`scoped-file.read` and `create` remain bounded UTF-8 operations: 200 KiB,
strict text decoding, no binary data, no reparses, device paths, ADS, reserved
names or multiple hard links. Creation is exclusive and uses a temporary
file plus native rename without replacing an existing destination.

The HTTP and stdio JSON wire bound is 2 MiB, measured in bytes. This lets a
valid 200 KiB UTF-8 text consisting of non-NUL control characters survive JSON
escaping without enlarging the file limit. Invalid UTF-8 is rejected, including
when a character is split across input chunks. NUL remains rejected.

Ordinary file tools cannot read or write the actual Hub project's `PROJECT.md`
or `.ai` metadata. Task capabilities use `hub_get_task`, `hub_get_chat`, report,
question and step tools for the exact authorized task. Ordinary writes also
refuse `.codex`, `.claude`, `.gemini` and `.agents` execution-control directories
and `.mcp.json`; AI config/auth/credential files are also refused on reads.
These controls require their dedicated approval flow. Application-owned
`PROJECT.md`/`.ai` outside the Hub metadata directory and ordinary application
config/source files remain available inside the exact granted task root.

`overwrite(root, relative, text, expectedHash, rootFingerprint, journal)`
requires an exact SHA-256 of the full existing file. The private `journal`
is `{root, rootFingerprint}` and must refer to an issuer-controlled directory
outside the task root. Browser and MCP arguments must never choose it.

Overwrite pins both root chains without write/delete sharing and owns the
existing file through an exclusive native handle. It creates and flushes
`before.bin` and `prepared.json` before touching the file. It writes through
that same handle, truncates, flushes, verifies the resulting hash, and creates
a completion receipt. There is no forced replacement of an existing file.

The private journal uses exclusive create and flush. Atomic temp rename is
incompatible with deny-write directory sharing on this tested Windows build;
ordinary atomic file creation retains its tested sharing policy and rooted
relative NT opens. These paths must not be described as identical controls.

`recover(root, relative, recordId, currentHash, rootFingerprint, journal)`
is a browser-approved recovery operation. It accepts only an incomplete
prepared record, the original target FileID/root identity, exact current
hash, and intact backup hash. Completed/recovered records, changed identities
and corrupt backups are rejected. Recovery is never automatic for an unknown
file hash or identity.

Interrupted overwrite errors report `partial` and `recoveryRequired`.
`recordId` may be unavailable when the process dies before returning it; the
owner must inspect the private journal. A prepared record is not a success
receipt. File flush and local journals are not hardware power-loss proof,
signatures, WORM storage or external attestation. A host owner can still
modify the local journal.

## Private binary transactions

`scoped-secret` exports `inspect`, `copy`, `remove`, with an 8 MiB bound.
`scoped-artifact` provides the same API with a 64 MiB bound for reviewed
artifact transfers. Neither operation is an ordinary MCP tool or grant.

Inspect returns only SHA-256, byte count and file fingerprint. Copy takes
source root identity, relative source path and SHA-256 plus destination root
identity and path; it creates missing parents through held native handles
and refuses overwrite. Remove requires the exact content hash and original
destination file identity. Identical content in a replacement file is not
enough to permit removal.

Reviewed supply/transfer callers also pass `sourceFingerprint`, obtained from
inspect. The native copy compares it on the held source handle before copying;
replacement with identical bytes and a different FileID is rejected. The field
is optional only for the lower-level private API's existing callers. No
ordinary MCP operation can request binary copy or deletion.

Private copy temporary names end in `.key`. Review/transfer/Git autosave must
exclude `.hub-write-*`: an interrupted operation can leave a temporary file.
No caller may infer successful delivery or cleanup from a failed response.
All private operations stay async through the owned process supervisor.

## Verification

The scoped suites cover ordinary success, literal argv, malformed protocol,
unexpected approval requests, version refusal, concurrent approve/replay,
task/root mutation, expiry, decline, cancellation and owner death; directory
rename and the write handle prerequisite for setting a reparse point; binary
and encoding bounds; concurrent junction swaps and create contention; exact
overwrite/backup/receipt, corrupt or replaced recovery files; and private
binary transactions. A fixture copy of the native source was interrupted
after WriteFile and before EOF/Flush to prove partial content recovery.

A separate real zero-model Codex test exercised long-lived root/child/
grandchild processes. Cancellation and owner death removed all reported
owned processes, preserved an unrelated fixture, and released the root pins
after cleanup. This is specific process evidence, not proof about arbitrary
unrelated host processes or future Codex releases.

The Codex runtime accepts only allow-listed app-server userAgent versions and requires an exact
match to the binary version selected by the controller. Both versions keep the
5-second forced shutdown and omit outputBytesCap; 0.164.0 requires real-machine
re-verification. A synthetic handshake is not evidence of sandbox containment.
