'use strict';
// R16 / T2+T3 blind acceptance (Claude bridge): decline, expiry and cancel still
// answer the CLI with behavior:'deny', emit one hub.tool_declined notice and no
// longer fail the turn; permission_denials no longer fails a successful result.
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {PassThrough}=require('node:stream');
const {start}=require('../lib/claude-native-bridge');
const {decide}=require('../lib/native-provider-tool-policy');
const sid='12345678-1234-4234-8234-1234567890ab';
const options={model:'sonnet',effort:'low',sessionId:sid,resume:false,project:'p',task:'t',runId:'run-1',cwd:'C:\\synthetic\\work',validatedMcpConfig:{mcpServers:{}}};
const immediate=()=>new Promise(r=>setImmediate(r)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const CONTROL=/[\u0000-\u001f\u007f-\u009f]/;
const DENY=requestId=>({type:'control_response',response:{subtype:'success',request_id:requestId,response:{behavior:'deny',message:'Owner declined this operation.'}}});

function fixture(t,extra={}){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-backend'});
  let killed=0,ended=false,wire='';
  c.kill=()=>{killed++;return true;};
  c.stdin.on('data',d=>wire+=d);
  const p=start({...options,...extra,openEndpoint:()=>{setImmediate(()=>c.emit('spawn'));return c;}});
  let output='';p.stdout.on('data',d=>output+=d);p.stderr.resume();
  const closed=once(p,'close');
  function finish(code=0,receipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}){
    if(ended)return;ended=true;c.cleanupReceipt=receipt;c.stdout.end();c.stderr.end();c.emit('close',code,null);
  }
  t.after(async()=>{p.kill();finish(1,null);await closed;});
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push=f=>c.stdout.write(Buffer.from(JSON.stringify(f)+'\n'));
  async function init(){
    p.stdin.end('Synthetic task');await immediate();await immediate();
    const r=rows()[0];assert.equal(r.type,'control_request');assert.equal(r.request.subtype,'initialize');
    push({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{commands:[],models:[]}}});
    push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5',tools:['Read']});
    await immediate();assert.equal(await p.ready,true);return r;
  }
  const result=(extra={})=>push({type:'result',subtype:'success',is_error:false,session_id:sid,result:'fixture reply',permission_denials:[],...extra});
  const permission=(id='req-tool-1',tool_name='Write',input={file_path:'file.txt',content:'a\n字'},tool_use_id='tool-1')=>
    push({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name,tool_use_id,input,decision_reason:'not authority'}});
  const events=()=>output.trim().split('\n').filter(Boolean).map(JSON.parse);
  const notices=()=>events().filter(e=>e.type==='hub.tool_declined');
  const replies=id=>rows().filter(r=>r.type==='control_response'&&r.response?.request_id===id);
  return {p,c,push,init,result,permission,finish,closed,rows,events,notices,replies,kills:()=>killed};
}
const denial={tool_name:'Write',tool_use_id:'tool-1',tool_input:{file_path:'file.txt',content:'a\n字'}};
async function endWithDenials(f){f.result({permission_denials:[denial]});f.finish();await f.closed;return f.p.completion;}
function assertCompleted(f,completion){
  assert.equal(completion.responseComplete,true,'turn must complete: '+completion.errorCode);
  assert.equal(completion.errorCode,null);
  assert.equal(f.events().filter(e=>e.type==='turn.completed').length,1);
  assert.equal(f.events().some(e=>e.type==='turn.failed'),false);
}

test('R16 Claude owner decline: same deny reply, one declined notice, token spent, completes despite permission_denials',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();f.permission();
  const a=f.p.listApprovals()[0];assert.ok(a);
  assert.equal(f.p.respond(a.token,'decline'),true);await immediate();
  assert.deepEqual(f.replies('req-tool-1'),[DENY('req-tool-1')]);
  assert.deepEqual(f.p.listApprovals(),[]);
  for(const decision of ['accept','decline','cancel'])assert.throws(()=>f.p.respond(a.token,decision),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});
  assert.equal(f.replies('req-tool-1').length,1);
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'Write file.txt',reason:'declined'}]);
  const completion=await endWithDenials(f);assertCompleted(f,completion);
  assert.equal(f.rows().some(r=>r.response?.response?.behavior==='allow'),false,'a refused operation is never allowed');
  assert.equal(f.notices().length,1);
});

test('R16 Claude approval timer expiry: deny reply, one expired notice, turn completes',async t=>{
  const f=fixture(t,{approvalTimeoutMs:10});await f.init();f.permission();
  const a=f.p.listApprovals()[0];assert.ok(a);
  await sleep(40);
  assert.deepEqual(f.replies('req-tool-1'),[DENY('req-tool-1')]);assert.deepEqual(f.p.listApprovals(),[]);
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'Write file.txt',reason:'expired'}]);
  const completion=await endWithDenials(f);assertCompleted(f,completion);
  assert.equal(f.rows().some(r=>r.response?.response?.behavior==='allow'),false);
});

test('R16 Claude respond after the deadline still throws EXPIRED, sends deny, one expired notice, turn completes',async t=>{
  let wall=1700000000000;t.mock.method(Date,'now',()=>wall);
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();f.permission();
  const a=f.p.listApprovals()[0];assert.equal(a.expiresAt,wall+1000);
  wall+=1000;
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'CLAUDE_NATIVE_APPROVAL_EXPIRED'});await immediate();
  assert.deepEqual(f.replies('req-tool-1'),[DENY('req-tool-1')]);
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'Write file.txt',reason:'expired'}]);
  const completion=await endWithDenials(f);assertCompleted(f,completion);
});

test('R16 Claude owner cancel: deny reply, one cancelled notice, turn completes',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();f.permission();
  const a=f.p.listApprovals()[0];f.p.respond(a.token,'cancel');await immediate();
  assert.deepEqual(f.replies('req-tool-1'),[DENY('req-tool-1')]);
  assert.throws(()=>f.p.respond(a.token,'cancel'),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'Write file.txt',reason:'cancelled'}]);
  const completion=await endWithDenials(f);assertCompleted(f,completion);
});

test('R16 Claude policy decline of an unregistered mcp__ tool is immediate and does not fail the turn',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();
  const policy=Object.freeze({root:'C:\\synthetic\\work',modelFlag:'sonnet',commandsApproved:true,subagentsApproved:true,mcpTools:['mcp__hub__hub_list_tasks','mcp__hub__hub_get_task','mcp__hub__hub_report']});
  const decided=[];
  f.p.on('approvals',rows=>{
    for(const row of rows){
      if(!f.p.listApprovals().some(a=>a.token===row.token))continue;
      const decision=decide('claude',JSON.parse(row.detail),policy);decided.push(decision);
      if(decision!=='manual')f.p.respond(row.token,decision==='accept'?'accept':'decline');
    }
  });
  f.push({type:'assistant',session_id:sid,message:{content:[{type:'tool_use',id:'mcp-1',name:'mcp__hub__hub_write_file',input:{project:'p',task:'t',path:'D:\\outside\\x.txt',text:'x'}}]}});
  f.permission('req-mcp-1','mcp__hub__hub_write_file',{project:'p',task:'t',path:'D:\\outside\\x.txt',text:'x'},'mcp-1');await immediate();
  assert.deepEqual(decided,['decline'],'an unregistered MCP tool must be declined at once, not left for a manual card');
  assert.deepEqual(f.p.listApprovals(),[]);
  assert.deepEqual(f.replies('req-mcp-1'),[DENY('req-mcp-1')]);
  assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:'mcp__hub__hub_write_file D:\\outside\\x.txt',reason:'declined'}]);
  f.push({type:'user',session_id:sid,message:{role:'user',content:[{type:'tool_result',tool_use_id:'mcp-1',content:'Owner declined this operation.',is_error:true}]}});
  f.push({type:'assistant',session_id:sid,message:{content:[{type:'text',text:'addNumbers'}]}});
  f.result({permission_denials:[{tool_name:'mcp__hub__hub_write_file',tool_use_id:'mcp-1',tool_input:{}}]});f.finish();await f.closed;
  assertCompleted(f,await f.p.completion);
});

test('R16 Claude registered mcp__ tool is still accepted and produces no notice',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();
  const policy=Object.freeze({root:'C:\\synthetic\\work',modelFlag:'sonnet',commandsApproved:true,subagentsApproved:true,mcpTools:['mcp__hub__hub_report']});
  f.p.on('approvals',rows=>{for(const row of rows){if(!f.p.listApprovals().some(a=>a.token===row.token))continue;const d=decide('claude',JSON.parse(row.detail),policy);if(d!=='manual')f.p.respond(row.token,d==='accept'?'accept':'decline');}});
  f.permission('req-mcp-2','mcp__hub__hub_report',{project:'p',task:'t',text:'done'},'mcp-2');await immediate();
  assert.equal(f.replies('req-mcp-2')[0].response.response.behavior,'allow');
  f.result();f.finish();await f.closed;assertCompleted(f,await f.p.completion);assert.deepEqual(f.notices(),[]);
});

test('R16 Claude approval still pending at result stays CLAUDE_NATIVE_INCOMPLETE',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();f.permission();
  assert.equal(f.p.listApprovals().length,1);
  f.result();f.finish();await f.closed;const completion=await f.p.completion;
  assert.equal(completion.responseComplete,false);assert.equal(completion.errorCode,'CLAUDE_NATIVE_INCOMPLETE');
  assert.equal(f.events().some(e=>e.type==='turn.completed'),false);
  assert.equal(f.replies('req-tool-1').length,0);
});

test('R16 Claude non-empty permission_denials alone no longer fails a successful result; non-array is still invalid',async t=>{
  const bad=fixture(t);await bad.init();
  bad.result({permission_denials:'not-an-array'});bad.finish(125);await bad.closed;const completion=await bad.p.completion;
  assert.equal(completion.errorCode,'CLAUDE_NATIVE_RESULT_INVALID');assert.equal(completion.responseComplete,false);
  const f=fixture(t);await f.init();
  f.result({permission_denials:[denial]});f.finish();await f.closed;
  assertCompleted(f,await f.p.completion);
});

test('R16 Claude error results stay incomplete after a decline',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();f.permission();
  f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
  f.result({subtype:'error_during_execution',is_error:true,permission_denials:[denial]});f.finish();await f.closed;
  const completion=await f.p.completion;assert.equal(completion.responseComplete,false);assert.equal(completion.errorCode,'CLAUDE_NATIVE_INCOMPLETE');
});

test('R16 Claude notice title is tool_name plus the first present string of file_path, path, command, pattern',async t=>{
  const cases=[
    ['Write',{file_path:'src\\a.js',path:'ignored',command:'ignored',content:'x'},'Write src\\a.js'],
    ['Grep',{file_path:42,path:'lib',pattern:'add'},'Grep lib'],
    ['Bash',{command:'node test.cjs',pattern:'ignored'},'Bash node test.cjs'],
    ['Glob',{pattern:'**/*.js'},'Glob **/*.js'],
    ['mcp__hub__hub_delegate',{project:'p',task:'t'},'mcp__hub__hub_delegate']
  ];
  let n=0;
  for(const [name,input,expected]of cases){
    const f=fixture(t,{approvalTimeoutMs:1000});await f.init();const id='req-title-'+(++n);
    f.permission(id,name,input,'tool-title-'+n);f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
    assert.deepEqual(f.replies(id),[DENY(id)],name);
    assert.deepEqual(f.notices(),[{type:'hub.tool_declined',title:expected,reason:'declined'}],name);
  }
});

test('R16 Claude notice title has no control characters or line breaks, is trimmed and capped at 300',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();
  const command='npm test\r\nrm -rf build\u0007\u001b[0m\t'+'y'.repeat(400)+'\n';
  f.permission('req-long','Bash',{command},'tool-long');f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
  assert.deepEqual(f.replies('req-long'),[DENY('req-long')]);
  const notices=f.notices();assert.equal(notices.length,1);
  const title=notices[0].title;assert.equal(typeof title,'string');
  assert.equal(CONTROL.test(title),false,'no control characters or line breaks: '+JSON.stringify(title.slice(0,40)));
  assert.equal(title,title.trim());assert.equal(title.length,300);
  assert.match(title,/^Bash npm test +rm -rf build +\[0m +y+$/);
  assert.equal(notices[0].reason,'declined');
});

test('R16 Claude accept never produces a declined notice and keeps the exact allow reply',async t=>{
  const f=fixture(t,{approvalTimeoutMs:1000});await f.init();f.permission();
  f.p.respond(f.p.listApprovals()[0].token,'accept');await immediate();
  assert.deepEqual(f.replies('req-tool-1'),[{type:'control_response',response:{subtype:'success',request_id:'req-tool-1',response:{behavior:'allow',updatedInput:{file_path:'file.txt',content:'a\n字'}}}}]);
  f.result();f.finish();await f.closed;assertCompleted(f,await f.p.completion);assert.deepEqual(f.notices(),[]);
});
