'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const chat = require('../lib/chat'), instructions = require('../lib/instructions');
const { install, codexServer } = require('./helpers/portable-cli');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-run-'));
const fake = install(dir, `
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
const claude=process.argv.includes('claude'), current=input.slice(input.lastIndexOf('# 今回の依頼')), out=x=>console.log(JSON.stringify(x)), compact=current.includes('compact-now'), fail=current.includes('fail-now');
if(claude){out({type:'system',session_id:'sid'});if(compact)out({type:'system',subtype:'compact_boundary'});out({type:'assistant',message:{content:[{type:'text',text:JSON.stringify({input:input.replaceAll('[[質問]]','template').replaceAll('[[/質問]]','end')})}]}});out({type:'result',is_error:fail,result:fail?'authentication failed':'',usage:{input_tokens:11,cache_read_input_tokens:22,cache_creation_input_tokens:33}});}
else{out({type:'thread.started',thread_id:'sid-codex'});out({type:'item.completed',item:{type:'agent_message',text:'ok'}});out({type:'turn.completed',usage:{input_tokens:44,cached_input_tokens:12}});}});`);
const codex = process.platform === 'win32' ? codexServer(dir, { text: 'ok', usage: { inputTokens: 44, cachedInputTokens: 12 } }) : fake;
const policy = '【モデルの決まり】fixture\n【利用上限の時】現在は自動交代がオフ\n【別の AI に作業を渡す時】fixture\n【人への操作案内の決まり】fixed\n【操作情報】dynamic';
const packet = issues => instructions.packet({ pdir: dir, task: 'task', policy, issues, common: 'cwd=fixture', contextRule: 'context', askRule: chat.ASK_RULE, port: 1 });
const runner = new chat.ChatRunner({ dirOf: () => dir });
const wait = async () => { for (let i = 0; i < 500 && runner.busy('p', 'task'); i++) await new Promise(r => setTimeout(r, 10)); assert.equal(runner.busy('p', 'task'), null); };
const send = async (text, issues = 'issue') => { runner.send({ ai: 'claude', model: 'Fable 5.1', project: 'p', task: 'task', pdir: dir, dir, text, perm: `${fake.command} claude`, env: fake.env, basePrompt: packet(issues) }); await wait(); return JSON.parse(chat.read(dir, 'task').filter(r => r.role === 'assistant').at(-1).text).input; };
test('実行からmetaを保存し5番ごと・圧縮後・失敗後・全文変更時に復元、usageも保存', async t => {
  t.after(async () => { runner.stopAll(); await wait(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.match(await send('one'), /【モデルの決まり】/);
  for (const text of ['two', 'three', 'four']) assert.match(await send(text), /【決まり】前回と同じ/);
  assert.match(await send('five'), /【モデルの決まり】/);
  assert.match(await send('compact-now'), /【決まり】前回と同じ/);
  assert.equal(chat.readMeta(dir, 'task').rulesSent.claude.restore, true);
  assert.match(await send('after-compact'), /【モデルの決まり】/);
  await send('fail-now'); assert.equal(chat.readMeta(dir, 'task').rulesSent.claude.restore, true);
  assert.match(await send('after-fail'), /【モデルの決まり】/);
  assert.match(await send('changed', 'changed issue'), /【モデルの決まり】/);
  const row = chat.read(dir, 'task').filter(r => r.role === 'assistant').at(-1); assert.deepEqual(row.usage, { input_tokens: 11, cache_read_input_tokens: 22, cache_creation_input_tokens: 33 });
  runner.send({ ai: 'codex', model: 'GPT-6.1-Sol', project: 'p', task: 'task', pdir: dir, dir, text: 'codex', perm: codex.command, env: codex.env, basePrompt: packet('issue') }); await wait();
  assert.deepEqual(chat.read(dir, 'task').filter(r => r.role === 'assistant').at(-1).usage, { input_tokens: 44, cached_input_tokens: 12 });
});
