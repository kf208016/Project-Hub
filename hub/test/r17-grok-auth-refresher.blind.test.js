'use strict';
// R17 / A4 blind acceptance: createGrokAuthRefresher with fake profile, identity,
// broker, launch and record. The owner home is a temp directory holding a
// synthetic .grok tree; os.homedir and USERPROFILE point there for the whole
// test, launch never spawns, and every fs read/open of an auth.json is trapped.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const FP='e'.repeat(64);
const PROXY='http://hub:'+'c'.repeat(64)+'@127.0.0.1:9';
const PLAN_KEYS=['codexFile','codexSHA256','nodeFile','ownerHome','providerFile','proxyUrl','rootFingerprint','runtimeBase','systemRoot'];
const RESULT_KEYS=['changed','integrity','ms','result','trigger'];
const SECRET_OUT='SYNTHETIC-R17-STDOUT-SECRET',SECRET_ERR='SYNTHETIC-R17-STDERR-SECRET',SECRET_MSG='SYNTHETIC-R17-LAUNCH-SECRET';
const RUN_RESULTS=['refreshed','unchanged','failed'];
const lc=value=>String(value).toLowerCase();

function api(){
  const m=require('../lib/grok-auth-refresh');
  assert.equal(typeof m.createGrokAuthRefresher,'function','createGrokAuthRefresher is exported');
  return m;
}

// ---------- synthetic owner home ----------
function ownerTree(t,{auth=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r17-refresh-'));
  const ownerHome=path.join(root,'home'),grok=path.join(ownerHome,'.grok');
  fs.mkdirSync(path.join(grok,'bin'),{recursive:true});fs.mkdirSync(path.join(grok,'downloads'));
  fs.writeFileSync(path.join(grok,'bin','grok.exe'),'synthetic');
  fs.writeFileSync(path.join(grok,'user-settings.json'),'{"synthetic":true}');
  const authFile=path.join(grok,'auth.json'),lockFile=path.join(grok,'auth.json.lock');
  if(auth){fs.writeFileSync(authFile,'{"synthetic":"credential-v1"}');fs.writeFileSync(lockFile,'');}
  const runtimeBase=path.join(ownerHome,'AppData','Local','ProjectHub');fs.mkdirSync(runtimeBase,{recursive:true});
  const savedProfile=process.env.USERPROFILE,savedHome=process.env.HOME;
  process.env.USERPROFILE=ownerHome;process.env.HOME=ownerHome;
  t.mock.method(os,'homedir',()=>ownerHome);
  let generation=1;
  const tree={root,ownerHome,grok,authFile,lockFile,runtimeBase,lastChange:0,
    setAge(ms){const at=new Date(Date.now()-ms);fs.utimesSync(authFile,at,at);fs.utimesSync(lockFile,at,at);return fs.lstatSync(authFile).mtimeMs;},
    // What Grok does on refresh: write auth.json.tmp.<n>, rename over auth.json, touch the lock.
    replaceAuth(){
      generation++;const temp=authFile+'.tmp.'+generation;
      guard.self++;try{fs.writeFileSync(temp,JSON.stringify({synthetic:'credential-v'+generation,pad:'x'.repeat(generation*11)}));fs.renameSync(temp,authFile);
        const now=new Date();fs.utimesSync(lockFile,now,now);}finally{guard.self--;}
      tree.lastChange=Date.now();
    },
    touchOther(){guard.self++;try{fs.appendFileSync(path.join(grok,'user-settings.json'),' ');fs.writeFileSync(path.join(grok,'planted.txt'),'x');}finally{guard.self--;}}
  };
  t.after(()=>{
    if(savedProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=savedProfile;
    if(savedHome===undefined)delete process.env.HOME;else process.env.HOME=savedHome;
    const actual=fs.realpathSync(root);
    assert.equal(lc(path.dirname(actual)),lc(fs.realpathSync(os.tmpdir())));
    assert.ok(path.basename(actual).startsWith('hub-r17-refresh-'));
    fs.rmSync(actual,{recursive:true,force:true});
  });
  return tree;
}

// ---------- fs trap: auth.json bytes are never opened or read ----------
const guard={self:0};
function trapAuthReads(t,tree){
  const hits=[],metadata=[];
  const name=p=>{try{const s=typeof p==='string'?p:Buffer.isBuffer(p)?p.toString():p instanceof URL?p.pathname:'';return s;}catch{return '';}};
  const isAuth=p=>lc(path.basename(name(p)))==='auth.json';
  const wrap=(obj,fn,list,label)=>{
    if(typeof obj[fn]!=='function')return;
    const original=obj[fn];
    t.mock.method(obj,fn,function(p,...rest){if(!guard.self&&isAuth(p))list.push(label+fn+':'+name(p));return original.call(this,p,...rest);});
  };
  for(const fn of ['readFile','readFileSync','open','openSync','createReadStream','copyFile','copyFileSync','cp','cpSync','openAsBlob'])wrap(fs,fn,hits,'fs.');
  for(const fn of ['readFile','open','copyFile','cp'])wrap(fs.promises,fn,hits,'fs.promises.');
  for(const fn of ['lstat','lstatSync','stat','statSync'])wrap(fs,fn,metadata,'fs.');
  for(const fn of ['lstat','stat'])wrap(fs.promises,fn,metadata,'fs.promises.');
  return {hits,metadata,assertClean(){
    assert.deepEqual(hits,[],'auth.json bytes were opened or read');
    for(const entry of metadata)assert.ok(lc(entry).includes(lc(tree.grok)),'metadata outside the synthetic home: '+entry);
  }};
}

// ---------- fake child, broker, launch ----------
function fakeChild({receipt='verified',chatter=true}={}){
  const c=new EventEmitter();
  Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),pid:4242,backendId:'synthetic-refresh',
    requiresCleanupReceipt:true,cleanupReceipt:null,exitCode:null,signalCode:null,kills:0,killedAt:null,closedAt:null,stdinBytes:0,stdinEndedAtKill:null});
  c.stdin.on('data',d=>{c.stdinBytes+=d.length;});
  c.kill=()=>{
    c.kills++;
    if(c.killedAt===null){
      c.killedAt=Date.now();c.stdinEndedAtKill=c.stdin.writableEnded;
      setTimeout(()=>{
        if(receipt==='verified')c.cleanupReceipt=Object.freeze({rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:1});
        else if(receipt==='unverified')c.cleanupReceipt=Object.freeze({rootExited:true,ownedTreeEmpty:false,cleanupVerified:false,exitCode:1});
        c.exitCode=1;c.stdout.end();c.stderr.end();c.closedAt=Date.now();c.emit('exit',1,null);c.emit('close',1,null);
      },5);
    }
    return true;
  };
  setImmediate(()=>c.emit('spawn'));
  if(chatter)setImmediate(()=>{
    c.stdout.write(SECRET_OUT+' access_token=synthetic\n');c.stderr.write(SECRET_ERR+' oidc refresh enter\n');
    c.stdout.write(Buffer.alloc(96*1024,0x41));c.stderr.write(Buffer.alloc(96*1024,0x42));
  });
  return c;
}

function harness(t,tree,{staleAfterMs,timeoutMs=4000,settleMs=500,now=()=>Date.now(),launchMode='ok',receipt='verified',
  brokerFails=false,profileFails=false,recordThrows=false,onLaunch=null,omitStale=false}={}){
  const calls={profile:[],identity:[],broker:[],launch:[],record:[],spawn:[],closes:0,children:[],brokers:[]};
  const consoleText=[];
  for(const level of ['log','info','warn','error','debug'])t.mock.method(console,level,(...args)=>{consoleText.push(args.map(String).join(' '));});
  const providerFile=path.join(tree.runtimeBase,'runtime-binaries','grok','d'.repeat(64),'grok.exe');
  const profileValue={ownerHome:tree.ownerHome,runtimeBase:tree.runtimeBase,providerFile,
    codexFile:path.join(tree.root,'tools','codex','codex.exe'),codexSHA256:'b'.repeat(64),nodeFile:process.execPath,
    gitDirectory:path.join(tree.root,'tools','git'),hubLibDirectory:path.join(tree.root,'tools','hub','lib'),
    systemRoot:process.env.SystemRoot||'C:\\Windows'};
  const options={
    profile:async(...args)=>{calls.profile.push(args);if(profileFails)throw Object.assign(Error(SECRET_MSG),{code:'NATIVE_PROFILE_UNAVAILABLE'});return {...profileValue};},
    identity:async(...args)=>{calls.identity.push(args);return Object.freeze({rootFingerprint:FP});},
    supervisedSpawn:(...args)=>{calls.spawn.push(args);throw Error('supervisedSpawn must not be called with a fake launch');},
    createBroker:async(...args)=>{
      calls.broker.push(args);
      if(brokerFails)throw Object.assign(Error(SECRET_MSG),{code:'NATIVE_BROKER_FAILED'});
      const broker={proxyUrl:PROXY,closed:0,closedAt:null,close:async()=>{broker.closed++;broker.closedAt=Date.now();calls.closes++;},
        snapshot:()=>({provider:'grok-auth',activeConnections:0,accepted:0,denied:0,totalBytes:0,closed:broker.closed>0})};
      calls.brokers.push(broker);return broker;
    },
    launch:(...args)=>{
      calls.launch.push({options:{...args[0]},rest:args.slice(1),at:Date.now()});
      if(launchMode==='throw')throw Object.assign(Error(SECRET_MSG),{code:'NATIVE_HASH_MISMATCH'});
      const child=fakeChild({receipt});calls.children.push(child);
      if(onLaunch)onLaunch(child);
      return child;
    },
    record:(...args)=>{calls.record.push(JSON.parse(JSON.stringify(args)));if(recordThrows)throw Error(SECRET_MSG);},
    now,timeoutMs,settleMs
  };
  if(!omitStale)options.staleAfterMs=staleAfterMs===undefined?60000:staleAfterMs;
  const refresher=api().createGrokAuthRefresher(options);
  assert.equal(typeof refresher.ensureFresh,'function');assert.equal(typeof refresher.refresh,'function');
  return {refresher,calls,consoleText,profileValue,
    assertQuiet(){
      const text=JSON.stringify(calls.record)+'\n'+consoleText.join('\n');
      for(const secret of [SECRET_OUT,SECRET_ERR,SECRET_MSG,'access_token','oidc refresh','credential-v'])assert.equal(text.includes(secret),false,'leaked: '+secret);
      assert.deepEqual(calls.spawn,[],'supervisedSpawn is reached only through launch');
    }};
}
// Grok's refresh as seen on disk: one replacement at +150 ms, another at +450 ms.
const refreshesTwice=tree=>()=>{setTimeout(()=>tree.replaceAuth(),150);setTimeout(()=>tree.replaceAuth(),450);};
function oneRecord(h){assert.equal(h.calls.record.length,1,'one record per run');const [name,scope,details]=h.calls.record[0];assert.equal(name,'grok-auth-refresh');assert.deepEqual(scope,{});return details;}

test('A4 ensureFresh: a recent auth.json is fresh and starts nothing',async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);tree.setAge(60000);
  const h=harness(t,tree,{staleAfterMs:3600000});
  assert.equal(await h.refresher.ensureFresh(),'fresh');
  assert.equal(h.calls.broker.length,0);assert.equal(h.calls.launch.length,0);
  trap.assertClean();h.assertQuiet();
});

test('A4 ensureFresh: a missing auth.json is missing and starts nothing',async t=>{
  const tree=ownerTree(t,{auth:false}),trap=trapAuthReads(t,tree);
  const h=harness(t,tree,{staleAfterMs:60000});
  assert.equal(await h.refresher.ensureFresh(),'missing');
  assert.equal(h.calls.broker.length,0);assert.equal(h.calls.launch.length,0);
  trap.assertClean();h.assertQuiet();
});

test('A4 ensureFresh: fresh strictly below staleAfterMs, refresh at exactly staleAfterMs (fake clock)',async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);const mtime=tree.setAge(10*60000);
  let clock=mtime+60000-1;
  const h=harness(t,tree,{staleAfterMs:60000,now:()=>clock,launchMode:'throw'});
  assert.equal(await h.refresher.ensureFresh(),'fresh');
  assert.equal(h.calls.broker.length,0);
  clock=mtime+60000;
  assert.equal(await h.refresher.ensureFresh(),'failed');
  assert.equal(h.calls.launch.length,1,'stale starts one refresh');
  const details=oneRecord(h);assert.equal(details.trigger,'stale');assert.equal(details.result,'failed');
  trap.assertClean();h.assertQuiet();
});

// Acceptance change: Grok refreshes only expired tokens (~6 h), so the default is five hours.
test('A4 staleAfterMs defaults to five hours',async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);const mtime=tree.setAge(5*3600000);
  const FOUR=5*3600000;let clock=mtime+FOUR-1;
  const h=harness(t,tree,{omitStale:true,now:()=>clock,launchMode:'throw'});
  assert.equal(await h.refresher.ensureFresh(),'fresh');
  assert.equal(h.calls.launch.length,0);
  clock=mtime+FOUR+1;
  assert.equal(await h.refresher.ensureFresh(),'failed');
  assert.equal(h.calls.launch.length,1);
  trap.assertClean();h.assertQuiet();
});

test('A4 stale -> refreshed: broker, profile, identity and launch shape; stops only after settle',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);tree.setAge(2*60000);
  const timeoutMs=5000,settleMs=600;
  const h=harness(t,tree,{staleAfterMs:60000,timeoutMs,settleMs,onLaunch:refreshesTwice(tree)});
  assert.equal(await h.refresher.ensureFresh(),'refreshed');
  // createBroker({provider:'grok-auth', maxWallMs: timeoutMs + 10000})
  assert.equal(h.calls.broker.length,1);
  // Acceptance change: an observe-only onAudit hook detects whether Grok contacts auth.x.ai.
  {const {onAudit,...rest}=h.calls.broker[0][0];assert.deepEqual(rest,{provider:'grok-auth',maxWallMs:timeoutMs+10000});assert.equal(typeof onAudit,'function');}
  assert.ok(h.calls.profile.length>=1);assert.ok(h.calls.profile.every(args=>args[0]==='grok'));
  const cwd=path.join(tree.runtimeBase,'runtime','grok-auth-refresh','cwd');
  assert.ok(h.calls.identity.some(args=>lc(args[0])===lc(cwd)),'identity of the refresh cwd');
  assert.equal(h.calls.launch.length,1);
  const launched=h.calls.launch[0].options;
  assert.deepEqual(Object.keys(launched).sort(),PLAN_KEYS);
  assert.equal(launched.proxyUrl,PROXY);assert.equal(launched.rootFingerprint,FP);
  for(const key of ['ownerHome','runtimeBase','providerFile','codexFile','codexSHA256','nodeFile','systemRoot'])
    assert.equal(launched[key],h.profileValue[key],key);
  const child=h.calls.children[0];
  assert.ok(child.kills>=1,'stopped with kill()');
  assert.equal(child.stdinBytes,0,'nothing written to stdin');
  assert.equal(child.stdinEndedAtKill,false,'stdin kept open until the stop');
  assert.ok(child.killedAt-tree.lastChange>=settleMs-100,'waited settleMs after the last change ('+(child.killedAt-tree.lastChange)+' ms)');
  assert.ok(child.killedAt-h.calls.launch[0].at<timeoutMs,'stopped before the timeout');
  assert.equal(child.stdout.readableLength,0,'stdout drained');assert.equal(child.stderr.readableLength,0,'stderr drained');
  const broker=h.calls.brokers[0];assert.ok(broker.closed>=1,'broker closed');assert.ok(broker.closedAt>=child.closedAt,'broker closed after the child closed');
  const details=oneRecord(h);
  assert.deepEqual(Object.keys(details).sort(),RESULT_KEYS);
  assert.equal(details.trigger,'stale');assert.equal(details.result,'refreshed');
  assert.equal(details.integrity,'ok');assert.deepEqual(details.changed,[]);
  assert.ok(Number.isFinite(details.ms)&&details.ms>=0);
  trap.assertClean();h.assertQuiet();
});

test('A4 refresh({trigger}) runs even when auth.json is recent and records that trigger',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);tree.setAge(1000);
  const h=harness(t,tree,{staleAfterMs:3600000,timeoutMs:4000,settleMs:300,onLaunch:()=>{setTimeout(()=>tree.replaceAuth(),100);}});
  assert.equal(await h.refresher.refresh({trigger:'auth-failure'}),'refreshed');
  const details=oneRecord(h);
  assert.deepEqual(details,{trigger:'auth-failure',result:'refreshed',ms:details.ms,integrity:'ok',changed:[]});
  trap.assertClean();h.assertQuiet();
});

test('A4 no change before timeoutMs -> unchanged, stopped at the timeout',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);tree.setAge(2*60000);
  const timeoutMs=1200;
  const h=harness(t,tree,{staleAfterMs:60000,timeoutMs,settleMs:300});
  assert.equal(await h.refresher.ensureFresh(),'unchanged');
  const child=h.calls.children[0];
  const ran=child.killedAt-h.calls.launch[0].at;
  assert.ok(ran>=timeoutMs-150&&ran<timeoutMs+3000,'stopped at timeoutMs ('+ran+' ms)');
  assert.equal(child.stdinBytes,0);
  assert.ok(h.calls.brokers[0].closed>=1);
  const details=oneRecord(h);
  assert.deepEqual(details,{trigger:'stale',result:'unchanged',ms:details.ms,integrity:'ok',changed:[]});
  trap.assertClean();h.assertQuiet();
});

test('A4 launch failure -> failed, broker closed, only a fixed code recorded',async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);
  const h=harness(t,tree,{launchMode:'throw'});
  assert.equal(await h.refresher.refresh({trigger:'auth-failure'}),'failed');
  assert.equal(h.calls.brokers.length,1);assert.ok(h.calls.brokers[0].closed>=1,'broker closed after launch failure');
  const details=oneRecord(h);
  assert.equal(details.trigger,'auth-failure');assert.equal(details.result,'failed');
  if(details.code!==undefined)assert.match(details.code,/^[A-Z][A-Z0-9_]{2,63}$/);
  for(const key of Object.keys(details))assert.ok(['trigger','result','ms','code','integrity','changed'].includes(key),'unexpected record field '+key);
  trap.assertClean();h.assertQuiet();
});

test('A4 broker or profile failure -> failed without launch, every created broker closed',async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);
  const broker=harness(t,tree,{brokerFails:true});
  assert.equal(await broker.refresher.refresh({trigger:'auth-failure'}),'failed');
  assert.equal(broker.calls.launch.length,0);
  assert.equal(oneRecord(broker).result,'failed');
  broker.assertQuiet();
  const profile=harness(t,tree,{profileFails:true});
  assert.equal(await profile.refresher.refresh({trigger:'auth-failure'}),'failed');
  assert.equal(profile.calls.launch.length,0);
  assert.ok(profile.calls.brokers.every(b=>b.closed>=1));
  profile.assertQuiet();
  trap.assertClean();
});

test('A4 missing or unverified cleanup receipt -> failed even though auth.json was replaced',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);
  for(const receipt of ['missing','unverified']){
    const h=harness(t,tree,{timeoutMs:3000,settleMs:300,receipt,onLaunch:()=>{setTimeout(()=>tree.replaceAuth(),100);}});
    assert.equal(await h.refresher.refresh({trigger:'auth-failure'}),'failed',receipt);
    assert.ok(h.calls.children[0].kills>=1);
    assert.ok(h.calls.brokers[0].closed>=1);
    const details=oneRecord(h);assert.equal(details.result,'failed');
    h.assertQuiet();
  }
  trap.assertClean();
});

test('A4 single-flight: concurrent callers share one run; a later call starts a new one',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);tree.setAge(2*60000);
  const h=harness(t,tree,{staleAfterMs:60000,timeoutMs:4000,settleMs:300,onLaunch:()=>{setTimeout(()=>tree.replaceAuth(),100);}});
  const results=await Promise.all([h.refresher.ensureFresh(),h.refresher.refresh({trigger:'auth-failure'}),
    h.refresher.refresh({trigger:'auth-failure'}),h.refresher.ensureFresh()]);
  assert.deepEqual(results,['refreshed','refreshed','refreshed','refreshed']);
  assert.equal(h.calls.broker.length,1);assert.equal(h.calls.launch.length,1);assert.equal(h.calls.record.length,1);
  assert.equal(await h.refresher.refresh({trigger:'auth-failure'}),'refreshed');
  assert.equal(h.calls.launch.length,2,'a call after the shared run finished starts a new run');
  trap.assertClean();h.assertQuiet();
});

test('A4 integrity: another .grok entry added or changed -> changed (names only); auth.json and lock ignored',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);
  const h=harness(t,tree,{timeoutMs:4000,settleMs:300,onLaunch:()=>{setTimeout(()=>{tree.replaceAuth();tree.touchOther();},100);}});
  assert.equal(await h.refresher.refresh({trigger:'auth-failure'}),'refreshed');
  const details=oneRecord(h);
  assert.equal(details.integrity,'changed');
  assert.deepEqual([...details.changed].sort(),['planted.txt','user-settings.json']);
  for(const name of details.changed)assert.equal(/[\\/]/.test(name),false,'names only');
  trap.assertClean();h.assertQuiet();
});

test('A4 integrity: a removed .grok entry is reported',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);
  const h=harness(t,tree,{timeoutMs:4000,settleMs:300,onLaunch:()=>{setTimeout(()=>{tree.replaceAuth();fs.rmSync(path.join(tree.grok,'user-settings.json'));},100);}});
  assert.equal(await h.refresher.refresh({trigger:'auth-failure'}),'refreshed');
  const details=oneRecord(h);
  assert.equal(details.integrity,'changed');assert.deepEqual(details.changed,['user-settings.json']);
  trap.assertClean();h.assertQuiet();
});

test('A4 errors never escape ensureFresh or refresh',{timeout:20000},async t=>{
  const tree=ownerTree(t),trap=trapAuthReads(t,tree);tree.setAge(2*60000);
  const thrown=harness(t,tree,{staleAfterMs:60000,timeoutMs:3000,settleMs:300,recordThrows:true,onLaunch:()=>{setTimeout(()=>tree.replaceAuth(),100);}});
  const result=await thrown.refresher.refresh({trigger:'auth-failure'});
  assert.ok(RUN_RESULTS.includes(result),String(result));
  const profile=harness(t,tree,{staleAfterMs:60000,profileFails:true});
  const ensured=await profile.refresher.ensureFresh();
  assert.ok(['fresh','missing',...RUN_RESULTS].includes(ensured),String(ensured));
  trap.assertClean();
});
