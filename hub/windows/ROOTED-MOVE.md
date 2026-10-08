# Native rooted move and hierarchy cleanup

Private application APIs for the audited Windows AMD64 build 26200 on fixed local NTFS. Browser/MCP input does not grant a new root. Product, Work, trash and journal roots come from the trusted Store. Source cleanup cannot overlap `_hub`, running Hub code, or an ancestor containing either.

## Authority and receipts

`lib/rooted-move.js` exposes asynchronous `snapshot`, `plan`, `move`, `recover` and `finalize`. A plan binds canonical roots and native root fingerprints, relative paths, source FileID, independent `native-tree-v1` hash and unique native record ID. Moves require the same volume and never overwrite a destination.

The helper pins roots/parents and renames the bound object through its handle. NTFS directory rename requires closing descendant handles. Directory oplocks are advisory and do not freeze a tree. The helper verifies before and after rename: identities, byte hashes, sizes, last-write times, names, hard links and alternate streams. Source endpoint/ancestor pins remain through receipt flush. Detected changes produce partial quarantine requiring review; changed content is not automatically accepted or deleted.

The native hash serializes `["native-tree-v1", rows]`. Each row contains `/` relative name, `d`/`f`, native object ID, decimal size, decimal last-write FILETIME and file SHA-256. Object identity hashes volume serial and FileIndex. This is not the legacy `Removal.snapshot` or `Git.rawContent` algorithm.

Immutable CreateNew/FlushFileBuffers receipts live at `ROOT/_hub/rooted-moves/<native-record-id>/planned.json`, `complete.json` and `partial.json`. Partial takes precedence. Callers accept only `state === 'complete'`. Recovery verifies actual identity/content; absent source alone is not success. Planned-only interruption after rename yields `moved-unreceipted`; explicit continuation may `finalize` the same plan after revalidation. Pre-helper interruption may retry the same confirmed plan when the source still matches and no native planned receipt exists. Partial receipts are never silently retried.

Limits: 128 KiB request, 20,000 entries, 256 MiB file bytes, 16 million UTF-16 characters of serialized hash metadata, owned helper with 512 MiB process/job memory, 30 seconds process/job CPU and 45 seconds wall timeout. Pending native I/O retains unmanaged buffers until kernel completion; timeout terminates the helper instead of freeing a pending buffer.

## Removal API

```js
const view = await removal.previewAsync(project, task);
// Human confirms displayed scope, optional IDs and typed project title.
const result = await removal.applyAsync({
  token: view.token, confirm: true, optional: selectedOptionalIds, typed
});
const history = await removal.historyAsync();
const restored = await removal.restoreAsync(result.record, true);
```

The private token holds native plans for all displayed mandatory/optional entries before confirmation. Apply consumes it once and selects only those plans. Restore binds exact reversed roots/object/hash with a distinct receipt and rejects collisions. Restored records cannot delete their restored source again. Legacy records without native evidence require manual review or a fresh ordinary deletion preview.

Trusted handoff controllers use `planNativeEntries({id,project,task,title,entries})`, `cleanupRecordAsync(recordOrId)`, `recoverAsync(recordOrId)` and `moveEntryAsync(record,entry)` under their existing confirmation grant. The `fingerprint` field remains the separate legacy preview hash.

## Hierarchy integration

`TaskIntegrate.previewAsync(project,task,only)` binds artifact FileID/SHA-256, ancestor Product destination root, metadata plans and reviewed Work cleanup plans before a once-only UI token. `applyAsync(body)` accepts selected children/files/optional IDs; `skipHooks:true` requires explicit user confirmation to skip the displayed hooks.

The Windows path first merges all sources grandchildren before children, persisting each reviewed Git receipt. Later private tokens advance their target only through the exact prior receipt. Source/native plans remain unchanged; config rows, hooks and active helper checks must match. Receive, once-only notification and native copy/metadata cleanup then run in the same grandchildren-first order.

`nativeActive()` and `nativeBusy(project,task?)` let the server block conflicting external changes without adding an internal self-lock. `pendingAsync()` rejects corrupt journals and validates actual completed artifact, metadata and Work evidence. Fresh evidence reads are more expensive than listing flags.

Git worktree repair changes the moved `.git` pointer. ReviewedMerge stores a separate post-repair native snapshot with the same original object ID and a new versioned tree hash; `receiptAsync` verifies it. This never substitutes a new hash for the original pre-move plan.

Interruptions/conflicts preserve Work, artifacts, branches and incomplete journals. Fresh preview authorizes continuation. Legacy incomplete hierarchy/merge records are not silently upgraded. These flows do not push, publish, upload or install global dependencies.

Local recovery facts do not provide whole-tree immutability, protection against the OS owner, WORM, trusted signatures or external attestation.

`Removal.cleanupRecordAsync(recordOrId, {beforeEntry})` optionally accepts a private
controller callback immediately before every entry move or completed receipt
check. TaskTransfer uses this to recheck shared Product references, source
reappearance and exact allowed metadata paths during confirmed continuation.
The callback is not an HTTP/MCP parameter. A rejection records the failure,
stops the batch and preserves the original native plan for explicit recovery.
TaskIntegrate also performs these current checks before accepting historical
complete cleanup receipts as current evidence.

Public optional-folder IDs use `/` separators on all platforms (for example
`作業/task`). Actual source paths remain canonical local paths; the ID is a
selection key rather than a filesystem path or new authority.
