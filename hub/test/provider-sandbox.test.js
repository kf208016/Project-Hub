'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createPlan, launch, SandboxError } = require('../lib/provider-sandbox.js');

const BASE_OPTS = () => ({
  provider: 'claude',
  providerFile: 'C:\\Program Files\\Claude\\claude.exe',
  providerArgs: ['--flag', 'value'],
  codexFile: 'C:\\Program Files\\Codex\\codex.exe',
  cwd: 'C:\\Users\\user\\project',
  rootFingerprint: 'b'.repeat(64),
  codexSHA256: 'a'.repeat(64),
  networkAccess: false,
  stateRoots: []
});

function noopSpawn() {
  throw new Error('spawn should not be called');
}

test('rejects rooted-drive-relative, ADS, device names and Unicode-broken paths',()=>{
  for(const cwd of ['\\project','C:\\project:stream','C:\\project\\con.txt','C:\\project\\tail.','C:\\project\\bad\ud800']) {
    assert.throws(()=>createPlan({...BASE_OPTS(),cwd}),e=>e.code==='ERR_INVALID_CWD');
  }
});

test('root identity must be a complete SHA-256 and cannot be a display label',()=>{
  for(const rootFingerprint of ['', 'fp-123','a'.repeat(63),'A'.repeat(64)]) {
    assert.throws(()=>createPlan({...BASE_OPTS(),rootFingerprint}),e=>e.code==='ERR_INVALID_FINGERPRINT');
  }
});

test('createPlan builds expected full structural plan', () => {
  const plan = createPlan(BASE_OPTS());
  assert.equal(plan.file, 'C:\\Program Files\\Codex\\codex.exe');
  assert.equal(plan.cwd, 'C:\\Users\\user\\project');
  assert.deepEqual(plan.dirPin, { root: plan.cwd, rootFingerprint: 'b'.repeat(64) });
  assert.equal(plan.args[0], 'sandbox');
  assert.equal(plan.args[1], '-C');
  assert.equal(plan.args[2], plan.cwd);
  assert.equal(plan.args[3], '-P');
  assert.equal(plan.args[4], 'project-hub-worker');
  assert.equal(plan.args[5], '--include-managed-config');
  assert.equal(plan.args[6], '-c');
  assert.match(plan.args[7], /permissions\.project-hub-worker\.filesystem=/);
  assert.equal(plan.args[8], '-c');
  assert.equal(plan.args[9], 'permissions.project-hub-worker.network.enabled=false');
  assert.equal(plan.args[10], '-c');
  assert.equal(plan.args[11], 'windows.sandbox="elevated"');
  assert.equal(plan.args[12], '--');
  assert.equal(plan.args[13], 'C:\\Program Files\\Claude\\claude.exe');
  assert.deepEqual(plan.args.slice(14), ['--flag', 'value']);
});

test('createPlan includes protected metadata roots as read grants', () => {
  const plan = createPlan(BASE_OPTS());
  const toml = plan.args[7];
  assert.match(toml, /\\.git"="read"/);
  assert.match(toml, /\\.agents"="read"/);
  assert.match(toml, /\\.codex"="read"/);
  assert.match(toml, /\\.aws"="read"/);
  assert.match(toml, /:minimal"="read"/);
  assert.doesNotMatch(toml, /:root/);
  assert.ok(toml.includes(JSON.stringify(plan.cwd)+'="write"'));
});

test('createPlan env filtering excludes secrets and non-whitelisted vars', () => {
  const prevSecret = process.env.HUB_SECRET_TOKEN;
  const prevNodeOpts = process.env.NODE_OPTIONS;
  process.env.HUB_SECRET_TOKEN = 'super-secret';
  process.env.NODE_OPTIONS = '--inspect';
  try {
    const plan = createPlan(BASE_OPTS());
    assert.equal(plan.env.HUB_SECRET_TOKEN, undefined);
    assert.equal(plan.env.NODE_OPTIONS, undefined);
    assert.ok(plan.env.PATH.includes('System32'));
    assert.ok(plan.env.TEMP.includes('.hub-runtime'));
    assert.ok(plan.env.TMP.includes('.hub-runtime'));
    assert.ok(plan.env.CLAUDE_CODE_TMPDIR.includes('.hub-runtime'));
  } finally {
    if (prevSecret === undefined) delete process.env.HUB_SECRET_TOKEN; else process.env.HUB_SECRET_TOKEN = prevSecret;
    if (prevNodeOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prevNodeOpts;
  }
});

test('no flag injection through provider args: literal values passed through, not interpreted', () => {
  const opts = BASE_OPTS();
  opts.providerArgs = ['--danger-full-access', '-c', 'evil=true'];
  const plan = createPlan(opts);
  const tailArgs = plan.args.slice(14);
  assert.deepEqual(tailArgs, ['--danger-full-access', '-c', 'evil=true']);
  // ensure no extra -c injected beyond the three fixed ones
  const cCount = plan.args.slice(0,plan.args.indexOf('--')).filter((a) => a === '-c').length;
  assert.equal(cCount, 3);
});

test('rejects invalid provider', () => {
  const opts = BASE_OPTS();
  opts.provider = 'gpt';
  assert.throws(() => createPlan(opts), (err) => err instanceof SandboxError && err.code === 'ERR_INVALID_PROVIDER');
});

test('rejects malformed codex hash format', () => {
  const opts = BASE_OPTS();
  opts.codexSHA256 = 'NOT-HEX';
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_HASH_FORMAT');
});

test('rejects NUL byte in provider args', () => {
  const opts = BASE_OPTS();
  opts.providerArgs = ['bad\u0000arg'];
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_ARGS');
});

test('rejects non-string provider args', () => {
  const opts = BASE_OPTS();
  opts.providerArgs = [42];
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_ARGS');
});

test('rejects traversal in stateRoots', () => {
  const opts = BASE_OPTS();
  opts.stateRoots = ['C:\\Users\\user\\project\\..\\..\\Windows'];
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_STATE_ROOT');
});

test('rejects stateRoot outside cwd', () => {
  const opts = BASE_OPTS();
  opts.stateRoots = ['C:\\Other\\Place'];
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_STATE_ROOT');
});

test('accepts exact subdir stateRoot', () => {
  const opts = BASE_OPTS();
  opts.stateRoots = ['C:\\Users\\user\\project\\data'];
  const plan = createPlan(opts);
  assert.deepEqual(plan.stateRoots, ['C:\\Users\\user\\project\\data']);
});

test('rejects drive-root cwd', () => {
  const opts = BASE_OPTS();
  opts.cwd = 'C:\\';
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_CWD');
});

test('rejects profile-wide root cwd', () => {
  const opts = BASE_OPTS();
  opts.cwd = 'C:\\Users\\user';
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_CWD');
});

test('rejects UNC path for providerFile', () => {
  const opts = BASE_OPTS();
  opts.providerFile = '\\\\server\\share\\claude.exe';
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_PATH');
});

test('rejects relative providerFile path', () => {
  const opts = BASE_OPTS();
  opts.providerFile = 'claude.exe';
  assert.throws(() => createPlan(opts), (err) => err.code === 'ERR_INVALID_PATH');
});

test('frozen plan: object and nested args/env are frozen', () => {
  const plan = createPlan(BASE_OPTS());
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.args));
  assert.ok(Object.isFrozen(plan.env));
  assert.ok(Object.isFrozen(plan.dirPin));
  assert.throws(() => { plan.args.push('x'); }, TypeError);
  assert.throws(() => { plan.cwd = 'C:\\other'; }, TypeError);
});

test('launch rejects when supervisedSpawn is not a function', () => {
  assert.throws(() => launch(BASE_OPTS(), null), (err) => err.code === 'ERR_SPAWN_INVALID');
});

test('launch rejects nonexistent cwd before spawning', () => {
  const opts = BASE_OPTS();
  opts.cwd = path.win32.join(os.tmpdir(), 'hub-sandbox-test-missing-' + crypto.randomBytes(4).toString('hex'));
  assert.throws(() => launch(opts, noopSpawn), (err) => err.code === 'ERR_NOT_DIRECTORY');
});

test('launch rejects provider hash mismatch using a real dummy file without calling spawn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sandbox-'));
  const providerFile = path.join(dir, 'claude.exe');
  const codexFile = path.join(dir, 'codex.exe');
  fs.writeFileSync(providerFile, 'dummy-provider-content');
  fs.writeFileSync(codexFile, 'dummy-codex-content');
  const codexHash = crypto.createHash('sha256').update(fs.readFileSync(codexFile)).digest('hex');

  const opts = {
    provider: 'claude',
    providerFile,
    providerArgs: [],
    codexFile,
    cwd: dir,
    rootFingerprint: 'b'.repeat(64),
    codexSHA256: codexHash,
    networkAccess: false,
    stateRoots: []
  };

  let spawnCalled = false;
  const spy = () => { spawnCalled = true; return {}; };

  assert.throws(() => launch(opts, spy), (err) => err.code === 'ERR_HASH_MISMATCH');
  assert.equal(spawnCalled, false);

  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('launch rejects unsupported provider before touching disk', () => {
  const opts = BASE_OPTS();
  opts.provider = 'unknown';
  assert.throws(() => launch(opts, noopSpawn), (err) => err.code === 'ERR_INVALID_PROVIDER');
});
