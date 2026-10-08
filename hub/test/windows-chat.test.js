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
  fs.writeFileSync(entry, `let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{
    const out=x=>console.log(JSON.stringify(x));
    out({type:'thread.started',thread_id:'fixture'});
    out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({args:process.argv.slice(2),text})}});
    out({type:'turn.completed'});
  });`);
  const runner = new chat.ChatRunner({ dirOf: () => dir });
  const result = runner.send({ project: 'p', task: 'one', pdir: dir, dir,
    ai: 'codex', model: 'GPT-6.1-Sol', effort: '高', text: 'A & B', basePrompt: 'fixture', perm: 'codex',
    env: { PATH: bin + path.delimiter + process.env.PATH } });
  assert.equal(await result.started, true);
  for (let i = 0; i < 100 && runner.busy('p', 'one'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runner.busy('p', 'one'), null);
  const response = chat.read(dir, 'one').findLast(row => row.role === 'assistant');
  assert.equal(response.error, '');
  const received = JSON.parse(response.text);
  assert.deepEqual(received.args.slice(0, 5), ['-a', 'never', 'exec', '--sandbox', 'workspace-write']);
  assert.match(received.text, /A & B/);
});
