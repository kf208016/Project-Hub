'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {PassThrough}=require('node:stream');
const {start,buildArgs}=require('../lib/claude-native-bridge');
const {TOOLS}=require('../lib/claude-subagent-context');
const sid='12345678-1234-4234-8234-123456789abc';
const options={model:'sonnet',effort:'low',sessionId:sid,resume:false,project:'p',task:'t',runId:'run-1',cwd:'C:\\synthetic',validatedMcpConfig:{mcpServers:{}}};
const immediate=()=>new Promise(r=>setImmediate(r));
test('CLI default omits all model overrides, retains effort and accepts Claude reported models only',async t=>{
 for(const model of ['claude-opus-5-5','claude-fable-5-1','claude-future-7','grok-4.6','claude-','claude-sonnet-5\n']){
  const f=fixture(t,{model:''});await f.init({sendInit:false});
  const args=f.args();assert.equal(args.includes('--model'),false);assert.equal(args[args.indexOf('--effort')+1],'low');
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings')+1]),{disableAllHooks:true,autoMemoryEnabled:false});
  f.push({type:'system',subtype:'init',session_id:sid,model});
  if(/^claude-[a-z0-9-]+$/.test(model)&&!model.endsWith('\n')){assert.equal(await f.p.ready,true);assert.equal(f.p.reportedModel,model);f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);}
  else{f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_MODEL_MISMATCH');}
 }
});
test('native Fable selection retains its exact model and usage limits remain errors',async t=>{
 const f=fixture(t,{model:'claude-fable-5-1'});await f.init({sendInit:false});
 assert.equal(f.args()[f.args().indexOf('--model')+1],'claude-fable-5-1');
 f.push({type:'system',subtype:'init',session_id:sid,model:'claude-fable-5-1'});await f.p.ready;
 f.result({is_error:true,subtype:'error_during_execution',errors:['Usage limit reached']});f.finish();await f.closed;
 assert.equal((await f.p.completion).responseComplete,false);assert.ok(f.events().some(row=>row.type==='error'||row.type==='turn.failed'));
});
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
test('buildArgs keeps owner permission channel and explicitly admitted MCP without safe-mode',()=>{
  const a=buildArgs(options);assert.equal(a.includes('--safe-mode'),false);assert.equal(a.includes('--dangerously-skip-permissions'),false);
  assert.equal(a[a.indexOf('--permission-prompt-tool')+1],'stdio');assert.equal(a[a.indexOf('--strict-mcp-config')+1],'--mcp-config');
  assert.equal(a.at(-2),'--session-id');assert.equal(buildArgs({...options,resume:true}).at(-2),'--resume');
  assert.equal(a.includes('--restricted'),true);
  assert.equal(a[a.indexOf('--tools')+1],TOOLS.join(','));
  const tools=a[a.indexOf('--tools')+1].split(',');
  assert.ok(tools.includes('Bash'));assert.ok(tools.includes('PowerShell'));
  for(const blocked of ['default','WebSearch','WebFetch','ComputerUse','BrowserOpen'])assert.equal(tools.includes(blocked),false);
  assert.equal(a[a.indexOf('--disallowedTools')+1],'WebSearch,WebFetch');
});
test('real documented handshake nesting sends exactly one prompt and keeps duplex input open',async t=>{
  const f=fixture(t);await f.init();assert.equal(await f.p.ready,true);
  assert.deepEqual(f.rows().filter(x=>x.type==='user'),[{type:'user',message:{role:'user',content:'Synthetic task'},parent_tool_use_id:null,session_id:sid}]);
  assert.equal(f.c.stdin.writableEnded,false);
  f.push({type:'system',subtype:'thinking_tokens',session_id:sid,estimated_tokens:7});
  f.push({type:'rate_limit_event',session_id:sid,rate_limit_info:{status:'allowed'}});
  f.push({type:'assistant',session_id:sid,message:{content:[{type:'thinking',thinking:''},{type:'text',text:'done'},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'file.txt'}}]}});
  f.push({type:'user',session_id:sid,message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:[{type:'text',text:'content'}]}]}});
  f.result();await immediate();assert.equal(f.events().some(e=>e.type==='turn.completed'),false);
  f.finish();assert.deepEqual(await f.closed,[0,null]);assert.equal((await f.p.completion).responseComplete,true);
  assert.equal(f.events().at(-1).type,'turn.completed');assert.equal(f.events().filter(e=>e.item?.type==='agent_message').length,1);
});
test('owner approval is once-only and uses exact original input in nested control response',async t=>{
  const f=fixture(t);await f.init();const notice=once(f.p,'approvals');f.permission();await notice;
  const a=f.p.listApprovals()[0];assert.equal(a.project,'p');assert.equal(a.task,'t');assert.equal(a.sessionId,sid);
  assert.throws(()=>f.p.respond('foreign','accept'),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});
  assert.throws(()=>f.p.respond(a.token,'allow-always'),{code:'CLAUDE_NATIVE_APPROVAL_DECISION'});
  f.p.respond(a.token,'accept');assert.throws(()=>f.p.respond(a.token,'accept'),{code:'CLAUDE_NATIVE_APPROVAL_UNKNOWN'});
  await immediate();assert.deepEqual(f.rows().at(-1),{type:'control_response',response:{subtype:'success',request_id:'req-tool-1',response:{behavior:'allow',updatedInput:{file_path:'file.txt',content:'a\n字'}}}});
  f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});
test('decline and expiry never become reply success even if remote reports success',async t=>{
  for(const expired of [false,true]){
    const f=fixture(t,{approvalTimeoutMs:expired?10:1000});await f.init();f.permission();const a=f.p.listApprovals()[0];
    if(expired)await new Promise(r=>setTimeout(r,25));else f.p.respond(a.token,'decline');
    await immediate();assert.equal(f.rows().at(-1).response.response.behavior,'deny');assert.deepEqual(f.p.listApprovals(),[]);
    f.result();f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,false);
  }
});
test('stop retains ownership until child actually closes and clears pending approval',async t=>{
  const f=fixture(t);await f.init();f.permission();let closed=false;f.p.once('close',()=>closed=true);
  f.p.kill();await immediate();assert.equal(closed,false);assert.ok(f.kills()>0);assert.deepEqual(f.p.listApprovals(),[]);
  f.finish(125,{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:125});await f.closed;
  assert.equal((await f.p.completion).cleanupVerified,true);assert.equal((await f.p.completion).responseComplete,false);
});
test('missing receipt or root exit failure cannot emit success',async t=>{
  for(const [code,receipt]of [[0,null],[3,{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:3}],
    [0,{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:125}]]){
    const f=fixture(t);await f.init();f.result();f.finish(code,receipt);await f.closed;
    assert.equal(f.events().some(x=>x.type==='turn.completed'),false);assert.equal((await f.p.completion).responseComplete,false);
  }
});
test('invalid wire, duplicate init and foreign session fail closed',async t=>{
  const malformed=[Buffer.from('{"type":"assistant","message":{"content":[]},"session_id":"foreign"}\n'),
    Buffer.from('{"type":"user","type":"result"}\n'),Buffer.from('{"type":"user","message":{"role":"user","content":"\\ud800"}}\n'),
    Buffer.from([0xc3,0x28,0x0a]),Buffer.from('{"type":"user","message":{"role":"user","content":"\\u0000"}}\n')];
  for(const bytes of malformed){const f=fixture(t);await f.init();f.c.stdout.write(bytes);f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,false);assert.ok(f.kills()>0);}
  const f=fixture(t);await f.init();f.push({type:'system',subtype:'init',session_id:sid,model:'sonnet'});f.finish();await f.closed;assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_INIT_SESSION');
});
test('partial EOF and result with pending approvals are incomplete',async t=>{
  const f=fixture(t);await f.init();f.result();f.c.stdout.write('{"partial":');f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,false);
  const p=fixture(t);await p.init();p.permission();p.result();p.finish();await p.closed;
  assert.equal((await p.p.completion).responseComplete,false);
});
test('handshake failure and timeout keep close tied to real owned exit',async t=>{
  const f=fixture(t,{initTimeoutMs:15});let closed=false;f.p.on('close',()=>closed=true);f.p.stdin.end('x');
  await new Promise(r=>setTimeout(r,30));assert.equal(closed,false);assert.ok(f.kills()>0);f.finish();await f.closed;
  assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_INIT_TIMEOUT');
});

test('wrong primary model and broken owner approval observer fail closed',async t=>{
  const model=fixture(t);await model.init({sendInit:false});model.push({type:'system',subtype:'init',session_id:sid,model:'claude-opus-5-5'});
  model.finish();await model.closed;assert.equal((await model.p.completion).errorCode,'CLAUDE_NATIVE_MODEL_MISMATCH');
  const owner=fixture(t);await owner.init();owner.p.on('approvals',rows=>{if(rows.length)throw Error('PRIVATE_OWNER_ERROR');});
  owner.permission();owner.finish();await owner.closed;assert.equal((await owner.p.completion).errorCode,'CLAUDE_NATIVE_OWNER_EVENT_FAILED');
});

test('native input usage preserves actual cache accounting without guessed zero values',async t=>{
  const f=fixture(t);await f.init();f.result({usage:{input_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:50}});f.finish();await f.closed;
  assert.deepEqual(f.events().at(-1).usage,{input_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:50});
});

test('invalid stream shapes report fixed stage codes without provider content',async t=>{
  const privateText='PRIVATE_SYNTHETIC_FRAME_CONTENT';
  const cases=[
    ['CLAUDE_NATIVE_FRAME_INVALID',{synthetic:privateText}],
    ['CLAUDE_NATIVE_SYSTEM_METADATA_INVALID',{type:'system',subtype:privateText}],
    ['CLAUDE_NATIVE_ASSISTANT_ENVELOPE',{type:'assistant',message:{content:privateText}}],
    ['CLAUDE_NATIVE_ASSISTANT_BLOCK',{type:'assistant',message:{content:[privateText]}}],
    ['CLAUDE_NATIVE_ASSISTANT_TEXT',{type:'assistant',message:{content:[{type:'text',text:123}]}}],
    ['CLAUDE_NATIVE_ASSISTANT_TOOL_USE',{type:'assistant',message:{content:[{type:'tool_use',id:'synthetic-tool',name:'Read',input:privateText}]}}],
    ['CLAUDE_NATIVE_USER_ENVELOPE',{type:'user',message:{role:privateText,content:[]}}]
  ];
  for(const [expected,frame]of cases){
    const f=fixture(t);await f.init();const before=f.events().length;f.push(frame);await immediate();f.finish(125);await f.closed;
    const completion=await f.p.completion;
    assert.equal(completion.errorCode,expected);assert.equal(completion.responseComplete,false);assert.ok(f.kills()>0);
    assert.equal(f.events().slice(before).some(row=>row.item),false);assert.deepEqual(f.p.listApprovals(),[]);
    assert.equal(JSON.stringify({completion,events:f.events()}).includes(privateText),false);
  }
});

test('tool result content and is_error diagnostics preserve the original rejection gates',async t=>{
  for(const [expected,content,isError]of [
    ['CLAUDE_NATIVE_TOOL_RESULT_CONTENT',123,false],
    ['CLAUDE_NATIVE_TOOL_RESULT_ERROR','synthetic output','PRIVATE_SYNTHETIC_ERROR_VALUE']
  ]){
    const f=fixture(t);await f.init();lineageTool(f,'result-source','Read');let results=0;f.p.on('toolResult',()=>{results++;});
    lineageUser(f,null,[{type:'tool_result',tool_use_id:'result-source',content,is_error:isError}]);await immediate();f.finish(125);await f.closed;
    const completion=await f.p.completion;
    assert.equal(completion.errorCode,expected);assert.equal(completion.responseComplete,false);assert.equal(results,0);assert.ok(f.kills()>0);
    assert.equal(JSON.stringify({completion,events:f.events()}).includes('PRIVATE_SYNTHETIC_ERROR_VALUE'),false);
  }
});

test('rate-limit before initialization and non-buffer stdout retain fixed failure categories',async t=>{
  const early=fixture(t);await early.init({sendInit:false});early.push({type:'rate_limit_event'});await immediate();early.finish(125);await early.closed;
  assert.equal((await early.p.completion).errorCode,'CLAUDE_NATIVE_RATE_LIMIT_STATE');
  const output=fixture(t);await output.init();output.c.stdout.emit('data','PRIVATE_SYNTHETIC_NONBUFFER');await immediate();output.finish(125);await output.closed;
  assert.equal((await output.p.completion).errorCode,'CLAUDE_NATIVE_OUTPUT_CHUNK_INVALID');
  assert.equal(JSON.stringify(output.events()).includes('PRIVATE_SYNTHETIC_NONBUFFER'),false);
});

function lineageTool(f,id,name,parent=null){
  f.push({type:'assistant',session_id:sid,parent_tool_use_id:parent,
    message:{content:[{type:'tool_use',id,name,input:name==='Agent'?{description:'Synthetic child',prompt:'Only synthetic work'}:{file_path:'synthetic.txt'}}]}});
}
function lineageUser(f,parent,content,uuid){
  f.push({type:'user',session_id:sid,parent_tool_use_id:parent,...(uuid?{uuid}:{}),message:{role:'user',content}});
}
const lineageResult=id=>[{type:'tool_result',tool_use_id:id,content:[{type:'text',text:'synthetic success'}],is_error:false}];

test('documented Agent first prompt is inert and child/root results retain their own lineage',async t=>{
  for(const content of ['Synthetic child prompt',[{type:'text',text:'Synthetic child prompt'}]]){
    let sessions=0,toolResultEvents=0,approvalRequests=0;
    const f=fixture(t,{onSession:()=>{sessions++;}});await f.init();
    f.p.on('toolResult',()=>{toolResultEvents++;});f.p.on('approvals',rows=>{approvalRequests+=rows.length;});
    lineageTool(f,'agent-1','Agent');
    const eventsBefore=f.events().length,wireBefore=f.rows().length;
    lineageUser(f,'agent-1',content,'child-prompt');await immediate();
    assert.equal(f.kills(),0);assert.equal(f.events().length,eventsBefore);assert.equal(f.rows().length,wireBefore);
    assert.equal(sessions,1);assert.equal(toolResultEvents,0);assert.equal(approvalRequests,0);
    lineageTool(f,'child-read','Read','agent-1');
    lineageUser(f,'agent-1',lineageResult('child-read'));
    lineageUser(f,null,lineageResult('agent-1'));
    f.result();f.finish();await f.closed;
    assert.equal((await f.p.completion).responseComplete,true);assert.equal(toolResultEvents,2);assert.equal(sessions,1);
  }
});

test('nested Agent contexts are admitted only through already registered Agent tools',async t=>{
  const f=fixture(t);await f.init();
  lineageTool(f,'outer','Agent');lineageUser(f,'outer',[{type:'text',text:'Outer child context'}]);
  lineageTool(f,'inner','Agent','outer');lineageUser(f,'inner','Inner child context');
  lineageTool(f,'inner-read','Read','inner');lineageUser(f,'inner',lineageResult('inner-read'));
  lineageUser(f,'outer',lineageResult('inner'));lineageUser(f,null,lineageResult('outer'));
  f.result();f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);
});

test('unknown, non-Agent and malformed parent values fail closed for child user messages',async t=>{
  for(const parent of ['unknown-agent','known-read',false,0,'',[]]){
    const f=fixture(t);await f.init();lineageTool(f,'known-read','Read');
    lineageUser(f,parent,[{type:'text',text:'Must not become authority'}]);f.finish();await f.closed;
    const result=await f.p.completion;
    assert.equal(result.errorCode,'CLAUDE_NATIVE_SUBAGENT_SCOPE');assert.equal(result.responseComplete,false);assert.ok(f.kills()>0);
    assert.deepEqual(f.p.listApprovals(),[]);
  }
});

test('unknown or non-Agent parents cannot register assistant child tools',async t=>{
  for(const parent of ['unknown-agent','known-read']){
    const f=fixture(t);await f.init();lineageTool(f,'known-read','Read');
    const before=f.events().length;
    lineageTool(f,'forged-child','Read',parent);await immediate();
    assert.equal(f.events().length,before);f.finish();await f.closed;
    assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_SUBAGENT_SCOPE');
  }
});

test('fresh UUID cannot replay a child first prompt',async t=>{
  const f=fixture(t);await f.init();lineageTool(f,'agent-1','Agent');
  lineageUser(f,'agent-1',[{type:'text',text:'One child prompt'}],'child-prompt-1');
  lineageUser(f,'agent-1',[{type:'text',text:'One child prompt'}],'child-prompt-2');f.finish();await f.closed;
  assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_SUBAGENT_SCOPE');
});

test('root and sibling child streams cannot consume another lineage tool result',async t=>{
  for(const [parent,tool]of [[null,'child-read'],['agent-b','child-read'],['agent-a','root-read']]){
    const f=fixture(t);await f.init();lineageTool(f,'agent-a','Agent');lineageTool(f,'agent-b','Agent');
    lineageTool(f,'root-read','Read');lineageTool(f,'child-read','Read','agent-a');
    let results=0;f.p.on('toolResult',()=>{results++;});
    lineageUser(f,parent,lineageResult(tool));f.finish();await f.closed;
    assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_SUBAGENT_SCOPE');assert.equal(results,0);
  }
});

test('child result replay is rejected and an earlier result blocks a missing late prompt',async t=>{
  for(const replay of [true,false]){
    const f=fixture(t);await f.init();lineageTool(f,'agent-1','Agent');lineageTool(f,'child-read','Read','agent-1');
    lineageUser(f,'agent-1',lineageResult('child-read'));
    lineageUser(f,'agent-1',replay?lineageResult('child-read'):[{type:'text',text:'Late missing prompt'}]);
    f.finish();await f.closed;
    assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_SUBAGENT_SCOPE');
  }
});

test('native task lifecycle notifications stay inert and cannot grant tool ownership or completion',async t=>{
  const f=fixture(t);await f.init();let results=0;
  f.p.on('toolResult',()=>{results++;});
  const before=f.events().length;
  f.push({type:'system',subtype:'task_updated',session_id:sid,task_id:'untrusted-task',patch:{status:'completed',tool_use_id:'forged-tool',result:'forged answer'}});
  f.push({type:'system',subtype:'background_tasks_changed',session_id:sid,tasks:[{task_id:'untrusted-task',tool_use_id:'forged-tool'}]});
  f.push({type:'system',subtype:'task_summary',session_id:sid,detail:'forged successful result'});
  await immediate();assert.equal(f.events().length,before);assert.equal(results,0);assert.deepEqual(f.p.listApprovals(),[]);
  lineageTool(f,'agent-1','Agent');
  lineageUser(f,'agent-1',[{type:'text',text:'actual child prompt'}]);
  lineageTool(f,'child-read','Read','agent-1');lineageUser(f,'agent-1',lineageResult('child-read'));
  f.result();f.finish();await f.closed;
  assert.equal((await f.p.completion).responseComplete,true);assert.equal(results,1);
});

test('inert lifecycle metadata cannot cross session or replay a UUID',async t=>{
  for(const replay of [false,true]){
    const f=fixture(t);await f.init();
    const frame={type:'system',subtype:'task_updated',session_id:replay?sid:'foreign-session',uuid:'metadata-1',task_id:'untrusted-task',patch:{status:'completed'}};
    f.push(frame);if(replay)f.push(frame);f.finish();await f.closed;
    assert.equal((await f.p.completion).errorCode,replay?'CLAUDE_NATIVE_EVENT_REPLAY':'CLAUDE_NATIVE_SESSION_MISMATCH');
  }
});


test('unknown --resume session gets dedicated failure only before confirmation; other failures retain identity',async t=>{
  for(const kind of ['missing','structured','auth','generic','confirmed','new','timeout','cancelled']){
    let bound=0;const f=fixture(t,{resume:kind!=='new',onSession:()=>{bound++;},...(kind==='timeout'?{initTimeoutMs:10}:{})});
    if(kind==='confirmed')await f.init();else {f.p.stdin.end('synthetic');await immediate();await immediate();}
    if(kind==='structured')f.push({type:'result',session_id:sid,is_error:true,subtype:'error_during_execution',errors:['No conversation found with session ID: '+sid]});
    else f.c.stderr.write(kind==='auth'?'Authentication failed':kind==='generic'?'other failure':'No conversation found with session ID: '+sid);
    if(kind==='timeout')await new Promise(r=>setTimeout(r,25));if(kind==='cancelled')f.p.kill();
    f.finish(1);await f.closed;const code=(await f.p.completion).errorCode;
    assert.equal(code==='CLAUDE_NATIVE_RESUME_FAILED',['missing','structured','auth','generic'].includes(kind),kind);
    assert.equal(bound,kind==='confirmed'?1:0);assert.equal(JSON.stringify(f.events()).includes('No conversation found'),false);
    if(kind==='timeout')assert.equal(code,'CLAUDE_NATIVE_INIT_TIMEOUT');
  }
});
test('Claude resume binds before prompt but publishes only after matching provider init',async t=>{
  let bound=0;const f=fixture(t,{resume:true,onSession:()=>{bound++;}});await f.init({sendInit:false});assert.equal(bound,1);assert.equal(f.events().some(e=>e.type==='thread.started'),false);
  f.push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});assert.equal(await f.p.ready,true);assert.equal(bound,1);f.result();f.finish();await f.closed;
});


test('owner binding failure blocks both fresh and resumed prompt frames',async t=>{
  for(const resume of [false,true]){
    let f;f=fixture(t,{resume,onSession:()=>{assert.equal(f.rows().some(r=>r.type==='user'),false);throw Error('private binding failure');}});
    await f.init({sendInit:false});f.finish(1);await f.closed;
    assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_SESSION_BINDING_FAILED');
    assert.equal(f.rows().some(r=>r.type==='user'),false);assert.equal(f.events().some(r=>r.type==='thread.started'),false);
  }
});
test('resumed init before ACK still verifies owner before prompt and confirms exactly once',async t=>{
  let f,bound=0;f=fixture(t,{resume:true,onSession:()=>{bound++;assert.equal(f.rows().some(r=>r.type==='user'),false);}});
  f.p.stdin.end('synthetic');await immediate();await immediate();
  f.push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});
  assert.equal(bound,0);assert.equal(f.events().length,0);
  f.push({type:'control_response',response:{subtype:'success',request_id:f.rows()[0].request_id,response:{}}});
  await f.p.ready;assert.equal(bound,1);assert.equal(f.events().filter(r=>r.type==='thread.started').length,1);
  f.result();f.finish();await f.closed;
});
test('resume failures before confirmation are structural, localized, and preserve specific failures',async t=>{
  for(const kind of ['localized','empty','result','malformed','foreign','child','limit','wall','signal','initOnly'])await t.test(kind,async sub=>{
    const f=fixture(sub,{resume:true,...(kind==='wall'?{maxWallMs:10}:{})});
    await f.init({sendInit:false});
    if(kind==='localized')f.c.stderr.write('找不到此對話，無法接續');
    if(kind==='result')f.result({subtype:'error_during_execution',is_error:true,result:'接續失敗'});
    if(kind==='malformed')f.result({subtype:'invalid',is_error:true});
    if(kind==='foreign')f.push({type:'system',subtype:'init',session_id:'foreign',model:'claude-sonnet-5'});
    if(kind==='child')f.c.emit('error',Error('private spawn error'));
    if(kind==='limit')f.c.stderr.write('x'.repeat(65537));
    if(kind==='wall')await new Promise(r=>setTimeout(r,25));
    if(kind==='initOnly')f.push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});
    if(kind==='signal'){f.c.cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:null};f.c.stdout.end();f.c.stderr.end();f.c.emit('close',null,'SIGTERM');}
    else f.finish(kind==='result'?0:1);
    await f.closed;
    const expected={malformed:'CLAUDE_NATIVE_RESULT_INVALID',foreign:'CLAUDE_NATIVE_SESSION_MISMATCH',child:'CLAUDE_NATIVE_CHILD_ERROR',limit:'CLAUDE_NATIVE_STDERR_LIMIT',wall:'CLAUDE_NATIVE_WALL_TIMEOUT',initOnly:'CLAUDE_NATIVE_EXIT_UNSUCCESSFUL'};
    assert.equal((await f.p.completion).errorCode,expected[kind]||'CLAUDE_NATIVE_RESUME_FAILED');
  });
});


test('wall and idle option boundaries fail before opening an endpoint',async t=>{
  for(const [key,values]of [['maxWallMs',[0,1800001,1.5,'1800000']],['idleTimeoutMs',[0,600001,1.5,'600000']]])for(const value of values){
    let opened=0;
    assert.throws(()=>start({...options,[key]:value,openEndpoint:()=>{opened++;}}),{code:'CLAUDE_NATIVE_OPTIONS'});
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
  f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_IDLE_TIMEOUT');
  const kills=f.kills();t.mock.timers.tick(1800000);assert.equal(f.kills(),kills);
});

test('accepted metadata resets idle but never extends the absolute wall',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{idleTimeoutMs:100,maxWallMs:500});await f.init();
  for(let i=0;i<6;i++){t.mock.timers.tick(80);f.push({type:'system',subtype:'status',session_id:sid});assert.equal(f.kills(),0);}
  t.mock.timers.tick(20);assert.equal(f.kills(),1);
  f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_WALL_TIMEOUT');
});

test('permission requests and owner answers each reset idle; result stops idle',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t,{idleTimeoutMs:100});await f.init();
  t.mock.timers.tick(80);f.permission();assert.equal(f.p.listApprovals().length,1);
  t.mock.timers.tick(80);assert.equal(f.kills(),0);f.p.respond(f.p.listApprovals()[0].token,'accept');
  t.mock.timers.tick(80);assert.equal(f.kills(),0);f.result();
  t.mock.timers.tick(200);assert.equal(f.kills(),0);
  f.finish();await f.closed;assert.equal((await f.p.completion).responseComplete,true);
});

test('defaults stop idle at ten minutes and active work at thirty minutes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const idle=fixture(t);await idle.init();t.mock.timers.tick(599999);assert.equal(idle.kills(),0);
  t.mock.timers.tick(1);idle.finish(1);await idle.closed;assert.equal((await idle.p.completion).errorCode,'CLAUDE_NATIVE_IDLE_TIMEOUT');
  const f=fixture(t);await f.init();
  for(let i=0;i<3;i++){t.mock.timers.tick(599999);f.push({type:'system',subtype:'status',session_id:sid});assert.equal(f.kills(),0);}
  t.mock.timers.tick(3);f.finish(1);await f.closed;assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_WALL_TIMEOUT');
});
