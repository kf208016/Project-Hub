'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const commands = require('../lib/codex-commands');
const broker = require('../lib/scoped-file');
const { createPlan } = require('../lib/provider-native-plan');
const { codeOf } = require('../lib/native-provider-diagnostic');
const { messageFor } = require('../lib/native-provider-messages');
const { NativeProviderApprovals } = require('../lib/native-provider-approvals');
const launch = require('../lib/launch');

const win = process.platform === 'win32' ? test : test.skip;
const PINS = [
  'features.windows_sandbox_service=false',
  'windows.allow_mxc=false',
  'features.prefer_mxc=false',
];

function baseOptions(overrides) {
  const opts = {
    actor: 'claude',
    cwd: 'C:\\Workspaces\\project',
    rootFingerprint: 'a'.repeat(64),
    ownerHome: 'C:\\Users\\example-user',
    runtimeBase: 'C:\\Users\\example-user\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\provider.exe',
    codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: 'b'.repeat(64),
    nodeFile: 'C:\\Tools\\node\\node.exe',
    gitDirectory: 'C:\\Tools\\git',
    hubLibDirectory: 'C:\\Tools\\hublib',
    providerArgs: ['--flag', 'value'],
    proxyUrl: 'http://hub:' + 'c'.repeat(64) + '@127.0.0.1:8080',
    systemRoot: 'C:\\Windows',
  };
  return Object.assign(opts, overrides || {});
}

async function setup(t, userAgent) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-command-protocol-'));
  const root = path.join(parent, 'task');
  const bin = path.join(parent, 'bin');
  const entry = path.join(bin, 'node_modules/@openai/codex/bin/codex.js');
  fs.mkdirSync(root);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const shim = path.join(bin, 'codex.cmd');
  fs.writeFileSync(shim, '@echo off\r\nexit /b 99\r\n');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.writeFileSync(entry, `const userAgent=${JSON.stringify(userAgent)},out=x=>console.log(JSON.stringify(x));require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')out({id:m.id,result:{userAgent,platformOs:'windows',platformFamily:'windows'}});if(m.method==='command/exec')out({id:m.id,result:{exitCode:0,stdout:JSON.stringify({params:m.params,args:process.argv.slice(2)}),stderr:''}});}).on('close',()=>process.exit(0));`);
  return { root, shim, pin: (await broker.identity(root)).rootFingerprint };
}

function run(shim, root, pin, expectedVersion) {
  return commands.run(shim, {
    argv: [process.execPath, '-e', 'fixture'],
    cwd: root,
    root,
    rootFingerprint: pin,
    expectedVersion,
    version: expectedVersion,
  }).promise;
}

win('codex-commands accepts an initialize userAgent of /0.164.0 when 0.164.0 is expected', { timeout: 20000 }, async t => {
  const { root, shim, pin } = await setup(t, 'Codex Desktop/0.164.0');
  const result = await run(shim, root, pin, '0.164.0');
  assert.equal(result.modelCalled, false);
  assert.equal(result.exitCode, 0);
});

win('codex-commands refuses /0.154.0 when 0.164.0 is expected, and still refuses /0.153.0', { timeout: 20000 }, async t => {
  const mismatch = await setup(t, 'Codex Desktop/0.154.0');
  await assert.rejects(run(mismatch.shim, mismatch.root, mismatch.pin, '0.164.0'), { code: 'UNSUPPORTED_CODEX_VERSION' });
  const old = await setup(t, 'Codex Desktop/0.153.0');
  await assert.rejects(run(old.shim, old.root, old.pin, '0.164.0'), { code: 'UNSUPPORTED_CODEX_VERSION' });
});

test('native sandbox argv pins the Windows service and MXC backend off and keeps elevated', () => {
  const plan = createPlan(baseOptions());
  for (const pin of PINS) {
    const index = plan.args.indexOf(pin);
    assert.ok(index > 0, pin);
    assert.equal(plan.args[index - 1], '-c');
  }
  assert.ok(plan.args.includes('windows.sandbox="elevated"'));
});

test('codeOf admits NATIVE_CODEX_VERSION_UNREVIEWED', () => {
  assert.equal(codeOf({ code: 'NATIVE_CODEX_VERSION_UNREVIEWED', message: 'private synthetic text' }), 'NATIVE_CODEX_VERSION_UNREVIEWED');
  assert.equal(codeOf(Object.create({ code: 'NATIVE_CODEX_VERSION_UNREVIEWED' })), null);
});

test('messageFor(NATIVE_CODEX_VERSION_UNREVIEWED) names both reviewed versions', () => {
  const text = messageFor('NATIVE_CODEX_VERSION_UNREVIEWED');
  assert.equal(text == null ? null : typeof text, 'string');
  assert.match(text, /0\.154\.0/);
  assert.match(text, /0\.164\.0/);
});

test('preview passes through NATIVE_CODEX_VERSION_UNREVIEWED and still masks an unknown describe error', async () => {
  const scope = { actor: 'grok', project: 'synthetic', task: 'task-1', model: 'grok-4.6', effort: 'low' };
  const unreviewed = new NativeProviderApprovals({
    describe: async () => { throw Object.assign(new Error('synthetic'), { code: 'NATIVE_CODEX_VERSION_UNREVIEWED' }); },
  });
  await assert.rejects(() => unreviewed.preview(scope), { code: 'NATIVE_CODEX_VERSION_UNREVIEWED' });
  const unknown = new NativeProviderApprovals({
    describe: async () => { throw Object.assign(new Error('synthetic'), { code: 'NOT_A_REAL_DIAGNOSTIC' }); },
  });
  await assert.rejects(() => unknown.preview(scope), { code: 'NATIVE_PROFILE_UNAVAILABLE' });
});

win('Windows codex launch args pass features.daemon_auto_start=false after -c', () => {
  const turn = launch.buildArgv({ ai: 'codex', model: launch.CLI_DEFAULT_LABEL, effort: '高', prompt: 'fixture' });
  const index = turn.args.indexOf('features.daemon_auto_start=false');
  assert.ok(index > 0);
  assert.equal(turn.args[index - 1], '-c');
});
