'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const cwdReader=require('../lib/process-cwd');
const since='2026-10-08T01:00:00.1234560Z';
const requests=[{pid:101,since},{pid:102,since}];
const ok=(pid,cwd='C:\\known')=>({pid,creationTime:since,cwd,status:'ok'});
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
function cimCreation(pid) {
 return execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference="Stop"; (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();
}
function compileProbe(folder,code,platform) {
 const source=path.join(folder,'probe.cs'),binary=path.join(folder,'probe.exe');fs.writeFileSync(source,code);
 const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 execFileSync(compiler,['/nologo','/target:exe','/platform:'+platform,'/out:'+binary,source],{windowsHide:true,timeout:30000,stdio:'pipe'});
 return binary;
}

test('Windows process identity retains CIM microseconds and rejects malformed or coarse timestamps',()=>{
 assert.equal(cwdReader.normalizeSince('2026-10-08T01:00:00.123456Z'),since);
 assert.equal(cwdReader.sameCreation(since,'2026-10-08T01:00:00.1234569Z'),true);
 assert.equal(cwdReader.sameCreation(since,'2026-10-08T01:00:00.1234570Z'),false);
 for(const invalid of ['invalid','2026-02-30T01:00:00.1234560Z','2026-10-08T01:00:00.123Z','2026-10-08T01:00:00.1234560+00:00',null])assert.equal(cwdReader.normalizeSince(invalid),null);
});

test('Windows cwd batches once, binds every response identity and never guesses paths',async()=>{
 let calls=0,input;
 const query=cwdReader.create({platform:'win32',ensure:()=> 'trusted-reader',validatePath:x=>x,run:async(file,value,options)=>{calls++;input=JSON.parse(value);assert.equal(file,'trusted-reader');assert.equal(options.timeout,5000);return JSON.stringify([ok(102,'C:\\unrelated'),ok(101)]);}});
 const results=await query(requests);assert.equal(calls,1);assert.deepEqual(input,requests);assert.deepEqual(results.map(x=>x.pid),[101,102]);assert.equal(results[0].cwd,'C:\\known');
 const reused=cwdReader.parseResults([{...ok(101),creationTime:'2026-10-08T01:00:00.1234570Z'}],[requests[0]],x=>x);
 assert.equal(reused[0].status,'pid-reused');assert.equal(reused[0].cwd,'');
 const pathRejected=cwdReader.parseResults([ok(101)],[requests[0]],()=>{throw Error('junction');});assert.equal(pathRejected[0].status,'invalid-path');assert.equal(pathRejected[0].cwd,'');
});

test('Windows denied, unsupported, read races and unavailable helpers preserve empty unknown cwd',async()=>{
 for(const status of ['access-denied','unsupported-layout','read-failed','changed','not-found']) {
  const query=cwdReader.create({platform:'win32',ensure:()=> 'reader',run:async()=>JSON.stringify([{pid:101,creationTime:since,cwd:'',status}])});
  assert.deepEqual((await query([requests[0]]))[0],{pid:101,creationTime:since,cwd:'',status});
 }
 for(const fail of [()=>{throw Error('compiler unavailable');},async()=>{throw Error('timeout');}]) {
  const query=cwdReader.create({platform:'win32',ensure:()=> 'reader',run:fail});assert.equal((await query([requests[0]]))[0].status,'helper-failed');
 }
 const compileFailure=cwdReader.create({platform:'win32',ensure:()=>{throw Error('compiler');}});assert.equal((await compileFailure([requests[0]]))[0].status,'helper-failed');
});

test('Windows malformed helper output and oversized batches are never accepted as unrelated',async()=>{
 for(const raw of ['{broken','[]',JSON.stringify([ok(999)]),JSON.stringify([{...ok(101),credentials:'not-allowed'}]),JSON.stringify([{...ok(101),status:'unknown-status'}]),JSON.stringify([{...ok(101),status:'access-denied'}])]) {
  const query=cwdReader.create({platform:'win32',ensure:()=> 'reader',run:async()=>raw});const result=await query([requests[0]]);assert.equal(result[0].status,'helper-failed',raw);assert.equal(result[0].cwd,'');
 }
 const noRun=cwdReader.create({platform:'win32',ensure:()=>{throw Error('must not launch');}});
 assert.equal((await noRun([{pid:101,since:'invalid'}]))[0].status,'invalid-request');
 assert.equal((await noRun([requests[0],requests[0]]))[0].status,'invalid-request');
 assert.equal((await noRun(Array.from({length:129},(_,i)=>({pid:i+1,since}))))[0].status,'invalid-request');
});

test('Windows validates a real synthetic child cwd against CIM and keeps the process alive',{skip:process.platform!=='win32'},async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cwd-空白 '));
 const child=spawn(process.execPath,['-e','console.log("READY");setInterval(()=>{},1000)'],{cwd:folder,windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}fs.rmSync(folder,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());});
 const creationTime=cimCreation(child.pid);
 const results=await cwdReader.query([{pid:child.pid,since:creationTime}]);assert.equal(results[0].status,'ok',JSON.stringify(results));assert.equal(results[0].cwd.toLowerCase(),path.resolve(folder).toLowerCase());assert.equal(child.exitCode,null);
 const oldIdentity=await cwdReader.query([{pid:child.pid,since:'2000-01-01T00:00:00.0000000Z'}]);assert.equal(oldIdentity[0].status,'pid-reused');assert.equal(oldIdentity[0].cwd,'');assert.equal(child.exitCode,null);
});

test('Windows protected process memory remains unknown without acquiring debug privileges',{skip:process.platform!=='win32'},async()=>{
 const result=await cwdReader.query([{pid:4,since:'2000-01-01T00:00:00.0000000Z'}]);
 assert.notEqual(result[0].status,'ok');assert.equal(result[0].cwd,'');
 assert.ok(['access-denied','read-failed','not-found','pid-reused'].includes(result[0].status),JSON.stringify(result));
});

test('Windows cwd rejects network, ADS and junction paths before considering project attribution',{skip:process.platform!=='win32'},async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cwd-path-')),target=path.join(folder,'target'),alias=path.join(folder,'alias');fs.mkdirSync(target);fs.symlinkSync(target,alias,'junction');
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 for(const invalid of ['\\\\uncontacted-server\\share',target+':stream',alias]){
  const query=cwdReader.create({platform:'win32',ensure:()=> 'reader',run:async()=>JSON.stringify([ok(101,invalid)])});
  const result=(await query([requests[0]]))[0];assert.equal(result.status,'invalid-path',invalid);assert.equal(result.cwd,'');
 }
});

test('Windows WOW64 synthetic process is refused and is not stopped',{skip:process.platform!=='win32'},async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cwd-wow64-'));
 const binary=compileProbe(folder,'class Probe { static void Main(){ System.Console.WriteLine("READY"); while(true) System.Threading.Thread.Sleep(1000); } }','x86');
 const child=spawn(binary,[],{cwd:folder,windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}fs.rmSync(folder,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());});
 const result=(await cwdReader.query([{pid:child.pid,since:cimCreation(child.pid)}]))[0];assert.equal(result.status,'unsupported-layout',JSON.stringify(result));assert.equal(result.cwd,'');assert.equal(child.exitCode,null);
});

test('Windows native helper deadline stops only the helper and returns unknown',{skip:process.platform!=='win32'},async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cwd-timeout-')),marker=path.join(folder,'identity.json');
 const binary=compileProbe(folder,'class Probe { static void Main(){ var p=System.Diagnostics.Process.GetCurrentProcess(); System.IO.File.WriteAllText('+JSON.stringify(marker)+',p.Id.ToString()+"\\n"+p.StartTime.ToUniversalTime().ToString("o")); while(true) System.Threading.Thread.Sleep(1000); } }','x64');
 t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const query=cwdReader.create({platform:'win32',ensure:()=>binary,timeout:1500});const result=await query([requests[0]]);assert.equal(result[0].status,'helper-failed');assert.equal(result[0].cwd,'');
 assert.equal(fs.existsSync(marker),true,'The helper started before its deadline');
 const [pid,creationTime]=fs.readFileSync(marker,'utf8').trim().split('\n');
 const closed=(await cwdReader.query([{pid:Number(pid),since:creationTime}]))[0];assert.ok(['not-found','pid-reused','read-failed'].includes(closed.status),JSON.stringify(closed));
});
