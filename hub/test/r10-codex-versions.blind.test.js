'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { NativeCliUpdater, inventory } = require('../lib/native-cli-update');

const HASH_154 = 'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde';
const VENDOR_154 = 'd348d8f114f6244458beb40c578b41656030e7e3c66b9e8866c01f7d4a6b7ae7';
const HASH_164 = '6f267830b029ee25d9339864aa867cd45de9f8fd4c5ea007d2e63c13a0c66d36';
const VENDOR_164 = 'b2efa5f01d47b2ea423b08c1f0b250e4ee6d606d78c26b940a9ec0dc910b60de';
const PROFILE = 'native-command-lifetime-0.154.0';
const RELATIVE = 'x86_64-pc-windows-msvc/bin/codex.exe';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');

function loadAllowList() {
  const candidates = [
    '../lib/codex-versions',
    '../lib/codex-version-allow-list',
    '../lib/reviewed-codex-versions',
  ];
  const missing = [];
  for (const id of candidates) {
    try {
      return require(id);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      missing.push(id);
    }
  }
  assert.fail('reviewed Codex allow-list module not found; tried ' + missing.join(', '));
}

function versionTable(mod) {
  const isTable = value => value && typeof value === 'object' && !Array.isArray(value) && value['0.154.0'] && value['0.164.0'];
  if (isTable(mod)) return mod;
  if (mod && typeof mod === 'object') {
    for (const value of Object.values(mod)) if (isTable(value)) return value;
  }
  assert.fail('allow-list module does not export a table of 0.154.0 and 0.164.0');
}

function probeBody(version) {
  return {
    version,
    modelCalled: false,
    insideWrite: true,
    outsideWriteDenied: true,
    readBoundary: 'broader-than-task',
    networkBoundary: 'incomplete',
    lifetimeProfile: PROFILE,
  };
}

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

function registry(version, { badBytes = false, binary } = {}) {
  const mainPackage = {
    name: '@openai/codex',
    version,
    optionalDependencies: { '@openai/codex-win32-x64': 'npm:@openai/codex@' + version + '-win32-x64' },
    scripts: { postinstall: 'node should-not-run.cjs' },
  };
  const nativePackage = { name: '@openai/codex', version: version + '-win32-x64', os: ['win32'], cpu: ['x64'] };
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
    ...(exact === version ? { optionalDependencies: mainPackage.optionalDependencies } : { os: ['win32'], cpu: ['x64'] }),
  }));
  return new Map([
    ['https://registry.npmjs.org/%40openai%2Fcodex/' + version, meta(main, version)],
    ['https://registry.npmjs.org/%40openai%2Fcodex/' + version + '-win32-x64', meta(native, version + '-win32-x64')],
    ['https://registry.npmjs.org/@openai/codex/-/codex-' + version + '.tgz', main],
    ['https://registry.npmjs.org/@openai/codex/-/codex-' + version + '-win32-x64.tgz', badBytes ? Buffer.from('wrong payload') : native],
  ]);
}

function setup(t, { version = '0.154.0', probeVersion = version, binary = Buffer.from('synthetic fixture executable') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-slot-'));
  const beforePath = process.env.PATH;
  const data = registry(version, { binary });
  let probes = 0;
  const knownHash = sha(binary);
  const expectedVendor = path.join(root, 'expected/vendor');
  fs.mkdirSync(path.dirname(path.join(expectedVendor, RELATIVE)), { recursive: true });
  fs.writeFileSync(path.join(expectedVendor, RELATIVE), binary);
  const knownVendorHash = inventory(expectedVendor);
  t.after(() => {
    process.env.PATH = beforePath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const updater = new NativeCliUpdater({
    root,
    knownHash,
    knownVendorHash,
    reviewedVersions: { '0.154.0': { binaryHash: knownHash, vendorHash: knownVendorHash, lifetimeProfile: PROFILE }, '0.164.0': { binaryHash: knownHash, vendorHash: knownVendorHash, lifetimeProfile: PROFILE } },
    read: async url => {
      assert.ok(data.has(url), url);
      return data.get(url);
    },
    probe: async () => {
      probes += 1;
      return probeBody(probeVersion);
    },
  });
  return { root, updater, version, knownHash, knownVendorHash, probes: () => probes };
}

function writeSlot(root, { cliVersion, binary, binaryHash, vendorHash }) {
  const id = crypto.randomUUID();
  const folder = path.join(root, '_hub/cli/slots', id);
  const vendor = path.join(folder, 'native/vendor');
  fs.mkdirSync(path.dirname(path.join(vendor, RELATIVE)), { recursive: true });
  fs.writeFileSync(path.join(vendor, RELATIVE), binary);
  const record = {
    schema: 1,
    id,
    version: cliVersion,
    state: 'activated',
    binaryHash,
    vendorHash,
    ignoreScripts: true,
    probe: null,
    error: null,
  };
  fs.writeFileSync(path.join(folder, 'record.json'), JSON.stringify(record) + '\n');
  return { id, folder, recordPath: path.join(folder, 'record.json') };
}

function writePointer(root, pointer) {
  fs.mkdirSync(path.join(root, '_hub/cli'), { recursive: true });
  fs.writeFileSync(path.join(root, '_hub/cli/active.json'), JSON.stringify(pointer) + '\n');
}

test('reviewed allow-list is exactly 0.154.0 and 0.164.0 with the measured hashes', () => {
  const table = versionTable(loadAllowList());
  assert.deepEqual(Object.keys(table).sort(), ['0.154.0', '0.164.0']);
  assert.deepEqual(table['0.154.0'], { binaryHash: HASH_154, vendorHash: VENDOR_154, lifetimeProfile: PROFILE });
  assert.deepEqual(table['0.164.0'], { binaryHash: HASH_164, vendorHash: VENDOR_164, lifetimeProfile: PROFILE });
});

test('active() loads a 0.164.0 slot and the existing 0.154.0 pointer, and rejects 0.163.0 or crossed hashes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-active-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = Buffer.from('synthetic fixture executable');
  const expectedVendor = path.join(root, 'expected/vendor');
  fs.mkdirSync(path.dirname(path.join(expectedVendor, RELATIVE)), { recursive: true });
  fs.writeFileSync(path.join(expectedVendor, RELATIVE), binary);
  const binaryHash = sha(binary);
  const vendorHash = inventory(expectedVendor);
  const updater = new NativeCliUpdater({
    root,
    knownHash: binaryHash,
    knownVendorHash: vendorHash,
    reviewedVersions: { '0.154.0': { binaryHash, vendorHash, lifetimeProfile: PROFILE }, '0.164.0': { binaryHash, vendorHash, lifetimeProfile: PROFILE } },
    read: async () => { throw new Error('registry must not be contacted'); },
    probe: async () => { throw new Error('probe must not run while reading active.json'); },
  });

  const slot164 = writeSlot(root, { cliVersion: '0.164.0', binary, binaryHash, vendorHash });
  writePointer(root, { version: 1, slot: slot164.id, cliVersion: '0.164.0', binaryHash, vendorHash });
  const active164 = updater.active();
  assert.equal(active164.version, '0.164.0');
  assert.equal(active164.slot, slot164.id);
  assert.equal(active164.binaryHash, binaryHash);
  assert.equal(active164.file, path.join(slot164.folder, 'native/vendor', RELATIVE));

  const slot154 = writeSlot(root, { cliVersion: '0.154.0', binary, binaryHash, vendorHash });
  writePointer(root, { version: 1, slot: slot154.id, cliVersion: '0.154.0', binaryHash, vendorHash });
  assert.equal(updater.active().version, '0.154.0');

  const slot163 = writeSlot(root, { cliVersion: '0.163.0', binary, binaryHash, vendorHash });
  writePointer(root, { version: 1, slot: slot163.id, cliVersion: '0.163.0', binaryHash, vendorHash });
  assert.throws(() => updater.active(), { code: 'ACTIVE_STATE_REJECTED' });

  const crossed = writeSlot(root, { cliVersion: '0.164.0', binary, binaryHash: HASH_154, vendorHash: VENDOR_154 });
  writePointer(root, { version: 1, slot: crossed.id, cliVersion: '0.164.0', binaryHash: HASH_154, vendorHash: VENDOR_154 });
  assert.throws(() => updater.active(), { code: 'ACTIVE_STATE_REJECTED' });
});

test('preview/apply of a version off the allow-list is blocked and its slot folder is removed', async t => {
  const f = setup(t, { version: '0.165.0' });
  const preview = await f.updater.preview(f.version);
  const result = await f.updater.apply({ version: f.version, token: preview.token, confirm: true });
  assert.equal(result.phase, 'blocked');
  assert.equal(result.blocker, 'UNVERIFIED_CODEX_PROTOCOL_VERSION');
  assert.equal(result.oldVersionRetained, true);
  assert.equal(f.probes(), 0);
  const slots = path.join(f.root, '_hub/cli/slots');
  if (result.slot) assert.equal(fs.existsSync(path.join(slots, result.slot)), false);
  else assert.deepEqual(fs.existsSync(slots) ? fs.readdirSync(slots) : [], []);
  assert.equal(f.updater.active(), null);
});

test('probe receipt records the probed version: 0.164.0 is kept for 0.164.0 and rejected for 0.154.0', async t => {
  const next = setup(t, { version: '0.164.0', probeVersion: '0.164.0' });
  const preview = await next.updater.preview(next.version);
  const result = await next.updater.apply({ version: next.version, token: preview.token, confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'activated');
  assert.equal(result.version, '0.164.0');
  const record = JSON.parse(fs.readFileSync(path.join(next.root, '_hub/cli/slots', result.slot, 'record.json'), 'utf8'));
  assert.equal(record.version, '0.164.0');
  assert.equal(record.probe.version, '0.164.0');
  assert.equal(record.health.version, '0.164.0');
  assert.equal(record.probe.lifetimeProfile, PROFILE);
  assert.equal(next.updater.active().version, '0.164.0');

  const current = setup(t, { version: '0.154.0', probeVersion: '0.154.0' });
  const oldPreview = await current.updater.preview(current.version);
  current.updater.probe = async () => probeBody('0.164.0');
  await assert.rejects(
    current.updater.apply({ version: current.version, token: oldPreview.token, confirm: true }),
    { code: 'PROBE_REJECTED' },
  );
  assert.equal(current.updater.active(), null);
});
