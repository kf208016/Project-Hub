'use strict';
// Non-secret controller. Native code owns credential bytes and migration state.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const vault=require('./ssh-password-vault'),managed=require('./managed-process');
const {decode,canonical}=require('./worker-channel');
const SHA=/^[a-f0-9]{64}$(?![\s\S])/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const REVIEW='docs/superpowers/specs/2026-10-14-ssh-vault-maintenance-design.md';
const MANIFEST_FIELDS=['schemaVersion','migrationId','issuedAt','expiresAt','reviewReference','sourceDescriptor','destinationDescriptor','sourceReceiptSHA256','sourceUid','sourceBroker','helper','helperSHA256','destinationBroker','catalogSHA256','payloadSHA256','payloadLength','pointerRoot','pointerRootFingerprint','pointerExpectedSHA256','pointerFileName'];
const RUN_FIELDS=['protocol','op','sequence','nonce','catalogSHA256','bootId','uid','case','expiresAtUnixSeconds','runtimeSeconds'];
const RECOVERY_FIELDS=['version','migrationId','manifestSHA256','observedStateSHA256','issuedAt','expiresAt','operation'];
const SOURCE_NAMES=['ssh-maintenance-common.cs','ssh-maintenance-store.cs','ssh-maintenance-process.cs','ssh-maintenance-pointer.cs','ssh-maintenance-state.cs','ssh-maintenance-recovery.cs','ssh-maintenance-entry.cs','ssh-maintenance-transport.cs','ssh-vault-store.cs','ssh-vault-transport.cs','pinned-root.cs'];
const EVENTS=new Set(['SOURCE_VERIFIED','INTENT_RECORDED','DESTINATION_STORED','VALIDATION_PROBE_1','VALIDATION_PROBE_2','DESTINATION_VALIDATED','ACTIVATION_INTENT','POINTER_WRITTEN','DESTINATION_ACTIVE','SOURCE_DELETE_INTENT','SOURCE_DELETED','SOURCE_TOMBSTONE','COMPLETED','ROLLED_BACK','POINTER_RESTORED','IDENTITY_VERIFIED','R2_SSH_EXIT_0','ASKPASS_SUPPLIED','ASKPASS_REJECTED','SSH_HOST_PIN_MATCHED','SSH_PASSWORD_AUTHENTICATED','SSH_PERMISSION_DENIED','SSH_INPUT_FAILED','SSH_OUTPUT_FAILED','SSH_DIAGNOSTIC_REJECTED','SSH_DEADLINE']);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const failure=code=>Object.assign(Error(code),{code});
function requireValue(ok,code){if(!ok)throw failure(code);}
function fields(value,names){requireValue(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===names.length&&names.every(n=>Object.hasOwn(value,n)),'MAINTENANCE_FIELDS_REJECTED');}
function absolute(p){return typeof p==='string'&&/^[A-Za-z]:\\/.test(p)&&p.length<240&&!/[\0\r\n]/.test(p)&&path.win32.normalize(p)===p&&!p.endsWith('\\')&&!p.slice(3).split('\\').some(x=>!x||x.endsWith('.')||x.endsWith(' ')||x.includes(':'));}
function validateManifest(m,{now=Math.floor(Date.now()/1000),allowExpired=false}={}){
  fields(m,MANIFEST_FIELDS);requireValue(m.schemaVersion===1&&typeof m.migrationId==='string'&&UUID.test(m.migrationId),'MIGRATION_ID_REJECTED');
  requireValue(Number.isSafeInteger(m.issuedAt)&&Number.isSafeInteger(m.expiresAt)&&m.issuedAt>0&&m.expiresAt<=2147483647&&m.expiresAt>m.issuedAt&&m.expiresAt-m.issuedAt<=86400,'MIGRATION_WINDOW_REJECTED');
  requireValue(Number.isSafeInteger(now)&&m.issuedAt<=now&&(allowExpired||m.expiresAt>now),'MIGRATION_EXPIRED_OR_FUTURE');
  requireValue(m.reviewReference===REVIEW,'MIGRATION_REVIEW_REJECTED');
  const s=vault.validate(m.sourceDescriptor),d=vault.validate(m.destinationDescriptor);
  requireValue(s.root.toLowerCase()!==d.root.toLowerCase()&&s.registrationId!==d.registrationId,'MIGRATION_SAME_REGISTRATION');
  for(const key of ['ownerSid','host','port','user','hostKey','hostFingerprint','ssh','sshSHA256'])requireValue(s[key]===d[key],'MIGRATION_IDENTITY_CHANGED');
  for(const key of ['sourceReceiptSHA256','helperSHA256','catalogSHA256','payloadSHA256','pointerRootFingerprint'])requireValue(typeof m[key]==='string'&&SHA.test(m[key]),'MIGRATION_DIGEST_REJECTED');
  for(const key of ['sourceBroker','helper','destinationBroker','pointerRoot'])requireValue(absolute(m[key]),'MIGRATION_PATH_REJECTED');
  const roots=[s.root,d.root,m.pointerRoot].map(x=>x.toLowerCase());
  for(let a=0;a<roots.length;a++)for(let b=a+1;b<roots.length;b++)requireValue(roots[a]!==roots[b]&&!roots[a].startsWith(roots[b]+'\\')&&!roots[b].startsWith(roots[a]+'\\'),'MIGRATION_ROOTS_OVERLAP');
  requireValue(new Set([m.sourceBroker,m.helper,m.destinationBroker].map(x=>x.toLowerCase())).size===3,'MIGRATION_CODE_PATH_REJECTED');
  requireValue(Number.isSafeInteger(m.sourceUid)&&m.sourceUid>0&&m.sourceUid<=2147483647,'MIGRATION_UID_REJECTED');
  requireValue(Number.isSafeInteger(m.payloadLength)&&m.payloadLength>4&&m.payloadLength<=1024*1024,'MIGRATION_PAYLOAD_BOUND');
  requireValue(m.pointerFileName==='active-registration.json'&&(m.pointerExpectedSHA256==='absent'||typeof m.pointerExpectedSHA256==='string'&&SHA.test(m.pointerExpectedSHA256)),'MIGRATION_POINTER_REJECTED');
  return m;
}
function validateRun(run,m,{now=Math.floor(Date.now()/1000)}={}){
  fields(run,RUN_FIELDS);
  requireValue(run.protocol===1&&run.op==='run-r2-synthetic-v1'&&run.sequence===1&&run.case==='isolation-v1'&&run.runtimeSeconds===60,'R2_OPERATION_REJECTED');
  requireValue(typeof run.nonce==='string'&&SHA.test(run.nonce)&&run.nonce!=='0'.repeat(64),'R2_NONCE_REJECTED');
  requireValue(run.catalogSHA256===m.catalogSHA256&&run.uid===m.sourceUid,'R2_BINDING_CHANGED');
  requireValue(typeof run.bootId==='string'&&run.bootId.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(run.bootId)&&run.bootId!=='00000000-0000-0000-0000-000000000000','R2_BOOT_ID_REJECTED');
  requireValue(Number.isSafeInteger(run.expiresAtUnixSeconds)&&run.expiresAtUnixSeconds>now&&run.expiresAtUnixSeconds<=now+120&&run.expiresAtUnixSeconds<=2147483647,'R2_PERMIT_EXPIRED_OR_BOUND');
  return run;
}
function validateRecoveryGrant(grant,manifest,mode,{now=Math.floor(Date.now()/1000)}={}){
  fields(grant,RECOVERY_FIELDS);
  requireValue(grant.version===1&&grant.migrationId===manifest.migrationId&&grant.manifestSHA256===hash(Buffer.from(canonical(manifest)))&&['resume','rollback','recover-pointer'].includes(mode)&&grant.operation===mode,'RECOVERY_BINDING_REJECTED');
  requireValue(typeof grant.observedStateSHA256==='string'&&SHA.test(grant.observedStateSHA256),'RECOVERY_STATE_REJECTED');
  requireValue(Number.isSafeInteger(grant.issuedAt)&&Number.isSafeInteger(grant.expiresAt)&&grant.issuedAt>0&&grant.issuedAt<=now&&grant.expiresAt>now&&grant.expiresAt<=2147483647&&grant.expiresAt-grant.issuedAt<=1800,'RECOVERY_WINDOW_REJECTED');
  return grant;
}
function environment(){const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];return env;}
function catalogSource(boot){
  requireValue(boot&&typeof boot.command==='string'&&Buffer.byteLength(boot.command)<=1024&&!/[\r\n\0]/.test(boot.command)&&Buffer.isBuffer(boot.payload),'R2_BUILD_CATALOG_REJECTED');
  requireValue(typeof boot.catalogSHA256==='string'&&SHA.test(boot.catalogSHA256),'R2_BUILD_CATALOG_REJECTED');
  return 'public static class HubSshMaintenanceCatalog {\n'+
    ' public const string Command = '+JSON.stringify(boot.command)+';\n'+
    ' public const string Operation = "run-r2-synthetic-v1";\n'+
    ' public const string PayloadSHA256 = "'+hash(boot.payload)+'";\n'+
    ' public const string CatalogSHA256 = "'+boot.catalogSHA256+'";\n'+
    ' public const string PayloadBase64 = "'+boot.payload.toString('base64')+'";\n'+
    ' public const int PayloadLength = '+boot.payload.length+';\n'+
    ' public const int RunDeadlineMs = 180000;\n}\n';
}
function ensure({fixture=false}={}){
  requireValue(process.platform==='win32'&&process.arch==='x64','UNSUPPORTED_PLATFORM');
  const boot=require('./worker-r2-bootstrap').buildR2Bootstrap();
  const generated=catalogSource(boot),files=SOURCE_NAMES.map(n=>path.join(__dirname,'../windows',n));
  const sourceHash=hash(Buffer.concat([Buffer.from(fixture?'maintenance-fixture-v1':'maintenance-production-v1'),Buffer.from(generated),...files.flatMap(f=>[Buffer.from(path.basename(f)+'\0'),fs.readFileSync(f)])]));
  const dir=path.join(__dirname,'../.runtime');fs.mkdirSync(dir,{recursive:true});
  const generatedFile=path.join(dir,'ssh-maintenance-catalog-'+sourceHash+'.cs');
  if(!fs.existsSync(generatedFile))fs.writeFileSync(generatedFile,generated,{flag:'wx'});
  requireValue(fs.readFileSync(generatedFile,'utf8')===generated,'MAINTENANCE_CATALOG_CACHE_CHANGED');
  const result={sourceHash,catalog:{command:boot.command,catalogSHA256:boot.catalogSHA256,payloadSHA256:hash(boot.payload),payloadLength:boot.payload.length}};
  for(const [kind,entry]of [['helper','HubSshMaintenanceEntry'],['broker','HubSshMaintenanceBrokerEntry']]){
    const file=path.join(dir,'ssh-maintenance-'+kind+'-'+sourceHash+'.exe'),receipt=file+'.build.json';
    if(!fs.existsSync(file)){
      const temp=path.join(dir,'ssh-maintenance-'+crypto.randomUUID()+'.exe');
      try{
        cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/main:'+entry,...(fixture?['/define:HUB_SSH_MAINTENANCE_TEST']:[]),'/out:'+temp,...files,generatedFile],{env:environment(),windowsHide:true,timeout:30000,stdio:'pipe'});
        fs.renameSync(temp,file);fs.writeFileSync(receipt,canonical({sourceHash,binarySHA256:hash(fs.readFileSync(file)),entry,catalogSHA256:boot.catalogSHA256}),{flag:'wx'});
      }catch(e){fs.rmSync(temp,{force:true});const error=failure('MAINTENANCE_COMPILATION_FAILED');error.diagnostics=String(e.stdout||'').slice(0,24000);throw error;}
    }
    const actual=hash(fs.readFileSync(file));let saved;try{saved=JSON.parse(fs.readFileSync(receipt,'utf8'));}catch{throw failure('MAINTENANCE_BUILD_RECEIPT_MISSING');}
    requireValue(canonical(saved)===canonical({sourceHash,binarySHA256:actual,entry,catalogSHA256:boot.catalogSHA256}),'MAINTENANCE_BUILD_CACHE_CHANGED');
    result[kind]={file,sha256:actual};
  }
  return result;
}
function buildRequest(kind,mode,manifest,options={}){
  requireValue(kind==='helper'||kind==='broker','MAINTENANCE_ENTRY_REJECTED');
  const modes=kind==='helper'?['migrate','resume','rollback','recover-pointer','status',...(options.fixture===true?['fixture-inspect','fixture-cleanup']:[])]:['status','probe','run-r2-synthetic-v1'];
  requireValue(modes.includes(mode),'MAINTENANCE_MODE_REJECTED');
  // The migration grant expires; an already activated registration continues
  // to use its fixed broker/catalog. Each execution has its own fresh permit.
  validateManifest(manifest,{allowExpired:kind==='broker'||mode==='status'||options.recoveryGrant!==undefined||options.fixture===true&&['fixture-inspect','fixture-cleanup'].includes(mode)});
  const request={mode,manifest};
  requireValue(mode!=='recover-pointer'||options.recoveryGrant!==undefined,'RECOVERY_GRANT_REQUIRED');
  if(options.recoveryGrant!==undefined){requireValue(kind==='helper','RECOVERY_MODE_REJECTED');request.recoveryGrant=validateRecoveryGrant(options.recoveryGrant,manifest,mode);}
  if(mode==='run-r2-synthetic-v1')request.runRequest=validateRun(options.runRequest,manifest);
  if(options.faultAt!==undefined){requireValue(options.fixture===true&&typeof options.faultAt==='string'&&options.faultAt.length<=64&&/^AFTER_[A-Z0-9_]+$/.test(options.faultAt),'MAINTENANCE_FIXTURE_REJECTED');request.faultAt=options.faultAt;}
  return request;
}
function launch(kind,mode,manifest,options={}){
  const request=buildRequest(kind,mode,manifest,options),build=ensure({fixture:options.fixture===true});
  requireValue(manifest.helper===build.helper.file&&manifest.helperSHA256===build.helper.sha256&&manifest.destinationBroker===build.broker.file&&manifest.destinationDescriptor.brokerSHA256===build.broker.sha256,'MAINTENANCE_BUILD_BINDING_CHANGED');
  for(const key of ['catalogSHA256','payloadSHA256','payloadLength'])requireValue(manifest[key]===build.catalog[key],'MAINTENANCE_CATALOG_BINDING_CHANGED');
  requireValue(manifest.destinationDescriptor.stageCommand===build.catalog.command,'MAINTENANCE_COMMAND_BINDING_CHANGED');
  const encoded=Buffer.from(canonical(request)).toString('base64');requireValue(encoded.length<=28000,'MAINTENANCE_REQUEST_BOUND');
  const child=managed.spawn(build[kind].file,[],{cwd:path.join(__dirname,'..'),env:{...environment(),HUB_SSH_MAINTENANCE_REQUEST:encoded},stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stdin.end();return child;
}
function invoke(kind,mode,manifest,options={}){
  requireValue(mode!=='run-r2-synthetic-v1','MAINTENANCE_STREAM_REQUIRED');
  requireValue(options.onEvent===undefined||typeof options.onEvent==='function','MAINTENANCE_EVENT_CALLBACK_REJECTED');
  return new Promise((resolve,reject)=>{
    let child;try{child=launch(kind,mode,manifest,options);}catch(e){reject(e);return;}
    let stdout=Buffer.alloc(0),stderr='',stderrBytes=0,errorCode=null,settled=false,stopTimer;const events=[];
    const finish=(exitCode,closed)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(stopTimer);let result;try{result=JSON.parse(stdout.toString('utf8'));}catch{}
      if(errorCode||exitCode!==0||result?.ok!==true){const e=failure(errorCode||(typeof result?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(result.code)?result.code:'MAINTENANCE_OPERATION_FAILED'));e.events=events;e.childCloseObserved=closed;reject(e);}else resolve({...result,events});};
    const fail=code=>{if(errorCode||settled)return;errorCode=code;stopTimer=setTimeout(()=>finish(null,false),5000);try{child.kill();}catch{}};
    const timer=setTimeout(()=>fail('MAINTENANCE_OPERATION_TIMEOUT'),mode==='status'?30000:240000);
    child.stdout.on('data',b=>{if(stdout.length+b.length>16384){fail('MAINTENANCE_OUTPUT_BOUND');return;}stdout=Buffer.concat([stdout,b]);});
    child.stderr.on('data',b=>{stderrBytes+=b.length;stderr+=b.toString('ascii');if(stderrBytes>16384){fail('MAINTENANCE_DIAGNOSTIC_BOUND');return;}let at;while((at=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,at).replace(/\r$/,'');stderr=stderr.slice(at+1);const match=line.match(/^HUB_MAINTENANCE_EVENT:([A-Z0-9_:.-]{1,100})$/);if(match&&EVENTS.has(match[1])){if(events.length>=128){fail('MAINTENANCE_EVENT_BOUND');return;}events.push(match[1]);if(options.onEvent)try{const returned=options.onEvent(match[1]);if(returned&&typeof returned.then==='function'){Promise.resolve(returned).catch(()=>{});fail('MAINTENANCE_EVENT_CALLBACK_FAILED');}}catch{fail('MAINTENANCE_EVENT_CALLBACK_FAILED');}}}});
    child.once('error',()=>fail('MAINTENANCE_PROCESS_FAILED'));child.once('close',code=>finish(code,true));
  });
}
function readManifest(file){const bytes=fs.readFileSync(file);requireValue(bytes.length<=20000,'MAINTENANCE_REQUEST_BOUND');const value=JSON.parse(canonical(decode(bytes)));return validateManifest(value,{allowExpired:true});}
module.exports={REVIEW,MANIFEST_FIELDS,RUN_FIELDS,RECOVERY_FIELDS,SOURCE_NAMES,canonical,hash,absolute,validateManifest,validateRun,validateRecoveryGrant,catalogSource,ensure,buildRequest,launch,invoke,readManifest,
  invokeHelper:(mode,m,options)=>invoke('helper',mode,m,options),invokeBroker:(mode,m,options)=>invoke('broker',mode,m,options)};
