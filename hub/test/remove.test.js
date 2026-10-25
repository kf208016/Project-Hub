'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {Store}=require('../lib/store'),{Removal}=require('../lib/remove');
function fixture(t,opts={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-remove-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);return f;};
 const project=(id,extra='')=>write(path.join(root,'Product',id,'PROJECT.md'),`---\nname: ${id}\nfolders: {}\nrelated: []\n${extra}---\n`);
 project('Parent');project('Child','parent: Parent\n');const store=new Store(root);const t1=store.createTask('Child',{title:'Task'}),t2=store.createTask('Child',{title:'Other'});
 const dir=path.join(root,'Product/Child'),chat=write(path.join(dir,'.ai/chat',t1.id+'.jsonl'),'original chat');
 const r=new Removal({store,trash:path.join(root,'Trash'),...opts});return {root,dir,write,project,store,r,task:t1.id,other:t2.id,chat};
}
test('task removal is explicit, leaves parent and other task unchanged, optional folders start separate and restore exact bytes',t=>{
 const f=fixture(t),optional=f.write(path.join(f.dir,'作業',f.task,'draft.txt'),'optional');const pfile=path.join(f.root,'Product/Parent/PROJECT.md'),other=f.store.taskFile('Child',f.other),before=[pfile,other].map(x=>fs.readFileSync(x));
 const d=f.r.preview('Child',f.task);assert.equal(d.blockers.length,0);assert.equal(d.optional.length,1);assert.throws(()=>f.r.apply({token:d.token,confirm:false}),/確認/);
 const out=f.r.apply({token:d.token,confirm:true});assert.equal(out.ok,true);assert.equal(fs.existsSync(f.chat),false);assert.equal(fs.readFileSync(optional,'utf8'),'optional');assert.deepEqual([pfile,other].map(x=>fs.readFileSync(x)),before);
 assert.equal(f.r.restore(out.record,true).restored,2);assert.equal(fs.readFileSync(f.chat,'utf8'),'original chat');assert.equal(f.r.history()[0].restored,true);
});
test('optional attachments are selected only by id; references, symlinks and shared folders are kept',t=>{
 const f=fixture(t);const a=f.write(path.join(f.dir,'attachments',f.task,'x.txt'),'attach');let d=f.r.preview('Child',f.task);assert.equal(d.optional.length,1);
 fs.appendFileSync(f.store.taskFile('Child',f.other),`\nReference attachments/${f.task}/x.txt`);d=f.r.preview('Child',f.task);assert.equal(d.optional.length,0);assert.match(d.keep.at(-1).why,/参照/);
 const b=fixture(t);b.write(path.join(b.dir,'作業',b.task,'x.txt'),'draft');const target=path.join(b.root,'link-target');fs.mkdirSync(target);fs.symlinkSync(target,path.join(b.dir,'作業',b.task,'link'),process.platform==='win32'?'junction':'dir');assert.match(b.r.preview('Child',b.task).keep.at(-1).why,/リンク/);
 const c=fixture(t);const file=c.write(path.join(c.dir,'attachments',c.task,'x.txt'),'attach');d=c.r.preview('Child',c.task);const out=c.r.apply({token:d.token,optional:[d.optional[0].id],confirm:true});assert.equal(fs.existsSync(file),false);assert.equal(c.r.restore(out.record,true).restored,3);
});
test('shared references resolve the whole path from the reader project, not a matching suffix',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task);
 const reader=f.store.createTask('Parent',{title:'Reader'}),file=f.store.taskFile('Parent',reader.id),base=fs.readFileSync(file,'utf8'),relative='.ai/work/'+f.task+'/shared.txt';
 for(const ref of [relative,'成果物/受取/receipt/project/'+relative]){fs.writeFileSync(file,base+'\n読む：'+ref+'\n');assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false,ref);}
 for(const ref of ['../Child/'+relative,'../Child/./.ai/work/'+f.task+'/../'+f.task+'/shared.txt']){fs.writeFileSync(file,base+'\n読む：'+ref+'\n');assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true,ref);}
});
test('JSON and JSONL reference strings decode tabs, newlines, escaped slashes and Unicode',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt';
 for(const ext of ['.json','.jsonl']){
  const file=path.join(f.dir,'.ai/chat',f.other+ext);
  for(const separator of ['\t','\n']){
   f.write(file,JSON.stringify({nested:[{text:'読む'+separator+ref}]}).replace(/\//g,'\\/').replace(/\.ai/g,'\\u002eai')+'\n');
   assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true,ext+' '+JSON.stringify(separator));
  }
  // コピー先の中の部分パスをデコードしても、元フォルダを指してはいない。
  f.write(file,JSON.stringify({text:'読む\t成果物/受取/receipt/project/'+ref})+'\n');assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false);
 }
});
test('Japanese punctuation keeps whole shared paths and does not match receipt destination suffixes',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt';
 const spellings=[['plain','読む ',''],['colon','読む：',''],['backticks','読む `','`'],['markdown','[参照](',')'],['corner','読む「','」'],['double-corner','読む『','』'],['parentheses','参照（','）'],['comma','参照、',''],['fullwidth-comma','参照，',''],['brackets','参照【','】'],['angle','参照〈','〉'],['double-angle','参照《','》'],['square','参照［','］'],['period','参照。','。']];
 for(const medium of ['markdown','jsonl']){
  const file=medium==='markdown'?f.store.taskFile('Child',f.other):path.join(f.dir,'.ai/chat',f.other+'.jsonl'),base=medium==='markdown'?fs.readFileSync(file,'utf8'):'';
  for(const [name,before,after] of spellings)for(const copied of [false,true]){
   const text=before+(copied?'成果物/受取/receipt/project/':'')+ref+after;
   f.write(file,base+'\n'+(medium==='jsonl'?JSON.stringify({text}):text)+'\n');
   assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),!copied,medium+' '+name+' copied='+copied);
  }
  // 次の媒体に前の参照を持ち越さない。
  f.write(file,base);
 }
});
test('children, derived tasks, queued requests, running AI, active verification and work copies block deletion',t=>{
 for(const kind of ['child','derived','queue','busy','locked','copy','copyRecord']){
  const f=fixture(t,{busy:()=>kind==='busy',locked:()=>kind==='locked'});
  if(kind==='child')f.store.createTask('Child',{title:'Kid',parent:f.task});
  if(kind==='derived')f.store.createTask('Child',{title:'Derived',kind:'derived',derivedFrom:'Child/'+f.task});
  if(kind==='queue')f.write(path.join(f.dir,'.ai/chat',f.task+'.queue.json'),'[{"text":"pending"}]');
  if(kind==='copy')fs.mkdirSync(path.join(f.root,'Work/Child',f.task),{recursive:true});
  if(kind==='copyRecord')f.store.updateTask('Child',f.task,{workdir:path.join(f.root,'Work/Child',f.task)});
  const d=f.r.preview('Child',f.task);assert.ok(d.blockers.length,kind);assert.throws(()=>f.r.apply({token:d.token,confirm:true}));assert.equal(fs.readFileSync(f.chat,'utf8'),'original chat');
 }
});
test('child project keeps external parent body; nonempty original material needs typed name and restores project',t=>{
 const f=fixture(t),parent=path.join(f.root,'Product/Parent'),original=f.write(path.join(parent,'資料/source.txt'),'parent original');
 f.project('Child',`parent: Parent\nrelated: [Parent]\nfolders:\n  本体: ${parent}\n`);f.write(path.join(f.dir,'資料/source.txt'),'child original');let d=f.r.preview('Child');assert.equal(d.keep[0].path,parent);assert.ok(d.keep.some(x=>x.why.includes('参考・関連')));assert.equal(d.typed,true);
 assert.throws(()=>f.r.apply({token:d.token,confirm:true,typed:'wrong'}),/プロジェクト名/);const out=f.r.apply({token:d.token,confirm:true,typed:'Child'});assert.equal(fs.existsSync(f.dir),false);assert.equal(fs.readFileSync(original,'utf8'),'parent original');assert.equal(f.r.restore(out.record,true).restored,1);assert.equal(fs.readFileSync(path.join(f.dir,'資料/source.txt'),'utf8'),'child original');
});
test('project deletion rejects descendants, shared contained body, external Git tracking, Project Hub and symlinks',t=>{
 let f=fixture(t);assert.match(f.r.preview('Parent').blockers.join(' '),/子/);
 f=fixture(t);f.project('Another',`folders:\n  本体: ${f.dir}/作業\n`);assert.match(f.r.preview('Child').blockers.join(' '),/使っています/);
 f=fixture(t);execFileSync('git',['init','-q',f.root]);execFileSync('git',['-C',f.root,'add','Product/Child/PROJECT.md']);assert.match(f.r.preview('Child').blockers.join(' '),/外側/);
 f=fixture(t);f.project('Project Hub');assert.match(f.r.preview('Project Hub').blockers.join(' '),/自身/);
 f=fixture(t);fs.renameSync(f.dir,f.dir+'-real');fs.symlinkSync(f.dir+'-real',f.dir,process.platform==='win32'?'junction':'dir');
 if(process.platform==='win32')assert.throws(()=>f.r.preview('Child'),/プロジェクトがありません/);else assert.match(f.r.preview('Child').blockers.join(' '),/リンク/);
 assert.ok(fs.lstatSync(f.dir).isSymbolicLink());assert.ok(fs.existsSync(path.join(f.dir+'-real','PROJECT.md')));
});
test('own Git root is recoverable, preview changes and invalid optional ids are refused',t=>{
 const f=fixture(t);execFileSync('git',['init','-q',f.dir]);execFileSync('git',['-C',f.dir,'add','PROJECT.md']);let d=f.r.preview('Child');assert.equal(d.blockers.length,0);
 const x=f.r.apply({token:d.token,confirm:true});assert.equal(f.r.restore(x.record,true).restored,1);assert.equal(fs.existsSync(path.join(f.dir,'.git')),true);
 d=f.r.preview('Child',f.task);fs.appendFileSync(f.chat,'changed');assert.throws(()=>f.r.apply({token:d.token,confirm:true}),/変わりました/);
 d=f.r.preview('Child',f.task);assert.throws(()=>f.r.apply({token:d.token,optional:['../../Parent'],confirm:true}),/選び直/);
});
test('partial move failure is journaled and reversible; EXDEV never copies or deletes',t=>{
 let calls=0;const f=fixture(t,{rename:(a,b)=>{if(++calls===2)throw Error('fixture fail');fs.renameSync(a,b);}});const d=f.r.preview('Child',f.task),out=f.r.apply({token:d.token,confirm:true});assert.equal(out.ok,false);assert.equal(out.moved.length,1);assert.equal(out.failed.length,1);assert.equal(fs.readFileSync(f.chat,'utf8'),'original chat');assert.equal(f.r.restore(out.record,true).restored,1);
 const g=fixture(t,{rename:()=>{throw Object.assign(Error('cross volume'),{code:'EXDEV'});}});const e=g.r.preview('Child',g.task),r=g.r.apply({token:e.token,confirm:true});assert.equal(r.moved.length,0);assert.match(r.failed[0].why,/同じディスク/);assert.equal(fs.existsSync(g.store.taskFile('Child',g.task)),true);
});
test('restore never overwrites, refuses changed Trash content and tampered path traversal',t=>{
 const f=fixture(t),d=f.r.preview('Child',f.task),out=f.r.apply({token:d.token,confirm:true});f.write(f.chat,'new content');let r=f.r.restore(out.record,true);assert.equal(r.restored,1);assert.match(r.skipped[0].why,/上書き/);assert.equal(fs.readFileSync(f.chat,'utf8'),'new content');
 const file=path.join(f.r.records,out.record+'.json'),record=JSON.parse(fs.readFileSync(file));record.entries[1].from=path.join(f.dir,'..','Parent','bad');fs.writeFileSync(file,JSON.stringify(record));assert.match(f.r.restore(out.record,true).skipped[0].why,/不正/);
 const g=fixture(t),a=g.r.apply({token:g.r.preview('Child',g.task).token,confirm:true}),saved=JSON.parse(fs.readFileSync(path.join(g.r.records,a.record+'.json')));fs.appendFileSync(saved.entries[1].to,'tamper');assert.match(g.r.restore(a.record,true).skipped[0].why,/中身/);
});

test('a stopped journal write after rename remains discoverable and recoverable',t=>{
 const f=fixture(t),save=f.r.save.bind(f.r);let count=0;
 f.r.save=r=>{if(++count>=3)throw Error('journal unavailable');save(r);};
 assert.throws(()=>f.r.apply({token:f.r.preview('Child',f.task).token,confirm:true}),/journal/);
 const fresh=new Removal({store:f.store,trash:f.r.trash}),history=fresh.history();
 assert.equal(history[0].count,1);assert.equal(fresh.restore(history[0].id,true).restored,1);
 assert.equal(fs.existsSync(f.store.taskFile('Child',f.task)),true);
});

test('Japanese punctuation inside path components stays intact in relative references and receipt destinations',t=>{
 const f=fixture(t),reader=f.store.createTask('Parent',{title:'Reader'}),taskFile=f.store.taskFile('Parent',reader.id),base=fs.readFileSync(taskFile,'utf8');
 for(const name of ['対象（共有）','対象「共有」','対象『共有』','対象、共有']){
  f.project(name);const owner=f.store.createTask(name,{title:'Owner'}),p=f.store.readProject(name),temp=f.write(path.join(p.dir,'.ai/work',owner.id,'shared.txt'),'shared'),ref='../'+name+'/.ai/work/'+owner.id+'/shared.txt';
  assert.equal(fs.realpathSync(path.resolve(f.root,'Product/Parent',ref)),fs.realpathSync(temp));
  for(const medium of ['markdown','jsonl']){
   const file=medium==='markdown'?taskFile:path.join(f.root,'Product/Parent/.ai/chat',reader.id+'.jsonl');
   for(const [before,after] of [['読む ',''],['読む「','」'],['参照（','）'],['参照、','。']])for(const copied of [false,true]){
    const text=before+(copied?'成果物/受取/receipt/project/':'')+ref+after;
    f.write(file,(medium==='markdown'?base:'')+'\n'+(medium==='jsonl'?JSON.stringify({text}):text)+'\n');
    assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),!copied,name+' '+medium+' '+text);
   }
   f.write(file,medium==='markdown'?base:'');
  }
 }
});

test('separate Japanese quoted references remain readable without extracting quotes inside a copied path',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt',file=f.store.taskFile('Child',f.other),base=fs.readFileSync(file,'utf8');
 for(const text of ['読む「別の場所/file.txt」、読む「'+ref+'」','読む（別の場所/file.txt）、読む（'+ref+'）']){
  f.write(file,base+'\n'+text);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true,text);
 }
 for(const text of ['読む 成果物/受取/receipt/「'+ref+'」','読む 成果物/受取/receipt/（'+ref+'）']){
  f.write(file,base+'\n'+text);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false,text);
 }
});


test('Japanese path lists read every reference while preserving path names and receipt destinations',t=>{
 const f=fixture(t),reader=f.store.createTask('Parent',{title:'List reader'}),taskFile=f.store.taskFile('Parent',reader.id),base=fs.readFileSync(taskFile,'utf8');
 const formats=[ref=>'読む：資料/a.md、'+ref,ref=>'読む【資料/a.md】、読む【'+ref+'】',ref=>'読む 資料/a.md。参照、'+ref,ref=>'読む「資料/a.md」、読む「'+ref+'」',ref=>'読む（資料/a.md）、読む（'+ref+'）',ref=>'資料/a.md，'+ref,ref=>'資料/a.md；'+ref];
 for(const name of ['Child','対象（共有）','対象「共有」','対象『共有』','対象、共有']){
  if(name!=='Child')f.project(name);const p=f.store.readProject(name),owner=name==='Child'?p.tasks.find(x=>x.id===f.task):f.store.createTask(name,{title:'Owner'}),temp=f.write(path.join(p.dir,'.ai/work',owner.id,'shared.txt'),'shared'),ref='../'+name+'/.ai/work/'+owner.id+'/shared.txt';
  for(const medium of ['markdown','jsonl']){
   const file=medium==='markdown'?taskFile:path.join(f.root,'Product/Parent/.ai/chat',reader.id+'.jsonl');
   for(const format of formats)for(const copied of [false,true]){
    const text=format((copied?'成果物/受取/receipt/project/':'')+ref);
    f.write(file,(medium==='markdown'?base:'')+'\n'+(medium==='jsonl'?JSON.stringify({text}):text)+'\n');
    assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),!copied,name+' '+medium+' '+text);
   }
   f.write(file,medium==='markdown'?base:'');
  }
 }
});

test('list boundaries do not extract quoted source suffixes or split existing comma directory components',t=>{
 const f=fixture(t),temp=f.write(path.join(f.dir,'.ai/work',f.task,'shared.txt'),'shared'),p=f.store.readProject('Child'),owner=p.tasks.find(x=>x.id===f.task),ref='.ai/work/'+f.task+'/shared.txt',file=f.store.taskFile('Child',f.other),base=fs.readFileSync(file,'utf8');
 f.write(path.join(f.dir,'成果物/受取/対象、.ai/work',f.task,'shared.txt'),'received copy');
 for(const text of ['資料/a.md、成果物/受取/receipt/【'+ref+'】','資料/a.md。読む 成果物/受取/receipt/「'+ref+'」','資料/a.md、成果物/受取/対象、'+ref]){
  f.write(file,base+'\n'+text);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),false,text);
 }
 f.write(file,base+'\n資料/a.md、'+ref);assert.equal(f.r.referenced(path.dirname(temp),p,owner,f.store.listProjects()),true);
});
