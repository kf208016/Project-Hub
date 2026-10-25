'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const {start,buildArgs}=require('../lib/grok-native-bridge');
const sid='synthetic-native-session',immediate=()=>new Promise(r=>setImmediate(r));
const options={project:'p',task:'t',runId:'r',cwd:'C:\\synthetic',model:'grok-selected',effort:'low',sessionId:null,resume:false,validatedMcpServers:[]};
const nativeTaskMeta={'x.ai/tool':{version:1,name:'spawn_subagent',kind:'task',namespace:'grok_build',read_only:false}};
function scopedUpdate(f,sessionId,update,promptId){
  f.push({jsonrpc:'2.0',method:'session/update',params:{sessionId,update,...(promptId?{_meta:{promptId}}:{})}});
}
function nativeTask(f,id='task-1',parent=sid,promptId='prompt-1'){
  scopedUpdate(f,parent,{sessionUpdate:'tool_call',toolCallId:id,title:'spawn_subagent',status:'pending',kind:'other',rawInput:{prompt:'synthetic child',background:false},_meta:nativeTaskMeta},promptId);
}
function announceChild(f,child='native-child',parent=sid,promptId='prompt-1',extra={}){
  f.push({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId:parent,update:{sessionUpdate:'subagent_spawned',parent_session_id:parent,parent_prompt_id:promptId,child_session_id:child,subagent_id:child,attempt_id:'attempt-'+child,model:options.model,...extra}}});
}
function initialWrite(f,id='tool-1',owner=sid){
  scopedUpdate(f,owner,{sessionUpdate:'tool_call',toolCallId:id,title:'synthetic write',kind:'edit',status:'pending',rawInput:{file:'a.txt',content:'x'}});
}
function routedPermission(f,id,transport,toolCall){
  f.push({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:transport,toolCall,options:[{optionId:'route-yes',name:'Allow once',kind:'allow_once'},{optionId:'route-no',name:'Reject once',kind:'reject_once'}]}});
}
function fixture(t,extra={}){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-backend'});
  let wire='',output='',ended=false,kills=0;c.kill=()=>{kills++;return true;};c.stdin.on('data',d=>wire+=d);
  const p=start({...options,...extra,openEndpoint:args=>{assert.deepEqual(args,buildArgs({...options,...extra}));setImmediate(()=>c.emit('spawn'));return c;}});
  p.stdout.on('data',d=>output+=d);p.stderr.resume();const closed=once(p,'close');
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push=v=>c.stdout.write(Buffer.from(JSON.stringify(v)+'\n'));
  const response=(req,result)=>push({jsonrpc:'2.0',id:req.id,result});
  function finish(code=0,receipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}){
    if(ended)return;ended=true;c.cleanupReceipt=receipt;c.stdout.end();c.stderr.end();c.emit('close',code,null);
  }
  t.after(async()=>{p.kill();finish(1,null);await closed;});
  async function init({load=true,model=options.model,availableModels=[],beforeOpenResponse}={}){
    p.stdin.end('synthetic prompt');await immediate();await immediate();const first=rows()[0];
    assert.equal(first.method,'initialize');assert.deepEqual(first.params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});
    response(first,{protocolVersion:1,agentCapabilities:{loadSession:load},extra:'inert'});
    await immediate();const open=rows().at(-1);
    if(extra.resume&&!load)return open;
    assert.equal(open.method,extra.resume?'session/load':'session/new');assert.deepEqual(open.params.mcpServers,[]);
    beforeOpenResponse?.();
    response(open,{...(!extra.resume?{sessionId:sid}:{}),models:{currentModelId:model,availableModels}});
    await immediate();return open;
  }
  const update=u=>push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:u}});
  const result=stopReason=>response(rows().findLast(r=>r.method==='session/prompt'),{stopReason:stopReason||'end_turn'});
  const permission=(id='server-1',status='pending')=>push({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:sid,
    toolCall:{toolCallId:'tool-1',title:'synthetic write',kind:'edit',status,rawInput:{file:'a.txt',content:'x'}},
    options:[{optionId:'dynamic-yes',name:'Allow once',kind:'allow_once'},{optionId:'dynamic-no',name:'Reject once',kind:'reject_once'},{optionId:'never-pick',name:'Always',kind:'allow_always'}]}});
  return {p,c,closed,rows,push,response,finish,init,update,result,permission,kills:()=>kills,events:()=>output.trim().split('\n').filter(Boolean).map(JSON.parse)};
}
test('Grok endpoint has no leader or auto-approve fallback and sends one bound prompt',async t=>{
  assert.deepEqual(buildArgs(options),['agent','--no-leader','--model','grok-selected','--effort','low','stdio']);
  const f=fixture(t);await f.init();assert.equal(await f.p.ready,true);const prompts=f.rows().filter(r=>r.method==='session/prompt');
  assert.deepEqual(prompts.map(r=>r.params),[{sessionId:sid,prompt:[{type:'text',text:'synthetic prompt'}]}]);
  assert.equal(f.c.stdin.writableEnded,false);
  f.push({jsonrpc:'2.0',method:'_x.ai/mcp/servers_updated',params:{servers:[]}});
  f.push({jsonrpc:'2.0',method:'_untrusted.example/approve',params:{approve:true,sessionId:'foreign'}});
  assert.deepEqual(f.p.listApprovals(),[]);
  f.update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'user echo is not an assistant reply'}});
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'reply'}});
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' continued'}});
  f.result();f.push({jsonrpc:'2.0',method:'_x.ai/session/closed',params:{}});f.finish();assert.deepEqual(await f.closed,[0,null]);assert.equal((await f.p.completion).responseComplete,true);
  assert.equal(f.events().filter(r=>r.type==='hub.agent_snapshot').at(-1).text,'reply continued');
});

test('backend-announced child routes tools through root owner scope without changing root binding or answer',async t=>{
  const bindings=[],f=fixture(t,{validatedAgentProfile:{name:'approved',tools:['task']},onSession:value=>{bindings.push(value);}});
  await f.init();nativeTask(f);announceChild(f);
  scopedUpdate(f,'native-child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'child text must not become root answer'}});
  scopedUpdate(f,'native-child',{sessionUpdate:'session_info_update',title:'inert child metadata'});
  scopedUpdate(f,'native-child',{sessionUpdate:'tool_call',toolCallId:'child-write',kind:'edit',title:'Write child artifact',status:'pending',rawInput:{variant:'Write',file_path:'native-delegate.json',content:'synthetic'}});
  f.push({jsonrpc:'2.0',id:'child-request-1',method:'session/request_permission',params:{sessionId:'native-child',toolCall:{toolCallId:'child-write',kind:'edit',title:'Write child artifact',status:'pending',rawInput:{variant:'Write',file_path:'native-delegate.json',content:'synthetic'}},options:[{optionId:'child-yes',name:'Allow once',kind:'allow_once'},{optionId:'child-no',name:'Reject once',kind:'reject_once'}]}});
  const approval=f.p.listApprovals()[0];assert.equal(approval.project,'p');assert.equal(approval.task,'t');assert.equal(approval.runId,'r');assert.equal(approval.sessionId,sid);
  f.p.respond(approval.token,'accept');await immediate();assert.equal(f.rows().at(-1).id,'child-request-1');
  scopedUpdate(f,'native-child',{sessionUpdate:'tool_call_update',toolCallId:'child-write',status:'completed'});
  f.update({sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'completed'});
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'root answer'}});f.result();f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);assert.equal(f.p.reportedModel,options.model);
  assert.equal(bindings.length,1);assert.equal(bindings[0].sessionId,sid);
  const text=f.events().filter(row=>row.type==='hub.agent_snapshot').map(row=>row.text).join('');
  assert.equal(text.includes('child text'),false);assert.equal(text.includes('root answer'),true);
});

test('child admission needs owner profile, pending runtime Task and matching trusted prompt/model',async t=>{
  for(const attack of ['not-approved','no-task','wrong-prompt','wrong-model','raw-input-lookalike','text-lookalike','wrong-native-kind']){
    const f=fixture(t,attack==='not-approved'?{}:{validatedAgentProfile:{name:'approved',tools:['task']}});await f.init();
    if(!['no-task','raw-input-lookalike','text-lookalike','wrong-native-kind'].includes(attack))nativeTask(f);
    if(attack==='wrong-native-kind')scopedUpdate(f,sid,{sessionUpdate:'tool_call',toolCallId:'fake-kind',title:'spawn_subagent',kind:'other',_meta:{'x.ai/tool':{...nativeTaskMeta['x.ai/tool'],kind:'other'}}},'prompt-1');
    if(attack==='raw-input-lookalike')f.update({sessionUpdate:'tool_call',toolCallId:'fake-task',title:'description',kind:'other',rawInput:{variant:'Task',parent_session_id:sid,prompt:'synthetic'}});
    if(attack==='text-lookalike')f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({sessionUpdate:'subagent_spawned',child_session_id:'native-child'})}});
    announceChild(f,'native-child',sid,attack==='wrong-prompt'?'foreign-prompt':'prompt-1',attack==='wrong-model'?{model:'unapproved-model'}:{});
    f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_SUBAGENT_SCOPE');assert.deepEqual(f.p.listApprovals(),[]);
  }
});

test('known sibling child cannot rewrite another session tool identity',async t=>{
  const f=fixture(t,{validatedAgentProfile:{name:'approved',tools:['task']}});await f.init();
  nativeTask(f,'task-a');nativeTask(f,'task-b');announceChild(f,'child-a');announceChild(f,'child-b');
  scopedUpdate(f,'child-a',{sessionUpdate:'tool_call',toolCallId:'owned-child-read',title:'Read file',kind:'read',status:'pending',rawInput:{variant:'ReadFile',path:'a.txt'}});
  scopedUpdate(f,'child-b',{sessionUpdate:'tool_call_update',toolCallId:'owned-child-read',status:'completed'});
  f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_SUBAGENT_SCOPE');
});

test('ancestor permission transport preserves the already registered child tool owner',async t=>{
  const f=fixture(t,{validatedAgentProfile:{name:'approved',tools:['task']}});await f.init();nativeTask(f);announceChild(f);initialWrite(f,'child-owned', 'native-child');
  routedPermission(f,'ancestor-request',sid,{toolCallId:'child-owned',title:'synthetic write',kind:'edit',status:'pending',rawInput:{file:'a.txt',content:'x'}});
  assert.equal(f.p.listApprovals().length,1);assert.equal(f.p.listApprovals()[0].sessionId,sid);
  f.p.respond(f.p.listApprovals()[0].token,'accept');await immediate();
  assert.equal(f.rows().find(row=>row.id==='ancestor-request').result.outcome.optionId,'route-yes');
  scopedUpdate(f,'native-child',{sessionUpdate:'tool_call_update',toolCallId:'child-owned',status:'completed'});
  f.update({sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'completed'});f.result();f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);
});

test('permission transport cannot use a descendant or sibling to control another tool owner',async t=>{
  for(const attack of ['descendant','sibling','queued-sibling']){
    const f=fixture(t,{validatedAgentProfile:{name:'approved',tools:['task']}});await f.init();nativeTask(f,'task-a');nativeTask(f,'task-b');announceChild(f,'child-a');announceChild(f,'child-b');
    const owner=attack==='descendant'?sid:'child-a';
    if(attack!=='queued-sibling')initialWrite(f,'protected-owner',owner);
    routedPermission(f,'bad-route','child-b',{toolCallId:'protected-owner',title:'synthetic write',kind:'edit',status:'pending',rawInput:{file:'a.txt',content:'x'}});
    if(attack==='queued-sibling'){assert.deepEqual(f.p.listApprovals(),[]);initialWrite(f,'protected-owner',owner);}
    f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_SUBAGENT_SCOPE');assert.deepEqual(f.p.listApprovals(),[]);
    assert.equal(f.rows().some(row=>row.id==='bad-route'&&row.result),false);
  }
});

test('early Task permission waits for trusted initial notification without minting owner or prompt scope',async t=>{
  const f=fixture(t,{validatedAgentProfile:{name:'approved',tools:['task']}});await f.init();
  routedPermission(f,'early-task',sid,{toolCallId:'task-1',title:'spawn_subagent',kind:'other',status:'pending',rawInput:{variant:'Task',prompt:'synthetic child',background:false},_meta:nativeTaskMeta});
  assert.deepEqual(f.p.listApprovals(),[]);assert.equal(f.rows().some(row=>row.id==='early-task'),false);
  nativeTask(f);assert.equal(f.p.listApprovals().length,1);f.p.respond(f.p.listApprovals()[0].token,'accept');await immediate();
  assert.equal(f.rows().filter(row=>row.id==='early-task').length,1);announceChild(f);
  f.update({sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'completed'});f.result();f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);
});

test('deferred permissions preserve receipt deadline and owner decline stays sticky',async t=>{
  let wall=1700000000000;t.mock.method(Date,'now',()=>wall);
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();const received=wall;f.permission();
  assert.deepEqual(f.p.listApprovals(),[]);wall+=400;initialWrite(f);
  const approval=f.p.listApprovals()[0];assert.equal(approval.expiresAt,received+1000);
  wall=received+1000;assert.throws(()=>f.p.respond(approval.token,'accept'),{code:'GROK_NATIVE_APPROVAL_EXPIRED'});await immediate();
  assert.equal(f.rows().at(-1).result.outcome.optionId,'dynamic-no');
  f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});f.result();f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,false);assert.deepEqual(f.p.listApprovals(),[]);
});

test('unknown permissions expire or stop without owner tokens or execution responses',async t=>{
  for(const stop of [false,true]){
    const f=fixture(t,{approvalTimeoutMs:stop?1000:10});await f.init();f.permission();assert.deepEqual(f.p.listApprovals(),[]);
    if(stop)f.p.kill();else await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(f.rows().some(row=>row.id==='server-1'&&row.result),false);
    f.finish(125);await f.closed;const result=await f.p.completion;
    assert.equal(result.responseComplete,false);assert.equal(result.cleanupVerified,true);assert.deepEqual(f.p.listApprovals(),[]);
    if(!stop)assert.equal(result.errorCode,'GROK_NATIVE_PERMISSION_STATE');
  }
});

test('queued request IDs are replay protected before owner registration and the combined limit is sixteen',async t=>{
  for(const attack of ['rpc-replay','tool-replay','combined-limit']){
    const f=fixture(t);await f.init();
    if(attack==='combined-limit'){initialWrite(f);f.permission();assert.equal(f.p.listApprovals().length,1);}
    const n=attack==='combined-limit'?15:1;
    for(let i=0;i<n;i++)routedPermission(f,'queued-'+i,sid,{toolCallId:'unseen-'+i,title:'synthetic read',kind:'read',status:'pending',rawInput:{path:'synthetic.txt'}});
    if(attack==='combined-limit')routedPermission(f,'overflow',sid,{toolCallId:'overflow-tool',title:'synthetic read',kind:'read',rawInput:{path:'synthetic.txt'}});
    else routedPermission(f,attack==='rpc-replay'?'queued-0':'new-request',sid,{toolCallId:attack==='rpc-replay'?'different-tool':'unseen-0',title:'synthetic read',kind:'read',rawInput:{path:'synthetic.txt'}});
    f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,attack==='combined-limit'?'GROK_NATIVE_PERMISSION_LIMIT':'GROK_NATIVE_PERMISSION_REPLAY');assert.deepEqual(f.p.listApprovals(),[]);
  }
});

test('persistence-shaped or invented extension methods cannot register a child session',async t=>{
  for(const method of ['_x.ai/session/update','_untrusted/session_notification']){
    const f=fixture(t,{validatedAgentProfile:{name:'approved',tools:['task']}});await f.init();nativeTask(f);
    f.push({jsonrpc:'2.0',method,params:{sessionId:sid,update:{sessionUpdate:'subagent_spawned',parent_session_id:sid,parent_prompt_id:'prompt-1',child_session_id:'foreign-child',subagent_id:'foreign-child',attempt_id:'foreign-attempt',model:options.model}}});
    assert.equal(f.kills(),0);assert.deepEqual(f.p.listApprovals(),[]);
    scopedUpdate(f,'foreign-child',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'not a root reply'}});
    f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_SESSION_MISMATCH');
    assert.equal(f.events().some(row=>row.text==='not a root reply'),false);
  }
});

test('recoverable failed tool remains visible but only terminal tools permit protocol completion',async t=>{
  for(const unfinished of [false,true]){
    const f=fixture(t);await f.init();const states=[];f.p.on('toolState',value=>states.push(value));
    f.update({sessionUpdate:'tool_call',toolCallId:'missing-file',title:'Read optional file',kind:'read',rawInput:{path:'optional.txt'}});
    f.update({sessionUpdate:'tool_call_update',toolCallId:'missing-file',status:'failed',rawOutput:{error:'synthetic missing optional file'}});
    f.update({sessionUpdate:'tool_call',toolCallId:'successful-tool',title:'Read actual file',kind:'read',rawInput:{path:'actual.txt'}});
    if(!unfinished)f.update({sessionUpdate:'tool_call_update',toolCallId:'successful-tool',status:'completed'});
    f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,!unfinished);
    assert.ok(states.some(row=>row.toolCallId==='missing-file'&&row.status==='failed'));
  }
});
test('owned resume uses session/load; no load capability or selected model mismatch refuses prompt',async t=>{
  const f=fixture(t,{sessionId:sid,resume:true});const r=await f.init();assert.equal(r.params.sessionId,sid);f.result();f.finish();await f.closed;assert.equal((await f.p.completion).sessionId,sid);
  for(const extra of [{sessionId:sid,resume:true},{sessionId:null,resume:false}]){
    const bad=fixture(t,extra);await bad.init(extra.resume?{load:false}:{model:'wrong-model'});bad.finish();await bad.closed;
    assert.equal((await bad.p.completion).responseComplete,false);assert.equal(bad.rows().some(r=>r.method==='session/prompt'),false);
  }
});
test('dynamic once-only permission options use exact ACP response and real tool output stays descriptive',async t=>{
  const f=fixture(t);await f.init();f.update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'synthetic write',kind:'edit',status:'pending',rawInput:{file:'a.txt',content:'x'},content:[]});
  const notice=once(f.p,'approvals');f.permission();await notice;const a=f.p.listApprovals()[0];
  assert.equal(a.project,'p');assert.equal(a.task,'t');assert.equal(a.sessionId,sid);assert.equal(typeof a.detail,'string');
  assert.throws(()=>f.p.respond('foreign','accept'),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});f.p.respond(a.token,'accept');
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});await immediate();
  assert.deepEqual(f.rows().at(-1),{jsonrpc:'2.0',id:'server-1',result:{outcome:{outcome:'selected',optionId:'dynamic-yes'}}});
  f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',content:[{type:'content',content:{type:'text',text:'saved'}}]});
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});
test('permission expiry and decline cannot become successful remote end_turn',async t=>{
  for(const expire of [true,false]){
    const f=fixture(t,{approvalTimeoutMs:expire?10:1000});await f.init();initialWrite(f);f.permission();const a=f.p.listApprovals()[0];
    if(expire)await new Promise(r=>setTimeout(r,25));else f.p.respond(a.token,'decline');await immediate();
    assert.equal(f.rows().at(-1).result.outcome.optionId,'dynamic-no');assert.deepEqual(f.p.listApprovals(),[]);
    f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});f.result();f.finish();await f.closed;
    assert.equal((await f.p.completion).responseComplete,false);
  }
});
test('client filesystem callbacks, duplicate replies and foreign updates fail closed',async t=>{
  for(const kind of ['callback','duplicate','foreign','changed-input']){
    const f=fixture(t);await f.init();
    if(kind==='callback')f.push({jsonrpc:'2.0',id:'server-fs',method:'fs/read_text_file',params:{path:'private'}});
    if(kind==='duplicate')f.response(f.rows()[0],{protocolVersion:1,agentCapabilities:{}});
    if(kind==='foreign')f.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'foreign',update:{sessionUpdate:'plan'}}});
    if(kind==='changed-input'){
      f.update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'x',rawInput:{file:'original'}});f.permission();
      f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',requested:false,locked:false,rawInput:{file:'different'}});
    }
    f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,false);assert.ok(f.kills()>0);
  }
});
test('stop waits for real owned exit; missing receipt and truncated EOF cannot be success',async t=>{
  const f=fixture(t);await f.init();let closed=false;f.p.on('close',()=>closed=true);f.p.kill();await immediate();assert.equal(closed,false);
  f.finish(125,{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:125});await f.closed;assert.equal((await f.p.completion).cleanupVerified,true);assert.equal((await f.p.completion).cancelled,true);
  for(const tail of [false,true]){
    const b=fixture(t);await b.init();b.result();if(tail)b.c.stdout.write('{');b.finish(0,tail?{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0}:null);
    await b.closed;assert.equal((await b.p.completion).responseComplete,false);assert.equal(b.events().some(r=>r.type==='turn.completed'),false);
  }
});

test('mismatched cleanup exit code cannot attest successful cleanup',async t=>{
  const f=fixture(t);await f.init();f.result();
  f.finish(0,{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:125});await f.closed;
  assert.equal((await f.p.completion).cleanupVerified,false);
  assert.equal((await f.p.completion).responseComplete,false);
});

test('exact native watcher ACKs are inert before and after prompt result; all other IDs remain refused',async t=>{
  const ack=(id='skills-reload',reloaded=0)=>({jsonrpc:'2.0',id,result:{result:{reloaded}}});
  const f=fixture(t);await f.init();
  const before=f.rows().length;
  f.push(ack());f.push(ack('workflows-reload',1));
  assert.deepEqual(f.p.internalNoticeSummary,{skills:1,workflows:1});
  assert.equal(Object.isFrozen(f.p.internalNoticeSummary),true);assert.equal(f.kills(),0);
  assert.equal(f.rows().length,before);assert.deepEqual(f.p.listApprovals(),[]);
  assert.equal(f.events().some(x=>x.type==='turn.completed'),false);
  f.result();f.push(ack());f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);
  assert.deepEqual(f.p.internalNoticeSummary,{skills:2,workflows:1});
  for(const frame of [ack('unknown-reload'),{...ack(),_meta:{}},
    {...ack(),result:{stopReason:'end_turn'}},{...ack(),result:{result:{reloaded:0},error:'partial'}}]){
    const bad=fixture(t);await bad.init();bad.push(frame);bad.finish(125);await bad.closed;
    assert.equal((await bad.p.completion).errorCode,'GROK_NATIVE_RESPONSE_UNKNOWN');
    assert.equal((await bad.p.completion).responseComplete,false);
  }
});

test('watcher ACK flood is bounded and ACK alone cannot complete a pending prompt',async t=>{
  const f=fixture(t);await f.init();
  for(let i=0;i<65;i++)f.push({jsonrpc:'2.0',id:'skills-reload',result:{result:{reloaded:0}}});
  f.finish(125);await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_NOTICE_LIMIT');
  assert.equal((await f.p.completion).responseComplete,false);
  assert.deepEqual(f.p.internalNoticeSummary,{skills:64,workflows:0});
  assert.equal(f.events().some(x=>x.type==='turn.completed'),false);
});

test('unknown or duplicate responses stay rejected; diagnostic records shapes without IDs or payloads',async t=>{
  for(const mode of ['mcp','forged-success','duplicate','error']){
    const f=fixture(t);await f.init();
    const privateValue='private-synthetic-id-and-payload';
    const frame=mode==='mcp'?{jsonrpc:'2.0',id:0,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:privateValue},_meta:{secret:privateValue}}}:
      mode==='forged-success'?{jsonrpc:'2.0',id:privateValue,result:{stopReason:'end_turn',text:privateValue}}:
      mode==='duplicate'?{jsonrpc:'2.0',id:f.rows()[0].id,result:{protocolVersion:1,agentCapabilities:{}}}:
      {jsonrpc:'2.0',id:privateValue,error:{code:-32603,message:privateValue,data:privateValue}};
    f.push(frame);f.finish(125);await f.closed;
    assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_RESPONSE_UNKNOWN');
    assert.equal((await f.p.completion).responseComplete,false);assert.ok(f.kills()>0);
    const diagnostic=f.p.lastResponseDiagnostic;
    assert.equal(diagnostic.idRelation,mode==='duplicate'?'already-replied':'unknown');
    assert.equal(diagnostic.resultShape,{mcp:'mcp-initialize','forged-success':'acp-stop',duplicate:'acp-initialize',error:'none'}[mode]);
    assert.deepEqual(diagnostic.pendingMethods,['session/prompt']);
    assert.equal(diagnostic.errorCode,mode==='error'?-32603:null);
    assert.equal(JSON.stringify(diagnostic).includes(privateValue),false);
    assert.equal(JSON.stringify(diagnostic).includes(String(frame.id)),false);
    assert.equal(JSON.stringify(f.events()).includes(privateValue),false);
    assert.equal(f.events().some(x=>x.type==='turn.completed'),false);
    assert.equal(Object.isFrozen(diagnostic),true);
  }
});

test('controller admitted profile is a copied protocol value, never inferred from model input',async t=>{
  const profile={name:'synthetic',description:'Fixed test',agentsMd:false,discoverSkills:false,inheritSkills:false};
  const f=fixture(t,{validatedAgentProfile:profile});profile.agentsMd=true;
  const open=await f.init();assert.equal(open.params._meta.agentProfile.agentsMd,false);
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});

test('current-session credential-less 401 stops without exposing reason or refreshing auth',async t=>{
  const reason='Re-authenticating after 401 (request carried no credential); PRIVATE_REMOTE_SUFFIX';
  const f=fixture(t);await f.init();
  const notice=sessionId=>({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId,
    update:{sessionUpdate:'retry_state',type:'retrying',attempt:1,reason}}});
  f.push(notice('foreign'));assert.equal(f.kills(),0);
  f.push(notice(sid));assert.equal(f.kills(),1);assert.deepEqual(f.p.listApprovals(),[]);
  assert.equal(f.rows().filter(x=>x.method==='session/prompt').length,1);
  f.finish(125);await f.closed;
  const result=await f.p.completion;
  assert.equal(result.errorCode,'GROK_NATIVE_AUTH_UNAVAILABLE');assert.equal(result.responseComplete,false);
  assert.equal(result.cleanupVerified,true);assert.equal(JSON.stringify(f.events()).includes('PRIVATE_REMOTE_SUFFIX'),false);
});

test('persisted journal retry method remains accepted for a bound authentication failure',async t=>{
  const f=fixture(t);await f.init();
  f.push({jsonrpc:'2.0',method:'_x.ai/session/update',params:{sessionId:sid,update:{sessionUpdate:'retry_state',type:'retrying',attempt:1,error_type:'auth',reason:'PRIVATE_JOURNAL_REASON'}}});
  assert.equal(f.kills(),1);f.finish(125);await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_AUTH_UNAVAILABLE');
  assert.equal(JSON.stringify(f.events()).includes('PRIVATE_JOURNAL_REASON'),false);
});

test('real retry notifications classify auth failure, rate limit and exhausted retries without exposing provider text',async t=>{
  const cases=[
    [{sessionUpdate:'retry_state',type:'failed',error_type:'auth',message:'PRIVATE_AUTH_MESSAGE'},'GROK_NATIVE_AUTH_UNAVAILABLE'],
    [{sessionUpdate:'retry_state',type:'exhausted',attempts:3,reason:'PRIVATE_RATE_REASON',is_rate_limited:true},'GROK_NATIVE_RATE_LIMITED'],
    [{sessionUpdate:'retry_state',type:'exhausted',attempts:3,reason:'PRIVATE_RETRY_REASON',is_rate_limited:false},'GROK_NATIVE_RETRY_EXHAUSTED'],
    [{sessionUpdate:'retry_state',type:'exhausted',attempts:3,reason:'Unauthorized (401) PRIVATE_FINAL_REASON',is_rate_limited:false},'GROK_NATIVE_RETRY_EXHAUSTED']
  ];
  for(const [update,code]of cases){
    const f=fixture(t);await f.init();f.push({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId:sid,update}});
    assert.equal(f.kills(),1);f.finish(125);await f.closed;assert.equal((await f.p.completion).errorCode,code);
    assert.equal(JSON.stringify(f.events()).includes('PRIVATE_'),false);
  }
});

test('legacy auth and non-auth retry notifications stay inert',async t=>{
  const cases=[
    {sessionUpdate:'retry_state',type:'failed',error_type:'legacy_auth',message:'Unauthorized (401) PRIVATE_LEGACY'},
    {sessionUpdate:'retry_state',type:'retrying',attempt:2,error_type:'server',reason:'HTTP 503 PRIVATE_SERVER'}
  ];
  for(const update of cases){
    const f=fixture(t);await f.init();f.push({jsonrpc:'2.0',method:'_x.ai/session_notification',params:{sessionId:sid,update}});
    assert.equal(f.kills(),0);f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
    assert.equal(JSON.stringify(f.events()).includes('PRIVATE_'),false);
  }
});

test('matched ACP AuthRequired stops every pending method with redacted diagnostics and owned cleanup',async t=>{
  for(const method of ['initialize','session/new','session/load','session/set_model','session/prompt']){
    const f=fixture(t,method==='session/load'?{sessionId:sid,resume:true}:{});
    let request,sent=false;
    const reject=()=>{
      request=f.rows().at(-1);assert.equal(request.method,method);
      f.push({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'PRIVATE_AUTH_MESSAGE',data:{token:'PRIVATE_AUTH_DATA'}}});sent=true;
    };
    if(method==='initialize'){
      f.p.stdin.end('synthetic prompt');await immediate();await immediate();
    }else if(method==='session/new'||method==='session/load'){
      await f.init({beforeOpenResponse:reject});
    }else{
      await f.init(method==='session/set_model'?{model:'catalog-default',availableModels:[{modelId:options.model}]}:{});
    }
    if(method==='session/prompt'){initialWrite(f);f.permission();assert.equal(f.p.listApprovals().length,1);}
    let closed=false;f.p.on('close',()=>closed=true);
    if(!sent)reject();
    assert.equal(f.kills(),1);assert.deepEqual(f.p.listApprovals(),[]);
    await immediate();assert.equal(closed,false);
    f.finish(125);await f.closed;const result=await f.p.completion;
    assert.equal(result.errorCode,'GROK_NATIVE_AUTH_UNAVAILABLE');assert.equal(result.responseComplete,false);assert.equal(result.cleanupVerified,true);
    assert.deepEqual(f.p.remoteError,{method,code:-32000});
    const exposed=JSON.stringify({events:f.events(),remoteError:f.p.remoteError,result});
    assert.equal(exposed.includes('PRIVATE_AUTH_'),false);assert.equal(f.events().some(x=>x.type==='turn.completed'),false);
    assert.equal(f.rows().filter(x=>x.method==='session/prompt').length,method==='session/prompt'?1:0);
  }
});

test('other matched RPC errors keep their original remote-error classification',async t=>{
  for(const code of [-32603,-32001,'-32000',null]){
    const f=fixture(t);await f.init();const request=f.rows().findLast(r=>r.method==='session/prompt');
    f.push({jsonrpc:'2.0',id:request.id,error:{code,message:'PRIVATE_REMOTE_MESSAGE',data:'PRIVATE_REMOTE_DATA'}});
    f.finish(125);await f.closed;const result=await f.p.completion;
    assert.equal(result.errorCode,'GROK_NATIVE_REMOTE_ERROR');assert.equal(result.responseComplete,false);assert.equal(result.cleanupVerified,true);
    assert.deepEqual(f.p.remoteError,{method:'session/prompt',code:Number.isSafeInteger(code)?code:null});
    assert.equal(JSON.stringify({events:f.events(),remoteError:f.p.remoteError,result}).includes('PRIVATE_REMOTE_'),false);
  }
});

test('AuthRequired with an unknown or replayed RPC ID remains an unknown response',async t=>{
  for(const replay of [false,true]){
    const f=fixture(t);await f.init();const id=replay?f.rows()[0].id:'PRIVATE_UNKNOWN_AUTH_ID';
    f.push({jsonrpc:'2.0',id,error:{code:-32000,message:'PRIVATE_AUTH_MESSAGE',data:'PRIVATE_AUTH_DATA'}});
    f.finish(125);await f.closed;const result=await f.p.completion;
    assert.equal(result.errorCode,'GROK_NATIVE_RESPONSE_UNKNOWN');assert.equal(result.responseComplete,false);assert.equal(result.cleanupVerified,true);
    assert.equal(f.p.remoteError,undefined);assert.equal(f.p.lastResponseDiagnostic.idRelation,replay?'already-replied':'unknown');
    assert.equal(f.p.lastResponseDiagnostic.errorCode,-32000);
    assert.equal(JSON.stringify({events:f.events(),diagnostic:f.p.lastResponseDiagnostic,result}).includes('PRIVATE_'),false);
    assert.equal(f.events().some(x=>x.type==='turn.completed'),false);assert.ok(f.kills()>0);
  }
});

test('metadata before new response or during model selection cannot race readiness or pick a model',async t=>{
  const f=fixture(t);
  await f.init({model:'catalog-default',availableModels:[{modelId:options.model}],
    beforeOpenResponse:()=>f.update({sessionUpdate:'available_commands_update',availableCommands:[]})});
  const select=f.rows().at(-1);assert.equal(select.method,'session/set_model');
  assert.equal(select.params.modelId,options.model);
  f.update({sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:'untrusted-notice'}]});
  assert.equal(f.rows().some(x=>x.method==='session/prompt'),false);
  f.response(select,{});await immediate();assert.equal(await f.p.ready,true);
  assert.equal(f.p.reportedModel,options.model);assert.equal(f.rows().filter(x=>x.method==='session/prompt').length,1);
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});

test('load replay does not become a new reply, a pending approval, or current tool execution',async t=>{
  const f=fixture(t,{sessionId:sid,resume:true});
  await f.init({beforeOpenResponse:()=>{
    f.update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'OLD_USER'}});
    f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_REPLY'}});
    f.update({sessionUpdate:'tool_call',toolCallId:'old-tool',title:'OLD_TOOL',status:'pending',rawInput:{path:'old'}});
    f.update({sessionUpdate:'tool_call_update',toolCallId:'old-tool',status:'completed'});
  }});
  assert.deepEqual(f.p.listApprovals(),[]);assert.equal(JSON.stringify(f.events()).includes('OLD_'),false);
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'NEW_REPLY'}});
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
  assert.equal(f.events().findLast(x=>x.type==='hub.agent_snapshot').text,'NEW_REPLY');
});

test('bootstrap foreign identities, premature content, and permission requests fail closed',async t=>{
  for(const kind of ['new-identity','resume-identity','new-content','permission']){
    const f=fixture(t,kind==='resume-identity'?{sessionId:sid,resume:true}:{});
    await f.init({beforeOpenResponse:()=>{
      if(kind.endsWith('identity'))f.push({jsonrpc:'2.0',method:'session/update',params:{sessionId:'foreign',update:{sessionUpdate:'plan'}}});
      if(kind==='new-content')f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PREMATURE'}});
      if(kind==='permission')f.permission();
    }});
    f.finish();await f.closed;
    assert.equal((await f.p.completion).responseComplete,false);assert.equal(f.rows().some(x=>x.method==='session/prompt'),false);
    assert.deepEqual(f.p.listApprovals(),[]);
  }
});

test('permission can pause a running tool but cannot approve an already terminal tool',async t=>{
  const f=fixture(t);await f.init();initialWrite(f);f.permission('active-permission','in_progress');
  assert.equal(f.p.listApprovals().length,1);f.p.respond(f.p.listApprovals()[0].token,'accept');
  f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
  for(const status of ['completed','failed']){
    const bad=fixture(t);await bad.init();bad.permission('terminal-permission',status);bad.finish();await bad.closed;
    assert.equal((await bad.p.completion).responseComplete,false);assert.deepEqual(bad.p.listApprovals(),[]);
  }
});

test('model state drift after acknowledged selection stops instead of silently substituting',async t=>{
  const f=fixture(t);await f.init();
  f.update({sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:options.model}]});
  assert.equal(f.kills(),0);
  f.update({sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:'different-model'}]});
  f.finish(125);await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_MODEL_MISMATCH');
  assert.equal((await f.p.completion).responseComplete,false);
});

test('streamed input finalizes at permission; owner preview locks cannot be overwritten by native fields',async t=>{
  const f=fixture(t);await f.init();
  f.update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'synthetic write',kind:'edit',rawInput:null});
  for(const rawInput of [{},'partial',{file:'a.txt',content:''}])f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',rawInput});
  assert.deepEqual(f.p.listApprovals(),[]);f.permission();
  const preview=f.p.listApprovals()[0];assert.deepEqual(JSON.parse(preview.detail).rawInput,{file:'a.txt',content:'x'});
  f.p.respond(preview.token,'accept');
  f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',rawInput:null,status:'completed',rawOutput:{saved:true},requested:false,locked:false});
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});


test('session/load remote failure has a dedicated code but auth and non-resume errors keep their codes',async t=>{
  for(const [resume,errorCode,expected]of [[true,-32603,'GROK_NATIVE_RESUME_FAILED'],[true,-32000,'GROK_NATIVE_AUTH_UNAVAILABLE'],[false,-32603,'GROK_NATIVE_REMOTE_ERROR']]){
    let bound=0;const f=fixture(t,{resume,sessionId:resume?sid:null,onSession:()=>{bound++;}});f.p.stdin.end('synthetic');await immediate();await immediate();
    f.response(f.rows()[0],{protocolVersion:1,agentCapabilities:{loadSession:true}});await immediate();const call=f.rows().at(-1);
    f.push({jsonrpc:'2.0',id:call.id,error:{code:errorCode,message:'PRIVATE_LOAD_ERROR'}});f.finish(1);await f.closed;
    assert.equal((await f.p.completion).errorCode,expected);assert.equal(bound,0);assert.equal(f.rows().some(x=>x.method==='session/prompt'),false);assert.equal(JSON.stringify(f.events()).includes('PRIVATE_LOAD_ERROR'),false);
  }
});

test('Grok publishes session only after successful session/new or session/load response',async t=>{
  for(const resume of [false,true]){
    let bound=0;const f=fixture(t,{resume,sessionId:resume?sid:null,onSession:()=>{bound++;}});
    await f.init({beforeOpenResponse:()=>{assert.equal(bound,0);assert.equal(f.events().some(e=>e.type==='thread.started'),false);assert.equal(f.rows().some(e=>e.method==='session/prompt'),false);}});
    assert.equal(bound,1);assert.equal(f.events().filter(e=>e.type==='thread.started').length,1);f.result();f.finish();await f.closed;
  }
});


test('wall and idle option boundaries fail before opening an endpoint',async t=>{
  for(const [key,values]of [['maxWallMs',[0,1800001,1.5,'1800000']],['idleTimeoutMs',[0,600001,1.5,'600000']]])for(const value of values){
    let opened=0;
    assert.throws(()=>start({...options,[key]:value,openEndpoint:()=>{opened++;}}),{code:'GROK_NATIVE_OPTIONS'});
    assert.equal(opened,0);
  }
  const f=fixture(t,{maxWallMs:1800000,idleTimeoutMs:600000});await f.init();
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});

test('idle starts at spawn; partial stdout and stderr cannot keep a turn alive',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{idleTimeoutMs:100});await immediate();await immediate();
  t.mock.timers.tick(60);f.c.stdout.write(Buffer.from('{'));f.c.stderr.write(Buffer.from('synthetic progress'));
  t.mock.timers.tick(40);assert.equal(f.kills(),1);
  f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_IDLE_TIMEOUT');
  const kills=f.kills();t.mock.timers.tick(1800000);assert.equal(f.kills(),kills);
});

test('accepted metadata resets idle but never extends the absolute wall',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{idleTimeoutMs:100,maxWallMs:500});await f.init();
  for(let i=0;i<6;i++){t.mock.timers.tick(80);f.update({sessionUpdate:'usage_update'});assert.equal(f.kills(),0);}
  t.mock.timers.tick(20);assert.equal(f.kills(),1);
  f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_WALL_TIMEOUT');
});

test('permission requests and owner answers each reset idle; result stops idle',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{idleTimeoutMs:100});await f.init();initialWrite(f);
  t.mock.timers.tick(80);f.permission();assert.equal(f.p.listApprovals().length,1);
  t.mock.timers.tick(80);assert.equal(f.kills(),0);f.p.respond(f.p.listApprovals()[0].token,'accept');
  t.mock.timers.tick(80);assert.equal(f.kills(),0);f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});f.result();
  t.mock.timers.tick(200);assert.equal(f.kills(),0);
  f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});

test('defaults stop idle at ten minutes and active work at thirty minutes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const idle=fixture(t);await idle.init();t.mock.timers.tick(599999);assert.equal(idle.kills(),0);
  t.mock.timers.tick(1);idle.finish(1);await idle.closed;assert.equal((await idle.p.completion).errorCode,'GROK_NATIVE_IDLE_TIMEOUT');
  const f=fixture(t);await f.init();
  for(let i=0;i<3;i++){t.mock.timers.tick(599999);f.update({sessionUpdate:'usage_update'});assert.equal(f.kills(),0);}
  t.mock.timers.tick(3);f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_WALL_TIMEOUT');
});

test('CLI default omits model argv, binds any valid reported ID for new/load and never selects a model',async t=>{
 assert.deepEqual(buildArgs({...options,model:''}),['agent','--no-leader','--effort','low','stdio']);
 for(const resume of [false,true])for(const model of ['grok-4.7','Other_VALID:version.1','x'.repeat(256)]){
  const f=fixture(t,{model:'',resume,sessionId:resume?sid:null});await f.init({model});
  assert.equal(await f.p.ready,true);assert.equal(f.p.reportedModel,model);assert.equal(f.rows().some(row=>row.method==='session/set_model'),false);
  f.update({sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:model}]});assert.equal(f.kills(),0);
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
 }
});

test('CLI default rejects malformed current IDs and later model drift without sending a prompt or set_model',async t=>{
 for(const model of ['',null,42,'bad model','bad/model','-leading','x'.repeat(257)]){
  const f=fixture(t,{model:''});await f.init({model});f.finish(125);await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_MODEL_UNVERIFIED');assert.equal(f.rows().some(row=>['session/prompt','session/set_model'].includes(row.method)),false);
 }
 const f=fixture(t,{model:''});await f.init({model:'grok-4.7'});
 f.update({sessionUpdate:'config_option_update',configOptions:[{id:'model',currentValue:'grok-4.6'}]});f.finish(125);await f.closed;
 assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_MODEL_MISMATCH');
});

test('CLI default subagent scope uses the reported model',async t=>{
 const f=fixture(t,{model:'',validatedAgentProfile:{name:'approved',tools:['task']}});await f.init({model:'grok:latest'});
 nativeTask(f);announceChild(f,'native-child',sid,'prompt-1',{model:'grok:latest'});assert.equal(f.kills(),0);
 f.update({sessionUpdate:'tool_call_update',toolCallId:'task-1',status:'completed'});f.result();f.finish();await f.closed;
 assert.equal((await f.p.completion).responseComplete,true);
});
