'use strict';
const {assertFreshForTurn,loginState,ttlFromEnv,marginFromEnv}=require('./grok-login');
const failed=outcome=>{const code=outcome==='unchanged'?'GROK_LOGIN_AUTO_REFRESH_UNCHANGED':'GROK_LOGIN_AUTO_REFRESH_FAILED';return Object.assign(Error(code),{code,status:409,notStarted:true});};
function createGrokTurnGate({home,env,now=Date.now,autoRefresh=null,record=()=>{},cooldownMs=600000,expiry=null}){
  const ttlMs=ttlFromEnv(env.PROJECT_HUB_GROK_LOGIN_TTL_MS),marginMs=marginFromEnv(env.PROJECT_HUB_GROK_LOGIN_MARGIN_MS,ttlMs);
  const state=()=>{
    let exact;try{if(typeof expiry==='function')exact=expiry();}catch{}
    if(Number.isFinite(exact?.expiresAt)){
      const remaining=exact.expiresAt-now();
      return {state:remaining<=0?'expired':remaining<marginMs?'expiring':'fresh',basis:'expires_at'};
    }
    return {...loginState({home,now:now(),ttlMs,marginMs}),basis:'mtime'};
  };
  const check=login=>{
    if(login.basis==='mtime')return assertFreshForTurn({home,now:now(),ttlMs,marginMs});
    if(['expired','expiring'].includes(login.state)){
      const code='GROK_LOGIN_'+login.state.toUpperCase();throw Object.assign(Error(code),{code,status:409,notStarted:true});
    }
  };
  let retryAt=null;
  return async function gate({otherGrokTurns=0}={}){
    let original;const before=state();
    try{check(before);return;}catch(error){
      if(!['GROK_LOGIN_EXPIRING','GROK_LOGIN_EXPIRED'].includes(error.code))throw error;
      original=error;
    }
    const from=original.code==='GROK_LOGIN_EXPIRING'?'expiring':'expired',startedAt=now();
    const log=(outcome,timedOut,skipped)=>{
      try{record('grok-login-auto-refresh',{from,outcome,timedOut,skipped,durationMs:Math.max(0,now()-startedAt),basis:before.basis});}catch{/* Diagnostic failures must not change the gate decision. */}
    };
    if(autoRefresh===null){log(null,false,'disabled');throw original;}
    if(otherGrokTurns>0){log(null,false,'turn-active');throw original;}
    if(retryAt!==null&&now()<retryAt){log(null,false,'cooldown');throw failed('failed');}
    let result;
    try{result=await autoRefresh();}
    catch{retryAt=now()+cooldownMs;log('failed',false,null);throw failed('failed');}
    if(result?.outcome==='busy'){log('busy',false,'busy');throw original;}
    const outcome=['refreshed','unchanged','failed'].includes(result?.outcome)?result.outcome:'failed',timedOut=result?.timedOut===true;
    // Only a confirmed refresh with explicitly fresh metadata admits the turn.
    const fresh=outcome==='refreshed'&&!timedOut&&state().state==='fresh';
    if(!fresh){retryAt=now()+cooldownMs;log(outcome,timedOut,null);throw failed(outcome);}
    retryAt=null;log(outcome,timedOut,null);
  };
}
module.exports={createGrokTurnGate};
