'use strict';
const {MAX_WALL_MS,IDLE_MS}=require('./native-turn-limits');
// Sonnet adapter reviewed by Codex: owner supplies the admitted, supervised
// endpoint. This module has no spawn, environment, filesystem or auth access.
const {EventEmitter}=require('node:events');
const {PassThrough,Readable,Writable}=require('node:stream');
const {randomUUID}=require('node:crypto');
const {TextDecoder}=require('node:util');
const {decode,canonical}=require('./providers/claude-protocol');
const {describeResponse}=require('./providers/rpc-response-diagnostic');
const {classifyWatcherAck}=require('./providers/grok-internal-notice');
const {nextToolState}=require('./providers/grok-tool-state');
const {createScope,isTerminalToolStatus}=require('./grok-subagent-context');
const {createDeferredPermissions}=require('./grok-deferred-permissions');
const LIMITS=Object.freeze({maxFrameBytes:1048576,maxRunBytes:16777216,maxFrames:4096,
  maxStringBytes:262144,maxDepth:24,maxNodes:32768,maxPromptBytes:65536,maxOutputBytes:2097152});
const claimed=new WeakSet();
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const good=x=>typeof x==='string'&&x.length>0&&x.isWellFormed()&&!x.includes('\0');
const failure=code=>Object.assign(Error(code),{code});
const check=(value,code='GROK_NATIVE_PROTOCOL')=>{if(!value)throw failure(code);};
function buildArgs(o){return ['agent','--no-leader',...(o.model===''?[]:['--model',o.model]),'--effort',o.effort,'stdio'];}
function start(o){
  check(plain(o),'GROK_NATIVE_OPTIONS');
  check(o.model===''||good(o.model)&&o.model.length<=32760,'GROK_NATIVE_OPTIONS');
  for(const k of ['effort','project','task','runId','cwd'])check(good(o[k])&&o[k].length<=32760,'GROK_NATIVE_OPTIONS');
  check(typeof o.resume==='boolean'&&typeof o.openEndpoint==='function'&&(o.resume?typeof o.sessionId==='string'&&ID.test(o.sessionId):o.sessionId===null),'GROK_NATIVE_OPTIONS');
  check(o.onSession===undefined||typeof o.onSession==='function','GROK_NATIVE_OPTIONS');
  check(Array.isArray(o.validatedMcpServers),'GROK_NATIVE_OPTIONS');
  // No inference of trust from this field name: admission belongs to the owner.
  const mcpServers=JSON.parse(canonical(o.validatedMcpServers,LIMITS));
  if(o.validatedAgentProfile!==undefined)check(plain(o.validatedAgentProfile),'GROK_NATIVE_OPTIONS');
  const agentProfile=o.validatedAgentProfile===undefined?undefined:JSON.parse(canonical(o.validatedAgentProfile,LIMITS));
  const cap=(key,fallback,max)=>{const v=o[key]??fallback;check(Number.isSafeInteger(v)&&v>=1&&v<=max,'GROK_NATIVE_OPTIONS');return v;};
  const wallMs=cap('maxWallMs',MAX_WALL_MS,MAX_WALL_MS),initMs=cap('initTimeoutMs',30000,30000),
    idleMs=cap('idleTimeoutMs',IDLE_MS,IDLE_MS),approvalMs=cap('approvalTimeoutMs',600000,600000),graceMs=cap('graceMs',5000,5000);
  const proc=new EventEmitter();Object.assign(proc,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true,requiresCleanupReceipt:true,cleanupReceipt:null});
  let readyResolve,readyReject,completeResolve;
  proc.ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;});proc.ready.catch(()=>{});
  proc.completion=new Promise(r=>{completeResolve=r;});
  let child=null,closed=false,closing=false,cancelled=false,errorCode=null,spawned=false,ready=false,
    initAck=false,systemInit=false,promptSent=false,promptEOF=false,result=null,denied=false,
    outEnded=false,errEnded=false,assistantText=false,outputBytes=0,stderrBytes=0;
  let sessionId=o.sessionId,phase='initialize',bootstrapSessionId=null,reply='',sessionScope=null;
  const initId='hub-init-'+randomUUID(),pending=new Map(),requestIds=new Set(),clientIds=new Set(),calls=new Map(),tools=new Map(),previewedTools=new Set();
  const deferredPermissions=createDeferredPermissions(16);
  const internalNotices={skills:0,workflows:0};
  Object.defineProperty(proc,'internalNoticeSummary',{get:()=>Object.freeze({...internalNotices})});
  let promptChunks=[],promptBytes=0,buffer=Buffer.alloc(0),totalBytes=0,frames=0,graceTimer=null;
  const queue=[];let current=null,queuedBytes=0,ending=false;
  let idleTimer=null;
  function stopIdle(){clearTimeout(idleTimer);idleTimer=null;}
  function activity(){
    if(!spawned||closed||closing||errorCode)return;
    stopIdle();idleTimer=setTimeout(()=>fail('GROK_NATIVE_IDLE_TIMEOUT'),idleMs);
  }
  const timers=[];
  const timer=(fn,ms)=>{const t=setTimeout(fn,ms);timers.push(t);return t;};
  function emitOut(row){if(closed)return;const s=JSON.stringify(row)+'\n';outputBytes+=Buffer.byteLength(s);check(outputBytes<=LIMITS.maxOutputBytes,'GROK_NATIVE_OUTPUT_LIMIT');proc.stdout.write(s);}
  function publish(){if(!closed)try{proc.emit('approvals',proc.listApprovals());}catch{errorCode=errorCode||'GROK_NATIVE_OWNER_EVENT_FAILED';closing=true;kill();}}
  function clearPending(){for(const p of pending.values())clearTimeout(p.timer);pending.clear();for(const entry of deferredPermissions.clear())clearTimeout(entry.record.timer);publish();}
  function kill(){stopIdle();if(child&&!closed){try{child.kill();}catch{errorCode=errorCode||'GROK_NATIVE_STOP_FAILED';}}}
  function fail(code){
    if(closed)return;errorCode=errorCode||code;closing=true;
    queue.length=0;queuedBytes=current?current.bytes.length:0;clearPending();
    if(!ready)readyReject(failure(errorCode));kill();
  }
  function safely(fn){if(closed||errorCode)return;try{fn();}catch(e){fail(typeof e?.code==='string'&&/^GROK_NATIVE_[A-Z_]+$/.test(e.code)?e.code:'GROK_NATIVE_PROTOCOL');}}
  function endInput(){if(ending&&child&&!current&&!queue.length&&!child.stdin.writableEnded){try{child.stdin.end();}catch{fail('GROK_NATIVE_WRITE_FAILED');}}}
  function writeDone(op){
    if(current!==op||!op.returned||!op.callback||op.needDrain||closed)return;
    queuedBytes-=op.bytes.length;current=null;pump();
  }
  function pump(){
    if(closed||errorCode||current||!child||!spawned)return;
    if(!queue.length){endInput();return;}
    const op={bytes:queue.shift(),callback:false,returned:false,needDrain:false,drained:false};current=op;
    try{
      const accepted=child.stdin.write(op.bytes,e=>{if(e){fail('GROK_NATIVE_WRITE_FAILED');return;}op.callback=true;writeDone(op);});
      op.returned=true;op.needDrain=!accepted&&!op.drained;writeDone(op);
    }catch{fail('GROK_NATIVE_WRITE_FAILED');}
  }
  function send(row){
    check(!closed&&!errorCode&&!ending,'GROK_NATIVE_WRITE_CLOSED');const b=Buffer.from(canonical(row,LIMITS)+'\n');
    check(queue.length+(current?1:0)<32&&queuedBytes+b.length<=1048576,'GROK_NATIVE_WRITE_LIMIT');
    queue.push(b);queuedBytes+=b.length;pump();
  }
  const rpcId=id=>typeof id==='string'?ID.test(id):Number.isSafeInteger(id)&&id>=0;
  const key=id=>typeof id+':'+id;
  function request(method,params,handler){
    const id='hub-rpc-'+randomUUID();clientIds.add(key(id));calls.set(key(id),{method,handler});
    send({jsonrpc:'2.0',id,method,params});return id;
  }
  function bindSession(value){
    check(plain(value),'GROK_NATIVE_SESSION_INVALID');
    if(o.resume){if(Object.hasOwn(value,'sessionId'))check(value.sessionId===sessionId,'GROK_NATIVE_SESSION_MISMATCH');}
    else {check(typeof value.sessionId==='string'&&ID.test(value.sessionId),'GROK_NATIVE_SESSION_INVALID');sessionId=value.sessionId;}
    check(bootstrapSessionId===null||bootstrapSessionId===sessionId,'GROK_NATIVE_SESSION_MISMATCH');
    const m=value.models;check(plain(m)&&good(m.currentModelId),'GROK_NATIVE_MODEL_UNVERIFIED');
    const selectedModel=o.model===''?m.currentModelId:o.model;
    if(o.model==='')check(ID.test(selectedModel),'GROK_NATIVE_MODEL_UNVERIFIED');
    const finish=()=>{
      sessionScope=createScope(sessionId,selectedModel,Array.isArray(agentProfile?.tools)&&agentProfile.tools.includes('task'),o.model==='');
      if(o.onSession)try{
        const r=o.onSession(Object.freeze({project:o.project,task:o.task,runId:o.runId,sessionId}));
        if(r&&typeof r.then==='function')Promise.resolve(r).catch(()=>{});
        check(r===undefined,'GROK_NATIVE_SESSION_BINDING_FAILED');
      }catch{throw failure('GROK_NATIVE_SESSION_BINDING_FAILED');}
      phase='ready';ready=true;systemInit=true;clearTimeout(initTimer);proc.reportedModel=selectedModel;
      emitOut({type:'thread.started',thread_id:sessionId});readyResolve(true);prompt();};
    if(o.model===''||m.currentModelId===o.model){finish();return;}
    check(Array.isArray(m.availableModels)&&m.availableModels.some(r=>plain(r)&&r.modelId===o.model),'GROK_NATIVE_MODEL_UNAVAILABLE');
    phase='select-model';
    request('session/set_model',{sessionId,modelId:o.model},r=>{check(plain(r),'GROK_NATIVE_MODEL_UNVERIFIED');finish();});
  }
  function initialize(value){
    check(plain(value)&&value.protocolVersion===1&&plain(value.agentCapabilities),'GROK_NATIVE_INIT_ACK');
    initAck=true;phase='session';proc.initialized=true;
    if(o.resume)check(value.agentCapabilities.loadSession===true,'GROK_NATIVE_RESUME_UNAVAILABLE');
    request(o.resume?'session/load':'session/new',{...(o.resume?{sessionId}:{}),cwd:o.cwd,mcpServers,
      ...(agentProfile===undefined?{}:{_meta:{agentProfile}})},bindSession);
  }
  function prompt(){
    if(!spawned||!ready||!promptEOF||promptSent||errorCode||closed)return;
    check(promptBytes>0&&promptBytes<=LIMITS.maxPromptBytes,'GROK_NATIVE_PROMPT_INVALID');
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(promptChunks));}catch{throw failure('GROK_NATIVE_PROMPT_INVALID');}
    check(good(text)&&!text.startsWith('\ufeff'),'GROK_NATIVE_PROMPT_INVALID');promptChunks=[];promptSent=true;
    request('session/prompt',{sessionId,prompt:[{type:'text',text}]},r=>{
      check(plain(r)&&['end_turn','max_tokens','max_turn_requests','refusal','cancelled'].includes(r.stopReason),'GROK_NATIVE_RESULT_INVALID');
      denied=denied||pending.size>0||deferredPermissions.size()>0;
      // Protocol completion preserves failed tool events. Task success is a
      // separate assertion; an unfinished tool or owner refusal still blocks.
      result={complete:r.stopReason==='end_turn'&&!denied&&[...tools.values()].every(t=>isTerminalToolStatus(t.status))};
      closing=true;stopIdle();clearPending();ending=true;endInput();graceTimer=timer(()=>fail('GROK_NATIVE_EXIT_TIMEOUT'),graceMs);
    });
  }
  function permissionResponse(p,decision){
    if(decision!=='accept')denied=true;
    const outcome=decision==='cancel'?{outcome:'cancelled'}:{outcome:'selected',optionId:p.options.find(x=>x.kind===(decision==='accept'?'allow_once':'reject_once')).optionId};
    send({jsonrpc:'2.0',id:p.requestId,result:{outcome}});activity();
  }
  function assertKnownSession(value,code='GROK_NATIVE_SESSION_MISMATCH'){
    check(typeof value==='string'&&ID.test(value),code);
    try{sessionScope.assertSession(value);}catch{throw failure(code);}
  }
  function scopeAction(action){try{return action();}catch{throw failure('GROK_NATIVE_SUBAGENT_SCOPE');}}
  function toolUpdate(u,initial=false,permission=false,context){
    check(plain(u),'GROK_NATIVE_TOOL_INVALID');
    assertKnownSession(context?.sessionId);
    const next=nextToolState(tools.get(u.toolCallId),u,{initial,permission,locked:previewedTools.has(u.toolCallId)});
    // Only fixed runtime tool metadata can identify an initial native Task.
    // Model rawInput, display descriptions and text cannot mint child scope.
    const meta=u._meta?.['x.ai/tool'];
    const nativeTask=plain(meta)&&meta.version===1&&meta.namespace==='grok_build'&&
      meta.name==='spawn_subagent'&&meta.kind==='task';
    const promptId=nativeTask?context?._meta?.promptId:undefined;
    scopeAction(()=>sessionScope.observeTool(context.sessionId,next.toolCallId,nativeTask?'task':undefined,promptId,next.status));
    tools.set(u.toolCallId,next);return next;
  }
  function permission(f){
    check(ready&&promptSent&&!result,'GROK_NATIVE_PERMISSION_STATE');const id=f.id,p=f.params;
    check(rpcId(id)&&!clientIds.has(key(id))&&!requestIds.has(key(id)),'GROK_NATIVE_PERMISSION_REPLAY');requestIds.add(key(id));
    check(plain(p)&&Array.isArray(p.options)&&p.options.length>=2&&p.options.length<=16,'GROK_NATIVE_PERMISSION_INVALID');
    assertKnownSession(p.sessionId,'GROK_NATIVE_PERMISSION_INVALID');
    const ids=new Set();for(const x of p.options){check(plain(x)&&typeof x.optionId==='string'&&ID.test(x.optionId)&&good(x.name)&&
      ['allow_once','allow_always','reject_once','reject_always'].includes(x.kind)&&!ids.has(x.optionId),'GROK_NATIVE_PERMISSION_INVALID');ids.add(x.optionId);}
    for(const kind of ['allow_once','reject_once'])check(p.options.filter(x=>x.kind===kind).length===1,'GROK_NATIVE_PERMISSION_ONCE_REQUIRED');
    check(plain(p.toolCall)&&typeof p.toolCall.toolCallId==='string'&&ID.test(p.toolCall.toolCallId),'GROK_NATIVE_PERMISSION_INVALID');
    check(!['completed','failed'].includes(p.toolCall.status),'GROK_NATIVE_PERMISSION_INVALID');
    check(Buffer.byteLength(canonical(p.toolCall,LIMITS))<=131072,'GROK_NATIVE_PERMISSION_LIMIT');
    check(pending.size+deferredPermissions.size()<16,'GROK_NATIVE_PERMISSION_LIMIT');
    activatePermission(id,p,Date.now()+approvalMs,true);
  }
  function activatePermission(id,p,expiresAt,mayWait){
    check(Date.now()<expiresAt,'GROK_NATIVE_PERMISSION_STATE');
    const owner=scopeAction(()=>sessionScope.permissionSession(p.sessionId,p.toolCall.toolCallId));
    if(owner===null){
      // A reverse request cannot establish tool ownership or Task prompt scope.
      // Wait for the ordinary native notification, under the original deadline.
      check(mayWait,'GROK_NATIVE_PERMISSION_STATE');
      const record={id,params:p,timer:null};
      try{deferredPermissions.add(randomUUID(),p.toolCall.toolCallId,record,expiresAt);}catch{throw failure('GROK_NATIVE_PERMISSION_REPLAY');}
      record.timer=timer(()=>{
        if(closed||errorCode)return;
        if(deferredPermissions.takeForTool(p.toolCall.toolCallId).length){denied=true;fail('GROK_NATIVE_PERMISSION_STATE');}
      },Math.max(1,expiresAt-Date.now()));
      return;
    }
    // Child CLI tools inherit the ancestor's native permission transport. Resolve
    // only an already registered owner; ordinary notifications remain exact.
    const t=toolUpdate(p.toolCall,false,true,{...p,sessionId:owner});
    // Controller-owned identity set. Incoming metadata cannot release a preview
    // lock or rewrite the exact input already shown to the owner.
    previewedTools.add(t.toolCallId);
    const detail=canonical(t,LIMITS);check(Buffer.byteLength(detail)<=131072,'GROK_NATIVE_PERMISSION_LIMIT');
    const token=randomUUID(),item={requestId:id,options:p.options,
      public:{token,kind:'tool',reason:'工具操作需要 owner 核准',detail,expiresAt,project:o.project,task:o.task,runId:o.runId,sessionId},expiresAt};
    item.timer=timer(()=>{if(!pending.has(token)||closed||errorCode)return;pending.delete(token);safely(()=>permissionResponse(item,'decline'));publish();},Math.max(1,expiresAt-Date.now()));
    pending.set(token,item);publish();
  }
  function activateDeferredPermissions(toolCallId){
    for(const entry of deferredPermissions.takeForTool(toolCallId)){
      clearTimeout(entry.record.timer);
      activatePermission(entry.record.id,entry.record.params,entry.expiresAt,false);
    }
  }
  proc.listApprovals=()=>[...pending.values()].map(p=>({...p.public}));
  proc.respond=(token,decision)=>{
    check(!closed&&!errorCode&&!closing,'GROK_NATIVE_APPROVAL_CLOSED');check(['accept','decline','cancel'].includes(decision),'GROK_NATIVE_APPROVAL_DECISION');
    const p=pending.get(token);check(p,'GROK_NATIVE_APPROVAL_UNKNOWN');pending.delete(token);clearTimeout(p.timer);
    if(Date.now()>=p.expiresAt){safely(()=>permissionResponse(p,'decline'));publish();throw failure('GROK_NATIVE_APPROVAL_EXPIRED');}
    safely(()=>permissionResponse(p,decision));publish();return true;
  };
  const metadata=new Set(['plan','available_commands_update','current_mode_update','config_option_update','session_info_update','usage_update']);
  function bootstrapUpdate(p){
    check(['session','select-model'].includes(phase),'GROK_NATIVE_UPDATE_STATE');
    check(plain(p)&&typeof p.sessionId==='string'&&ID.test(p.sessionId)&&plain(p.update),'GROK_NATIVE_SESSION_MISMATCH');
    if(sessionId!==null)check(p.sessionId===sessionId,'GROK_NATIVE_SESSION_MISMATCH');
    else if(bootstrapSessionId===null)bootstrapSessionId=p.sessionId;
    else check(bootstrapSessionId===p.sessionId,'GROK_NATIVE_SESSION_MISMATCH');
    const u=p.update;
    if(metadata.has(u.sessionUpdate))return;
    // ACP session/load replays history before its response. Consume the bound
    // history as inert data: never expose old replies as this turn's answer,
    // reconstruct pending approvals, or execute a historical tool again.
    check(o.resume&&phase==='session','GROK_NATIVE_UPDATE_BEFORE_PROMPT');
    if(['user_message_chunk','agent_message_chunk','agent_thought_chunk'].includes(u.sessionUpdate)){
      check(plain(u.content)&&['text','image','audio','resource','resource_link'].includes(u.content.type),'GROK_NATIVE_CONTENT');
      if(u.content.type==='text')check(typeof u.content.text==='string','GROK_NATIVE_CONTENT');
      return;
    }
    check(['tool_call','tool_call_update'].includes(u.sessionUpdate)&&typeof u.toolCallId==='string'&&ID.test(u.toolCallId),'GROK_NATIVE_UPDATE_UNSUPPORTED');
    if(u.status!==undefined)check(['pending','in_progress','completed','failed'].includes(u.status),'GROK_NATIVE_TOOL_STATE');
    if(u.rawInput!==undefined)check(plain(u.rawInput),'GROK_NATIVE_TOOL_INPUT');
    if(u.content!==undefined)check(Array.isArray(u.content),'GROK_NATIVE_TOOL_CONTENT');
  }
  function update(p){
    if(!ready){bootstrapUpdate(p);return;}
    check(ready&&plain(p)&&plain(p.update),'GROK_NATIVE_SESSION_MISMATCH');assertKnownSession(p.sessionId);const u=p.update;
    if(metadata.has(u.sessionUpdate)){
      if(u.sessionUpdate==='config_option_update'&&Array.isArray(u.configOptions)){
        for(const option of u.configOptions)if(plain(option)&&option.id==='model'){
          check(option.currentValue===proc.reportedModel,'GROK_NATIVE_MODEL_MISMATCH');
        }
      }
      return;
    }
    check(promptSent,'GROK_NATIVE_UPDATE_BEFORE_PROMPT');
    if(u.sessionUpdate==='user_message_chunk'){
      check(plain(u.content)&&u.content.type==='text'&&typeof u.content.text==='string','GROK_NATIVE_CONTENT');return;
    }
    if(u.sessionUpdate==='agent_message_chunk'){
      check(plain(u.content)&&u.content.type==='text'&&typeof u.content.text==='string','GROK_NATIVE_CONTENT');
      if(p.sessionId!==sessionId)return;
      reply+=u.content.text;
      check(Buffer.byteLength(reply)<=1048576,'GROK_NATIVE_OUTPUT_LIMIT');emitOut({type:'hub.agent_snapshot',id:'reply',text:reply});return;
    }
    if(u.sessionUpdate==='agent_thought_chunk'){check(plain(u.content));return;}
    if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
      const {sessionUpdate,...fields}=u,t=toolUpdate(fields,u.sessionUpdate==='tool_call',false,p);
      emitOut({type:'item.completed',item:{type:'command_execution',command:String(t.title||t.toolCallId).slice(0,4096)}});
      proc.emit('toolState',JSON.parse(JSON.stringify(t)));activateDeferredPermissions(t.toolCallId);return;
    }
    check(metadata.has(u.sessionUpdate),'GROK_NATIVE_UPDATE_UNSUPPORTED');
  }
  function frame(f){
    check(plain(f)&&f.jsonrpc==='2.0','GROK_NATIVE_PROTOCOL');
    // The fixed native stdio runtime injects its own watcher requests into the
    // ACP stream. Their exact passive ACKs have no client call to resolve.
    // Discard only these documented shapes; they never become run authority,
    // tool approval, session/model state or a successful prompt response.
    const notice=classifyWatcherAck(f);
    if(notice){check(internalNotices.skills+internalNotices.workflows<64,'GROK_NATIVE_NOTICE_LIMIT');internalNotices[notice]++;return;}
    // Custom notifications remain inert even during orderly shutdown. An id,
    // result or error prevents this path; none can grant authority or success.
    if(typeof f.method==='string'&&f.method.startsWith('_')&&!Object.hasOwn(f,'id')&&
       !Object.hasOwn(f,'result')&&!Object.hasOwn(f,'error')){
      if(f.params!==undefined)check(plain(f.params));
      // A current-session authentication failure can only stop this run. It
      // never authorizes refresh, widens egress, or exposes the remote reason.
      // Avoid the CLI's repeated credential-less requests on a known failure.
      const p=f.params,u=p?.update;
      if(!result&&ready&&promptSent&&f.method==='_x.ai/session_notification'&&plain(p)&&plain(u)&&u.sessionUpdate==='subagent_spawned'){
        assertKnownSession(p.sessionId);
        for(const key of ['parent_session_id','parent_prompt_id','child_session_id','subagent_id','attempt_id'])
          check(typeof u[key]==='string'&&ID.test(u[key]),'GROK_NATIVE_SUBAGENT_SCOPE');
        scopeAction(()=>sessionScope.admitChild(p.sessionId,u.parent_session_id,u.parent_prompt_id,
          u.child_session_id,u.subagent_id,u.attempt_id,u.model));
        return;
      }
      if(!result&&promptSent&&['_x.ai/session_notification','_x.ai/session/update'].includes(f.method)&&
         plain(p)&&plain(u)&&u.sessionUpdate==='retry_state'){
        // Foreign custom metadata is inert; only a bound root/child may stop
        // its own run for authentication. This grants no session authority.
        try{assertKnownSession(p?.sessionId);}catch{return;}
        const excluded=u.error_type==='legacy_auth'||u.error_type==='auth_transient';
        const auth=(text='')=>!excluded&&(u.error_type==='auth'||typeof text==='string'&&text.includes('Unauthorized (401)'));
        if(u.type==='retrying'&&!excluded&&
           ((typeof u.reason==='string'&&u.reason.startsWith('Re-authenticating after 401'))||auth(u.reason)))
          throw failure('GROK_NATIVE_AUTH_UNAVAILABLE');
        if(u.type==='failed'&&auth(u.message))throw failure('GROK_NATIVE_AUTH_UNAVAILABLE');
        if(u.type==='exhausted')throw failure(u.is_rate_limited===true?'GROK_NATIVE_RATE_LIMITED':'GROK_NATIVE_RETRY_EXHAUSTED');
      }
      return;
    }
    check(!result,'GROK_NATIVE_AFTER_RESULT');
    if(Object.hasOwn(f,'method')){
      check(typeof f.method==='string'&&!Object.hasOwn(f,'result')&&!Object.hasOwn(f,'error'));
      if(Object.hasOwn(f,'id')){
        if(f.method==='session/request_permission'){permission(f);return;}
        check(rpcId(f.id),'GROK_NATIVE_PROTOCOL');send({jsonrpc:'2.0',id:f.id,error:{code:-32601,message:'Unsupported client request'}});
        throw failure('GROK_NATIVE_REVERSE_UNSUPPORTED');
      }
      if(f.method==='session/update'){update(f.params);return;}
      if(f.method.startsWith('_')){
        // ACP v1 extensibility: unknown custom notifications are inert. They
        // never create sessions, approvals, tool results or completion state.
        // Requests carrying an id are handled above and remain denied.
        if(f.params!==undefined)check(plain(f.params));return;
      }
      // Owner diagnostic contains only a syntactically bounded method name,
      // never the frame payload, auth state or remote error text.
      proc.lastUnsupportedMethod=/^[A-Za-z_][A-Za-z0-9._/-]{0,127}$/.test(f.method)?f.method:null;
      throw failure('GROK_NATIVE_NOTIFICATION_UNSUPPORTED');
    }
    const responseKey=rpcId(f.id)?key(f.id):null,call=responseKey===null?null:calls.get(responseKey);
    if(!call)proc.lastResponseDiagnostic=describeResponse(f,{
      idRelation:clientIds.has(responseKey)?'already-replied':requestIds.has(responseKey)?'server-request':'unknown',
      pendingMethods:[...calls.values()].map(c=>c.method)
    });
    check(rpcId(f.id)&&Object.hasOwn(f,'result')!==Object.hasOwn(f,'error'),'GROK_NATIVE_RESPONSE_INVALID');
    check(call,'GROK_NATIVE_RESPONSE_UNKNOWN');calls.delete(responseKey);
    if(Object.hasOwn(f,'error')){
      const code=plain(f.error)&&Number.isSafeInteger(f.error.code)?f.error.code:null;
      proc.remoteError={method:call.method,code};
      throw failure(code===-32000?'GROK_NATIVE_AUTH_UNAVAILABLE':o.resume&&!ready&&call.method==='session/load'?'GROK_NATIVE_RESUME_FAILED':'GROK_NATIVE_REMOTE_ERROR');
    }
    call.handler(f.result);
  }
  function data(chunk){safely(()=>{
    check(Buffer.isBuffer(chunk));totalBytes+=chunk.length;check(totalBytes<=LIMITS.maxRunBytes,'GROK_NATIVE_RUN_LIMIT');buffer=Buffer.concat([buffer,chunk]);let at;
    while((at=buffer.indexOf(10))!==-1){let line=buffer.subarray(0,at);buffer=buffer.subarray(at+1);if(line.at(-1)===13)line=line.subarray(0,-1);
      if(!line.length)continue;check(line.length<=LIMITS.maxFrameBytes&&++frames<=LIMITS.maxFrames,'GROK_NATIVE_FRAME_LIMIT');frame(decode(line,LIMITS));if(errorCode)return;activity();}
    check(buffer.length<=LIMITS.maxFrameBytes,'GROK_NATIVE_FRAME_LIMIT');
  });}
  function close(code,signal){
    if(closed)return;
    stopIdle();for(const t of timers)clearTimeout(t);clearPending();
    const receipt=child?.cleanupReceipt;
    const cleanup=receipt?.rootExited===true&&receipt?.ownedTreeEmpty===true&&receipt?.cleanupVerified===true&&receipt?.exitCode===code;
    if(!errorCode){
      if(buffer.length||!outEnded||!errEnded)errorCode='GROK_NATIVE_TRUNCATED_OUTPUT';
      else if(!cleanup)errorCode='GROK_NATIVE_CLEANUP_UNVERIFIED';
      else if(code!==0||signal)errorCode='GROK_NATIVE_EXIT_UNSUCCESSFUL';
      else if(!ready||!promptSent||!result?.complete||denied)errorCode='GROK_NATIVE_INCOMPLETE';
    }
    const complete=!errorCode&&!cancelled;
    try{emitOut(complete?{type:'turn.completed',usage:{}}:{type:'turn.failed',error:{message:errorCode||'GROK_NATIVE_INCOMPLETE'}});}catch{errorCode=errorCode||'GROK_NATIVE_OUTPUT_LIMIT';}
    closed=true;sessionScope?.dispose();proc.cleanupReceipt=cleanup?{...receipt}:null;
    if(!ready)readyReject(failure(errorCode||'GROK_NATIVE_INIT_FAILED'));
    proc.stdin.destroy();proc.stdout.end();proc.stderr.end();
    completeResolve({responseComplete:!errorCode&&!cancelled,cleanupVerified:cleanup,sessionId:sessionId,errorCode,cancelled});
    proc.emit('close',!errorCode&&!cancelled?0:typeof code==='number'&&code!==0?code:1,signal??null);
  }
  proc.kill=()=>{if(closed)return false;cancelled=true;fail('GROK_NATIVE_CANCELLED');return true;};
  proc.stdin.on('data',b=>safely(()=>{promptBytes+=b.length;check(promptBytes<=LIMITS.maxPromptBytes,'GROK_NATIVE_PROMPT_LIMIT');promptChunks.push(Buffer.from(b));}));
  proc.stdin.on('end',()=>safely(()=>{promptEOF=true;prompt();}));proc.stdin.on('error',()=>fail('GROK_NATIVE_INPUT_ERROR'));
  const initTimer=timer(()=>fail('GROK_NATIVE_INIT_TIMEOUT'),initMs);
  timer(()=>fail('GROK_NATIVE_WALL_TIMEOUT'),wallMs);
  // Deferred to let the caller attach all observers and supply prompt bytes.
  queueMicrotask(async()=>{
    if(cancelled){close(1,null);return;}
    try{
      const c=await o.openEndpoint(buildArgs(o));
      check(c&&typeof c.on==='function'&&typeof c.kill==='function','GROK_NATIVE_ENDPOINT');
      child=c;
      c.on('error',()=>fail('GROK_NATIVE_CHILD_ERROR'));
      c.once('close',(code,signal)=>setImmediate(()=>close(code,signal)));
      check(good(c.backendId)&&c.stdin instanceof Writable&&c.stdout instanceof Readable&&c.stderr instanceof Readable&&c.stdout!==c.stderr,'GROK_NATIVE_ENDPOINT');
      const streams=[c.stdin,c.stdout,c.stderr];
      check(streams.every(s=>!claimed.has(s)&&!s.destroyed)&&!c.stdin.writableEnded&&!c.stdout.readableEnded&&!c.stderr.readableEnded,'GROK_NATIVE_ENDPOINT_REUSED');
      for(const s of [c.stdout,c.stderr])check(!s.readableEncoding&&s.readableFlowing!==true&&s.listenerCount('data')===0&&s.listenerCount('readable')===0,'GROK_NATIVE_ENDPOINT_REUSED');
      streams.forEach(s=>claimed.add(s));
      c.stdout.on('data',data);c.stdout.on('end',()=>{outEnded=true;if(buffer.length)fail('GROK_NATIVE_TRUNCATED_OUTPUT');});
      c.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>65536)fail('GROK_NATIVE_STDERR_LIMIT');});c.stderr.on('end',()=>{errEnded=true;});
      for(const s of streams)s.on('error',()=>fail('GROK_NATIVE_STREAM_ERROR'));
      c.stdin.on('drain',()=>{if(current){current.drained=true;current.needDrain=false;writeDone(current);}});
      c.once('spawn',()=>safely(()=>{check(!spawned,'GROK_NATIVE_DUPLICATE_SPAWN');spawned=true;activity();proc.pid=c.pid;proc.commandPid=c.commandPid;proc.emit('spawn');request('initialize',{protocolVersion:1,clientInfo:{name:'project-hub',version:'4.68.2'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}},initialize);pump();}));
      if(errorCode||cancelled)kill();
    }catch{if(child){fail('GROK_NATIVE_ENDPOINT_FAILED');}else{errorCode=errorCode||'GROK_NATIVE_ENDPOINT_FAILED';close(1,null);}}
  });
  return proc;
}
module.exports={start,buildArgs,LIMITS};
