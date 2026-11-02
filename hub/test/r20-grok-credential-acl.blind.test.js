'use strict';
// Blind acceptance test for round 20, written from SPEC-R20 only (not from the implementation).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGrokCredentialAcl, REMOVE_SCRIPT } = require('../lib/grok-credential-acl');

const OWNER = 'S-1-5-21-11-22-33-1001';
const GROUP = 'S-1-5-21-11-22-33-1003';
const CAP = 'S-1-5-21-901-902-903-904';
const SYSROOT = 'C:\\Windows';
const ICACLS = 'c:\\windows\\system32\\icacls.exe';
const FORBIDDEN = ['/t', '/c', '/reset', '/grant', '/grant:r', '/deny', '/setowner', '/inheritance', '/restore'];

function tree(t, { dirKind = 'dir', authKind = 'file', lock = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'r20-blind-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), grok = path.join(home, '.grok'), tmp = path.join(base, 'tmp');
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  if (dirKind === 'dir') fs.mkdirSync(grok); else fs.writeFileSync(grok, 'x');
  if (dirKind === 'dir') {
    if (authKind === 'file') fs.writeFileSync(path.join(grok, 'auth.json'), 'dummy');
    else if (authKind === 'dir') fs.mkdirSync(path.join(grok, 'auth.json'));
    if (lock) fs.writeFileSync(path.join(grok, 'auth.json.lock'), '');
  }
  return { home, grok, tmp, auth: path.join(grok, 'auth.json'), lock: path.join(grok, 'auth.json.lock') };
}

// Fake ACL tools: keep one SDDL per target, answer icacls /save and PowerShell removal.
function fakeIcacls(sddl, { removeStatus = 0, removeTimeout = false, removeNoop = false } = {}) {
  const calls = [];
  const key = p => path.resolve(p).toLowerCase();
  const state = new Map(Object.entries(sddl).map(([k, v]) => [key(k), v]));
  const run = async (file, args, opts) => {
    calls.push({ file, args: args.slice(), opts });
    const target = key(opts.env?.HUB_GROK_ACL_TARGET || args[0]);
    if (args[1] === '/save') {
      const text = path.basename(args[0]) + '\r\n' + state.get(target) + '\r\n';
      fs.writeFileSync(args[2], Buffer.from(text, 'utf16le'));
      return { status: 0, timedOut: false };
    }
    if (args[0] === '-NoProfile') {
      assert.equal(file, path.win32.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
      assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', REMOVE_SCRIPT]);
      assert.equal(opts.env.HUB_GROK_ACL_DIR, path.basename(opts.env.HUB_GROK_ACL_TARGET) === '.grok' ? '1' : '0');
      if (removeTimeout) return { status: null, timedOut: true };
      if (removeStatus !== 0) return { status: removeStatus, timedOut: false };
      if (removeNoop) return { status: 0, timedOut: false };
      const sids = opts.env.HUB_GROK_ACL_SIDS.split(',').map(a => a.toUpperCase());
      const s = state.get(target);
      const head = s.slice(0, s.indexOf('D:') + 2);
      const rest = s.slice(s.indexOf('D:') + 2);
      const flagsEnd = rest.indexOf('(');
      const daclFlags = flagsEnd < 0 ? rest : rest.slice(0, flagsEnd);
      const aces = rest.match(/\([^)]*\)/g) || [];
      const kept = aces.filter(a => {
        const f = a.slice(1, -1).split(';');
        const explicit = !f[1].includes('ID');
        return !(f[0] === 'A' && explicit && sids.includes(resolveAlias(f[5]).toUpperCase()));
      });
      state.set(target, head + daclFlags + kept.join(''));
      return { status: 0, timedOut: false };
    }
    throw new Error('unexpected icacls call ' + args.join(' '));
  };
  return { run, calls, state };
}
function resolveAlias(s) { return { WD: 'S-1-1-0', SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', AU: 'S-1-5-11', CO: 'S-1-3-0', OW: 'S-1-3-4' }[s] || s; }

function make(t, paths, fake, extra = {}) {
  const records = [];
  const acl = createGrokCredentialAcl({ home: paths.home, systemRoot: SYSROOT, run: fake.run,
    record: (name, data) => records.push({ name, data }), platform: 'win32', tmpdir: paths.tmp,
    currentUserSid: async () => OWNER, ...extra });
  return { acl, records };
}
const byTarget = r => Object.fromEntries(r.results.map(x => [x.target, x]));
const removes = calls => calls.filter(c => c.args[0] === '-NoProfile');

test('clean ACLs: three inspections, no remove, outcomes clean in fixed order', async t => {
  const p = tree(t);
  const fake = fakeIcacls({
    [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${OWNER})`,
    [p.auth]: `O:${OWNER}G:${OWNER}D:P(A;;FA;;;${OWNER})`,
    [p.lock]: `O:${OWNER}G:${OWNER}D:(A;ID;FA;;;SY)(A;ID;FA;;;${OWNER})(A;ID;0x1301bf;;;${GROUP})`
  });
  const { acl, records } = make(t, p, fake);
  const r = await acl.revoke('startup');
  assert.equal(r.reason, 'startup');
  assert.deepEqual(r.results.map(x => x.target), ['dir', 'auth', 'lock']);
  assert.deepEqual(r.results.map(x => x.outcome), ['clean', 'clean', 'clean']);
  assert.equal(removes(fake.calls).length, 0);
  for (const c of fake.calls) assert.equal(c.file.toLowerCase(), ICACLS);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'grok-credential-acl');
  assert.deepEqual(fs.readdirSync(p.tmp), [], 'the /save temp folder is removed');
});

test('foreign explicit allow ACEs are removed in one call per target; deny and inherited stay', async t => {
  const p = tree(t);
  const fake = fakeIcacls({
    [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICI;0x1301bf;;;${GROUP})(A;OICI;0x1301bf;;;${CAP})(D;OICI;0x110000;;;${CAP})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${OWNER})`,
    [p.auth]: `O:${OWNER}G:${OWNER}D:P(A;;0x1200a9;;;${GROUP})(A;;FA;;;${OWNER})`,
    [p.lock]: `O:${OWNER}G:${OWNER}D:(A;;0x1301bf;;;${GROUP})(A;;0x1301bf;;;${CAP})(A;ID;0x1301bf;;;${GROUP})(A;ID;FA;;;${OWNER})`
  });
  const { acl, records } = make(t, p, fake);
  const r = await acl.revoke('turn-end');
  const o = byTarget(r);
  assert.equal(r.reason, 'turn-end');
  assert.deepEqual([o.dir.outcome, o.auth.outcome, o.lock.outcome], ['revoked', 'revoked', 'revoked']);
  assert.deepEqual([o.dir.removed, o.auth.removed, o.lock.removed], [2, 1, 2]);
  const rm = removes(fake.calls);
  assert.equal(rm.length, 3);
  const dirCall = rm.find(c => path.resolve(c.opts.env.HUB_GROK_ACL_TARGET).toLowerCase() === path.resolve(p.grok).toLowerCase());
  assert.deepEqual(dirCall.opts.env.HUB_GROK_ACL_SIDS.split(',').sort(), [CAP, GROUP].sort());
  assert.equal(dirCall.opts.timeoutMs, 120000);
  for (const c of rm.filter(c => c !== dirCall)) assert.equal(c.opts.timeoutMs, 30000);
  assert.ok(fake.state.get(path.resolve(p.grok).toLowerCase()).includes(`(D;OICI;0x110000;;;${CAP})`), 'deny ACE kept');
  assert.ok(fake.state.get(path.resolve(p.lock).toLowerCase()).includes(`(A;ID;0x1301bf;;;${GROUP})`), 'inherited ACE untouched');
  for (const c of fake.calls) for (const a of c.args) assert.ok(!FORBIDDEN.includes(String(a).toLowerCase()), 'forbidden switch ' + a);
  const text = JSON.stringify(records);
  assert.ok(!/\\|S-1-|D:/.test(text), 'record leaks a path, SID or SDDL: ' + text);
  assert.deepEqual(fs.readdirSync(p.tmp), []);
});

test('owner, SYSTEM and Administrators are kept in every spelling; WD and BU are foreign', async t => {
  const p = tree(t, { lock: false });
  const fake = fakeIcacls({
    [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-32-544)(A;OICI;FA;;;${OWNER})`,
    [p.auth]: `O:${OWNER}G:${OWNER}D:P(A;;FR;;;WD)(A;;FR;;;BU)(A;;FA;;;${OWNER})`
  });
  const { acl } = make(t, p, fake);
  const o = byTarget(await acl.revoke('startup'));
  assert.equal(o.dir.outcome, 'clean');
  assert.equal(o.auth.outcome, 'revoked');
  assert.equal(o.auth.removed, 2);
  assert.equal(o.lock.outcome, 'missing');
  const rm = removes(fake.calls);
  assert.equal(rm.length, 1);
  assert.equal(rm[0].opts.env.HUB_GROK_ACL_TARGET, p.auth);
  assert.deepEqual(rm[0].opts.env.HUB_GROK_ACL_SIDS.split(',').sort(), ['S-1-1-0', 'S-1-5-32-545']);
});

test('remove failure, timeout, or a foreign ACE still present gives failed', async t => {
  for (const opts of [{ removeStatus: 5 }, { removeTimeout: true }, { removeNoop: true }]) {
    const p = tree(t, { lock: false });
    const fake = fakeIcacls({
      [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICIID;FA;;;${OWNER})`,
      [p.auth]: `O:${OWNER}G:${OWNER}D:P(A;;0x1200a9;;;${GROUP})(A;;FA;;;${OWNER})`
    }, opts);
    const { acl } = make(t, p, fake);
    const o = byTarget(await acl.revoke('turn-end'));
    assert.equal(o.auth.outcome, 'failed', JSON.stringify(opts));
    assert.equal(o.dir.outcome, 'clean');
  }
});

test('malformed SDDL gives failed without any remove', async t => {
  const p = tree(t, { lock: false });
  const fake = fakeIcacls({
    [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICIID;FA;;;${OWNER})`,
    [p.auth]: 'this is not sddl (A;;'
  });
  const { acl } = make(t, p, fake);
  const o = byTarget(await acl.revoke('startup'));
  assert.equal(o.auth.outcome, 'failed');
  assert.equal(removes(fake.calls).length, 0);
});

test('wrong kinds are skipped without calling icacls on them', async t => {
  const p = tree(t, { authKind: 'dir' });
  const fake = fakeIcacls({
    [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICIID;FA;;;${OWNER})`,
    [p.lock]: `O:${OWNER}G:${OWNER}D:(A;ID;FA;;;${OWNER})`
  });
  const { acl } = make(t, p, fake);
  const o = byTarget(await acl.revoke('startup'));
  assert.equal(o.auth.outcome, 'skipped-kind');
  assert.ok(!fake.calls.some(c => path.resolve(c.args[0]).toLowerCase() === path.resolve(p.auth).toLowerCase()));

  const q = tree(t, { dirKind: 'file' });
  const fake2 = fakeIcacls({});
  const { acl: acl2 } = make(t, q, fake2);
  const o2 = byTarget(await acl2.revoke('startup'));
  assert.equal(o2.dir.outcome, 'skipped-kind');
  assert.ok(!fake2.calls.some(c => path.resolve(c.args[0]).toLowerCase() === path.resolve(q.grok).toLowerCase()));
});

test('non-win32 makes no call', async t => {
  const p = tree(t);
  const fake = fakeIcacls({});
  const { acl } = make(t, p, fake, { platform: 'linux' });
  const r = await acl.revoke('startup');
  assert.deepEqual(r.results, []);
  assert.equal(fake.calls.length, 0);
});

test('never opens or reads anything under .grok', async t => {
  const p = tree(t);
  const fake = fakeIcacls({
    [p.grok]: `O:${OWNER}G:${OWNER}D:(A;OICI;0x1301bf;;;${GROUP})(A;OICIID;FA;;;${OWNER})`,
    [p.auth]: `O:${OWNER}G:${OWNER}D:P(A;;0x1200a9;;;${GROUP})(A;;FA;;;${OWNER})`,
    [p.lock]: `O:${OWNER}G:${OWNER}D:(A;ID;FA;;;${OWNER})`
  });
  const grokKey = path.resolve(p.grok).toLowerCase() + path.sep;
  const touched = [];
  const wrap = name => { const orig = fs[name]; t.mock.method(fs, name, function (f, ...rest) {
    if (typeof f === 'string' && (path.resolve(f).toLowerCase() + path.sep).startsWith(grokKey)) touched.push(name + ' ' + f);
    return orig.call(this, f, ...rest); }); };
  for (const n of ['openSync', 'readFileSync', 'createReadStream', 'copyFileSync']) wrap(n);
  const { acl } = make(t, p, fake);
  await acl.revoke('turn-end');
  assert.deepEqual(touched, []);
});

// Amendment A: real icacls /save output has no O: part; the owner comes from currentUserSid.
test('real format without O: keeps the current user, CO and OW; removes BG and the sandbox group', async t => {
  const p = tree(t);
  let asked = 0;
  const fake = fakeIcacls({
    [p.grok]: `D:(A;OICI;0x1301bf;;;${GROUP})(A;OICIIO;FA;;;CO)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${OWNER})`,
    [p.auth]: `D:P(A;;0x1200a9;;;${GROUP})(A;;FA;;;${OWNER})`,
    [p.lock]: `D:(A;;0x1301bf;;;BG)(A;;FA;;;OW)(A;ID;FA;;;${OWNER})`
  });
  const { acl } = make(t, p, fake, { currentUserSid: async () => { asked++; return OWNER; } });
  const o = byTarget(await acl.revoke('turn-end'));
  assert.deepEqual([o.dir.outcome, o.auth.outcome, o.lock.outcome], ['revoked', 'revoked', 'revoked']);
  assert.deepEqual([o.dir.removed, o.auth.removed, o.lock.removed], [1, 1, 1]);
  assert.ok(asked <= 1, 'currentUserSid called at most once per revoke');
  const lockCall = removes(fake.calls).find(c => path.resolve(c.opts.env.HUB_GROK_ACL_TARGET).toLowerCase() === path.resolve(p.lock).toLowerCase());
  assert.equal(lockCall.opts.env.HUB_GROK_ACL_SIDS, 'S-1-5-32-546');
  assert.ok(fake.state.get(path.resolve(p.auth).toLowerCase()).includes(`(A;;FA;;;${OWNER})`), 'owner explicit ACE kept');
});

test('currentUserSid failure or garbage means no remove anywhere', async t => {
  for (const bad of [async () => { throw new Error('x'); }, async () => 'not-a-sid', async () => 'S-1-1-0']) {
    const p = tree(t, { lock: false });
    const fake = fakeIcacls({
      [p.grok]: `D:(A;OICIID;FA;;;${OWNER})`,
      [p.auth]: `D:P(A;;0x1200a9;;;${GROUP})(A;;FA;;;${OWNER})`
    });
    const { acl } = make(t, p, fake, { currentUserSid: bad });
    const o = byTarget(await acl.revoke('startup'));
    assert.equal(removes(fake.calls).length, 0);
    assert.equal(o.auth.outcome, 'failed');
  }
});

test('currentUserSid is not called when nothing needs inspection', async t => {
  const p = tree(t, { dirKind: 'file' });
  let asked = 0;
  const { acl } = make(t, p, fakeIcacls({}), { currentUserSid: async () => { asked++; return OWNER; } });
  await acl.revoke('startup');
  assert.equal(asked, 0);
});
