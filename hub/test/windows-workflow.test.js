'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { Store } = require('../lib/store');
const chat = require('../lib/chat');

const winOnly = process.platform === 'win32' ? test : test.skip;
winOnly('Windows API starts Codex only in a Git worktree and rejects a non-Git body', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-flow-'));
  const repo = path.join(root, 'source'), plain = path.join(root, 'plain');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(plain);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' } });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'source\n');
  git('add', 'README.md'); git('commit', '-q', '-m', 'initial');
  fs.writeFileSync(path.join(repo, '.env'), 'DUMMY_NOT_SECRET');
  const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
  require('./helpers/codex-server').install(bin);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const secret = 'D'.repeat(43);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HUB_ROOT: root, HUB_TRASH: path.join(root, '_hub', 'Trash'),
      HUB_AI_HOME: path.join(root, 'empty-home'), HUB_PORT: String(port), HUB_LOCAL_TOKEN: secret }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString('utf8').slice(0, 1000); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(stderr);
    try { if ((await fetch(base + '/api/state')).status === 401) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, stderr);
  const login = await fetch(base + '/api/local/login', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await post('/api/project/new', { name: 'isolated', body: repo })).status, 200);
  assert.equal((await post('/api/project/new', { name: 'no-git', body: plain })).status, 200);
  const denied = await post('/api/start', { project: 'no-git', ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'test', images: [] });
  assert.equal(denied.status, 409, await denied.text());
  assert.equal(fs.existsSync(path.join(plain, '.git')), false);
  const accepted = await post('/api/start', { project: 'isolated', ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'test', images: [] });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const task = (await accepted.json()).task;
  const store = new Store(root);
  const project = store.readProject('isolated');
  const row = project.tasks.find(x => x.id === task);
  assert.ok(row.workdir.startsWith(path.join(root, 'Work', 'isolated') + path.sep));
  assert.equal(fs.existsSync(path.join(row.workdir, '.env')), false);
  let reply;
  for (let i = 0; i < 100; i++) {
    reply = chat.read(project.dir, task).findLast(x => x.role === 'assistant');
    if (reply) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(reply?.text, 'fixture reply');
  assert.equal(reply?.error, '');
});
