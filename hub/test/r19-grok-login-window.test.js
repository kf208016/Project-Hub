'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {createGrokLoginWindow}=require('../lib/grok-login-window');
function fixture(t,extra={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r19-window-')),file=path.join(home,'.grok','auth.json');fs.mkdirSync(path.dirname(file));
  const write=mtime=>{fs.writeFileSync(file,'synthetic');fs.utimesSync(file,mtime/1000,mtime/1000);};write(1800000000000);
  t.after(()=>{assert.equal(path.dirname(path.resolve(home)),path.resolve(os.tmpdir()));fs.rmSync(home,{recursive:true,force:true});});
  const child=new EventEmitter();child.pid=123;const calls=[],records=[],kills=[],timers=new Map();let next=0,time=1800000001000;
  const options={home,env:{USERPROFILE:home,PATH:'synthetic-path',PROJECT_HUB_TOKEN:'secret',project_hub_x:'secret',HUB_X:'secret',hub_x:'secret',GROK_HOME:'secret',grok_home:'secret',HTTP_PROXY:'secret',https_proxy:'secret',All_Proxy:'secret',no_PROXY:'secret'},comspec:'C:\\Windows\\System32\\cmd.exe',resolveGrok:async()=> 'C:\\Hub Private\\grok.exe',
    spawn:(...args)=>{calls.push(args);return child;},now:()=>time,record:(...args)=>records.push(args),isGrokTurnActive:()=>false,
    setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),kill:pid=>kills.push(pid),...extra};
  const window=createGrokLoginWindow(options);
  return {window,home,file,child,calls,records,kills,timers,options,write,advance:ms=>{time+=ms;}};
}
for(const [mode,args,deadline]of [['refresh','models',120000],['login','login',900000],['device','login --device-auth',900000]])test('R19 exact owner cmd launch and stripped environment: '+mode,async t=>{
  const f=fixture(t);const value=await f.window.start(mode);assert.equal(value.running,true);
  assert.deepEqual(f.calls,[[f.options.comspec,['/d','/s','/c','start "Grok login" /wait "C:\\Hub Private\\grok.exe" '+args],{windowsVerbatimArguments:true,windowsHide:true,stdio:'ignore',cwd:f.home,env:{USERPROFILE:f.home,PATH:'synthetic-path',...(mode==='refresh'?{GROK_AUTH_EARLY_INVALIDATION_SECS:'21600'}:{})}}]]);
  assert.equal([...f.timers.values()][0].ms,deadline);f.child.emit('exit',0);assert.equal(f.timers.size,0);
});
test('R19 rejects invalid modes and active Grok turn without resolving or spawning',async t=>{
  const f=fixture(t,{resolveGrok:()=>assert.fail('resolve forbidden')});for(const mode of ['',null,undefined,{},'REFRESH','models','toString','__proto__'])await assert.rejects(f.window.start(mode),{status:400});
  const active=fixture(t,{isGrokTurnActive:()=>true,resolveGrok:()=>assert.fail('resolve forbidden')});await assert.rejects(active.window.start('login'),{code:'GROK_LOGIN_TURN_ACTIVE',status:409});assert.equal(f.calls.length+active.calls.length,0);
});
test('R19 single flight includes asynchronous binary resolution',async t=>{
  let resolve;const f=fixture(t,{resolveGrok:()=>new Promise(r=>{resolve=r;})});const first=f.window.start('refresh');await assert.rejects(f.window.start('login'),{code:'GROK_LOGIN_WINDOW_OPEN',status:409});resolve('C:\\Hub\\grok.exe');await first;
  await assert.rejects(f.window.start('device'),{code:'GROK_LOGIN_WINDOW_OPEN'});assert.equal(f.calls.length,1);f.child.emit('exit',0);
});
test('R19 refuses unreviewed binary, unsafe paths and mismatched owner',async t=>{
  for(const file of [null,'relative\\grok.exe','\\\\server\\grok.exe','C:\\Hub\\other.exe',...['"','%','^','&','|','<','>','!','\r','\n'].map(c=>'C:\\Hub'+c+'\\grok.exe')]){
    const f=fixture(t,{resolveGrok:async()=>file});await assert.rejects(f.window.start('login'),{code:'GROK_LOGIN_UNAVAILABLE',status:409});assert.equal(f.calls.length,0);
  }
  const rejected=fixture(t,{resolveGrok:()=>{throw Error('private hash path');}});await assert.rejects(rejected.window.start('login'),{message:'GROK_LOGIN_UNAVAILABLE'});
  const mismatch=fixture(t,{env:{USERPROFILE:'C:\\Different'}});await assert.rejects(mismatch.window.start('login'),{code:'GROK_LOGIN_UNAVAILABLE'});assert.equal(mismatch.calls.length,0);
});
test('R19 owner comparison ignores case and turn is checked again after resolve',async t=>{
  const f=fixture(t);f.options.env.USERPROFILE=f.home.toUpperCase();await f.window.start('refresh');f.child.emit('exit',0);
  let active=false;const g=fixture(t,{resolveGrok:async()=>{active=true;return 'C:\\Hub\\grok.exe';},isGrokTurnActive:()=>active});await assert.rejects(g.window.start('login'),{code:'GROK_LOGIN_TURN_ACTIVE'});assert.equal(g.calls.length,0);
});
for(const kind of ['newer','missing-present','same','failed','missing','older'])test('R19 exit metadata outcome: '+kind,async t=>{
  const f=fixture(t);if(kind==='missing-present'||kind==='missing')fs.unlinkSync(f.file);await f.window.start('refresh');
  if(kind==='newer'||kind==='missing-present')f.write(1800000002000);if(kind==='older')f.write(1799999990000);f.advance(2000);f.child.emit('exit',kind==='failed'?1:0);
  const outcome=['newer','missing-present'].includes(kind)?'refreshed':kind==='same'?'unchanged':'failed';assert.equal(f.window.state().outcome,outcome);
  assert.deepEqual(f.records,[['grok-login-window',{mode:'refresh',exitCode:kind==='failed'?1:0,outcome,timedOut:false,durationMs:2000}]]);assert.doesNotMatch(JSON.stringify(f.records),/synthetic|auth\.json|[A-Za-z]:\\|PATH|USERPROFILE|secret/);
});
test('R19 deadline kills tree via injected kill and forces failed even with changed metadata',async t=>{
  const f=fixture(t);await f.window.start('refresh');f.write(1800000002000);[...f.timers.values()][0].fn();assert.deepEqual(f.kills,[123]);assert.equal(f.window.state().outcome,'failed');assert.equal(f.window.state().timedOut,true);f.child.emit('exit',0);assert.equal(f.records.length,1);
});
test('R19 synchronous exit during kill remains failed and timed out',async t=>{
  let f;f=fixture(t,{kill:()=>f.child.emit('exit',0)});await f.window.start('refresh');f.write(1800000002000);[...f.timers.values()][0].fn();assert.equal(f.window.state().outcome,'failed');assert.equal(f.window.state().timedOut,true);assert.equal(f.records.length,1);
});
test('R19 stale deadline never kills a finished window or a later process',async t=>{
  const f=fixture(t);await f.window.start('refresh');const deadline=[...f.timers.values()][0].fn;f.child.emit('exit',0);deadline();assert.deepEqual(f.kills,[]);assert.equal(f.window.state().outcome,'unchanged');assert.equal(f.records.length,1);
});
test('R19 dispose kills running window and prevents late resolver spawning',async t=>{
  const f=fixture(t);await f.window.start('login');f.window.dispose();assert.deepEqual(f.kills,[123]);assert.equal(f.window.state().outcome,'failed');f.window.dispose();assert.equal(f.records.length,1);
  let resolve;const g=fixture(t,{resolveGrok:()=>new Promise(r=>{resolve=r;})});const pending=g.window.start('login');g.window.dispose();resolve('C:\\Hub\\grok.exe');await assert.rejects(pending,{code:'GROK_LOGIN_UNAVAILABLE'});assert.equal(g.calls.length,0);
});
test('R19 spawn errors are bounded, recorded once and release single flight',async t=>{
  const f=fixture(t,{spawn:()=>{throw Error('private');}});await assert.rejects(f.window.start('refresh'),{message:'GROK_LOGIN_UNAVAILABLE'});assert.equal(f.window.state().running,false);assert.equal(f.records[0][1].outcome,'failed');
  const g=fixture(t);await g.window.start('login');g.child.emit('error',Error('private'));g.child.emit('exit',1);assert.equal(g.records.length,1);assert.equal(g.window.state().outcome,'failed');
});
test('R19 window lifecycle never reads credential contents',async t=>{
  const f=fixture(t);let attempts=0;
  for(const [obj,name]of [[fs,'openSync'],[fs,'readFileSync'],[fs,'createReadStream'],[fs.promises,'readFile']]){
    const original=obj[name];t.mock.method(obj,name,function(file,...args){if(path.resolve(String(file)).toLowerCase()===f.file.toLowerCase()){attempts++;assert.fail('credential read forbidden');}return original.call(this,file,...args);});
  }
  f.window.state();await f.window.start('refresh');f.child.emit('exit',0);assert.equal(f.window.state().outcome,'unchanged');f.window.dispose();assert.equal(attempts,0);
});

for(const mode of ['refresh','login','device'])test('R21 inherited early invalidation is overridden only for refresh: '+mode,async t=>{
  const f=fixture(t);f.options.env.GROK_AUTH_EARLY_INVALIDATION_SECS='17';
  await f.window.start(mode);
  assert.equal(f.calls[0][2].env.GROK_AUTH_EARLY_INVALIDATION_SECS,mode==='refresh'?'21600':'17');
  assert.equal(f.options.env.GROK_AUTH_EARLY_INVALIDATION_SECS,'17');f.child.emit('exit',0);
});
test('R21 window metadata uses configured TTL and margin through exit',async t=>{
  const f=fixture(t);f.options.env.PROJECT_HUB_GROK_LOGIN_TTL_MS='6000000';f.options.env.PROJECT_HUB_GROK_LOGIN_MARGIN_MS='600000';
  const window=createGrokLoginWindow(f.options);f.advance(5399000);
  assert.equal(window.state().login.state,'expiring');assert.equal(window.state().login.refreshAt,1800005400000);
  await window.start('refresh');f.child.emit('exit',0);
  assert.equal(window.state().login.state,'expiring');assert.equal(window.state().outcome,'unchanged');
});
