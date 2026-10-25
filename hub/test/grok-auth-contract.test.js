'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter, once} = require('node:events');
const {PassThrough} = require('node:stream');
const {start, buildArgs} = require('../lib/grok-native-bridge');

const sid = 'synthetic-native-session';
const immediate = () => new Promise(resolve => setImmediate(resolve));
const options = {
  project: 'p', task: 't', runId: 'r', cwd: 'C:\\synthetic', model: 'grok-selected',
  effort: 'low', sessionId: null, resume: false, validatedMcpServers: [],
};
const SECRET = 'REMOTE-TEXT-MUST-NOT-LEAK';
const WIRE = '_x.ai/session_notification';
const JOURNAL = '_x.ai/session/update';
const LEGACY_401 = `Re-authenticating after 401 (request carried no credential) ${SECRET}`;
const SPEC_401 = `Re-authenticating after 401 ${SECRET}`;

function fixture(t, extra = {}) {
  const c = new EventEmitter();
  Object.assign(c, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), backendId: 'fixture-backend'});
  let wire = '', output = '', ended = false, kills = 0;
  c.kill = () => { kills++; return true; };
  c.stdin.on('data', d => wire += d);
  const p = start({...options, ...extra, openEndpoint: args => {
    assert.deepEqual(args, buildArgs(options));
    setImmediate(() => c.emit('spawn'));
    return c;
  }});
  p.stdout.on('data', d => output += d);
  p.stderr.resume();
  const closed = once(p, 'close');
  const rows = () => wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push = v => c.stdout.write(Buffer.from(JSON.stringify(v) + '\n'));
  const response = (req, result) => push({jsonrpc: '2.0', id: req.id, result});
  function finish(code = 0, receipt = {rootExited: true, ownedTreeEmpty: true, cleanupVerified: true, exitCode: code}) {
    if (ended) return;
    ended = true;
    c.cleanupReceipt = receipt;
    c.stdout.end();
    c.stderr.end();
    c.emit('close', code, null);
  }
  t.after(async () => { p.kill(); finish(1, null); await closed; });
  async function init({load = true, model = options.model, availableModels = [], beforeOpenResponse} = {}) {
    p.stdin.end('synthetic prompt');
    await immediate();
    await immediate();
    const first = rows()[0];
    assert.equal(first.method, 'initialize');
    assert.deepEqual(first.params.clientCapabilities, {fs: {readTextFile: false, writeTextFile: false}, terminal: false});
    response(first, {protocolVersion: 1, agentCapabilities: {loadSession: load}, extra: 'inert'});
    await immediate();
    const open = rows().at(-1);
    if (extra.resume && !load) return open;
    assert.equal(open.method, extra.resume ? 'session/load' : 'session/new');
    assert.deepEqual(open.params.mcpServers, []);
    beforeOpenResponse?.();
    response(open, {...(!extra.resume ? {sessionId: sid} : {}), models: {currentModelId: model, availableModels}});
    await immediate();
    return open;
  }
  const update = u => push({jsonrpc: '2.0', method: 'session/update', params: {sessionId: sid, update: u}});
  const result = stopReason => response(rows().findLast(r => r.method === 'session/prompt'), {stopReason: stopReason || 'end_turn'});
  return {p, c, closed, rows, push, response, finish, init, update, result, kills: () => kills, events: () => output.trim().split('\n').filter(Boolean).map(JSON.parse)};
}

function retry(method, sessionId, update) {
  return {jsonrpc: '2.0', method, params: {sessionId, update: {sessionUpdate: 'retry_state', ...update}}};
}

function hidden(f, completion) {
  const blob = JSON.stringify(f.events()) + JSON.stringify(completion);
  assert.equal(blob.includes(SECRET), false);
}

async function expectStop(t, frame, code) {
  const f = fixture(t);
  await f.init();
  f.push(frame);
  f.finish();
  await f.closed;
  const completion = await f.p.completion;
  assert.equal(completion.errorCode, code);
  assert.equal(completion.responseComplete, false);
  hidden(f, completion);
}

async function expectInert(t, frame) {
  const f = fixture(t);
  await f.init();
  f.push(frame);
  await immediate();
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'still going'}});
  f.result();
  f.finish();
  await f.closed;
  const completion = await f.p.completion;
  assert.equal(completion.responseComplete, true);
  assert.equal(completion.errorCode, null);
  hidden(f, completion);
}

test('wire _x.ai/session_notification retrying after 401 stops with GROK_NATIVE_AUTH_UNAVAILABLE', {timeout: 20000}, async t => {
  await expectStop(t, retry(WIRE, sid, {
    type: 'retrying', attempt: 1, max_retries: 3, reason: LEGACY_401,
  }), 'GROK_NATIVE_AUTH_UNAVAILABLE');
});

test('journal _x.ai/session/update retrying whose reason starts with Re-authenticating after 401 still stops', {timeout: 20000}, async t => {
  await expectStop(t, retry(JOURNAL, sid, {
    type: 'retrying', attempt: 1, max_retries: 3, reason: SPEC_401,
  }), 'GROK_NATIVE_AUTH_UNAVAILABLE');
});

test('failed error_type auth stops with GROK_NATIVE_AUTH_UNAVAILABLE', {timeout: 20000}, async t => {
  await expectStop(t, retry(WIRE, sid, {
    type: 'failed', error_type: 'auth', message: `${SECRET} credential rejected`,
  }), 'GROK_NATIVE_AUTH_UNAVAILABLE');
});

test('failed legacy_auth stays inert even when the message contains Unauthorized (401)', {timeout: 20000}, async t => {
  await expectInert(t, retry(WIRE, sid, {
    type: 'failed', error_type: 'legacy_auth', message: `legacy Unauthorized (401) ${SECRET}`,
  }));
});

test('failed auth_transient stays inert even when the message contains Unauthorized (401)', {timeout: 20000}, async t => {
  await expectInert(t, retry(WIRE, sid, {
    type: 'failed', error_type: 'auth_transient', message: `transient Unauthorized (401) ${SECRET}`,
  }));
});

test('failed message containing Unauthorized (401) and no error_type stops', {timeout: 20000}, async t => {
  await expectStop(t, retry(WIRE, sid, {
    type: 'failed', message: `session Unauthorized (401) ${SECRET}`,
  }), 'GROK_NATIVE_AUTH_UNAVAILABLE');
});

test('exhausted with is_rate_limited true stops with GROK_NATIVE_RATE_LIMITED', {timeout: 20000}, async t => {
  await expectStop(t, retry(WIRE, sid, {
    type: 'exhausted', attempts: 3, reason: `${SECRET} rate limit`, is_rate_limited: true,
  }), 'GROK_NATIVE_RATE_LIMITED');
});

test('exhausted without a rate limit stops with GROK_NATIVE_RETRY_EXHAUSTED', {timeout: 20000}, async t => {
  await expectStop(t, retry(WIRE, sid, {
    type: 'exhausted', attempts: 3, reason: `${SECRET} retries used up`, is_rate_limited: false,
  }), 'GROK_NATIVE_RETRY_EXHAUSTED');
});

test('retrying for a 5xx stays inert', {timeout: 20000}, async t => {
  await expectInert(t, retry(WIRE, sid, {
    type: 'retrying', attempt: 2, max_retries: 5, reason: `${SECRET} upstream 503`, error_type: 'server',
  }));
});

test('a foreign session id is ignored for both retry methods', {timeout: 20000}, async t => {
  for (const method of [JOURNAL, WIRE]) {
    await expectInert(t, retry(method, 'foreign-session', {
      type: 'retrying', attempt: 1, max_retries: 3, reason: LEGACY_401,
    }));
  }
});
