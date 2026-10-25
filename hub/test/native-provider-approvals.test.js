'use strict';
// Controller fixtures: no existing auth, models, OS sandbox or network.
const test=require('node:test'),assert=require('node:assert/strict');
const {NativeProviderApprovals}=require('../lib/native-provider-approvals');
const scope={actor:'grok',project:'synthetic',task:'task-1',model:'grok-4.6',effort:'low'};
const binding={project:scope.project,task:scope.task,dir:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),workspaceRun:'run-1'};
const candidate=()=>({binding:{...binding},descriptor:{scope:{actor:scope.actor,project:scope.project,task:scope.task,runtimeProfileId:'runtime-1',accountProfileId:'local-profile-1',rootFingerprint:binding.rootFingerprint}},review:{destination:'xAI',authenticationRead:['synthetic-auth.json'],lockWrite:'synthetic-auth.json.lock',sessionWrite:'synthetic-state',credentialContentVisibleToOwnCliTools:true}});
const consent=token=>({token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
test('owner consent binds destination/account/runtime/root and permits a fresh run on that same root',async()=>{
  let liveBinding={...binding};
  const store=new NativeProviderApprovals({describe:async()=>({...candidate(),binding:liveBinding})});
  await assert.rejects(()=>store.authorize(scope,binding),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
  const preview=await store.preview(scope);assert.equal(preview.review.destination,'xAI');
  await store.approve(consent(preview.token));assert.equal(store.active(),1);
  assert.equal((await store.authorize(scope,binding)).scope.actor,'grok');
  liveBinding={...binding,workspaceRun:'run-2'};
  assert.equal((await store.authorize(scope,liveBinding)).scope.accountProfileId,'local-profile-1');
});
test('client cannot skip a required acknowledgement, replay preview or alter profile',async()=>{
  let current=candidate();const store=new NativeProviderApprovals({describe:async()=>current});
  const p=await store.preview(scope);
  await assert.rejects(()=>store.approve({...consent(p.token),ackAuthenticationRead:false}),{code:'NATIVE_APPROVAL_INVALID'});
  current={...current,review:{...current.review,destination:'unexpected'}};
  await assert.rejects(()=>store.approve(consent(p.token)),{code:'NATIVE_APPROVAL_CHANGED'});
  await assert.rejects(()=>store.approve(consent(p.token)),{code:'NATIVE_APPROVAL_EXPIRED'});
  assert.equal(store.active(),0);
});
test('changed root/account/MCP profile and provider cannot inherit an earlier grant',async()=>{
  let current=candidate();const store=new NativeProviderApprovals({describe:async()=>current});
  const p=await store.preview(scope);await store.approve(consent(p.token));
  await assert.rejects(()=>store.authorize({...scope,actor:'claude'},binding),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
  current={...current,descriptor:{...current.descriptor,scope:{...current.descriptor.scope,accountProfileId:'different'}}};
  await assert.rejects(()=>store.authorize(scope,binding),{code:'NATIVE_APPROVAL_CHANGED'});
  assert.equal(store.revoke({actor:scope.actor,project:scope.project,task:scope.task}),true);
  assert.equal(store.active(),0);
});
test('expiry, backward time and failed snapshot preserve refusal',async()=>{
  let now=1000;const store=new NativeProviderApprovals({describe:async()=>candidate(),now:()=>now});
  const p=await store.preview(scope);await store.approve(consent(p.token));
  now+=3600000;await assert.rejects(()=>store.authorize(scope,binding),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
  now=1000;const reset=new NativeProviderApprovals({describe:async()=>candidate(),now:()=>now});
  const next=await reset.preview(scope);now=999;
  await assert.rejects(()=>reset.approve(consent(next.token)),{code:'NATIVE_APPROVAL_CLOCK'});
});
test('monotonic expiry cannot be extended by a stalled wall clock and getters are never invoked',async()=>{
  let mono=1;const store=new NativeProviderApprovals({describe:async()=>candidate(),now:()=>1000,monotonic:()=>mono});
  let called=0;const raw={...scope};Object.defineProperty(raw,'model',{enumerable:true,get(){called++;return 'secret';}});
  await assert.rejects(()=>store.preview(raw),{code:'NATIVE_APPROVAL_INVALID'});assert.equal(called,0);
  const p=await store.preview(scope);await store.approve(consent(p.token));mono+=3600000;
  await assert.rejects(()=>store.authorize(scope,binding),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
});

test('insufficient lifetime drops the grant and renews the same request without shortening',async()=>{
  for(const clock of ['wall','monotonic'])for(const shape of ['both','launch','default']){
    let now=1000,mono=1000;
    const descriptor={...candidate().descriptor,...(shape==='default'?{}:{launchOptions:{maxWallMs:1800000}}),...(shape==='both'?{maxWallMs:1800000}:{})};
    const store=new NativeProviderApprovals({describe:async()=>({...candidate(),descriptor}),now:()=>now,monotonic:()=>mono});
    const p=await store.preview(scope);await store.approve(consent(p.token));
    if(clock==='wall')now+=1800000;else mono+=1800000;
    assert.deepEqual(await store.authorize(scope,binding),descriptor);
    if(clock==='wall')now++;else mono++;
    await assert.rejects(()=>store.authorize(scope,binding),e=>e.code==='NATIVE_PROVIDER_APPROVAL_REQUIRED'&&e.actor===scope.actor&&e.project===scope.project&&e.task===scope.task);
    assert.equal(store.active(),0);
    await assert.rejects(()=>store.authorize(scope,binding),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
    const renewal=await store.preview(scope);await store.approve(consent(renewal.token));
    assert.deepEqual(await store.authorize(scope,binding),descriptor);assert.equal(store.active(),1);
  }
});

test('grant expiring during profile recheck is dropped and asks for renewal',async()=>{
  let now=1000,expire=false;
  const store=new NativeProviderApprovals({describe:async()=>{if(expire)now+=3600000;return candidate();},now:()=>now,monotonic:()=>1000});
  const p=await store.preview(scope);await store.approve(consent(p.token));expire=true;
  await assert.rejects(()=>store.authorize(scope,binding),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});assert.equal(store.active(),0);
});

test('describe preserves known diagnostics and sanitizes unknown failures',async()=>{
 for(const code of ['NATIVE_CODEX_VERSION_UNREVIEWED','NATIVE_BINARY_UNAVAILABLE','PRIVATE_UNKNOWN']){const store=new NativeProviderApprovals({describe:()=>{throw Object.assign(Error('PRIVATE_DIAGNOSTIC'),{code,version:'0.165.0'});}});await assert.rejects(store.preview(scope),e=>e.code===(code==='PRIVATE_UNKNOWN'?'NATIVE_PROFILE_UNAVAILABLE':code)&&!e.message.includes('PRIVATE_DIAGNOSTIC')&&(code!=='NATIVE_CODEX_VERSION_UNREVIEWED'||e.message.includes('目前 0.165.0')));}
});

test('unknown thrown values and diagnostic version accessors never expose provider data',async()=>{
 for(const value of [null,'PRIVATE_THROW',Object.defineProperty({code:'NATIVE_CODEX_VERSION_UNREVIEWED'},'version',{get(){throw Error('PRIVATE_GETTER');}})]){const store=new NativeProviderApprovals({describe:()=>{throw value;}});await assert.rejects(store.preview(scope),e=>['NATIVE_PROFILE_UNAVAILABLE','NATIVE_CODEX_VERSION_UNREVIEWED'].includes(e.code)&&!e.message.includes('PRIVATE'));}
});
