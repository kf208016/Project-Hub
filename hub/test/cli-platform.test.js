'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../lib/cli-platform');

test('Windows npm Codex shim invokes the pinned local JS entry without a shell', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'codex.cmd');
  const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(shim, '@echo off');
  fs.writeFileSync(entry, '');
  assert.equal(cli.find('codex', dir, 'win32'), shim);
  assert.deepEqual(cli.invocation(shim, ['exec', 'a & b'], 'win32'),
    { file: process.execPath, args: [entry, 'exec', 'a & b'] });
});

test('Windows rejects unknown command shims and missing Codex package entries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const unknown = path.join(dir, 'other.cmd');
  const codex = path.join(dir, 'codex.cmd');
  fs.writeFileSync(unknown, '');
  fs.writeFileSync(codex, '');
  assert.throws(() => cli.invocation(unknown, [], 'win32'), /unsupported/);
  assert.throws(() => cli.invocation(codex, [], 'win32'), /missing/);
  assert.equal(cli.find('..\\bad', dir, 'win32'), '');
  assert.deepEqual(cli.resolve('./fixture', ['arg'], '', 'darwin'), { file: './fixture', args: ['arg'] });
});
