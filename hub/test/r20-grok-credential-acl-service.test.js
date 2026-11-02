'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {NativeProviderRuntime}=require('../lib/native-provider-runtime');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture({revoke,refresh,gate,prepare,dispose,enabled=true}={}){
  const events=[],records=[],turns=new Map();let runtime;
  class Runtime{
    constructor(options){this.options=options;runtime=this;}
    active(actor){return [...turns.values()].filter(r=>r.actor===actor).length;}
    async prepareTurn(r){events.push('prepare:'+r.task);if(prepare)await prepare(r);turns.set(r.task,r);return r;}
    async end(task,kind='success'){const r=turns.get(task);events.push(kind+':'+task);await this.options.dispose(r);turns.delete(task);this.options.onTurnEnd(r);}
    cancel(r){return this.end(r.task,'cancel');}
  }
  const filename=path.join(__dirname,'../lib/native-provider-service.js'),actual=createRequire(filename),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,require:name=>name==='./native-provider-runtime'?{NativeProviderRuntime:Runtime}:actual(name)});
  const service=new module.exports.NativeProviderService({resolveWorkspace:()=>{},profile:()=>{},modelFlag:()=>{},effortFlag:()=>{},supervisedSpawn:()=>{},
    dispose:dispose||(()=>{}),refresher:refresh?{ensureFresh:refresh}:null,grokLoginGate:gate||(()=>{}),record:(...args)=>records.push(args),
    grokCredentialAcl:enabled?{revoke:async reason=>{events.push('revoke:'+reason);return revoke?.(reason);}}:null});
  return {service,events,records,runtime,turns,start:(task='a',ai='grok')=>service.prepareTurn({ai,task}),end:(task='a',kind)=>runtime.end(task,kind)};
}
test('R20 startup is once; last Grok success/failure/cancel revokes after dispose',async()=>{
  for(const kind of ['success','failure','cancel']){
    const f=fixture();await f.service.startupCredentialAcl();await f.service.startupCredentialAcl();assert.deepEqual(f.events,['revoke:startup']);
    await f.start('a');await f.start('b');await f.end('a',kind);await tick();assert.equal(f.events.filter(e=>e==='revoke:turn-end').length,0);
    if(kind==='cancel')await f.service.cancel({actor:'grok',task:'b'});else await f.end('b',kind);
    await tick();assert.equal(f.events.at(-1),'revoke:turn-end');assert.equal(f.events.filter(e=>e==='revoke:turn-end').length,1);
  }
});
test('R20 pending Grok preparation waits for in-flight revoke before refresh/gate/runtime',async()=>{
  const block=deferred(),events=[];
  const f=fixture({revoke:async()=>{events.push('revoke-start');await block.promise;events.push('revoke-end');},refresh:async()=>events.push('refresh'),gate:()=>events.push('gate'),prepare:()=>events.push('runtime')});
  const startup=f.service.startupCredentialAcl();await tick();const prepared=f.start();await tick();assert.deepEqual(events,['revoke-start']);
  block.resolve();await startup;await prepared;assert.deepEqual(events,['revoke-start','revoke-end','refresh','gate','runtime']);
});
test('R20 pending refresher prevents last-turn revoke and rejection releases pending count',async()=>{
  const block=deferred();let calls=0;
  const f=fixture({refresh:async()=>{if(++calls===2)await block.promise;},gate:()=>{if(calls===2)throw Error('gate');}});
  await f.start('a');const pending=f.start('b');await tick();await f.end('a');await tick();assert.ok(!f.events.includes('revoke:turn-end'));
  block.resolve();await assert.rejects(pending,/gate/);await tick();assert.equal(f.events.at(-1),'revoke:turn-end');
});
test('R20 queued revoke rechecks pending count at actual start',async()=>{
  const f=fixture();const startup=f.service.startupCredentialAcl();const pending=f.start();await startup;await pending;
  assert.deepEqual(f.events,['prepare:a']);await f.end();await tick();assert.equal(f.events.at(-1),'revoke:turn-end');
});
test('R20 Claude turns never trigger or delay revoke; null injection does nothing',async()=>{
  const f=fixture();await f.start('c','claude');await f.service.startupCredentialAcl();await f.end('c');await tick();assert.deepEqual(f.events,['prepare:c','revoke:startup','success:c']);
  const disabled=fixture({enabled:false});await disabled.service.startupCredentialAcl();await disabled.start();await disabled.end();await tick();assert.ok(disabled.events.every(e=>!e.startsWith('revoke:')));
});
test('R20 rejected or failed revokes never fail turns; exception diagnostics exclude private payloads',async()=>{
  for(const rejects of [true,false]){
    const f=fixture({revoke:()=>{if(rejects)throw Error('C:\\private S-1-SECRET D:');return {reason:'turn-end',results:[{target:'dir',outcome:'failed',removed:0}]};}});
    await f.service.startupCredentialAcl();await f.start();await f.end();await tick();await f.start('b');
    assert.equal(f.turns.size,1);assert.equal(f.records.length,rejects?2:0);assert.doesNotMatch(JSON.stringify(f.records),/\\|S-1-|D:/);
  }
});
test('R20 auth-failure refresh scope is pending and waits for revokes',async()=>{
  const block=deferred(),refresh=deferred();const f=fixture({revoke:()=>block.promise});
  const startup=f.service.startupCredentialAcl();await tick();let entered=false;
  const retry=f.service.withGrokPreparation(async()=>{entered=true;await refresh.promise;});await tick();assert.equal(entered,false);
  block.resolve();await startup;await tick();assert.equal(entered,true);assert.equal(f.events.length,1);
  refresh.resolve();await retry;await tick();assert.deepEqual(f.events,['revoke:startup','revoke:turn-end']);
});
test('R20 slow disposal completes before revoke',async()=>{
  const block=deferred(),f=fixture({dispose:()=>block.promise});await f.start();const end=f.end();await tick();assert.ok(!f.events.includes('revoke:turn-end'));
  block.resolve();await end;await tick();assert.equal(f.events.at(-1),'revoke:turn-end');
});
test('R20 server composes same owner home, off switch and asynchronous post-listening startup without booting Hub',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const expression=source.slice(source.indexOf('const grokCredentialAcl='),source.indexOf('const nativeProviderService='));
  for(const platform of ['win32','linux'])for(const value of [undefined,'0','1','false'])for(const main of [true,false])for(const dry of [true,false]){
    let calls=0;const home='C:\\SyntheticOwner';const module={},context={module,require:{main:main?module:{}},process:{platform,env:{PROJECT_HUB_GROK_ACL_REVOKE:value,SystemRoot:'C:\\SyntheticWindows'}},os:{homedir:()=>home},DRY:dry,runIcacls:()=>{},record:()=>{},createGrokCredentialAcl:options=>{calls++;assert.equal(options.home,home);assert.equal(options.systemRoot,'C:\\SyntheticWindows');return {};}};
    vm.runInNewContext(expression,context);assert.equal(calls,main&&!dry&&platform==='win32'&&value!=='0'?1:0);
  }
  assert.match(source,/server\.listen\(PORT, '127\.0\.0\.1', \(\) => \{\s*void nativeProviderService\?\.startupCredentialAcl\(\);/);
  assert.match(source,/nativeProviderService\.withGrokPreparation\(\(\)=>grokAuthRefresher\.refresh/);
  assert.doesNotMatch(source.slice(source.indexOf('function shutdown()'),source.indexOf('function shutdown()')+800),/startupCredentialAcl|grokCredentialAcl/);
});
function runtimeFixture({launchThrows=false,resolveThrows=false}={}){
  const events=[],children=[],request={actor:'grok',project:'p',task:'t',dir:'C:\\Synthetic\\work',model:'model',effort:'low',rootFingerprint:'a'.repeat(64)};
  const runtime=new NativeProviderRuntime({resolve:async()=>{if(resolveThrows)throw Error('failure');return {project:'p',task:'t',dir:request.dir,rootFingerprint:request.rootFingerprint,workspaceRun:'run'};},
    authorize:async()=>({scope:{actor:'grok',project:'p',task:'t',rootFingerprint:request.rootFingerprint,runtimeProfileId:'rp',accountProfileId:'ap'},modelFlag:'model',effortFlag:'low',maxWallMs:5000,validatedMcpServers:[],
      launchOptions:{actor:'grok',ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',cwd:request.dir,rootFingerprint:request.rootFingerprint,providerFile:'C:\\Tools\\grok.exe',codexFile:'C:\\Tools\\codex.exe',codexSHA256:'b'.repeat(64),nodeFile:'C:\\Tools\\node.exe',gitDirectory:'C:\\Tools\\git',hubLibDirectory:'C:\\Tools\\lib',systemRoot:'C:\\Windows',maxWallMs:5000}}),
    createBroker:async()=>({proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:12345',snapshot:()=>({}),close:async()=>events.push('broker')}),dispose:async()=>events.push('dispose'),
    onTurnEnd:r=>{events.push('end:'+r.actor);assert.equal(runtime.active('grok'),0);},
    launch:()=>{if(launchThrows)throw Error('uncertain');const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fake',kill:()=>events.push('kill')});children.push(child);return child;}});
  return {runtime,request,events,children,open:plan=>runtime.handlers().grok.openEndpoint({actor:'grok',project:'p',task:'t',runId:plan.runId,dir:request.dir,scope:plan.scope,args:[]})};
}
for(const code of [0,1])test('R20 real runtime fires end once after verified child cleanup, exit '+code,async()=>{
  const f=runtimeFixture(),plan=await f.runtime.prepareTurn(f.request),endpoint=f.open(plan),child=f.children[0];
  child.cleanupReceipt={cleanupVerified:true,rootExited:true,ownedTreeEmpty:true,exitCode:code};const closed=new Promise(resolve=>endpoint.once('close',resolve));child.emit('close',code);await closed;child.emit('close',code);await tick();
  assert.deepEqual(f.events,['broker','dispose','end:grok']);assert.equal(f.runtime.active(),0);
});
test('R20 real runtime setup failure and prepared cancel notify once',async()=>{
  const failed=runtimeFixture({resolveThrows:true});await assert.rejects(failed.runtime.prepareTurn(failed.request));assert.deepEqual(failed.events,['dispose','end:grok']);
  const f=runtimeFixture();await f.runtime.prepareTurn(f.request);const target={actor:'grok',project:'p',task:'t'};await f.runtime.cancel(target);await f.runtime.cancel(target);assert.deepEqual(f.events,['broker','dispose','end:grok']);
});
test('R20 real runtime active cancel waits for cleanup; uncertain-child cleanup stays active without revoking',async()=>{
  const f=runtimeFixture(),plan=await f.runtime.prepareTurn(f.request),endpoint=f.open(plan);await f.runtime.cancel({actor:'grok',project:'p',task:'t'});assert.deepEqual(f.events,['kill']);
  const closed=new Promise(resolve=>endpoint.once('close',resolve));f.children[0].emit('close',1);await closed;assert.equal(f.runtime.active('grok'),1);assert.ok(!f.events.includes('end:grok'));
  const uncertain=runtimeFixture({launchThrows:true}),prepared=await uncertain.runtime.prepareTurn(uncertain.request);assert.throws(()=>uncertain.open(prepared));await tick();
  await assert.rejects(uncertain.runtime.cancel({actor:'grok',project:'p',task:'t'}),{code:'NATIVE_CLEANUP_REQUIRED'});assert.equal(uncertain.runtime.active('grok'),1);assert.ok(!uncertain.events.includes('end:grok'));
});
test('R20 production runner uses argument arrays, shell false, hidden windows and bounded capture',async()=>{
  const filename=path.join(__dirname,'../lib/grok-credential-acl.js'),actual=createRequire(filename),module={exports:{}};let error=null;const calls=[];
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,require:name=>name==='node:child_process'?{execFile:(file,args,options,callback)=>{calls.push({file,args,options});callback(error);}}:actual(name)});
  for(const e of [null,{code:5},{killed:true,code:null}]){error=e;const result=await module.exports.runIcacls('icacls.exe',['target','/Q'],{timeoutMs:30000});assert.equal(result.status,e?(e.code??-1):0);assert.equal(result.timedOut,Boolean(e?.killed));}
  for(const call of calls){assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.options.timeout,30000);assert.equal(call.options.stdio,undefined);assert.ok(call.options.maxBuffer>0);assert.deepEqual(call.args,['target','/Q']);}
});
// Reservation expiry is a turn end even when no endpoint was ever opened.
test('R20 real runtime expiry releases the reservation and notifies only once',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=runtimeFixture();await f.runtime.prepareTurn(f.request);
  t.mock.timers.tick(5000);await tick();assert.equal(f.runtime.active('grok'),0);assert.deepEqual(f.events,['broker','dispose','end:grok']);
  await f.runtime.cancel({actor:'grok',project:'p',task:'t'});assert.equal(f.events.filter(e=>e==='end:grok').length,1);
});
