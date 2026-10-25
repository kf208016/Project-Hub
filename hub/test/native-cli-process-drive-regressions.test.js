'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const {NativeCliUpdater, inventory} = require('../lib/native-cli-update');
const {create} = require('../lib/procwatch');
const {createChecker} = require('../lib/local-drives');

const PROFILE = 'native-command-lifetime-0.154.0';
const RELATIVE = 'x86_64-pc-windows-msvc/bin/codex.exe';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');

function tar(entries) {
  const parts = [];
  for (const [name, data, type = '0'] of entries) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(String(bytes.length.toString(8)).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

function registry(version, binary) {
  const mainPackage = {
    name: '@openai/codex',
    version,
    optionalDependencies: {'@openai/codex-win32-x64': 'npm:@openai/codex@' + version + '-win32-x64'},
    scripts: {postinstall: 'node should-not-run.cjs'},
  };
  const nativePackage = {name: '@openai/codex', version: version + '-win32-x64', os: ['win32'], cpu: ['x64']};
  const main = tar([
    ['package/package.json', JSON.stringify(mainPackage)],
    ['package/should-not-run.cjs', 'require("fs").writeFileSync("INSTALL_SCRIPT_RAN","bad")'],
  ]);
  const native = tar([
    ['package/package.json', JSON.stringify(nativePackage)],
    ['package/vendor/' + RELATIVE, binary],
  ]);
  const meta = (asset, exact) => Buffer.from(JSON.stringify({
    name: '@openai/codex',
    version: exact,
    dist: {
      integrity: sri(asset),
      tarball: 'https://registry.npmjs.org/@openai/codex/-/codex-' + exact + '.tgz',
    },
    ...(exact === version ? {optionalDependencies: mainPackage.optionalDependencies} : {os: ['win32'], cpu: ['x64']}),
  }));
  return new Map([
    ['https://registry.npmjs.org/%40openai%2Fcodex/' + version, meta(main, version)],
    ['https://registry.npmjs.org/%40openai%2Fcodex/' + version + '-win32-x64', meta(native, version + '-win32-x64')],
    ['https://registry.npmjs.org/@openai/codex/-/codex-' + version + '.tgz', main],
    ['https://registry.npmjs.org/@openai/codex/-/codex-' + version + '-win32-x64.tgz', native],
  ]);
}

function setupUpdater(t, {isAlive}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-regressions-'));
  const beforePath = process.env.PATH;
  const binary = Buffer.from('synthetic fixture executable');
  const data = registry('0.165.0', binary);
  const expectedVendor = path.join(root, 'expected/vendor');
  fs.mkdirSync(path.dirname(path.join(expectedVendor, RELATIVE)), {recursive: true});
  fs.writeFileSync(path.join(expectedVendor, RELATIVE), binary);
  const knownHash = sha(binary);
  const knownVendorHash = inventory(expectedVendor);
  t.after(() => {
    process.env.PATH = beforePath;
    fs.rmSync(root, {recursive: true, force: true});
  });
  const updater = new NativeCliUpdater({
    root,
    knownHash,
    knownVendorHash,
    reviewedVersions: {
      '0.154.0': {binaryHash: knownHash, vendorHash: knownVendorHash, lifetimeProfile: PROFILE},
      '0.164.0': {binaryHash: knownHash, vendorHash: knownVendorHash, lifetimeProfile: PROFILE},
    },
    read: async url => {
      assert.ok(data.has(url), url);
      return data.get(url);
    },
    probe: async () => {
      throw new Error('probe must not run for an unverified 0.165.0 candidate');
    },
    processIdentity: {
      self: () => ({pid: process.pid, created: 1_700_000_000_000}),
      isAlive,
    },
  });
  return {root, updater};
}

function lockPath(root) {
  return path.join(root, '_hub', 'cli', 'update.lock');
}

function writeLock(root, contents) {
  const file = lockPath(root);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, contents);
  return file;
}

function staleArchives(root) {
  const dir = path.join(root, '_hub', 'cli');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^update\.lock\.stale-.+\.json$/.test(name)) : [];
}

function driveMap(overrides = {}) {
  const map = {};
  for (let i = 0; i < 26; i++) map[String.fromCharCode(65 + i)] = 3;
  return {...map, ...overrides};
}

test('A3 a stale update.lock whose owner is dead is reclaimed; 0.165.0 apply ends blocked', {timeout: 60000}, async t => {
  const {root, updater} = setupUpdater(t, {isAlive: () => false});
  const preview = await updater.preview('0.165.0');
  writeLock(root, JSON.stringify({version: 1, pid: 424242, created: 1, at: 1_600_000_000_000}) + '\n');
  const result = await updater.apply({version: '0.165.0', token: preview.token, confirm: true});
  assert.equal(result.phase, 'blocked');
  assert.notEqual(result.phase, 'UPDATE_FAILED');
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.equal(staleArchives(root).length, 1);
});

test('A3 an unreadable update.lock is reclaimed the same way', {timeout: 60000}, async t => {
  const {root, updater} = setupUpdater(t, {isAlive: () => false});
  const preview = await updater.preview('0.165.0');
  writeLock(root, '{not json');
  const result = await updater.apply({version: '0.165.0', token: preview.token, confirm: true});
  assert.equal(result.phase, 'blocked');
  assert.equal(fs.existsSync(lockPath(root)), false);
  assert.equal(staleArchives(root).length, 1);
});

test('A3 a live update.lock owner is UPDATE_IN_PROGRESS and the lock bytes are unchanged', {timeout: 60000}, async t => {
  const {root, updater} = setupUpdater(t, {isAlive: () => true});
  const preview = await updater.preview('0.165.0');
  const bytes = Buffer.from(JSON.stringify({version: 1, pid: process.pid, created: 1, at: 1_600_000_000_000}) + '\n');
  const file = writeLock(root, bytes);
  await assert.rejects(
    updater.apply({version: '0.165.0', token: preview.token, confirm: true}),
    err => err && err.code === 'UPDATE_IN_PROGRESS',
  );
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('A5 messageFor maps NT_REJECTED_C0000043 to a 關閉/重新預覽 string and other codes to null', () => {
  const {messageFor} = require('../lib/rooted-move');
  const pinned = messageFor('NT_REJECTED_C0000043');
  assert.equal(typeof pinned, 'string');
  assert.match(pinned, /關閉/);
  assert.match(pinned, /重新預覽/);
  assert.equal(messageFor('NT_REJECTED_C0000034'), null);
});

test('L3 scan() then scan({maxAgeMs:10000}) within the window queries once; a later plain scan queries again', async () => {
  let queries = 0;
  const text = '      1       0 Sat Oct  3 08:00:00 2026 /sbin/init\n';
  const w = create({
    platform: 'linux',
    selfPid: 42,
    exec: async cmd => {
      queries += 1;
      assert.equal(cmd, 'ps');
      return text;
    },
    readlink: () => '/work',
    projects: () => [],
    log: () => {},
  });
  await w.scan();
  assert.equal(queries, 1);
  await w.scan({maxAgeMs: 10000});
  assert.equal(queries, 1);
  await w.scan();
  assert.equal(queries, 2);
});

test('L4 createChecker TTL is 5000 ms; remote (4) and unknown (0) drive letters still throw', () => {
  let now = 1000;
  let queries = 0;
  const checker = createChecker({
    query: () => {
      queries += 1;
      return driveMap();
    },
    now: () => now,
    platform: 'win32',
  });
  checker('C:\\foo');
  now = 5999;
  checker('C:\\foo');
  assert.equal(queries, 1);
  now = 6000;
  checker('C:\\foo');
  assert.equal(queries, 2);

  const remote = createChecker({query: () => driveMap({Z: 4}), now: () => 1000, platform: 'win32'});
  const unknown = createChecker({query: () => driveMap({Y: 0}), now: () => 1000, platform: 'win32'});
  assert.throws(() => remote('Z:\\share'));
  assert.throws(() => unknown('Y:\\mystery'));
});
