'use strict';
// Production entry is tested only with rejected switches. Synthetic fixtures never access vendor paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const windows = path.resolve(__dirname, '../windows');
const fixtureSource = path.join(__dirname, 'fixtures/claude-static-identity/share-lock.cs');
const schemaPath = path.join(windows, 'claude-static-identity-result.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath));
const sourceFiles = [path.join(windows, 'claude-static-identity.cs'), path.join(windows, 'pinned-root.cs'), fixtureSource, __filename, schemaPath];
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
// Independent test-only evaluator for the schema keywords used by this closed envelope.
function matches(rule, value) {
  if (rule.$ref) return matches(schema.$defs[rule.$ref.split('/').pop()], value);
  if (Object.hasOwn(rule, 'const') && JSON.stringify(rule.const) !== JSON.stringify(value)) return false;
  const valid = child => matches(child, value);
  if (rule.allOf && !rule.allOf.every(valid) || rule.anyOf && !rule.anyOf.some(valid) || rule.oneOf && rule.oneOf.filter(valid).length !== 1 || rule.not && valid(rule.not)) return false;
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (rule.type && !(rule.type === 'object' ? object : rule.type === 'integer' ? Number.isInteger(value) : typeof value === rule.type)) return false;
  if (typeof value === 'string' && (rule.maxLength !== undefined && value.length > rule.maxLength || rule.pattern && !new RegExp(rule.pattern, 'u').test(value))) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum)) return false;
  if (object) {
    if (rule.required && !rule.required.every(key => Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (rule.properties?.[key]) { if (!matches(rule.properties[key], item)) return false; }
      else if (rule.additionalProperties === false) return false;
    }
  }
  return true;
}

test('static result schema keeps success separate from readiness and failed measurements', () => {
  const base = {schemaVersion: 1, kind: 'fixed-claude-static-identity', providerReady: false, vendorExecuted: false, authRead: false};
  const identity = {volume: '1', fileId: '2', bytes: '1476', links: '2', attributes: 32, createdFileTime: '3', modifiedFileTime: '4'};
  const expected = Object.fromEntries(Object.entries(schema.properties.expected.properties).map(([key, rule]) => [key, rule.const]));
  // Synthetic schema values only; this is not a real provider observation.
  const success = {...base, passed: true, code: 'STATIC_IDENTITY_MATCHED', expected, heldTogether: true, namespacePinned: true, scope: 'held-read-only-static-snapshot',
    manifest: {identity, sha256: expected.manifestSHA256}, executable: {identity: {...identity, bytes: '217406624'}, sha256: expected.executableSHA256}};
  const failure = {...base, passed: false, code: 'STATIC_FILE_OPEN_FAILED', nativeError: 32};
  assert.equal(matches(schema, success), true); assert.equal(matches(schema, failure), true);
  for (const value of [
    {...success, providerReady: true}, {...success, vendorExecuted: true}, {...success, authRead: true},
    {...success, heldTogether: false}, {...success, nativeError: 0}, {...success, sourcePath: 'not-authorized'},
    {...failure, code: 'STATIC_IDENTITY_MATCHED'}, {...failure, manifest: success.manifest}, {...failure, nativeError: -1},
    {...failure, code: 'STATIC_FILE_OPEN_FAILED\n'}, {...success, executable: {...success.executable, sha256: '0'.repeat(64)}},
    {...success, executable: {...success.executable, identity: {...success.executable.identity, links: '2\n'}}},
    {...success, executable: {...success.executable, identity: {...success.executable.identity, links: '0'}}},
  ]) assert.equal(matches(schema, value), false);
});

const enabled = process.platform === 'win32' && process.env.HUB_RUN_STATIC_IDENTITY_NATIVE_TEST === '1';
(enabled ? test : test.skip)('fixed static helper rejects paths; owned hardlinks enforce read sharing', {timeout: 60000}, t => {
  const sources = sourceFiles.map(file => ({file: path.relative(path.resolve(__dirname, '../..'), file).replaceAll('\\', '/'), sha256: sha(fs.readFileSync(file))}));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-static-native-'));
  const production = path.join(root, 'claude-static-identity.exe');
  const fixture = path.join(root, 'claude-static-share-fixture.exe');
  t.after(() => {
    for (const file of [production, fixture]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root); // unexpected files fail cleanup, never broad recursive deletion
  });
  function compile(output, extra) {
    const result = spawnSync(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/optimize+',
      '/r:mscorlib.dll', '/r:System.dll', '/r:System.Web.Extensions.dll', '/out:' + output,
      path.join(windows, 'claude-static-identity.cs'), path.join(windows, 'pinned-root.cs'), ...extra],
    {encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true});
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  compile(production, []);
  compile(fixture, ['/main:ClaudeStaticShareSelfTest', fixtureSource]);
  const rejected = [];
  for (const args of [[], ['--describe'], ['--inspect-fixed-claude', 'PRIVATE_MARKER'], ['--path', root], ['--inspect-fixed-claude\n']]) {
    const result = spawnSync(production, args, {encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true});
    assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stderr, '');
    const value = JSON.parse(result.stdout);
    assert.equal(matches(schema, value), true);
    assert.deepEqual(value, {schemaVersion: 1, kind: 'fixed-claude-static-identity', passed: false, code: 'STATIC_SWITCH_REJECTED', providerReady: false, vendorExecuted: false, authRead: false, nativeError: 0});
    assert.equal(result.stdout.includes('PRIVATE_MARKER'), false);
    rejected.push(value.code);
  }
  const result = spawnSync(fixture, [root], {encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true});
  assert.equal(result.error, undefined); assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  const evidence = {schemaVersion: 1, sources, binaries: [production, fixture].map(file => ({file: path.basename(file), sha256: sha(fs.readFileSync(file))})), rejected, synthetic: value};
  const evidenceName = process.env.HUB_STATIC_IDENTITY_TEST_EVIDENCE;
  if (evidenceName) {
    assert.match(evidenceName, /^claude-static-identity-native-[a-z0-9-]+\.json$/);
    fs.writeFileSync(path.resolve(__dirname, '../../../../outputs', evidenceName), JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx'});
  }
  assert.equal(result.status, 0, JSON.stringify(value));
  assert.equal(value.passed, true); assert.equal(value.cleanupVerified, true);
  assert.equal(value.vendorExecuted, false); assert.equal(value.profileCreated, false);
  assert.ok(value.cases.length >= 30); assert.ok(value.cases.every(row => row.passed === true));
  assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(production), path.basename(fixture)].sort());
  assert.deepEqual(sourceFiles.map(file => sha(fs.readFileSync(file))), sources.map(row => row.sha256), 'sources remain fixed across the native batch');
  t.diagnostic('Owned native sharing checks passed: ' + value.cases.length);
});
