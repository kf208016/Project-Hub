'use strict';
// Explicit opt-in integration: fresh synthetic Credential Manager entries and
// loopback SSH only. No existing user descriptor or credential is read here.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const vault=require('../lib/ssh-password-vault');
const maintenance=require('../lib/ssh-vault-maintenance');
const enabled=process.platform==='win32'&&process.env.HUB_RUN_MAINTENANCE_NATIVE_TEST==='1';
const native=enabled?test:test.skip;
const PARENT=path.resolve(__dirname,'../../..');
const BOOT_ID='3d68605d-fc17-42f4-972b-40a18df72dbc';
const FAULTS=['AFTER_SOURCE_INTENT','AFTER_DESTINATION_INTENT','AFTER_INTENTS','AFTER_CREDENTIAL_WRITE','AFTER_PENDING_RECEIPT','AFTER_PROBE_1','AFTER_PROBE_2','AFTER_ACTIVATION_INTENT','AFTER_POINTER','AFTER_ACTIVATION_RECEIPT','AFTER_DELETE_INTENT','AFTER_SOURCE_DELETE','AFTER_TOMB','AFTER_COMPLETE'];

function conflict(descriptor,mode){
  const files=[path.join(__dirname,'helpers/ssh-maintenance-conflict-fixture.cs'),path.join(__dirname,'../windows/ssh-maintenance-common.cs'),path.join(__dirname,'../windows/ssh-vault-store.cs'),path.join(__dirname,'../windows/pinned-root.cs')];
  const identity=maintenance.hash(Buffer.concat(files.map(file=>fs.readFileSync(file))));
  const output=path.join(__dirname,'../.runtime/ssh-maintenance-conflict-'+identity+'.exe');
  if(!fs.existsSync(output))cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/out:'+output,...files],{windowsHide:true,timeout:30000,stdio:'pipe'});
  const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  env.HUB_MAINTENANCE_FIXTURE_REQUEST=Buffer.from(maintenance.canonical({mode,descriptor})).toString('base64');
  const result=JSON.parse(cp.execFileSync(output,[],{env,windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']}));noSecret(result);assert.equal(result.ok,true);return result;
}
function directNative(manifest,request,entry){
  const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  env.HUB_SSH_MAINTENANCE_REQUEST=Buffer.from(maintenance.canonical({...request,manifest})).toString('base64');
  const result=cp.spawnSync(entry,[],{env,windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);noSecret({stdout:result.stdout,stderr:result.stderr});
  if(request.mode==='run-r2-synthetic-v1')return {exit:result.status,stdout:result.stdout,stderr:result.stderr};
  return {exit:result.status,...JSON.parse(result.stdout)};
}
function directBroker(manifest,request){return directNative(manifest,request,manifest.destinationBroker);}
function fixtureCleanupOperation(manifest,mode){
  assert.ok(['fixture-cleanup','fixture-inspect'].includes(mode));assert.equal(manifest.sourceDescriptor.host,'127.0.0.1');assert.equal(manifest.sourceDescriptor.user,'fixture');assert.equal(manifest.destinationDescriptor.host,'127.0.0.1');assert.equal(manifest.destinationDescriptor.user,'fixture');
  assert.equal(maintenance.hash(fs.readFileSync(manifest.helper)),manifest.helperSHA256);
  const env={};for(const key of ['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  env.HUB_SSH_MAINTENANCE_REQUEST=Buffer.from(maintenance.canonical({mode,manifest})).toString('base64');
  // Retain this fixture's exact compiled helper even if a parallel developer
  // rebuilds current sources; cleanup never switches to a newly trusted binary.
  const result=cp.spawnSync(manifest.helper,[],{env,windowsHide:true,timeout:20000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(result.error,undefined);noSecret({stdout:result.stdout,stderr:result.stderr});
  const value=JSON.parse(result.stdout);assert.equal(result.status,0,value.code);assert.equal(value.ok,true);return value;
}
function recoveryGrant(f,operation,status){
  const now=Math.floor(Date.now()/1000);assert.match(status.observedStateSHA256,/^[a-f0-9]{64}$/);
  return {version:1,migrationId:f.manifest.migrationId,manifestSHA256:maintenance.hash(Buffer.from(maintenance.canonical(f.manifest))),observedStateSHA256:status.observedStateSHA256,issuedAt:now-1,expiresAt:now+120,operation};
}

function noSecret(value){
  const text=JSON.stringify(value);
  assert.doesNotMatch(text,/Hub fixture|密碼|🔐/);
  assert.doesNotMatch(text,/PROMPT_REQUESTED|ENROLLMENT_READY|ENROLLMENT_REQUESTED/);
}
function ownedRemove(root){
  assert.equal(path.dirname(root),PARENT);assert.match(path.basename(root),/^vault-maintenance-[a-f0-9]{12}-[sdp]$/);
  assert.equal(fs.realpathSync(root),root);
  function remove(directory){
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      const entry=path.join(directory,item.name);const actual=fs.lstatSync(entry);
      assert.equal(actual.isSymbolicLink(),false);assert.ok(entry.startsWith(root+path.sep));
      if(actual.isDirectory())remove(entry);else fs.unlinkSync(entry);
    }
    fs.rmdirSync(directory);
  }
  remove(root);
}
async function startServer(t,{wrongUid=false}={}){
  const server=cp.spawn('python',[path.join(__dirname,'fixtures/ssh-maintenance-server.py'),'--connections','16','--v2-uid',wrongUid?'1001':'1000'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const records=[];let stderr='',pending='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const timer=setTimeout(()=>readyReject(Error('Synthetic loopback fixture startup deadline')),10000);
  server.stdout.on('data',chunk=>{
    pending+=chunk;let at;
    while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const record=JSON.parse(line);if(record.port){clearTimeout(timer);readyResolve(record);}else records.push(record);}catch{readyReject(Error('Synthetic loopback fixture output rejected'));}}
  });
  server.stderr.on('data',chunk=>{stderr+=chunk;});server.once('error',readyReject);
  t.after(()=>{clearTimeout(timer);server.kill();});
  const config=await ready;
  return {config,records,get errors(){return stderr;}};
}
async function setup(t,options={}){
  // Compile before enrollment so a build failure cannot strand a credential.
  const build=maintenance.ensure({fixture:true}),oldBuild=vault.ensure({fixture:true});
  const server=await startServer(t,options),id=crypto.randomBytes(6).toString('hex');
  const roots=[];let manifest,source,enrolled=false,cleaned=false;
  t.after(async()=>{
    if(manifest){
      const cleanup=fixtureCleanupOperation(manifest,'fixture-cleanup');noSecret(cleanup);
      const remaining=fixtureCleanupOperation(manifest,'fixture-inspect');
      assert.equal(remaining.sourceExists,false);assert.equal(remaining.destinationExists,false);cleaned=true;
    }else if(enrolled){await vault.operation('forget',source,{fixture:true});cleaned=true;}
    else cleaned=true;
    if(cleaned)for(const root of roots.reverse())ownedRemove(root);
  });
  const sourceRoot=await vault.prepare({parentRoot:PARENT,leaf:'vault-maintenance-'+id+'-s'});roots.push(sourceRoot.root);
  const destinationRoot=await vault.prepare({parentRoot:PARENT,leaf:'vault-maintenance-'+id+'-d'});roots.push(destinationRoot.root);
  const pointerRoot=await vault.prepare({parentRoot:PARENT,leaf:'vault-maintenance-'+id+'-p'});roots.push(pointerRoot.root);
  const config={host:'127.0.0.1',port:server.config.port,user:'fixture',hostKey:server.config.publicKey,hostFingerprint:server.config.fingerprint,ssh:'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',stageCommand:'synthetic-source-stage-never-executed'};
  source=vault.descriptor(config,sourceRoot,{fixture:true});
  const enrolledResult=await vault.operation('enroll-fixture',source,{fixture:true});enrolled=true;
  assert.equal(enrolledResult.uid,1000);
  const destination={...source,registrationId:crypto.randomUUID(),root:destinationRoot.root,rootFingerprint:destinationRoot.rootFingerprint,brokerSHA256:build.broker.sha256,stageCommand:build.catalog.command,stageCommandSHA256:maintenance.hash(Buffer.from(build.catalog.command))};
  const now=Math.floor(Date.now()/1000);
  let pointerExpectedSHA256='absent';
  if(options.existingPointer){const bytes=Buffer.from(maintenance.canonical({version:1,binding:maintenance.hash(Buffer.from(maintenance.canonical(source))),descriptorRoot:source.root}));fs.writeFileSync(path.join(pointerRoot.root,'active-registration.json'),bytes,{flag:'wx'});pointerExpectedSHA256=maintenance.hash(bytes);}
  manifest={schemaVersion:1,migrationId:crypto.randomUUID(),issuedAt:now-2,expiresAt:now+(options.windowSeconds||3600),reviewReference:maintenance.REVIEW,sourceDescriptor:source,destinationDescriptor:destination,sourceReceiptSHA256:maintenance.hash(fs.readFileSync(path.join(source.root,'registration.bin'))),sourceUid:1000,sourceBroker:oldBuild.file,helper:build.helper.file,helperSHA256:build.helper.sha256,destinationBroker:build.broker.file,catalogSHA256:build.catalog.catalogSHA256,payloadSHA256:build.catalog.payloadSHA256,payloadLength:build.catalog.payloadLength,pointerRoot:pointerRoot.root,pointerRootFingerprint:pointerRoot.rootFingerprint,pointerExpectedSHA256,pointerFileName:'active-registration.json'};
  maintenance.validateManifest(manifest);
  const invoke=(mode,extra={})=>maintenance.invokeHelper(mode,manifest,{fixture:true,...extra});
  const broker=(mode,extra={})=>maintenance.invokeBroker(mode,manifest,{fixture:true,...extra});
  return {manifest,source,server,invoke,broker,inspect:()=>invoke('fixture-inspect')};
}

native('migration preserves native UTF-8 bytes, validates two new brokers and retires only source',{timeout:120000},async t=>{
  const f=await setup(t);const before=await f.inspect();assert.equal(before.sourceExists,true);assert.equal(before.destinationExists,false);
  // A separate synthetic registration must survive exact source retirement.
  const unrelatedRoot=await vault.prepare({parentRoot:PARENT,leaf:'vault-maintenance-'+crypto.randomBytes(6).toString('hex')+'-s'});
  const unrelated={...f.source,registrationId:crypto.randomUUID(),root:unrelatedRoot.root,rootFingerprint:unrelatedRoot.rootFingerprint};let unrelatedStored=false;
  t.after(async()=>{if(unrelatedStored)await vault.operation('forget',unrelated,{fixture:true});ownedRemove(unrelatedRoot.root);});
  await vault.operation('enroll-fixture',unrelated,{fixture:true});unrelatedStored=true;
  const migrated=await f.invoke('migrate');noSecret(migrated);assert.equal(migrated.state,'completed');
  const after=await f.inspect();noSecret(after);assert.equal(after.sourceExists,false);assert.equal(after.destinationExists,true);
  await assert.rejects(vault.operation('status',f.source,{fixture:true}),{code:'REGISTRATION_FORGOTTEN'});
  const probe=await f.broker('probe');noSecret(probe);assert.equal(probe.uid,1000);assert.equal(probe.bootId,BOOT_ID);
  const connections=f.server.records.length;
  const resumed=await f.invoke('resume');assert.equal(resumed.state,'completed');
  const status=await f.invoke('status');assert.equal(status.state,'completed');
  assert.equal(f.server.records.length,connections,'completed resume/status must not reconnect');
  assert.equal((await vault.operation('status',unrelated,{fixture:true})).state,'stored');
  assert.equal(f.server.errors,'');
});

native('each durable interruption recovers with the same manifest and no repeated enrollment',{timeout:600000},async t=>{
  for(const faultAt of FAULTS)await t.test(faultAt,{timeout:120000},async t=>{
    const f=await setup(t);
    await assert.rejects(f.invoke('migrate',{faultAt}),error=>{assert.match(error.code,/^(?:INJECTED_FAULT|FIXTURE_FAULT|FAULT_)/);noSecret({code:error.code,events:error.events});return true;});
    const state=await f.inspect();noSecret(state);
    const sourceDeleted=FAULTS.indexOf(faultAt)>=FAULTS.indexOf('AFTER_SOURCE_DELETE');
    assert.equal(state.sourceExists,!sourceDeleted);
    assert.equal(state.destinationExists,FAULTS.indexOf(faultAt)>=FAULTS.indexOf('AFTER_CREDENTIAL_WRITE'));
    if(FAULTS.indexOf(faultAt)<FAULTS.indexOf('AFTER_ACTIVATION_RECEIPT'))await assert.rejects(f.broker('probe'));
    const result=await f.invoke('resume');noSecret(result);assert.equal(result.state,'completed');
    const completed=await f.inspect();assert.equal(completed.sourceExists,false);assert.equal(completed.destinationExists,true);
    await assert.rejects(vault.operation('status',f.source,{fixture:true}),{code:'REGISTRATION_FORGOTTEN'});
    assert.equal(f.server.errors,'');
  });
});

native('changed remote UID leaves the original credential and pending destination intact',{timeout:120000},async t=>{
  const f=await setup(t,{wrongUid:true});
  await assert.rejects(f.invoke('migrate'),error=>{assert.equal(error.code,'VALIDATION_PROBE_REJECTED');noSecret({code:error.code,events:error.events});return true;});
  const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,true);
  assert.equal((await vault.operation('status',f.source,{fixture:true})).state,'stored');
  await assert.rejects(f.broker('probe'));
  assert.equal(f.server.errors,'');
});

native('a pre-existing destination is never overwritten or deleted by migration',{timeout:120000},async t=>{
  const f=await setup(t);let ownConflict=false;
  try{
    conflict(f.manifest.destinationDescriptor,'create-conflict');ownConflict=true;
    await assert.rejects(f.invoke('migrate'),error=>{assert.match(error.code,/EXISTS|METADATA|OWNERSHIP|RECOVERY/);return true;});
    await assert.rejects(f.invoke('status'),{code:'SSH_VAULT_METADATA_MISMATCH'});
    assert.equal((await vault.operation('status',f.source,{fixture:true})).state,'stored');
    // The creating fixture independently verifies its original bytes/metadata;
    // production cleanup is never asked to remove this conflicting credential.
    conflict(f.manifest.destinationDescriptor,'remove-conflict');ownConflict=false;
    const removed=await f.inspect();assert.equal(removed.destinationExists,false);
  }finally{if(ownConflict)conflict(f.manifest.destinationDescriptor,'remove-conflict');}
});

native('corrupt activation pointer is rejected without source retirement and exact restoration can resume',{timeout:120000},async t=>{
  const f=await setup(t);
  await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_ACTIVATION_RECEIPT'}));
  const pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName),original=fs.readFileSync(pointer);
  fs.writeFileSync(pointer,'{"syntheticCorruption":true}\n');
  try{
    const connections=f.server.records.length;
    await assert.rejects(f.broker('probe'));await assert.rejects(f.invoke('resume'));
    assert.equal(f.server.records.length,connections,'corrupt activation cannot start SSH');
    const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,true);
  }finally{fs.writeFileSync(pointer,original);}
  assert.equal((await f.invoke('resume')).state,'completed');
});

native('source receipt bytes remain bound across a stopped migration',{timeout:120000},async t=>{
  const f=await setup(t);await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_PENDING_RECEIPT'}));
  const receipt=path.join(f.source.root,'registration.bin'),original=fs.readFileSync(receipt),changed=Buffer.from(original);changed[changed.length-1]^=1;
  fs.writeFileSync(receipt,changed);
  try{
    const connections=f.server.records.length;
    await assert.rejects(f.invoke('resume'),error=>{assert.match(error.code,/RECEIPT|IDENTITY|SOURCE/);return true;});
    assert.equal(f.server.records.length,connections,'changed receipt cannot start SSH');
  }finally{fs.writeFileSync(receipt,original);}
  const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,true);
  assert.equal((await f.invoke('resume')).state,'completed');
});

native('changed pinned known_hosts file is rejected before any migration SSH',{timeout:120000},async t=>{
  const f=await setup(t),knownHosts=path.join(f.source.root,'known_hosts'),original=fs.readFileSync(knownHosts);
  fs.writeFileSync(knownHosts,Buffer.concat([original,Buffer.from('# synthetic extra host record\n')]));
  try{
    const connections=f.server.records.length;
    await assert.rejects(f.invoke('migrate'),{code:'SOURCE_HOST_PIN_CHANGED'});
    assert.equal(f.server.records.length,connections);
  }finally{fs.writeFileSync(knownHosts,original);}
  const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,false);
});

native('two controllers cannot mutate one migration concurrently',{timeout:120000},async t=>{
  const f=await setup(t);
  const outcomes=await Promise.allSettled([f.invoke('migrate'),f.invoke('migrate')]);
  const succeeded=outcomes.filter(item=>item.status==='fulfilled'),rejected=outcomes.filter(item=>item.status==='rejected');
  assert.equal(succeeded.length,1);assert.equal(succeeded[0].value.state,'completed');assert.equal(rejected.length,1);
  assert.match(rejected[0].reason.code,/LOCK|BUSY|IOEXCEPTION|MIGRATION_REPLAY/);
  const state=await f.inspect();assert.equal(state.sourceExists,false);assert.equal(state.destinationExists,true);
  assert.equal(f.server.errors,'');
});

native('native validation entry rejects missing capability and invalid ordinal before SSH',{timeout:120000},async t=>{
  const f=await setup(t);await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_PENDING_RECEIPT'}));
  const connections=f.server.records.length;
  const missing=directBroker(f.manifest,{mode:'validate-migration',ordinal:1});assert.equal(missing.ok,false);assert.equal(missing.code,'VALIDATION_CAPABILITY_REQUIRED');
  const invalid=directBroker(f.manifest,{mode:'validate-migration',ordinal:3});assert.equal(invalid.ok,false);assert.equal(invalid.code,'INTEGER_REJECTED');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.server.records.length,connections);
  const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,true);assert.equal(state.bytesEqual,true);
});

native('native helper rejects nested registration roots before opening files or SSH',{timeout:120000},async t=>{
  const f=await setup(t),connections=f.server.records.length;
  for(const direction of ['source-parent','destination-parent']){
    const manifest=JSON.parse(JSON.stringify(f.manifest));
    if(direction==='source-parent')manifest.destinationDescriptor.root=path.join(manifest.sourceDescriptor.root,'synthetic-child');
    else manifest.sourceDescriptor.root=path.join(manifest.destinationDescriptor.root,'synthetic-child');
    const result=directNative(manifest,{mode:'migrate'},manifest.helper);
    assert.equal(result.ok,false);assert.equal(result.code,'SOURCE_DESTINATION_OVERLAP');
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(f.server.records.length,connections);
  }
  const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,false);assert.equal(state.state,'prepared');
});

native('expired migration needs a grant bound to the observed state and exact original manifest',{timeout:150000},async t=>{
  const f=await setup(t,{windowSeconds:15});
  await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_CREDENTIAL_WRITE'}),{code:'INJECTED_FAULT_AFTER_CREDENTIAL_WRITE'});
  const waitMs=f.manifest.expiresAt*1000-Date.now()+1100;assert.ok(waitMs<17000);
  if(waitMs>0)await new Promise(resolve=>setTimeout(resolve,waitMs));
  const status=await f.invoke('status');assert.equal(status.expired,true);assert.equal(status.sourceExists,true);assert.equal(status.destinationExists,true);
  await assert.rejects(f.invoke('resume'),error=>{assert.match(error.code,/EXPIRED/);return true;});
  const grant=recoveryGrant(f,'resume',status);
  await assert.rejects(f.invoke('resume',{recoveryGrant:{...grant,observedStateSHA256:'0'.repeat(64)}}),error=>{assert.match(error.code,/RECOVERY|GRANT|STATE/);return true;});
  assert.equal((await f.invoke('resume',{recoveryGrant:grant})).state,'completed');
  const completed=await f.inspect();assert.equal(completed.sourceExists,false);assert.equal(completed.destinationExists,true);
  assert.equal((await f.broker('status')).state,'active');
  const probe=await f.broker('probe');assert.equal(probe.uid,1000);assert.equal(probe.bootId,BOOT_ID);
  await assert.rejects(f.invoke('resume',{recoveryGrant:grant}),error=>{assert.match(error.code,/RECOVERY|GRANT|STATE|REPLAY/);return true;});
  assert.equal(f.server.errors,'');
});

for(const faultAt of ['AFTER_PENDING_RECEIPT','AFTER_ACTIVATION_RECEIPT'])native('rollback retains original credential from '+faultAt,{timeout:120000},async t=>{
  const f=await setup(t);await assert.rejects(f.invoke('migrate',{faultAt}),{code:'INJECTED_FAULT_'+faultAt});
  const result=await f.invoke('rollback');assert.equal(result.state,'rolled-back');noSecret(result);
  const state=await f.invoke('status');assert.equal(state.state,'rolled-back');assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,false);assert.equal(state.pointerState,'old');
  assert.equal((await vault.operation('probe',f.source,{fixture:true})).uid,1000);
  await assert.rejects(f.broker('probe'));await assert.rejects(f.invoke('resume'));
  assert.equal(f.server.errors,'');
});

native('source retirement makes automatic rollback unavailable',{timeout:120000},async t=>{
  const f=await setup(t);assert.equal((await f.invoke('migrate')).state,'completed');
  await assert.rejects(f.invoke('rollback'),error=>{assert.match(error.code,/SOURCE|RETIRED|ROLLBACK/);return true;});
  const state=await f.inspect();assert.equal(state.sourceExists,false);assert.equal(state.destinationExists,true);
});

native('a missing active pointer requires an exact recovery grant and restores only the destination',{timeout:120000},async t=>{
  const f=await setup(t);assert.equal((await f.invoke('migrate')).state,'completed');
  const pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName),original=fs.readFileSync(pointer);
  fs.unlinkSync(pointer);
  const connections=f.server.records.length;await assert.rejects(f.broker('probe'));
  await assert.rejects(f.invoke('recover-pointer'));
  assert.equal(f.server.records.length,connections);
  const status=await f.invoke('status');assert.equal(status.sourceExists,false);assert.equal(status.destinationExists,true);assert.notEqual(status.state,'completed');
  const grant=recoveryGrant(f,'recover-pointer',status);
  assert.equal((await f.invoke('recover-pointer',{recoveryGrant:grant})).state,'pointer-restored');
  assert.deepEqual(fs.readFileSync(pointer),original);
  const probe=await f.broker('probe');assert.equal(probe.uid,1000);assert.equal(probe.bootId,BOOT_ID);
  const state=await f.inspect();assert.equal(state.sourceExists,false);assert.equal(state.destinationExists,true);
});

native('rollback interruptions retain enough exact state to finish without recreating credentials',{timeout:450000},async t=>{
  for(const faultAt of ['AFTER_ROLLBACK_INTENT','AFTER_ROLLBACK_POINTER','AFTER_ROLLBACK_DELETE','AFTER_ROLLBACK_RECORD'])await t.test(faultAt,{timeout:120000},async t=>{
    const f=await setup(t);await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_ACTIVATION_RECEIPT'}));
    await assert.rejects(f.invoke('rollback',{faultAt}),{code:'INJECTED_FAULT_'+faultAt});
    const state=await f.inspect();assert.equal(state.sourceExists,true);
    await assert.rejects(f.broker('probe'));
    assert.equal((await f.invoke('rollback')).state,'rolled-back');
    const final=await f.invoke('status');assert.equal(final.state,'rolled-back');assert.equal(final.sourceExists,true);assert.equal(final.destinationExists,false);assert.equal(final.pointerState,'old');
    assert.equal(f.server.errors,'');
  });
});

native('pointer recovery interruption resumes only its exact existing grant intent',{timeout:240000},async t=>{
  for(const faultAt of ['AFTER_POINTER_RECOVERY_INTENT','AFTER_POINTER_RECOVERY_WRITE'])await t.test(faultAt,{timeout:120000},async t=>{
    const f=await setup(t);assert.equal((await f.invoke('migrate')).state,'completed');
    const pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName),original=fs.readFileSync(pointer);fs.unlinkSync(pointer);
    const grant=recoveryGrant(f,'recover-pointer',await f.invoke('status'));
    await assert.rejects(f.invoke('recover-pointer',{recoveryGrant:grant,faultAt}),{code:'INJECTED_FAULT_'+faultAt});
    const connections=f.server.records.length;
    assert.equal((await f.invoke('recover-pointer',{recoveryGrant:grant})).state,'pointer-restored');
    assert.equal(f.server.records.length,connections,'pointer recovery cannot authenticate to SSH');
    assert.deepEqual(fs.readFileSync(pointer),original);
    const state=await f.inspect();assert.equal(state.sourceExists,false);assert.equal(state.destinationExists,true);
  });
});

native('malformed final probe evidence is rejected by its closed schema before resume SSH',{timeout:120000},async t=>{
  const f=await setup(t);await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_PROBE_1'}),{code:'INJECTED_FAULT_AFTER_PROBE_1'});
  let corrupted=false;
  try{
    conflict(f.manifest.destinationDescriptor,'corrupt-journal');corrupted=true;
    const connections=f.server.records.length;
    await assert.rejects(f.invoke('resume'),error=>{assert.match(error.code,/FIELDS_REJECTED|JOURNAL_DETAILS/);return true;});
    assert.equal(f.server.records.length,connections);
    conflict(f.manifest.destinationDescriptor,'restore-journal');corrupted=false;
  }finally{if(corrupted)conflict(f.manifest.destinationDescriptor,'restore-journal');}
  assert.equal((await f.invoke('resume')).state,'completed');
});

native('replacing an existing active pointer preserves its exact bytes for rollback',{timeout:120000},async t=>{
  const f=await setup(t,{existingPointer:true}),pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName),original=fs.readFileSync(pointer);
  await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_ACTIVATION_RECEIPT'}),{code:'INJECTED_FAULT_AFTER_ACTIVATION_RECEIPT'});
  assert.notDeepEqual(fs.readFileSync(pointer),original);
  assert.equal((await f.invoke('rollback')).state,'rolled-back');assert.deepEqual(fs.readFileSync(pointer),original);
  const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,false);
});

native('displaced pointer crashes retain exact old bytes and resume or roll back',{timeout:360000},async t=>{
  for(const recovery of ['resume','rollback'])await t.test('activation displacement then '+recovery,{timeout:120000},async t=>{
    const f=await setup(t,{existingPointer:true}),pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName),original=fs.readFileSync(pointer);
    await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_POINTER_DISPLACE'}),{code:'INJECTED_FAULT_AFTER_POINTER_DISPLACE'});
    assert.equal(fs.existsSync(pointer),false);
    assert.deepEqual(fs.readFileSync(path.join(f.manifest.pointerRoot,'activation-old-'+f.manifest.migrationId+'.backup')),original);
    const stopped=await f.inspect();assert.equal(stopped.pointerState,'missing');assert.equal(stopped.sourceExists,true);assert.equal(stopped.destinationExists,true);
    const result=await f.invoke(recovery);assert.equal(result.state,recovery==='resume'?'completed':'rolled-back');
    const final=await f.inspect();
    if(recovery==='rollback'){assert.deepEqual(fs.readFileSync(pointer),original);assert.equal(final.sourceExists,true);assert.equal(final.destinationExists,false);}
    else{assert.notDeepEqual(fs.readFileSync(pointer),original);assert.equal(final.sourceExists,false);assert.equal(final.destinationExists,true);}
  });
  await t.test('rollback displacement then rollback',{timeout:120000},async t=>{
    const f=await setup(t,{existingPointer:true}),pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName),original=fs.readFileSync(pointer);
    await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_ACTIVATION_RECEIPT'}),{code:'INJECTED_FAULT_AFTER_ACTIVATION_RECEIPT'});
    const active=fs.readFileSync(pointer);
    await assert.rejects(f.invoke('rollback',{faultAt:'AFTER_ROLLBACK_DISPLACE'}),{code:'INJECTED_FAULT_AFTER_ROLLBACK_DISPLACE'});
    assert.equal(fs.existsSync(pointer),false);
    assert.deepEqual(fs.readFileSync(path.join(f.manifest.pointerRoot,'rollback-new-'+f.manifest.migrationId+'.backup')),active);
    assert.equal((await f.invoke('rollback')).state,'rolled-back');assert.deepEqual(fs.readFileSync(pointer),original);
    const final=await f.inspect();assert.equal(final.sourceExists,true);assert.equal(final.destinationExists,false);
  });
});

native('displaced recovery rejects unknown pointer and changed backup without changing their bytes',{timeout:120000},async t=>{
  const f=await setup(t,{existingPointer:true}),pointer=path.join(f.manifest.pointerRoot,f.manifest.pointerFileName);
  const backup=path.join(f.manifest.pointerRoot,'activation-old-'+f.manifest.migrationId+'.backup'),original=fs.readFileSync(pointer);
  await assert.rejects(f.invoke('migrate',{faultAt:'AFTER_POINTER_DISPLACE'}),{code:'INJECTED_FAULT_AFTER_POINTER_DISPLACE'});
  const connections=f.server.records.length,unknown=Buffer.from('{"syntheticUnknownPointer":true}\n'),changed=Buffer.from('{"syntheticChangedBackup":true}\n');
  fs.writeFileSync(pointer,unknown,{flag:'wx'});
  try{
    await assert.rejects(f.invoke('resume'),{code:'POINTER_CHANGED'});
    await assert.rejects(f.invoke('rollback'),{code:'ROLLBACK_POINTER_CHANGED'});
    assert.deepEqual(fs.readFileSync(pointer),unknown);assert.deepEqual(fs.readFileSync(backup),original);
    assert.equal(f.server.records.length,connections);
  }finally{assert.deepEqual(fs.readFileSync(pointer),unknown);fs.unlinkSync(pointer);}
  fs.writeFileSync(backup,changed);
  try{
    await assert.rejects(f.invoke('resume'),error=>{assert.match(error.code,/BACKUP_CHANGED/);return true;});
    assert.deepEqual(fs.readFileSync(backup),changed);assert.equal(fs.existsSync(pointer),false);
    assert.equal(f.server.records.length,connections);
    const state=await f.inspect();assert.equal(state.sourceExists,true);assert.equal(state.destinationExists,true);assert.equal(state.bytesEqual,true);
  }finally{fs.writeFileSync(backup,original);}
  assert.equal((await f.invoke('resume')).state,'completed');assert.deepEqual(fs.readFileSync(backup),original);
});

native('native raw run rejects malformed permits before any SSH',{timeout:120000},async t=>{
  const f=await setup(t);assert.equal((await f.invoke('migrate')).state,'completed');
  const connections=f.server.records.length,now=Math.floor(Date.now()/1000);
  const valid={protocol:1,op:'run-r2-synthetic-v1',sequence:1,nonce:crypto.randomBytes(32).toString('hex'),catalogSHA256:f.manifest.catalogSHA256,bootId:BOOT_ID,uid:1000,case:'isolation-v1',expiresAtUnixSeconds:now+120,runtimeSeconds:60};
  for(const [changes,code] of [[{case:'unapproved'},'RUN_CATALOG_REJECTED'],[{nonce:'0'.repeat(64)},'RUN_NONCE_REJECTED'],[{expiresAtUnixSeconds:now-1},'RUN_EXPIRED'],[{command:'synthetic-disallowed-field'},'FIELDS_REJECTED']]){
    const result=directBroker(f.manifest,{mode:'run-r2-synthetic-v1',runRequest:{...valid,...changes}});
    assert.equal(result.exit,125);assert.equal(result.stdout,'');assert.match(result.stderr,new RegExp('^HUB_MAINTENANCE_ERROR:'+code+'\\r?\\n$'));
  }
  // Drain child-pipe events after synchronous native calls so zero new SSH is
  // checked against server-observed connections, not an unprocessed event queue.
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.server.records.length,connections);assert.equal(f.server.errors,'');
  assert.equal((await f.broker('status')).state,'active');
});

module.exports={FAULTS};
