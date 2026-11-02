'use strict';
// R17 acceptance: Grok refreshes only an expired token, so a refresh run that sees no
// auth.x.ai connection ends early and later stale checks are skipped for a while.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {createGrokAuthRefresher,parseStaleAfterMs}=require('../lib/grok-auth-refresh');
const safe=require('../lib/safe-path');
const options={ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',
  providerFile:'C:\\Tools\\provider\\grok.exe',codexFile:'C:\\Tools\\codex\\codex.exe',nodeFile:'C:\\Tools\\node\\node.exe',
  codexSHA256:'a'.repeat(64),rootFingerprint:'b'.repeat(64),systemRoot:'C:\\Windows',proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:12345'};

function fixture(t,{connect=false}={}){
  let clock=1000000,launches=0,kills=0,audit=null;
  const records=[],nodes=new Map();
  const stat=(mtimeMs=0)=>({size:100,mtimeMs,birthtimeMs:mtimeMs,ino:1,dev:1,isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>false});
  nodes.set('auth.json',stat());nodes.set('auth.json.lock',stat());
  t.mock.method(os,'homedir',()=>options.ownerHome);t.mock.method(safe,'localPath',p=>p);
  t.mock.method(fs,'mkdirSync',()=>{});t.mock.method(fs,'readdirSync',()=>[...nodes.keys()]);
  t.mock.method(fs,'lstatSync',file=>{const s=nodes.get(path.basename(file));if(!s)throw Object.assign(Error('missing'),{code:'ENOENT'});return s;});
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const child=()=>{const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();
    c.kill=()=>{kills++;c.cleanupReceipt={cleanupVerified:true,rootExited:true,ownedTreeEmpty:true,exitCode:0};c.emit('close',0);};
    t.after(()=>{c.stdin.destroy();c.stdout.destroy();c.stderr.destroy();});return c;};
  const refresher=createGrokAuthRefresher({profile:async()=>({...options}),identity:async()=>({rootFingerprint:options.rootFingerprint}),
    supervisedSpawn:()=>assert.fail('must not spawn'),
    createBroker:async o=>{audit=o.onAudit;return {proxyUrl:options.proxyUrl,close:async()=>{}};},
    launch:()=>{launches++;if(connect)assert.equal(audit({event:'accepted-connect',provider:'grok-auth',code:'ok',hostname:'auth.x.ai'}),true);return child();},
    record:(...r)=>records.push(r),now:()=>clock,staleAfterMs:60000,timeoutMs:20000,settleMs:200,quietMs:1000,quietWindowMs:900000});
  const tick=async ms=>{await new Promise(r=>setImmediate(r));clock+=ms;t.mock.timers.tick(ms);await new Promise(r=>setImmediate(r));};
  return {refresher,nodes,records,tick,setClock:v=>{clock=v;},counts:()=>({launches,kills})};
}

test('R17 default stale threshold is five hours',()=>{
  assert.equal(parseStaleAfterMs(undefined),18000000);assert.equal(parseStaleAfterMs('60000'),60000);
});
test('R17 a quiet start (no auth.x.ai connection, no change) ends at quietMs, not timeoutMs',async t=>{
  const f=fixture(t),p=f.refresher.refresh({trigger:'stale'});
  await f.tick(0);await f.tick(800);assert.equal(f.counts().kills,0);
  await f.tick(400);assert.equal(await p,'unchanged');assert.equal(f.counts().kills,1);
  assert.deepEqual(f.records[0][2],{trigger:'stale',result:'unchanged',ms:1200,integrity:'ok',changed:[],quiet:true});
});
test('R17 a quiet result skips stale checks for the quiet window; auth-failure still refreshes',async t=>{
  const f=fixture(t),p=f.refresher.ensureFresh();await f.tick(0);await f.tick(1200);assert.equal(await p,'unchanged');
  assert.equal(await f.refresher.ensureFresh(),'fresh');assert.equal(f.counts().launches,1);
  const q=f.refresher.refresh({trigger:'auth-failure'});await f.tick(0);await f.tick(1200);assert.equal(await q,'unchanged');assert.equal(f.counts().launches,2);
  f.setClock(1000000+2400+900000);const r=f.refresher.ensureFresh();await f.tick(0);await f.tick(1200);assert.equal(await r,'unchanged');assert.equal(f.counts().launches,3);
});
test('R17 an auth.x.ai connection keeps waiting past quietMs for the replacement',async t=>{
  const f=fixture(t,{connect:true}),p=f.refresher.refresh({trigger:'stale'});
  await f.tick(0);await f.tick(1500);assert.equal(f.counts().kills,0);
  f.nodes.set('auth.json',{...f.nodes.get('auth.json'),mtimeMs:5,birthtimeMs:5,ino:2});await f.tick(200);await f.tick(200);
  assert.equal(await p,'refreshed');assert.equal(f.records[0][2].quiet,undefined);
});
