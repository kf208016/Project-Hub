'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const fixture=require('./helpers/owned-native-fixture'),reviewed=require('./helpers/reviewed-workspace'),{Store}=require('../lib/store');
const win=process.platform==='win32'?test:test.skip;
win('owned native task display writes extend only a continuous private receipt; scope, stale GitHub and full receipt chains reject before writes',{timeout:180000},async t=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-task-metadata-')),root=path.join(temporary,'workspace'),dir=path.join(root,'Product','p'),scope={project:'p',task:'t'},originalPath=process.env.PATH;
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../windows/roles.yaml'),path.join(root,'_hub/roles.yaml'));
 fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: p\nstatus: 進行中\nfolders: {}\nrelated: []\nphases: []\n---\n');
 const file=path.join(dir,'.ai/tasks/t.md'),otherFile=path.join(dir,'.ai/tasks/other.md');
 const task=id=>'---\nid: '+id+'\ntitle: synthetic\nowner: codex\nmodel: GPT-6.1-Sol\nworkspaceMode: direct\nstate: 実行中\nquestion:\n---\n## 手順\n- [ ] synthetic\n';
 fs.writeFileSync(file,task('t'));fs.writeFileSync(otherFile,task('other'));
 fs.writeFileSync(path.join(root,'_hub/ai-tools-models.json'),JSON.stringify({v:1,codex:{models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}],known:[],source:'synthetic-fixture'}}));
 const provider=fixture.provider(temporary,{delay:120000}),restoreInventory=fixture.freshInventory();process.env.PATH=fixture.environment(provider.bin);
 Object.assign(process.env,{HUB_ROOT:root,HUB_PORT:'0',HUB_DRY_RUN:'1',HUB_AI_HOME:path.join(temporary,'home'),HUB_TRASH:path.join(temporary,'trash')});
 // This fault flag covers the existing GitHub lock admission branch only; no
 // GitHub job, network operation or external attestation is claimed here.
 const gh=require('../lib/github'),createGithub=gh.createGithub;let ghLocked=false;
 gh.createGithub=options=>{const instance=createGithub(options),locked=instance.locked;instance.locked=(...args)=>ghLocked||locked(...args);return instance;};
 let service=require('../server');await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const port=service.server.address().port;await new Promise(r=>service.server.close(r));process.env.HUB_PORT=String(port);delete require.cache[require.resolve('../server')];service=require('../server');await new Promise(r=>service.server.listen(port,'127.0.0.1',r));
 const base='http://127.0.0.1:'+port,post=(route,body)=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body)});
 t.after(async()=>{
  ghLocked=false;await post('/api/chat/stop',scope);for(const flow of [...service.workspaceRuntime.flows.values()]){await service.workspaceRuntime.stop(flow.id);await service.workspaceRuntime.finish(flow.id);}
  await new Promise(r=>service.server.close(r));gh.createGithub=createGithub;restoreInventory();process.env.PATH=originalPath;
  const resolved=fs.realpathSync(temporary);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith('hub-native-task-metadata-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:50});
 });
 let response=await reviewed.startReviewedFixture(post,'/api/chat/send',{...scope,ai:'codex',model:'GPT-6.1-Sol',text:'synthetic running turn'});assert.equal(response.status,200,await response.clone().text());
 const flow=service.workspaceRuntime.current('p','t');assert.ok(flow.children.size>0,'actual owned RPC child must be active');
 const entry=service.workspaceReview.runs.get(flow.workspace.run),baseline=JSON.stringify(entry.record.baseSnapshot),approvedSource=entry.record.taskHash;
 const current=()=>new Store(root).readTask(file);
 assert.equal(entry.approvedTaskHash,current().completionHash);
 const beforeQueue=fs.readFileSync(file),beforeAdvances=entry.taskAdvances.length;
 response=await post('/api/chat/send',{...scope,ai:'codex',model:'GPT-6.1-Sol',text:'queued synthetic',mode:'queue'});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(fs.readFileSync(file),beforeQueue,'same workspace queue admission must not touch updated');assert.equal(entry.taskAdvances.length,beforeAdvances);
 for(const input of [{state:'返事待ち',question:'human question',memo:'human note'},{state:'実行中',question:'another human question'}]){
  response=await post('/api/task',{...scope,...input});assert.equal(response.status,200,await response.clone().text());assert.equal(entry.approvedTaskHash,current().completionHash);
 }
 ghLocked=true;response=await post('/api/task',{...scope,question:'continuous under controlled GitHub lock'});assert.equal(response.status,200,await response.clone().text());ghLocked=false;
 assert.equal(entry.approvedTaskHash,current().completionHash);assert.equal(entry.record.taskHash,approvedSource);assert.equal(JSON.stringify(entry.record.baseSnapshot),baseline,'display updates cannot replace source baselines');
 const bytes=fs.readFileSync(file),otherBytes=fs.readFileSync(otherFile);
 for(const input of [{task:'other',question:'outside task'},{state:'完了'},{model:'GPT-6-Astra'},{owner:'claude-code'},{role:'チェック'},{parent:'other'},{kind:'derived'},{derivedFrom:'other'},{workspaceMode:'isolated'},{workdir:'other'},{refs:[]},{extra:true},{question:7},{memo:[]}]){
  response=await post('/api/task',{...scope,...input});assert.equal(response.status,409,await response.clone().text());assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readFileSync(otherFile),otherBytes);
 }
 // These private admission fault flags do not claim a worker transaction ran.
 for(const [moduleName,className,method]of [['task-transfer','TaskTransfer','nativeActive'],['task-integrate','TaskIntegrate','nativeActive'],['reviewed-git-service','ReviewedGitService','pending'],['native-maintenance','NativeMaintenance','nativeBusy']]){
  const proto=require('../lib/'+moduleName)[className].prototype,original=proto[method];proto[method]=()=>true;
  try{response=await post('/api/task',{...scope,question:'blocked transaction mutation'});assert.equal(response.status,409,await response.clone().text());assert.deepEqual(fs.readFileSync(file),bytes);}
  finally{proto[method]=original;}
 }
 // A restored stat tuple must not hide actual metadata bytes at this trust
 // boundary. Prime the controller's ordinary read cache at a fixed NTFS time.
 const fixed=new Date('2020-01-01T00:00:00.000Z');fs.utimesSync(file,fixed,fixed);
 response=await fetch(base+'/api/state',{headers:{Connection:'close'}});assert.equal(response.status,200);await response.json();
 const originalBytes=fs.readFileSync(file),stat=fs.statSync(file),changedBytes=Buffer.from(originalBytes.toString().replace('continuous under controlled GitHub lock','dontinuous under controlled GitHub lock'));
 assert.equal(changedBytes.length,originalBytes.length);assert.notDeepEqual(changedBytes,originalBytes);fs.writeFileSync(file,changedBytes);fs.utimesSync(file,fixed,fixed);assert.equal(fs.statSync(file).mtimeMs,stat.mtimeMs);ghLocked=true;
 try{response=await post('/api/task',{...scope,question:'must refuse same-stat stale bytes'});assert.equal(response.status,409,await response.clone().text());assert.match((await response.json()).error,/缺少連續controller收據/);assert.deepEqual(fs.readFileSync(file),changedBytes);}
 finally{ghLocked=false;fs.writeFileSync(file,originalBytes);fs.utimesSync(file,fixed,fixed);}
 // Exercise the real continuous controller chain to its bounded limit.
 while(entry.taskAdvances.length<128){response=await post('/api/task',{...scope,question:'receipt '+entry.taskAdvances.length});assert.equal(response.status,200,await response.clone().text());}
 const fullBytes=fs.readFileSync(file),fullHash=entry.approvedTaskHash;response=await post('/api/task',{...scope,question:'over limit'});assert.equal(response.status,409);assert.match((await response.json()).error,/收據已達上限/);assert.deepEqual(fs.readFileSync(file),fullBytes);assert.equal(entry.approvedTaskHash,fullHash);
 // A separate lifecycle write may be handled normally when GitHub is idle,
 // but cannot be adopted as approved evidence or written during its lock.
 new Store(root).updateTask('p','t',{question:'controlled lifecycle write without receipt'});const staleBytes=fs.readFileSync(file);ghLocked=true;
 response=await post('/api/task',{...scope,question:'must refuse stale chain'});assert.equal(response.status,409);assert.match((await response.json()).error,/缺少連續controller收據/);assert.deepEqual(fs.readFileSync(file),staleBytes);ghLocked=false;
 response=await post('/api/task',{...scope,question:'allowed original idle-GitHub display update'});assert.equal(response.status,200,await response.clone().text());assert.equal(entry.approvedTaskHash,fullHash);assert.equal(entry.taskAdvances.length,128);assert.equal(JSON.stringify(entry.record.baseSnapshot),baseline);
});
