'use strict';
// Controller-only journals. Hashes support local reconciliation, not attestation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const LIMITS = Object.freeze({ input:48*1024, prompt:128*1024, result:256*1024, row:2*1024*1024, task:4*1024*1024, metadata:1024*1024, log:64*1024*1024, receipts:10000 });
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const STATES=new Set(['preview','approved','revoked','planned','chat_saved','task_note_saved','committed']);
const component=x=>typeof x==='string'&&x.length>0&&x.length<=4096&&x.isWellFormed()&&!/[\\/\0<>:"|?*\x00-\x1f]/.test(x)&&!['.','..'].includes(x)&&!/[. ]$/.test(x);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(code,status=409)=>Object.assign(Error('網頁交接：'+code),{code,status});
function scalar(text,max=LIMITS.metadata) {
  if(typeof text!=='string'||!text.isWellFormed()||text.includes('\0')||Buffer.byteLength(text,'utf8')>max)throw fail('INVALID_TEXT',400);
  return text;
}
function decode(bytes,max) {
  if(!Buffer.isBuffer(bytes)||bytes.length>max)throw fail('SOURCE_TOO_LARGE',409);
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('INVALID_UTF8',400);}
  return scalar(text,max);
}
function exact(value,required,optional=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>![...required,...optional].includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw fail('INVALID_FIELDS',400);
  return value;
}
function allScalar(value) {
  const pending=[value];while(pending.length){const item=pending.pop();if(typeof item==='string')scalar(item,LIMITS.log);else if(Array.isArray(item))for(const entry of item)pending.push(entry);else if(item&&typeof item==='object')for(const [key,entry]of Object.entries(item)){scalar(key);pending.push(entry);}}
}
function* iterateRows(text) {
  scalar(text,LIMITS.log);if(text&&!text.endsWith('\n'))throw fail('CHAT_LOG_INCOMPLETE');
  let cursor=0,index=0;
  while(cursor<text.length) {
    const end=text.indexOf('\n',cursor),line=text.slice(cursor,end);if(!line)throw fail('CHAT_LOG_CORRUPT');
    if(Buffer.byteLength(line)>LIMITS.row)throw fail('CHAT_ROW_TOO_LARGE');
    let row;try{row=JSON.parse(line);}catch{throw fail('CHAT_LOG_CORRUPT');}
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.role!=='string'||!['user','assistant','event'].includes(row.role)||row.text!==undefined&&typeof row.text!=='string')throw fail('CHAT_LOG_CORRUPT');
    allScalar(row);yield {row,index};index++;cursor=end+1;
  }
}
function strictRows(text){return Array.from(iterateRows(text),item=>item.row);}
function identity(value) {
  exact(value,['relative','rootFingerprint','fileFingerprint','sha256','bytes','missing']);
  scalar(value.relative,32768);
  if(path.isAbsolute(value.relative)||value.relative.split(/[\\/]/).some(x=>!x||x==='.'||x==='..')||!HASH.test(value.rootFingerprint)||typeof value.missing!=='boolean'||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>LIMITS.log||!((value.missing&&value.bytes===0&&value.sha256==='missing'&&value.fileFingerprint==='missing')||(!value.missing&&HASH.test(value.sha256)&&HASH.test(value.fileFingerprint))))throw fail('RECEIPT_IDENTITY_INVALID');
  return value;
}
const RECORD_KEYS=['version','receiptId','ownerHash','actor','transport','destination','project','task','responseLanguage','state','createdAt','previewExpiresAt','approvedAt','resultExpiresAt','previewTokenHash','resultTokenHash','taskHash','taskHashAlgorithm','rawTaskSHA256','promptSHA256','sourceManifest','truncation','promptBlob','nativeJournalRootFingerprint','transaction','revokedAt'];
function validateRecord(value) {
  exact(value,RECORD_KEYS);allScalar(value);
  if(!HASH.test(value.nativeJournalRootFingerprint))throw fail('RECEIPT_JOURNAL_BINDING_INVALID');
  if(value.version!==2||!UUID.test(value.receiptId)||!HASH.test(value.ownerHash)||!['chatgpt','claude-chat'].includes(value.actor)||value.transport!=='web-manual'||value.destination!==({chatgpt:'https://chatgpt.com/','claude-chat':'https://claude.ai/'})[value.actor]||!['zh-TW','ja'].includes(value.responseLanguage)||!STATES.has(value.state)||value.taskHashAlgorithm!=='hub-completion-crlf-to-lf-v1'||!HASH.test(value.taskHash)||!HASH.test(value.rawTaskSHA256)||!HASH.test(value.promptSHA256)||!HASH.test(value.previewTokenHash)||!(value.resultTokenHash===null||HASH.test(value.resultTokenHash))||![value.createdAt,value.previewExpiresAt].every(Number.isSafeInteger)||value.previewExpiresAt-value.createdAt!==300000||![value.approvedAt,value.resultExpiresAt,value.revokedAt].every(x=>x===null||Number.isSafeInteger(x)))throw fail('RECEIPT_INVALID');
  if(!component(value.project)||!component(value.task))throw fail('RECEIPT_SCOPE_INVALID');
  const approved=value.approvedAt!==null;
  if(approved?(!HASH.test(value.resultTokenHash)||value.resultExpiresAt-value.approvedAt!==3600000||value.approvedAt<value.createdAt):(value.resultExpiresAt!==null||value.resultTokenHash!==null))throw fail('RECEIPT_CLOCK_BINDING_INVALID');
  if(value.state==='preview'&&approved||value.state==='approved'&&!approved||['planned','chat_saved','task_note_saved','committed'].includes(value.state)&&!approved||value.state==='revoked'&&value.revokedAt===null)throw fail('RECEIPT_STATE_INVALID');
  if(!Array.isArray(value.sourceManifest)||value.sourceManifest.length!==3||!Array.isArray(value.truncation))throw fail('RECEIPT_INVALID');
  for(const entry of value.sourceManifest){exact(entry,['kind','identity','extraction']);if(!['task','project','chat'].includes(entry.kind))throw fail('RECEIPT_INVALID');identity(entry.identity);validateExtraction(entry.extraction);if(entry.extraction.endByte>entry.identity.bytes||entry.identity.relative!==({task:'.ai/tasks/'+value.task+'.md',project:'PROJECT.md',chat:'.ai/chat/'+value.task+'.jsonl'})[entry.kind])throw fail('RECEIPT_SOURCE_BINDING_INVALID');}
  if(new Set(value.sourceManifest.map(x=>x.kind)).size!==3)throw fail('RECEIPT_INVALID');
  const taskSource=value.sourceManifest.find(x=>x.kind==='task').identity;
  if(taskSource.missing||value.rawTaskSHA256!==taskSource.sha256||value.sourceManifest.some(x=>x.identity.rootFingerprint!==taskSource.rootFingerprint))throw fail('RECEIPT_SOURCE_BINDING_INVALID');
  const truncation=value.sourceManifest.filter(x=>x.extraction.truncated).map(x=>({kind:x.kind,rule:x.extraction.rule,startByte:x.extraction.startByte,endByte:x.extraction.endByte,rowIndexes:x.extraction.rowIndexes,fullSourceBytes:x.identity.bytes}));
  if(JSON.stringify(value.truncation)!==JSON.stringify(truncation))throw fail('RECEIPT_EXTRACTION_INVALID');
  blob(value.promptBlob,LIMITS.prompt);if(value.promptBlob.relative!==value.receiptId+'/prompt.txt'||value.promptBlob.sha256!==value.promptSHA256)throw fail('RECEIPT_BLOB_BINDING_INVALID');
  if(value.transaction!==null)validateTransaction(value.transaction);
  if(['planned','chat_saved','task_note_saved','committed'].includes(value.state)!==(value.transaction!==null))throw fail('RECEIPT_STATE_INVALID');
  if(value.transaction){const tx=value.transaction;if(tx.resultSHA256!==tx.resultBlob.sha256||JSON.stringify(tx.taskBefore)!==JSON.stringify(taskSource)||JSON.stringify(tx.logBefore)!==JSON.stringify(value.sourceManifest.find(x=>x.kind==='chat').identity))throw fail('RECEIPT_BINDING_INVALID');for(const [field,name]of [['resultBlob','result'],['rowBlob','row'],['taskBeforeBlob','task-before'],['taskAfterBlob','task-after']])if(tx[field].relative!==value.receiptId+'/'+name+'.txt'||tx[field].rootFingerprint!==value.promptBlob.rootFingerprint)throw fail('RECEIPT_BLOB_BINDING_INVALID');}
  return value;
}
function validateExtraction(x) {
  exact(x,['rule','startByte','endByte','rowIndexes','truncated']);
  if(!['utf8-prefix','project-body-prefix','recent-human-assistant-rows'].includes(x.rule)||!Number.isSafeInteger(x.startByte)||!Number.isSafeInteger(x.endByte)||x.startByte<0||x.endByte<x.startByte||!Array.isArray(x.rowIndexes)||x.rowIndexes.some(i=>!Number.isSafeInteger(i)||i<0)||typeof x.truncated!=='boolean')throw fail('RECEIPT_EXTRACTION_INVALID');
}
function blob(x,max) {
  exact(x,['relative','rootFingerprint','fileFingerprint','sha256','bytes']);
  identity({...x,missing:false});if(x.bytes>max)throw fail('RECEIPT_BLOB_TOO_LARGE');return x;
}
function validateTransaction(x) {
  exact(x,['requestId','resultSHA256','rowId','acceptedAt','resultBlob','rowBlob','taskBeforeBlob','taskAfterBlob','taskBefore','logBefore','taskAfterSHA256','logAfterSHA256','chatJournalId','taskJournalId','taskNoteEncoding','logAfterFileFingerprint']);
  if(x.logAfterFileFingerprint!==null&&!HASH.test(x.logAfterFileFingerprint))throw fail('RECEIPT_FILEID_INVALID');
  if(x.taskNoteEncoding!=='web-task-blockquote-preserve-newlines-v1')throw fail('TASK_NOTE_ENCODING_INVALID');
  if(!UUID.test(x.requestId)||!UUID.test(x.rowId)||!HASH.test(x.resultSHA256)||!Number.isSafeInteger(x.acceptedAt)||!HASH.test(x.taskAfterSHA256)||!HASH.test(x.logAfterSHA256)||![x.chatJournalId,x.taskJournalId].every(i=>/^[a-f0-9]{32}$/.test(i)))throw fail('RECEIPT_TRANSACTION_INVALID');
  blob(x.resultBlob,LIMITS.result);blob(x.rowBlob,LIMITS.row);blob(x.taskBeforeBlob,LIMITS.task);blob(x.taskAfterBlob,LIMITS.task);identity(x.taskBefore);identity(x.logBefore);
  if(x.taskAfterBlob.sha256!==x.taskAfterSHA256||x.taskBeforeBlob.sha256!==x.taskBefore.sha256)throw fail('RECEIPT_BINDING_INVALID');return x;
}
const REVISION=/^metadata-([0-9]{6})-([a-f0-9]{64})\.json$/;
const TRANSITIONS={preview:['approved','revoked'],approved:['planned','revoked'],planned:['chat_saved'],chat_saved:['task_note_saved'],task_note_saved:['committed'],committed:[],revoked:[]};
function metadataNames(directory,id) {const home=path.join(directory,id),names=fs.readdirSync(home),revisions=[];for(const name of names){if(!name.startsWith('metadata-'))continue;const match=name.match(REVISION);if(!match)throw fail('METADATA_ENTRY_UNKNOWN');revisions.push({name,sequence:Number(match[1]),sha256:match[2]});}if(revisions.length>16)throw fail('METADATA_REVISION_LIMIT');return revisions.sort((a,b)=>a.sequence-b.sequence);}
function parseMetadata(evidence){let value;try{const text=scalar(evidence.text,LIMITS.metadata);if(digest(Buffer.from(text))!==evidence.sha256||Buffer.byteLength(text)!==evidence.bytes)throw fail('METADATA_UTF8_CHANGED');value=JSON.parse(text);}catch(error){if(error.code)throw error;throw fail('RECEIPT_CORRUPT');}return value;}
function advanceMetadata(id,current,entry,evidence) {
  if(evidence.missing||evidence.sha256!==entry.sha256||evidence.rootFingerprint!==current.evidence.rootFingerprint)throw fail('METADATA_BYTES_CHANGED');const envelope=parseMetadata(evidence);exact(envelope,['version','receiptId','sequence','previousMetadata','record']);exact(envelope.previousMetadata,['relative','sha256','fileFingerprint']);
  if(envelope.version!==1||envelope.receiptId!==id||entry.sequence!==current.sequence+1||envelope.sequence!==entry.sequence||envelope.previousMetadata.relative!==current.relative||envelope.previousMetadata.sha256!==current.evidence.sha256||envelope.previousMetadata.fileFingerprint!==current.evidence.fileFingerprint)throw fail('METADATA_CHAIN_CHANGED');
  validateRecord(envelope.record);if(envelope.record.receiptId!==id||!TRANSITIONS[current.value.state].includes(envelope.record.state))throw fail('METADATA_STATE_CHANGED');
  const immutable=['version','receiptId','ownerHash','actor','transport','destination','project','task','responseLanguage','createdAt','previewExpiresAt','previewTokenHash','taskHash','taskHashAlgorithm','rawTaskSHA256','promptSHA256','sourceManifest','truncation','promptBlob','nativeJournalRootFingerprint'];for(const key of immutable)if(JSON.stringify(envelope.record[key])!==JSON.stringify(current.value[key]))throw fail('METADATA_BINDING_CHANGED');
  if(current.value.transaction){const before={...current.value.transaction,logAfterFileFingerprint:null},after={...envelope.record.transaction,logAfterFileFingerprint:null};if(JSON.stringify(before)!==JSON.stringify(after)||current.value.transaction.logAfterFileFingerprint&&current.value.transaction.logAfterFileFingerprint!==envelope.record.transaction.logAfterFileFingerprint)throw fail('METADATA_TRANSACTION_CHANGED');}
  return {value:envelope.record,evidence,sequence:entry.sequence,relative:id+'/'+entry.name};
}
function initialMetadata(id,evidence){if(evidence.missing)throw fail('RECEIPT_NOT_FOUND',404);const value=parseMetadata(evidence);validateRecord(value);if(value.receiptId!==id||value.state!=='preview')throw fail('INITIAL_METADATA_INVALID');return {value,evidence,sequence:0,relative:id+'/receipt.json'};}
function readMetadataChainSync(directory,id,inspect) {
  if(!UUID.test(id)||typeof inspect!=='function')throw fail('RECEIPT_ID_INVALID');const normalize=e=>e.evidence||e;
  let current=initialMetadata(id,normalize(inspect(directory,id+'/receipt.json',LIMITS.metadata)));for(const entry of metadataNames(directory,id))current=advanceMetadata(id,current,entry,normalize(inspect(directory,id+'/'+entry.name,LIMITS.metadata)));return current;
}
function assessOrphansSync(directory,inspect) {
  if(!fs.existsSync(directory))return [];const names=fs.readdirSync(directory);if(names.length>LIMITS.receipts+1)throw fail('RECEIPT_LIMIT');const result=[];
  for(const id of names){if(id==='native')continue;if(!UUID.test(id)){result.push({receiptId:null,reasonCode:'PRIVATE_ENTRY_UNKNOWN',repairable:false});continue;}try{readMetadataChainSync(directory,id,inspect);}catch(error){result.push({receiptId:id,reasonCode:error.code||'METADATA_UNKNOWN',repairable:false});}}
  return result;
}
class WebChatReceipts {
  constructor({root,writer,directory=path.join(root,'_hub','web-chat-receipts')}) {
    this.root=path.resolve(root);this.directory=path.resolve(directory);this.writer=writer;this.pin=null;this.nativePin=null;this.pending=Promise.resolve();this.blobPins=new Map();this.knownPreviews=new Map();
    const relative=path.relative(this.root,this.directory);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw fail('PRIVATE_ROOT_INVALID');
  }
  async init() {
    if(!this.pin){const parent=await this.writer.identity(this.root);const id=await this.writer.identity(this.directory,{create:true,parentRoot:this.root,parentFingerprint:parent.rootFingerprint});if(!HASH.test(id.rootFingerprint))throw fail('PRIVATE_ROOT_INVALID');this.pin=id.rootFingerprint;}
    const current=await this.writer.identity(this.directory);if(current.rootFingerprint!==this.pin)throw fail('PRIVATE_ROOT_CHANGED');return this.pin;
  }
  async run(fn) {
    const prior=this.pending;let release;this.pending=new Promise(r=>release=r);await prior;try{return await fn();}finally{release();}
  }
  file(id){if(!UUID.test(id))throw fail('RECEIPT_ID_INVALID',400);return id+'/receipt.json';}
  async inspect(relative,max=LIMITS.metadata){await this.init();return this.writer.inspect(this.directory,relative,{text:true,maxBytes:max,rootFingerprint:this.pin});}
  async read(id) {
    let current=initialMetadata(id,await this.inspect(this.file(id)));for(const entry of metadataNames(this.directory,id))current=advanceMetadata(id,current,entry,await this.inspect(id+'/'+entry.name));return current;
  }
  async list(skipId) {
    await this.init();const names=fs.readdirSync(this.directory);if(names.length>LIMITS.receipts+2)throw fail('RECEIPT_LIMIT');
    const values=[];for(const name of names){if(name==='native'||name===skipId)continue;if(!UUID.test(name))throw fail('PRIVATE_ENTRY_UNKNOWN');values.push((await this.read(name)).value);}return values;
  }
  assertWritable(id){this.file(id);const home=path.join(this.directory,id);if(fs.existsSync(home)&&fs.readdirSync(home).some(name=>/^\.hub-web-[a-f0-9]{32}\.tmp$/i.test(name)))throw fail('METADATA_PENDING_TEMP');}
  async request(id) {
    if(!UUID.test(id))throw fail('REQUEST_ID_INVALID',400);
    const records=(await this.list()).filter(r=>r.transaction?.requestId===id);if(records.length>1)throw fail('REQUEST_ID_DUPLICATE');return records[0]||null;
  }
  async create(value) {
    validateRecord(value);if((await this.list(value.receiptId)).length>=LIMITS.receipts)throw fail('RECEIPT_LIMIT');
    this.knownPreviews.set(value.receiptId,structuredClone(value));if(typeof this.writer.atomicCreate!=='function')throw fail('ATOMIC_METADATA_WRITER_REQUIRED');await this.writer.atomicCreate(this.directory,this.file(value.receiptId),JSON.stringify(value)+'\n',this.pin);this.knownPreviews.delete(value.receiptId);return value;
  }
  async retryKnownPreviews(owner) {
    for(const [id,value]of this.knownPreviews){if(value.ownerHash!==digest(owner))continue;await this.init();await this.readBlob(value.promptBlob,LIMITS.prompt);await this.journal(undefined,value.nativeJournalRootFingerprint);
      this.assertWritable(id);
      const present=await this.inspect(this.file(id));if(present.missing)await this.writer.atomicCreate(this.directory,this.file(id),JSON.stringify(value)+'\n',this.pin);
      const current=await this.read(id);if(current.sequence!==0||JSON.stringify(current.value)!==JSON.stringify(value))throw fail('PREVIEW_REPAIR_CHANGED');this.knownPreviews.delete(id);
    }
  }
  async save(value,before) {
    validateRecord(value);this.assertWritable(value.receiptId);const current=await this.read(value.receiptId);if(current.evidence.sha256!==before.sha256||current.evidence.fileFingerprint!==before.fileFingerprint)throw fail('RECEIPT_CHANGED');await this.journal(undefined,value.nativeJournalRootFingerprint);
    const envelope={version:1,receiptId:value.receiptId,sequence:current.sequence+1,previousMetadata:{relative:current.relative,sha256:current.evidence.sha256,fileFingerprint:current.evidence.fileFingerprint},record:value},text=JSON.stringify(envelope)+'\n';scalar(text,LIMITS.metadata);
    const name='metadata-'+String(envelope.sequence).padStart(6,'0')+'-'+digest(Buffer.from(text))+'.json';if(typeof this.writer.atomicCreate!=='function')throw fail('ATOMIC_METADATA_WRITER_REQUIRED');await this.writer.atomicCreate(this.directory,value.receiptId+'/'+name,text,this.pin);
    const saved=await this.read(value.receiptId);if(digest(JSON.stringify(saved.value))!==digest(JSON.stringify(value)))throw fail('RECEIPT_SAVE_UNCONFIRMED');return saved;
  }
  async createBlob(id,name,text,kind) {
    this.file(id);if(!/^[a-z-]{1,40}$/.test(name))throw fail('BLOB_NAME_INVALID');await this.init();const relative=id+'/'+name+'.txt';
    const known=this.blobPins.get(relative);if(known){if(known.sha256!==digest(Buffer.from(text)))throw fail('BLOB_RETRY_BYTES_CHANGED');await this.readBlob(known,LIMITS[kind==='raw-result'?'result':kind]);return known;}
    const result=await this.writer.create(this.directory,relative,text,this.pin,{kind});
    const evidence=await this.inspect(relative,LIMITS[kind==='raw-result'?'result':kind]);
    if(evidence.missing||evidence.sha256!==digest(Buffer.from(text,'utf8'))||result.sha256&&result.sha256!==evidence.sha256)throw fail('BLOB_SAVE_UNCONFIRMED');
    const saved={relative,rootFingerprint:this.pin,fileFingerprint:evidence.fileFingerprint,sha256:evidence.sha256,bytes:evidence.bytes};this.blobPins.set(relative,saved);return saved;
  }
  async readBlob(ref,max) {
    blob(ref,max);const evidence=await this.inspect(ref.relative,max);
    if(evidence.missing||evidence.sha256!==ref.sha256||evidence.fileFingerprint!==ref.fileFingerprint||evidence.rootFingerprint!==ref.rootFingerprint||evidence.bytes!==ref.bytes)throw fail('BLOB_CHANGED');return scalar(evidence.text,max);
  }
  async journal(recordId,expectedPin) {
    await this.init();const root=path.join(this.directory,'native'),bound=expectedPin||this.nativePin;
    if(expectedPin&&!HASH.test(expectedPin)||expectedPin&&this.nativePin&&expectedPin!==this.nativePin)throw fail('JOURNAL_ROOT_CHANGED');
    const id=await this.writer.identity(root,{create:!bound,parentRoot:this.directory,parentFingerprint:this.pin});
    if(!HASH.test(id.rootFingerprint)||bound&&id.rootFingerprint!==bound)throw fail('JOURNAL_ROOT_CHANGED');
    this.nativePin=id.rootFingerprint;return {root,rootFingerprint:this.nativePin,recordId};
  }
}
module.exports={WebChatReceipts,LIMITS,UUID,HASH,STATES,digest,fail,scalar,decode,exact,strictRows,iterateRows,identity,validateRecord,validateTransaction,readMetadataChainSync,assessOrphansSync};
