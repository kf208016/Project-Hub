'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const locks=require('../lib/task-write-lock');
test('controller handoff lock rejects competing writers and project handoffs while allowing private transaction',async()=>{
  const root=path.join(os.tmpdir(),'owned-lock-scope');let unblock,entered;
  const ready=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>unblock=resolve);
  const running=locks.run(root,'T1',async()=>{assert.doesNotThrow(()=>locks.assertPathWritable(path.join(root,'.ai/tasks/T1.md')));entered();await wait;});
  await ready;
  try{
    assert.equal(locks.active(),true);assert.equal(locks.blocked(root),true);
    assert.throws(()=>locks.assertPathWritable(path.join(root,'.ai/chat/T1.jsonl')),{code:'HANDOFF_WRITE_BUSY'});
    await assert.rejects(locks.run(root,'T2',async()=>{}),{code:'HANDOFF_WRITE_BUSY'});
    assert.doesNotThrow(()=>locks.assertPathWritable(path.join(root+'-other','file')));
  }finally{unblock();await running;}
  assert.equal(locks.active(),false);assert.doesNotThrow(()=>locks.assertPathWritable(path.join(root,'file')));
});
test('failure releases process lock and invalid task scope is rejected',async()=>{
  const root=path.join(os.tmpdir(),'owned-lock-failure');
  await assert.rejects(locks.run(root,'T1',async()=>{throw Error('injected');}),/injected/);
  assert.equal(locks.active(),false);
  await assert.rejects(locks.run(root,'../T2',async()=>{}),{code:'HANDOFF_LOCK_INVALID'});
});
test('accepted partial retains project lease after async writer exits and only exact private recovery releases it',async()=>{
 const root=path.join(os.tmpdir(),'owned-lock-partial'),receiptId='a'.repeat(8)+'-'+ 'a'.repeat(4)+'-4aaa-8aaa-'+ 'a'.repeat(12);
 await locks.run(root,'T1',async()=>{locks.hold(root,'T1',receiptId);},{receiptId});
 try{
   assert.equal(locks.active(),false);assert.equal(locks.blocked(root),true);
   assert.throws(()=>locks.assertPathWritable(path.join(root,'.ai/tasks/T1.md')),{code:'HANDOFF_WRITE_BUSY'});
   await assert.rejects(locks.run(root,'T1',async()=>{}),{code:'HANDOFF_WRITE_BUSY'});
   await assert.rejects(locks.run(root,'T2',async()=>{},{receiptId}),{code:'HANDOFF_WRITE_BUSY'});
   await locks.run(root,'T1',async()=>{assert.doesNotThrow(()=>locks.assertPathWritable(path.join(root,'.ai/tasks/T1.md')));locks.release(root,'T1',receiptId);},{receiptId});
 }finally{locks.release(root,'T1',receiptId);}
 assert.equal(locks.blocked(root),false);
});
