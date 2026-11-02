if(process.env.HUB_R11_START_CHILD!=='1'){
 const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
 test('start suite uses an isolated child environment',{timeout:1800000},async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-start-')),fixture=require('./helpers/owned-native-fixture'),provider=process.platform==='win32'?fixture.provider(tmp,{capture:path.join(tmp,'child-argv.json')}):{bin:path.join(tmp,'child-cli')};
  const childEnv={...process.env,HUB_R11_START_CHILD:'1',HUB_R11_START_TMP:tmp,HUB_R11_START_BIN:provider.bin,PATH:process.platform==='win32'?fixture.environment(provider.bin):[provider.bin,path.join(tmp,'initial-cli'),'/usr/bin','/bin'].join(path.delimiter)};for(const key of Object.keys(childEnv))if(key.startsWith('NODE_TEST_'))delete childEnv[key];
  const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',__filename],{env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('close',r));}assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));assert.ok(path.basename(tmp).startsWith('hub-start-'));fs.rmSync(tmp,{recursive:true,force:true,maxRetries:20,retryDelay:50});});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});t.diagnostic(output);assert.match(output,/# tests [1-9][0-9]*/,'child must actually execute the suite');assert.equal(code,0,output);
 });
}else{
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const start = require('../lib/start');
const chat = require('../lib/chat');
const native=process.platform==='win32',fixture=require('./helpers/owned-native-fixture');
const reviewed=require('./helpers/reviewed-workspace');
const tmp = fs.realpathSync(process.env.HUB_R11_START_TMP);
const root = path.join(tmp, 'workspace'), pdir = path.join(root, 'Product', 'サンプルアプリ');
const port = 48000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');
let server, sessions;
let restoreInventory=()=>{};
const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'サンプルアプリ', ...body }) });
const reviewedPost=(route,body)=>reviewed.startReviewedFixture(post,route,{project:'サンプルアプリ',...body});
test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.cpSync(path.join(__dirname, '../seed/サンプルアプリ'), pdir, { recursive: true });
  fs.writeFileSync(path.join(root, '_hub/roles.yaml'), 'models:\n  claude-code: [Opus 5.5]\n  codex: [GPT-6.1-Sol]\nagents: [しおり, つむぎ, りつ]\nroles: {}\n');
  Object.assign(process.env, { HUB_ROOT: root, HUB_PORT: String(port), HUB_DRY_RUN: '1', HUB_AI_HOME: path.join(tmp, 'empty-home') });
  if(native)restoreInventory=fixture.freshInventory();
  ({ server, sessions } = require('../server'));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
});
test.after(async () => { sessions?.stopAll(); if(server?.listening)await new Promise(resolve => server.close(resolve)); restoreInventory();fs.rmSync(tmp, { recursive: true, force: true,maxRetries:20,retryDelay:50 }); });

test('画像を作業フォルダへコピーし、選択したCodexの-i・担当・モデル・思考・前回選択を保存する', {timeout:180000}, async () => {
  const upload = await fetch(base + '/api/start/image?project=' + encodeURIComponent('サンプルアプリ') + '&name=test.png', { method: 'POST', headers: { 'X-Hub': '1' }, body: png });
  const image = await upload.json(); assert.equal(upload.status, 200);
  assert.equal(image.path, start.imageFile({dir:pdir}, image.id, true));
  assert.deepEqual(fs.readFileSync(image.path), png);
  assert.deepEqual(Buffer.from(await (await fetch(base + image.url)).arrayBuffer()), png);
  const body = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '極高', text: '文章を保ち、画像を確認', images: [image.id], request: 'req-codex' };
  const res = await reviewedPost('/api/start', body), r = await res.json(); assert.equal(res.status, 200, r.error);
  assert.equal(r.turn.command, 'codex'); assert.equal(r.turn.args[native?2:0], 'exec');
  const i = r.turn.args.indexOf('-i'); assert.ok(i > 0); assert.equal(r.turn.args[i + 1], r.images[0]);
  assert.deepEqual(fs.readFileSync(r.images[0]), png); assert.match(r.images[0], /attachments/);
  assert.match(r.turn.stdin, /文章を保ち、画像を確認/);
  const state = await (await fetch(base + '/api/state')).json(), p = state.projects.find(x => x.id === 'サンプルアプリ'), t = p.tasks.find(x => x.id === r.task);
  assert.equal(t.owner, 'codex'); assert.equal(t.model, body.model); assert.equal(t.effort, body.effort);
  assert.deepEqual(p.startSpec, { ai: body.ai, model: body.model, effort: body.effort });
  assert.equal((await (await post('/api/start', body)).json()).task, r.task, '通信再試行で作業を重複作成しない');
});

test('ClaudeはRead指示、画像のみも開始、Discordは送信しないことを作業画面に明示する', {timeout:180000}, async () => {
  const p = { id: 'サンプルアプリ', dir: pdir }, image = start.saveImage(p, '添付.png', png);
  if(native){
    const before=fs.readdirSync(path.join(pdir,'.ai/tasks')).sort();
    const rejected=await post('/api/start',{ai:'claude',text:'',images:[image.id]});await require('./helpers/provider-refusal').providerRefusal(rejected);
    assert.deepEqual(fs.readdirSync(path.join(pdir,'.ai/tasks')).sort(),before);
    const onlyImage=await reviewedPost('/api/start',{ai:'codex',model:'GPT-6.1-Sol',text:'',images:[image.id]});assert.equal(onlyImage.status,200,await onlyImage.clone().text());const value=await onlyImage.json();assert.ok(value.turn.args.includes('-i'));assert.deepEqual(fs.readFileSync(value.images[0]),png);
  }else{
    const claude = await (await post('/api/start', { ai: 'claude', text: '', images: [image.id] })).json();
    assert.equal(claude.turn.command, 'claude'); assert.match(claude.turn.stdin, /これらの画像を Read で見てから始める/);assert.ok(!claude.turn.args.includes('-i'));
  }
  const discord = await (await post('/api/start', { ai: 'discord:しおり', text: '確認してください', images: [image.id] })).json();
  assert.equal(discord.agent, true); assert.equal(discord.turn, undefined);
  const pstate = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === p.id);
  const t = pstate.tasks.find(x => x.id === discord.task);
  assert.equal(t.owner, 'discord:しおり'); assert.match(t.question, /自動送信は未対応/);
  assert.ok(chat.read(pdir, t.id).at(-1).text.includes(discord.images[0]));
});

test('Sol・高の初期選択はCLIと会話用作業へ保存し、役割設定と過去の作業を保持する', {timeout:180000}, async () => {
  const rolesFile = path.join(root, '_hub/roles.yaml');
  const roleText = 'models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [Astra, GPT-6.1-Sol]\nagents: [しおり, つむぎ, りつ]\nroles:\n  コーディング: { main: [claude-code, Fable 5.1, 極高], backup: [codex, Astra, 極高] }\n';
  fs.writeFileSync(rolesFile, roleText);
  const before = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === 'サンプルアプリ');
  const res = await reviewedPost('/api/start', { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: '初期選択の確認', images: [] }), r = await res.json();
  assert.equal(res.status, 200, r.error); assert.equal(r.turn.command, 'codex');
  assert.equal(r.turn.args[r.turn.args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(r.turn.args.includes('model_reasoning_effort=high'));
  const after = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === 'サンプルアプリ');
  const task = after.tasks.find(x => x.id === r.task);
  assert.equal(task.owner, 'codex'); assert.equal(task.model, 'GPT-6.1-Sol'); assert.equal(task.effort, '高');
  assert.deepEqual(after.startSpec, { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' });
  for (const old of before.tasks) assert.deepEqual(after.tasks.find(x => x.id === old.id), old);
  assert.equal(fs.readFileSync(rolesFile, 'utf8'), roleText);
});

test('子作業のSol・高は保存・再読込・会話とターミナルの起動に通り、既存作業と分岐を保持する', {timeout:300000}, async () => {
  const { Store } = require('../lib/store'), rolesFile = path.join(root, '_hub/roles.yaml');
  const bin = path.join(tmp, 'child-cli'), captured = path.join(tmp, 'child-argv.json');if(fs.existsSync(captured))fs.unlinkSync(captured);
  if(!native){fs.mkdirSync(bin);fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'turn.completed'}));});\n`, { mode: 0o755 });}
  const oldRoles = fs.readFileSync(rolesFile, 'utf8');
  const roleText = 'models:\n  claude-code: [Fable 5.1]\n  codex: [Astra, GPT-6.1-Sol]\nroles:\n  司令塔: { main: [claude-code, Fable 5.1, 極高], backup: [codex, Astra, 極高] }\n';
  fs.writeFileSync(rolesFile, roleText);
  try {
    const parentRes = await post('/api/task/new', { title: '親の司令塔', owner: 'claude-code', role: '司令塔', phase: '設計' });
    const parent = await parentRes.json(); assert.equal(parentRes.status, 200, parent.error);
    const before = (await (await fetch(base + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ');
    const made = await post('/api/task/new', { title: '新しい子', parent: parent.id, kind: 'main', derivedFrom: '', owner: 'codex', role: parent.role, phase: parent.phase, model: 'GPT-6.1-Sol', effort: '高' });
    assert.equal(made.status, 200); const child = await made.json();
    const check = task => {
      assert.equal(task.owner, 'codex'); assert.equal(task.model, 'GPT-6.1-Sol'); assert.equal(task.effort, '高');
      assert.equal(task.parent, parent.id); assert.equal(task.phase, '設計'); assert.equal(task.role, '司令塔'); assert.equal(task.kind, 'main');
    };
    check(child);
    const fresh = new Store(root); check(fresh.readTask(fresh.taskFile('サンプルアプリ', child.id)));
    const after = (await (await fetch(base + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ');
    check(after.tasks.find(t => t.id === child.id));
    for (const old of before.tasks) assert.deepEqual(after.tasks.find(t => t.id === old.id), old);
    const branched = await post('/api/task/new', { title: '分岐', parent: parent.parent, kind: 'derived', derivedFrom: 'サンプルアプリ/' + parent.id, owner: parent.owner, role: parent.role, phase: parent.phase });
    assert.equal(branched.status, 200); const branch = await branched.json();
    assert.equal(branch.owner, 'claude-code'); assert.equal(branch.model, ''); assert.equal(branch.effort, '');
    assert.equal(branch.derivedFrom, 'サンプルアプリ/' + parent.id); assert.equal(branch.phase, '設計');
    const termRes = await reviewedPost('/api/term/start', { task: child.id, ai: 'codex' }), term = await termRes.json();
    assert.equal(termRes.status, 200, term.error); assert.equal(term.command, 'codex');
    assert.equal(term.args[term.args.indexOf('--model') + 1], 'gpt-6.1-sol'); assert.ok(term.args.includes('model_reasoning_effort=high'));
    const chatRes = await reviewedPost('/api/chat/send', { task: child.id, ai: 'codex', text: '子作業の確認' }), result = await chatRes.json();
    assert.equal(chatRes.status, 200, result.error); assert.equal(result.model, 'GPT-6.1-Sol'); assert.equal(result.effort, '高');
    const deadline = Date.now() + (native?15000:3000);
    while (!fs.existsSync(captured)) { assert.ok(Date.now() < deadline, '模擬CLIが引数を記録しない'); await new Promise(r => setTimeout(r, 10)); }
    const capturedValue=JSON.parse(fs.readFileSync(captured,'utf8'));
    if(native){assert.equal(capturedValue.settings.model,'gpt-6.1-sol');assert.equal(capturedValue.turn.effort,'high');assert.ok(capturedValue.args.includes('app-server'));}
    else{const args=capturedValue;assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol'); assert.ok(args.includes('model_reasoning_effort=high'));}
    check(new Store(root).readTask(fresh.taskFile('サンプルアプリ', child.id)));
    assert.equal(fs.readFileSync(rolesFile, 'utf8'), roleText);
  } finally { fs.writeFileSync(rolesFile, oldRoles);  }
});

test('最大10枚・画像形式・参照範囲を検証し、不正入力では作業を作らない', {timeout:180000}, async () => {
  const p = { id: 'サンプルアプリ', dir: pdir };
  assert.throws(() => start.saveImage(p, 'data.txt', png));
  assert.throws(() => start.imageFile(p, '../PROJECT.md'));
  const before = (await (await fetch(base + '/api/state')).json()).projects[0].tasks.length;
  assert.equal((await post('/api/start', { ai: 'codex', text: 'a', images: Array(11).fill('x') })).status, 400);
  assert.equal((await post('/api/start', { ai: 'unknown', text: 'a', images: [] })).status, 400);
  assert.equal((await post('/api/start', { ai: 'codex', text: 'a', images: ['../file'] })).status, 409);
  assert.equal((await post('/api/start', { ai: 'claude', model: 'fake-model', text: 'a', images: [] })).status, 409);
  assert.equal((await (await fetch(base + '/api/state')).json()).projects[0].tasks.length, before);
});

test('Macの画像パスを追加、GIF/HEICは元を残しPNGへ変換してCLIへ渡す', { skip: process.platform !== 'darwin' }, async () => {
  const input = path.join(tmp, 'source.png'); fs.writeFileSync(input, png);
  const image = await (await post('/api/start/image-path', { path: input })).json(); assert.ok(image.id);
  assert.equal(image.path, start.imageFile({dir:pdir}, image.id, true));
  assert.deepEqual(fs.readFileSync(image.path), png);
  const p = { id: 'サンプルアプリ', dir: pdir };
  for (const ext of ['gif', 'heic']) {
    const source = path.join(tmp, 'source.' + ext);
    execFileSync('/usr/bin/sips', ['-s', 'format', ext, input, '--out', source], { stdio: 'pipe' });
    const saved = start.imageFromPath(p, source), copied = start.copyImages(p, [saved.id], tmp, 'conversion');
    assert.equal(saved.path, start.imageFile(p, saved.id, true));
    assert.match(copied[0], /\.png$/); assert.ok(fs.existsSync(start.imageFile(p, saved.id)));
  }
});

test('Codex再開時も-iをresumeの後に渡す', () => {
  const turn = chat.buildTurn({ ai: 'codex', model: 'GPT-6.1-Sol', meta: { sessions: { codex: 'sid' }, models: { codex: 'GPT-6.1-Sol' } }, rows: [], text: '確認', images: ['/tmp/image.png'] });
  assert.deepEqual(turn.args.slice(-5), ['resume', 'sid', '-i', '/tmp/image.png', '-']);
});

test('非DRYのChatRunnerをローカルCLIで起動して画像引数を実際に受け取り、起動失敗も通知する', {timeout:180000}, async () => {
  if(native){
    const capturedFile=path.join(tmp,'native-image-turn.json'),local=fixture.provider(path.join(tmp,'native-local'),{capture:capturedFile,echo:true});
    let runner,flow;
    const runnerEnv={PATH:fixture.environment(local.bin)};
    try{
      const image=start.saveImage({id:'サンプルアプリ',dir:pdir},'native.png',png),made=await post('/api/task/new',{title:'native runner image',owner:'codex',model:'GPT-6.1-Sol',effort:'高'}),task=await made.json();assert.equal(made.status,200);
      const ready=await reviewed.prepareFixtureWorkspace(post,{project:'サンプルアプリ',task:task.id}),{workspaceRuntime,workspaceReview}=require('../server');flow=await workspaceRuntime.begin({project:'サンプルアプリ',task:task.id,permit:ready.permit,kind:'chat'});const binding=workspaceReview.binding('サンプルアプリ',task.id);
      runner=new chat.ChatRunner({canStart:(ai,model,o)=>{workspaceRuntime.assertStart(o.project,o.task,o.workspaceFlow,o.dir);return '';}});let finish;const ended=new Promise(r=>finish=r);
      const sent=runner.send({project:'サンプルアプリ',task:task.id,pdir,dir:binding.dir,workspaceFlow:flow.id,nativeRootPin:{root:binding.dir,rootFingerprint:binding.rootFingerprint},ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'画像を見る',images:[image.path],perm:'codex',env:runnerEnv,onEnd:finish});const running=runner.busy('サンプルアプリ',task.id);workspaceRuntime.track(flow,running.child);assert.equal(await sent.started,true);
      const row=await ended;assert.equal(row.error,'');const captured=JSON.parse(row.text);assert.deepEqual(captured,JSON.parse(fs.readFileSync(capturedFile,'utf8')));assert.equal(row.asks,undefined);assert.equal(captured.settings.model,'gpt-6.1-sol');assert.equal(captured.turn.effort,'high');assert.ok(captured.turn.input.some(x=>x.type==='localImage'&&fs.readFileSync(x.path).equals(png)));assert.ok(captured.turn.input.some(x=>x.type==='text'&&x.text.includes('画像を見る')));
      await workspaceRuntime.awaitClosed(flow);await workspaceRuntime.finish(flow.id);
      const shared=path.join(process.env.HUB_R11_START_BIN,'codex.cmd');fs.renameSync(shared,shared+'.saved');
      const failed=await reviewedPost('/api/chat/send',{task:task.id,ai:'codex',text:'a'});assert.equal(failed.status,409,await failed.clone().text());assert.match((await failed.json()).error,/CLI.*not found|見つか|找不到/);assert.equal((await (await fetch(base+'/api/state')).json()).chatting.some(x=>x.task===task.id),false);
    }finally{const shared=path.join(process.env.HUB_R11_START_BIN,'codex.cmd');if(fs.existsSync(shared+'.saved'))fs.renameSync(shared+'.saved',shared);if(flow){runner?.stop(flow.project,flow.task);const runtime=require('../server').workspaceRuntime;if(runtime.flows.has(flow.id))await runtime.failed(flow);}}
    return;
  }
  const executable = path.join(tmp, 'local-codex');
  fs.writeFileSync(executable, `#!${process.execPath}\nlet text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args:process.argv.slice(2),text})}})));\n`, {mode:0o755});
  const runner = new chat.ChatRunner();
  let completed; const ended = new Promise(resolve => { completed = resolve; });
  const sent = runner.send({project:'local',task:'local-test',pdir:tmp,dir:tmp,ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'画像を見る',images:['/tmp/添付 画像.png'],perm:'./local-codex',onEnd:completed});
  assert.equal(await sent.started, true);
  const row = await ended, captured = JSON.parse(row.text);
  const index = captured.args.indexOf('-i'); assert.equal(captured.args[index+1], '/tmp/添付 画像.png');
  assert.match(captured.text, /画像を見る/);
  const failed = runner.send({project:'local',task:'failure',pdir:tmp,dir:tmp,ai:'codex',text:'a',perm:path.join(tmp,'missing-cli')});
  assert.equal(await failed.started, false); assert.equal(runner.busy('local','failure'), null);
});

test('設定したClaude Opus中の子/分岐は保存・再読込・模擬会話CLIへ通る', {timeout:180000}, async () => {
  const { ModelView } = require('../lib/model-view'), { Store } = require('../lib/store');
  const rolesFile = path.join(root, '_hub/roles.yaml'), oldRoles = fs.readFileSync(rolesFile);
  const bin = path.join(tmp, 'initial-cli'), captured = path.join(tmp, 'initial-argv.json');
  if(!native){fs.mkdirSync(bin);fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'result',subtype:'success',result:'見本確認済み'}));});\n`, { mode: 0o755 });}
  fs.writeFileSync(rolesFile, 'models:\n  claude-code: [Fable 5.1, Opus 5.5]\n  codex: [GPT-6.1-Sol]\nroles: {}\n');
  try {
    const initial = { ai: 'claude', model: 'Opus 5.5', effort: '中' };
    const beforeSetting=new ModelView(path.join(root,'_hub/model-view.json')).initial();
    const setting = await post('/api/models/initial', initial); assert.equal(setting.status, native?400:200);
    assert.deepEqual(new ModelView(path.join(root, '_hub/model-view.json')).initial(), native?beforeSetting:initial);
    const p = (await (await fetch(base + '/api/state')).json()).projects.find(p => p.id === 'サンプルアプリ');
    const parent = p.tasks[0];
    for (const kind of ['main', 'derived']) {
      const res = await post('/api/task/new', { title: '設定済み' + kind, owner: 'claude-code', model: initial.model, effort: initial.effort, parent: kind === 'main' ? parent.id : parent.parent, kind, derivedFrom: kind === 'derived' ? p.id + '/' + parent.id : '', role: parent.role, phase: parent.phase });
      assert.equal(res.status, 200); const made = await res.json();
      const fresh = new Store(root); const task = fresh.readTask(fresh.taskFile(p.id, made.id));
      assert.equal(task.model, initial.model); assert.equal(task.effort, initial.effort); assert.equal(task.owner, 'claude-code');
      assert.equal(task.role, parent.role); assert.equal(task.phase, parent.phase);
      if(native){
        const original=fs.readFileSync(fresh.taskFile(p.id,made.id));for(const route of ['/api/term/start','/api/chat/send']){const denied=await post(route,{task:made.id,ai:'claude',text:'設定起動確認'});await require('./helpers/provider-refusal').providerRefusal(denied);assert.deepEqual(fs.readFileSync(fresh.taskFile(p.id,made.id)),original);}assert.equal(fs.existsSync(captured),false);continue;
      }
      const term = await (await post('/api/term/start', { task: made.id, ai: 'claude' })).json();
      assert.equal(term.args[term.args.indexOf('--model') + 1], 'claude-opus-5-5'); assert.equal(term.args[term.args.indexOf('--effort') + 1], 'medium');
      if (kind === 'main') {
        const chatRes = await post('/api/chat/send', { task: made.id, ai: 'claude', text: '設定起動確認' }); assert.equal(chatRes.status, 200);
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(captured)) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
        const args = JSON.parse(fs.readFileSync(captured));
        assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5'); assert.equal(args[args.indexOf('--effort') + 1], 'medium');
      }
    }
    const after = (await (await fetch(base + '/api/state')).json()).projects.find(x => x.id === p.id);
    for (const old of p.tasks) assert.deepEqual(after.tasks.find(x => x.id === old.id), old);
    assert.deepEqual(after.startSpec, p.startSpec);
  } finally { fs.writeFileSync(rolesFile, oldRoles);  }
});

}
