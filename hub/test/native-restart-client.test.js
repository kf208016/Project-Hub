'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {RestartClient,verify}=require('../public/native-restart-client');
const spec={operation:crypto.randomUUID(),sourceHash:'a'.repeat(64),statusKey:crypto.randomBytes(32).toString('base64url'),statusPort:4547},challenge='b'.repeat(64);
const signed=(body,nonce=challenge)=>{const text=JSON.stringify(body);return{body:text,proof:crypto.createHmac('sha256',spec.statusKey).update('hub-restart-status-v1\n'+nonce+'\n'+text).digest('hex')};};
const ready={operation:spec.operation,sourceHash:spec.sourceHash,phase:'ready',error:null,pid:12345,createdTicks:'123456789'};
test('Restart client verifies exact operation/source/process and rejects forged or replayed proofs',async()=>{
  assert.deepEqual(await verify(signed(ready),challenge,spec),ready);
  for(const response of [{...signed(ready),proof:'0'.repeat(64)},signed({...ready,operation:crypto.randomUUID()}),signed({...ready,sourceHash:'c'.repeat(64)}),signed({...ready,createdTicks:'bad'}),signed({...ready,pid:0}),signed(ready,'c'.repeat(64))])await assert.rejects(verify(response,challenge,spec));
});
test('Restart polling sends no cookies and resumes only after a verified ready status',async()=>{
  const notifications=[],client=new RestartClient({notify:type=>notifications.push(type),sleep:async()=>{},fetch:async(url,options)=>{assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');const nonce=new URL(url).searchParams.get('challenge');return{ok:true,json:async()=>signed(ready,nonce)};}});
  client.pause();assert.equal(client.paused,true);assert.deepEqual(await client.wait(spec),ready);assert.equal(client.paused,false);assert.deepEqual(notifications,['pause','pause','ready']);
});
test('Restart failures, expiry and invalid clocks leave the interface paused',async()=>{
  for(const setup of [{fetch:async url=>({ok:true,json:async()=>signed({...ready,phase:'failed',error:'SYNTHETIC_RESTART_REFUSED'},new URL(url).searchParams.get('challenge'))})},{fetch:async url=>({ok:true,json:async()=>({...signed(ready,new URL(url).searchParams.get('challenge')),proof:'0'.repeat(64)})})},{monotonic:()=>NaN},{monotonic:(()=>{let n=0;return()=>n++*90000;})(),fetch:async()=>({ok:false})}]){
    const client=new RestartClient({sleep:async()=>{},...setup});await assert.rejects(client.wait(spec));assert.equal(client.paused,true);
  }
});
test('Only explicit refusal before helper launch restores the old connection',async()=>{
  const client=new RestartClient();client.pause();
  for(const value of [{},{notStarted:false,stage:'busy'},{notStarted:true,stage:'handshake'}])assert.throws(()=>client.resumePreflight(value));
  assert.equal(client.paused,true);client.resumePreflight({notStarted:true,stage:'busy'});assert.equal(client.paused,false);
  client.pause();client.spec=spec;assert.throws(()=>client.resumePreflight({notStarted:true,stage:'preflight'}));assert.equal(client.paused,true);
});
