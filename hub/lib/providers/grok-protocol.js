'use strict';
// Source-derived, closed ACP turn subset. No transport, process, auth or IO.
const {createHash}=require('node:crypto');
const {decode:strictDecode,canonical}=require('./claude-protocol');
const SOURCE=Object.freeze({repository:'xai-org/grok-build',revision:'2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8',monorepoRevision:'559751fdcec02d413e4c57c8832ab275e4f44980',acpSchemaVersion:'0.11.4',acpSchemaSHA256:'ca68e7e55681ce56546c0cecc6bc8f20493d24b44c6d93ec46174f310730bba2',binaryVersionVerified:false,liveProtocolVerified:false});
const LIMITS=Object.freeze({maxFrameBytes:262144,maxRunBytes:8388608,maxFrames:4096,maxPending:16,maxStringBytes:131072,maxOutputBytes:2097152,maxDepth:16,maxNodes:16384,maxEventsPerPush:256,permissionTtlMs:600000});
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH=/^[a-f0-9]{64}$/;
const KINDS=['read','edit','delete','move','search','execute','think','fetch','switch_mode','other'];
const STATUSES=['pending','in_progress','completed','failed'];
const STOPS=['end_turn','max_tokens','max_turn_requests','refusal','cancelled'];
const OPTION_KINDS=['allow_once','allow_always','reject_once','reject_always'];
const ONCE=Object.freeze({'allow-once':'allow_once','reject-once':'reject_once'});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const rejected=code=>Object.assign(Error(code),{code});
function check(value,code='GROK_PROTOCOL_INVALID'){if(!value)throw rejected(code);}
function keys(value,required,optional=[]){check(plain(value));check(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
function text(value,{id=false,empty=true}={}){check(typeof value==='string'&&value.isWellFormed()&&!value.includes('\0')&&(empty||value.length>0));if(id)check(ID.test(value));}
const integer=x=>Number.isSafeInteger(x)&&x>=0;
function rpcId(value){check(typeof value==='string'?ID.test(value):integer(value),'GROK_REQUEST_ID_INVALID');}
const idKey=id=>typeof id+':'+id;
const copy=value=>JSON.parse(JSON.stringify(value));
const digest=(value,limits)=>createHash('sha256').update(canonical(value,limits)).digest('hex');
function metadata(value){if(value!==undefined)check(plain(value),'GROK_METADATA_INVALID');}
function decode(bytes,limits=LIMITS){try{return strictDecode(bytes,limits);}catch(error){throw rejected(typeof error?.code==='string'&&error.code.startsWith('CLAUDE_')?'GROK_'+error.code.slice(7):'GROK_PROTOCOL_INVALID');}}

function createProtocol(options){
  keys(options,['sessionId','runId','promptRequestId','ownerAuthority'],['now','monotonic','limits']);
  const {sessionId,runId,promptRequestId,ownerAuthority}=options;
  text(sessionId,{id:true});text(runId,{id:true});rpcId(promptRequestId);
  check(ownerAuthority!==null&&typeof ownerAuthority==='object','GROK_OPTIONS_INVALID');
  const limits={...LIMITS};
  if(options.limits!==undefined){keys(options.limits,[],Object.keys(LIMITS));for(const [key,value]of Object.entries(options.limits)){check(integer(value)&&value>=1&&value<=LIMITS[key],'GROK_OPTIONS_INVALID');limits[key]=value;}}
  const now=options.now===undefined?Date.now:options.now,monotonic=options.monotonic===undefined?(()=>Number(process.hrtime.bigint()/1000000n)):options.monotonic;
  check(typeof now==='function'&&typeof monotonic==='function','GROK_OPTIONS_INVALID');
  let phase='active',failure=null,buffer=Buffer.alloc(0),bytes=0,frames=0,outputBytes=0,lastClock=null,terminal=null,permissionDenied=false,cancelled=false,toolFailureObserved=false;
  const pending=new Map(),requestIds=new Set(),tools=new Map();
  function fail(code){if(!failure){failure=rejected(code);phase='failed';pending.clear();buffer=Buffer.alloc(0);terminal=null;}throw failure;}
  function guarded(fn){if(failure)throw failure;try{return fn();}catch(error){return fail(typeof error?.code==='string'&&/^GROK_[A-Z0-9_]+$/.test(error.code)?error.code:typeof error?.code==='string'&&/^CLAUDE_[A-Z0-9_]+$/.test(error.code)?'GROK_'+error.code.slice(7):'GROK_PROTOCOL_INVALID');}}
  function clock(){let wall,mono;try{wall=now();mono=monotonic();}catch{return fail('GROK_CLOCK_INVALID');}check(integer(wall)&&integer(mono)&&wall<=Number.MAX_SAFE_INTEGER-limits.permissionTtlMs&&mono<=Number.MAX_SAFE_INTEGER-limits.permissionTtlMs&&(!lastClock||wall>=lastClock.wall&&mono>=lastClock.mono),'GROK_CLOCK_INVALID');lastClock={wall,mono};return lastClock;}
  function tick(){return guarded(()=>{const time=clock();for(const p of pending.values())check(time.wall<p.expiresAt&&time.mono<p.expiresMono,'GROK_PERMISSION_EXPIRED');return {phase,pending:pending.size};});}
  function active(){check(phase==='active','GROK_STATE_INVALID');}
  function scope(value){check(value===sessionId,'GROK_SESSION_MISMATCH');}
  function authority(value){check(value===ownerAuthority,'GROK_OWNER_REQUIRED');}
  function boundedText(value,opts){text(value,opts);check(Buffer.byteLength(value)<=limits.maxStringBytes,'GROK_STRING_SIZE');}
  function accountText(value){boundedText(value);outputBytes+=Buffer.byteLength(value);check(outputBytes<=limits.maxOutputBytes,'GROK_OUTPUT_SIZE');}
  function wire(value){const encoded=Buffer.from(canonical(value,limits)+'\n');check(encoded.length<=limits.maxFrameBytes,'GROK_FRAME_SIZE');return encoded;}
  function toolIdentity(value){const {status,rawOutput,...identity}=value;return identity;}
  function toolFields(value,{initial=false,permission=false}={}){
    keys(value,initial?['toolCallId','title']:['toolCallId'],['title','kind','status','content','locations','rawInput','rawOutput','_meta']);
    boundedText(value.toolCallId,{id:true});if(value.title!==undefined)boundedText(value.title,{empty:false});
    if(value.kind!==undefined)check(KINDS.includes(value.kind));if(value.status!==undefined)check(STATUSES.includes(value.status));metadata(value._meta);
    // This turn subset handles descriptive tool state, not rendered tool output,
    // locations, client terminals or embedded resources.
    for(const key of ['content','locations'])if(value[key]!==undefined)check(Array.isArray(value[key])&&value[key].length===0,'GROK_TOOL_CONTENT_UNSUPPORTED');
    const old=tools.get(value.toolCallId);
    if(initial)check(!old,'GROK_TOOL_REPLAY');
    if(!initial&&!permission)check(old,'GROK_TOOL_UNKNOWN');
    const next={...(old?.value||{}),...copy(value)};
    if(next.rawInput!==undefined)check(plain(next.rawInput),'GROK_TOOL_INPUT_INVALID');
    const inputHash=next.rawInput===undefined?null:digest(next.rawInput,limits);
    if(old?.inputHash!==null&&old?.inputHash!==undefined&&inputHash!==old.inputHash)throw rejected('GROK_TOOL_INPUT_CHANGED');
    const status=next.status||'pending';
    if(old&&['completed','failed'].includes(old.status))check(status===old.status,'GROK_TOOL_STATE_INVALID');
    if(old?.status==='in_progress')check(status!=='pending','GROK_TOOL_STATE_INVALID');
    if(old?.pendingRequest)check(permission||canonical(next,limits)===canonical(old.value,limits),'GROK_PERMISSION_STATE_CONFLICT');
    if(old?.requested&&!old.pendingRequest)check(canonical(toolIdentity(next),limits)===canonical(toolIdentity(old.value),limits),'GROK_PERMISSION_IDENTITY_CHANGED');
    if(permission){check(!old?.requested,'GROK_TOOL_REPLAY');check(typeof next.title==='string'&&next.title.length>0&&plain(next.rawInput),'GROK_PERMISSION_INPUT_REQUIRED');check(status==='pending','GROK_PERMISSION_STATE_CONFLICT');}
    const binding={...old,value:next,inputHash,status,requested:old?.requested||false,pendingRequest:old?.pendingRequest||null};
    if(status==='failed')toolFailureObserved=true;
    tools.set(value.toolCallId,binding);return binding;
  }
  function publicPending(p){return {sessionId,runId,promptRequestId,requestId:p.requestId,toolCallId:p.toolCallId,toolCall:copy(p.toolCall),options:copy(p.options),inputSHA256:p.inputSHA256,requestSHA256:p.requestSHA256,expiresAt:p.expiresAt};}
  function permission(value){
    active();keys(value,['jsonrpc','id','method','params']);rpcId(value.id);const key=idKey(value.id);
    check(key!==idKey(promptRequestId)&&!requestIds.has(key),'GROK_REQUEST_REPLAY');check(pending.size<limits.maxPending,'GROK_PENDING_SIZE');
    const p=value.params;keys(p,['sessionId','toolCall','options'],['_meta']);scope(p.sessionId);metadata(p._meta);
    check(Array.isArray(p.options)&&p.options.length>=2&&p.options.length<=16,'GROK_PERMISSION_OPTIONS_INVALID');
    const ids=new Set();for(const option of p.options){keys(option,['optionId','name','kind'],['_meta']);boundedText(option.optionId,{id:true});boundedText(option.name,{empty:false});metadata(option._meta);check(OPTION_KINDS.includes(option.kind)&&!ids.has(option.optionId),'GROK_PERMISSION_OPTIONS_INVALID');ids.add(option.optionId);if(Object.hasOwn(ONCE,option.optionId))check(option.kind===ONCE[option.optionId],'GROK_PERMISSION_OPTIONS_INVALID');}
    check(Object.entries(ONCE).every(([id,kind])=>p.options.some(o=>o.optionId===id&&o.kind===kind)),'GROK_PERMISSION_OPTIONS_INVALID');
    const binding=toolFields(p.toolCall,{permission:true});binding.requested=true;binding.pendingRequest=key;
    const time=clock(),entry={requestId:value.id,toolCallId:p.toolCall.toolCallId,toolCall:copy(binding.value),options:copy(p.options),inputSHA256:binding.inputHash,requestSHA256:digest({sessionId,runId,promptRequestId,request:value,resolvedToolCall:binding.value},limits),expiresAt:time.wall+limits.permissionTtlMs,expiresMono:time.mono+limits.permissionTtlMs};
    requestIds.add(key);pending.set(key,entry);return {type:'permission',...publicPending(entry)};
  }
  function update(value){
    check(phase==='active'||phase==='cancelling','GROK_STATE_INVALID');
    keys(value,['jsonrpc','method','params']);const p=value.params;keys(p,['sessionId','update'],['_meta']);scope(p.sessionId);metadata(p._meta);const u=p.update;
    check(plain(u));
    if(u.sessionUpdate==='agent_message_chunk'){
      keys(u,['sessionUpdate','content'],['_meta']);metadata(u._meta);keys(u.content,['type','text'],['_meta']);metadata(u.content._meta);check(u.content.type==='text','GROK_CONTENT_UNSUPPORTED');accountText(u.content.text);return {type:'text-delta',text:u.content.text};
    }
    if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
      if(u.sessionUpdate==='tool_call')active();
      const {sessionUpdate,...fields}=u;const binding=toolFields(fields,{initial:sessionUpdate==='tool_call'});
      return {type:'tool-state',toolCallId:fields.toolCallId,status:binding.status,descriptiveOnly:true,approvalVerified:false};
    }
    throw rejected('GROK_UPDATE_UNSUPPORTED');
  }
  function response(value){
    check(idKey(value.id)===idKey(promptRequestId),'GROK_RESPONSE_UNKNOWN');check(pending.size===0,'GROK_RESULT_WITH_PENDING');
    if(Object.hasOwn(value,'error')){
      keys(value,['jsonrpc','id','error']);keys(value.error,['code','message'],['data']);check(Number.isSafeInteger(value.error.code)&&value.error.code>=-2147483648&&value.error.code<=2147483647);boundedText(value.error.message);
      terminal={terminal:true,replyComplete:false,taskSuccess:null,sessionId,runId,promptRequestId,stopReason:null,errorCode:'GROK_REMOTE_ERROR',rpcCode:value.error.code,permissionDenied,cancelled,toolFailureObserved};phase='result-error';
    }else{
      keys(value,['jsonrpc','id','result']);keys(value.result,['stopReason'],['_meta']);metadata(value.result._meta);check(STOPS.includes(value.result.stopReason),'GROK_STOP_REASON_UNSUPPORTED');
      check(!cancelled||value.result.stopReason==='cancelled','GROK_CANCEL_RESULT_CONFLICT');
      const openTools=[...tools.values()].filter(t=>!['completed','failed'].includes(t.status)).length;
      // A recoverable tool failure remains observable; it is not an open tool
      // or an owner denial, and protocol completion is never task success.
      const replyComplete=value.result.stopReason==='end_turn'&&!permissionDenied&&!cancelled&&openTools===0;
      terminal={terminal:true,replyComplete,taskSuccess:null,sessionId,runId,promptRequestId,stopReason:value.result.stopReason,errorCode:null,permissionDenied,cancelled,toolFailureObserved,openTools,...(value.result._meta===undefined?{}:{metadata:copy(value.result._meta)})};phase=replyComplete?'result-complete':'result-incomplete';
    }
    return {type:'result',...copy(terminal)};
  }
  function frame(value){
    check(++frames<=limits.maxFrames,'GROK_FRAME_COUNT');check(value.jsonrpc==='2.0','GROK_JSONRPC_INVALID');
    if(Object.hasOwn(value,'method')){
      check(typeof value.method==='string');
      if(value.method==='session/request_permission')return permission(value);
      if(value.method==='session/update')return update(value);
      throw rejected('GROK_REVERSE_METHOD_UNSUPPORTED');
    }
    rpcId(value.id);return response(value);
  }
  function push(chunk){return guarded(()=>{
    check(Buffer.isBuffer(chunk)&&chunk.length>0,'GROK_CHUNK_INVALID');check(!phase.startsWith('result-'),'GROK_DATA_AFTER_RESULT');check(phase!=='ended','GROK_STATE_INVALID');tick();bytes+=chunk.length;check(bytes<=limits.maxRunBytes,'GROK_RUN_SIZE');const events=[];let start=0;
    for(let index=0;index<chunk.length;index++)if(chunk[index]===10){check(!phase.startsWith('result-'),'GROK_DATA_AFTER_RESULT');const part=chunk.subarray(start,index);check(buffer.length+part.length<=limits.maxFrameBytes+1,'GROK_FRAME_SIZE');let line=Buffer.concat([buffer,part]);buffer=Buffer.alloc(0);if(line.at(-1)===13)line=line.subarray(0,-1);check(line.length>0&&line.length<=limits.maxFrameBytes,'GROK_FRAME_SIZE');check(events.length<limits.maxEventsPerPush,'GROK_EVENT_BURST');events.push(frame(decode(line,limits)));tick();start=index+1;}
    const rest=chunk.subarray(start);check(!phase.startsWith('result-')||rest.length===0,'GROK_DATA_AFTER_RESULT');const remaining=buffer.length+rest.length;check(remaining<=limits.maxFrameBytes+1,'GROK_FRAME_SIZE');if(rest.length)buffer=Buffer.concat([buffer,rest]);check(remaining<=limits.maxFrameBytes||buffer.at(-1)===13,'GROK_FRAME_SIZE');return events;
  });}
  function decide(owner,decision){return guarded(()=>{
    active();tick();authority(owner);keys(decision,['sessionId','runId','requestId','requestSHA256','optionId','confirm']);rpcId(decision.requestId);
    check(decision.confirm===true&&decision.sessionId===sessionId&&decision.runId===runId&&typeof decision.requestSHA256==='string'&&HASH.test(decision.requestSHA256),'GROK_DECISION_INVALID');
    const p=pending.get(idKey(decision.requestId));check(p&&p.requestSHA256===decision.requestSHA256,'GROK_DECISION_STALE');
    check(typeof decision.optionId==='string'&&Object.hasOwn(ONCE,decision.optionId)&&p.options.some(o=>o.optionId===decision.optionId&&o.kind===ONCE[decision.optionId]),'GROK_PERMISSION_OPTION_FORBIDDEN');
    const encoded=wire({jsonrpc:'2.0',id:p.requestId,result:{outcome:{outcome:'selected',optionId:decision.optionId}}});
    pending.delete(idKey(p.requestId));tools.get(p.toolCallId).pendingRequest=null;if(decision.optionId==='reject-once')permissionDenied=true;return encoded;
  });}
  function cancel(owner,decision){return guarded(()=>{
    active();tick();authority(owner);keys(decision,['sessionId','runId','confirm']);check(decision.confirm===true&&decision.sessionId===sessionId&&decision.runId===runId,'GROK_DECISION_INVALID');
    const outbound=[wire({jsonrpc:'2.0',method:'session/cancel',params:{sessionId}})];
    for(const p of pending.values())outbound.push(wire({jsonrpc:'2.0',id:p.requestId,result:{outcome:{outcome:'cancelled'}}}));
    pending.clear();for(const t of tools.values())t.pendingRequest=null;cancelled=true;phase='cancelling';return outbound;
  });}
  function end(){return guarded(()=>{tick();check(buffer.length===0,'GROK_EOF_TRUNCATED');check(terminal!==null&&pending.size===0,'GROK_EOF_INCOMPLETE');check(phase!=='ended','GROK_STATE_INVALID');phase='ended';return copy(terminal);});}
  return Object.freeze({push,decide,cancel,tick,end,pending:()=>guarded(()=>{tick();return [...pending.values()].map(publicPending);}),state:()=>({phase,sessionId,runId,promptRequestId,pending:pending.size,bytes,frames,outputBytes,errorCode:failure?.code||null})});
}
module.exports={createProtocol,decode,SOURCE,LIMITS};
