'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {createGrokLoginWindow}=require('../lib/grok-login-window');
const tick=()=>new Promise(resolve=>setImmediate(resolve)),stamp=1800000000000;
function fixture(t,extra={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r22-window-')),file=path.join(home,'.grok','auth.json');
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'synthetic');
  const touch=value=>fs.utimesSync(file,value/1000,value/1000);touch(stamp);
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  const calls=[],records=[],kills=[],timers=new Set();let time=stamp+1000,unrefs=0;
  const options={home,env:{USERPROFILE:home,PATH:'synthetic',PROJECT_HUB_TOKEN:'private',project_hub_x:'private',HUB_X:'private',hub_x:'private',GROK_HOME:'private',grok_home:'private',HTTP_PROXY:'private',https_proxy:'private',All_Proxy:'private',no_PROXY:'private',GROK_AUTH_EARLY_INVALIDATION_SECS:'17',grok_auth_early_invalidation_secs:'9'},
    resolveGrok:async()=> 'C:\\Reviewed Hub\\grok.exe',spawn:(...args)=>{const child=new EventEmitter();child.pid=123+calls.length;calls.push({args,child});return child;},
    now:()=>time,record:(...args)=>records.push(args),isGrokTurnActive:()=>assert.fail('automatic refresh must not check current turn'),
    setTimeout:(fn,ms)=>{const timer={fn,ms,unref(){unrefs++;}};timers.add(timer);return timer;},clearTimeout:timer=>timers.delete(timer),kill:pid=>kills.push(pid),...extra};
  const window=createGrokLoginWindow(options);
  return {window,home,file,touch,calls,records,kills,timers,options,advance:ms=>{time+=ms;},unrefs:()=>unrefs};
}
test('R22 automatic refresh spawns reviewed exe directly, hidden, with isolated env and 60s deadline',async t=>{
  const f=fixture(t),pending=f.window.autoRefresh();await tick();
  assert.deepEqual(f.calls[0].args,['C:\\Reviewed Hub\\grok.exe',['models'],{windowsHide:true,stdio:'ignore',cwd:f.home,env:{USERPROFILE:f.home,PATH:'synthetic',GROK_AUTH_EARLY_INVALIDATION_SECS:'21600'}}]);
  assert.equal(f.options.env.GROK_AUTH_EARLY_INVALIDATION_SECS,'17');assert.equal(f.unrefs(),1);
  assert.equal([...f.timers][0].ms,60000);assert.equal(f.window.state().mode,'auto');assert.equal(f.window.state().running,true);
  f.calls[0].child.emit('exit',0);assert.deepEqual(await pending,{outcome:'unchanged',timedOut:false});assert.ok(Object.isFrozen(await pending));assert.equal(f.timers.size,0);
});
for(const [kind,code,outcome]of [['newer',0,'refreshed'],['newer',1,'refreshed'],['same',0,'unchanged'],['same',1,'failed'],['older',0,'failed'],['removed',0,'failed']])test('R22 auto metadata outcome '+kind+' exit '+code,async t=>{
  const f=fixture(t),pending=f.window.autoRefresh();await tick();
  if(kind==='newer')f.touch(stamp+2000);if(kind==='older')f.touch(stamp-2000);if(kind==='removed')fs.unlinkSync(f.file);
  f.advance(2000);f.calls[0].child.emit('exit',code);f.calls[0].child.emit('exit',code);
  assert.deepEqual(await pending,{outcome,timedOut:false});assert.ok(Object.isFrozen(await pending));
  assert.deepEqual(f.records,[['grok-login-window',{mode:'auto',exitCode:code,outcome,timedOut:false,durationMs:2000}]]);
  assert.doesNotMatch(JSON.stringify(f.records),/auth\.json|USERPROFILE|private|synthetic|[A-Za-z]:\\/);
});
test('R22 auto single flight includes resolver and manual start rejects all modes with 409',async t=>{
  let resolve;const f=fixture(t,{resolveGrok:()=>new Promise(r=>{resolve=r;})});
  const a=f.window.autoRefresh(),b=f.window.autoRefresh();assert.strictEqual(a,b);assert.equal(f.calls.length,0);
  for(const mode of ['refresh','login','device'])await assert.rejects(f.window.start(mode),{code:'GROK_LOGIN_AUTO_REFRESHING',status:409});
  await assert.rejects(f.window.start('auto'),{status:400});resolve('C:\\Reviewed Hub\\grok.exe');await tick();
  assert.strictEqual(f.window.autoRefresh(),a);assert.equal(f.calls.length,1);f.calls[0].child.emit('exit',0);await a;
});
for(const mode of ['refresh','login','device'])test('R22 auto busy during manual '+mode,async t=>{
  const f=fixture(t,{isGrokTurnActive:()=>false});await f.window.start(mode);
  const result=await f.window.autoRefresh();assert.deepEqual(result,{outcome:'busy',timedOut:false});assert.ok(Object.isFrozen(result));assert.equal(f.calls.length,1);f.calls[0].child.emit('exit',0);
});
test('R22 auto unknown route mode is 400 even when idle',async t=>{
  const f=fixture(t);await assert.rejects(f.window.start('auto'),{status:400});assert.equal(f.calls.length,0);
});
test('R22 deadline kills once and forces failure even with newer metadata and synchronous exit',async t=>{
  const f=fixture(t,{kill:pid=>{f.kills.push(pid);f.calls[0].child.emit('exit',0);}}),pending=f.window.autoRefresh();await tick();
  const deadline=[...f.timers][0].fn;f.touch(stamp+2000);deadline();
  assert.deepEqual(await pending,{outcome:'failed',timedOut:true});assert.deepEqual(f.kills,[123]);assert.equal(f.records.length,1);
  deadline();assert.deepEqual(f.kills,[123]);assert.equal(f.timers.size,0);
});
test('R22 auto error event forces failure, clears timer and permits a new run',async t=>{
  const f=fixture(t),a=f.window.autoRefresh();await tick();f.touch(stamp+2000);f.calls[0].child.emit('error',Error('private'));f.calls[0].child.emit('exit',0);
  assert.deepEqual(await a,{outcome:'failed',timedOut:false});assert.equal(f.timers.size,0);assert.equal(f.records.length,1);
  const b=f.window.autoRefresh();assert.notStrictEqual(a,b);await tick();f.calls[1].child.emit('exit',0);assert.equal((await b).outcome,'unchanged');
});
test('R22 resolver/path/home/disposed failures never spawn or reject',async t=>{
  for(const value of [null,'relative\\grok.exe','\\\\host\\share\\grok.exe','C:\\Hub\\other.exe',...['"','%','^','&','|','<','>','!','\r','\n'].map(c=>'C:\\Hub'+c+'\\grok.exe')]){
    const f=fixture(t,{resolveGrok:async()=>value});assert.deepEqual(await f.window.autoRefresh(),{outcome:'failed',timedOut:false});assert.equal(f.calls.length,0);
  }
  for(const extra of [{resolveGrok:()=>{throw Error('private');}},{env:{USERPROFILE:'C:\\Different'}},{env:{}}]){
    const f=fixture(t,extra);assert.equal((await f.window.autoRefresh()).outcome,'failed');assert.equal(f.calls.length,0);
  }
  const f=fixture(t);f.window.dispose();assert.deepEqual(await f.window.autoRefresh(),{outcome:'failed',timedOut:false});assert.equal(f.calls.length,0);
});
test('R22 owner comparison ignores case; spawn and recorder exceptions never reject',async t=>{
  const f=fixture(t,{record:()=>{throw Error('private');}});f.options.env.USERPROFILE=f.home.toUpperCase();const pending=f.window.autoRefresh();await tick();f.calls[0].child.emit('exit',0);assert.equal((await pending).outcome,'unchanged');
  const g=fixture(t,{spawn:()=>{throw Error('private');}});assert.deepEqual(await g.window.autoRefresh(),{outcome:'failed',timedOut:false});assert.equal(g.window.state().running,false);
});
test('R22 dispose settles active auto and blocks late resolution without spawning',async t=>{
  const f=fixture(t),a=f.window.autoRefresh();await tick();f.window.dispose();assert.deepEqual(await a,{outcome:'failed',timedOut:false});assert.deepEqual(f.kills,[123]);f.window.dispose();assert.equal(f.records.length,1);
  let resolve;const g=fixture(t,{resolveGrok:()=>new Promise(r=>{resolve=r;})}),b=g.window.autoRefresh();g.window.dispose();assert.equal((await b).outcome,'failed');resolve('C:\\Hub\\grok.exe');await tick();assert.equal(g.calls.length,0);
});
test('R22 auto lifecycle uses metadata only, never credential reads',async t=>{
  const f=fixture(t);let reads=0;
  for(const [object,key]of [[fs,'openSync'],[fs,'readFileSync'],[fs,'createReadStream'],[fs.promises,'readFile']]){
    const actual=object[key];t.mock.method(object,key,function(file,...args){if(path.resolve(String(file)).toLowerCase()===f.file.toLowerCase()){reads++;throw Error('credential read forbidden');}return actual.call(this,file,...args);});
  }
  const pending=f.window.autoRefresh();await tick();f.window.state();f.calls[0].child.emit('exit',0);await pending;f.window.dispose();assert.equal(reads,0);
});
