'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CommandIntents}=require('../lib/command-intents');
const root=process.cwd(),scope={id:'11111111-1111-4111-8111-111111111111',project:'p',task:'one',run:'fixture-run-1111111111111111',taskHash:'c'.repeat(64),root,rootFingerprint:'a'.repeat(64)};
const body={argv:[process.execPath,'-e','console.log("fixture")'],cwd:root,expectedHash:scope.taskHash};
const approve=row=>({id:row.id,decision:'approve',confirm:true,ackBroaderRead:true,ackNetworkLimits:true,argv:row.argv,cwd:row.cwd,expectedHash:row.taskHash,rootFingerprint:row.rootFingerprint});
test('Command intents bind exact argv/root/hash, execute once and restrict result to the issuing run',async()=>{
  let calls=0;const broker=new CommandIntents({resolve:async()=>scope,execute:()=>({promise:Promise.resolve({exitCode:0,stdout:'fixture'}),cancel(){},...(calls++,{})})});
  const row=await broker.request(scope,body);assert.equal(row.state,'pending');
  await assert.rejects(broker.decide({...approve(row),argv:[process.execPath,'-e','wrong']}));
  await assert.rejects(broker.decide({...approve(row),ackBroaderRead:false}));assert.equal(calls,0);
  await broker.decide(approve(row));await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(broker.get(scope,row.id).result.stdout,'fixture');
  assert.throws(()=>broker.get({...scope,run:'fixture-other-1111111111111111'},row.id),{status:404});await assert.rejects(broker.decide(approve(row)));assert.equal(calls,1);
});
test('Command intents fail closed when task hash/root identity changes after review',async()=>{
  let current=scope,calls=0;const broker=new CommandIntents({resolve:async()=>current,execute:()=>{calls++;throw Error('must not run');}});const row=await broker.request(scope,body);
  current={...scope,rootFingerprint:'b'.repeat(64)};await assert.rejects(broker.decide(approve(row)));assert.equal(calls,0);assert.equal(broker.get(scope,row.id).state,'failed');
});
test('Concurrent approval claims only one execution even while validation is awaiting',async()=>{
  let release,calls=0,n=0;const broker=new CommandIntents({resolve:()=>++n===2?new Promise(r=>release=()=>r(scope)):Promise.resolve(scope),execute:()=>{calls++;return{promise:Promise.resolve({exitCode:0}),cancel(){}};}});const row=await broker.request(scope,body),first=broker.decide(approve(row));
  await assert.rejects(broker.decide(approve(row)));release();await first;assert.equal(calls,1);
});
test('Decline, cancellation, expiry and backwards time never execute pending intents',async()=>{
  let now=10000,calls=0;const broker=new CommandIntents({resolve:async()=>scope,execute:()=>{calls++;throw Error('must not execute');},now:()=>now,ttlMs:1000});
  const declined=await broker.request(scope,body);await broker.decide({id:declined.id,decision:'decline',confirm:true});assert.equal(broker.get(scope,declined.id).state,'declined');
  const canceled=await broker.request(scope,body);broker.cancel(scope,canceled.id);await assert.rejects(broker.decide(approve(canceled)));
  const expired=await broker.request(scope,body);now+=1000;await assert.rejects(broker.decide(approve(expired)));assert.equal(broker.get(scope,expired.id).state,'expired');
  const backward=await broker.request(scope,body);now--;await assert.rejects(broker.decide(approve(backward)),{code:'INVALID_CLOCK'});assert.equal(calls,0);
});
test('Revoking a run cancels owned execution and remains busy until its process cleanup completes',async()=>{
  let finish,cancel=0;const broker=new CommandIntents({resolve:async()=>scope,execute:()=>({promise:new Promise(r=>finish=r),cancel(){cancel++;}})});const row=await broker.request(scope,body);await broker.decide(approve(row));broker.cancelRun(scope.run);assert.equal(cancel,1);assert.equal(broker.active(),1);assert.equal(broker.get(scope,row.id).state,'canceling');finish({canceled:true});await new Promise(r=>setImmediate(r));assert.equal(broker.active(),0);assert.equal(broker.get(scope,row.id).state,'canceled');
});
test('Monotonic expiry refuses approval even when the wall clock is frozen',async()=>{
  let mono=10000,calls=0;const broker=new CommandIntents({resolve:async()=>scope,execute:()=>{calls++;throw Error('must not run');},now:()=>10000,monotonic:()=>mono,ttlMs:1000});const row=await broker.request(scope,body);mono+=1000;await assert.rejects(broker.decide(approve(row)),{code:'NOT_PENDING'});assert.equal(broker.get(scope,row.id).state,'expired');assert.equal(calls,0);
});
test('Invalid or throwing clocks fail closed and cancel already running execution until owned cleanup finishes',async()=>{
  for(const now of [()=>NaN,()=>Infinity,()=>-1,()=>10000.5,()=>{throw Error('clock unavailable');}]){const invalid=new CommandIntents({resolve:async()=>scope,execute(){throw Error('must not run');},now});await assert.rejects(invalid.request(scope,body),{code:'INVALID_CLOCK'});}
  let wall=10000,cancel=0,finish;const broker=new CommandIntents({resolve:async()=>scope,execute:()=>({promise:new Promise(r=>finish=r),cancel(){cancel++;}}),now:()=>wall,monotonic:()=>10000});const row=await broker.request(scope,body);await broker.decide(approve(row));wall=NaN;assert.throws(()=>broker.list(),{code:'INVALID_CLOCK'});assert.equal(cancel,1);assert.equal(broker.active(),1);finish({canceled:true});await new Promise(r=>setImmediate(r));assert.equal(broker.active(),0);wall=10000;assert.equal(broker.get(scope,row.id).state,'canceled');
});
test('Capability identity binds polling and approval resolution, and exhausted call budget denies execution',async()=>{
  let remainingCalls=1,calls=0,seen;const broker=new CommandIntents({resolve:async(project,task,bound)=>{seen=bound.id;return{...scope,remainingCalls};},execute:()=>{calls++;throw Error('must not run');}});const row=await broker.request(scope,body);assert.equal(row.capId,scope.id);assert.throws(()=>broker.get({...scope,id:'22222222-2222-4222-8222-222222222222'},row.id),{code:'NOT_FOUND'});remainingCalls=0;await assert.rejects(broker.decide(approve(row)),{code:'SCOPE_CHANGED'});assert.equal(seen,scope.id);assert.equal(calls,0);
});
test('Failed durable approval recording blocks execution and cannot be retried with the same intent',async()=>{
  let records=0,calls=0;const broker=new CommandIntents({resolve:async()=>scope,record:()=>{records++;throw Error('synthetic record failure');},execute:()=>{calls++;throw Error('must not run');}});const row=await broker.request(scope,body);await assert.rejects(broker.decide(approve(row)));assert.equal(records,1);assert.equal(calls,0);await assert.rejects(broker.decide(approve(row)),{code:'NOT_PENDING'});assert.equal(broker.get(scope,row.id).state,'failed');
});
test('Scope is checked again after the approval record is written',async()=>{
  let current=scope,calls=0;const broker=new CommandIntents({resolve:async()=>current,record:async()=>{current={...scope,taskHash:'d'.repeat(64)};},execute:()=>{calls++;throw Error('must not run');}});const row=await broker.request(scope,body);await assert.rejects(broker.decide(approve(row)),{code:'SCOPE_CHANGED'});assert.equal(calls,0);
});
test('Completed execution preserves a nonzero exit code and reports a failed command outcome',async()=>{
  const broker=new CommandIntents({resolve:async()=>scope,execute:()=>({promise:Promise.resolve({exitCode:7,stdout:'fixture',stderr:'synthetic failure'}),cancel(){}})});const row=await broker.request(scope,body);await broker.decide(approve(row));await new Promise(r=>setImmediate(r));const result=broker.get(scope,row.id);assert.equal(result.state,'completed');assert.equal(result.outcome,'failure');assert.equal(result.result.exitCode,7);
});
test('Terminal rows are pruned under bounded capacity while active pending intents are retained',async()=>{
  const broker=new CommandIntents({resolve:async()=>scope,execute(){throw Error('must not run');}});const first=await broker.request(scope,body);await broker.decide({id:first.id,decision:'decline',confirm:true});for(let index=0;index<140;index++){const row=await broker.request(scope,body);await broker.decide({id:row.id,decision:'decline',confirm:true});}assert.ok(broker.rows.size<=128);
  const full=new CommandIntents({resolve:async()=>scope,execute(){throw Error('must not run');}});const pending=[];for(let index=0;index<128;index++)pending.push(await full.request(scope,body));await assert.rejects(full.request(scope,body),{code:'INTENT_LIMIT'});assert.equal(full.get(scope,pending[0].id).state,'pending');assert.equal(full.rows.size,128);
});
test('A command approved just before capability expiry is canceled at its monotonic deadline and stays busy until cleanup',async()=>{
  let finish,cancels=0;const expiring={...scope,expiresAt:10030},broker=new CommandIntents({resolve:async()=>expiring,now:()=>10000,execute:()=>({promise:new Promise(r=>finish=r),cancel(){cancels++;}})});const row=await broker.request(expiring,body);assert.equal(row.expiresAt,10030);await broker.decide(approve(row));await new Promise(r=>setTimeout(r,70));assert.equal(cancels,1);assert.equal(broker.active(),1);assert.equal(broker.get(expiring,row.id).state,'canceling');finish({canceled:true});await new Promise(r=>setImmediate(r));assert.equal(broker.active(),0);assert.equal(broker.get(expiring,row.id).state,'canceled');
});
