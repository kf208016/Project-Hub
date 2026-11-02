'use strict';
// Protocol fixtures only: no model, executable, account, network or OS sandbox.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const win=process.platform==='win32'?test:test.skip;
const immediate=()=>new Promise(r=>setImmediate(r));

function fixture(t,{admit=true,receipt=true,incomplete=false,systemFirst=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-chat-'));
  const ledger=path.join(root,'ledger'),dir=path.join(root,'workspace');fs.mkdirSync(ledger);fs.mkdirSync(dir);
  const meta=path.join(ledger,'.ai','chat','t.json');
  const opened=[],prompts=[],events=[],children=[],settings={account:'fixture-account',profile:'fixture-runtime',prepares:0};
  const pin={root:dir,rootFingerprint:'a'.repeat(64)};
  if(admit)t.mock.method(registry,'assertCapability',(actor,cap)=>{assert.equal(cap,'chat');return registry.cliActor(actor);});
  function handler(actor){return {
    onApprovals(child,context,rows){for(const row of rows)setImmediate(()=>child.respond(row.token,'decline'));},
    prepare(o){
      settings.prepares++;
      assert.equal(o.actor,actor);assert.equal(o.model,settings.defaultModel?'CLI預設':'fixture-model');
      return {scope:{project:o.project,task:o.task,actor,runtimeProfileId:settings.profile,
        accountProfileId:settings.account,rootFingerprint:o.rootFingerprint},
        modelFlag:settings.modelFlag??(actor==='claude'?'sonnet':'grok-4.6'),effortFlag:'low',
        ...(actor==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[]})};
    },
    openEndpoint(context){
      opened.push({...context,requests:[]});const c=new EventEmitter();let wire='',closed=false,sid=null,promptRequest=null;
      Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-'+opened.length});
      const push=row=>{if(!closed)c.stdout.write(Buffer.from(JSON.stringify(row)+'\n'));};
      const response=(req,result)=>push({jsonrpc:'2.0',id:req.id,result});
      function finish(code=0){if(closed)return;closed=true;c.cleanupReceipt=receipt?{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}:null;c.stdout.end();c.stderr.end();c.emit('close',code,null);}
      c.kill=()=>{if(closed)return false;setImmediate(()=>finish(125));return true;};
      c.stdin.on('finish',()=>setImmediate(()=>finish()));
      c.stdin.on('data',bytes=>{
        wire+=bytes;let at;
        while((at=wire.indexOf('\n'))>=0){const line=wire.slice(0,at);wire=wire.slice(at+1);if(!line)continue;
          const row=JSON.parse(line);opened.at(-1).requests.push(row);setImmediate(()=>{
            if(closed)return;
            if(actor==='claude'){
              sid=context.args.at(-1);
              if(row.type==='control_request'){
                if(systemFirst)push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});
                push({type:'control_response',response:{subtype:'success',request_id:row.request_id,response:{}}});
                if(!systemFirst)push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});
              }else if(row.type==='user'){
                const saved=chat.readMeta(ledger,'t');assert.equal(saved.providerBindings.claude.providerSessionId,sid);
                prompts.push({actor,sid,text:row.message.content});
                push({type:'assistant',session_id:sid,message:{content:[{type:'text',text:'fixture-claude-reply'}]}});
                push({type:'control_request',request_id:'decline-1',request:{subtype:'can_use_tool',tool_name:'Write',tool_use_id:'write-1',input:{file_path:'outside.txt'}}});
              }else if(row.type==='control_response'){
                assert.equal(row.response.response.behavior,'deny');
                push({type:'result',session_id:sid,subtype:'success',is_error:false,permission_denials:[{tool_name:'Write'}]});
              }
            }else if(row.method==='initialize')response(row,{protocolVersion:1,agentCapabilities:{loadSession:true}});
            else if(row.method==='session/new'||row.method==='session/load'){
              sid=row.params.sessionId||'grok-session-'+opened.length;
              if(row.method==='session/load')push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_REPLAY'}}}});
              response(row,{...(row.method==='session/new'?{sessionId:sid}:{}),models:{currentModelId:'grok-4.6',availableModels:[]}});
            }else if(row.method==='session/prompt'){
              const saved=chat.readMeta(ledger,'t');assert.equal(saved.providerBindings.grok.providerSessionId,sid);
              prompts.push({actor,sid,text:row.params.prompt[0].text});
              push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture-grok-reply'}}}});
              promptRequest=row;
              const tool={toolCallId:'write-1',title:'Write outside.txt',kind:'edit',status:'pending',rawInput:{file_path:'outside.txt'}};
              push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'tool_call',...tool}}});
              push({jsonrpc:'2.0',id:'decline-1',method:'session/request_permission',params:{sessionId:sid,toolCall:tool,options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});
            }else if(row.id==='decline-1'){
              assert.equal(row.result.outcome.optionId,'no');response(promptRequest,{stopReason:'end_turn'});
            }
          });
        }
      });
      children.push(c);setImmediate(()=>c.emit('spawn'));return c;
    }
  };}
  const handlers={claude:handler('claude'),grok:handler('grok')};
  const runner=new chat.ChatRunner({dirOf:()=>ledger,nativeProviders:handlers});runner.watch('p','t',e=>events.push(e));
  const options=(ai='grok',extra={})=>({project:'p',task:'t',pdir:ledger,dir,ai,model:'fixture-model',effort:'low',text:'synthetic instruction',basePrompt:'fixture rules',nativeRootPin:pin,...extra});
  async function send(ai,extra={}){const result=runner.send(options(ai,extra)),run=runner.busy('p','t');await result.started;await run.finishedP;return {result,run,row:chat.read(ledger,'t').findLast(x=>x.role==='assistant')};}
  t.after(()=>{
    runner.stopAll();for(const c of children){c.stdin.destroy();c.stdout.destroy();c.stderr.destroy();}
    const actual=fs.realpathSync(root);assert.equal(path.dirname(actual).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('hub-native-chat-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  return {root,ledger,dir,meta,pin,settings,handlers,runner,options,send,opened,prompts,events};
}


const {toolDeclinedText}=require('../lib/native-provider-messages');
test('R16 chat parses only valid notices and exact Traditional Chinese messages',()=>{
 const prefixes={declined:'工具操作被 Hub 拒絕，已略過（沒有執行）：',expired:'工具操作等待核准逾時，已略過（沒有執行）：',cancelled:'工具操作已取消（沒有執行）：'};
 for(const [reason,prefix]of Object.entries(prefixes))for(const ai of ['codex','claude','grok']){
  assert.equal(toolDeclinedText(reason,'title'),prefix+'title');
  assert.deepEqual(chat.parse(ai,{type:'hub.tool_declined',title:'title',reason}),[{kind:'notice',code:'NATIVE_TOOL_DECLINED',text:prefix+'title'}]);
 }
 for(const value of [{reason:'unknown',title:'title'},{reason:'declined',title:42},{reason:'expired'},{title:'title'}])assert.equal(chat.parse('codex',{type:'hub.tool_declined',...value}).some(e=>e.kind==='notice'),false);
});
for(const ai of ['grok','claude'])win('R16 '+ai+' run persists and emits a visible notice, labels approvals, and keeps its answer',async t=>{
 const f=fixture(t),{row}=await f.send(ai);
 assert.equal(row.error,'');assert.match(row.text,new RegExp('fixture-'+ai+'-reply'));
 const notices=chat.read(f.ledger,'t').filter(r=>r.notice);
 assert.equal(notices.length,1);assert.equal(notices[0].role,'event');assert.equal(notices[0].ai,ai);assert.equal(notices[0].code,'NATIVE_TOOL_DECLINED');
 assert.equal(notices[0].text,toolDeclinedText('declined','Write outside.txt'));
 assert.ok(f.events.some(e=>e.type==='row'&&e.row.notice&&e.row.code==='NATIVE_TOOL_DECLINED'&&e.row.ai===ai));
 const approvals=f.events.filter(e=>e.type==='approvals').flatMap(e=>e.approvals);
 assert.ok(approvals.length>0);assert.ok(approvals.every(r=>r.ai===ai));
});
