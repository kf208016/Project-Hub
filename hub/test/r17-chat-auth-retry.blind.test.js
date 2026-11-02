'use strict';
// R17 / A6 + A7 blind acceptance.
// A6: a native Grok run that ends with GROK_NATIVE_AUTH_UNAVAILABLE shows one
// GROK_AUTH_REFRESHING notice, calls the ChatRunner option nativeAuthRetry once
// and, on true, resends the same message once (no new user row, no assistant
// row from the failed run). Protocol fixtures only: synthetic ACP/stream-json
// endpoints, no executable, account, network or OS sandbox.
// A7: the new GROK_NATIVE_AUTH_UNAVAILABLE sentence, the notice rendered like
// the R16 notices, and the fixed names (env override, controller module,
// ChatRunner option, R17 doc section) being present. PROJECT_HUB_GROK_AUTH_STALE_MS
// parsing lives only in server start-up (no exported surface), so only its
// presence is checked.
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
function fixture(t,{script=['auth','ok'],retry}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r17-chat-'));
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
  runner=new chat.ChatRunner({dirOf:()=>ledger,nativeProviders:handlers,...(nativeAuthRetry?{nativeAuthRetry}:{})});
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
    assert.ok(path.basename(actual).startsWith('hub-r17-chat-'));fs.rmSync(actual,{recursive:true,force:true});
  });
  return {ledger,dir,runner,options,send,settled,rows,opened,prompts,events,retries,observed,settings};
}
const pick=(row,keys)=>Object.fromEntries(keys.map(k=>[k,row[k]]));
const noticeRows=f=>f.rows().filter(r=>r.code==='GROK_AUTH_REFRESHING');

win('A6 AUTH failure -> one refreshing notice, one nativeAuthRetry, one resend, one user row, success result',{timeout:30000},async t=>{
  const f=fixture(t,{script:['auth','ok'],retry:async()=>true});
  await f.send('grok');
  assert.equal(f.retries.length,1,'nativeAuthRetry called once');
  const o=f.retries[0];
  assert.equal(o.ai,'grok');assert.equal(o.project,'p');assert.equal(o.task,'t');assert.equal(o.text,'synthetic instruction r17');
  assert.equal(o.authRetried,undefined,'the first run is not marked as retried');
  // Notice saved and emitted before the retry was awaited; the task stayed busy meanwhile.
  assert.deepEqual(f.observed,[{busy:true,idleSeen:false,noticeSaved:true,assistantRows:0}]);
  const notices=noticeRows(f);
  assert.equal(notices.length,1);assert.deepEqual(pick(notices[0],Object.keys(NOTICE)),NOTICE);
  assert.ok(f.events.some(e=>e.type==='row'&&e.row.code==='GROK_AUTH_REFRESHING'&&e.row.notice===true&&e.row.text===NOTICE_TEXT));
  // The same message went to Grok twice through two endpoints.
  assert.equal(f.opened.length,2);assert.deepEqual(f.opened.map(x=>x.mode),['auth','ok']);
  assert.equal(f.prompts.length,2);assert.ok(f.prompts.every(p=>p.text.includes('synthetic instruction r17')));
  assert.notEqual(f.opened[0].runId,f.opened[1].runId);
  const all=f.rows();
  assert.equal(all.filter(r=>r.role==='user').length,1,'exactly one user row');
  const assistant=all.filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1,'no assistant row from the failed run');
  assert.equal(assistant[0].error,'');assert.match(assistant[0].text,/fixture-grok-reply/);assert.equal(assistant[0].ai,'grok');
  assert.equal(all.some(r=>r.code===AUTH),false);
  // Order: user row, notice, answer.
  const index=pred=>all.findIndex(pred);
  assert.ok(index(r=>r.role==='user')<index(r=>r.code==='GROK_AUTH_REFRESHING'));
  assert.ok(index(r=>r.code==='GROK_AUTH_REFRESHING')<index(r=>r.role==='assistant'));
  assert.equal(f.runner.busy('p','t'),null);
  assert.equal(f.events.at(-1).type,'idle');
});

for(const [label,retry] of [['returns false',async()=>false],['throws',async()=>{throw Error('synthetic refresh failure');}]]){
  win('A6 nativeAuthRetry '+label+' -> the original AUTH error row, no resend',{timeout:30000},async t=>{
    const f=fixture(t,{script:['auth','ok'],retry});
    await f.send('grok');
    assert.equal(f.retries.length,1);
    assert.equal(f.opened.length,1,'no resend');
    assert.equal(noticeRows(f).length,1,'the notice was shown before the attempt');
    const all=f.rows(),assistant=all.filter(r=>r.role==='assistant');
    assert.equal(all.filter(r=>r.role==='user').length,1);
    assert.equal(assistant.length,1);
    assert.equal(assistant[0].code,AUTH);
    assert.equal(assistant[0].error,messageFor(AUTH));
    assert.match(assistant[0].error,/grok login/);
    assert.equal(f.runner.busy('p','t'),null);
  });
}

win('A6 a second AUTH failure on the resend ends the turn: no third run, one notice, one error row',{timeout:30000},async t=>{
  const f=fixture(t,{script:['auth','auth','ok'],retry:async()=>true});
  await f.send('grok');
  assert.equal(f.retries.length,1,'at most one automatic resend');
  assert.equal(f.opened.length,2,'no third run');
  assert.equal(noticeRows(f).length,1);
  const all=f.rows(),assistant=all.filter(r=>r.role==='assistant');
  assert.equal(all.filter(r=>r.role==='user').length,1);
  assert.equal(assistant.length,1);
  assert.equal(assistant[0].code,AUTH);assert.equal(assistant[0].error,messageFor(AUTH));
});

win('A6 stop during the refresh cancels the resend and keeps the original AUTH error row',{timeout:30000},async t=>{
  let stopReturned;
  const f=fixture(t,{script:['auth','ok'],retry:(o,{runner})=>new Promise(resolve=>setTimeout(()=>{stopReturned=runner.stop('p','t');resolve(true);},30))});
  const result=f.runner.send(f.options('grok'));assert.equal(await result.started,true);
  await f.settled();
  assert.equal(f.retries.length,1);
  assert.notEqual(stopReturned,undefined,'stop was reachable while refreshing');
  assert.equal(f.opened.length,1,'no resend after stop');
  const assistant=f.rows().filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1);
  assert.equal(assistant[0].code,AUTH);assert.equal(assistant[0].error,messageFor(AUTH));
  assert.equal(f.runner.busy('p','t'),null);
});

win('A6 without the nativeAuthRetry option the AUTH failure is reported as today (no notice, no resend)',{timeout:30000},async t=>{
  const f=fixture(t,{script:['auth','ok']});
  await f.send('grok');
  assert.equal(f.opened.length,1);assert.equal(noticeRows(f).length,0);
  const assistant=f.rows().filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1);assert.equal(assistant[0].code,AUTH);assert.equal(assistant[0].error,messageFor(AUTH));
});

win('A6 other Grok error codes are unchanged (no notice, no retry)',{timeout:30000},async t=>{
  const f=fixture(t,{script:['remote','ok'],retry:async()=>true});
  await f.send('grok');
  assert.equal(f.retries.length,0);assert.equal(f.opened.length,1);assert.equal(noticeRows(f).length,0);
  const assistant=f.rows().filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1);assert.equal(assistant[0].code,'GROK_NATIVE_REMOTE_ERROR');
});

win('A6 a Claude login-style failure is untouched (no notice, no retry)',{timeout:30000},async t=>{
  const f=fixture(t,{script:['authlike','ok'],retry:async()=>true});
  await f.send('claude');
  assert.equal(f.retries.length,0);assert.equal(f.opened.length,1);assert.equal(noticeRows(f).length,0);
  const assistant=f.rows().filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1);assert.notEqual(assistant[0].error,'');assert.equal(assistant[0].ai,'claude');
  assert.notEqual(assistant[0].code,AUTH);
});

win('A6 a Claude native run reporting the Grok AUTH code is not retried (Grok only)',{timeout:30000},async t=>{
  const bridge=require('../lib/claude-native-bridge');
  const f=fixture(t,{retry:async()=>true});
  t.mock.method(bridge,'start',o=>{
    const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true,requiresCleanupReceipt:true,cleanupReceipt:null});
    c.kill=()=>true;c.ready=Promise.resolve(true);
    c.stdin.on('finish',()=>setImmediate(()=>{
      c.stdout.write(JSON.stringify({type:'turn.failed',error:{message:AUTH}})+'\n');
      c.cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0};c.stdout.end();c.stderr.end();c.emit('close',0,null);
    }));
    c.stdin.resume();setImmediate(()=>c.emit('spawn'));return c;
  });
  await f.send('claude');
  assert.equal(f.retries.length,0);assert.equal(noticeRows(f).length,0);
  assert.equal(bridge.start.mock.callCount(),1);
  const assistant=f.rows().filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1);assert.equal(assistant[0].ai,'claude');
});

win('A6 a Codex run reporting the Grok AUTH code is not retried (native Grok only)',{timeout:30000},async t=>{
  const bridge=require('../lib/codex-bridge');
  const f=fixture(t,{retry:async()=>true});
  t.mock.method(bridge,'start',()=>{
    const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true});
    c.kill=()=>true;c.ready=Promise.resolve(true);c.listApprovals=()=>[];
    c.stdin.on('finish',()=>setImmediate(()=>{
      c.stdout.write(JSON.stringify({type:'thread.started',thread_id:'synthetic-thread'})+'\n');
      c.stdout.write(JSON.stringify({type:'turn.failed',error:{message:AUTH}})+'\n');
      c.stdout.end();c.stderr.end();c.emit('close',1,null);
    }));
    c.stdin.resume();setImmediate(()=>c.emit('spawn'));return c;
  });
  await f.send('codex');
  assert.equal(bridge.start.mock.callCount(),1,'one Codex run');
  assert.equal(f.retries.length,0);assert.equal(noticeRows(f).length,0);
  const assistant=f.rows().filter(r=>r.role==='assistant');
  assert.equal(assistant.length,1);assert.equal(assistant[0].ai,'codex');assert.notEqual(assistant[0].error,'');
});

// ---------- A7 visibility ----------
const NEW_AUTH_TEXT='Grok 回報登入無效或已過期，這一回合沒有完成。請按「更新 Grok 登入」（或在一般終端機執行 grok login），完成後再送一次。';
const OLD_AUTH_TEXT='Grok 的登入已過期或無法驗證，Hub 不會在沙箱內替你更新登入。請在一般終端機執行 grok 並完成登入（或開啟 Grok 一次），再重新送出。';
const UNCHANGED=Object.freeze({
  GROK_NATIVE_RATE_LIMITED:'Grok 回報已達用量上限，請稍後再試，或確認方案額度。',
  GROK_NATIVE_RETRY_EXHAUSTED:'Grok 多次重試仍失敗，這一回合已停止。請稍後再試；若一再發生，請重新登入 Grok。',
  GROK_NATIVE_IDLE_TIMEOUT:'Grok 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，最常見的原因是登入已過期，請先在一般終端機開啟 Grok 確認登入。',
  GROK_NATIVE_REMOTE_ERROR:'Grok 服務端回報錯誤，這一回合已停止。請稍後再試。'
});
const messages=()=>require('../lib/native-provider-messages');

test('A7 GROK_NATIVE_AUTH_UNAVAILABLE has the exact new sentence plus the code suffix',()=>{
  const {messageFor,messageOrFallback}=messages();
  assert.equal(messageFor(AUTH),NEW_AUTH_TEXT+'（代碼：'+AUTH+'）');
  assert.equal(messageOrFallback(AUTH),messageFor(AUTH));
  assert.match(messageFor(AUTH),/grok login/);
  assert.equal(messageFor(AUTH).includes(OLD_AUTH_TEXT),false);
});

test('A7 a turn.failed AUTH code becomes the new sentence and keeps its code',()=>{
  const {parse}=require('../lib/chat');
  for(const ai of ['grok','codex']){
    const done=parse(ai,{type:'turn.failed',error:{message:AUTH}}).filter(e=>e.kind==='done');
    assert.equal(done.length,1);
    assert.equal(done[0].error,NEW_AUTH_TEXT+'（代碼：'+AUTH+'）');
    assert.equal(done[0].code,AUTH);
  }
});

test('A7 neighbouring Grok messages keep their exact text; the notice code is not a message-table code',()=>{
  const {messageFor}=messages();
  for(const [code,text] of Object.entries(UNCHANGED))assert.equal(messageFor(code),text+'（代碼：'+code+'）',code);
  assert.equal(messageFor('GROK_AUTH_REFRESHING'),null);
});

// ---------- app.js in a vm (copied from the R16 UI tests) ----------
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function app(){
  const elements=new Map(),events=new Map(),windowEvents=new Map(),timers=new Map(),timeouts=new Map(),details=[];
  let nextTimer=0;
  function element(key){
    if(!elements.has(key))elements.set(key,{
      innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,scrollTop:0,scrollHeight:100,clientHeight:100,
      dataset:{},handlers:{},attributes:{},addEventListener(name,cb){this.handlers[name]=cb;},
      setAttribute(name,value){this.attributes[name]=String(value);},
      querySelector(){return null;},querySelectorAll(){return [];},insertAdjacentHTML(){},
    });
    return elements.get(key);
  }
  class EventSource{constructor(){}close(){}}
  const document={
    hidden:false,activeElement:null,
    querySelector:s=>s.startsWith('details[open]')?details.find(d=>d.open)||null:s==='#msg-partial'?elements.get(s)||null:element(s),
    querySelectorAll:()=>[],addEventListener(name,cb){events.set(name,cb);},
  };
  const context=vm.createContext({
    document,window:{addEventListener(name,callback){windowEvents.set(name,callback);}},navigator:{userAgent:''},
    localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),EventSource,URLSearchParams,
    requestAnimationFrame:cb=>cb(),
    setInterval(cb,ms){const id=++nextTimer;timers.set(id,{cb,ms});return id;},clearInterval(id){timers.delete(id);},
    setTimeout(cb,ms){const id=++nextTimer;timeouts.set(id,{cb,ms});return id;},clearTimeout(id){timeouts.delete(id);},
    console,ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order'),confirm:()=>true,
  });
  vm.runInContext(source,context);
  return {context,element};
}
function uiFixture(){
  const a=app(),instances=[];
  class FakeEventSource{
    static CONNECTING=0;static OPEN=1;static CLOSED=2;
    constructor(url){this.url=url;this.readyState=1;this.closed=false;instances.push(this);}
    close(){this.closed=true;this.readyState=2;}
    frame(value){this.onmessage({data:JSON.stringify(value)});}
  }
  a.context.EventSource=FakeEventSource;a.context.console={warn(){}};a.context.toast=()=>{};a.context.api=async()=>({});
  const project={id:'p',name:'Project',parent:'',status:'進行中',description:'',updated:'',phases:[],
    tasks:[{id:'t',title:'Task',state:'実行中',owner:'codex',role:'',model:'',effort:'',phase:'',steps:[],skills:[],question:'',next:'',copy:false}],
    folders:[],related:[],issues:[],chats:[]};
  const state={providers:registry.list({platform:'darwin'}),webChatAvailable:false,root:'/tmp',projects:[project],
    roles:{models:{codex:[],'claude-code':[]},roles:[],permissions:{}},sessions:[],chatting:[],terminal:true,efforts:[],cliFlags:{},version:'1',latest:'1'};
  vm.runInContext('state='+JSON.stringify(state)+';view={kind:"work",project:"p",task:"t"}',a.context);
  a.context.render();
  return {...a,frame:v=>instances.at(-1).frame(v)};
}

test('A7 the GROK_AUTH_REFRESHING notice renders like the R16 notices (visible without details)',()=>{
  const a=uiFixture();
  const notice={role:'event',ai:'grok',notice:true,code:'GROK_AUTH_REFRESHING',text:NOTICE_TEXT};
  assert.equal(a.context.msgHtml({role:'event',tool:true,text:'hidden'}),'','tool rows stay hidden without details');
  assert.equal(a.context.msgHtml(notice),'<div class="ev notice">▸ '+NOTICE_TEXT+'</div>');
  a.frame({type:'rows',rows:[{role:'user',text:'synthetic',at:'2026-10-27T00:00:00Z'},notice],queue:[],approvals:[],busy:null});
  assert.match(a.element('#msgs').innerHTML,new RegExp('class="ev notice">▸ '+NOTICE_TEXT));
});

test('A7 an AUTH error row with the new sentence still shows the grok login hint',()=>{
  const a=uiFixture();
  const row={role:'assistant',ai:'grok',error:messages().messageFor(AUTH),text:'',at:'2026-10-27T00:00:00Z'};
  const html=a.context.msgHtml(row);
  assert.match(html,/grok-login-hint/);
  assert.ok(html.includes('grok login'));
});

test('A7 fixed names are wired: env override and controller in server.js, nativeAuthRetry, R17 doc section',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.ok(server.includes('PROJECT_HUB_GROK_AUTH_STALE_MS'),'server.js reads PROJECT_HUB_GROK_AUTH_STALE_MS');
  assert.ok(/grok-auth-refresh/.test(server),'server.js uses lib/grok-auth-refresh');
  assert.ok(server.includes('nativeAuthRetry'),'server.js passes nativeAuthRetry to ChatRunner');
  assert.ok(server.includes('auth-failure'),'server.js refreshes with trigger auth-failure');
  assert.ok(fs.existsSync(path.join(__dirname,'../lib/grok-auth-refresh.js')));
  const doc=fs.readFileSync(path.join(__dirname,'../windows/PROVIDER-RUNTIME.md'),'utf8');
  const at=doc.search(/^#{2,3} [^\n]*R17/m);
  assert.ok(at>=0,'PROVIDER-RUNTIME.md has an R17 section');
  const section=doc.slice(at);
  for(const needle of ['auth.x.ai','PROJECT_HUB_GROK_AUTH_STALE_MS','auth.json'])assert.ok(section.includes(needle),needle);
});
