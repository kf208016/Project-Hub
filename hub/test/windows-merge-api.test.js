'use strict';
const {waitForHub,waitFor}=require('./helpers/wait-hub');
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process');
const {spawn}=require('../lib/managed-process'),cli=require('../lib/cli-platform'),gitw=require('../lib/git'),{Store}=require('../lib/store');
const win=process.platform==='win32'?test:test.skip;
async function holdDirectory(dir,root){
  const source=path.join(root,'hold-directory.cs'),binary=path.join(root,'hold-directory.exe');
  const releaseFile=path.join(root,'release-directory-pin');
  fs.writeFileSync(source,'using System; using System.IO; using System.Threading; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; class Hold { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t); static int Main(string[] a){using(var h=CreateFile(a[0],0x80000000,3,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){if(h.IsInvalid)return 1;Console.WriteLine("READY");Console.Out.Flush();for(int n=0;n<12000&&!File.Exists(a[1]);n++)Thread.Sleep(25);return 0;}} }');
  const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/out:'+binary,source],{windowsHide:true,stdio:'pipe',timeout:30000});
  const child=spawn(binary,[dir,releaseFile],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.resume();
  await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned directory pin timed out'));},10000);child.stdout.on('data',data=>{out+=data;if(out.includes('READY')){clearTimeout(timer);resolve();}});child.once('close',()=>{clearTimeout(timer);reject(Error('Owned directory pin failed'));});});
  assert.equal(child.exitCode,null,'owned pin process is alive');assert.throws(()=>fs.renameSync(dir,dir+'.unapproved-move'),error=>['EACCES','EPERM','EBUSY'].includes(error.code),'actual OS handle refuses renaming the source');
  return async()=>{fs.writeFileSync(releaseFile,'release');if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));};
}
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-merge-api-')),repo=path.join(root,'來源 & Unicode-甲');fs.mkdirSync(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.autocrlf',GIT_CONFIG_VALUE_0:'false'}}).trim();
  git('init','-q');git('config','user.name','Synthetic');git('config','user.email','synthetic@example.test');git('config','core.autocrlf','false');
  fs.writeFileSync(path.join(repo,'initial.txt'),'initial\n');git('add','initial.txt');git('commit','-qm','initial');
  fs.mkdirSync(path.join(root,'_hub'));fs.copyFileSync(path.join(__dirname,'../windows/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  const query=path.join(root,'process-query.json'),blockedMove=path.join(root,'block-own-move');
  const preload=path.join(root,'preload.cjs'),hub=path.join(__dirname,'..');
  fs.writeFileSync(preload,`const fs=require('node:fs');const query=${JSON.stringify(query)},blockedMove=${JSON.stringify(blockedMove)};
const originalRename=fs.renameSync;fs.renameSync=function(from,to){if(String(to).includes('merge-trash')&&fs.existsSync(blockedMove)){const e=Error('synthetic move denied');e.code='EACCES';throw e;}return originalRename.apply(this,arguments);};
const procwatch=require(${JSON.stringify(path.join(hub,'lib/procwatch.js'))});const originalCreate=procwatch.create;
procwatch.create=opts=>originalCreate({...opts,exec:async()=>fs.existsSync(query)?fs.readFileSync(query,'utf8'):JSON.stringify([{pid:process.pid,ppid:0,since:new Date().toISOString(),name:'node.exe',command:'synthetic Hub server'}])});
const {server,PORT}=require(${JSON.stringify(path.join(hub,'server.js'))});server.listen(PORT,'127.0.0.1',()=>console.log('HUB_LISTENING'));
`);
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const systemPath=[path.dirname(process.execPath),path.dirname(cli.find('git')),path.join(process.env.SystemRoot,'System32'),path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0')].join(path.delimiter);
  const secret='M'.repeat(43),child=spawn(process.execPath,[preload],{cwd:hub,env:{...process.env,PATH:systemPath,HUB_ROOT:root,HUB_TRASH:path.join(root,'trash'),HUB_PORT:String(port),HUB_AI_HOME:path.join(root,'empty-home'),HUB_LOCAL_TOKEN:secret}});
  let stderr='';child.stdin.end();child.stdout.on('data',()=>{});child.stderr.on('data',d=>stderr+=d.toString('utf8').slice(0,1000));
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('close',r));}fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
  const base=`http://127.0.0.1:${port}`;
  await waitForHub(base,child,()=>stderr);
  let cookie='';
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Connection:'close',Cookie:cookie,...headers},body:JSON.stringify(body)}).catch(error=>{throw Error('Synthetic '+route+' failed; owned server exit='+child.exitCode+'; '+stderr.slice(-2500),{cause:error});});
  const login=await post('/api/local/login',{token:secret});assert.equal(login.status,200,await login.clone().text());cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/project/new',{name:'p',body:repo})).status,200);
  const store=new Store(root);
  const create=(id)=>{const task=store.createTask('p',{id,title:id,owner:'codex'});const work=gitw.prepare({base:repo,workRoot:path.join(root,'Work/p'),taskId:task.id});store.updateTask('p',task.id,{workdir:work.dir});return {id:task.id,dir:work.dir};};
  return {root,repo,git,post,store,create,query,blockedMove,port,cookie};
}

win('Windows merge HTTP binds authenticated confirmation to the exact snapshot and records success before cleanup',{timeout:180000},async t=>{
  const f=await fixture(t),task=f.create('one');fs.writeFileSync(path.join(task.dir,'new.txt'),'new\n');
  const body={project:'p',task:task.id};
  assert.equal((await f.post('/api/task/merge',body)).status,409);
  let previewFinished=false;const previewRequest=f.post('/api/task/merge/preview',body,{Cookie:''}).then(response=>{previewFinished=true;return response;});
  await new Promise(resolve=>setTimeout(resolve,100));
  const pendingMutation=await f.post('/api/task',{project:'p',task:task.id,owner:'codex',memo:'must remain unchanged during Git worker'});assert.equal(pendingMutation.status,409);
  assert.equal((await fetch('http://127.0.0.1:'+f.port+'/api/state',{headers:{Cookie:f.cookie}})).status,200);assert.equal(previewFinished,false,'HTTP reads respond while the owned Git worker is still running');
  let response=await previewRequest;assert.equal(response.status,200,await response.clone().text());let preview=await response.json();
  fs.writeFileSync(path.join(task.dir,'new.txt'),'changed after preview\n');
  assert.equal((await f.post('/api/task/merge',{...body,token:preview.token,confirm:true})).status,409);assert.equal(fs.existsSync(task.dir),true);assert.equal(fs.existsSync(path.join(f.repo,'new.txt')),false);
  response=await f.post('/api/task/merge/preview',body);assert.equal(response.status,200,await response.clone().text());preview=await response.json();
  assert.equal((await f.post('/api/task/merge',{project:'p',task:'other',token:preview.token,confirm:true})).status,409);
  assert.equal((await f.post('/api/task/merge',{...body,token:preview.token,confirm:true},{Origin:'https://example.invalid'})).status,403);
  response=await f.post('/api/task/merge/preview',body);assert.equal(response.status,200,await response.clone().text());preview=await response.json();
  const merged=await f.post('/api/task/merge',{...body,token:preview.token,confirm:true});assert.equal(merged.status,200,await merged.clone().text());const result=await merged.json();
  assert.equal(result.ok,true);assert.equal(fs.readFileSync(path.join(f.repo,'new.txt'),'utf8'),'changed after preview\n');assert.equal(fs.existsSync(task.dir),false);assert.equal(fs.existsSync(result.trashed),true);
  const journal=JSON.parse(fs.readFileSync(path.join(f.root,'_hub/reviewed-merges',result.recordId+'.json'),'utf8'));assert.equal(journal.complete,true);assert.equal(journal.commit,result.commit);
  assert.equal(f.store.readProject('p').tasks.find(x=>x.id===task.id).workdir,'');
  assert.equal((await f.post('/api/task/merge',{...body,token:preview.token,confirm:true})).status,409);
});

win('Windows merge HTTP retains its source after an actual OS cleanup refusal and resumes durable merge evidence',{timeout:300000},async t=>{
  const f=await fixture(t),task=f.create('resume');fs.writeFileSync(path.join(task.dir,'recover.txt'),'recover\n');let release=null;
  try{
  const body={project:'p',task:task.id};const pr=await f.post('/api/task/merge/preview',body);assert.equal(pr.status,200,await pr.clone().text());let preview=await pr.json();release=await holdDirectory(task.dir,f.root);
  const failed=await f.post('/api/task/merge',{...body,token:preview.token,confirm:true});assert.equal(failed.status,409);const partial=await failed.json();assert.equal(partial.ok,false,JSON.stringify(partial));assert.equal(partial.partial,true,JSON.stringify(partial));
  assert.equal(fs.existsSync(task.dir),true);assert.equal(fs.readFileSync(path.join(f.repo,'recover.txt'),'utf8'),'recover\n');assert.notEqual(f.store.readProject('p').tasks.find(x=>x.id===task.id).workdir,'');
  const committed=f.git('rev-parse','HEAD');await release();release=null;
  const next=await f.post('/api/task/merge/preview',body);assert.equal(next.status,200,await next.clone().text());preview=await next.json();assert.equal(preview.resume,true);
  const resumed=await f.post('/api/task/merge',{...body,token:preview.token,confirm:true});assert.equal(resumed.status,200,await resumed.clone().text());assert.equal(f.git('rev-parse','HEAD'),committed);assert.equal(fs.existsSync(task.dir),false);
  }finally{if(release)await release();}
});

win('Windows merge HTTP blocks unknown external AI and corrupt journal before Git writes',{timeout:60000},async t=>{
  const f=await fixture(t),task=f.create('blocked');fs.writeFileSync(path.join(task.dir,'pending.txt'),'pending\n');const head=f.git('rev-parse','HEAD'),body={project:'p',task:task.id};
  const other=f.create('foreign');f.store.updateTask('p',task.id,{workdir:other.dir});
  assert.equal((await f.post('/api/task/merge/preview',body)).status,409,'a task cannot borrow another task worktree');
  assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(fs.existsSync(task.dir),true);assert.equal(fs.existsSync(other.dir),true);
  f.store.updateTask('p',task.id,{workdir:task.dir});
  fs.writeFileSync(f.query,JSON.stringify([{pid:2147480000,ppid:0,since:'2026-10-08T00:00:00.000Z',name:'codex.exe',command:'codex.exe'}]));
  assert.equal((await f.post('/api/task/merge/preview',body)).status,409);assert.equal(f.git('rev-parse','HEAD'),head);
  fs.unlinkSync(f.query);const journalDir=path.join(f.root,'_hub/reviewed-merges');fs.mkdirSync(journalDir,{recursive:true});fs.writeFileSync(path.join(journalDir,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'),'broken');
  assert.equal((await f.post('/api/task/merge/preview',body)).status,409);assert.equal(fs.existsSync(task.dir),true);assert.equal(f.git('rev-parse','HEAD'),head);
});
