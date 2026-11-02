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
  return {p,c,closed,rows,push,response,finish,init,update,result,permission,kills:()=>kills,stdoutBytes:()=>Buffer.byteLength(output),events:()=>output.trim().split('\n').filter(Boolean).map(JSON.parse)};
}

const textUpdate=(f,text)=>f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
function finalSnapshot(f,reply,terminal){
  const rows=f.events(),snapshots=rows.filter(r=>r.type==='hub.agent_snapshot');
  assert.equal(snapshots.length,1);assert.equal(snapshots[0].text,reply);
  assert.ok(rows.indexOf(snapshots[0])<rows.findIndex(r=>r.type===terminal));
}
// One ACP string is capped at LIMITS.maxStringBytes (256 KiB), so the coarsest case is two chunks.
for(const count of [2,1000,15000])test('R24 300 KB reply in '+count+' chunks completes with linear stdout',{timeout:30000},async t=>{
  const reply='x'.repeat(300000),f=fixture(t);await f.init();
  for(let i=0;i<count;i++)textUpdate(f,reply.slice(Math.floor(i*reply.length/count),Math.floor((i+1)*reply.length/count)));
  f.result();f.finish();await f.closed;const result=await f.p.completion;
  assert.equal(result.errorCode,null);assert.equal(result.responseComplete,true);
  assert.equal(f.events().filter(r=>r.type==='hub.agent_delta').map(r=>r.text).join(''),reply);
  finalSnapshot(f,reply,'turn.completed');assert.ok(f.stdoutBytes()<2097152,String(f.stdoutBytes()));
});
test('R24 1048577 reply bytes refuse with output limit',{timeout:30000},async t=>{
  const f=fixture(t);await f.init();const chunk='x'.repeat(131072);
  for(let i=0;i<8;i++)textUpdate(f,chunk);textUpdate(f,'x');f.finish(1);await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_OUTPUT_LIMIT');
});
test('R24 idle failure after partial reply emits exactly one final snapshot',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.init();textUpdate(f,'partial reply');t.mock.timers.tick(600000);
  assert.ok(f.kills()>0);f.finish(1);await f.closed;
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_IDLE_TIMEOUT');finalSnapshot(f,'partial reply','turn.failed');
});
test('R24 70000 small frames refuse with frame limit',{timeout:30000},async t=>{
  const f=fixture(t);await f.init();
  for(let i=0;i<70000;i++)f.push({jsonrpc:'2.0',method:'_fixture'});
  f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_FRAME_LIMIT');
});
