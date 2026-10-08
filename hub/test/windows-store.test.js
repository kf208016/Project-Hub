'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store');
const win=process.platform==='win32'?test:test.skip;
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
