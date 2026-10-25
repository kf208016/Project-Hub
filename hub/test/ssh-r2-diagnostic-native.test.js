'use strict';
// Explicit opt-in: fresh synthetic registrations and localhost SSH only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const diagnostic=require('../lib/ssh-r2-diagnostic');
const maintenance=require('../lib/ssh-vault-maintenance');
const synthetic=require('./helpers/ssh-diagnostic-synthetic');
const enabled=process.platform==='win32'&&process.env.HUB_RUN_R2_DIAGNOSTIC_NATIVE_TEST==='1';
const native=enabled?test:test.skip;
const NAMES=['intent.json','runtime.json','unit.json','service-kernel.json','execution-gate.json','service-error.json','measurement.json','result.json','closed.json','active.json'];
const FACTS=['bindingMatches','recordedCode','recordedOk','recordedCleanupVerified','completionState','recordedGuardPassed','measurementShapeValid','invocationId','pid','startTicks','cgroupPathSHA256'];
const hash=diagnostic.hash,canonical=diagnostic.canonical;
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
const builds=[],outcomes=[];let sourceSnapshot;
function snapshotSources(){
  const files=[...diagnostic.SOURCE_NAMES.map(name=>path.join(__dirname,'../windows',name)),path.join(__dirname,'helpers/ssh-r2-diagnostic-fixture.cs'),path.join(__dirname,'../worker/r2_inspect.py'),path.join(__dirname,'../worker/stage_protocol.py'),path.join(__dirname,'../lib/ssh-r2-diagnostic.js'),path.join(__dirname,'../lib/worker-r2-inspect-bootstrap.js'),path.join(__dirname,'../lib/r2-inspect-result.js'),__filename,path.join(__dirname,'helpers/ssh-diagnostic-synthetic.js'),path.join(__dirname,'fixtures/ssh-r2-diagnostic-server.py')];
  return files.map(file=>({file:path.relative(path.join(__dirname,'../..'),file).replaceAll('\\','/'),sha256:hash(fs.readFileSync(file))}));
}
test.after(()=>{
  const filename=process.env.HUB_R2_DIAGNOSTIC_TEST_EVIDENCE;if(!enabled||!filename)return;
  assert.match(filename,/^ssh-r2-diagnostic-native-[a-z0-9-]+\.json$/);
  const remainingFixtureRoots=fs.readdirSync(synthetic.PARENT).filter(name=>/^vault-diagnostic-[a-f0-9]{12}-[sdpg]$/.test(name));
  fs.writeFileSync(path.resolve(__dirname,'../../../../outputs',filename),JSON.stringify({schemaVersion:1,scope:'synthetic credential and loopback SSH only; Python payload not executed',sourceSnapshot,builds,outcomes,remainingFixtureRoots},null,2)+'\n',{flag:'wx'});
  assert.deepEqual(remainingFixtureRoots,[]);
});

async function startServer(t,bundle){
  const configuration=path.join(bundle.grantRoot.root,'diagnostic-case.json');
  const child=cp.spawn('python',[path.join(__dirname,'fixtures/ssh-r2-diagnostic-server.py'),'--case-file',configuration],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const records=[];let stderr='',pending='',resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const timer=setTimeout(()=>rejectReady(Error('Diagnostic fixture startup deadline')),10000);
  child.stdout.on('data',data=>{pending+=data;let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);try{const record=JSON.parse(line);if(record.port){clearTimeout(timer);resolveReady(record);}else records.push(record);}catch{rejectReady(Error('Diagnostic fixture output rejected'));}}});
  child.stderr.on('data',data=>{stderr+=data;});child.once('error',rejectReady);
  t.after(()=>{clearTimeout(timer);child.kill();});
  return {config:await ready,configuration,records,get connections(){return records.filter(r=>r.event==='accepted').length;},get errors(){return stderr;}};
}

function fixture(f,mode,extra={}){
  assert.equal(hash(fs.readFileSync(f.build.fixtureHelper.file)),f.build.fixtureHelper.sha256);
  const env={...synthetic.environment(),HUB_R2_DIAGNOSTIC_FIXTURE_REQUEST:Buffer.from(canonical({mode,manifest:f.manifest,...extra})).toString('base64')};
  const result=cp.spawnSync(f.build.fixtureHelper.file,[],{env,windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);synthetic.noSecret({stdout:result.stdout,stderr:result.stderr});
  const value=JSON.parse(result.stdout);assert.equal(result.status,0,value.code);assert.equal(value.ok,true);return value;
}

function direct(f,grant=f.grant,{text,entry=f.build.file}={}){
  const request=text??canonical({mode:'inspect-r2-run-v1',grant});
  const env={...synthetic.environment(),HUB_SSH_R2_DIAGNOSTIC_REQUEST:Buffer.from(request).toString('base64')};
  const result=cp.spawnSync(entry,[],{env,windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);synthetic.noSecret({stdout:result.stdout,stderr:result.stderr});
  const value=JSON.parse(result.stdout);assert.equal(result.status,125);assert.equal(value.ok,false);assert.match(value.code,/^[A-Z0-9_]{1,100}$/);
  const events=result.stderr.split(/\r?\n/).filter(Boolean).map(line=>{assert.match(line,/^HUB_R2_DIAGNOSTIC_EVENT:[A-Z0-9_]{1,100}$/);return line.split(':')[1];});
  outcomes.push({case:f.caseName,kind:'raw-native-rejection',code:value.code,events});
  return {...value,stderr:result.stderr};
}

async function invoke(f){
  try{const result=await diagnostic.invoke(f.build,f.grant);outcomes.push({case:f.caseName,kind:'typed-result',state:result.state,code:result.diagnostic.code,events:result.events,childCloseObserved:result.childCloseObserved});return result;}
  catch(error){assert.match(error.code,/^[A-Z0-9_]{1,100}$/);outcomes.push({case:f.caseName,kind:'transport-rejection',code:error.code,events:error.events,childCloseObserved:error.childCloseObserved});throw error;}
}

function historicalFiles(f){
  const result={};
  for(const [kind,root] of [['source',f.source.root],['destination',f.destination.root],['pointer',f.manifest.pointerRoot]]){
    for(const name of fs.readdirSync(root).sort()){
      const file=path.join(root,name),stat=fs.lstatSync(file);assert.equal(stat.isSymbolicLink(),false);assert.equal(stat.isFile(),true);
      result[kind+'/'+name]={sha256:hash(fs.readFileSync(file)),bytes:stat.size,mtimeMs:stat.mtimeMs};
    }
  }
  return result;
}

function failureEvidence(run){
  const common={protocol:1,nonce:run.nonce,providerReady:false};
  return {kind:'project-hub-approved-ssh-maintenance',mode:'r2',recordedAtUTC:new Date().toISOString(),passwordObservedByController:false,providerLogin:false,modelCalls:false,events:['SSH_HOST_PIN_MATCHED','ASKPASS_SUPPLIED','SSH_PASSWORD_AUTHENTICATED','IDENTITY_VERIFIED'],
    result:{ok:false,state:'r2-result',exitCode:125,nativeCode:'R2_SSH_FAILED',identity:{uid:run.uid,bootId:run.bootId},frames:[
      {...common,sequence:1,op:'accepted',bootId:run.bootId,case:run.case,catalogSHA256:run.catalogSHA256,sourceBundleSHA256:require('../lib/worker-r2-bootstrap').buildR2Bootstrap().sourceBundleSHA256,uid:run.uid},
      {...common,sequence:2,op:'heartbeat',phase:'synthetic-running'},
      {...common,sequence:3,op:'result',case:run.case,catalogSHA256:run.catalogSHA256,cleanup:{basis:'owned-cgroup-events',cleanupVerified:false,identityPreserved:false,ownedOutputsClosed:false,populatedZeroObserved:false,unitStopped:false},cleanupVerified:false,code:'R2_UNIT_IDENTITY_CHANGED',fullR2Verified:false,notStartedConfirmed:false,ok:false}],providerReady:false,providerLogin:false,modelCalls:false},ok:false};
}

function response(run){
  return {protocol:1,op:'inspection-result',sequence:1,nonce:run.nonce,uid:run.uid,bootId:run.bootId,ok:false,code:'INSPECTION_FAILED',records:NAMES.map(name=>({name,status:'unread',code:'NOT_READ',sha256:null,facts:Object.fromEntries(FACTS.map(key=>[key,null]))})),
    unit:{status:'unknown',code:'NOT_READ',loadState:null,activeState:null,subState:null,invocationId:null,mainPID:null,execMainCode:null,execMainStatus:null,result:null,savedIdentityMatches:false},
    cgroup:{status:'unknown',code:'NOT_READ',identityMatches:false,populated:null,frozen:null,memoryMax:null,memorySwapMax:null,pidsMax:null,cpuQuota:null,cpuPeriod:null},cleanupHistorical:'unknown',providerReady:false,snapshotAtomic:false};
}

async function setup(t){
  const current=snapshotSources();if(sourceSnapshot)assert.deepEqual(current,sourceSnapshot,'diagnostic source changed during native batch');else sourceSnapshot=current;
  const bundle=await synthetic.createRoots(t),server=await startServer(t,bundle),f=await synthetic.completeMigration(bundle,server);
  const now=Math.floor(Date.now()/1000);
  const run={protocol:1,op:'run-r2-synthetic-v1',sequence:1,nonce:crypto.randomBytes(32).toString('hex'),catalogSHA256:f.manifest.catalogSHA256,bootId:synthetic.BOOT_ID,uid:1000,case:'isolation-v1',expiresAtUnixSeconds:now-60,runtimeSeconds:60};
  const manifestReference=path.join(f.grantRoot.root,'migration-manifest.json'),reviewReference=path.join(f.grantRoot.root,'review.md'),failureReference=path.join(f.grantRoot.root,'failure-evidence.json');
  fs.writeFileSync(manifestReference,canonical(f.manifest),{flag:'wx'});
  fs.writeFileSync(reviewReference,fs.readFileSync(path.join(__dirname,'../..',diagnostic.REVIEW)),{flag:'wx'});
  fs.writeFileSync(failureReference,canonical(failureEvidence(run)),{flag:'wx'});
  const capsule={ManifestReference:manifestReference,ManifestSHA256:hash(Buffer.from(canonical(f.manifest))),DestinationBindingSHA256:hash(Buffer.from(canonical(f.destination))),RunNonce:run.nonce,OriginalCatalogSHA256:run.catalogSHA256,RunPermitSHA256:hash(Buffer.from(canonical(run))),ReviewReference:diagnostic.REVIEW,ReviewDocumentReference:reviewReference,ReviewDocumentSHA256:hash(fs.readFileSync(reviewReference)),FailureEvidenceReference:failureReference,FailureEvidenceSHA256:hash(fs.readFileSync(failureReference)),GrantRoot:f.grantRoot.root,GrantRootFingerprint:f.grantRoot.rootFingerprint,Uid:run.uid,BootId:run.bootId};
  const build=diagnostic.ensure({capsule,fixture:true});
  builds.push({sourceHash:build.sourceHash,helperSHA256:build.sha256,fixtureHelperSHA256:build.fixtureHelper.sha256,catalogSHA256:build.catalog.catalogSHA256,payloadSHA256:build.catalog.payloadSHA256,payloadLength:build.catalog.payloadLength,manifestSHA256:capsule.ManifestSHA256,runNonceSHA256:hash(Buffer.from(run.nonce))});
  Object.assign(f,{build,run,capsule,caseName:t.name});
  const receipt=fixture(f,'run-receipt',{run});assert.equal(receipt.runPermitSHA256,capsule.RunPermitSHA256);
  const time=Math.floor(Date.now()/1000);
  const grant={schemaVersion:1,grantId:crypto.randomUUID(),issuedAt:time-1,expiresAt:time+300,operation:'inspect-r2-run-v1',reviewReference:diagnostic.REVIEW,reviewDocumentSHA256:capsule.ReviewDocumentSHA256,manifestReference,manifestSHA256:capsule.ManifestSHA256,destinationBindingSHA256:capsule.DestinationBindingSHA256,registrationReceiptSHA256:hash(fs.readFileSync(path.join(f.destination.root,'registration.bin'))),activationReceiptSHA256:hash(fs.readFileSync(path.join(f.destination.root,'activation.bin'))),pointerSHA256:hash(fs.readFileSync(path.join(f.manifest.pointerRoot,f.manifest.pointerFileName))),runReceiptSHA256:receipt.runReceiptSHA256,runPermitSHA256:capsule.RunPermitSHA256,originalCatalogSHA256:run.catalogSHA256,helperSHA256:build.sha256,sourceSetSHA256:build.sourceHash,diagnosticCatalogSHA256:build.catalog.catalogSHA256,diagnosticPayloadSHA256:build.catalog.payloadSHA256,diagnosticPayloadLength:build.catalog.payloadLength,failureEvidenceSHA256:capsule.FailureEvidenceSHA256,runNonce:run.nonce,uid:1000,bootId:run.bootId,grantRoot:capsule.GrantRoot,grantRootFingerprint:capsule.GrantRootFingerprint,maxSessions:1,deadlineSeconds:45,maxOutputBytes:131072};
  diagnostic.buildRequest(grant,build);f.grant=grant;f.consumed=path.join(f.grantRoot.root,'consumed-'+grant.grantId+'.bin');
  f.serverCase={command:build.catalog.command,payloadSHA256:build.catalog.payloadSHA256,payloadLength:build.catalog.payloadLength,request:{protocol:1,op:'inspect-r2-run-v1',sequence:1,nonce:run.nonce,originalCatalogSHA256:run.catalogSHA256,uid:run.uid,bootId:run.bootId,expiresAtUnixSeconds:grant.expiresAt},response:response(run),responseMode:'framed'};
  f.writeCase=()=>fs.writeFileSync(f.server.configuration,canonical(f.serverCase));f.writeCase();
  return f;
}

native('diagnostic reads one synthetic credential for one bounded typed session and rejects replay',{timeout:120000},async t=>{
  const f=await setup(t),before=fixture(f,'inspect'),files=historicalFiles(f),connections=f.server.connections;
  assert.equal(before.syntheticMatches,true);assert.equal(before.commentMatches,true);assert.equal(before.destinationExists,true);
  const result=await invoke(f);synthetic.noSecret(result);assert.equal(result.state,'diagnostic-result');assert.equal(result.diagnostic.cleanupHistorical,'unknown');assert.equal(result.diagnostic.providerReady,false);assert.equal(result.diagnostic.snapshotAtomic,false);assert.equal(result.diagnostic.code,'INSPECTION_FAILED');
  await pause();assert.equal(f.server.connections,connections+1);assert.equal(f.server.records.filter(r=>r.event==='diagnostic').length,1);assert.equal(fs.existsSync(f.consumed),true);
  assert.deepEqual(fixture(f,'inspect'),before);assert.deepEqual(historicalFiles(f),files);
  const consumption=fs.readFileSync(f.consumed);const replay=direct(f);assert.match(replay.code,/REPLAY|FORBIDDEN_STATE/);await pause();assert.equal(f.server.connections,connections+1);assert.deepEqual(fs.readFileSync(f.consumed),consumption);
  assert.deepEqual(fixture(f,'inspect'),before);assert.deepEqual(historicalFiles(f),files);assert.equal(f.server.errors,'');
});

native('native diagnostic rejects changed grants and history before consuming or starting SSH',{timeout:180000},async t=>{
  const f=await setup(t),credential=fixture(f,'inspect'),connections=f.server.connections;
  const alteredGrant=[
    ['expired',{issuedAt:f.grant.issuedAt-120,expiresAt:f.grant.issuedAt-1}],['future',{issuedAt:f.grant.expiresAt,expiresAt:f.grant.expiresAt+60}],['near expiry',()=>({expiresAt:Math.floor(Date.now()/1000)+5})],
    ['wrong operation',{operation:'unapproved'}],['extra command',{command:'synthetic-disallowed-field'}],['boolean session count',{maxSessions:true}],['two sessions',{maxSessions:2}],
    ['wrong UID',{uid:1001}],['wrong boot',{bootId:'11111111-1111-1111-1111-111111111111'}],['zero nonce',{runNonce:'0'.repeat(64)}],
    ['helper digest',{helperSHA256:'0'.repeat(64)}],['source set digest',{sourceSetSHA256:'0'.repeat(64)}],['run permit digest',{runPermitSHA256:'0'.repeat(64)}],['review reference',{reviewReference:'synthetic-unapproved.md'}]
  ];
  for(const [name,change] of alteredGrant)await t.test(name,async()=>{f.caseName=name;const files=historicalFiles(f);const result=direct(f,{...f.grant,...(typeof change==='function'?change():change)});if(name==='near expiry')assert.equal(result.code,'DIAGNOSTIC_DEADLINE');await pause();assert.equal(fs.existsSync(f.consumed),false);assert.equal(f.server.connections,connections);assert.deepEqual(historicalFiles(f),files);assert.deepEqual(fixture(f,'inspect'),credential);});
  await t.test('duplicate JSON key',async()=>{f.caseName='duplicate JSON key';const text=canonical({mode:'inspect-r2-run-v1',grant:f.grant}).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1');const result=direct(f,f.grant,{text});assert.match(result.code,/JSON/);await pause();assert.equal(f.server.connections,connections);assert.equal(fs.existsSync(f.consumed),false);});
  const files=[['manifest',f.capsule.ManifestReference],['review',f.capsule.ReviewDocumentReference],['failure evidence',f.capsule.FailureEvidenceReference],['run receipt',path.join(f.destination.root,'run-'+f.run.nonce+'.bin')],['registration receipt',path.join(f.destination.root,'registration.bin')],['activation receipt',path.join(f.destination.root,'activation.bin')],['pointer',path.join(f.manifest.pointerRoot,f.manifest.pointerFileName)],['source tomb',path.join(f.source.root,'forgotten.bin')],['source intent',path.join(f.source.root,'maintenance-intent.bin')],['destination intent',path.join(f.destination.root,'maintenance-intent.bin')],['journal',path.join(f.destination.root,'migration-0003.bin')],['known hosts',path.join(f.destination.root,'known_hosts')]];
  for(const [name,file] of files)await t.test(name,async()=>{
    f.caseName=name;
    const original=fs.readFileSync(file),changed=Buffer.from(original);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);
    try{const before=historicalFiles(f);direct(f);await pause();assert.equal(f.server.connections,connections);assert.equal(fs.existsSync(f.consumed),false);assert.deepEqual(fs.readFileSync(file),changed);assert.deepEqual(historicalFiles(f),before);}
    finally{fs.writeFileSync(file,original);}assert.deepEqual(fixture(f,'inspect'),credential);
  });
  await t.test('missing existing lock is not recreated',async()=>{
    f.caseName='missing existing lock is not recreated';
    const lock=path.join(f.destination.root,'registration.lock'),backup=path.join(f.destination.root,'fixture-existing-lock.backup');fs.renameSync(lock,backup);
    try{const before=historicalFiles(f);direct(f);await pause();assert.equal(f.server.connections,connections);assert.equal(fs.existsSync(lock),false);assert.equal(fs.existsSync(f.consumed),false);assert.deepEqual(historicalFiles(f),before);}
    finally{assert.equal(fs.existsSync(lock),false);fs.renameSync(backup,lock);}assert.deepEqual(fixture(f,'inspect'),credential);
  });
  await t.test('different helper path',async()=>{
    f.caseName='different helper path';
    const copy=path.join(f.grantRoot.root,'different-helper.exe');fs.copyFileSync(f.build.file,copy,fs.constants.COPYFILE_EXCL);
    try{assert.equal(direct(f,f.grant,{entry:copy}).code,'DIAGNOSTIC_ENTRY_IMAGE');await pause();assert.equal(f.server.connections,connections);assert.equal(fs.existsSync(f.consumed),false);}
    finally{assert.equal(hash(fs.readFileSync(copy)),f.build.sha256);fs.unlinkSync(copy);}
  });
  f.caseName='valid after all rejection cases';const before=historicalFiles(f);assert.equal((await invoke(f)).state,'diagnostic-result');await pause();assert.equal(f.server.connections,connections+1);assert.deepEqual(fixture(f,'inspect'),credential);assert.deepEqual(historicalFiles(f),before);
});

native('credential metadata failure consumes the grant but never mutates the entry or starts SSH',{timeout:120000},async t=>{
  const f=await setup(t),files=historicalFiles(f),connections=f.server.connections;
  fixture(f,'wrong-metadata');
  try{
    const before=fixture(f,'inspect');assert.equal(before.commentMatches,false);assert.equal(before.syntheticMatches,true);
    const result=direct(f);assert.match(result.code,/METADATA/);await pause();assert.equal(f.server.connections,connections);assert.equal(fs.existsSync(f.consumed),true);assert.deepEqual(fixture(f,'inspect'),before);assert.deepEqual(historicalFiles(f),files);
    direct(f);await pause();assert.equal(f.server.connections,connections);assert.deepEqual(fixture(f,'inspect'),before);
  }finally{fixture(f,'restore-metadata');}
  assert.equal(fixture(f,'inspect').commentMatches,true);
});

native('bounded malformed remote diagnostic results cannot change credentials or become ready',{timeout:360000},async t=>{
  for(const mode of ['malformed','oversize','valid-prefix-overflow','wrong-exit','wrong-nonce','provider-ready','cleanup-overclaim'])await t.test(mode,{timeout:120000},async t=>{
    const f=await setup(t),before=fixture(f,'inspect'),files=historicalFiles(f),connections=f.server.connections;
    if(mode==='wrong-nonce')f.serverCase.response.nonce='1'.repeat(64);else if(mode==='provider-ready')f.serverCase.response.providerReady=true;else if(mode==='cleanup-overclaim')f.serverCase.response.cleanupHistorical='verified';else f.serverCase.responseMode=mode;f.writeCase();
    const expected={malformed:'DIAGNOSTIC_OUTPUT_FRAME_LENGTH',oversize:'DIAGNOSTIC_SSH_FAILED','valid-prefix-overflow':'DIAGNOSTIC_SSH_FAILED','wrong-exit':'DIAGNOSTIC_EXIT_RESULT_MISMATCH','wrong-nonce':'DIAGNOSTIC_OUTPUT_BINDING','provider-ready':'DIAGNOSTIC_BOOLEAN_REJECTED','cleanup-overclaim':'DIAGNOSTIC_OUTPUT_BINDING'};
    await assert.rejects(invoke(f),{code:expected[mode]});await pause();assert.equal(f.server.connections,connections+1);assert.equal(fs.existsSync(f.consumed),true);assert.deepEqual(fixture(f,'inspect'),before);assert.deepEqual(historicalFiles(f),files);
    direct(f);await pause();assert.equal(f.server.connections,connections+1);assert.deepEqual(fixture(f,'inspect'),before);
  });
});
