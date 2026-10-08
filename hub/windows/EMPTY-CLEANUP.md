# Native empty batch cleanup

Eligibility compares PROJECT/task text with Store's CRLF-normalized completion
hash solely to detect stale cached metadata. Confirmation and movement use
separate raw-byte native tree hashes and FileID bindings. The adapter never
normalizes or rewrites source metadata line endings; restore preserves the bytes.

The private `NativeEmptyCleanup` service in `lib/empty-native.js` provides the Windows adapter. The POSIX `empty.js` functions remain unchanged.

Private confirmation tickets expire after two minutes using both wall time and
monotonic elapsed time. Observed rollback of either clock invalidates tickets;
changing the system clock cannot extend a ticket's monotonic deadline. Public
journal timestamps remain ordinary wall-clock timestamps.

```js
const service = new NativeEmptyCleanup({store, removal, busy});
const {items, blocked} = service.scan();
const preview = await service.preview({items: userSelectedItems});
// Show all preview.items paths, counts and warnings; then human confirms.
const result = await service.apply({token: preview.token, confirm: true});
const retry = await service.resumePreview(result.id);
// A separate human confirmation consumes this new continuation token.
const continued = await service.apply({token: retry.token, confirm: true});
const history = await service.history();
```

Selected item shape is `{project, task}`; absent/empty task selects a whole child project. Preview rejects duplicate/overlapping whole-project and task selections. The supported batch bound is 100 items. The outer private token is single use with a two-minute lifetime. It does not accept caller-provided native roots/plans. `nativeActive()` and `nativeBusy(project)` block conflicting external mutations, including other task metadata in a selected project, without setting Removal's internal lock.

Scanning reads strict UTF-8 and validates source metadata hashes against Store to reject stale cached identity. Malformed/unreadable Hub conversations are reported in `blocked`; errors do not become empty data. Any actual task conversation row, workdir, active operation, queued instruction, hidden attachment, task-specific result/temp data or handoff document prevents empty eligibility. Task done notes are retained in the review and do not default to selected.

Whole-project cleanup requires a child/derived project with all tasks eligible and no Work data. It permits PROJECT/task/chat metadata and files identical to the trusted shipped project template. Unknown files, modified templates and hidden data prevent whole-project selection; eligible individual tasks can still be selected while other project data remains. This is an eligibility check, not an attestation of absence of all work outside the Hub.

A batch selecting both descendants and ancestors uses a private Store projection excluding only those selected entries from dependency checks. Topological order is descendants first. Unselected descendants/shared references remain visible to Removal and still block. The projection grants no new filesystem root. Each item has a native plan before the single human confirmation; task metadata is moved last.

The batch journal and all individual Removal records are durably written before the first move. Batch path is `ROOT/_hub/empty-cleanups/<batch-id>.json`; ordinary Removal history stores each item's record. Initial files use CreateNew and fsync. Progress changes use the existing bounded exclusive-temp local journal. Immutable native move receipts retain their separate planned/complete/partial files.

After confirmation, every item is checked again immediately before its operation. New content, busy state, any scope mismatch or failed move stops the remaining batch with `ok:false`, `complete:false`, `recoveryRequired:true`. `moved` counts fully verified items; it does not imply a partial item's individual files were unaffected. Source and quarantine paths remain in the review.

A fresh resume preview binds the exact batch hash and existing native plans; it never silently replans current files. Already completed entries are reverified by native receipts, current FileID and bytes. Valid receipts can recover an interrupted metadata checkpoint. A native partial receipt, restored item or altered target requires review and cannot be used to delete newly restored/new source data.

Restore each ordinary item through `removal.restoreAsync(removalId, true)`. For whole-project ancestors, restore parents before descendants. Batch history reports `currentState: restored` or `mixed-restored` only after verifying the distinct native reverse receipts; historical completion is not mislabeled as a current quarantine copy.

The Windows server and UI wire authenticated scan, preview, apply, resume preview and history. The screen displays blocked scan reasons and the exact source/target paths, FileIDs and tree hashes before a separate confirmation. Partial results preserve the selected items and durable history; resuming requires a fresh review and confirmation. Individual restore uses the existing Removal history; whole-project parents must be restored before descendants. These local recovery facts are not signatures, WORM or protection against the OS owner.
