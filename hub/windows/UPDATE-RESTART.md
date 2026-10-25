# Windows CLI slots and Hub restart

## CLI update

`AiTools.checkUpdate('codex', {version:'0.164.0'})` previews a reviewed version;
omitting `version` retains the latest-npm check. Explicit selection accepts only
0.154.0 and 0.164.0, including downgrade and same-version repair. The settings
card shows both installable versions, active/previous slots and pointer errors.
The check returns a `nativePreview` with the exact version,
official registry URLs, SHA512 SRI for main/native packages, expiry and a
single-use token. `AiTools.update('codex',{version,token,confirm:true})` requires
that exact preview. Fresh metadata must still match before downloads start.

The updater extracts regular files and directories itself. It never runs npm,
an installer, or lifecycle scripts; `ignoreScripts:true` is part of the preview
and receipts. Tar links, traversal, device/ADS names, case collisions, checksum
errors and oversized data fail closed. There is no use of user npm config or
registry credentials. Metadata is bounded to 2 MiB, each download to 256 MiB,
and unpacked package/vendor totals to 1 GiB. Individual files remain capped at
512 MiB; vendor/archive counts remain 128/2000. Each request has a 600 s total
timeout and a 15 s stall timeout.

Candidates live under `_hub/cli/slots/<uuid>`. Only the reviewed Codex 0.154.0 and
0.164.0 native AMD64 artifacts can activate, using the frozen per-version hashes
in `lib/codex-versions.js`. The inventory covers every vendor file (6 in 0.154.0,
45 in 0.164.0), not only codex.exe. Unknown versions or differing vendor images
are blocked and their candidate slots removed; active/previous slots are retained.
This is a concrete compatibility limit, not proof that newer versions are
malicious or unsafe.

Activation runs zero-model sandbox probes, verifies the code again, updates
only a private active pointer and this Hub process's PATH, and retains the
previous pointer for rollback. The user/global Codex installation, machine
PATH, login files, role/model choices and source workspace are not updated.
Probe/version failure restores the prior selection. Failed candidates are removed without deleting the active or previous slot.
The observed 0.154.0 vendor is approximately 380 MiB and 0.164.0 approximately
461 MiB; stage allocation and gzip decoding
need additional temporary memory/storage.

Both probe receipts must include the measured read/network limits and exact
version; incomplete or stronger security claims are rejected. The completed
receipt is flushed before the private active pointer is installed, so an
interruption cannot select a slot with only an unfinished receipt.

SRI demonstrates content consistency with the previewed metadata. Baseline
hashes and a local receipt are not signatures, malware absence or external
attestation. `networkAccess=false` still has the previously measured network
limits, and sandbox reads are broader than the working directory.

## Hub restart

The browser-only `/api/restart` starts an operation-specific local helper.
It refuses active AI, command cleanup, Git/artifact transactions and native
file work. The helper validates saved launcher identity, owns no Hub/MCP
credential, and exposes only a temporary signed read-only status endpoint.

`start-windows.ps1 -Restart -ExpectedPid <pid> -ExpectedCreatedTicks <ticks>`
first proves the current service using the DPAPI-protected launcher secret,
requests an orderly quit, waits for that exact old process, and starts the
new Node service hidden in the same workspace. It preserves the browser
secret so the existing cookie remains valid. The helper verifies the new
PID creation ticks, Node executable path, service instance proof and source
digest before returning ready. Its PowerShell execution policy is scoped to
that helper process; no persistent system policy changes occur.

The status API returns `{body,proof}`. The proof is
`HMAC-SHA256(statusKey, 'hub-restart-status-v1\n'+challenge+'\n'+body)`.
The UI must pause its Hub API/SSE polling and fetch helper status with
`credentials:'omit'`. It verifies the HMAC, operation, source digest and new
PID/ticks before resuming cookie-bearing requests. Only exact old Hub origins
`http://127.0.0.1:<port>` and `http://localhost:<port>` are permitted.

The source digest covers five critical files: launcher, server, package
manifest, restart adapter and helper. It does not attest the entire repository,
its dependencies or an external build. A failed or timed-out restart remains
failed/paused; a planned restart is never reported as a ready service. Source
changes during restart are rejected. The data workspace is retained even if
the new service fails to start. Rollback of CLI selection is separate from
rollback of changed Hub source code.

Only known refusals before helper launch carry `notStarted:true` and a stage.
The UI may resume the old service after these refusals. Helper launch errors,
timeouts and unknown outcomes do not carry this flag and must remain paused.

## Reviewed-version boundary

Corrupt/rejected active pointers are reported as `nativeUpdate.error`; Hub keeps
starting but native execution fails closed with `NATIVE_CODEX_VERSION_UNREVIEWED`.
No silent fallback is allowed after a rejected pointer. Without an active slot,
the resolved global helper must match a reviewed binary hash. Digest caching
uses path, size, modification time and inode (also device and change time), with
path/metadata checks retained on cache hits. Native host checks before spawn remain.

0.164.0 retains the `native-command-lifetime-0.154.0` contract pending real-machine
acceptance; it is not a newly measured lifetime profile. This round does not
install/activate Codex, change global npm, separate CODEX_HOME, or modify the
Windows sandbox service/registry. Keep 0.154.0 as the rollback target.
