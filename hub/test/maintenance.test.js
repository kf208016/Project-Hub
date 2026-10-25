'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Store}=require('../lib/store');
const {Maintenance,scriptsAt}=require('../lib/maintenance');
const DAY=86400000;
function fixture(t,opts={}) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-maint-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,'Product','P');fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: P\nstatus: 進行中\nfolders: {}\nrelated: []\nphases: []\n---\n');
 const store=new Store(root),trash=path.join(root,'Trash');let busy=false;
 const m=new Maintenance({store,baseOf:p=>p.dir,trash,busy:()=>busy,timeout:5000,...opts});
 function old(rel,data='fixture') {const f=path.join(dir,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);const when=new Date(Date.now()-40*DAY);fs.utimesSync(f,when,when);return f;}
 return {root,dir,store,trash,m,old,busy:v=>busy=v};
}
test('preview protects recent, referenced, tracked, symlink and original material files',t=>{
 const f=fixture(t),keep=f.old('.ai/work/referenced.dat'),safe=f.old('.ai/work/unused.dat');
 f.old('作業/versions/old-version.dat');f.old('資料/original.dat');f.old('成果物/result.dat');
 f.old('.ai/memory/memory.md');const tracked=f.old('.ai/work/tracked.dat');
 fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'\nReference '+keep+'\n');
 const recent=path.join(f.dir,'.ai/work/recent.dat');fs.writeFileSync(recent,'recent');
 if(process.platform==='win32'){const target=path.join(f.root,'link-target');fs.mkdirSync(target);fs.symlinkSync(target,path.join(f.dir,'.ai/work/link.dat'),'junction');}
 else fs.symlinkSync(safe,path.join(f.dir,'.ai/work/link.dat'));
 execFileSync('git',['init','-q',f.dir]);execFileSync('git',['-C',f.dir,'add',tracked]);
 const d=f.m.preview('P');assert.equal(d.candidates.length,2);assert.ok(d.candidates.some(c=>c.paths.includes(safe)));
 assert.equal(d.excluded.length,4);assert.ok(d.excluded.some(e=>e.reason.includes('Git')));assert.ok(d.excluded.some(e=>e.reason.includes('参照')));
});
test('cleanup requires explicit choices, rechecks content/reference/busy and restores exact content',t=>{
 const f=fixture(t),file=f.old('.ai/work/unused.dat','original');let d=f.m.preview('P');
 assert.throws(()=>f.m.apply('P',d.token,[],true),/選び直/);
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],false),/選び直/);
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id,d.candidates[0].id],true),/選び直/);
 f.busy(true);assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),/動いて/);f.busy(false);
 fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'\nReference unused.dat');
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),/参照が変わ/);
 fs.writeFileSync(path.join(f.dir,'PROJECT.md'),'---\nname: P\nstatus: 進行中\nfolders: {}\n---\n');
 d=f.m.preview('P');const r=f.m.apply('P',d.token,[d.candidates[0].id],true);assert.equal(r.ok,true);assert.equal(fs.existsSync(file),false);
 assert.equal(f.m.history('P')[0].count,1);
 assert.equal(f.m.restore('P',r.id,true).restored,1);assert.equal(fs.readFileSync(file,'utf8'),'original');
 assert.equal(f.m.history('P')[0].restored,true);
});
test('restore refuses overwrite, tampered trash, missing trash and path traversal',t=>{
 const f=fixture(t),file=f.old('.ai/work/old.dat');const d=f.m.preview('P'),r=f.m.apply('P',d.token,[d.candidates[0].id],true);
 const rf=path.join(f.m.records,r.id+'.json'),record=JSON.parse(fs.readFileSync(rf));
 fs.writeFileSync(file,'new');assert.throws(()=>f.m.restore('P',r.id,true),/上書き/);fs.unlinkSync(file);
 const original=record.entries[0].src;record.entries[0].src=path.join(f.dir,'.ai/work')+'/../../PROJECT.md';fs.writeFileSync(rf,JSON.stringify(record));
 assert.throws(()=>f.m.restore('P',r.id,true),/パスが不正/);record.entries[0].src=original;fs.writeFileSync(rf,JSON.stringify(record));
 fs.appendFileSync(record.entries[0].dest,'tamper');assert.throws(()=>f.m.restore('P',r.id,true),/中身が変わ/);
 fs.unlinkSync(record.entries[0].dest);assert.throws(()=>f.m.restore('P',r.id,true),/復元用/);
});
test('only approved completed chat history is eligible, queued and referenced histories are protected',t=>{
 const f=fixture(t),task=f.store.createTask('P',{title:'Done'});let t1=f.store.decideTask('P',task.id,'approve',task.completionHash);
 const chat=f.old('.ai/chat/'+task.id+'.jsonl','history');f.old('.ai/chat/'+task.id+'.queue.json','[]');
 assert.equal(f.m.preview('P').candidates.length,1);
 f.old('.ai/chat/'+task.id+'.queue.json','[{"text":"next"}]');assert.equal(f.m.preview('P').candidates.length,0);
 f.old('.ai/chat/'+task.id+'.queue.json','[]');fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'\n'+chat);assert.equal(f.m.preview('P').candidates.length,0);
 fs.writeFileSync(path.join(f.dir,'PROJECT.md'),'---\nname: P\n---\n');
 f.store.decideTask('P',t1.id,'continue',t1.completionHash);assert.equal(f.m.preview('P').candidates.length,0);
});
test('changed eligible content rejects a stale cleanup token',t=>{
 const f=fixture(t);const file=f.old('.ai/work/stale.dat'),d=f.m.preview('P');
 fs.writeFileSync(file,'changed');const when=new Date(Date.now()-40*DAY);fs.utimesSync(file,when,when);
 assert.throws(()=>f.m.apply('P',d.token,[d.candidates[0].id],true),/変わりました/);assert.equal(fs.readFileSync(file,'utf8'),'changed');
});
test('partial move retains a transaction and allows recovery of successful moves',t=>{
 const f=fixture(t);f.old('.ai/work/a.dat');f.old('.ai/work/b.dat');const d=f.m.preview('P'),original=fs.renameSync;
 fs.renameSync=(src,dst)=>{if(path.basename(src)==='b.dat'){const e=Error('fixture');e.code='EXDEV';throw e;}return original(src,dst);};
 let r;try {r=f.m.apply('P',d.token,d.candidates.map(c=>c.id),true);}finally{fs.renameSync=original;}
 assert.equal(r.ok,false);assert.equal(r.moved,1);assert.equal(f.m.restore('P',r.id,true).restored,1);assert.equal(f.m.history('P')[0].restored,true);
});
test('verification runs only confirmed existing scripts, skips npm hooks and locks AI launch until finished',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'test.cjs'),'setTimeout(()=>console.log("fixture passed"),50)');
 fs.writeFileSync(path.join(f.dir,'hook.cjs'),'require("fs").writeFileSync("hook-ran","bad")');
 const pkg=path.join(f.dir,'package.json');fs.writeFileSync(pkg,JSON.stringify({scripts:{test:'node test.cjs',pretest:'node hook.cjs',posttest:'node hook.cjs',build:'curl example.invalid'}}));
 const s=scriptsAt(f.dir);assert.equal(s.find(x=>x.name==='build').allowed,false);
 assert.equal((await f.m.verify('P','','',false)).ok,true);
 await assert.rejects(()=>f.m.verify('P','test','stale',true),/選び直/);
 await assert.rejects(()=>f.m.verify('P','test',s[0].hash,false),/選び直/);
 const pending=f.m.verify('P','test',s[0].hash,true);assert.equal(f.m.locked('P'),true);assert.throws(()=>f.m.apply('P','bad',[],true),/検証が動いて/);
 const r=await pending;assert.equal(r.ok,true);assert.match(r.result.output,/fixture passed/);assert.equal(fs.existsSync(path.join(f.dir,'hook-ran')),false);assert.equal(f.m.locked('P'),false);
});
test('verification reports broken structure and terminates an overlong local script',async t=>{
 const f=fixture(t,{timeout:350});fs.appendFileSync(path.join(f.dir,'PROJECT.md'),'');
 const task=f.store.createTask('P',{title:'Broken'});f.store.updateTask('P',task.id,{parent:'missing'});
 assert.equal((await f.m.verify('P')).ok,false);
 fs.writeFileSync(path.join(f.dir,'wait.cjs'),'setInterval(()=>{},1000)');fs.writeFileSync(path.join(f.dir,'package.json'),JSON.stringify({scripts:{test:'node wait.cjs'}}));
 const r=await f.m.verify('P','test',scriptsAt(f.dir)[0].hash,true);assert.equal(r.ok,false);assert.match(r.result.note,/時間内/);assert.equal(f.m.locked('P'),false);
});

test('shared body ledgers and Unicode-equivalent references protect old versions; nested Git is excluded',t=>{
 const f=fixture(t),body=path.join(f.root,'body');fs.mkdirSync(body);f.m.baseOf=()=>body;
 const oldDir=path.join(body,'作業/過去版');fs.mkdirSync(oldDir,{recursive:true});
 const nfd='データ.dat'.normalize('NFD'),file=path.join(oldDir,nfd);fs.writeFileSync(file,'version');const when=new Date(Date.now()-40*DAY);fs.utimesSync(file,when,when);
 const other=path.join(f.root,'Product/Q');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'PROJECT.md'),'---\nname: Q\n---\n参照：'+file.normalize('NFC'));
 assert.equal(f.m.preview('P').candidates.length,0);
 const nested=f.old('.ai/work/nested/.git/HEAD','git');fs.utimesSync(path.dirname(nested),when,when);fs.utimesSync(path.dirname(path.dirname(nested)),when,when);
 assert.ok(f.m.preview('P').excluded.some(e=>e.reason.includes('Git履歴')));
 fs.writeFileSync(path.join(body,'package.json'),JSON.stringify({scripts:{test:'jest',build:'tsc',check:'curl'}}));
 const scripts=scriptsAt(body);assert.equal(scripts.find(x=>x.name==='test').allowed,true);assert.equal(scripts.find(x=>x.name==='build').allowed,true);assert.equal(scripts.find(x=>x.name==='check').allowed,false);
});

test('構造確認は資料の相対パスをプロジェクト基準に解決し、絶対・ホーム指定と欠落も正しく判定する',async t=>{
 const f=fixture(t),relative='資料/確認 用/原文.md',file=f.old(relative,'keep this source');
 const cwdOnly=path.relative(process.cwd(),__filename);
 assert.equal(fs.existsSync(cwdOnly),true);
 assert.equal(fs.existsSync(path.resolve(f.dir,cwdOnly)),false);
 const folders={相対資料:relative,絶対資料:file,ホーム:'~',欠落:'資料/missing',実行場所だけ:cwdOnly};
 const doc='---\nname: P\nfolders:\n'+Object.entries(folders).map(([label,file])=>'  '+label+': '+file).join('\n')+'\n---\n';
 fs.writeFileSync(path.join(f.dir,'PROJECT.md'),doc);
 const r=await f.m.verify('P');
 const check=label=>r.checks.find(c=>c.name==='フォルダ：'+label);
 for(const label of ['相対資料','絶対資料','ホーム'])assert.equal(check(label).ok,true,label);
 for(const label of ['欠落','実行場所だけ'])assert.equal(check(label).ok,false,label);
 assert.equal(r.ok,false);assert.equal(check('相対資料').detail,relative);
 assert.equal(fs.readFileSync(file,'utf8'),'keep this source');assert.equal(fs.readFileSync(path.join(f.dir,'PROJECT.md'),'utf8'),doc);
});

test('stopped preview retains protected large reference path, size and busy state',t=>{
 const f=fixture(t),large=f.old('large.json','x'.repeat(1024*1024+1));f.busy(true);
 const d=f.m.preview('P');assert.equal(d.token,'');assert.equal(d.candidates.length,0);assert.equal(d.stopped.path,large);assert.equal(d.stopped.size,1024*1024+1);assert.equal(d.busy,true);assert.equal(fs.statSync(large).size,1024*1024+1);
});
test('interrupted restore journal recovers only the exact restored bytes after reopening',t=>{
 const f=fixture(t),file=f.old('.ai/work/old.dat','keep bytes'),preview=f.m.preview('P');
 const moved=f.m.apply('P',preview.token,preview.candidates.map(c=>c.id),true);assert.equal(moved.ok,true);
 const save=f.m.save.bind(f.m);f.m.save=r=>{if(r.entries.some(e=>e.restored))throw Error('fixture journal failure');save(r);};
 assert.throws(()=>f.m.restore('P',moved.id,true),/journal failure/);assert.equal(fs.readFileSync(file,'utf8'),'keep bytes');
 const reopened=new Maintenance({store:f.store,baseOf:p=>p.dir,trash:f.trash});
 assert.equal(reopened.history('P')[0].restored,true);assert.deepEqual(reopened.restore('P',moved.id,true),{ok:true,restored:0});
});
test('broken cleanup history never masquerades as an empty successful history',t=>{
 const f=fixture(t);fs.mkdirSync(f.m.records,{recursive:true});fs.writeFileSync(path.join(f.m.records,'00000000-0000-4000-8000-000000000000.json'),'{broken');assert.throws(()=>f.m.history('P'));
});
test('cleanup rejects a corrupted boolean state instead of silently treating it as restored',t=>{
 const f=fixture(t),file=f.old('.ai/work/old.dat'),preview=f.m.preview('P'),moved=f.m.apply('P',preview.token,preview.candidates.map(c=>c.id),true);
 const recordFile=path.join(f.m.records,moved.id+'.json'),record=JSON.parse(fs.readFileSync(recordFile));record.entries[0].restored='false';fs.writeFileSync(recordFile,JSON.stringify(record));
 assert.throws(()=>f.m.history('P'),/破損/);assert.throws(()=>f.m.restore('P',moved.id,true),/破損/);assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(record.entries[0].dest),true);
});
