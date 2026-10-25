'use strict';
const {MAX_WALL_MS,IDLE_MS}=require('./native-turn-limits');
// Sonnet adapter reviewed by Codex: owner supplies the admitted, supervised
// endpoint. This module has no spawn, environment, filesystem or auth access.
const {EventEmitter}=require('node:events');
const {PassThrough,Readable,Writable}=require('node:stream');
const {randomUUID}=require('node:crypto');
const {TextDecoder}=require('node:util');
const {decode,canonical}=require('./providers/claude-protocol');
const {TOOLS,createScope}=require('./claude-subagent-context');
const {isInertTaskMetadata}=require('./claude-task-metadata');
const LIMITS=Object.freeze({maxFrameBytes:1048576,maxRunBytes:16777216,maxFrames:4096,
  maxStringBytes:262144,maxDepth:24,maxNodes:32768,maxPromptBytes:65536,maxOutputBytes:2097152});
const claimed=new WeakSet(),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const good=x=>typeof x==='string'&&x.length>0&&x.isWellFormed()&&!x.includes('\0');
const failure=code=>Object.assign(Error(code),{code});
const check=(value,code='CLAUDE_NATIVE_PROTOCOL')=>{if(!value)throw failure(code);};
function buildArgs(o){
  return ['--print','--input-format','stream-json','--output-format','stream-json','--verbose',
    '--permission-prompt-tool','stdio',...(o.model===''?[]:['--model',o.model]),'--effort',o.effort,'--restricted',
    '--tools',TOOLS.join(','),'--setting-sources','','--settings',JSON.stringify({disableAllHooks:true,autoMemoryEnabled:false,...(o.model===''?{}:{availableModels:[o.model],env:{CLAUDE_CODE_SUBAGENT_MODEL:o.model}})}),
    '--disallowedTools','WebSearch,WebFetch',
    '--no-chrome','--strict-mcp-config','--mcp-config',canonical(o.validatedMcpConfig,LIMITS),
    '--disable-slash-commands',o.resume?'--resume':'--session-id',o.sessionId];
}
function start(o){
  check(plain(o),'CLAUDE_NATIVE_OPTIONS');
  check(o.model===''||good(o.model)&&ID.test(o.model),'CLAUDE_NATIVE_OPTIONS');
  for(const k of ['effort','project','task','runId','cwd'])check(good(o[k])&&o[k].length<=32760,'CLAUDE_NATIVE_OPTIONS');
  check(UUID.test(o.sessionId)&&typeof o.resume==='boolean'&&typeof o.openEndpoint==='function','CLAUDE_NATIVE_OPTIONS');
  check(o.onSession===undefined||typeof o.onSession==='function','CLAUDE_NATIVE_OPTIONS');
  check(plain(o.validatedMcpConfig)&&plain(o.validatedMcpConfig.mcpServers),'CLAUDE_NATIVE_OPTIONS');
  // No inference of trust from this field name: admission belongs to the owner.
  canonical(o.validatedMcpConfig,LIMITS);
  const scope=createScope();
  const cap=(key,fallback,max)=>{const v=o[key]??fallback;check(Number.isSafeInteger(v)&&v>=1&&v<=max,'CLAUDE_NATIVE_OPTIONS');return v;};
  const wallMs=cap('maxWallMs',MAX_WALL_MS,MAX_WALL_MS),initMs=cap('initTimeoutMs',30000,30000),
    idleMs=cap('idleTimeoutMs',IDLE_MS,IDLE_MS),approvalMs=cap('approvalTimeoutMs',600000,600000),graceMs=cap('graceMs',5000,5000);
  const proc=new EventEmitter();Object.assign(proc,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true,requiresCleanupReceipt:true,cleanupReceipt:null});
  let readyResolve,readyReject,completeResolve;
  proc.ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});proc.ready.catch(()=>{});
  proc.completion=new Promise(r=>{completeResolve=r;});
  let child=null,closed=false,closing=false,cancelled=false,errorCode=null,spawned=false,ready=false,
    initAck=false,systemInit=false,promptSent=false,promptEOF=false,result=null,denied=false,
    outEnded=false,errEnded=false,assistantText=false,outputBytes=0,stderrBytes=0;
  const initId='hub-init-'+randomUUID(),pending=new Map(),requestIds=new Set(),eventIds=new Set(),toolIds=new Set(),toolResults=new Set();
  let promptChunks=[],promptBytes=0,buffer=Buffer.alloc(0),totalBytes=0,frames=0,graceTimer=null;
  const queue=[];let current=null,queuedBytes=0,ending=false;
  let idleTimer=null;
  function stopIdle(){clearTimeout(idleTimer);idleTimer=null;}
  function activity(){
    if(!spawned||closed||closing||errorCode)return;
    stopIdle();idleTimer=setTimeout(()=>fail('CLAUDE_NATIVE_IDLE_TIMEOUT'),idleMs);
  }
  const timers=[];
  const timer=(fn,ms)=>{const t=setTimeout(fn,ms);timers.push(t);return t;};
  function emitOut(row){if(closed)return;const s=JSON.stringify(row)+'\n';outputBytes+=Buffer.byteLength(s);check(outputBytes<=LIMITS.maxOutputBytes,'CLAUDE_NATIVE_OUTPUT_LIMIT');proc.stdout.write(s);}
  function publish(){if(!closed)try{proc.emit('approvals',proc.listApprovals());}catch{errorCode=errorCode||'CLAUDE_NATIVE_OWNER_EVENT_FAILED';closing=true;kill();}}
  function clearPending(){for(const p of pending.values())clearTimeout(p.timer);pending.clear();publish();}
  function kill(){stopIdle();if(child&&!closed){try{child.kill();}catch{errorCode=errorCode||'CLAUDE_NATIVE_STOP_FAILED';}}}
  function fail(code){
    if(closed)return;errorCode=errorCode||code;closing=true;
    queue.length=0;queuedBytes=current?current.bytes.length:0;clearPending();
    if(!ready)readyReject(failure(errorCode));kill();
  }
  function safely(fn){if(closed||errorCode)return;try{fn();}catch(e){fail(typeof e?.code==='string'&&/^CLAUDE_NATIVE_[A-Z_]+$/.test(e.code)?e.code:'CLAUDE_NATIVE_PROTOCOL');}}
  function endInput(){if(ending&&child&&!current&&!queue.length&&!child.stdin.writableEnded){try{child.stdin.end();}catch{fail('CLAUDE_NATIVE_WRITE_FAILED');}}}
  function writeDone(op){
    if(current!==op||!op.returned||!op.callback||op.needDrain||closed)return;
    queuedBytes-=op.bytes.length;current=null;pump();
  }
  function pump(){
    if(closed||errorCode||current||!child||!spawned)return;
    if(!queue.length){endInput();return;}
    const op={bytes:queue.shift(),callback:false,returned:false,needDrain:false,drained:false};current=op;
    try{
      const accepted=child.stdin.write(op.bytes,e=>{if(e){fail('CLAUDE_NATIVE_WRITE_FAILED');return;}op.callback=true;writeDone(op);});
      op.returned=true;op.needDrain=!accepted&&!op.drained;writeDone(op);
    }catch{fail('CLAUDE_NATIVE_WRITE_FAILED');}
  }
  function send(row){
    check(!closed&&!errorCode&&!ending,'CLAUDE_NATIVE_WRITE_CLOSED');const b=Buffer.from(canonical(row,LIMITS)+'\n');
    check(queue.length+(current?1:0)<32&&queuedBytes+b.length<=1048576,'CLAUDE_NATIVE_WRITE_LIMIT');
    queue.push(b);queuedBytes+=b.length;pump();
  }
  function bindOwner(){
    if(o.onSession)try{
      const r=o.onSession(Object.freeze({project:o.project,task:o.task,runId:o.runId,sessionId:o.sessionId}));
      if(r&&typeof r.then==='function')Promise.resolve(r).catch(()=>{});
      check(r===undefined,'CLAUDE_NATIVE_SESSION_BINDING_FAILED');
    }catch{throw failure('CLAUDE_NATIVE_SESSION_BINDING_FAILED');}
  }
  function maybeReady(){if(initAck&&systemInit&&promptSent&&!ready){ready=true;clearTimeout(initTimer);emitOut({type:'thread.started',thread_id:o.sessionId});readyResolve(true);}}
  function prompt(){
    if(!spawned||!initAck||!promptEOF||promptSent||errorCode||closed)return;
    check(promptBytes>0&&promptBytes<=LIMITS.maxPromptBytes,'CLAUDE_NATIVE_PROMPT_INVALID');
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(promptChunks));}catch{throw failure('CLAUDE_NATIVE_PROMPT_INVALID');}
    check(good(text)&&!text.startsWith('\ufeff'),'CLAUDE_NATIVE_PROMPT_INVALID');promptChunks=[];
    bindOwner();
    promptSent=true;send({type:'user',message:{role:'user',content:text},parent_tool_use_id:null,session_id:o.sessionId});maybeReady();
  }
  function permissionResponse(p,allow){send({type:'control_response',response:{subtype:'success',request_id:p.requestId,response:allow?
    {behavior:'allow',updatedInput:p.input}:{behavior:'deny',message:'Owner declined this operation.'}}});activity();}
  function permission(frame){
    check(ready&&promptSent&&!result,'CLAUDE_NATIVE_PERMISSION_STATE');
    const r=frame.request,id=frame.request_id;
    check(typeof id==='string'&&ID.test(id)&&id!==initId&&!requestIds.has(id),'CLAUDE_NATIVE_PERMISSION_REPLAY');requestIds.add(id);
    check(plain(r)&&r.subtype==='can_use_tool'&&good(r.tool_name)&&r.tool_name.length<=256&&
      typeof r.tool_use_id==='string'&&ID.test(r.tool_use_id)&&plain(r.input),'CLAUDE_NATIVE_PERMISSION_INVALID');
    check(pending.size<16,'CLAUDE_NATIVE_PERMISSION_LIMIT');
    const detail=canonical({toolName:r.tool_name,input:r.input},LIMITS);check(Buffer.byteLength(detail)<=131072,'CLAUDE_NATIVE_PERMISSION_LIMIT');
    const token=randomUUID(),expiresAt=Date.now()+approvalMs,p={requestId:id,input:r.input,expiresAt,
      public:{token,kind:'tool',reason:'工具操作需要 owner 核准',detail,expiresAt,project:o.project,task:o.task,runId:o.runId,sessionId:o.sessionId}};
    p.timer=timer(()=>{if(!pending.has(token)||closed||errorCode)return;pending.delete(token);denied=true;safely(()=>permissionResponse(p,false));publish();},approvalMs);
    pending.set(token,p);publish();
  }
  proc.listApprovals=()=>[...pending.values()].map(p=>({...p.public}));
  proc.respond=(token,decision)=>{
    check(!closed&&!errorCode&&!closing,'CLAUDE_NATIVE_APPROVAL_CLOSED');
    check(['accept','decline','cancel'].includes(decision),'CLAUDE_NATIVE_APPROVAL_DECISION');
    const p=pending.get(token);check(p,'CLAUDE_NATIVE_APPROVAL_UNKNOWN');
    pending.delete(token);clearTimeout(p.timer);
    if(Date.now()>=p.expiresAt){denied=true;safely(()=>permissionResponse(p,false));publish();throw failure('CLAUDE_NATIVE_APPROVAL_EXPIRED');}
    if(decision!=='accept')denied=true;
    safely(()=>permissionResponse(p,decision==='accept'));publish();return true;
  };
  const metadata=new Set(['thinking_tokens','compact_boundary','status']);
  function resultUsage(f){
    check(typeof f.is_error==='boolean'&&typeof f.subtype==='string'&&f.session_id===o.sessionId,'CLAUDE_NATIVE_RESULT_INVALID');
    check(f.subtype==='success'||/^error_[A-Za-z0-9_]+$/.test(f.subtype),'CLAUDE_NATIVE_RESULT_INVALID');
    if(f.permission_denials!==undefined)check(Array.isArray(f.permission_denials),'CLAUDE_NATIVE_RESULT_INVALID');
    const usage={};
    if(f.usage!==undefined){check(plain(f.usage),'CLAUDE_NATIVE_RESULT_INVALID');for(const k of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens'])if(f.usage[k]!==undefined){check(Number.isSafeInteger(f.usage[k])&&f.usage[k]>=0,'CLAUDE_NATIVE_RESULT_INVALID');usage[k]=f.usage[k];}}
    return usage;
  }
  function frame(f){
    check(plain(f)&&typeof f.type==='string','CLAUDE_NATIVE_FRAME_INVALID');
    if(Object.hasOwn(f,'session_id'))check(f.session_id===o.sessionId,'CLAUDE_NATIVE_SESSION_MISMATCH');
    if(typeof f.uuid==='string'){check(!eventIds.has(f.uuid),'CLAUDE_NATIVE_EVENT_REPLAY');eventIds.add(f.uuid);}
    check(!result,'CLAUDE_NATIVE_AFTER_RESULT');
    if(o.resume&&spawned&&!systemInit&&f.type==='result'&&f.is_error===true){
      resultUsage(f);throw failure('CLAUDE_NATIVE_RESUME_FAILED');
    }
    if(f.type==='control_response'){
      const r=f.response;check(plain(r)&&r.request_id===initId&&r.subtype==='success'&&plain(r.response)&&!initAck,'CLAUDE_NATIVE_INIT_ACK');
      initAck=true;maybeReady();prompt();return;
    }
    if(f.type==='control_request'){permission(f);return;}
    if(f.type==='system'){
      if(f.subtype==='init'){
        check(!systemInit&&f.session_id===o.sessionId,'CLAUDE_NATIVE_INIT_SESSION');systemInit=true;
        check(typeof f.model==='string'&&f.model.length>0,'CLAUDE_NATIVE_INIT_MODEL');
        // Aliases are resolved by the provider. Reported model stays available
        // to the admission owner; this field is not proof of account identity.
        const alias=['sonnet','opus','haiku','fable'].includes(o.model);
        check(o.model===''?/^claude-[a-z0-9-]+$/.test(f.model)&&f.model===f.model.trim():alias?f.model.startsWith('claude-'+o.model+'-'):f.model===o.model,'CLAUDE_NATIVE_MODEL_MISMATCH');
        proc.reportedModel=f.model;maybeReady();return;
      }
      // Exact vendor lifecycle notifications are inert. Payloads never enter
      // tool ownership, permissions, replies or completion state.
      check(systemInit&&(metadata.has(f.subtype)||isInertTaskMetadata(f.subtype)),'CLAUDE_NATIVE_SYSTEM_METADATA_INVALID');return;
    }
    if(f.type==='rate_limit_event'){check(systemInit,'CLAUDE_NATIVE_RATE_LIMIT_STATE');return;}
    check(ready&&promptSent,'CLAUDE_NATIVE_BEFORE_INIT');
    if(f.type==='assistant'){
      const parent=scope.assertParent(Object.hasOwn(f,'parent_tool_use_id')?f.parent_tool_use_id:null);
      check(plain(f.message)&&Array.isArray(f.message.content),'CLAUDE_NATIVE_ASSISTANT_ENVELOPE');
      for(const b of f.message.content){
        check(plain(b),'CLAUDE_NATIVE_ASSISTANT_BLOCK');
        if(b.type==='text'){check(typeof b.text==='string','CLAUDE_NATIVE_ASSISTANT_TEXT');assistantText=assistantText||Boolean(b.text);emitOut({type:'item.completed',item:{type:'agent_message',text:b.text}});}
        else if(b.type==='thinking'||b.type==='redacted_thinking')continue;
        else if(b.type==='tool_use'){
          check(good(b.name)&&plain(b.input)&&typeof b.id==='string'&&ID.test(b.id)&&!toolIds.has(b.id),'CLAUDE_NATIVE_ASSISTANT_TOOL_USE');
          scope.registerTool(b.id,b.name,parent);toolIds.add(b.id);
          emitOut({type:'item.completed',item:{type:'command_execution',command:b.name+' '+canonical(b.input,LIMITS).slice(0,4096)}});
        }
        else throw failure('CLAUDE_NATIVE_ASSISTANT_CONTENT');
      }return;
    }
    if(f.type==='user'){
      const parent=scope.assertParent(Object.hasOwn(f,'parent_tool_use_id')?f.parent_tool_use_id:null);
      check(plain(f.message)&&f.message.role==='user'&&(typeof f.message.content==='string'||Array.isArray(f.message.content)),'CLAUDE_NATIVE_USER_ENVELOPE');
      if(scope.consumeUser(parent,f.message.content)==='prompt')return;
      if(Array.isArray(f.message.content))for(const b of f.message.content){
        check(plain(b)&&b.type==='tool_result'&&typeof b.tool_use_id==='string'&&toolIds.has(b.tool_use_id)&&!toolResults.has(b.tool_use_id),'CLAUDE_NATIVE_TOOL_RESULT_INVALID');
        check(typeof b.content==='string'||Array.isArray(b.content),'CLAUDE_NATIVE_TOOL_RESULT_CONTENT');if(b.is_error!==undefined)check(typeof b.is_error==='boolean','CLAUDE_NATIVE_TOOL_RESULT_ERROR');
        toolResults.add(b.tool_use_id);
        // Internal owner event, bounded by the strict decoder; never authority.
        proc.emit('toolResult',JSON.parse(JSON.stringify({toolUseId:b.tool_use_id,isError:b.is_error===true,content:b.content})));
      }return;
    }
    if(f.type==='result'){
      const usage=resultUsage(f);
      proc.usage=usage;
      denied=denied||Boolean(f.permission_denials?.length)||pending.size>0;
      if(!assistantText&&typeof f.result==='string'&&f.result)emitOut({type:'item.completed',item:{type:'agent_message',text:f.result}});
      result={complete:f.subtype==='success'&&!f.is_error&&!denied};closing=true;stopIdle();clearPending();ending=true;endInput();
      graceTimer=timer(()=>fail('CLAUDE_NATIVE_EXIT_TIMEOUT'),graceMs);return;
    }
    throw failure('CLAUDE_NATIVE_FRAME_UNSUPPORTED');
  }
  function data(chunk){safely(()=>{
    check(Buffer.isBuffer(chunk),'CLAUDE_NATIVE_OUTPUT_CHUNK_INVALID');totalBytes+=chunk.length;check(totalBytes<=LIMITS.maxRunBytes,'CLAUDE_NATIVE_RUN_LIMIT');
    buffer=Buffer.concat([buffer,chunk]);let at;
    while((at=buffer.indexOf(10))!==-1){
      let line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);if(line.at(-1)===13)line=line.subarray(0,-1);
      if(!line.length)continue;check(line.length<=LIMITS.maxFrameBytes&&++frames<=LIMITS.maxFrames,'CLAUDE_NATIVE_FRAME_LIMIT');
      frame(decode(line,LIMITS));if(errorCode)return;activity();
    }
    check(buffer.length<=LIMITS.maxFrameBytes,'CLAUDE_NATIVE_FRAME_LIMIT');
  });}
  function close(code,signal){
    if(closed)return;
    stopIdle();for(const t of timers)clearTimeout(t);clearPending();
    const receipt=child?.cleanupReceipt;
    const cleanup=receipt?.rootExited===true&&receipt?.ownedTreeEmpty===true&&receipt?.cleanupVerified===true&&receipt?.exitCode===code;
    if(!errorCode){
      if(buffer.length||!outEnded||!errEnded)errorCode='CLAUDE_NATIVE_TRUNCATED_OUTPUT';
      else if(!cleanup)errorCode='CLAUDE_NATIVE_CLEANUP_UNVERIFIED';
      else if(code!==0||signal)errorCode=o.resume&&spawned&&!systemInit&&!cancelled?'CLAUDE_NATIVE_RESUME_FAILED':'CLAUDE_NATIVE_EXIT_UNSUCCESSFUL';
      else if(!ready||!promptSent||!result?.complete||denied)errorCode='CLAUDE_NATIVE_INCOMPLETE';
    }
    const complete=!errorCode&&!cancelled;
    try{emitOut(complete?{type:'turn.completed',usage:proc.usage||{}}:{type:'turn.failed',error:{message:errorCode||'CLAUDE_NATIVE_INCOMPLETE'}});}catch{errorCode=errorCode||'CLAUDE_NATIVE_OUTPUT_LIMIT';}
    closed=true;proc.cleanupReceipt=cleanup?{...receipt}:null;
    if(!ready)readyReject(failure(errorCode||'CLAUDE_NATIVE_INIT_FAILED'));
    proc.stdin.destroy();proc.stdout.end();proc.stderr.end();
    completeResolve({responseComplete:!errorCode&&!cancelled,cleanupVerified:cleanup,sessionId:o.sessionId,errorCode,cancelled});
    proc.emit('close',!errorCode&&!cancelled?0:typeof code==='number'&&code!==0?code:1,signal??null);
  }
  proc.kill=()=>{if(closed)return false;cancelled=true;fail('CLAUDE_NATIVE_CANCELLED');return true;};
  proc.stdin.on('data',b=>safely(()=>{promptBytes+=b.length;check(promptBytes<=LIMITS.maxPromptBytes,'CLAUDE_NATIVE_PROMPT_LIMIT');promptChunks.push(Buffer.from(b));}));
  proc.stdin.on('end',()=>safely(()=>{promptEOF=true;prompt();}));proc.stdin.on('error',()=>fail('CLAUDE_NATIVE_INPUT_ERROR'));
  const initTimer=timer(()=>fail('CLAUDE_NATIVE_INIT_TIMEOUT'),initMs);
  timer(()=>fail('CLAUDE_NATIVE_WALL_TIMEOUT'),wallMs);
  // Deferred to let the caller attach all observers and supply prompt bytes.
  queueMicrotask(async()=>{
    if(cancelled){close(1,null);return;}
    try{
      const c=await o.openEndpoint(buildArgs(o));
      check(c&&typeof c.on==='function'&&typeof c.kill==='function','CLAUDE_NATIVE_ENDPOINT');
      child=c;
      c.on('error',()=>fail('CLAUDE_NATIVE_CHILD_ERROR'));
      c.once('close',(code,signal)=>setImmediate(()=>close(code,signal)));
      check(good(c.backendId)&&c.stdin instanceof Writable&&c.stdout instanceof Readable&&c.stderr instanceof Readable&&c.stdout!==c.stderr,'CLAUDE_NATIVE_ENDPOINT');
      const streams=[c.stdin,c.stdout,c.stderr];
      check(streams.every(s=>!claimed.has(s)&&!s.destroyed)&&!c.stdin.writableEnded&&!c.stdout.readableEnded&&!c.stderr.readableEnded,'CLAUDE_NATIVE_ENDPOINT_REUSED');
      for(const s of [c.stdout,c.stderr])check(!s.readableEncoding&&s.readableFlowing!==true&&s.listenerCount('data')===0&&s.listenerCount('readable')===0,'CLAUDE_NATIVE_ENDPOINT_REUSED');
      streams.forEach(s=>claimed.add(s));
      c.stdout.on('data',data);c.stdout.on('end',()=>{outEnded=true;if(buffer.length)fail('CLAUDE_NATIVE_TRUNCATED_OUTPUT');});
      c.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>65536)fail('CLAUDE_NATIVE_STDERR_LIMIT');});c.stderr.on('end',()=>{errEnded=true;});
      for(const s of streams)s.on('error',()=>fail('CLAUDE_NATIVE_STREAM_ERROR'));
      c.stdin.on('drain',()=>{if(current){current.drained=true;current.needDrain=false;writeDone(current);}});
      c.once('spawn',()=>safely(()=>{check(!spawned,'CLAUDE_NATIVE_DUPLICATE_SPAWN');spawned=true;activity();proc.pid=c.pid;proc.commandPid=c.commandPid;proc.emit('spawn');send({type:'control_request',request_id:initId,request:{subtype:'initialize',hooks:{}}});pump();}));
      if(errorCode||cancelled)kill();
    }catch{if(child){fail('CLAUDE_NATIVE_ENDPOINT_FAILED');}else{errorCode=errorCode||'CLAUDE_NATIVE_ENDPOINT_FAILED';close(1,null);}}
  });
  return proc;
}
module.exports={start,buildArgs,LIMITS};
