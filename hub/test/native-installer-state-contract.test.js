'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../windows/native-install.cjs');

function systemRoot() {
  return process.env.SystemRoot || 'C:\\Windows';
}

function otherSystemRoot() {
  const letter = path.parse(systemRoot()).root[0].toUpperCase();
  const other = letter === 'X' ? 'Y' : 'X';
  if (other === 'D') throw new Error('refusing D:');
  return `${other}:\\Windows`;
}

function ownedTemp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-installer-state-')));
  const drive = path.parse(root).root.toUpperCase();
  if (drive === 'D:\\') throw new Error('refusing D:');
  const protectedRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ProjectHub'),
    path.join(os.homedir(), 'Documents'),
  ].filter(Boolean).map(item => path.resolve(item).toLowerCase());
  if (protectedRoots.some(item => root.toLowerCase().startsWith(item))) throw new Error('refusing a protected path');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function installer(t, {realpath, system = systemRoot()} = {}) {
  const tmp = ownedTemp(t);
  const base = path.join(tmp, 'ProjectHub');
  const dataRoot = path.join(tmp, 'AI-Workspace');
  const created = new tool.Installer({installBase: base, dataRoot, port: 4545, systemRoot: system, ...(realpath ? {realpath} : {})});
  return {tmp, base, dataRoot, installer: created};
}

// The launcher records .NET UTC ticks (StartTime.ToUniversalTime().Ticks), not FILETIME.
function creationFileTimeUtc(pid) {
  const ps = path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().Ticks.ToString()`], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  const ticks = String(out).trim();
  if (!/^[0-9]{1,19}$/.test(ticks)) throw new Error(`creation ticks unavailable: ${ticks}`);
  return ticks;
}

function parseRequest(buffer) {
  assert.equal(typeof tool.parseRequest, 'function');
  return tool.parseRequest(buffer);
}

test('parseRequest accepts UTF-8 JSON without a BOM', () => {
  assert.deepEqual(parseRequest(Buffer.from('{"ok":true,"n":1}', 'utf8')), {ok: true, n: 1});
});

test('parseRequest accepts UTF-8 JSON with a leading BOM', () => {
  const body = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"ok":true}', 'utf8')]);
  assert.deepEqual(parseRequest(body), {ok: true});
});

test('parseRequest rejects invalid UTF-8 with REQUEST_REJECTED', () => {
  assert.equal(typeof tool.parseRequest, 'function');
  assert.throws(() => tool.parseRequest(Buffer.from([0xC3, 0x28])), err => err && err.code === 'REQUEST_REJECTED');
});

test('parseRequest rejects invalid JSON with REQUEST_REJECTED', () => {
  assert.equal(typeof tool.parseRequest, 'function');
  assert.throws(() => tool.parseRequest(Buffer.from('{', 'utf8')), err => err && err.code === 'REQUEST_REJECTED');
});

test('an install base on a different drive than systemRoot is INSTALL_BASE_NOT_SYSTEM_DRIVE', t => {
  const tmp = ownedTemp(t);
  const base = path.join(tmp, 'ProjectHub');
  const injected = otherSystemRoot();
  assert.notEqual(path.parse(base).root.toLowerCase(), path.parse(injected).root.toLowerCase());
  assert.throws(() => new tool.Installer({
    installBase: base,
    dataRoot: path.join(tmp, 'AI-Workspace'),
    port: 4545,
    systemRoot: injected,
  }), err => err && err.code === 'INSTALL_BASE_NOT_SYSTEM_DRIVE');
});

test('assertUnvirtualized passes when the install base does not exist yet', t => {
  const {base, installer: created} = installer(t);
  assert.equal(fs.existsSync(base), false);
  assert.equal(typeof created.assertUnvirtualized, 'function');
  assert.doesNotThrow(() => created.assertUnvirtualized());
});

test('an injected realpath that leaves the install base is INSTALL_BASE_VIRTUALIZED', t => {
  const tmp = ownedTemp(t);
  const base = path.join(tmp, 'ProjectHub');
  fs.mkdirSync(base);
  const virtual = path.join(tmp, 'virtualized', 'ProjectHub');
  const created = new tool.Installer({
    installBase: base,
    dataRoot: path.join(tmp, 'AI-Workspace'),
    port: 4545,
    systemRoot: systemRoot(),
    realpath: () => virtual,
  });
  assert.equal(typeof created.assertUnvirtualized, 'function');
  assert.throws(() => created.assertUnvirtualized(), err => err && err.code === 'INSTALL_BASE_VIRTUALIZED');
});

test('an injected realpath equal to the base except for case is not virtualized', t => {
  const tmp = ownedTemp(t);
  const base = path.join(tmp, 'ProjectHub');
  fs.mkdirSync(base);
  const created = new tool.Installer({
    installBase: base,
    dataRoot: path.join(tmp, 'AI-Workspace'),
    port: 4545,
    systemRoot: systemRoot(),
    realpath: value => String(value).toLowerCase(),
  });
  assert.equal(typeof created.assertUnvirtualized, 'function');
  assert.doesNotThrow(() => created.assertUnvirtualized());
});

test('a dead launcher pid is archived instead of STOP_CURRENT_INSTANCE_FIRST', t => {
  const {installer: created} = installer(t);
  const hub = path.join(created.root, '_hub');
  fs.mkdirSync(hub, {recursive: true});
  const ticks = '637000000000000000';
  const file = path.join(hub, 'desktop-state.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, root: created.root, hubDir: path.join(created.base, 'hub'), pid: 314159265,
    createdTicks: ticks, port: 4545, protectedToken: 'QQ==',
  }));
  let error = null;
  try { created.assertStopped(); } catch (caught) { error = caught; }
  const names = fs.readdirSync(hub);
  const archived = names.filter(name => new RegExp(`^desktop-state\\.stale-${ticks}-[0-9a-fA-F]{8}\\.json$`).test(name));
  assert.equal(archived.length, 1, `expected a stale archive, code=${error && error.code}, names=${names.join(',')}`);
  assert.equal(fs.existsSync(file), false);
  assert.notEqual(error && error.code, 'STOP_CURRENT_INSTANCE_FIRST');
});

test('a live process with matching creation filetime still requires STOP_CURRENT_INSTANCE_FIRST', t => {
  const {installer: created} = installer(t);
  const hub = path.join(created.root, '_hub');
  fs.mkdirSync(hub, {recursive: true});
  const ticks = creationFileTimeUtc(process.pid);
  const file = path.join(hub, 'desktop-state.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, root: created.root, hubDir: path.join(created.base, 'hub'), pid: process.pid,
    createdTicks: ticks, port: 4545, protectedToken: 'QQ==',
  }));
  assert.throws(() => created.assertStopped(), err => err && err.code === 'STOP_CURRENT_INSTANCE_FIRST');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readdirSync(hub).some(name => name.startsWith('desktop-state.stale-')), false);
});

test('an unparsable launcher state still fails closed with STOP_CURRENT_INSTANCE_FIRST', t => {
  const {installer: created} = installer(t);
  const hub = path.join(created.root, '_hub');
  fs.mkdirSync(hub, {recursive: true});
  const file = path.join(hub, 'desktop-state.json');
  fs.writeFileSync(file, '{');
  assert.throws(() => created.assertStopped(), err => err && err.code === 'STOP_CURRENT_INSTANCE_FIRST');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readdirSync(hub).some(name => name.startsWith('desktop-state.stale-')), false);
});

test.skip('install writes Start-Project-Hub.cmd and Stop-Project-Hub.cmd', {skip: 'requires a real package to finish install'}, () => {});

test.skip('rollback writes Start-Project-Hub.cmd and Stop-Project-Hub.cmd', {skip: 'requires a real package to finish rollback'}, () => {});

test.skip('a launcher file without the generated marker is LAUNCHER_FILE_FOREIGN', {skip: 'requires a real package to reach launcher generation; refusing a foreign file must not need admin or a Hub process'}, () => {});
