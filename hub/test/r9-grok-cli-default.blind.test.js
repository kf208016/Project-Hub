'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { start } = require('../lib/grok-native-bridge');
const { NativeProviderService } = require('../lib/native-provider-service');
const artifacts = require('../lib/native-cli-update');
const safe = require('../lib/safe-path');
const host = require('../lib/provider-native-host');
const egress = require('../lib/provider-egress');
const scoped = require('../lib/scoped-file');

const sid = 'synthetic-native-session';
const options = {
  project: 'p',
  task: 't',
  runId: 'r',
  cwd: 'C:\\synthetic',
  model: 'grok-4.5',
  effort: 'low',
  sessionId: null,
  resume: false,
  validatedMcpServers: [],
};
const immediate = () => new Promise(resolve => setImmediate(resolve));

function bridge(t, extra = {}) {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    backendId: 'fixture-backend',
  });
  let ended = false;
  let wire = '';
  let args;
  child.kill = () => true;
  child.stdin.on('data', chunk => { wire += chunk; });
  const proc = start({
    ...options,
    ...extra,
    openEndpoint: given => {
      args = given;
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  proc.stdout.on('data', () => {});
  proc.stderr.resume();
  const closed = once(proc, 'close');
  function finish(code = 0, receipt = { rootExited: true, ownedTreeEmpty: true, cleanupVerified: true, exitCode: code }) {
    if (ended) return;
    ended = true;
    child.cleanupReceipt = receipt;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
  }
  t.after(async () => {
    proc.kill();
    finish(1, null);
    await closed;
  });
  const rows = () => wire.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const push = frame => child.stdout.write(Buffer.from(JSON.stringify(frame) + '\n'));
  const response = (req, result) => push({ jsonrpc: '2.0', id: req.id, result });
  async function openSession(currentModelId, availableModels) {
    proc.stdin.end('synthetic prompt');
    await immediate();
    await immediate();
    const first = rows()[0];
    assert.equal(first.method, 'initialize');
    response(first, { protocolVersion: 1, agentCapabilities: { loadSession: true }, extra: 'inert' });
    await immediate();
    const open = rows().at(-1);
    assert.equal(open.method, 'session/new');
    response(open, { sessionId: sid, models: { currentModelId, availableModels } });
    await immediate();
    return open;
  }
  return { proc, rows, finish, closed, openSession, args: () => args };
}

test('an empty Grok model omits --model, keeps --effort, accepts grok-4.7, and never calls set_model', async t => {
  const f = bridge(t, { model: '' });
  await new Promise(resolve => setImmediate(resolve)); // the bridge opens its endpoint in a deferred microtask
  const args = f.args();
  assert.equal(args.includes('--model'), false);
  const effortAt = args.indexOf('--effort');
  assert.ok(effortAt >= 0);
  assert.equal(args[effortAt + 1], 'low');
  await f.openSession('grok-4.7', []);
  assert.equal(f.rows().some(row => row.method === 'session/set_model'), false);
  assert.equal(f.proc.reportedModel, 'grok-4.7');
  assert.equal(await f.proc.ready, true);
});

test('an explicit grok-4.5 still sends session/set_model when the session is on grok-4.7', async t => {
  const f = bridge(t, { model: 'grok-4.5' });
  await f.openSession('grok-4.7', [{ modelId: 'grok-4.5' }, { modelId: 'grok-4.7' }]);
  const select = f.rows().at(-1);
  assert.equal(select.method, 'session/set_model');
  assert.equal(select.params.modelId, 'grok-4.5');
});

const scope = { actor: 'grok', project: 'synthetic', task: 't', model: 'Grok 4.6', effort: '中' };
const binding = {
  project: scope.project,
  task: scope.task,
  dir: 'C:\\Synthetic\\workspace',
  rootFingerprint: 'a'.repeat(64),
  run: 'workspace-run',
};

function serviceFixture(t, callbacks = {}) {
  let network = 0;
  let closed = 0;
  let disposed = 0;
  let reads = 0;
  let spawned = 0;
  const settings = {
    ownerHome: 'C:\\Users\\fixture',
    runtimeBase: 'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\grok.exe',
    codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: artifacts.KNOWN,
    nodeFile: process.execPath,
    gitDirectory: 'C:\\Tools\\git',
    hubLibDirectory: 'C:\\Tools\\hub\\lib',
    systemRoot: 'C:\\Windows',
  };
  t.mock.method(scoped, 'identity', async file => {
    assert.equal(file, settings.runtimeBase);
    assert.ok(file.startsWith('C:\\Users\\fixture\\AppData\\Local\\'));
    return { rootFingerprint: 'b'.repeat(64) };
  });
  t.mock.method(artifacts, 'digestFile', file => file.endsWith('codex.exe') ? artifacts.KNOWN : host.PROVIDER_HASHES.grok);
  t.mock.method(safe, 'localPath', file => file);
  t.mock.method(fs, 'lstatSync', (_file, opts) => ({
    isFile: () => true,
    nlink: opts?.bigint ? 1n : 1,
    size: opts?.bigint ? 123n : 123,
    ino: 1n,
    dev: 1n,
    mtimeNs: 10n,
  }));
  t.mock.method(fs, 'readFileSync', () => {
    reads += 1;
    throw new Error('CREDENTIAL_CONTENT_READ_FORBIDDEN');
  });
  t.mock.method(egress, 'create', async () => {
    network += 1;
    return { proxyUrl: 'http://hub:' + 'f'.repeat(64) + '@127.0.0.1:12345', snapshot: () => ({}), close: async () => { closed += 1; } };
  });
  const service = new NativeProviderService({
    resolveWorkspace: async () => binding,
    profile: () => ({ ...settings }),
    modelFlag: (_actor, model) => model === 'Grok 4.6' ? 'grok-4.6' : '',
    effortFlag: () => 'medium',
    supervisedSpawn: () => {
      spawned += 1;
      throw new Error('NO_CHILD_EXPECTED');
    },
    dispose: async () => { disposed += 1; },
    ...callbacks,
  });
  return { service, settings, spawned: () => spawned, counts: () => ({ network, closed, disposed, reads }) };
}

test('grok CLI default is previewed with an empty model flag and an unknown label is refused', async t => {
  const request = { ...scope, actor: 'grok', model: 'CLI預設' };
  const f = serviceFixture(t, {
    modelFlag: (_actor, model) => (model === 'CLI預設' || model === 'Bogus 9') ? '' : 'grok-4.6',
  });
  const preview = await f.service.preview(request);
  assert.equal(preview.review.modelFlag, '');
  assert.equal(f.spawned(), 0);
  await assert.rejects(
    () => f.service.preview({ ...request, model: 'Bogus 9' }),
    { code: 'NATIVE_PROFILE_UNAVAILABLE' },
  );
});
