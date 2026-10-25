'use strict';
// No credential bytes enter this module. Native CredUI/vault/ASKPASS own secrets.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const managed=require('./managed-process'),scoped=require('./scoped-file');
const SOURCE_NAMES=['ssh-vault-broker.cs','ssh-vault-store.cs','ssh-vault-transport.cs','pinned-root.cs','ssh-vault-enrollment.cs'];
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEYS=['version','registrationId','root','rootFingerprint','ownerSid','host','port','user','hostKey','hostFingerprint','ssh','sshSHA256','brokerSHA256','stageCommand','stageCommandSHA256'];
const active=new Map();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const error=code=>Object.assign(Error(code),{code});
function requireValue(v,code){if(!v)throw error(code);}
function canonical(x){if(x&&typeof x==='object'&&!Array.isArray(x))return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';requireValue(typeof x==='string'||typeof x==='boolean'||Number.isSafeInteger(x)||x===null,'JSON_TYPE_REJECTED');return JSON.stringify(x);}
function absolute(p){return typeof p==='string'&&/^[A-Za-z]:\\/.test(p)&&p.length<240&&!/[\0\r\n]/.test(p)&&path.win32.normalize(p)===p&&!p.endsWith('\\')&&!p.slice(3).split('\\').some(x=>!x||x.endsWith('.')||x.endsWith(' ')||x.includes(':'));}
function validate(d){
  requireValue(d&&Object.getPrototypeOf(d)===Object.prototype&&Object.keys(d).length===KEYS.length&&KEYS.every(k=>Object.hasOwn(d,k)),'FIELDS_REJECTED');
  requireValue(d.version===1&&typeof d.registrationId==='string'&&UUID.test(d.registrationId),'ID_REJECTED');
  requireValue(absolute(d.root)&&absolute(d.ssh),'PATH_REJECTED');
  requireValue(typeof d.ownerSid==='string'&&/^S-1-[0-9-]{1,178}$/.test(d.ownerSid),'OWNER_REJECTED');
  for(const k of ['rootFingerprint','sshSHA256','brokerSHA256','stageCommandSHA256'])requireValue(typeof d[k]==='string'&&SHA.test(d[k]),'DIGEST_REJECTED');
  requireValue(typeof d.host==='string'&&/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(d.host)&&d.host.split('.').every(x=>Number(x)<=255),'HOST_REJECTED');
  requireValue(Number.isSafeInteger(d.port)&&d.port>=1&&d.port<=65535&&typeof d.user==='string'&&/^[a-z_][a-z0-9_-]{0,31}$/.test(d.user),'ACCOUNT_REJECTED');
  const key=typeof d.hostKey==='string'?Buffer.from(d.hostKey,'base64'):Buffer.alloc(0);
  requireValue(key.length===51&&key.toString('base64')===d.hostKey&&key.subarray(0,19).toString('hex')==='0000000b7373682d6564323535313900000020','HOST_KEY_REJECTED');
  requireValue(d.hostFingerprint==='SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,''),'HOST_PIN_CHANGED');
  requireValue(typeof d.stageCommand==='string'&&Buffer.byteLength(d.stageCommand)>0&&Buffer.byteLength(d.stageCommand)<=1024&&!/[\0\r\n]/.test(d.stageCommand)&&d.stageCommand.isWellFormed()&&hash(Buffer.from(d.stageCommand))===d.stageCommandSHA256,'STAGE_COMMAND_REJECTED');
  return d;
}
function environment(){const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];return env;}
function ensure({fixture=false}={}){
  requireValue(process.platform==='win32'&&process.arch==='x64','UNSUPPORTED_PLATFORM');
  const files=SOURCE_NAMES.map(n=>path.join(__dirname,'../windows',n));
  const sourceHash=hash(Buffer.concat([Buffer.from(fixture?'fixture-v2':'production-v2'),...files.map(f=>fs.readFileSync(f))]));
  const dir=path.join(__dirname,'../.runtime');fs.mkdirSync(dir,{recursive:true});
  const target=path.join(dir,'ssh-vault-'+sourceHash+'.exe');
  if(!fs.existsSync(target)){
    const temp=path.join(dir,'ssh-vault-'+crypto.randomUUID()+'.exe');
    try{cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',...(fixture?['/define:HUB_SSH_VAULT_TEST']:[]),'/out:'+temp,...files],{env:environment(),windowsHide:true,timeout:30000,stdio:'pipe'});fs.renameSync(temp,target);fs.writeFileSync(target+'.build.json',JSON.stringify({sourceHash,binarySHA256:hash(fs.readFileSync(target))}),{flag:'wx'});}
    catch(e){fs.rmSync(temp,{force:true});const failure=error('BROKER_COMPILATION_FAILED');failure.diagnostics=String(e.stdout||'').slice(0,16000);throw failure;}
  }
  const actual=hash(fs.readFileSync(target));let build;try{build=JSON.parse(fs.readFileSync(target+'.build.json','utf8'));}catch{throw error('BROKER_BUILD_RECEIPT_MISSING');}
  requireValue(build&&Object.keys(build).sort().join(',')==='binarySHA256,sourceHash'&&build.sourceHash===sourceHash&&build.binarySHA256===actual,'BROKER_CACHE_CHANGED');
  return {file:target,sha256:actual,sourceHash};
}
function launch(request,{fixture=false}={}){
  const broker=ensure({fixture});
  if(request.descriptor){validate(request.descriptor);requireValue(request.descriptor.brokerSHA256===broker.sha256,'BROKER_BINDING_CHANGED');}
  const text=canonical(request);requireValue(Buffer.byteLength(text)<=24000,'REQUEST_BOUND_REJECTED');
  const child=managed.spawn(broker.file,[],{cwd:path.join(__dirname,'..'),env:{...environment(),HUB_SSH_VAULT_REQUEST:Buffer.from(text).toString('base64')},stdio:['pipe','pipe','pipe'],windowsHide:true});
  if(request.descriptor){const binding=canonical(request.descriptor);let group=active.get(binding);if(!group)active.set(binding,group=new Set());group.add(child);child.once('close',()=>{group.delete(child);if(!group.size)active.delete(binding);});}
  return child;
}
function invoke(request,options={}){
  return new Promise((resolve,reject)=>{
    if(options.onEvent!==undefined&&typeof options.onEvent!=='function'){reject(error('VAULT_EVENT_CALLBACK_REJECTED'));return;}
    let child;try{child=launch(request,options);}catch(e){reject(e);return;}
    // This is the only diagnostic surface exposed to JavaScript callers. Never
    // forward raw stderr or arbitrary uppercase strings as credential events.
    const allowed=new Set(['ENROLLMENT_READY','ENROLLMENT_REQUESTED','PROMPT_REQUESTED','PROMPT_CANCELLED','PROMPT_RETURNED','PROMPT_UNPACKED','SUBMITTED','IDENTITY_VERIFIED','PREPARE_CREATED','PREPARE_ACL_VERIFIED','STORED','STAGE_SSH_EXIT_0','ASKPASS_SUPPLIED','ASKPASS_REJECTED','SSH_HOST_PIN_MATCHED','SSH_PASSWORD_AUTHENTICATED','SSH_PERMISSION_DENIED','SSH_INPUT_FAILED','SSH_OUTPUT_FAILED','SSH_DIAGNOSTIC_REJECTED','SSH_DEADLINE']);
    let out='',pending='',stderrBytes=0,failure=null,settled=false,stopTimer,timer,enrollmentReady=false,enrollmentStarted=false;const events=[];
    const finish=(code,childCloseObserved)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(stopTimer);
      let result;try{result=JSON.parse(out);}catch{}
      if(failure||code!==0||result?.ok!==true){const e=error(failure||(typeof result?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(result.code)?result.code:'VAULT_OPERATION_FAILED'));e.events=events.slice();e.childCloseObserved=childCloseObserved;reject(e);}
      else resolve({...result,events:events.slice()});
    };
    const fail=code=>{
      if(failure||settled)return;failure=code;
      // Preserve the original failure even if a late success result arrives.
      // A missing close event must not leave enrollment pending indefinitely.
      stopTimer=setTimeout(()=>finish(null,false),5000);
      try{child.kill();}catch{}
    };
    const line=value=>{
      const match=value.match(/^HUB_VAULT_EVENT:([A-Z0-9_:]{1,64})\r?$/);if(!match)return;
      const event=match[1],pid=event.match(/^SSH_PID:([1-9][0-9]{0,9})$/);
      if(!allowed.has(event)&&!(pid&&Number(pid[1])<=0xffffffff))return;
      if(event==='ENROLLMENT_READY'||event==='ENROLLMENT_REQUESTED'){
        if(request.mode!=='enroll'||event==='ENROLLMENT_READY'&&(enrollmentReady||enrollmentStarted)||event==='ENROLLMENT_REQUESTED'&&(!enrollmentReady||enrollmentStarted)){fail('VAULT_ENROLLMENT_ORDER_REJECTED');return;}
        if(event==='ENROLLMENT_READY')enrollmentReady=true;
        else {enrollmentStarted=true;clearTimeout(timer);timer=setTimeout(()=>fail('VAULT_OPERATION_TIMEOUT'),300000);}
      }
      if(request.mode==='enroll'&&event==='PROMPT_REQUESTED'&&!enrollmentStarted){fail('VAULT_ENROLLMENT_ORDER_REJECTED');return;}
      if(events.length>=64){fail('VAULT_EVENT_LIMIT');return;}
      events.push(event);
      if(options.onEvent)try{const returned=options.onEvent(event);if(returned&&typeof returned.then==='function'){Promise.resolve(returned).catch(()=>{});fail('VAULT_EVENT_CALLBACK_FAILED');}}catch{fail('VAULT_EVENT_CALLBACK_FAILED');}
    };
    // Waiting for the explicit Start button has its own non-secret idle period.
    // Only the first valid Start event arms the bounded credential operation.
    timer=setTimeout(()=>fail(request.mode==='enroll'?'VAULT_ENROLLMENT_IDLE_TIMEOUT':'VAULT_OPERATION_TIMEOUT'),request.mode==='enroll'?900000:60000);
    child.stdout.on('data',x=>{if(failure||settled)return;if(Buffer.byteLength(out)+Buffer.byteLength(x)>8192){fail('VAULT_OUTPUT_LIMIT');return;}out+=x;});
    child.stderr.on('data',x=>{
      if(failure||settled)return;stderrBytes+=Buffer.byteLength(x);
      if(stderrBytes>8192){fail('VAULT_DIAGNOSTIC_LIMIT');return;}
      // ASCII allowlisted records only; decoding diagnostic Unicode is neither
      // necessary nor useful. The unfinished line is separately bounded.
      pending+=x.toString();let index;
      while(!failure&&!settled&&(index=pending.indexOf('\n'))!==-1){const value=pending.slice(0,index);pending=pending.slice(index+1);if(Buffer.byteLength(value)>256){fail('VAULT_DIAGNOSTIC_LINE_LIMIT');break;}line(value);}
      if(Buffer.byteLength(pending)>256)fail('VAULT_DIAGNOSTIC_LINE_LIMIT');
    });
    child.on('error',()=>fail('VAULT_PROCESS_FAILED'));
    child.once('close',code=>{if(!failure&&!settled&&pending)line(pending);finish(code,true);});
    try{child.stdin.end();}catch{fail('VAULT_PROCESS_FAILED');}
  });
}
async function prepare({parentRoot,leaf}){
  requireValue(absolute(parentRoot)&&/^[a-zA-Z0-9-]{1,50}$/.test(leaf),'ROOT_REJECTED');
  const {rootFingerprint}=await scoped.identity(parentRoot);
  return invoke({mode:'prepare',parentRoot,parentFingerprint:rootFingerprint,leaf});
}
function descriptor(config,prepared,{fixture=false}={}){
  const broker=ensure({fixture});return validate({version:1,registrationId:crypto.randomUUID(),root:prepared.root,rootFingerprint:prepared.rootFingerprint,ownerSid:prepared.ownerSid,...config,sshSHA256:hash(fs.readFileSync(config.ssh)),brokerSHA256:broker.sha256,stageCommandSHA256:hash(Buffer.from(config.stageCommand))});
}
async function operation(mode,d,options){
  requireValue(['enroll','probe','status','forget'].includes(mode)||mode==='enroll-fixture'&&options?.fixture===true,'MODE_REJECTED');validate(d);
  if(mode==='forget')await Promise.all([...active.get(canonical(d))||[]].map(child=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(error('CONNECTION_STOP_UNVERIFIED')),10000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();})));
  return invoke({mode,descriptor:d},options);
}
function stage(d){validate(d);return launch({mode:'stage',descriptor:d});}
module.exports={validate,canonical,ensure,prepare,descriptor,operation,stage};
