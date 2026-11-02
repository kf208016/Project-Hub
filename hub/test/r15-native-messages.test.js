'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const {messageFor,messageOrFallback}=require('../lib/native-provider-messages');
const table={
  "GROK_NATIVE_INCOMPLETE": "Grok 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。",
  "CLAUDE_NATIVE_INCOMPLETE": "Claude 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。",
  "GROK_NATIVE_CANCELLED": "Grok 這一回合已停止。",
  "CLAUDE_NATIVE_CANCELLED": "Claude 這一回合已停止。",
  "GROK_NATIVE_CLEANUP_UNVERIFIED": "Grok 結束後，Hub 無法確認它啟動的程式都已關閉，所以這一回合判為失敗。請確認沒有殘留的 Grok 程式後再送一次。",
  "CLAUDE_NATIVE_CLEANUP_UNVERIFIED": "Claude 結束後，Hub 無法確認它啟動的程式都已關閉，所以這一回合判為失敗。請確認沒有殘留的 Claude 程式後再送一次。",
  "GROK_NATIVE_EXIT_UNSUCCESSFUL": "Grok 程式異常結束，這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。",
  "CLAUDE_NATIVE_EXIT_UNSUCCESSFUL": "Claude 程式異常結束，這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。",
  "GROK_NATIVE_INIT_TIMEOUT": "Grok 沒有在時限內完成啟動，這一回合已停止。請稍後再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。",
  "CLAUDE_NATIVE_INIT_TIMEOUT": "Claude 沒有在時限內完成啟動，這一回合已停止。請稍後再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。",
  "GROK_NATIVE_INIT_FAILED": "Grok 啟動失敗，這一回合沒有開始。請先在一般終端機開啟 Grok 確認可以使用，再送一次。",
  "CLAUDE_NATIVE_INIT_FAILED": "Claude 啟動失敗，這一回合沒有開始。請先在一般終端機開啟 Claude Code 確認可以使用，再送一次。",
  "GROK_NATIVE_TRUNCATED_OUTPUT": "Grok 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。",
  "CLAUDE_NATIVE_TRUNCATED_OUTPUT": "Claude 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。",
  "GROK_NATIVE_REMOTE_ERROR": "Grok 服務端回報錯誤，這一回合已停止。請稍後再試。"
};
function fixture(t,{admit=true,receipt=true,incomplete=false,systemFirst=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-chat-'));
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
              push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture-grok-reply'}}}});
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
    assert.ok(path.basename(actual).startsWith('hub-native-chat-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  return {root,ledger,dir,meta,pin,settings,handlers,runner,options,send,opened,prompts,events};
}



test('R15 all 15 native messages match the locked text and retain their code suffix',()=>{
  assert.equal(Object.keys(table).length,15);
  for(const [code,text]of Object.entries(table)){
    assert.equal(messageFor(code),`${text}（代碼：${code}）`);
    assert.equal(messageOrFallback(code),messageFor(code));
    const done=chat.parse('grok',{type:'turn.failed',error:{message:code}})[0];
    assert.equal(done.error,messageFor(code));assert.equal(done.code,code);
  }
});

test('R15 native fallback is bounded and non-native and malformed inputs stay null',()=>{
  for(const actor of ['GROK','CLAUDE']){
    for(const suffix of ['XY','NEW_GUARD_123','X'.repeat(60)]){
      const code=actor+'_NATIVE_'+suffix;
      assert.equal(messageFor(code),null);
      assert.equal(messageOrFallback(code),`${actor==='GROK'?'Grok':'Claude'} 這一回合因 Hub 的安全檢查而停止。可以再送一次；若一再發生，請把代碼告訴維護者。（代碼：${code}）`);
    }
  }
  for(const code of [null,undefined,{},42,[],Symbol('code'),'OTHER_NATIVE_ERROR','GROK_NATIVE_X','GROK_NATIVE_'+'X'.repeat(61),'GROK_NATIVE_lower','GROK_NATIVE_XX\n',' GROK_NATIVE_XX','GROK_NATIVE_XX<script>'])assert.equal(messageOrFallback(code),null);
  assert.equal(messageOrFallback('NATIVE_CODEX_VERSION_UNREVIEWED','0.165.0'),messageFor('NATIVE_CODEX_VERSION_UNREVIEWED','0.165.0'));
  assert.equal(chat.parse('codex',{type:'turn.failed',error:{message:'ordinary failure'}})[0].error,'ordinary failure');
});

test('R15 declined synthetic Grok turn persists Chinese error and the original code',async t=>{
  const f=fixture(t,{incomplete:true}),{row}=await f.send('grok');
  assert.equal(row.code,'GROK_NATIVE_INCOMPLETE');assert.equal(row.error,messageFor(row.code));
  assert.ok(f.events.some(event=>event.type==='row'&&event.row.code===row.code&&event.row.error===row.error));
});

test('R15 native HTTP errors used by UI toasts use fallback and preserve code',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const fn=source.match(/^function nativeWorkspaceError[^\n]+/m)[0];
  const context=vm.createContext({require:name=>require(name.replace('./lib/','../lib/'))});vm.runInContext(fn,context);
  for(const code of ['GROK_NATIVE_INCOMPLETE','CLAUDE_NATIVE_SESSION_MISMATCH']){
    const value=context.nativeWorkspaceError(Object.assign(Error(code),{code}));
    assert.equal(value.code,code);assert.equal(value.error,messageOrFallback(code));
  }
  assert.equal(context.nativeWorkspaceError(Error('ordinary failure')).error,'ordinary failure');
});
