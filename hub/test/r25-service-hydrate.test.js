'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {NativeProviderService}=require('../lib/native-provider-service'),{NativeProviderRuntime}=require('../lib/native-provider-runtime');
const {createPlan}=require('../lib/provider-native-plan'),{canonical}=require('../lib/providers/claude-protocol');
const artifacts=require('../lib/native-cli-update'),safe=require('../lib/safe-path'),scoped=require('../lib/scoped-file'),host=require('../lib/provider-native-host');
const binding={project:'synthetic',task:'task',dir:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),run:'fixture'};
const settings={ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',providerFile:'C:\\Tools\\provider\\grok.exe',codexFile:'C:\\Tools\\codex\\codex.exe',codexSHA256:artifacts.KNOWN,nodeFile:process.execPath,gitDirectory:'C:\\Tools\\git',hubLibDirectory:'C:\\Tools\\hub\\lib',systemRoot:'C:\\Windows'};
const request={ai:'grok',project:binding.project,task:binding.task,dir:binding.dir,model:'Grok 4.6',effort:'中'};
function fixture(t,{hydrateGrok=null,grokLoginGate=()=>{}}={}){
  const service=new NativeProviderService({resolveWorkspace:async()=>binding,profile:()=>({...settings}),modelFlag:()=> 'grok-4.6',effortFlag:()=> 'medium',supervisedSpawn:()=>{throw Error('NO_SPAWN');},hydrateGrok,grokLoginGate});
  return service;
}
test('service hydrates each Grok turn once after gate and before runtime with plan paths',async t=>{
  const order=[],paths=[];t.mock.method(NativeProviderRuntime.prototype,'prepareTurn',async()=>{order.push('runtime');return 'prepared';});
  const service=fixture(t,{grokLoginGate:()=>order.push('gate'),hydrateGrok:async p=>{order.push('hydrate');paths.push(p);return {outcome:'hydrated'};}});
  for(let i=0;i<2;i++)assert.equal(await service.prepareTurn(request),'prepared');
  assert.deepEqual(order,['gate','hydrate','runtime','gate','hydrate','runtime']);
  const plan=createPlan({...settings,actor:'grok',cwd:binding.dir,rootFingerprint:binding.rootFingerprint,providerArgs:[],proxyUrl:'http://hub:'+'0'.repeat(64)+'@127.0.0.1:1'});
  assert.deepEqual(paths,[0,1].map(()=>({providerHome:plan.providerHome,authPath:plan.credentialFiles[0],lockPath:plan.lockFile,runtimeDirectory:plan.runtimeDirectory})));
});
test('service hydration failure is a not-started 409 and gate failure prevents hydration',async t=>{
  let calls=0;t.mock.method(NativeProviderRuntime.prototype,'prepareTurn',async()=>{calls++;});
  for(const result of [{outcome:'failed'},null,{}]){
    const service=fixture(t,{hydrateGrok:async()=>result});
    await assert.rejects(service.prepareTurn(request),{code:'GROK_LOGIN_HYDRATE_FAILED',status:409,notStarted:true});
  }
  let hydrated=0;const service=fixture(t,{grokLoginGate:()=>{throw Error('gate');},hydrateGrok:async()=>{hydrated++;}});
  await assert.rejects(service.prepareTurn(request),/gate/);assert.equal(hydrated,0);assert.equal(calls,0);
});
test('service null hydrator and Claude bypass hydration',async t=>{
  let calls=0,hydrated=0;t.mock.method(NativeProviderRuntime.prototype,'prepareTurn',async()=>{calls++;});
  await fixture(t).prepareTurn(request);
  await fixture(t,{hydrateGrok:async()=>{hydrated++;}}).prepareTurn({...request,ai:'claude'});
  assert.equal(calls,2);assert.equal(hydrated,0);
});
test('service account identity stays on owner file, lock is not inspected and review binds v5',async t=>{
  const inspected=[];t.mock.method(safe,'localPath',f=>f);t.mock.method(scoped,'identity',async()=>({rootFingerprint:'b'.repeat(64)}));
  t.mock.method(artifacts,'digestFile',f=>f.endsWith('codex.exe')?artifacts.KNOWN:host.PROVIDER_HASHES.grok);
  t.mock.method(fs,'lstatSync',file=>{inspected.push(file);return {isFile:()=>true,isSymbolicLink:()=>false,nlink:1n,size:123n,dev:9n};});
  const review=(await fixture(t).preview({actor:'grok',project:binding.project,task:binding.task,model:'Grok 4.6',effort:'中'})).review;
  const owner=settings.ownerHome+'\\.grok\\auth.json';
  const oldIdentity=[{path:process.platform==='win32'?owner.toLowerCase():owner,device:'9'}];
  assert.equal(review.accountProfileId,'auth-'+crypto.createHash('sha256').update(canonical(oldIdentity)).digest('hex'));
  assert.ok(inspected.includes(owner));assert.ok(!inspected.includes(review.authenticationRead[0]));assert.ok(!inspected.some(x=>x.endsWith('.lock')));
  assert.match(review.credentialHydration,/no refresh token/);assert.match(review.authenticationRead[0],/\\grok\\grok\\auth.json$/);
});
