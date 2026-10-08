'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove'),{TaskTransfer}=require('../lib/task-transfer'),chat=require('../lib/chat');
function fixture(t,opts={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-transfer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product','Project Hub'),write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 write(path.join(dir,'PROJECT.md'),'---\nname: Project Hub\nphases: []\nrelated: []\n---\n');
 const store=new Store(root),parent=store.createTask('Project Hub',{title:'本作業'}),child=store.createTask('Project Hub',{title:'小作業',parent:parent.id}),other=store.createTask('Project Hub',{title:'その他'});
 const done=id=>write(store.taskFile('Project Hub',id),fs.readFileSync(store.taskFile('Project Hub',id),'utf8')+'\n## 手順\n- [x] 完成\n');done(child.id);
 const artifact=write(path.join(dir,'作業',child.id,'report.txt'),'実際の成果\n');
 const removal=new Removal({store,trash:path.join(root,'Trash'),...opts});const transfer=new TaskTransfer({store,removal,...opts});
 chat.append(dir,child.id,{role:'assistant',text:'長い会話は親へ入れない'});
 const preview=paths=>transfer.preview('Project Hub',child.id,paths),apply=d=>transfer.apply({project:'Project Hub',task:child.id,token:d.token,selected:d.files.map(x=>x.id),confirm:true});
 return {root,dir,store,parent,child,other,write,done,artifact,removal,transfer,preview,apply};
}
test('受領窓口は名前の不一致を保存・通知・片付け前に拒否し、片付け済みと不明を区別する',t=>{
 const f=fixture(t),file=f.store.taskFile('Project Hub',f.child.id),bytes=fs.readFileSync(file);
 assert.throws(()=>f.transfer.preview('Project Hub',f.child.id,[],'昔の子'),/同じ番号の別の作業/);
 const d=f.transfer.preview('Project Hub',f.child.id,[],'小作業');
 assert.throws(()=>f.transfer.apply({project:'Project Hub',task:f.child.id,token:d.token,selected:d.files.map(x=>x.id),confirm:true,expectTitle:'昔の子'}),/同じ番号の別の作業/);
 assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(f.transfer.read('Project Hub',f.child.id),null);assert.equal(chat.read(f.dir,f.parent.id).length,0);
 f.apply(d);assert.throws(()=>f.preview(),/もう受け取って片付けてあります/);assert.throws(()=>f.transfer.preview('Project Hub','missing'),/今はありません/);
 assert.equal(chat.read(f.dir,f.parent.id)[0].childTitle,'小作業');assert.equal(f.apply(d).duplicate,true);
});
test('途中受領・重複適用でもexpectTitleを検査し、名前変更後は元の記録を保つ',t=>{
 let failed=false;const f=fixture(t,{rename:(a,b)=>{if(!failed){failed=true;throw Error('fixture interrupted');}fs.renameSync(a,b);}});
 assert.throws(()=>f.apply(f.preview()),/interrupted/);const receipt=fs.readFileSync(f.transfer.file('Project Hub',f.child.id));
 assert.throws(()=>f.transfer.preview('Project Hub',f.child.id,[],'別の子'),/同じ番号の別の作業/);
 // 台帳の名前変更を模擬し、保存済み受領記録との競合も検査。
 const file=f.store.taskFile('Project Hub',f.child.id);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('title: 小作業','title: 名前変更'));
 assert.throws(()=>f.transfer.preview('Project Hub',f.child.id,[],'小作業'),/同じ番号の別の作業/);assert.deepEqual(fs.readFileSync(f.transfer.file('Project Hub',f.child.id)),receipt);
});
test('小作業の成果を保存・通知後に管理記録だけ退避し、Project Hubでも正確に復元できる',t=>{
 const f=fixture(t);f.write(path.join(f.dir,'.ai/chat',f.child.id+'.json'),'{}');f.write(path.join(f.dir,'.ai/chat',f.child.id+'.queue.json'),'[]');
 const packet=f.write(path.join(f.dir,'.ai/handoff',f.child.id+'-20261006-010203-codex.md'),'交代記録');
 const other=f.store.taskFile('Project Hub',f.other.id),otherBytes=fs.readFileSync(other),d=f.preview();assert.deepEqual(d.blockers,[]);
 const out=f.apply(d);assert.equal(out.ok,true);assert.equal(fs.readFileSync(out.files[0],'utf8'),'実際の成果\n');
 assert.equal(fs.existsSync(f.store.taskFile('Project Hub',f.child.id)||'/absent'),false);assert.equal(fs.existsSync(packet),false);assert.equal(fs.existsSync(f.artifact),true);assert.deepEqual(fs.readFileSync(other),otherBytes);
 const rows=chat.read(f.dir,f.parent.id);assert.equal(rows.length,1);assert.doesNotMatch(rows[0].text,/長い会話/);assert.match(rows[0].text,/report.txt/);assert.match(rows[0].text,/最終確認/);
 assert.equal(f.apply(d).duplicate,true);assert.equal(chat.read(f.dir,f.parent.id).length,1);
 assert.equal(f.removal.restore(out.record,true).restored,5);assert.equal(fs.readFileSync(packet,'utf8'),'交代記録');assert.throws(()=>f.preview(),/復元/);
});
test('派生はparentより派生元へ渡す。プロジェクト間の派生も同一家族へ保存する',t=>{
 const f=fixture(t);f.store.updateTask('Project Hub',f.child.id,{kind:'derived',derivedFrom:'Project Hub/'+f.other.id});const d=f.preview();assert.equal(d.targetTask,f.other.id);f.apply(d);assert.equal(chat.read(f.dir,f.parent.id).length,0);assert.equal(chat.read(f.dir,f.other.id).length,1);
 const g=fixture(t),qdir=path.join(g.root,'Product','Kid');g.write(path.join(qdir,'PROJECT.md'),'---\nname: Kid\nparent: Project Hub\n---\n');const q=g.store.createTask('Kid',{title:'別プロジェクトの検証',kind:'derived',derivedFrom:'Project Hub/'+g.parent.id});const file=g.store.taskFile('Kid',q.id);g.write(file,fs.readFileSync(file,'utf8')+'\n## 手順\n- [x] 完成\n');g.write(path.join(qdir,'成果物','out.txt'),'結果');const x=g.transfer.preview('Kid',q.id);assert.deepEqual(x.blockers,[]);const out=g.transfer.apply({project:'Kid',task:q.id,token:x.token,selected:x.files.map(x=>x.id),confirm:true});assert.equal(out.parentProject,'Project Hub');assert.match(out.files[0],/Product[\\/]Project Hub[\\/]成果物[\\/]受取/);
});
test('未完了・質問・稼働・待ち順・コピー・下の作業は成果を渡す前に止める',t=>{
 for(const kind of ['unfinished','question','busy','parentBusy','locked','queue','copy','copyRecord','child']){
  let f;f=fixture(t,{busy:(p,id)=>kind==='busy'&&id===f?.child.id||kind==='parentBusy'&&id===f?.parent.id,locked:()=>kind==='locked'});
  if(kind==='unfinished')f.write(f.store.taskFile('Project Hub',f.child.id),fs.readFileSync(f.store.taskFile('Project Hub',f.child.id),'utf8').replace('[x]','[ ]'));
  if(kind==='question')f.store.updateTask('Project Hub',f.child.id,{question:'未回答'});
  if(kind==='queue')f.write(path.join(f.dir,'.ai/chat',f.child.id+'.queue.json'),'[{}]');
  if(kind==='copy')fs.mkdirSync(path.join(f.root,'Work/Project Hub',f.child.id),{recursive:true});
  if(kind==='copyRecord')f.store.updateTask('Project Hub',f.child.id,{workdir:path.join(f.root,'Work/Project Hub',f.child.id)});
  if(kind==='child')f.store.createTask('Project Hub',{title:'下',parent:f.child.id});
  const d=f.preview();assert.ok(d.blockers.length,kind);assert.throws(()=>f.apply(d),undefined,kind);assert.equal(chat.read(f.dir,f.parent.id).length,0);assert.equal(fs.existsSync(f.artifact),true);
 }
});
test('変更・隠し設定・リンク・他作業・外のパスを拒否、返事だけで渡さない',t=>{
 const f=fixture(t);const d=f.preview();fs.appendFileSync(f.artifact,'更新');assert.throws(()=>f.apply(d),/変わ/);assert.equal(chat.read(f.dir,f.parent.id).length,0);
 const g=fixture(t);for(const input of ['../outside','.ai/tasks/x.md','/etc/hosts','作業/'+g.other.id+'/out.txt'])assert.ok(g.preview([input]).blockers.length,input);
 fs.mkdirSync(path.join(g.dir,'成果物'),{recursive:true});fs.symlinkSync(process.platform==='win32'?path.dirname(g.artifact):g.artifact,path.join(g.dir,'成果物','link.txt'),process.platform==='win32'?'junction':undefined);assert.ok(g.preview().blockers.some(x=>x.includes('リンク')));
 const h=fixture(t);fs.unlinkSync(h.artifact);const x=h.preview();assert.ok(x.blockers.some(x=>x.includes('成果ファイルがありません')));assert.throws(()=>h.apply(x));
 const i=fixture(t);const a=i.preview();assert.throws(()=>i.transfer.apply({project:'Project Hub',task:i.child.id,token:a.token,selected:[],confirm:true}),/選んで/);assert.throws(()=>i.transfer.apply({project:'Project Hub',task:i.child.id,token:a.token,selected:a.files.map(x=>x.id)}),/確認/);
});
test('片付け失敗・再起動・再実行でも通知・成果は一度だけ、復元できる',t=>{
 let failed=false;const f=fixture(t,{rename:(a,b)=>{if(!failed){failed=true;throw Error('fixture cleanup failure');}fs.renameSync(a,b);}});const d=f.preview();assert.throws(()=>f.apply(d),/cleanup failure/);assert.equal(chat.read(f.dir,f.parent.id).length,1);assert.ok(f.store.taskFile('Project Hub',f.child.id));
 const fresh=new TaskTransfer({store:f.store,removal:f.removal}),p=fresh.preview('Project Hub',f.child.id);assert.equal(p.resume,true);const out=fresh.apply({project:'Project Hub',task:f.child.id,token:p.token,confirm:true});assert.equal(out.files.length,1);assert.equal(chat.read(f.dir,f.parent.id).length,1);assert.equal(fs.readdirSync(path.join(f.dir,'成果物/受取')).length,1);assert.equal(f.removal.restore(out.record,true).restored,2);
});
test('コピー保存・親への記録失敗で管理記録を残し、再実行は通知を重ねない',t=>{
 const f=fixture(t);const d=f.preview();fs.mkdirSync(path.join(f.dir,'成果物/受取'),{recursive:true});
 // root権限でも検証できるよう、保存直前のIO失敗を注入。
 const copy=fs.copyFileSync;fs.copyFileSync=()=>{throw Error('fixture copy failed');};try{assert.throws(()=>f.apply(d),/copy failed/);}finally{fs.copyFileSync=copy;}
 assert.equal(chat.read(f.dir,f.parent.id).length,0);assert.ok(f.store.taskFile('Project Hub',f.child.id));const p=f.preview();f.apply(p);assert.equal(chat.read(f.dir,f.parent.id).length,1);
 const g=fixture(t),append=g.store.appendSection.bind(g.store);g.store.appendSection=()=>{throw Error('fixture note failed');};assert.throws(()=>g.apply(g.preview()),/note failed/);assert.ok(g.store.taskFile('Project Hub',g.child.id));assert.equal(chat.read(g.dir,g.parent.id).length,1);g.store.appendSection=append;g.apply(g.preview());assert.equal(chat.read(g.dir,g.parent.id).length,1);
});
test('管理記録の途中退避後に保存が止まっても残りを続け、成果を改変されたら消さない',t=>{
 const f=fixture(t),save=f.removal.save.bind(f.removal);let calls=0;f.removal.save=r=>{if(++calls===3)throw Error('fixture journal');save(r);};assert.throws(()=>f.apply(f.preview()),/journal/);assert.ok(f.store.taskFile('Project Hub',f.child.id));f.removal.save=save;f.apply(f.preview());assert.equal(chat.read(f.dir,f.parent.id).length,1);
 let failed=false;const g=fixture(t,{rename:(a,b)=>{if(!failed){failed=true;throw Error('fixture fail');}fs.renameSync(a,b);}});assert.throws(()=>g.apply(g.preview()),/fixture fail/);const receipt=g.transfer.read('Project Hub',g.child.id);fs.appendFileSync(receipt.files[0].to,'tamper');assert.throws(()=>g.apply(g.preview()),/変更/);assert.ok(g.store.taskFile('Project Hub',g.child.id));
});

test('取り込み済みコードは二重コピーせず証跡を渡し、取り込み記録の変化時は片付けない',t=>{
 let receipt={dir:'/isolated/body',commit:'fixture-commit',files:['src/app.js'],github:{url:'https://github.com/example/fixture',branch:'main'}};
 const f=fixture(t,{integration:()=>receipt});fs.unlinkSync(f.artifact);const d=f.preview();assert.deepEqual(d.blockers,[]);
 const out=f.apply(d);assert.deepEqual(out.files,[]);const row=chat.read(f.dir,f.parent.id)[0];assert.match(row.text,/fixture-commit/);assert.match(row.text,/src\/app.js/);assert.match(row.text,/更新候補/);assert.match(row.text,/最終確認/);
 const g=fixture(t,{integration:()=>receipt});const x=g.preview();receipt={...receipt,commit:'changed'};assert.throws(()=>g.apply(x),/取り込み記録/);assert.ok(g.store.taskFile('Project Hub',g.child.id));
});

test('自動候補は自分の成果と直下資料だけ。共有資料は指定して確認できる',t=>{
 const f=fixture(t);const shared=f.write(path.join(f.dir,'成果物','shared','memo.txt'),'shared');f.write(path.join(f.dir,'成果物',f.other.id,'private.txt'),'other');f.write(path.join(f.dir,'成果物','direct.txt'),'direct');
 assert.equal(f.preview().files.length,2);assert.equal(f.preview(['成果物/shared/memo.txt']).files.length,3);assert.ok(f.preview([{}]).blockers.length);assert.equal(fs.readFileSync(shared,'utf8'),'shared');
});

test('全管理記録を退避後の最後の保存失敗も、本作業の再開一覧から完了できる',t=>{
 const f=fixture(t),save=f.transfer.save.bind(f.transfer);f.transfer.save=r=>{if(r.complete)throw Error('fixture final receipt save');save(r);};
 assert.throws(()=>f.apply(f.preview()),/final receipt/);assert.equal(f.store.taskFile('Project Hub',f.child.id),null);
 const next=f.store.createTask('Project Hub',{title:'片付け後の新規作業',parent:f.parent.id});assert.notEqual(next.id,f.child.id);
 const transfer=new TaskTransfer({store:f.store,removal:f.removal});assert.equal(transfer.pending()[0].task,f.child.id);
 const d=transfer.preview('Project Hub',f.child.id);assert.equal(d.resume,true);transfer.apply({project:'Project Hub',task:f.child.id,token:d.token,confirm:true});
 assert.deepEqual(transfer.pending(),[]);assert.equal(chat.read(f.dir,f.parent.id).length,1);
 assert.ok(f.store.taskFile('Project Hub',next.id));
});
test('旧版で片付け範囲を保存済みの途中引渡しは新版のrules・一時物を残して再開できる',t=>{
 const f=fixture(t),rules=f.write(path.join(f.dir,'.ai/chat',f.child.id+'.rules.md'),'old rules'),temp=f.write(path.join(f.dir,'.ai/work',f.child.id,'tmp.txt'),'temporary');
 const copy=fs.copyFileSync;fs.copyFileSync=()=>{throw Error('fixture interrupted before copy');};try{assert.throws(()=>f.apply(f.preview()),/before copy/);}finally{fs.copyFileSync=copy;}
 const r=f.transfer.read('Project Hub',f.child.id);delete r.cleanupVersion;r.move=r.move.filter(x=>x.path!==rules&&x.path!==path.dirname(temp));f.transfer.save(r);
 const transfer=new TaskTransfer({store:f.store,removal:f.removal}),d=transfer.offerPreview('Project Hub',f.child.id);assert.equal(d.resume,true);const out=transfer.offer({project:'Project Hub',task:f.child.id,token:d.token,confirm:true});
 assert.equal(out.ok,true);assert.equal(f.store.taskFile('Project Hub',f.child.id),null);assert.ok(fs.existsSync(rules));assert.ok(fs.existsSync(temp));assert.equal(chat.read(f.dir,f.parent.id).filter(x=>x.handoff).length,1);
});

test('同日の連続引渡しで番号・成果・取り込み証跡を混同せず、旧tokenと復元の二重引渡しを防ぐ',t=>{
 const f=fixture(t),first=f.preview(),out=f.apply(first),oldReceipt=f.transfer.read('Project Hub',f.child.id);
 // 旧版で引渡し済みの環境への更新を模擬：予約ファイルが無くても受領/削除履歴が残る。
 fs.rmSync(path.join(f.root,'_hub/task-ids'),{recursive:true});
 const store=new Store(f.root),next=store.createTask('Project Hub',{title:'次の別成果',parent:f.parent.id,steps:['完成']});
 assert.notEqual(next.id,f.child.id);store.setStep('Project Hub',next.id,0,true);
 const artifact=f.write(path.join(f.dir,'作業',next.id,'second.txt'),'新しい成果');
 const oldMerge={project:'Project Hub',task:f.child.id,commit:'old-commit',files:['old.js']};
 const transfer=new TaskTransfer({store,removal:new Removal({store,trash:path.join(f.root,'Trash')}),integration:(p,t)=>oldMerge.project===p.id&&oldMerge.task===t.id?oldMerge:null});
 const d=transfer.preview('Project Hub',next.id);assert.deepEqual(d.blockers,[]);assert.equal(d.integrated,null);assert.deepEqual(d.files.map(x=>x.path),[artifact]);
 assert.throws(()=>f.transfer.apply({project:'Project Hub',task:next.id,token:first.token,selected:first.files.map(x=>x.id),confirm:true}),/確認/);
 assert.equal(f.apply(first).duplicate,true);assert.ok(store.taskFile('Project Hub',next.id));
 const second=transfer.apply({project:'Project Hub',task:next.id,token:d.token,selected:d.files.map(x=>x.id),confirm:true});
 assert.notEqual(second.destination,out.destination);assert.equal(fs.readFileSync(second.files[0],'utf8'),'新しい成果');assert.equal(fs.readFileSync(out.files[0],'utf8'),'実際の成果\n');
 assert.deepEqual(f.transfer.read('Project Hub',f.child.id),oldReceipt);assert.equal(chat.read(f.dir,f.parent.id).length,2);
 assert.equal(f.removal.restore(out.record,true).ok,true);assert.throws(()=>f.preview(),/復元/);
 const later=new Store(f.root).createTask('Project Hub',{title:'さらに新規',parent:f.parent.id});assert.ok(![f.child.id,next.id].includes(later.id));
 assert.equal(fs.readFileSync(f.artifact,'utf8'),'実際の成果\n');assert.equal(fs.existsSync(artifact),true);
});

test('完了記録と異なる確認tokenはduplicate成功にせず、変更された復元作業は残す',t=>{
 const f=fixture(t),d=f.preview(),out=f.apply(d);
 const wrong=f.transfer.token({...d,taskHash:'別の作業の確認'});
 assert.throws(()=>f.transfer.apply({project:'Project Hub',task:f.child.id,token:wrong,confirm:true}),/受領記録/);
 f.removal.restore(out.record,true);f.store.updateTask('Project Hub',f.child.id,{memo:'復元後の変更'});
 assert.throws(()=>f.apply(d),/作業が変わ/);assert.ok(f.store.taskFile('Project Hub',f.child.id));assert.equal(chat.read(f.dir,f.parent.id).length,1);
});
