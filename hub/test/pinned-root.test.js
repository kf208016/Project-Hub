'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const managed=require('../lib/managed-process'),file=require('../lib/scoped-file');
const win=process.platform==='win32'?test:test.skip;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function observe(child){let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',()=>{});return{out:()=>stdout,closed:new Promise(r=>child.once('close',code=>r({code,stdout,stderr}))) };}
win('Native pinned ancestors deny root rename while allowing normal descendant writes until exit',{timeout:20000},async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pin-')),root=path.join(parent,'root');fs.mkdirSync(root);t.after(()=>fs.rmSync(parent,{force:true,recursive:true}));
  const pin=(await file.identity(root)).rootFingerprint,child=managed.spawn(process.execPath,['-e','const fs=require("fs");fs.mkdirSync("normal");fs.writeFileSync("normal/result.txt","fixture");console.log("READY");setInterval(()=>{},1000);'],{cwd:root,dirPin:{root,rootFingerprint:pin}});t.after(()=>child.kill());const run=observe(child);
  for(let i=0;i<200&&!run.out().includes('READY');i++)await wait(25);assert.match(run.out(),/READY/);assert.equal(fs.readFileSync(path.join(root,'normal/result.txt'),'utf8'),'fixture');
  assert.throws(()=>fs.renameSync(root,path.join(parent,'renamed')));assert.throws(()=>fs.renameSync(parent,parent+'-renamed'));
  child.kill();await run.closed;fs.renameSync(root,path.join(parent,'renamed'));assert.ok(fs.existsSync(path.join(parent,'renamed/normal/result.txt')));
});
win('Native stale directory identity rejects execution before the first child instruction',{timeout:20000},async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'hub-stale-pin-')),root=path.join(parent,'root');fs.mkdirSync(root);t.after(()=>fs.rmSync(parent,{force:true,recursive:true}));const pin=(await file.identity(root)).rootFingerprint;
  fs.renameSync(root,path.join(parent,'original'));fs.mkdirSync(root);const child=managed.spawn(process.execPath,['-e','require("fs").writeFileSync("must-not-exist.txt","bad");'],{cwd:root,dirPin:{root,rootFingerprint:pin}}),result=await observe(child).closed;assert.equal(result.code,125);assert.equal(fs.existsSync(path.join(root,'must-not-exist.txt')),false);
});
win('Native pins deny the directory write handle required to set a reparse point',{timeout:20000},async t=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'hub-fsctl-pin-')),root=path.join(parent,'root'),source=path.join(parent,'write-open.cs'),exe=path.join(parent,'write-open.exe');fs.mkdirSync(root);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  // FSCTL_SET_REPARSE_POINT requires a write-capable directory handle. Verify
  // the prerequisite is denied by sharing, not by a fixture ACL or permissions.
  fs.writeFileSync(source,'using System;using System.Runtime.InteropServices;class Probe{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr p,uint d,uint f,IntPtr t);[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr p);static int Main(string[] args){IntPtr h=CreateFileW(args[0],0x40000000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);int code=Marshal.GetLastWin32Error();bool ok=h!=new IntPtr(-1)&&h!=IntPtr.Zero;if(ok)CloseHandle(h);Console.WriteLine(ok?"opened":"denied:"+code);return 0;}}');
  const {execFileSync}=require('node:child_process');execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/out:'+exe,source],{windowsHide:true,timeout:15000});assert.equal(execFileSync(exe,[root],{encoding:'utf8',windowsHide:true}).trim(),'opened');
  const rootFingerprint=(await file.identity(root)).rootFingerprint,child=managed.spawn(process.execPath,['-e','console.log("READY");setInterval(()=>{},1000);'],{cwd:root,dirPin:{root,rootFingerprint}});t.after(()=>child.kill());const run=observe(child);for(let i=0;i<200&&!run.out().includes('READY');i++)await wait(25);assert.match(run.out(),/READY/);
  assert.equal(execFileSync(exe,[root],{encoding:'utf8',windowsHide:true}).trim(),'denied:32');child.kill();await run.closed;assert.equal(execFileSync(exe,[root],{encoding:'utf8',windowsHide:true}).trim(),'opened');
});
