'use strict';
const {waitForHub,waitFor}=require('./helpers/wait-hub');
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
winOnly('Windows API requires reviewed workspace consent before Git and non-Git Codex starts',{timeout:180000},async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-flow-'));
  const repo = path.join(root, 'source'), plain = path.join(root, 'plain');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(plain);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' } });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
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
  const preload=path.join(root,'server-fixture.cjs'),hub=path.join(__dirname,'..');fs.writeFileSync(preload,`const pw=require(${JSON.stringify(path.join(hub,'lib/procwatch'))}),create=pw.create;pw.create=o=>create({...o,exec:async()=>JSON.stringify([{pid:process.pid,ppid:0,since:new Date().toISOString(),name:'node.exe',command:'synthetic fixture controller'}])});const {server,PORT}=require(${JSON.stringify(path.join(hub,'server.js'))});server.listen(PORT,'127.0.0.1',()=>console.log('HUB_LISTENING'));`);
  const child = spawn(process.execPath, [preload], { cwd: path.join(__dirname, '..'),
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HUB_ROOT: root, HUB_TRASH: path.join(root, '_hub', 'Trash'),
      HUB_AI_HOME: path.join(root, 'empty-home'), HUB_PORT: String(port), HUB_LOCAL_TOKEN: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString('utf8').slice(0, 1000); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHub(base,child,()=>stderr);
  const login = await fetch(base + '/api/local/login', { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await post('/api/project/new', { name: 'isolated', body: repo })).status, 200);
  assert.equal((await post('/api/project/new', { name: 'no-git', body: plain })).status, 200);
  const denied = await post('/api/start', { project: 'no-git', ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'test', images: [] });
  assert.equal(denied.status, 409, await denied.clone().text());
  assert.equal(fs.existsSync(path.join(plain, '.git')), false);
  const freshStart=async request=>{const first=await post('/api/start',request);assert.equal(first.status,409,await first.clone().text());const needed=await first.json();assert.equal(needed.code,'WORKSPACE_REQUIRED');const scope={project:request.project,task:needed.task},preview=await post('/api/task/workspace/preview',{...scope,secrets:[]});assert.equal(preview.status,200,await preview.clone().text());const pv=await preview.json(),prepared=await post('/api/task/workspace/prepare',{...scope,token:pv.token,confirm:true,ackReadLimits:true,ackNetworkLimits:true});assert.equal(prepared.status,200,await prepared.clone().text());return post('/api/start',{...request,task:scope.task,workspacePermit:(await prepared.json()).permit});};
  const accepted = await freshStart({ project: 'isolated', ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'test', images: [] });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const task = (await accepted.json()).task;
  const store = new Store(root);
  const project = store.readProject('isolated');
  const row = project.tasks.find(x => x.id === task);
  assert.ok(row.workdir.startsWith(path.join(root, 'Work', 'isolated') + path.sep));
  assert.equal(fs.existsSync(path.join(row.workdir, '.env')), false);
  const reply=await waitFor(()=>chat.read(project.dir,task).findLast(x=>x.role==='assistant'),{deadlineMs:30000});
  assert.equal(reply?.text, 'fixture reply');
  assert.equal(reply?.error, '');
  const deniedValue=await denied.json();assert.equal(deniedValue.code,'WORKSPACE_REQUIRED');const scope={project:'no-git',task:deniedValue.task},pv=await(await post('/api/task/workspace/preview',{...scope,secrets:[]})).json(),prepared=await post('/api/task/workspace/prepare',{...scope,token:pv.token,confirm:true,ackReadLimits:true,ackNetworkLimits:true});assert.equal(prepared.status,200,await prepared.clone().text());const nongit=await post('/api/start',{...scope,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'test',images:[],workspacePermit:(await prepared.json()).permit});assert.equal(nongit.status,200,await nongit.clone().text());assert.equal(fs.existsSync(path.join(plain,'.git')),true);assert.equal(store.readProject('no-git').tasks.length,1);assert.equal(store.readProject('isolated').tasks.length,1);
});
