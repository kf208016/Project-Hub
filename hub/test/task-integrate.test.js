'use strict';
const nativeTest=require('node:test'),test=(name,fn)=>nativeTest(name,{timeout:900000},fn),WIN=process.platform==='win32',assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),{TaskIntegrate}=require('../lib/task-integrate'),graph=require('../public/project-order'),git=require('../lib/git'),chat=require('../lib/chat');
const sh=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t,opts={}){
 const project=opts.project||'Fixture';
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-integrate-'));const oldTrash=process.env.HUB_TRASH;process.env.HUB_TRASH=path.join(root,'Trash');t.after(()=>{if(oldTrash===undefined)delete process.env.HUB_TRASH;else process.env.HUB_TRASH=oldTrash;});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product',project),body=path.join(root,'Body');
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(dir,'PROJECT.md'),'---\nname: '+project+'\n---\n');write(path.join(body,'base.txt'),'base\n');
 sh(body,'init','-q');sh(body,'config','core.autocrlf','false');sh(body,'config','user.email','fixture@localhost');sh(body,'config','user.name',project);sh(body,'add','.');sh(body,'commit','-qm','base');
 const store=new Store(root),parent=store.createTask(project,{title:'祖先'});
 const removal=new Removal({store,trash:path.join(root,'Trash'),...opts});
 if(WIN&&opts.beforeNativeCleanup){const move=removal.moveEntryAsync.bind(removal);removal.moveEntryAsync=async(r,e)=>{opts.beforeNativeCleanup();return move(r,e);};}
 const transfer=new TaskTransfer({store,removal,baseOf:()=>body,...opts});
 const make=()=>new TaskIntegrate({store,transfer,removal,baseOf:()=>body});let integrate=make();
 const child=(title,parentId=parent.id,code=true)=>{
   const c=store.createTask(project,{title,parent:parentId,steps:['完成']});store.setStep(project,c.id,0,true);
   if(code){const w=git.prepare({base:body,workRoot:removal.workRoot({id:project}),taskId:c.id});store.updateTask(project,c.id,{workdir:w.dir});write(path.join(w.dir,title+'.txt'),title+'\n');git.save(w.dir,'child');}
   write(path.join(dir,'作業',c.id,'report.txt'),title+' report');return store.readTask(store.taskFile(project,c.id));
 };
 const preview=async only=>WIN?integrate.previewAsync(project,parent.id,only):integrate.preview(project,parent.id,only);
 const previewTask=async (p,t)=>WIN?integrate.previewAsync(p,t):integrate.preview(p,t);
 const applyInput=async input=>WIN?integrate.applyAsync(input):integrate.apply(input);
 const restore=async (id,confirm)=>WIN?removal.restoreAsync(id,confirm):removal.restore(id,confirm);
 const apply=async(d,items=d.items)=>applyInput({project:project,task:parent.id,token:d.token,confirm:true,selected:items.map(i=>({project:i.project,task:i.task,files:i.selected,optional:[]}))});
 const stopCopyAfterMove=message=>{integrate.reviewed.beforeNativeMutation=async r=>{const moved=await require('../lib/rooted-move').move(r.nativeCleanup);assert.equal(moved.state,'complete');throw Error(message);};};
 return {root,dir,body,write,store,parent,removal,transfer,child,preview,previewTask,apply,applyInput,restore,stopCopyAfterMove,get integrate(){return integrate;},restart(){integrate=make();},sh};
}
test('祖先判定は親・祖父・派生、未完中間親保護、全員完了と循環を共通に判定',()=>{
 const a={id:'a',state:'実行中'},b={id:'b',parent:'a',state:'完了'},c={id:'c',parent:'b',state:'完了'},p={id:'p',tasks:[a,b,c]};
 assert.deepEqual(graph.integrators(p,c).map(x=>x.task.id),['b','a']);
 b.state='実行中';assert.deepEqual(graph.integrators(p,c).map(x=>x.task.id),['b']);
 b.state='完了';a.state='完了';assert.deepEqual(graph.integrators(p,c),[]);
 a.state='実行中';const q={id:'q',tasks:[{id:'d',kind:'derived',derivedFrom:'p/b'}]};assert.deepEqual(graph.integrators(q,q.tasks[0],[p,q]).map(x=>x.task.id),['b','a']);
 a.parent='c';assert.deepEqual(graph.ancestorsOf(p,c),[]);
});
test('成果を渡すだけではコピー・会話・記録を残し、通知は一度、未引渡しも祖先が拾う',async t=>{
 const f=fixture(t),c=f.child('子');chat.append(f.dir,c.id,{role:'assistant',text:'child history'});
 const d=WIN?await f.transfer.offerPreviewAsync('Fixture',c.id):f.transfer.offerPreview('Fixture',c.id);assert.deepEqual(d.blockers,[]);
 const b={project:'Fixture',task:c.id,token:d.token,confirm:true,selected:d.selected};if(WIN){await f.transfer.offerAsync(b);await assert.rejects(f.transfer.offerAsync(b),/確認已到期或已使用|重新預覽/);}else{f.transfer.offer(b);f.transfer.offer(b);}
 assert.ok(fs.existsSync(c.workdir));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(chat.read(f.dir,c.id).length,1);assert.equal(chat.read(f.dir,f.parent.id).length,1);assert.deepEqual(f.transfer.pending(),[]);
 const c2=f.child('未引渡し'),p=(await f.preview());assert.equal(p.items.find(i=>i.task===c.id).handedUp,true);assert.equal(p.items.find(i=>i.task===c2.id).handedUp,false);
 (await f.apply(p));assert.equal(fs.readFileSync(path.join(f.body,'子.txt'),'utf8'),'子\n');assert.equal(fs.readFileSync(path.join(f.body,'未引渡し.txt'),'utf8'),'未引渡し\n');assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(f.store.taskFile('Fixture',c2.id),null);
});
test('親のコピーへ統合し本体は不変、専用一時物とrulesもTrash、成果・ログは残る',async t=>{
 const f=fixture(t),w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});
 const before=sh(f.body,'rev-parse','HEAD'),c=f.child('成果');
 f.write(path.join(f.dir,'.ai/chat',c.id+'.rules.md'),'rules');f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'temporary');
 const p=(await f.preview());assert.equal(p.target,w.dir);const result=(await f.apply(p));assert.equal(result.complete,true);
 assert.equal(sh(f.body,'rev-parse','HEAD'),before);assert.equal(fs.existsSync(path.join(f.body,'成果.txt')),false);assert.equal(fs.readFileSync(path.join(w.dir,'成果.txt'),'utf8'),'成果\n');
 assert.equal(fs.existsSync(c.workdir),false);assert.equal(fs.existsSync(path.join(f.dir,'.ai/work',c.id)),false);assert.equal(fs.existsSync(path.join(f.dir,'.ai/chat',c.id+'.rules.md')),false);
 assert.equal(fs.readFileSync(path.join(f.dir,'作業',c.id,'report.txt'),'utf8'),'成果 report');
 const journal=f.integrate.read('Fixture',f.parent.id),r=f.transfer.read('Fixture',c.id);assert.equal(journal.complete,true);assert.equal(r.complete,true);assert.ok(fs.existsSync(r.destination));assert.ok(fs.existsSync(journal.items[0].copyTrashed));assert.equal((await f.restore(r.cleanup,true)).ok,true);
 assert.equal(fs.readFileSync(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'utf8'),'temporary');
});
test('2子の2件目衝突は祖先に質問、先行子確定・後続保持、AI解消後は重複せず再開',async t=>{
 const f=fixture(t),a=f.child('A'),b=f.child('B');
 f.write(path.join(a.workdir,'base.txt'),'A\n');git.save(a.workdir,'A change');f.write(path.join(b.workdir,'base.txt'),'B\n');git.save(b.workdir,'B change');
 const p=(await f.preview()),ordered=[p.items.find(i=>i.task===a.id),p.items.find(i=>i.task===b.id)],out=(await f.apply(p,ordered));
 assert.equal(out.conflict,true);if(WIN){assert.ok(f.store.taskFile('Fixture',a.id));assert.equal(f.integrate.read('Fixture',f.parent.id).items[0].state,'取り込み済み');assert.equal(f.transfer.read('Fixture',a.id).complete,undefined);}else assert.equal(f.store.taskFile('Fixture',a.id),null);assert.ok(f.store.taskFile('Fixture',b.id));assert.equal(fs.readFileSync(path.join(f.body,'base.txt'),'utf8'),'A\n');
 assert.match(f.store.readTask(f.store.taskFile('Fixture',f.parent.id)).question,WIN?/B.*衝突/:/B.*ぶつかりました/);assert.equal(f.store.readTask(f.store.taskFile('Fixture',b.id)).question,'');
 await assert.rejects(async()=>sh(f.body,'merge','--no-ff','--no-edit',git.inspect(b.workdir).branch));f.write(path.join(f.body,'base.txt'),'A and B\n');sh(f.body,'add','.');sh(f.body,'commit','-qm','resolved');
 f.store.updateTask('Fixture',f.parent.id,{state:'実行中',question:''});const head=sh(f.body,'rev-parse','HEAD');f.restart();const d=(await f.preview());assert.equal(d.resume,true);(await f.apply(d));
 assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.equal(f.store.taskFile('Fixture',b.id),null);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,2);
 assert.equal(f.integrate.pending().length,0);
});
test('受領片付けの途中失敗を再起動後に継続し、別祖先・再通知・二重mergeを拒否',async t=>{
 let fail=true;const f=fixture(t,{rename:(a,b)=>{if(fail){fail=false;throw Error('fixture cleanup failure');}fs.renameSync(a,b);},beforeNativeCleanup:()=>{if(fail){fail=false;throw Error('fixture cleanup failure');}}}),c=f.child('子');
 const d=(await f.preview());await assert.rejects(async()=>(await f.apply(d)),/cleanup failure/);const head=sh(f.body,'rev-parse','HEAD');
 const upper=f.store.createTask('Fixture',{title:'上の祖先'});f.store.updateTask('Fixture',f.parent.id,{parent:upper.id});f.store.updateTask('Fixture',f.parent.id,{state:'完了'});
 const other=(await f.previewTask('Fixture',upper.id));assert.ok(other.items.find(i=>i.task===c.id).blockers.some(x=>x.includes('別の祖先')));
 f.restart();const resume=(await f.preview());(await f.apply(resume));assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('孫→子を強制し未完中間親と未完子孫を保護、成功後に両方片付ける',async t=>{
 const f=fixture(t),c=f.child('子'),g=f.child('孫',c.id);const d=(await f.preview());assert.equal(d.items[0].task,g.id);assert.equal(d.items[1].task,c.id);
 await assert.rejects(async()=>(await f.apply(d,d.items.slice().reverse())),/孫から/);const second=WIN?await f.preview():d;await assert.rejects(async()=>(await f.apply(second,[second.items[1]])),/孫から/);(await f.apply(WIN?await f.preview():d));assert.equal(f.store.taskFile('Fixture',c.id),null);assert.equal(f.store.taskFile('Fixture',g.id),null);
 const h=fixture(t),mid=h.child('中間'),leaf=h.child('下',mid.id);h.store.setStep('Fixture',mid.id,0,false);assert.equal((await h.preview()).items.length,0);assert.equal((await h.previewTask('Fixture',mid.id)).items[0].task,leaf.id);
 const k=fixture(t),parent=k.child('完了親'),unfinished=k.store.createTask('Fixture',{title:'未完の孫',parent:parent.id});assert.match((await k.preview()).items.find(i=>i.task===parent.id).blockers.join(' '),/未完了/);assert.ok(k.store.taskFile('Fixture',unfinished.id));
});
test('コピー退避直後に停止しても退避先を照合しGit登録整理から再開する',async t=>{
 const f=fixture(t),c=f.child('子'),branch=git.inspect(c.workdir).branch;
 f.integrate.gitw={...git,cleanupCopy:args=>git.cleanupCopy({...args,beforeMove:data=>{args.beforeMove(data);fs.renameSync(args.dir,data.trashed);throw Error('fixture stopped after move');}})};
 if(WIN)f.stopCopyAfterMove('fixture stopped after move');
 await assert.rejects(async()=>(await f.apply((await f.preview()))),/stopped after move/);
 const journal=f.integrate.read('Fixture',f.parent.id),record=WIN?f.integrate.reviewed.read('Fixture',c.id):null,planned=WIN?path.join(record.nativeCleanup.targetRoot,record.nativeCleanup.targetPath):journal.items[0].copyTrashPlanned;assert.ok(fs.existsSync(planned));assert.ok(sh(f.body,'branch','--list',branch));
 f.restart();(await f.apply((await f.preview())));if(WIN){assert.equal(sh(f.body,'rev-parse','refs/heads/'+branch),record.sourceHead);const registered=sh(f.body,'worktree','list','--porcelain','-z').split('\0').filter(x=>x.startsWith('worktree ')).map(x=>path.resolve(x.slice(9)).toLowerCase());assert.ok(registered.includes(path.resolve(planned).toLowerCase()));}else assert.equal(sh(f.body,'branch','--list',branch),'');assert.equal(f.integrate.read('Fixture',f.parent.id).items[0].copyTrashed,planned);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('成果改変・確認後のコード変更・順番待ちは保存/merge/削除前に拒否',async t=>{
 const f=fixture(t),c=f.child('子'),d=(await f.preview()),head=sh(f.body,'rev-parse','HEAD');f.write(path.join(f.dir,'作業',c.id,'report.txt'),'changed');await assert.rejects(async()=>(await f.apply(d)),/成果ファイル/);assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.ok(f.store.taskFile('Fixture',c.id));
 const g=fixture(t),x=g.child('子'),p=(await g.preview());g.write(path.join(x.workdir,'late.txt'),'late');await assert.rejects(async()=>(await g.apply(p)),/子の変更/);
 const h=fixture(t),q=h.child('子');h.write(path.join(h.dir,'.ai/chat',q.id+'.queue.json'),'[{}]');assert.ok((await h.preview()).items[0].blockers.some(x=>x.includes('順番待ち')));
});
test('共有から参照された専用一時物は残し、任意選択の専用フォルダだけTrash',async t=>{
 const f=fixture(t),c=f.child('子',f.parent.id,false),other=f.store.createTask('Fixture',{title:'参照元'}),temp=f.write(path.join(f.dir,'.ai/work',c.id,'memo.txt'),'shared');
 fs.appendFileSync(f.store.taskFile('Fixture',other.id),'\n参照 .ai/work/'+c.id+'/memo.txt\n');const d=(await f.preview());assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));
 (await f.applyInput({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:[{project:'Fixture',task:c.id,files:d.items[0].selected,optional:['作業/'+c.id]}]}));
 assert.equal(fs.existsSync(temp),true);assert.equal(fs.existsSync(path.join(f.dir,'作業',c.id)),false);assert.ok(f.transfer.read('Fixture',c.id).complete);
});

for(const stop of ['notification','copy-move','cleanup-save'])test('R1 専用一時物と任意フォルダ付きで'+stop+'停止後に一度だけ受領・片付け',async t=>{
 const f=fixture(t),c=f.child('再開');f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'temporary');
 const apply=async()=>{const d=(await f.preview());return (await f.applyInput({project:'Fixture',task:f.parent.id,token:d.token,confirm:true,selected:d.items.map(i=>({project:i.project,task:i.task,files:i.selected,optional:['作業/'+i.task]}))}));};
 if(stop==='notification')f.transfer.beforeCleanup=()=>{throw Error('fixture interruption');};
 if(stop==='copy-move')f.integrate.gitw={...git,cleanupCopy:args=>git.cleanupCopy({...args,beforeMove:data=>{args.beforeMove(data);fs.renameSync(c.workdir,data.trashed);throw Error('fixture interruption');}})};
 if(WIN&&stop==='copy-move')f.stopCopyAfterMove('fixture interruption');
 if(stop==='cleanup-save'){const save=f.removal.save.bind(f.removal);f.removal.save=r=>{save(r);throw Error('fixture interruption');};}
 await assert.rejects(apply,/fixture interruption/);assert.ok(f.store.taskFile('Fixture',c.id));
 f.removal.save=Removal.prototype.save.bind(f.removal);f.restart();assert.equal((await apply()).complete,true);
 assert.equal(fs.existsSync(path.join(f.dir,'.ai/work',c.id)),false);assert.equal(fs.existsSync(path.join(f.dir,'作業',c.id)),false);
 const receipt=f.transfer.read('Fixture',c.id);assert.ok(fs.existsSync(receipt.files[0].to));assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
test('R1 受領先の参照は元フォルダと誤認せず、真の共有参照を追加すると再開を保留',async t=>{
 const f=fixture(t),c=f.child('共有'),temp=f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'shared');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture stop/);
 const other=f.store.createTask('Fixture',{title:'参照元'});chat.append(f.dir,other.id,{role:'user',text:'使う '+temp});
 f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),/管理ファイルが変わりました/);assert.ok(fs.existsSync(c.workdir));assert.ok(fs.existsSync(temp));assert.ok(f.store.taskFile('Fixture',c.id));
});
for(const change of ['new-untracked','existing-local','tracked'])test('R2 受領停止後の'+change+'変更は未統合のまま片付けない',async t=>{
 const f=fixture(t),c=f.child('保持');f.write(path.join(c.workdir,'.env'),'INITIAL=1\n');
 f.write(path.join(c.workdir,'.gitignore'),'scratch/\n');git.save(c.workdir,'ignore');f.write(path.join(c.workdir,'scratch','temp.txt'),'original ignored temporary');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture stop/);
 const filename=change==='new-untracked'?'new-unintegrated.txt':change==='existing-local'?'.env':'base.txt';f.write(path.join(c.workdir,filename),'new unintegrated work\n');
 f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),WIN?/合併後來源.*已變更/:/未統合/);assert.ok(fs.existsSync(c.workdir));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 assert.notEqual(fs.existsSync(path.join(f.body,filename))&&fs.readFileSync(path.join(f.body,filename),'utf8'),'new unintegrated work\n');
});
test('R2 最初からあるignore一時物と非ignoreローカル設定は再開時コピーとともにTrash',async t=>{
 const f=fixture(t),c=f.child('設定');f.write(path.join(c.workdir,'.env'),'LOCAL=1\n');f.write(path.join(c.workdir,'.gitignore'),'scratch/\n');git.save(c.workdir,'ignore');f.write(path.join(c.workdir,'scratch','temp.txt'),'ignored');
 f.transfer.beforeCleanup=()=>{throw Error('fixture stop');};await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture stop/);f.restart();assert.equal((await f.apply((await f.preview()))).complete,true);
 const copy=f.integrate.read('Fixture',f.parent.id).items[0].copyTrashed;assert.equal(fs.readFileSync(path.join(copy,'.env'),'utf8'),'LOCAL=1\n');assert.equal(fs.readFileSync(path.join(copy,'scratch','temp.txt'),'utf8'),'ignored');assert.equal(fs.existsSync(path.join(f.body,'.env')),false);
});
for(const target of ['child-tracked','child-untracked','parent-tracked','parent-untracked'])test('R3 確認済みの同じdirtyファイルの内容変更を拒否 '+target,async t=>{
 const f=fixture(t),c=f.child('内容');let dir=c.workdir;
 if(target.startsWith('parent')){const w=git.prepare({base:f.body,workRoot:f.removal.workRoot({id:'Fixture'}),taskId:f.parent.id});f.store.updateTask('Fixture',f.parent.id,{workdir:w.dir});dir=w.dir;}
 const filename=target.endsWith('-untracked')?'new.txt':'base.txt';f.write(path.join(dir,filename),'previewed version\n');const d=(await f.preview()),before=git.inspect(dir),head=sh(f.body,'rev-parse','HEAD');
 f.write(path.join(dir,filename),'unreviewed version\n');const after=git.inspect(dir);assert.equal(before.status,after.status);assert.notEqual(before.content,after.content);
 await assert.rejects(async()=>(await f.apply(d)),target.startsWith('parent')?(WIN?/ancestor or target changed/:/統合先が変わりました/):/子の変更が変わりました/);assert.equal(sh(f.body,'rev-parse','HEAD'),head);assert.ok(f.store.taskFile('Fixture',c.id));assert.ok(fs.existsSync(c.workdir));assert.equal(f.integrate.read('Fixture',f.parent.id),null);
});
test('R4 旧版の対象外の子を戻した後、祖先の統合候補として受領する',async t=>{
 const f=fixture(t),c=f.child('旧対象外');f.store.updateTask('Fixture',c.id,{mergeExcluded:true});assert.match((await f.preview()).items[0].blockers.join(' '),/対象から外され/);
 f.store.updateTask('Fixture',c.id,{mergeExcluded:false});assert.deepEqual((await f.preview()).items[0].blockers,[]);assert.equal((await f.apply((await f.preview()))).complete,true);
});
test('R1 片付け記録作成後でも新しい真の共有参照を保護する',async t=>{
 let stop=true;const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture stop');}fs.renameSync(a,b);},beforeNativeCleanup:()=>{if(stop){stop=false;throw Error('fixture stop');}}}),c=f.child('後の共有');
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'temp.txt'),'shared');await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);
 const other=f.store.createTask('Fixture',{title:'参照元'});chat.append(f.dir,other.id,{role:'user',text:'読む：./.ai/work/'+c.id+'/temp.txt'});
 f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),/他の記録から参照/);assert.ok(fs.existsSync(temp));assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
});
for(const mode of ['cross-project-relative','json-tab'])for(const stage of ['initial','cleanup-resume'])test('R1 共有参照 '+mode+' を '+stage+' で保護する',async t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture shared stop');}fs.renameSync(a,b);},beforeNativeCleanup:()=>{if(stop){stop=false;throw Error('fixture shared stop');}}}),c=f.child('共有参照',f.parent.id,false);
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 if(stage==='cleanup-resume'){await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture shared stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);}
 if(mode==='cross-project-relative'){
  const readerDir=path.join(f.root,'Product','Consumer');f.write(path.join(readerDir,'PROJECT.md'),'---\nname: Consumer\n---\n');const reader=f.store.createTask('Consumer',{title:'別プロジェクトの参照元'}),ref='../Fixture/.ai/work/'+c.id+'/shared.txt';
  assert.equal(path.resolve(readerDir,ref),temp);fs.appendFileSync(f.store.taskFile('Consumer',reader.id),'\n読む：'+ref+'\n');
 }else{const reader=f.store.createTask('Fixture',{title:'タブ直後の参照元'});chat.append(f.dir,reader.id,{role:'user',text:'読む\t.ai/work/'+c.id+'/shared.txt'});}
 const p=f.store.readProject('Fixture');assert.equal(f.removal.referenced(path.dirname(temp),p,p.tasks.find(x=>x.id===c.id),f.store.listProjects()),true);
 if(stage==='initial'){
  const d=(await f.preview());assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal((await f.apply(d)).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);
 }else{
  f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),/他の記録から参照/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');
 const receipt=f.transfer.read('Fixture',c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
for(const [name,before,after] of [['corner','読む「','」'],['double-corner','読む『','』'],['parentheses','参照（','）'],['comma','参照、','']])for(const medium of ['markdown','jsonl'])for(const stage of ['initial','cleanup-resume'])test('R1 日本語区切り '+name+' '+medium+' '+stage+' の共有物を保持する',async t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture punctuation stop');}fs.renameSync(a,b);},beforeNativeCleanup:()=>{if(stop){stop=false;throw Error('fixture punctuation stop');}}}),c=f.child('日本語の共有参照',f.parent.id,false);
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 if(stop){await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture punctuation stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);}
 const reader=f.store.createTask('Fixture',{title:'日本語参照元'}),text=before+'.ai/work/'+c.id+'/shared.txt'+after;
 if(medium==='markdown')fs.appendFileSync(f.store.taskFile('Fixture',reader.id),'\n'+text+'\n');else chat.append(f.dir,reader.id,{role:'user',text});
 if(stage==='initial'){
  const d=(await f.preview());assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal((await f.apply(d)).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);
 }else{
  f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),/他の記録から参照/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');
 const receipt=f.transfer.read('Fixture',c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});

for(const project of ['対象（共有）','対象「共有」','対象『共有』','対象、共有'])for(const medium of ['markdown','jsonl'])for(const stage of ['initial','cleanup-resume'])test('R1 パス内の日本語文字 '+project+' '+medium+' '+stage+' の共有物を保持する',async t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{project,rename:(a,b)=>{if(stop){stop=false;throw Error('fixture pathname stop');}fs.renameSync(a,b);},beforeNativeCleanup:()=>{if(stop){stop=false;throw Error('fixture pathname stop');}}}),c=f.child('パスの共有参照',f.parent.id,false);
 const temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 if(stop){await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture pathname stop/);assert.ok(f.transfer.read(project,c.id).cleanup);}
 const readerDir=path.join(f.root,'Product','Consumer');f.write(path.join(readerDir,'PROJECT.md'),'---\nname: Consumer\n---\n');const reader=f.store.createTask('Consumer',{title:'引用なし参照元'}),ref='../'+project+'/.ai/work/'+c.id+'/shared.txt';
 assert.equal(path.resolve(readerDir,ref),temp);
 if(medium==='markdown')fs.appendFileSync(f.store.taskFile('Consumer',reader.id),'\n読む '+ref+'\n');else chat.append(readerDir,reader.id,{role:'user',text:'読む '+ref});
 if(stage==='initial'){
  const d=(await f.preview());assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal((await f.apply(d)).complete,true);assert.equal(f.store.taskFile(project,c.id),null);
 }else{
  f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),/他の記録から参照/);assert.ok(f.store.taskFile(project,c.id));assert.equal(f.transfer.read(project,c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');assert.ok(f.store.taskFile('Consumer',reader.id));
 const receipt=f.transfer.read(project,c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});


for(const [style,format] of [['comma',ref=>'読む：資料/a.md、'+ref],['brackets',ref=>'読む【資料/a.md】、読む【'+ref+'】'],['sentence',ref=>'読む 資料/a.md。参照、'+ref]])for(const medium of ['markdown','jsonl'])for(const stage of ['initial','cleanup-resume'])test('R1 複数共有参照 '+style+' '+medium+' '+stage+' を保護する',async t=>{
 let stop=stage==='cleanup-resume';const f=fixture(t,{rename:(a,b)=>{if(stop){stop=false;throw Error('fixture list stop');}fs.renameSync(a,b);},beforeNativeCleanup:()=>{if(stop){stop=false;throw Error('fixture list stop');}}}),c=f.child('複数参照',f.parent.id,false),temp=f.write(path.join(f.dir,'.ai/work',c.id,'shared.txt'),'shared original');
 f.write(path.join(f.dir,'資料/a.md'),'first reference');
 if(stop){await assert.rejects(async()=>(await f.apply((await f.preview()))),/fixture list stop/);assert.ok(f.transfer.read('Fixture',c.id).cleanup);}
 const reader=f.store.createTask('Fixture',{title:'複数を読む別作業'}),text=format('.ai/work/'+c.id+'/shared.txt');
 if(medium==='markdown')fs.appendFileSync(f.store.taskFile('Fixture',reader.id),'\n'+text+'\n');else chat.append(f.dir,reader.id,{role:'user',text});
 if(stage==='initial'){
  const d=(await f.preview());assert.ok(d.items[0].keep.some(x=>x.path===path.dirname(temp)));assert.equal((await f.apply(d)).complete,true);assert.equal(f.store.taskFile('Fixture',c.id),null);
 }else{
  f.restart();await assert.rejects(async()=>(await f.apply((await f.preview()))),/他の記録から参照/);assert.ok(f.store.taskFile('Fixture',c.id));assert.equal(f.transfer.read('Fixture',c.id).complete,false);
 }
 assert.equal(fs.readFileSync(temp,'utf8'),'shared original');assert.ok(f.store.taskFile('Fixture',reader.id));
 const receipt=f.transfer.read('Fixture',c.id),cleanup=JSON.parse(fs.readFileSync(path.join(f.removal.records,receipt.cleanup+'.json'),'utf8'));
 assert.equal(cleanup.entries.some(e=>e.from===path.dirname(temp)&&e.moved),false);assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});
