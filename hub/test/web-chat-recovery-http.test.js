'use strict';
// Real local HTTP and NTFS, owned synthetic data. Admission/procwatch fixtures
// are explicit; this does not attest a production host or a provider model.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture,approved,resultInput}=require('./helpers/web-chat-fixture');
const {WebChat}=require('../lib/web-chat'),{digest,strictRows}=require('../lib/web-chat-receipts');
const recovery=require('../lib/web-chat-recovery-server');
const win=process.platform==='win32'?test:test.skip;
function snapshot(root){const rows=[];const walk=dir=>{for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),stat=fs.lstatSync(file);if(stat.isDirectory())walk(file);else rows.push([path.relative(root,file),stat.size,digest(fs.readFileSync(file))]);}};walk(root);return rows;}
function forbidOrdinaryConstructors(t){
 const restored=[];
 for(const [file,names]of [['store',['Store']],['completion',['Completion']],['chat',['ChatRunner']],['sessions',['Sessions']],['ai-tools',['AiTools']],['usage',['Usage']]]){const module=require('../lib/'+file);for(const name of names){const original=module[name];if(typeof original!=='function')continue;module[name]=class {constructor(){throw Error('Ordinary constructor forbidden in RecoveryOnly: '+name);}};restored.push(()=>module[name]=original);}}
 t.after(()=>restored.reverse().forEach(restore=>restore()));
}
async function start(t,f,admission,{procwatchFactory}={}){
 const watcherModule=require('../lib/procwatch'),original=watcherModule.create,restoreInventory=procwatchFactory?(()=>{watcherModule.create=original;}):require('./helpers/owned-native-fixture').freshInventory();if(procwatchFactory)watcherModule.create=procwatchFactory;
 const hubDir=path.join(__dirname,'..'),secret='R'.repeat(43);let service;try{service=recovery.create({root:f.root,hubDir,port:0,secret,admission});}finally{restoreInventory();}
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+service.server.address().port;let cookie='';
 const cleanupDir=fs.realpathSync(f.pdir).toLowerCase();t.after(async()=>{service.server.closeAllConnections?.();await new Promise(resolve=>service.server.close(resolve));const locks=require('../lib/task-write-lock');for(const row of locks.pending())if(row.dir===cleanupDir)locks.release(f.pdir,row.task,row.receiptId);});
 const request=async(route,input,{anonymous=false,headers={},method='POST',raw=false}={})=>fetch(base+route,{method,headers:{Connection:'close',...(method==='POST'?{'X-Hub':'1',Origin:base,'Content-Type':'application/json'}:{}),...(!anonymous&&cookie?{Cookie:cookie}:{}),...headers},...(method==='POST'?{body:raw?input:JSON.stringify(input)}:{})});
 const login=async()=>{const response=await request('/api/local/login',{token:secret},{anonymous:true});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);cookie=response.headers.get('set-cookie').split(';')[0];};
 return {service,request,login,base,secret};
}
win('minimal RecoveryOnly auth, origin and allowlist stay read-only with unknown orphan inspection and no ordinary constructors',{timeout:120000},async t=>{
 const f=fixture(t),id=crypto.randomUUID(),orphan=path.join(f.root,'_hub/web-chat-receipts',id);fs.mkdirSync(orphan,{recursive:true});fs.writeFileSync(path.join(orphan,'prompt.txt'),'synthetic private orphan content');
 forbidOrdinaryConstructors(t);const before=snapshot(f.root),admission={recoveryOnly:true,format:'web-manual-v2',pending:[],inspection:[{receiptId:id,reasonCode:'RECEIPT_METADATA_MISSING',repairable:false}]};
 assert.throws(()=>recovery.create({root:f.root,hubDir:path.join(__dirname,'..'),port:0,secret:'R'.repeat(43),admission:{recoveryOnly:false}}),/RECOVERY_ADMISSION_REQUIRED/);
 const {request,login,secret,service}=await start(t,f,admission);
 assert.equal((await request('/api/state',null,{method:'GET',anonymous:true})).status,200);assert.equal((await request('/api/web-chat/inspection',null,{method:'GET',anonymous:true})).status,200);
 assert.equal((await request('/api/local/login',{token:secret},{anonymous:true,headers:{Origin:'https://invalid.example'}})).status,403);
 assert.equal((await request('/api/local/login',{token:'wrong'},{anonymous:true})).status,403);await login();
 for(const headers of [{Origin:'https://invalid.example'},{'X-Hub':'0'},{Authorization:'Bearer '+('X'.repeat(43))},{'X-Forwarded-Host':'invalid.example'},{'X-Forwarded-For':'127.0.0.1'},{'Tailscale-User-Login':'synthetic'},{'X-Forwarded-Host':''},{'X-Forwarded-For':''},{'Tailscale-User-Login':''}])assert.equal((await request('/api/web-chat/recover/preview',{actor:'chatgpt',project:'p',task:'t',receiptId:id},{headers})).status,403,JSON.stringify(headers));
 // fetch retains the URL authority in this Node runtime, so exercise Host
 // refusal using raw local HTTP to keep the destination fixed.
 const hostStatus=await new Promise((resolve,reject)=>{const req=require('node:http').request({hostname:'127.0.0.1',port:service.server.address().port,path:'/api/state',method:'GET',headers:{Host:'invalid.example',Connection:'close'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(hostStatus,403);
 for(const route of ['/api/web-chat/preview','/api/web-chat/confirm','/api/web-chat/result','/api/task','/api/chat/send','/api/term/start','/api/project/new','/api/restart']){const response=await request(route,{actor:'chatgpt',project:'p',task:'t',text:'do not execute'});assert.equal(response.status,409);assert.equal((await response.json()).code,'RECOVERY_ONLY');}
 const state=await request('/api/state',null,{method:'GET'});assert.equal(state.status,200);assert.deepEqual(await state.json(),{recoveryOnly:true,mode:'recovery-only',format:'web-manual-v2',transactionsAtStartup:0,inspectionCount:1});
 const response=await request('/api/web-chat/inspection',null,{method:'GET'});assert.equal(response.status,200);const inspected=await response.json();assert.equal(inspected.inspection[0].repairable,false);assert.ok(!JSON.stringify(inspected).includes('synthetic private orphan content'));assert.equal(inspected.records.length,0);
 assert.equal((await request('/api/web-chat/status',{actor:'chatgpt',project:'p',task:'t',receiptId:id})).status,404);
 assert.deepEqual(snapshot(f.root),before);assert.equal(fs.existsSync(path.join(f.root,'_hub/completion.json')),false);assert.equal(fs.existsSync(path.join(f.root,'_hub/completion.migrated')),false);assert.equal(service.recoveryOnly,true);
});
win('known accepted partial crosses real HTTP current SHA/FileID preview and owner confirmation into committed without Completion/CLI effects',{timeout:240000},async t=>{
 const f=fixture(t),writer=require('../lib/web-handoff-writer'),originalOverwrite=writer.overwrite,source=new WebChat({...f.options,writer}),a=await approved(source,{owner:'windows-hub-owner'}),scope={actor:a.base.actor,project:a.base.project,task:a.base.task,receiptId:a.preview.receiptId};
 // Failure-return boundary fixture: keep the real native prepared intent and
 // before/after blobs, then expose damaged target UTF-8 under its same FileID.
 const managed=require('../lib/managed-process'),originalSpawn=managed.spawn,nativeSource=fs.readFileSync(path.join(__dirname,'../windows/web-handoff-writer.cs'),'utf8'),needle='WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)';assert.equal(nativeSource.split(needle).length,2);
 const changed=nativeSource.replace(needle,'FixtureWrite(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)').replace('static void Write(IntPtr file,byte[] bytes)','static bool FixtureWrite(IntPtr file,byte[] bytes,uint length,out uint written,IntPtr overlap){if(FinalName(file).EndsWith("\\\\t.md")){written=0;return false;}return WriteFile(file,bytes,length,out written,overlap);}\n  static void Write(IntPtr file,byte[] bytes)');
 const temporary=path.dirname(f.root),cs=path.join(temporary,'recovery-http-fault.cs'),exe=path.join(temporary,'recovery-http-fault.exe');fs.writeFileSync(cs,changed);require('node:child_process').execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll','/out:'+exe,cs],{windowsHide:true,timeout:30000});
 t.after(()=>{managed.spawn=originalSpawn;writer.overwrite=originalOverwrite;});managed.spawn=(binary,...args)=>originalSpawn(path.basename(binary).startsWith('web-handoff-writer-')?exe:binary,...args);const partial=await source.result(resultInput(a,'SYNTHETIC_HTTP_RECOVERY'));managed.spawn=originalSpawn;assert.equal(partial.partial,true);assert.equal(partial.state,'chat_saved');
 const identity=await writer.inspect(f.pdir,'.ai/tasks/t.md',{text:false,maxBytes:4*1024*1024});fs.writeFileSync(f.task,Buffer.from([0xff,0xfe,0x70,0x61,0x72,0x74]));assert.equal((await writer.inspect(f.pdir,'.ai/tasks/t.md',{text:false,maxBytes:4*1024*1024})).fileFingerprint,identity.fileFingerprint);
 forbidOrdinaryConstructors(t);const before=snapshot(f.root),{request,login,service}=await start(t,f,{recoveryOnly:true,format:'web-manual-v2',pending:[{receiptId:scope.receiptId,state:'chat_saved'}],inspection:[]});
 assert.deepEqual(snapshot(f.root),before);assert.equal(recovery.readonlyStore(f.root).listProjects()[0].tasks[0].id,'t');
 let response=await request('/api/web-chat/status',scope);assert.equal(response.status,409);let status=await response.json();assert.equal(status.state,'chat_saved');assert.equal(status.actualTargets.task,'changed');assert.equal(status.taskNoteSaved,null);
 response=await request('/api/web-chat/recover',scope);assert.equal(response.status,409);assert.equal((await response.json()).code,'RECOVERY_PREVIEW_REQUIRED');
 response=await request('/api/web-chat/recover/preview',{...scope,owner:'forged-owner'});assert.equal(response.status,400);
 response=await request('/api/web-chat/recover/preview',{...scope,actor:'claude-chat'});assert.equal(response.status,403);
 response=await request('/api/web-chat/recover/preview',scope);assert.equal(response.status,200);const preview=await response.json(),action=preview.actions.find(x=>x.target==='task');assert.equal(action.currentSHA256,digest(fs.readFileSync(f.task)));assert.equal(action.currentFileFingerprint,identity.fileFingerprint);assert.equal(action.willOverwrite,true);
 const payload={...scope,confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256};response=await request('/api/web-chat/recover',{...payload,recoveryToken:'Z'.repeat(43)});assert.equal(response.status,403);
 response=await request('/api/web-chat/recover',payload);assert.equal(response.status,200);const committed=await response.json();assert.equal(committed.state,'committed');assert.equal(committed.actualTargets.task,'saved');assert.equal(committed.actualTargets.chat,'saved');assert.equal(committed.provenance,'user-pasted/unattested');
 response=await request('/api/web-chat/status',scope);assert.equal(response.status,200);assert.equal((await response.json()).state,'committed');assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);assert.ok(fs.readFileSync(f.task,'utf8').includes('> SYNTHETIC_HTTP_RECOVERY'));
 response=await request('/api/web-chat/recover',payload);assert.equal(response.status,200);assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);assert.equal(require('../lib/task-write-lock').pending().filter(row=>row.receiptId===scope.receiptId).length,0);
 assert.equal(fs.existsSync(path.join(f.root,'_hub/completion.json')),false);assert.equal(fs.existsSync(path.join(f.root,'_hub/completion.migrated')),false);assert.equal(service.recoveryOnly,true);
 t.diagnostic('Real local HTTP and NTFS with explicit synthetic admission/no-AI process inventory; task partial bytes are fixture-created under a real prepared native intent.');
});
win('RecoveryOnly inspection pagination reaches receipt 101 and excludes fresh terminal records',{timeout:60000},async t=>{
 const f=fixture(t);forbidOrdinaryConstructors(t);const rows=Array.from({length:101},()=>({receiptId:crypto.randomUUID(),state:'planned'})),before=snapshot(f.root),{service,request,login}=await start(t,f,{recoveryOnly:true,format:'web-manual-v2',pending:rows,inspection:[]});
 let reads=0;const ownerHash=digest('windows-hub-owner');service.webChat.receipts.read=async id=>{reads++;return {value:{receiptId:id,ownerHash,actor:'chatgpt',project:'p',task:'t',state:id===rows[0].receiptId?'committed':'planned'}};};
 let response=await request('/api/web-chat/inspection',null,{method:'GET'});assert.equal(response.status,200);const first=await response.json();assert.equal(first.records.length,99);assert.equal(first.nextOffset,100);assert.equal(first.truncated,true);assert.ok(!first.records.some(row=>row.receiptId===rows[0].receiptId));assert.equal(reads,100);
 response=await request('/api/web-chat/inspection?offset=100',null,{method:'GET'});assert.equal(response.status,200);const last=await response.json();assert.equal(last.records.length,1);assert.equal(last.records[0].receiptId,rows[100].receiptId);assert.equal(last.previousOffset,0);assert.equal(last.nextOffset,null);assert.equal(last.truncated,false);assert.equal(reads,101);
 for(const query of ['?offset=100&offset=0','?offset=-1','?offset=99999','?extra=1'])assert.equal((await request('/api/web-chat/inspection'+query,null,{method:'GET'})).status,400);
 const state=await request('/api/state',null,{method:'GET'});assert.equal((await state.json()).transactionsAtStartup,101);assert.deepEqual(snapshot(f.root),before);
 t.diagnostic('Only receipt reads are mocked for the 101-item bounded list; HTTP/auth/pagination and filesystem no-write checks are real.');
});
win('existing 本体 folder maps a related synthetic background CLI and refuses recovery with blank accepted workdir',{timeout:60000},async t=>{
 const f=fixture(t),main=path.join(f.root,'Main');fs.mkdirSync(main);fs.writeFileSync(f.project,"---\nname: p\nfolders:\n  本体: '"+main+"'\n---\n");assert.equal(recovery.readonlyStore(f.root).listProjects()[0].folders['本体'],main);forbidOrdinaryConstructors(t);const receiptId=crypto.randomUUID(),scope={actor:'chatgpt',project:'p',task:'t',receiptId},before=snapshot(f.root);let scans=0,mapped='';
 const factory=options=>({scan:async()=>{scans++;const p=options.projects().find(row=>row.id==='p');mapped=options.baseOf(p);},assertKnown(){},list:()=>mapped===main?[{project:'p',task:'',ai:'codex',pid:999999}]:[]});
 const {service,request,login}=await start(t,f,{recoveryOnly:true,format:'web-manual-v2',pending:[{receiptId,state:'planned'}],inspection:[]},{procwatchFactory:factory});
 service.webChat.receipts.read=async()=>({value:{ownerHash:digest('windows-hub-owner'),receiptId,actor:'chatgpt',project:'p',task:'t',state:'planned',transaction:{taskBeforeBlob:{}}},evidence:{sha256:'a'.repeat(64),fileFingerprint:'b'.repeat(64)},relative:receiptId+'/receipt.json'});service.webChat.receipts.readBlob=async()=>'---\nworkdir:\n---\n';service.webChat.recoveryActions=async()=>[];service.webChat.outcome=async()=>({state:'planned',actualTargets:{chat:'before',task:'before'}});
 let response=await request('/api/web-chat/recover/preview',scope);assert.equal(response.status,200);const preview=await response.json();response=await request('/api/web-chat/recover',{...scope,confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256});assert.equal(response.status,409);assert.equal((await response.json()).code,'TASK_ACTIVE_LEASE');assert.equal(mapped,main);assert.equal(scans,1);assert.deepEqual(snapshot(f.root),before);
 t.diagnostic('Synthetic procwatch mapping and receipt fixture exercise the actual 本体 baseOf callback plus HTTP owner confirmation; no real CLI is launched.');
});
