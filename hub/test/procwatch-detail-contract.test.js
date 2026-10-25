'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pw=require('../lib/procwatch');
const row=(pid,ppid,command,since='2026-10-08T01:00:00.0000000Z')=>({pid,ppid,command,name:'node.exe',since});
const unreadable=async wanted=>wanted.map(({pid,since})=>({pid,creationTime:since||'',cwd:'',status:'access-denied'}));
const AROUND=/^U\+[0-9A-F]{4,6}$/;

function watch(exec){
  const logs=[],failures=[];
  const w=pw.create({
    platform:'win32',exec,windowsCwds:unreadable,projects:()=>[],
    log:m=>logs.push(String(m)),onFailure:d=>failures.push(d)
  });
  return {w,logs,failures};
}
function reject(extra){
  const e=Error('synthetic procwatch failure');
  return Object.assign(e,extra);
}

test('Windows query sets UTF-8 output encoding and a timeout of at least 15s',async()=>{
  let captured=null;
  const {w}=watch(async(cmd,args,opts)=>{captured={cmd,args,opts};return JSON.stringify([row(1,0,'system')]);});
  await w.scan();
  assert.ok(captured);
  const blob=JSON.stringify(captured.args);
  assert.match(blob,/OutputEncoding/);
  assert.match(blob,/UTF8/);
  assert.ok(captured.opts&&captured.opts.timeoutMs>=15000);
  assert.equal(typeof captured.args,'object');
});

test('exec ENOENT becomes PROCWATCH_SPAWN_FAILED with errno and notifies log/onFailure',async()=>{
  const {w,logs,failures}=watch(async()=>{throw reject({code:'ENOENT'});});
  await w.scan();
  assert.equal(w.status().code,'PROCWATCH_SPAWN_FAILED');
  assert.equal(w.status().detail.errno,'ENOENT');
  assert.ok(logs.some(line=>line.includes('PROCWATCH_SPAWN_FAILED')));
  assert.ok(failures.some(d=>d&&d.code==='PROCWATCH_SPAWN_FAILED'));
  assert.throws(()=>w.assertKnown(),e=>e.code==='PROCWATCH_SPAWN_FAILED'&&String(e.message).includes('（代碼：'));
});

test('killed SIGTERM becomes PROCWATCH_TIMEOUT',async()=>{
  const {w,logs,failures}=watch(async()=>{throw reject({killed:true,signal:'SIGTERM'});});
  await w.scan();
  assert.equal(w.status().code,'PROCWATCH_TIMEOUT');
  assert.ok(logs.some(line=>line.includes('PROCWATCH_TIMEOUT')));
  assert.ok(failures.some(d=>d&&d.code==='PROCWATCH_TIMEOUT'));
  assert.throws(()=>w.assertKnown(),e=>e.code==='PROCWATCH_TIMEOUT'&&String(e.message).includes('（代碼：'));
});

test('bad JSON escape is PROCWATCH_OUTPUT_INVALID without leaking stdout',async()=>{
  const raw='[{"pid":1,"ppid":0,"since":"","command":"RAWSTDOUT_TOKEN_9f3c\\q","name":"n"}]';
  const {w}=watch(async()=>raw);
  await w.scan();
  const s=w.status();
  assert.equal(s.code,'PROCWATCH_OUTPUT_INVALID');
  assert.equal(typeof s.detail.parseError,'string');
  assert.ok(s.detail.parseError.length>0);
  assert.equal(typeof s.detail.stdoutBytes,'number');
  assert.equal(s.detail.stdoutBytes,Buffer.byteLength(raw));
  assert.ok(Array.isArray(s.detail.around));
  assert.ok(s.detail.around.length>0);
  assert.ok(s.detail.around.length<=16);
  for(const item of s.detail.around)assert.match(item,AROUND);
  const dumped=JSON.stringify(s);
  assert.equal(dumped.includes('RAWSTDOUT_TOKEN_9f3c'),false);
  assert.equal(dumped.includes(raw),false);
});

test('empty Windows JSON is PROCWATCH_EMPTY and a later success keeps lastFailure',async()=>{
  let mode='empty';
  const {w}=watch(async()=>{
    if(mode==='empty')return '[]';
    return JSON.stringify([row(1,0,'system')]);
  });
  await w.scan();
  assert.equal(w.status().code,'PROCWATCH_EMPTY');
  assert.throws(()=>w.assertKnown(),e=>e.code==='PROCWATCH_EMPTY'&&String(e.message).includes('（代碼：'));
  mode='ok';
  await w.scan();
  assert.equal(w.status().state,'ok');
  assert.equal(w.status().lastFailure.code,'PROCWATCH_EMPTY');
  assert.doesNotThrow(()=>w.assertKnown());
});

test('assertKnown before any scan is PROCWATCH_NOT_READY',()=>{
  const {w}=watch(async()=>'[]');
  assert.throws(()=>w.assertKnown(),e=>e.code==='PROCWATCH_NOT_READY'&&String(e.message).includes('（代碼：'));
});
