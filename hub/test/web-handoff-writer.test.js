'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const writer = require('../lib/web-handoff-writer');
const native = process.platform === 'win32' ? test : test.skip;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-web-writer-'));
  const root = path.join(parent, 'root'), journalRoot = path.join(parent, 'journal');
  fs.mkdirSync(root); fs.mkdirSync(journalRoot);
  t.after(() => {
    const resolved = path.resolve(parent), temp = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(temp + path.sep) && path.basename(resolved).startsWith('hub-web-writer-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const rootFingerprint = (await writer.identity(root)).rootFingerprint;
  return { parent, root, rootFingerprint, journal: { root: journalRoot, rootFingerprint: (await writer.identity(journalRoot)).rootFingerprint } };
}
function record(journal) { return { ...journal, recordId: crypto.randomUUID().replaceAll('-', '') }; }
async function inspect(f, name, maxBytes = writer.LIMITS.task) { return writer.inspect(f.root, name, { text: true, maxBytes, rootFingerprint: f.rootFingerprint }); }

test('Internal writer has distinct bounds and rejects invalid Unicode before spawning', async () => {
  assert.deepEqual(writer.LIMITS, { 'raw-result': 262144, row: 2097152, task: 4194304, metadata: 1048576, log: 67108864 });
  for (const value of ['\0', '\ud800', '\udfff']) await assert.rejects(writer.create('C:\\fixture', 'raw.txt', value, 'a'.repeat(64)), error => ['INVALID_CONTENT', 'ENCODING_REJECTED'].includes(error.code));
  await assert.rejects(writer.create('C:\\fixture', 'raw.txt', 'x'.repeat(262145), 'a'.repeat(64), { kind: 'raw-result' }), { code: 'CONTENT_TOO_LARGE' });
  await assert.rejects(writer.inspect('C:\\fixture', 'raw.txt', { maxBytes: 67108865, rootFingerprint: 'a'.repeat(64) }), { code: 'INVALID_SIZE_LIMIT' });
  await assert.rejects(writer.create('C:\\fixture', 'raw.txt', '', 'a'.repeat(64), { kind: 'public' }), { code: 'INVALID_KIND' });
  await assert.rejects(writer.atomicCreate('C:\\fixture', 'revision.json', 'x'.repeat(writer.LIMITS.metadata + 1), 'a'.repeat(64)), { code: 'CONTENT_TOO_LARGE' });
  assert.equal(writer.isPendingTempName('.hub-web-' + 'a'.repeat(32) + '.tmp'), true);
  assert.equal(writer.isPendingTempName('.HUB-WEB-' + 'A'.repeat(32) + '.TMP'), true);
  for (const name of ['revision.json', '.hub-web-' + 'a'.repeat(31) + '.tmp', 'nested/.hub-web-' + 'a'.repeat(32) + '.tmp']) assert.equal(writer.isPendingTempName(name), false);
});

native('NativeMetadataCreate uses create-only pinned metadata with reserved pending names', { timeout: 60000 }, async t => {
  const f = await fixture(t), text = JSON.stringify({ state: 'previewed', result: '合成內容', revision: 0 });
  const created = await writer.atomicCreate(f.root, 'revisions/0000.json', text, f.rootFingerprint);
  const before = await inspect(f, 'revisions/0000.json');
  assert.equal(created.flushed, true); assert.equal(created.sha256, hash(text)); assert.equal(created.rootFingerprint, f.rootFingerprint); assert.equal(created.fileFingerprint, before.fileFingerprint); assert.deepEqual(JSON.parse(before.text), JSON.parse(text));
  await assert.rejects(writer.atomicCreate(f.root, 'revisions/0000.json', '{}', f.rootFingerprint), { code: 'DESTINATION_EXISTS' });
  assert.equal((await inspect(f, 'revisions/0000.json')).sha256, before.sha256);
  const pending = '.hub-web-' + 'a'.repeat(32) + '.tmp';
  await assert.rejects(writer.atomicCreate(f.root, pending, '{}', f.rootFingerprint), { code: 'RESERVED_TEMP_NAME' });
  fs.writeFileSync(path.join(f.root, pending), '{"unknown":true}');
  assert.equal((await inspect(f, pending)).text, '{"unknown":true}');
  // Filename classification is not ownership or receipt-chain authority. Read
  // does not adopt/remove an unknown temporary file.
  assert.equal(fs.existsSync(path.join(f.root, pending)), true);
  fs.linkSync(path.join(f.root, 'revisions/0000.json'), path.join(f.root, 'hard.json'));
  await assert.rejects(inspect(f, 'hard.json'), { code: 'MULTIPLE_LINKS_REJECTED' });
  await assert.rejects(writer.atomicCreate(f.root, 'hard.json', '{}', f.rootFingerprint), { code: 'DESTINATION_EXISTS' });
  fs.renameSync(f.root, path.join(f.parent, 'old-root')); fs.mkdirSync(f.root);
  await assert.rejects(writer.atomicCreate(f.root, 'replacement.json', '{}', f.rootFingerprint), { code: 'ROOT_CHANGED' });
  assert.deepEqual(fs.readdirSync(f.root), []);
});

native('NativeMetadataCreate interrupted around write, flush and rename exposes only absent or complete finals', { timeout: 150000 }, async t => {
  const f = await fixture(t), managed = require('../lib/managed-process'), original = managed.spawn;
  const source = fs.readFileSync(path.join(__dirname, '../windows/web-handoff-writer.cs'), 'utf8');
  t.after(() => { managed.spawn = original; });
  const stageHelper = `
  static string FixtureStage="";
  static void FixturePause(string stage){if(FixtureStage==stage){Console.Error.WriteLine("HUB_METADATA_PAUSE:"+stage);Console.Error.Flush();System.Threading.Thread.Sleep(10000);}if(stage=="before-rename"&&FixtureStage=="no-replace"){Console.Error.WriteLine("HUB_METADATA_RACE");Console.Error.Flush();System.Threading.Thread.Sleep(3000);}}
  static bool FixtureWrite(IntPtr file,byte[] bytes,uint length,out uint written,IntPtr overlap){bool ok=WriteFile(file,bytes,length,out written,overlap);FixturePause("after-write");return ok;}
  static bool FixtureFlush(IntPtr file){FixturePause("before-flush");bool ok=FlushFileBuffers(file);FixturePause("after-flush");return ok;}
`;
  let changed = source.replace('static void Write(IntPtr file,byte[] bytes)', stageHelper + '  static void Write(IntPtr file,byte[] bytes)');
  for (const [needle, replacement] of [
    ['WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)', 'FixtureWrite(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)'],
    ['written==bytes.Length&&SetEndOfFile(file)&&FlushFileBuffers(file)', 'written==bytes.Length&&SetEndOfFile(file)&&FixtureFlush(file)'],
    ['FILE_INFO identity=FileIdentity(temp);string expectedHash=Hash(bytes);', 'FILE_INFO identity=FileIdentity(temp);string expectedHash=Hash(bytes);FixtureStage=parts[parts.Length-1].Substring(9).Replace(".json","");FixturePause("before-write");'],
    ['Rename(temp,chain.Last,parts[parts.Length-1]);moved=true;', 'FixturePause("before-rename");Rename(temp,chain.Last,parts[parts.Length-1]);moved=true;FixturePause("after-rename");'],
    ['Require(FlushFileBuffers(temp),"CREATE_FLUSH_INCOMPLETE");', 'Require(FlushFileBuffers(temp),"CREATE_FLUSH_INCOMPLETE");FixturePause("after-final-flush");']
  ]) { assert.equal(changed.split(needle).length, 2); changed = changed.replace(needle, replacement); }
  const cs = path.join(f.parent, 'atomic-metadata.cs'), exe = path.join(f.parent, 'atomic-metadata.exe'); fs.writeFileSync(cs, changed);
  execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + exe, cs], { windowsHide: true, timeout: 30000 });
  const oldText = JSON.stringify({ revision: 0, state: 'previewed' }); await writer.atomicCreate(f.root, 'snapshot.json', oldText, f.rootFingerprint); const old = await inspect(f, 'snapshot.json');
  for (const stage of ['before-write', 'after-write', 'before-flush', 'after-flush', 'before-rename', 'after-rename', 'after-final-flush']) {
    const relative = 'revision-' + stage + '.json', text = JSON.stringify({ revision: 1, state: 'planned', synthetic: '臺灣'.repeat(4000), previous: old.sha256 }); let killed = 0;
    const pendingBefore = new Set(fs.readdirSync(f.root).filter(writer.isPendingTempName));
    managed.spawn = (binary, ...args) => {
      const child = original(path.basename(binary).startsWith('web-handoff-writer-') ? exe : binary, ...args);
      child.stderr.on('data', bytes => { if (bytes.toString().includes('HUB_METADATA_PAUSE:' + stage)) { killed++; child.kill(); } });
      return child;
    };
    await assert.rejects(writer.atomicCreate(f.root, relative, text, f.rootFingerprint), error => error.code === 'BROKER_INTERRUPTED' && error.partial === true);
    managed.spawn = original; assert.equal(killed, 1);
    const current = await inspect(f, relative), renamed = stage === 'after-rename' || stage === 'after-final-flush';
    assert.equal(current.missing, !renamed);
    if (renamed) { assert.equal(current.sha256, hash(text)); assert.equal(current.text, text); assert.deepEqual(JSON.parse(current.text), JSON.parse(text)); await assert.rejects(writer.atomicCreate(f.root, relative, '{}', f.rootFingerprint), { code: 'DESTINATION_EXISTS' }); }
    else { const pending = fs.readdirSync(f.root).filter(name => writer.isPendingTempName(name) && !pendingBefore.has(name)); assert.equal(pending.length, 1); const observed = await writer.inspect(f.root, pending[0], { rootFingerprint: f.rootFingerprint }); assert.equal(observed.missing, false); assert.match(observed.fileFingerprint, /^[a-f0-9]{64}$/); assert.equal(fs.existsSync(path.join(f.root, pending[0])), true); }
    const oldAfter = await inspect(f, 'snapshot.json'); assert.equal(oldAfter.text, oldText); assert.equal(oldAfter.sha256, old.sha256); assert.equal(oldAfter.fileFingerprint, old.fileFingerprint);
  }
  // The early destination check is not relied on for noReplace. Create a
  // competing final while the flushed temp is held immediately before rename.
  let competing = 0;
  managed.spawn = (binary, ...args) => {
    const child = original(path.basename(binary).startsWith('web-handoff-writer-') ? exe : binary, ...args);
    child.stderr.on('data', bytes => { if (bytes.toString().includes('HUB_METADATA_RACE')) { competing++; fs.writeFileSync(path.join(f.root, 'revision-no-replace.json'), '{"owner":"competing"}', { flag: 'wx' }); } });
    return child;
  };
  await assert.rejects(writer.atomicCreate(f.root, 'revision-no-replace.json', '{"owner":"writer"}', f.rootFingerprint), { code: 'DESTINATION_EXISTS' });
  managed.spawn = original; assert.equal(competing, 1); assert.equal((await inspect(f, 'revision-no-replace.json')).text, '{"owner":"competing"}');
  assert.equal((await inspect(f, 'snapshot.json')).fileFingerprint, old.fileFingerprint);
  t.diagnostic('Owned native fixture child kills at seven metadata create stages; pending temps retained for read-only review. This is not a power-loss or DiskFull test.');
});

native('Real NTFS create-only writer supports 256 KiB text without widening public scoped-file', { timeout: 60000 }, async t => {
  const f = await fixture(t), text = '\u0001'.repeat(writer.LIMITS['raw-result']);
  const missing = await inspect(f, 'nested/raw.txt'); assert.equal(missing.missing, true); assert.equal(missing.sha256, 'missing'); assert.equal(missing.rootFingerprint, f.rootFingerprint);
  const created = await writer.create(f.root, 'nested/raw.txt', text, f.rootFingerprint, { kind: 'raw-result' });
  assert.equal(created.created, true); assert.equal(created.flushed, true); assert.equal(created.sha256, hash(text));
  const read = await inspect(f, 'nested/raw.txt'); assert.equal(read.text, text); assert.equal(read.fileFingerprint, created.fileFingerprint);
  await assert.rejects(writer.create(f.root, 'nested/raw.txt', 'replacement', f.rootFingerprint), { code: 'DESTINATION_EXISTS' });
  const publicBroker = require('../lib/scoped-file');
  await assert.rejects(publicBroker.create(f.root, 'public.txt', 'x'.repeat(200 * 1024 + 1)), { code: 'OVERWRITE_NOT_SUPPORTED' });
  const prefix = await publicBroker.read(f.root, 'nested/raw.txt', f.rootFingerprint); assert.equal(prefix.bytesRead, 200 * 1024); assert.equal(prefix.truncated, true); assert.equal(prefix.sha256, null);
});

native('Overwrite and append preserve FileID, record full-byte blobs, and retry once without duplicates', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await writer.create(f.root, 'task.md', '原稿\r\n', f.rootFingerprint, { kind: 'task' });
  const before = await inspect(f, 'task.md'), transaction = record(f.journal);
  const result = await writer.overwrite(f.root, 'task.md', '新稿\n', before, transaction);
  assert.equal(result.fileFingerprint, before.fileFingerprint); assert.equal(result.beforeHash, before.sha256); assert.equal(result.sha256, hash('新稿\n'));
  const dir = path.join(f.journal.root, result.recordId), intent = JSON.parse(fs.readFileSync(path.join(dir, 'intent.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'before.bin'), 'utf8'), '原稿\r\n'); assert.equal(fs.readFileSync(path.join(dir, 'after.bin'), 'utf8'), '新稿\n'); assert.match(intent.afterBlobFingerprint, /^[a-f0-9]{64}$/);
  const retried = await writer.overwrite(f.root, 'task.md', '新稿\n', before, transaction); assert.equal(retried.alreadyApplied, true); assert.equal(retried.beforeHash, before.sha256);
  await assert.rejects(writer.overwrite(f.root, 'task.md', '別稿', before, transaction), { code: 'RETRY_BINDING_CHANGED' });
  await writer.create(f.root, 'chat.jsonl', '{"id":1}\n', f.rootFingerprint, { kind: 'log' });
  const chatBefore = await inspect(f, 'chat.jsonl', writer.LIMITS.log), appendJournal = record(f.journal);
  const appended = await writer.append(f.root, 'chat.jsonl', '{"id":2}\n', chatBefore, appendJournal);
  assert.equal(appended.fileFingerprint, chatBefore.fileFingerprint); assert.equal(appended.appended, true);
  await writer.append(f.root, 'chat.jsonl', '{"id":2}\n', chatBefore, appendJournal);
  assert.equal((await inspect(f, 'chat.jsonl')).text, '{"id":1}\n{"id":2}\n');
});

native('Append binds a missing source and creates the initial log after durable intent', { timeout: 60000 }, async t => {
  const f = await fixture(t), before = await inspect(f, '.ai/chat/task.jsonl'), transaction = record(f.journal), row = '{"id":"once"}\n';
  const result = await writer.append(f.root, '.ai/chat/task.jsonl', row, before, transaction);
  assert.equal(result.created, true); assert.equal(result.beforeHash, 'missing'); assert.equal(result.sha256, hash(row));
  const retried = await writer.append(f.root, '.ai/chat/task.jsonl', row, before, transaction); assert.equal(retried.alreadyApplied, true);
  assert.equal((await inspect(f, '.ai/chat/task.jsonl')).text, row);
  const other = await inspect(f, '.ai/chat/other.jsonl'); fs.writeFileSync(path.join(f.root, '.ai/chat/other.jsonl'), row);
  await assert.rejects(writer.append(f.root, '.ai/chat/other.jsonl', row, other, record(f.journal)), { code: 'DESTINATION_EXISTS' });
});

native('NTFS rejects path traversal, ADS, reserved names, reparses and hard links', { timeout: 60000 }, async t => {
  const f = await fixture(t), outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'synthetic outside');
  for (const name of ['../outside/secret.txt', '/absolute', 'a:stream', 'CON.txt', 'COM1', 'COM¹.txt', 'NUL', 'file.', 'file ', 'a//b']) {
    await assert.rejects(writer.inspect(f.root, name, { rootFingerprint: f.rootFingerprint }), { code: 'INVALID_PATH' });
    await assert.rejects(writer.create(f.root, name, 'bad', f.rootFingerprint), { code: 'INVALID_PATH' });
  }
  fs.symlinkSync(outside, path.join(f.root, 'linked'), 'junction');
  await assert.rejects(inspect(f, 'linked/secret.txt'), error => error.status === 403);
  await assert.rejects(writer.create(f.root, 'linked/new.txt', 'bad', f.rootFingerprint), error => error.status === 403);
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(f.root, 'hard.txt'));
  await assert.rejects(inspect(f, 'hard.txt'), { code: 'MULTIPLE_LINKS_REJECTED' });
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

native('CAS rejects root replacement, identical bytes with a new FileID, and stale hashes', { timeout: 60000 }, async t => {
  const f = await fixture(t); await writer.create(f.root, 'task.md', 'before', f.rootFingerprint);
  const before = await inspect(f, 'task.md');
  fs.writeFileSync(path.join(f.root, 'task.md'), 'changed');
  await assert.rejects(writer.overwrite(f.root, 'task.md', 'after', before, record(f.journal)), { code: 'HASH_CHANGED' });
  fs.renameSync(path.join(f.root, 'task.md'), path.join(f.root, 'old-task.md')); fs.writeFileSync(path.join(f.root, 'task.md'), 'before');
  await assert.rejects(writer.overwrite(f.root, 'task.md', 'after', before, record(f.journal)), { code: 'FILE_CHANGED' });
  fs.renameSync(f.root, path.join(f.parent, 'old-root')); fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'task.md'), 'before');
  await assert.rejects(inspect(f, 'task.md'), { code: 'ROOT_CHANGED' });
  assert.deepEqual(fs.readdirSync(f.journal.root), []);
});

native('Private journal binding rejects replaced blobs, changed targets and nested journal roots', { timeout: 60000 }, async t => {
  const f = await fixture(t); await writer.create(f.root, 'task.md', 'before', f.rootFingerprint);
  const before = await inspect(f, 'task.md'), transaction = record(f.journal);
  const write = await writer.overwrite(f.root, 'task.md', 'after', before, transaction);
  const afterFile = path.join(f.journal.root, write.recordId, 'after.bin'); fs.renameSync(afterFile, afterFile + '.old'); fs.writeFileSync(afterFile, 'after');
  await assert.rejects(writer.overwrite(f.root, 'task.md', 'after', before, transaction), { code: 'JOURNAL_FILE_CHANGED' });
  fs.writeFileSync(path.join(f.root, 'task.md'), 'external');
  await assert.rejects(writer.recover(f.root, 'task.md', await inspect(f, 'task.md'), transaction), { code: 'RECORD_COMPLETE' });
  const nested = await writer.identity(path.join(f.root, 'journal'), { create: true, parentRoot: f.root, parentFingerprint: f.rootFingerprint });
  await assert.rejects(writer.overwrite(f.root, 'task.md', 'after', await inspect(f, 'task.md'), { root: path.join(f.root, 'journal'), rootFingerprint: nested.rootFingerprint }), { code: 'JOURNAL_OVERLAP_REJECTED' });
});

native('Limits reject full-file overflow and malformed text; Unicode escaping is kept exact', { timeout: 60000 }, async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.root, 'broken.txt'), Buffer.from([0xc0, 0xaf]));
  await assert.rejects(inspect(f, 'broken.txt'), { code: 'ENCODING_REJECTED' });
  fs.writeFileSync(path.join(f.root, 'binary.txt'), Buffer.from([0])); await assert.rejects(inspect(f, 'binary.txt'), { code: 'BINARY_REJECTED' });
  await writer.create(f.root, 'large.txt', 'a'.repeat(writer.LIMITS.task), f.rootFingerprint, { kind: 'task' });
  await assert.rejects(writer.inspect(f.root, 'large.txt', { maxBytes: writer.LIMITS.task - 1, rootFingerprint: f.rootFingerprint }), { code: 'FILE_SIZE_REJECTED' });
  const text = '\u0001'.repeat(writer.LIMITS.row); const created = await writer.create(f.root, 'escaped-row.jsonl', text, f.rootFingerprint, { kind: 'row' });
  assert.equal(created.sha256, hash(text)); assert.equal((await inspect(f, 'escaped-row.jsonl')).text, text);
  fs.writeFileSync(path.join(f.root, 'large-log.jsonl'), Buffer.alloc(writer.LIMITS.log, 0x61));
  const log = await writer.inspect(f.root, 'large-log.jsonl', { maxBytes: writer.LIMITS.log, rootFingerprint: f.rootFingerprint });
  await assert.rejects(writer.append(f.root, 'large-log.jsonl', 'x', log, record(f.journal)), { code: 'FILE_SIZE_REJECTED' });
  assert.equal(fs.statSync(path.join(f.root, 'large-log.jsonl')).size, writer.LIMITS.log);
});

native('Native worker lifecycle strips sensitive environment keys', { timeout: 60000 }, async t => {
  const f = await fixture(t), managed = require('../lib/managed-process'), original = managed.spawn;
  const old = process.env.HUB_LOCAL_TOKEN; process.env.HUB_LOCAL_TOKEN = 'synthetic-token'; let seen = false;
  managed.spawn = (file, args, options) => { if (path.basename(file).startsWith('web-handoff-writer-')) { seen = true; assert.equal(Object.keys(options.env).some(k => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL|COOKIE/i.test(k)), false); assert.equal(options.windowsHide, true); } return original(file, args, options); };
  t.after(() => { managed.spawn = original; if (old === undefined) delete process.env.HUB_LOCAL_TOKEN; else process.env.HUB_LOCAL_TOKEN = old; });
  await inspect(f, 'missing.txt'); assert.equal(seen, true);
});

native('Capacity is a read-only pinned-root snapshot and rejects replaced roots', { timeout: 60000 }, async t => {
  const f = await fixture(t), capacity = await writer.capacity(f.root, { rootFingerprint: f.rootFingerprint });
  assert.equal(capacity.rootFingerprint, f.rootFingerprint); assert.equal(Number.isSafeInteger(capacity.freeBytes), true); assert.ok(capacity.freeBytes >= 0); assert.deepEqual(fs.readdirSync(f.root), []);
  fs.renameSync(f.root, path.join(f.parent, 'old-root')); fs.mkdirSync(f.root);
  await assert.rejects(writer.capacity(f.root, { rootFingerprint: f.rootFingerprint }), { code: 'ROOT_CHANGED' });
});

native('Installer read-only web identities agree with the held NTFS writer identities', { timeout: 60000 }, async t => {
  const f = await fixture(t), installer = require('../windows/native-install.cjs');
  const rootIdentity = installer.native({ mode: 'identity', root: f.root });
  assert.equal(rootIdentity.webRootFingerprint, f.rootFingerprint);
  const relative = 'nested/臺灣 text.txt', text = '合成內容\r\n';
  await writer.create(f.root, relative, text, f.rootFingerprint);
  const before = await inspect(f, relative), installedRead = installer.native({ mode: 'inspect', root: f.root, path: relative });
  assert.equal(installedRead.webRootFingerprint, before.rootFingerprint); assert.equal(installedRead.webFileFingerprint, before.fileFingerprint); assert.equal(installedRead.sha256, before.sha256);
  const target = path.join(f.root, relative); fs.renameSync(target, target + '.old'); fs.writeFileSync(target, text);
  const changed = await inspect(f, relative), changedRead = installer.native({ mode: 'inspect', root: f.root, path: relative });
  assert.equal(changedRead.webFileFingerprint, changed.fileFingerprint); assert.notEqual(changed.fileFingerprint, before.fileFingerprint); assert.equal(changed.sha256, before.sha256);
  await assert.rejects(writer.overwrite(f.root, relative, 'replacement', before, record(f.journal)), { code: 'FILE_CHANGED' });
  assert.equal(fs.readFileSync(target, 'utf8'), text);
});

native('Owned interruption after WriteFile yields partial status and exact identity recovery', { timeout: 60000 }, async t => {
  const f = await fixture(t), managed = require('../lib/managed-process'), original = managed.spawn;
  const source = fs.readFileSync(path.join(__dirname, '../windows/web-handoff-writer.cs'), 'utf8');
  const needle = 'written==bytes.Length&&SetEndOfFile(file)&&FlushFileBuffers(file)'; assert.equal(source.split(needle).length, 2);
  const paused = source.replace(needle, 'written==bytes.Length&&FixturePause(file)&&SetEndOfFile(file)&&FlushFileBuffers(file)').replace('static void Write(IntPtr file,byte[] bytes)', 'static bool FixturePause(IntPtr file){if(FinalName(file).EndsWith("\\\\task.md")){Console.Error.WriteLine("HUB_WEB_FIXTURE_AFTER_WRITE");Console.Error.Flush();System.Threading.Thread.Sleep(10000);}return true;}\n  static void Write(IntPtr file,byte[] bytes)');
  const cs = path.join(f.parent, 'interrupted.cs'), exe = path.join(f.parent, 'interrupted.exe'); fs.writeFileSync(cs, paused);
  execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + exe, cs], { windowsHide: true, timeout: 30000 });
  // Only the fixture target has this pause. Production has no test env switch.
  await writer.create(f.root, 'task.md', 'a'.repeat(10000), f.rootFingerprint); const before = await inspect(f, 'task.md'), transaction = record(f.journal); let interrupted = 0;
  managed.spawn = (file, ...args) => { const child = original(path.basename(file).startsWith('web-handoff-writer-') ? exe : file, ...args); child.stderr.on('data', bytes => { if (bytes.toString().includes('HUB_WEB_FIXTURE_AFTER_WRITE')) { interrupted++; child.kill(); } }); return child; };
  t.after(() => { managed.spawn = original; });
  await assert.rejects(writer.overwrite(f.root, 'task.md', 'b'.repeat(5000), before, transaction), error => error.partial === true && error.code === 'BROKER_INTERRUPTED');
  managed.spawn = original; assert.equal(interrupted, 1);
  const partial = await inspect(f, 'task.md'); assert.notEqual(partial.sha256, before.sha256); assert.notEqual(partial.sha256, hash('b'.repeat(5000)));
  await assert.rejects(writer.overwrite(f.root, 'task.md', 'b'.repeat(5000), before, transaction), error => error.partial === true && error.code === 'RECOVERY_REQUIRED');
  const recovered = await writer.recover(f.root, 'task.md', partial, transaction); assert.equal(recovered.recovered, true); assert.equal(recovered.fileFingerprint, before.fileFingerprint); assert.equal((await inspect(f, 'task.md')).text, 'b'.repeat(5000));
  await assert.rejects(writer.recover(f.root, 'task.md', await inspect(f, 'task.md'), transaction), { code: 'RECORD_COMPLETE' });
  t.diagnostic('Fixture kill between target WriteFile and truncate/flush; explicit current full hash approved for roll-forward. Not a real host crash.');
});

native('Durable native stages survive owned interruption without duplicate writes or invented completion', { timeout: 120000 }, async t => {
  const f = await fixture(t), managed = require('../lib/managed-process'), original = managed.spawn;
  const source = fs.readFileSync(path.join(__dirname, '../windows/web-handoff-writer.cs'), 'utf8');
  t.after(() => { managed.spawn = original; });
  const pause = 'Console.Error.WriteLine("HUB_WEB_STAGE_PAUSE");Console.Error.Flush();System.Threading.Thread.Sleep(10000);';
  const prepared = 'JournalCreate(journal,id,"intent.json",Serialize(intent));prepared=true;';
  const flushed = 'Require(Hash(Bytes(file,mode=="append"?LOG:TASK))==afterHash,"WRITE_VERIFY_FAILED");';
  const completed = 'return MutationResult(mode,id,expected,afterHash,fileId,after.Length,false);';
  for (const [name, needle, replace, hasComplete] of [
    ['prepared', prepared, prepared + pause, false],
    ['flushed', flushed, flushed + pause, false],
    ['complete', completed, pause + completed, true]
  ]) {
    assert.equal(source.split(needle).length, 2);
    const cs = path.join(f.parent, name + '.cs'), exe = path.join(f.parent, name + '.exe'); fs.writeFileSync(cs, source.replace(needle, replace));
    execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + exe, cs], { windowsHide: true, timeout: 30000 });
    const file = name + '.md'; await writer.create(f.root, file, 'before', f.rootFingerprint); const before = await inspect(f, file), transaction = record(f.journal); let killed = 0;
    managed.spawn = (binary, ...args) => { const child = original(path.basename(binary).startsWith('web-handoff-writer-') ? exe : binary, ...args); child.stderr.on('data', bytes => { if (bytes.toString().includes('HUB_WEB_STAGE_PAUSE')) { killed++; child.kill(); } }); return child; };
    await assert.rejects(writer.overwrite(f.root, file, 'after', before, transaction), error => error.partial === true && error.code === 'BROKER_INTERRUPTED');
    managed.spawn = original; assert.equal(killed, 1); assert.equal(fs.existsSync(path.join(f.journal.root, transaction.recordId, 'complete.json')), hasComplete);
    assert.equal((await inspect(f, file)).text, name === 'prepared' ? 'before' : 'after');
    const retried = await writer.overwrite(f.root, file, 'after', before, transaction); assert.equal(retried.alreadyApplied, hasComplete); assert.equal(retried.fileFingerprint, before.fileFingerprint); assert.equal((await inspect(f, file)).text, 'after');
  }
  // A missing target created before its new FileID receipt cannot be silently
  // adopted by retry, even if bytes match. The owner must review this window.
  const needle = 'JournalCreate(journal,id,"created.json",Serialize(new Dictionary<string,object>';
  assert.equal(source.split(needle).length, 2);
  const cs = path.join(f.parent, 'created-window.cs'), exe = path.join(f.parent, 'created-window.exe'); fs.writeFileSync(cs, source.replace(needle, pause + needle));
  execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + exe, cs], { windowsHide: true, timeout: 30000 });
  const before = await inspect(f, 'new-log.jsonl'), transaction = record(f.journal); let killed = 0;
  managed.spawn = (binary, ...args) => { const child = original(path.basename(binary).startsWith('web-handoff-writer-') ? exe : binary, ...args); child.stderr.on('data', bytes => { if (bytes.toString().includes('HUB_WEB_STAGE_PAUSE')) { killed++; child.kill(); } }); return child; };
  await assert.rejects(writer.append(f.root, 'new-log.jsonl', '{"once":true}\n', before, transaction), error => error.partial === true && error.code === 'BROKER_INTERRUPTED');
  managed.spawn = original; assert.equal(killed, 1);
  await assert.rejects(writer.append(f.root, 'new-log.jsonl', '{"once":true}\n', before, transaction), error => error.partial === true && error.code === 'UNBOUND_CREATED_TARGET');
  assert.equal((await inspect(f, 'new-log.jsonl')).text, '{"once":true}\n'); assert.equal(fs.existsSync(path.join(f.journal.root, transaction.recordId, 'complete.json')), false);
  t.diagnostic('Synthetic native copies interrupted after durable intent, target flush, completion receipt and create/identity window. No real power-failure durability claim.');
});

native('Injected native write and flush failures never create successful target receipts', { timeout: 90000 }, async t => {
  const f = await fixture(t), managed = require('../lib/managed-process'), original = managed.spawn;
  const source = fs.readFileSync(path.join(__dirname, '../windows/web-handoff-writer.cs'), 'utf8');
  t.after(() => { managed.spawn = original; });
  for (const operation of ['write', 'flush']) {
    const name = operation + '-fail.md'; await writer.create(f.root, name, 'before', f.rootFingerprint); const before = await inspect(f, name), transaction = record(f.journal);
    let changed;
    if (operation === 'write') {
      const needle = 'WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)'; assert.equal(source.split(needle).length, 2);
      changed = source.replace(needle, 'FixtureWrite(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)').replace('static void Write(IntPtr file,byte[] bytes)', 'static bool FixtureWrite(IntPtr file,byte[] bytes,uint length,out uint written,IntPtr overlap){if(FinalName(file).EndsWith("\\\\write-fail.md")){written=0;return false;}return WriteFile(file,bytes,length,out written,overlap);}\n  static void Write(IntPtr file,byte[] bytes)');
    } else {
      changed = source.replaceAll('FlushFileBuffers(file)', 'FixtureFlush(file)').replace('static void Write(IntPtr file,byte[] bytes)', 'static bool FixtureFlush(IntPtr file){if(FinalName(file).EndsWith("\\\\flush-fail.md"))return false;return FlushFileBuffers(file);}\n  static void Write(IntPtr file,byte[] bytes)');
    }
    const cs = path.join(f.parent, operation + '-fail.cs'), exe = path.join(f.parent, operation + '-fail.exe'); fs.writeFileSync(cs, changed);
    execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', '/out:' + exe, cs], { windowsHide: true, timeout: 30000 });
    managed.spawn = (binary, ...args) => original(path.basename(binary).startsWith('web-handoff-writer-') ? exe : binary, ...args);
    await assert.rejects(writer.overwrite(f.root, name, 'after', before, transaction), error => error.partial === true && error.recordId === transaction.recordId && error.code === 'RECOVERY_REQUIRED');
    managed.spawn = original; assert.equal(fs.existsSync(path.join(f.journal.root, transaction.recordId, 'complete.json')), false);
    assert.equal((await inspect(f, name)).text, operation === 'write' ? 'before' : 'after');
    // Both before-state and after-bytes retry must reflush before success.
    const retried = await writer.overwrite(f.root, name, 'after', before, transaction); assert.equal(retried.flushed, true); assert.equal((await inspect(f, name)).text, 'after');
  }
  t.diagnostic('Failure-return injection in independently compiled native fixture copies; no production test hooks and no actual disk-full claim.');
});
