'use strict';
// This registry describes implemented transports, not an attestation that a
// user's executable, account or model is installed/verified. Controllers still
// validate the exact runtime identity, model and once-only run permit.
const CLI_CAPABILITIES = Object.freeze(['spawn','chat','terminal','delegate','queue','resume','stop','transcript','models','usage','update','mcp']);
const WEB_CAPABILITIES = Object.freeze(['preview','confirm','result']);
const entries = [
  {id:'codex',provider:'openai',kind:'cli',transport:'native-codex',ownerKey:'codex',label:'Codex',url:null,isolationProfile:'native-codex'},
  {id:'claude',provider:'anthropic',kind:'cli',transport:'provider-adapter',ownerKey:'claude-code',label:'Claude Code',url:null,isolationProfile:'provider-worker'},
  {id:'agy',provider:'google',kind:'cli',transport:'provider-adapter',ownerKey:'agy',label:'Agy CLI',url:null,isolationProfile:'provider-worker'},
  {id:'grok',provider:'xai',kind:'cli',transport:'provider-adapter',ownerKey:'grok',label:'Grok CLI',url:null,isolationProfile:'provider-worker'},
  {id:'chatgpt',provider:'openai',kind:'external-chat',transport:'web-manual',ownerKey:'chatgpt',label:'ChatGPT',url:'https://chatgpt.com/',isolationProfile:'manual-web'},
  {id:'claude-chat',provider:'anthropic',kind:'external-chat',transport:'web-manual',ownerKey:'claude-chat',label:'Claude Chat',url:'https://claude.ai/',isolationProfile:'manual-web'},
].map(row=>Object.freeze({...row,capabilities:row.kind==='cli'?CLI_CAPABILITIES:WEB_CAPABILITIES}));
const byId=new Map(entries.map(row=>[row.id,row]));
const actorIds=Object.freeze(entries.map(row=>row.id));
const ownerKeys=Object.freeze(entries.map(row=>row.ownerKey));
const cliIds=Object.freeze(entries.filter(row=>row.kind==='cli').map(row=>row.id));
const webIds=Object.freeze(entries.filter(row=>row.kind==='external-chat').map(row=>row.id));
// Reference authority belongs to this controller process. A serialized request,
// constructor handler or worker's separate require() cannot forge this entry.
const nativeAuthorities=new WeakMap();
function createNativeAuthority(value,capabilities,check){
  const actor=cliActor(value);
  if(!['claude','grok'].includes(actor.id)||typeof check!=='function'||!Array.isArray(capabilities)||!capabilities.length||
    new Set(capabilities).size!==capabilities.length||capabilities.some(c=>!CLI_CAPABILITIES.includes(c)))throw rejected('INVALID_NATIVE_AUTHORITY',400,'原生控制端能力設定無效');
  const ref=Object.freeze(Object.create(null));nativeAuthorities.set(ref,{actor:actor.id,capabilities:Object.freeze([...capabilities]),check});return ref;
}
function nativeAuthority(actor,options){
  const ref=options?.nativeAuthority||options?.nativeAuthorities?.[actor.id];
  const record=ref&&typeof ref==='object'?nativeAuthorities.get(ref):null;
  if(!record||record.actor!==actor.id)return null;
  try{return record.check()===true?record:null;}catch{return null;}
}
function rejected(code,status,message){return Object.assign(Error(message),{code,status,notStarted:true});}
function resolveActor(value){
  if(typeof value!=='string')throw rejected('UNKNOWN_ACTOR',400,'AI 入口格式無效');
  const id=value==='claude-code'?'claude':value,row=byId.get(id);
  if(!row)throw rejected('UNKNOWN_ACTOR',400,'未知 AI 入口；未改用其他服務');
  return row;
}
function isActor(value){try{resolveActor(value);return true;}catch{return false;}}
function cliActor(value){const row=resolveActor(value);if(row.kind!=='cli')throw rejected('CLI_ACTOR_REQUIRED',400,'此網頁 Chat 入口不能啟動 CLI');return row;}
function webActor(value){const row=resolveActor(value);if(row.kind!=='external-chat')throw rejected('WEB_ACTOR_REQUIRED',400,'此入口不是人工網頁 Chat');return row;}
function status(value,options={}){
  const {platform=process.platform}=options;
  const actor=resolveActor(value);
  if(typeof platform!=='string'||!platform)throw rejected('INVALID_PLATFORM',400,'執行平台格式無效');
  const ready=actor.kind==='external-chat'||actor.id==='codex'||platform!=='win32'&&actor.id!=='grok'||platform==='win32'&&Boolean(nativeAuthority(actor,options));
  return Object.freeze({ready,state:ready?'ready':'blocked',reasonCode:ready?'':actor.id==='grok'?'PROVIDER_ADAPTER_UNVERIFIED':'WINDOWS_PROVIDER_ISOLATION_UNVERIFIED',runtimeVerificationRequired:actor.kind==='cli'});
}
function supports(value,capability){const actor=resolveActor(value);return typeof capability==='string'&&actor.capabilities.includes(capability);}
function assertCapability(value,capability,options){
  const actor=resolveActor(value);
  if(!supports(actor.id,capability))throw rejected('ACTOR_CAPABILITY_UNAVAILABLE',409,'此 AI 入口不支援要求的操作');
  const readiness=status(actor.id,options);
  if(!readiness.ready)throw rejected(readiness.reasonCode,409,'此 CLI 的執行與隔離尚未驗證，未啟動');
  const admitted=nativeAuthority(actor,options);
  if((options?.platform||process.platform)==='win32'&&admitted&&!admitted.capabilities.includes(capability))throw rejected('ACTOR_CAPABILITY_UNAVAILABLE',409,'此原生入口尚未接入要求的操作');
  return actor;
}
function list(options){return entries.map(actor=>Object.freeze({...actor,readiness:status(actor.id,options)}));}
// Explicit runtime validator for this exact version's public snapshot. This is
// intentionally not a general JSON Schema engine.
function validateSnapshot(rows,options){
  if(!Array.isArray(rows)||rows.length!==entries.length)throw rejected('INVALID_REGISTRY',400,'AI 入口目錄格式無效');
  const expected=new Map(list(options).map(row=>[row.id,row])),seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||!expected.has(row.id)||seen.has(row.id))throw rejected('INVALID_REGISTRY',400,'AI 入口目錄格式無效');
    seen.add(row.id);const target=expected.get(row.id),keys=Object.keys(target);
    if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw rejected('INVALID_REGISTRY',400,'AI 入口目錄欄位無效');
    for(const key of keys){
      const value=row[key],required=target[key];
      const matches=key==='capabilities'?Array.isArray(value)&&value.length===required.length&&required.every((item,index)=>value[index]===item):key==='readiness'?value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===Object.keys(required).length&&Object.keys(required).every(name=>Object.hasOwn(value,name)&&value[name]===required[name]):value===required;
      if(!matches)throw rejected('INVALID_REGISTRY',400,'AI 入口目錄內容無效');
    }
  }
  return true;
}
module.exports={resolveActor,resolve:resolveActor,isActor,cliActor,webActor,status,supports,assertCapability,list,validateSnapshot,createNativeAuthority,actorIds,ownerKeys,cliIds,webIds,CLI_CAPABILITIES,WEB_CAPABILITIES};
