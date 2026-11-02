'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const admission=require('../lib/web-chat-admission'),install=require('../windows/native-install.cjs');
const win=process.platform==='win32'?test:test.skip,hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const release=(letter='a')=>({legacy:false,capabilities:{version:1,dataFormats:['legacy','web-manual-v2'],recoveryOnly:true},capabilitiesSHA256:letter.repeat(64),identity:{kind:'source',id:'source-'+letter.repeat(12),digest:letter.repeat(64)}});
function owned(t){const parent=fs.mkdtempSync(path.join(os.tmpdir(),'hub-admission-owned-')),root=path.join(parent,'AI-Workspace');fs.mkdirSync(root);t.after(()=>{assert.equal(path.dirname(fs.realpathSync(parent)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());fs.rmSync(parent,{recursive:true,force:true,maxRetries:20,retryDelay:100});});return {parent,root};}
async function recoverExact(service,scope){const preview=await service.recoverPreview(scope);return service.recover({...scope,confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256});}
win('native DataRoot format marks exact root identity and rejects legacy, unknown, replacement and different recovery release',t=>{
  const {parent,root}=owned(t),current=release();assert.equal(admission.check(root,{release:{legacy:true}}).format,'legacy');
  const marked=admission.ensureFormat(root,{release:current});assert.equal(marked.format,'web-manual-v2');assert.equal(admission.check(root,{release:current}).ok,true);
  assert.equal(admission.check(root,{release:current,recoveryOnly:true}).recoveryOnly,true);
  assert.throws(()=>admission.check(root,{release:{legacy:true}}),{code:'RELEASE_DATA_FORMAT_UNSUPPORTED'});
  assert.throws(()=>admission.check(root,{release:release('b'),recoveryOnly:true}),{code:'RECOVERY_RELEASE_MISMATCH'});
  assert.equal(admission.ensureFormat(root,{release:release('b')}).format,'web-manual-v2');assert.equal(admission.check(root,{release:release('b'),recoveryOnly:true}).ok,true);
  const bytes=fs.readFileSync(path.join(root,admission.MARKER));fs.renameSync(root,path.join(parent,'saved'));fs.mkdirSync(root);fs.mkdirSync(path.join(root,'_hub'));fs.writeFileSync(path.join(root,admission.MARKER),bytes);
  assert.throws(()=>admission.check(root,{release:release('b')}),{code:'DATA_ROOT_IDENTITY_CHANGED'});
});
win('unknown marker, orphan private drafts and malformed receipts never become legacy/ready',t=>{
  const {root}=owned(t);fs.mkdirSync(path.join(root,'_hub'));fs.writeFileSync(path.join(root,admission.MARKER),'{broken');assert.throws(()=>admission.check(root,{release:release()}),{code:'ADMISSION_JSON_INVALID'});
  fs.unlinkSync(path.join(root,admission.MARKER));fs.mkdirSync(path.join(root,admission.RECEIPTS));assert.throws(()=>admission.check(root,{release:release()}),{code:'DATA_FORMAT_MARKER_REQUIRED'});
  fs.rmdirSync(path.join(root,admission.RECEIPTS));admission.ensureFormat(root,{release:release()});fs.mkdirSync(path.join(root,admission.RECEIPTS));fs.mkdirSync(path.join(root,admission.RECEIPTS,crypto.randomUUID()));assert.throws(()=>admission.check(root,{release:release()}),{code:'RECEIPT_METADATA_MISSING'});
  const inspected=admission.check(root,{release:release(),recoveryOnly:true});assert.equal(inspected.inspection.length,1);assert.equal(inspected.inspection[0].repairable,false);assert.equal(inspected.pending.length,0);
});
test('recovery route allowlist permits owner reconciliation and denies new handoff, execution and metadata mutations',()=>{
  for(const [route,method]of [['/api/local/proof','GET'],['/api/local/login','POST'],['/api/local/browser/begin','POST'],['/api/local/browser/poll','POST'],['/api/local/browser/approve','POST'],['/api/state','GET'],['/api/web-chat/status','GET'],['/api/web-chat/status','POST'],['/api/web-chat/inspection','GET'],['/api/web-chat/recover/preview','POST'],['/api/web-chat/recover','POST'],['/api/quit','POST']])assert.equal(admission.restrictRoutes(route,method),true);
  assert.deepEqual(['/api/local/browser/begin','/api/local/browser/poll','/api/local/browser/approve'].map(route=>admission.restrictRoutes(route,'GET')),[false,false,false]);
  assert.equal(admission.restrictRoutes('/api/web-chat/recover/preview','GET'),false);
  for(const route of ['/api/web-chat/preview','/api/web-chat/confirm','/api/web-chat/result','/api/chat/send','/api/start','/api/task','/api/term/start','/api/mcp'])assert.equal(admission.restrictRoutes(route,'POST'),false);
  assert.equal(admission.restrictRoutes('/api/chat/stream','GET'),false);assert.equal(admission.restrictRoutes('/../secret','GET'),false);assert.equal(admission.restrictRoutes('/assets/app.js','GET'),true);
});
test('installer start options reject nonboolean recovery flags and unknown fields without fallback',()=>{
  assert.deepEqual(install.actionOptions('start',{}),{});assert.deepEqual(install.actionOptions('start',{noBrowser:true,recoveryOnly:true}),{noBrowser:true,recoveryOnly:true});
  for(const value of [null,[],{recoveryOnly:'true'},{recoveryOnly:1},{noBrowser:'false'},{recoveryOnly:false,extra:true}])assert.throws(()=>install.actionOptions('start',value),{code:'OPTIONS_REJECTED'});
  assert.throws(()=>install.actionOptions('rollback',{recoveryOnly:true}),{code:'SCHEMA_REJECTED'});
});
win('actual delivered 058 package has no web data capability and refuses the new Root at the managed gate',t=>{
  const {root}=owned(t);admission.ensureFormat(root,{release:release()});
  const oldHub=path.resolve(__dirname,'../../../packages/4.68.2-windows-codex-0583184ee534/hub');assert.equal(fs.existsSync(path.join(oldHub,'server.js')),true,'actual delivered package required for this gate');
  const old=admission.readRelease(oldHub);assert.equal(old.legacy,true);
  assert.throws(()=>admission.check(root,{hubDir:oldHub}),{code:'RELEASE_DATA_FORMAT_UNSUPPORTED'});
});
win('source/package capability fields are exact; unknown flags do not grant newer data access',()=>{
  for(const bad of [{version:999,dataFormats:['legacy','web-manual-v2'],recoveryOnly:true},{version:1,dataFormats:['legacy'],recoveryOnly:true},{version:1,dataFormats:['legacy','web-manual-v2'],recoveryOnly:false},{version:1,dataFormats:['legacy','web-manual-v2'],recoveryOnly:true,extra:true}])assert.throws(()=>admission.capabilities(bad));
  const cap=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/release-capabilities.json'))),schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/release-capabilities.schema.json')));assert.equal(admission.capabilities(cap),cap);assert.deepEqual(Object.keys(cap).sort(),schema.required.slice().sort());assert.equal(schema.additionalProperties,false);
});
win('real NTFS accepted partial states refuse normal/switch start and allow exact same-release reconciliation',{timeout:480000},async t=>{
  const {WebChat}=require('../lib/web-chat'),writer=require('../lib/web-handoff-writer'),{fixture,approved,resultInput}=require('./helpers/web-chat-fixture');
  for(const phase of ['planned','chat_saved','task_note_saved']){
    const f=fixture(t),current=release();admission.ensureFormat(f.root,{release:current});
    const faulty={...writer,...(phase==='planned'?{append:async()=>{throw Error('owned fixture before append');}}:phase==='chat_saved'?{overwrite:async(...args)=>{if(args[1]==='.ai/tasks/t.md')throw Error('owned fixture before task write');return writer.overwrite(...args);}}:{})};
    const service=new WebChat({...f.options,writer:faulty}),a=await approved(service),input=resultInput(a,'合成 durable partial state '+phase);
    if(phase==='task_note_saved'){const save=service.receipts.save.bind(service.receipts);service.receipts.save=async(value,before)=>{if(value.state==='committed')throw Error('owned fixture before committed journal');return save(value,before);};}
    const partial=await service.result(input);assert.equal(partial.state,phase);assert.equal(partial.ok,false);assert.equal(partial.recoveryRequired,true);
    assert.throws(()=>admission.check(f.root,{release:current}),{code:'WEB_TRANSACTION_RECOVERY_REQUIRED'});
    assert.throws(()=>admission.check(f.root,{release:current,recoveryOnly:true,switching:true}),{code:'WEB_TRANSACTION_RECOVERY_REQUIRED'});
    const state=admission.check(f.root,{release:current,recoveryOnly:true});assert.equal(state.pending.length,1);assert.equal(state.pending[0].state,phase);
    assert.throws(()=>admission.check(f.root,{release:release('b'),recoveryOnly:true}),{code:'RECOVERY_RELEASE_MISMATCH'});
    const recovered=await recoverExact(new WebChat({...f.options,writer}),{...a.base,receiptId:a.preview.receiptId});assert.equal(recovered.ok,true,JSON.stringify(recovered));
    assert.equal(admission.check(f.root,{release:current}).pending.length,0);assert.equal(fs.readFileSync(f.log,'utf8').trimEnd().split('\n').length,2);
  }
});
win('same bytes replacement of private receipt blobs fails identity admission before normal or recovery start',{timeout:120000},async t=>{
  const {WebChat}=require('../lib/web-chat'),writer=require('../lib/web-handoff-writer'),{fixture,approved}=require('./helpers/web-chat-fixture'),f=fixture(t),current=release();admission.ensureFormat(f.root,{release:current});
  const service=new WebChat({...f.options,writer}),a=await approved(service),saved=await service.receipts.read(a.preview.receiptId),file=path.join(f.root,admission.RECEIPTS,saved.value.promptBlob.relative),bytes=fs.readFileSync(file);fs.renameSync(file,file+'.old');fs.writeFileSync(file,bytes);
  assert.throws(()=>admission.check(f.root,{release:current}),{code:'RECEIPT_BLOB_CHANGED'});assert.throws(()=>admission.check(f.root,{release:current,recoveryOnly:true}),{code:'RECEIPT_BLOB_CHANGED'});
});
win('replacing the native journal directory cannot introduce a new authority even with copied valid bytes',{timeout:120000},async t=>{
  const {WebChat}=require('../lib/web-chat'),writer=require('../lib/web-handoff-writer'),{fixture,approved}=require('./helpers/web-chat-fixture'),f=fixture(t),current=release();admission.ensureFormat(f.root,{release:current});
  const service=new WebChat({...f.options,writer});await approved(service);
  const directory=path.join(f.root,admission.RECEIPTS,'native'),original=directory+'-original';fs.renameSync(directory,original);fs.cpSync(original,directory,{recursive:true,errorOnExist:true,force:false});
  assert.throws(()=>admission.check(f.root,{release:current}),{code:'WRITER_JOURNAL_ROOT_CHANGED'});
  assert.throws(()=>admission.check(f.root,{release:current,recoveryOnly:true}),{code:'WRITER_JOURNAL_ROOT_CHANGED'});
});
win('cold recovery can inspect unfinished atomic metadata artifacts without accepting or repairing unknown bytes',{timeout:120000},async t=>{
  const {WebChat}=require('../lib/web-chat'),writer=require('../lib/web-handoff-writer'),{fixture,approved}=require('./helpers/web-chat-fixture'),f=fixture(t),current=release();admission.ensureFormat(f.root,{release:current});
  const service=new WebChat({...f.options,writer}),a=await approved(service),beforeTask=fs.readFileSync(f.task),beforeLog=fs.readFileSync(f.log),home=path.join(f.root,admission.RECEIPTS,a.preview.receiptId);
  // Real NTFS partial artifact represents a stopped atomic metadata create.
  // It is not a real process-kill or production crash claim.
  const pending=path.join(home,'.HUB-WEB-'+crypto.randomBytes(16).toString('hex').toUpperCase()+'.TMP');fs.writeFileSync(pending,'{"version":1,"record":');
  assert.throws(()=>admission.check(f.root,{release:current}),{code:'METADATA_PENDING_TEMP'});
  const inspected=admission.check(f.root,{release:current,recoveryOnly:true});assert.equal(inspected.inspection[0].reasonCode,'METADATA_PENDING_TEMP');assert.equal(inspected.inspection[0].repairable,false);assert.equal(inspected.pending.length,0);
  const cold=new WebChat({...f.options,writer});await assert.rejects(cold.recover({...a.base,receiptId:a.preview.receiptId}),{code:'METADATA_PENDING_TEMP'});
  fs.unlinkSync(pending);const latest=await service.receipts.read(a.preview.receiptId),revision=path.join(f.root,admission.RECEIPTS,latest.relative),bytes=fs.readFileSync(revision);assert.ok(latest.sequence>0);fs.writeFileSync(revision,bytes.subarray(0,bytes.length-6));
  assert.throws(()=>admission.check(f.root,{release:current}));const unknown=admission.check(f.root,{release:current,recoveryOnly:true});assert.equal(unknown.inspection.length,1);assert.equal(unknown.inspection[0].repairable,false);assert.equal(unknown.pending.length,0);
  await assert.rejects(new WebChat({...f.options,writer}).recover({...a.base,receiptId:a.preview.receiptId}));
  assert.throws(()=>admission.check(f.root,{release:release('b'),recoveryOnly:true}),{code:'RECOVERY_RELEASE_MISMATCH'});
  assert.deepEqual(fs.readFileSync(f.task),beforeTask);assert.deepEqual(fs.readFileSync(f.log),beforeLog);
});
