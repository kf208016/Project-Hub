'use strict';
// Synthetic controller and filesystem fixtures; no model, installed Hub or owner data.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {waitForHub,waitFor}=require('./helpers/wait-hub');
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-controller-filesystem-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function installerFixture(t){
 const file=require.resolve('../windows/native-install.cjs'),mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
 mod._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.inject=(n,h)=>{native=n;fileHash=h;};',file);
 const root=temp(t),base=path.join(root,'ProjectHub'),data=path.join(root,'AI-Workspace');fs.mkdirSync(path.join(data,'_hub'),{recursive:true});
 const tool=mod.exports,i=new tool.Installer({installBase:base,dataRoot:data,port:54321,packageContext:()=>null}),pointer=path.join(data,'_hub/native-dependencies.json'),calls=[];
 let targetHash=tool.FFMPEG.sha256;
 tool.inject(q=>{calls.push(q);if(q.mode==='inspect'&&q.path.endsWith('native-dependencies.json'))return {text:fs.readFileSync(pointer,'utf8'),sha256:'a'.repeat(64),fileFingerprint:'b'.repeat(64)};if(q.mode==='inspect')return {sha256:targetHash};return {ok:true};},()=>({sha256:targetHash}));
 return {root,base,data,tool,i,pointer,calls,hash:value=>targetHash=value};
}
test('dependency rebind uses _hub CAS and fingerprint, heals missing target and leaves exact pointer untouched',t=>{
 const f=installerFixture(t),slot=path.join(f.base,'versions/synthetic'),exe=path.join(slot,'dependencies/ffmpeg-9.0.2/bin/ffmpeg.exe');
 f.i.bindDependency(slot);let write=f.calls.find(q=>q.mode==='write');assert.equal(write.root,path.join(f.data,'_hub'));assert.equal(write.path,'native-dependencies.json');assert.equal(write.expectedHash,'missing');
 const value=JSON.parse(write.text);assert.equal(value.heicDecoder.path,exe);fs.writeFileSync(f.pointer,JSON.stringify({...value,heicDecoder:{...value.heicDecoder,path:path.join(f.root,'deleted/ffmpeg.exe')}}));
 assert.equal(f.i.dependencies().rebindNeeded,true);f.calls.length=0;f.i.bindDependency(slot);write=f.calls.find(q=>q.mode==='write');assert.equal(write.expectedHash,'a'.repeat(64));assert.equal(write.fileFingerprint,'b'.repeat(64));
 fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'synthetic bytes');fs.writeFileSync(f.pointer,JSON.stringify(value));f.calls.length=0;f.i.bindDependency(slot);assert.equal(f.calls.some(q=>q.mode==='write'),false);
 f.hash('0'.repeat(64));assert.throws(()=>f.i.dependencies(),{code:'EXISTING_DEPENDENCY_CHANGED'});assert.throws(()=>f.i.bindDependency(slot),{code:'EXISTING_DEPENDENCY_CHANGED'});
 fs.writeFileSync(f.pointer,'{}');assert.throws(()=>f.i.dependencies(),{code:'EXISTING_DEPENDENCY_UNKNOWN'});
});
test('readiness requires a listening signal plus HTTP 200; exit diagnostics fail fast',async t=>{
 const http=require('node:http'),child=new EventEmitter();child.stdout=new PassThrough();child.exitCode=null;child.signalCode=null;let requests=0;
 const server=http.createServer((_req,res)=>{requests++;res.writeHead(requests===1?503:200);res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port,pending=waitForHub(base,child,()=>'',{deadlineMs:2000,intervalMs:5});child.stdout.write('HUB_LISTENING\n');await pending;assert.equal(requests,2);
 child.exitCode=17;await assert.rejects(waitForHub(base,child,()=> 'owned stderr tail'),/17.*owned stderr tail/);
 await assert.rejects(waitFor(()=>false,{deadlineMs:1,intervalMs:1}),/last=false/);
});
test('virtualized package and per-file redirect refuse all actions before IO, status remains diagnostic',t=>{
 const f=installerFixture(t);fs.mkdirSync(f.base);f.i.packageContext=()=> 'Synthetic.Package';f.i.userDataRoots=[f.root];f.i.tempRoot=path.join(f.root,'other-temp');
 for(const act of [()=>f.i.preview({}),()=>f.i.install({}),()=>f.i.launch(),()=>f.i.launch(true),()=>f.i.rollback(),()=>f.i.restorePointer({})])assert.throws(act,{code:'INSTALL_BASE_VIRTUALIZED'});
 assert.equal(f.i.status().virtualized,true);assert.match(f.i.status().warning,/MSIX/);assert.equal(f.calls.length,0);
 f.i.packageContext=()=>null;fs.writeFileSync(path.join(f.base,'current.json'),'{}');f.i.realpath=file=>file.endsWith('current.json')?path.join(f.root,'Packages/family/LocalCache/current.json'):file;
 assert.deepEqual(f.i.virtualization().redirected,[path.join(f.base,'current.json')]);assert.throws(()=>f.i.launch(true),{code:'INSTALL_BASE_VIRTUALIZED'});
 f.i.realpath=()=>{throw Error('synthetic inaccessible path');};assert.doesNotThrow(()=>f.i.status());assert.equal(f.i.status().virtualized,true);
});
test('rooted sharing refusal maps only the exact code and survives the worker protocol',async t=>{
 const rooted=require('../lib/rooted-move'),message=rooted.messageFor('NT_REJECTED_C0000043');assert.match(message,/來源資料夾/);assert.equal(rooted.messageFor('Windows rooted move: NT_REJECTED_C0000043'),null);
 const {ReviewedGitService}=require('../lib/reviewed-git-service'),root=temp(t),service=new ReviewedGitService({root,resolve:()=>{},spawn:()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  child.stdin.once('finish',()=>{child.stdout.end(JSON.stringify({version:1,ok:false,error:'raw diagnostic',code:'NT_REJECTED_C0000043'}));child.emit('close',0);});return child;
 }});
 await assert.rejects(service.invoke('preview',{project:'p',task:'t'},{}),e=>e.code==='NT_REJECTED_C0000043'&&rooted.messageFor(e.code)===message);
});
