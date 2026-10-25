'use strict';
// Compilation and pure managed lifecycle only; the fixture owns zero native handles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

(process.platform === 'win32' ? test : test.skip)('pinned root disposed and incomplete states fail closed without native queries', {timeout: 30000}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pin-lifecycle-'));
  const fixture = path.join(root, 'pinned-root-lifecycle.exe');
  t.after(() => {
    if (fs.existsSync(fixture)) fs.unlinkSync(fixture);
    fs.rmdirSync(root);
  });
  const compiled = spawnSync(compiler, ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64', '/optimize+',
    '/r:mscorlib.dll', '/r:System.dll', '/out:' + fixture,
    path.join(__dirname, '../windows/pinned-root.cs'), path.join(__dirname, 'fixtures/pinned-root/lifecycle.cs')],
  {encoding: 'utf8', timeout: 20000, maxBuffer: 65536, windowsHide: true});
  assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const result = spawnSync(fixture, [], {encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true});
  assert.equal(result.error, undefined); assert.equal(result.stderr, '');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.trim(), 'Pinned root pure lifecycle checks passed: 9');
  assert.deepEqual(fs.readdirSync(root), [path.basename(fixture)], 'fixture must not create native roots or other files');
  t.diagnostic(result.stdout.trim());
});
