'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {WebChat}=require('../lib/web-chat');
const {digest,validateRecord,strictRows}=require('../lib/web-chat-receipts');
const {fixture,approved,resultInput,recoverAccepted}=require('./helpers/web-chat-fixture');
test('known unapproved preview orphan retries exact metadata so a second preview does not poison the library',async t=>{
  const f=fixture(t),s=new WebChat(f.options),before=fs.readFileSync(f.task);let once=false;f.hooks.beforeWrite=({target})=>{if(target.endsWith('receipt.json')&&!once){once=true;throw Error('before initial metadata create');}};
  const input={owner:'fixture-owner',actor:'chatgpt',project:'p',task:'t',text:'first'};await assert.rejects(s.preview(input));const ids=fs.readdirSync(s.receipts.directory).filter(x=>x!=='native');assert.equal(ids.length,1);assert.equal(fs.existsSync(path.join(s.receipts.directory,ids[0],'receipt.json')),false);
  delete f.hooks.beforeWrite;const next=await s.preview({...input,text:'second'});assert.equal(next.ok,true);const records=await s.receipts.list();assert.equal(records.length,2);assert.ok(records.every(r=>r.state==='preview'));assert.deepEqual(fs.readFileSync(f.task),before);assert.equal(f.holds.size,0);
});
test('unknown restart orphan has sanitized read-only assessment and never gains an invented receipt or token',async t=>{
  const f=fixture(t),s=new WebChat(f.options);f.hooks.beforeWrite=({target})=>{if(target.endsWith('receipt.json'))throw Error('lost initial metadata');};await assert.rejects(s.preview({owner:'fixture-owner',actor:'chatgpt',project:'p',task:'t',text:'private synthetic draft'}));delete f.hooks.beforeWrite;
  const {assessOrphansSync}=require('../lib/web-chat-receipts'),inspect=(dir,relative)=>{const file=path.join(dir,relative);if(!fs.existsSync(file))return {missing:true};const bytes=fs.readFileSync(file);return {missing:false,sha256:digest(bytes),fileFingerprint:f.identities.get(file),rootFingerprint:f.identities.get(dir),bytes:bytes.length,text:bytes.toString()};},assessment=assessOrphansSync(s.receipts.directory,inspect);assert.equal(assessment.length,1);assert.equal(assessment[0].repairable,false);assert.ok(!JSON.stringify(assessment).includes('private synthetic draft'));
  const restarted=new WebChat(f.options);await assert.rejects(restarted.preview({owner:'fixture-owner',actor:'chatgpt',project:'p',task:'t',text:'new'}));assert.equal(fs.existsSync(path.join(s.receipts.directory,assessment[0].receiptId,'receipt.json')),false);
});
test('immutable revisions avoid the shorter committed overwrite gap and enforce previous bytes/FileID chain',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),scope={...a.base,receiptId:a.preview.receiptId},baseFile=path.join(s.receipts.directory,a.preview.receiptId,'receipt.json'),baseBytes=fs.readFileSync(baseFile);let once=false;
  f.hooks.beforeWrite=({target,text})=>{if(target.includes('metadata-')&&text.includes('"state":"committed"')&&!once){once=true;throw Error('commit final name absent before atomic metadata create');}};const result=await s.result(resultInput(a));assert.equal(result.partial,true);assert.equal(result.state,'task_note_saved');assert.deepEqual(fs.readFileSync(baseFile),baseBytes);assert.equal(f.holds.size,1);delete f.hooks.beforeWrite;
  const restarted=new WebChat(f.options);assert.equal((await restarted.status(scope)).state,'task_note_saved');assert.equal((await recoverAccepted(restarted,scope)).ok,true);assert.equal(f.holds.size,0);
  const latest=await restarted.receipts.read(a.preview.receiptId);assert.equal(latest.sequence,5);const initial=path.join(s.receipts.directory,a.preview.receiptId,'receipt.json');f.identities.set(initial,digest('replacement base metadata ID'));await assert.rejects(restarted.status(scope),{code:'METADATA_CHAIN_CHANGED'});
});
test('partial target bytes need exact owner recovery preview, fresh tuple and a one-use token',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),scope={...a.base,receiptId:a.preview.receiptId};let once=false;
  f.hooks.beforeWrite=({target})=>{if(target===f.task&&!once){once=true;fs.writeFileSync(f.task,fs.readFileSync(f.task,'utf8')+'\nPARTIAL');throw Error('synthetic partial WriteFile');}};
  const result=await s.result(resultInput(a));assert.equal(result.partial,true);assert.equal(result.taskNoteSaved,null);assert.equal(f.holds.size,1);delete f.hooks.beforeWrite;
  const restarted=new WebChat(f.options),preview=await restarted.recoverPreview(scope),action=preview.actions.find(x=>x.target==='task');assert.equal(action.willOverwrite,true);assert.equal(action.currentSHA256,digest(fs.readFileSync(f.task)));assert.equal(action.currentFileFingerprint,f.identities.get(f.task));await assert.rejects(restarted.recover(scope),{code:'RECOVERY_PREVIEW_REQUIRED'});
  fs.appendFileSync(f.task,'EXTERNAL');await assert.rejects(restarted.recover({...scope,confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256}),{code:'RECOVERY_TARGET_CHANGED'});assert.equal(f.holds.size,1);
  const fresh=await restarted.recoverPreview(scope);assert.equal((await restarted.recover({...scope,confirm:true,recoveryToken:fresh.recoveryToken,expectedRecoverySHA256:fresh.previewSHA256})).ok,true);assert.equal(f.holds.size,0);assert.ok(!fs.readFileSync(f.task,'utf8').includes('PARTIAL'));assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);
});
test('unknown metadata pending temp is inspectable but mutations remain closed in the live process',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),home=path.join(s.receipts.directory,a.preview.receiptId),temp=path.join(home,'.hub-web-'+('a'.repeat(32))+'.tmp');fs.writeFileSync(temp,'unknown incomplete metadata');const before=fs.readFileSync(f.task);
  assert.equal((await s.status({...a.base,receiptId:a.preview.receiptId})).state,'approved');await assert.rejects(s.result(resultInput(a)),{code:'METADATA_PENDING_TEMP'});assert.deepEqual(fs.readFileSync(f.task),before);assert.equal(fs.readFileSync(temp,'utf8'),'unknown incomplete metadata');
});
test('each durable target stage can reconcile after restart without duplicate rows or lost answer',async t=>{
  for(const phase of ['after-chat','before-task','after-task']){
    const f=fixture(t),s=new WebChat(f.options),a=await approved(s),input=resultInput(a);let injected=false;
    if(phase==='before-task')f.hooks.beforeWrite=({target})=>{if(target===f.task&&!injected){injected=true;throw Error('fixture disk-full-before-task');}};
    else f.hooks.afterWrite=({target})=>{if(target===(phase==='after-chat'?f.log:f.task)&&!injected){injected=true;throw Error('fixture crash-after-flush');}};
    const result=await s.result(input);assert.equal(result.ok,false);assert.equal(result.partial,true);assert.equal(result.recoveryRequired,true);assert.equal(result.actualTargets.chat,'saved');assert.equal(result.chatSaved,true);if(phase==='after-task'){assert.equal(result.actualTargets.task,'saved');assert.equal(result.taskNoteSaved,true);}else assert.equal(result.actualTargets.task,'before');assert.equal(f.events.length,0);delete f.hooks.beforeWrite;delete f.hooks.afterWrite;
    const restarted=new WebChat(f.options),recovered=await recoverAccepted(restarted,{...a.base,receiptId:a.preview.receiptId});assert.equal(recovered.ok,true);assert.equal(recovered.state,'committed');assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).filter(r=>r.webHandoff?.requestId===input.requestId).length,1);assert.equal(fs.readFileSync(f.task,'utf8').split('<!-- web-handoff:').length-1,1);assert.equal((await restarted.result(input)).ok,true);assert.equal(f.holds.size,0);
  }
});
test('external task modification and FileID replacement preserve partial transaction, never infer success',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),input=resultInput(a);f.hooks.beforeWrite=({target})=>{if(target===f.task)throw Error('fixture task fault');};assert.equal((await s.result(input)).partial,true);delete f.hooks.beforeWrite;
  fs.appendFileSync(f.task,'\nexternal changed');const current=fs.readFileSync(f.task),restarted=new WebChat(f.options);await assert.rejects(restarted.recover({...a.base,receiptId:a.preview.receiptId}),{code:'RECOVERY_PREVIEW_REQUIRED'});const preview=await restarted.recoverPreview({...a.base,receiptId:a.preview.receiptId});assert.equal(preview.actions.find(x=>x.target==='task').willOverwrite,true);assert.deepEqual(fs.readFileSync(f.task),current);assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);assert.equal(f.holds.size,1);
});
test('receipt corruption, token disclosure and cross-file blob changes reject before recovery',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),id=a.preview.receiptId,dir=path.join(f.root,'_hub/web-chat-receipts',id),receipt=path.join(dir,'receipt.json'),record=JSON.parse(fs.readFileSync(receipt,'utf8'));
  const journalText=fs.readFileSync(receipt,'utf8');assert.ok(!journalText.includes(a.preview.previewToken));assert.ok(!journalText.includes(a.confirm.token));assert.ok(!journalText.includes(a.base.owner));
  assert.throws(()=>validateRecord({...record,unexpected:true}),{code:'INVALID_FIELDS'});
  fs.writeFileSync(path.join(dir,'prompt.txt'),'replacement');await assert.rejects(s.result(resultInput(a)),{code:'BLOB_CHANGED'});
  fs.writeFileSync(receipt,'{"broken"');await assert.rejects(s.status({...a.base,receiptId:id}),{code:'RECEIPT_CORRUPT'});
});
test('strict row parser refuses unknown rows, truncated files and blank interior records',()=>{
  for(const text of ['{bad}\n','{"role":"user","text":"x"}','{"role":"bogus","text":"x"}\n','{"role":"user","text":"x"}\n\n'])assert.throws(()=>strictRows(text));assert.deepEqual(strictRows(''),[]);
});
test('known flushed preplanned blobs can retry the same request after metadata/disk refusal; target bytes stay untouched',async t=>{
  for(const fault of ['blob','planned']){
    const f=fixture(t),s=new WebChat(f.options),a=await approved(s),input=resultInput(a),taskBefore=fs.readFileSync(f.task),logBefore=fs.readFileSync(f.log);let injected=false;
    if(fault==='blob'){const create=f.writer.create;f.writer.create=async function(...args){if(args[1].endsWith('/result.txt')&&!injected){injected=true;throw Error('fixture disk-full-before-blob');}return create.apply(this,args);};}
    else f.hooks.beforeWrite=({target,text})=>{if(target.includes('metadata-')&&text.includes('"state":"planned"')&&!injected){injected=true;throw Error('fixture refuse planned metadata before write');}};
    await assert.rejects(s.result(input));assert.deepEqual(fs.readFileSync(f.task),taskBefore);assert.deepEqual(fs.readFileSync(f.log),logBefore);assert.equal((await s.status({...a.base,receiptId:a.preview.receiptId})).state,'approved');delete f.hooks.beforeWrite;
    assert.equal((await s.result(input)).ok,true);assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);
  }
});
test('failures after each metadata flush expose accepted status and owner recovery, with no emitted fake success',async t=>{
  for(const stage of ['planned','chat_saved','task_note_saved','committed']){
    const f=fixture(t),s=new WebChat(f.options),a=await approved(s),input=resultInput(a);let injected=false;
    f.hooks.afterWrite=({target,text})=>{if(target.includes('metadata-')&&text.includes('"state":"'+stage+'"')&&!injected){injected=true;throw Error('fixture crash after metadata flush');}};
    let first;try{first=await s.result(input);}catch(error){first={error};}assert.equal(f.events.length,0);assert.ok(first.error||first.partial);delete f.hooks.afterWrite;
    const restarted=new WebChat(f.options),lookup=await restarted.status({...a.base,receiptId:a.preview.receiptId});assert.equal(lookup.state,stage);const recovered=await recoverAccepted(restarted,{...a.base,receiptId:a.preview.receiptId});assert.equal(recovered.ok,true);assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).filter(r=>r.webHandoff?.requestId===input.requestId).length,1);
  }
});
test('native journal root replacement after accepted partial rejects across restart and preserves target bytes',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),input=resultInput(a);f.hooks.beforeWrite=({target})=>{if(target===f.task)throw Error('fixture task refusal');};assert.equal((await s.result(input)).partial,true);delete f.hooks.beforeWrite;
  const before=fs.readFileSync(f.task),native=path.join(f.root,'_hub/web-chat-receipts/native');f.identities.set(native,digest('replacement native root'));
  await assert.rejects(new WebChat(f.options).recoverPreview({...a.base,receiptId:a.preview.receiptId}),{code:'JOURNAL_ROOT_CHANGED'});assert.deepEqual(fs.readFileSync(f.task),before);assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);
});
test('insufficient volume budget rejects before planned, without target writes or first-accept success',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),task=fs.readFileSync(f.task),log=fs.readFileSync(f.log);const capacity=f.writer.capacity;f.writer.capacity=async function(...args){return {...await capacity.apply(this,args),freeBytes:1};};
  await assert.rejects(s.result(resultInput(a)),{code:'DISK_BUDGET_INSUFFICIENT'});assert.equal((await s.status({...a.base,receiptId:a.preview.receiptId})).state,'approved');assert.deepEqual(fs.readFileSync(f.task),task);assert.deepEqual(fs.readFileSync(f.log),log);
});
test('owner can abandon a verified unaccepted hold only after immutable revoke; unknown native intent retains it',async t=>{
  const f=fixture(t),s=new WebChat(f.options),a=await approved(s),scope={...a.base,receiptId:a.preview.receiptId};f.hooks.beforeWrite=({target,text})=>{if(target.includes('metadata-')&&text.includes('"state":"planned"'))throw Error('before accepted planned publication');};await assert.rejects(s.result(resultInput(a)));assert.equal(f.holds.size,1);delete f.hooks.beforeWrite;
  const native=path.join(s.receipts.directory,'native'),unknown=path.join(native,'f'.repeat(32));fs.mkdirSync(unknown);await assert.rejects(s.revoke(scope),{code:'UNACCEPTED_NATIVE_INTENT_UNKNOWN'});assert.equal(f.holds.size,1);fs.rmdirSync(unknown);assert.equal((await s.revoke(scope)).state,'revoked');assert.equal(f.holds.size,0);assert.equal((await s.status(scope)).state,'revoked');
});
const win=process.platform==='win32'?test:test.skip;
win('real native target partial bytes recover through owner preview and one-use current FileID/SHA confirmation',{timeout:240000},async t=>{
  const f=fixture(t),writer=require('../lib/web-handoff-writer'),managed=require('../lib/managed-process'),original=managed.spawn,service=new WebChat({...f.options,writer}),a=await approved(service),scope={...a.base,receiptId:a.preview.receiptId};
  const source=fs.readFileSync(path.join(__dirname,'../windows/web-handoff-writer.cs'),'utf8'),needle='WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)';assert.equal(source.split(needle).length,2);
  const changed=source.replace(needle,'FixtureWrite(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero)').replace('static void Write(IntPtr file,byte[] bytes)','static bool FixtureWrite(IntPtr file,byte[] bytes,uint length,out uint written,IntPtr overlap){if(FinalName(file).EndsWith("\\\\t.md")){WriteFile(file,bytes,length-3,out written,overlap);return false;}return WriteFile(file,bytes,length,out written,overlap);}\n  static void Write(IntPtr file,byte[] bytes)');
  const temporary=path.dirname(f.root),cs=path.join(temporary,'partial-write.cs'),exe=path.join(temporary,'partial-write.exe');fs.writeFileSync(cs,changed);require('node:child_process').execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll','/out:'+exe,cs],{windowsHide:true,timeout:30000});
  t.after(()=>managed.spawn=original);managed.spawn=(binary,...args)=>original(path.basename(binary).startsWith('web-handoff-writer-')?exe:binary,...args);const first=await service.result(resultInput(a,'synthetic reply ending ABC'));managed.spawn=original;assert.equal(first.partial,true);assert.equal(first.actualTargets.task,'changed');assert.equal(first.taskNoteSaved,null);assert.equal(f.holds.size,1);
  const restarted=new WebChat({...f.options,writer}),preview=await restarted.recoverPreview(scope),target=preview.actions.find(x=>x.target==='task');assert.equal(target.willOverwrite,true);assert.equal(target.currentSHA256,digest(fs.readFileSync(f.task)));assert.equal((await restarted.recover({...scope,confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256})).ok,true);assert.equal(f.holds.size,0);assert.equal(strictRows(fs.readFileSync(f.log,'utf8')).length,2);assert.equal((await restarted.status(scope)).state,'committed');
  t.diagnostic('Independent native fixture writes all but three target bytes and reports failure. No production fault switch, external call or real power-loss claim.');
});
