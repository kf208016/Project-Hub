'use strict';
// Credential contents are never inspected: this is only an expiry estimate.
const fs=require('node:fs'),path=require('node:path');
const {MAX_WALL_MS}=require('./native-turn-limits');
// Margin covers the longest turn plus five minutes for preparation and mtime lag.
const DEFAULT_TTL_MS=21300000,DEFAULT_MARGIN_MS=MAX_WALL_MS+300000;
function ttlFromEnv(value){
  if(typeof value!=='string'||!/^\d+$/.test(value))return DEFAULT_TTL_MS;
  const n=Number(value);return Number.isSafeInteger(n)&&n>=600000&&n<=86400000?n:DEFAULT_TTL_MS;
}
function marginFromEnv(value,ttlMs){
  const fallback=DEFAULT_MARGIN_MS<ttlMs?DEFAULT_MARGIN_MS:0;
  if(typeof value!=='string'||!/^\d+$/.test(value))return fallback;
  const n=Number(value);return Number.isSafeInteger(n)&&n>=0&&n<=10800000&&n<ttlMs?n:fallback;
}
function loginState({home,now=Date.now(),ttlMs=DEFAULT_TTL_MS,marginMs=marginFromEnv(undefined,ttlMs)}){
  let mtime=null,ageMs=null,expiresAt=null,refreshAt=null,state='unknown';
  try{
    const st=fs.lstatSync(path.join(home,'.grok','auth.json'));
    if(st.isFile()&&!st.isSymbolicLink()&&Number.isFinite(st.mtimeMs)){
      mtime=st.mtimeMs;ageMs=now-mtime;expiresAt=mtime+ttlMs;refreshAt=expiresAt-marginMs;
      state=ageMs < -300000?'unknown':ageMs>=ttlMs?'expired':ageMs>=ttlMs-marginMs?'expiring':'fresh';
    }
  }catch(error){if(error.code==='ENOENT')state='missing';}
  return Object.freeze({state,mtime,ageMs,expiresAt,refreshAt,ttlMs});
}
function assertFreshForTurn(options){
  const login=loginState(options);
  if(['missing','expired','expiring'].includes(login.state)){
    const code='GROK_LOGIN_'+login.state.toUpperCase();
    throw Object.assign(Error(code),{code,status:409,notStarted:true});
  }
}
module.exports={loginState,ttlFromEnv,marginFromEnv,assertFreshForTurn};
