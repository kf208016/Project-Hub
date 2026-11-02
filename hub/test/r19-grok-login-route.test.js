'use strict';
// Same source-slice VM harness as grok-preview-http, with in-memory req/res:
// no server import, listeners, credentials or provider processes.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const filename=path.join(__dirname,'../server.js'),source=fs.readFileSync(filename,'utf8');
function fixture({remote=false,dry=false,owner=true,error=null,badJson=false}={}){
  const guard=source.split('\n').find(line=>line.includes("fromRemote()&&['/api/quit'"));
  const begin=source.indexOf("  if(url.pathname==='/api/grok/login-window'){"),end=source.indexOf('  // Mac ',begin);assert.ok(guard&&begin>0&&end>begin);
  const calls=[];const state={running:false,login:{state:'missing'}};
  const context=vm.createContext({require:createRequire(filename),process:{platform:'win32'},DRY:dry,fromRemote:()=>remote,localOwner:()=>owner&&!remote,readSmallJson:async req=>{if(badJson)throw Error('private invalid body');return req.body;},
    grokLoginWindow:{start:async mode=>{calls.push(mode);if(error)throw error;state.running=true;},state:()=>state},send:(_res,status,data)=>({status,data})});
  const handler=vm.runInContext('(async(req,res,url)=>{'+guard+'\n'+source.slice(begin,end)+'})',context);
  return {calls,request:(method='POST',body={mode:'refresh'})=>handler({method,body},{},{pathname:'/api/grok/login-window'})};
}
test('R19 remote POST returns 403 before DRY and never starts; remote GET is readable',async()=>{
  for(const dry of [false,true]){const f=fixture({remote:true,dry});assert.equal((await f.request()).status,403);assert.equal(f.calls.length,0);assert.equal((await f.request('GET')).status,200);}
});
test('R19 local DRY POST returns only dry true without spawning',async()=>{
  const f=fixture({dry:true});const r=await f.request();assert.equal(r.status,200);assert.equal(JSON.stringify(r.data),'{"dry":true}');assert.equal(f.calls.length,0);
});
test('R19 route forwards mode, returns state and uses bounded native error JSON',async()=>{
  const f=fixture();assert.equal((await f.request('POST',{mode:'device'})).data.running,true);assert.deepEqual(f.calls,['device']);
  for(const [code,status]of [['GROK_LOGIN_WINDOW_OPEN',409],['GROK_LOGIN_TURN_ACTIVE',409],['GROK_LOGIN_UNAVAILABLE',400]]){
    const g=fixture({error:Object.assign(Error('private'),{code,status})}),r=await g.request();assert.equal(r.status,status);assert.equal(r.data.code,code);assert.equal(r.data.error,require('../lib/native-provider-messages').messageFor(code));assert.doesNotMatch(JSON.stringify(r.data),/private/);
  }
  assert.equal((await fixture({owner:false}).request()).status,403);
});
test('R19 invalid JSON is 400 and never reaches the launcher',async()=>{
  const f=fixture({badJson:true}),r=await f.request();assert.equal(r.status,400);assert.equal(r.data.code,'GROK_LOGIN_UNAVAILABLE');assert.equal(f.calls.length,0);assert.doesNotMatch(r.data.error,/private/);
});
test('R19 production owner window uses existing binary review, Grok running state and tree kill argv',async()=>{
  const start=source.indexOf('const grokLoginWindow='),end=source.indexOf('const grokHydrator=',start),calls=[],home='C:\\Users\\Synthetic',file=home+'\\AppData\\Local\\ProjectHub\\runtime-binaries\\hash\\grok.exe';let options;
  const running=new Map(),spawns=[];
  const modules={
    './lib/grok-login-window':{createGrokLoginWindow:o=>{options=o;return {}; }},
    'node:child_process':{spawn:(...args)=>{spawns.push(args);return {on(){}};}},
    './lib/scoped-file':{identity:()=>({rootFingerprint:'synthetic'})},
    './lib/native-runtime-base':{resolve:async(h,o)=>{assert.equal(h,home);assert.equal(typeof o.identity,'function');return {physicalBase:home+'\\AppData\\Local\\ProjectHub'};}},
    './lib/native-provider-binary':{grokFile:async(h,base,o)=>{calls.push([h,base]);assert.equal(typeof o.identity,'function');return file;}},
    './lib/native-cli-update':{digestFile:p=>{assert.equal(p,file);return 'reviewed-digest';}},
    './lib/provider-native-host':{reviewedProvider:(actor,digest)=>{assert.equal(actor,'grok');assert.equal(digest,'reviewed-digest');return {hash:digest};}}
  };
  vm.runInNewContext(source.slice(source.indexOf('async function resolveReviewedGrok()'),source.indexOf('const {createGrokAuthRefresher'))+source.slice(start,end),{require:name=>modules[name],process:{platform:'win32',env:{USERPROFILE:home,HUB_AI_HOME:'C:\\Different'}},os:{homedir:()=>home},chats:{running},record:()=>{}});
  assert.equal(options.home,home);assert.equal(await options.resolveGrok(),file);assert.equal(calls.length,1);
  assert.equal(options.isGrokTurnActive(),false);running.set('c',{ai:'claude'});assert.equal(options.isGrokTurnActive(),false);running.set('g',{ai:'grok',pending:true});assert.equal(options.isGrokTurnActive(),true);
  options.kill(123);assert.equal(JSON.stringify(spawns),JSON.stringify([['C:\\Windows\\System32\\taskkill.exe',['/PID','123','/T','/F'],{windowsHide:true,stdio:'ignore'}]]));
  modules['./lib/provider-native-host'].reviewedProvider=()=>null;await assert.rejects(options.resolveGrok(),/GROK_LOGIN_UNAVAILABLE/);
  assert.match(source,/shutdown\.running=true;grokLoginWindow\?\.dispose\(\)/);
});
