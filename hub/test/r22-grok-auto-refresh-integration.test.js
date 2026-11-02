'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {messageFor}=require('../lib/native-provider-messages'),{codeOf}=require('../lib/native-provider-diagnostic');
const failed='Grok 登入即將到期或已過期，Hub 剛才自動更新沒有成功，這則訊息沒有送出。請按「更新 Grok 登入」再試一次；如果還是不行，請按「登入 Grok」重新登入，完成後再送一次。';
const refreshing='Hub 正在自動更新 Grok 登入（通常幾秒鐘）；請稍後再按一次。';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('R22 production composition has entry-point, Windows and opt-out conditions and a TDZ-safe callback',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const line=source.split('\n').find(l=>l.trimStart().startsWith('grokLoginGate:'));
  assert.ok(source.indexOf(line)<source.indexOf('const grokLoginWindow='));
  for(const main of [true,false])for(const platform of ['win32','linux'])for(const value of [undefined,'0','1','false']){
    let options,calls=0;const module={},records=[],home='C:\\SyntheticOwner';
    const require=Object.assign(name=>{assert.equal(name,'./lib/grok-turn-gate');return {createGrokTurnGate:o=>{options=o;return ()=>{};}};},{main:main?module:{}});
    const env={PROJECT_HUB_GROK_AUTO_REFRESH:value},context={module,require,process:{platform,env},os:{homedir:()=>home},record:(...args)=>records.push(args),refresh:()=>{calls++;return 'sentinel';}};
    vm.runInNewContext('const gate=({'+line+'}).grokLoginGate; const grokLoginWindow={autoRefresh:refresh};',context);
    assert.equal(options.home,home);assert.strictEqual(options.env,env);assert.equal(calls,0);
    const enabled=main&&platform==='win32'&&value!=='0';assert.equal(typeof options.autoRefresh,enabled?'function':'object');
    if(enabled){assert.equal(options.autoRefresh(),'sentinel');assert.equal(calls,1);}else assert.equal(options.autoRefresh,null);
    const fields={from:'expired'};options.record('grok-login-auto-refresh',fields);assert.equal(records[0][0],'grok-login-auto-refresh');assert.equal(JSON.stringify(records[0][1]),'{}');assert.strictEqual(records[0][2],fields);
  }
});
function serviceFixture({gate=()=>{},refresh=null}={}){
  const turns=new Map(),seen=[],order=[];
  class Runtime{
    active(actor){assert.equal(actor,'grok');return [...turns.values()].filter(r=>r.actor===actor).length;}
    prepareTurn(r){order.push('runtime');turns.set(r.task,r);return r;}
  }
  const filename=path.join(__dirname,'../lib/native-provider-service.js'),actual=createRequire(filename),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,require:n=>n==='./native-provider-runtime'?{NativeProviderRuntime:Runtime}:actual(n)});
  const service=new module.exports.NativeProviderService({resolveWorkspace:()=>{},profile:()=>{},modelFlag:()=>{},effortFlag:()=>{},supervisedSpawn:()=>{},
    refresher:refresh?{ensureFresh:async()=>{order.push('refresh');await refresh();}}:null,grokLoginGate:async options=>{order.push('gate');seen.push(options.otherGrokTurns);await gate(options);}});
  return {service,seen,order,turns,start:(task,ai='grok')=>service.prepareTurn({ai,task})};
}
test('R22 service lone preparation reports zero, reservations count only other Grok, R18 stays before gate',async()=>{
  const f=serviceFixture({refresh:()=>{}});await f.start('claude','claude');await f.start('a');await f.start('b');
  assert.deepEqual(f.seen,[0,1]);assert.deepEqual(f.order,['runtime','refresh','gate','runtime','refresh','gate','runtime']);
});
test('R22 service concurrent preparation counts another pending turn before runtime reservation',async()=>{
  const hold=deferred(),f=serviceFixture({gate:()=>hold.promise});
  const a=f.start('a');await tick();assert.deepEqual(f.seen,[0]);assert.equal(f.turns.size,0);
  const b=f.start('b');await tick();assert.deepEqual(f.seen,[0,1]);assert.equal(f.turns.size,0);
  hold.resolve();await Promise.all([a,b]);assert.equal(f.turns.size,2);
});
test('R22 concurrent preparations held in refresher count each other and failed gates release pending',async()=>{
  const hold=deferred(),f=serviceFixture({refresh:()=>hold.promise,gate:()=>{throw Error('synthetic refusal');}});
  const a=f.start('a'),b=f.start('b');const settled=Promise.allSettled([a,b]);await tick();hold.resolve();assert.deepEqual((await settled).map(x=>x.status),['rejected','rejected']);assert.deepEqual(f.seen,[1,1]);
  await assert.rejects(f.start('c'));assert.equal(f.seen.at(-1),0);assert.equal(f.turns.size,0);
});
test('R22 new public codes have exact Traditional Chinese messages and retain nativeWorkspaceError fields',()=>{
  const filename=path.join(__dirname,'../server.js'),source=fs.readFileSync(filename,'utf8'),line=source.split('\n').find(l=>l.startsWith('function nativeWorkspaceError('));
  const context=vm.createContext({require:createRequire(filename)});vm.runInContext(line,context);
  for(const [code,message]of [['GROK_LOGIN_AUTO_REFRESH_FAILED',failed],['GROK_LOGIN_AUTO_REFRESHING',refreshing]]){
    assert.equal(codeOf({code}),code);assert.equal(messageFor(code),message+'（代碼：'+code+'）');
    const result=context.nativeWorkspaceError(Object.assign(Error(code),{code,status:409,notStarted:true}));assert.equal(result.code,code);assert.equal(result.notStarted,true);assert.equal(result.error,messageFor(code));
  }
});
function ui(){
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('let grokLoginWindowState='),end=source.indexOf('\n\n',source.indexOf('async function startGrokLoginWindow(',start));
  assert.ok(start>0&&end>start);const timers=[],messages=[],refreshes=[],prompt={innerHTML:''};
  const context=vm.createContext({refreshTree:()=>refreshes.push(true),state:{},view:{project:'p',task:'t'},esc:String,$:()=>prompt,document:{querySelectorAll:()=>[]},toast:m=>messages.push(m),setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}});
  vm.runInContext(source.slice(start,end),context);
  return {context,timers,messages,refreshes,prompt,run:s=>vm.runInContext(s,context)};
}
test('R22 auto failure prompt is scoped to the task, has exact message and three manual buttons',()=>{
  const f=ui();f.run('rememberGrokLoginError({code:"GROK_LOGIN_AUTO_REFRESH_FAILED"},"p","t")');
  const html=f.run('grokLoginPromptHtml("p","t")');assert.ok(html.includes(messageFor('GROK_LOGIN_AUTO_REFRESH_FAILED')));
  for(const mode of ['refresh','login','device'])assert.match(html,new RegExp('data-grok-mode="'+mode+'"'));
  assert.equal(f.run('grokLoginPromptHtml("other","t")'),'');assert.equal(f.run('grokLoginPromptHtml("p","other")'),'');assert.equal(f.prompt.innerHTML,html);
});
test('R22 auto UI running, refreshed, unchanged, failed and timed out texts are exact',()=>{
  const f=ui();assert.equal(f.run('grokLoginWindowText({mode:"auto",running:true})'),'Hub 正在自動更新 Grok 登入…');
  for(const outcome of ['unchanged','failed'])assert.equal(f.context.grokLoginWindowText({mode:'auto',outcome}),'自動更新沒有成功；請按「更新 Grok 登入」再試，或改按「登入 Grok」。');
  assert.equal(f.context.grokLoginWindowText({mode:'auto',outcome:'failed',timedOut:true}),'自動更新逾時；請按「更新 Grok 登入」再試，或改按「登入 Grok」。');
  for(const timestamps of [{login:{mtime:1800000000000},finishedAt:1800000009000},{finishedAt:1800000000000}]){
    const time=new Date(timestamps.login?.mtime??timestamps.finishedAt).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});
    assert.equal(f.context.grokLoginWindowText({mode:'auto',outcome:'refreshed',...timestamps}),'Grok 登入已自動更新（'+time+'）。');
  }
  assert.equal(f.context.grokLoginWindowText({mode:'auto'}),'');
});
test('R22 AUTO_REFRESHING shows server message, starts polling, and auto success clears prompt without resend',async()=>{
  const f=ui(),calls=[];f.run('rememberGrokLoginError({code:"GROK_LOGIN_AUTO_REFRESH_FAILED"},"p","t")');
  f.context.api=async(route,body)=>{calls.push([route,body]);if(body)throw Object.assign(Error(messageFor('GROK_LOGIN_AUTO_REFRESHING')),{code:'GROK_LOGIN_AUTO_REFRESHING'});return {mode:'auto',outcome:'refreshed',login:{mtime:1800000000000}};};
  await f.context.startGrokLoginWindow('refresh');assert.equal(f.messages.at(-1),messageFor('GROK_LOGIN_AUTO_REFRESHING'));assert.ok(f.run('grokLoginActionsHtml("test")').includes(messageFor('GROK_LOGIN_AUTO_REFRESHING')));
  assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,2000);assert.deepEqual(f.refreshes,[]);await f.timers[0].fn();assert.deepEqual(f.refreshes,[true]);assert.equal(f.run('state.grokLoginPrompt'),undefined);
  assert.deepEqual(calls.map(c=>c[0]),['/api/grok/login-window','/api/grok/login-window']);assert.match(f.run('grokLoginActionsHtml("test")'),/登入已自動更新/);
});
test('R22 route cannot start auto; manual request during auto returns bounded refreshing message',async()=>{
  const filename=path.join(__dirname,'../server.js'),source=fs.readFileSync(filename,'utf8');
  const begin=source.indexOf("  if(url.pathname==='/api/grok/login-window'){"),end=source.indexOf('  // Mac ',begin);
  const {createGrokLoginWindow}=require('../lib/grok-login-window');let starts=0;
  const window=createGrokLoginWindow({home:'synthetic',env:{USERPROFILE:'synthetic'},spawn:()=>assert.fail('no provider spawn'),resolveGrok:()=>assert.fail('no resolver'),record:()=>{},isGrokTurnActive:()=>false});
  const context=vm.createContext({require:createRequire(filename),DRY:false,localOwner:()=>true,readSmallJson:async req=>req.body,grokLoginWindow:window,send:(_res,status,data)=>({status,data})});
  const handler=vm.runInContext('(async(req,res,url)=>{'+source.slice(begin,end)+'})',context);
  const request=mode=>handler({method:'POST',body:{mode}},{},{pathname:'/api/grok/login-window'});
  assert.equal((await request('auto')).status,400);
  context.grokLoginWindow={start:()=>{starts++;throw Object.assign(Error('private'),{code:'GROK_LOGIN_AUTO_REFRESHING',status:409});}};
  const response=await request('refresh');assert.equal(starts,1);assert.equal(response.status,409);assert.equal(response.data.code,'GROK_LOGIN_AUTO_REFRESHING');assert.equal(response.data.error,messageFor('GROK_LOGIN_AUTO_REFRESHING'));
});
