# Windows CLI slots and Hub restart

## CLI update

`AiTools.checkUpdate('codex')` returns a `nativePreview` with the exact version,
official registry URLs, SHA512 SRI for main/native packages, expiry and a
single-use token. `AiTools.update('codex',{version,token,confirm:true})` requires
that exact preview. Fresh metadata must still match before downloads start.

The updater extracts regular files and directories itself. It never runs npm,
an installer, or lifecycle scripts; `ignoreScripts:true` is part of the preview
and receipts. Tar links, traversal, device/ADS names, case collisions, checksum
errors and oversized data fail closed. There is no use of user npm config or
registry credentials. Metadata is bounded to 2 MiB, each download to 256 MiB,
and unpacked package data to 512 MiB. Downloads have idle and total deadlines.

Candidates live under `_hub/cli/slots/<uuid>`. Only the tested Codex 0.154.0
native AMD64 vendor inventory can activate. The recorded baseline includes
all six vendor files, not only codex.exe. Unknown versions or differing vendor
images remain staged and blocked; the old executable selection is retained.
This is a concrete compatibility limit, not proof that newer versions are
malicious or unsafe.

Activation runs zero-model sandbox probes, verifies the code again, updates
only a private active pointer and this Hub process's PATH, and retains the
previous pointer for rollback. The user/global Codex installation, machine
PATH, login files, role/model choices and source workspace are not updated.
Probe/version failure restores the prior selection. Failed candidates remain
available for inspection and may consume hundreds of MiB. The observed
0.154.0 vendor is approximately 380 MiB; stage allocation and gzip decoding
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
