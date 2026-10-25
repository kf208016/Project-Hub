'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { start: startClaude } = require('../lib/claude-native-bridge');
const { start: startGrok } = require('../lib/grok-native-bridge');
const { createPlan } = require('../lib/provider-native-plan');
const egress = require('../lib/provider-egress');
const { messageFor } = require('../lib/native-provider-messages');
const { codeOf } = require('../lib/native-provider-diagnostic');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const immediate = () => new Promise(resolve => setImmediate(resolve));

const claudeSid = '12345678-1234-4234-8234-123456789abc';
const claudeOptions = {
  model: 'sonnet',
  effort: 'low',
  sessionId: claudeSid,
  resume: false,
  project: 'p',
  task: 't',
  runId: 'run-1',
  cwd: 'C:\\synthetic',
  validatedMcpConfig: { mcpServers: {} }
};

const grokSid = 'synthetic-native-session';
const grokOptions = {
  project: 'p',
  task: 't',
  runId: 'r',
  cwd: 'C:\\synthetic',
  model: 'grok-selected',
  effort: 'low',
  sessionId: null,
  resume: false,
  validatedMcpServers: []
};

function claudeFixture(t, extra = {}) {
  const c = new EventEmitter();
  Object.assign(c, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    backendId: 'fixture-backend'
  });
  let killed = 0, ended = false, wire = '';
  c.kill = () => { killed += 1; return true; };
  c.stdin.on('data', d => { wire += d; });
  const p = startClaude({
    ...claudeOptions,
    ...extra,
    openEndpoint: () => {
      setImmediate(() => c.emit('spawn'));
      return c;
    }
  });
  let output = '';
  p.stdout.on('data', d => { output += d; });
  p.stderr.resume();
  const closed = once(p, 'close');
  function finish(code = 0, receipt = { rootExited: true, ownedTreeEmpty: true, cleanupVerified: true, exitCode: code }) {
    if (ended) return;
    ended = true;
    c.cleanupReceipt = receipt;
    c.stdout.end();
    c.stderr.end();
    c.emit('close', code, null);
  }
  t.after(async () => {
    p.kill();
    finish(1, null);
    await closed;
  });
  const rows = () => wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push = frame => c.stdout.write(Buffer.from(JSON.stringify(frame) + '\n'));
  async function init({ sendInit = true } = {}) {
    p.stdin.end('Synthetic task');
    await immediate();
    await immediate();
    const r = rows()[0];
    assert.equal(r.type, 'control_request');
    assert.equal(r.request.subtype, 'initialize');
    push({
      type: 'control_response',
      response: { subtype: 'success', request_id: r.request_id, response: { commands: [], models: [] } }
    });
    if (sendInit) {
      push({
        type: 'system',
        subtype: 'init',
        session_id: claudeSid,
        model: 'claude-sonnet-5',
        tools: ['Read'],
        extraMetadata: { preserve: 'inert' }
      });
    }
    await immediate();
    return r;
  }
  const result = (extraResult = {}) => push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: claudeSid,
    result: 'fixture reply',
    permission_denials: [],
    ...extraResult
  });
  return { p, push, init, result, finish, closed, kills: () => killed };
}

function grokFixture(t, extra = {}) {
  const c = new EventEmitter();
  Object.assign(c, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    backendId: 'fixture-backend'
  });
  let wire = '', ended = false, kills = 0;
  c.kill = () => { kills += 1; return true; };
  c.stdin.on('data', d => { wire += d; });
  const p = startGrok({
    ...grokOptions,
    ...extra,
    openEndpoint: () => {
      setImmediate(() => c.emit('spawn'));
      return c;
    }
  });
  p.stdout.resume();
  p.stderr.resume();
  const closed = once(p, 'close');
  const rows = () => wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push = value => c.stdout.write(Buffer.from(JSON.stringify(value) + '\n'));
  const response = (req, resultValue) => push({ jsonrpc: '2.0', id: req.id, result: resultValue });
  function finish(code = 0, receipt = { rootExited: true, ownedTreeEmpty: true, cleanupVerified: true, exitCode: code }) {
    if (ended) return;
    ended = true;
    c.cleanupReceipt = receipt;
    c.stdout.end();
    c.stderr.end();
    c.emit('close', code, null);
  }
  t.after(async () => {
    p.kill();
    finish(1, null);
    await closed;
  });
  async function init({ load = true, model = grokOptions.model, availableModels = [] } = {}) {
    p.stdin.end('synthetic prompt');
    await immediate();
    await immediate();
    const first = rows()[0];
    assert.equal(first.method, 'initialize');
    response(first, { protocolVersion: 1, agentCapabilities: { loadSession: load }, extra: 'inert' });
    await immediate();
    const open = rows().at(-1);
    assert.equal(open.method, extra.resume ? 'session/load' : 'session/new');
    response(open, { ...(extra.resume ? {} : { sessionId: grokSid }), models: { currentModelId: model, availableModels } });
    await immediate();
    return open;
  }
  const update = u => push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: grokSid, update: u } });
  const result = stopReason => response(rows().findLast(r => r.method === 'session/prompt'), { stopReason: stopReason || 'end_turn' });
  return { p, push, init, update, result, finish, closed, kills: () => kills };
}

function planOptions(overrides) {
  const opts = {
    actor: 'claude',
    cwd: 'C:\\Workspaces\\project',
    rootFingerprint: 'a'.repeat(64),
    ownerHome: 'C:\\Users\\example-user',
    runtimeBase: 'C:\\Users\\example-user\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\provider.exe',
    codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: 'b'.repeat(64),
    nodeFile: 'C:\\Tools\\node\\node.exe',
    gitDirectory: 'C:\\Tools\\git',
    hubLibDirectory: 'C:\\Tools\\hublib',
    providerArgs: ['--flag', 'value'],
    proxyUrl: 'http://hub:' + 'c'.repeat(64) + '@127.0.0.1:8080',
    systemRoot: 'C:\\Windows'
  };
  return Object.assign(opts, overrides || {});
}

test('native-turn-limits exports frozen MAX_WALL_MS 1800000 and IDLE_MS 600000', () => {
  const limits = require('../lib/native-turn-limits');
  assert.equal(limits.MAX_WALL_MS, 1800000);
  assert.equal(limits.IDLE_MS, 600000);
  assert.equal(Object.isFrozen(limits), true);
  assert.throws(() => { limits.MAX_WALL_MS = 1; });
  assert.equal(limits.MAX_WALL_MS, 1800000);
});

test('Claude bridge accepts maxWallMs 1800000 and rejects 1800001 as options error', async t => {
  assert.throws(
    () => startClaude({
      ...claudeOptions,
      maxWallMs: 1800001,
      openEndpoint() { throw new Error('must not open'); }
    }),
    { code: 'CLAUDE_NATIVE_OPTIONS' }
  );
  const f = claudeFixture(t, { maxWallMs: 1800000 });
  await f.init();
  f.result();
  f.finish();
  await f.closed;
  assert.equal((await f.p.completion).responseComplete, true);
});

test('Grok bridge accepts maxWallMs 1800000 and rejects 1800001 as options error', async t => {
  assert.throws(
    () => startGrok({
      ...grokOptions,
      maxWallMs: 1800001,
      openEndpoint() { throw new Error('must not open'); }
    }),
    { code: 'GROK_NATIVE_OPTIONS' }
  );
  const f = grokFixture(t, { maxWallMs: 1800000 });
  await f.init();
  f.result();
  f.finish();
  await f.closed;
  assert.equal((await f.p.completion).responseComplete, true);
});

test('Claude bridge idleTimeoutMs 80 with no frames after init fails CLAUDE_NATIVE_IDLE_TIMEOUT', async t => {
  const f = claudeFixture(t, { maxWallMs: 240000, idleTimeoutMs: 80 });
  await f.init();
  await delay(200);
  assert.ok(f.kills() > 0);
  f.finish();
  await f.closed;
  assert.equal((await f.p.completion).errorCode, 'CLAUDE_NATIVE_IDLE_TIMEOUT');
});

test('Claude bridge idleTimeoutMs 80 does not fire while frames arrive every 20ms', async t => {
  const f = claudeFixture(t, { maxWallMs: 240000, idleTimeoutMs: 80 });
  await f.init();
  for (let i = 0; i < 10; i += 1) {
    f.push({
      type: 'system',
      subtype: 'thinking_tokens',
      session_id: claudeSid,
      estimated_tokens: i
    });
    await delay(20);
    assert.equal(f.kills(), 0, 'idle must not fire while provider frames keep arriving');
  }
  await delay(200);
  assert.ok(f.kills() > 0);
  f.finish();
  await f.closed;
  assert.equal((await f.p.completion).errorCode, 'CLAUDE_NATIVE_IDLE_TIMEOUT');
});

test('Grok bridge idleTimeoutMs 80 with no frames after init fails GROK_NATIVE_IDLE_TIMEOUT', async t => {
  const f = grokFixture(t, { maxWallMs: 240000, idleTimeoutMs: 80 });
  await f.init();
  await delay(200);
  assert.ok(f.kills() > 0);
  f.finish();
  await f.closed;
  assert.equal((await f.p.completion).errorCode, 'GROK_NATIVE_IDLE_TIMEOUT');
});

test('Grok bridge idleTimeoutMs 80 does not fire while frames arrive every 20ms', async t => {
  const f = grokFixture(t, { maxWallMs: 240000, idleTimeoutMs: 80 });
  await f.init();
  for (let i = 0; i < 10; i += 1) {
    f.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
    await delay(20);
    assert.equal(f.kills(), 0, 'idle must not fire while provider frames keep arriving');
  }
  await delay(200);
  assert.ok(f.kills() > 0);
  f.finish();
  await f.closed;
  assert.equal((await f.p.completion).errorCode, 'GROK_NATIVE_IDLE_TIMEOUT');
});

test('createPlan accepts maxWallMs 1800000 and rejects 1800001', () => {
  const plan = createPlan(planOptions({ maxWallMs: 1800000 }));
  assert.equal(plan.maxWallMs, 1800000);
  assert.throws(() => createPlan(planOptions({ maxWallMs: 1800001 })), { code: 'NATIVE_PLAN_INVALID' });
});

test('provider-egress create accepts maxWallMs 1800000', async () => {
  const h = await egress.create({ provider: 'claude', maxWallMs: 1800000 });
  try {
    assert.ok(h.proxyUrl);
  } finally {
    await h.close();
  }
});

test('wall and idle messages and codeOf admit the native timeout codes', () => {
  const grokWall = messageFor('GROK_NATIVE_WALL_TIMEOUT');
  assert.equal(typeof grokWall, 'string');
  assert.ok(grokWall.includes('30 分鐘'));
  assert.equal(grokWall.includes('4 分鐘'), false);
  const claudeIdle = messageFor('CLAUDE_NATIVE_IDLE_TIMEOUT');
  assert.equal(typeof claudeIdle, 'string');
  assert.ok(claudeIdle.includes('10 分鐘'));
  assert.equal(codeOf({ code: 'CLAUDE_NATIVE_IDLE_TIMEOUT' }), 'CLAUDE_NATIVE_IDLE_TIMEOUT');
  assert.equal(codeOf({ code: 'GROK_NATIVE_IDLE_TIMEOUT' }), 'GROK_NATIVE_IDLE_TIMEOUT');
});
