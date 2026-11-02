'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {loginState,ttlFromEnv,assertFreshForTurn}=require('../lib/grok-login');
const {createPlan}=require('../lib/provider-native-plan');
const ttl=21300000,now=1800000000000;
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r19-gate-')),file=path.join(home,'.grok','auth.json');
  fs.mkdirSync(path.dirname(file));
  t.after(()=>{assert.equal(path.dirname(path.resolve(home)),path.resolve(os.tmpdir()));fs.rmSync(home,{recursive:true,force:true});});
  return {home,file,write:mtime=>{fs.writeFileSync(file,'synthetic');fs.utimesSync(file,mtime/1000,mtime/1000);},options:{home,now,ttlMs:ttl}};
}
function forbidReads(t,file){
  let attempts=0;
  for(const [obj,name] of [[fs,'openSync'],[fs,'readFileSync'],[fs,'createReadStream'],[fs.promises,'readFile']]){
    const original=obj[name];t.mock.method(obj,name,function(p,...args){if(path.resolve(String(p)).toLowerCase()===file.toLowerCase()){attempts++;assert.fail('credential content read forbidden');}return original.call(this,p,...args);});
  }
  return ()=>assert.equal(attempts,0);
}
test('R19 login metadata covers missing, fresh, expired and TTL boundaries',t=>{
  const f=fixture(t);assert.deepEqual(loginState(f.options),{state:'missing',mtime:null,ageMs:null,expiresAt:null,refreshAt:null,ttlMs:ttl});
  for(const [age,state]of [[0,'fresh'],[ttl-2100001,'fresh'],[ttl-2100000,'expiring'],[ttl-1,'expiring'],[ttl,'expired'],[ttl+1,'expired'],[-300000,'fresh'],[-300001,'unknown']]){
    f.write(now-age);const s=loginState(f.options);assert.equal(s.state,state);assert.equal(s.mtime,now-age);assert.equal(s.ageMs,age);assert.equal(s.expiresAt,now-age+ttl);assert.ok(Object.isFrozen(s));
  }
});
test('R19 denied or non-file metadata is unknown and never blocks',t=>{
  const f=fixture(t);fs.mkdirSync(f.file);assert.equal(loginState(f.options).state,'unknown');assertFreshForTurn(f.options);
  let code;t.mock.method(fs,'lstatSync',()=>{throw Object.assign(Error('private'),{code});});
  for(code of ['EACCES','EPERM','EIO']){assert.equal(loginState(f.options).state,'unknown');assert.doesNotThrow(()=>assertFreshForTurn(f.options));}
});
test('R19 TTL environment parser accepts only decimal integer strings in range',()=>{
  for(const value of ['600000','86400000','21480000','0600000'])assert.equal(ttlFromEnv(value),Number(value));
  for(const value of [undefined,null,600000,{},'', '599999','86400001','600000.0','6e5','+600000','-600000',' 600000','600000\n','0x927c0','Infinity','9'.repeat(500)])assert.equal(ttlFromEnv(value),ttl);
});
test('R19 missing and expired gate errors are bare, notStarted 409; fresh and unknown pass without reads',t=>{
  const f=fixture(t);
  assert.throws(()=>assertFreshForTurn(f.options),{message:'GROK_LOGIN_MISSING',code:'GROK_LOGIN_MISSING',status:409,notStarted:true});
  f.write(now-ttl);const check=forbidReads(t,f.file);
  assert.throws(()=>assertFreshForTurn(f.options),{message:'GROK_LOGIN_EXPIRED',code:'GROK_LOGIN_EXPIRED',status:409,notStarted:true});
  fs.utimesSync(f.file,now/1000,now/1000);assertFreshForTurn(f.options);assert.equal(loginState(f.options).state,'fresh');
  fs.utimesSync(f.file,(now+300001)/1000,(now+300001)/1000);assertFreshForTurn(f.options);assert.equal(loginState(f.options).state,'unknown');
  fs.unlinkSync(f.file);assert.throws(()=>assertFreshForTurn(f.options),{code:'GROK_LOGIN_MISSING'});check();
});
test('R19 service runs optional refresh then gate, never runtime on rejection; Claude skips gate',async()=>{
  const filename=path.join(__dirname,'../lib/native-provider-service.js'),source=fs.readFileSync(filename,'utf8'),actual=createRequire(filename);
  for(const ai of ['grok','claude'])for(const state of ['missing','expired','expiring','fresh','unknown']){
    const order=[],module={exports:{}};
    class Runtime {active(){return 0;}prepareTurn(){order.push('runtime');}}
    vm.runInNewContext(source,{module,require:n=>n==='./native-provider-runtime'?{NativeProviderRuntime:Runtime}:actual(n)});
    const service=new module.exports.NativeProviderService({resolveWorkspace:()=>{},profile:()=>{},modelFlag:()=>{},effortFlag:()=>{},supervisedSpawn:()=>{},
      refresher:{ensureFresh:async()=>{order.push('refresh');throw Error('ignored');}},grokLoginGate:()=>{order.push('gate');if(['missing','expired','expiring'].includes(state))throw Object.assign(Error('GROK_LOGIN_'+state.toUpperCase()),{code:'GROK_LOGIN_'+state.toUpperCase(),status:409,notStarted:true});}});
    if(ai==='grok'&&['missing','expired','expiring'].includes(state)){await assert.rejects(service.prepareTurn({ai}),{code:'GROK_LOGIN_'+state.toUpperCase(),status:409,notStarted:true});assert.deepEqual(order,['refresh','gate']);}
    else {await service.prepareTurn({ai});assert.deepEqual(order,ai==='grok'?['refresh','gate','runtime']:['runtime']);}
  }
});
test('R19 mtime fallback still inspects owner credentials, not the R25 provider copy',t=>{
  const home='C:\\Users\\SyntheticOwner',seen=[];
  const plan=createPlan({actor:'grok',ownerHome:home,runtimeBase:home+'\\AppData\\Local\\ProjectHub',cwd:'C:\\Synthetic\\Work',rootFingerprint:'a'.repeat(64),providerFile:'C:\\Synthetic\\grok.exe',codexFile:'C:\\Synthetic\\codex.exe',codexSHA256:'b'.repeat(64),nodeFile:'C:\\Synthetic\\node.exe',gitDirectory:'C:\\Synthetic\\git',hubLibDirectory:'C:\\Synthetic\\lib',providerArgs:[],proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:12345',systemRoot:'C:\\Windows'});
  t.mock.method(fs,'lstatSync',file=>{seen.push(file);throw Object.assign(Error(),{code:'ENOENT'});});
  assert.throws(()=>assertFreshForTurn({home}),{code:'GROK_LOGIN_MISSING'});
  assert.deepEqual(seen.map(p=>path.win32.normalize(p).toLowerCase()),[(home+'\\.grok\\auth.json').toLowerCase()]);
  assert.ok(plan.credentialFiles[0].startsWith(plan.providerHome));
});
test('R19 nativeWorkspaceError maps bare login codes to Traditional Chinese',()=>{
  const filename=path.join(__dirname,'../server.js'),source=fs.readFileSync(filename,'utf8'),line=source.split('\n').find(l=>l.startsWith('function nativeWorkspaceError('));
  const context=vm.createContext({require:createRequire(filename)});vm.runInContext(line,context);
  for(const code of ['GROK_LOGIN_MISSING','GROK_LOGIN_EXPIRED','GROK_LOGIN_EXPIRING']){
    const result=context.nativeWorkspaceError(Object.assign(Error(code),{code,status:409,notStarted:true}));
    assert.equal(result.code,code);assert.equal(result.notStarted,true);assert.equal(result.error,require('../lib/native-provider-messages').messageFor(code));assert.match(result.error,/這則訊息沒有送出/);
  }
});
