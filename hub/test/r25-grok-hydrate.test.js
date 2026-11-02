'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {createGrokHydrator}=require('../lib/grok-hydrate');
function fixture(t,extra={}){
  const runtimeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'r25-hydrate-'));
  t.after(()=>fs.rmSync(runtimeDirectory,{recursive:true,force:true}));
  const providerHome=path.join(runtimeDirectory,'grok'),authPath=path.join(providerHome,'auth.json'),lockPath=authPath+'.lock';
  const paths={runtimeDirectory,providerHome,authPath,lockPath},calls=[],records=[],kills=[],timers=[],aclCalls=[];
  const child=Object.assign(new EventEmitter(),{pid:12345});
  const h=createGrokHydrator({resolveGrok:async()=> 'C:\\Synthetic Tools\\grok.exe',spawn:(...args)=>{calls.push(args);return child;},
    systemRoot:'C:\\Windows',restoreInheritance:async(...args)=>{aclCalls.push(args);return true;},
    nodeFile:process.execPath,hubLibDirectory:'C:\\Synthetic Hub\\lib',env:{KEEP:'yes',USERPROFILE:'C:\\synthetic',HUB_SECRET:'secret',PROJECT_HUB_TOKEN:'secret',GROK_AUTH_BAD:'secret',grok_auth_expired:'1',GROK_HOME:'old',HTTP_PROXY:'bad',https_proxy:'bad',ALL_PROXY:'bad',NO_PROXY:'bad',GROK_AUTH_EARLY_INVALIDATION_SECS:'5'},
    record:(...r)=>records.push(r),kill:pid=>kills.push(pid),setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{},...extra});
  t.after(()=>h.dispose());
  return {...paths,paths,h,calls,records,kills,timers,aclCalls,child,start:async()=>{const promise=h.hydrate(paths);await Promise.resolve();await Promise.resolve();return {promise};}};
}
test('hydrator spawn contract, stale removal, fresh file and missing lock creation',async t=>{
  const f=fixture(t);fs.mkdirSync(f.providerHome);fs.writeFileSync(f.authPath,'stale');fs.writeFileSync(f.lockPath,'stale');
  const {promise}=await f.start();assert.equal(fs.existsSync(f.authPath),false);assert.equal(fs.existsSync(f.lockPath),false);
  assert.equal(f.calls.length,1);const [file,args,opts]=f.calls[0];
  assert.equal(file,'C:\\Synthetic Tools\\grok.exe');assert.deepEqual(args,['login','--device-auth']);
  assert.deepEqual(opts,{cwd:path.join(f.runtimeDirectory,'grok-hydrate'),windowsHide:true,stdio:'ignore',env:{KEEP:'yes',USERPROFILE:'C:\\synthetic',GROK_HOME:path.join(f.runtimeDirectory,'grok-hydrate'),GROK_AUTH_PATH:f.authPath,GROK_AUTH_PROVIDER_COMMAND:'grok-auth-helper-owner.cmd',PATH:'C:\\Synthetic Hub\\lib',HUB_NODE:process.execPath,GROK_DISABLE_AUTOUPDATER:'1',GROK_MEMORY:'0',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DO_NOT_TRACK:'1'}});
  assert.deepEqual(f.aclCalls,[]);
  fs.writeFileSync(f.authPath,'synthetic');f.child.emit('exit',0);const result=await promise;
  assert.deepEqual(f.aclCalls,[[f.authPath],[f.lockPath]]);
  assert.equal(result.acl,'inherited');
  assert.equal(result.outcome,'hydrated');assert.ok(Object.isFrozen(result));assert.ok(fs.existsSync(f.lockPath));assert.equal(f.timers[0].ms,20000);
  assert.deepEqual(f.records,[['grok-hydrate',{...result}]]);assert.deepEqual(Object.keys(result),['outcome','timedOut','exitCode','durationMs','acl']);assert.ok(!JSON.stringify(f.records).includes(f.runtimeDirectory));
});
test('hydrator prepends Hub lib and canonicalizes inherited PATH keys',async t=>{
  for(const env of [
    {Path:'C:\\Parent\\bin;C:\\Other',USERPROFILE:'C:\\synthetic'},
    {PATH:'X',Path:'Y'},
    {path:'lower',pAtH:'ignored'},
    {PATH:'',Path:'fallback'}
  ]){
    const f=fixture(t,{env}),{promise}=await f.start();
    assert.equal(f.calls.length,1);
    const childEnv=f.calls[0][2].env;
    assert.deepEqual(Object.keys(childEnv).filter(key=>key.toLowerCase()==='path'),['PATH']);
    assert.equal(childEnv.PATH,'C:\\Synthetic Hub\\lib;'+(env.PATH||env.Path||env.path));
    assert.equal(Object.hasOwn(childEnv,'Path'),false);
    f.child.emit('exit',1);assert.equal((await promise).outcome,'failed');
  }
});

test('hydrator failure matrix and deadline kills once',async t=>{
  for(const mode of ['missing','empty','old','exit','error','timeout','bad-lock'])await t.test(mode,async sub=>{
    const f=fixture(sub),{promise}=await f.start();
    if(mode==='empty')fs.writeFileSync(f.authPath,'');
    if(mode==='old'){fs.writeFileSync(f.authPath,'old');fs.utimesSync(f.authPath,0,0);}
    if(mode==='bad-lock'){fs.writeFileSync(f.authPath,'new');fs.mkdirSync(f.lockPath);}
    if(mode==='error')f.child.emit('error',Error('synthetic'));
    else if(mode==='timeout'){f.timers[0].fn();f.timers[0].fn();f.child.emit('exit',0);}
    else f.child.emit('exit',mode==='exit'?1:0);
    const r=await promise;assert.equal(r.outcome,'failed');assert.equal(r.timedOut,mode==='timeout');if(mode==='timeout')assert.deepEqual(f.kills,[12345]);
    assert.equal(r.acl,null);assert.deepEqual(f.aclCalls,[]);
    assert.deepEqual(Object.keys(r),['outcome','timedOut','exitCode','durationMs','acl']);
  });
});
test('hydrator refuses unsafe stale files and invalid paths before spawning',async t=>{
  const f=fixture(t);fs.mkdirSync(f.providerHome);fs.writeFileSync(f.authPath,'synthetic');
  const original=fs.lstatSync;
  const mock=t.mock.method(fs,'lstatSync',file=>file===f.authPath?{isFile:()=>true,isSymbolicLink:()=>true,nlink:1}:original(file));
  assert.equal((await f.h.hydrate(f.paths)).outcome,'failed');mock.mock.restore();
  for(const bad of [null,{}, {...f.paths,authPath:f.authPath+'x'},{...f.paths,lockPath:'relative'},{...f.paths,providerHome:f.runtimeDirectory},{...f.paths,runtimeDirectory:f.providerHome},{...f.paths,providerHome:'C:\\bad&path'}])assert.equal((await f.h.hydrate(bad)).outcome,'failed');
  assert.equal(f.calls.length,0);
});
test('hydrator shares in-flight promise and dispose kills and refuses later calls',async t=>{
  const f=fixture(t);const first=f.h.hydrate(f.paths);assert.equal(f.h.hydrate(f.paths),first);await Promise.resolve();
  f.h.dispose();f.h.dispose();assert.equal((await first).outcome,'failed');assert.deepEqual(f.kills,[12345]);assert.equal((await f.h.hydrate(f.paths)).outcome,'failed');assert.equal(f.calls.length,1);
});
test('hydrator dispose during resolution and invalid resolver never spawn',async t=>{
  let resolve;const f=fixture(t,{resolveGrok:()=>new Promise(r=>{resolve=r;})});const promise=f.h.hydrate(f.paths);f.h.dispose();resolve('C:\\tools\\grok.exe');assert.equal((await promise).outcome,'failed');assert.equal(f.calls.length,0);
  const g=fixture(t,{resolveGrok:async()=> 'grok'});assert.equal((await g.h.hydrate(g.paths)).outcome,'failed');assert.equal(g.calls.length,0);
});

test('hydrator ACL failures refuse hydration and preserve exit zero',async t=>{
  for(const mode of ['lock-false','reject','throw','non-boolean'])await t.test(mode,async sub=>{
    const calls=[];
    const f=fixture(sub,{restoreInheritance:(...args)=>{
      calls.push(args);
      if(mode==='reject')return Promise.reject(Error('private ACL error'));
      if(mode==='throw')throw Error('private ACL error');
      if(mode==='non-boolean')return Promise.resolve(1);
      return Promise.resolve(calls.length===1);
    }});
    const {promise}=await f.start();fs.writeFileSync(f.authPath,'synthetic');f.child.emit('exit',0);
    const result=await promise;
    assert.deepEqual(result,{outcome:'failed',timedOut:false,exitCode:0,durationMs:result.durationMs,acl:'failed'});
    assert.deepEqual(calls,mode==='lock-false'?[[f.authPath],[f.lockPath]]:[[f.authPath]]);
    assert.deepEqual(f.records,[['grok-hydrate',result]]);
    assert.ok(Object.isFrozen(result));assert.doesNotMatch(JSON.stringify(f.records),/private ACL error/);
  });
});
test('hydrator deadline or disposal wins pending ACL work and ignores late completion',async t=>{
  for(const stop of ['timeout','dispose'])for(const pendingCall of [1,2])await t.test(stop+' call '+pendingCall,async sub=>{
    let complete;const calls=[];
    const f=fixture(sub,{restoreInheritance:(...args)=>{
      calls.push(args);
      return calls.length===pendingCall?new Promise(resolve=>{complete=resolve;}):Promise.resolve(true);
    }});
    const {promise}=await f.start();fs.writeFileSync(f.authPath,'synthetic');f.child.emit('exit',0);
    await Promise.resolve();assert.equal(calls.length,pendingCall);
    if(stop==='timeout')f.timers[0].fn();else f.h.dispose();
    const result=await promise;
    assert.deepEqual(result,{outcome:'failed',timedOut:stop==='timeout',exitCode:null,durationMs:result.durationMs,acl:null});
    const snapshot=JSON.stringify(f.records);
    complete(true);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(await promise,result);assert.equal(JSON.stringify(f.records),snapshot);
    assert.equal(calls.length,pendingCall);assert.deepEqual(f.kills,[12345]);
  });
});
test('hydrator never restores ACLs after nonzero exit or missing auth',async t=>{
  for(const mode of ['exit','missing'])await t.test(mode,async sub=>{
    const f=fixture(sub),{promise}=await f.start();
    if(mode==='exit')fs.writeFileSync(f.authPath,'synthetic');
    f.child.emit('exit',mode==='exit'?1:0);
    const result=await promise;assert.equal(result.outcome,'failed');assert.equal(result.acl,null);assert.deepEqual(f.aclCalls,[]);
  });
});
test('hydrator rejects symlink and multi-link output files before any ACL call',async t=>{
  for(const target of ['authPath','lockPath'])for(const kind of ['symlink','hardlink'])await t.test(target+' '+kind,async sub=>{
    const f=fixture(sub),{promise}=await f.start();fs.writeFileSync(f.authPath,'synthetic');fs.writeFileSync(f.lockPath,'');
    const original=fs.lstatSync;
    sub.mock.method(fs,'lstatSync',file=>file===f[target]?{isFile:()=>true,isSymbolicLink:()=>kind==='symlink',nlink:kind==='hardlink'?2:1}:original(file));
    f.child.emit('exit',0);
    const result=await promise;assert.equal(result.outcome,'failed');assert.equal(result.acl,null);assert.deepEqual(f.aclCalls,[]);
  });
});
