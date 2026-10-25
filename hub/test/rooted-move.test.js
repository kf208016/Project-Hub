'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const rooted=require('../lib/rooted-move'),scoped=require('../lib/scoped-file');
const native={skip:process.platform!=='win32'||process.arch!=='x64'||os.release()!=='10.0.26200'};
let tmp;test.before(()=>{tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-rooted-move-'));});test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
function fixture(label){const root=path.join(tmp,label),sourceRoot=path.join(root,'source'),targetRoot=path.join(root,'trash'),journalRoot=path.join(root,'journal');for(const d of [sourceRoot,targetRoot,journalRoot])fs.mkdirSync(d,{recursive:true});return {root,sourceRoot,targetRoot,journalRoot};}
function tree(f,name='tree'){const dir=path.join(f.sourceRoot,name);fs.mkdirSync(path.join(dir,'子 目錄'),{recursive:true});fs.writeFileSync(path.join(dir,'子 目錄','證據.txt'),'synthetic unchanged');fs.writeFileSync(path.join(dir,'empty.txt'),'');return dir;}
test('bound nonempty Unicode tree moves and restores with independent native receipts',native,async()=>{
 const f=fixture('normal'),source=tree(f),plan=await rooted.plan({...f,sourcePath:'tree',targetPath:'record/tree'});assert.equal(plan.algorithm,'native-tree-v1');const before=await rooted.snapshot({root:f.sourceRoot,path:'tree'});assert.equal(before.objectId,plan.objectId);const out=await rooted.move(plan);assert.equal(out.state,'complete');assert.equal(fs.existsSync(source),false);assert.equal(fs.readFileSync(path.join(f.targetRoot,'record/tree/子 目錄/證據.txt'),'utf8'),'synthetic unchanged');assert.equal((await rooted.recover(plan)).state,'complete');
 const undo=await rooted.plan({sourceRoot:f.targetRoot,sourcePath:'record/tree',targetRoot:f.sourceRoot,targetPath:'tree',journalRoot:f.journalRoot});assert.equal(undo.objectId,plan.objectId);assert.equal(undo.treeHash,plan.treeHash);assert.equal((await rooted.move(undo)).state,'complete');assert.equal((await rooted.recover(undo)).state,'complete');assert.equal(fs.readFileSync(path.join(source,'子 目錄/證據.txt'),'utf8'),'synthetic unchanged');
});
test('source content and object replacement reject stale plans before move',native,async()=>{
 const f=fixture('stale');fs.writeFileSync(path.join(f.sourceRoot,'x'),'one');const p=await rooted.plan({...f,sourcePath:'x',targetPath:'x'});fs.writeFileSync(path.join(f.sourceRoot,'x'),'changed');await assert.rejects(rooted.move(p),/SOURCE_CHANGED/);assert.equal(fs.existsSync(path.join(f.targetRoot,'x')),false);
 const a=await rooted.plan({...f,sourcePath:'x',targetPath:'x'});fs.renameSync(path.join(f.sourceRoot,'x'),path.join(f.sourceRoot,'old'));fs.writeFileSync(path.join(f.sourceRoot,'x'),'changed');await assert.rejects(rooted.move(a),/SOURCE_CHANGED/);assert.equal(fs.readFileSync(path.join(f.sourceRoot,'old'),'utf8'),'changed');
});
test('destination collision produces partial receipt without overwriting either file',native,async()=>{
 const f=fixture('collision');fs.writeFileSync(path.join(f.sourceRoot,'x'),'source');const p=await rooted.plan({...f,sourcePath:'x',targetPath:'x'});fs.writeFileSync(path.join(f.targetRoot,'x'),'existing');const out=await rooted.move(p);assert.equal(out.state,'partial');assert.equal(out.moved,false);assert.equal(fs.readFileSync(path.join(f.sourceRoot,'x'),'utf8'),'source');assert.equal(fs.readFileSync(path.join(f.targetRoot,'x'),'utf8'),'existing');const recovery=await rooted.recover(p);assert.equal(recovery.state,'partial');assert.equal(recovery.recoveryRequired,true);
});
test('root replacement, junctions, hard links and alternate streams are rejected',native,async()=>{
 const f=fixture('untrusted'),dir=tree(f),p=await rooted.plan({...f,sourcePath:'tree',targetPath:'tree'});fs.renameSync(f.targetRoot,f.targetRoot+'-old');fs.mkdirSync(f.targetRoot);await assert.rejects(rooted.move(p),/ROOT_CHANGED/);
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'marker'),'private synthetic');fs.symlinkSync(outside,path.join(dir,'jump'),'junction');await assert.rejects(rooted.snapshot({root:f.sourceRoot,path:'tree'}),/REPARSE|TYPE_CHANGED|PATH_CHANGED/);assert.equal(fs.readFileSync(path.join(outside,'marker'),'utf8'),'private synthetic');fs.unlinkSync(path.join(dir,'jump'));
 fs.linkSync(path.join(outside,'marker'),path.join(dir,'linked'));await assert.rejects(rooted.snapshot({root:f.sourceRoot,path:'tree'}),/MULTIPLE_LINKS/);fs.unlinkSync(path.join(dir,'linked'));
 fs.writeFileSync(path.join(dir,'empty.txt')+':secret','hidden synthetic');await assert.rejects(rooted.snapshot({root:f.sourceRoot,path:'tree'}),/ALTERNATE_STREAM/);
});
test('receipts cannot be silently transplanted and current target changes invalidate completion',native,async()=>{
 const f=fixture('receipt');fs.writeFileSync(path.join(f.sourceRoot,'x'),'original');const p=await rooted.plan({...f,sourcePath:'x',targetPath:'x'});assert.equal((await rooted.move(p)).state,'complete');const forged={...p,targetPath:'other'};await assert.rejects(rooted.recover(forged),/RECORD_BINDING_CHANGED/);fs.writeFileSync(path.join(f.targetRoot,'x'),'changed');await assert.rejects(rooted.recover(p),/RECOVERY_CONTENT_CHANGED/);
});
test('malformed planned timestamps cannot receive a new native completion receipt',native,async()=>{
 const f=fixture('bad-time');fs.writeFileSync(path.join(f.sourceRoot,'x'),'original');const p=await rooted.plan({...f,sourcePath:'x',targetPath:'x'});assert.equal((await rooted.move(p)).state,'complete');const recordDir=path.join(f.journalRoot,p.recordId),planned=path.join(recordDir,'planned.json'),record=JSON.parse(fs.readFileSync(planned,'utf8'));record.at='invalid timestamp';fs.writeFileSync(planned,JSON.stringify(record));fs.unlinkSync(path.join(recordDir,'complete.json'));await assert.rejects(rooted.finalize(p),/RECORD_INVALID/);assert.equal(fs.existsSync(path.join(recordDir,'complete.json')),false);assert.equal(fs.readFileSync(path.join(f.targetRoot,'x'),'utf8'),'original');
});
test('native relative authority rejects traversal, self destination and unsupported plan version',native,async()=>{
 const f=fixture('paths');fs.writeFileSync(path.join(f.sourceRoot,'x'),'x');await assert.rejects(rooted.plan({...f,sourcePath:'../outside',targetPath:'x'}),/INVALID_PATH/);await assert.rejects(rooted.plan({...f,sourcePath:'x',targetRoot:f.sourceRoot,targetPath:'x'}),/INVALID_DESTINATION/);const p=await rooted.plan({...f,sourcePath:'x',targetPath:'x'});assert.throws(()=>rooted.validatePlan({...p,version:2}),/INVALID_PLAN/);assert.throws(()=>rooted.validatePlan({...p,extra:true}),/INVALID_PLAN/);await assert.rejects(rooted.snapshot({root:'\\invalid.test\share',path:'x'}));
});
test('native metadata serialization supports bounded trees beyond the framework default 2 MiB',native,async()=>{
 const f=fixture('metadata-size'),dir=path.join(f.sourceRoot,'tree');fs.mkdirSync(dir);for(let n=0;n<6500;n++)fs.writeFileSync(path.join(dir,'meta-'+String(n).padStart(5,'0')+'-'+ 's'.repeat(228)),'');const observed=await rooted.snapshot({root:f.sourceRoot,path:'tree'});assert.equal(observed.entries,6501);assert.equal(observed.bytes,0);assert.equal(observed.algorithm,'native-tree-v1');assert.equal(fs.readdirSync(dir).length,6500);
});
test('owner interruption after namespace move requires verified native finalize before success',native,async()=>{
 const f=fixture('owner-crash'),dir=path.join(f.sourceRoot,'tree');fs.mkdirSync(dir);const block=Buffer.alloc(96*1024*1024,0x5a);fs.writeFileSync(path.join(dir,'data.bin'),block);for(let n=0;n<500;n++)fs.writeFileSync(path.join(dir,'row-'+n+'.txt'),'synthetic');
 const p=await rooted.plan({...f,sourcePath:'tree',targetPath:'tree'}),managed=require('../lib/managed-process'),original=managed.spawn;let child;
 managed.spawn=(...args)=>{child=original(...args);return child;};const moved=rooted.move(p);const rejection=assert.rejects(moved,/BROKER_INTERRUPTED/);try{
  const deadline=Date.now()+30000,target=path.join(f.targetRoot,'tree');while(!fs.existsSync(target)||!child?.commandPid){assert.ok(Date.now()<deadline,'owned namespace move did not start');await new Promise(resolve=>setTimeout(resolve,2));}
  // commandPid comes from this invocation's authenticated Job supervisor.
  process.kill(child.commandPid,'SIGKILL');await rejection;
 }finally{managed.spawn=original;}
 const before=await rooted.recover(p);assert.equal(before.state,'moved-unreceipted');assert.equal(before.recoveryRequired,true);assert.equal((await rooted.finalize(p)).state,'complete');assert.equal((await rooted.recover(p)).state,'complete');assert.equal(fs.statSync(path.join(f.targetRoot,'tree/data.bin')).size,block.length);
});
test('concurrent tree addition after rename remains partial quarantine rather than complete',native,async()=>{
 const f=fixture('tree-race'),dir=path.join(f.sourceRoot,'tree');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'data.bin'),Buffer.alloc(96*1024*1024,0x51));for(let n=0;n<500;n++)fs.writeFileSync(path.join(dir,'row-'+n+'.txt'),'original');
 const p=await rooted.plan({...f,sourcePath:'tree',targetPath:'tree'}),moving=rooted.move(p),target=path.join(f.targetRoot,'tree'),deadline=Date.now()+30000;
 while(!fs.existsSync(target)){assert.ok(Date.now()<deadline,'namespace move not observed');await new Promise(resolve=>setTimeout(resolve,2));}
 fs.writeFileSync(path.join(target,'added.txt'),'unapproved synthetic addition');const out=await moving;assert.equal(out.state,'partial');assert.equal(out.moved,true);assert.equal(out.recoveryRequired,true);assert.equal(fs.statSync(path.join(target,'data.bin')).size,96*1024*1024);assert.equal(fs.readFileSync(path.join(target,'added.txt'),'utf8'),'unapproved synthetic addition');assert.equal((await rooted.recover(p)).state,'partial');await assert.rejects(rooted.finalize(p),/RECOVERY_REVIEW_REQUIRED/);
});
test('existing writable mapped view cannot silently change moved file bytes without native rejection',native,async t=>{
 const f=fixture('mapped-race'),source=path.join(f.sourceRoot,'x');fs.writeFileSync(source,Buffer.alloc(96*1024*1024,0x51));const p=await rooted.plan({...f,sourcePath:'x',targetPath:'x'}),{execFileSync,spawn}=require('node:child_process'),cs=path.join(f.root,'mapped-fixture.cs'),exe=path.join(f.root,'mapped-fixture.exe');
 fs.writeFileSync(cs,String.raw`
using System;using System.Runtime.InteropServices;
class Fixture {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateFileW(string p,uint a,uint s,IntPtr sec,uint d,uint flags,IntPtr t);
 [DllImport("kernel32.dll")]static extern IntPtr CreateFileMappingW(IntPtr f,IntPtr sec,uint protect,uint hi,uint lo,IntPtr name);
 [DllImport("kernel32.dll")]static extern IntPtr MapViewOfFile(IntPtr map,uint access,uint hi,uint lo,UIntPtr bytes);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")]static extern bool FlushViewOfFile(IntPtr v,UIntPtr bytes);
 [DllImport("kernel32.dll")]static extern bool UnmapViewOfFile(IntPtr v);
 static int Main(string[] args){IntPtr f=CreateFileW(args[0],0xc0000000,7,IntPtr.Zero,3,0x80,IntPtr.Zero);if(f==new IntPtr(-1))return 2;IntPtr m=CreateFileMappingW(f,IntPtr.Zero,4,0,0,IntPtr.Zero),v=MapViewOfFile(m,2,0,0,new UIntPtr(1));CloseHandle(f);if(m==IntPtr.Zero||v==IntPtr.Zero)return 3;Console.WriteLine("READY");Console.Out.Flush();if(Console.ReadLine()=="write"){Marshal.WriteByte(v,0,0x72);FlushViewOfFile(v,new UIntPtr(1));Console.WriteLine("WRITTEN");Console.Out.Flush();Console.ReadLine();}UnmapViewOfFile(v);CloseHandle(m);return 0;}
}
`);execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/platform:x64','/out:'+exe,cs],{windowsHide:true,stdio:'pipe'});const writer=spawn(exe,[source],{windowsHide:true,stdio:['pipe','pipe','pipe']});writer.stderr.resume();let text='';writer.stdout.setEncoding('utf8');writer.stdout.on('data',s=>text+=s);writer.stdin.on('error',()=>{});
 try{const readyDeadline=Date.now()+5000;while(!text.includes('READY')){assert.ok(Date.now()<readyDeadline&&writer.exitCode===null,'owned mapped fixture did not start');await new Promise(resolve=>setTimeout(resolve,2));}
  const moving=rooted.move(p),outPromise=moving.then(out=>({out}),error=>({error})),target=path.join(f.targetRoot,'x'),deadline=Date.now()+30000;let early;
  while(!fs.existsSync(target)){early=await Promise.race([outPromise, new Promise(resolve=>setTimeout(()=>resolve(null),2))]);if(early)break;assert.ok(Date.now()<deadline,'owned move did not start');}
  if(early){assert.ok(early.error||early.out?.state==='partial'&&!early.out.moved,'mapping blocked broker should reject');assert.equal(fs.readFileSync(source).at(0),0x51);if(early.out)assert.equal((await rooted.recover(p)).state,'partial');t.diagnostic('Mapped view rejected before namespace move: '+(early.error?.code||early.out?.error));return;}
  writer.stdin.write('write\n');const writtenDeadline=Date.now()+5000;while(!text.includes('WRITTEN')){assert.ok(Date.now()<writtenDeadline,'mapped write did not complete');await new Promise(resolve=>setTimeout(resolve,2));}const result=await outPromise;assert.ok(result.error||result.out?.state==='partial','changed mapped bytes received complete receipt');assert.equal(fs.readFileSync(target).at(0),0x72);assert.equal((await rooted.recover(p)).state,'partial');t.diagnostic('Changed mapped bytes quarantined after namespace move: '+(result.error?.code||result.out?.error));
 }finally{writer.stdin.end('finish\n');if(writer.exitCode===null){await Promise.race([new Promise(resolve=>writer.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,1000))]);if(writer.exitCode===null)writer.kill();}}
});
