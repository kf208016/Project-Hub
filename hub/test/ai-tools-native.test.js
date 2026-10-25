'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {AiTools}=require('../lib/ai-tools');
test('Claude local catalog refresh reads only the newest metadata, retains efforts, never spawns and preserves state on failure',t=>{
 const root=fixture(t),home=path.join(root,'home'),dir=path.join(home,'.claude/cache/model-catalog');fs.mkdirSync(dir,{recursive:true});
 const older=path.join(dir,'old.json'),latest=path.join(dir,'new.json');
 const json=(id,name,efforts)=>JSON.stringify({catalog:{config:{models:[{id,name,section:'main',thinking:{effort_options:efforts.map(id=>({id}))}},{id:'hidden',name:'Hidden',section:'overflow'}]}}});
 fs.writeFileSync(older,json('old','Old',['low']));fs.utimesSync(older,1000,1000);
 fs.writeFileSync(latest,json('claude-fable-5-1','Fable 5.1',['low','medium','high','xhigh']));fs.utimesSync(latest,2000,2000);
 const forbidden=()=>{assert.fail('No CLI lookup, process or live refresh is allowed');};
 const tools=new AiTools({root,home,platform:'win32',dry:true,find:forbidden,run:forbidden,refreshClaude:forbidden});
 const read=fs.readFileSync,reads=[];t.mock.method(fs,'readFileSync',(file,...args)=>{reads.push(file);assert.equal(file,latest);return read(file,...args);});
 const result=tools.refreshClaudeCatalogFromCache();assert.equal(result.source,'local-cache');assert.equal(result.refreshedAt,new Date(fs.statSync(latest).mtimeMs).toISOString());
 assert.deepEqual(result.models,[{id:'claude-fable-5-1',label:'Fable 5.1',efforts:['low','medium','high','xhigh']}]);assert.deepEqual(tools.catalog().claude.known,result.models);
 const before=structuredClone(tools.catalog().claude);tools.refreshClaudeCatalogFromCache({ifChanged:true});assert.equal(reads.length,1);
 fs.writeFileSync(latest,'{broken');fs.utimesSync(latest,3000,3000);
 assert.throws(()=>tools.refreshClaudeCatalogFromCache({ifChanged:true}),e=>e.status===502&&e.stage==='models');assert.deepEqual(tools.catalog().claude,before);
 fs.unlinkSync(latest);fs.unlinkSync(older);assert.throws(()=>tools.refreshClaudeCatalogFromCache(),e=>e.status===502&&e.stage==='models');assert.deepEqual(tools.catalog().claude,before);
});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ai-native-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('Native AI update forwards exact approval, exposes a private candidate and retains the old CLI on compatibility block',async t=>{
 const root=fixture(t);let approved;const native={useActive(){},preview:async version=>({version,token:'fixture-token',ignoreScripts:true,scope:'Hub-private-slot',compatible:false,blocker:'UNVERIFIED_CODEX_PROTOCOL_VERSION'}),apply:async body=>{approved=body;return{ok:false,phase:'blocked',oldVersionRetained:true,blocker:'UNVERIFIED_CODEX_PROTOCOL_VERSION'};}};
 const tools=new AiTools({root,home:path.join(root,'home'),platform:'win32',nativeUpdater:native,find:()=>process.execPath,run:async()=>'codex-cli 0.154.0',latest:async()=>({version:'0.155.0',source:'official fixture'})});const check=await tools.checkUpdate('codex');assert.equal(check.nativePreview.version,'0.155.0');assert.equal(check.scope,'Hub-private-slot');const approval={version:'0.155.0',token:'fixture-token',confirm:true},result=await tools.update('codex',approval);assert.deepEqual(approved,approval);assert.equal(result.phase,'blocked');assert.equal(result.changed,false);assert.equal(result.verified,false);assert.equal(result.afterVersion,'0.154.0');assert.equal(tools.isOperating(),false);
});
test('Native AI activation verifies its exact version, preserves model choices, and rolls back a version verification failure',async t=>{
 const root=fixture(t);let versions=0,rollback=0;const native={useActive(){},apply:async()=>({ok:true,phase:'activated',version:'0.154.0',slot:'fixture-slot',globalCliChanged:false}),active:()=>({file:process.execPath}),rollback:id=>{assert.equal(id,'fixture-slot');rollback++;}};
 const tools=new AiTools({root,home:path.join(root,'home'),platform:'win32',nativeUpdater:native,find:()=>process.execPath,run:async()=>++versions===1?'codex-cli 0.154.0':'broken version',refreshCodex:async()=>[{id:'fixture-model',label:'fixture-model'}]});await assert.rejects(tools.update('codex',{version:'0.154.0',token:'fixture',confirm:true}),error=>error.stage==='verify');assert.equal(rollback,1);assert.equal(tools.isOperating(),false);assert.deepEqual(tools.catalog().codex.models,[]);
});
test('Windows ignores the shared Codex cache and binds live availability to the exact binary hash',async t=>{
 const root=fixture(t),home=path.join(root,'home'),shared=path.join(home,'.codex/models_cache.json'),binary=path.join(root,'codex.exe');fs.mkdirSync(path.dirname(shared),{recursive:true});fs.writeFileSync(shared,JSON.stringify({models:[{slug:'shared-stale',display_name:'Shared stale',visibility:'list'}]}));fs.writeFileSync(binary,'binary-one');
 let calls=0,release;const gate=new Promise(resolve=>release=resolve),native={useActive(){}};
 const tools=new AiTools({root,home,platform:'win32',nativeUpdater:native,refreshCodex:async file=>{calls++;assert.equal(file,binary);await gate;return[{id:'live-id',label:'Live label'}];}});
 assert.deepEqual(tools.catalog().codex.models,[]);assert.equal(tools.codexAvailability('live-id'),'unknown');
 const first=tools.refreshCodexCatalog({file:binary}),second=tools.refreshCodexCatalog({file:binary});release();assert.deepEqual(await first,[{id:'live-id',label:'Live label'}]);assert.deepEqual(await second,[{id:'live-id',label:'Live label'}]);assert.equal(calls,1);
 const hash=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),saved=JSON.parse(fs.readFileSync(tools.file,'utf8'));
 assert.equal(saved.codex.source,'codex-app-server');assert.equal(saved.codex.binarySha256,hash);assert.ok(saved.codex.refreshedAt);
 assert.equal(tools.codexAvailability('Live label'),'available');assert.equal(tools.codexAvailability('live-id'),'available');assert.equal(tools.codexAvailability('CLI預設'),'available');assert.equal(tools.codexAvailability('missing'),'unavailable');
 const other=path.join(root,'other-codex.exe');fs.writeFileSync(other,'binary-two');tools.setCodexBinary(other);assert.equal(tools.codexAvailability('live-id'),'unknown');
 const restarted=new AiTools({root,home,platform:'win32',dry:true,nativeUpdater:native});restarted.setCodexBinary(binary);assert.equal(restarted.codexAvailability('live-id'),'available');restarted.setCodexBinary(other);assert.equal(restarted.codexAvailability('live-id'),'unknown');
});
test('failed Windows Codex refresh preserves the previous catalog and persisted receipt',async t=>{
 const root=fixture(t),binary=path.join(root,'codex.exe');fs.writeFileSync(binary,'binary');let fail=false;
 const tools=new AiTools({root,home:path.join(root,'home'),platform:'win32',nativeUpdater:{useActive(){}},refreshCodex:async()=>{if(fail)throw Error('PRIVATE_PROVIDER_OUTPUT');return[{id:'kept',label:'Kept'}];}});
 await tools.refreshCodexCatalog({file:binary});const before=fs.readFileSync(tools.file);fail=true;
 await assert.rejects(tools.refreshCodexCatalog({file:binary}),/PRIVATE_PROVIDER_OUTPUT/);assert.deepEqual(fs.readFileSync(tools.file),before);assert.deepEqual(tools.catalog().codex.models,[{id:'kept',label:'Kept'}]);
});

test('Grok cache projects four visible models and effort values without accessing secret siblings',async t=>{
 const root=fixture(t),home=path.join(root,'home'),file=path.join(home,'.grok/models_cache.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 const secret='SYNTHETIC_GROK_SECRET_NEVER_EXPOSE',names=['Grok 4.7','Grok 4.7 Fast','Grok 4.6','Grok 4.5'];
 const rows=Object.fromEntries(names.map((name,index)=>{const id=['grok-4.7','grok-4.7-fast','grok-4.6','grok-4.5'][index];return [id,{info:{id,name,hidden:false,supports_reasoning_effort:true,reasoning_efforts:(index===3?['low','medium','high']:['low','medium','high','xhigh']).map((value,i)=>i?{id:'display-'+value,value}:{id:value})},api_key:secret,env_key:secret,api_base_url:secret}];}));
 rows.hidden={info:{id:'hidden',name:'Hidden',hidden:true},api_key:secret};
 const json=JSON.stringify({models:rows,identity:secret,auth_method:secret,etag:secret});fs.writeFileSync(file,json);fs.utimesSync(file,2000,2000);
 const tools=new AiTools({root,home,platform:'win32',dry:true,find:()=>null,run:()=>assert.fail('no CLI spawn'),refreshClaude:()=>assert.fail('no CLI spawn')});
 const parse=JSON.parse,read=fs.readFileSync;let accesses=0,reads=0;
 const forbid=(object,key)=>Object.defineProperty(object,key,{get(){accesses++;throw Error('Forbidden field access');},enumerable:true,configurable:true});
 t.mock.method(JSON,'parse',function(value,...args){const parsed=parse(value,...args);if(value===json){
  for(const key of ['identity','auth_method','etag','fetched_at','renewed_at','grok_version','origin'])forbid(parsed,key);
  for(const row of Object.values(parsed.models)){
   for(const key of ['api_key','env_key','api_base_url'])forbid(row,key);
   forbid(row.info,'reasoning_effort');
   for(const option of row.info.reasoning_efforts||[])forbid(option,'label');
  }
 }return parsed;});
 t.mock.method(fs,'readFileSync',(name,...args)=>{assert.equal(String(name).endsWith('auth.json'),false);if(name===file)reads++;return read(name,...args);});
 const result=tools.refreshGrokCatalogFromCache();assert.equal(accesses,0);assert.equal(reads,1);
 assert.deepEqual(result.models.map(row=>row.label),names);assert.deepEqual(result.models[0].efforts,['low','medium','high','xhigh']);assert.deepEqual(result.models[3].efforts,['low','medium','high']);
 assert.equal(result.source,'local-cache');assert.equal(result.refreshedAt,new Date(fs.statSync(file).mtimeMs).toISOString());
 assert.equal(JSON.stringify({result,catalog:tools.catalog(),status:await tools.status()}).includes(secret),false);
 assert.equal((await tools.status()).tools.grok.modelRefreshAvailable,true);
 tools.refreshGrokCatalogFromCache({ifChanged:true});assert.equal(reads,1);
 const before=structuredClone(tools.catalog().grok);
 for(const broken of ['{broken','{}','{"models":[]}','{"models":{"x":null}}','{"models":{"x":{"info":{"id":"bad id"}}}}']){
  fs.writeFileSync(file,broken);assert.throws(()=>tools.refreshGrokCatalogFromCache(),e=>e.status===502&&e.stage==='models'&&!e.message.includes(secret));assert.deepEqual(tools.catalog().grok,before);
 }
 fs.unlinkSync(file);assert.throws(()=>tools.refreshGrokCatalogFromCache(),e=>e.status===502&&e.stage==='models');assert.deepEqual(tools.catalog().grok,before);
});

test('Grok cache uses id labels, de-duplicates efforts and records no supported effort for non-reasoning models',t=>{
 const root=fixture(t),home=path.join(root,'home'),file=path.join(home,'.grok/models_cache.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({models:{one:{info:{id:'one',supports_reasoning_effort:false,reasoning_efforts:[{value:'high'}]}},two:{info:{id:'two',supports_reasoning_effort:true,reasoning_efforts:[{value:'low'},{id:'low'},{value:'xhigh'},{value:'bad effort'}]}}}}));
 const tools=new AiTools({root,home,platform:'win32',dry:true});assert.deepEqual(tools.refreshGrokCatalogFromCache().models,[{id:'one',label:'one',efforts:[]},{id:'two',label:'two',efforts:['low','xhigh']}]);
});

test('explicit reviewed version previews support upgrade, downgrade and same-version repair without latest npm',async t=>{
 const root=fixture(t),previews=[],native={useActive(){},active:()=>({slot:'active-slot',version:'0.164.0',previous:{slot:'old-slot',version:'0.154.0'}}),preview:async version=>{previews.push(version);return {version,compatible:true};}};
 const tools=new AiTools({root,home:path.join(root,'home'),platform:'win32',nativeUpdater:native,find:()=>process.execPath,run:async()=>'codex-cli 0.164.0',latest:()=>assert.fail('no latest lookup')});
 for(const version of ['0.154.0','0.164.0']){const result=await tools.checkUpdate('codex',{version});assert.equal(result.available,true);assert.equal(result.nativePreview.version,version);}
 for(const version of ['0.153.0','__proto__',null])await assert.rejects(tools.checkUpdate('codex',{version}),e=>e.status===400);
 assert.deepEqual(previews,['0.154.0','0.164.0']);const status=(await tools.status()).tools.codex.nativeUpdate;assert.deepEqual(status.versions,['0.154.0','0.164.0']);assert.equal(status.active.version,'0.164.0');assert.equal(status.previous.version,'0.154.0');
});
test('corrupt active pointer does not crash construction and is visible in settings',async t=>{
 const root=fixture(t),dir=path.join(root,'_hub/cli');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'active.json'),'{broken');
 const tools=new AiTools({root,home:path.join(root,'home'),platform:'win32',find:()=>null});assert.equal(tools.nativeUpdateError,'ACTIVE_STATE_REJECTED');
 const status=(await tools.status()).tools.codex.nativeUpdate;assert.equal(status.error,'ACTIVE_STATE_REJECTED');assert.equal(status.active,null);
 assert.throws(()=>require('../lib/native-codex-profile').resolve({updater:tools.nativeUpdater,error:tools.nativeUpdateError,file:process.execPath}),{code:'NATIVE_CODEX_VERSION_UNREVIEWED'});
});
