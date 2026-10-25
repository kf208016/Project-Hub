'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const maintenance=require('../lib/ssh-vault-maintenance');
const examples=require('../windows/ssh-vault-maintenance-examples.json');
const schema=require('../windows/ssh-vault-maintenance.schema.json');
const now=examples.evaluationUnixSeconds;
const fresh=()=>structuredClone(examples.manifest);
function rejects(change){const value=fresh();change(value);assert.throws(()=>maintenance.validateManifest(value,{now}));}
test('decoded state schema and synthetic examples preserve closed nonsecret records',()=>{
  const stateSchema=require('../windows/ssh-maintenance-state.schema.json');
  const stateExamples=require('../windows/ssh-maintenance-state-examples.json');
  for(const name of ['pending','activation','pointer','pointerPrior','probeDetails']){
    const shape=stateSchema.$defs[name],sample=stateExamples[name];
    assert.equal(shape.additionalProperties,false);
    assert.deepEqual(shape.required.slice().sort(),Object.keys(sample).sort());
    assert.deepEqual(Object.keys(shape.properties).sort(),Object.keys(sample).sort());
  }
  const digest=x=>maintenance.hash(Buffer.from(maintenance.canonical(x)));
  assert.equal(stateExamples.pending.manifestSHA256,digest(examples.manifest));
  assert.equal(stateExamples.pending.binding,digest(examples.manifest.destinationDescriptor));
  assert.equal(stateExamples.activation.pointerSHA256,digest(stateExamples.pointer));
  assert.equal(stateSchema.$defs.journal.properties.sequence.maximum,12);
  assert.equal(stateSchema.$defs.runPermit.properties.run.$ref,'worker-r2-run.schema.json');
  assert.equal(stateSchema.$defs.recoveryIntent.properties.grant.$ref,'ssh-maintenance-recovery.schema.json');
});
test('maintenance example and schema agree without credentials or endpoint activity',()=>{
  const value=fresh();assert.equal(maintenance.validateManifest(value,{now}),value);
  assert.deepEqual(schema.required.slice().sort(),Object.keys(value).sort());
  assert.deepEqual(Object.keys(schema.properties).sort(),Object.keys(value).sort());
  assert.equal(schema.additionalProperties,false);assert.match(examples.validationScope,/Synthetic offline/);
  assert.equal(value.sourceDescriptor.host,'192.0.2.25');
  assert.equal(schema.properties.sourceDescriptor.$ref,'ssh-password-vault.schema.json');
});
test('maintenance rejects secrets, unknown fields, missing fields and inherited requests',()=>{
  for(const field of ['password','secret','command','source','env','rawCredential'])rejects(x=>{x[field]='unexpected';});
  for(const field of maintenance.MANIFEST_FIELDS)rejects(x=>{delete x[field];});
  for(const value of [null,[],Object.create(fresh()),Object.assign(Object.create(null),fresh())])assert.throws(()=>maintenance.validateManifest(value,{now}));
});
test('migration cannot change host account pin SID or SSH runtime',()=>{
  for(const field of ['host','port','user','ownerSid','ssh','sshSHA256','hostKey','hostFingerprint'])rejects(x=>{x.destinationDescriptor[field]=field==='port'?2222:field==='user'?'other':field==='host'?'192.0.2.26':field==='ssh'?'C:\\Other\\ssh.exe':field==='ownerSid'?'S-1-5-21-2-3-4-1001':'a'.repeat(64);});
  rejects(x=>{x.destinationDescriptor.root=x.sourceDescriptor.root.toUpperCase();});
  rejects(x=>{x.destinationDescriptor.registrationId=x.sourceDescriptor.registrationId;});
  rejects(x=>{x.helper=x.sourceBroker;});
  rejects(x=>{x.pointerRoot=x.sourceDescriptor.root;});
  rejects(x=>{x.pointerRoot=x.destinationDescriptor.root+'\\nested';});
  rejects(x=>{x.pointerRoot=path.win32.dirname(x.sourceDescriptor.root);});
  rejects(x=>{x.destinationDescriptor.root=x.sourceDescriptor.root+'\\nested';});
  rejects(x=>{x.reviewReference='unreviewed';});
});
test('manifest expiry and identifiers reject coercion trailing newline and broad lifetimes',()=>{
  for(const field of ['migrationId','sourceReceiptSHA256','helperSHA256','catalogSHA256','payloadSHA256','pointerRootFingerprint'])rejects(x=>{x[field]+='\n';});
  for(const value of [true,1.5,'1000',0,-1,2147483648])rejects(x=>{x.sourceUid=value;});
  for(const value of [true,1.5,'1024',0,-1,1048577])rejects(x=>{x.payloadLength=value;});
  rejects(x=>{x.expiresAt=x.issuedAt;});rejects(x=>{x.expiresAt=x.issuedAt+86401;});
  assert.throws(()=>maintenance.validateManifest(fresh(),{now:examples.manifest.expiresAt}));
  assert.throws(()=>maintenance.validateManifest(fresh(),{now:examples.manifest.issuedAt-1,allowExpired:true}));
  assert.equal(maintenance.validateManifest(fresh(),{now:examples.manifest.expiresAt,allowExpired:true}).schemaVersion,1);
});
test('migration pointer and code paths cannot normalize or escape declared references',()=>{
  for(const field of ['sourceBroker','helper','destinationBroker','pointerRoot'])for(const value of ['relative','C:/unsafe','C:\\a\\..\\b','C:\\a:stream','C:\\a\\','C:\\a\n','\\\\server\\share'])rejects(x=>{x[field]=value;});
  for(const value of ['..\\pointer.json','other.json',null])rejects(x=>{x.pointerFileName=value;});
  for(const value of ['',null,'absent\n','a'.repeat(64)+'\n'])rejects(x=>{x.pointerExpectedSHA256=value;});
});
test('permit accepts only one fixed bounded synthetic operation',()=>{
  const run=()=>structuredClone(examples.runRequest),m=fresh();
  assert.equal(maintenance.validateRun(run(),m,{now}).case,'isolation-v1');
  for(const [key,value]of [['op','sh'],['case','claude'],['runtimeSeconds',61],['protocol',true],['sequence',2],['uid',1001],['catalogSHA256','a'.repeat(64)],['expiresAtUnixSeconds',now],['expiresAtUnixSeconds',now+121],['bootId',run().bootId+'\n'],['nonce','0'.repeat(64)],['nonce','a'.repeat(64)+'\n'],['command','id']]){
    assert.throws(()=>maintenance.validateRun({...run(),[key]:value},m,{now}),key);
  }
});
test('run schema closes the exact request and fixes the sole executable case',()=>{
  const schema=require('../windows/worker-r2-run.schema.json');
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required.slice().sort(),maintenance.RUN_FIELDS.slice().sort());
  assert.deepEqual(Object.keys(schema.properties).sort(),maintenance.RUN_FIELDS.slice().sort());
  for(const key of ['protocol','op','sequence','case','runtimeSeconds'])assert.equal(schema.properties[key].const,examples.runRequest[key]);
});
test('migration expiry does not silently expire an already activated registration',()=>{
  const m=fresh();m.issuedAt=Math.floor(Date.now()/1000)-600;m.expiresAt=m.issuedAt+599;
  assert.doesNotThrow(()=>maintenance.buildRequest('broker','probe',m));
  assert.throws(()=>maintenance.buildRequest('helper','resume',m),{code:'MIGRATION_EXPIRED_OR_FUTURE'});
  assert.throws(()=>maintenance.invokeHelper('status',m,{onEvent:1}),{code:'MAINTENANCE_EVENT_CALLBACK_REJECTED'});
});
test('production request builder denies fixture modes and fault injection before native launch',()=>{
  const m=fresh();m.issuedAt=Math.floor(Date.now()/1000)-1;m.expiresAt=m.issuedAt+600;
  for(const mode of ['fixture-cleanup','fixture-inspect','shell','enroll'])assert.throws(()=>maintenance.buildRequest('helper',mode,m));
  assert.throws(()=>maintenance.buildRequest('helper','migrate',m,{faultAt:'AFTER_INTENTS'}));
  assert.equal(maintenance.buildRequest('helper','migrate',m,{fixture:true,faultAt:'AFTER_INTENTS'}).faultAt,'AFTER_INTENTS');
  assert.throws(()=>maintenance.buildRequest('helper','migrate',m,{fixture:true,faultAt:'AFTER_INTENTS\n'}));
});
test('recovery grant is exact, short-lived and cannot expand operations or manifests',()=>{
  const m=fresh(),grant={version:1,migrationId:m.migrationId,manifestSHA256:maintenance.hash(Buffer.from(maintenance.canonical(m))),observedStateSHA256:'a'.repeat(64),issuedAt:now-1,expiresAt:now+30,operation:'resume'};
  assert.equal(maintenance.validateRecoveryGrant(grant,m,'resume',{now}),grant);
  for(const [field,value]of [['operation','rollback'],['migrationId','other'],['manifestSHA256','b'.repeat(64)],['observedStateSHA256','a'.repeat(64)+'\n'],['issuedAt',now+1],['expiresAt',now],['expiresAt',now+1801],['secret','unexpected']]){
    assert.throws(()=>maintenance.validateRecoveryGrant({...grant,[field]:value},m,'resume',{now}),field);
  }
  const current=fresh();current.issuedAt=Math.floor(Date.now()/1000)-1;current.expiresAt=current.issuedAt+600;
  assert.throws(()=>maintenance.buildRequest('helper','recover-pointer',current),{code:'RECOVERY_GRANT_REQUIRED'});
  const schema=require('../windows/ssh-maintenance-recovery.schema.json');
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required.slice().sort(),maintenance.RECOVERY_FIELDS.slice().sort());
});
test('generated catalog embeds only fixed supplied build bytes and validates structural bounds',()=>{
  const boot={command:'python3 -I -B -c \'pass\'',payload:Buffer.from('fixed synthetic bytes'),catalogSHA256:'a'.repeat(64)};
  const source=maintenance.catalogSource(boot);assert.match(source,/public static class HubSshMaintenanceCatalog/);
  assert.ok(source.includes(boot.payload.toString('base64')));assert.ok(source.includes(maintenance.hash(boot.payload)));
  for(const invalid of [{...boot,command:'x\ny'},{...boot,command:'x'.repeat(1025)},{...boot,payload:'secret'},{...boot,catalogSHA256:'a'.repeat(64)+'\n'}])assert.throws(()=>maintenance.catalogSource(invalid));
});
