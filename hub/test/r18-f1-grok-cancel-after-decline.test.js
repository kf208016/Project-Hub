'use strict';
// Fake ACP endpoints only: no CLI executable, real Hub, account or network.
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {start}=require('../lib/grok-native-bridge');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const {messageFor}=require('../lib/native-provider-messages');
const sid='r18-session',immediate=()=>new Promise(resolve=>setImmediate(resolve));
const noticeType='hub.turn_stopped_after_decline';
const text='Grok 在工具操作被 Hub 拒絕後，依它自己的設計停下了這一回合。要它接著做，可以再送一則訊息。';
const options={project:'p',task:'t',runId:'r18',cwd:'C:\\synthetic',model:'grok-selected',effort:'low',sessionId:null,resume:false,validatedMcpServers:[]};
const tool=(id='declined')=>({toolCallId:id,title:'Write '+id,kind:'edit',status:'pending',rawInput:{file:'outside.txt',content:'never executed'}});

function endpoint(){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'r18-fake'});
  let wire='',ended=false;
  c.stdin.on('data',bytes=>wire+=bytes);
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push=value=>c.stdout.write(Buffer.from(JSON.stringify(value)+'\n'));
  const response=(request,result)=>push({jsonrpc:'2.0',id:request.id,result});
  const update=value=>push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:value}});
  const permission=(value=tool())=>push({jsonrpc:'2.0',id:'permission-'+value.toolCallId,method:'session/request_permission',params:{sessionId:sid,toolCall:value,
    options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});
  function finish(code=0,receipt=true){
    if(ended)return;ended=true;
    c.cleanupReceipt=receipt?{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}:null;
    c.stdout.end();c.stderr.end();c.emit('close',code,null);
  }
  c.kill=()=>{setImmediate(()=>finish(125));return true;};
  return {c,rows,push,response,update,permission,finish};
}

async function fixture(t,{resume=false,replay=false}={}){
  const e=endpoint();let output='';
  const p=start({...options,resume,sessionId:resume?sid:null,openEndpoint:()=>{setImmediate(()=>e.c.emit('spawn'));return e.c;}});
  p.stdout.on('data',bytes=>output+=bytes);p.stderr.resume();const closed=once(p,'close');
  t.after(async()=>{p.kill();e.finish(125);await closed;for(const s of [e.c.stdin,e.c.stdout,e.c.stderr])s.destroy();});
  p.stdin.end('synthetic prompt');await immediate();await immediate();
  e.response(e.rows()[0],{protocolVersion:1,agentCapabilities:{loadSession:true}});await immediate();
  const open=e.rows().at(-1);assert.equal(open.method,resume?'session/load':'session/new');
  if(replay)e.update({sessionUpdate:'tool_call',...tool('historical'),status:'failed'});
  e.response(open,{...(resume?{}:{sessionId:sid}),models:{currentModelId:options.model,availableModels:[]}});
  await p.ready;await immediate();
  const events=()=>output.trim().split('\n').filter(Boolean).map(JSON.parse);
  const result=stopReason=>e.response(e.rows().find(r=>r.method==='session/prompt'),{stopReason});
  async function decline(id='declined'){
    const value=tool(id);e.update({sessionUpdate:'tool_call',...value});e.permission(value);
    const row=p.listApprovals().find(a=>JSON.parse(a.detail).toolCallId===id);assert.ok(row);
    p.respond(row.token,'decline');await immediate();
    assert.deepEqual(e.rows().filter(r=>r.id==='permission-'+id).map(r=>r.result),[{outcome:{outcome:'selected',optionId:'no'}}]);
  }
  async function finish(stopReason='cancelled',code=0,receipt=true){result(stopReason);e.finish(code,receipt);await closed;return p.completion;}
  return {...e,p,closed,events,result,decline,finish};
}

function assertIncomplete(f,completion,code='GROK_NATIVE_INCOMPLETE'){
  assert.equal(completion.responseComplete,false);assert.equal(completion.errorCode,code);
  assert.equal(f.events().some(e=>e.type==='turn.completed'),false);
  assert.deepEqual(f.events().filter(e=>e.type===noticeType),[]);
  assert.equal(f.events().find(e=>e.type==='turn.failed').error.message,code);
}

test('R18 Hub decline then CLI cancellation completes once, preserves rejection, and exits zero',{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();await f.decline('second-decline');
  for(const status of ['completed','failed']){
    f.update({sessionUpdate:'tool_call',...tool(status)});
    f.update({sessionUpdate:'tool_call_update',toolCallId:status,status});
  }
  const completion=await f.finish();
  assert.equal(completion.responseComplete,true);assert.equal(completion.errorCode,null);assert.equal(completion.cancelled,false);
  assert.equal(completion.cleanupVerified,true);assert.deepEqual(await f.closed,[0,null]);
  const events=f.events();assert.deepEqual(events.filter(e=>e.type===noticeType),[{type:noticeType}]);
  assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
  assert.ok(events.findIndex(e=>e.type===noticeType)<events.findIndex(e=>e.type==='turn.completed'));
  assert.equal(events.some(e=>e.type==='turn.failed'),false);
  assert.deepEqual(events.filter(e=>e.type==='hub.tool_declined'),[
    {type:'hub.tool_declined',title:'Write declined',reason:'declined'},
    {type:'hub.tool_declined',title:'Write second-decline',reason:'declined'}]);
  assert.equal(f.rows().some(r=>r.result?.outcome?.optionId==='yes'),false);
});

test('R18 cancelled without a Hub decline stays incomplete',{timeout:5000},async t=>{
  const f=await fixture(t);assertIncomplete(f,await f.finish());
});

test('R18 declined tool cannot excuse another in_progress tool',{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();
  f.update({sessionUpdate:'tool_call',...tool('unfinished'),status:'in_progress'});
  assertIncomplete(f,await f.finish());
});

for(const deferred of [false,true])test(`R18 decline plus ${deferred?'deferred permission':'pending manual approval'} stays incomplete`,{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();const other=tool('waiting');
  if(!deferred)f.update({sessionUpdate:'tool_call',...other});
  f.permission(other);assert.equal(f.p.listApprovals().length,deferred?0:1);
  assertIncomplete(f,await f.finish());
  assert.equal(f.rows().some(r=>r.id==='permission-waiting'),false);
});

test('R18 proc.kill after decline retains owner cancellation failure',{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();f.p.kill();f.result('cancelled');await f.closed;
  const completion=await f.p.completion;assertIncomplete(f,completion,'GROK_NATIVE_CANCELLED');
  assert.equal(completion.cancelled,true);assert.notEqual((await f.closed)[0],0);
});

for(const reason of ['refusal','max_tokens','max_turn_requests'])test(`R18 decline plus ${reason} stays incomplete`,{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();assertIncomplete(f,await f.finish(reason));
});

test('R18 decline plus end_turn completes without the new notice',{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();const completion=await f.finish('end_turn');
  assert.equal(completion.responseComplete,true);assert.equal(completion.errorCode,null);
  assert.equal(f.events().filter(e=>e.type==='turn.completed').length,1);
  assert.deepEqual(f.events().filter(e=>e.type===noticeType),[]);
});

test('R18 prior run decline and session/load history cannot authorize current cancellation',{timeout:5000},async t=>{
  const first=await fixture(t);await first.decline();assert.equal((await first.finish()).responseComplete,true);
  const next=await fixture(t,{resume:true,replay:true});assertIncomplete(next,await next.finish());
  assert.equal(next.events().some(e=>e.type==='hub.tool_declined'),false);
});

test('R18 failed tool status alone is not a Hub decline',{timeout:5000},async t=>{
  const f=await fixture(t);f.update({sessionUpdate:'tool_call',...tool(),status:'failed'});
  assertIncomplete(f,await f.finish());
});

test('R18 missing cleanup receipt still fails after qualifying cancellation',{timeout:5000},async t=>{
  const f=await fixture(t);await f.decline();const completion=await f.finish('cancelled',0,false);
  assert.equal(completion.responseComplete,false);assert.equal(completion.errorCode,'GROK_NATIVE_CLEANUP_UNVERIFIED');
  assert.equal(f.events().some(e=>e.type==='turn.completed'),false);
});

test('R18 message and exact parse shape produce one notice without an error suffix',()=>{
  assert.equal(messageFor('GROK_STOPPED_AFTER_DECLINE'),text);
  for(const ai of ['grok','claude','codex'])assert.deepEqual(chat.parse(ai,{type:noticeType}),[
    {kind:'notice',code:'GROK_STOPPED_AFTER_DECLINE',text}]);
  const malformed=[null,{},[],{type:null},{type:noticeType,text},{type:noticeType,code:'injected'},
    {type:noticeType,extra:undefined},Object.assign([],{type:noticeType}),Object.create({type:noticeType}),
    Object.assign(Object.create({extra:true}),{type:noticeType}),{type:noticeType,[Symbol('extra')]:true},
    Object.defineProperty({type:noticeType},'extra',{value:true})];
  for(const value of malformed)assert.deepEqual(chat.parse('grok',value),[]);
});

const win=process.platform==='win32'?test:test.skip;
win('R18 full ChatRunner saves a successful assistant and exactly one stopped-after-decline notice',{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r18-chat-'));
  const ledger=path.join(root,'ledger'),dir=path.join(root,'workspace');fs.mkdirSync(ledger);fs.mkdirSync(dir);
  const events=[],children=[];
  t.mock.method(registry,'assertCapability',(actor,cap)=>{assert.equal(cap,'chat');return registry.cliActor(actor);});
  const handler={
    prepare(o){return {scope:{project:o.project,task:o.task,actor:'grok',runtimeProfileId:'r18-runtime',accountProfileId:'r18-account',rootFingerprint:o.rootFingerprint},
      modelFlag:options.model,effortFlag:'low',validatedMcpServers:[]};},
    onApprovals(child,context,rows){for(const row of rows)setImmediate(()=>child.respond(row.token,'decline'));},
    openEndpoint(){
      const e=endpoint();children.push(e.c);let wire='',prompt;
      e.c.stdin.on('finish',()=>setImmediate(()=>e.finish()));
      e.c.stdin.on('data',bytes=>{
        wire+=bytes;let at;
        while((at=wire.indexOf('\n'))>=0){
          const row=JSON.parse(wire.slice(0,at));wire=wire.slice(at+1);
          setImmediate(()=>{
            if(row.method==='initialize')e.response(row,{protocolVersion:1,agentCapabilities:{loadSession:true}});
            else if(row.method==='session/new')e.response(row,{sessionId:sid,models:{currentModelId:options.model,availableModels:[]}});
            else if(row.method==='session/prompt'){
              prompt=row;e.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'synthetic assistant answer'}});
              e.update({sessionUpdate:'tool_call',...tool()});e.permission();
            }else if(row.id==='permission-declined'){
              assert.deepEqual(row.result,{outcome:{outcome:'selected',optionId:'no'}});
              e.response(prompt,{stopReason:'cancelled'});
            }
          });
        }
      });
      setImmediate(()=>e.c.emit('spawn'));return e.c;
    }
  };
  const runner=new chat.ChatRunner({dirOf:()=>ledger,nativeProviders:{grok:handler}});
  t.after(()=>{
    runner.stopAll();for(const c of children)for(const s of [c.stdin,c.stdout,c.stderr])s.destroy();
    const actual=fs.realpathSync(root);assert.equal(path.dirname(actual).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('hub-r18-chat-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  runner.watch('p','t',event=>events.push(event));
  const sent=runner.send({project:'p',task:'t',pdir:ledger,dir,ai:'grok',model:'fixture-model',effort:'low',text:'synthetic instruction',basePrompt:'fixture rules',
    nativeRootPin:{root:dir,rootFingerprint:'a'.repeat(64)}});
  const run=runner.busy('p','t');await sent.started;await run.finishedP;
  const rows=chat.read(ledger,'t'),assistants=rows.filter(row=>row.role==='assistant');
  assert.equal(assistants.length,1);assert.equal(assistants[0].error,'');assert.equal(assistants[0].text,'synthetic assistant answer');
  const notices=rows.filter(row=>row.code==='GROK_STOPPED_AFTER_DECLINE');assert.equal(notices.length,1);
  assert.equal(notices[0].role,'event');assert.equal(notices[0].ai,'grok');assert.equal(notices[0].notice,true);assert.equal(notices[0].text,text);
  assert.equal(rows.filter(row=>row.code==='NATIVE_TOOL_DECLINED').length,1);
  assert.equal(events.filter(event=>event.type==='row'&&event.row.code==='GROK_STOPPED_AFTER_DECLINE').length,1);
});
