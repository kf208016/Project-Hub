'use strict';
// R16 / T2+T3 blind acceptance (Grok bridge): a refused tool call is sent to the
// CLI exactly as before, becomes one hub.tool_declined notice, never runs, and
// no longer fails a turn that the CLI ended normally. Synthetic endpoint only.
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const {start,buildArgs}=require('../lib/grok-native-bridge');
const {decide}=require('../lib/native-provider-tool-policy');
const sid='synthetic-r16-session',immediate=()=>new Promise(r=>setImmediate(r)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const options={project:'p',task:'t',runId:'r',cwd:'C:\\synthetic\\work',model:'grok-selected',effort:'low',sessionId:null,resume:false,validatedMcpServers:[]};
const CONTROL=/[\u0000-\u001f\u007f-\u009f]/;

function scopedUpdate(f,sessionId,update){
  f.push({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
}
function initialWrite(f,id='tool-1',owner=sid,title='synthetic write'){
  scopedUpdate(f,owner,{sessionUpdate:'tool_call',toolCallId:id,title,kind:'edit',status:'pending',rawInput:{file:'a.txt',content:'x'}});
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
  async function init(){
    p.stdin.end('synthetic prompt');await immediate();await immediate();const first=rows()[0];
    assert.equal(first.method,'initialize');
    response(first,{protocolVersion:1,agentCapabilities:{loadSession:true}});
    await immediate();const open=rows().at(-1);assert.equal(open.method,'session/new');
    response(open,{sessionId:sid,models:{currentModelId:options.model,availableModels:[]}});
    await immediate();assert.equal(await p.ready,true);return open;
  }
  const update=u=>push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:u}});
  const result=stopReason=>response(rows().findLast(r=>r.method==='session/prompt'),{stopReason:stopReason||'end_turn'});
  const permission=(id='server-1',status='pending')=>push({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:sid,
    toolCall:{toolCallId:'tool-1',title:'synthetic write',kind:'edit',status,rawInput:{file:'a.txt',content:'x'}},
    options:[{optionId:'dynamic-yes',name:'Allow once',kind:'allow_once'},{optionId:'dynamic-no',name:'Reject once',kind:'reject_once'},{optionId:'never-pick',name:'Always',kind:'allow_always'}]}});
  const events=()=>output.trim().split('\n').filter(Boolean).map(JSON.parse);
  const notices=()=>events().filter(e=>e.type==='hub.tool_declined');
  const replies=id=>rows().filter(r=>r.id===id&&Object.hasOwn(r,'result'));
  return {p,c,closed,rows,push,response,finish,init,update,result,permission,kills:()=>kills,events,notices,replies};
}
async function endNormally(f,text='synthetic answer'){
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
  f.result('end_turn');f.finish();await f.closed;return f.p.completion;
}
function assertCompleted(f,completion){
  assert.equal(completion.responseComplete,true,'turn must complete: '+completion.errorCode);
  assert.equal(completion.errorCode,null);
  assert.equal(f.events().filter(e=>e.type==='turn.completed').length,1);
  assert.equal(f.events().some(e=>e.type==='turn.failed'),false);
}
const REJECT={outcome:{outcome:'selected',optionId:'dynamic-no'}};

test('R16 owner decline: same reject_once reply, one declined notice, token spent, turn completes',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);f.permission();
  const a=f.p.listApprovals()[0];assert.ok(a);
  assert.equal(f.p.respond(a.token,'decline'),true);await immediate();
  assert.deepEqual(f.replies('server-1'),[{jsonrpc:'2.0',id:'server-1',result:REJECT}]);
  assert.deepEqual(f.p.listApprovals(),[]);
  for(const decision of ['accept','decline','cancel'])assert.throws(()=>f.p.respond(a.token,decision),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});
  assert.equal(f.replies('server-1').length,1,'a second respond must not send another reply');
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'synthetic write',reason:'declined'}]);
  // The declined tool never reaches a terminal status; the CLI ends its turn normally.
  const completion=await endNormally(f);assertCompleted(f,completion);
  assert.equal(f.rows().some(r=>r.result?.outcome?.optionId==='dynamic-yes'||r.result?.outcome?.optionId==='never-pick'),false);
  assert.equal(f.notices().length,1);
  assert.equal(f.events().findLast(e=>e.type==='hub.agent_snapshot').text,'synthetic answer');
});

test('R16 approval timer expiry: same reject_once reply, one expired notice, turn completes',async t=>{
  const f=fixture(t,{approvalTimeoutMs:10});await f.init();initialWrite(f);f.permission();
  const a=f.p.listApprovals()[0];assert.ok(a);
  await sleep(40);
  assert.deepEqual(f.replies('server-1'),[{jsonrpc:'2.0',id:'server-1',result:REJECT}]);
  assert.deepEqual(f.p.listApprovals(),[]);
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'synthetic write',reason:'expired'}]);
  const completion=await endNormally(f);assertCompleted(f,completion);
  assert.equal(f.rows().some(r=>r.result?.outcome?.optionId==='dynamic-yes'),false);
});

test('R16 respond after the deadline: still throws EXPIRED, sends reject_once, one expired notice, turn completes',async t=>{
  let wall=1700000000000;t.mock.method(Date,'now',()=>wall);
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);f.permission();
  const a=f.p.listApprovals()[0];assert.equal(a.expiresAt,wall+1000);
  wall+=1000;
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'GROK_NATIVE_APPROVAL_EXPIRED'});await immediate();
  assert.deepEqual(f.replies('server-1'),[{jsonrpc:'2.0',id:'server-1',result:REJECT}]);
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'synthetic write',reason:'expired'}]);
  const completion=await endNormally(f);assertCompleted(f,completion);
});

test('R18 approval cancel: still sends cancelled, preserves declined notice; CLI cancellation completes',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);f.permission();
  const a=f.p.listApprovals()[0];f.p.respond(a.token,'cancel');await immediate();
  assert.deepEqual(f.replies('server-1'),[{jsonrpc:'2.0',id:'server-1',result:{outcome:{outcome:'cancelled'}}}]);
  assert.throws(()=>f.p.respond(a.token,'cancel'),{code:'GROK_NATIVE_APPROVAL_UNKNOWN'});
  f.result('cancelled');f.finish();await f.closed;const completion=await f.p.completion;
  assertCompleted(f,completion);
  assert.deepEqual(f.events().filter(e=>e.type==='hub.turn_stopped_after_decline'),[{type:'hub.turn_stopped_after_decline'}]);
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'synthetic write',reason:'cancelled'}]);
});

test('R16 owner cancel followed by a normal end_turn is not a failed turn',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);f.permission();
  f.p.respond(f.p.listApprovals()[0].token,'cancel');await immediate();
  assert.deepEqual(f.replies('server-1').map(r=>r.result),[{outcome:{outcome:'cancelled'}}]);
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'synthetic write',reason:'cancelled'}]);
  const completion=await endNormally(f);assertCompleted(f,completion);
});

test('R16 policy decline from the approvals listener (unregistered MCP UseTool) is immediate and does not fail the turn',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();
  const policy=Object.freeze({root:'C:\\synthetic\\work',modelFlag:options.model,commandsApproved:true,subagentsApproved:true,mcpTools:['hub__hub_list_tasks','hub__hub_get_task','hub__hub_report']});
  const decided=[];
  // Same shape as the native provider service: decide on the published row, answer non-manual decisions synchronously.
  f.p.on('approvals',rows=>{
    for(const row of rows){
      if(!f.p.listApprovals().some(a=>a.token===row.token))continue;
      const decision=decide('grok',JSON.parse(row.detail),policy);decided.push(decision);
      if(decision!=='manual')f.p.respond(row.token,decision==='accept'?'accept':'decline');
    }
  });
  const toolCall={toolCallId:'mcp-write-1',title:'hub__hub_write_file',kind:'other',status:'pending',rawInput:{variant:'UseTool',tool_name:'hub__hub_write_file',tool_input:{project:'p',task:'t',path:'D:\\outside\\x.txt',text:'x'}}};
  scopedUpdate(f,sid,{sessionUpdate:'tool_call',...toolCall});
  routedPermission(f,'mcp-request-1',sid,toolCall);await immediate();
  assert.deepEqual(decided,['accept'],'a valid Hub MCP tool defers grant enforcement to the Hub capability check');
  assert.deepEqual(f.p.listApprovals(),[],'no approval card may be left waiting');
  assert.deepEqual(f.replies('mcp-request-1').map(r=>r.result),[{outcome:{outcome:'selected',optionId:'route-yes'}}]);
  assert.deepEqual(f.notices(),[]);
  const completion=await endNormally(f,'addNumbers');assert.equal(completion.errorCode,'GROK_NATIVE_INCOMPLETE','accepted tool has no terminal update in this fixture');
  assert.equal(f.rows().some(r=>r.result?.outcome?.optionId==='route-yes'),true);
});

test('R16 registered MCP UseTool is still accepted by policy and produces no notice',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();
  const policy=Object.freeze({root:'C:\\synthetic\\work',modelFlag:options.model,commandsApproved:true,subagentsApproved:true,mcpTools:['hub__hub_report']});
  f.p.on('approvals',rows=>{for(const row of rows){if(!f.p.listApprovals().some(a=>a.token===row.token))continue;const d=decide('grok',JSON.parse(row.detail),policy);if(d!=='manual')f.p.respond(row.token,d==='accept'?'accept':'decline');}});
  const toolCall={toolCallId:'mcp-report-1',title:'hub__hub_report',kind:'other',status:'pending',rawInput:{variant:'UseTool',tool_name:'hub__hub_report',tool_input:{project:'p',task:'t',text:'done'}}};
  scopedUpdate(f,sid,{sessionUpdate:'tool_call',...toolCall});routedPermission(f,'mcp-request-2',sid,toolCall);await immediate();
  assert.deepEqual(f.replies('mcp-request-2').map(r=>r.result),[{outcome:{outcome:'selected',optionId:'route-yes'}}]);
  f.update({sessionUpdate:'tool_call_update',toolCallId:'mcp-report-1',status:'completed'});
  const completion=await endNormally(f);assertCompleted(f,completion);assert.deepEqual(f.notices(),[]);
});

test('R16 an approval still pending when the CLI ends its turn stays GROK_NATIVE_INCOMPLETE',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();initialWrite(f);f.permission();
  assert.equal(f.p.listApprovals().length,1);
  f.result('end_turn');f.finish();await f.closed;const completion=await f.p.completion;
  assert.equal(completion.responseComplete,false);assert.equal(completion.errorCode,'GROK_NATIVE_INCOMPLETE');
  assert.equal(f.events().some(e=>e.type==='turn.completed'),false);
  assert.equal(f.replies('server-1').length,0,'nothing may be approved or rejected on the owner\'s behalf by end_turn');
});

test('R16 a declined tool does not excuse a different tool that never finished',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);
  f.update({sessionUpdate:'tool_call',toolCallId:'other-tool',title:'synthetic read',kind:'read',status:'pending',rawInput:{path:'b.txt'}});
  f.permission();f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
  const completion=await endNormally(f);
  assert.equal(completion.responseComplete,false);assert.equal(completion.errorCode,'GROK_NATIVE_INCOMPLETE');
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'synthetic write',reason:'declined'}]);
});

test('R16 other stop reasons stay INCOMPLETE after a decline',async t=>{
  for(const stop of ['max_tokens','max_turn_requests','refusal']){
    const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);f.permission();
    f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
    f.result(stop);f.finish();await f.closed;const completion=await f.p.completion;
    assert.equal(completion.responseComplete,false,stop);assert.equal(completion.errorCode,'GROK_NATIVE_INCOMPLETE',stop);
  }
});

test('R16 deferred permission whose tool never appears still fails GROK_NATIVE_PERMISSION_STATE',async t=>{
  const f=fixture(t,{approvalTimeoutMs:10});await f.init();f.permission();
  assert.deepEqual(f.p.listApprovals(),[]);await sleep(40);
  assert.equal(f.replies('server-1').length,0);
  f.finish(125);await f.closed;const completion=await f.p.completion;
  assert.equal(completion.errorCode,'GROK_NATIVE_PERMISSION_STATE');assert.equal(completion.responseComplete,false);
});

// The toolCallId title fallback is not exercised: the tool-state reducer already
// rejects a permission whose tool has no non-empty title.
test('R16 notice title has no control characters or line breaks, is trimmed and capped at 300',async t=>{
  const raw='  Write\r\nfile\tname\u0007\u001b[31m\u007fend '+'x'.repeat(400);
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();
  initialWrite(f,'long-tool',sid,raw);
  routedPermission(f,'long-request',sid,{toolCallId:'long-tool',title:raw,kind:'edit',status:'pending',rawInput:{file:'a.txt',content:'x'}});
  f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
  assert.deepEqual(f.replies('long-request').map(r=>r.result),[{outcome:{outcome:'selected',optionId:'route-no'}}]);
  const notices=f.notices();assert.equal(notices.length,1);
  const title=notices[0].title;assert.equal(typeof title,'string');
  assert.equal(CONTROL.test(title),false,'no control characters or line breaks: '+JSON.stringify(title.slice(0,40)));
  assert.equal(title,title.trim());assert.equal(title.length,300);
  assert.match(title,/^Write +file +name +\[31m +end x+$/);
  assert.equal(notices[0].reason,'declined');
});

test('R16 accepted approvals never produce a declined notice',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();initialWrite(f);f.permission();
  f.p.respond(f.p.listApprovals()[0].token,'accept');await immediate();
  assert.deepEqual(f.replies('server-1').map(r=>r.result),[{outcome:{outcome:'selected',optionId:'dynamic-yes'}}]);
  f.update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});
  const completion=await endNormally(f);assertCompleted(f,completion);assert.deepEqual(f.notices(),[]);
});
