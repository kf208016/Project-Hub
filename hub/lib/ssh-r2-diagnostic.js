'use strict';
// This controller handles only nonsecret identities. Credential bytes stay native.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const managed=require('./managed-process'),maintenance=require('./ssh-vault-maintenance');
const {decode,canonical}=require('./worker-channel');
const {buildR2InspectBootstrap,validateBinding}=require('./worker-r2-inspect-bootstrap');
const REVIEW='docs/superpowers/specs/2026-10-15-r2-readonly-diagnostic-design.md';
const OPERATION='inspect-r2-run-v1',SHA=/^[a-f0-9]{64}$(?![\s\S])/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const SOURCE_NAMES=Object.freeze(['ssh-r2-diagnostic-json.cs','ssh-r2-diagnostic-state.cs','ssh-r2-diagnostic-store.cs','ssh-r2-diagnostic-entry.cs','ssh-r2-diagnostic-transport.cs','ssh-maintenance-common.cs','pinned-root.cs']);
const CAPSULE_FIELDS=Object.freeze(['ManifestReference','ManifestSHA256','DestinationBindingSHA256','RunNonce','OriginalCatalogSHA256','RunPermitSHA256','ReviewReference','ReviewDocumentReference','ReviewDocumentSHA256','FailureEvidenceReference','FailureEvidenceSHA256','GrantRoot','GrantRootFingerprint','Uid','BootId']);
const GRANT_FIELDS=Object.freeze(['schemaVersion','grantId','issuedAt','expiresAt','operation','reviewReference','reviewDocumentSHA256','manifestReference','manifestSHA256','destinationBindingSHA256','registrationReceiptSHA256','activationReceiptSHA256','pointerSHA256','runReceiptSHA256','runPermitSHA256','originalCatalogSHA256','helperSHA256','sourceSetSHA256','diagnosticCatalogSHA256','diagnosticPayloadSHA256','diagnosticPayloadLength','failureEvidenceSHA256','runNonce','uid','bootId','grantRoot','grantRootFingerprint','maxSessions','deadlineSeconds','maxOutputBytes']);
const EVENTS=new Set(['ADMISSION_VERIFIED','GRANT_CONSUMED','DIAGNOSTIC_RESULT_VALIDATED','ASKPASS_SUPPLIED','ASKPASS_REJECTED','SSH_HOST_PIN_MATCHED','SSH_PASSWORD_AUTHENTICATED','SSH_PERMISSION_DENIED','SSH_INPUT_FAILED','SSH_OUTPUT_FAILED','SSH_DIAGNOSTIC_REJECTED','SSH_DEADLINE']);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const failure=code=>Object.assign(Error(code),{code});
function check(yes,code){if(!yes)throw failure(code);}
function fields(value,names){check(value&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)),'R2_DIAGNOSTIC_FIELDS');}
function validateCapsule(c){
  fields(c,CAPSULE_FIELDS);
  for(const k of ['ManifestReference','ReviewDocumentReference','FailureEvidenceReference','GrantRoot'])check(maintenance.absolute(c[k]),'R2_DIAGNOSTIC_PATH');
  for(const k of ['ManifestSHA256','DestinationBindingSHA256','RunNonce','OriginalCatalogSHA256','RunPermitSHA256','ReviewDocumentSHA256','FailureEvidenceSHA256','GrantRootFingerprint'])check(typeof c[k]==='string'&&SHA.test(c[k]),'R2_DIAGNOSTIC_DIGEST');
  check(c.ReviewReference===REVIEW,'R2_DIAGNOSTIC_REVIEW');
  validateBinding({nonce:c.RunNonce,originalCatalogSHA256:c.OriginalCatalogSHA256,uid:c.Uid,bootId:c.BootId,runPermitSHA256:c.RunPermitSHA256});
  return c;
}
function validateGrant(g,{now=Math.floor(Date.now()/1000)}={}){
  fields(g,GRANT_FIELDS);
  check(g.schemaVersion===1&&g.operation===OPERATION&&g.reviewReference===REVIEW&&typeof g.grantId==='string'&&UUID.test(g.grantId),'R2_DIAGNOSTIC_OPERATION');
  check(Number.isSafeInteger(now)&&Number.isSafeInteger(g.issuedAt)&&Number.isSafeInteger(g.expiresAt)&&g.issuedAt>0&&g.issuedAt<=now&&g.expiresAt>now&&g.expiresAt<=2147483647&&g.expiresAt-g.issuedAt<=600,'R2_DIAGNOSTIC_WINDOW');
  for(const k of GRANT_FIELDS.filter(k=>k.endsWith('SHA256')||k==='runNonce'||k==='grantRootFingerprint'))check(typeof g[k]==='string'&&SHA.test(g[k]),'R2_DIAGNOSTIC_DIGEST');
  check(g.runNonce!=='0'.repeat(64),'R2_DIAGNOSTIC_NONCE');
  for(const k of ['manifestReference','grantRoot'])check(maintenance.absolute(g[k]),'R2_DIAGNOSTIC_PATH');
  check(g.maxSessions===1&&g.deadlineSeconds===45&&g.maxOutputBytes===131072,'R2_DIAGNOSTIC_LIMITS');
  check(Number.isSafeInteger(g.diagnosticPayloadLength)&&g.diagnosticPayloadLength>4&&g.diagnosticPayloadLength<=131076,'R2_DIAGNOSTIC_PAYLOAD_BOUND');
  validateBinding({nonce:g.runNonce,originalCatalogSHA256:g.originalCatalogSHA256,uid:g.uid,bootId:g.bootId,runPermitSHA256:g.runPermitSHA256});
  return g;
}
function catalogSource(boot){
  check(boot.operation===OPERATION&&typeof boot.command==='string'&&Buffer.byteLength(boot.command)<=1024&&!/[\r\n\0]/.test(boot.command)&&Buffer.isBuffer(boot.payload),'R2_DIAGNOSTIC_CATALOG');
  return 'public static class HubSshR2DiagnosticCatalog {\n'+
    ' public const string Command = '+JSON.stringify(boot.command)+';\n'+
    ' public const string Operation = "'+OPERATION+'";\n'+
    ' public const string PayloadSHA256 = "'+hash(boot.payload)+'";\n'+
    ' public const string CatalogSHA256 = "'+boot.catalogSHA256+'";\n'+
    ' public const string PayloadBase64 = "'+boot.payload.toString('base64')+'";\n'+
    ' public const int PayloadLength = '+boot.payload.length+';\n'+
    ' public const int DeadlineMs = 45000;\n}\n';
}
function environment(){const env={};for(const k of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k];return env;}
function ensure({capsule,fixture=false}={}){
  check(process.platform==='win32'&&process.arch==='x64','UNSUPPORTED_PLATFORM');validateCapsule(capsule);
  check(typeof fixture==='boolean','R2_DIAGNOSTIC_FIXTURE');
  const boot=buildR2InspectBootstrap({binding:{nonce:capsule.RunNonce,originalCatalogSHA256:capsule.OriginalCatalogSHA256,uid:capsule.Uid,bootId:capsule.BootId,runPermitSHA256:capsule.RunPermitSHA256}});
  const generatedCatalog=catalogSource(boot),files=SOURCE_NAMES.map(n=>path.join(__dirname,'../windows',n));
  if(fixture)files.push(path.join(__dirname,'../test/helpers/ssh-r2-diagnostic-fixture.cs'));
  const snapshots=files.map(file=>({file,bytes:fs.readFileSync(file)}));
  const sourceHash=hash(Buffer.concat([Buffer.from(fixture?'r2-diagnostic-fixture-v1':'r2-diagnostic-production-v1'),Buffer.from(canonical(capsule)),Buffer.from(generatedCatalog),...snapshots.flatMap(row=>[Buffer.from(path.basename(row.file)+'\0'),row.bytes])]));
  const dir=path.join(__dirname,'../.runtime');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'ssh-r2-diagnostic-'+sourceHash+'.exe'),receipt=file+'.build.json';
  const constants={...capsule,HelperPath:file,SourceSetSHA256:sourceHash};
  const generated='public static class HubSshR2DiagnosticCapsule {\n'+Object.keys(constants).sort().map(k=>' public const '+(typeof constants[k]==='number'?'int':'string')+' '+k+' = '+JSON.stringify(constants[k])+';').join('\n')+'\n}\n'+generatedCatalog;
  const generatedFile=path.join(dir,'ssh-r2-diagnostic-capsule-'+sourceHash+'.cs');
  if(!fs.existsSync(generatedFile))fs.writeFileSync(generatedFile,generated,{flag:'wx'});
  check(fs.readFileSync(generatedFile,'utf8')===generated,'R2_DIAGNOSTIC_GENERATED_CHANGED');
  if(!fs.existsSync(file)){
    const temp=path.join(dir,'ssh-r2-diagnostic-'+crypto.randomUUID()+'.exe');
    try{
      cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/main:HubSshR2DiagnosticEntry',...(fixture?['/define:HUB_SSH_R2_DIAGNOSTIC_TEST']:[]),'/out:'+temp,...files,generatedFile],{env:environment(),windowsHide:true,timeout:30000,stdio:'pipe'});
      for(const row of snapshots)check(hash(fs.readFileSync(row.file))===hash(row.bytes),'R2_DIAGNOSTIC_SOURCE_CHANGED');
      check(fs.readFileSync(generatedFile,'utf8')===generated,'R2_DIAGNOSTIC_GENERATED_CHANGED');
      fs.renameSync(temp,file);
      fs.writeFileSync(receipt,canonical({sourceHash,binarySHA256:hash(fs.readFileSync(file)),generatedSHA256:hash(Buffer.from(generated)),catalogSHA256:boot.catalogSHA256,entry:'HubSshR2DiagnosticEntry'}),{flag:'wx'});
    }catch(e){fs.rmSync(temp,{force:true});if(e.code?.startsWith('R2_'))throw e;const error=failure('R2_DIAGNOSTIC_COMPILATION_FAILED');error.diagnostics=String(e.stdout||'').slice(0,24000);throw error;}
  }
  const actual=hash(fs.readFileSync(file));let saved;try{saved=decode(fs.readFileSync(receipt));}catch{throw failure('R2_DIAGNOSTIC_BUILD_RECEIPT');}
  check(canonical(saved)===canonical({sourceHash,binarySHA256:actual,generatedSHA256:hash(Buffer.from(generated)),catalogSHA256:boot.catalogSHA256,entry:'HubSshR2DiagnosticEntry'}),'R2_DIAGNOSTIC_BUILD_CHANGED');
  const result={sourceHash,file,sha256:actual,capsule:{...capsule},fixture,catalog:{command:boot.command,catalogSHA256:boot.catalogSHA256,payloadSHA256:boot.payloadSHA256,payloadLength:boot.payload.length}};
  if(fixture){
    const fixtureFile=path.join(dir,'ssh-r2-diagnostic-fixture-'+sourceHash+'.exe'),fixtureReceipt=fixtureFile+'.build.json';
    if(!fs.existsSync(fixtureFile)){
      const temp=path.join(dir,'ssh-r2-diagnostic-fixture-'+crypto.randomUUID()+'.exe');
      try{
        cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/main:HubSshR2DiagnosticFixture','/define:HUB_SSH_R2_DIAGNOSTIC_TEST','/out:'+temp,...files,generatedFile],{env:environment(),windowsHide:true,timeout:30000,stdio:'pipe'});
        for(const row of snapshots)check(hash(fs.readFileSync(row.file))===hash(row.bytes),'R2_DIAGNOSTIC_SOURCE_CHANGED');
        check(fs.readFileSync(generatedFile,'utf8')===generated,'R2_DIAGNOSTIC_GENERATED_CHANGED');
        fs.renameSync(temp,fixtureFile);fs.writeFileSync(fixtureReceipt,canonical({sourceHash,binarySHA256:hash(fs.readFileSync(fixtureFile)),entry:'HubSshR2DiagnosticFixture'}),{flag:'wx'});
      }catch(e){fs.rmSync(temp,{force:true});const error=failure('R2_DIAGNOSTIC_FIXTURE_COMPILATION_FAILED');error.diagnostics=String(e.stdout||'').slice(0,24000);throw error;}
    }
    const fixtureSHA256=hash(fs.readFileSync(fixtureFile));let savedFixture;try{savedFixture=decode(fs.readFileSync(fixtureReceipt));}catch{throw failure('R2_DIAGNOSTIC_FIXTURE_RECEIPT');}
    check(canonical(savedFixture)===canonical({sourceHash,binarySHA256:fixtureSHA256,entry:'HubSshR2DiagnosticFixture'}),'R2_DIAGNOSTIC_FIXTURE_CHANGED');
    result.fixtureHelper={file:fixtureFile,sha256:fixtureSHA256};
  }
  return result;
}
function buildRequest(grant,build,options={}){
  validateGrant(grant,options);validateCapsule(build.capsule);
  for(const [g,c]of [['manifestReference','ManifestReference'],['manifestSHA256','ManifestSHA256'],['destinationBindingSHA256','DestinationBindingSHA256'],['runNonce','RunNonce'],['originalCatalogSHA256','OriginalCatalogSHA256'],['runPermitSHA256','RunPermitSHA256'],['reviewReference','ReviewReference'],['reviewDocumentSHA256','ReviewDocumentSHA256'],['failureEvidenceSHA256','FailureEvidenceSHA256'],['grantRoot','GrantRoot'],['grantRootFingerprint','GrantRootFingerprint'],['uid','Uid'],['bootId','BootId']])check(grant[g]===build.capsule[c],'R2_DIAGNOSTIC_CAPSULE_CHANGED');
  check(grant.helperSHA256===build.sha256&&grant.sourceSetSHA256===build.sourceHash&&grant.diagnosticCatalogSHA256===build.catalog.catalogSHA256&&grant.diagnosticPayloadSHA256===build.catalog.payloadSHA256&&grant.diagnosticPayloadLength===build.catalog.payloadLength,'R2_DIAGNOSTIC_BUILD_BINDING');
  return {mode:OPERATION,grant};
}
function launch(build,grant,options={}){
  const request=buildRequest(grant,build,options);
  check(hash(fs.readFileSync(build.file))===build.sha256,'R2_DIAGNOSTIC_IMAGE_CHANGED');
  const encoded=Buffer.from(canonical(request)).toString('base64');check(encoded.length<=28000,'R2_DIAGNOSTIC_REQUEST_BOUND');
  const child=managed.spawn(build.file,[],{cwd:path.join(__dirname,'..'),env:{...environment(),HUB_SSH_R2_DIAGNOSTIC_REQUEST:encoded},stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdin.end();return child;
}
function invoke(build,grant,options={}){
  check(options.onEvent===undefined||typeof options.onEvent==='function','R2_DIAGNOSTIC_CALLBACK');
  return new Promise((resolve,reject)=>{
    let child;try{child=launch(build,grant,options);}catch(e){reject(e);return;}
    let bytes=Buffer.alloc(0),stderr='',stderrBytes=0,errorCode=null,settled=false,stopTimer;const events=[];
    const finish=(exit,closed)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(stopTimer);
      let result;try{result=decode(bytes);}catch{}
      if(errorCode||exit!==0||!result||result.ok!==true){const e=failure(errorCode||(typeof result?.code==='string'&&/^[A-Z0-9_]{1,100}$(?![\s\S])/.test(result.code)?result.code:'R2_DIAGNOSTIC_FAILED'));e.events=events;e.childCloseObserved=closed;reject(e);return;}
      try{fields(result,['ok','state','grantId','runNonce','diagnostic']);check(result.state==='diagnostic-result'&&result.grantId===grant.grantId&&result.runNonce===grant.runNonce,'R2_DIAGNOSTIC_RESULT_BINDING');require('./r2-inspect-result').validateResult(result.diagnostic,grant);resolve({...result,events,childCloseObserved:closed});}catch(e){e.events=events;e.childCloseObserved=closed;reject(e);}
    };
    const fail=code=>{if(errorCode||settled)return;errorCode=code;stopTimer=setTimeout(()=>finish(null,false),5000);try{child.kill();}catch{}};
    const timer=setTimeout(()=>fail('R2_DIAGNOSTIC_TIMEOUT'),50000);
    child.stdout.on('data',b=>{if(bytes.length+b.length>135168){fail('R2_DIAGNOSTIC_OUTPUT_BOUND');return;}bytes=Buffer.concat([bytes,b]);});
    child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>16384){fail('R2_DIAGNOSTIC_EVENT_BOUND');return;}stderr+=b.toString('ascii');let at;
      while((at=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,at).replace(/\r$/,'');stderr=stderr.slice(at+1);const match=line.match(/^HUB_R2_DIAGNOSTIC_EVENT:([A-Z0-9_]{1,100})$(?![\s\S])/);
        if(match&&EVENTS.has(match[1])){if(events.length>=64){fail('R2_DIAGNOSTIC_EVENT_BOUND');return;}events.push(match[1]);if(options.onEvent)try{const returned=options.onEvent(match[1]);if(returned&&typeof returned.then==='function'){Promise.resolve(returned).catch(()=>{});fail('R2_DIAGNOSTIC_CALLBACK_FAILED');}}catch{fail('R2_DIAGNOSTIC_CALLBACK_FAILED');}}
      }
    });
    child.once('error',()=>fail('R2_DIAGNOSTIC_PROCESS_FAILED'));child.once('close',code=>finish(code,true));
  });
}
module.exports={REVIEW,OPERATION,SOURCE_NAMES,CAPSULE_FIELDS,GRANT_FIELDS,hash,canonical,validateCapsule,validateGrant,catalogSource,ensure,buildRequest,launch,invoke};
