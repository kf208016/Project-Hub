'use strict';
// Pure, deliberately closed protocol subset. No process, transport, auth or IO.
const {TextDecoder}=require('node:util');
const {createHash}=require('node:crypto');
const SOURCE=Object.freeze({repository:'anthropics/claude-agent-sdk-python',revision:'615d88b9baebfe155263fbdd2ca22cecc1da3430',bundledCliVersion:'2.1.252',liveProtocolVerified:false});
const LIMITS=Object.freeze({maxFrameBytes:262144,maxRunBytes:8388608,maxFrames:4096,maxPending:16,maxStringBytes:131072,maxOutputBytes:2097152,maxDepth:16,maxNodes:16384,maxEventsPerPush:256,permissionTtlMs:600000});
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH=/^[a-f0-9]{64}$/;
const RESERVED=new Set(['__proto__','constructor','prototype']);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const rejected=code=>Object.assign(Error(code),{code});
function check(value,code='CLAUDE_PROTOCOL_INVALID'){if(!value)throw rejected(code);}
function keys(value,required,optional=[]){check(plain(value));check(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
function text(value,limits,{id=false,empty=true}={}){check(typeof value==='string'&&value.isWellFormed()&&!value.includes('\0')&&(empty||value.length>0)&&Buffer.byteLength(value)<=limits.maxStringBytes);if(id)check(ID.test(value));}
const integer=x=>Number.isSafeInteger(x)&&x>=0;
function jsonValue(value,limits,depth=0,budget={nodes:0}){
  check(depth<=limits.maxDepth&&++budget.nodes<=limits.maxNodes,'CLAUDE_JSON_COMPLEXITY');
  if(typeof value==='string'){text(value,limits);return;}
  if(typeof value==='number'){check(Number.isFinite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER,'CLAUDE_JSON_NUMBER');return;}
  if(value===null||typeof value==='boolean')return;
  if(Array.isArray(value)){for(const item of value)jsonValue(item,limits,depth+1,budget);return;}
  check(plain(value),'CLAUDE_JSON_TYPE');
  for(const key of Object.keys(value)){text(key,limits);check(!RESERVED.has(key),'CLAUDE_JSON_KEY');jsonValue(value[key],limits,depth+1,budget);}
}
function canonical(value,limits=LIMITS){
  jsonValue(value,limits);
  const visit=x=>Array.isArray(x)?'['+x.map(visit).join(',')+']':plain(x)?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+visit(x[k])).join(',')+'}':JSON.stringify(x);
  return visit(value);
}
// Validate raw JSON before JSON.parse: duplicate keys and rounded integers must
// never silently change the bytes the owner is being asked to approve.
function decode(bytes,limits=LIMITS){
  check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=limits.maxFrameBytes,'CLAUDE_FRAME_SIZE');
  let source;try{source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw rejected('CLAUDE_UTF8_INVALID');}
  let at=0,nodes=0;
  const decimal=raw=>{const m=raw.match(/^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/);const digits=(m[2]+(m[3]||'')).replace(/^0+/,'');if(!digits)return '0';const trimmed=digits.replace(/0+$/,'');const exponent=Number(m[4]||0)-(m[3]||'').length+digits.length-trimmed.length;check(Number.isSafeInteger(exponent),'CLAUDE_JSON_NUMBER');return m[1]+trimmed+'e'+exponent;};
  const space=()=>{while(at<source.length&&/[\x20\x09\x0d\x0a]/.test(source[at]))at++;};
  function string(){
    const start=at;check(source[at++]==='"','CLAUDE_JSON_INVALID');let ended=false;
    while(at<source.length){const c=source[at++];if(c==='"'){ended=true;break;}check(c.charCodeAt(0)>=32,'CLAUDE_JSON_INVALID');if(c==='\\'){const next=source[at++];if(next==='u'){check(/^[a-fA-F0-9]{4}$/.test(source.slice(at,at+4)),'CLAUDE_JSON_INVALID');at+=4;}else check(next!==undefined&&'"\\/bfnrt'.includes(next),'CLAUDE_JSON_INVALID');}}
    check(ended,'CLAUDE_JSON_INVALID');let result;try{result=JSON.parse(source.slice(start,at));}catch{throw rejected('CLAUDE_JSON_INVALID');}text(result,limits);return result;
  }
  function value(depth){
    check(depth<=limits.maxDepth&&++nodes<=limits.maxNodes,'CLAUDE_JSON_COMPLEXITY');space();const c=source[at];
    if(c==='"')return string();
    if(c==='{'){
      at++;space();const result=Object.create(null);if(source[at]==='}'){at++;return result;}
      for(;;){space();const key=string();check(!RESERVED.has(key),'CLAUDE_JSON_KEY');check(!Object.hasOwn(result,key),'CLAUDE_JSON_DUPLICATE_KEY');space();check(source[at++]===':','CLAUDE_JSON_INVALID');result[key]=value(depth+1);space();const sep=source[at++];if(sep==='}')return result;check(sep===',','CLAUDE_JSON_INVALID');}
    }
    if(c==='['){at++;space();const result=[];if(source[at]===']'){at++;return result;}for(;;){result.push(value(depth+1));space();const sep=source[at++];if(sep===']')return result;check(sep===',','CLAUDE_JSON_INVALID');}}
    for(const [literal,result]of [['true',true],['false',false],['null',null]])if(source.startsWith(literal,at)){at+=literal.length;return result;}
    const match=source.slice(at).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);check(match,'CLAUDE_JSON_INVALID');at+=match[0].length;const number=Number(match[0]);
    check(Number.isFinite(number)&&Math.abs(number)<=Number.MAX_SAFE_INTEGER&&(!/^-?[0-9]+$/.test(match[0])||Number.isSafeInteger(number))&&decimal(match[0])===decimal(JSON.stringify(number)),'CLAUDE_JSON_NUMBER');return number;
  }
  const result=value(0);space();check(at===source.length&&plain(result),'CLAUDE_JSON_INVALID');jsonValue(result,limits);return result;
}
const digest=(value,limits)=>createHash('sha256').update(canonical(value,limits)).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));
function createProtocol(options){
  keys(options,['sessionId','runId','ownerAuthority'],['now','monotonic','limits']);
  const {sessionId,runId,ownerAuthority}=options;
  check(typeof sessionId==='string'&&typeof runId==='string'&&ID.test(sessionId)&&ID.test(runId)&&ownerAuthority!==null&&typeof ownerAuthority==='object','CLAUDE_OPTIONS_INVALID');
  const limits={...LIMITS};
  if(options.limits!==undefined){keys(options.limits,[],Object.keys(LIMITS));for(const [key,value]of Object.entries(options.limits)){check(Number.isSafeInteger(value)&&value>=1&&value<=LIMITS[key],'CLAUDE_OPTIONS_INVALID');limits[key]=value;}}
  const now=options.now===undefined?Date.now:options.now,monotonic=options.monotonic===undefined?(()=>Number(process.hrtime.bigint()/1000000n)):options.monotonic;
  check(typeof now==='function'&&typeof monotonic==='function','CLAUDE_OPTIONS_INVALID');
  let phase='awaiting-init',failure=null,buffer=Buffer.alloc(0),bytes=0,frames=0,outputBytes=0,lastClock=null,terminal=null,stream=null;
  let lastStopReason=null,abnormalStop=false,permissionDenied=false,permissionCanceled=false;
  const stopReasons=new Set();
  const pending=new Map(),requestIds=new Set(),eventIds=new Set(),toolIds=new Map(),messageIds=new Set(),assistantIds=new Set(),streamSnapshots=new Map();
  function fail(code){if(!failure){failure=rejected(code);phase='failed';pending.clear();buffer=Buffer.alloc(0);stream=null;terminal=null;}throw failure;}
  function guarded(fn){if(failure)throw failure;try{return fn();}catch(error){return fail(typeof error?.code==='string'&&/^CLAUDE_[A-Z_]+$/.test(error.code)?error.code:'CLAUDE_PROTOCOL_INVALID');}}
  function clock(){let wall,mono;try{wall=now();mono=monotonic();}catch{return fail('CLAUDE_CLOCK_INVALID');}check(integer(wall)&&integer(mono)&&wall<=Number.MAX_SAFE_INTEGER-limits.permissionTtlMs&&mono<=Number.MAX_SAFE_INTEGER-limits.permissionTtlMs&&(!lastClock||wall>=lastClock.wall&&mono>=lastClock.mono),'CLAUDE_CLOCK_INVALID');lastClock={wall,mono};return lastClock;}
  function tick(){return guarded(()=>{const time=clock();for(const p of pending.values())check(time.wall<p.expiresAt&&time.mono<p.expiresMono,'CLAUDE_PERMISSION_EXPIRED');return {phase,pending:pending.size};});}
  function active(){check(phase==='active','CLAUDE_STATE_INVALID');}
  function bound(frame,required,optional=[]){keys(frame,required,optional);check(frame.session_id===sessionId,'CLAUDE_SESSION_MISMATCH');text(frame.uuid,limits,{id:true});check(!eventIds.has(frame.uuid),'CLAUDE_EVENT_REPLAY');eventIds.add(frame.uuid);}
  function tool(id,name,input){
    text(id,limits,{id:true});text(name,limits,{id:true});check(plain(input));
    const hash=digest({name,input},limits),old=toolIds.get(id);
    if(old)check(old.hash===hash,'CLAUDE_TOOL_CHANGED');else toolIds.set(id,{hash,requested:false});
    return toolIds.get(id);
  }
  function block(value,record=true){
    check(plain(value));
    if(value.type==='text'){keys(value,['type','text']);text(value.text,limits);return {type:'text',text:value.text};}
    if(value.type==='tool_use'){keys(value,['type','id','name','input']);text(value.id,limits,{id:true});text(value.name,limits,{id:true});check(plain(value.input));if(record)tool(value.id,value.name,value.input);return copy(value);}
    throw rejected('CLAUDE_BLOCK_UNSUPPORTED');
  }
  function accountText(value){outputBytes+=Buffer.byteLength(value);check(outputBytes<=limits.maxOutputBytes,'CLAUDE_OUTPUT_SIZE');}
  function observeStop(reason){if(reason==null)return;text(reason,limits);stopReasons.add(reason);lastStopReason=reason;if(!['end_turn','tool_use'].includes(reason))abnormalStop=true;}
  function messageMetadata(m){for(const k of ['stop_reason','stop_sequence'])if(m[k]!==undefined)check(m[k]===null||typeof m[k]==='string');if(m.usage!==undefined)check(plain(m.usage));observeStop(m.stop_reason);}
  function streamFrame(frame){
    bound(frame,['type','uuid','session_id','event'],['parent_tool_use_id']);check(frame.parent_tool_use_id==null,'CLAUDE_SUBAGENT_UNSUPPORTED');
    const event=frame.event;check(plain(event));
    if(event.type==='message_start'){
      keys(event,['type','message']);check(stream===null,'CLAUDE_STREAM_ORDER');
      keys(event.message,['id','type','role','model','content'],['stop_reason','stop_sequence','usage']);
      const m=event.message;messageMetadata(m);text(m.id,limits,{id:true});text(m.model,limits,{empty:false});check(m.type==='message'&&m.role==='assistant'&&Array.isArray(m.content)&&m.content.length===0&&!messageIds.has(m.id)&&!assistantIds.has(m.id),'CLAUDE_STREAM_ORDER');
      stream={id:m.id,model:m.model,next:0,block:null,blocks:[],delta:false};return {type:'stream-start',messageId:m.id};
    }
    check(stream!==null,'CLAUDE_STREAM_ORDER');
    if(event.type==='content_block_start'){
      keys(event,['type','index','content_block']);check(stream.block===null&&!stream.delta&&event.index===stream.next,'CLAUDE_STREAM_ORDER');
      const content=block(event.content_block,false);check(content.type==='text'?content.text==='':Object.keys(content.input).length===0,'CLAUDE_STREAM_ORDER');stream.block={...content,partial:''};return {type:'stream-block-start',index:event.index,kind:content.type};
    }
    if(event.type==='content_block_delta'){
      keys(event,['type','index','delta']);check(stream.block!==null&&event.index===stream.next,'CLAUDE_STREAM_ORDER');const d=event.delta;
      if(stream.block.type==='text'){keys(d,['type','text']);check(d.type==='text_delta');text(d.text,limits);stream.block.text+=d.text;text(stream.block.text,limits);accountText(d.text);return {type:'text-delta',text:d.text};}
      keys(d,['type','partial_json']);check(d.type==='input_json_delta');text(d.partial_json,limits);stream.block.partial+=d.partial_json;check(Buffer.byteLength(stream.block.partial)<=limits.maxStringBytes,'CLAUDE_INPUT_SIZE');return {type:'tool-input-delta',toolUseId:stream.block.id};
    }
    if(event.type==='content_block_stop'){
      keys(event,['type','index']);check(stream.block!==null&&event.index===stream.next,'CLAUDE_STREAM_ORDER');const b=stream.block;
      if(b.type==='tool_use'){b.input=b.partial?decode(Buffer.from(b.partial),limits):{};const binding=tool(b.id,b.name,b.input);check(binding.streamMessage===undefined,'CLAUDE_TOOL_REPLAY');binding.streamMessage=stream.id;}
      const {partial,...content}=b;stream.blocks.push(content);stream.block=null;stream.next++;return {type:'stream-block-stop',index:event.index};
    }
    if(event.type==='message_delta'){keys(event,['type','delta','usage']);keys(event.delta,['stop_reason','stop_sequence']);check(stream.block===null&&!stream.delta&&Array.isArray(stream.blocks),'CLAUDE_STREAM_ORDER');check(event.delta.stop_reason===null||typeof event.delta.stop_reason==='string');check(event.delta.stop_sequence===null||typeof event.delta.stop_sequence==='string');check(plain(event.usage));observeStop(event.delta.stop_reason);stream.delta=true;return {type:'stream-usage',usage:copy(event.usage),stopReason:event.delta.stop_reason};}
    if(event.type==='message_stop'){keys(event,['type']);check(stream.block===null&&stream.delta,'CLAUDE_STREAM_ORDER');const result={type:'stream-stop',messageId:stream.id};streamSnapshots.set(stream.id,digest({model:stream.model,content:stream.blocks},limits));messageIds.add(stream.id);stream=null;return result;}
    throw rejected('CLAUDE_STREAM_UNSUPPORTED');
  }
  function frame(value){
    check(++frames<=limits.maxFrames,'CLAUDE_FRAME_COUNT');check(typeof value.type==='string');
    if(value.type==='system'){
      check(phase==='awaiting-init','CLAUDE_STATE_INVALID');bound(value,['type','subtype','session_id','uuid'],['model','cwd','tools','permissionMode']);check(value.subtype==='init','CLAUDE_EVENT_UNSUPPORTED');
      if(value.model!==undefined)text(value.model,limits,{empty:false});if(value.cwd!==undefined)text(value.cwd,limits,{empty:false});if(value.tools!==undefined)check(Array.isArray(value.tools)&&value.tools.length<=128&&value.tools.every(x=>typeof x==='string'&&ID.test(x)));if(value.permissionMode!==undefined)check(['default','manual','plan','dontAsk'].includes(value.permissionMode),'CLAUDE_PERMISSION_MODE');
      phase='active';return {type:'session',sessionId,runId,...(value.model===undefined?{}:{model:value.model})};
    }
    active();
    if(value.type==='control_request'){
      keys(value,['type','request_id','request']);text(value.request_id,limits,{id:true});check(!requestIds.has(value.request_id),'CLAUDE_REQUEST_REPLAY');check(pending.size<limits.maxPending,'CLAUDE_PENDING_SIZE');
      const r=value.request;keys(r,['subtype','tool_name','input','tool_use_id'],['permission_suggestions','blocked_path','decision_reason','title','display_name','description','agent_id']);check(r.subtype==='can_use_tool','CLAUDE_CONTROL_UNSUPPORTED');check(r.agent_id==null,'CLAUDE_SUBAGENT_UNSUPPORTED');
      check(plain(r.input));for(const k of ['blocked_path','decision_reason','title','display_name','description'])if(r[k]!=null)text(r[k],limits);
      check(r.permission_suggestions==null||Array.isArray(r.permission_suggestions)&&r.permission_suggestions.length===0,'CLAUDE_PERMISSION_UPDATE_UNSUPPORTED');
      const binding=tool(r.tool_use_id,r.tool_name,r.input);check(!binding.requested,'CLAUDE_TOOL_REPLAY');binding.requested=true;requestIds.add(value.request_id);
      const time=clock(),requestSHA256=digest({sessionId,runId,request:value},limits),entry={requestId:value.request_id,toolUseId:r.tool_use_id,toolName:r.tool_name,input:copy(r.input),requestSHA256,expiresAt:time.wall+limits.permissionTtlMs,expiresMono:time.mono+limits.permissionTtlMs};
      pending.set(value.request_id,entry);return {type:'permission',...publicPending(entry)};
    }
    if(value.type==='control_cancel_request'){
      keys(value,['type','request_id']);text(value.request_id,limits,{id:true});check(pending.has(value.request_id),'CLAUDE_CANCEL_UNKNOWN');pending.delete(value.request_id);permissionCanceled=true;return {type:'permission-canceled',requestId:value.request_id};
    }
    if(value.type==='assistant'){
      bound(value,['type','session_id','uuid','message'],['parent_tool_use_id','error']);check(value.parent_tool_use_id==null&&value.error==null,'CLAUDE_ASSISTANT_ERROR');
      keys(value.message,['id','role','model','content'],['type','stop_reason','stop_sequence','usage']);const m=value.message;messageMetadata(m);text(m.id,limits,{id:true});text(m.model,limits,{empty:false});check(m.role==='assistant'&&(m.type===undefined||m.type==='message')&&Array.isArray(m.content)&&m.content.length<=128&&stream===null);
      check(!assistantIds.has(m.id),'CLAUDE_MESSAGE_REPLAY');assistantIds.add(m.id);const seenTools=new Set(),content=m.content.map(x=>{const b=block(x);if(b.type==='tool_use'){check(!seenTools.has(b.id),'CLAUDE_TOOL_REPLAY');seenTools.add(b.id);const binding=toolIds.get(b.id);check(binding.snapshotMessage===undefined,'CLAUDE_TOOL_REPLAY');binding.snapshotMessage=m.id;}return b;});
      if(streamSnapshots.has(m.id))check(streamSnapshots.get(m.id)===digest({model:m.model,content},limits),'CLAUDE_MESSAGE_CHANGED');
      for(const b of content)if(b.type==='text')accountText(b.text);return {type:'assistant',messageId:m.id,model:m.model,content,...(m.stop_reason===undefined?{}:{stopReason:m.stop_reason})};
    }
    if(value.type==='stream_event')return streamFrame(value);
    if(value.type==='result'){
      bound(value,['type','subtype','session_id','uuid','duration_ms','duration_api_ms','is_error','num_turns'],['result','errors','terminal_reason','stop_reason','total_cost_usd','usage','modelUsage','permission_denials','api_error_status']);
      check(typeof value.subtype==='string'&&['success','error_during_execution','error_max_turns','error_max_budget_usd','error_max_structured_output_retries'].includes(value.subtype));check(typeof value.is_error==='boolean'&&integer(value.duration_ms)&&integer(value.duration_api_ms)&&integer(value.num_turns));
      check(stream===null&&pending.size===0,'CLAUDE_RESULT_WITH_PENDING');
      if(value.result!==undefined){text(value.result,limits);accountText(value.result);}if(value.errors!==undefined)check(Array.isArray(value.errors)&&value.errors.length<=32&&value.errors.every(x=>typeof x==='string'));if(value.terminal_reason!==undefined)text(value.terminal_reason,limits,{id:true});if(value.stop_reason!==undefined)check(value.stop_reason===null||typeof value.stop_reason==='string');
      if(value.total_cost_usd!==undefined)check(typeof value.total_cost_usd==='number'&&Number.isFinite(value.total_cost_usd)&&value.total_cost_usd>=0);for(const k of ['usage','modelUsage'])if(value[k]!==undefined)check(plain(value[k]));if(value.permission_denials!==undefined)check(Array.isArray(value.permission_denials)&&value.permission_denials.length<=128);if(value.api_error_status!=null){check(integer(value.api_error_status)&&value.api_error_status>=100&&value.api_error_status<=599);check(value.is_error,'CLAUDE_RESULT_CONFLICT');}
      observeStop(value.stop_reason);const permissionDenials=value.permission_denials?.length||0;if(permissionDenials)permissionDenied=true;
      const incompleteReasons=[];
      if(value.subtype!=='success'||value.is_error)incompleteReasons.push('provider-error');
      if(value.terminal_reason!==undefined&&value.terminal_reason!=='completed')incompleteReasons.push('terminal-reason');
      if(value.errors?.length)incompleteReasons.push('errors');
      if(abnormalStop||lastStopReason==='tool_use')incompleteReasons.push('stop-reason');
      if(permissionDenied)incompleteReasons.push('permission-denied');
      if(permissionCanceled)incompleteReasons.push('permission-canceled');
      const ok=incompleteReasons.length===0;
      phase=ok?'result-success':'result-error';terminal={terminal:true,ok,responseComplete:ok,sessionId,runId,subtype:value.subtype,isError:value.is_error,terminalReason:value.terminal_reason||null,stopReasons:[...stopReasons],lastStopReason,permissionDenied,permissionDenials,permissionCanceled,incompleteReasons,...(value.result===undefined?{}:{text:value.result})};return {type:'result',...copy(terminal)};
    }
    throw rejected('CLAUDE_EVENT_UNSUPPORTED');
  }
  function publicPending(p){return {sessionId,runId,requestId:p.requestId,toolUseId:p.toolUseId,toolName:p.toolName,input:copy(p.input),requestSHA256:p.requestSHA256,expiresAt:p.expiresAt};}
  function push(chunk){return guarded(()=>{
    check(Buffer.isBuffer(chunk)&&chunk.length>0,'CLAUDE_CHUNK_INVALID');check(!phase.startsWith('result-'),'CLAUDE_DATA_AFTER_RESULT');check(phase!=='ended','CLAUDE_STATE_INVALID');tick();bytes+=chunk.length;check(bytes<=limits.maxRunBytes,'CLAUDE_RUN_SIZE');const events=[];let start=0;
    for(let index=0;index<chunk.length;index++)if(chunk[index]===10){check(!phase.startsWith('result-'),'CLAUDE_DATA_AFTER_RESULT');const part=chunk.subarray(start,index);check(buffer.length+part.length<=limits.maxFrameBytes+1,'CLAUDE_FRAME_SIZE');let line=Buffer.concat([buffer,part]);buffer=Buffer.alloc(0);if(line.at(-1)===13)line=line.subarray(0,-1);check(line.length>0&&line.length<=limits.maxFrameBytes,'CLAUDE_FRAME_SIZE');check(events.length<limits.maxEventsPerPush,'CLAUDE_EVENT_BURST');events.push(frame(decode(line,limits)));tick();start=index+1;}
    const rest=chunk.subarray(start);check(!phase.startsWith('result-')||rest.length===0,'CLAUDE_DATA_AFTER_RESULT');const remaining=buffer.length+rest.length;check(remaining<=limits.maxFrameBytes+1,'CLAUDE_FRAME_SIZE');if(rest.length)buffer=Buffer.concat([buffer,rest]);check(remaining<=limits.maxFrameBytes||buffer.at(-1)===13,'CLAUDE_FRAME_SIZE');return events;
  });}
  function decide(authority,decision){return guarded(()=>{
    active();tick();check(authority===ownerAuthority,'CLAUDE_OWNER_REQUIRED');keys(decision,['sessionId','runId','requestId','requestSHA256','decision','confirm']);check(decision.confirm===true&&decision.sessionId===sessionId&&decision.runId===runId&&HASH.test(decision.requestSHA256||'')&&['allow','deny'].includes(decision.decision),'CLAUDE_DECISION_INVALID');const p=pending.get(decision.requestId);check(p&&p.requestSHA256===decision.requestSHA256,'CLAUDE_DECISION_STALE');
    const response={type:'control_response',response:{subtype:'success',request_id:p.requestId,response:decision.decision==='allow'?{behavior:'allow',updatedInput:copy(p.input)}:{behavior:'deny',message:'Denied by Hub owner'}}};
    const encoded=Buffer.from(canonical(response,limits)+'\n');check(encoded.length<=limits.maxFrameBytes,'CLAUDE_FRAME_SIZE');pending.delete(p.requestId);if(decision.decision==='deny')permissionDenied=true;return encoded;
  });}
  function end(){return guarded(()=>{tick();check(buffer.length===0,'CLAUDE_EOF_TRUNCATED');check(terminal!==null&&pending.size===0&&stream===null,'CLAUDE_EOF_INCOMPLETE');check(phase!=='ended','CLAUDE_STATE_INVALID');phase='ended';return copy(terminal);});}
  return Object.freeze({push,decide,tick,end,pending:()=>guarded(()=>{tick();return [...pending.values()].map(publicPending);}),state:()=>({phase,sessionId,runId,pending:pending.size,bytes,frames,errorCode:failure?.code||null})});
}
module.exports={createProtocol,decode,canonical,SOURCE,LIMITS};
