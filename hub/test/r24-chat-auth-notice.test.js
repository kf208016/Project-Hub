'use strict';
// Synthetic endpoints only; no provider executable or account.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const {messageFor}=require('../lib/native-provider-messages');
const win=process.platform==='win32'?test:test.skip;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const AUTH='GROK_NATIVE_AUTH_UNAVAILABLE';
const NOTICE_TEXT='Grok 登入已過期，正在自動更新登入並重送這則訊息…';
const NOTICE={role:'event',ai:'grok',notice:true,code:'GROK_AUTH_REFRESHING',text:NOTICE_TEXT};

// script: one entry per opened Grok/Claude endpoint, in order:
//   'ok'       answer the prompt and end the turn normally
//   'auth'     reject session/prompt with JSON-RPC -32000 (Grok AUTH failure)
//   'remote'   reject session/prompt with JSON-RPC -32001 (another Grok error)
//   'authlike' Claude result is_error with a login-style message
function fixture(t,{script=['auth','ok'],retry,available}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r24-chat-'));
  const ledger=path.join(root,'ledger'),dir=path.join(root,'workspace');fs.mkdirSync(ledger);fs.mkdirSync(dir);
  const opened=[],prompts=[],events=[],children=[],retries=[],settings={prepares:0};
  const pin={root:dir,rootFingerprint:'a'.repeat(64)};
  t.mock.method(registry,'assertCapability',(actor,cap)=>{assert.equal(cap,'chat');return registry.cliActor(actor);});
  function handler(actor){return {
    onApprovals(child,context,rows){for(const row of rows)setImmediate(()=>child.respond(row.token,'decline'));},
    prepare(o){
      settings.prepares++;assert.equal(o.actor,actor);
      return {scope:{project:o.project,task:o.task,actor,runtimeProfileId:'fixture-runtime',accountProfileId:'fixture-account',rootFingerprint:o.rootFingerprint},
        modelFlag:actor==='claude'?'sonnet':'grok-4.6',effortFlag:'low',
        ...(actor==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[]})};
    },
    openEndpoint(context){
      const mode=script[opened.length]??'ok';
      opened.push({...context,mode,requests:[]});const c=new EventEmitter();let wire='',closed=false,sid=null;
      Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-'+opened.length});
      const push=row=>{if(!closed)c.stdout.write(Buffer.from(JSON.stringify(row)+'\n'));};
      const response=(req,result)=>push({jsonrpc:'2.0',id:req.id,result});
      function finish(code=0){if(closed)return;closed=true;c.cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code};c.stdout.end();c.stderr.end();c.emit('close',code,null);}
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
                push({type:'control_response',response:{subtype:'success',request_id:row.request_id,response:{}}});
                push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});
              }else if(row.type==='user'){
                prompts.push({actor,mode,text:row.message.content});
                if(mode==='authlike')push({type:'result',session_id:sid,subtype:'error_during_execution',is_error:true,result:'Invalid API key · Please run /login'});
                else{push({type:'assistant',session_id:sid,message:{content:[{type:'text',text:'fixture-claude-reply'}]}});
                  push({type:'result',session_id:sid,subtype:'success',is_error:false});}
              }
            }else if(row.method==='initialize')response(row,{protocolVersion:1,agentCapabilities:{loadSession:true}});
            else if(row.method==='session/new'||row.method==='session/load'){
              sid=row.params.sessionId||'grok-session-'+opened.length;
              response(row,{...(row.method==='session/new'?{sessionId:sid}:{}),models:{currentModelId:'grok-4.6',availableModels:[]}});
            }else if(row.method==='session/prompt'){
              prompts.push({actor,mode,text:row.params.prompt[0].text});
              if(mode==='auth')push({jsonrpc:'2.0',id:row.id,error:{code:-32000,message:'Unauthorized (401) synthetic'}});
              else if(mode==='remote')push({jsonrpc:'2.0',id:row.id,error:{code:-32001,message:'synthetic remote failure'}});
              else{push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture-grok-reply'}}}});
                response(row,{stopReason:'end_turn'});}
            }
          });
        }
      });
      children.push(c);setImmediate(()=>c.emit('spawn'));return c;
    }
  };}
  const handlers={claude:handler('claude'),grok:handler('grok')};
  let runner;
  const observed=[];
  const nativeAuthRetry=retry===undefined?undefined:async o=>{
    retries.push(o);
    observed.push({busy:Boolean(runner.busy('p','t')),idleSeen:events.some(e=>e.type==='idle'),
      noticeSaved:chat.read(ledger,'t').some(r=>r.code==='GROK_AUTH_REFRESHING'),
      assistantRows:chat.read(ledger,'t').filter(r=>r.role==='assistant').length});
    return retry(o,{runner,retries});
  };
  runner=new chat.ChatRunner({dirOf:()=>ledger,nativeProviders:handlers,nativeAuthRetryAvailable:available,...(nativeAuthRetry?{nativeAuthRetry}:{})});
  runner.watch('p','t',e=>events.push(e));
  const options=(ai='grok',extra={})=>({project:'p',task:'t',pdir:ledger,dir,ai,model:'fixture-model',effort:'low',text:'synthetic instruction r17',basePrompt:'fixture rules',nativeRootPin:pin,...extra});
  const rows=()=>chat.read(ledger,'t');
  // Done: the task is idle, an assistant row exists and nothing new starts for a grace period.
  async function settled(limit=10000){
    const until=Date.now()+limit;
    for(;;){
      if(!runner.busy('p','t')&&rows().some(r=>r.role==='assistant')){
        const count=opened.length;await sleep(150);
        if(!runner.busy('p','t')&&opened.length===count)return;
      }
      if(Date.now()>until)throw Error('chat did not settle: busy='+Boolean(runner.busy('p','t'))+' opened='+opened.length);
      await sleep(10);
    }
  }
  async function send(ai='grok',extra={}){const result=runner.send(options(ai,extra));assert.equal(await result.started,true);await settled();return result;}
  t.after(()=>{
    runner.stopAll();for(const c of children){c.stdin.destroy();c.stdout.destroy();c.stderr.destroy();}
    const actual=fs.realpathSync(root);assert.equal(path.dirname(actual).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith('hub-r24-chat-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  return {ledger,dir,runner,options,send,settled,rows,opened,prompts,events,retries,observed,settings};
}
const pick=(row,keys)=>Object.fromEntries(keys.map(k=>[k,row[k]]));
const noticeRows=f=>f.rows().filter(r=>r.code==='GROK_AUTH_REFRESHING');


for(const available of [false,true])win('R24 auth retry availability '+available+' controls notice, refresh and resend',{timeout:30000},async t=>{
  const f=fixture(t,{script:['auth','ok'],retry:async()=>true,available:()=>available});await f.send();
  assert.equal(noticeRows(f).length,available?1:0);assert.equal(f.retries.length,available?1:0);
  assert.equal(f.opened.length,available?2:1);assert.equal(f.prompts.length,available?2:1);
  const rows=f.rows(),assistant=rows.filter(r=>r.role==='assistant');assert.equal(assistant.length,1);
  assert.equal(rows.filter(r=>r.role==='user').length,1);
  assert.equal(assistant[0].error,available?'':messageFor(AUTH));
  if(available){assert.equal(assistant[0].text,'fixture-grok-reply');assert.deepEqual(f.observed,[{busy:true,idleSeen:false,noticeSaved:true,assistantRows:0}]);}
});
test('R24 server availability callback immediately precedes unchanged retry callback',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.ok(source.includes('  nativeAuthRetryAvailable:()=>grokAuthRefresher!==null,\n  nativeAuthRetry:async o=>{'));
});
