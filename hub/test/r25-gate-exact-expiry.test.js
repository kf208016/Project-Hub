'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGrokTurnGate}=require('../lib/grok-turn-gate');
const now=1800000000000,marginMs=2100000;
function fixture(t,extra={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r25-gate-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'.grok'));const file=path.join(home,'.grok/auth.json');fs.writeFileSync(file,'synthetic');fs.utimesSync(file,now/1000,now/1000);
  const records=[];const gate=createGrokTurnGate({home,env:{},now:()=>now,record:(...r)=>records.push(r),...extra});return {home,file,gate,records};
}
test('exact expiry uses margin and zero boundaries even with fresh mtime',async t=>{
  for(const remaining of [marginMs+1,marginMs,marginMs-1,1,0,-1]){
    const f=fixture(t,{expiry:()=>({expiresAt:now+remaining})});
    if(remaining>=marginMs)await f.gate();else{await assert.rejects(f.gate(),{code:remaining<=0?'GROK_LOGIN_EXPIRED':'GROK_LOGIN_EXPIRING',status:409,notStarted:true});assert.equal(f.records[0][1].basis,'expires_at');}
  }
});
test('refresh must advance exact expiry; stale mtime does not veto renewed exact expiry',async t=>{
  let at=now;const f=fixture(t,{expiry:()=>({expiresAt:at}),autoRefresh:async()=>{at=now+marginMs;return {outcome:'refreshed'};}});
  fs.utimesSync(f.file,0,0);await f.gate();assert.equal(f.records[0][1].basis,'expires_at');assert.equal(f.records[0][1].outcome,'refreshed');
  const g=fixture(t,{expiry:()=>({expiresAt:now}),autoRefresh:async()=>({outcome:'refreshed'})});await assert.rejects(g.gate(),{code:'GROK_LOGIN_AUTO_REFRESH_FAILED'});
});
test('throwing, null, nonnumeric and missing expiry fall back to mtime and preserve missing',async t=>{
  for(const expiry of [()=>{throw Error('private');},()=>({expiresAt:null}),()=>({expiresAt:NaN}),()=>({expiresAt:String(now)}),null]){
    const f=fixture(t,{expiry});await f.gate();fs.utimesSync(f.file,0,0);await assert.rejects(f.gate(),{code:'GROK_LOGIN_EXPIRED'});assert.equal(f.records[0][1].basis,'mtime');
    fs.unlinkSync(f.file);await assert.rejects(f.gate(),{code:'GROK_LOGIN_MISSING'});
  }
});
