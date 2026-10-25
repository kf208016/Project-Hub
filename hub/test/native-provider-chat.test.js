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

win('Claude CLI default reaches the bridge without model argv; requiredModel remains strict',async t=>{
 const f=fixture(t);f.settings.defaultModel=true;f.settings.modelFlag='';
 const first=await f.send('claude',{model:'CLI預設'});assert.equal(first.row.error,'');assert.equal(f.opened[0].args.includes('--model'),false);
 let count=f.opened.length;
 assert.throws(()=>f.runner.send(f.options('claude',{model:'CLI預設',requiredModel:'sonnet'})),{code:'NATIVE_MODEL_MISMATCH'});
 const grok=await f.send('grok',{model:'CLI預設'});assert.equal(grok.row.error,'');assert.equal(f.opened.at(-1).args.includes('--model'),false);assert.equal(f.opened.at(-1).requests.some(row=>row.method==='session/set_model'),false);
 count=f.opened.length;
 f.settings.modelFlag='sonnet';assert.throws(()=>f.runner.send(f.options('claude',{model:'CLI預設',requiredModel:''})),{code:'NATIVE_MODEL_MISMATCH'});assert.equal(f.opened.length,count);
});

win('constructor factory never overrides the real Windows readiness gate',t=>{
  const f=fixture(t,{admit:false});
  assert.throws(()=>f.runner.send(f.options()),e=>e.code==='PROVIDER_ADAPTER_UNVERIFIED');
  assert.equal(f.opened.length,0);assert.deepEqual(chat.read(f.ledger,'t'),[]);
});

win('Claude and Grok persist owner scope before prompt and resume their separate native sessions',async t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(f.meta),{recursive:true});
  fs.writeFileSync(f.meta,JSON.stringify({sessions:{codex:'codex-owned'},models:{codex:'codex-model'},extension:{keep:true}}));
  for(const ai of ['claude','grok']){
    const first=await f.send(ai,{request:ai+'-1'});assert.equal(first.row.error,'');assert.equal(first.result.resume,false);
    const before=chat.readMeta(f.ledger,'t');
    const second=await f.send(ai,{request:ai+'-2',text:'synthetic follow-up'});assert.equal(second.row.error,'');assert.equal(second.result.resume,true);
    assert.equal(chat.readMeta(f.ledger,'t').sessions[ai],before.sessions[ai]);
    assert.equal(second.row.text.includes('OLD_REPLAY'),false);
    const calls=f.opened.filter(x=>x.actor===ai);assert.equal(calls.length,2);
    assert.equal(calls[1].scope.actor,ai);assert.equal(calls[1].scope.accountProfileId,'fixture-account');
  }
  const saved=chat.readMeta(f.ledger,'t');assert.notEqual(saved.sessions.claude,saved.sessions.grok);
  assert.equal(saved.sessions.codex,'codex-owned');assert.deepEqual(saved.extension,{keep:true});
  assert.ok(f.prompts.find(x=>x.actor==='grok').text.includes('fixture-claude-reply'));
  assert.deepEqual(fs.readdirSync(path.dirname(f.meta)).filter(n=>n.endsWith('.tmp')),[]);
});

win('account/runtime/root changes or unbound legacy IDs start fresh before the user row',async t=>{
  for(const ai of ['claude','grok'])for(const field of ['account','profile','root','legacy']){
    const f=fixture(t);await f.send(ai);const old=chat.readMeta(f.ledger,'t'),rows=chat.read(f.ledger,'t').length,opened=f.opened.length;
    if(field==='account')f.settings.account='different-account';
    if(field==='profile')f.settings.profile='different-runtime';
    if(field==='root')f.pin.rootFingerprint='b'.repeat(64);
    if(field==='legacy'){delete old.providerBindings;fs.writeFileSync(f.meta,JSON.stringify(old));}
    const next=await f.send(ai),code=field==='legacy'?'SESSION_BINDING_REQUIRED':'SESSION_SCOPE_CHANGED';
    assert.equal(next.row.error,'');assert.equal(next.result.resume,false);assert.deepEqual(next.result.freshSession,{code});
    assert.equal(f.settings.prepares,2);assert.equal(f.opened.length,opened+1);assert.equal(f.opened.at(-1).args.includes('--resume'),false);
    assert.equal(f.opened.at(-1).requests.some(r=>r.method==='session/load'),false);
    const added=chat.read(f.ledger,'t').slice(rows);assert.equal(added[0].role,'event');assert.equal(added[0].code,code);assert.equal(added[0].freshSession,true);assert.ok(added[0].text.includes(`（代碼：${code}）`));assert.equal(added[1].role,'user');
    assert.ok(f.events.some(e=>e.type==='row'&&e.row===next.result.userRow));assert.ok(f.events.some(e=>e.row?.freshSession));
    const saved=chat.readMeta(f.ledger,'t'),b=saved.providerBindings[ai];assert.equal(b.accountProfileId,f.settings.account);assert.equal(b.runtimeProfileId,f.settings.profile);assert.equal(b.rootFingerprint,f.pin.rootFingerprint);
    assert.notEqual(saved.sessions[ai],old.sessions[ai]);assert.equal(saved.retiredBindings.at(-1).providerSessionId,old.sessions[ai]);
    assert.ok(f.prompts.at(-1).text.includes('fixture-'+ai+'-reply'));assert.ok(f.prompts.at(-1).text.includes('fixture rules'));
  }
});

win('request metadata cannot forge factories, reuse a native turn, pick another model or silently drop images',t=>{
  const f=fixture(t),empty=new chat.ChatRunner();
  const raw={...f.options(),nativeProviders:f.handlers,nativePlan:{},perm:'grok --always-approve'};
  assert.throws(()=>empty.send(raw),e=>e.code==='NATIVE_RUNTIME_REQUIRED');
  assert.throws(()=>empty.run(f.options(),{native:true},{sessions:{},models:{}},[]),e=>e.code==='NATIVE_RUNTIME_REQUIRED');
  assert.throws(()=>f.runner.send(f.options('grok',{requiredModel:'different-model'})),e=>e.code==='NATIVE_MODEL_MISMATCH');
  assert.throws(()=>f.runner.send(f.options('grok',{images:['synthetic-image']})),e=>e.code==='NATIVE_IMAGES_UNVERIFIED');
  assert.equal(f.opened.length,0);assert.deepEqual(chat.read(f.ledger,'t'),[]);
});

win('failed session publish preserves original metadata and sends no native prompt',async t=>{
  for(const [ai,systemFirst] of [['claude',false],['claude',true],['grok',false]]){
    const f=fixture(t,{systemFirst});fs.mkdirSync(path.dirname(f.meta),{recursive:true});const original=Buffer.from('{"extension":"keep"}');fs.writeFileSync(f.meta,original);
    const rename=fs.renameSync;t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.meta)throw Error('SYNTHETIC_PRIVATE_RENAME_ERROR');return rename(a,b);});
    const result=f.runner.send(f.options(ai)),run=f.runner.busy('p','t');
    await assert.rejects(result.started,e=>e.code===ai.toUpperCase()+'_NATIVE_SESSION_BINDING_FAILED');await run.finishedP;
    assert.deepEqual(fs.readFileSync(f.meta),original);assert.equal(f.prompts.length,0);
    assert.ok(chat.read(f.ledger,'t').findLast(x=>x.role==='assistant').error);
    assert.deepEqual(fs.readdirSync(path.dirname(f.meta)).filter(n=>n.endsWith('.tmp')),[]);
  }
});

win('early Claude system init does not publish a session or readiness before durable owner binding',async t=>{
  const f=fixture(t,{systemFirst:true});
  const first=await f.send('claude');assert.equal(first.row.error,'');assert.equal(first.run.protocolFailed,undefined);
  const next=await f.send('claude');assert.equal(next.row.error,'');assert.equal(next.result.resume,true);
  assert.equal(f.prompts.length,2);assert.equal(f.prompts[0].sid,f.prompts[1].sid);
});

win('malformed controller plans fail before history append or endpoint creation',t=>{
  const f=fixture(t),base=f.handlers.grok.prepare;
  for(const mutate of [p=>({...p,validatedAgentProfile:null}),p=>({...p,maxWallMs:1800001}),
    p=>({...p,scope:{...p.scope,actor:'claude'}}),p=>({...p,modelFlag:'--uncontrolled'}),
    p=>({...p,unexpected:true}),p=>Promise.resolve(p)]){
    const runner=new chat.ChatRunner({nativeProviders:{grok:{...f.handlers.grok,prepare:o=>mutate(base(o))}}});
    assert.throws(()=>runner.send(f.options()),e=>['NATIVE_RUNTIME_INVALID','NATIVE_SCOPE_MISMATCH'].includes(e.code));
  }
  assert.deepEqual(chat.read(f.ledger,'t'),[]);assert.equal(f.opened.length,0);
});

win('incomplete native turn keeps the queued request; missing cleanup receipt also retains busy ownership',async t=>{
  for(const receipt of [true,false]){
    const f=fixture(t,{receipt,incomplete:true});
    const result=f.runner.send(f.options()),run=f.runner.busy('p','t');f.runner.enqueue('p','t',{ai:'grok',model:'fixture-model',text:'queued instruction'});
    await result.started;await run.finishedP;await immediate();
    assert.equal(f.opened.length,1);assert.equal(f.runner.queue('p','t').length,1);assert.equal(run.protocolFailed,true);
    assert.equal(Boolean(f.runner.busy('p','t')),!receipt);
    if(!receipt)assert.ok(f.events.some(e=>e.type==='busy'&&e.cleanupRequired===true));
  }
});


win('fallback metadata failure is not-started and preserves all rows, binding and endpoint count',async t=>{
  const f=fixture(t);await f.send('grok');f.settings.account='changed';const before=fs.readFileSync(f.meta),rows=chat.read(f.ledger,'t'),opened=f.opened.length;
  const rename=fs.renameSync;t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.meta)throw Object.assign(Error('PRIVATE_PATH'),{code:'EINVAL'});return rename(a,b);});
  assert.throws(()=>f.runner.send(f.options()),e=>e.code==='CHAT_META_WRITE_FAILED'&&e.notStarted===true);
  assert.deepEqual(fs.readFileSync(f.meta),before);assert.deepEqual(chat.read(f.ledger,'t'),rows);assert.equal(f.opened.length,opened);assert.equal(f.runner.busy('p','t'),null);
  assert.deepEqual(fs.readdirSync(path.dirname(f.meta)).filter(x=>x.endsWith('.tmp')),[]);
});
win('queued send uses the same fresh-session fallback once',async t=>{
  const f=fixture(t);await f.send('grok');f.settings.profile='changed';const item=f.runner.enqueue('p','t',{ai:'grok',model:'fixture-model',text:'queued'});
  const result=await f.runner.sendQueued(f.options('grok',{request:item.id,text:item.text})),run=f.runner.busy('p','t');await result.started;await run.finishedP;
  assert.deepEqual(result.freshSession,{code:'SESSION_SCOPE_CHANGED'});assert.equal(result.resume,false);assert.equal(f.settings.prepares,2);
});
win('runtime retire is limited to unconfirmed resumed sessions, preserves failed assistant, next turn is fresh',async t=>{
  const recover=['GROK_NATIVE_RESUME_UNAVAILABLE','GROK_NATIVE_RESUME_FAILED','CLAUDE_NATIVE_RESUME_FAILED','GROK_NATIVE_SESSION_MISMATCH','CLAUDE_NATIVE_SESSION_MISMATCH'];
  const retain=['GROK_NATIVE_AUTH_UNAVAILABLE','GROK_NATIVE_RATE_LIMITED','GROK_NATIVE_WALL_TIMEOUT','GROK_NATIVE_INIT_TIMEOUT','CLAUDE_NATIVE_WALL_TIMEOUT','CLAUDE_NATIVE_INIT_TIMEOUT','CLAUDE_NATIVE_EXIT_UNSUCCESSFUL'];
  for(const code of [...recover,...retain])for(const condition of ['unconfirmed','confirmed','stopped','new']){
    const ai=code.startsWith('CLAUDE')?'claude':'grok',f=fixture(t);if(condition!=='new')await f.send(ai);
    const before=chat.readMeta(f.ledger,'t'),bridge=require('../lib/'+ai+'-native-bridge');
    const mock=t.mock.method(bridge,'start',o=>{
      const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true,ready:Promise.resolve(true),cleanupReceipt:{cleanupVerified:true}});c.kill=()=>true;
      setImmediate(()=>{c.emit('spawn');if(condition!=='new')o.onSession({project:o.project,task:o.task,runId:o.runId,sessionId:o.sessionId});if(condition==='confirmed')c.stdout.write(JSON.stringify({type:'thread.started',thread_id:o.sessionId})+'\n');c.stdout.write(JSON.stringify({type:'turn.failed',error:{message:code}})+'\n');c.stdout.end();c.stderr.end();c.emit('close',1,null);});return c;
    });
    const result=f.runner.send(f.options(ai)),run=f.runner.busy('p','t');if(condition==='stopped')f.runner.stop('p','t');await result.started;await run.finishedP;mock.mock.restore();
    const expected=recover.includes(code)&&condition==='unconfirmed',saved=chat.readMeta(f.ledger,'t');assert.equal(Boolean(saved.retiredBindings),expected,code+' '+condition);
    const events=chat.read(f.ledger,'t').filter(r=>r.freshSession);assert.equal(events.length,expected?1:0);assert.ok(chat.read(f.ledger,'t').at(-1).error);
    if(expected){assert.equal(saved.sessions[ai],undefined);assert.equal(saved.rulesSent[ai],undefined);assert.equal(events[0].code,code);assert.match(events[0].text,/下一則訊息/);assert.ok(events[0].text.includes(code));assert.equal(saved.retiredBindings[0].providerSessionId,before.sessions[ai]);const next=await f.send(ai);assert.equal(next.result.resume,false);assert.equal(next.row.error,'');}
    else assert.equal(saved.sessions?.[ai],before.sessions?.[ai]);
  }
});
win('chat metadata retries transient sharing failures without starting duplicate endpoints',async t=>{
  const f=fixture(t),rename=fs.renameSync;let calls=0;
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.meta&&++calls<3)throw Object.assign(Error('PRIVATE'),{code:'EBUSY'});return rename(a,b);});
  const done=await f.send('grok');assert.equal(done.row.error,'');assert.equal(f.opened.length,1);assert.ok(calls>=3);assert.deepEqual(fs.readdirSync(path.dirname(f.meta)).filter(x=>x.endsWith('.tmp')),[]);
});



win('failed runtime retirement preserves binding and emits no misleading fresh-session event',async t=>{
  const f=fixture(t);await f.send('grok');const original=fs.readFileSync(f.meta),bridge=require('../lib/grok-native-bridge'),rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.meta)throw Object.assign(Error('PRIVATE_PATH'),{code:'EINVAL'});return rename(a,b);});
  t.mock.method(bridge,'start',()=>{const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true,ready:Promise.resolve(true),cleanupReceipt:{cleanupVerified:true}});c.kill=()=>true;setImmediate(()=>{c.emit('spawn');c.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'GROK_NATIVE_RESUME_FAILED'}})+'\n');c.stdout.end();c.stderr.end();c.emit('close',1,null);});return c;});
  const result=f.runner.send(f.options()),run=f.runner.busy('p','t');await result.started;await run.finishedP;
  assert.deepEqual(fs.readFileSync(f.meta),original);assert.equal(chat.read(f.ledger,'t').some(x=>x.freshSession),false);assert.match(chat.read(f.ledger,'t').at(-1).error,/CHAT_META_WRITE_FAILED/);
});

win('synchronous owner metadata save exhausts only the explicit 300 ms retry budget',async t=>{
  const f=fixture(t),rename=fs.renameSync,delays=[];let calls=0;
  t.mock.method(Atomics,'wait',(_a,_i,_v,ms)=>{delays.push(ms);});
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.meta){calls++;throw Object.assign(Error('private'),{code:'EACCES'});}return rename(a,b);});
  const result=f.runner.send(f.options('claude')),run=f.runner.busy('p','t');
  await assert.rejects(result.started,{code:'CLAUDE_NATIVE_SESSION_BINDING_FAILED'});await run.finishedP;assert.equal(f.prompts.length,0);
  assert.equal(calls%6,0);assert.ok(calls>=6);for(let i=0;i<delays.length;i+=5)assert.deepEqual(delays.slice(i,i+5),[10,20,40,80,150]);
});


win('chat accepts thirty-minute controller plans for both providers',async t=>{
  const f=fixture(t);
  for(const actor of ['claude','grok']){
    const base=f.handlers[actor].prepare;
    const runner=new chat.ChatRunner({dirOf:()=>f.ledger,nativeProviders:{[actor]:{...f.handlers[actor],prepare:o=>({...base(o),maxWallMs:1800000})}}});
    const result=runner.send(f.options(actor)),run=runner.busy('p','t');await result.started;await run.finishedP;
    assert.equal(run.protocolFailed,undefined);assert.equal(f.opened.at(-1).actor,actor);
  }
});
