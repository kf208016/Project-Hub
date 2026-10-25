'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const broker=require('../lib/scoped-file');
const win=process.platform==='win32'?test:test.skip,hash=text=>crypto.createHash('sha256').update(text).digest('hex');
async function setup(t){const parent=fs.mkdtempSync(path.join(os.tmpdir(),'hub-overwrite-')),root=path.join(parent,'root'),journalRoot=path.join(parent,'journal');fs.mkdirSync(root);fs.mkdirSync(journalRoot);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));return{parent,root,pin:(await broker.identity(root)).rootFingerprint,journal:{root:journalRoot,rootFingerprint:(await broker.identity(journalRoot)).rootFingerprint}};}
win('Native overwrite holds the same file identity, verifies content and keeps a private backup/receipt',{timeout:20000},async t=>{
  const {root,pin,journal}=await setup(t),file=path.join(root,'result.txt'),before='original 臺灣\n',after='new';fs.writeFileSync(file,before);
  const result=await broker.overwrite(root,'result.txt',after,hash(before),pin,journal);assert.equal(result.overwritten,true);assert.equal(result.beforeHash,hash(before));assert.equal(result.sha256,hash(after));assert.equal(fs.readFileSync(file,'utf8'),after);
  const recordDir=path.join(journal.root,result.recordId),prepared=JSON.parse(fs.readFileSync(path.join(recordDir,'prepared.json'),'utf8'));assert.equal(fs.readFileSync(path.join(recordDir,'before.bin'),'utf8'),before);assert.equal(prepared.fileFingerprint,result.fileFingerprint);assert.equal(prepared.rootFingerprint,pin);assert.equal(JSON.parse(fs.readFileSync(path.join(recordDir,'complete.json'),'utf8')).state,'complete');
  await assert.rejects(broker.recover(root,'result.txt',result.recordId,hash(after),pin,journal),{code:'RECORD_COMPLETE'});assert.equal(fs.readFileSync(file,'utf8'),after);
  const second=await broker.overwrite(root,'result.txt','',hash(after),pin,journal);assert.equal(second.fileFingerprint,result.fileFingerprint);assert.equal(fs.statSync(file).size,0);
});
win('Native overwrite rejects stale hashes, binary files, changed roots and journals in the task root',{timeout:20000},async t=>{
  const {parent,root,pin,journal}=await setup(t),file=path.join(root,'result.txt');fs.writeFileSync(file,'current');
  await assert.rejects(broker.overwrite(root,'result.txt','new',hash('old'),pin,journal),{code:'HASH_CHANGED'});assert.equal(fs.readFileSync(file,'utf8'),'current');assert.deepEqual(fs.readdirSync(journal.root),[]);
  const nested=path.join(root,'journal');fs.mkdirSync(nested);await assert.rejects(broker.overwrite(root,'result.txt','new',hash('current'),pin,{root:nested,rootFingerprint:(await broker.identity(nested)).rootFingerprint}),{code:'JOURNAL_IN_TASK_REJECTED'});
  fs.writeFileSync(path.join(root,'binary.bin'),Buffer.from([0,1]));await assert.rejects(broker.overwrite(root,'binary.bin','new',hash(Buffer.from([0,1])),pin,journal),{code:'BINARY_REJECTED'});
  fs.renameSync(root,path.join(parent,'original-root'));fs.mkdirSync(root);fs.writeFileSync(path.join(root,'result.txt'),'current');await assert.rejects(broker.overwrite(root,'result.txt','new',hash('current'),pin,journal),{code:'ROOT_CHANGED'});
});
win('Native recovery accepts only an incomplete journal, exact current hash and the original target FileID',{timeout:20000},async t=>{
  const {root,pin,journal}=await setup(t),file=path.join(root,'result.txt'),before='original',after='after';fs.writeFileSync(file,before);const write=await broker.overwrite(root,'result.txt',after,hash(before),pin,journal),record=path.join(journal.root,write.recordId);
  // Fixture simulates a receipt lost after a durable target write. This is not
  // evidence of an actual host crash or an externally immutable ledger.
  fs.unlinkSync(path.join(record,'complete.json'));
  await assert.rejects(broker.recover(root,'result.txt',write.recordId,hash('wrong'),pin,journal),{code:'HASH_CHANGED'});
  const restored=await broker.recover(root,'result.txt',write.recordId,hash(after),pin,journal);assert.equal(restored.recovered,true);assert.equal(fs.readFileSync(file,'utf8'),before);await assert.rejects(broker.recover(root,'result.txt',write.recordId,hash(before),pin,journal),{code:'RECORD_COMPLETE'});
  const next=await broker.overwrite(root,'result.txt',after,hash(before),pin,journal);fs.unlinkSync(path.join(journal.root,next.recordId,'complete.json'));fs.renameSync(file,path.join(root,'original.txt'));fs.writeFileSync(file,after);
  await assert.rejects(broker.recover(root,'result.txt',next.recordId,hash(after),pin,journal),{code:'RECOVERY_BINDING_CHANGED'});assert.equal(fs.readFileSync(file,'utf8'),after);
});
win('Corrupt backup and record fields fail closed without touching the target',{timeout:20000},async t=>{
  const {root,pin,journal}=await setup(t);fs.writeFileSync(path.join(root,'result.txt'),'before');const write=await broker.overwrite(root,'result.txt','after',hash('before'),pin,journal),record=path.join(journal.root,write.recordId);fs.unlinkSync(path.join(record,'complete.json'));fs.writeFileSync(path.join(record,'before.bin'),'tampered');await assert.rejects(broker.recover(root,'result.txt',write.recordId,hash('after'),pin,journal),{code:'BACKUP_CHANGED'});assert.equal(fs.readFileSync(path.join(root,'result.txt'),'utf8'),'after');
});
win('Killing an owned native write after the prepared journal preserves a recoverable partial transaction',{timeout:60000},async t=>{
  const {parent,root,pin,journal}=await setup(t),managed=require('../lib/managed-process'),originalSpawn=managed.spawn,file=path.join(root,'result.txt');let interruptions=0;
  // Compile a fixture copy of the real native source with a pause immediately
  // after WriteFile. No environment switch, hook, or pause exists in production.
  const sourcePath=path.join(parent,'interrupted.cs'),binary=path.join(parent,'interrupted.exe'),source=fs.readFileSync(path.join(__dirname,'../windows/scoped-file.cs'),'utf8'),needle='Require(SetEndOfFile(file)&&FlushFileBuffers(file),"WRITE_INCOMPLETE");';assert.equal(source.split(needle).length,2);
  fs.writeFileSync(sourcePath,source.replace(needle,'Console.Error.WriteLine("HUB_FIXTURE_AFTER_WRITE");Console.Error.Flush();System.Threading.Thread.Sleep(10000);'+needle));
  require('node:child_process').execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/out:'+binary,sourcePath],{windowsHide:true,timeout:30000});
  managed.spawn=(file,...args)=>{const child=originalSpawn(path.basename(file).startsWith('scoped-file-')?binary:file,...args);child.stderr.on('data',data=>{if(data.toString().includes('HUB_FIXTURE_AFTER_WRITE')){interruptions++;child.kill();}});return child;};t.after(()=>{managed.spawn=originalSpawn;});
  const before='a'.repeat(200*1024),after='b'.repeat(100*1024);fs.writeFileSync(file,before);
  await assert.rejects(broker.overwrite(root,'result.txt',after,hash(before),pin,journal),{code:'BROKER_INTERRUPTED'});managed.spawn=originalSpawn;assert.equal(interruptions,1);
  const records=fs.readdirSync(journal.root);assert.equal(records.length,1);const recordId=records[0];assert.ok(fs.existsSync(path.join(journal.root,recordId,'prepared.json')));assert.equal(fs.existsSync(path.join(journal.root,recordId,'complete.json')),false);
  const current=fs.readFileSync(file);assert.notEqual(hash(current),hash(before));assert.notEqual(hash(current),hash(after));
  const restored=await broker.recover(root,'result.txt',recordId,hash(current),pin,journal);assert.equal(restored.recovered,true);assert.equal(fs.readFileSync(file,'utf8'),before);t.diagnostic('Fixture copy of native broker killed after target WriteFile and before SetEndOfFile/Flush; exact partial hash approved for recovery');
});
