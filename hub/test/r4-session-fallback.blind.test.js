'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const {validate,resolve,bind,retire}=require('../lib/provider-session-binding');
const {codeOf}=require('../lib/native-provider-diagnostic');
const {messageFor}=require('../lib/native-provider-messages');
const win=process.platform==='win32'?test:test.skip;
const AT='2026-10-22T00:00:00.000Z';
const A4_CODES=[
  'SESSION_SCOPE_CHANGED','SESSION_BINDING_REQUIRED','SESSION_BINDING_CORRUPT','SESSION_SCOPE_INVALID',
  'SESSION_REPLACEMENT_REQUIRED','CHAT_META_CORRUPT','CHAT_META_WRITE_FAILED','GROK_NATIVE_RESUME_FAILED',
  'CLAUDE_NATIVE_RESUME_FAILED','WORKSPACE_RECORD_WRITE_FAILED','PROCWATCH_SPAWN_FAILED','PROCWATCH_TIMEOUT',
  'PROCWATCH_EXIT_FAILED','PROCWATCH_OUTPUT_LIMIT','PROCWATCH_OUTPUT_INVALID','PROCWATCH_EMPTY',
  'PROCWATCH_INTERNAL','PROCWATCH_STALE','PROCWATCH_UNASSIGNED_AI','PROCWATCH_NOT_READY'
];

function makeScope(overrides){
  return Object.assign({
    project:'proj-a',task:'task-a',actor:'claude',runtimeProfileId:'rt-1',
    accountProfileId:'acct-1',rootFingerprint:'a'.repeat(64)
  },overrides||{});
}
function info(code){return {code:code||'SESSION_SCOPE_CHANGED',at:AT};}

function boundMeta(){
  const grok=makeScope({actor:'grok'});
  const claude=makeScope({actor:'claude'});
  let meta=bind({
    extraKeep:true,
    unknownBox:{keep:1},
    models:{grok:'gm',claude:'cm',codex:'cx'},
    rulesSent:{grok:{sid:'sid-g'},claude:{sid:'sid-c'},codex:{sid:'sid-x'}}
  },grok,'sid-g');
  meta=bind(meta,claude,'sid-c');
  return {meta,grok,claude};
}

test('retire removes only that actor and keeps the rest without mutating input',()=>{
  const {meta,grok}=boundMeta();
  const snapshot=JSON.stringify(meta);
  const result=retire(meta,'grok',info());
  assert.equal(JSON.stringify(meta),snapshot);
  assert.equal(meta.providerBindings.grok.providerSessionId,'sid-g');
  assert.equal(result.extraKeep,true);
  assert.deepEqual(result.unknownBox,{keep:1});
  assert.equal(result.providerBindings.grok,undefined);
  assert.equal(result.sessions.grok,undefined);
  assert.equal(result.models.grok,undefined);
  assert.equal(result.rulesSent.grok,undefined);
  assert.equal(result.providerBindings.claude.providerSessionId,'sid-c');
  assert.equal(result.sessions.claude,'sid-c');
  assert.equal(result.models.claude,'cm');
  assert.equal(result.models.codex,'cx');
  assert.deepEqual(result.rulesSent.claude,{sid:'sid-c'});
  assert.deepEqual(result.rulesSent.codex,{sid:'sid-x'});
  assert.equal(typeof result.providerBindings,'object');
  assert.equal(Array.isArray(result.providerBindings),false);
  assert.equal(typeof result.sessions,'object');
  assert.equal(validate(result),true);
  assert.equal(resolve(result,grok).resume,false);
  assert.equal(resolve(result,makeScope()).resume,true);
  assert.deepEqual(result.retiredBindings[result.retiredBindings.length-1],{
    actor:'grok',providerSessionId:'sid-g',code:'SESSION_SCOPE_CHANGED',at:AT
  });
});

test('retire keeps the newest 8 retiredBindings and records legacy session id',()=>{
  const grok=makeScope({actor:'grok'});
  const prior=Array.from({length:8},(_,i)=>({
    actor:'grok',providerSessionId:'old-'+i,code:'SESSION_SCOPE_CHANGED',
    at:`2026-10-${String(i+1).padStart(2,'0')}T00:00:00.000Z`
  }));
  const meta=bind({retiredBindings:prior,sessions:{codex:'legacy-codex'}},grok,'sid-now');
  const result=retire(meta,'grok',{code:'SESSION_BINDING_REQUIRED',at:AT});
  assert.equal(result.retiredBindings.length,8);
  assert.equal(result.retiredBindings[0].providerSessionId,'old-1');
  assert.deepEqual(result.retiredBindings[7],{
    actor:'grok',providerSessionId:'sid-now',code:'SESSION_BINDING_REQUIRED',at:AT
  });
  assert.equal(result.sessions.codex,'legacy-codex');
  const legacy={sessions:{grok:'legacy-sid',claude:'keep-claude'},extra:9};
  const fromLegacy=retire(legacy,'grok',info());
  assert.equal(fromLegacy.sessions.grok,undefined);
  assert.equal(fromLegacy.sessions.claude,'keep-claude');
  assert.equal(fromLegacy.extra,9);
  assert.equal(fromLegacy.retiredBindings[0].providerSessionId,'legacy-sid');
  assert.equal(validate(fromLegacy),true);
  assert.equal(resolve(fromLegacy,grok).resume,false);
});

test('retire rejects a bad actor with SESSION_SCOPE_INVALID',()=>{
  const {meta}=boundMeta();
  for(const actor of ['codex','',null,undefined,'GROK',1]){
    assert.throws(()=>retire(meta,actor,info()),{code:'SESSION_SCOPE_INVALID'});
  }
  assert.equal(JSON.stringify(meta).includes('"sid-g"'),true);
});

test('retire rejects a bad code or at with SESSION_SCOPE_INVALID',()=>{
  const {meta}=boundMeta();
  const bad=[
    {code:'session_scope_changed',at:AT},
    {code:'AB',at:AT},
    {code:'1ABC',at:AT},
    {code:'SESSION-SCOPE',at:AT},
    {code:'A',at:AT},
    {code:'SESSION_SCOPE_CHANGED',at:'yesterday'},
    {code:'SESSION_SCOPE_CHANGED',at:''},
    {code:'SESSION_SCOPE_CHANGED',at:123},
    {code:'SESSION_SCOPE_CHANGED'},
    {at:AT},
    {}
  ];
  for(const value of bad)assert.throws(()=>retire(meta,'grok',value),{code:'SESSION_SCOPE_INVALID'});
  assert.throws(()=>retire(null,'grok',info()),{code:'SESSION_BINDING_CORRUPT'});
  assert.throws(()=>retire([],'grok',info()),{code:'SESSION_BINDING_CORRUPT'});
});

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-chat-'));
  const ledger=path.join(root,'ledger'),dir=path.join(root,'workspace');fs.mkdirSync(ledger);fs.mkdirSync(dir);
  const meta=path.join(ledger,'.ai','chat','t.json');
  const opened=[],prompts=[],events=[],children=[],sessionOps=[],settings={account:'fixture-account',profile:'fixture-runtime'};
  const pin={root:dir,rootFingerprint:'a'.repeat(64)};
  t.mock.method(registry,'assertCapability',(actor,cap)=>{assert.equal(cap,'chat');return registry.cliActor(actor);});
  function handler(actor){return {
    prepare(o){
      assert.equal(o.actor,actor);assert.equal(o.model,'fixture-model');
      return {scope:{project:o.project,task:o.task,actor,runtimeProfileId:settings.profile,
        accountProfileId:settings.account,rootFingerprint:o.rootFingerprint},
        modelFlag:actor==='claude'?'sonnet':'grok-4.6',effortFlag:'low',
        ...(actor==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[]})};
    },
    openEndpoint(context){
      opened.push(context);const c=new EventEmitter();let wire='',closed=false,sid=null;
      Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-'+opened.length});
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
            if(actor==='claude'){
              sid=context.args.at(-1);
              if(row.type==='control_request'){
                push({type:'control_response',response:{subtype:'success',request_id:row.request_id,response:{}}});
                push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5'});
              }else if(row.type==='user'){
                prompts.push({actor,sid,text:row.message.content});
                push({type:'assistant',session_id:sid,message:{content:[{type:'text',text:'fixture-claude-reply'}]}});
                push({type:'result',session_id:sid,subtype:'success',is_error:false,result:'fixture-claude-reply',permission_denials:[]});
              }
            }else if(row.method==='initialize')response(row,{protocolVersion:1,agentCapabilities:{loadSession:true}});
            else if(row.method==='session/new'||row.method==='session/load'){
              sessionOps.push({method:row.method,sessionId:row.params&&row.params.sessionId||null});
              sid=row.params.sessionId||'grok-session-'+opened.length;
              if(row.method==='session/load')push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_REPLAY'}}}});
              response(row,{...(row.method==='session/new'?{sessionId:sid}:{}),models:{currentModelId:'grok-4.6',availableModels:[]}});
            }else if(row.method==='session/prompt'){
              prompts.push({actor,sid,text:row.params.prompt[0].text});
              push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture-grok-reply'}}}});
              response(row,{stopReason:'end_turn'});
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
  return {root,ledger,dir,meta,pin,settings,handlers,runner,options,send,opened,prompts,events,sessionOps};
}

async function assertFreshFallback(t,field){
  const f=fixture(t);const first=await f.send('grok');assert.equal(first.row.error,'');
  const oldId=chat.readMeta(f.ledger,'t').sessions.grok;assert.ok(oldId);
  const opened=f.opened.length,opsAt=f.sessionOps.length,rowsBefore=chat.read(f.ledger,'t');
  if(field==='account')f.settings.account='different-account';
  if(field==='profile')f.settings.profile='different-runtime';
  if(field==='root')f.pin.rootFingerprint='b'.repeat(64);
  if(field==='legacy'){const old=JSON.parse(fs.readFileSync(f.meta,'utf8'));delete old.providerBindings;fs.writeFileSync(f.meta,JSON.stringify(old));}
  const expected=field==='legacy'?'SESSION_BINDING_REQUIRED':'SESSION_SCOPE_CHANGED';
  const second=await f.send('grok',{text:'follow-up after scope change',request:'fresh-'+field});
  assert.equal(second.result.freshSession.code,expected);
  assert.equal(second.row.error,'');
  assert.equal(f.opened.length,opened+1);
  const newer=f.sessionOps.slice(opsAt);
  assert.ok(newer.some(x=>x.method==='session/new'));
  assert.equal(newer.some(x=>x.method==='session/load'&&x.sessionId===oldId),false);
  const rows=chat.read(f.ledger,'t');
  const eventAt=rows.findIndex((r,i)=>i>=rowsBefore.length&&r.role==='event'&&r.freshSession===true);
  const userAt=rows.findIndex((r,i)=>i>eventAt&&r.role==='user');
  assert.ok(eventAt>=0,field);assert.ok(userAt>eventAt,field);
  assert.equal(rows[eventAt].code,expected);
  assert.equal(rows[eventAt].ai,'grok');
  assert.match(rows[eventAt].text,/（代碼：/);
  assert.ok(rows[eventAt].text.includes(expected));
  assert.ok(f.events.some(e=>e.type==='row'&&e.row&&e.row.freshSession===true&&String(e.row.text).includes('（代碼：')));
  const saved=chat.readMeta(f.ledger,'t');
  assert.equal(saved.providerBindings.grok.accountProfileId,f.settings.account);
  assert.equal(saved.providerBindings.grok.runtimeProfileId,f.settings.profile);
  assert.equal(saved.providerBindings.grok.rootFingerprint,f.pin.rootFingerprint);
  assert.notEqual(saved.providerBindings.grok.providerSessionId,oldId);
  assert.ok(saved.retiredBindings.some(x=>x.actor==='grok'&&x.providerSessionId===oldId&&x.code===expected));
}

win('ChatRunner account change starts a new Grok session with SESSION_SCOPE_CHANGED',t=>assertFreshFallback(t,'account'));
win('ChatRunner runtime profile change starts a new Grok session with SESSION_SCOPE_CHANGED',t=>assertFreshFallback(t,'profile'));
win('ChatRunner root fingerprint change starts a new Grok session with SESSION_SCOPE_CHANGED',t=>assertFreshFallback(t,'root'));
win('ChatRunner unbound legacy session starts a new Grok session with SESSION_BINDING_REQUIRED',t=>assertFreshFallback(t,'legacy'));

test('codeOf admits the A4 public codes and still rejects arbitrary strings',()=>{
  for(const code of A4_CODES)assert.equal(codeOf({code,message:'private synthetic text'}),code);
  for(const error of [null,{},'SESSION_SCOPE_CHANGED',{code:'SESSION_PRIVATE_SYNTHETIC'},{code:'SESSION_SCOPE_CHANGED\nprivate'},{code:123},{message:'SESSION_SCOPE_CHANGED'},{code:'NOT_A_REAL_CODE'}]){
    assert.equal(codeOf(error),null);
  }
});

test('messageFor SESSION_SCOPE_CHANGED is Traditional Chinese ending with the code',()=>{
  const text=messageFor('SESSION_SCOPE_CHANGED');
  assert.equal(typeof text,'string');
  assert.match(text,/舊對話/);
  assert.ok(text.endsWith('（代碼：SESSION_SCOPE_CHANGED）'));
  assert.equal(text,'舊對話是在不同的登入、執行環境或工作區建立的，無法安全接續；已改開新對話，並附上先前的文字紀錄。（代碼：SESSION_SCOPE_CHANGED）');
});

win('non-recoverable nativeError includes the public code marker',t=>{
  const f=fixture(t);
  const empty=new chat.ChatRunner();
  const raw={...f.options(),nativeProviders:f.handlers,nativePlan:{},perm:'grok --always-approve'};
  assert.throws(()=>empty.send(raw),e=>e.code==='NATIVE_RUNTIME_REQUIRED'&&String(e.message).includes('（代碼：NATIVE_RUNTIME_REQUIRED）'));
  assert.throws(()=>f.runner.send({...f.options(),nativeRootPin:null}),e=>e.code==='NATIVE_ROOT_PIN_REQUIRED'&&String(e.message).includes('（代碼：NATIVE_ROOT_PIN_REQUIRED）'));
  assert.equal(f.opened.length,0);
});
