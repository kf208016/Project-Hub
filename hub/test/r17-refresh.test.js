'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {createGrokAuthRefresher,parseStaleAfterMs}=require('../lib/grok-auth-refresh');
const {createGrokAuthRefreshPlan,createPlan}=require('../lib/provider-native-plan');
const safe=require('../lib/safe-path');
const options={ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',
  providerFile:'C:\\Tools\\provider\\grok.exe',codexFile:'C:\\Tools\\codex\\codex.exe',nodeFile:'C:\\Tools\\node\\node.exe',
  codexSHA256:'a'.repeat(64),rootFingerprint:'b'.repeat(64),systemRoot:'C:\\Windows',proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:12345'};

test('R17 refresh egress allows exactly auth.x.ai:443 and preserves turn hosts',()=>{
  const {PROVIDER_HOSTS,parseAuthority}=require('../lib/provider-egress')._internal;
  assert.deepEqual(PROVIDER_HOSTS.grok,['api.x.ai','cli-chat-proxy.grok.com']);
  assert.deepEqual(PROVIDER_HOSTS.claude,['api.anthropic.com','claude.ai']);
  assert.deepEqual(PROVIDER_HOSTS['grok-auth'],['auth.x.ai']);
  assert.equal(parseAuthority('auth.x.ai:443',PROVIDER_HOSTS['grok-auth']),'auth.x.ai');
  for(const authority of ['api.x.ai:443','cli-chat-proxy.grok.com:443','auth.x.ai:80','auth.x.ai:444','auth.x.ai.evil.test:443','evil.auth.x.ai:443','127.0.0.1:443'])
    assert.equal(parseAuthority(authority,PROVIDER_HOSTS['grok-auth']),null);
});
test('R17 egress create admits the refresh provider with a fake listener and no network',async t=>{
  const http=require('node:http'),server=new EventEmitter();
  server.listen=(port,host,ready)=>{assert.equal(port,0);assert.equal(host,'127.0.0.1');ready();};
  server.address=()=>({port:12345});server.close=done=>done();
  t.mock.method(http,'createServer',()=>server);
  const broker=await require('../lib/provider-egress').create({provider:'grok-auth',maxWallMs:30000});
  assert.equal(broker.snapshot().provider,'grok-auth');await broker.close();assert.equal(broker.snapshot().closed,true);
});
test('R17 refresh plan has only the eight exact grants, wrapper, argv and turn environment except PATH',()=>{
  const p=createGrokAuthRefreshPlan(options),base=options.runtimeBase+'\\runtime\\grok-auth-refresh',tree=options.ownerHome+'\\.grok';
  assert.equal(p.runtimeDirectory,base);assert.equal(p.cwd,base+'\\cwd');assert.equal(p.tempDirectory,base+'\\tmp');assert.equal(p.providerHome,base+'\\grok');
  assert.deepEqual(p.credentialFiles,[tree+'\\auth.json']);assert.equal(p.lockFile,tree+'\\auth.json.lock');
  assert.deepEqual(p.dirPin,{root:p.cwd,rootFingerprint:options.rootFingerprint});
  assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.args)&&Object.isFrozen(p.env)&&Object.isFrozen(p.credentialFiles));
  const grants=Object.fromEntries([...p.args[7].matchAll(/("(?:[^"\\]|\\.)*")="(read|write)"/g)].map(m=>[JSON.parse(m[1]),m[2]]));
  assert.deepEqual(grants,{':minimal':'read',[path.win32.dirname(options.providerFile)]:'read',[p.cwd]:'write',[p.tempDirectory]:'write',
    [p.providerHome]:'write',[tree]:'write',[tree+'\\bin']:'read',[tree+'\\downloads']:'read'});
  assert.deepEqual(p.args.slice(-5),['--',options.providerFile,'agent','--no-leader','stdio']);
  assert.ok(!p.args.includes('--tools'));
  const turn=createPlan({...options,actor:'grok',cwd:'C:\\Workspace\\project',gitDirectory:'C:\\Tools\\git',hubLibDirectory:'C:\\Tools\\hub\\lib',providerArgs:[]});
  assert.deepEqual(p.args.slice(8,p.args.indexOf('--')),turn.args.slice(8,turn.args.indexOf('--')));
  const turnEnv={...turn.env};delete turnEnv.GROK_AUTH_PROVIDER_COMMAND;delete turnEnv.HUB_NODE;turnEnv.GROK_AUTH_PATH=p.credentialFiles[0];
  assert.deepEqual(p.env,{...turnEnv,HOME:p.providerHome,APPDATA:p.providerHome,LOCALAPPDATA:p.providerHome,GROK_HOME:p.providerHome,
    TEMP:p.tempDirectory,TMP:p.tempDirectory,PATH:'C:\\Windows\\System32'});
  assert.equal(turn.args[7].includes(JSON.stringify(tree+'\\auth.json')+'="read"'),false);
  // SHA-256 of JSON.stringify(createPlan(...)) with R25 provider-home credentials and R26 provider command/PATH.
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(turn)).digest('hex'),
    '2282b03eb0093b0eb40e80eb46eaf9435cb910dfae4bec886a3dfed255bd3817');
});
test('R17 refresh plan rejects missing, extra, accessor, malformed and overlapping inputs',()=>{
  for(const key of Object.keys(options)){const o={...options};delete o[key];assert.throws(()=>createGrokAuthRefreshPlan(o),{code:'NATIVE_PLAN_INVALID'});}
  for(const extra of [{actor:'grok'},{providerArgs:[]},{cwd:'C:\\Workspace'},{[Symbol('hidden')]:1}])assert.throws(()=>createGrokAuthRefreshPlan({...options,...extra}));
  let called=false;assert.throws(()=>createGrokAuthRefreshPlan({...options,get ownerHome(){called=true;return options.ownerHome;}}));assert.equal(called,false);
  for(const overrides of [{rootFingerprint:'x'},{codexSHA256:'A'.repeat(64)},{proxyUrl:'http://example.com:443'},
    {ownerHome:'C:\\'},{runtimeBase:'C:\\Wide'},{providerFile:options.runtimeBase+'\\runtime\\grok-auth-refresh\\cwd\\grok.exe'},
    {providerFile:'C:\\grok.exe'},{nodeFile:options.ownerHome+'\\.grok\\node.exe'},{systemRoot:options.runtimeBase}])
    assert.throws(()=>createGrokAuthRefreshPlan({...options,...overrides}));
});
test('R17 stale env parsing accepts only integer milliseconds in the approved range',()=>{
  for(const v of ['60000','14400000','21600000'])assert.equal(parseStaleAfterMs(v),Number(v));
  for(const v of [undefined,null,60000,'',' 60000','60000 ','60000.0','6e4','-60000','59999','21600001','Infinity','x'])assert.equal(parseStaleAfterMs(v),18000000);
});

function fixture(t,changes={}){
  let clock=1000000,launches=0,brokers=0,closes=0,kills=0,writes=0;
  const records=[],nodes=new Map();
  const stat=(mtimeMs=0)=>({size:100,mtimeMs,birthtimeMs:mtimeMs,ino:1,dev:1,isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>false});
  nodes.set('auth.json',stat());nodes.set('auth.json.lock',stat());nodes.set('bin',stat());
  t.mock.method(os,'homedir',()=>options.ownerHome);t.mock.method(safe,'localPath',p=>p);
  t.mock.method(fs,'mkdirSync',()=>{});
  t.mock.method(fs,'readdirSync',()=>[...nodes.keys()]);
  t.mock.method(fs,'lstatSync',file=>{const s=nodes.get(path.basename(file));if(!s)throw Object.assign(Error('missing'),{code:'ENOENT'});return s;});
  for(const name of ['open','openSync','readFile','readFileSync']){
    const original=fs[name];t.mock.method(fs,name,(file,...args)=>{assert.ok(!String(file).endsWith('auth.json'),'credential contents forbidden');return original(file,...args);});
  }
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();
  c.stdin.on('data',()=>writes++);
  c.kill=()=>{kills++;if(changes.noClose)return;if(!changes.noReceipt)c.cleanupReceipt={cleanupVerified:true,rootExited:true,ownedTreeEmpty:true,exitCode:0,...changes.receipt};c.emit('close',0);};
  const refresher=createGrokAuthRefresher({profile:async actor=>{assert.equal(actor,'grok');return {...options,gitDirectory:'ignored',hubLibDirectory:'ignored'};},
    identity:async cwd=>{assert.equal(cwd,options.runtimeBase+'\\runtime\\grok-auth-refresh\\cwd');return {rootFingerprint:options.rootFingerprint};},
    supervisedSpawn:()=>assert.fail('must not spawn'),createBroker:async o=>{brokers++;const {onAudit,...rest}=o;assert.deepEqual(rest,{provider:'grok-auth',maxWallMs:11000});assert.equal(typeof onAudit,'function');if(changes.brokerFail)throw Error('PRIVATE');return {proxyUrl:options.proxyUrl,close:async()=>{closes++;if(changes.closeFail)throw Error('PRIVATE');}};},
    launch:o=>{launches++;assert.deepEqual(o,options);if(changes.launchFail)throw Error('PRIVATE');return c;},
    record:(...r)=>records.push(r),now:()=>clock,staleAfterMs:60000,timeoutMs:1000,settleMs:200});
  async function tick(ms){await new Promise(r=>setImmediate(r));clock+=ms;t.mock.timers.tick(ms);await new Promise(r=>setImmediate(r));}
  t.after(()=>{c.stdin.destroy();c.stdout.destroy();c.stderr.destroy();});
  return {refresher,c,nodes,records,stat,tick,counts:()=>({launches,brokers,closes,kills,writes})};
}
test('R17 missing and fresh credentials need no broker or launch',async t=>{
  const f=fixture(t);f.nodes.delete('auth.json');assert.equal(await f.refresher.ensureFresh(),'missing');
  f.nodes.set('auth.json',f.stat(999999));assert.equal(await f.refresher.ensureFresh(),'fresh');assert.equal(f.counts().brokers,0);
});
test('R17 stale refresh is single-flight, waits for stable metadata, drains secrets, and verifies cleanup',async t=>{
  const f=fixture(t),a=f.refresher.ensureFresh(),b=f.refresher.refresh({trigger:'stale'}),c=f.refresher.refresh({trigger:'auth-failure'});assert.equal(b,c);
  await f.tick(0);f.c.stdout.write('PRIVATE_STDOUT');f.c.stderr.write('PRIVATE_STDERR');
  f.nodes.set('auth.json',{...f.stat(1000000),ino:2});await f.tick(200);assert.equal(f.counts().kills,0);
  f.nodes.set('auth.json',{...f.stat(1000200),ino:3});await f.tick(200);assert.equal(f.counts().kills,0);
  await f.tick(200);assert.deepEqual(await Promise.all([a,b,c]),['refreshed','refreshed','refreshed']);
  assert.deepEqual(f.counts(),{launches:1,brokers:1,closes:1,kills:1,writes:0});
  assert.equal(f.c.stdin.writableEnded,false);assert.equal(f.records.length,1);
  assert.deepEqual(f.records[0],['grok-auth-refresh',{}, {trigger:'stale',result:'refreshed',ms:600,integrity:'ok',changed:[]}]);
  assert.doesNotMatch(JSON.stringify(f.records),/PRIVATE/);
});
test('R17 timeout without replacement is unchanged; later calls can run again',async t=>{
  const f=fixture(t),p=f.refresher.refresh({trigger:'auth-failure'});await f.tick(1000);assert.equal(await p,'unchanged');
  assert.equal(f.records[0][2].trigger,'auth-failure');const q=f.refresher.refresh({trigger:'stale'});await f.tick(1000);assert.equal(await q,'unchanged');assert.equal(f.counts().launches,2);
});
for(const mode of ['launchFail','brokerFail','noReceipt','closeFail','noClose','receipt'])test('R17 '+mode+' returns failed with fixed code only',async t=>{
  const f=fixture(t,{[mode]:mode==='receipt'?{exitCode:1}:true}),p=f.refresher.refresh({trigger:'stale'});
  await f.tick(1000);if(mode==='noClose')await f.tick(5000);
  assert.equal(await p,'failed');assert.match(f.records[0][2].code,/^NATIVE_[A-Z_]+$/);assert.doesNotMatch(JSON.stringify(f.records),/PRIVATE/);
  assert.equal(f.counts().closes,mode==='brokerFail'?0:1);
});
test('R17 integrity warning contains only sorted changed entry names',async t=>{
  const f=fixture(t),p=f.refresher.refresh({trigger:'stale'});await f.tick(0);
  f.nodes.set('auth.json',f.stat(1000000));f.nodes.set('auth.json.lock',f.stat(1000000));f.nodes.delete('bin');f.nodes.set('extra',f.stat());
  await f.tick(200);await f.tick(200);assert.equal(await p,'refreshed');
  assert.deepEqual(f.records[0][2].changed,['bin','extra']);assert.equal(f.records[0][2].integrity,'changed');
});
test('R17 malformed metadata and excessive output fail without leaking content',async t=>{
  const f=fixture(t);f.nodes.set('auth.json',{...f.stat(),isFile:()=>false});assert.equal(await f.refresher.ensureFresh(),'failed');
  f.nodes.set('auth.json',f.stat());const p=f.refresher.refresh({trigger:'stale'});await f.tick(0);
  f.c.stdout.write(Buffer.alloc(4*1024*1024+1,65));await f.tick(0);assert.equal(await p,'failed');assert.equal(f.counts().kills,1);
});

test('R17 server retry calls full prepare only after refreshed, handles stop and throws',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.equal((source.match(/process\.env\.PROJECT_HUB_GROK_AUTH_STALE_MS/g)||[]).length,1);
  const body=source.slice(source.indexOf('  nativeAuthRetry:async o=>{')+'  nativeAuthRetry:'.length,source.indexOf('  delegates: (p, t) =>')).trim().replace(/,$/,'');
  for(const result of ['refreshed','unchanged','failed','throw','stopped']){
    const order=[],run={stopped:false};
    const retry=vm.runInNewContext('('+body+')',{grokAuthRefresher:{refresh:async o=>{assert.equal(o.trigger,'auth-failure');order.push('refresh');if(result==='throw')throw Error('PRIVATE');if(result==='stopped')run.stopped=true;return result==='stopped'?'refreshed':result;}},
      chats:{busy:()=>run},prepareNativeProviderTurn:async()=>order.push('prepare'),nativeProviderService:{withGrokPreparation:action=>action(),cancel:async()=>order.push('cancel')}});
    assert.equal(await retry({ai:'grok'}),result==='refreshed');assert.deepEqual(order,result==='refreshed'?['refresh','prepare']:['refresh']);
  }
});
