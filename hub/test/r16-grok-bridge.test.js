'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const {start,buildArgs}=require('../lib/grok-native-bridge');
const {GROK_PROCESS_TOOLS}=require('../lib/grok-tool-allowlist');
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

for(const mode of ['owner','policy','timer','late','cancel'])test(`R16 Grok ${mode} refuses exactly once without accepting the operation`,async t=>{
  let now=Date.now();if(mode==='late')t.mock.method(Date,'now',()=>now);
  const f=fixture(t,{approvalTimeoutMs:mode==='timer'?20:1000});await f.init();
  const title='  outside\r\n\t'+ 'x'.repeat(310),tool={toolCallId:'refused',title,kind:'edit',status:'pending',rawInput:{variant:'Write',file_path:'D:\\outside.txt',content:'not executed'}};
  if(mode==='policy')f.p.on('approvals',rows=>{for(const row of rows){
    const decision=require('../lib/native-provider-tool-policy').decide('grok',JSON.parse(row.detail),{root:options.cwd,modelFlag:options.model,commandsApproved:true,subagentsApproved:true,mcpTools:[]});
    assert.equal(decision,'accept');f.p.respond(row.token,decision);
  }});
  f.update({sessionUpdate:'tool_call',...tool});routedPermission(f,'refusal-request',sid,tool);
  const a=f.p.listApprovals()[0];
  if(mode==='timer')await new Promise(r=>setTimeout(r,45));
  else if(mode==='late'){now+=1000;assert.throws(()=>f.p.respond(a.token,'accept'),{code:'GROK_NATIVE_APPROVAL_EXPIRED'});}
  else if(mode!=='policy')f.p.respond(a.token,mode==='cancel'?'cancel':'decline');
  if(a)assert.throws(()=>f.p.respond(a.token,'accept'),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});
  await immediate();
  const replies=f.rows().filter(r=>r.id==='refusal-request');assert.equal(replies.length,1);
  assert.deepEqual(replies[0].result.outcome,mode==='cancel'?{outcome:'cancelled'}:{outcome:'selected',optionId:mode==='policy'?'route-yes':'route-no'});
  assert.deepEqual(f.p.listApprovals(),[]);
  assert.deepEqual(f.events().filter(r=>r.type==='hub.tool_declined'),mode==='policy'?[]:[{type:'hub.tool_declined',title:('outside '+'x'.repeat(310)).slice(0,300),reason:mode==='cancel'?'cancelled':['timer','late'].includes(mode)?'expired':'declined'}]);
  f.result(mode==='cancel'?'cancelled':'end_turn');f.finish();await f.closed;
  const completed=await f.p.completion;assert.equal(completed.responseComplete,mode!=='policy');
  assert.equal(f.events().some(r=>r.type==='turn.completed'),mode!=='policy');
  assert.equal(completed.errorCode,mode==='policy'?'GROK_NATIVE_INCOMPLETE':null);
  assert.equal(f.events().filter(r=>r.type==='hub.turn_stopped_after_decline').length,mode==='cancel'?1:0);
});

test('R16 Grok pending approval and unknown deferred permission cannot succeed',async t=>{
  for(const deferred of [false,true]){
    const f=fixture(t,{approvalTimeoutMs:deferred?20:1000});await f.init();
    if(!deferred)initialWrite(f);f.permission();
    if(deferred)await new Promise(r=>setTimeout(r,45));else f.result();
    assert.equal(f.rows().some(r=>r.id==='server-1'),false);
    f.finish();await f.closed;
    assert.equal((await f.p.completion).errorCode,deferred?'GROK_NATIVE_PERMISSION_STATE':'GROK_NATIVE_INCOMPLETE');
    assert.deepEqual(f.events().filter(r=>r.type==='hub.tool_declined'),[]);
  }
});

test('R16 Grok malformed permission without a title still fails the existing protocol guard',async t=>{
  const f=fixture(t);await f.init();const tool={toolCallId:'without-title',kind:'other',status:'pending',rawInput:{}};
  f.update({sessionUpdate:'tool_call',...tool});routedPermission(f,'fallback',sid,tool);
  assert.deepEqual(f.p.listApprovals(),[]);f.finish();await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_PERMISSION_INVALID');
  assert.equal(f.events().some(r=>r.type==='hub.tool_declined'),false);
});
