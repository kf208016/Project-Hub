'use strict';
// Local HTTP and synthetic catalog only. No provider process or credentials.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const win=process.platform==='win32'?test:test.skip;
win('Windows dry startup, throttled cache reread, refresh API and fallback picker',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-grok-models-')),home=path.join(root,'home'),dir=path.join(home,'.grok'),file=path.join(dir,'models_cache.json');
 fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(root,'_hub'));
 fs.writeFileSync(path.join(root,'_hub/roles.yaml'),'models:\n  grok: [Grok 4.6, Stale]\nroles:\n  saved: { main: [grok, Grok 4.6, 高], backup: [人] }\n');
 const models=[['grok-4.7','Grok 4.7'],['grok-4.7-fast','Grok 4.7 Fast'],['grok-4.6','Grok 4.6'],['grok-4.5','Grok 4.5']];
 const secret='SYNTHETIC_GROK_HTTP_SECRET';
 const write=(rows,time)=>{fs.writeFileSync(file,JSON.stringify({identity:secret,auth_method:secret,etag:secret,models:Object.fromEntries([...rows.map(([id,name])=>[id,{info:{id,name,hidden:false,supports_reasoning_effort:true,reasoning_efforts:(id==='grok-4.5'?['low','medium','high']:['low','medium','high','xhigh']).map(value=>({value}))},api_key:secret,env_key:secret,api_base_url:secret}]),['hidden',{info:{id:'hidden',hidden:true},api_key:secret}]])}));fs.utimesSync(file,time,time);};write(models,1000);
 const listener=require('node:net').createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const env={...process.env};Object.assign(process.env,{HUB_ROOT:root,HUB_AI_HOME:home,HUB_DRY_RUN:'1',HUB_PORT:String(port)});
 const fixture=require('./helpers/owned-native-fixture'),restore=fixture.freshInventory();process.env.PATH=fixture.environment(fixture.provider(root).bin);
 const {AiTools}=require('../lib/ai-tools'),launch=require('../lib/launch'),originalRead=fs.readFileSync;let reads=0,now=Date.now();
 t.mock.method(Date,'now',()=>now);
 t.mock.method(AiTools.prototype,'fetchModels',()=>assert.fail('Live refresh forbidden'));
 // This HTTP test exercises catalog behavior, not the native data-root HANDLE gate.
 t.mock.method(require('../lib/web-chat-admission'),'check',()=>({ok:true}));
 t.mock.method(fs,'readFileSync',(name,...args)=>{if(name===file)reads++;assert.equal(String(name).endsWith('auth.json'),false);return originalRead(name,...args);});
 const {server}=require('../server');await new Promise(r=>server.listen(Number(process.env.HUB_PORT),'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));restore();for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);fs.rmSync(root,{recursive:true,force:true});});
 const state=async()=>{const response=await fetch(base+'/api/state'),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(JSON.stringify(data).includes(secret),false);return data;};
 const refresh=()=>fetch(base+'/api/ai-tools/models/refresh',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({ai:'grok'})});
 assert.deepEqual((await state()).roles.models['grok'],['CLI預設',...models.map(row=>row[1])]);assert.equal(reads,1);
 const toolsResponse=await fetch(base+'/api/ai-tools'),toolsData=await toolsResponse.json();assert.equal(toolsResponse.status,200);assert.equal(JSON.stringify(toolsData).includes(secret),false);assert.equal(toolsData.tools.grok.modelRefreshAvailable,true);
 for(const [label,id] of [['Grok 4.6','grok-4.6'],...models.map(([id,label])=>[label,id])])assert.equal(launch.flagFor('grok',label),id);
 assert.equal(launch.flagFor('grok','unknown'),'');assert.equal(launch.flagFor('grok','CLI預設'),'');
 write([['grok-new-1','New']],2000);await state();assert.equal(reads,1);
 now+=30001;assert.deepEqual((await state()).roles.models['grok'],['CLI預設','New']);assert.equal(reads,2);
 now+=30001;await state();assert.equal(reads,2,'unchanged mtime is stat only');
 write(models,3000);const response=await refresh();assert.equal(response.status,200);assert.equal((await response.json()).source,'local-cache');
 assert.deepEqual((await state()).roles.models['grok'],['CLI預設',...models.map(row=>row[1])]);
 fs.writeFileSync(file,'broken');const bad=await refresh();assert.equal(bad.status,502);assert.equal((await bad.json()).stage,'models');assert.deepEqual((await state()).roles.models['grok'],['CLI預設',...models.map(row=>row[1])]);
 // Admission is checked before native workspace/approval and before a user row.
 const registry=require('../lib/provider-registry'),capability=registry.assertCapability,{Store}=require('../lib/store');
 t.mock.method(registry,'assertCapability',(actor,cap,...rest)=>actor==='grok'&&cap==='chat'?registry.resolveActor(actor):capability(actor,cap,...rest));
 t.mock.method(Store.prototype,'readProject',()=>({id:'p'}));t.mock.method(Store.prototype,'taskFile',()=>path.join(root,'synthetic-task.md'));
 t.mock.method(Store.prototype,'readTask',()=>({id:'t',owner:'grok',model:'Grok 4.5',effort:'高',state:'未着手'}));
 for(const [model,effort,expected]of [['unknown','高',/目前不提供模型/],['Grok 4.5','極高',/不支援思考強度「極高」/],['Grok 4.5','xhigh',/不支援思考強度「xhigh」/]]){
  const response=await fetch(base+'/api/chat/send',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'p',task:'t',ai:'grok',model,effort,text:'synthetic'})});
  const data=await response.json();assert.equal(response.status,409,JSON.stringify(data));assert.match(data.error,expected);
 }
 // A send itself refreshes changed metadata after the throttle, without GET state.
 write([['grok-4.5','Changed 4.5']],4000);now+=30001;
 const changed=await fetch(base+'/api/chat/send',{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify({project:'p',task:'t',ai:'grok',model:'Changed 4.5',effort:'xhigh',text:'synthetic'})});
 assert.equal(changed.status,409);assert.match((await changed.json()).error,/不支援思考強度「xhigh」/);
 assert.equal(fs.existsSync(path.join(root,'synthetic-task.md')),false);
 // Simulate an unknown catalog without changing readiness or creating a provider.
 const catalog=AiTools.prototype.catalog;t.mock.method(AiTools.prototype,'catalog',function(){return {...catalog.call(this),grok:{models:[],known:[]}};});
 assert.deepEqual((await state()).roles.models['grok'],['CLI預設','Grok 4.6']);
});
