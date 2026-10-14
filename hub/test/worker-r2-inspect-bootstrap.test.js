'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),zlib=require('node:zlib'),cp=require('node:child_process');
const {buildR2InspectBootstrap}=require('../lib/worker-r2-inspect-bootstrap');
const {decode}=require('../lib/worker-channel');
const binding={nonce:'a'.repeat(64),originalCatalogSHA256:'b'.repeat(64),uid:1001,bootId:'11111111-1111-4111-8111-111111111111',runPermitSHA256:'c'.repeat(64)};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('fixed inspection catalog and compressed loader are deterministic and bounded',()=>{
  const one=buildR2InspectBootstrap({binding}),two=buildR2InspectBootstrap({binding});
  assert.equal(one.catalogSHA256,two.catalogSHA256);assert.deepEqual(one.payload,two.payload);
  assert.equal(one.payloadSHA256,hash(one.payload));assert.ok(one.commandBytes<=1024);
  assert.match(one.command,/^\/usr\/bin\/python3 -I -B -c /);
  const code=zlib.inflateSync(one.payload.subarray(4)).toString('ascii');
  assert.ok(code.includes('m.EXPECTED_BINDING='));assert.ok(code.includes('m.DIAGNOSTIC_CATALOG_SHA256='));
  assert.equal(one.payload.readUInt32BE(0),one.payload.length-4);
  assert.deepEqual(one.sources.map(x=>x.name),['stage_protocol.py','r2_inspect.py']);
  assert.notEqual(one.catalogSHA256,buildR2InspectBootstrap({binding:{...binding,nonce:'d'.repeat(64)}}).catalogSHA256);
});
test('loader rejects changed payload length, digest and truncated input before inspection',()=>{
  const boot=buildR2InspectBootstrap({binding});
  const wrongLength=Buffer.from(boot.payload);wrongLength.writeUInt32BE(1,0);
  const wrongDigest=Buffer.from(boot.payload);wrongDigest[8]^=1;
  for(const [input,status]of [[wrongLength,92],[wrongDigest,93],[boot.payload.subarray(0,10),91]]){
    const result=cp.spawnSync('python',['-I','-B','-c',boot.loader],{input,encoding:null,timeout:10000,windowsHide:true});
    assert.ifError(result.error);assert.equal(result.status,status);assert.equal(result.stdout.length,0);
  }
});
test('valid bootstrap on Windows rejects the platform with only a closed frame',()=>{
  if(process.platform!=='win32')return;
  const boot=buildR2InspectBootstrap({binding});
  const result=cp.spawnSync('python',['-I','-B','-c',boot.loader],{input:boot.payload,encoding:null,timeout:10000,windowsHide:true});
  assert.ifError(result.error);assert.equal(result.status,1);
  assert.equal(result.stdout.readUInt32BE(0),result.stdout.length-4);
  const frame=decode(result.stdout.subarray(4));assert.equal(frame.code,'LINUX_REQUIRED');assert.equal(frame.cleanupHistorical,'unknown');assert.equal(frame.providerReady,false);
});
