'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store'),locks=require('../lib/task-write-lock');
test('partial handoff blocks mutations before task IDs or completion ledger changes; reads preserve approval bytes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-web-store-owned-')),store=new Store(root),project=store.createProject({name:'synthetic'}).project,task=store.createTask(project.id,{title:'synthetic',owner:'codex'}),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const ledger=store.completion.file;store.completion.data.tasks[project.id+'/'+task.id]={hash:'synthetic historical approval'};store.completion.save();
 const before=fs.readFileSync(ledger),tasks=fs.readdirSync(path.join(project.dir,'.ai/tasks'));locks.hold(project.dir,task.id,id);
 try{
  store.readProject(project.id);assert.deepEqual(fs.readFileSync(ledger),before);
  for(const operation of [()=>store.createTask(project.id,{title:'blocked'}),()=>store.updateTask(project.id,task.id,{memo:'blocked'}),()=>store.continuePhase(project.id),()=>store.completion.approveTask(project.id+'/'+task.id,'blocked')])assert.throws(operation,{code:'HANDOFF_WRITE_BUSY'});
  assert.deepEqual(fs.readFileSync(ledger),before);assert.deepEqual(fs.readdirSync(path.join(project.dir,'.ai/tasks')),tasks);
 }finally{locks.release(project.dir,task.id,id);const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith('hub-web-store-owned-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
