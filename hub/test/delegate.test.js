'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../lib/chat');
const launch = require('../lib/launch');
const native=process.platform==='win32',fixture=require('./helpers/owned-native-fixture'),reviewed=require('./helpers/reviewed-workspace'),originalPath=process.env.PATH;
let restoreInventory=()=>{},nativeProvider;

// 本物の CLI・利用者の台帳を呼ばず、渡された引数と会話を返す fixture で検証する。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-delegate-'));
const root = path.join(tmp, 'workspace'), bin = path.join(tmp, 'bin');
const dir = path.join(root, 'Product', '委任の試験');
const key = { project: '委任の試験', task: 'existing' };
let server, base, sessions;
const rows = () => chat.read(dir, key.task);
const replies = () => rows().filter(r => r.role === 'assistant');
const tasks = () => fs.readdirSync(path.join(dir, '.ai/tasks')).sort();
const queueFile = path.join(dir, '.ai/chat/existing.queue.json');
const chatWording = input => {
  const current = input.split('以下は、この作業の会話')[0];
  if (/【決まり】前回と同じ/.test(current)) assert.match(current, /思い出せない時はその全文を読む/);
  else assert.match(current, /委任がターミナル稼働で断られた時だけ.*対象AI欄［停止］/);
  const full = fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8');
  assert.match(full, /断られていない時は、ターミナルの停止や終了を人に頼まない/);
  assert.doesNotMatch(current, /ターミナルのAIを終了|ターミナルで動いているAIからは委任できません/);
  assert.doesNotMatch(current, /あなたはターミナルで動いている/);
};
const post = (route, body) => fetch(base + route, { method: 'POST',
  headers: { 'X-Hub': '1', 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ ...key, ...body }) });
async function waitReplies(n) {
  for (let i = 0; i < 150 && replies().length < n; i++) await new Promise(r => setTimeout(r, 30));
  assert.equal(replies().length, n);
  return replies().at(-1);
}
const delegate = body => post('/api/delegate', { title: '確認する', text: 'review', ...body });
async function restartFixture(){await new Promise(r=>server.close(r));delete require.cache[require.resolve('../server')];({server,sessions}=require('../server'));await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));}
const nativeCases=()=>require('./helpers/native-delegate-cases').cases({key,dir,root,provider:nativeProvider,post,tasks,restart:restartFixture});

test.before(async () => {
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../docs/project-hub/templates/_hub/roles.yaml'), path.join(root, '_hub/roles.yaml'));
  fs.mkdirSync(path.join(dir, '.ai/tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '---\nname: 委任の試験\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
  fs.writeFileSync(path.join(dir, '.ai/tasks/existing.md'), '---\nid: existing\ntitle: 元の作業\nrole: 文章\nowner: claude-code\nmodel: Opus 5.5\nworkspaceMode: direct\nstate: 実行中\n---\n## 手順\n- [ ] 人による確認\n');
  fs.writeFileSync(path.join(dir, '.ai/tasks/old-child.md'), '---\nid: old-child\ntitle: 既存の子\nkind: derived\nderivedFrom: existing\n---\n');
  fs.mkdirSync(bin);
  if(!native)for (const ai of ['claude', 'codex']) fs.writeFileSync(path.join(bin, ai), `#!${process.execPath}
const ai=${JSON.stringify(ai)}, args=process.argv.slice(2);let input='';
process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
 const out=x=>console.log(JSON.stringify(x));
 // 入力中の質問形式のひな形を、fixture自身の質問として解釈させない。
 const text=JSON.stringify({ai,args,input:input.replaceAll('[[質問]]','（質問形式の説明）').replaceAll('[[/質問]]','（説明終わり）')});
 setTimeout(()=>{
  if(ai==='claude'){
   out({type:'system',subtype:'init',session_id:'delegate-fixture'});
   out({type:'assistant',message:{content:[{type:'text',text}]}});
   out({type:'result',is_error:false,result:'',session_id:'delegate-fixture'});
  }else{
   out({type:'thread.started',thread_id:'delegate-codex-fixture'});
   out({type:'item.completed',item:{type:'agent_message',text}});out({type:'turn.completed'});
  }
 },input.includes('# 今回の依頼\\nparent-working')?700:20);
});
process.on('SIGTERM',()=>process.exit(143));
`, { mode: 0o755 });
  if(native){restoreInventory=fixture.freshInventory();nativeProvider=fixture.provider(tmp,{echo:true,delay:8000});process.env.PATH=fixture.environment(nativeProvider.bin);fs.writeFileSync(path.join(root,'_hub/ai-tools-models.json'),JSON.stringify({v:1,codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'},{id:'gpt-6-astra',label:'GPT-6-Astra'}],known:[],source:'synthetic-fixture'}}));}
  else process.env.PATH = bin + ':/usr/bin:/bin';
  process.env.HUB_ROOT = root; process.env.HUB_PORT = '0'; process.env.HUB_DRY_RUN = '1';
  process.env.HUB_AI_HOME = path.join(tmp, 'ai-home'); process.env.HUB_TRASH = path.join(tmp, 'trash');
  ({ server, sessions } = require('../server'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  // allowed() が使う PORT と合わせて起動する（ポートの取得だけ先に行う）。
  const port = server.address().port;
  await new Promise(r => server.close(r));
  process.env.HUB_PORT = String(port);
  delete require.cache[require.resolve('../server')];
  ({ server, sessions } = require('../server'));
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => { if(native&&server?.listening){await post('/api/chat/stop',{});const runtime=require('../server').workspaceRuntime;for(const flow of [...runtime.flows.values()]){await runtime.stop(flow.id);await runtime.finish(flow.id);}}if (server?.listening) await new Promise(r => server.close(r));restoreInventory();process.env.PATH=originalPath;if(native){const resolved=fs.realpathSync(tmp);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith('hub-delegate-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:50});} });

test('未指定・未知モデルは CLI 既定へ落とさず、台帳・会話を増やさない', {timeout:240000}, async () => {
  const before = tasks(), task = fs.readFileSync(path.join(dir, '.ai/tasks/existing.md'), 'utf8');
  assert.equal((await delegate({ ai: 'claude' })).status, 400); // 元の作業の Opus を継承しない
  assert.equal((await delegate({ ai: 'claude', model: 'claude-opus-4-6' })).status, 409);
  assert.equal((await delegate({ ai: 'codex', role: 'チェック' })).status, 400); // backup への自動切替なし
  assert.equal((await delegate({ ai: 'claude', role: '存在しない役割' })).status, 400);
  assert.equal((await delegate({ ai: 'claude', model: 'gpt-6.1-sol' })).status, 409);
  assert.deepEqual(tasks(), before); assert.equal(rows().length, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.ai/tasks/existing.md'), 'utf8'), task);
});

test('正式 ID で指定した Fable が同じ会話・同じ作業で起動する', {timeout:240000}, async () => {
  if(native)return nativeCases().success();
  const before = tasks(), child = fs.readFileSync(path.join(dir, '.ai/tasks/old-child.md'), 'utf8');
  const list = sessions.list;
  let result;
  try {
    sessions.list = () => [{ ...key, ai: 'codex', running: false },
      { ...key, task: '別作業', ai: 'codex', running: true },
      { ...key, project: '別プロジェクト', ai: 'claude', running: true }];
    result = await (await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).json();
  } finally { sessions.list = list; }
  assert.equal(result.ok, true); assert.equal(result.task, key.task); assert.equal(result.model, 'Fable 5.1');
  assert.equal(result.queued, false);
  const row = await waitReplies(1), received = JSON.parse(row.text);
  assert.equal(received.args[received.args.indexOf('--model') + 1], 'claude-fable-5-1');
  assert.equal(row.model, 'Fable 5.1'); assert.match(received.input, /同じ作業/);
  assert.match(received.input, /【この番の起動】[^\n]*Claude Code・Fable 5.1（CLI 引数 --model claude-fable-5-1）/);
  assert.match(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), /相手に「実際のモデルを確かめて違えば止まれ」と書かない/);
  assert.match(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), /モデル名を返させる時は「起動設定のモデル名」と頼む/);
  assert.match(rows()[0].text, /渡した依頼：確認する/);
  assert.match(received.input, /"model":"gpt-6.1-sol"/); // 委任の案内に実際の model 欄
  assert.match(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), /この委任APIは会話画面からだけ使えます/);
  chatWording(received.input);
  assert.match(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), /この依頼を繰り返し送ったりしない/);
  assert.deepEqual(tasks(), before);
  assert.equal(fs.readFileSync(path.join(dir, '.ai/tasks/old-child.md'), 'utf8'), child);
  const state = await (await fetch(base + '/api/state', { headers: { Connection: 'close' } })).json();
  const t = state.projects[0].tasks.find(t => t.id === key.task);
  assert.equal(t.owner, 'claude-code'); assert.equal(t.role, '文章'); assert.equal(t.model, 'Opus 5.5');
});

test('稼働中は止めず、Codex→Fable→Opusを指定順で実行し履歴・待ち順を保存する', {timeout:240000}, async () => {
  if(native)return nativeCases().queue();
  const before = tasks();
  assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'gpt-6.1-sol', text: 'parent-working' })).status, 200);
  const check = await (await delegate({ ai: 'claude', role: 'チェック', title: '律の確認' })).json();
  const write = await (await delegate({ ai: 'claude', model: 'claude-opus-5-5', title: '紬の修正', text: 'write' })).json();
  assert.equal(check.queued, true, JSON.stringify(check)); assert.equal(write.queued, true, JSON.stringify(write));
  assert.equal(check.task, key.task); assert.equal(check.model, 'Fable 5.1');
  const saved = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.deepEqual(saved.map(x => x.model), ['Fable 5.1', 'Opus 5.5']);
  assert.equal(saved[0].id, check.id); assert.match(saved[0].shown, /律の確認/);
  const active = (await (await fetch(base + '/api/state', { headers: { Connection: 'close' } })).json()).chatting;
  assert.equal(active.length, 1); assert.equal(active[0].ai, 'codex');
  await waitReplies(4);
  assert.deepEqual(replies().slice(-3).map(r => [r.ai, r.model]), [
    ['codex', 'GPT-6.1-Sol'], ['claude', 'Fable 5.1'], ['claude', 'Opus 5.5']]);
  for (const row of replies().slice(-3)) {
    assert.equal(row.error, '');
    const got = JSON.parse(row.text);
    const flag = got.args[got.args.indexOf('--model') + 1];
    assert.equal(flag, launch.flagFor(row.ai, row.model));
    const current = got.input.split('以下は、この作業の会話')[0];
    chatWording(current);
    assert.match(current, /【この番の起動】/);
    assert.ok(current.includes(`CLI 引数 --model ${flag}`));
  }
  const checkInput = JSON.parse(replies()[2].text).input;
  assert.match(checkInput, /parent-working/); // 別AIの結果を引き継ぐ
  assert.match(rows().find(r => r.request === check.id).text, /渡した依頼：律の確認/);
  assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), []);
  assert.deepEqual(tasks(), before);
});

test('CLI ID の改名・無効化は正式名での委任にも適用される', {timeout:240000}, async () => {
  const old = structuredClone(launch.getOverrides());
  try {
    launch.setOverrides({ claude: { 'Fable 5.1': 'test-fable-id' } });
    assert.equal((await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).status, 409);
    assert.equal(launch.flagFor('claude', 'test-fable-id'), 'test-fable-id');
    launch.setOverrides({ claude: { 'Fable 5.1': '' } });
    assert.equal((await delegate({ ai: 'claude', model: 'Fable 5.1' })).status, 409);
    assert.equal((await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).status, 409);
  } finally { launch.setOverrides(old); }
});

test('再起動後の保存済み委任は同じ作業の［始める］で再開できる', {timeout:240000}, async () => {
  if(native)return nativeCases().saved();
  const item = { id: 'saved-delegate', ai: 'claude', model: 'Fable 5.1', text: 'saved-review', shown: '【渡した依頼：保存済みの確認】\nsaved-review' };
  // メモリ上の空キューを再ロードして、保存ファイルの復旧経路を通す。
  await new Promise(r => server.close(r));
  fs.writeFileSync(queueFile, JSON.stringify([item]));
  const port = Number(process.env.HUB_PORT);
  delete require.cache[require.resolve('../server')];
  ({ server, sessions } = require('../server')); await new Promise(r => server.listen(port, '127.0.0.1', r));
  const result = await (await post('/api/chat/send', { fromQueue: item.id })).json();
  assert.equal(result.ok, true); assert.equal(result.model, 'Fable 5.1');
  await waitReplies(5);
  assert.match(rows().filter(r => r.role === 'user').at(-1).text, /渡した依頼：保存済みの確認/);
  assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), []);
  assert.equal(tasks().length, 2);
});

test('［止める］は現在の AI と委任の順番待ちを止め、勝手に次のモデルを起動しない', {timeout:240000}, async () => {
  if(native)return nativeCases().stopped();
  assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'GPT-6.1-Sol', text: 'parent-working' })).status, 200);
  assert.equal((await (await delegate({ ai: 'claude', model: 'Fable 5.1' })).json()).queued, true);
  assert.equal((await post('/api/chat/stop', {})).status, 200);
  const row = await waitReplies(6);
  assert.equal(row.ai, 'codex'); assert.equal(row.error, '止めました');
  assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), []);
  assert.equal(tasks().length, 2);
});

test('待っている間にモデル名が無効になっても、理由を表示して待ち順を保持し既定で起動しない', {timeout:240000}, async () => {
  if(native)return nativeCases().disabled();
  const old = structuredClone(launch.getOverrides());
  try {
    assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'GPT-6.1-Sol', text: 'parent-working' })).status, 200);
    const pending = await (await delegate({ ai: 'claude', model: 'Fable 5.1' })).json();
    assert.equal(pending.queued, true);
    launch.setOverrides({ claude: { 'Fable 5.1': '' } });
    await waitReplies(7);
    const q = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(q.length, 1); assert.equal(q[0].id, pending.id);
    assert.match(q[0].error, /モデル指定なしでは起動しません/);
    assert.match(rows().at(-1).text, /順番待ちの依頼を始められません/);
    assert.equal((await post('/api/chat/send', { fromQueue: pending.id })).status, 409);
    assert.equal(replies().length, 7); // 既定の Opus を起動していない
    launch.setOverrides({ claude: { 'Fable 5.1': 'claude-opus-5-5' } });
    const changed = await post('/api/chat/send', { fromQueue: pending.id });
    assert.equal(changed.status, 409);
    assert.match((await changed.json()).error, /依頼時から変更/);
    assert.equal(replies().length, 7); // 同じ画面名に別モデルが設定されても起動しない
    launch.setOverrides(old);
    assert.equal((await post('/api/chat/send', { fromQueue: pending.id })).status, 200);
    await waitReplies(8);
    assert.equal(replies().at(-1).model, 'Fable 5.1');
    assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), []);
    assert.equal(tasks().length, 2);
  } finally { launch.setOverrides(old); }
});

const taskFile = path.join(dir, '.ai/tasks/existing.md');
const taskData = async () => (await (await fetch(base + '/api/state', { headers: { Connection: 'close' } })).json()).projects[0].tasks.find(t => t.id === key.task);

test('同じ作業の稼働端末だけを拒否し、対象AI欄の停止を案内して状態を保持する', {timeout:240000}, async () => {
  if(native)return nativeCases().terminal();
  const before = fs.readFileSync(taskFile, 'utf8'), count = rows().length;
  const list = sessions.list;
  try {
    for (const [ais, names] of [[['claude'], 'Claude Code'], [['codex', 'agy', 'codex'], 'Codex・Agy CLI']]) {
      sessions.list = () => [
        ...ais.map(ai => ({ ...key, ai, running: true })),
        { ...key, ai: 'claude', running: false },
        { ...key, project: '別プロジェクト', ai: 'claude', running: true },
        { ...key, task: '別作業', ai: 'claude', running: true },
      ];
      const res = await delegate({ ai: 'claude', model: 'claude-fable-5-1' });
      assert.equal(res.status, 409);
      const error = (await res.json()).error;
      assert.ok(error.includes(`AI（${names}）が動いているため、委任できません`));
      assert.ok(error.includes(`［ターミナル］に切り替え、${names}の欄の［停止］`));
      assert.match(error, /会話画面の［停止］は押させない（待っている指示も取り消されます）/);
      assert.match(error, /繰り返し送ったりしない/);
      assert.doesNotMatch(error, /ターミナルのAIを終了/);
      assert.equal(fs.readFileSync(taskFile, 'utf8'), before);
      assert.equal(rows().length, count); assert.equal(tasks().length, 2);
    }
  } finally { sessions.list = list; }
});

test('開始直前の検査で断られても、状態・質問を起動前に書き換えない', {timeout:240000}, async () => {
  if(native)return nativeCases().beforeLaunch();
  assert.equal((await post('/api/task', { state: '返事待ち', question: '人の判断がまだ必要' })).status, 200);
  const before = fs.readFileSync(taskFile, 'utf8'), count = rows().length;
  const send = chat.ChatRunner.prototype.send;
  try {
    chat.ChatRunner.prototype.send = () => { throw Error('開始直前の検査で停止'); };
    const res = await delegate({ ai: 'claude', model: 'claude-fable-5-1' });
    assert.equal(res.status, 409); assert.match((await res.json()).error, /開始直前の検査で停止/);
    assert.equal(fs.readFileSync(taskFile, 'utf8'), before);
    assert.equal(rows().length, count); assert.equal(tasks().length, 2);
  } finally { chat.ChatRunner.prototype.send = send; }
});

test('CLIの起動失敗でも状態・質問を保持し、復旧後の起動成功でだけ更新する', {timeout:240000}, async () => {
  if(native)return nativeCases().failedCLI();
  const before = fs.readFileSync(taskFile, 'utf8'), count = replies().length;
  const cli = path.join(bin, 'claude'), unavailable = path.join(bin, 'claude-unavailable');
  fs.renameSync(cli, unavailable);
  try {
    const res = await delegate({ ai: 'claude', model: 'claude-fable-5-1' });
    assert.equal(res.status, 409); assert.match((await res.json()).error, /AIを起動できませんでした/);
    const row = await waitReplies(count + 1); assert.match(row.error, /見つかりません/);
    assert.equal(fs.readFileSync(taskFile, 'utf8'), before);
  } finally { fs.renameSync(unavailable, cli); }
  assert.equal((await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).status, 200);
  const t = await taskData(); assert.equal(t.state, '実行中'); assert.equal(t.question, '');
  await waitReplies(count + 2); assert.equal(tasks().length, 2);
});

test('完了作業へは新規委任・保存キュー再開を拒否し、人の再開後も起動失敗なら質問と待ち順を保持する', {timeout:240000}, async () => {
  if(native)return nativeCases().completed();
  const old = structuredClone(launch.getOverrides()), count = replies().length;
  let pending;
  try {
    assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'GPT-6.1-Sol', text: 'parent-working' })).status, 200);
    pending = await (await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).json();
    assert.equal(pending.queued, true);
    launch.setOverrides({ claude: { 'Fable 5.1': '' } });
    await waitReplies(count + 1);
  } finally { launch.setOverrides(old); }
  let t = await taskData();
  assert.equal((await post('/api/task/completion', { action: 'approve', confirm: true, expectedHash: t.completionHash })).status, 200);
  t = await taskData(); assert.equal(t.state, '完了');
  const before = fs.readFileSync(taskFile, 'utf8'), rowCount = rows().length;
  for (const res of [await delegate({ ai: 'claude', model: 'claude-fable-5-1' }), await post('/api/chat/send', { fromQueue: pending.id })]) {
    assert.equal(res.status, 409); assert.match((await res.json()).error, /完了済み/);
  }
  assert.equal(fs.readFileSync(taskFile, 'utf8'), before); assert.equal(rows().length, rowCount);
  assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8'))[0].id, pending.id);
  assert.equal((await post('/api/task/completion', { action: 'continue', confirm: true, expectedHash: t.completionHash })).status, 200);
  assert.equal((await post('/api/task', { state: '返事待ち', question: '再開の判断を待っている' })).status, 200);
  const waiting = fs.readFileSync(taskFile, 'utf8');
  const cli = path.join(bin, 'claude'), unavailable = path.join(bin, 'claude-unavailable');
  fs.renameSync(cli, unavailable);
  try {
    assert.equal((await post('/api/chat/send', { fromQueue: pending.id })).status, 409);
    await waitReplies(count + 2);
    assert.equal(fs.readFileSync(taskFile, 'utf8'), waiting);
    assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8'))[0].id, pending.id);
  } finally { fs.renameSync(unavailable, cli); }
  assert.equal((await post('/api/chat/send', { fromQueue: pending.id })).status, 200);
  await waitReplies(count + 3);
  t = await taskData(); assert.equal(t.state, '実行中'); assert.equal(t.question, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), []); assert.equal(tasks().length, 2);
});

test('自動で次の委任を起動できない時は、質問・失敗した依頼・後続を残して再送せず止める', {timeout:240000}, async () => {
  if(native)return nativeCases().autoFailure();
  const count = replies().length;
  assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'GPT-6.1-Sol', text: 'parent-working' })).status, 200);
  const first = await (await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).json();
  const second = await (await delegate({ ai: 'codex', model: 'gpt-6.1-sol', title: '次の依頼', text: 'following' })).json();
  assert.equal(first.queued, true); assert.equal(second.queued, true);
  assert.equal((await post('/api/task', { state: '返事待ち', question: '残しておく質問' })).status, 200);
  const before = fs.readFileSync(taskFile, 'utf8');
  const cli = path.join(bin, 'claude'), unavailable = path.join(bin, 'claude-unavailable');
  fs.renameSync(cli, unavailable);
  try {
    const row = await waitReplies(count + 2);
    assert.match(row.error, /見つかりません/);
    assert.equal(fs.readFileSync(taskFile, 'utf8'), before);
    const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.deepEqual(queue.map(x => x.id), [first.id, second.id]);
    assert.match(queue[0].error, /起動できませんでした/);
  } finally { fs.renameSync(unavailable, cli); }
  assert.equal((await post('/api/chat/send', { fromQueue: first.id })).status, 200);
  await waitReplies(count + 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(queueFile, 'utf8')), []); assert.equal(tasks().length, 2);
});

test('最初の会話・継続の番に画面名案内が入り、手順更新後は黄色い帯の情報になる', {timeout:240000}, async () => {
  if(native)return nativeCases().guidance();
  assert.equal((await post('/api/task', { state: '実行中', question: '' })).status, 200);
  assert.equal((await post('/api/task/step', { index: 0, done: false })).status, 200);
  // 会話の最初の番を作る。メタデータだけをfixture内で退避。
  const meta = path.join(dir, '.ai/chat/existing.json');
  if (fs.existsSync(meta)) fs.renameSync(meta, meta + '.guidance-backup');
  const before = replies().length;
  assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'gpt-6.1-sol', text: 'guidance-first' })).status, 200);
  const first = JSON.parse((await waitReplies(before + 1)).text);
  assert.ok(!first.args.includes('resume'));
  chatWording(first.input);
  assert.match(first.input, /【人への操作案内の決まり】/);
  assert.match(first.input, /【この番の起動】[^\n]*Codex・GPT-6.1-Sol（CLI 引数 --model gpt-6.1-sol）/);
  assert.match(first.input, /作業「元の作業」（作業ID existing）の続きを/);
  assert.match(first.input, /今は確認の黄色い帯なし/);
  assert.doesNotMatch(first.input, /取り込みは人が Hub で行う/);
  assert.equal((await post('/api/task/step', { index: 0, done: true })).status, 200);
  assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'gpt-6.1-sol', text: 'guidance-resume' })).status, 200);
  const resumed = JSON.parse((await waitReplies(before + 2)).text);
  assert.ok(resumed.args.includes('resume'));
  chatWording(resumed.input);
  assert.match(resumed.input.split('以下は、この作業の会話')[0], /【この番の起動】[^\n]*Codex・GPT-6.1-Sol（CLI 引数 --model gpt-6.1-sol）/);
  assert.match(resumed.input, /【決まり】前回と同じ/);
  assert.match(fs.readFileSync(path.join(dir, '.ai/chat/existing.rules.md'), 'utf8'), /【人への操作案内の決まり】/);
  assert.match(resumed.input, /手順 1\/1\n/);
  assert.match(resumed.input, /黄色い帯「AI が手順をすべて済にしました/);
});

test('ターミナルの起動引数には画面を断定しない案内と名前を先にした指示が入る', {timeout:240000}, async () => {
  if(native)return nativeCases().termGuidance();
  const res = await post('/api/term/start', { ai: 'claude' });
  assert.equal(res.status, 200);
  const data = await res.json(), prompt = data.args.join('\n');
  assert.equal(data.dry, true);
  assert.match(prompt, /ターミナルからの依頼を受け取った時点/);
  assert.match(prompt, /ターミナルか別の画面/);
  assert.match(prompt, /作業「元の作業」（作業ID existing）の続きを/);
  assert.match(prompt, /あなたはターミナルで動いている/);
  assert.match(prompt, /［会話］に切り替えて、記録した依頼を送ってください/);
  assert.match(prompt, /ターミナルを止める操作は頼まない/);
  assert.doesNotMatch(prompt, /ターミナルのAIを終了/);
  assert.doesNotMatch(prompt, /Hubの同じ作業の/);
});

test('自動の順番待ちも前の番の古い表示情報を使わず、開始時の完了確認を渡す', {timeout:240000}, async () => {
  if(native)return nativeCases().queuedGuidance();
  assert.equal((await post('/api/task/step', { index: 0, done: false })).status, 200);
  const count = replies().length;
  assert.equal((await post('/api/chat/send', { ai: 'codex', model: 'gpt-6.1-sol', text: 'parent-working' })).status, 200);
  const queued = await (await delegate({ ai: 'claude', model: 'claude-fable-5-1' })).json();
  assert.equal(queued.queued, true);
  assert.equal((await post('/api/task/step', { index: 0, done: true })).status, 200);
  const next = JSON.parse((await waitReplies(count + 2)).text);
  chatWording(next.input);
  assert.match(next.input, /手順 1\/1\n/);
  assert.match(next.input, /黄色い帯「AI が手順をすべて済にしました/);
  // 最初の番の情報は引き継ぎ履歴に残りうるので、今回のpolicy先頭だけを照合する。
  assert.doesNotMatch(next.input.split('以下は、この作業の会話')[0].split('# 今回の依頼')[0], /今は確認の黄色い帯なし/);
});

test('長い委任は受け付けて差分化の案内を添え、8000字の上限は維持する', {timeout:240000}, async () => {
  if(native)return nativeCases().long();
  const count = replies().length;
  const r = await delegate({ ai: 'claude', model: 'claude-fable-5-1', text: 'r'.repeat(1501) });
  assert.equal(r.status, 200); assert.match((await r.json()).note, /Hub が付ける内容を除き、差分だけ/);
  await waitReplies(count + 1);
  assert.equal((await delegate({ ai: 'claude', model: 'claude-fable-5-1', text: 'r'.repeat(8001) })).status, 400);
});
