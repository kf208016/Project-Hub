'use strict';
// Public status exposes metadata and exact expiry only; owner token contents never leave this process.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {loginState,ttlFromEnv,marginFromEnv}=require('./grok-login');
const {expiryOf}=require('./grok-owner-token');
const {reviewed,PREFERRED}=require('./grok-versions');
function metadata(file){
  try{const st=fs.lstatSync(file);if(st.isFile())return {present:true,bytes:Number.isSafeInteger(st.size)?st.size:null,mtime:new Date(st.mtime).toISOString()};}catch{}
  return {present:false,bytes:null,mtime:null};
}
function status(home=process.env.HUB_AI_HOME||os.homedir(),{version=process.env.PROJECT_HUB_GROK_VERSION}={}){
  const override=typeof version==='string'&&version.length?version.slice(0,64):null,overrideInvalid=override!==null&&!reviewed(override);
  const selected=override!==null&&!overrideInvalid?override:PREFERRED[0],hash=reviewed(selected).binaryHash;
  let auth={present:false,bytes:null,mtime:null},lock={present:false,mtime:null},slotPresent=false;
  try{
    if(typeof home==='string'&&path.isAbsolute(home)){
      auth=metadata(path.join(home,'.grok','auth.json'));lock=metadata(path.join(home,'.grok','auth.json.lock'));
      slotPresent=metadata(path.join(home,'AppData','Local','ProjectHub','runtime-binaries','grok',hash,'grok.exe')).present;
    }
  }catch{}
  const ttlMs=ttlFromEnv(process.env.PROJECT_HUB_GROK_LOGIN_TTL_MS),marginMs=marginFromEnv(process.env.PROJECT_HUB_GROK_LOGIN_MARGIN_MS,ttlMs);
  const login=loginState({home,ttlMs,marginMs});
  const exactExpiresAt=typeof home==='string'&&path.isAbsolute(home)?expiryOf({home}).expiresAt:null;
  return Object.freeze({login:Object.freeze({exactExpiresAt,state:login.state,mtime:login.mtime,expiresAt:login.expiresAt,refreshAt:login.refreshAt,ttlMs:login.ttlMs}),auth:Object.freeze({...auth,lockPresent:lock.present,lockMtime:lock.mtime}),runtime:Object.freeze({version:selected,hashPrefix:hash.slice(0,12),slotPresent,override,overrideInvalid})});
}
module.exports={status};
