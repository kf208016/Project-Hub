'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {loginState,ttlFromEnv,marginFromEnv,assertFreshForTurn}=require('../lib/grok-login');
const {status}=require('../lib/grok-status');
const {messageFor}=require('../lib/native-provider-messages');
const {codeOf}=require('../lib/native-provider-diagnostic');
const ttl=21300000,margin=2100000,mtime=1800000000000,home=path.resolve('synthetic-owner');
const message='Grok 登入即將到期，為避免回合做到一半中斷，這則訊息沒有送出。請按「更新 Grok 登入」（幾秒鐘、不需要瀏覽器），完成後再送一次。';
function metadata(t){
  t.mock.method(fs,'lstatSync',()=>({isFile:()=>true,isSymbolicLink:()=>false,mtimeMs:mtime,mtime:new Date(mtime),size:1}));
  for(const name of ['openSync','readFileSync','createReadStream'])t.mock.method(fs,name,()=>assert.fail('credential contents must not be opened'));
}
test('R21 defaults and decimal margin parser enforce range and effective TTL',()=>{
  assert.equal(ttlFromEnv(undefined),ttl);assert.equal(marginFromEnv(undefined,ttl),margin);
  for(const value of ['0','1','1800000','10800000','000001'])assert.equal(marginFromEnv(value,ttl),Number(value));
  for(const value of [undefined,null,0,{},'','-1','10800001','1.0','1e3','0x10','+1',' 1','1 ','1\n','Infinity','9'.repeat(500)])assert.equal(marginFromEnv(value,ttl),margin,String(value));
  for(const effective of [600000,1800000,1800001,6000000]){
    const fallback=effective>margin?margin:0;
    assert.equal(marginFromEnv(String(effective),effective),fallback);
    assert.equal(marginFromEnv(String(effective+1),effective),fallback);
    assert.equal(marginFromEnv(undefined,effective),fallback);
    assert.equal(marginFromEnv('0',effective),0);
    assert.equal(marginFromEnv(String(effective-1),effective),effective-1);
  }
});
test('R21 exact fresh / expiring / expired boundaries and metadata-only timestamps',t=>{
  metadata(t);
  for(const [age,state]of [[0,'fresh'],[ttl-margin-1,'fresh'],[ttl-margin,'expiring'],[ttl-margin+1,'expiring'],[ttl-1,'expiring'],[ttl,'expired'],[ttl+1,'expired'],[-300000,'fresh'],[-300001,'unknown']]){
    const result=loginState({home,now:mtime+age});
    assert.deepEqual(result,{state,mtime,ageMs:age,expiresAt:mtime+ttl,refreshAt:mtime+ttl-margin,ttlMs:ttl});
    assert.ok(Object.isFrozen(result));
  }
  assert.equal(loginState({home,now:mtime+ttl-1,marginMs:0}).state,'fresh');
  assert.equal(loginState({home,now:mtime+ttl,marginMs:0}).state,'expired');
  assert.equal(loginState({home,now:mtime,ttlMs:600000}).refreshAt,mtime+600000);
});
test('R21 missing and unreadable metadata keep refreshAt null',t=>{
  for(const [code,state]of [['ENOENT','missing'],['EPERM','unknown']]){
    t.mock.method(fs,'lstatSync',()=>{throw Object.assign(Error('synthetic'),{code});});
    assert.deepEqual(loginState({home}),{state,mtime:null,ageMs:null,expiresAt:null,refreshAt:null,ttlMs:ttl});
    if(state==='unknown')assert.doesNotThrow(()=>assertFreshForTurn({home}));
  }
});
test('R21 expiring refusal has bare code, status 409 and notStarted; unknown passes',t=>{
  metadata(t);
  for(const age of [ttl-margin,ttl-1])assert.throws(()=>assertFreshForTurn({home,now:mtime+age}),{message:'GROK_LOGIN_EXPIRING',code:'GROK_LOGIN_EXPIRING',status:409,notStarted:true});
  assert.throws(()=>assertFreshForTurn({home,now:mtime+ttl}),{code:'GROK_LOGIN_EXPIRED',status:409,notStarted:true});
  for(const age of [ttl-margin-1,-300001])assert.doesNotThrow(()=>assertFreshForTurn({home,now:mtime+age}));
});
test('R21 fixed diagnostic enum and exact Traditional Chinese message',()=>{
  assert.equal(codeOf({code:'GROK_LOGIN_EXPIRING'}),'GROK_LOGIN_EXPIRING');
  assert.equal(messageFor('GROK_LOGIN_EXPIRING'),message+'（代碼：GROK_LOGIN_EXPIRING）');
});
test('R21 status honors both env values and is deterministic without ageMs',t=>{
  const keys=['PROJECT_HUB_GROK_LOGIN_TTL_MS','PROJECT_HUB_GROK_LOGIN_MARGIN_MS'],saved=keys.map(k=>process.env[k]);
  t.after(()=>keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];}));
  process.env[keys[0]]='6000000';process.env[keys[1]]='600000';
  metadata(t);let now=mtime+5400000;t.mock.method(Date,'now',()=>now);
  const first=status(home);now+=1000;assert.deepEqual(status(home),first);
  assert.deepEqual(first.login,{exactExpiresAt:null,state:'expiring',mtime,expiresAt:mtime+6000000,refreshAt:mtime+5400000,ttlMs:6000000});
  assert.equal(Object.hasOwn(first.login,'ageMs'),false);assert.ok(Object.isFrozen(first.login));
});
test('R21 production gate passes parsed TTL and margin to the metadata gate',async t=>{
  const file=path.join(__dirname,'../server.js'),line=fs.readFileSync(file,'utf8').split('\n').find(l=>l.trimStart().startsWith('grokLoginGate:'));
  const {createGrokTurnGate}=require('../lib/grok-turn-gate');
  metadata(t);t.mock.method(Date,'now',()=>mtime+5400000);
  for(const [ttlValue,marginValue,code]of [['6000000','600000','GROK_LOGIN_EXPIRING'],['600000','600000','GROK_LOGIN_EXPIRED'],[undefined,undefined,null]]){
    const module={},context={module,os:{homedir:()=>home},process:{platform:'win32',env:{PROJECT_HUB_GROK_LOGIN_TTL_MS:ttlValue,PROJECT_HUB_GROK_LOGIN_MARGIN_MS:marginValue}},record:()=>{},require:Object.assign(name=>{assert.equal(name,'./lib/grok-turn-gate');return {createGrokTurnGate};},{main:{}})};
    const gate=vm.runInNewContext('({'+line+'}).grokLoginGate',context);
    if(code)await assert.rejects(gate(),{code,message:code,status:409,notStarted:true});else await gate();
  }
});
