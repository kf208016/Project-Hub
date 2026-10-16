'use strict';
// These tests compile the trusted probe and exercise only inert/rejected inputs.
// They never submit an admissible profile-creation request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const requestSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../windows/claude-lpac-probe-request.schema.json')));
const resultSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../windows/claude-lpac-probe-result.schema.json')));
// Test-only evaluator for the documented schema keywords, independent of native admission.
function matches(schema, rule, value) {
  if (rule.$ref) return matches(schema, schema.$defs[rule.$ref.split('/').pop()], value);
  if (Object.hasOwn(rule, 'const') && JSON.stringify(rule.const) !== JSON.stringify(value)) return false;
  if (rule.enum && !rule.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) return false;
  const valid = child => matches(schema, child, value);
  if (rule.allOf && !rule.allOf.every(valid) || rule.anyOf && !rule.anyOf.some(valid) || rule.oneOf && rule.oneOf.filter(valid).length !== 1 || rule.not && valid(rule.not)) return false;
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.some(t => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? object : t === 'integer' ? Number.isInteger(value) : typeof value === t)) return false;
  }
  if (typeof value === 'string' && (rule.minLength !== undefined && value.length < rule.minLength || rule.maxLength !== undefined && value.length > rule.maxLength || rule.pattern && !new RegExp(rule.pattern, 'u').test(value))) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum)) return false;
  if (Array.isArray(value) && (rule.maxItems !== undefined && value.length > rule.maxItems || rule.items && !value.every(x => matches(schema, rule.items, x)))) return false;
  if (object) {
    if (rule.maxProperties !== undefined && Object.keys(value).length > rule.maxProperties || rule.required && !rule.required.every(k => Object.hasOwn(value, k))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (rule.propertyNames && !matches(schema, rule.propertyNames, key)) return false;
      if (rule.properties?.[key]) { if (!matches(schema, rule.properties[key], item)) return false; }
      else if (rule.additionalProperties === false || typeof rule.additionalProperties === 'object' && !matches(schema, rule.additionalProperties, item)) return false;
    }
  }
  return true;
}

(process.platform === 'win32' ? test : test.skip)('LPAC probe inert and rejected requests do not create a profile or probe root', {timeout: 60000}, t => {
  assert.equal(fs.existsSync(compiler), true, 'the approved existing compiler is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lpac-inert-'));
  const controller = path.join(root, 'claude-lpac-probe.exe');
  const fixture = path.join(root, 'claude-lpac-fixture.exe');
  const faults = path.join(root, 'claude-lpac-result-faults.exe');
  // Remove only the exact files created here. Unexpected files make cleanup fail.
  t.after(() => {
    for (const file of [controller, fixture, faults]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  });
  function compile(output, names, references = [], extra = []) {
    const args = ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/optimize+', '/out:' + output,
      ...extra, ...['mscorlib.dll', 'System.dll', ...references].map(name => '/r:' + name),
      ...names.map(name => path.join(__dirname, '../windows', name))];
    const result = spawnSync(compiler, args, {encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 65536});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  compile(fixture, ['claude-lpac-fixture.cs']);
  compile(controller, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs'], ['System.Web.Extensions.dll']);
  compile(faults, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/result-faults.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeResultSelfTest']);
  const faultResult = spawnSync(faults, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(faultResult.error, undefined);
  assert.equal(faultResult.status, 0, faultResult.stdout + faultResult.stderr);
  assert.equal(faultResult.stdout.trim(), 'receipt/result fault checks passed: 23');
  assert.equal(faultResult.stderr, '');
  const initialFiles = fs.readdirSync(root).sort();
  function run(args, input) {
    const result = spawnSync(controller, args, {input, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const value = JSON.parse(result.stdout);
    assert.equal(matches(resultSchema, resultSchema, value), true, 'actual native output must match its closed envelope; code=' + value.code);
    assert.equal(value.providerReady, false);
    assert.equal(value.probePassed, false);
    assert.deepEqual(fs.readdirSync(root).sort(), initialFiles, 'rejected/inert operations must not prepare any root or journal');
    return {result, value};
  }
  for (const args of [[], ['--describe']]) {
    const {result, value} = run(args, '');
    assert.equal(result.status, 0);
    assert.equal(value.profileCreated, false);
  }
  assert.notEqual(run(['--execute-approved-w0-gate', '--extra'], '').result.status, 0);
  assert.notEqual(run(['--unknown'], '').result.status, 0);
  const request = {schemaVersion: 1, operation: 'claude-lpac-bootstrap-gate', runNonce: 'a'.repeat(32),
    rootParent: root, fixturePath: fixture, fixtureSHA256: '0'.repeat(64)};
  assert.equal(matches(requestSchema, requestSchema, request), true, 'shape is separate from admission/authority');
  for (const changed of [{unexpected: true}, {runNonce: request.runNonce + '\n'}, {fixtureSHA256: request.fixtureSHA256 + '\n'}, {rootParent: root + '\n'}]) {
    assert.equal(matches(requestSchema, requestSchema, {...request, ...changed}), false);
  }
  // Even if parsing regresses, the all-zero fixture hash prevents admission.
  const rejected = [
    '', '{', '\ufeff{}', Buffer.from([0xff]), ' '.repeat(16385),
    JSON.stringify({...request, unexpected: 'PRIVATE_MARKER_DO_NOT_ECHO'}),
    JSON.stringify({...request, runNonce: '../not-a-nonce'}),
    JSON.stringify({...request, operation: 'not-approved'}),
    JSON.stringify(request).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    JSON.stringify(request).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":2'),
  ];
  for (const input of rejected) {
    const {result, value} = run(['--execute-approved-w0-gate'], input);
    assert.notEqual(result.status, 0);
    assert.match(value.code, /^[A-Z][A-Z0-9_]{0,95}$/);
    assert.equal(result.stdout.includes('PRIVATE_MARKER_DO_NOT_ECHO'), false);
  }
  const {result, value} = run(['--execute-approved-w0-gate'], JSON.stringify(request));
  assert.notEqual(result.status, 0);
  assert.equal(value.bootstrapPassed, false);
  // No positive execute request is sent here; real LPAC measurements are separate.
});
