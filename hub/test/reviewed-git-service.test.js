'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {execFileSync}=require('node:child_process');
const {ReviewedGitService,workerEnvironment}=require('../lib/reviewed-git-service');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-git-worker-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50}));
  const d={project:'p',task:'one',title:'one',taskHash:'fixture',dir:path.join(root,'Work/p/one'),workRoot:path.join(root,'Work/p'),target:path.join(root,'repo')};
  return {root,d};
}
function fake(reply,delay=20){
  return (file,args,options)=>{
    assert.equal(file,process.execPath);assert.equal(path.basename(args[0]),'reviewed-git-worker.js');assert.equal(options.env.HUB_LOCAL_TOKEN,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null});let request='';
    child.stdin.setEncoding('utf8');child.stdin.on('data',x=>request+=x);const close=code=>{child.exitCode=code;child.emit('close',code);};
    child.kill=()=>{setImmediate(()=>close(null));return true;};
    child.stdin.on('finish',()=>setTimeout(()=>{if(child.exitCode!==null)return;const data=typeof reply==='function'?reply(JSON.parse(request)):reply;child.stdout.end(typeof data==='string'?data:JSON.stringify(data));close(0);},delay));return child;
  };
}
test('owned Git service keeps the event loop available and rejects concurrent scope, replay, expiry and task changes',async t=>{
  const f=fixture(t),now={at:Date.now()},result={project:'p',task:'one',taskHash:'fixture',token:'worker-owned-token'};
  let calls=0;const service=new ReviewedGitService({root:f.root,resolve:()=>({...f.d}),now:()=>now.at,spawn:fake(q=>{calls++;if(q.method==='preview')return {version:1,ok:true,value:result};assert.equal(q.args.entry.value.task,'one');return {version:1,ok:true,value:{ok:true}};},40)});
  service.reader.common=()=>path.join(f.root,'synthetic-common');
  const pvPromise=service.preview('p','one');assert.equal(service.active(),1);assert.equal(service.pending(f.d.target),true);assert.throws(()=>service.stop(),/仍在執行/);
  await assert.rejects(service.preview('p','one'),/正在執行/);let ticked=false;setTimeout(()=>ticked=true,5);const pv=await pvPromise;assert.equal(ticked,true);assert.equal(service.active(),0);assert.notEqual(pv.token,result.token);
  await assert.rejects(service.apply({...pv,project:'p',task:'other',confirm:true}),/格式無效/);
  const command={project:'p',task:'one',token:pv.token,confirm:true};assert.equal((await service.apply(command)).ok,true);await assert.rejects(service.apply(command),/重新預覽/);
  const stale=await service.preview('p','one');now.at+=600001;await assert.rejects(service.apply({project:'p',task:'one',token:stale.token,confirm:true}),/重新預覽/);
  now.at=Date.now();const changes=service.preview('p','one');f.d.taskHash='changed';await assert.rejects(changes,/預覽期間/);assert.equal(calls,4);service.stop();await assert.rejects(service.preview('p','one'),/已停止/);
});
test('Git service rejects broken worker protocol, oversized output, timeout and failed startup',async t=>{
  const f=fixture(t);
  for(const reply of ['not-json',{version:1,ok:true},{version:1,ok:true,value:{},unexpected:true},{version:1,ok:false,error:'synthetic refused'},'x'.repeat(4*1024*1024+1)]){
    const service=new ReviewedGitService({root:f.root,resolve:()=>({...f.d}),spawn:fake(reply)});service.reader.common=()=>path.join(f.root,'synthetic-common');await assert.rejects(service.preview('p','one'));assert.equal(service.active(),0);
  }
  const timeout=new ReviewedGitService({root:f.root,resolve:()=>({...f.d}),spawn:fake({version:1,ok:true,value:{}},2000),timeoutMs:1000});timeout.reader.common=()=>path.join(f.root,'synthetic-common');await assert.rejects(timeout.preview('p','one'),/逾時/);assert.equal(timeout.active(),0);
  const failed=new ReviewedGitService({root:f.root,resolve:()=>({...f.d}),spawn:()=>{throw Error('synthetic startup failure');}});failed.reader.common=()=>path.join(f.root,'synthetic-common');await assert.rejects(failed.preview('p','one'),/startup/);assert.equal(failed.active(),0);
});
test('worker env does not carry controller or preload credentials',()=>{
  const old={};for(const key of ['HUB_LOCAL_TOKEN','HUB_MCP_TOKEN','NODE_OPTIONS','GIT_DIR']){old[key]=process.env[key];process.env[key]='synthetic secret';}
  try{const env=workerEnvironment();for(const key of Object.keys(old))assert.equal(env[key],undefined);assert.ok(env.SystemRoot||process.platform!=='win32');}
  finally{for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('private real worker performs a checked synthetic merge with durable receipt',{timeout:600000},async t=>{
  const f=fixture(t);fs.mkdirSync(f.d.target);fs.mkdirSync(f.d.workRoot,{recursive:true});
  const cmd=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  cmd(f.d.target,'init','-q');cmd(f.d.target,'config','user.name','Synthetic');cmd(f.d.target,'config','user.email','synthetic@example.test');cmd(f.d.target,'config','core.autocrlf','false');fs.writeFileSync(path.join(f.d.target,'initial.txt'),'initial\n');cmd(f.d.target,'add','initial.txt');cmd(f.d.target,'commit','-qm','initial');cmd(f.d.target,'worktree','add','-qb','hub/one',f.d.dir);
  fs.writeFileSync(path.join(f.d.dir,'new.txt'),'owned worker\n');
  const service=new ReviewedGitService({root:f.root,resolve:()=>({...f.d})});const started=Date.now(),preview=await service.preview('p','one');assert.equal(preview.files,1);const result=await service.apply({project:'p',task:'one',token:preview.token,confirm:true});assert.equal(result.ok,true,result.error);assert.equal(fs.readFileSync(path.join(f.d.target,'new.txt'),'utf8'),'owned worker\n');assert.equal(fs.existsSync(f.d.dir),false);assert.ok(fs.existsSync(result.trashed));assert.equal((await service.receipt('p','one')).commit,result.commit);assert.equal(service.recovery('p','one').complete,true);assert.equal(service.active(),0);t.diagnostic('real worker elapsed '+(Date.now()-started)+' ms');service.stop();
});
