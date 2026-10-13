'use strict';
const crypto=require('node:crypto'),zlib=require('node:zlib');
const NAMES=['stage_protocol.py','stage_fs_checks.py','private_stage.py'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function check(value,code){if(!value)throw Object.assign(Error(code),{code});}
function buildBootstrap(sources){
  check(Array.isArray(sources)&&sources.length===NAMES.length,'WORKER_BOOTSTRAP_SOURCES_REJECTED');
  let program='import base64,zlib,types,sys;';
  const identities=[];
  for(let i=0;i<NAMES.length;i++){
    const row=sources[i];check(row&&row.name===NAMES[i]&&Buffer.isBuffer(row.bytes)&&row.bytes.length>0&&row.bytes.length<=64*1024,'WORKER_BOOTSTRAP_SOURCE_BOUND');
    const name=row.name.slice(0,-3),encoded=zlib.deflateSync(row.bytes).toString('base64');
    program+='m=types.ModuleType("'+name+'");sys.modules["'+name+'"]=m;exec(compile(zlib.decompress(base64.b64decode("'+encoded+'")),"'+row.name+'","exec"),m.__dict__);';
    identities.push({name:row.name,bytes:row.bytes.length,sha256:hash(row.bytes)});
  }
  program+='sys.exit(sys.modules["private_stage"].main())';
  const code=Buffer.from(program),compressed=zlib.deflateSync(code);
  check(code.length<=288*1024&&compressed.length>0&&compressed.length<=64*1024,'WORKER_BOOTSTRAP_PROGRAM_BOUND');
  const loader=[
    'import sys,hashlib,zlib,struct,signal',
    'if sys.platform=="linux":signal.alarm(540)',
    'r=sys.stdin.buffer',
    'def x(n):',
    ' b=bytearray()',
    ' while len(b)<n:',
    '  c=r.read(n-len(b))',
    '  if not c:sys.exit(91)',
    '  b.extend(c)',
    ' return bytes(b)',
    'n=struct.unpack("!I",x(4))[0]',
    'if n!='+compressed.length+':sys.exit(92)',
    'b=x(n)',
    'if hashlib.sha256(b).hexdigest()!="'+hash(compressed)+'":sys.exit(93)',
    'd=zlib.decompressobj()',
    's=d.decompress(b,'+(code.length+1)+')',
    'if len(s)!='+code.length+' or not d.eof or d.unused_data or d.unconsumed_tail or hashlib.sha256(s).hexdigest()!="'+hash(code)+'":sys.exit(94)',
    'exec(compile(s,"project-hub-bootstrap","exec"))',
  ].join('\n');
  const command="python3 -I -B -c '"+loader+"'";
  check(!loader.includes("'")&&Buffer.byteLength(command)<=1024,'WORKER_BOOTSTRAP_COMMAND_BOUND');
  const prefix=Buffer.alloc(4);prefix.writeUInt32BE(compressed.length);
  return {command,loader,payload:Buffer.concat([prefix,compressed]),sources:identities,commandBytes:Buffer.byteLength(command),compressedBytes:compressed.length,programBytes:code.length,compressedSHA256:hash(compressed),programSHA256:hash(code)};
}
module.exports={buildBootstrap};
