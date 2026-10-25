'use strict';
// Regression coverage for controller lifetime and native runtime contracts.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const tool=require('../windows/native-install.cjs');
const win=process.platform==='win32'?test:test.skip;
function temp(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-installer-process-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function installer(t,options={}){const tmp=temp(t),base=path.join(tmp,'ProjectHub'),dataRoot=path.join(tmp,'AI-Workspace');fs.mkdirSync(base);fs.mkdirSync(dataRoot);return {tmp,base,dataRoot,i:new tool.Installer({installBase:base,dataRoot,packageContext:()=>null,...options})};}
const overlay=(tmp,file)=>path.join(tmp,'Packages','Example_0000000000000','LocalCache','Local','ProjectHub',path.basename(file));

win('a virtualized new write is refused although the process has no package identity and no existing path is redirected',t=>{
  let probes=0;const f=installer(t,{realpath:file=>{if(path.basename(file).startsWith('.hub-write-probe-')){probes++;return overlay(path.dirname(path.dirname(file)),file);}return fs.realpathSync.native(file);}});
  assert.throws(()=>f.i.preview({packageRoot:f.tmp,manifestSha256:'a'.repeat(64)}),{code:'INSTALL_BASE_VIRTUALIZED'});
  assert.throws(()=>f.i.launch(true,true),{code:'INSTALL_BASE_VIRTUALIZED'});
  assert.throws(()=>f.i.rollback(),{code:'INSTALL_BASE_VIRTUALIZED'});
  const status=f.i.status();assert.equal(status.virtualized,true);assert.match(status.warning,/封裝|重新導向/);
  assert.ok(probes>=4,'every action resolved a fresh write probe');
  assert.deepEqual(fs.readdirSync(f.base).filter(name=>name.startsWith('.hub-write-probe-')),[],'probe directories are always removed');
});

win('the write probe does not flag a real, unvirtualized base',t=>{
  const f=installer(t);const status=f.i.status();assert.equal(status.virtualized,false);assert.equal(status.installed,false);
  assert.deepEqual(fs.readdirSync(f.base),[]);
});

win('the FFmpeg pointer is never bound to a target that resolves into a virtualized copy',t=>{
  const f=installer(t,{realpath:file=>path.basename(file)==='ffmpeg.exe'?overlay(f.tmp,file):fs.realpathSync.native(file)});
  const slot=path.join(f.base,'versions','4.68.2-windows-codex-aaaaaaaaaaaa'),exe=path.join(slot,'dependencies/ffmpeg-9.0.2/bin/ffmpeg.exe');fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'synthetic');
  assert.throws(()=>f.i.bindDependency(slot),{code:'INSTALL_BASE_VIRTUALIZED'});
  assert.equal(fs.existsSync(path.join(f.dataRoot,'_hub','native-dependencies.json')),false);
});

win('status reports an unverifiable current.json as unknown instead of not installed',t=>{
  const f=installer(t);fs.writeFileSync(path.join(f.base,'current.json'),'{}');
  const status=f.i.status();assert.equal(status.installed,null);assert.equal(typeof status.code,'string');assert.match(status.warning,/不代表尚未安裝/);
});

win('a corrupt leftover helper with a matching name never blocks the installer helper',t=>{
  const runtime=path.join(__dirname,'../.runtime'),source=fs.readFileSync(path.join(__dirname,'../windows/install-files.cs'));
  fs.mkdirSync(runtime,{recursive:true});
  const junk=path.join(runtime,'install-files-'+crypto.createHash('sha256').update(source).digest('hex').slice(0,16)+'-'+'0'.repeat(32)+'.exe');
  fs.writeFileSync(junk,'not a helper');t.after(()=>fs.rmSync(junk,{force:true}));
  const run=require('node:child_process').spawnSync(process.execPath,['-e',"process.stdout.write(JSON.stringify(require('./windows/native-install.cjs').native({mode:'package-context'})))"],{cwd:path.join(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).ok,true);
});

win('the update lock records the owner creation time as UTC epoch milliseconds',t=>{
  const {NativeCliUpdater}=require('../lib/native-cli-update');const root=temp(t);
  const self=new NativeCliUpdater({root}).processIdentity.self(),expected=Date.now()-process.uptime()*1000;
  assert.equal(self.pid,process.pid);assert.ok(Math.abs(self.created-expected)<120000,`created ${self.created} vs ${Math.round(expected)}`);
});

test('a start inside an existing workspace flow keeps the baseline path without an extra process scan',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.ok(server.includes('if(!current){assertWorkspaceIdle(p,t,allowExisting);if(workspacePermit){await procwatch.scan();procwatch.assertKnown();}}'));
});
