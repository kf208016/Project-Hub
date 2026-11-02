'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
test('server wires reviewed resolver, hydrator, per-run route, exact expiry and shutdown',()=>{
  for(const text of ['async function resolveReviewedGrok()', 'createGrokHydrator(', 'hydrateGrok:', "require('./lib/grok-auth-route')",'/api/native/grok-token','expiry:', 'grokHydrator?.dispose()', 'owned?.grokAuthRoute?.close()'])assert.ok(source.includes(text),text);
  assert.equal((source.match(/resolveGrok:resolveReviewedGrok/g)||[]).length,2);
  const hydrator=source.slice(source.indexOf('const grokHydrator='),source.indexOf('const ownerToken='));
  assert.ok(hydrator.includes("systemRoot:process.env.SystemRoot || 'C:\\\\Windows'"));
  assert.ok(source.includes("path.join(runtimeBase,'runtime',binding.rootFingerprint,'grok','grok')"));
  assert.ok(source.includes("fs.openSync(routeFile,'wx',0o600)"));
  assert.ok(source.includes('stat.size>1024'));assert.ok(source.includes('!==owned.routeSHA256'));
});
test('nativeAuthRetry block remains byte-identical to candidate 25',()=>{
  const previous=execFileSync('git',['show','HEAD:hub/server.js'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'});
  const block=s=>s.slice(s.indexOf('  nativeAuthRetry:async o=>{'),s.indexOf('  delegates: (p, t) =>'));
  assert.ok(block(previous).length>300);assert.equal(block(source),block(previous));
});
test('hydration error has the same actionable message in UI and diagnostic boundary',()=>{
  const code='GROK_LOGIN_HYDRATE_FAILED',messages=require('../lib/native-provider-messages');
  const ui=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const library=fs.readFileSync(path.join(__dirname,'../lib/native-provider-messages.js'),'utf8');
  const message=library.match(/GROK_LOGIN_HYDRATE_FAILED:'([^']+)'/)[1];
  assert.ok(ui.includes(message));assert.ok(ui.includes("if(!['"+code+"'"));assert.ok(fs.readFileSync(path.join(__dirname,'../lib/native-provider-diagnostic.js'),'utf8').includes(code));
  assert.equal(message,'Hub 無法在回合前把 Grok 登入交給沙箱（灌入失敗），這則訊息沒有送出。請按「更新 Grok 登入」，若還是不行請按「登入 Grok」，完成後再送一次。');
});
test('server mint refreshes rejected or near-expiry tokens and returns current token after busy/failed refresh',async()=>{
  const start=source.indexOf('const grokTokenMint='),end=source.indexOf('const nativeProviderOptions=',start);
  for(const mode of ['fresh','near','expired','busy','failed']){
    let time=100000,calls=0,reads=0,expiresAt=time+(mode==='near'?299999:600000);
    const context=vm.createContext({Date:{now:()=>time},os:{homedir:()=> 'C:\\SyntheticOwner'},
      ownerToken:{readOwnerToken:({home})=>{assert.equal(home,'C:\\SyntheticOwner');reads++;return {key:'synthetic-access',expiresAt};}},
      grokLoginWindow:{autoRefresh:async()=>{calls++;if(!['busy','failed'].includes(mode))expiresAt=time+600000;return {outcome:mode==='busy'?'busy':mode==='failed'?'failed':'refreshed'};}}});
    vm.runInContext(source.slice(start,end)+'globalThis.mint=grokTokenMint;',context);
    const value=await context.mint({expired:['expired','busy','failed'].includes(mode)});
    assert.equal(JSON.stringify(value),'{"access_token":"synthetic-access","expires_in":540}');
    assert.equal(calls,mode==='fresh'?0:1);assert.equal(reads,mode==='near'?2:1);
  }
});
test('server route disposal closes first and deletes only matching regular bounded single-link file',async()=>{
  const start=source.indexOf('async function nativeProviderDispose('),end=source.indexOf('// A bearer',start);
  for(const mode of ['valid','changed','symlink','hardlink','oversize']){
    const bytes=Buffer.from('{"synthetic":true}'),events=[];
    const owned={routeFile:'C:\\Synthetic\\route.json',routeSHA256:crypto.createHash('sha256').update(bytes).digest('hex'),grokAuthRoute:{close:()=>events.push('close')}};
    const resources=new Map([['synthetic-run',owned]]);
    const context=vm.createContext({crypto,nativeProviderResources:resources,commandIntents:null,mcpCapabilities:{revokeRun:()=>events.push('revoke')},
      require:name=>{assert.equal(name,'./lib/safe-path');return {localPath:()=>{}};},
      fs:{lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>mode==='symlink',nlink:mode==='hardlink'?2:1,size:mode==='oversize'?1025:bytes.length}),readFileSync:()=>mode==='changed'?Buffer.from('changed'):bytes,unlinkSync:()=>events.push('unlink')}});
    vm.runInContext(source.slice(start,end),context);
    if(mode==='valid'){await context.nativeProviderDispose({runId:'synthetic-run'});assert.equal(resources.size,0);assert.deepEqual(events,['revoke','close','unlink']);}
    else{await assert.rejects(context.nativeProviderDispose({runId:'synthetic-run'}));assert.equal(resources.size,1);assert.deepEqual(events,['revoke','close']);}
  }
});
test('server HTTP composition binds the run scope, routes exact token POST and keeps MCP fallback',()=>{
  const start=source.indexOf('  httpFor:context=>{'),end=source.indexOf('  toolPolicyFor:',start);
  const events=[],owned={actor:'grok',project:'p',task:'t',grokAuthRoute:{handle:()=>events.push('token')},mcpProxy:{handle:()=>events.push('mcp')}};
  const context=vm.createContext({PORT:12345,nativeProviderResources:new Map([['run',owned]])});
  vm.runInContext('globalThis.options={'+source.slice(start,end)+'};',context);
  assert.equal(context.options.httpFor({runId:'run',actor:'grok',project:'p',task:'other'}),null);
  const handler=context.options.httpFor({runId:'run',actor:'grok',project:'p',task:'t'});
  for(const req of [{method:'POST',url:'http://127.0.0.1:12345/api/native/grok-token'},{method:'GET',url:'http://127.0.0.1:12345/api/native/grok-token'},{method:'POST',url:'http://127.0.0.1:12345/api/mcp/call'}])handler(req,{});
  assert.deepEqual(events,['token','mcp','mcp']);
  owned.actor='claude';assert.equal(context.options.httpFor({runId:'run',actor:'claude',project:'p',task:'t'}),owned.mcpProxy.handle);
});
