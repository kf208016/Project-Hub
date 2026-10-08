# Windows original regression fixtures

`owned-native-fixture.js` installs a generated Codex stdio app-server inside an
owned temporary directory. Its model list, reply, optional delay and argument
capture are synthetic. The PATH includes only that entry and the known local
Node/Git/Windows runtimes; any real AI provider in runtime directories rejects
fixture setup. Removing the fixture shim cannot fall through to a user's CLI.

Echo replies encode the question-template brackets as JSON Unicode escapes.
Decoding the JSON preserves the exact captured RPC object while preventing the
fixture's echoed instruction template from becoming a false assistant question.

`reviewed-workspace.js` runs the real HTTP preview and prepare actions, explicitly
acknowledges the disclosed native read/network limits and submits a once-only
private permit. Only process inventory is replaced with fresh synthetic CIM rows.
Git, FileID/root pins, worktree registration, managed process exit, cleanup and
restore receipts remain real. A persisted `workspaceMode` alone never grants a run.

`fixture-bootstrap.js` covers setup.sh's seed/template stage for Windows tests.
It writes only beneath the caller's owned temporary directory, rejects links,
uses exclusive file creation and preserves existing ledgers. It does not install
dependencies, invoke Bash/WSL or integrate with the desktop.

`hub-native-cases.js` preserves native Codex conversation, queue, unread,
delegation and terminal assertions. Claude/Agy execution is explicitly rejected
and original metadata retained; imported synthetic conversation rows are data,
not proof of executing those providers. macOS assertions remain in the original
test branch. The macOS conversion test remains platform-specific; actual Windows
container/decode coverage is in `windows-images.test.js`.

These fixture results prove local implementation paths, not real model calls,
network isolation, external security attestation or user project deployment.

The version/restart test substitutes only the final restart adapter response to
assert exact HTTP routing arguments after real busy refusal. It does not replace
the running test server. Actual restart/handoff is covered by the dedicated
native restart tests and is not claimed by this routing case.

`native-delegate-cases.js` retains delegation success through explicit Codex
selection, including persistent queues, exact requested model IDs, cancellation,
restart/resume, missing CLI and prelaunch failure, completed-task rejection,
fresh guidance and the text-size boundary. Deferred Claude requests preserve
task, conversation and queue bytes. RPC assertions inspect actual app-server
settings/turn input, not fabricated legacy command arguments.

Delegation failure tests compare the persisted queue's raw bytes before and
after a refused manual launch. Resuming a stopped native flow uses a fresh
workspace preview, prepare and private permit. Changing a requested model's
CLI ID still rejects the queued request; it cannot inherit a default model.
Explicit user stop retains the original behavior of clearing pending requests.

Completion assertions create a fresh Store after the HTTP approval writes its
durable record. A Store instance created before approval holds its earlier
Completion snapshot and is not used as evidence of the current HTTP state.
