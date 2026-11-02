'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeProviderService } = require('../lib/native-provider-service');
// Hoisted so lazy requires inside the service/host hit the module cache even when fs.readFileSync is mocked below.
require('../lib/native-provider-binary'); require('../lib/native-provider-messages'); require('../lib/native-provider-diagnostic');
try { require('../lib/grok-versions'); } catch {}
function noOverride(t) {
  const saved = process.env.PROJECT_HUB_GROK_VERSION;
  delete process.env.PROJECT_HUB_GROK_VERSION;
  t.after(() => { if (saved === undefined) delete process.env.PROJECT_HUB_GROK_VERSION; else process.env.PROJECT_HUB_GROK_VERSION = saved; });
}

const HASH_134 = '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94';
const HASH_170 = '1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326';
const CLAUDE_HASH = 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a';
const HASHES = Object.freeze([HASH_170, HASH_134]);
const PROVIDER_HASHES = Object.freeze({ claude: CLAUDE_HASH, grok: HASH_134 });
// Exact text of lib/provider-native-host.js lines 18-45 (candidate 15). This becomes GROK_CONFIG_PREVIOUS.
const GROK_CONFIG_PREVIOUS = [
  '[memory]',
  'enabled = false',
  '[memory_v2]',
  'enabled = false',
  '',
  '[session]',
  'load_envrc = false',
  '',
  '[compat.claude]',
  'agents = false',
  'hooks = false',
  'mcps = false',
  'rules = false',
  'skills = false',
  '',
  '[compat.codex]',
  'hooks = false',
  'skills = false',
  '',
  '[compat.cursor]',
  'agents = false',
  'hooks = false',
  'mcps = false',
  'rules = false',
  'skills = false',
  ''
].join('\n');
const RUNTIME_PROFILE_ID = 'runtime-e3c0e3906b3273d5331995b99d4b075908bfa8eb10775b52955c6040d8549622';
const win = process.platform === 'win32' ? test : test.skip;

function versions() { return require('../lib/grok-versions'); }
function hostModule() { return require('../lib/provider-native-host'); }
function sandboxModule() { return require('../lib/provider-sandbox'); }
function binaryModule() { return require('../lib/native-provider-binary'); }

test('grok-versions REVIEWED has exactly 1.0.34 and 1.0.70', () => {
  const { REVIEWED } = versions();
  assert.deepEqual(Object.keys(REVIEWED), ['1.0.34', '1.0.70']);
  assert.deepEqual(REVIEWED['1.0.34'], {
    binaryHash: HASH_134,
    bytes: 151293256,
    versionString: 'grok 1.0.34 (3736acbc8658)',
    helpers: {}
  });
  assert.deepEqual(REVIEWED['1.0.70'], {
    binaryHash: HASH_170,
    bytes: 176011920,
    versionString: 'grok 1.0.70 (f50904eaee6c)',
    helpers: {
      'agent.exe': HASH_170,
      'grove.exe': 'aa11dd2e214fef7f49ebe6509a3e8dd88b597344a5fc77857c7bf03ce0d8d7a7',
      'grove-credential.exe': '772355911d4deee3c3b36439e850c4be6ceb3f7604086f74140f797a3a55e4c6',
      'grove-fsmonitor.exe': 'df4f522f115cf7246d9449cd905ff61e0c2e8c0c1f9939d12326209f22009480'
    }
  });
  assert.equal(versions().reviewed('1.0.70').binaryHash, HASH_170);
});

test('PREFERRED, HASHES, reviewed() and versionForHash follow the allowlist', () => {
  const api = versions();
  assert.deepEqual(api.PREFERRED, ['1.0.70', '1.0.34']);
  assert.deepEqual(api.HASHES, HASHES);
  assert.equal(api.versionForHash(HASH_170), '1.0.70');
  assert.equal(api.versionForHash(HASH_134), '1.0.34');
  assert.equal(api.versionForHash(HASH_170.toUpperCase()), null);
  assert.equal(api.versionForHash(HASH_170.slice(0, 63)), null);
  assert.equal(api.reviewed('toString'), null);
  assert.equal(api.reviewed(undefined), null);
  assert.equal(api.reviewed('1.0.7'), null);
});

test('REVIEWED, each entry, PREFERRED and HASHES are frozen', () => {
  const { REVIEWED, PREFERRED, HASHES: hashes } = versions();
  assert.equal(Object.isFrozen(REVIEWED), true);
  assert.equal(Object.isFrozen(REVIEWED['1.0.34']), true);
  assert.equal(Object.isFrozen(REVIEWED['1.0.34'].helpers), true);
  assert.equal(Object.isFrozen(REVIEWED['1.0.70']), true);
  assert.equal(Object.isFrozen(REVIEWED['1.0.70'].helpers), true);
  assert.equal(Object.isFrozen(PREFERRED), true);
  assert.equal(Object.isFrozen(hashes), true);
  assert.throws(() => { REVIEWED['9.9.9'] = {}; }, TypeError);
  assert.throws(() => { PREFERRED.push('9.9.9'); }, TypeError);
  assert.throws(() => { hashes.push('f'.repeat(64)); }, TypeError);
});

test('host hash lists stay compatible and reviewedProvider resolves both Grok hashes', () => {
  const host = hostModule();
  assert.deepEqual(host.PROVIDER_HASHES, PROVIDER_HASHES);
  assert.deepEqual(host.REVIEWED_PROVIDER_HASHES.grok, HASHES);
  assert.deepEqual(host.REVIEWED_PROVIDER_HASHES.claude, [CLAUDE_HASH]);
  const current = host.reviewedProvider('grok', HASH_170);
  const previous = host.reviewedProvider('grok', HASH_134);
  const claude = host.reviewedProvider('claude', CLAUDE_HASH);
  assert.deepEqual(current, { hash: HASH_170, version: '1.0.70' });
  assert.deepEqual(previous, { hash: HASH_134, version: '1.0.34' });
  assert.deepEqual(claude, { hash: CLAUDE_HASH, version: null });
  assert.equal(Object.isFrozen(current), true);
  assert.equal(host.reviewedProvider('grok', 'f'.repeat(64)), null);
  assert.equal(host.reviewedProvider('codex', HASH_170), null);
  assert.equal(host.reviewedProvider('grok', undefined), null);
});

test('GROK_CONFIG v2 inserts the cli block and GROK_CONFIG_PREVIOUS is today\'s text', () => {
  const host = hostModule();
  const block = 'load_envrc = false\n\n[cli]\nauto_update = false\ngrove_worktree = false\n\n[compat.claude]';
  assert.equal(host.GROK_CONFIG.includes(block), true);
  assert.equal(host.GROK_CONFIG_PREVIOUS, GROK_CONFIG_PREVIOUS);
  const lines = host.GROK_CONFIG.split('\n');
  const at = lines.indexOf('load_envrc = false');
  assert.deepEqual(lines.slice(at, at + 6), ['load_envrc = false', '', '[cli]', 'auto_update = false', 'grove_worktree = false', '']);
  assert.equal(lines[at + 6], '[compat.claude]');
  const removed = lines.slice(0, at + 2).concat(lines.slice(at + 6)).join('\n');
  assert.equal(removed, host.GROK_CONFIG_PREVIOUS);
});

const HOST_PATH = require.resolve('../lib/provider-native-host');
const HOST_SOURCE = fs.readFileSync(HOST_PATH, 'utf8');

function makePlanFixture(overrides) {
  const base = {
    file: 'C:/fake/codex.exe',
    args: ['--sandbox', 'run'],
    cwd: 'C:/fake/cwd',
    env: { PATH: 'C:/fake/bin', USERPROFILE: 'C:/fake/ownerhome', HOME: 'C:/fake/providerhome', APPDATA: 'C:/fake/providerhome', LOCALAPPDATA: 'C:/fake/providerhome', NATIVE_CONNECT_URL: 'http://127.0.0.1:0/ephemeral' },
    dirPin: 'C:/fake/cwd',
    actor: 'grok',
    codexSHA256: HASH_134,
    providerFile: 'C:/fake/grok.exe',
    nodeFile: process.execPath,
    gitDirectory: 'C:/fake/cwd/.git',
    hubLibDirectory: 'C:/fake/hublib',
    stateDirectory: 'C:/fake/state',
    runtimeDirectory: 'C:/fake/state/runtime',
    runtimeBase: 'C:/fake/state/runtime-base',
    tempDirectory: 'C:/fake/temp',
    providerHome: 'C:/fake/providerhome',
    credentialFiles: ['C:/fake/auth/claude.json'],
    lockFile: null,
    maxWallMs: 30000
  };
  const plan = Object.assign({}, base, overrides);
  plan.codexSHA256 = HASH_134;
  return Object.freeze(plan);
}

function fakeStat({ isFile = true, isDir = false, isSymlink = false, nlink = 1, size = 1024 } = {}) {
  return {
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    nlink,
    size
  };
}

function isDirPath(file) {
  const value = String(file).replace(/\\/g, '/').toLowerCase();
  if (value.includes('config.toml')) return false;
  return value.includes('directory') || value.includes('hublib') || value.includes('.git') || value.includes('state') || value.includes('temp') || value.includes('providerhome') || value.includes('.hub-runtime');
}

function loadHost(t, { plan, providerDigest, configBytes }) {
  const norm = file => path.win32.normalize(String(file)).replace(/\//g, '\\').toLowerCase();
  const files = new Map();
  const handles = new Map();
  let next = 1000;
  let lastRead = '';
  const configPath = path.join(plan.providerHome, 'config.toml');
  if (configBytes) files.set(norm(configPath), Buffer.from(configBytes));
  const fsOverrides = {
    lstatSync(file) {
      const key = norm(file);
      if (files.has(key)) return fakeStat({ isFile: true, nlink: 1, size: files.get(key).length });
      if (norm(file) === norm(process.execPath) || !isDirPath(file)) return fakeStat({ isFile: true, nlink: 1, size: 1024 });
      return fakeStat({ isFile: false, isDir: true, nlink: 1, size: 0 });
    },
    readFileSync(file) {
      const key = norm(file);
      if (files.has(key)) return Buffer.from(files.get(key));
      return Buffer.from('fixture-binary');
    },
    mkdirSync() {},
    openSync(file, flags) {
      const key = norm(file);
      if (flags === 'wx') {
        if (files.has(key)) throw Object.assign(Error('exists fixture'), { code: 'EEXIST' });
        const fd = ++next;
        files.set(key, Buffer.alloc(0));
        handles.set(fd, { path: key, writing: true });
        return fd;
      }
      const fd = ++next;
      const bytes = files.has(key) ? Buffer.from(files.get(key)) : Buffer.from('fixture-binary');
      handles.set(fd, { path: key, bytes, at: 0 });
      lastRead = key;
      return fd;
    },
    readSync(fd, buffer, offset, length) {
      const row = handles.get(fd);
      if (!row || row.writing) return 0;
      const n = Math.min(length, row.bytes.length - row.at);
      if (n <= 0) return 0;
      row.bytes.copy(buffer, offset, row.at, row.at + n);
      row.at += n;
      return n;
    },
    writeFileSync(target, data) {
      const buf = Buffer.from(data);
      if (typeof target === 'number') {
        const row = handles.get(target);
        files.set(row.path, buf);
        return;
      }
      files.set(norm(target), buf);
    },
    writeSync(fd, buffer, offset, length) {
      const row = handles.get(fd);
      if (!row) return 0;
      let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
      if (Buffer.isBuffer(buffer) && typeof offset === 'number') buf = buffer.subarray(offset, typeof length === 'number' ? offset + length : undefined);
      files.set(row.path, Buffer.concat([files.get(row.path) || Buffer.alloc(0), Buffer.from(buf)]));
      return buf.length;
    },
    rmSync(file) { files.delete(norm(file)); },
    fsyncSync() {},
    closeSync(fd) { handles.delete(fd); },
    renameSync(from, to) {
      const source = norm(from);
      const dest = norm(to);
      if (!files.has(source)) throw Object.assign(Error('missing fixture'), { code: 'ENOENT' });
      files.set(dest, files.get(source));
      files.delete(source);
    },
    unlinkSync(file) { files.delete(norm(file)); }
  };
  const nodeFs = require('node:fs');
  const nodeCrypto = require('node:crypto');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === HOST_PATH) {
      if (request === './provider-native-plan') return { createPlan: () => plan };
      if (request === './safe-path') return { localPath: value => value };
    }
    return originalLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = originalLoad; });
  for (const [name, impl] of Object.entries(fsOverrides)) t.mock.method(nodeFs, name, impl);
  t.mock.method(nodeCrypto, 'createHash', () => {
    const file = lastRead;
    return {
      update() { return this; },
      digest() { return String(file).includes('grok.exe') ? providerDigest : plan.codexSHA256; }
    };
  });
  t.mock.method(nodeCrypto, 'randomUUID', () => '22222222-2222-4222-8222-222222222222');
  const loaded = new Module(HOST_PATH, module);
  loaded.filename = HOST_PATH;
  loaded.paths = Module._nodeModulePaths(path.dirname(HOST_PATH));
  loaded._compile(HOST_SOURCE, HOST_PATH);
  return { host: loaded.exports, files, norm, configPath };
}

function FakeChild() {
  EventEmitter.call(this);
  this.stdin = new PassThrough();
  this.stdout = new PassThrough();
  this.stderr = new PassThrough();
  this.killed = false;
}
FakeChild.prototype = Object.create(EventEmitter.prototype);
FakeChild.prototype.kill = function () { this.killed = true; return true; };

win('host launch spawns once when the provider digest is the 1.0.70 hash', t => {
  const plan = makePlanFixture({});
  let spawned = 0;
  const loaded = loadHost(t, { plan, providerDigest: HASH_170 });
  const child = loaded.host.launch({}, () => { spawned++; return new FakeChild(); });
  assert.equal(spawned, 1);
  assert.equal(typeof child.kill, 'function');
});

win('host launch keeps NATIVE_HASH_MISMATCH and never spawns an unknown digest', t => {
  const plan = makePlanFixture({});
  let spawned = 0;
  const loaded = loadHost(t, { plan, providerDigest: 'f'.repeat(64) });
  assert.throws(() => loaded.host.launch({}, () => { spawned++; return new FakeChild(); }), error => error.code === 'NATIVE_HASH_MISMATCH');
  assert.equal(spawned, 0);
});

win('previous private config.toml is replaced by GROK_CONFIG and launch proceeds', t => {
  const plan = makePlanFixture({});
  let spawned = 0;
  const loaded = loadHost(t, { plan, providerDigest: HASH_170, configBytes: GROK_CONFIG_PREVIOUS });
  loaded.host.launch({}, () => { spawned++; return new FakeChild(); });
  assert.equal(spawned, 1);
  assert.equal(loaded.files.get(loaded.norm(loaded.configPath)).equals(Buffer.from(loaded.host.GROK_CONFIG, 'utf8')), true);
});

win('foreign private config.toml fails NATIVE_CONFIG_CHANGED and keeps its bytes', t => {
  const plan = makePlanFixture({});
  const foreign = Buffer.from('SYNTHETIC_FOREIGN_CONFIG_R14');
  let spawned = 0;
  const loaded = loadHost(t, { plan, providerDigest: HASH_170, configBytes: foreign });
  assert.throws(() => loaded.host.launch({}, () => { spawned++; return new FakeChild(); }), error => error.code === 'NATIVE_CONFIG_CHANGED');
  assert.equal(spawned, 0);
  assert.equal(loaded.files.get(loaded.norm(loaded.configPath)).equals(foreign), true);
});

test('sandbox hash list and reviewedProvider accept 1.0.70', () => {
  const sandbox = sandboxModule();
  assert.deepEqual(sandbox.PROVIDER_HASHES, PROVIDER_HASHES);
  assert.deepEqual(sandbox.REVIEWED_PROVIDER_HASHES.grok, HASHES);
  assert.equal(sandbox.reviewedProvider('grok', HASH_170).version, '1.0.70');
});

win('sandbox launch still rejects a real digest that is not on the list', t => {
  const { launch } = sandboxModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-sandbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const providerFile = path.join(dir, 'grok.exe');
  const codexFile = path.join(dir, 'codex.exe');
  fs.writeFileSync(providerFile, 'dummy-provider-content');
  fs.writeFileSync(codexFile, 'dummy-codex-content');
  const codexHash = crypto.createHash('sha256').update(fs.readFileSync(codexFile)).digest('hex');
  let spawned = 0;
  assert.throws(() => launch({
    provider: 'grok', providerFile, providerArgs: [], codexFile, cwd: dir,
    rootFingerprint: 'b'.repeat(64), codexSHA256: codexHash, networkAccess: false, stateRoots: []
  }, () => { spawned++; return {}; }), error => error.code === 'ERR_HASH_MISMATCH');
  assert.equal(spawned, 0);
});

win('sandbox launch passes the hash check when the mocked digest is 1.0.70', t => {
  // sha256File calls crypto.createHash, so the digest is mockable there (not only via reviewedProvider).
  const { launch } = sandboxModule();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-sandbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const providerFile = path.join(dir, 'grok.exe');
  const codexFile = path.join(dir, 'codex.exe');
  fs.writeFileSync(providerFile, 'synthetic-provider-bytes');
  fs.writeFileSync(codexFile, 'synthetic-codex-bytes');
  t.mock.method(crypto, 'createHash', () => ({ update() { return this; }, digest: () => HASH_170 }));
  let spawned = 0;
  const child = launch({
    provider: 'grok', providerFile, providerArgs: [], codexFile, cwd: dir,
    rootFingerprint: 'b'.repeat(64), codexSHA256: HASH_170, networkAccess: false, stateRoots: []
  }, () => { spawned++; return {}; });
  assert.equal(spawned, 1);
  assert.equal(typeof child.backendId, 'string');
});

test('grokSources and grokSlot use the fixed paths and reject an unreviewed version', () => {
  const { grokSources, grokSlot } = binaryModule();
  assert.deepEqual(grokSources('C:\\h', '1.0.70'), [
    path.win32.join('C:\\h', '.grok', 'downloads', 'grok-1.0.70-windows-x86_64'),
    path.win32.join('C:\\h', '.grok', 'bin', 'grok.exe'),
    path.win32.join('C:\\h', '.grok', 'bin', 'grok.exe.old')
  ]);
  assert.equal(grokSlot('C:\\h\\AppData\\Local\\ProjectHub', '1.0.70'), path.win32.join('C:\\h\\AppData\\Local\\ProjectHub', 'runtime-binaries', 'grok', HASH_170, 'grok.exe'));
  assert.equal(Object.isFrozen(grokSources('C:\\h', '1.0.70')), true);
  assert.throws(() => grokSources('C:\\h', '9.9.9'), error => error.code === 'NATIVE_BINARY_UNAVAILABLE');
  assert.throws(() => grokSlot('C:\\h\\AppData\\Local\\ProjectHub', '9.9.9'), error => error.code === 'NATIVE_BINARY_UNAVAILABLE');
});

test('unreviewed() carries the 409 code and the readable Grok text', () => {
  const { unreviewed } = binaryModule();
  const hashed = unreviewed({ hashPrefix: '1e03c16cf2bd' });
  assert.equal(hashed.code, 'NATIVE_GROK_VERSION_UNREVIEWED');
  assert.equal(hashed.status, 409);
  assert.equal(hashed.notStarted, true);
  assert.equal(hashed.hashPrefix, '1e03c16cf2bd');
  assert.equal(hashed.override, null);
  assert.equal(hashed.message.includes('1e03c16cf2bd…'), true);
  assert.equal(hashed.message.includes('1.0.70、1.0.34'), true);
  assert.equal(hashed.message.includes('（代碼：NATIVE_GROK_VERSION_UNREVIEWED）'), true);
  const override = unreviewed({ override: '9.9.9' });
  assert.equal(override.message.includes('PROJECT_HUB_GROK_VERSION=9.9.9'), true);
  assert.equal(override.override, '9.9.9');
});

const OWNER = 'C:\\Users\\fixture';
const RUNTIME = OWNER + '\\AppData\\Local\\ProjectHub';
function slot(version, hash) {
  return path.win32.join(RUNTIME, 'runtime-binaries', 'grok', hash, 'grok.exe');
}
function sourceRel(name) {
  return path.win32.join('.grok', ...name);
}

function mockBroker(t, handler) {
  const scoped = require('../lib/scoped-file');
  const calls = [];
  t.mock.method(scoped, 'identity', async root => {
    assert.equal(root, OWNER);
    return { rootFingerprint: 'a'.repeat(64) };
  });
  t.mock.method(scoped, 'privateInvoke', async request => {
    calls.push(request);
    return handler(request, calls);
  });
  return calls;
}

win('grokFile (a) reuses a hash-correct 1.0.70 slot and never copies', async t => {
  noOverride(t);
  const calls = mockBroker(t, request => {
    assert.equal(request.mode, 'private-binary-inspect');
    return { sha256: HASH_170, bytes: 32 };
  });
  const destination = await binaryModule().grokFile(OWNER, RUNTIME, { identity: async root => ({ rootFingerprint: 'a'.repeat(64) }) });
  assert.equal(destination, slot('1.0.70', HASH_170));
  assert.equal(calls.some(call => call.mode === 'private-binary-copy'), false);
});

win('grokFile (b) copies the first reviewed source when the slot is missing', async t => {
  noOverride(t);
  let copied = false;
  const calls = mockBroker(t, request => {
    if (request.mode === 'private-binary-inspect') {
      if (!copied) throw Object.assign(Error('synthetic missing'), { code: 'NOT_FOUND' });
      return { sha256: HASH_170, bytes: 32 };
    }
    copied = true;
    return { created: true, sha256: HASH_170 };
  });
  const destination = await binaryModule().grokFile(OWNER, RUNTIME);
  assert.equal(destination, slot('1.0.70', HASH_170));
  const copy = calls.find(call => call.mode === 'private-binary-copy');
  assert.equal(copy.sourcePath, sourceRel(['downloads', 'grok-1.0.70-windows-x86_64']));
  assert.equal(copy.sourceHash, HASH_170);
});

win('grokFile (c) tries the three 1.0.70 sources in order', async t => {
  noOverride(t);
  let copies = 0;
  const calls = mockBroker(t, request => {
    if (request.mode === 'private-binary-inspect') {
      if (copies < 3) throw Object.assign(Error('synthetic missing'), { code: 'NOT_FOUND' });
      return { sha256: HASH_170, bytes: 32 };
    }
    copies++;
    if (copies < 3) throw Object.assign(Error('sourceHash mismatch'), { code: 'SOURCE_HASH_MISMATCH' });
    return { created: true, sha256: request.sourceHash };
  });
  const destination = await binaryModule().grokFile(OWNER, RUNTIME);
  assert.equal(destination, slot('1.0.70', HASH_170));
  assert.deepEqual(calls.filter(call => call.mode === 'private-binary-copy').map(call => call.sourcePath), [
    sourceRel(['downloads', 'grok-1.0.70-windows-x86_64']),
    sourceRel(['bin', 'grok.exe']),
    sourceRel(['bin', 'grok.exe.old'])
  ]);
});

win('grokFile (d) falls through to the 1.0.34 slot', async t => {
  noOverride(t);
  mockBroker(t, request => {
    if (request.mode === 'private-binary-inspect' && String(request.path).includes(HASH_134)) return { sha256: HASH_134, bytes: 16 };
    if (request.mode === 'private-binary-inspect') throw Object.assign(Error('synthetic missing'), { code: 'NOT_FOUND' });
    throw Object.assign(Error('sourceHash mismatch'), { code: 'SOURCE_HASH_MISMATCH' });
  });
  const destination = await binaryModule().grokFile(OWNER, RUNTIME);
  assert.equal(destination, slot('1.0.34', HASH_134));
});

win('grokFile (e) reports the live install prefix, or null when grok.exe is absent', async t => {
  noOverride(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-grok-file-'));
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-grok-file-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(missing, { recursive: true, force: true }); });
  const bytes = Buffer.from('synthetic grok.exe bytes for the unreviewed prefix\n');
  const live = path.win32.join(root, '.grok', 'bin', 'grok.exe');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, bytes);
  const prefix = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const scoped = require('../lib/scoped-file');
  t.mock.method(scoped, 'identity', async owner => ({ rootFingerprint: 'a'.repeat(64), owner }));
  t.mock.method(scoped, 'privateInvoke', async request => {
    if (request.mode === 'private-binary-inspect') throw Object.assign(Error('synthetic missing'), { code: 'NOT_FOUND' });
    throw Object.assign(Error('sourceHash mismatch'), { code: 'SOURCE_HASH_MISMATCH' });
  });
  const runtimeOf = owner => path.win32.join(owner, 'AppData', 'Local', 'ProjectHub');
  await assert.rejects(binaryModule().grokFile(root, runtimeOf(root)), error => error.code === 'NATIVE_GROK_VERSION_UNREVIEWED' && error.hashPrefix === prefix && error.override === null);
  await assert.rejects(binaryModule().grokFile(missing, runtimeOf(missing)), error => error.code === 'NATIVE_GROK_VERSION_UNREVIEWED' && error.hashPrefix === null);
});

win('grokFile (f) rejects an unreviewed override before any broker call', async t => {
  const scoped = require('../lib/scoped-file');
  let called = false;
  t.mock.method(scoped, 'privateInvoke', async () => { called = true; throw Error('must not run'); });
  t.mock.method(scoped, 'identity', async () => { called = true; throw Error('must not run'); });
  await assert.rejects(binaryModule().grokFile(OWNER, RUNTIME, { version: '9.9.9' }), error => error.code === 'NATIVE_GROK_VERSION_UNREVIEWED' && error.override === '9.9.9');
  assert.equal(called, false);
});

win('grokFile (g) a 1.0.34 override never requests the 1.0.70 slot', async t => {
  const calls = mockBroker(t, request => {
    assert.equal(String(request.path).includes(HASH_134), true);
    assert.equal(String(request.path).includes(HASH_170), false);
    if (request.sourceHash !== undefined) assert.equal(request.sourceHash, HASH_134);
    if (request.mode === 'private-binary-inspect') return { sha256: HASH_134, bytes: 16 };
    return { created: true, sha256: HASH_134 };
  });
  const destination = await binaryModule().grokFile(OWNER, RUNTIME, { version: '1.0.34' });
  assert.equal(destination, slot('1.0.34', HASH_134));
  assert.equal(calls.length > 0, true);
  assert.equal(calls.every(call => call.sourceHash === undefined || call.sourceHash === HASH_134), true);
});

test('messageFor has the three NATIVE_GROK_VERSION_UNREVIEWED texts and keeps the auth text', () => {
  const { messageFor } = require('../lib/native-provider-messages');
  assert.equal(messageFor('NATIVE_GROK_VERSION_UNREVIEWED', { override: '9.9.9' }), 'Hub 設定的 Grok 版本（PROJECT_HUB_GROK_VERSION=9.9.9）不在已審核清單（1.0.70、1.0.34）；未啟動。請改回清單內的版本或移除此設定。（代碼：NATIVE_GROK_VERSION_UNREVIEWED）');
  assert.equal(messageFor('NATIVE_GROK_VERSION_UNREVIEWED', { hashPrefix: '1e03c16cf2bd' }), 'Hub 找不到已審核的 Grok CLI（已審核版本：1.0.70、1.0.34）。目前安裝的 grok.exe 雜湊 1e03c16cf2bd… 尚未審核；請勿回滾，等待 Hub 更新納入新版本，並保留 ~/.grok/downloads 內的已審核發行檔。（代碼：NATIVE_GROK_VERSION_UNREVIEWED）');
  assert.equal(messageFor('NATIVE_GROK_VERSION_UNREVIEWED'), 'Hub 找不到已審核的 Grok CLI（已審核版本：1.0.70、1.0.34），而且讀不到目前安裝的 grok.exe。請在一般終端機確認 Grok 已安裝，或保留 ~/.grok/downloads 內的已審核發行檔。（代碼：NATIVE_GROK_VERSION_UNREVIEWED）');
  assert.equal(messageFor('GROK_NATIVE_AUTH_UNAVAILABLE'), 'Grok 回報登入無效或已過期，這一回合沒有完成。請按「更新 Grok 登入」（或在一般終端機執行 grok login），完成後再送一次。（代碼：GROK_NATIVE_AUTH_UNAVAILABLE）');
});

test('codeOf admits NATIVE_GROK_VERSION_UNREVIEWED', () => {
  const { codeOf } = require('../lib/native-provider-diagnostic');
  assert.equal(codeOf({ code: 'NATIVE_GROK_VERSION_UNREVIEWED' }), 'NATIVE_GROK_VERSION_UNREVIEWED');
});

test('createPlan Grok env has the eleven hardened keys and the claude branch is unchanged', () => {
  const { createPlan } = require('../lib/provider-native-plan');
  const base = {
    actor: 'claude', cwd: 'C:\\Workspaces\\project', rootFingerprint: 'a'.repeat(64),
    ownerHome: 'C:\\Users\\example-user', runtimeBase: 'C:\\Users\\example-user\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\provider.exe', codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: 'b'.repeat(64), nodeFile: 'C:\\Tools\\node\\node.exe', gitDirectory: 'C:\\Tools\\git',
    hubLibDirectory: 'C:\\Tools\\hublib', providerArgs: ['--flag', 'value'],
    proxyUrl: 'http://hub:' + 'c'.repeat(64) + '@127.0.0.1:8080', systemRoot: 'C:\\Windows'
  };
  const grok = createPlan({ ...base, actor: 'grok' });
  assert.equal(grok.env.GROK_HOME, grok.providerHome);
  assert.equal(grok.env.GROK_AUTH_PATH, grok.credentialFiles[0]);
  assert.equal(grok.env.GROK_MEMORY, '0');
  assert.equal(grok.env.GROK_DISABLE_AUTOUPDATER, '1');
  assert.equal(grok.env.GROK_DISABLE_EXPERIMENTS, '1');
  assert.equal(grok.env.GROK_WORKTREE_TYPE, 'copy');
  assert.equal(grok.env.GROK_CLONE, '0');
  assert.equal(grok.env.DISABLE_TELEMETRY, '1');
  assert.equal(grok.env.DISABLE_ERROR_REPORTING, '1');
  assert.equal(grok.env.DO_NOT_TRACK, '1');
  assert.equal(grok.env.OTEL_TRACES_EXPORTER, 'none');
  const claude = createPlan(base);
  assert.equal(claude.env.DISABLE_TELEMETRY, '1');
  assert.equal(claude.env.DISABLE_ERROR_REPORTING, '1');
  assert.equal(claude.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(claude.env.GROK_HOME, undefined);
  assert.equal(claude.env.GROK_DISABLE_AUTOUPDATER, undefined);
  assert.equal(claude.env.GROK_DISABLE_EXPERIMENTS, undefined);
  assert.equal(claude.env.GROK_WORKTREE_TYPE, undefined);
  assert.equal(claude.env.GROK_CLONE, undefined);
});

function serviceFixture(t, callbacks = {}, providerDigest = HASH_134) {
  let inode = 1n;
  const settings = {
    ownerHome: 'C:\\Users\\fixture', runtimeBase: 'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\grok.exe', codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: require('../lib/native-cli-update').KNOWN, nodeFile: process.execPath,
    gitDirectory: 'C:\\Tools\\git', hubLibDirectory: 'C:\\Tools\\hub\\lib', systemRoot: 'C:\\Windows'
  };
  const scoped = require('../lib/scoped-file');
  const artifacts = require('../lib/native-cli-update');
  const safe = require('../lib/safe-path');
  const egress = require('../lib/provider-egress');
  t.mock.method(scoped, 'identity', async file => {
    assert.equal(file, settings.runtimeBase);
    return { rootFingerprint: 'b'.repeat(64) };
  });
  t.mock.method(artifacts, 'digestFile', file => String(file).endsWith('codex.exe') ? artifacts.KNOWN : providerDigest);
  t.mock.method(safe, 'localPath', file => file);
  t.mock.method(fs, 'lstatSync', (_file, opts) => ({ isFile: () => true, nlink: opts?.bigint ? 1n : 1, size: opts?.bigint ? 123n : 123, ino: inode, dev: 1n, mtimeNs: 10n }));
  t.mock.method(fs, 'readFileSync', () => { throw Error('CREDENTIAL_CONTENT_READ_FORBIDDEN'); });
  t.mock.method(egress, 'create', async () => ({ proxyUrl: 'http://hub:' + 'f'.repeat(64) + '@127.0.0.1:12345', snapshot: () => ({}), close: async () => {} }));
  const service = new NativeProviderService({
    resolveWorkspace: async () => ({ project: 'synthetic', task: 't', dir: 'C:\\Synthetic\\workspace', rootFingerprint: 'a'.repeat(64), run: 'workspace-run' }),
    profile: () => ({ ...settings }),
    modelFlag: (_actor, model) => model === 'Grok 4.6' ? 'grok-4.6' : model === 'Sonnet' ? 'sonnet' : '',
    effortFlag: () => 'medium',
    supervisedSpawn: () => { throw Error('NO_CHILD_EXPECTED'); },
    dispose: async () => {},
    ...callbacks
  });
  return { service, settings };
}

const grokScope = { actor: 'grok', project: 'synthetic', task: 't', model: 'Grok 4.6', effort: '中' };

test('service preview of the 1.0.70 digest reports that version and the pinned runtime profile', async t => {
  const { service } = serviceFixture(t, {}, HASH_170);
  const first = await service.preview(grokScope);
  const second = await service.preview(grokScope);
  assert.equal(first.review.providerSHA256, HASH_170);
  assert.equal(first.review.providerVersion, '1.0.70');
  assert.equal(first.review.runtimeProfileId, RUNTIME_PROFILE_ID);
  assert.match(first.review.runtimeProfileId, /^runtime-[0-9a-f]{64}$/);
  assert.equal(second.review.runtimeProfileId, first.review.runtimeProfileId);
});

test('service preview of the 1.0.34 digest reports providerVersion 1.0.34', async t => {
  const { service } = serviceFixture(t, {}, HASH_134);
  const preview = await service.preview(grokScope);
  assert.equal(preview.review.providerSHA256, HASH_134);
  assert.equal(preview.review.runtimeProfileId, RUNTIME_PROFILE_ID);
  assert.match(preview.review.runtimeProfileId, /^runtime-[0-9a-f]{64}$/);
  assert.equal(preview.review.providerVersion, '1.0.34');
});

test('service preview rejects an unknown Grok digest as NATIVE_GROK_VERSION_UNREVIEWED', async t => {
  const digest = 'ab'.repeat(32);
  const { service } = serviceFixture(t, {}, digest);
  await assert.rejects(service.preview(grokScope), error => error.code === 'NATIVE_GROK_VERSION_UNREVIEWED' && error.status === 409 && error.message.includes(digest.slice(0, 12)));
});

test('service preview keeps NATIVE_PROFILE_UNAVAILABLE for an unknown Claude digest', async t => {
  const { service, settings } = serviceFixture(t, {}, 'cd'.repeat(32));
  settings.providerFile = 'C:\\Tools\\provider\\claude.exe';
  await assert.rejects(service.preview({ ...grokScope, actor: 'claude', model: 'Sonnet' }), error => error.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('a successful Claude review has no providerVersion key', async t => {
  const { service, settings } = serviceFixture(t, {}, CLAUDE_HASH);
  settings.providerFile = 'C:\\Tools\\provider\\claude.exe';
  const preview = await service.preview({ ...grokScope, actor: 'claude', model: 'Sonnet' });
  assert.equal(Object.hasOwn(preview.review, 'providerVersion'), false);
  assert.equal(preview.review.providerSHA256, CLAUDE_HASH);
});
