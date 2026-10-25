'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('../windows/native-install.cjs');
const builder = require('../windows/package-windows.cjs');

const hub = path.join(__dirname, '..');
const ffmpegRoot = path.resolve(hub, '../../dependencies/ffmpeg-9.0.2-reviewed');
const win = process.platform === 'win32' ? test : test.skip;
const PACKAGED = 'Example_1.0.0.0_x64__0000000000000';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-installer-pointer-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('hub-installer-pointer-'));
    fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  });
  return root;
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, value);
}

function fixturePackage(root, revision) {
  const source = path.join(root, 'package-' + revision[0]);
  fs.mkdirSync(source);
  const names = [
    'hub/server.js',
    'hub/start-windows.ps1',
    'hub/windows/roles.yaml',
    'hub/windows/native-install.cjs',
    'hub/windows/install-files.cs',
    'hub/package-lock.json',
    'hub/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ];
  for (const name of names) write(source, name, 'fixture');
  for (const name of [
    'start-windows.ps1',
    'windows/roles.yaml',
    'windows/native-install.cjs',
    'windows/install-files.cs',
    'lib/safe-path.js',
    'lib/local-drives.js',
    'lib/cli-platform.js',
    'lib/provider-registry.js',
    'lib/web-chat-admission.js',
    'windows/local-drives.cs',
  ]) write(source, 'hub/' + name, fs.readFileSync(path.join(hub, name)));
  write(
    source,
    'hub/server.js',
    `const http=require('http'),crypto=require('crypto');const token=process.env.HUB_LOCAL_TOKEN;const send=(res,n,v)=>{res.writeHead(n,{'Content-Type':'application/json'});res.end(JSON.stringify(v))};const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://127.0.0.1');if(u.pathname==='/api/local/proof')return send(res,200,{proof:crypto.createHmac('sha256',token).update('project-hub-instance-v1:'+u.searchParams.get('challenge')).digest('hex')});if(u.pathname==='/api/local/login'){let body='';req.on('data',x=>body+=x);req.on('end',()=>{if(JSON.parse(body).token!==token)return send(res,401,{});res.setHeader('Set-Cookie','owned-fixture=1; Path=/; HttpOnly; SameSite=Strict');send(res,200,{ok:true})});return;}if(u.pathname==='/api/quit'&&String(req.headers.cookie||'').includes('owned-fixture=1')){send(res,200,{ok:true});setTimeout(()=>server.close(()=>process.exit(0)),30);return;}send(res,401,{error:'fixture authentication required'});});server.listen(Number(process.env.HUB_PORT),'127.0.0.1');`,
  );
  for (const name of ['bin/ffmpeg.exe', 'LICENSE', 'README.txt']) {
    write(source, 'dependencies/ffmpeg-9.0.2/' + name, fs.readFileSync(path.join(ffmpegRoot, name)));
  }
  write(source, 'dependencies/ffmpeg-9.0.2/source-metadata.json', tool.json({fixture: true, source: 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b'}));
  const all = builder.inventory(source, builder.files(source, 'hub').concat(builder.files(source, 'dependencies')));
  const value = builder.metadata(revision, all, all.find(f => f.path === 'hub/package-lock.json').sha256);
  const bytes = tool.json(tool.manifest(value));
  write(source, 'package-manifest.json', bytes);
  return {packageRoot: source, manifestSha256: tool.digest(Buffer.from(bytes))};
}

function makeInstaller(tmp, extra = {}) {
  const base = path.join(tmp, 'ProjectHub');
  const dataRoot = path.join(tmp, 'AI-Workspace');
  const port = extra.port || tool.native({mode: 'free-port'}).port;
  assert.notEqual(port, 4545);
  assert.notEqual(port, 4546);
  const installer = new tool.Installer({
    installBase: base,
    dataRoot,
    port,
    ...extra,
  });
  return {base, dataRoot, port, installer};
}

function ffmpegExe(installer, releaseId) {
  return path.join(installer.slot({id: releaseId}), 'dependencies', 'ffmpeg-9.0.2', 'bin', 'ffmpeg.exe');
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function readDeps(dataRoot) {
  const file = path.join(dataRoot, '_hub', 'native-dependencies.json');
  const text = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(text);
  assert.equal(value.version, 1);
  assert.equal(value.heicDecoder.sha256, tool.FFMPEG.sha256);
  assert.equal(value.heicDecoder.version, tool.FFMPEG.version);
  return {file, text, value};
}

function rewritePointer(dataRoot, exePath) {
  const before = tool.native({
    mode: 'inspect',
    root: dataRoot,
    path: '_hub/native-dependencies.json',
    text: true,
  });
  tool.native({
    mode: 'write',
    root: dataRoot,
    path: '_hub/native-dependencies.json',
    text: tool.json({
      version: 1,
      heicDecoder: {
        path: exePath,
        sha256: tool.FFMPEG.sha256,
        version: tool.FFMPEG.version,
      },
    }),
    expectedHash: before.sha256,
    fileFingerprint: before.fileFingerprint,
    rootFingerprint: before.rootFingerprint,
  });
}

function diskState(base, dataRoot) {
  const read = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
  const versions = path.join(base, 'versions');
  return {
    current: read(path.join(base, 'current.json')),
    deps: read(path.join(dataRoot, '_hub', 'native-dependencies.json')),
    start: read(path.join(base, 'Start-Project-Hub.cmd')),
    stop: read(path.join(base, 'Stop-Project-Hub.cmd')),
    versions: fs.existsSync(versions) ? fs.readdirSync(versions).sort() : [],
  };
}

win('A1 install A then B rebinds heicDecoder.path to slot B; rollback returns it to slot A', {timeout: 180000}, t => {
  const tmp = temp(t);
  const {base, dataRoot, installer} = makeInstaller(tmp);
  const a = fixturePackage(tmp, 'a'.repeat(40));
  const b = fixturePackage(tmp, 'b'.repeat(40));
  const first = installer.install(a);
  const second = installer.install(b);
  const afterB = readDeps(dataRoot);
  assert.equal(samePath(afterB.value.heicDecoder.path, ffmpegExe(installer, second.releaseId)), true, afterB.value.heicDecoder.path);
  assert.equal(afterB.value.heicDecoder.path.toLowerCase().includes(path.join('versions', second.releaseId).toLowerCase()), true);
  const rolled = installer.rollback();
  assert.equal(rolled.releaseId, first.releaseId);
  const afterRollback = readDeps(dataRoot);
  assert.equal(samePath(afterRollback.value.heicDecoder.path, ffmpegExe(installer, first.releaseId)), true, afterRollback.value.heicDecoder.path);
  assert.equal(JSON.parse(fs.readFileSync(afterRollback.file, 'utf8')).version, 1);
});

win('A1 pointer naming a missing slot is rebound when installing B', {timeout: 180000}, t => {
  const tmp = temp(t);
  const {base, dataRoot, installer} = makeInstaller(tmp);
  const a = fixturePackage(tmp, 'a'.repeat(40));
  const b = fixturePackage(tmp, 'b'.repeat(40));
  installer.install(a);
  const missingId = '4.68.2-windows-codex-' + 'd'.repeat(12);
  const missingExe = path.join(base, 'versions', missingId, 'dependencies', 'ffmpeg-9.0.2', 'bin', 'ffmpeg.exe');
  assert.equal(fs.existsSync(path.join(base, 'versions', missingId)), false);
  rewritePointer(dataRoot, missingExe);
  const second = installer.install(b);
  const after = readDeps(dataRoot);
  assert.equal(samePath(after.value.heicDecoder.path, ffmpegExe(installer, second.releaseId)), true, after.value.heicDecoder.path);
});

win('A1 pointer naming an existing file with the wrong bytes is EXISTING_DEPENDENCY_CHANGED', {timeout: 180000}, t => {
  const tmp = temp(t);
  const {dataRoot, installer} = makeInstaller(tmp);
  const a = fixturePackage(tmp, 'a'.repeat(40));
  const b = fixturePackage(tmp, 'b'.repeat(40));
  installer.install(a);
  const decoy = path.join(tmp, 'decoy', 'ffmpeg.exe');
  write(tmp, 'decoy/ffmpeg.exe', 'not-the-reviewed-ffmpeg');
  rewritePointer(dataRoot, decoy);
  assert.throws(() => installer.install(b), err => err && err.code === 'EXISTING_DEPENDENCY_CHANGED');
  assert.equal(samePath(readDeps(dataRoot).value.heicDecoder.path, decoy), true);
});

win('A2 realpath redirect of current.json only: install, rollback and Stop refuse; status reports virtualized', {timeout: 180000}, t => {
  const tmp = temp(t);
  const {base, dataRoot, port, installer} = makeInstaller(tmp);
  const a = fixturePackage(tmp, 'a'.repeat(40));
  const b = fixturePackage(tmp, 'b'.repeat(40));
  installer.install(a);
  const overlay = path.join(tmp, 'Packages', 'Example_0000000000000', 'LocalCache', 'Local', 'ProjectHub', 'current.json');
  const current = path.join(base, 'current.json');
  const realpath = file => {
    const resolved = path.resolve(String(file));
    if (resolved.toLowerCase() === current.toLowerCase()) return overlay;
    return fs.realpathSync.native(file);
  };
  const virtual = new tool.Installer({installBase: base, dataRoot, port, realpath});
  const before = diskState(base, dataRoot);
  assert.throws(() => virtual.install(b), err => err && err.code === 'INSTALL_BASE_VIRTUALIZED');
  assert.throws(() => virtual.rollback(), err => err && err.code === 'INSTALL_BASE_VIRTUALIZED');
  assert.throws(() => virtual.launch(true), err => err && err.code === 'INSTALL_BASE_VIRTUALIZED');
  assert.deepEqual(diskState(base, dataRoot), before);
  const status = virtual.status();
  assert.equal(status.virtualized, true);
  assert.equal(typeof status.warning, 'string');
  assert.ok(status.warning.length > 0);
});

win('A2 packaged context inside userDataRoots is refused unless tempRoot contains the base', {timeout: 180000}, t => {
  const tmp = temp(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-installer-other-'));
  t.after(() => fs.rmSync(other, {recursive: true, force: true, maxRetries: 20, retryDelay: 100}));
  const a = fixturePackage(tmp, 'a'.repeat(40));
  const port = tool.native({mode: 'free-port'}).port;
  const base = path.join(tmp, 'ProjectHub');
  const dataRoot = path.join(tmp, 'AI-Workspace');
  const refused = new tool.Installer({
    installBase: base,
    dataRoot,
    port,
    packageContext: () => PACKAGED,
    userDataRoots: [tmp],
    tempRoot: other,
  });
  assert.throws(() => refused.preview(a), err => err && err.code === 'INSTALL_BASE_VIRTUALIZED');
  assert.throws(() => refused.install(a), err => err && err.code === 'INSTALL_BASE_VIRTUALIZED');
  const allowed = new tool.Installer({
    installBase: base,
    dataRoot,
    port,
    packageContext: () => PACKAGED,
    userDataRoots: [tmp],
    tempRoot: tmp,
  });
  let previewError = null;
  try {
    allowed.preview(a);
  } catch (error) {
    previewError = error;
  }
  assert.notEqual(previewError && previewError.code, 'INSTALL_BASE_VIRTUALIZED', previewError && previewError.code);
  assert.equal(previewError, null);
  assert.equal(allowed.status().packageContext, PACKAGED);
});
