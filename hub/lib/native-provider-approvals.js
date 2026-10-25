'use strict';
const {MAX_WALL_MS}=require('./native-turn-limits');
// Owner-route grants only. Nothing here reads credentials or launches a CLI.
const {randomUUID}=require('node:crypto');
const {canonical}=require('./providers/claude-protocol');
const LIMIT=3600000;
const key=s=>JSON.stringify([s.actor,s.project,s.task]);
function dataOnly(x,depth=0,seen=new Set(),budget={left:32768}){
  if(depth>24||--budget.left<0)throw Error('INVALID_SNAPSHOT');
  if(x===null||['string','number','boolean'].includes(typeof x))return;
  if(typeof x!=='object'||seen.has(x)||Object.getOwnPropertySymbols(x).length)throw Error('INVALID_SNAPSHOT');
  const array=Array.isArray(x),proto=Object.getPrototypeOf(x);
  if(array?proto!==Array.prototype:![Object.prototype,null].includes(proto))throw Error('INVALID_SNAPSHOT');
  seen.add(x);const properties=Object.getOwnPropertyDescriptors(x);
  if(array&&Object.keys(properties).length!==x.length+1)throw Error('INVALID_SNAPSHOT');
  for(const [k,d]of Object.entries(properties)){
    if(array&&k==='length')continue;
    if(!Object.hasOwn(d,'value')||!d.enumerable||array&&(!/^(0|[1-9]\d*)$/.test(k)||Number(k)>=x.length))throw Error('INVALID_SNAPSHOT');
    dataOnly(d.value,depth+1,seen,budget);
  }
  seen.delete(x);
}
const clone=x=>{dataOnly(x);return JSON.parse(canonical(x));};
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=(code,request)=>Object.assign(Error('此 CLI 的精確目的地、登入檔與工作區授權尚未通過；未送出提示詞。'),{
  code,status:409,notStarted:true,...(request?{project:request.project,task:request.task,actor:request.actor}:{})
});
const required=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));

function request(raw){
  let r;try{r=clone(raw);}catch{throw fail('NATIVE_APPROVAL_INVALID');}
  if(!required(r,['actor','project','task','model','effort'])||!['claude','grok'].includes(r.actor)||
    ['project','task'].some(k=>typeof r[k]!=='string'||!r[k]||r[k].length>200||/[\x00-\x1f\x7f/\\]/.test(r[k]))||
    ['model','effort'].some(k=>typeof r[k]!=='string'||k==='model'&&!r[k]||r[k].length>256||/[\x00-\x1f\x7f]/.test(r[k])))throw fail('NATIVE_APPROVAL_INVALID');
  return r;
}

class NativeProviderApprovals {
  #describe;#now;#monotonic;#lastWall=0;#lastMono=0;#previews=new Map();#grants=new Map();
  constructor({describe,now=Date.now,monotonic=()=>Number(process.hrtime.bigint()/1000000n)}){
    if(typeof describe!=='function'||typeof now!=='function'||typeof monotonic!=='function')throw fail('NATIVE_APPROVAL_INVALID');
    this.#describe=describe;this.#now=now;this.#monotonic=monotonic;
  }
  #time(){const now=this.#now(),mono=this.#monotonic();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-LIMIT||!Number.isSafeInteger(mono)||mono<0||mono>Number.MAX_SAFE_INTEGER-LIMIT||now<this.#lastWall||mono<this.#lastMono)throw fail('NATIVE_APPROVAL_CLOCK');this.#lastWall=now;this.#lastMono=mono;return now;}
  #prune(){const now=this.#time();for(const map of [this.#previews,this.#grants])for(const [id,row]of map)if(now>=row.expiresAt||this.#lastMono>=row.expiresMono)map.delete(id);return now;}
  async #candidate(r,binding){
    let value;try{value=clone(await this.#describe(Object.freeze({...r}),binding));}catch(error){const code=require('./native-provider-diagnostic').codeOf(error);if(code==='NATIVE_PROVIDER_APPROVAL_REQUIRED')throw error;const rejected=fail(code||'NATIVE_PROFILE_UNAVAILABLE',r);if(code==='NATIVE_CODEX_VERSION_UNREVIEWED'){const version=Object.getOwnPropertyDescriptor(error,'version');rejected.message=require('./native-provider-messages').messageFor(code,version&&Object.hasOwn(version,'value')?version.value:undefined);}throw rejected;}
    if(!required(value,['binding','descriptor','review']))throw fail('NATIVE_PROFILE_UNAVAILABLE',r);
    const b=value.binding,d=value.descriptor;
    if(!b||b.project!==r.project||b.task!==r.task||typeof b.dir!=='string'||!b.dir||!/^[a-f0-9]{64}$/.test(b.rootFingerprint||'')||typeof b.workspaceRun!=='string'||!b.workspaceRun||
      !d||d.scope?.actor!==r.actor||d.scope.project!==r.project||d.scope.task!==r.task||d.scope.rootFingerprint!==b.rootFingerprint||
      !value.review||typeof value.review!=='object'||Array.isArray(value.review))throw fail('NATIVE_PROFILE_UNAVAILABLE',r);
    return value;
  }
  async preview(raw){
    const r=request(raw),now=this.#prune();
    if(this.#previews.size>=64)throw fail('NATIVE_APPROVAL_LIMIT');
    const candidate=await this.#candidate(r),token=randomUUID();
    const row={request:r,candidate,at:now,expiresAt:now+600000,expiresMono:this.#lastMono+600000};this.#previews.set(token,row);
    return {project:r.project,task:r.task,actor:r.actor,model:r.model,effort:r.effort,review:clone(candidate.review),token,expiresAt:row.expiresAt};
  }
  async approve(raw){
    let input;try{input=clone(raw);}catch{throw fail('NATIVE_APPROVAL_INVALID');}
    if(!required(input,['token','confirm','ackAuthenticationRead','ackCommandAccess','ackDestination','ackSessionWrite'])||
      typeof input.token!=='string'||['confirm','ackAuthenticationRead','ackCommandAccess','ackDestination','ackSessionWrite'].some(k=>input[k]!==true))throw fail('NATIVE_APPROVAL_INVALID');
    const now=this.#prune(),row=this.#previews.get(input.token);this.#previews.delete(input.token);
    if(!row)throw fail('NATIVE_APPROVAL_EXPIRED');
    const current=await this.#candidate(row.request);
    if(!equal(current,row.candidate))throw fail('NATIVE_APPROVAL_CHANGED',row.request);
    const at=this.#time();if(at<now||at>=row.expiresAt||this.#lastMono>=row.expiresMono)throw fail('NATIVE_APPROVAL_EXPIRED',row.request);
    if(this.#grants.size>=128&&!this.#grants.has(key(row.request)))throw fail('NATIVE_APPROVAL_LIMIT');
    const grant={request:row.request,candidate:current,at,expiresAt:at+LIMIT,expiresMono:this.#lastMono+LIMIT,id:randomUUID()};
    this.#grants.set(key(row.request),grant);
    return {ok:true,grantId:grant.id,actor:row.request.actor,project:row.request.project,task:row.request.task,expiresAt:grant.expiresAt};
  }
  async authorize(raw,binding){
    const r=request({actor:raw.actor,project:raw.project,task:raw.task,model:raw.model,effort:raw.effort});
    this.#prune();const grant=this.#grants.get(key(r));
    if(!grant||!equal(r,grant.request))throw fail('NATIVE_PROVIDER_APPROVAL_REQUIRED',r);
    const current=await this.#candidate(r,binding);this.#prune();
    if(this.#lastWall>=grant.expiresAt||this.#lastMono>=grant.expiresMono){this.#grants.delete(key(r));throw fail('NATIVE_PROVIDER_APPROVAL_REQUIRED',r);}
    if(this.#grants.get(key(r))!==grant||!equal(current.descriptor,grant.candidate.descriptor)||!equal(current.review,grant.candidate.review)||
      !equal(current.binding,binding)||current.binding.dir!==grant.candidate.binding.dir||current.binding.rootFingerprint!==grant.candidate.binding.rootFingerprint)throw fail('NATIVE_APPROVAL_CHANGED',r);
    const descriptor=clone(current.descriptor),remaining=Math.min(grant.expiresAt-this.#lastWall,grant.expiresMono-this.#lastMono);
    const requested=Math.max(descriptor.maxWallMs??descriptor.launchOptions?.maxWallMs??MAX_WALL_MS,descriptor.launchOptions?.maxWallMs??0);
    if(remaining<requested){this.#grants.delete(key(r));throw fail('NATIVE_PROVIDER_APPROVAL_REQUIRED',r);}
    return descriptor;
  }
  revoke(raw){const r=clone(raw);if(!required(r,['actor','project','task']))throw fail('NATIVE_APPROVAL_INVALID');request({...r,model:'_',effort:''});return this.#grants.delete(key(r));}
  active(){this.#prune();return this.#grants.size;}
}
module.exports={NativeProviderApprovals};
