'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const diagnostic=require('../lib/ssh-r2-diagnostic'),bootstrap=require('../lib/worker-r2-inspect-bootstrap');
const {decode,canonical}=require('../lib/worker-channel');
const examples=require('../windows/ssh-r2-diagnostic-examples.json');
const schema=require('../windows/ssh-r2-diagnostic.schema.json');
function fixture(){
  const grant=structuredClone(examples.accepted);
  const capsule={ManifestReference:grant.manifestReference,ManifestSHA256:grant.manifestSHA256,DestinationBindingSHA256:grant.destinationBindingSHA256,RunNonce:grant.runNonce,OriginalCatalogSHA256:grant.originalCatalogSHA256,RunPermitSHA256:grant.runPermitSHA256,ReviewReference:grant.reviewReference,ReviewDocumentReference:'C:\\Synthetic\\repo\\docs\\diagnostic.md',ReviewDocumentSHA256:grant.reviewDocumentSHA256,FailureEvidenceReference:'C:\\Synthetic\\evidence.json',FailureEvidenceSHA256:grant.failureEvidenceSHA256,GrantRoot:grant.grantRoot,GrantRootFingerprint:grant.grantRootFingerprint,Uid:grant.uid,BootId:grant.bootId};
  const build={capsule,sha256:grant.helperSHA256,sourceHash:grant.sourceSetSHA256,catalog:{catalogSHA256:grant.diagnosticCatalogSHA256,payloadSHA256:grant.diagnosticPayloadSHA256,payloadLength:grant.diagnosticPayloadLength}};
  return {grant,build};
}
const opts={now:examples.validationTime};
test('closed schema and examples agree with the runtime grant contract',()=>{
  assert.deepEqual([...schema.required].sort(),[...diagnostic.GRANT_FIELDS].sort());
  assert.deepEqual(Object.keys(schema.properties).sort(),[...diagnostic.GRANT_FIELDS].sort());
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(diagnostic.validateGrant(examples.accepted,opts),examples.accepted);
  for(const row of examples.rejected)assert.throws(()=>diagnostic.validateGrant(row.value,opts),row.reason);
  const {grant,build}=fixture();assert.deepEqual(diagnostic.buildRequest(grant,build,opts),{mode:diagnostic.OPERATION,grant});
});
test('grant rejects expiry, future issue, oversized windows and wrong numeric types',()=>{
  const {grant}=fixture();
  for(const changes of [{expiresAt:opts.now},{issuedAt:opts.now+1},{expiresAt:grant.issuedAt+601},{uid:true},{issuedAt:String(grant.issuedAt)},{deadlineSeconds:46},{maxOutputBytes:131073},{maxSessions:2},{diagnosticPayloadLength:0},{expiresAt:2147483648}])assert.throws(()=>diagnostic.validateGrant({...grant,...changes},opts));
});
test('identities, paths and the operation reject alternate encodings and extra input',()=>{
  const {grant}=fixture();
  for(const changes of [{runNonce:'0'.repeat(64)},{runNonce:grant.runNonce+'\n'},{bootId:'00000000-0000-0000-0000-000000000000'},{bootId:grant.bootId.toUpperCase()},{grantId:'11111111-1111-1111-1111-111111111111'},{manifestReference:'C:\\Synthetic\\..\\other.json'},{grantRoot:'C:\\Synthetic\\diagnostic\\'},{operation:'run-r2-synthetic-v1'},{command:'shell'},{source:'python'},{argv:[]},{provider:'grok'}]){
    if(changes.bootId===grant.bootId)continue;
    assert.throws(()=>diagnostic.validateGrant({...grant,...changes},opts));
  }
  const missing={...grant};delete missing.helperSHA256;assert.throws(()=>diagnostic.validateGrant(missing,opts));
  const duplicated=canonical(grant).replace('"uid":1001','"uid":1001,"uid":1001');assert.throws(()=>decode(Buffer.from(duplicated)));
});
test('grant cannot swap the reviewed capsule, original run or native build',()=>{
  const {grant,build}=fixture();
  for(const key of ['manifestSHA256','destinationBindingSHA256','runNonce','originalCatalogSHA256','runPermitSHA256','reviewDocumentSHA256','failureEvidenceSHA256','grantRootFingerprint','helperSHA256','sourceSetSHA256','diagnosticCatalogSHA256','diagnosticPayloadSHA256'])assert.throws(()=>diagnostic.buildRequest({...grant,[key]:'b'.repeat(64)},build,opts));
  for(const changes of [{uid:1002},{bootId:'22222222-2222-4222-8222-222222222222'},{manifestReference:'C:\\Other\\manifest.json'},{grantRoot:'C:\\Other\\diagnostic'},{diagnosticPayloadLength:4097}])assert.throws(()=>diagnostic.buildRequest({...grant,...changes},build,opts));
});
test('bootstrap accepts only typed fixed identities, with no code or executable input',()=>{
  const binding={nonce:'a'.repeat(64),originalCatalogSHA256:'b'.repeat(64),uid:1001,bootId:'11111111-1111-4111-8111-111111111111',runPermitSHA256:'c'.repeat(64)};
  assert.equal(bootstrap.validateBinding(binding),binding);
  for(const changes of [{command:'shell'},{source:'python'},{uid:true},{uid:0},{nonce:'0'.repeat(64)},{runPermitSHA256:'x'.repeat(64)}])assert.throws(()=>bootstrap.validateBinding({...binding,...changes}));
  assert.throws(()=>bootstrap.buildR2InspectBootstrap());assert.throws(()=>bootstrap.buildR2InspectBootstrap({binding,source:'python'}));
});
test('production source lists preserve all frozen vault and R2 modules',()=>{
  assert.deepEqual(bootstrap.NAMES,['stage_protocol.py','r2_inspect.py']);
  assert.equal(diagnostic.SOURCE_NAMES.includes('ssh-maintenance-entry.cs'),false);
  assert.equal(diagnostic.SOURCE_NAMES.includes('ssh-maintenance-state.cs'),false);
  assert.equal(diagnostic.SOURCE_NAMES.includes('ssh-vault-store.cs'),false);
  const controller=fs.readFileSync(path.join(__dirname,'../lib/ssh-r2-diagnostic.js'),'utf8');
  assert.match(controller,/child\.stdin\.end\(\)/);
  assert.equal(controller.includes('HUB_SSH_MAINTENANCE_REQUEST'),false);
});
