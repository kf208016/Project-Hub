'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {ReviewedWorkspace}=require('../lib/reviewed-workspace'),git=require('../lib/git'),{SecretSupply}=require('../lib/secret-supply');
const win=process.platform==='win32'?test:test.skip;
// Non-Git fixtures cannot persist a repo-local setting before preview. Use
// the supported per-process fixture override instead of the host default.
process.env.GIT_CONFIG_COUNT='1';process.env.GIT_CONFIG_KEY_0='core.autocrlf';process.env.GIT_CONFIG_VALUE_0='false';
function fixture(t){const tmp=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(tmp,'hub-workspace-review-')),base=path.join(root,'project');fs.mkdirSync(base);t.after(()=>{assert.ok(root.startsWith(tmp+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});const d={project:'p',task:'one',title:'Synthetic task',taskHash:'task-1',base,workRoot:path.join(root,'Work/p')};const cmd=(...args)=>execFileSync('git',['-C',base,...args],{encoding:'utf8',stdio:'pipe'}).trim(),ws=new ReviewedWorkspace({root,resolve:()=>({...d})});return {root,base,d,cmd,ws,apply:p=>ws.apply({project:'p',task:'one',token:p.token,confirm:true})};}
win('direct workspace refuses index flags introduced after preparation before granting a run',{timeout:300000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'ordinary.txt'),'SYNTHETIC_BASELINE\n');const ready=await f.apply(await f.ws.preview('p','one',{direct:true}));assert.equal(ready.ok,true,ready.error);const head=f.cmd('rev-parse','HEAD');f.cmd('update-index','--assume-unchanged','ordinary.txt');await assert.rejects(f.ws.consumeRun({project:'p',task:'one',permit:ready.permit}),/assume-unchanged／skip-worktree/);assert.equal(f.ws.runs.size,0);assert.equal(f.cmd('rev-parse','HEAD'),head);assert.equal(fs.readFileSync(path.join(f.base,'ordinary.txt'),'utf8'),'SYNTHETIC_BASELINE\n');assert.match(f.cmd('ls-files','-v'),/^h /);f.cmd('update-index','--no-assume-unchanged','ordinary.txt');const fresh=await f.apply(await f.ws.preview('p','one',{direct:true}));assert.equal(fresh.ok,true,fresh.error);const run=await f.ws.consumeRun({project:'p',task:'one',permit:fresh.permit});assert.equal(f.ws.locked(f.base),true);assert.equal((await f.ws.releaseRun(run.run)).ok,true);});
win('reviewed non-Git first save excludes secrets and creates an isolated task worktree',{timeout:600000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'file.txt'),'ordinary\n');fs.writeFileSync(path.join(f.base,'.env'),'SYNTHETIC=not-a-secret\n');const p=await f.ws.preview('p','one');assert.equal(p.kind,'non-git');assert.deepEqual(p.excluded,['.env']);assert.equal(fs.existsSync(path.join(f.base,'.git')),false);const out=await f.apply(p);assert.equal(out.ok,true,out.error);assert.equal(out.dir,path.join(f.d.workRoot,'one'));assert.equal(fs.readFileSync(path.join(out.dir,'file.txt'),'utf8'),'ordinary\n');assert.equal(fs.existsSync(path.join(out.dir,'.env')),false);assert.ok(!f.cmd('ls-tree','-rz','--name-only','HEAD').includes('.env'));await assert.rejects(f.apply(p),/重新預覽/);const run=await f.ws.consumeRun({project:'p',task:'one',permit:out.permit});assert.equal(run.mode,'isolated');await assert.rejects(f.ws.consumeRun({project:'p',task:'one',permit:out.permit}),/已到期或已使用/);assert.equal((await f.ws.releaseRun(run.run)).ok,true);});
win('unborn Git and empty first commits prepare a usable worktree',{timeout:600000},async t=>{const f=fixture(t);f.cmd('init','-q');f.cmd('config','user.name','Synthetic');f.cmd('config','user.email','synthetic@example.test');const p=await f.ws.preview('p','one');assert.equal(p.kind,'unborn');const out=await f.apply(p);assert.equal(out.ok,true,out.error);assert.match(out.baselineCommit,/^[a-f0-9]{40,64}$/);assert.ok(fs.existsSync(path.join(out.dir,'.git')));});
win('selected supply journal failure retains its private never-started flow for exact cleanup',{timeout:600000},async t=>{const f=fixture(t);await assert.rejects(f.ws.preview('p','one',{secrets:Array.from({length:129},(_,i)=>'secret-'+i)}),/格式無效/);fs.writeFileSync(path.join(f.base,'.env'),'SYNTHETIC=never-started\n');const {WorkspaceRuntime}=require('../lib/workspace-runtime');let runtime;const supply=new SecretSupply({root:f.root,stopRun:id=>runtime.stop(id)});f.ws.secretSupply=supply;const prepared=await f.apply(await f.ws.preview('p','one',{secrets:['.env']}));assert.equal(prepared.ok,true,prepared.error);const save=f.ws.saveAsync.bind(f.ws);f.ws.saveAsync=async r=>{if(r.supplied.length)throw Error('synthetic post-supply journal failure');return save(r);};runtime=new WorkspaceRuntime({review:f.ws,chats:{busy:()=>null,queue:()=>[],stop(){}},sessions:{stop(){}},store:{},stopExtra:async()=>({stopped:true,treeExited:true})});let failure;try{await runtime.begin({project:'p',task:'one',permit:prepared.permit,kind:'chat'});}catch(error){failure=error;}assert.match(failure.message,/post-supply/);assert.ok(failure.supplyId);const flow=runtime.flows.get(failure.workspaceFlow);assert.ok(flow);assert.equal(flow.children.size,0);assert.equal(fs.existsSync(path.join(prepared.dir,'.env')),true);await runtime.failed(flow);assert.equal(supply.read(failure.supplyId).complete,true);assert.equal(fs.existsSync(path.join(prepared.dir,'.env')),false);assert.equal(fs.readFileSync(path.join(f.base,'.env'),'utf8'),'SYNTHETIC=never-started\n');});
win('existing worktree bytes and root FileID remain bound across preview and run',{timeout:600000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'file.txt'),'baseline\n');const first=await f.apply(await f.ws.preview('p','one'));assert.equal(first.ok,true,first.error);let p=await f.ws.preview('p','one');assert.ok(p.workingOriginal.rootFingerprint);fs.writeFileSync(path.join(first.dir,'file.txt'),'changed after preview\n');await assert.rejects(f.apply(p),/內容.*FileID/);p=await f.ws.preview('p','one');const ready=await f.apply(p);assert.equal(ready.ok,true,ready.error);const swapped=first.dir+'-held';fs.renameSync(first.dir,swapped);fs.mkdirSync(first.dir);await assert.rejects(f.ws.consumeRun({project:'p',task:'one',permit:ready.permit}),/啟動前/);fs.rmdirSync(first.dir);fs.renameSync(swapped,first.dir);const run=await f.ws.consumeRun({project:'p',task:'one',permit:(await f.apply(await f.ws.preview('p','one'))).permit});assert.equal((await f.ws.verifiedBinding('p','one')).run,run.run);const restarted=new ReviewedWorkspace({root:f.root,resolve:()=>({...f.d})});assert.equal(restarted.binding('p','one'),null);await assert.rejects(restarted.verifiedBinding('p','one'),/controller/);await f.ws.releaseRun(run.run);});
win('direct run requires fresh user preview, saves a baseline and holds the shared repository lock',{timeout:600000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'file.txt'),'baseline\n');const p=await f.ws.preview('p','one',{direct:true}),out=await f.apply(p);assert.equal(out.ok,true,out.error);assert.equal(out.dir,f.base);const run=await f.ws.consumeRun({project:'p',task:'one',permit:out.permit});assert.equal(f.ws.locked(f.base),true);fs.writeFileSync(path.join(f.base,'file.txt'),'synthetic direct result\n');await assert.rejects(f.ws.preview('p','one',{direct:true}),/其他操作執行中/);assert.equal((await f.ws.releaseRun(run.run)).ok,true);assert.equal(f.ws.locked(f.base),false);assert.equal(f.cmd('show',out.baselineCommit+':file.txt'),'baseline');assert.equal(fs.readFileSync(path.join(f.base,'file.txt'),'utf8'),'synthetic direct result\n');});
win('workspace refuses stale bytes/task, wrong task, nested Git and Hub code/control overlap',{timeout:600000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'file.txt'),'before\n');let p=await f.ws.preview('p','one');fs.writeFileSync(path.join(f.base,'file.txt'),'after\n');await assert.rejects(f.apply(p),/內容.*已變更/);assert.equal(fs.existsSync(path.join(f.base,'.git')),false);p=await f.ws.preview('p','one');f.d.taskHash='changed';await assert.rejects(f.apply(p),/內容.*已變更/);p=await f.ws.preview('p','one');await assert.rejects(f.ws.apply({project:'p',task:'two',token:p.token,confirm:true}),/重新預覽/);f.cmd('init','-q');const nested=path.join(f.base,'nested');fs.mkdirSync(nested);f.d.base=nested;await assert.rejects(f.ws.preview('p','one'),/外層 Git/);f.d.base=f.root;await assert.rejects(f.ws.preview('p','one'),/控制資料/);f.d.base=path.resolve(__dirname,'../..');await assert.rejects(f.ws.preview('p','one'),/執行碼/);});
win('workspace malformed hook authority and changed secret source leave files and Git untouched',async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'.env'),'SYNTHETIC=before\n');const p=await f.ws.preview('p','one',{secrets:['.env']});await assert.rejects(f.ws.apply({project:'p',task:'one',token:p.token,confirm:true,skipHooks:'yes'}),/格式無效/);assert.equal(fs.existsSync(path.join(f.base,'.git')),false);fs.writeFileSync(path.join(f.base,'.env'),'SYNTHETIC=after\n');await assert.rejects(f.apply(p),/內容.*已變更/);assert.equal(fs.readFileSync(path.join(f.base,'.env'),'utf8'),'SYNTHETIC=after\n');await assert.rejects(f.ws.preview('../p','one'),/識別/);});
win('initial journal failure prevents Git init; failed worktree preparation can resume from saved commit',{timeout:600000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'file.txt'),'preserved\n');const p=await f.ws.preview('p','one'),save=f.ws.saveAsync.bind(f.ws);f.ws.saveAsync=async()=>{throw Error('synthetic disk failure');};const failed=await f.apply(p);assert.equal(failed.ok,false);assert.equal(failed.partial,false);assert.equal(fs.existsSync(path.join(f.base,'.git')),false);f.ws.saveAsync=save;const prepare=git.prepare;git.prepare=()=>{throw Error('synthetic worktree failure');};let stopped;try{stopped=await f.apply(await f.ws.preview('p','one'));}finally{git.prepare=prepare;}assert.equal(stopped.ok,false);assert.equal(stopped.state,'preparing');const before=f.cmd('rev-parse','HEAD'),resume=await f.ws.preview('p','one');assert.equal(resume.resume,true);const done=await f.apply(resume);assert.equal(done.ok,true,done.error);assert.equal(f.cmd('rev-parse','HEAD'),before);});
win('user-selected tracked secret requires complete exposure confirmation and restores its baseline after stopping',{timeout:600000},async t=>{const f=fixture(t);fs.writeFileSync(path.join(f.base,'.env'),'SYNTHETIC=fixture\n');f.cmd('init','-q');f.cmd('config','user.name','Synthetic');f.cmd('config','user.email','synthetic@example.test');f.cmd('add','.env');f.cmd('commit','-qm','fixture tracked secret');await assert.rejects(f.ws.preview('p','one'),/完整清單/);let stopped=0;const supply=new SecretSupply({root:f.root,stopRun:async()=>{stopped++;return {stopped:true,treeExited:true};}});f.ws.secretSupply=supply;const p=await f.ws.preview('p','one',{secrets:['.env']});assert.deepEqual(p.trackedSecrets,['.env']);assert.match(p.action,/Git歷史/);const ready=await f.apply(p);assert.equal(ready.ok,true,ready.error);const lease=await f.ws.supply({project:'p',task:'one',permit:ready.permit,runId:'synthetic-owned-run'}),run=await f.ws.consumeRun({project:'p',task:'one',permit:ready.permit});assert.equal(run.supplyId,lease.id);assert.equal((await f.ws.releaseRun(run.run)).ok,true);assert.equal(stopped,1);assert.equal(supply.read(lease.id).complete,true);assert.equal(fs.readFileSync(path.join(ready.dir,'.env'),'utf8'),'SYNTHETIC=fixture\n');assert.equal(execFileSync('git',['-C',ready.dir,'status','--porcelain'],{encoding:'utf8'}),'');});
win('existing Work HEAD secret requires its own exposure confirmation and preserves different destination bytes',{timeout:600000},async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.base,'ordinary.txt'),'ordinary\n');
  const first=await f.apply(await f.ws.preview('p','one'));assert.equal(first.ok,true,first.error);
  const work=(...args)=>execFileSync('git',['-C',first.dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  const destination='SYNTHETIC_WORK_BASELINE\r\n',source='SYNTHETIC_SOURCE_SELECTION\n';
  fs.writeFileSync(path.join(first.dir,'.env'),destination);work('add','.env');work('commit','-qm','synthetic Work-only tracked secret');
  await assert.rejects(f.ws.preview('p','one'),/既有工作複本 Git HEAD.*完整檔名/);
  await assert.rejects(f.ws.preview('p','one',{secrets:['.env']}),/未確認的機密/);
  assert.equal(fs.existsSync(path.join(f.base,'.env')),false);assert.equal(fs.readFileSync(path.join(first.dir,'.env'),'utf8'),destination);
  fs.writeFileSync(path.join(f.base,'.env'),source);const preview=await f.ws.preview('p','one',{secrets:['.env']});
  assert.deepEqual(preview.trackedSecrets,['.env']);assert.equal(preview.secrets.files[0].relative,'.env');
  const ready=await f.apply(preview);assert.equal(ready.ok,true,ready.error);
  // This fixture validates real native supply/restoration. The owned-exit proof
  // is explicitly synthetic; actual child-close proof has separate HTTP tests.
  f.ws.secretSupply=new SecretSupply({root:f.root,stopRun:async()=>({stopped:true,treeExited:true})});
  await assert.rejects(f.ws.consumeRun({project:'p',task:'one',permit:ready.permit}),/尚未建立短期供應 lease/);
  const retry=await f.apply(await f.ws.preview('p','one',{secrets:['.env']}));assert.equal(retry.ok,true,retry.error);
  await f.ws.supply({project:'p',task:'one',permit:retry.permit,runId:'synthetic-owned-run'});
  assert.equal(fs.readFileSync(path.join(first.dir,'.env'),'utf8'),source);
  const run=await f.ws.consumeRun({project:'p',task:'one',permit:retry.permit});await f.ws.releaseRun(run.run);
  assert.equal(fs.readFileSync(path.join(first.dir,'.env'),'utf8'),destination);assert.equal(fs.readFileSync(path.join(f.base,'.env'),'utf8'),source);
  assert.equal(work('status','--porcelain'),'');
});
win('GitHub existing-run exception requires exact source baseline and a private consecutive task-write receipt',{timeout:600000},async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.base,'ordinary.txt'),'source baseline\n');const ready=await f.apply(await f.ws.preview('p','one'));assert.equal(ready.ok,true,ready.error);
  const run=await f.ws.consumeRun({project:'p',task:'one',permit:ready.permit});assert.equal((await f.ws.verifiedBinding('p','one',{verifySource:true})).run,run.run);
  fs.writeFileSync(path.join(ready.dir,'ordinary.txt'),'authorized Work result\n');assert.equal((await f.ws.verifiedBinding('p','one',{verifySource:true})).run,run.run);
  const before=f.d.taskHash;f.d.taskHash='synthetic-controller-write-v2';await assert.rejects(f.ws.verifiedBinding('p','one',{verifySource:true}),/連續metadata收據/);
  assert.throws(()=>f.ws.advanceTaskMetadata({project:'p',task:'one',run:run.run,beforeHash:'unreviewed',afterHash:f.d.taskHash}),/連續/);
  f.ws.advanceTaskMetadata({project:'p',task:'one',run:run.run,beforeHash:before,afterHash:f.d.taskHash});assert.equal(f.ws.metadataBinding('p','one').taskHash,f.d.taskHash);
  assert.equal((await f.ws.verifiedBinding('p','one',{verifySource:true})).run,run.run);
  fs.writeFileSync(path.join(f.base,'ordinary.txt'),'changed source\n');assert.equal((await f.ws.verifiedBinding('p','one')).run,run.run);await assert.rejects(f.ws.verifiedBinding('p','one',{verifySource:true}),/來源基線/);assert.equal(f.ws.binding('p','one').run,run.run);
  await assert.rejects(f.ws.verifiedBinding('p','one',{verifySource:'yes'}),/選項/);await f.ws.releaseRun(run.run);
});


function recordFixture(t){
  const f=fixture(t),digest='a'.repeat(64);
  const r={version:1,id:require('node:crypto').randomUUID(),at:new Date().toISOString(),project:'p',task:'one',title:'Synthetic record',taskHash:'t',base:f.base,workRoot:f.d.workRoot,mode:'isolated',kind:'non-git',original:{head:null,allContent:digest},execution:{configHash:digest,hooks:[],blockers:[]},secrets:{rootFingerprint:digest,files:[]},trackedSecrets:[],supplied:[],state:'planned',complete:false,error:''};
  return {...f,r,file:f.ws.file('p','one')};
}
test('workspace save retries sharing violations then persists the complete record',t=>{
  const f=recordFixture(t),rename=fs.renameSync;let count=0;
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.file&&++count<3)throw Object.assign(Error('PRIVATE_RENAME_PATH'),{code:'EPERM'});return rename(a,b);});
  f.ws.save(f.r);assert.equal(count,3);assert.deepEqual(f.ws.read('p','one'),f.r);assert.deepEqual(fs.readdirSync(f.ws.records).filter(x=>x.endsWith('.tmp')),[]);
});
test('workspace failed rename, write and fsync preserve old data, remove tmp and expose only safe error',t=>{
  const f=recordFixture(t);f.ws.save(f.r);const before=fs.readFileSync(f.file),rename=fs.renameSync,write=fs.writeFileSync,sync=fs.fsyncSync;let stage='rename',attempts=0;
  t.mock.method(Atomics,'wait',()=> 'timed-out');
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.file&&stage==='rename'){attempts++;throw Object.assign(Error('EPERM private path '+a),{code:'EPERM'});}return rename(a,b);});
  t.mock.method(fs,'writeFileSync',(fd,...args)=>{if(typeof fd==='number'&&stage==='write'){write(fd,'partial');throw Object.assign(Error('private'),{code:'EIO'});}return write(fd,...args);});
  t.mock.method(fs,'fsyncSync',fd=>{if(stage==='fsync')throw Object.assign(Error('private'),{code:'EIO'});return sync(fd);});
  for(stage of ['rename','write','fsync']){
    assert.throws(()=>f.ws.save({...f.r,title:'new'}),e=>{assert.equal(e.code,'WORKSPACE_RECORD_WRITE_FAILED');assert.equal(e.status,503);assert.equal(Object.getOwnPropertyDescriptor(e,'cause').enumerable,false);assert.doesNotMatch(e.message,/EPERM|private/);assert.doesNotMatch(JSON.stringify(e),/EPERM|private/);return true;});
    assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(fs.readdirSync(f.ws.records).filter(x=>x.endsWith('.tmp')),[]);
  }
  assert.equal(attempts,8);
});
test('post-rename fsync-open failure retries but cannot turn a durable save into a failure',t=>{
  const f=recordFixture(t),open=fs.openSync;let calls=0;
  t.mock.method(Atomics,'wait',()=> 'timed-out');t.mock.method(fs,'openSync',(file,flags,...rest)=>{if(file===f.file&&flags==='r+'){calls++;throw Object.assign(Error('PRIVATE'),{code:'EACCES'});}return open(file,flags,...rest);});
  assert.doesNotThrow(()=>f.ws.save(f.r));assert.equal(calls,8);assert.deepEqual(f.ws.read('p','one'),f.r);
});
test('stale tmp cleanup is one-shot, exact-name, age-bound, regular files only and nonrecursive',t=>{
  const f=recordFixture(t);fs.mkdirSync(f.ws.records,{recursive:true});const uuid=()=>require('node:crypto').randomUUID(),name=()=> 'a'.repeat(64)+'.json.'+uuid()+'.tmp',old=path.join(f.ws.records,name()),fresh=path.join(f.ws.records,name()),other=path.join(f.ws.records,'unrelated.tmp'),dir=path.join(f.ws.records,name());
  for(const file of [old,fresh,other])fs.writeFileSync(file,'synthetic');fs.mkdirSync(dir);const nested=path.join(dir,name());fs.writeFileSync(nested,'nested');
  const past=new Date(Date.now()-700000);for(const file of [old,other,dir,nested])fs.utimesSync(file,past,past);
  f.ws.save(f.r);assert.equal(fs.existsSync(old),false);for(const file of [fresh,other,dir,nested])assert.equal(fs.existsSync(file),true);
  fs.writeFileSync(old,'late');fs.utimesSync(old,past,past);f.ws.save(f.r);assert.equal(fs.existsSync(old),true);
});

test('sync and async save distinguish sharing errors from system errno without leaking paths',async t=>{
  for(const method of ['save','saveAsync'])for(const code of ['EPERM','EACCES','EBUSY','ENOSPC','ENOENT','EINVAL','EROFS','EIO','EIO private C:\\secret'])await t.test(method+' '+code,async sub=>{
    const f=recordFixture(sub);await f.ws[method](f.r);const before=fs.readFileSync(f.file),rename=fs.renameSync;let calls=0;
    sub.mock.method(Atomics,'wait',()=> 'timed-out');
    sub.mock.method(fs,'renameSync',(a,b)=>{if(b===f.file){calls++;throw Object.assign(Error('PRIVATE '+a),{code});}return rename(a,b);});
    const sharing=['EPERM','EACCES','EBUSY'].includes(code);
    await assert.rejects(async()=>f.ws[method]({...f.r,title:'replacement'}),e=>{
      assert.equal(e.code,'WORKSPACE_RECORD_WRITE_FAILED');assert.equal(e.status,503);
      if(sharing)assert.match(e.message,/防毒/);
      else assert.equal(e.message,`工作區紀錄無法寫入（系統錯誤 ${/^E[A-Z0-9_]+$/.test(code)?code:'UNKNOWN'}）；請檢查磁碟空間與資料夾權限。`);
      assert.doesNotMatch(e.message,/PRIVATE|secret|[A-Za-z]:[\\/]/);return true;
    });
    assert.equal(calls,sharing?8:1);assert.deepEqual(fs.readFileSync(f.file),before);
    assert.deepEqual(fs.readdirSync(f.ws.records).filter(x=>x.endsWith('.tmp')),[]);
  });
});
test('async save yields between sharing retries, cleans stale tmp, and persists complete record',async t=>{
  const f=recordFixture(t),rename=fs.renameSync;let calls=0,ticked=false;
  fs.mkdirSync(f.ws.records,{recursive:true});const stale=f.file+'.'+require('node:crypto').randomUUID()+'.tmp';fs.writeFileSync(stale,'old');const past=new Date(Date.now()-700000);fs.utimesSync(stale,past,past);
  t.mock.method(Atomics,'wait',()=>assert.fail('async save must not block'));
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f.file){if(++calls===1)throw Object.assign(Error('private'),{code:'EBUSY'});assert.equal(ticked,true);}return rename(a,b);});
  const timer=setTimeout(()=>{ticked=true;},0);t.after(()=>clearTimeout(timer));await f.ws.saveAsync(f.r);
  assert.equal(calls,2);assert.deepEqual(f.ws.read('p','one'),f.r);assert.equal(fs.existsSync(stale),false);
  assert.deepEqual(fs.readdirSync(f.ws.records).filter(x=>x.endsWith('.tmp')),[]);
});
test('async post-rename open exhaustion keeps durable record successful',async t=>{
  const f=recordFixture(t),open=fs.openSync;let calls=0;
  t.mock.method(fs,'openSync',(file,flags,...rest)=>{if(file===f.file&&flags==='r+'){calls++;throw Object.assign(Error('private'),{code:'EACCES'});}return open(file,flags,...rest);});
  t.mock.method(Atomics,'wait',()=>assert.fail('async open must not block'));await f.ws.saveAsync(f.r);
  assert.equal(calls,8);assert.deepEqual(f.ws.read('p','one'),f.r);
});
test('both save APIs rethrow uncoded errors unchanged and reject invalid records before writing',async t=>{
  for(const method of ['save','saveAsync'])await t.test(method,async sub=>{
    const f=recordFixture(sub),sentinel=Error('synthetic uncoded failure');
    await assert.rejects(async()=>f.ws[method]({...f.r,state:'invalid'}),/格式無效/);
    assert.equal(fs.existsSync(f.ws.records),false);
    sub.mock.method(fs,'writeFileSync',()=>{throw sentinel;});
    await assert.rejects(async()=>f.ws[method](f.r),e=>e===sentinel);
    assert.deepEqual(fs.readdirSync(f.ws.records).filter(x=>x.endsWith('.tmp')),[]);
  });
});

win('raw content and index visibility still reject a deep junction with per-pass ancestor checks',t=>{
 const f=fixture(t),deep=path.join(f.base,'one/two/three'),outside=path.join(f.root,'outside');fs.mkdirSync(deep,{recursive:true});fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'x'),'outside');fs.symlinkSync(outside,path.join(deep,'linked'),'junction');
 assert.throws(()=>git.rawContent(f.base),/junction|symlink/);
 const policy=require('../lib/git-policy'),record=Buffer.from('H 100644 '+'a'.repeat(40)+' 0\tone/two/three/linked/x\0');
 // Real metadata guard also refuses the nested junction before hash-object.
 f.cmd('init','-q');assert.throws(()=>policy.assertIndexVisible(f.base,record),/junction|symlink|連結/);
});
