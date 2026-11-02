'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGrokTurnGate}=require('../lib/grok-turn-gate');
const stamp=1800000000000,ttl=21300000,margin=2100000;
const error=code=>({code,message:code,status:409,notStarted:true});
function fixture(t,{kind='expired',refresh,env={},cooldownMs=600000}={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r24-gate-')),file=path.join(home,'.grok','auth.json');fs.mkdirSync(path.dirname(file));
  let time=stamp,calls=0;const records=[];
  const touch=mtime=>fs.utimesSync(file,mtime/1000,mtime/1000);
  if(kind!=='missing'){fs.writeFileSync(file,'synthetic');touch(kind==='fresh'?time:kind==='unknown'?time+301000:time-ttl+(kind==='expiring'?1000:0));}
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  const f={home,file,records,touch,advance:ms=>{time+=ms;},now:()=>time,calls:()=>calls};
  f.gate=createGrokTurnGate({home,env,now:()=>time,record:(...args)=>records.push(args),cooldownMs,autoRefresh:refresh===null?null:async()=>{calls++;return refresh?refresh(f):{outcome:'unchanged',timedOut:false};}});
  return f;
}

test('R24 refreshed with future unknown metadata refuses, records actual outcome and arms cooldown',async t=>{
  const f=fixture(t,{refresh:f=>{f.touch(f.now()+600000);return {outcome:'refreshed',timedOut:false};}});
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.equal(f.records.at(-1)[1].outcome,'refreshed');assert.equal(f.records.at(-1)[1].timedOut,false);
  // Pre-check intentionally admits unknown. Restore expired metadata to exercise cooldown.
  f.touch(f.now()-ttl);await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.equal(f.calls(),1);assert.equal(f.records.at(-1)[1].skipped,'cooldown');
});
for(const outcome of ['failed','refreshed'])test('R24 '+outcome+' and timedOut still refuse fresh mtime',async t=>{
  const f=fixture(t,{refresh:f=>{f.touch(f.now());return {outcome,timedOut:true};}});
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.equal(f.calls(),1);assert.equal(f.records.at(-1)[1].outcome,outcome);assert.equal(f.records.at(-1)[1].timedOut,true);
});
test('R24 unchanged yields distinct 409, cooldown, and manual fresh login bypasses refresh',async t=>{
  const f=fixture(t);await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_UNCHANGED'));
  assert.equal(f.records.at(-1)[1].outcome,'unchanged');
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.equal(f.records.at(-1)[1].skipped,'cooldown');assert.equal(f.calls(),1);
  f.touch(f.now());await f.gate();assert.equal(f.calls(),1);
});
test('R24 confirmed refresh with fresh metadata passes and clears cooldown',async t=>{
  const f=fixture(t,{refresh:f=>{f.touch(f.now());return {outcome:'refreshed',timedOut:false};}});
  await f.gate();f.touch(f.now()-ttl);await f.gate();assert.equal(f.calls(),2);
  assert.equal(f.records.at(-1)[1].outcome,'refreshed');assert.equal(f.records.at(-1)[1].skipped,null);
});
for(const outcome of ['unchanged','failed','invalid'])test('R24 '+outcome+' refuses even when metadata is fresh',async t=>{
  const f=fixture(t,{refresh:f=>{f.touch(f.now());return {outcome,timedOut:false};}});
  await assert.rejects(f.gate(),error(outcome==='unchanged'?'GROK_LOGIN_AUTO_REFRESH_UNCHANGED':'GROK_LOGIN_AUTO_REFRESH_FAILED'));
});
