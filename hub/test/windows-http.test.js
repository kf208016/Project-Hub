'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const winOnly = process.platform === 'win32' ? test : test.skip;
winOnly('Windows browser API requires a local session and rejects remote requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-http-'));
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
    try { const response = await fetch(base + '/api/state'); if (response.status === 401) { ready = true; break; } }
    catch { /* wait for local startup */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, stderr);
  const payload = JSON.stringify({ name: '試用專案' });
  assert.equal((await fetch(base + '/api/project/new', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: payload })).status, 401);
  assert.equal((await fetch(base + '/api/local/login', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) })).status, 403);
  const login = await fetch(base + '/api/local/login', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie, 'X-Forwarded-For': '203.0.113.1' } })).status, 403);
  const create = await fetch(base + '/api/project/new', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: payload });
  assert.equal(create.status, 200, await create.text());
  const post = path => fetch(base + path, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  for (const route of ['/api/restart', '/api/ai-tools/update', '/api/task/merge', '/api/task/integrate', '/api/empty/trash', '/api/maintenance/verify']) {
    assert.equal((await post(route)).status, 409, route);
  }
  assert.equal((await post('/api/mcp/call')).status, 403, 'browser session alone cannot become an MCP capability');
  fs.writeFileSync(brokerMarker, 'synthetic owned request');
  assert.equal((await post('/api/quit')).status, 409, 'an active broker request prevents stopping Hub');
  fs.unlinkSync(brokerMarker);
  assert.equal((await post('/api/quit')).status, 200, 'after its helper closes Hub can stop');
});
