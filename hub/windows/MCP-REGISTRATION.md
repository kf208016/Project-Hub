# Windows temporary Codex MCP registration

The controller constructs `NativeMcpRegistration` with fixed `root`, `hubDir`,
`configFile` and loopback `port`. Its trusted callbacks inspect and revoke the
selected process-local task capability. The ordinary MCP tools cannot choose
these paths or call the private native config operations.

`preview({capabilityId,runId,token})` is read-only. `resolveGrant` receives these
three fields and returns the fresh public capability snapshot. The issuer
continues storing only the bearer hash. The registration preview holds the
submitted bearer in memory for at most 60 seconds, never returns it, and binds
the exact config bytes, FileID and root fingerprint. Its public result contains
the append-only TOML patch, scope and expiry for the user to review.

`apply({token:previewToken,confirm:true})` rechecks the grant and config binding.
It uses a unique `project_hub_<grant UUID with underscores>` section, preserves
the original config prefix exactly, and never overwrites a same-name server.
The fragment runs the fixed Node executable and Hub `mcp.js` and contains only
`HUB_MCP_CREDENTIAL_FILE`, an absolute path under `_hub/MCP`. The bearer, port,
run and expiry are sealed with current-user DPAPI. Existing config backups are
also sealed natively, because the existing config may contain private values.
Credential files are created by the private native create-only operation, with
held ancestor handles, native parent creation and the previewed Hub root FileID.
Only `_hub/MCP/<grant UUID>.bin` is accepted, with at most 64 KiB of ciphertext.

The native `private-config-write` operation holds an exclusive target handle,
checks both FileID and SHA256, writes a flushed encrypted backup and prepared
receipt, then writes/verifies the same file. Missing configs use create-only
native parent creation. The private `private-config-recover` operation accepts
only an incomplete encrypted journal, original file identity and exact current
hash; it is not exposed to ordinary MCP grants. Failed or interrupted writes
report partial/recovery state and never claim successful registration.

`await loadCredential(file)` returns `{token,runId,port}` only after a bounded
local file read, DPAPI decryption, payload/path binding and expiry checks. Its
payload also binds the current native Hub root fingerprint; copying a credential
into a different physical directory at the same path is rejected. Its
caller must clear inherited plaintext credentials, start stdio handling only
after this succeeds, and retain the existing fail-closed server authorization.
The encrypted file does not extend authority: server expiry, exhausted calls,
revoke and Hub restart still reject the grant. The maximum grant is 10 minutes
and 100 calls for one selected task.

The temporary entry is appended to this Windows user's global Codex config.
Other Codex clients running as the same user may discover and use it. They
share the same project/task/grant-run authority and 100-call budget; this is
not authentication of one unique app-server thread. Reloading the client is
required after registration or cleanup. Revoked/expired grants are refused
even by an already-running transport that cached the decrypted credential.

The owner-only browser routes are `POST /api/chatgpt/register/preview`,
`POST /api/chatgpt/register` (exact single-use preview approval),
`GET /api/chatgpt/register/status`, `POST /api/chatgpt/register/cleanup`,
`POST /api/chatgpt/register/recover/preview` and
`POST /api/chatgpt/register/recover`. Remote sessions, MCP bearers and requests
that combine an owner cookie with a bearer cannot mutate the config. Startup
prunes all old registrations before accepting a new registration operation;
periodic pruning handles expiry. A configured port of 0 disables registration
without reading or writing global config; it does not widen credential ports.

Both HTTP JSON bodies and MCP stdio messages/responses have a 2 MiB byte bound.
The ordinary UTF-8 file limit remains 200 KiB; JSON-escaped non-NUL controls can
roundtrip at that exact file limit. Split UTF-8 is buffered and malformed UTF-8
is rejected before dispatch. Oversized input is rejected without a success
state; an oversized unfinished stdio message can terminate that transport.

`cleanup({registrationId})` revokes first. It removes only an unchanged owned
fragment/file and its exact encrypted credential FileID/hash. A later user edit
or replaced file is preserved and reported as `manual-review`. `prune({})`
cleans expired registrations; `prune({all:true})` supports controller startup
after every previous process-local grant has been revoked. The controller
should also prune periodically and include `active()` in its restart busy gate.
Config cleanup and authorization revocation are distinct outcomes.

`status()` returns metadata only; it does not read the actual user config or
return credentials. `recover({registrationId,expectedHash,confirm:true})` is an
explicit controller action for a known incomplete private journal. It revokes
first and refuses unknown journal IDs, replaced files or different current
hashes. Version 2 private prepared records use `before.dpapi`; version 1 ordinary
MCP file journals remain unchanged and cannot recover private config backups.

The append lexer refuses unfinished strings/containers, duplicate managed names
and inline root MCP tables. It proves the added table is outside existing
strings/comments; it is not a full TOML semantic validator. Actual client reload
and existing config semantic errors remain separate from `configured:true`.
The fixture test asks the installed Codex CLI to parse only its isolated config
with `mcp list --json`; it does not start any listed server or model. No real
user config is read or written by that test.

DPAPI and local receipts are not protection against the same Windows account,
malware absence, immutable storage or external attestation. The native broker
retains the measured Windows build/NTFS restrictions and the broader read and
incomplete network boundaries already documented for native Codex.
