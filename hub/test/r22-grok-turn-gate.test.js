'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGrokTurnGate}=require('../lib/grok-turn-gate');
const stamp=1800000000000,ttl=21300000,margin=2100000;
const error=code=>({code,message:code,status:409,notStarted:true});
function fixture(t,{kind='expired',refresh,env={},cooldownMs=600000}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r22-gate-')),file=path.join(home,'.grok','auth.json');fs.mkdirSync(path.dirname(file));
  let time=stamp,calls=0;const records=[];
  const touch=mtime=>fs.utimesSync(file,mtime/1000,mtime/1000);
  if(kind!=='missing'){fs.writeFileSync(file,'synthetic');touch(kind==='fresh'?time:kind==='unknown'?time+301000:time-ttl+(kind==='expiring'?1000:0));}
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  const f={home,file,records,touch,advance:ms=>{time+=ms;},now:()=>time,calls:()=>calls};
  f.gate=createGrokTurnGate({home,env,now:()=>time,record:(...args)=>records.push(args),cooldownMs,autoRefresh:refresh===null?null:async()=>{calls++;return refresh?refresh(f):{outcome:'unchanged',timedOut:false};}});
  return f;
}
for(const kind of ['fresh','unknown'])test('R22 '+kind+' bypasses automatic refresh and records',async t=>{
  const f=fixture(t,{kind});await f.gate();assert.equal(f.calls(),0);assert.deepEqual(f.records,[]);
});
test('R22 missing login keeps original notStarted 409 without refresh',async t=>{
  const f=fixture(t,{kind:'missing'});await assert.rejects(f.gate(),error('GROK_LOGIN_MISSING'));assert.equal(f.calls(),0);assert.deepEqual(f.records,[]);
});
for(const kind of ['expiring','expired'])test('R22 '+kind+' silently refreshed then permits turn and records duration',async t=>{
  const f=fixture(t,{kind,refresh:f=>{f.advance(2000);f.touch(f.now());return {outcome:'refreshed',timedOut:false};}});
  await f.gate();assert.equal(f.calls(),1);assert.deepEqual(f.records,[['grok-login-auto-refresh',{from:kind,outcome:'refreshed',timedOut:false,skipped:null,durationMs:2000,basis:'mtime'}]]);
});
for(const outcome of ['unchanged','failed','refreshed','throws'])test('R22 stale metadata after '+outcome+' fails closed with exact fields',async t=>{
  const f=fixture(t,{refresh:()=>{if(outcome==='throws')throw Error('private path/token');return {outcome,timedOut:outcome==='failed'};}});
  await assert.rejects(f.gate(),error(outcome==='unchanged'?'GROK_LOGIN_AUTO_REFRESH_UNCHANGED':'GROK_LOGIN_AUTO_REFRESH_FAILED'));assert.equal(f.calls(),1);
  assert.deepEqual(f.records,[['grok-login-auto-refresh',{from:'expired',outcome:outcome==='throws'?'failed':outcome,timedOut:outcome==='failed',skipped:null,durationMs:0,basis:'mtime'}]]);
});
test('R22 cooldown blocks attempts before boundary, retries at boundary, and success clears it',async t=>{
  let succeed=false;const f=fixture(t,{cooldownMs:1000,refresh:f=>{if(succeed)f.touch(f.now());return {outcome:succeed?'refreshed':'failed',timedOut:false};}});
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));f.advance(999);
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));assert.equal(f.calls(),1);assert.equal(f.records.at(-1)[1].skipped,'cooldown');
  f.advance(1);succeed=true;await f.gate();assert.equal(f.calls(),2);
  f.touch(f.now()-ttl);await f.gate();assert.equal(f.calls(),3,'success must remove the cooldown');
});
test('R22 default cooldown is ten minutes, and failed retry resets its deadline',async t=>{
  const f=fixture(t);await assert.rejects(f.gate());f.advance(599999);await assert.rejects(f.gate());assert.equal(f.calls(),1);
  f.advance(1);await assert.rejects(f.gate());assert.equal(f.calls(),2);f.advance(599999);await assert.rejects(f.gate());assert.equal(f.calls(),2);
});
for(const kind of ['expiring','expired'])for(const skipped of ['disabled','turn-active','busy'])test('R22 '+kind+' rethrows original when '+skipped,async t=>{
  const f=fixture(t,{kind,refresh:skipped==='disabled'?null:()=>({outcome:'busy',timedOut:false})});
  await assert.rejects(f.gate({otherGrokTurns:skipped==='turn-active'?1:0}),error('GROK_LOGIN_'+kind.toUpperCase()));
  assert.equal(f.calls(),skipped==='busy'?1:0);
  assert.deepEqual(f.records,[['grok-login-auto-refresh',{from:kind,outcome:skipped==='busy'?'busy':null,timedOut:false,skipped,durationMs:0,basis:'mtime'}]]);
  if(skipped==='busy'){await assert.rejects(f.gate(),error('GROK_LOGIN_'+kind.toUpperCase()));assert.equal(f.calls(),2,'busy must not start cooldown');}
});
test('R22 active turn takes precedence over cooldown; fresh login always passes',async t=>{
  const f=fixture(t);await assert.rejects(f.gate());await assert.rejects(f.gate({otherGrokTurns:2}),error('GROK_LOGIN_EXPIRED'));
  assert.equal(f.records.at(-1)[1].skipped,'turn-active');f.touch(f.now());await f.gate();assert.equal(f.calls(),1);
});
test('R22 second assertion uses a new clock and notices disappearance during refresh',async t=>{
  const f=fixture(t,{refresh:f=>{f.touch(f.now());f.advance(ttl);return {outcome:'refreshed'};}});await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  const g=fixture(t,{refresh:f=>{fs.unlinkSync(f.file);return {outcome:'refreshed'};}});await assert.rejects(g.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
});
test('R22 TTL and margin are parsed once at creation; records never contain paths or credential data',async t=>{
  const env={PROJECT_HUB_GROK_LOGIN_TTL_MS:'6000000',PROJECT_HUB_GROK_LOGIN_MARGIN_MS:'600000'};
  const f=fixture(t,{env,refresh:f=>{f.touch(f.now());return {outcome:'refreshed',timedOut:false};}});env.PROJECT_HUB_GROK_LOGIN_TTL_MS='86400000';
  f.touch(f.now()-5400000);await f.gate();assert.equal(f.calls(),1);assert.equal(f.records[0][1].from,'expiring');
  assert.doesNotMatch(JSON.stringify(f.records),/auth\.json|USERPROFILE|synthetic|[A-Za-z]:\\/);
});
test('R22 record exceptions do not change bounded errors or successful checks',async t=>{
  const f=fixture(t),gate=createGrokTurnGate({home:f.home,env:{},now:f.now,autoRefresh:async()=>({outcome:'failed'}),record:()=>{throw Error('private');}});
  await assert.rejects(gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));f.touch(f.now());await gate();
});
