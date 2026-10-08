'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const managed = require('../lib/managed-process');
const win = process.platform === 'win32' ? test : test.skip;
const wait = ms => new Promise(r => setTimeout(r, ms));
function observe(child) {
  let out = '', err = '', error;
  child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
  child.on('error', e => { error = e; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, out, err, error })));
  return { closed, output: () => out };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch(e) { if (e.code === 'ESRCH') return false; throw e; } }
async function readRow(run) {
  for (let i = 0; i < 200; i++) { const row = run.output().split('\n').find(x => x.startsWith('{')); if(row) return JSON.parse(row); await wait(25); }
  throw Error('Fixture did not report process IDs: ' + run.output());
}
async function assertGone(pids) {
  for(let i=0;i<100 && pids.some(alive);i++) await wait(25);
  assert.deepEqual(pids.map(alive), pids.map(() => false));
}
win('Windows Job preserves stdin, stdout, stderr and literal argv', { timeout: 20000 }, async t => {
  const args = ['space here', 'a"b', 'tail\\', '字 & | $(value)', ''];
  const child = managed.spawn(process.execPath, ['-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{console.log(JSON.stringify({args:process.argv.slice(1),s,spec:process.env.HUB_PROCESS_SPEC}));console.error("diagnostic");});', ...args]);
  t.after(() => child.kill()); const run = observe(child); child.stdin.end('input\n');
  const result = await run.closed;
  assert.equal(result.error, undefined, result.err); assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out), { args, s: 'input\n' }); assert.equal(result.err.trim(), 'diagnostic');
});
const grandchild = 'const g=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.send({grandchild:g.pid});setInterval(()=>{},1000);';
const tree = 'const c=require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(grandchild)+'],{stdio:["ignore","ignore","ignore","ipc"]});c.on("message",m=>console.log(JSON.stringify({parent:process.pid,child:c.pid,...m})));setInterval(()=>{},1000);';
win('Windows Job cancellation removes root and descendants', { timeout: 20000 }, async t => {
  const child=managed.spawn(process.execPath,['-e',tree]); t.after(()=>child.kill());
  const run=observe(child); const ids=await readRow(run); child.kill(); await run.closed;
  await assertGone([ids.parent,ids.child,ids.grandchild]);
});
win('Windows Job owner crash removes owned descendants', { timeout: 20000 }, async t => {
  const source='const m=require('+JSON.stringify(require.resolve('../lib/managed-process'))+');const p=m.spawn(process.execPath,["-e",'+JSON.stringify(tree)+']);p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);p.on("error",()=>{});';
  const owner=spawn(process.execPath,['-e',source],{stdio:['pipe','pipe','pipe']}); t.after(()=>owner.kill());
  const run=observe(owner); const ids=await readRow(run); owner.kill(); await run.closed;
  await assertGone([ids.parent,ids.child,ids.grandchild]);
});
win('Windows Job refuses a missing executable before reporting started', { timeout: 20000 }, async () => {
  const child=managed.spawn('C:\\project-hub-no-such-executable.exe',[]); let started=false; child.on('spawn',()=>started=true);
  const run=observe(child); child.stdin.end(); const result=await run.closed;
  assert.equal(started,false); assert.equal(result.code,125); assert.ok(result.error);
});
