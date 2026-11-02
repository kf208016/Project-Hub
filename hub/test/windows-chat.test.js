'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../lib/chat');

const winOnly = process.platform === 'win32' ? test : test.skip;
winOnly('Windows Codex chat invokes npm package JS directly with sandbox flags', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
  require('./helpers/codex-server').install(bin,{echo:true});
  const runner = new chat.ChatRunner({ dirOf: () => dir });
  const result = runner.send({ project: 'p', task: 'one', pdir: dir, dir,
    ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'A & B', basePrompt: 'fixture', perm: 'codex',
    env: { PATH: bin + path.delimiter + process.env.PATH } });
  assert.equal(await result.started, true);
  await require('./helpers/wait-hub').waitFor(()=>!runner.busy('p','one'),{deadlineMs:30000});
  assert.equal(runner.busy('p', 'one'), null);
  const response = chat.read(dir, 'one').findLast(row => row.role === 'assistant');
  assert.equal(response.error, '');
  const received = JSON.parse(response.text);
  assert.deepEqual(received.args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  assert.equal(received.settings.sandbox,'workspace-write');
  assert.equal(received.settings.approvalPolicy,'on-request');
  assert.equal(received.settings.approvalsReviewer,'user');
  assert.equal(received.turn.sandboxPolicy.networkAccess,false);
  assert.deepEqual(received.turn.sandboxPolicy.writableRoots,[dir]);
  assert.match(received.turn.input[0].text, /A & B/);
});

winOnly('Windows Codex incomplete output fails closed and retains the queued request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-incomplete-'));
  const bin = path.join(dir,'bin'), entry=path.join(bin,'node_modules','@openai','codex','bin','codex.js');
  fs.mkdirSync(path.dirname(entry),{recursive:true}); fs.writeFileSync(path.join(bin,'codex.cmd'),'');
  require('./helpers/codex-server').install(bin,{mode:'incomplete'});
  const runner = new chat.ChatRunner({dirOf:()=>dir});
  t.after(()=>{runner.stopAll();fs.rmSync(dir,{recursive:true,force:true});});
  const started=runner.send({project:'p',task:'one',pdir:dir,dir,ai:'codex',model:'GPT-6.1-Sol',text:'test',basePrompt:'fixture',perm:'codex',env:{PATH:bin+path.delimiter+process.env.PATH}});
  const running=runner.busy('p','one');
  runner.enqueue('p','one',{ai:'codex',model:'GPT-6.1-Sol',text:'must remain queued'});
  assert.equal(await started.started,true); await running.finishedP;
  const row=chat.read(dir,'one').findLast(x=>x.role==='assistant');
  assert.match(row.error,/完成前中斷/); assert.equal(row.text,'fixture reply');
  assert.equal(runner.queue('p','one').length,1); assert.equal(runner.busy('p','one'),null);
});
