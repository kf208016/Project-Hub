'use strict';
// Build-time catalog. Callers cannot supply alternative source, command or case.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {canonical}=require('./worker-channel');
const NAMES=Object.freeze(['stage_protocol.py','r2_policy.py','r2_contract.py','r2_runtime.py','r2_supervisor.py']);
const OPERATION='run-r2-synthetic-v1';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function check(value,code){if(!value)throw Object.assign(Error(code),{code});}
function buildR2Bootstrap(){
  check(arguments.length===0,'R2_BOOTSTRAP_ARGUMENTS_REJECTED');
  const sources=[],bundle={},pieces=[];
  for(const name of NAMES){
    const bytes=fs.readFileSync(path.join(__dirname,'../worker',name));
    check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=96*1024,'R2_BOOTSTRAP_SOURCE_BOUND');
    const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);pieces.push(size,bytes);
    sources.push({name,bytes:bytes.length,sha256:hash(bytes)});
    bundle[name]=zlib.deflateSync(bytes).toString('base64');
  }
  const sourceBundleSHA256=hash(Buffer.concat(pieces));
  const catalog={schemaVersion:1,operation:OPERATION,case:'isolation-v1',wireVersion:1,
    runtimeSeconds:60,sourceBundleSHA256,sources};
  const catalogSHA256=hash(Buffer.from(canonical(catalog)));
  let program='import base64,zlib,types,sys\n';
  for(const row of sources){
    const name=row.name.slice(0,-3);
    program+='m=types.ModuleType('+JSON.stringify(name)+');sys.modules['+JSON.stringify(name)+']=m\n';
    program+='exec(compile(zlib.decompress(base64.b64decode('+JSON.stringify(bundle[row.name])+')),'+JSON.stringify(row.name)+',"exec"),m.__dict__)\n';
  }
  program+='m=sys.modules["r2_supervisor"]\n';
  program+='m.CATALOG_SHA256='+JSON.stringify(catalogSHA256)+'\n';
  program+='m.SOURCE_BUNDLE_SHA256='+JSON.stringify(sourceBundleSHA256)+'\n';
  program+='m.SOURCE_BUNDLE='+JSON.stringify(bundle)+'\n';
  program+='m.SOURCE_IDENTITIES='+JSON.stringify(sources)+'\n';
  program+='sys.exit(m.main())\n';
  const code=Buffer.from(program,'ascii'),compressed=zlib.deflateSync(code);
  check(code.length<=384*1024&&compressed.length>0&&compressed.length<=128*1024,'R2_BOOTSTRAP_PROGRAM_BOUND');
  const loader=[
    'import sys,hashlib,zlib,struct,signal',
    'if sys.platform=="linux":signal.alarm(100)',
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
    'd=zlib.decompressobj();s=d.decompress(b,'+(code.length+1)+')',
    'if len(s)!='+code.length+' or not d.eof or d.unused_data or d.unconsumed_tail or hashlib.sha256(s).hexdigest()!="'+hash(code)+'":sys.exit(94)',
    'exec(compile(s,"project-hub-fixed-r2-bootstrap","exec"))',
  ].join('\n');
  const encodedLoader=zlib.deflateSync(Buffer.from(loader,'ascii')).toString('base64');
  const command='/usr/bin/python3 -I -B -c \'exec(__import__("zlib").decompress(__import__("base64").b64decode("'+encodedLoader+'")))\'';
  check(/^[\x20-\x7e]+$/.test(command)&&Buffer.byteLength(command)<=1024,'R2_BOOTSTRAP_COMMAND_BOUND');
  const prefix=Buffer.alloc(4);prefix.writeUInt32BE(compressed.length);
  const payload=Buffer.concat([prefix,compressed]);
  return {operation:OPERATION,catalog,catalogSHA256,sourceBundleSHA256,sources,
    command,commandBytes:Buffer.byteLength(command),commandSHA256:hash(Buffer.from(command)),
    payload,payloadBytes:payload.length,payloadSHA256:hash(payload),
    compressedBytes:compressed.length,compressedSHA256:hash(compressed),
    programBytes:code.length,programSHA256:hash(code),loader};
}
module.exports={buildR2Bootstrap};
