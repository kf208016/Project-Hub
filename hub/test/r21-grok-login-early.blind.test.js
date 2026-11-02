'use strict';
// R21 blind acceptance tests, written from SPEC-R21.md only (before reading the implementation).
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

const TTL = 21300000, MARGIN = 2100000;
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-blind-'));
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
function setMtime(file, ms) { const s = new Date(ms); fs.utimesSync(file, s, s); }

test('R21 B1 defaults: TTL 6 h - 5 min, margin 35 min', () => {
  assert.equal(login.ttlFromEnv(undefined), TTL);
  assert.equal(login.ttlFromEnv(''), TTL);
  assert.equal(login.marginFromEnv(undefined, TTL), MARGIN);
  assert.equal(login.ttlFromEnv('600000'), 600000);
  assert.equal(login.ttlFromEnv('86400000'), 86400000);
});

test('R21 B2 margin parsing: decimal range [0, 3 h], strictly below the TTL', () => {
  assert.equal(login.marginFromEnv('0', TTL), 0);
  assert.equal(login.marginFromEnv('600000', TTL), 600000);
  assert.equal(login.marginFromEnv('10800000', TTL), 10800000);
  for (const bad of ['10800001', '-1', '1e3', '1.5', ' 600000', '0x10', 'abc', '']) assert.equal(login.marginFromEnv(bad, TTL), MARGIN, JSON.stringify(bad));
  // A margin not below the TTL falls back to the default, or 0 when the default is not below the TTL either.
  assert.equal(login.marginFromEnv('3600000', 3600000), MARGIN);
  assert.equal(login.marginFromEnv('3600000', 1800000), 0);
  assert.equal(login.marginFromEnv(undefined, 600000), 0);
});

test('R21 B3 fresh / expiring / expired at the exact boundaries, with refreshAt', t => {
  const home = tempHome(t), now = Date.now();
  const file = writeAuth(home, now);
  const at = age => { setMtime(file, now - age); return login.loginState({ home, now, ttlMs: TTL, marginMs: MARGIN }); };
  // utimes has millisecond-or-coarser precision; use whole-second ages.
  assert.equal(at(TTL - MARGIN - 1000).state, 'fresh');
  const e = at(TTL - MARGIN);
  assert.equal(e.state, 'expiring');
  assert.equal(e.refreshAt, e.mtime + TTL - MARGIN);
  assert.equal(e.expiresAt, e.mtime + TTL);
  assert.ok(Object.isFrozen(e));
  assert.equal(at(TTL - 1000).state, 'expiring');
  assert.equal(at(TTL).state, 'expired');
  assert.equal(at(TTL + 3600000).state, 'expired');
  fs.rmSync(file);
  const m = login.loginState({ home, now, ttlMs: TTL, marginMs: MARGIN });
  assert.equal(m.state, 'missing');
  assert.equal(m.refreshAt ?? null, null);
});

test('R21 B4 the gate refuses expiring and expired, passes fresh', t => {
  const home = tempHome(t), now = Date.now();
  const file = writeAuth(home, now - (TTL - MARGIN));
  assert.throws(() => login.assertFreshForTurn({ home, now, ttlMs: TTL, marginMs: MARGIN }),
    e => e.code === 'GROK_LOGIN_EXPIRING' && e.status === 409 && e.notStarted === true && e.message === 'GROK_LOGIN_EXPIRING');
  setMtime(file, now - TTL);
  assert.throws(() => login.assertFreshForTurn({ home, now, ttlMs: TTL, marginMs: MARGIN }), e => e.code === 'GROK_LOGIN_EXPIRED');
  setMtime(file, now - 1000);
  assert.doesNotThrow(() => login.assertFreshForTurn({ home, now, ttlMs: TTL, marginMs: MARGIN }));
});

test('R21 B5 code and Traditional Chinese message', () => {
  const e = Object.assign(Error('GROK_LOGIN_EXPIRING'), { code: 'GROK_LOGIN_EXPIRING' });
  assert.equal(diagnostic.codeOf(e), 'GROK_LOGIN_EXPIRING');
  const m = messageFor('GROK_LOGIN_EXPIRING');
  assert.ok(m.includes('Grok 登入即將到期，為避免回合做到一半中斷，這則訊息沒有送出。請按「更新 Grok 登入」（幾秒鐘、不需要瀏覽器），完成後再送一次。'), m);
  assert.ok(m.includes('（代碼：GROK_LOGIN_EXPIRING）'), m);
  assert.match(messageFor('GROK_LOGIN_EXPIRED'), /Grok 登入已過期/);
});

// ---- login window env ----
const GROK = 'C:\\Users\\owner\\AppData\\Local\\ProjectHub\\runtime-binaries\\grok\\abc\\grok.exe';
function rig(t, env) {
  const home = tempHome(t), spawned = [];
  const w = createGrokLoginWindow({
    resolveGrok: async () => GROK,
    spawn: (file, args, opts) => { const c = new EventEmitter(); c.pid = 5000 + spawned.length; spawned.push({ file, args, opts, child: c }); return c; },
    now: () => Date.now(), record: () => {}, isGrokTurnActive: () => false,
    home, env: { PATH: 'C:\\Windows', USERPROFILE: home, ...env }, comspec: 'C:\\Windows\\System32\\cmd.exe',
    setTimeout: () => ({}), clearTimeout: () => {}, kill: () => {},
  });
  return { w, spawned };
}
const settle = () => new Promise(r => setImmediate(r));
const finish = c => { c.emit('exit', 0, null); c.emit('close', 0, null); };
const envValue = (env, name) => { const k = Object.keys(env).find(x => x.toUpperCase() === name); return k === undefined ? undefined : env[k]; };

test('R21 B6 refresh mode forces early invalidation 21600 even over an inherited value', async t => {
  for (const inherited of [undefined, '5', '0']) {
    const r = rig(t, inherited === undefined ? {} : { GROK_AUTH_EARLY_INVALIDATION_SECS: inherited });
    await r.w.start('refresh'); await settle();
    const env = r.spawned[0].opts.env;
    assert.equal(envValue(env, 'GROK_AUTH_EARLY_INVALIDATION_SECS'), '21600', String(inherited));
    assert.equal(Object.keys(env).filter(k => k.toUpperCase() === 'GROK_AUTH_EARLY_INVALIDATION_SECS').length, 1);
    finish(r.spawned[0].child); await settle();
  }
});

test('R21 B7 login and device modes leave the variable as inherited', async t => {
  for (const mode of ['login', 'device']) {
    let r = rig(t, {});
    await r.w.start(mode); await settle();
    assert.equal(envValue(r.spawned[0].opts.env, 'GROK_AUTH_EARLY_INVALIDATION_SECS'), undefined, mode);
    finish(r.spawned[0].child); await settle();
    r = rig(t, { GROK_AUTH_EARLY_INVALIDATION_SECS: '7' });
    await r.w.start(mode); await settle();
    assert.equal(envValue(r.spawned[0].opts.env, 'GROK_AUTH_EARLY_INVALIDATION_SECS'), '7', mode);
    finish(r.spawned[0].child); await settle();
  }
});

test('R21 B8 the revoker is composed only for the real entry point', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('const grokCredentialAcl=');
  assert.ok(start >= 0);
  const expr = source.slice(start, source.indexOf('\n', start + 30) + 400);
  assert.match(expr.slice(0, expr.indexOf('createGrokCredentialAcl(')), /require\.main\s*===\s*module/);
});
