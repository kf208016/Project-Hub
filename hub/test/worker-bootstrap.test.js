'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs');
const {buildBootstrap}=require('../lib/worker-bootstrap');
const fixture=()=>[
  {name:'stage_protocol.py',bytes:Buffer.from('# '+('"繁體中文"'.repeat(1800))+'\n')},
  {name:'stage_fs_checks.py',bytes:Buffer.from('pass\n')},
  {name:'private_stage.py',bytes:Buffer.from('import sys,hashlib\ndef main():\n b=sys.stdin.buffer.read()\n print(hashlib.sha256(b).hexdigest())\n return 0\n')},
];
function run(boot,payload){return cp.spawnSync('python',['-I','-B','-c',boot.loader],{input:payload,encoding:'utf8',timeout:10000,maxBuffer:32768});}
test('worker bootstrap keeps quoted argv short and preserves MSYS argv exactly',()=>{
  const boot=buildBootstrap(fixture());assert.ok(boot.commandBytes<=1024);assert.ok(boot.programBytes>0);
  assert.equal(boot.payload.readUInt32BE(0),boot.payload.length-4);
  const executable='C:/Program Files/Git/usr/bin/printf.exe';
  if(process.platform==='win32'&&fs.existsSync(executable)){
    const echo=cp.spawnSync(executable,['%s',boot.command],{timeout:10000});assert.equal(echo.status,0);assert.deepEqual(echo.stdout,Buffer.from(boot.command));
  }
});
test('worker source transport retains subsequent binary frames in the same buffered stdin',()=>{
  const boot=buildBootstrap(fixture()),tail=Buffer.concat([Buffer.from([0,255,0,4]),Buffer.from('繁體中文')]);
  const result=run(boot,Buffer.concat([boot.payload,tail]));assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),require('node:crypto').createHash('sha256').update(tail).digest('hex'));
});
test('wrong length, corrupt source digest and truncated source cannot execute bootstrap',()=>{
  const boot=buildBootstrap(fixture()),wrongLength=Buffer.from(boot.payload),wrongDigest=Buffer.from(boot.payload);wrongLength.writeUInt32BE(boot.compressedBytes+1);wrongDigest[wrongDigest.length-1]^=1;
  for(const [payload,status]of [[wrongLength,92],[wrongDigest,93],[boot.payload.subarray(0,-1),91]]){const result=run(boot,payload);assert.equal(result.status,status,result.stderr);assert.equal(result.stdout,'');}
});
test('worker bootstrap rejects unknown, missing, reordered and oversized module sources',()=>{
  const rows=fixture();assert.throws(()=>buildBootstrap(rows.slice(1)));assert.throws(()=>buildBootstrap([rows[1],rows[0],rows[2]]));
  assert.throws(()=>buildBootstrap([{name:'untrusted.py',bytes:Buffer.from('pass')},...rows.slice(1)]));
  assert.throws(()=>buildBootstrap([{name:rows[0].name,bytes:Buffer.alloc(65537)},...rows.slice(1)]));
});
