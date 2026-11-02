'use strict';
// R22 blind acceptance tests, written from SPEC-R22.md only (before reading the implementation).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createGrokLoginWindow } = require('../lib/grok-login-window');
const { createGrokTurnGate } = require('../lib/grok-turn-gate');
const { messageFor } = require('../lib/native-provider-messages');
const diagnostic = require('../lib/native-provider-diagnostic');

const TTL = 21300000, MARGIN = 2100000;
const GROK = 'C:\\Users\\owner\\AppData\\Local\\ProjectHub\\runtime-binaries\\grok\\abc\\grok.exe';
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const settle = () => new Promise(r => setImmediate(r));
const envValue = (env, name) => { const k = Object.keys(env).find(x => x.toUpperCase() === name); return k === undefined ? undefined : env[k]; };

function tempHome(t, ageMs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r22-blind-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.grok'));
  if (ageMs !== null) setAge(home, ageMs);
  return home;
}
function authFile(home) { return path.join(home, '.grok', 'auth.json'); }
function setAge(home, ageMs) {
  const file = authFile(home);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{"dummy":true}');
  // Whole seconds: utimes precision.
  const when = new Date(Math.floor((Date.now() - ageMs) / 1000) * 1000);
  fs.utimesSync(file, when, when);
}

function rig(t, { ageMs = TTL + 60000, env = {}, resolveGrok, turnActive = false } = {}) {
  const home = tempHome(t, ageMs), spawned = [], timers = [], killed = [], records = [];
  const w = createGrokLoginWindow({
    resolveGrok: resolveGrok || (async () => GROK),
    spawn: (file, args, opts) => { const c = new EventEmitter(); c.pid = 7000 + spawned.length; spawned.push({ file, args, opts, child: c }); return c; },
    now: () => Date.now(), record: (...a) => records.push(a), isGrokTurnActive: () => turnActive,
    home, env: { PATH: 'C:\\Windows', USERPROFILE: home, ...env }, comspec: COMSPEC,
    setTimeout: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; },
    clearTimeout: () => {}, kill: pid => killed.push(pid),
  });
  return { w, home, spawned, timers, killed, records };
}
const exit = (c, code) => { c.emit('exit', code, null); c.emit('close', code, null); };

test('R22 W1 autoRefresh spawns grok directly, hidden, with the early-invalidation env', async t => {
  const r = rig(t, { env: { GROK_AUTH_EARLY_INVALIDATION_SECS: '5', PROJECT_HUB_X: '1', HUB_Y: '1', GROK_HOME: 'C:\\x', HTTPS_PROXY: 'http://p', KEEP_ME: 'k' } });
  const p = r.w.autoRefresh(); await settle(); await settle();
  assert.equal(r.spawned.length, 1);
  const s = r.spawned[0];
  assert.equal(s.file, GROK);
  assert.notEqual(s.file, COMSPEC);
  assert.deepEqual(s.args, ['models']);
  assert.equal(s.opts.windowsHide, true);
  assert.equal(s.opts.stdio, 'ignore');
  assert.equal(s.opts.cwd, r.home);
  assert.ok(!s.opts.windowsVerbatimArguments);
  assert.equal(envValue(s.opts.env, 'GROK_AUTH_EARLY_INVALIDATION_SECS'), '21600');
  for (const gone of ['PROJECT_HUB_X', 'HUB_Y', 'GROK_HOME', 'HTTPS_PROXY']) assert.equal(envValue(s.opts.env, gone), undefined, gone);
  assert.equal(envValue(s.opts.env, 'KEEP_ME'), 'k');
  assert.equal(r.w.state().running, true);
  assert.equal(r.w.state().mode, 'auto');
  setAge(r.home, 0); exit(s.child, 0);
  const result = await p;
  assert.equal(result.outcome, 'refreshed');
  assert.equal(result.timedOut, false);
  assert.ok(Object.isFrozen(result));
});

test('R22 W2 outcomes come from the mtime, not the exit code', async t => {
  let r = rig(t); let p = r.w.autoRefresh(); await settle(); await settle();
  exit(r.spawned[0].child, 0);
  assert.equal((await p).outcome, 'unchanged');
  r = rig(t); p = r.w.autoRefresh(); await settle(); await settle();
  exit(r.spawned[0].child, 1);
  assert.equal((await p).outcome, 'failed');
  r = rig(t); p = r.w.autoRefresh(); await settle(); await settle();
  r.spawned[0].child.emit('error', Object.assign(Error('x'), { code: 'ENOENT' }));
  assert.equal((await p).outcome, 'failed');
});

test('R22 W3 the 60 s deadline kills the child and reports timedOut', async t => {
  const r = rig(t); const p = r.w.autoRefresh(); await settle(); await settle();
  const timer = r.timers.find(h => h.ms === 60000);
  assert.ok(timer, 'a 60000 ms timer: ' + r.timers.map(h => h.ms).join(','));
  timer.fn();
  const result = await p;
  assert.deepEqual(r.killed, [r.spawned[0].child.pid]);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.timedOut, true);
});

test('R22 W4 concurrent calls share one spawn', async t => {
  const r = rig(t); const a = r.w.autoRefresh(), b = r.w.autoRefresh(); await settle(); await settle();
  const c = r.w.autoRefresh(); await settle();
  assert.equal(r.spawned.length, 1);
  setAge(r.home, 0); exit(r.spawned[0].child, 0);
  const results = await Promise.all([a, b, c]);
  for (const x of results) assert.equal(x.outcome, 'refreshed');
});

test('R22 W5 busy while a manual window runs; manual start refused while auto runs', async t => {
  let r = rig(t);
  await r.w.start('refresh'); await settle();
  assert.equal(r.spawned.length, 1);
  const busy = await r.w.autoRefresh();
  assert.equal(busy.outcome, 'busy');
  assert.equal(r.spawned.length, 1);
  exit(r.spawned[0].child, 0); await settle();

  r = rig(t);
  const p = r.w.autoRefresh(); await settle(); await settle();
  await assert.rejects(r.w.start('refresh'), e => e.code === 'GROK_LOGIN_AUTO_REFRESHING' && e.status === 409);
  assert.equal(r.spawned.length, 1);
  exit(r.spawned[0].child, 0); await p;
});

test('R22 W6 auto is not a route mode', async t => {
  const r = rig(t);
  await assert.rejects(r.w.start('auto'), e => e.status === 400);
  assert.equal(r.spawned.length, 0);
});

test('R22 W7 resolve and path failures give failed without a spawn; never throws', async t => {
  let r = rig(t, { resolveGrok: async () => { throw Error('nope'); } });
  assert.equal((await r.w.autoRefresh()).outcome, 'failed');
  assert.equal(r.spawned.length, 0);
  r = rig(t, { resolveGrok: async () => 'C:\\Users\\owner\\grok.cmd' });
  assert.equal((await r.w.autoRefresh()).outcome, 'failed');
  r = rig(t, { resolveGrok: async () => 'C:\\a"b\\grok.exe' });
  assert.equal((await r.w.autoRefresh()).outcome, 'failed');
  assert.equal(r.spawned.length, 0);
});

test('R22 W8 autoRefresh does not consult isGrokTurnActive; dispose stops a run', async t => {
  const r = rig(t, { turnActive: true });
  const p = r.w.autoRefresh(); await settle(); await settle();
  assert.equal(r.spawned.length, 1);
  r.w.dispose();
  const result = await p;
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(r.killed, [r.spawned[0].child.pid]);
});

// ---- the turn gate ----
function gateRig(t, { ageMs, refresh = 'refreshed', autoRefresh, clock } = {}) {
  const home = tempHome(t, ageMs), calls = [], records = [];
  let offset = 0;
  const now = clock || (() => Date.now() + offset);
  const auto = autoRefresh === null ? null : autoRefresh || (async () => {
    calls.push(Date.now());
    const outcome = typeof refresh === 'function' ? refresh() : refresh;
    if (outcome === 'throw') throw Error('boom');
    if (outcome === 'refreshed') setAge(home, 0);
    return Object.freeze({ outcome, timedOut: false });
  });
  const gate = createGrokTurnGate({ home, env: {}, now, autoRefresh: auto, record: (...a) => records.push(a), cooldownMs: 600000 });
  return { gate, home, calls, records, advance: ms => { offset += ms; } };
}
const isCode = code => e => e.code === code && e.message === code && e.status === 409 && e.notStarted === true;

test('R22 G1 fresh and unknown pass without a refresh; missing rethrows', async t => {
  let g = gateRig(t, { ageMs: 60000 });
  await g.gate(); assert.equal(g.calls.length, 0);
  g = gateRig(t, { ageMs: -3600000 });
  await g.gate(); assert.equal(g.calls.length, 0);
  g = gateRig(t, { ageMs: null });
  await assert.rejects(g.gate(), isCode('GROK_LOGIN_MISSING'));
  assert.equal(g.calls.length, 0);
});

test('R22 G2 expiring and expired refresh once and pass', async t => {
  for (const age of [TTL - MARGIN + 60000, TTL + 3600000]) {
    const g = gateRig(t, { ageMs: age });
    await g.gate({ otherGrokTurns: 0 });
    assert.equal(g.calls.length, 1, String(age));
  }
});

test('R22 G3 a failed refresh refuses with AUTO_REFRESH_FAILED and starts a cooldown', async t => {
  for (const outcome of ['unchanged', 'failed', 'throw']) {
    const g = gateRig(t, { ageMs: TTL + 60000, refresh: outcome });
    await assert.rejects(g.gate(), isCode(outcome==='unchanged'?'GROK_LOGIN_AUTO_REFRESH_UNCHANGED':'GROK_LOGIN_AUTO_REFRESH_FAILED'), outcome);
    assert.equal(g.calls.length, 1);
    await assert.rejects(g.gate(), isCode('GROK_LOGIN_AUTO_REFRESH_FAILED'));
    assert.equal(g.calls.length, 1, 'no new attempt within the cooldown');
    g.advance(600000 + 1000);
    await assert.rejects(g.gate(), isCode(outcome==='unchanged'?'GROK_LOGIN_AUTO_REFRESH_UNCHANGED':'GROK_LOGIN_AUTO_REFRESH_FAILED'));
    assert.equal(g.calls.length, 2, 'one new attempt after the cooldown');
  }
});

test('R22 G4 other turns, busy and disabled rethrow the original code without a refresh', async t => {
  let g = gateRig(t, { ageMs: TTL - MARGIN + 60000 });
  await assert.rejects(g.gate({ otherGrokTurns: 1 }), isCode('GROK_LOGIN_EXPIRING'));
  assert.equal(g.calls.length, 0);
  g = gateRig(t, { ageMs: TTL + 60000, refresh: 'busy' });
  await assert.rejects(g.gate(), isCode('GROK_LOGIN_EXPIRED'));
  g = gateRig(t, { ageMs: TTL + 60000, autoRefresh: null });
  await assert.rejects(g.gate(), isCode('GROK_LOGIN_EXPIRED'));
  // A busy result does not start a cooldown.
  let mode = 'busy';
  g = gateRig(t, { ageMs: TTL + 60000, refresh: () => mode });
  await assert.rejects(g.gate(), isCode('GROK_LOGIN_EXPIRED'));
  mode = 'refreshed';
  await g.gate();
  assert.equal(g.calls.length, 2);
});

test('R22 G5 records name the state and the reason, never a path', async t => {
  const g = gateRig(t, { ageMs: TTL + 60000 });
  await g.gate();
  const rows = g.records.filter(a => a[0] === 'grok-login-auto-refresh');
  assert.ok(rows.length >= 1);
  const fields = rows.at(-1)[1];
  assert.equal(fields.from, 'expired');
  assert.equal(fields.outcome, 'refreshed');
  assert.equal(fields.skipped ?? null, null);
  assert.ok(!JSON.stringify(g.records).includes(g.home.replace(/\\/g, '\\\\')));
  const s = gateRig(t, { ageMs: TTL + 60000 });
  await assert.rejects(s.gate({ otherGrokTurns: 2 }));
  assert.equal(s.records.filter(a => a[0] === 'grok-login-auto-refresh').at(-1)[1].skipped, 'turn-active');
});

test('R22 M1 codes and Traditional Chinese messages', () => {
  for (const code of ['GROK_LOGIN_AUTO_REFRESH_FAILED', 'GROK_LOGIN_AUTO_REFRESHING']) {
    assert.equal(diagnostic.codeOf(Object.assign(Error(code), { code })), code);
    assert.ok(messageFor(code).includes('（代碼：' + code + '）'), messageFor(code));
  }
  assert.ok(messageFor('GROK_LOGIN_AUTO_REFRESH_FAILED').includes('Grok 登入即將到期或已過期，Hub 剛才自動更新沒有成功，這則訊息沒有送出。請按「更新 Grok 登入」再試一次；如果還是不行，請按「登入 Grok」重新登入，完成後再送一次。'));
  assert.ok(messageFor('GROK_LOGIN_AUTO_REFRESHING').includes('Hub 正在自動更新 Grok 登入（通常幾秒鐘）；請稍後再按一次。'));
});

test('R22 C1 server composes the automatic refresh only for the real entry point and the switch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const at = source.indexOf('PROJECT_HUB_GROK_AUTO_REFRESH');
  assert.ok(at >= 0);
  const around = source.slice(Math.max(0, at - 600), at + 300);
  assert.match(around, /require\.main\s*===\s*module/);
  assert.match(around, /PROJECT_HUB_GROK_AUTO_REFRESH\s*!==\s*['"]0['"]/);
  assert.match(source, /createGrokTurnGate\s*\(/);
});
