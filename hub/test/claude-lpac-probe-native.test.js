'use strict';
// These tests compile the trusted probe and exercise inert/rejected inputs,
// pure validation guards and read-only queries on their own process tokens.
// They never submit an admissible profile-creation request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
  if (Array.isArray(value) && (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems || rule.items && !value.every(x => matches(schema, rule.items, x)))) return false;
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

test('LPAC proof schema binds exact semantic masks and supplemental class46 outcomes', () => {
  // Synthetic shape examples are not OS LPAC measurements or general schema validation.
  const access = mask => ({functionSucceeded:true,accessStatus:true,grantedMask:mask,nativeCode:0,privilegeSetCapacity:4096,privilegeSetReturnedBytes:4096,privilegeCount:0});
  const unavailable = {api:'GetTokenInformation',informationClass:46,capacity:4,queryUnavailable:true,nativeCode:87,returnedBytes:null,value:null};
  const restriction = {api:'GetTokenInformation',informationClass:21,returnedBytes:1,encoding:'BOOLEAN-1',validationScope:'measured-host-abi-v1',value:false};
  const proof = {appContainerSid:'S-1-15-2-1-2-3-4-5-6-7',ownerSidMatched:true,capabilityCount:0,lowIntegrity:true,primaryToken:true,hasRestrictions:false,hasRestrictionsQuery:restriction,lpac:true,validationMethod:'chromium-access-check-v1',referenceRevision:'5c210565c3fa181730df37778d22af487a0d5e40',ownerControl:access(3),lpacAccess:access(2),class46:unavailable};
  const valid = value => matches(resultSchema,resultSchema.$defs.lpacTokenProof,value);
  assert.equal(valid(proof),true);
  assert.equal(valid({...proof,class46:{...unavailable,queryUnavailable:false,nativeCode:0,returnedBytes:4,value:1}}),true);
  assert.equal(valid({...proof,hasRestrictions:true,hasRestrictionsQuery:{...restriction,value:true}}),true);
  assert.equal(valid({...proof,lpacAccess:{...access(2),privilegeSetReturnedBytes:8}}),true,'empty privilege header remains valid');
  for(const changed of [
    {lpacAccess:access(3)},{ownerControl:access(2)},{lpacAccess:{...access(2),accessStatus:false}},
    {lpacAccess:{...access(2),functionSucceeded:false}},{lpacAccess:{...access(2),future:true}},
    {lpacAccess:{...access(2),privilegeSetReturnedBytes:8,privilegeCount:340}},
    {lpacAccess:{...access(2),privilegeSetReturnedBytes:20,privilegeCount:1}},
    {ownerControl:{...access(3),privilegeCount:1}},
    {hasRestrictions:true},{hasRestrictionsQuery:{...restriction,value:true}},
    {hasRestrictionsQuery:{...restriction,returnedBytes:4}},{hasRestrictionsQuery:{...restriction,encoding:'DWORD-4'}},
    {hasRestrictionsQuery:{...restriction,informationClass:29}},{hasRestrictionsQuery:{...restriction,api:'IsTokenRestricted'}},
    {hasRestrictionsQuery:{...restriction,value:1}},
    {class46:{...unavailable,nativeCode:5}},{class46:{...unavailable,value:1}},
    {class46:{...unavailable,queryUnavailable:false,nativeCode:0,returnedBytes:4,value:2}},
    {capabilityCount:1},{primaryToken:false},{lowIntegrity:false},{validationMethod:'class46-only'},{future:true}
  ])assert.equal(valid({...proof,...changed}),false);
  const result={schemaVersion:1,operation:'claude-lpac-bootstrap-gate',stage:'closed',code:'W0_NATIVE_CASES_PASSED',nativeCode:0,bootstrapPassed:true,cleanupVerified:true,probePassed:false,providerReady:false,profileCreated:true};
  assert.equal(matches(resultSchema,resultSchema,result),false,'bootstrap success requires explicit token proof');
  assert.equal(matches(resultSchema,resultSchema,{...result,lpacTokenProof:proof}),true);
  assert.equal(matches(resultSchema,resultSchema,{...result,bootstrapPassed:false}),true,'historical failed envelopes remain readable');
  const log={sourceBasename:'claude-lpac-fixture.exe.CLRLoad00.log',sourceFileId:'12345678:0000000000000001',bytes:1,sha256:crypto.createHash('sha256').update('x').digest('hex'),rawBase64:'eA=='};
  const diagnostic={schemaVersion:1,scope:'identity-child-owned-tmp',status:'captured',code:'CLR_LOGS_CAPTURED',interpretation:'diagnostic-only-not-root-cause-or-pass',logs:[log]};
  const validDiagnostic = value=>matches(resultSchema,resultSchema.$defs.clrActivationLogs,value);
  assert.equal(validDiagnostic(diagnostic),true);
  assert.equal(validDiagnostic({...diagnostic,status:'absent',code:'CLR_LOGS_ABSENT',logs:[]}),true);
  assert.equal(validDiagnostic({...diagnostic,status:'error',code:'FILE_TYPE_REJECTED',logs:[]}),true);
  for(const changed of [{logs:[]},{logs:[log,log,log]},{status:'absent',code:'CLR_LOGS_ABSENT'},{status:'error',code:'CLR_LOGS_CAPTURED',logs:[]},{scope:'any-directory'},{future:true}])assert.equal(validDiagnostic({...diagnostic,...changed}),false);
  for(const changed of [{sourceBasename:'../outside.log'},{sourceBasename:'claude-lpac-fixture.exe.CLRLoad100.log'},{sourceBasename:'claude-lpac-fixture.exe.CLRLoad00.log:ads'},{sourceFileId:'unknown'},{bytes:65537},{rawBase64:'AAAA===='},{rawBase64:'A'.repeat(87388)},{sha256:'not-a-hash'},{future:true}])assert.equal(validDiagnostic({...diagnostic,logs:[{...log,...changed}]}),false);
});

(process.platform === 'win32' ? test : test.skip)('LPAC probe inert, rejected and current-token readonly checks do not create a profile or probe root', {timeout: 60000}, t => {
  assert.equal(fs.existsSync(compiler), true, 'the approved existing compiler is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lpac-inert-'));
  const controller = path.join(root, 'claude-lpac-probe.exe');
  const fixture = path.join(root, 'claude-lpac-fixture.exe');
  const faults = path.join(root, 'claude-lpac-result-faults.exe');
  const aclChecks = path.join(root, 'claude-lpac-acl-checks.exe');
  const registryChecks = path.join(root, 'claude-lpac-registry-checks.exe');
  const tokenChecks = path.join(root, 'claude-lpac-token-checks.exe');
  const tokenDiagnostic = path.join(root, 'claude-lpac-token-readonly.exe');
  const tokenShapeDiagnostic = path.join(root, 'claude-lpac-token-shape.exe');
  const environmentChecks = path.join(root, 'claude-lpac-environment-checks.exe');
  const clrLogChecks = path.join(root, 'claude-lpac-clr-log-checks.exe');
  const lpacAccessChecks = path.join(root, 'claude-lpac-access-checks.exe');
  // Remove only the exact files created here. Unexpected files make cleanup fail.
  t.after(() => {
    for (const file of [controller, fixture, faults, aclChecks, registryChecks, tokenChecks, tokenDiagnostic, tokenShapeDiagnostic, environmentChecks, clrLogChecks, lpacAccessChecks]) if (fs.existsSync(file)) fs.unlinkSync(file);
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
  compile(environmentChecks, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/environment-block-validation.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeEnvironmentSelfTest']);
  const environmentRun = spawnSync(environmentChecks, [], {encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:65536});
  assert.equal(environmentRun.error,undefined);assert.equal(environmentRun.status,0,environmentRun.stdout+environmentRun.stderr);assert.equal(environmentRun.stderr,'');
  const environmentProof=JSON.parse(environmentRun.stdout);
  assert.deepEqual(environmentProof,{schemaVersion:1,assertions:102,allowlistKeys:12,identityAllowlistKeys:13,pollutionMarkers:12,profileCreated:false,fixtureProcessStarted:false,target:'environment-builder-memory-only'});
  t.diagnostic('Fixed fixture child environment checks: '+JSON.stringify(environmentProof));
  compile(clrLogChecks, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/clr-log-validation.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeClrLogSelfTest']);
  const clrLogRun=spawnSync(clrLogChecks,[path.join(root,'owned-clr-log-fixture')],{encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:512*1024});
  assert.equal(clrLogRun.error,undefined);assert.equal(clrLogRun.status,0,clrLogRun.stderr);assert.equal(clrLogRun.stderr,'');
  const logProof=JSON.parse(clrLogRun.stdout);
  assert.equal(logProof.schemaVersion,1);assert.equal(logProof.profileCreated,false);assert.equal(logProof.fixtureProcessStarted,false);
  assert.deepEqual(logProof.cases,['fixed-filename','cross-root-ads-reparse-and-link-guards','exact-size-and-count-limits','absent-not-cause','job-not-empty-refused','root-identity-refused','two-64k-files','third-file-refused','oversize-file-refused','actual-hard-link-refused','unsafe-cleanup-still-refuses']);
  assert.equal(logProof.syntheticCapturedLogs.length,2);
  assert.equal(new Set(logProof.syntheticCapturedLogs.map(row=>row.sourceFileId)).size,2);
  let capturedBytes=0;
  for(const row of logProof.syntheticCapturedLogs){
    assert.equal(matches(resultSchema,resultSchema.$defs.clrActivationLog,row),true);
    const raw=Buffer.from(row.rawBase64,'base64');
    assert.equal(raw.toString('base64'),row.rawBase64);assert.equal(raw.length,row.bytes);
    assert.deepEqual(raw,Buffer.alloc(65536));assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),row.sha256);capturedBytes+=raw.length;
  }
  assert.equal(capturedBytes,131072);
  t.diagnostic('Owned synthetic CLR log collection: '+JSON.stringify({assertions:logProof.assertions,cases:logProof.cases,files:2,bytes:capturedBytes,profileCreated:false,fixtureProcessStarted:false}));
  compile(faults, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/result-faults.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeResultSelfTest']);
  const faultResult = spawnSync(faults, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(faultResult.error, undefined);
  assert.equal(faultResult.status, 0, faultResult.stdout + faultResult.stderr);
  assert.equal(faultResult.stdout.trim(), 'receipt/result fault checks passed: 23');
  assert.equal(faultResult.stderr, '');
  compile(aclChecks, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/acl-equivalence.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeAclSelfTest']);
  const aclResult = spawnSync(aclChecks, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(aclResult.error, undefined);
  assert.equal(aclResult.status, 0, aclResult.stdout + aclResult.stderr);
  assert.equal(aclResult.stdout.trim(), 'ACL descriptor checks passed: 46');
  assert.equal(aclResult.stderr, '');
  t.diagnostic(aclResult.stdout.trim());
  compile(registryChecks, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/registry-identity.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeRegistrySelfTest']);
  const registryResult = spawnSync(registryChecks, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(registryResult.error, undefined);
  assert.equal(registryResult.status, 0, registryResult.stdout + registryResult.stderr);
  assert.equal(registryResult.stdout.trim(), 'registry identity checks passed: 46');
  assert.equal(registryResult.stderr, '');
  t.diagnostic(registryResult.stdout.trim());
  compile(tokenChecks, ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/token-query-validation.cs'], ['System.Web.Extensions.dll'], ['/main:ProbeTokenQuerySelfTest']);
  const tokenResult = spawnSync(tokenChecks, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(tokenResult.error, undefined);
  assert.equal(tokenResult.status, 0, tokenResult.stdout + tokenResult.stderr);
  assert.match(tokenResult.stdout.trim(), /^token query checks passed: (192|193)$/);
  assert.equal(tokenResult.stderr, '');
  t.diagnostic(tokenResult.stdout.trim());
  const accessSources = ['claude-lpac-probe.cs', 'claude-lpac-cases.cs', 'pinned-root.cs', '../test/fixtures/claude-lpac/access-check-validation.cs'];
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const accessSourceHashes = () => Object.fromEntries(accessSources.map(file => [file,digest(path.join(__dirname,'../windows',file))]));
  const accessBefore = accessSourceHashes();
  compile(lpacAccessChecks, accessSources, ['System.Web.Extensions.dll'], ['/main:ProbeLpacAccessSelfTest']);
  const accessExecutableHash = digest(lpacAccessChecks);
  const accessResult = spawnSync(lpacAccessChecks, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(accessResult.error, undefined);
  assert.equal(accessResult.status, 0, accessResult.stdout + accessResult.stderr);
  assert.equal(accessResult.stderr, '');
  const access = JSON.parse(accessResult.stdout);
  assert.equal(access.schemaVersion, 1);
  assert.equal(access.guardAssertions, 220);
  assert.equal(access.profileCreated, false);
  assert.equal(access.lpacPositiveMeasured, false);
  assert.equal(access.target, 'current-process-only');
  assert.equal(access.ownerControl.grantedMask, 3);
  assert.equal(access.ownerControl.functionSucceeded, true);
  assert.equal(access.ownerControl.accessStatus, true);
  assert.equal(matches(resultSchema, resultSchema.$defs.ownerAccessControl, access.ownerControl), true);
  assert.deepEqual(accessSourceHashes(), accessBefore, 'native source bytes must remain stable through compilation and execution');
  t.diagnostic('LPAC guard assertions/current-owner negative control: ' + JSON.stringify({...access,compilerSHA256:digest(compiler),executableSHA256:accessExecutableHash,sourceSHA256:accessBefore}));
  compile(tokenDiagnostic, ['../test/fixtures/claude-lpac/token-api-readonly.cs'], ['System.Web.Extensions.dll']);
  const tokenReadOnly = spawnSync(tokenDiagnostic, [], {encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 65536});
  assert.equal(tokenReadOnly.error, undefined);
  assert.equal(tokenReadOnly.status, 0, tokenReadOnly.stdout + tokenReadOnly.stderr);
  assert.equal(tokenReadOnly.stderr, '');
  const tokenApi = JSON.parse(tokenReadOnly.stdout);
  assert.deepEqual(Object.keys(tokenApi).sort(), ['native', 'payloadSerialized', 'profileCreated', 'schemaVersion', 'target', 'tokenAccess', 'win32'].sort());
  assert.equal(tokenApi.schemaVersion, 1);
  assert.equal(tokenApi.target, 'current-process-only');
  assert.equal(tokenApi.tokenAccess, 8);
  assert.equal(tokenApi.profileCreated, false);
  assert.equal(tokenApi.payloadSerialized, false);
  assert.deepEqual([...new Set(tokenApi.win32.map(row => row.class))], [8, 29, 30, 31, 46]);
  assert.deepEqual([...new Set(tokenApi.native.map(row => row.class))], [29, 46]);
  for (const [api, rows] of [['win32', tokenApi.win32], ['native', tokenApi.native]]) {
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['capacity', 'class', 'returnLength', 'returnLengthUntouched', 'success', api === 'native' ? 'ntstatus' : 'win32Code'].sort());
      assert.equal(typeof row.success, 'boolean');
      assert.equal(row.returnLengthUntouched, row.returnLength === null);
      assert.ok([0, 4, 8, 16, 65536].includes(row.capacity));
      if (api === 'native') assert.match(row.ntstatus, /^0x[0-9a-f]{8}$/);
      else assert.equal(Number.isInteger(row.win32Code), true);
    }
  }
  compile(tokenShapeDiagnostic, ['../test/fixtures/claude-lpac/token-shape-readonly.cs'], ['System.Web.Extensions.dll']);
  const shapeRun = spawnSync(tokenShapeDiagnostic, [], {encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:65536});
  assert.equal(shapeRun.error,undefined);assert.equal(shapeRun.status,0,shapeRun.stdout+shapeRun.stderr);assert.equal(shapeRun.stderr,'');
  const shape=JSON.parse(shapeRun.stdout);
  assert.equal(shape.schemaVersion,1);assert.equal(shape.target,'current-process-only');
  assert.equal(shape.profileCreated,false);assert.equal(shape.threadImpersonated,false);assert.equal(shape.rawTokenPayloadSerialized,false);
  assert.equal(shape.restrictionBooleanSerialized,true);assert.equal(shape.rows.length,40);
  for(const row of shape.rows){
    assert.ok(['current-primary','identification-duplicate'].includes(row.tokenKind));
    assert.ok([8,9,21,29].includes(row.class));assert.ok([0,1,4,16].includes(row.capacity));
    if(row.class!==21||!row.success){
      assert.equal(row.restrictionBoolean,null);assert.equal(row.restrictionEncoding,null);
    }else{
      assert.ok([1,4].includes(row.returnLengthObserved));
      assert.equal(typeof row.restrictionBoolean,'boolean');
      assert.equal(row.restrictionEncoding,row.returnLengthObserved===1?'BOOLEAN-1':'DWORD-4');
    }
    if(row.class!==21&&row.success)assert.equal(row.returnLengthObserved,4);
    if(row.class===9&&row.tokenKind==='current-primary')assert.equal(row.success,false);
  }
  t.diagnostic('Own token shape observations: '+JSON.stringify(shape));
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
