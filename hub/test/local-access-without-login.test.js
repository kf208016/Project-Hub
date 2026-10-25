'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const winOnly = process.platform === 'win32' ? test : test.skip;

function request(port, { method = 'GET', path: pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...headers,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startHub(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-local-access-'));
  const secret = 'C'.repeat(43);
  const brokerMarker = path.join(root, 'broker-active'), preload = path.join(root, 'broker-status.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.resolve(__dirname, '../lib/scoped-file'))}).active=()=>require('node:fs').existsSync(${JSON.stringify(brokerMarker)})?1:0;`);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HUB_ROOT: root, HUB_AI_HOME: path.join(root, 'empty-home'),
      HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_LOCAL_TOKEN: secret },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 1000); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(`server exited: ${stderr}`);
    try { const response = await fetch(base + '/api/state'); if (response.status) { ready = true; break; } }
    catch { /* wait for local startup */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, stderr);
  return { port, stderr };
}

winOnly('same-machine access without login', { timeout: 30000 }, async t => {
  const { port } = await startHub(t);
  const postRead = (headers = {}) => request(port, {
    method: 'POST', path: '/api/task/read', headers, body: { project: 'x', task: 'y' },
  });

  await t.test('GET /api/state with Host 127.0.0.1 and no cookie returns 200', async () => {
    const res = await request(port, { path: '/api/state' });
    assert.equal(res.status, 200, res.text);
  });

  await t.test('POST /api/task/read with X-Hub and no cookie is not 401', async () => {
    const res = await postRead({ 'X-Hub': '1' });
    assert.notEqual(res.status, 401, res.text);
  });

  await t.test('POST /api/task/read without X-Hub is 403', async () => {
    const res = await postRead();
    assert.equal(res.status, 403, res.text);
  });

  await t.test('POST /api/task/read with wrong Host is 403', async () => {
    const res = await postRead({ Host: 'evil.example', 'X-Hub': '1' });
    assert.equal(res.status, 403, res.text);
  });

  await t.test('POST /api/task/read with Origin http://evil.example is 403', async () => {
    const res = await postRead({ 'X-Hub': '1', Origin: 'http://evil.example' });
    assert.equal(res.status, 403, res.text);
  });

  await t.test('any request with x-forwarded-for is 403', async () => {
    const res = await request(port, { path: '/api/state', headers: { 'x-forwarded-for': '203.0.113.1' } });
    assert.equal(res.status, 403, res.text);
  });

  await t.test('owner-only /api/commands/decide without cookie is not a login refusal', async () => {
    const res = await request(port, {
      method: 'POST', path: '/api/commands/decide', headers: { 'X-Hub': '1' },
      body: { id: 'x', decision: 'approve', confirm: true },
    });
    assert.notEqual(res.status, 401, res.text);
    assert.equal(res.text.includes('請由 Windows 啟動器開啟'), false, res.text);
    assert.equal(res.text.includes('本機已登入使用者'), false, res.text);
  });

  await t.test('owner-only /api/commands/decide with MCP Bearer is 403', async () => {
    const res = await request(port, {
      method: 'POST', path: '/api/commands/decide',
      headers: { 'X-Hub': '1', Authorization: 'Bearer ' + 'A'.repeat(43) },
      body: { id: 'x', decision: 'approve', confirm: true },
    });
    assert.equal(res.status, 403, res.text);
  });
});

winOnly('start-windows.ps1 no longer Start-Process launches browser-login-approve.ps1', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start-windows.ps1'), 'utf8');
  const launchesApproval =
    /Start-Process[^\n]*\$approval(PowerShell|Script)/.test(source) ||
    /Start-Process[\s\S]{0,400}ConvertTo-WindowsArgument \$approvalScript/.test(source) ||
    /Start-Process[^\n]*browser-login-approve\.ps1/.test(source);
  assert.equal(launchesApproval, false, 'start-windows.ps1 still Start-Process launches browser-login-approve.ps1');
});
