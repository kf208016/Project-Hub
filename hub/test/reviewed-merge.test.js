'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawn,spawnSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {ReviewedMerge}=require('../lib/reviewed-merge'),gitw=require('../lib/git'),policy=require('../lib/git-policy');
function fixture(t,{attributes}={}) {
  const testTmp=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(testTmp,'hub-reviewed-merge-')),repo=path.join(root,'repo'),workRoot=path.join(root,'Work','P');
  fs.mkdirSync(repo);const env={...policy.environment(),GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
  const cmd=(dir,...args)=>execFileSync('git',['-c','core.autocrlf=false','-C',dir,...args],{env,encoding:'utf8',stdio:'pipe'}).trim();
  cmd(repo,'init','-q');cmd(repo,'config','user.name','Fixture');cmd(repo,'config','user.email','fixture@example.test');cmd(repo,'config','core.autocrlf','false');
  t.after(()=>{assert.ok(root.startsWith(testTmp+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
  fs.writeFileSync(path.join(repo,'a.txt'),'base\n');if(attributes!==undefined)fs.writeFileSync(path.join(repo,'.gitattributes'),attributes);cmd(repo,'add','-A');cmd(repo,'commit','-qm','initial');
  const source=gitw.prepare({base:repo,workRoot,taskId:'one'}).dir;
  const context={project:'P',task:'one',title:'Synthetic change',taskHash:'initial-task',dir:source,workRoot,target:repo};
  const merge=new ReviewedMerge({root,resolve:(p,q)=>({...context,project:p,task:q})});
  return {root,repo,source,workRoot,context,merge,cmd,change:(text='result\n')=>fs.writeFileSync(path.join(source,'b.txt'),text),apply:pv=>merge.apply({project:'P',task:'one',token:pv.token,confirm:true})};
}

for(const flag of ['assume-unchanged','skip-worktree'])test('Windows refuses hidden index changes and late '+flag+' without saving or cleanup',{skip:process.platform!=='win32',timeout:300000},async t=>{
  const f=fixture(t),file=path.join(f.source,'a.txt'),originalSource=f.cmd(f.source,'rev-parse','HEAD'),originalTarget=f.cmd(f.repo,'rev-parse','HEAD');
  f.cmd(f.source,'update-index','--'+flag,'a.txt');fs.writeFileSync(file,'SYNTHETIC_HIDDEN_APPROVED_BYTES\n');assert.equal(f.cmd(f.source,'status','--porcelain'),'');
  await assert.rejects(f.merge.previewAsync('P','one'),/assume-unchanged／skip-worktree/);assert.throws(()=>gitw.save(f.source,'must not save hidden bytes'),/assume-unchanged／skip-worktree/);
  assert.equal(f.cmd(f.source,'rev-parse','HEAD'),originalSource);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),originalTarget);assert.equal(fs.readFileSync(file,'utf8'),'SYNTHETIC_HIDDEN_APPROVED_BYTES\n');assert.match(f.cmd(f.source,'ls-files','-v'),flag==='assume-unchanged'?/^h /:/^S /);
  f.cmd(f.source,'update-index','--no-'+flag,'a.txt');const preview=await f.merge.previewAsync('P','one');assert.equal(preview.dirty,true);
  f.cmd(f.source,'update-index','--'+flag,'a.txt');await assert.rejects(f.merge.applyAsync({project:'P',task:'one',token:preview.token,confirm:true}),/assume-unchanged／skip-worktree/);assert.ok(fs.existsSync(f.source));assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),originalTarget);assert.equal(f.merge.read('P','one'),null);
  f.cmd(f.source,'update-index','--no-'+flag,'a.txt');f.cmd(f.repo,'update-index','--'+flag,'a.txt');assert.throws(()=>gitw.prepare({base:f.repo,workRoot:f.workRoot,taskId:'unapproved'}),/assume-unchanged／skip-worktree/);assert.equal(fs.existsSync(path.join(f.workRoot,'unapproved')),false);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),originalTarget);
});

test('Windows refuses content hidden by stat cache even beside a visible modification',{skip:process.platform!=='win32',timeout:300000},async t=>{
  const f=fixture(t),file=path.join(f.source,'a.txt'),original=fs.statSync(file),head=f.cmd(f.repo,'rev-parse','HEAD');f.cmd(f.source,'config','core.trustctime','false');f.cmd(f.source,'config','core.checkStat','minimal');await new Promise(resolve=>setTimeout(resolve,1200));f.cmd(f.source,'update-index','--really-refresh');fs.writeFileSync(file,'evil\n');fs.utimesSync(file,original.atime,original.mtime);assert.equal(f.cmd(f.source,'status','--porcelain'),'');assert.equal(f.cmd(f.source,'ls-files','-v'),'H a.txt');
  await assert.rejects(f.merge.previewAsync('P','one'),/index cache 隱藏/);assert.throws(()=>gitw.save(f.source,'not permitted'),/index cache 隱藏/);f.change('visible addition\n');await assert.rejects(f.merge.previewAsync('P','one'),/index cache 隱藏/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(file,'utf8'),'evil\n');assert.ok(fs.existsSync(f.source));assert.equal(f.merge.read('P','one'),null);
  // Manual force-rehash makes the genuine staged change visible without
  // replacing the user's settings; ordinary reviewed work can continue.
  fs.writeFileSync(path.join(f.source,'台灣 合成.txt'),'SYNTHETIC_UNICODE_WORK\n');f.cmd(f.source,'add','--renormalize','a.txt');const resumed=await f.merge.previewAsync('P','one');assert.equal(resumed.dirty,true);assert.equal(f.cmd(f.source,'config','core.trustctime'),'false');assert.equal(f.cmd(f.source,'config','core.checkStat'),'minimal');
  const result=await f.merge.applyAsync({project:'P',task:'one',token:resumed.token,confirm:true});assert.equal(result.ok,true,result.error);assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),'evil\n');assert.equal(fs.readFileSync(path.join(f.repo,'b.txt'),'utf8'),'visible addition\n');assert.equal(fs.readFileSync(path.join(f.repo,'台灣 合成.txt'),'utf8'),'SYNTHETIC_UNICODE_WORK\n');assert.equal(fs.existsSync(f.source),false);assert.equal(fs.readFileSync(path.join(result.trashed,'a.txt'),'utf8'),'evil\n');assert.equal(f.cmd(result.trashed,'config','core.trustctime'),'false');assert.equal(f.cmd(result.trashed,'config','core.checkStat'),'minimal');
});
test('reviewed merge saves dirty sides, journals receipt before reversible cleanup and retains branch',t=>{
  const f=fixture(t);f.change();fs.writeFileSync(path.join(f.repo,'parent.txt'),'parent\n');fs.writeFileSync(path.join(f.source,'.env'),'SYNTHETIC_NOT_A_SECRET');
  const pv=f.merge.preview('P','one');assert.equal(pv.dirty,true);assert.equal(pv.conflictUnknown,true);assert.equal(pv.files,1);assert.deepEqual(pv.paths,['b.txt']);assert.deepEqual(pv.notStagedSecrets,['.env']);
  const out=f.apply(pv);assert.equal(out.ok,true,out.error);assert.deepEqual(out.files,['b.txt']);assert.ok(out.recordId);assert.ok(!fs.existsSync(f.source));assert.ok(fs.existsSync(out.trashed));
  assert.equal(fs.readFileSync(path.join(f.repo,'b.txt'),'utf8'),'result\n');assert.equal(fs.readFileSync(path.join(f.repo,'parent.txt'),'utf8'),'parent\n');assert.ok(!f.cmd(f.repo,'ls-tree','-r','--name-only','HEAD').includes('.env'));
  assert.equal(f.merge.receipt('P','one').commit,out.commit);assert.ok(f.cmd(f.repo,'branch','--list','hub/*'));
  assert.ok(f.cmd(out.trashed,'rev-parse','HEAD'));assert.throws(()=>f.apply(pv),/重新預覽/);
});
test('native deferred hierarchy merges advance only an exact confirmed target receipt and verify repaired directory identity',{skip:process.platform!=='win32',timeout:600000},async t=>{const f=fixture(t);f.change('first approved\n');const second=gitw.prepare({base:f.repo,workRoot:f.workRoot,taskId:'two'}).dir;fs.writeFileSync(path.join(second,'c.txt'),'second approved\n');f.merge.deferCleanup=true;f.merge.resolve=(p,task)=>({...f.context,project:p,task,dir:task==='two'?second:f.source});const p1=await f.merge.previewAsync('P','one'),p2=await f.merge.previewAsync('P','two');const first=await f.merge.applyAsync({project:'P',task:'one',token:p1.token,confirm:true});assert.equal(first.ok,true,first.error);assert.equal(first.merged,true);assert.equal(fs.existsSync(f.source),true);fs.writeFileSync(path.join(f.repo,'a.txt'),'unapproved target\n');assert.throws(()=>f.merge.advanceTarget(p2.token,first.recordId),/精確結果/);fs.writeFileSync(path.join(f.repo,'a.txt'),'base\n');f.merge.advanceTarget(p2.token,first.recordId);const next=await f.merge.applyAsync({project:'P',task:'two',token:p2.token,confirm:true});assert.equal(next.ok,true,next.error);assert.equal(next.merged,true);const cleaned=await f.merge.cleanupAsync('P','one');assert.equal(cleaned.ok,true,cleaned.error);assert.equal((await f.merge.receiptAsync('P','one')).recordId,first.recordId);const old=cleaned.trashed+'-old';fs.renameSync(cleaned.trashed,old);fs.mkdirSync(cleaned.trashed);for(const name of fs.readdirSync(old))fs.renameSync(path.join(old,name),path.join(cleaned.trashed,name));await assert.rejects(f.merge.receiptAsync('P','one'),/FileID.*已變更/);assert.equal((await f.merge.cleanupAsync('P','two')).ok,true);});
test('source bytes, target bytes, task hash, expiration and cross-task replay require a fresh preview',t=>{
  const f=fixture(t);f.change();let pv=f.merge.preview('P','one');f.change('changed');assert.throws(()=>f.apply(pv),/內容已變更/);
  pv=f.merge.preview('P','one');fs.writeFileSync(path.join(f.repo,'a.txt'),'target change');assert.throws(()=>f.apply(pv),/內容已變更/);
  pv=f.merge.preview('P','one');f.context.taskHash='other';assert.throws(()=>f.apply(pv),/作業內容已變更/);
  pv=f.merge.preview('P','one');assert.throws(()=>f.merge.apply({project:'P',task:'two',token:pv.token,confirm:true}),/重新預覽/);
  const clock={at:1000};f.merge.now=()=>clock.at;pv=f.merge.preview('P','one');clock.at+=600001;assert.throws(()=>f.apply(pv),/重新預覽/);assert.ok(fs.existsSync(f.source));
});
test('Windows snapshot rejects changed stage blobs with identical status and working bytes',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t),file=path.join(f.source,'a.txt');
  fs.writeFileSync(file,'stage version one\n');f.cmd(f.source,'add','a.txt');fs.writeFileSync(file,'working version\n');
  const pv=f.merge.preview('P','one'),head=f.cmd(f.repo,'rev-parse','HEAD');
  const staged=execFileSync('git',['-C',f.source,'hash-object','-w','--stdin'],{env:policy.environment(),input:'stage version two\n',encoding:'utf8'}).trim();
  f.cmd(f.source,'update-index','--cacheinfo','100644,'+staged+',a.txt');
  const changed=f.merge.inspect(f.source);assert.equal(changed.status,pv.source.status);assert.equal(changed.allContent,pv.source.allContent);assert.notEqual(changed.content,pv.source.content);
  assert.throws(()=>f.apply(pv),/內容已變更/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),head);assert.ok(fs.existsSync(f.source));
});
test('Windows snapshot binds normalized working bytes even when Git status stays clean',{skip:process.platform!=='win32'},t=>{
  // Explicit text attributes make this independent of inherited autocrlf
  // fixture overrides and the user's global Git settings.
  const f=fixture(t,{attributes:'*.txt text\n'}),file=path.join(f.source,'a.txt');fs.writeFileSync(file,'base\r\n');f.cmd(f.source,'add','a.txt');
  const pv=f.merge.preview('P','one'),head=f.cmd(f.repo,'rev-parse','HEAD');assert.equal(pv.source.status,'');fs.writeFileSync(file,'base\n');f.cmd(f.source,'add','a.txt');
  const changed=f.merge.inspect(f.source);assert.equal(changed.status,pv.source.status);assert.notEqual(changed.allContent,pv.source.allContent);
  assert.throws(()=>f.apply(pv),/內容已變更/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),head);
});
test('Windows snapshot rejects ignored and untracked byte changes and changed HEAD',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.source,'.gitignore'),'ignored.bin\n');f.cmd(f.source,'add','.gitignore');f.cmd(f.source,'commit','-qm','ignore fixture');
  fs.writeFileSync(path.join(f.source,'ignored.bin'),Buffer.from([0,1,255]));f.change('untracked one\n');const head=f.cmd(f.repo,'rev-parse','HEAD');
  let pv=f.merge.preview('P','one');fs.writeFileSync(path.join(f.source,'ignored.bin'),Buffer.from([0,2,255]));assert.equal(f.merge.inspect(f.source).status,pv.source.status);assert.throws(()=>f.apply(pv),/內容已變更/);
  pv=f.merge.preview('P','one');f.change('untracked two\n');assert.equal(f.merge.inspect(f.source).status,pv.source.status);assert.throws(()=>f.apply(pv),/內容已變更/);
  pv=f.merge.preview('P','one');f.cmd(f.source,'commit','--allow-empty','-qm','new fixture HEAD');assert.throws(()=>f.apply(pv),/內容已變更/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),head);assert.ok(fs.existsSync(f.source));
});
test('busy and an inter-Hub repo lock reject before Git mutation',t=>{
  const f=fixture(t);f.change();const before=f.cmd(f.repo,'rev-parse','HEAD');f.merge.busy=()=>true;assert.throws(()=>f.merge.preview('P','one'),/AI/);f.merge.busy=()=>false;
  const pv=f.merge.preview('P','one'),other=new ReviewedMerge({root:f.root,resolve:()=>f.context}),release=other.lock(f.repo,'00000000-0000-4000-8000-000000000000',false);
  assert.ok(f.merge.locked(f.repo));assert.throws(()=>f.apply(pv),/其他 Hub/);release();assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),before);assert.ok(fs.existsSync(f.source));
});
test('real conflicting Git merge leaves source and clean target with explicit partial state',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.source,'a.txt'),'source\n');f.cmd(f.source,'commit','-qam','source');fs.writeFileSync(path.join(f.repo,'a.txt'),'target\n');f.cmd(f.repo,'commit','-qam','target');
  const pv=f.merge.preview('P','one');assert.equal(pv.conflict,true);const out=f.apply(pv);assert.equal(out.ok,false);assert.equal(out.conflict,true);assert.equal(out.state,'conflict');assert.ok(fs.existsSync(f.source));assert.equal(f.cmd(f.repo,'status','--porcelain'),'');assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),'target\n');
  f.cmd(f.source,'merge','-s','ours','--no-edit',f.cmd(f.repo,'rev-parse','HEAD'));const again=f.merge.preview('P','one');assert.equal(again.resume,true);assert.equal(again.conflict,false);assert.equal(f.apply(again).ok,true);
});
test('journal failure before first mutation leaves both HEADs and source unchanged',t=>{
  const f=fixture(t);f.change();const source=f.cmd(f.source,'rev-parse','HEAD'),target=f.cmd(f.repo,'rev-parse','HEAD'),pv=f.merge.preview('P','one');
  f.merge.save=()=>{throw Error('synthetic disk failure');};const out=f.apply(pv);assert.equal(out.ok,false);assert.equal(out.partial,false);assert.match(out.journalError,/disk failure/);assert.equal(f.cmd(f.source,'rev-parse','HEAD'),source);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),target);assert.ok(fs.existsSync(f.source));
});
test('cleanup failure retains merged proof and a new confirmation resumes without another merge',t=>{
  const f=fixture(t);f.change();const move=f.merge.move;f.merge.move=()=>{throw Error('synthetic rename failure');};const out=f.apply(f.merge.preview('P','one'));assert.equal(out.ok,false);assert.equal(out.state,'cleanup-planned');assert.ok(fs.existsSync(f.source));const merged=f.cmd(f.repo,'rev-parse','HEAD');
  assert.equal(f.merge.recovery('P','one').complete,false);f.merge.move=move;const pv=f.merge.preview('P','one');assert.equal(pv.resume,true);const again=f.apply(pv);assert.equal(again.ok,true,again.error);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),merged);
});
test('interruption after cleanup move is recovered from durable intent and content',t=>{
  const f=fixture(t);f.change();const save=f.merge.save.bind(f.merge);f.merge.save=r=>{if(r.state==='cleanup-moved')throw Error('synthetic crash after move');save(r);};const out=f.apply(f.merge.preview('P','one'));assert.equal(out.ok,false);assert.ok(!fs.existsSync(f.source));
  const resumed=new ReviewedMerge({root:f.root,resolve:()=>f.context});const pv=resumed.preview('P','one');assert.equal(pv.resume,true);assert.equal(pv.source,null);const done=resumed.apply({project:'P',task:'one',token:pv.token,confirm:true});assert.equal(done.ok,true,done.error);
  f.context.taskHash='metadata-after-update';const final=resumed.preview('P','one');assert.equal(resumed.apply({project:'P',task:'one',token:final.token,confirm:true}).ok,true);
  fs.mkdirSync(f.source);fs.writeFileSync(path.join(f.source,'new.txt'),'new source');assert.throws(()=>resumed.preview('P','one'));assert.ok(fs.existsSync(path.join(f.source,'new.txt')));
});
test('merge success evidence save failure preserves source and can recover via unique merge marker',t=>{
  const f=fixture(t);f.change();const save=f.merge.save.bind(f.merge);f.merge.save=r=>{if(r.state==='merged')throw Error('synthetic receipt save failure');save(r);};const out=f.apply(f.merge.preview('P','one'));assert.equal(out.ok,false);assert.ok(fs.existsSync(f.source));
  const again=new ReviewedMerge({root:f.root,resolve:()=>f.context});assert.equal(again.apply({project:'P',task:'one',token:again.preview('P','one').token,confirm:true}).ok,true);
});
test('effective hooks require separate bound skip confirmation and run neither during preview nor prepare',t=>{
  const f=fixture(t);f.change();const marker=path.join(f.root,'hook-ran'),hook=path.join(f.repo,'.git','hooks','post-checkout');fs.writeFileSync(hook,'#!/bin/sh\nprintf x > "'+marker.replace(/\\/g,'/')+'"\n');fs.chmodSync(hook,0o755);
  const empty=path.join(f.root,'empty-hooks');fs.mkdirSync(empty);f.cmd(f.repo,'config','--add','core.hooksPath',empty);f.cmd(f.repo,'config','--add','core.hooksPath',path.dirname(hook));
  assert.throws(()=>gitw.prepare({base:f.repo,workRoot:f.workRoot,taskId:'two'}),/hooks/);assert.ok(!fs.existsSync(marker));
  let pv=f.merge.preview('P','one');assert.equal(pv.gitExecution.requiresSkipHooksConfirmation,true);assert.throws(()=>f.apply(pv),/另行明確/);
  pv=f.merge.preview('P','one');fs.appendFileSync(hook,'# changed\n');assert.throws(()=>f.merge.apply({project:'P',task:'one',token:pv.token,confirm:true,skipHooks:true}),/hooks 已變更/);
  pv=f.merge.preview('P','one');const out=f.merge.apply({project:'P',task:'one',token:pv.token,confirm:true,skipHooks:true});assert.equal(out.ok,true,out.error);assert.ok(!fs.existsSync(marker));assert.equal(f.cmd(f.repo,'config','--get','core.hooksPath'),path.dirname(hook));
});
test('external filters/drivers and signature requirements reject; fsmonitor and hostile Git env never execute',t=>{
  const f=fixture(t),marker=path.join(f.root,'helper-ran');f.change();const helper='echo x > "'+marker.replace(/\\/g,'/')+'"';
  f.cmd(f.repo,'config','filter.synthetic.clean',helper);fs.writeFileSync(path.join(f.repo,'.gitattributes'),'*.txt filter=synthetic\n');assert.throws(()=>f.merge.preview('P','one'),/外部程式/);assert.throws(()=>gitw.prepare({base:f.repo,workRoot:f.workRoot,taskId:'filtered'}),/外部程式/);assert.ok(!fs.existsSync(marker));f.cmd(f.repo,'config','--unset','filter.synthetic.clean');
  f.cmd(f.repo,'config','filter.Danger.clean',helper);fs.writeFileSync(path.join(f.repo,'.gitattributes'),'*.txt filter=Danger\n');assert.throws(()=>f.merge.preview('P','one'),/filter.Danger.clean/);assert.throws(()=>gitw.save(f.repo,'refuse case-sensitive helper'),/filter.Danger.clean/);assert.ok(!fs.existsSync(marker));f.cmd(f.repo,'config','--unset','filter.Danger.clean');
  f.cmd(f.repo,'config','filter.set.clean',helper);fs.writeFileSync(path.join(f.repo,'.gitattributes'),'*.txt filter=set\n');assert.throws(()=>f.merge.preview('P','one'),/filter.set.clean/);assert.ok(!fs.existsSync(marker));f.cmd(f.repo,'config','--unset','filter.set.clean');
  f.cmd(f.repo,'config','merge.synthetic.driver',helper);fs.writeFileSync(path.join(f.repo,'.gitattributes'),'*.txt merge=synthetic\n');assert.throws(()=>f.merge.preview('P','one'),/外部程式/);f.cmd(f.repo,'config','--unset','merge.synthetic.driver');
  f.cmd(f.repo,'config','merge.Danger.driver',helper);fs.writeFileSync(path.join(f.repo,'.gitattributes'),'*.txt merge=Danger\n');assert.throws(()=>f.merge.preview('P','one'),/merge.Danger.driver/);assert.ok(!fs.existsSync(marker));f.cmd(f.repo,'config','--unset','merge.Danger.driver');
  f.cmd(f.repo,'config','commit.gpgsign','true');assert.throws(()=>f.merge.preview('P','one'),/可信簽章/);f.cmd(f.repo,'config','commit.gpgsign','false');
  const monitor=path.join(f.root,'fsmonitor.sh');fs.writeFileSync(monitor,'#!/bin/sh\n'+helper+'\n');fs.chmodSync(monitor,0o755);f.cmd(f.repo,'config','core.fsmonitor',monitor);assert.equal(gitw.dirty(f.repo),true);assert.ok(!fs.existsSync(marker));
  const old=process.env.GIT_DIR;process.env.GIT_DIR=path.join(f.root,'foreign.git');try{assert.equal(path.resolve(gitw.repoTop(f.repo)).toLowerCase(),f.repo.toLowerCase());}finally{if(old===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=old;}
});
test('same-id journal path/content changes and malformed records reject before any foreign Git write',t=>{
  const f=fixture(t);f.change();const before=f.cmd(f.repo,'rev-parse','HEAD'),pv=f.merge.preview('P','one'),r={version:1,id:randomUUID(),at:new Date().toISOString(),project:'P',task:'one',title:f.context.title,taskHash:f.context.taskHash,source:f.source,target:f.repo,workRoot:f.workRoot,state:'planned',complete:false,files:[],error:'',sourceOriginal:pv.source,targetOriginal:pv.target,gitExecution:pv.gitExecution,skipHooks:false};f.merge.save(r);
  let resume=f.merge.preview('P','one');r.error='changed journal';f.merge.save(r);assert.throws(()=>f.apply(resume),/恢復記錄已變更/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),before);
  resume=f.merge.preview('P','one');const foreign=path.join(f.root,'foreign');fs.mkdirSync(foreign);f.cmd(foreign,'init','-q');f.cmd(foreign,'commit','--allow-empty','-qm','foreign');const foreignHead=f.cmd(foreign,'rev-parse','HEAD');fs.writeFileSync(path.join(foreign,'do-not-commit.txt'),'synthetic');r.target=foreign;f.merge.save(r);assert.throws(()=>f.apply(resume),/恢復記錄已變更/);assert.throws(()=>f.merge.preview('P','one'),/記錄不同/);assert.equal(f.cmd(foreign,'rev-parse','HEAD'),foreignHead);
  r.target=f.repo;r.at='invalid';fs.writeFileSync(path.join(f.merge.records,r.id+'.json'),JSON.stringify(r));assert.throws(()=>f.merge.read('P','one'),/記錄格式無效/);
});
test('concurrent reviewed stale-lock recovery admits one owner and removes its claim',async t=>{
  const f=fixture(t),recordId=randomUUID(),dead=spawnSync(process.execPath,['-e','process.exit(0)']),lock=f.merge.lockPath(f.repo),barrier=path.join(f.root,'begin'),releaseFile=path.join(f.root,'release-owner');
  assert.equal(dead.status,0);fs.writeFileSync(lock,JSON.stringify({version:1,pid:dead.pid,owner:randomUUID(),recordId,root:f.root,at:Date.now()}));
  const moduleFile=require.resolve('../lib/reviewed-merge');
  const code="const fs=require('node:fs');const {ReviewedMerge}=require(process.argv[1]);const d=JSON.parse(process.argv[2]);while(!fs.existsSync(d.barrier))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);const m=new ReviewedMerge({root:d.root,resolve:()=>d.context});try{const release=m.lock(d.repo,d.id,true);console.log('owned');setInterval(()=>{if(fs.existsSync(d.releaseFile)){release();process.exit(0)}},20);setTimeout(()=>process.exit(3),60000)}catch(e){console.log('blocked:'+e.message);process.exit(2)}";
  const input=JSON.stringify({root:f.root,repo:f.repo,id:recordId,context:f.context,barrier,releaseFile});
  const workers=[0,1].map(()=>spawn(process.execPath,['-e',code,moduleFile,input],{stdio:['ignore','pipe','pipe'],windowsHide:true}));
  const first=workers.map(child=>new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);}));
  const results=workers.map(child=>new Promise((resolve,reject)=>{let out='';child.stdout.on('data',x=>out+=x);child.on('error',reject);child.on('close',code=>resolve({code,out}));}));fs.writeFileSync(barrier,'go');await Promise.all(first);fs.writeFileSync(releaseFile,'release');const done=await Promise.all(results);
  assert.equal(done.filter(x=>x.code===0).length,1,JSON.stringify(done));assert.equal(done.filter(x=>x.code===2).length,1,JSON.stringify(done));assert.ok(!fs.existsSync(lock));assert.ok(!fs.existsSync(lock+'.recovery-claim'));
});
test('same-branch worktree and an abandoned recovery claim block without writing Git refs',t=>{
  const f=fixture(t),before=f.cmd(f.repo,'rev-parse','HEAD'),sameBranch=path.join(f.workRoot,'same'),branch=f.cmd(f.repo,'rev-parse','--abbrev-ref','HEAD');f.cmd(f.repo,'worktree','add','--force',sameBranch,branch);f.context.dir=sameBranch;assert.throws(()=>f.merge.preview('P','one'),/共用同一個 branch/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),before);
  f.context.dir=f.source;const claim=f.merge.lockPath(f.repo)+'.recovery-claim';fs.writeFileSync(claim,'abandoned synthetic claim');assert.equal(f.merge.locked(f.repo),true);assert.throws(()=>f.merge.lock(f.repo,randomUUID(),true),/遺留 claim/);assert.equal(fs.readFileSync(claim,'utf8'),'abandoned synthetic claim');
});
test('target change during source save rejects before target mutation and leaves recoverable partial source state',t=>{
  const f=fixture(t);f.change();const before=f.cmd(f.repo,'rev-parse','HEAD'),save=f.merge.save.bind(f.merge);let changed=false;
  f.merge.save=r=>{if(r.state==='source-saved'&&!changed){changed=true;fs.writeFileSync(path.join(f.repo,'manual-change.txt'),'synthetic edit during source save');}save(r);};
  const out=f.apply(f.merge.preview('P','one'));assert.equal(out.ok,false);assert.equal(out.partial,true);assert.equal(out.state,'source-saved');assert.match(out.error,/目標已變更/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),before);assert.ok(fs.existsSync(f.source));assert.ok(out.sourceHead);assert.equal(out.targetSavedHead,null);
});
test('source edit during saving is detected, keeps source and does not merge into target',t=>{
  const f=fixture(t);f.change();const before=f.cmd(f.repo,'rev-parse','HEAD'),save=f.merge.saveChanges.bind(f.merge);let changed=false;
  f.merge.saveChanges=(dir,message,skip)=>{if(dir===f.source&&!changed){changed=true;f.change('synthetic edit during save');}return save(dir,message,skip);};
  const out=f.apply(f.merge.preview('P','one'));assert.equal(out.ok,false);assert.equal(out.state,'source-saving');assert.equal(out.partial,true);assert.match(out.error,/保存來源時檔案內容已變更/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),before);assert.ok(fs.existsSync(f.source));assert.equal(fs.existsSync(path.join(f.repo,'b.txt')),false);
});
test('target edit during saving reports its saved commit as partial and retains source',t=>{
  const f=fixture(t);f.change();fs.writeFileSync(path.join(f.repo,'parent.txt'),'synthetic original parent edit');const before=f.cmd(f.repo,'rev-parse','HEAD'),save=f.merge.saveChanges.bind(f.merge);let changed=false;
  f.merge.saveChanges=(dir,message,skip)=>{if(dir===f.repo&&!changed){changed=true;fs.writeFileSync(path.join(f.repo,'manual-during-save.txt'),'synthetic edit');}return save(dir,message,skip);};
  const out=f.apply(f.merge.preview('P','one'));assert.equal(out.ok,false);assert.equal(out.state,'target-saving');assert.equal(out.partial,true);assert.match(out.error,/保存目標時檔案內容已變更/);assert.notEqual(out.targetSavedHead,before);assert.equal(out.targetSavedHead,f.cmd(f.repo,'rev-parse','HEAD'));assert.ok(fs.existsSync(f.source));assert.equal(fs.existsSync(path.join(f.repo,'b.txt')),false);assert.ok(fs.existsSync(path.join(f.repo,'manual-during-save.txt')));
});
test('filename-based private-key exclusion and tracked secret rejection preserve actual targets',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t);f.change();const secret=path.join(f.source,'private.key');fs.writeFileSync(secret,'SYNTHETIC_PRIVATE_KEY_NOT_REAL');let pv=f.merge.preview('P','one');assert.deepEqual(pv.notStagedSecrets,['private.key']);const out=f.apply(pv);assert.equal(out.ok,true,out.error);assert.ok(!f.cmd(f.repo,'ls-tree','-r','--name-only','HEAD').includes('private.key'));assert.ok(fs.existsSync(path.join(out.trashed,'private.key')));
  fs.writeFileSync(path.join(f.repo,'.env'),'SYNTHETIC_OLD');f.cmd(f.repo,'add','.env');f.cmd(f.repo,'commit','-qm','manual synthetic tracked config');const before=f.cmd(f.repo,'rev-parse','HEAD');fs.writeFileSync(path.join(f.repo,'.env'),'SYNTHETIC_NEW');assert.throws(()=>gitw.save(f.repo,'not authorized'),/已追蹤/);assert.throws(()=>gitw.prepare({base:f.repo,workRoot:f.workRoot,taskId:'sensitive'}),/HEAD 已追蹤/);assert.equal(f.cmd(f.repo,'rev-parse','HEAD'),before);assert.ok(!fs.existsSync(path.join(f.workRoot,'sensitive')));
  const committed=fixture(t);fs.writeFileSync(path.join(committed.source,'private.key'),'SYNTHETIC_ALREADY_COMMITTED');committed.cmd(committed.source,'add','-A');committed.cmd(committed.source,'commit','-qm','manual synthetic source key');const targetBefore=committed.cmd(committed.repo,'rev-parse','HEAD');assert.throws(()=>committed.merge.preview('P','one'),/來源 commit 含可能機密/);assert.equal(committed.cmd(committed.repo,'rev-parse','HEAD'),targetBefore);assert.ok(fs.existsSync(committed.source));
});
test('merging attributes macros cannot silently activate a previously unused external helper',t=>{
  const f=fixture(t,{attributes:'# definitions\n\n# paths\n\n'}),marker=path.join(f.root,'macro-helper-ran');
  f.cmd(f.repo,'config','filter.synthetic.smudge','echo synthetic > "'+marker.replace(/\\/g,'/')+'"; cat');
  fs.writeFileSync(path.join(f.source,'.gitattributes'),'# definitions\n  [attr]Combo filter=synthetic\n# paths\n\n');f.change();f.cmd(f.source,'add','-A');f.cmd(f.source,'commit','-qm','source macro');
  fs.writeFileSync(path.join(f.repo,'.gitattributes'),'# definitions\n\n# paths\n*.txt Combo\n');f.cmd(f.repo,'add','-A');f.cmd(f.repo,'commit','-qm','target macro use');
  assert.deepEqual(policy.execution(f.source).blockers,[]);assert.deepEqual(policy.execution(f.repo).blockers,[]);assert.throws(()=>f.merge.preview('P','one'),/屬性宏/);assert.ok(!fs.existsSync(marker));
  // A separate, explicitly controlled Git call demonstrates the checkout
  // hazard in this disposable fixture; no Hub/user repository is touched.
  f.cmd(f.repo,'merge','--no-ff','--no-edit',f.cmd(f.source,'rev-parse','HEAD'));assert.ok(fs.existsSync(marker),'the synthetic direct Git control must demonstrate helper execution');
});
test('junction, ADS and UNC are rejected without touching real targets', {skip:process.platform!=='win32'},t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'synthetic');fs.symlinkSync(outside,path.join(f.source,'linked'),'junction');assert.throws(()=>f.merge.preview('P','one'),/連結|junction|symlink/);assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'synthetic');
  fs.unlinkSync(path.join(f.source,'linked'));f.context.dir=f.source+':stream';assert.throws(()=>f.merge.preview('P','one'),/ADS/);f.context.dir='\\\\localhost\\share\\test';assert.throws(()=>f.merge.preview('P','one'),/網路/);
});
