'use strict';
// R19 blind acceptance tests, written from SPEC-R19.md only (before reading the implementation).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const login = require('../lib/grok-login');
const { createGrokLoginWindow } = require('../lib/grok-login-window');
const { messageFor } = require('../lib/native-provider-messages');
const diagnostic = require('../lib/native-provider-diagnostic');

const TTL = 21300000;
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r19-blind-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.grok'));
  return home;
}
function writeAuth(home, mtimeMs) {
  const file = path.join(home, '.grok', 'auth.json');
  fs.writeFileSync(file, '{"dummy":true}');
  const s = new Date(mtimeMs);
  fs.utimesSync(file, s, s);
  return file;
}
// Fails the test if anything opens or reads the credential file.
function guardReads(t, file) {
  const target = path.resolve(file).toLowerCase();
  const hit = p => typeof p === 'string' && path.resolve(p).toLowerCase() === target;
  const orig = { openSync: fs.openSync, readFileSync: fs.readFileSync, createReadStream: fs.createReadStream, readFile: fs.promises.readFile, open: fs.open };
  const touched = [];
  fs.openSync = function (p, ...a) { if (hit(p)) touched.push('openSync'); return orig.openSync.call(this, p, ...a); };
  fs.readFileSync = function (p, ...a) { if (hit(p)) touched.push('readFileSync'); return orig.readFileSync.call(this, p, ...a); };
  fs.createReadStream = function (p, ...a) { if (hit(p)) touched.push('createReadStream'); return orig.createReadStream.call(this, p, ...a); };
  fs.promises.readFile = function (p, ...a) { if (hit(p)) touched.push('promises.readFile'); return orig.readFile.call(this, p, ...a); };
  fs.open = function (p, ...a) { if (hit(p)) touched.push('open'); return orig.open.call(this, p, ...a); };
  t.after(() => { fs.openSync = orig.openSync; fs.readFileSync = orig.readFileSync; fs.createReadStream = orig.createReadStream; fs.promises.readFile = orig.readFile; fs.open = orig.open; });
  return touched;
}

test('R19 B1 loginState states and TTL boundary, metadata only', t => {
  const home = tempHome(t), now = Date.now();
  assert.equal(login.loginState({ home, now, ttlMs: TTL }).state, 'missing');
  const file = writeAuth(home, now - TTL + 60000);
  const touched = guardReads(t, file);
  assert.equal(login.loginState({ home, now, ttlMs: TTL }).state, 'expiring');
  const s = new Date(now - TTL); fs.utimesSync(file, s, s);
  const st = login.loginState({ home, now, ttlMs: TTL });
  assert.equal(st.state, 'expired');
  assert.ok(Object.isFrozen(st));
  assert.equal(st.ttlMs, TTL);
  const f = new Date(now + 6 * 60000); fs.utimesSync(file, f, f);
  assert.equal(login.loginState({ home, now, ttlMs: TTL }).state, 'unknown');
  const f2 = new Date(now + 4 * 60000); fs.utimesSync(file, f2, f2);
  assert.equal(login.loginState({ home, now, ttlMs: TTL }).state, 'fresh');
  assert.deepEqual(touched, []);
});

test('R19 B2 ttlFromEnv default and bounds', () => {
  assert.equal(login.ttlFromEnv(undefined), TTL);
  assert.equal(login.ttlFromEnv(''), TTL);
  assert.equal(login.ttlFromEnv('600000'), 600000);
  assert.equal(login.ttlFromEnv('86400000'), 86400000);
  for (const bad of ['599999', '86400001', '1e6', '-600000', ' 600000', '600000.5', 'abc', '0x927C0']) assert.equal(login.ttlFromEnv(bad), TTL, bad);
});

test('R19 B3 assertFreshForTurn codes', t => {
  const home = tempHome(t), now = Date.now();
  const expect = code => err => err.code === code && err.status === 409 && err.notStarted === true;
  assert.throws(() => login.assertFreshForTurn({ home, now, ttlMs: TTL }), expect('GROK_LOGIN_MISSING'));
  const file = writeAuth(home, now - TTL - 1000);
  const touched = guardReads(t, file);
  assert.throws(() => login.assertFreshForTurn({ home, now, ttlMs: TTL }), expect('GROK_LOGIN_EXPIRED'));
  const s = new Date(now - 1000); fs.utimesSync(file, s, s);
  assert.doesNotThrow(() => login.assertFreshForTurn({ home, now, ttlMs: TTL }));
  const f = new Date(now + 3600000); fs.utimesSync(file, f, f);
  assert.doesNotThrow(() => login.assertFreshForTurn({ home, now, ttlMs: TTL }));
  assert.deepEqual(touched, []);
});

test('R19 B4 new codes are in the fixed enum and have zh-TW messages', () => {
  for (const code of ['GROK_LOGIN_EXPIRED', 'GROK_LOGIN_EXPIRING', 'GROK_LOGIN_MISSING', 'GROK_LOGIN_WINDOW_OPEN', 'GROK_LOGIN_TURN_ACTIVE', 'GROK_LOGIN_UNAVAILABLE']) {
    const e = Object.assign(Error(code), { code });
    assert.equal(diagnostic.codeOf(e), code);
    const m = messageFor(code);
    assert.ok(typeof m === 'string' && m.includes(`（代碼：${code}）`), code);
  }
  assert.match(messageFor('GROK_LOGIN_EXPIRED'), /更新 Grok 登入/);
  assert.match(messageFor('GROK_LOGIN_MISSING'), /登入 Grok/);
  const auth = messageFor('GROK_NATIVE_AUTH_UNAVAILABLE');
  assert.match(auth, /更新 Grok 登入/);
  assert.doesNotMatch(auth, /自動更新登入沒有成功/);
});

// ---- login window ----
const GROK = 'C:\\Users\\owner\\AppData\\Local\\ProjectHub\\runtime-binaries\\grok\\abc\\grok.exe';
function rig(t, over = {}) {
  const home = over.home || tempHome(t);
  const spawned = [], records = [], kills = [], timers = [];
  let active = false;
  const env = { PATH: 'C:\\Windows', USERPROFILE: home, PROJECT_HUB_X: '1', hub_secret: '2', GROK_HOME: 'C:\\g', https_proxy: 'http://p', HTTP_PROXY: 'http://p', All_Proxy: 'x', no_proxy: 'y', OTHER: 'keep', ...(over.env || {}) };
  const w = createGrokLoginWindow({
    resolveGrok: over.resolveGrok || (async () => GROK),
    spawn: (file, args, opts) => { const c = new EventEmitter(); c.pid = 4242 + spawned.length; spawned.push({ file, args, opts, child: c }); return c; },
    now: () => Date.now(),
    record: (name, fields) => records.push({ name, fields }),
    isGrokTurnActive: () => active,
    home, env, comspec: 'C:\\Windows\\System32\\cmd.exe',
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeout: h => { if (h) h.cleared = true; },
    kill: (...a) => { kills.push(a); },
  });
  return { w, home, spawned, records, kills, timers, setActive: v => { active = v; } };
}
const settle = () => new Promise(r => setImmediate(r));
function finish(child, code) { child.emit('exit', code, null); child.emit('close', code, null); }
const codeIs = code => err => err && err.code === code;

test('R19 B5 exact command line per mode, hidden cmd with visible start window', async t => {
  for (const [mode, tail] of [['refresh', 'models'], ['login', 'login'], ['device', 'login --device-auth']]) {
    const r = rig(t);
    await r.w.start(mode);
    await settle();
    assert.equal(r.spawned.length, 1, mode);
    const s = r.spawned[0];
    assert.equal(s.file, 'C:\\Windows\\System32\\cmd.exe');
    const line = s.args.join(' ');
    assert.ok(line.includes(`start "Grok login" /wait "${GROK}" ${tail}`), line);
    assert.equal(s.opts.windowsVerbatimArguments, true);
    assert.equal(s.opts.windowsHide, true);
    assert.equal(s.opts.stdio, 'ignore');
    assert.equal(path.resolve(s.opts.cwd).toLowerCase(), path.resolve(r.home).toLowerCase());
    const keys = Object.keys(s.opts.env);
    for (const k of keys) assert.doesNotMatch(k, /^(PROJECT_HUB_|HUB_|GROK_HOME$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i, k);
    assert.equal(s.opts.env.PATH, 'C:\\Windows');
    assert.equal(s.opts.env.OTHER, 'keep');
    assert.equal(s.opts.env.GROK_AUTH_EARLY_INVALIDATION_SECS, mode === 'refresh' ? '21600' : undefined);
    assert.ok(Object.keys(s.opts.env).some(k => k.toUpperCase() === 'USERPROFILE'));
    finish(s.child, 0); await settle();
  }
});

test('R19 B6 refusals: bad mode, single flight, active turn, unreviewed or unsafe path, home mismatch', async t => {
  let r = rig(t);
  for (const bad of ['', 'Refresh', 'logout', 'models', null, undefined, 1]) await assert.rejects(Promise.resolve().then(() => r.w.start(bad)));
  assert.equal(r.spawned.length, 0);
  r = rig(t);
  await r.w.start('refresh'); await settle();
  await assert.rejects(Promise.resolve().then(() => r.w.start('login')), codeIs('GROK_LOGIN_WINDOW_OPEN'));
  assert.equal(r.spawned.length, 1);
  finish(r.spawned[0].child, 0); await settle();
  r = rig(t); r.setActive(true);
  await assert.rejects(Promise.resolve().then(() => r.w.start('refresh')), codeIs('GROK_LOGIN_TURN_ACTIVE'));
  assert.equal(r.spawned.length, 0);
  r = rig(t, { resolveGrok: async () => { throw Object.assign(Error('unreviewed'), { code: 'NATIVE_GROK_UNREVIEWED' }); } });
  await assert.rejects(Promise.resolve().then(() => r.w.start('refresh')), codeIs('GROK_LOGIN_UNAVAILABLE'));
  for (const p of ['C:\\a"b\\grok.exe', 'C:\\a%PATH%\\grok.exe', 'C:\\a&b\\grok.exe', 'C:\\a^b\\grok.exe', 'C:\\a|b\\grok.exe', 'C:\\a!b\\grok.exe', '\\\\srv\\s\\grok.exe', 'C:\\x\\notgrok.exe', 'grok.exe']) {
    r = rig(t, { resolveGrok: async () => p });
    await assert.rejects(Promise.resolve().then(() => r.w.start('refresh')), codeIs('GROK_LOGIN_UNAVAILABLE'), p);
    assert.equal(r.spawned.length, 0, p);
  }
  r = rig(t, { env: { USERPROFILE: 'C:\\Users\\someone-else' } });
  await assert.rejects(Promise.resolve().then(() => r.w.start('refresh')), codeIs('GROK_LOGIN_UNAVAILABLE'));
  assert.equal(r.spawned.length, 0);
});

test('R19 B7 outcomes from before/after metadata, no credential reads, no paths recorded', async t => {
  const now = Date.now();
  // refreshed: older -> newer
  let r = rig(t);
  let file = writeAuth(r.home, now - TTL - 5000);
  let touched = guardReads(t, file);
  await r.w.start('refresh'); await settle();
  const s = new Date(now); fs.utimesSync(file, s, s);
  finish(r.spawned[0].child, 0); await settle();
  assert.equal(r.w.state().outcome, 'refreshed');
  assert.equal(r.w.state().running, false);
  assert.deepEqual(touched, []);
  // unchanged
  r = rig(t);
  file = writeAuth(r.home, now - TTL - 5000);
  await r.w.start('refresh'); await settle();
  finish(r.spawned[0].child, 0); await settle();
  assert.equal(r.w.state().outcome, 'unchanged');
  // failed: nonzero exit, unchanged
  r = rig(t);
  writeAuth(r.home, now - TTL - 5000);
  await r.w.start('login'); await settle();
  finish(r.spawned[0].child, 1); await settle();
  assert.equal(r.w.state().outcome, 'failed');
  assert.equal(r.w.state().exitCode, 1);
  // missing -> present
  r = rig(t);
  await r.w.start('login'); await settle();
  writeAuth(r.home, now);
  finish(r.spawned[0].child, 0); await settle();
  assert.equal(r.w.state().outcome, 'refreshed');
  const rec = r.records.filter(x => x.name === 'grok-login-window');
  assert.ok(rec.length >= 1);
  const flat = JSON.stringify(rec);
  assert.doesNotMatch(flat, /grok\.exe|\\\\|auth\.json|Users/i);
  for (const k of ['mode', 'exitCode', 'outcome']) assert.ok(Object.hasOwn(rec[rec.length - 1].fields, k), k);
});

test('R19 B8 deadline kills the tree and reports timedOut; dispose kills a running window', async t => {
  let r = rig(t);
  await r.w.start('refresh'); await settle();
  const live = r.timers.filter(h => !h.cleared);
  assert.ok(live.some(h => h.ms === 120000), JSON.stringify(live.map(h => h.ms)));
  live.find(h => h.ms === 120000).fn();
  await settle();
  assert.ok(r.kills.length >= 1);
  assert.ok(JSON.stringify(r.kills[0]).includes('4242'));
  finish(r.spawned[0].child, 1); await settle();
  assert.equal(r.w.state().outcome, 'failed');
  assert.equal(r.w.state().timedOut, true);
  r = rig(t);
  await r.w.start('login'); await settle();
  assert.ok(r.timers.some(h => !h.cleared && h.ms === 900000));
  await r.w.dispose();
  assert.ok(r.kills.length >= 1);
});
