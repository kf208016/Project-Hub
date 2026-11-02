'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { start } = require('../lib/claude-native-bridge');
const { NativeProviderService } = require('../lib/native-provider-service');
const artifacts = require('../lib/native-cli-update');
const safe = require('../lib/safe-path');
const host = require('../lib/provider-native-host');
const egress = require('../lib/provider-egress');
const scoped = require('../lib/scoped-file');

const sid = '12345678-1234-4234-8234-123456789abc';
const options = {
  model: 'sonnet',
  effort: 'low',
  sessionId: sid,
  resume: false,
  project: 'p',
  task: 't',
  runId: 'run-1',
  cwd: 'C:\\synthetic',
  validatedMcpConfig: { mcpServers: {} },
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
  async function handshake(reported) {
    proc.stdin.end('Synthetic task');
    await immediate();
    await immediate();
    const request = rows()[0];
    assert.equal(request.type, 'control_request');
    assert.equal(request.request.subtype, 'initialize');
    push({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response: { commands: [], models: [] } },
    });
    if (reported !== undefined) {
      push({
        type: 'system',
        subtype: 'init',
        session_id: sid,
        model: reported,
        tools: ['Read'],
        extraMetadata: { preserve: 'inert' },
      });
      await immediate();
    }
    return request;
  }
  return { proc, push, handshake, finish, closed, args: () => args };
}

test('an empty Claude model omits --model, keeps --effort, and accepts claude-sonnet-5-5', async t => {
  const f = bridge(t, { model: '' });
  await f.handshake('claude-sonnet-5-5');
  const args = f.args();
  assert.equal(args.includes('--model'), false);
  const effortAt = args.indexOf('--effort');
  assert.ok(effortAt >= 0);
  assert.equal(args[effortAt + 1], 'low');
  assert.equal(await f.proc.ready, true);
});

test('an explicit Opus model still passes --model and refuses a Sonnet init', async t => {
  const f = bridge(t, { model: 'claude-opus-5-5' });
  await f.handshake('claude-sonnet-5-5');
  const args = f.args();
  const modelAt = args.indexOf('--model');
  assert.equal(args[modelAt + 1], 'claude-opus-5-5');
  f.finish();
  await f.closed;
  assert.equal((await f.proc.completion).errorCode, 'CLAUDE_NATIVE_MODEL_MISMATCH');
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

test('claude CLI default is previewed with an empty model flag and an unknown label is refused', async t => {
  const request = { ...scope, actor: 'claude', model: 'CLI預設' };
  const f = serviceFixture(t, {
    modelFlag: (_actor, model) => (model === 'CLI預設' || model === 'Bogus 9') ? '' : 'sonnet',
  });
  f.settings.providerFile = 'C:\\Tools\\provider\\claude.exe';
  t.mock.method(artifacts, 'digestFile', file => file.endsWith('codex.exe') ? artifacts.KNOWN : host.PROVIDER_HASHES.claude);
  const preview = await f.service.preview(request);
  assert.equal(preview.review.modelFlag, '');
  assert.equal(f.spawned(), 0);
  await assert.rejects(
    () => f.service.preview({ ...request, model: 'Bogus 9' }),
    { code: 'NATIVE_PROFILE_UNAVAILABLE' },
  );
});
