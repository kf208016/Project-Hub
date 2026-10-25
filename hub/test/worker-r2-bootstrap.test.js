'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {buildR2Bootstrap}=require('../lib/worker-r2-bootstrap');
const {canonical}=require('../lib/worker-channel');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixtureBuilder(){
  const file=path.join(__dirname,'../lib/worker-r2-bootstrap.js'),module={exports:{}};
  const sources={
    'stage_protocol.py':Buffer.from('pass\n'),'r2_policy.py':Buffer.from('pass\n'),
    'r2_contract.py':Buffer.from('pass\n'),'r2_runtime.py':Buffer.from('pass\n'),
    'r2_supervisor.py':Buffer.from('import sys,hashlib\ndef main():\n print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())\n return 0\n'),
  };
  const customRequire=name=>name==='node:fs'?{readFileSync:p=>sources[path.basename(p)]}:name==='./worker-channel'?{canonical:value=>canonical(JSON.parse(JSON.stringify(value)))}:require(name);
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:customRequire,module,exports:module.exports,__dirname:path.dirname(file),Buffer});
  return module.exports.buildR2Bootstrap;
}
function run(boot,payload){return cp.spawnSync('python',['-I','-B','-c',boot.loader],{input:payload,encoding:'utf8',timeout:10000,maxBuffer:32768});}
test('fixed R2 catalog accepts no alternate source or operation and binds every module',()=>{
  for(const input of [{},[],{command:'id'},'claude'])assert.throws(()=>buildR2Bootstrap(input),{code:'R2_BOOTSTRAP_ARGUMENTS_REJECTED'});
  const boot=buildR2Bootstrap();assert.equal(boot.operation,'run-r2-synthetic-v1');
  assert.deepEqual(boot.sources.map(r=>r.name),['stage_protocol.py','r2_policy.py','r2_contract.py','r2_runtime.py','r2_supervisor.py']);
  assert.equal(boot.catalogSHA256,hash(Buffer.from(canonical(boot.catalog))));
  for(const row of boot.sources){const bytes=fs.readFileSync(path.join(__dirname,'../worker',row.name));assert.equal(row.bytes,bytes.length);assert.equal(row.sha256,hash(bytes));}
  assert.equal(boot.payloadSHA256,hash(boot.payload));assert.equal(boot.commandSHA256,hash(Buffer.from(boot.command)));
});
test('fixed R2 command is one ASCII line within Git/MSYS bound',()=>{
  const boot=buildR2Bootstrap();assert.ok(boot.commandBytes<=1024);assert.match(boot.command,/^[\x20-\x7e]+$/);assert.equal(boot.payload.readUInt32BE(0),boot.compressedBytes);
  assert.ok(boot.command.startsWith('/usr/bin/python3 -I -B -c '));
  const program=zlib.inflateSync(boot.payload.subarray(4));assert.equal(hash(program),boot.programSHA256);
  const executable='C:/Program Files/Git/usr/bin/printf.exe';
  if(process.platform==='win32'&&fs.existsSync(executable)){
    const echoed=cp.spawnSync(executable,['%s',boot.command],{timeout:10000});assert.equal(echoed.status,0);assert.deepEqual(echoed.stdout,Buffer.from(boot.command));
  }
});
test('loader preserves the single following request byte-for-byte in a synthetic module fixture',()=>{
  const boot=fixtureBuilder()(),tail=Buffer.concat([Buffer.from([0,255,0,4]),Buffer.from('繁體中文')]);
  const result=run(boot,Buffer.concat([boot.payload,tail]));assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),hash(tail));
});
test('wrong length, modified payload and truncated bytes cannot execute fixed R2 loader',()=>{
  const boot=fixtureBuilder()(),length=Buffer.from(boot.payload),digest=Buffer.from(boot.payload);length.writeUInt32BE(boot.compressedBytes+1);digest[digest.length-1]^=1;
  for(const [payload,status] of [[length,92],[digest,93],[boot.payload.subarray(0,-1),91]]){
    const result=run(boot,payload);assert.equal(result.status,status,result.stderr);assert.equal(result.stdout,'');
  }
});
test('the real catalog imports completely and rejects absent run input without launching a service',()=>{
  const boot=buildR2Bootstrap(),result=run(boot,boot.payload);
  assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,'');
  if(process.platform==='win32')assert.match(result.stderr,/R2_NONROOT_LINUX_X64_REQUIRED/);
  assert.doesNotMatch(result.stderr,/Traceback|ModuleNotFoundError|SyntaxError/);
});
