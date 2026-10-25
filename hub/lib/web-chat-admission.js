'use strict';
// Managed entry points enforce data compatibility. This cannot make an old
// binary safe if a person starts it outside the managed installer/launcher.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {localPath}=require('./safe-path');
const FORMAT='web-manual-v2',MARKER='_hub/data-format.json',RECEIPTS='_hub/web-chat-receipts';
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NONTERMINAL=new Set(['planned','chat_saved','task_note_saved']);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(Error('資料相容檢查：'+code),{code,status:409,notStarted:true});};
const exact=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!==keys.slice().sort().join(','))fail('DATA_FORMAT_INVALID');};
function native(request){return require('../windows/native-install.cjs').native(request);}
function bounded(file,max=1024*1024){
  localPath(file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>max)fail('ADMISSION_FILE_INVALID');
  const bytes=fs.readFileSync(file);if(bytes.length>max)fail('ADMISSION_FILE_INVALID');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{fail('ADMISSION_JSON_INVALID');}return {value,bytes};
}
function capabilities(value){
  exact(value,['version','dataFormats','recoveryOnly']);
  if(value.version!==1||value.recoveryOnly!==true||!Array.isArray(value.dataFormats)||value.dataFormats.length!==2||value.dataFormats[0]!=='legacy'||value.dataFormats[1]!==FORMAT)fail('RELEASE_CAPABILITIES_INVALID');
  return value;
}
function readRelease(hubDir=path.resolve(__dirname,'..')){
  hubDir=localPath(path.resolve(hubDir));const capabilityFile=path.join(hubDir,'windows/release-capabilities.json');
  if(!fs.existsSync(capabilityFile))return {hubDir,legacy:true,capabilities:null,capabilitiesSHA256:null,identity:null};
  const cap=bounded(capabilityFile,16384);capabilities(cap.value);const capabilitiesSHA256=sha(cap.bytes);
  const packageRoot=path.dirname(hubDir),manifestFile=path.join(packageRoot,'package-manifest.json');
  let identity;
  if(fs.existsSync(manifestFile)){
    const parsed=bounded(manifestFile,8*1024*1024),install=require('../windows/native-install.cjs'),value=install.manifest(parsed.value);
    const file=value.files.find(row=>row.path==='hub/windows/release-capabilities.json');
    if(!file||file.sha256!==capabilitiesSHA256||file.bytes!==cap.bytes.length)fail('RELEASE_CAPABILITIES_CHANGED');
    // Direct use of the new launcher also checks actual version contents. A
    // matching manifest ID alone is not evidence that its runtime stayed intact.
    const rootFingerprint=native({mode:'identity',root:packageRoot}).rootFingerprint;
    install.verifyFiles(packageRoot,value,rootFingerprint);
    if(sha(bounded(manifestFile,8*1024*1024).bytes)!==sha(parsed.bytes))fail('RELEASE_MANIFEST_CHANGED');
    identity={kind:'package',id:value.releaseId,digest:sha(parsed.bytes)};
  }else{
    // Source development/owned fixtures have no signed/package manifest. Bind
    // recovery to their actual controller source bytes and name this explicitly.
    const names=['package.json','server.js','start-windows.ps1','lib/web-chat-admission.js','lib/web-chat.js','lib/web-chat-receipts.js','lib/web-chat-recovery-server.js','lib/web-handoff-writer.js','lib/provider-registry.js','lib/safe-path.js','lib/local-drives.js','windows/native-install.cjs','windows/install-files.cs','windows/local-drives.cs','windows/web-handoff-writer.cs','windows/release-capabilities.json'];
    const parts=[];for(const name of names){const file=localPath(path.join(hubDir,name)),stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>4*1024*1024)fail('RELEASE_SOURCE_INVALID');parts.push([name,sha(fs.readFileSync(file))]);}
    const digest=sha(Buffer.from(JSON.stringify(parts)));identity={kind:'source',id:'source-'+digest.slice(0,12),digest};
  }
  return {hubDir,legacy:false,capabilities:cap.value,capabilitiesSHA256,identity};
}
function validateMarker(value){
  exact(value,['version','format','rootFingerprint','release','capabilitiesSHA256']);exact(value.release,['kind','id','digest']);
  if(value.version!==1||value.format!==FORMAT||!HASH.test(value.rootFingerprint)||!HASH.test(value.capabilitiesSHA256)||!HASH.test(value.release.digest)||!['package','source'].includes(value.release.kind)||typeof value.release.id!=='string'||!(value.release.kind==='package'?/^4\.68\.2-windows-codex-[a-f0-9]{12}$/:/^source-[a-f0-9]{12}$/).test(value.release.id))fail('DATA_FORMAT_INVALID');
  return value;
}
function webEvidence(value){if(!HASH.test(value.webRootFingerprint)||!HASH.test(value.webFileFingerprint))fail('WEB_IDENTITY_EVIDENCE_REQUIRED');return {...value,rootFingerprint:value.webRootFingerprint,fileFingerprint:value.webFileFingerprint};}
function webRoot(root){const result=native({mode:'identity',root});if(!HASH.test(result.webRootFingerprint))fail('WEB_IDENTITY_EVIDENCE_REQUIRED');return result.webRootFingerprint;}
function inspect(root,relative,max=1024*1024,web=false){
  let value=native({mode:'inspect',root,path:relative,text:true});if(web)value=webEvidence(value);if(value.bytes>max)fail('ADMISSION_FILE_TOO_LARGE');
  let parsed;try{parsed=JSON.parse(value.text);}catch{fail('ADMISSION_JSON_INVALID');}return {value:parsed,evidence:value};
}
function journal(root,directory,id,expected,requiredComplete){
  if(!/^[a-f0-9]{32}$/.test(id))fail('WRITER_JOURNAL_ID_INVALID');
  const home=path.join(directory,'native'),folder=path.join(home,id);
  if(!fs.existsSync(folder)){if(requiredComplete)fail('WRITER_JOURNAL_MISSING');return;}
  localPath(folder);const allowed=new Set(['before.bin','after.bin','intent.json','complete.json','created.json']);
  if(fs.readdirSync(folder).some(name=>!allowed.has(name))||!fs.existsSync(path.join(folder,'intent.json')))fail('WRITER_JOURNAL_UNKNOWN');
  const value=inspect(home,id+'/intent.json').value;
  exact(value,['version','recordId','mode','root','rootFingerprint','path','fileFingerprint','beforeHash','afterHash','deltaHash','beforeBytes','afterBytes','beforeBlobFingerprint','afterBlobFingerprint','state']);
  const sourceRoot=localPath(value.root),relative=path.relative(root,sourceRoot);
  if(relative.startsWith('..')||path.isAbsolute(relative)||relative.toLowerCase().startsWith('_hub'+path.sep)||!relative||value.version!==1||value.recordId!==id||value.mode!==expected.mode||value.state!=='prepared'||path.resolve(sourceRoot)!==sourceRoot||value.rootFingerprint!==expected.before.rootFingerprint||value.path!==expected.before.relative||value.fileFingerprint!==expected.before.fileFingerprint||value.beforeHash!==expected.before.sha256||value.beforeBytes!==expected.before.bytes||value.afterHash!==expected.afterHash||value.afterBytes!==expected.afterBytes||value.deltaHash!==expected.deltaHash||!HASH.test(value.beforeBlobFingerprint)||!HASH.test(value.afterBlobFingerprint))fail('WRITER_JOURNAL_BINDING_CHANGED');
  if(webRoot(sourceRoot)!==value.rootFingerprint)fail('WRITER_SOURCE_ROOT_CHANGED');
  const before=webEvidence(native({mode:'inspect',root:home,path:id+'/before.bin'})),after=webEvidence(native({mode:'inspect',root:home,path:id+'/after.bin'}));
  if(before.fileFingerprint!==value.beforeBlobFingerprint||before.bytes!==value.beforeBytes||before.sha256!==(value.beforeHash==='missing'?sha(Buffer.alloc(0)):value.beforeHash)||after.fileFingerprint!==value.afterBlobFingerprint||after.bytes!==value.afterBytes||after.sha256!==value.afterHash)fail('WRITER_JOURNAL_BLOB_CHANGED');
  let created=null;
  if(fs.existsSync(path.join(folder,'created.json'))){created=inspect(home,id+'/created.json').value;exact(created,['recordId','sha256','fileFingerprint','state']);if(value.fileFingerprint!=='missing'||created.recordId!==id||created.sha256!==value.afterHash||created.state!=='created'||!HASH.test(created.fileFingerprint))fail('WRITER_CREATED_INVALID');}
  let complete=null;
  if(fs.existsSync(path.join(folder,'complete.json'))){complete=inspect(home,id+'/complete.json').value;exact(complete,['recordId','state','sha256','fileFingerprint']);if(complete.recordId!==id||complete.state!=='complete'||complete.sha256!==value.afterHash||complete.fileFingerprint!==(created?created.fileFingerprint:value.fileFingerprint))fail('WRITER_COMPLETE_INVALID');}
  if(complete&&expected.afterFingerprint&&complete.fileFingerprint!==expected.afterFingerprint)fail('WRITER_COMPLETE_BINDING_CHANGED');
  if(requiredComplete&&!complete)fail('WRITER_JOURNAL_INCOMPLETE');
}
function receipts(root,{inspectionOnly=false}={}){
  const directory=path.join(root,RECEIPTS);if(!fs.existsSync(directory))return {records:[],inspection:[]};
  localPath(directory);const directoryId=webRoot(directory),names=fs.readdirSync(directory).sort();
  if(names.length>10001)fail('RECEIPT_LIMIT');const result=[];
  const contract=require('./web-chat-receipts'),validator=contract.validateRecord,inspection=[];
  const metadataInspect=(dir,relative,max)=>{
    const file=localPath(path.join(dir,relative),{allowMissing:true});
    if(!fs.existsSync(file))return {missing:true,rootFingerprint:webRoot(dir),fileFingerprint:'missing',sha256:'missing',bytes:0,text:''};
    return inspect(dir,relative,max,true).evidence;
  };
  for(const name of names){
    if(name==='native'){localPath(path.join(directory,name));continue;}
    if(!UUID.test(name)){if(inspectionOnly){inspection.push({receiptId:null,reasonCode:'RECEIPT_ENTRY_UNKNOWN',repairable:false});continue;}fail('RECEIPT_ENTRY_UNKNOWN');}localPath(path.join(directory,name));
    const entries=fs.readdirSync(path.join(directory,name)),isPending=require('./web-handoff-writer').isPendingTempName;
    if(typeof isPending!=='function')fail('TEMP_CLASSIFIER_REQUIRED');
    const pendingTemps=entries.filter(isPending);
    if(pendingTemps.length){if(!inspectionOnly)fail('METADATA_PENDING_TEMP');inspection.push({receiptId:name,reasonCode:'METADATA_PENDING_TEMP',repairable:false});}
    let record;
    try{if(!fs.existsSync(path.join(directory,name,'receipt.json')))fail('RECEIPT_METADATA_MISSING');record=contract.readMetadataChainSync(directory,name,metadataInspect);validator(record.value);}
    catch(error){if(!inspectionOnly)throw error;inspection.push({receiptId:name,reasonCode:/^[A-Z0-9_]{1,80}$/.test(error.code||'')?error.code:'METADATA_UNKNOWN',repairable:false});continue;}
    if(record.value.receiptId!==name||record.evidence.rootFingerprint!==directoryId)fail('RECEIPT_IDENTITY_CHANGED');
    if(!fs.existsSync(path.join(directory,'native'))||webRoot(path.join(directory,'native'))!==record.value.nativeJournalRootFingerprint)fail('WRITER_JOURNAL_ROOT_CHANGED');
    const blobs=[record.value.promptBlob,...(record.value.transaction?[record.value.transaction.resultBlob,record.value.transaction.rowBlob,record.value.transaction.taskBeforeBlob,record.value.transaction.taskAfterBlob]:[])];
    for(const blob of blobs){
      if(!blob.relative.startsWith(name+'/')||blob.rootFingerprint!==directoryId)fail('RECEIPT_BLOB_BINDING_CHANGED');
      const observed=webEvidence(native({mode:'inspect',root:directory,path:blob.relative}));
      if(observed.rootFingerprint!==blob.rootFingerprint||observed.fileFingerprint!==blob.fileFingerprint||observed.sha256!==blob.sha256||observed.bytes!==blob.bytes)fail('RECEIPT_BLOB_CHANGED');
    }
    const unknown=entries.some(entry=>!isPending(entry)&&!['receipt.json','prompt.txt','result.txt','row.txt','task-before.txt','task-after.txt'].includes(entry)&&!/^metadata-[0-9]{6}-[a-f0-9]{64}\.json$/.test(entry));
    if(unknown){if(!inspectionOnly)fail('METADATA_ENTRY_UNKNOWN');inspection.push({receiptId:name,reasonCode:'METADATA_ENTRY_UNKNOWN',repairable:false});}
    result.push(record.value);
  }
  for(const record of result){
    if(!NONTERMINAL.has(record.state))continue;const tx=record.transaction;
    journal(root,directory,tx.chatJournalId,{mode:'append',before:tx.logBefore,afterHash:tx.logAfterSHA256,afterBytes:tx.logBefore.bytes+tx.rowBlob.bytes,deltaHash:tx.rowBlob.sha256,afterFingerprint:tx.logAfterFileFingerprint},['chat_saved','task_note_saved'].includes(record.state));
    journal(root,directory,tx.taskJournalId,{mode:'overwrite',before:tx.taskBefore,afterHash:tx.taskAfterSHA256,afterBytes:tx.taskAfterBlob.bytes,deltaHash:tx.taskAfterSHA256},record.state==='task_note_saved');
  }
  if(webRoot(directory)!==directoryId)fail('RECEIPT_ROOT_CHANGED');return {records:result,inspection};
}
function sameRelease(a,b){return Boolean(a&&b&&a.kind===b.kind&&a.id===b.id&&a.digest===b.digest);}
function check(root,{hubDir=path.resolve(__dirname,'..'),release,recoveryOnly=false,switching=false}={}){
  root=localPath(path.resolve(root),{allowMissing:true});release=release||readRelease(hubDir);
  if(typeof recoveryOnly!=='boolean'||typeof switching!=='boolean')fail('ADMISSION_OPTIONS_INVALID');
  if(!fs.existsSync(root)){if(recoveryOnly)fail('RECOVERY_ROOT_REQUIRED');return {ok:true,format:'legacy',recoveryOnly:false,pending:[]};}
  const rootFingerprint=native({mode:'identity',root}).rootFingerprint,markerFile=path.join(root,MARKER);
  if(!fs.existsSync(markerFile)){
    if(fs.existsSync(path.join(root,RECEIPTS)))fail('DATA_FORMAT_MARKER_REQUIRED');
    if(recoveryOnly)fail('RECOVERY_FORMAT_REQUIRED');return {ok:true,format:'legacy',rootFingerprint,recoveryOnly:false,pending:[]};
  }
  const marker=inspect(root,MARKER,16384);validateMarker(marker.value);
  if(marker.evidence.rootFingerprint!==rootFingerprint||marker.value.rootFingerprint!==rootFingerprint)fail('DATA_ROOT_IDENTITY_CHANGED');
  if(release.legacy||!release.capabilities?.dataFormats.includes(FORMAT))fail('RELEASE_DATA_FORMAT_UNSUPPORTED');
  if(release.legacy!==false)fail('RELEASE_CAPABILITIES_INVALID');capabilities(release.capabilities);
  if(recoveryOnly&&(!sameRelease(marker.value.release,release.identity)||marker.value.capabilitiesSHA256!==release.capabilitiesSHA256))fail('RECOVERY_RELEASE_MISMATCH');
  const assessed=receipts(root,{inspectionOnly:recoveryOnly}),pending=assessed.records.filter(row=>NONTERMINAL.has(row.state)).map(row=>({receiptId:row.receiptId,state:row.state}));
  if((pending.length||assessed.inspection.length)&&(!recoveryOnly||switching))fail('WEB_TRANSACTION_RECOVERY_REQUIRED');
  if(native({mode:'identity',root}).rootFingerprint!==rootFingerprint)fail('DATA_ROOT_IDENTITY_CHANGED');
  return {ok:true,format:FORMAT,rootFingerprint,recoveryOnly,pending,inspection:assessed.inspection,marker:marker.value,markerEvidence:marker.evidence,release};
}
function ensureFormat(root,options={}){
  const release=options.release||readRelease(options.hubDir),state=check(root,{...options,release,recoveryOnly:false});
  if(release.legacy)fail('RELEASE_DATA_FORMAT_UNSUPPORTED');
  if(release.legacy!==false)fail('RELEASE_CAPABILITIES_INVALID');capabilities(release.capabilities);
  const rootFingerprint=state.rootFingerprint||native({mode:'identity',root,create:true}).rootFingerprint;
  const value={version:1,format:FORMAT,rootFingerprint,release:release.identity,capabilitiesSHA256:release.capabilitiesSHA256};validateMarker(value);
  if(state.marker&&sameRelease(state.marker.release,release.identity)&&state.marker.capabilitiesSHA256===release.capabilitiesSHA256)return state;
  const written=native({mode:'write',root,rootFingerprint,path:MARKER,text:JSON.stringify(value,null,2)+'\n',expectedHash:state.markerEvidence?.sha256||'missing',...(state.markerEvidence?{fileFingerprint:state.markerEvidence.fileFingerprint}:{})});
  if(native({mode:'identity',root}).rootFingerprint!==rootFingerprint||written.sha256!==sha(Buffer.from(JSON.stringify(value,null,2)+'\n')))fail('DATA_ROOT_IDENTITY_CHANGED');return check(root,{...options,release,recoveryOnly:false});
}
const RECOVERY_READ_ROUTES=new Set(['/api/local/proof','/api/local/login','/api/state','/api/web-chat/status','/api/web-chat/inspection']);
const RECOVERY_WRITE_ROUTES=new Set(['/api/local/login','/api/local/browser/begin','/api/local/browser/poll','/api/local/browser/approve','/api/quit','/api/web-chat/status','/api/web-chat/recover/preview','/api/web-chat/recover']);
function restrictRoutes(pathname,method='GET'){
  if(typeof pathname!=='string'||typeof method!=='string')return false;
  if(method==='GET'&&(pathname==='/'||pathname==='/login'||!pathname.startsWith('/api/')))return !pathname.includes('..')&&!pathname.includes('\\');
  return (method==='GET'?RECOVERY_READ_ROUTES:method==='POST'?RECOVERY_WRITE_ROUTES:new Set()).has(pathname);
}
module.exports={FORMAT,MARKER,RECEIPTS,NONTERMINAL,capabilities,readRelease,validateMarker,check,ensureFormat,restrictRoutes,sameRelease};
