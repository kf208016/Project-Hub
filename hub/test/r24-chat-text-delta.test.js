'use strict';
// Protocol fixtures only: no model, executable, account, network or OS sandbox.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const win=process.platform==='win32'?test:test.skip;
const immediate=()=>new Promise(r=>setImmediate(r));

function fixture(t,{admit=true,receipt=true,incomplete=false,systemFirst=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r24-delta-'));
  const ledger=path.join(root,'ledger'),dir=path.join(root,'workspace');fs.mkdirSync(ledger);fs.mkdirSync(dir);
  const meta=path.join(ledger,'.ai','chat','t.json');
  const opened=[],prompts=[],events=[],children=[],settings={account:'fixture-account',profile:'fixture-runtime',prepares:0};
  const pin={root:dir,rootFingerprint:'a'.repeat(64)};
  if(admit)t.mock.method(registry,'assertCapability',(actor,cap)=>{assert.equal(cap,'chat');return registry.cliActor(actor);});
  function handler(actor){return {
    prepare(o){
      settings.prepares++;
      assert.equal(o.actor,actor);assert.equal(o.model,settings.defaultModel?'CLI預設':'fixture-model');
      return {scope:{project:o.project,task:o.task,actor,runtimeProfileId:settings.profile,
        accountProfileId:settings.account,rootFingerprint:o.rootFingerprint},
        modelFlag:settings.modelFlag??(actor==='claude'?'sonnet':'grok-4.6'),effortFlag:'low',
        ...(actor==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[]})};
    },
    openEndpoint(context){
      opened.push({...context,requests:[]});const c=new EventEmitter();let wire='',closed=false,sid=null;
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
                push({type:'result',session_id:sid,subtype:'success',is_error:false,result:'fixture-claude-reply',permission_denials:[]});
              }
            }else if(row.method==='initialize')response(row,{protocolVersion:1,agentCapabilities:{loadSession:true}});
            else if(row.method==='session/new'||row.method==='session/load'){
              sid=row.params.sessionId||'grok-session-'+opened.length;
              if(row.method==='session/load')push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_REPLAY'}}}});
              response(row,{...(row.method==='session/new'?{sessionId:sid}:{}),models:{currentModelId:'grok-4.6',availableModels:[]}});
            }else if(row.method==='session/prompt'){
              const saved=chat.readMeta(ledger,'t');assert.equal(saved.providerBindings.grok.providerSessionId,sid);
              prompts.push({actor,sid,text:row.params.prompt[0].text});
              for(const text of ['第一段',' second',' reply'])push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
              response(row,{stopReason:incomplete?'refusal':'end_turn'});
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
    assert.ok(path.basename(actual).startsWith('hub-r24-delta-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  return {root,ledger,dir,meta,pin,settings,handlers,runner,options,send,opened,prompts,events};
}


win('R24 three deltas and final same-id snapshot yield one complete assistant row',async t=>{
  const f=fixture(t),{row}=await f.send('grok'),reply='第一段 second reply';
  assert.equal(row.error,'');assert.equal(row.text,reply);
  assert.equal(chat.read(f.ledger,'t').filter(r=>r.role==='assistant').length,1);
  const partials=f.events.filter(e=>e.type==='partial').map(e=>e.text);
  assert.deepEqual(partials,['第一段','第一段 second',reply,reply]);
  for(let i=1;i<partials.length;i++)assert.ok(partials[i].startsWith(partials[i-1]));
});
