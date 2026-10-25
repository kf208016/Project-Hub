'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateResult}=require('../lib/r2-inspect-result');
const examples=require('../windows/worker-r2-inspect-result-examples.json');
const schema=require('../windows/worker-r2-inspect-result.schema.json');
const grant={runNonce:examples.accepted.nonce,uid:examples.accepted.uid,bootId:examples.accepted.bootId};
const clone=()=>structuredClone(examples.accepted);
test('closed partial evidence is preserved with historical cleanup unknown',()=>{
  assert.equal(validateResult(examples.accepted,grant),examples.accepted);
  assert.equal(examples.accepted.cleanupHistorical,'unknown');
  for(const row of examples.rejected)assert.throws(()=>validateResult(row.value,grant),row.reason);
});
test('record order, nested raw text and unknown vocabularies are rejected',()=>{
  for(const edit of [r=>r.records.reverse(),r=>r.records.pop(),r=>r.records[0].facts.secret='private',r=>r.records[0].facts.recordedCode='PRIVATE_MESSAGE',r=>r.records[0].sha256='a'.repeat(64)+'\n',r=>r.unit.subState='arbitrary',r=>r.unit.stderr='private',r=>r.cgroup.path='/home/private',r=>r.cgroup.memoryMax=true,r=>r.records[0].facts.startTicks=1.5,r=>r.records[0].facts.pid=0]){
    const result=clone();edit(result);assert.throws(()=>validateResult(result,grant));
  }
});
test('current valid readings cannot claim provider readiness or historical cleanup',()=>{
  const result=clone();result.cgroup={status:'valid',code:'OK',identityMatches:true,populated:0,frozen:0,memoryMax:6442450944,memorySwapMax:0,pidsMax:256,cpuQuota:150000,cpuPeriod:100000};
  validateResult(result,grant);
  for(const edit of [r=>r.cleanupHistorical='verified',r=>r.providerReady=true,r=>r.snapshotAtomic=true,r=>r.nonce='b'.repeat(64),r=>r.uid=1002,r=>r.bootId='22222222-2222-4222-8222-222222222222',r=>r.ok='false']){
    const changed=structuredClone(result);edit(changed);assert.throws(()=>validateResult(changed,grant));
  }
  assert.equal(schema.additionalProperties,false);
});
