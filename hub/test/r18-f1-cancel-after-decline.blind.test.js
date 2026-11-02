'use strict';
// R18 / F1 blind acceptance: Grok CLI ends its whole turn with
// stopReason 'cancelled' after Hub declines a tool. Such a turn completes with
// one hub.turn_stopped_after_decline notice; every other incomplete or stopped
// shape keeps its current code. Synthetic endpoints only: no CLI executable,
// account, network, real Hub, user profile or fixed port is touched.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const {start,buildArgs}=require('../lib/grok-native-bridge');
const {decide}=require('../lib/native-provider-tool-policy');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const {messageFor,toolDeclinedText}=require('../lib/native-provider-messages');
const win=process.platform==='win32'?test:test.skip;

const EVENT='hub.turn_stopped_after_decline',CODE='GROK_STOPPED_AFTER_DECLINE';
const TEXT='Grok 在工具操作被 Hub 拒絕後，依它自己的設計停下了這一回合。要它接著做，可以再送一則訊息。';

const sid='synthetic-r18-session',immediate=()=>new Promise(r=>setImmediate(r));
const options={project:'p',task:'t',runId:'r',cwd:'C:\\synthetic\\work',model:'grok-selected',effort:'low',sessionId:null,resume:false,validatedMcpServers:[]};
const CHOICES=[{optionId:'opt-yes',name:'Allow once',kind:'allow_once'},{optionId:'opt-no',name:'Reject once',kind:'reject_once'}];
const ACCEPTED={outcome:{outcome:'selected',optionId:'opt-yes'}},REJECTED={outcome:{outcome:'selected',optionId:'opt-no'}};

// ---------------------------------------------------------------------------
// Bridge fixture (same synthetic endpoint shape as the R16 Grok bridge tests).
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
    await immediate();assert.equal(await p.ready,true);
    assert.equal(rows().filter(r=>r.method==='session/prompt').length,1);
  }
  const update=u=>push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:u}});
  const toolCall=(toolCallId,title,more={})=>({toolCallId,title,kind:'edit',status:'pending',rawInput:{file_path:toolCallId+'.txt',content:'x'},...more});
  const announce=tc=>update({sessionUpdate:'tool_call',...tc});
  const ask=(requestId,tc)=>push({jsonrpc:'2.0',id:requestId,method:'session/request_permission',params:{sessionId:sid,toolCall:tc,options:CHOICES}});
  const stop=stopReason=>response(rows().findLast(r=>r.method==='session/prompt'),{stopReason});
  const events=()=>output.trim().split('\n').filter(Boolean).map(JSON.parse);
  const of=type=>events().filter(e=>e.type===type);
  const replies=id=>rows().filter(r=>r.id===id&&Object.hasOwn(r,'result')).map(r=>r.result);
  return {p,c,closed,rows,push,finish,init,update,toolCall,announce,ask,stop,events,of,replies,kills:()=>kills};
}

// Announce a tool, raise its permission request and answer the single card.
async function decided(f,id,title,decision,more){
  const tc=f.toolCall(id,title,more);f.announce(tc);f.ask('req-'+id,tc);
  const cards=f.p.listApprovals();assert.equal(cards.length,1,'exactly one open card for '+id);
  assert.equal(f.p.respond(cards[0].token,decision),true);await immediate();
  assert.deepEqual(f.replies('req-'+id),[decision==='accept'?ACCEPTED:REJECTED]);
  assert.deepEqual(f.p.listApprovals(),[]);
  return tc;
}
const declined=(f,id='edit-1',title='search_replace')=>decided(f,id,title,'decline');
const status=(f,toolCallId,value)=>f.update({sessionUpdate:'tool_call_update',toolCallId,status:value});

async function end(f,stopReason,{text='synthetic answer',exitCode=0}={}){
  if(text!==null)f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
  f.stop(stopReason);f.finish(exitCode);const [code,signal]=await f.closed;
  return {completion:await f.p.completion,code,signal};
}

function assertStoppedAfterDecline(f,r,label=''){
  assert.equal(r.completion.errorCode,null,label+' no error code, got '+r.completion.errorCode);
  assert.equal(r.completion.responseComplete,true,label+' responseComplete');
  assert.equal(r.completion.cancelled,false,label+' not owner-cancelled');
  assert.equal(r.code,0,label+' bridge exit code');
  const ev=f.events();
  assert.deepEqual(ev.filter(e=>e.type===EVENT),[{type:EVENT}],label+' exactly one bare stop-after-decline event');
  assert.equal(ev.filter(e=>e.type==='turn.completed').length,1,label+' one turn.completed');
  assert.equal(ev.some(e=>e.type==='turn.failed'),false,label+' no turn.failed');
  assert.ok(ev.findIndex(e=>e.type===EVENT)<ev.findIndex(e=>e.type==='turn.completed'),label+' notice event precedes turn.completed');
}
function assertIncomplete(f,r,label=''){
  assert.equal(r.completion.responseComplete,false,label+' responseComplete');
  assert.equal(r.completion.errorCode,'GROK_NATIVE_INCOMPLETE',label+' errorCode');
  assert.notEqual(r.code,0,label+' bridge exit code');
  assert.equal(f.of('turn.completed').length,0,label+' no turn.completed');
  assert.deepEqual(f.of('turn.failed').map(e=>e.error?.message),['GROK_NATIVE_INCOMPLETE'],label+' one turn.failed');
  assert.deepEqual(f.of(EVENT),[],label+' no stop-after-decline event');
}

// ---------------------------------------------------------------------------
// Spec item 1: decline + cancelled + every tool terminal or declined.
test('R18-F1 item1: owner decline then Grok stopReason cancelled completes with one stop-after-decline event',async t=>{
  const f=fixture(t);await f.init();await declined(f);
  const r=await end(f,'cancelled');assertStoppedAfterDecline(f,r);
  assert.deepEqual(f.of('hub.tool_declined'),[{type:'hub.tool_declined',title:'search_replace',reason:'declined'}]);
  assert.equal(f.of('hub.agent_snapshot').at(-1).text,'synthetic answer');
  assert.deepEqual(f.replies('req-edit-1'),[REJECTED],'the declined tool is still only rejected');
  assert.equal(f.rows().some(row=>row.method==='session/cancel'),false,'Hub never sends session/cancel');
});

test('R18-F1 item1: field evidence replay (report completed, mark_step failed, search_replace declined, cancelled) completes',async t=>{
  const f=fixture(t);await f.init();
  await decided(f,'report-1','hub__hub_report','accept',{kind:'other',rawInput:{variant:'UseTool',tool_name:'hub__hub_report',tool_input:{project:'p',task:'t',text:'r'}}});
  status(f,'report-1','completed');
  await decided(f,'mark-1','hub__hub_mark_step','accept',{kind:'other',rawInput:{variant:'UseTool',tool_name:'hub__hub_mark_step',tool_input:{project:'p',task:'t',step:1}}});
  status(f,'mark-1','failed');
  await decided(f,'edit-1','search_replace','decline',{rawInput:{file_path:'D:\\HubTest\\tmp\\c18_outside.txt',old_string:'',new_string:'x'}});
  const r=await end(f,'cancelled',{text:'partial answer'});assertStoppedAfterDecline(f,r);
  assert.deepEqual(f.of('hub.tool_declined'),[{type:'hub.tool_declined',title:'search_replace',reason:'declined'}]);
  assert.equal(f.of('hub.agent_snapshot').at(-1).text,'partial answer');
});

test('R18-F1 item1: policy decline from the approvals listener then cancelled completes',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();
  const policy=Object.freeze({root:options.cwd,modelFlag:options.model,commandsApproved:true,subagentsApproved:true,mcpTools:['hub__hub_report']});
  const seen=[];
  f.p.on('approvals',rows=>{for(const row of rows){
    if(!f.p.listApprovals().some(a=>a.token===row.token))continue;
    const d=decide('grok',JSON.parse(row.detail),policy);seen.push(d);
    if(d!=='manual')f.p.respond(row.token,d==='accept'?'accept':'decline');
  }});
  const report={toolCallId:'mcp-report-1',title:'hub__hub_report',kind:'other',status:'pending',rawInput:{variant:'UseTool',tool_name:'hub__hub_report',tool_input:{project:'p',task:'t',text:'done'}}};
  f.announce(report);f.ask('req-report',report);await immediate();
  assert.deepEqual(f.replies('req-report'),[ACCEPTED]);status(f,'mcp-report-1','completed');
  const write={toolCallId:'mcp-write-1',title:'hub__hub_write_file',kind:'other',status:'pending',rawInput:{variant:'UseTool',tool_name:'hub__hub_write_file',tool_input:{project:'p',task:'t',path:'D:\\outside\\x.txt',text:'x'}}};
  f.announce(write);f.ask('req-write',write);await immediate();
  assert.deepEqual(seen,['accept','accept']);
  assert.deepEqual(f.replies('req-write'),[ACCEPTED]);assert.deepEqual(f.p.listApprovals(),[]);
  const r=await end(f,'cancelled');assert.equal(r.completion.errorCode,'GROK_NATIVE_INCOMPLETE','no Hub decline and accepted tool is unfinished');
  assert.deepEqual(f.of('hub.tool_declined'),[]);
});

test('R18-F1 item1: two declined tools still yield exactly one stop-after-decline event',async t=>{
  const f=fixture(t);await f.init();await declined(f,'edit-1','search_replace');await declined(f,'edit-2','write_file');
  const r=await end(f,'cancelled');assertStoppedAfterDecline(f,r);
  assert.equal(f.of('hub.tool_declined').length,2);
});

// Spec item 2: cancelled without any Hub decline stays incomplete.
test('R18-F1 item2: stopReason cancelled with no decline stays GROK_NATIVE_INCOMPLETE',async t=>{
  for(const shape of ['no-tools','accepted-completed','failed-tool']){
    const f=fixture(t);await f.init();
    if(shape==='accepted-completed'){await decided(f,'report-1','hub__hub_report','accept',{kind:'other'});status(f,'report-1','completed');}
    if(shape==='failed-tool'){f.announce(f.toolCall('read-1','read_file',{kind:'read',rawInput:{path:'a.txt'}}));status(f,'read-1','failed');}
    const r=await end(f,'cancelled');assertIncomplete(f,r,shape);
    assert.deepEqual(f.of('hub.tool_declined'),[],shape);
  }
});

// Spec item 3: a non-declined tool that never finished still blocks completion.
test('R18-F1 item3: decline + cancelled + another unfinished tool stays GROK_NATIVE_INCOMPLETE',async t=>{
  for(const open of ['in_progress','pending']){
    const f=fixture(t);await f.init();
    f.announce(f.toolCall('other-1','read_file',{kind:'read',status:'pending',rawInput:{path:'b.txt'}}));
    if(open==='in_progress')status(f,'other-1','in_progress');
    await declined(f);
    const r=await end(f,'cancelled');assertIncomplete(f,r,open);
    assert.equal(f.of('hub.tool_declined').length,1,open);
  }
});

// Spec item 4: an approval still open (manual card, or a deferred request).
test('R18-F1 item4: decline + cancelled + a manual approval card still open stays GROK_NATIVE_INCOMPLETE',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();await declined(f);
  const waiting=f.toolCall('write-2','write_file');f.announce(waiting);f.ask('req-write-2',waiting);
  assert.equal(f.p.listApprovals().length,1,'manual card is open');
  const r=await end(f,'cancelled');assertIncomplete(f,r,'manual card');
  assert.deepEqual(f.replies('req-write-2'),[],'nothing may be approved or rejected on the owner\'s behalf');
  assert.deepEqual(f.p.listApprovals(),[]);
});

test('R18-F1 item4: decline + cancelled + a deferred permission for an unannounced tool stays GROK_NATIVE_INCOMPLETE',async t=>{
  const f=fixture(t,{approvalTimeoutMs:600000});await f.init();await declined(f);
  f.ask('req-ghost',f.toolCall('ghost-1','write_file'));
  assert.deepEqual(f.p.listApprovals(),[],'deferred request has no card yet');
  const r=await end(f,'cancelled');assertIncomplete(f,r,'deferred');
  assert.deepEqual(f.replies('req-ghost'),[]);
});

// Spec item 5: an owner stop keeps the cancelled/failed outcome.
test('R18-F1 item5: owner stop (proc.kill) after a decline, then Grok cancelled, stays GROK_NATIVE_CANCELLED',async t=>{
  const f=fixture(t);await f.init();await declined(f);
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'partial'}});
  assert.equal(f.p.kill(),true);await immediate();assert.ok(f.kills()>0,'the endpoint is told to stop');
  f.stop('cancelled');f.finish(125);const [code]=await f.closed;const completion=await f.p.completion;
  assert.equal(completion.responseComplete,false);assert.equal(completion.cancelled,true);
  assert.equal(completion.errorCode,'GROK_NATIVE_CANCELLED');assert.notEqual(code,0);
  assert.equal(f.of('turn.completed').length,0);
  assert.deepEqual(f.of('turn.failed').map(e=>e.error?.message),['GROK_NATIVE_CANCELLED']);
  assert.deepEqual(f.of(EVENT),[],'an owner stop is not a Grok stop after decline');
});

test('R18-F1 item5: owner stop arriving after Grok\'s cancelled response still ends GROK_NATIVE_CANCELLED',async t=>{
  const f=fixture(t);await f.init();await declined(f);
  f.stop('cancelled');await immediate();
  assert.equal(f.p.kill(),true);f.finish(125);const [code]=await f.closed;const completion=await f.p.completion;
  assert.equal(completion.responseComplete,false);assert.equal(completion.cancelled,true);
  assert.equal(completion.errorCode,'GROK_NATIVE_CANCELLED');assert.notEqual(code,0);
  assert.equal(f.of('turn.completed').length,0);
  assert.deepEqual(f.of('turn.failed').map(e=>e.error?.message),['GROK_NATIVE_CANCELLED']);
});

// Spec item 6: other non-end_turn stop reasons are unchanged.
test('R18-F1 item6: decline + refusal / max_tokens / max_turn_requests stays GROK_NATIVE_INCOMPLETE',async t=>{
  for(const reason of ['refusal','max_tokens','max_turn_requests']){
    const f=fixture(t);await f.init();await declined(f);
    const r=await end(f,reason);assertIncomplete(f,r,reason);
  }
});

// Spec item 7: end_turn after a decline completes without the new event.
test('R18-F1 item7: decline + end_turn completes and emits no stop-after-decline event',async t=>{
  for(const shape of ['minimal','evidence']){
    const f=fixture(t);await f.init();
    if(shape==='evidence'){await decided(f,'report-1','hub__hub_report','accept',{kind:'other'});status(f,'report-1','completed');}
    await declined(f);
    const r=await end(f,'end_turn');
    assert.equal(r.completion.responseComplete,true,shape);assert.equal(r.completion.errorCode,null,shape);assert.equal(r.code,0,shape);
    assert.equal(f.of('turn.completed').length,1,shape);assert.equal(f.of('turn.failed').length,0,shape);
    assert.deepEqual(f.of(EVENT),[],shape+': end_turn needs no stop notice');
    assert.equal(f.of('hub.tool_declined').length,1,shape);
  }
});

// ---------------------------------------------------------------------------
// Spec item 8: chat parse and a full ChatRunner run.
test('R18-F1 item8: chat parse maps the bare event to the exact GROK_STOPPED_AFTER_DECLINE notice',()=>{
  for(const ai of ['codex','grok'])
    assert.deepEqual(chat.parse(ai,{type:EVENT}),[{kind:'notice',code:CODE,text:TEXT}],ai);
});

test('R18-F1 item8: chat parse ignores malformed variants of the event',()=>{
  const malformed=[
    {type:EVENT,text:'spoofed text'},{type:EVENT,code:'OTHER_CODE'},{type:EVENT,title:'search_replace'},
    {type:EVENT,reason:'declined'},{type:EVENT,extra:null},{type:EVENT,error:{message:'x'}},
    {type:'HUB.TURN_STOPPED_AFTER_DECLINE'},{type:EVENT+' '},{type:' '+EVENT},{type:'hub.turn_stopped'},
    {type:'hub.turn_stopped_after_declined'},{event:EVENT},{kind:'notice',code:CODE,text:TEXT}
  ];
  for(const value of malformed)for(const ai of ['codex','grok']){
    const out=chat.parse(ai,value),label=ai+' '+JSON.stringify(value);
    assert.equal(out.some(e=>e.kind==='notice'),false,label);
    assert.equal(out.some(e=>e.code===CODE||e.text===TEXT),false,label);
  }
});

function chatFixture(t,{decline=true,stopReason='cancelled'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r18-f1-chat-'));
  const ledger=path.join(root,'ledger'),dir=path.join(root,'workspace');fs.mkdirSync(ledger);fs.mkdirSync(dir);
  const events=[],children=[],prompts=[];
  const pin={root:dir,rootFingerprint:'a'.repeat(64)};
  t.mock.method(registry,'assertCapability',(actor,cap)=>{assert.equal(cap,'chat');return registry.cliActor(actor);});
  const grok={
    onApprovals(child,context,rows){for(const row of rows)setImmediate(()=>child.respond(row.token,'decline'));},
    prepare(o){
      assert.equal(o.actor,'grok');
      return {scope:{project:o.project,task:o.task,actor:'grok',runtimeProfileId:'fixture-runtime',
        accountProfileId:'fixture-account',rootFingerprint:o.rootFingerprint},modelFlag:'grok-4.6',effortFlag:'low',validatedMcpServers:[]};
    },
    openEndpoint(context){
      assert.equal(context.actor,'grok');
      const c=new EventEmitter();let wire='',closed=false,sessionId=null,promptRequest=null;
      Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-r18-'+(children.length+1)});
      const push=row=>{if(!closed)c.stdout.write(Buffer.from(JSON.stringify(row)+'\n'));};
      const response=(req,result)=>push({jsonrpc:'2.0',id:req.id,result});
      function finish(code=0){if(closed)return;closed=true;c.cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code};c.stdout.end();c.stderr.end();c.emit('close',code,null);}
      c.kill=()=>{if(closed)return false;setImmediate(()=>finish(125));return true;};
      c.stdin.on('finish',()=>setImmediate(()=>finish()));
      c.stdin.on('data',bytes=>{
        wire+=bytes;let at;
        while((at=wire.indexOf('\n'))>=0){const line=wire.slice(0,at);wire=wire.slice(at+1);if(!line)continue;
          const row=JSON.parse(line);setImmediate(()=>{
            if(closed)return;
            if(row.method==='initialize')response(row,{protocolVersion:1,agentCapabilities:{loadSession:true}});
            else if(row.method==='session/new'){sessionId='grok-r18-session-'+children.length;response(row,{sessionId,models:{currentModelId:'grok-4.6',availableModels:[]}});}
            else if(row.method==='session/prompt'){
              promptRequest=row;prompts.push(row.params.prompt[0].text);
              push({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture-grok-reply'}}}});
              if(!decline){response(row,{stopReason});return;}
              const tool={toolCallId:'write-1',title:'Write outside.txt',kind:'edit',status:'pending',rawInput:{file_path:'outside.txt'}};
              push({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'tool_call',...tool}}});
              push({jsonrpc:'2.0',id:'decline-1',method:'session/request_permission',params:{sessionId,toolCall:tool,options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});
            }else if(row.id==='decline-1'){
              assert.equal(row.result.outcome.optionId,'no');response(promptRequest,{stopReason});
            }
          });
        }
      });
      children.push(c);setImmediate(()=>c.emit('spawn'));return c;
    }
  };
  const runner=new chat.ChatRunner({dirOf:()=>ledger,nativeProviders:{grok}});runner.watch('p','t',e=>events.push(e));
  async function send(){
    const result=runner.send({project:'p',task:'t',pdir:ledger,dir,ai:'grok',model:'fixture-model',effort:'low',text:'synthetic instruction',basePrompt:'fixture rules',nativeRootPin:pin});
    const run=runner.busy('p','t');await result.started;await run.finishedP;
    const all=chat.read(ledger,'t');return {all,row:all.findLast(x=>x.role==='assistant')};
  }
  t.after(()=>{
    runner.stopAll();for(const c of children){c.stdin.destroy();c.stdout.destroy();c.stderr.destroy();}
    const actual=fs.realpathSync(root);assert.equal(path.dirname(actual).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('hub-r18-f1-chat-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  return {ledger,events,prompts,send};
}

win('R18-F1 item8: ChatRunner run with a fake native Grok that cancels after a decline has no error and one stop notice',async t=>{
  const f=chatFixture(t),{all,row}=await f.send();
  assert.equal(f.prompts.length,1);
  assert.ok(row,'an assistant row is written');
  assert.equal(row.error,'','the turn is not a failure');
  assert.equal(row.code,undefined,'the assistant row carries no error code');
  assert.match(row.text,/fixture-grok-reply/);
  const notices=all.filter(r=>r.notice);
  const stops=notices.filter(r=>r.code===CODE);
  assert.equal(stops.length,1,'exactly one stop-after-decline notice row');
  assert.equal(stops[0].role,'event');assert.equal(stops[0].ai,'grok');assert.equal(stops[0].notice,true);
  assert.equal(stops[0].text,TEXT);
  const declines=notices.filter(r=>r.code==='NATIVE_TOOL_DECLINED');
  assert.equal(declines.length,1,'the decline notice stays');
  assert.equal(declines[0].text,toolDeclinedText('declined','Write outside.txt'));
  assert.equal(notices.length,2,'no other notice rows');
  assert.ok(all.indexOf(stops[0])<all.indexOf(row),'notice row precedes the assistant row');
  assert.equal(f.events.filter(e=>e.type==='row'&&e.row.notice&&e.row.code===CODE&&e.row.ai==='grok'&&e.row.text===TEXT).length,1);
});

win('R18-F1 item8 control: ChatRunner run where Grok cancels without a decline keeps the incomplete error and no stop notice',async t=>{
  const f=chatFixture(t,{decline:false}),{all,row}=await f.send();
  assert.ok(row);
  assert.equal(row.code,'GROK_NATIVE_INCOMPLETE');
  assert.equal(row.error,messageFor('GROK_NATIVE_INCOMPLETE'));
  assert.equal(all.some(r=>r.notice),false);
  assert.equal(f.events.some(e=>e.type==='row'&&e.row.code===CODE),false);
});

// ---------------------------------------------------------------------------
// Spec item 9: the message text.
test('R18-F1 item9: messageFor(GROK_STOPPED_AFTER_DECLINE) is the exact text with no code suffix',()=>{
  assert.equal(messageFor(CODE),TEXT);
});

test('R18-F1 item9: existing native messages are unchanged',()=>{
  assert.equal(messageFor('GROK_NATIVE_INCOMPLETE'),'Grok 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。（代碼：GROK_NATIVE_INCOMPLETE）');
  assert.equal(messageFor('GROK_NATIVE_CANCELLED'),'Grok 這一回合已停止。（代碼：GROK_NATIVE_CANCELLED）');
  assert.equal(toolDeclinedText('declined','x'),'工具操作被 Hub 拒絕，已略過（沒有執行）：x');
});
