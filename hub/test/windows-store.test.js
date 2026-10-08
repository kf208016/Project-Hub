'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store');
const win=process.platform==='win32'?test:test.skip;
test('Task step updates accept CRLF and reject coerced types without changing the file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-step-crlf-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=new Store(root);store.createProject({name:'p'});const project=store.readProject('p'),task=store.createTask(project.id,{title:'CRLF',steps:['first','second']});
 const file=store.taskFile(project.id,task.id);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/\r?\n/g,'\r\n'));
 const before=fs.readFileSync(file);
 for(const [index,done]of [['0',true],[0,'false'],[-1,true],[NaN,true]]){assert.equal(store.setStep(project.id,task.id,index,done),null);assert.deepEqual(fs.readFileSync(file),before);}
 const result=store.setStep(project.id,task.id,0,true);assert.ok(result);assert.equal(result.steps[0].done,true);assert.equal(result.steps[1].done,false);
 const appended=store.addStep(project.id,task.id,'third');assert.deepEqual(appended.steps.map(step=>step.text),['first','second','third']);assert.equal(/(?<!\r)\n/.test(fs.readFileSync(file,'utf8')),false);
});

test('Reference insertion preserves CRLF frontmatter and rejects a missing terminator without rewriting',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-refs-crlf-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new Store(root),p=store.createProject({name:'refs'}).project,file=path.join(p.dir,'PROJECT.md');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/\r?\n/g,'\r\n'));const target=path.join(root,'synthetic-reference');fs.mkdirSync(target);const result=store.addRefs(p.id,[target]);assert.equal(result.added,1);assert.equal(result.project.folders.filter(x=>x.path===target).length,1);assert.equal(/(?<!\r)\n/.test(fs.readFileSync(file,'utf8')),false);
 const broken=fs.readFileSync(file,'utf8').replace(/\r\n---\r\n/,'\r\n');fs.writeFileSync(file,broken);const before=fs.readFileSync(file);assert.throws(()=>store.addRefs(p.id,[root]),/frontmatter/);assert.deepEqual(fs.readFileSync(file),before);
});
win('Windows ledger rejects reserved names, ADS and aliased project/task paths',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-win-ledger-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'hub-win-ledger-outside-'));
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
 const store=new Store(root);
 for(const name of ['CON','project:stream','尾點.'])assert.ok(store.createProject({name}).error,name);
 const project=store.createProject({name:'測試專案'}).project;assert.ok(project);
 fs.writeFileSync(path.join(outside,'PROJECT.md'),'---\nname: outside\n---\n');
 fs.symlinkSync(outside,path.join(root,'Product','linked'),'junction');
 assert.equal(store.projectDir('linked'),null);assert.equal(store.readProject('linked'),null);
 const tasks=path.join(project.dir,'.ai','tasks');fs.rmdirSync(tasks);fs.symlinkSync(outside,tasks,'junction');
 fs.writeFileSync(path.join(outside,'secret.md'),'synthetic');
 assert.equal(store.taskFile(project.id,'secret'),null);assert.throws(()=>store.createTask(project.id,{title:'must not write'}),/junction|symlink/);
 assert.deepEqual(fs.readdirSync(outside).sort(),['PROJECT.md','secret.md']);
});
