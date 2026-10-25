'use strict';
const {waitForHub,waitFor}=require('./helpers/wait-hub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { CapabilityAuth, READ_TOOLS } = require('../lib/capability-auth');
const { Chatgpt, validateArguments } = require('../lib/chatgpt');
const { Remote, cookieOf } = require('../lib/remote');
const { Store } = require('../lib/store');
const chat = require('../lib/chat');
const runId = () => crypto.randomUUID(), nonce = () => crypto.randomUUID();
const rejected = operation => assert.throws(operation, error => error.status === 403);

test('Windows capability settings schema is valid JSON with distinct module/browser grants',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/mcp-settings.schema.json'),'utf8'));
  assert.ok(schema.required.includes('runId'));assert.equal(schema.$defs.browserIssue.properties.confirm.const,true);
  assert.equal(schema.$defs.browserIssue.properties.root,undefined);assert.equal(schema.$defs.browserIssue.properties.runId,undefined);
  assert.equal(schema.$defs.browserRevoke.properties.confirm.const,true);assert.deepEqual(schema.properties.tools.default,READ_TOOLS.filter(name=>name!=='hub_read_file'));
  assert.equal(schema.additionalProperties,false);assert.equal(schema.$defs.moduleIssue.$ref,'#');
  assert.equal(schema.properties.workspaceRun.type,'string');assert.equal(schema.properties.workspaceRun.pattern,schema.properties.runId.pattern);
  assert.match(schema.properties.workspaceRun.description,/Private issuer field/);assert.match(schema.properties.workspaceRun.description,/cannot be reconstructed from task metadata/);
  assert.equal(schema.required.includes('workspaceRun'),false,'An isolated grant does not require a direct workspace binding');
  assert.equal(schema.$defs.browserIssue.additionalProperties,false);assert.equal(schema.$defs.browserIssue.properties.workspaceRun,undefined);assert.equal(schema.$defs.browserRevoke.properties.workspaceRun,undefined);
  const binding=schema.allOf.find(rule=>rule.if?.required?.length===1&&rule.if.required[0]==='workspaceRun');
  assert.ok(binding,'workspaceRun has an explicit conditional grant shape');assert.deepEqual(binding.then.required,['task','tools']);
  assert.deepEqual(binding.then.properties.tools.contains.enum,['hub_read_file','hub_write_file','hub_request_command','hub_get_command_result','hub_delegate']);
});

test('Windows workspace-run examples agree with declared schema fields and private runtime binding',()=>{
  // These are explicit shape/pattern/example checks, not a general JSON Schema validator.
  const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/mcp-settings.schema.json'),'utf8'));
  const privateRun='controller_workspace_run_20261009',moduleExample={project:'fixture-project',task:'fixture-task',runId:'fixture_hub_run_20261009',root:'C:\\synthetic\\ReviewedWorkspace',rootFingerprint:'a'.repeat(64),workspaceRun:privateRun,tools:['hub_read_file','hub_request_command','hub_get_command_result'],taskHash:'b'.repeat(64),ttlMs:600000,maxCalls:100};
  const browserExample={project:moduleExample.project,task:moduleExample.task,tools:moduleExample.tools.slice(),confirm:true,expectedHash:moduleExample.taskHash};
  assert.ok(Object.keys(moduleExample).every(key=>Object.hasOwn(schema.properties,key)));
  assert.ok(Object.keys(browserExample).every(key=>Object.hasOwn(schema.$defs.browserIssue.properties,key)));
  for(const key of ['runId','workspaceRun','root','rootFingerprint','taskHash'])assert.ok(new RegExp(schema.properties[key].pattern).test(moduleExample[key]),key);
  assert.ok(moduleExample.tools.every(tool=>schema.properties.tools.items.enum.includes(tool)));
  assert.equal(browserExample.confirm,schema.$defs.browserIssue.properties.confirm.const);
  assert.ok(new RegExp(schema.$defs.browserIssue.properties.expectedHash.pattern).test(browserExample.expectedHash));
  const identifiers=new RegExp(schema.properties.workspaceRun.pattern);
  for(const value of ['a'.repeat(16),'a'.repeat(128),privateRun])assert.ok(identifiers.test(value));
  for(const value of ['a'.repeat(15),'a'.repeat(129),'workspace/run_20261009','workspace run_20261009','workspace_run_20261009\n'])assert.equal(identifiers.test(value),false);
  assert.equal(Object.hasOwn(schema.$defs.browserIssue.properties,'workspaceRun'),false,'Browser callers cannot select the private controller run');
  assert.equal(validateArguments('hub_read_file',{project:moduleExample.project,task:moduleExample.task,path:'src/file.js',workspaceRun:privateRun}),false,'MCP tool arguments cannot select the private controller run');
  if(process.platform==='win32'){
    const auth=new CapabilityAuth(),grant=auth.issue(moduleExample);
    assert.equal(auth.current(grant.capability.id,moduleExample.runId).workspaceRun,privateRun);
    assert.equal(auth.inspect(grant.token,moduleExample.runId).workspaceRun,undefined,'The public grant snapshot omits private runtime authority');
    for(const workspaceRun of ['short',17,null])rejected(()=>auth.issue({...moduleExample,workspaceRun}));
    rejected(()=>auth.issue({project:moduleExample.project,task:moduleExample.task,runId:moduleExample.runId,workspaceRun:privateRun,tools:['hub_report']}));
  }
});

test('MCP grants default to one project/run and read tools, hash secrets and revoke on restart', () => {
  const auth = new CapabilityAuth(), run = runId(), grant = auth.issue({ project: 'one', runId: run });
  assert.deepEqual(grant.capability.tools, READ_TOOLS);
  assert.equal(grant.capability.project, 'one'); assert.equal(grant.capability.runId, run);
  assert.ok(!READ_TOOLS.includes('hub_list_projects')); assert.ok(!READ_TOOLS.includes('hub_report'));
  assert.equal([...auth.records.keys()][0], crypto.createHash('sha256').update(grant.token).digest('hex'));
  assert.equal(JSON.stringify([...auth.records.values()]).includes(grant.token), false);
  rejected(() => new CapabilityAuth().inspect(grant.token, run));
  for (const scope of [{}, { project: '*', runId: 'short' }, { project: '../two', runId: run }, { project: 'one', runId: run, tools: [] }, { project: 'one', runId: run, tools: ['hub_get_task', 'hub_get_task'] }, { project: 'one', runId: run, ttlMs: '1000' }, { project: 'one', runId: run, maxCalls: 0 }, { project: 'one', runId: run, future: true }]) rejected(() => auth.issue(scope));
});

test('MCP rejects cross-project/task, wrong run, malformed arguments and consumes nonce once', async () => {
  const auth = new CapabilityAuth(), run = runId();
  const grant = auth.issue({ project: 'one', task: 't', runId: run, tools: ['hub_get_task', 'hub_mark_step'] });
  const request = { token: grant.token, runId: run, nonce: nonce(), tool: 'hub_mark_step', arguments: { project: 'one', task: 't', index: 0, done: false } };
  for (const changed of [{ arguments: { ...request.arguments, project: 'two' } }, { arguments: { ...request.arguments, task: 'other' } }, { runId: runId() }, { nonce: 10 }, { nonce: 'x'.repeat(129) }, { arguments: { ...request.arguments, index: '0' } }, { arguments: { ...request.arguments, done: 'false' } }, { arguments: { ...request.arguments, extra: true } }, { tool: 'hub_write_file' }]) rejected(() => auth.consume({ ...request, ...changed }));
  assert.equal(auth.inspect(grant.token, run).remainingCalls, 100);
  const attempts = await Promise.allSettled([Promise.resolve().then(() => auth.consume(request)), Promise.resolve().then(() => auth.consume(request))]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(auth.inspect(grant.token, run).remainingCalls, 99);
  rejected(() => auth.consume(request));
  assert.equal(auth.revoke(grant.capability.id), 1); rejected(() => auth.inspect(grant.token, run));
});

test('MCP limits expiry/call budget, revokes a run and fails closed on an invalid clock', () => {
  let now = 1700000000000;
  const auth = new CapabilityAuth({ now: () => now }), run = runId();
  const grant = auth.issue({ project: 'one', runId: run, maxCalls: 1, ttlMs: 1000 });
  auth.consume({ token: grant.token, runId: run, nonce: nonce(), tool: 'hub_list_tasks', arguments: { project: 'one' } });
  rejected(() => auth.inspect(grant.token, run));
  const expires = auth.issue({ project: 'one', runId: run, ttlMs: 1000 }); now += 1000;
  rejected(() => auth.inspect(expires.token, run));
  const active = auth.issue({ project: 'one', runId: run }); assert.equal(auth.revokeRun(run), 1); rejected(() => auth.inspect(active.token, run));
  const broken = auth.issue({ project: 'one', runId: run }); [...auth.records.values()][0].expiresAt = NaN; rejected(() => auth.inspect(broken.token, run));
  const backwards = auth.issue({ project:'one',runId:run }); now--; rejected(()=>auth.inspect(backwards.token,run)); now++;
  now = NaN; rejected(() => auth.issue({ project: 'one', runId: run }));
});

test('MCP monotonic deadline does not extend a grant when wall time moves backwards within its lifetime',()=>{
  let now=1700000000000,mono=100;
  const auth=new CapabilityAuth({now:()=>now,monotonic:()=>mono}),run=runId(),grant=auth.issue({project:'one',runId:run,ttlMs:1000});
  now+=500;mono+=500;assert.ok(auth.inspect(grant.token,run));
  now-=400;mono+=600;rejected(()=>auth.inspect(grant.token,run));
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function remoteFixture(t) {
  const root = fixture(t), file = path.join(root, 'remote.json');
  let now = Date.parse('2026-10-04T00:00:00Z');
  const remote = new Remote({ file, now: () => now });
  assert.equal(remote.update({ enabled: true, passcode: 'synthetic secret' }).ok, true);
  const session = remote.login('synthetic secret', 'synthetic-peer', 'synthetic agent');
  return { file, remote, token: session.token, setNow: value => { now = value; }, now: () => now };
}

test('Remote rejects invalid/future/reversed dates, malformed password settings and unknown metadata', t => {
  const { file, remote, token, now } = remoteFixture(t), saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(remote.check(token));
  const corruptions = [
    d => { d.sessions[0].createdAt = 'invalid'; }, d => { d.sessions[0].lastSeen = 'invalid'; },
    d => { d.sessions[0].createdAt = new Date(now() + 1).toISOString(); }, d => { d.sessions[0].lastSeen = new Date(now() + 1).toISOString(); },
    d => { d.sessions[0].lastSeen = new Date(now() - 1).toISOString(); }, d => { d.sessions[0].id = 'short'; },
    d => { d.sessions[0].extra = true; }, d => { d.passcodeHash = 'invalid'; }, d => { d.salt = 'invalid'; },
    d => { d.enabled = 'true'; }, d => { d.host = 'https://evil.example/path'; }, d => { d.future = true; }
  ];
  for (const change of corruptions) {
    const changed = structuredClone(saved); change(changed); fs.writeFileSync(file, JSON.stringify(changed));
    const loaded = new Remote({ file, now }); assert.equal(loaded.check(token), null); assert.equal(loaded.enabled(), false);
    const bytes = fs.readFileSync(file); assert.ok(loaded.update({ enabled: true, passcode: 'new synthetic secret' }).error); assert.deepEqual(fs.readFileSync(file), bytes);
  }
  assert.equal(cookieOf({ headers: { cookie: 'hub_session=%invalid' } }), '');
});

test('Remote validates before mutation and denies an unrecorded session update', t => {
  const { remote, file, token, setNow, now } = remoteFixture(t), before = fs.readFileSync(file), hash = remote.load().passcodeHash;
  for (const input of [{ enabled: 'false', passcode: 'new synthetic secret' }, { enabled: false, extra: true }, null, []]) assert.ok(remote.update(input).error);
  assert.equal(remote.load().passcodeHash, hash); assert.deepEqual(fs.readFileSync(file), before);
  const lastSeen = remote.load().sessions[0].lastSeen; setNow(now() + 60001); remote.save = () => { throw Error('synthetic disk failure'); };
  assert.equal(remote.check(token), null); assert.equal(remote.load().sessions[0].lastSeen, lastSeen);
});

function chatFixture(t) {
  const dir = fixture(t), root = path.join(dir, 'workspace'), body = path.join(dir, 'body'), workdir = path.join(dir, 'task-work');
  const project = 'サンプルアプリ', task = 'sample-app-01', pdir = path.join(root, 'Product', project);
  fs.mkdirSync(body); fs.mkdirSync(workdir); fs.writeFileSync(path.join(body, 'body.txt'), 'project body'); fs.writeFileSync(path.join(workdir, 'task.txt'), 'task result');
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), pdir, { recursive: true });
  const projectFile = path.join(pdir, 'PROJECT.md'); fs.writeFileSync(projectFile, fs.readFileSync(projectFile, 'utf8').replace('~/Documents/SampleApp', body));
  const store = new Store(root); store.updateTask(project, task, { workdir });
  const events = [], gpt = new Chatgpt({ file: path.join(root, '_hub', 'chatgpt.json'), store, chat, baseOf: () => body, emitRow: () => {}, ended: () => {}, record: (...event) => events.push(event) });
  return { project, task, store, gpt, body, workdir, events, taskFile: store.taskFile(project, task) };
}

test('MCP tool schema rejects coercion, unknown fields and malformed IDs before real file writes', async t => {
  const { project, task, gpt, taskFile, events } = chatFixture(t), before = fs.readFileSync(taskFile);
  const bad = [
    ['hub_mark_step', { project, task, index: '0', done: false }], ['hub_mark_step', { project, task, index: 0, done: 'false' }],
    ['hub_mark_step', { project, task, index: -1, done: false }], ['hub_mark_step', { project, task, index: 0, done: false, extra: true }],
    ['hub_report', { project, task, text: 'synthetic', done: 'false' }], ['hub_get_task', { project: 10, task }],
    ['hub_get_task', { project, task: '../other' }], ['hub_get_chat', { project, task, limit: '1' }]
  ];
  for (const [tool, args] of bad) { assert.equal(validateArguments(tool, args), false); await assert.rejects(gpt.call(tool, args), error => error.status === 400); }
  assert.deepEqual(fs.readFileSync(taskFile), before); assert.deepEqual(events, []);
  const valid = await gpt.call('hub_mark_step', { project, task, index: 0, done: true }); assert.equal(valid.steps[0].done, true);
  await gpt.call('hub_report', { project, task, text: 'synthetic report', done: false }); assert.match(fs.readFileSync(taskFile, 'utf8'), /synthetic report/);
  assert.throws(() => gpt.save({ work: 'true' }), error => error.status === 400);
});

test('MCP project/task capability confines task file reads and blocks cross-scope mutations', async t => {
  const { project, task, gpt, body, workdir, taskFile, store } = chatFixture(t), before = fs.readFileSync(taskFile);
  const rootFingerprint=process.platform==='win32'?(await require('../lib/scoped-file').identity(workdir)).rootFingerprint:undefined;
  const scope = { project, task, root:workdir,rootFingerprint,tools: ['hub_list_projects', 'hub_list_tasks', 'hub_get_task', 'hub_read_file', 'hub_mark_step'] };
  assert.equal((await gpt.call('hub_list_projects', {}, scope)).length, 1);
  assert.equal((await gpt.call('hub_list_tasks', { project }, scope)).length, 1);
  assert.match(await gpt.call('hub_read_file', { project, task, path: 'task.txt' }, scope), /task result/);
  for (const [name, args] of [['hub_get_task', { project: 'other', task }], ['hub_get_task', { project, task: 'other' }], ['hub_read_file', { project, task, path: path.join(body, 'body.txt') }], ['hub_mark_step', { project, task: 'other', index: 0, done: true }]]) await assert.rejects(gpt.call(name, args, scope), error => error.status === 403);
  assert.deepEqual(fs.readFileSync(taskFile), before);
  if(process.platform==='win32'){store.updateTask(project,task,{workdir:body});await assert.rejects(gpt.call('hub_read_file',{project,task,path:'body.txt'},scope),error=>error.status===403);}
});

test('MCP file tools reject existing links, Git metadata and secret files without changing outside content', async t => {
  const { project, task, gpt, body, store } = chatFixture(t), outside = path.join(path.dirname(body), 'outside'); fs.mkdirSync(outside);
  store.updateTask(project,task,{workdir:body});const scope=process.platform==='win32'?{project,task,root:body,rootFingerprint:(await require('../lib/scoped-file').identity(body)).rootFingerprint,tools:['hub_read_file','hub_write_file']}:undefined;
  const outsideFile = path.join(outside, 'outside.txt'); fs.writeFileSync(outsideFile, 'synthetic outside content');
  const link = path.join(body, 'linked'); fs.symlinkSync(outside, link, 'junction');
  fs.mkdirSync(path.join(body, '.GIT')); fs.writeFileSync(path.join(body, '.GIT/config'), 'synthetic Git metadata'); fs.writeFileSync(path.join(body, '.env'), 'synthetic secret');
  gpt.save({ work: true });
  for (const raw of ['linked/outside.txt', '.GIT/config', '.env']) {
    await assert.rejects(gpt.call('hub_read_file', { project, task, path: raw },scope), error => error.status === 403);
    await assert.rejects(gpt.call('hub_write_file', { project, task, path: raw, text: 'must not be written',...(process.platform==='win32'?{expectedHash:'missing'}:{}) },scope), error => error.status === 403);
  }
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'synthetic outside content');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(body, 'body.txt:stream'), 'synthetic stream secret');
    for (const raw of ['body.txt:stream', '\\\\localhost\\invalid-share\\outside.txt']) await assert.rejects(gpt.call('hub_read_file', { project, task, path: raw },scope), error => [403, 404].includes(error.status));
  }
});

test('Windows MCP refuses direct command execution; request authority requires a task/root/hash', async t => {
  const { project, gpt } = chatFixture(t); gpt.save({ work: true });
  if (process.platform === 'win32') {
    const auth = new CapabilityAuth(); rejected(() => auth.issue({ project, runId: runId(), tools: ['hub_run_command'] }));
    rejected(()=>auth.issue({project,task:'t',runId:runId(),tools:['hub_request_command']}));
    const root=path.resolve(os.tmpdir(),'issued-task'),taskHash='a'.repeat(64),rootFingerprint='b'.repeat(64);
    const issued=auth.issue({project,task:'t',runId:runId(),tools:['hub_request_command','hub_get_command_result'],root,rootFingerprint,taskHash});
    const fresh=auth.current(issued.capability.id,issued.capability.runId);assert.equal(fresh.taskHash,taskHash);assert.equal(fresh.root,root);
    const command={project,task:'t',argv:[process.execPath,'-e','process.exit(0)'],cwd:root,expectedHash:taskHash};
    assert.equal(validateArguments('hub_request_command',command),true);
    for(const changed of [{argv:[]},{argv:'echo'},{timeoutMs:'1000'},{expectedHash:'missing'},{cwd:root,future:true}])assert.equal(validateArguments('hub_request_command',{...command,...changed}),false);
    const consumed=auth.consume({token:issued.token,runId:issued.capability.runId,nonce:nonce(),tool:'hub_request_command',arguments:command});assert.equal(consumed.taskHash,taskHash);
    auth.revoke(issued.capability.id);rejected(()=>auth.current(issued.capability.id,issued.capability.runId));
    assert.equal(gpt.tools().some(tool => tool.name === 'hub_run_command'), false);
    await assert.rejects(gpt.call('hub_run_command', { project, command: 'echo synthetic' }), error => error.status === 400);
    await assert.rejects(gpt.call('hub_run_command', { project, file: process.execPath, args: ['-e', 'process.exit(0)'] }), error => error.status === 409 && /sandbox/.test(error.message));
  } else {
    assert.equal(validateArguments('hub_run_command', { project, command: 'echo synthetic' }), true);
  }
});

test('Private write journal authority stays outside the task and is never exposed in a public grant',()=>{
  if(process.platform!=='win32')return;
  const auth=new CapabilityAuth(),root=path.resolve(os.tmpdir(),'task-root'),journalRoot=path.resolve(os.tmpdir(),'control-journal'),base={project:'one',task:'task',runId:runId(),tools:['hub_write_file'],root,rootFingerprint:'a'.repeat(64)},journalRootFingerprint='b'.repeat(64);
  for(const changes of [{journalRoot:root,journalRootFingerprint},{journalRoot:path.join(root,'hidden'),journalRootFingerprint},{journalRoot,journalRootFingerprint:'bad'},{journalRoot}])rejected(()=>auth.issue({...base,...changes}));
  const issued=auth.issue({...base,journalRoot,journalRootFingerprint});assert.equal(issued.capability.journalRoot,undefined);assert.equal(auth.inspect(issued.token,issued.capability.runId).journalRoot,undefined);
  const privateScope=auth.consume({token:issued.token,runId:issued.capability.runId,nonce:nonce(),tool:'hub_write_file',arguments:{project:'one',task:'task',path:'file.txt',text:'new',expectedHash:'missing'}});assert.equal(privateScope.journalRoot,journalRoot);assert.equal(privateScope.journalRootFingerprint,journalRootFingerprint);
});

test('Codex delegation is task/run scoped, once-only and bound to the explicitly issued model',()=>{
  if(process.platform!=='win32')return;
  const auth=new CapabilityAuth(),model='gpt-6.1-sol',root=path.resolve(os.tmpdir(),'delegation-root'),base={project:'one',task:'task',runId:runId(),tools:['hub_delegate'],root,rootFingerprint:'a'.repeat(64),delegationModel:model};
  for(const changes of [{delegationModel:undefined},{delegationModel:'*'},{task:undefined},{root:undefined},{tools:['hub_get_task']}])rejected(()=>auth.issue({...base,...changes}));
  const grant=auth.issue(base),request={token:grant.token,runId:grant.capability.runId,nonce:nonce(),tool:'hub_delegate',arguments:{project:'one',task:'task',model,title:'review',text:'synthetic delta'}};
  rejected(()=>auth.consume({...request,arguments:{...request.arguments,model:'gpt-6-astra'}}));rejected(()=>auth.consume({...request,arguments:{...request.arguments,task:'other'}}));
  const scope=auth.consume(request);assert.equal(scope.delegationModel,model);assert.equal(scope.remainingDelegations,0);rejected(()=>auth.consume({...request,nonce:nonce()}));
  assert.equal(auth.inspect(grant.token,grant.capability.runId).remainingCalls,99);
});

test('Claude and Grok delegation actor is issuer-only and once-only',()=>{
  for(const [actor,model]of [['claude','sonnet'],['grok','grok-4.6']]){
    const auth=new CapabilityAuth(),root=path.resolve(os.tmpdir(),'delegation-fixture');
    const base={project:'synthetic',task:'t',runId:runId(),tools:['hub_delegate'],root,rootFingerprint:'b'.repeat(64),delegationActor:actor,delegationModel:model};
    rejected(()=>auth.issue({...base,delegationActor:'other'}));rejected(()=>auth.issue({...base,tools:['hub_get_task']}));
    const grant=auth.issue(base),args={project:'synthetic',task:'t',model,title:'review',text:'synthetic'};
    const request={token:grant.token,runId:grant.capability.runId,nonce:nonce(),tool:'hub_delegate',arguments:args};
    rejected(()=>auth.consume({...request,arguments:{...args,actor:'codex'}}));
    assert.equal(auth.consume(request).delegationActor,actor);rejected(()=>auth.consume({...request,nonce:nonce()}));
  }
});

test('Native MCP create reports partial completion when the operation record fails',async t=>{
  if(process.platform!=='win32')return;
  const {project,task,gpt,workdir}=chatFixture(t),broker=require('../lib/scoped-file');
  const scope={project,task,root:workdir,rootFingerprint:(await broker.identity(workdir)).rootFingerprint,tools:['hub_read_file','hub_write_file']};
  gpt.save({work:true});gpt.record=()=>{throw Error('synthetic-private-record-error');};
  await assert.rejects(gpt.call('hub_write_file',{project,task,path:'partial.txt',text:'created before record failure',expectedHash:'missing'},scope),error=>error.status===500&&error.partial===true&&error.created===true&&!error.message.includes('synthetic-private-record-error'));
  assert.equal(broker.active(),0);assert.equal(fs.readFileSync(path.join(workdir,'partial.txt'),'utf8'),'created before record failure');
  await assert.rejects(gpt.call('hub_write_file',{project,task,path:'partial.txt',text:'must not overwrite',expectedHash:'missing'},scope),error=>error.status===409);
  assert.equal(fs.readFileSync(path.join(workdir,'partial.txt'),'utf8'),'created before record failure');
});

test('MCP stdio transport fixture sends only an independent scoped Bearer, run and fresh nonces', async t => {
  const auth = new CapabilityAuth(), run = runId(), grant = auth.issue({ project: 'one', runId: run, tools: ['hub_get_task'] }), received = [];
  const server = http.createServer(async (request, response) => {
    received.push(request.headers); let body = ''; for await (const chunk of request) body += chunk;
    const token = request.headers.authorization?.slice(7), remoteRun = request.headers['x-hub-mcp-run'];
    try {
      if (request.method === 'GET') { const scope = auth.inspect(token, remoteRun); response.end(JSON.stringify({ tools: [{ name: scope.tools[0] }] })); return; }
      const args = JSON.parse(body); auth.consume({ token, runId: remoteRun, nonce: request.headers['x-hub-mcp-nonce'], tool: args.name, arguments: args.arguments });
      if(args.arguments.task==='partial'){response.statusCode=500;response.end(JSON.stringify({error:'synthetic partial record failure',partial:true,created:true}));return;}
      response.end(JSON.stringify({ text: 'synthetic scoped result' }));
    } catch { response.statusCode = 403; response.end(JSON.stringify({ error: 'scoped request denied' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../mcp.js')], { env: { ...process.env, HUB_MCP_PORT: String(server.address().port), HUB_PORT:'1', HUB_MCP_TOKEN: grant.token, HUB_MCP_RUN_ID: run, HUB_LOCAL_TOKEN: 'synthetic-browser-secret' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); child.stdin?.on('error',()=>{});
  let stderr = '', output = '', id = 0; const waiting = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { output += chunk; const lines = output.split('\n'); output = lines.pop(); for (const line of lines) if (line) { const message = JSON.parse(line); waiting.get(message.id)?.(message); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const key = ++id, timer = setTimeout(() => reject(Error('synthetic MCP timeout')), 30000); const exited=code=>{clearTimeout(timer);waiting.delete(key);reject(Error('MCP exited '+code+'; '+stderr.slice(-2000)));};child.once('exit',exited);waiting.set(key, result => { child.off('exit',exited);clearTimeout(timer); waiting.delete(key); resolve(result); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); });
  t.after(async () => { child.kill(); if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'project-hub');
  assert.deepEqual((await rpc('tools/list', {})).result.tools, [{ name: 'hub_get_task' }]);
  assert.equal((await rpc('tools/call', { name: 'hub_get_task', arguments: { project: 'other', task: 't' } })).result.isError, true);
  for (let i = 0; i < 2; i++) assert.equal((await rpc('tools/call', { name: 'hub_get_task', arguments: { project: 'one', task: 't' }, _meta: { progressToken: 'synthetic-progress' } })).result.content[0].text, 'synthetic scoped result');
  const partial=(await rpc('tools/call',{name:'hub_get_task',arguments:{project:'one',task:'partial'}})).result;
  assert.equal(partial.isError,true);assert.deepEqual(partial.structuredContent,{ok:false,status:500,error:'synthetic partial record failure',partial:true,created:true});assert.deepEqual(JSON.parse(partial.content[0].text),partial.structuredContent);
  assert.ok(received.every(headers => headers.authorization === 'Bearer ' + grant.token && headers['x-hub-mcp-run'] === run && !headers.cookie));
  const nonces = received.map(headers => headers['x-hub-mcp-nonce']).filter(Boolean); assert.equal(new Set(nonces).size, 4);
  assert.ok(!stderr.includes(grant.token)); assert.ok(!stderr.includes('synthetic-browser-secret'));
});

test('MCP transport rejects malformed credentials before HTTP and keeps errors free of credential text', async t => {
  let requests = 0; const server = http.createServer((request, response) => { requests++; response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const secret = 'synthetic-secret-must-not-appear';
  const child = spawn(process.execPath, [path.join(__dirname, '../mcp.js')], { env: { ...process.env, HUB_PORT: String(server.address().port), HUB_MCP_TOKEN: secret, HUB_MCP_RUN_ID: runId(), HUB_LOCAL_TOKEN: 'B'.repeat(43) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); child.stdin?.on('error',()=>{});
  let stderr = '', output = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const response = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('synthetic MCP timeout')), 30000); child.once('exit',code=>{clearTimeout(timer);reject(Error('MCP exited '+code+'; '+stderr.slice(-2000)));});child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); } }); });
  t.after(async () => { child.kill(); if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  assert.equal((await response).error.code, -32603); assert.equal(requests, 0);
  assert.ok(!stderr.includes(secret)); assert.ok(!output.includes(secret)); assert.ok(!stderr.includes('B'.repeat(43)));
});

test('MCP explicit port has strict decimal bounds, wins over legacy port, and never falls back after malformed input',async t=>{
  let requests=0;const server=http.createServer((request,response)=>{requests++;response.end(JSON.stringify({tools:[]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const request=async port=>{
    const child=spawn(process.execPath,[path.join(__dirname,'../mcp.js')],{env:{...process.env,HUB_PORT:String(server.address().port),HUB_MCP_PORT:port,HUB_MCP_TOKEN:crypto.randomBytes(32).toString('base64url'),HUB_MCP_RUN_ID:runId()},stdio:['pipe','pipe','pipe'],windowsHide:true}); child.stdin?.on('error',()=>{});
    let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);let output='';
    try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic port test timeout')),30000);child.once('exit',code=>{clearTimeout(timer);reject(Error('MCP exited '+code+'; '+stderr.slice(-2000)));});child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');});}
    finally{child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));}
  };
  assert.deepEqual((await request(undefined)).result.tools,[]);assert.equal(requests,1);
  for(const port of ['','0','65536','1.5',' 4545','+4545','1e3'])assert.equal((await request(port)).error.code,-32603);
  assert.equal(requests,1);
});

test('Actual Hub HTTP gate binds independently issued MCP grants, rejects replay and permits scoped task updates', async t => {
  const { project, task, gpt, store, taskFile } = chatFixture(t), root = store.root;
  const listener = require('node:net').createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const secret = crypto.randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, HUB_ROOT: root, HUB_AI_HOME: path.join(root, 'empty-home'), HUB_TRASH: path.join(root, 'trash'), HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_LOCAL_TOKEN: secret }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); child.stdin?.on('error',()=>{});
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { child.kill(); if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve)); });
  const base = 'http://127.0.0.1:' + port;
  await waitForHub(base,child,()=>stderr);
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1', ...headers }, body: JSON.stringify(body) });
  const login = await post('/api/local/login', { token: secret }); assert.equal(login.status, 200);
  const browser = {};
  if (process.platform !== 'win32') { assert.equal((await post('/api/mcp/capability', {}, browser)).status, 403); return; }
  const state = await (await fetch(base + '/api/state', { headers: browser })).json(), p = state.projects.find(item => item.id === project), target = p.tasks.find(item => item.id === task);
  const request = { project, task, tools: ['hub_get_task', 'hub_report', 'hub_mark_step'], confirm: true, expectedHash: target.completionHash };
  assert.equal((await post('/api/mcp/capability', { ...request, expectedHash: '0'.repeat(64) }, browser)).status, 409);
  const issued = await post('/api/mcp/capability', request, browser); assert.equal(issued.status, 200, await issued.clone().text());
  const grant = await issued.json(), auth = { 'X-Hub': '1', Authorization: 'Bearer ' + grant.token, 'X-Hub-Mcp-Run': grant.capability.runId };
  assert.notEqual(grant.token, secret); assert.equal(grant.capability.project, project); assert.equal(grant.capability.task, task);
  assert.equal((await post('/api/mcp/capability', request, auth)).status, 403);
  assert.equal((await post('/api/task/new', { project, title: 'must not be created' }, auth)).status, 403);
  const tools = await fetch(base + '/api/mcp/tools', { headers: auth }); assert.equal(tools.status, 200); assert.deepEqual((await tools.json()).tools.map(tool => tool.name).sort(), request.tools.slice().sort());
  const before = fs.readFileSync(taskFile), attempted = { name: 'hub_mark_step', arguments: { project, task, index: '0', done: false } }, callHeaders = { ...auth, 'X-Hub-Mcp-Nonce': nonce() };
  assert.equal((await post('/api/mcp/call', attempted, callHeaders)).status, 403); assert.deepEqual(fs.readFileSync(taskFile), before);
  assert.equal((await post('/api/mcp/call', { name: 'hub_get_task', arguments: { project: 'other', task } }, { ...auth, 'X-Hub-Mcp-Nonce': nonce() })).status, 403);
  assert.equal((await post('/api/mcp/call', { name: 'hub_mark_step', arguments: { project, task, index: 0, done: false } }, callHeaders)).status, 200);
  const report = { name: 'hub_report', arguments: { project, task, text: 'one permitted report' } }, replayHeaders = { ...auth, 'X-Hub-Mcp-Nonce': nonce() };
  const repeated = await Promise.all([post('/api/mcp/call', report, replayHeaders), post('/api/mcp/call', report, replayHeaders)]); assert.deepEqual(repeated.map(response => response.status).sort(), [200, 403]);
  assert.equal(fs.readFileSync(taskFile, 'utf8').match(/one permitted report/g)?.length, 1);
  const mcp = spawn(process.execPath, [path.join(__dirname, '../mcp.js')], { env: { ...process.env, HUB_MCP_PORT: String(port), HUB_MCP_TOKEN: grant.token, HUB_MCP_RUN_ID: grant.capability.runId }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); mcp.stdin?.on('error',()=>{});
  let output = '', key = 0; const waiting = new Map(); mcp.stderr.on('data', chunk => { stderr += chunk; });
  mcp.stdout.on('data', chunk => { output += chunk; const lines = output.split('\n'); output = lines.pop(); for (const line of lines) if (line) { const message = JSON.parse(line); waiting.get(message.id)?.(message); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++key, timer = setTimeout(() => reject(Error('synthetic MCP timeout')), 30000); const exited=code=>{clearTimeout(timer);waiting.delete(id);reject(Error('MCP exited '+code+'; '+stderr.slice(-2000)));};mcp.once('exit',exited);waiting.set(id, message => { mcp.off('exit',exited);clearTimeout(timer); waiting.delete(id); resolve(message); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  t.after(async () => { mcp.kill(); if (mcp.exitCode === null) await new Promise(resolve => mcp.once('close', resolve)); });
  assert.deepEqual((await rpc('tools/list', {})).result.tools.map(tool => tool.name).sort(), request.tools.slice().sort());
  const taskReply = await rpc('tools/call', { name: 'hub_get_task', arguments: { project, task } }); assert.match(taskReply.result.content[0].text, /one permitted report/);
  assert.equal(taskReply.result.content[0].text.includes('# 台帳（'),false);
  assert.equal((await post('/api/mcp/capability/revoke', { id: grant.capability.id, confirm: true }, browser)).status, 200);
  assert.equal((await fetch(base + '/api/mcp/tools', { headers: auth })).status, 403);
  assert.equal((await rpc('tools/call', { name: 'hub_get_task', arguments: { project, task } })).result.isError, true);
  assert.ok(!stderr.includes(secret)); assert.ok(!stderr.includes(grant.token));
});

test('Actual Hub HTTP file grants require the registered task root and bind read/list/create/revoke to its native identity',async t=>{
  if(process.platform!=='win32')return;
  const cleanup=[];const f=chatFixture({after:fn=>cleanup.push(fn)}),{project,task,store,body}=f,root=store.root,dir=path.dirname(root),broker=require('../lib/scoped-file');
  t.after(async()=>{for(const close of cleanup.reverse())await close();assert.equal(broker.active(),0);});
  const home=path.join(dir,'isolated-home'),hooks=path.join(home,'empty-hooks'),empty=path.join(home,'empty.config');fs.mkdirSync(hooks,{recursive:true});fs.writeFileSync(empty,'');
  const gitEnv={...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home,GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Synthetic Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Synthetic Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'};
  for(const key of Object.keys(gitEnv))if(/^GIT_(DIR|COMMON_DIR|WORK_TREE|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)/i.test(key))delete gitEnv[key];
  const git=(cwd,args)=>execFileSync('git',['-c','core.hooksPath='+hooks,'-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',cwd,...args],{env:gitEnv,windowsHide:true,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000});
  git(body,['init','--template='+hooks]);git(body,['add','body.txt']);git(body,['commit','-m','synthetic fixture']);
  const tree=path.join(root,'Work',project,task);fs.mkdirSync(path.dirname(tree),{recursive:true});git(body,['worktree','add','--detach',tree,'HEAD']);store.updateTask(project,task,{workdir:tree});
  const foreign=path.join(dir,'foreign-repo');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'marker.txt'),'foreign repository marker');git(foreign,['init','--template='+hooks]);git(foreign,['add','marker.txt']);git(foreign,['commit','-m','synthetic foreign fixture']);
  const other=store.createTask(project,{title:'Synthetic foreign task',owner:'codex'});assert.ok(other);
  const foreignTree=path.join(root,'Work',project,other.id);git(foreign,['worktree','add','--detach',foreignTree,'HEAD']);store.updateTask(project,other.id,{workdir:foreignTree});
  const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'marker.txt'),'synthetic outside marker');fs.symlinkSync(outside,path.join(tree,'linked'),'junction');
  const listener=require('node:net').createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const secret=crypto.randomBytes(32).toString('base64url'),child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...gitEnv,HUB_ROOT:root,HUB_AI_HOME:home,HUB_TRASH:path.join(dir,'trash'),HUB_PORT:String(port),HUB_DRY_RUN:'1',HUB_LOCAL_TOKEN:secret},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});cleanup.push(async()=>{child.kill();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));});
  const base='http://127.0.0.1:'+port;await waitForHub(base,child,()=>stderr);
  const post=(route,value,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Hub':'1',...headers},body:JSON.stringify(value)});
  const login=await post('/api/local/login',{token:secret});assert.equal(login.status,200);const browser={};
  assert.equal((await post('/api/chatgpt',{work:true},browser)).status,200);
  const issue=async(taskId=task)=>{const state=await(await fetch(base+'/api/state',{headers:browser})).json(),current=state.projects.find(p=>p.id===project).tasks.find(x=>x.id===taskId);return post('/api/mcp/capability',{project,task:taskId,tools:['hub_read_file','hub_write_file'],confirm:true,expectedHash:current.completionHash},browser);};
  assert.equal((await post('/api/chatgpt',{work:false},browser)).status,200);assert.equal((await issue()).status,403);
  assert.equal((await post('/api/chatgpt',{work:true},browser)).status,200);
  assert.equal((await issue(other.id)).status,403);
  const issued=await issue();assert.equal(issued.status,200,await issued.clone().text());const grant=await issued.json();
  assert.equal(grant.capability.root,undefined);assert.match(grant.capability.rootFingerprint,/^[a-f0-9]{64}$/);
  const auth={'X-Hub':'1',Authorization:'Bearer '+grant.token,'X-Hub-Mcp-Run':grant.capability.runId};
  const call=(name,args)=>post('/api/mcp/call',{name,arguments:{project,task,...args}},{...auth,'X-Hub-Mcp-Nonce':nonce()});
  const tools=await fetch(base+'/api/mcp/tools',{headers:auth});assert.equal(tools.status,200);assert.deepEqual((await tools.json()).tools.map(x=>x.name).sort(),['hub_read_file','hub_write_file']);
  const read=await call('hub_read_file',{path:'body.txt'});assert.equal(read.status,200);assert.match((await read.json()).text,/project body/);
  const listed=await call('hub_read_file',{path:'.'});assert.equal(listed.status,200);const listing=JSON.parse((await listed.json()).text);assert.ok(listing.entries.includes('body.txt'));assert.equal(listing.limit,500);assert.equal(listing.truncated,false);
  const created=await call('hub_write_file',{path:'nested/result.txt',text:'real HTTP create 臺灣',expectedHash:'missing'});assert.equal(created.status,200,await created.clone().text());assert.equal(JSON.parse((await created.json()).text).created,true);assert.equal(fs.readFileSync(path.join(tree,'nested/result.txt'),'utf8'),'real HTTP create 臺灣');
  const overwrite=await call('hub_write_file',{path:'nested/result.txt',text:'must not overwrite',expectedHash:'missing'});assert.equal(overwrite.status,409);assert.equal(fs.readFileSync(path.join(tree,'nested/result.txt'),'utf8'),'real HTTP create 臺灣');
  const beforeHash=crypto.createHash('sha256').update('real HTTP create 臺灣').digest('hex');
  const wrongHash=await call('hub_write_file',{path:'nested/result.txt',text:'wrong hash',expectedHash:'0'.repeat(64)});assert.equal(wrongHash.status,409);
  const replaced=await call('hub_write_file',{path:'nested/result.txt',text:'real HTTP overwrite 臺灣',expectedHash:beforeHash});assert.equal(replaced.status,200,await replaced.clone().text());const receipt=JSON.parse((await replaced.json()).text);assert.equal(receipt.overwritten,true);assert.equal(receipt.beforeHash,beforeHash);assert.equal(fs.readFileSync(path.join(tree,'nested/result.txt'),'utf8'),'real HTTP overwrite 臺灣');
  const journal=path.join(root,'_hub','file-write',receipt.recordId);assert.equal(fs.readFileSync(path.join(journal,'before.bin'),'utf8'),'real HTTP create 臺灣');assert.equal(JSON.parse(fs.readFileSync(path.join(journal,'complete.json'),'utf8')).state,'complete');
  assert.equal((await call('hub_write_file',{path:'missing-confirm.txt',text:'no confirmation'})).status,403);assert.equal(fs.existsSync(path.join(tree,'missing-confirm.txt')),false);
  const mcp=spawn(process.execPath,[path.join(__dirname,'../mcp.js')],{env:{...gitEnv,HUB_MCP_PORT:String(port),HUB_MCP_TOKEN:grant.token,HUB_MCP_RUN_ID:grant.capability.runId},stdio:['pipe','pipe','pipe'],windowsHide:true}); mcp.stdin?.on('error',()=>{});
  cleanup.push(async()=>{mcp.kill();if(mcp.exitCode===null)await new Promise(resolve=>mcp.once('close',resolve));});
  mcp.stderr.on('data',chunk=>{stderr+=chunk;});let output='',requestId=0;const waiting=new Map();
  mcp.stdout.on('data',chunk=>{output+=chunk;const lines=output.split('\n');output=lines.pop();for(const line of lines)if(line){const reply=JSON.parse(line);waiting.get(reply.id)?.(reply);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++requestId,timer=setTimeout(()=>reject(Error('synthetic actual MCP timeout')),30000);const exited=code=>{clearTimeout(timer);waiting.delete(id);reject(Error('MCP exited '+code+'; '+stderr.slice(-2000)));};mcp.once('exit',exited);waiting.set(id,reply=>{mcp.off('exit',exited);clearTimeout(timer);waiting.delete(id);resolve(reply);});mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const log=path.join(root,'_hub','log.jsonl'),savedLog=log+'.synthetic-saved';fs.renameSync(log,savedLog);fs.mkdirSync(log);
  try{
    const partial=await call('hub_write_file',{path:'partial-http.txt',text:'created before HTTP record failure',expectedHash:'missing'});assert.equal(partial.status,500);const detail=await partial.json();assert.equal(detail.partial,true);assert.equal(detail.created,true);assert.equal(fs.readFileSync(path.join(tree,'partial-http.txt'),'utf8'),'created before HTTP record failure');
    const stdio=(await rpc('tools/call',{name:'hub_write_file',arguments:{project,task,path:'partial-stdio.txt',text:'created before stdio record failure',expectedHash:'missing'}})).result;
    assert.equal(stdio.isError,true);assert.equal(stdio.structuredContent.partial,true);assert.equal(stdio.structuredContent.created,true);assert.equal(stdio.structuredContent.status,500);assert.deepEqual(JSON.parse(stdio.content[0].text),stdio.structuredContent);assert.equal(fs.readFileSync(path.join(tree,'partial-stdio.txt'),'utf8'),'created before stdio record failure');
    assert.equal((await call('hub_write_file',{path:'partial-http.txt',text:'must not overwrite partial result',expectedHash:'missing'})).status,409);assert.equal(fs.readFileSync(path.join(tree,'partial-http.txt'),'utf8'),'created before HTTP record failure');
  }finally{fs.rmdirSync(log);fs.renameSync(savedLog,log);}
  for(const raw of ['../outside/marker.txt','linked/marker.txt',path.join(outside,'marker.txt')]){const denied=await call('hub_read_file',{path:raw});assert.equal(denied.status,403);assert.equal((await denied.text()).includes('synthetic outside marker'),false);}
  assert.equal((await call('hub_write_file',{path:'linked/new.txt',text:'outside write denied',expectedHash:'missing'})).status,403);assert.equal(fs.existsSync(path.join(outside,'new.txt')),false);
  store.updateTask(project,task,{workdir:foreignTree});assert.equal((await call('hub_read_file',{path:'marker.txt'})).status,403);assert.equal((await issue()).status,403);store.updateTask(project,task,{workdir:tree});
  const parked=path.join(dir,'original-worktree');fs.renameSync(tree,parked);fs.mkdirSync(tree);fs.writeFileSync(path.join(tree,'body.txt'),'unapproved replacement root marker');
  const swapped=await call('hub_read_file',{path:'body.txt'});assert.equal(swapped.status,403);assert.equal((await swapped.text()).includes('unapproved replacement root marker'),false);
  assert.equal((await call('hub_write_file',{path:'new.txt',text:'root swap write denied',expectedHash:'missing'})).status,403);assert.equal(fs.existsSync(path.join(tree,'new.txt')),false);
  fs.rmSync(tree,{recursive:true,force:true});fs.renameSync(parked,tree);
  assert.equal((await post('/api/mcp/capability/revoke',{id:grant.capability.id,confirm:true},browser)).status,200);
  assert.equal((await fetch(base+'/api/mcp/tools',{headers:auth})).status,403);assert.equal((await call('hub_read_file',{path:'body.txt'})).status,403);
  assert.equal(fs.readFileSync(path.join(outside,'marker.txt'),'utf8'),'synthetic outside marker');assert.ok(!stderr.includes(secret));assert.ok(!stderr.includes(grant.token));
});


test('native MCP issuance uses the shared thirty-minute TTL and existing 500-call ceiling',async()=>{
  const vm=require('node:vm'),limits=require('../lib/native-turn-limits');
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.match(source,/const \{MAX_WALL_MS\}=require\('\.\/lib\/native-turn-limits'\);/);
  const fn=source.slice(source.indexOf('async function nativeProviderMcp('),source.indexOf('async function nativeProviderDispose('));
  let issued;const sentinel=Error('captured issuance');
  const context=vm.createContext({MAX_WALL_MS:limits.MAX_WALL_MS,os,path,READ_TOOLS,
    require:name=>{assert.equal(name,'./lib/native-runtime-base');return {resolve:async()=>({physicalBase:'C:\\Synthetic'})};},
    gpt:{settings:()=>({work:false})},store:{readProject:()=>({tasks:[{id:'task'}]})},
    mcpCapabilities:{issue:options=>{issued=options;throw sentinel;}}
  });
  vm.runInContext(fn,context);
  await assert.rejects(context.nativeProviderMcp({actor:'grok',project:'one',task:'task',runId:runId()},{dir:'C:\\Synthetic',rootFingerprint:'a'.repeat(64),workspaceRun:runId()}),e=>e===sentinel);
  assert.equal(issued.ttlMs,1800000);assert.equal(issued.maxCalls,500);
  let now=1000,mono=1000;const auth=new CapabilityAuth({now:()=>now,monotonic:()=>mono});
  const grant=auth.issue({project:'one',runId:runId(),ttlMs:issued.ttlMs,maxCalls:issued.maxCalls});
  assert.equal(grant.capability.expiresAt,1801000);assert.equal(grant.capability.remainingCalls,500);
  rejected(()=>auth.issue({project:'one',runId:runId(),ttlMs:issued.ttlMs,maxCalls:501}));
});
