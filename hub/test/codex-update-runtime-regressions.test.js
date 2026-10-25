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


// Regression coverage for controller lifetime and native runtime contracts.
test('a failing cleanup of a blocked candidate never masks the blocked result and still removes the fresh slot', async t => {
  const f = setup(t, { version: '0.165.0' });
  // An active pointer whose slot record is unreadable: cleanup used to throw SyntaxError from finally.
  const activeId = '11111111-1111-4111-8111-111111111111';
  const activeFolder = path.join(f.root, '_hub/cli/slots', activeId);
  fs.mkdirSync(activeFolder, { recursive: true });
  fs.writeFileSync(path.join(activeFolder, 'record.json'), '{not json');
  fs.mkdirSync(path.join(f.root, '_hub/cli'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '_hub/cli/active.json'), JSON.stringify({ version: 1, slot: activeId, cliVersion: '0.154.0', binaryHash: f.knownHash, vendorHash: f.knownVendorHash }));
  const preview = await f.updater.preview(f.version);
  const result = await f.updater.apply({ version: f.version, token: preview.token, confirm: true });
  assert.equal(result.phase, 'blocked');
  assert.equal(result.blocker, 'UNVERIFIED_CODEX_PROTOCOL_VERSION');
  const left = fs.readdirSync(path.join(f.root, '_hub/cli/slots')).filter(name => name !== activeId);
  assert.deepEqual(left, [], 'the blocked candidate folder is removed');
  assert.equal(fs.existsSync(activeFolder), true, 'the active slot is never removed');
});

test('native resolve re-checks the slot every time instead of trusting a sticky startup or poll error', () => {
  const profile = require('../lib/native-codex-profile');
  let fail = true;
  const updater = { active: () => { if (fail) throw Object.assign(Error('busy'), { code: 'EBUSY' }); return { file: 'x', version: '0.154.0', binaryHash: HASH_154, slot: 's' }; } };
  assert.throws(() => profile.resolve({ updater, file: process.execPath }), { code: 'NATIVE_CODEX_VERSION_UNREVIEWED' });
  fail = false;
  assert.equal(profile.resolve({ updater, error: 'EBUSY', file: process.execPath }).version, '0.154.0', 'a stale error flag no longer blocks a healthy slot');
});

test('terminal routes read the Codex slot only through a guarded helper and only for Codex', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.equal(/buildArgv\(\{[^}]*nativeUpdater\?\.active\(\)/.test(server), false, 'no unguarded active() inside buildArgv arguments');
  const helper = server.match(/function activeCodexVersion\(ai\)\{([^\n]*)\}/);
  assert.ok(helper, 'activeCodexVersion helper exists');
  assert.match(helper[1], /ai!=='codex'/);
  assert.match(helper[1], /try\{/);
  assert.match(helper[1], /catch/);
});

test('a bare diagnostic code from the native runtime is shown with its Chinese explanation', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /String\(error\.message\|\|''\)===diagnosticCode\?require\('\.\/lib\/native-provider-messages'\)\.messageFor\(diagnosticCode/);
  const { messageFor } = require('../lib/native-provider-messages');
  assert.match(messageFor('NATIVE_CODEX_VERSION_UNREVIEWED'), /0\.154\.0/);
});
