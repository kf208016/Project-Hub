'use strict';
// Native owner-approval controller (windows/browser-login-approve.ps1) against a synthetic Hub stand-in
// that runs the REAL local-auth and browser-login handler. No provider, no real DataRoot, no real login file.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const http = require('node:http'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const win = process.platform === 'win32' ? test : test.skip;
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const hubDir = path.resolve(__dirname, '..');
const controller = path.join(hubDir, 'windows', 'browser-login-approve.ps1');
const helpers = path.join(__dirname, 'helpers');
// The controller resolves node.exe from PATH like the launcher does; make that the node running this test.
const psEnv = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
for (const name of ['HUB_ROOT', 'HUB_PORT', 'HUB_LOCAL_TOKEN', 'HUB_DRY_RUN']) delete psEnv[name];

function runPs(args, { input = '', timeout = 90000, hide = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', ...args], { env: psEnv, windowsHide: hide });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { child.kill(); reject(Error('powershell timeout')); }, timeout);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(input);
  });
}
const result = r => JSON.parse(r.out.trim().split(/\r?\n/).pop());
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}
function idle(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => child.kill());
  return new Promise(resolve => setTimeout(() => resolve(child), 400));
}
const exited = child => new Promise(resolve => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));

function request(port, method, url, body, headers = {}, host = '127.0.0.1') {
  const base = `http://${host}:${port}`;
  const h = { 'X-Hub': '1', 'Content-Type': 'application/json', Origin: base, ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request(base + url, { method, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, cookies: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(Error('request timeout')));
    req.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}

async function hub(t, { mode = 'normal', host = '127.0.0.1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-native-'));
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('base64url');
  const server = spawn(process.execPath, [path.join(helpers, 'browser-login-fixture-server.js')],
    { env: { ...process.env, FIXTURE_PORT: String(port), FIXTURE_TOKEN: token, FIXTURE_MODE: mode, FIXTURE_HOST: host }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('fixture server did not start')), 10000);
    server.stdout.on('data', d => { if (String(d).includes('ready')) { clearTimeout(timer); resolve(); } });
    server.on('exit', () => reject(Error('fixture server exited')));
  });
  t.after(() => { server.kill(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const f = { root, port, token, server, statePath: path.join(root, '_hub', 'desktop-state.json') };
  f.writeState = async (pid = server.pid, credential = token) => {
    const r = await runPs([path.join(helpers, 'write-desktop-state.ps1'), '-Root', root, '-Port', String(port), '-ProcessId', String(pid), '-HubDir', hubDir], { input: credential });
    assert.equal(r.code, 0, r.err);
    f.pristine = fs.readFileSync(f.statePath);
  };
  f.restore = () => { fs.mkdirSync(path.dirname(f.statePath), { recursive: true }); fs.writeFileSync(f.statePath, f.pristine); };
  f.mutate = fn => { f.restore(); const o = JSON.parse(f.pristine.toString('utf8')); fn(o); fs.writeFileSync(f.statePath, JSON.stringify(o)); };
  f.stats = async () => (await request(port, 'GET', '/__stats', undefined, {}, host)).body;
  f.begin = async () => { const r = await request(port, 'POST', '/api/local/browser/begin', {}); assert.equal(r.status, 200); return { id: r.body.requestId, cookie: r.cookies[0].split(';')[0] }; };
  f.poll = b => request(port, 'POST', '/api/local/browser/poll', { requestId: b.id }, { Cookie: b.cookie });
  f.run = async id => { const r = await runPs([controller, '-DataRoot', root, '-Port', String(port), '-RequestId', id]); return { ...r, json: result(r) }; };
  return f;
}
const refused = (r, reason) => { assert.equal(r.code, 1, r.out + r.err); assert.deepEqual(r.json, { ok: false, code: 'BROWSER_LOGIN_FAILED', reason }); };

win('controller proves the instance, approves exactly the observed ID, and the browser then gets the owner session once', { timeout: 120000 }, async t => {
  const f = await hub(t);
  await f.writeState();
  const b = await f.begin();
  assert.equal((await f.poll(b)).status, 202);
  const r = await f.run(b.id);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.out.trim(), '{"ok":true,"code":"BROWSER_LOGIN_APPROVED"}');
  const session = crypto.createHmac('sha256', f.token).update('project-hub-local-session-v1').digest('base64url');
  assert.equal((r.out + r.err).includes(f.token), false);
  assert.equal((r.out + r.err).includes(session), false);
  const done = await f.poll(b);
  assert.equal(done.status, 200);
  assert.ok(done.cookies.some(c => c.startsWith(`hub_local_session=${session};`)));
  assert.equal((await f.poll(b)).status, 409);
  assert.deepEqual(await f.stats(), { proofs: 1, logins: 1, loginAccepted: 1 });
});

win('controller refuses replayed, unknown and other IDs and leaves other pending requests untouched', { timeout: 120000 }, async t => {
  const f = await hub(t);
  await f.writeState();
  const used = await f.begin(), other = await f.begin();
  assert.equal((await f.run(used.id)).code, 0);
  refused(await f.run(used.id), 'REQUEST_REJECTED');
  refused(await f.run('f'.repeat(32)), 'REQUEST_REJECTED');
  assert.equal((await f.poll(other)).status, 202);
});

win('malformed request IDs are refused before any file or network access', { timeout: 120000 }, async t => {
  const f = await hub(t);
  await f.writeState();
  for (const id of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'a'.repeat(16) + ' ' + 'a'.repeat(15), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0123456789abcdef0123456789abcdef\n']) {
    refused(await f.run(id), 'INVALID_REQUEST_ID');
  }
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});

win('an impostor that cannot answer the HMAC proof never receives the credential', { timeout: 120000 }, async t => {
  for (const [mode, reason] of [['wrong-proof', 'PROOF_MISMATCH'], ['oversized-proof', 'RESPONSE_TOO_LARGE']]) {
    const f = await hub(t, { mode });
    await f.writeState();
    refused(await f.run('a'.repeat(32)), reason);
    const stats = await f.stats();
    assert.equal(stats.proofs, 1);
    assert.equal(stats.logins, 0);
  }
});

win('a saved credential that belongs to another Hub instance fails the proof and is never sent', { timeout: 120000 }, async t => {
  const f = await hub(t);
  await f.writeState(f.server.pid, crypto.randomBytes(32).toString('base64url'));
  refused(await f.run('a'.repeat(32)), 'PROOF_MISMATCH');
  assert.equal((await f.stats()).logins, 0);
});

win('wrong or malformed saved state is refused before any request is made', { timeout: 300000 }, async t => {
  const f = await hub(t);
  await f.writeState();
  const cases = [
    ['root differs', o => { o.root += 'x'; }, 'STATE_ROOT_MISMATCH'],
    ['hubDir differs by case', o => { o.hubDir = o.hubDir.replace(/hub$/, 'HUB'); }, 'STATE_HUBDIR_MISMATCH'],
    ['port differs', o => { o.port += 1; }, 'STATE_PORT_MISMATCH'],
    ['version is a string', o => { o.version = '1'; }, 'STATE_INVALID'],
    ['pid is a string', o => { o.pid = String(o.pid); }, 'STATE_INVALID'],
    ['pid is zero', o => { o.pid = 0; }, 'STATE_INVALID'],
    ['ticks are not digits', o => { o.createdTicks = '12x'; }, 'STATE_INVALID'],
    ['ticks carry a trailing newline', o => { o.createdTicks += '\n'; }, 'STATE_INVALID'],
    ['credential is not base64', o => { o.protectedToken = 'not base64!'; }, 'STATE_INVALID'],
    ['credential is missing', o => { delete o.protectedToken; }, 'STATE_INVALID'],
    ['recoveryOnly is not boolean', o => { o.recoveryOnly = 'yes'; }, 'STATE_INVALID'],
    ['creation time differs', o => { o.createdTicks = String(BigInt(o.createdTicks) + 1n); }, 'PROCESS_IDENTITY_MISMATCH'],
    ['credential is not DPAPI data', o => { o.protectedToken = 'AAAA'; }, 'CREDENTIAL_UNAVAILABLE'],
  ];
  for (const [name, mutate, reason] of cases) {
    f.mutate(mutate);
    const r = await f.run('a'.repeat(32));
    assert.equal(r.code, 1, name);
    assert.equal(r.json.reason, reason, name);
  }
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});

win('dead, non-node, non-listening and foreign-listener processes are refused before any request', { timeout: 300000 }, async t => {
  const f = await hub(t);
  const victim = await idle(t);
  await f.writeState(victim.pid);
  victim.kill();
  await exited(victim);
  refused(await f.run('a'.repeat(32)), 'PROCESS_NOT_FOUND');

  const shell = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => shell.kill());
  await new Promise(resolve => setTimeout(resolve, 800));
  await f.writeState(shell.pid);
  refused(await f.run('a'.repeat(32)), 'PROCESS_PATH_MISMATCH');

  const bystander = await idle(t); // a live node.exe that does not own the port
  await f.writeState(bystander.pid);
  refused(await f.run('a'.repeat(32)), 'LISTENER_MISMATCH');

  // The saved PID IS the listener, but a second process also listens on the same port (IPv6 loopback).
  await f.writeState();
  const extra = spawn(process.execPath, ['-e', `require('net').createServer().on('error',()=>process.exit(3)).listen(${f.port},'::1',()=>console.log('ready'))`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => extra.kill());
  const bound = await new Promise(resolve => { extra.stdout.on('data', () => resolve(true)); extra.on('exit', () => resolve(false)); });
  if (bound) refused(await f.run('a'.repeat(32)), 'LISTENER_MISMATCH');
  else t.diagnostic('IPv6 loopback is unavailable here; the foreign-listener case was not exercised');
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});

win('missing, oversized, undecodable and aliased state is refused without creating anything', { timeout: 300000 }, async t => {
  const f = await hub(t);
  await f.writeState();
  fs.rmSync(f.statePath);
  refused(await f.run('a'.repeat(32)), 'STATE_MISSING');
  fs.mkdirSync(f.statePath);
  refused(await f.run('a'.repeat(32)), 'STATE_MISSING');
  fs.rmdirSync(f.statePath);
  fs.writeFileSync(f.statePath, JSON.stringify({ ...JSON.parse(f.pristine.toString('utf8')), pad: 'x'.repeat(17000) }));
  refused(await f.run('a'.repeat(32)), 'STATE_TOO_LARGE');
  for (const bytes of [Buffer.alloc(0), Buffer.from('not json'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), Buffer.from('[]'), Buffer.from('"text"')]) {
    fs.writeFileSync(f.statePath, bytes);
    refused(await f.run('a'.repeat(32)), 'STATE_INVALID');
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.dirname(f.statePath), { recursive: true, force: true });
  fs.symlinkSync(outside, path.dirname(f.statePath), 'junction');
  refused(await f.run('a'.repeat(32)), 'PATH_NOT_LOCAL');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});

win('controller shares its constants with the launcher and the server and cannot start or restart anything', () => {
  const script = fs.readFileSync(controller, 'utf8');
  const launcher = fs.readFileSync(path.join(hubDir, 'start-windows.ps1'), 'utf8');
  const localAuth = fs.readFileSync(path.join(hubDir, 'lib', 'local-auth.js'), 'utf8');
  const entropy = "'ProjectHub.Windows.Launcher.v1'";
  assert.ok(script.includes(entropy) && launcher.includes(entropy), 'DPAPI entropy drifted from the launcher');
  assert.ok(script.includes("'project-hub-instance-v1:'") && localAuth.includes("'project-hub-instance-v1:'"), 'proof prefix drifted from local-auth');
  assert.ok(script.includes('hub_local_session=') && localAuth.includes("'hub_local_session'"), 'session cookie name drifted');
  assert.ok(script.includes('16384') && launcher.includes('16384'), 'state size bound drifted');
  assert.doesNotMatch(script, /Start-Process|Invoke-Expression|Invoke-Item|\biex\b|Set-Clipboard|Out-File|Set-Content|Add-Content|WriteAllText|HUB_LOCAL_TOKEN/);
  assert.doesNotMatch(script, /^\s*\.\s+\S/m, 'must not dot-source the launcher');
  // Reading $env:OS is the only environment access; nothing may be written to or passed through it.
  // Add-Type compiles through csc.exe into %TEMP% and fails for non-ANSI or read-only TEMP folders; the hidden child would then have no window.
  assert.doesNotMatch(script, /Add-Type\s+(-Namespace|-TypeDefinition|-MemberDefinition)/, 'the dialog path must not compile code (csc + TEMP can fail)');
  assert.doesNotMatch(script, /\$env:(?!OS\b)/i, 'no credential or state may travel through the environment');
  assert.doesNotMatch(script, /SetEnvironmentVariable|Env:\\/i);
});

async function dialog(t) {
  const f = await hub(t);
  await f.writeState();
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', controller, '-DataRoot', f.root, '-Port', String(f.port)], { env: psEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const closed = new Promise(resolve => child.on('close', code => resolve({ code, json: out.trim() ? result({ out }) : null })));
  const drive = (button, text) => runPs([path.join(helpers, 'drive-approval-dialog.ps1'), '-ProcessId', String(child.pid), '-Title', 'Project Hub 本機登入確認', '-ButtonName', button, '-Text', text], { hide: false });
  return { f, child, closed, drive };
}

win('native window rejects a malformed code without closing, then approves a pasted code with case and hyphen noise', { timeout: 180000 }, async t => {
  const { f, child, closed, drive } = await dialog(t);
  const b = await f.begin();
  const bad = await drive('核准登入', 'zzz');
  assert.equal(bad.out.trim(), 'INVOKED', bad.out + bad.err);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(child.exitCode, null, 'the window must stay open after a malformed code');
  assert.equal((await f.stats()).proofs, 0);
  const pasted = b.id.replace(/(.{8})(?=.)/g, '$1-').toUpperCase();
  const good = await drive('核准登入', pasted);
  assert.equal(good.out.trim(), 'INVOKED', good.out + good.err);
  const end = await closed;
  assert.equal(end.code, 0);
  assert.deepEqual(end.json, { ok: true, code: 'BROWSER_LOGIN_APPROVED' });
  assert.equal((await f.poll(b)).status, 200);
});

win('native window cancel approves nothing and reports a fixed reason', { timeout: 180000 }, async t => {
  const { f, closed, drive } = await dialog(t);
  const b = await f.begin();
  const cancelled = await drive('取消', b.id);
  assert.equal(cancelled.out.trim(), 'INVOKED', cancelled.out + cancelled.err);
  const end = await closed;
  assert.equal(end.code, 1);
  assert.deepEqual(end.json, { ok: false, code: 'BROWSER_LOGIN_FAILED', reason: 'CANCELLED' });
  assert.equal((await f.poll(b)).status, 202);
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});


win('a Hub that listens on another address than 127.0.0.1 is refused before any request', { timeout: 120000 }, async t => {
  // 127.0.0.2 is a loopback alias: the saved PID IS the listener, only the ADDRESS is wrong.
  // A correct controller stops at the listener check; one that skips the address check goes on to talk to 127.0.0.1 and fails differently.
  const f = await hub(t, { host: '127.0.0.2' });
  await f.writeState();
  refused(await f.run('a'.repeat(32)), 'LISTENER_MISMATCH');
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});

win('a saved credential of the wrong length or alphabet is refused before any request', { timeout: 180000 }, async t => {
  const f = await hub(t);
  for (const credential of ['a'.repeat(20), 'a'.repeat(44), '+'.repeat(43)]) {
    await f.writeState(f.server.pid, credential);
    refused(await f.run('a'.repeat(32)), 'CREDENTIAL_INVALID');
  }
  assert.deepEqual(await f.stats(), { proofs: 0, logins: 0, loginAccepted: 0 });
});

win('a login answer with a malformed or doubled session cookie is refused and nothing is approved', { timeout: 180000 }, async t => {
  for (const mode of ['odd-cookie', 'two-cookies']) {
    const f = await hub(t, { mode });
    await f.writeState();
    const b = await f.begin();
    refused(await f.run(b.id), 'LOGIN_REJECTED');
    assert.equal((await f.poll(b)).status, 202, mode + ': the request must stay unapproved');
    assert.equal((await f.stats()).loginAccepted, 1, mode + ': the login itself was accepted by the server');
  }
});

win('the hidden approval child shows its window even when TEMP is a folder with characters outside the ANSI code page', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-approve-temp-'));
  const badTemp = path.join(root, '\u0e17\u0e14\u0e2a\u0e2d\u0e1a-temp');
  fs.mkdirSync(badTemp);
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const starter = path.join(root, 'start-hidden.ps1');
  fs.writeFileSync(starter, [
    'param([string]$Script,[string]$Root,[int]$Port,[string]$Temp)',
    '$env:TEMP = $Temp; $env:TMP = $Temp',
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$p = Start-Process -FilePath $ps -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','RemoteSigned','-File',('\"' + $Script + '\"'),'-DataRoot',('\"' + $Root + '\"'),'-Port',\"$Port\")",
    '[Console]::Out.WriteLine($p.Id)',
    '',
  ].join('\r\n'), { encoding: 'ascii' });
  const started = await runPs([starter, '-Script', controller, '-Root', root, '-Port', String(await freePort()), '-Temp', badTemp]);
  const pid = Number(started.out.trim().split(/\s+/).pop());
  assert.ok(pid > 0, started.out + started.err);
  require('./helpers/owned-pid').rememberPid(pid);t.after(() => require('./helpers/owned-pid').killPid(pid));
  const driven = await runPs([path.join(helpers, 'drive-approval-dialog.ps1'), '-ProcessId', String(pid), '-Title', 'Project Hub 本機登入確認', '-ButtonName', '取消', '-Text', 'x'], { hide: false });
  assert.equal(driven.out.trim(), 'INVOKED', 'the window never appeared: ' + driven.out + driven.err);
});