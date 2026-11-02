'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {PassThrough}=require('node:stream');
const {start,buildArgs}=require('../lib/claude-native-bridge');
const {TOOLS}=require('../lib/claude-subagent-context');
const sid='12345678-1234-4234-8234-123456789abc';
const options={model:'sonnet',effort:'low',sessionId:sid,resume:false,project:'p',task:'t',runId:'run-1',cwd:'C:\\synthetic',validatedMcpConfig:{mcpServers:{}}};
const immediate=()=>new Promise(r=>setImmediate(r));
function fixture(t,extra={}){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-backend'});
  let killed=0,ended=false,wire='',args;
  c.kill=()=>{killed++;return true;};
  c.stdin.on('data',d=>wire+=d);
  const p=start({...options,...extra,openEndpoint:a=>{args=a;setImmediate(()=>c.emit('spawn'));return c;}});
  let output='';p.stdout.on('data',d=>output+=d);p.stderr.resume();
  const closed=once(p,'close');
  function finish(code=0,receipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}){
    if(ended)return;ended=true;c.cleanupReceipt=receipt;c.stdout.end();c.stderr.end();c.emit('close',code,null);
  }
  t.after(async()=>{p.kill();finish(1,null);await closed;});
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push=f=>c.stdout.write(Buffer.from(JSON.stringify(f)+'\n'));
  async function init({sendInit=true}={}){
    p.stdin.end('Synthetic task');await immediate();await immediate();
    const r=rows()[0];assert.equal(r.type,'control_request');assert.equal(r.request.subtype,'initialize');
    push({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{commands:[],models:[]}}});
    if(sendInit)push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5',tools:['Read'],extraMetadata:{preserve:'inert'}});
    await immediate();return r;
  }
  const result=(extra={})=>push({type:'result',subtype:'success',is_error:false,session_id:sid,result:'fixture reply',permission_denials:[],...extra});
  const permission=(id='req-tool-1')=>push({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:'Write',tool_use_id:'tool-1',input:{file_path:'file.txt',content:'a\n字'},decision_reason:'not authority'}});
  return {p,c,push,init,result,permission,finish,closed,rows,events:()=>output.trim().split('\n').filter(Boolean).map(JSON.parse),kills:()=>killed,args:()=>args};
}

for(const mode of ['decline','timer','late','cancel'])test(`R16 Claude ${mode} sends deny once and completes despite permission_denials`,async t=>{
  let now=Date.now();if(mode==='late')t.mock.method(Date,'now',()=>now);
  const f=fixture(t,{approvalTimeoutMs:mode==='timer'?20:1000});await f.init();f.permission();const a=f.p.listApprovals()[0];
  if(mode==='timer')await new Promise(r=>setTimeout(r,45));
  else if(mode==='late'){now+=1000;assert.throws(()=>f.p.respond(a.token,'accept'),{code:'CLAUDE_NATIVE_APPROVAL_EXPIRED'});}
  else f.p.respond(a.token,mode);
  assert.throws(()=>f.p.respond(a.token,'accept'),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});await immediate();
  const replies=f.rows().filter(r=>r.type==='control_response'&&r.response.request_id==='req-tool-1');
  assert.equal(replies.length,1);assert.deepEqual(replies[0].response.response,{behavior:'deny',message:'Owner declined this operation.'});
  assert.deepEqual(f.events().filter(r=>r.type==='hub.tool_declined'),[{type:'hub.tool_declined',title:'Write file.txt',reason:mode==='cancel'?'cancelled':['timer','late'].includes(mode)?'expired':'declined'}]);
  assert.deepEqual(f.p.listApprovals(),[]);
  f.result({permission_denials:[{tool_name:'Write'}]});f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);assert.equal(f.events().filter(r=>r.type==='turn.completed').length,1);
});

test('R16 Claude title uses first string, sanitizes controls, trims and caps at 300',async t=>{
  for(const [input,title]of [[{file_path:'a\r\n\tb',path:'ignored'},'Read a b'],[{file_path:42,path:'path',command:'ignored'},'Read path'],[{command:'cmd',pattern:'ignored'},'Read cmd'],[{pattern:'needle'},'Read needle'],[{},'Read'],[{file_path:'x'.repeat(400)},('Read '+'x'.repeat(400)).slice(0,300)]]){
    const f=fixture(t);await f.init();f.push({type:'control_request',request_id:'title',request:{subtype:'can_use_tool',tool_name:'Read',tool_use_id:'read-1',input}});
    f.p.respond(f.p.listApprovals()[0].token,'decline');await immediate();
    assert.equal(f.events().find(r=>r.type==='hub.tool_declined').title,title);
    f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
  }
});

test('R16 Claude pending approval still fails and permission_denials must remain an array',async t=>{
  for(const pending of [true,false]){
    const f=fixture(t);await f.init();if(pending)f.permission();
    f.result({permission_denials:pending?[]:{}});f.finish();await f.closed;
    assert.equal((await f.p.completion).errorCode,pending?'CLAUDE_NATIVE_INCOMPLETE':'CLAUDE_NATIVE_RESULT_INVALID');
    assert.equal(f.events().some(r=>r.type==='turn.completed'),false);
  }
});
