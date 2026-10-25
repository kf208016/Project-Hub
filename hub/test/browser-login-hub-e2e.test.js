'use strict';
// The real launcher starts the real Hub (server.js) in a temporary DataRoot with a synthetic CLI fixture; the native approval
// controller then runs in its non-interactive mode. No browser, no window, no provider, no model. This is the only test that
// ties launcher state (DPAPI token, PID, port) to the controller and to the server routes.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const { execFile } = require('node:child_process');

const win = process.platform === 'win32' ? test : test.skip;
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const hubDir = path.resolve(__dirname, '..');
const launcher = path.join(hubDir, 'start-windows.ps1');
const controller = path.join(hubDir, 'windows', 'browser-login-approve.ps1');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function environment(root) {
  const fixture = require('./helpers/portable-cli').install(root, "if(process.argv.includes('--version')){console.log('codex-cli fixture');process.exit(0);}throw Error('e2e fixture must not run model requests');", 'codex');
  const env = { ...process.env, PATH: fixture.bin + path.delimiter + process.env.PATH, HUB_AI_HOME: path.join(root, 'home') };
  delete env.HUB_DRY_RUN; delete env.HUB_LOCAL_TOKEN;
  return env;
}
function powershell(args, env, timeout = 60000) {
  return new Promise(resolve => execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', ...args], { windowsHide: true, env, timeout }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: String(stdout), err: String(stderr) })));
}
function call(port, method, route, body, headers = {}) {
  const base = `http://127.0.0.1:${port}`;
  const merged = { 'X-Hub': '1', 'Content-Type': 'application/json', Origin: base, Connection: 'close', ...headers };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return new Promise((resolve, reject) => {
    const request = http.request(base + route, { method, headers: merged }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: response.statusCode, json, text, cookies: response.headers['set-cookie'] || [] });
      });
    });
    request.on('error', reject);
    request.setTimeout(8000, () => request.destroy(Error('request timeout')));
    request.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}

async function scenario(t, extraLauncherArgs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-e2e-'));
  const port = await freePort();
  const env = { ...environment(root), HUB_ROOT: root, HUB_PORT: String(port) };
  t.after(async () => {
    await powershell([launcher, '-NoBrowser', '-Stop'], env);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const started = await powershell([launcher, '-NoBrowser', ...extraLauncherArgs], env);
  assert.equal(started.code, 0, 'launcher failed: ' + started.out + started.err);
  assert.doesNotMatch(started.out + started.err, /#auth=/);

  assert.equal((await call(port, 'GET', '/api/state', undefined, { Origin: undefined })).status, 200, 'local access works before optional legacy login');
  const begin = await call(port, 'POST', '/api/local/browser/begin', {});
  assert.equal(begin.status, 200, begin.text);
  const id = begin.json.requestId;
  assert.match(id, /^[0-9a-f]{32}$/);
  const pending = begin.cookies[0].split(';')[0];
  assert.equal((await call(port, 'POST', '/api/local/browser/poll', { requestId: id }, { Cookie: pending })).status, 202);

  const approved = await powershell([controller, '-DataRoot', root, '-Port', String(port), '-RequestId', id], env);
  assert.equal(approved.code, 0, 'controller failed: ' + approved.out + approved.err);
  assert.equal(approved.out.trim(), '{"ok":true,"code":"BROWSER_LOGIN_APPROVED"}');

  const done = await call(port, 'POST', '/api/local/browser/poll', { requestId: id }, { Cookie: pending });
  assert.equal(done.status, 200, done.text);
  const session = done.cookies.map(value => value.split(';')[0]).find(value => value.startsWith('hub_local_session='));
  assert.ok(session, 'poll must hand over the owner session cookie');
  assert.ok(done.cookies.some(value => /Max-Age=0/.test(value)), 'poll must clear the pending cookie');
  const secret = session.split('=')[1];
  assert.equal((started.out + started.err + approved.out + approved.err).includes(secret), false, 'a credential leaked into process output');
  assert.equal((await call(port, 'GET', '/api/state', undefined, { Cookie: session, Origin: undefined })).status, 200, 'the session cookie must open the Hub');
  assert.equal((await call(port, 'POST', '/api/local/browser/poll', { requestId: id }, { Cookie: pending })).status, 409, 'the session may be taken once');
}

win('real launcher + real Hub + approval controller: begin, native approval, one-time session (normal mode)', { timeout: 240000 }, async t => {
  await scenario(t, []);
});
// RecoveryOnly is deliberately NOT started through the launcher here: it refuses a DataRoot that has no data-format marker, and that
// marker is only written by the web-chat format upgrade. The recovery server and its routes are covered in-process by
// browser-login-server.test.js (cases 5.1.7, 5.1.9, 5.1.10).