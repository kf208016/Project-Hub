'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const win = process.platform === 'win32' ? test : test.skip;
let fixture;
function executable() {
  if (fixture) return fixture;
  const sources = [path.resolve(__dirname, '../windows/ssh-vault-transport.cs'), path.join(__dirname, 'helpers/ssh-vault-transport-fixture.cs')];
  const hash = createHash('sha256'); sources.forEach(source => hash.update(fs.readFileSync(source)));
  const folder = path.resolve(__dirname, '../.runtime'); fs.mkdirSync(folder, { recursive: true });
  fixture = path.join(folder, `ssh-vault-transport-test-${hash.digest('hex')}.exe`);
  if (!fs.existsSync(fixture)) execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + fixture, ...sources], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
  return fixture;
}
function run(mode) {
  const output = execFileSync(executable(), [mode], { windowsHide: true, timeout: 25000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output.includes('fixture-繁體'), false);
  assert.equal(output.includes('sensitive-untrusted-debug-must-not-escape'), false);
  return JSON.parse(output);
}
win('native SSH password pipe preserves UTF-8 and spaces, validates peers, and filters stderr', { timeout: 45000 }, () => {
  const result = run('success');
  assert.equal(result.ExitCode, 0); assert.equal(result.Authenticated, true); assert.equal(result.AskpassSupplied, true);
  assert.equal(result.CleanupVerified, true); assert.equal(result.Output, 'IDENTITY_OK\n');
  assert.equal(result.Events.filter(event => event === 'ASKPASS_SUPPLIED').length, 1);
  assert.ok(result.Events.includes('SSH_HOST_PIN_MATCHED'));
});
win('native SSH password permit cannot be replayed', { timeout: 45000 }, () => {
  const result = run('replay');
  assert.equal(result.ExitCode, 0); assert.equal(result.Authenticated, true); assert.equal(result.CleanupVerified, true);
  assert.equal(result.Events.filter(event => event === 'ASKPASS_SUPPLIED').length, 1);
});
for (const mode of ['nonce', 'ancestry']) win(`native SSH password pipe rejects ${mode} without releasing secret`, { timeout: 45000 }, () => {
  const result = run(mode);
  assert.notEqual(result.ExitCode, 0); assert.equal(result.Authenticated, false); assert.equal(result.AskpassSupplied, false);
  assert.equal(result.CleanupVerified, true); assert.equal(result.Output, '');
});
win('native SSH deadline stops owned process and closes secret pipe', { timeout: 45000 }, () => {
  const result = run('timeout');
  assert.equal(result.ExitCode, 125); assert.equal(result.Authenticated, false); assert.equal(result.AskpassSupplied, false);
  assert.equal(result.CleanupVerified, true); assert.ok(result.Events.includes('SSH_DEADLINE'));
});
