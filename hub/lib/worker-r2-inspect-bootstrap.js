'use strict';
// Fixed read-only operation. The caller can bind identities, never source or argv.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {canonical}=require('./worker-channel');
const NAMES=Object.freeze(['stage_protocol.py','r2_inspect.py']);
const BINDING_FIELDS=Object.freeze(['nonce','originalCatalogSHA256','uid','bootId','runPermitSHA256']);
const OPERATION='inspect-r2-run-v1',SHA=/^[a-f0-9]{64}$(?![\s\S])/;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(yes,code)=>{if(!yes)throw Object.assign(Error(code),{code});};
function validateBinding(binding){
  check(binding&&Object.getPrototypeOf(binding)===Object.prototype&&Object.keys(binding).length===BINDING_FIELDS.length&&BINDING_FIELDS.every(k=>Object.hasOwn(binding,k)),'R2_INSPECT_BINDING_FIELDS');
  for(const k of ['nonce','originalCatalogSHA256','runPermitSHA256'])check(typeof binding[k]==='string'&&SHA.test(binding[k]),'R2_INSPECT_BINDING_DIGEST');
  check(binding.nonce!=='0'.repeat(64),'R2_INSPECT_BINDING_NONCE');
  check(Number.isSafeInteger(binding.uid)&&binding.uid>0&&binding.uid<=2147483647,'R2_INSPECT_BINDING_UID');
  check(typeof binding.bootId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/.test(binding.bootId)&&binding.bootId!=='00000000-0000-0000-0000-000000000000','R2_INSPECT_BINDING_BOOT');
  return binding;
}
function buildR2InspectBootstrap({binding}={}){
  check(arguments.length===1&&arguments[0]&&Object.keys(arguments[0]).length===1,'R2_INSPECT_BUILD_ARGUMENTS');
  validateBinding(binding);
  const sources=[],bundle={},pieces=[];
  for(const name of NAMES){
    const bytes=fs.readFileSync(path.join(__dirname,'../worker',name));
    check(bytes.length>0&&bytes.length<=96*1024,'R2_INSPECT_SOURCE_BOUND');
    const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);pieces.push(size,bytes);
    sources.push({name,bytes:bytes.length,sha256:hash(bytes)});bundle[name]=zlib.deflateSync(bytes).toString('base64');
  }
  const sourceBundleSHA256=hash(Buffer.concat(pieces));
  const catalog={schemaVersion:1,operation:OPERATION,wireVersion:1,binding,sourceBundleSHA256,sources,
    deadlineSeconds:45,maxOutputBytes:131072,maxJSONFileBytes:32768,maxJSONFiles:10};
  const catalogSHA256=hash(Buffer.from(canonical(catalog)));
  let program='import base64,zlib,types,sys\n';
  for(const row of sources){
    const name=row.name.slice(0,-3);
    program+='m=types.ModuleType('+JSON.stringify(name)+');sys.modules['+JSON.stringify(name)+']=m\n';
    program+='exec(compile(zlib.decompress(base64.b64decode('+JSON.stringify(bundle[row.name])+')),'+JSON.stringify(row.name)+',"exec"),m.__dict__)\n';
  }
  program+='m=sys.modules["r2_inspect"]\n';
  program+='m.EXPECTED_BINDING='+canonical(binding)+'\n';
  program+='m.DIAGNOSTIC_CATALOG_SHA256="'+catalogSHA256+'"\n';
  program+='sys.exit(m.main())\n';
  const code=Buffer.from(program,'ascii'),compressed=zlib.deflateSync(code);
  check(code.length<=384*1024&&compressed.length>0&&compressed.length<=128*1024,'R2_INSPECT_PROGRAM_BOUND');
  const loader=[
    'import sys,hashlib,zlib,struct,signal',
    'if sys.platform=="linux":signal.alarm(45)',
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
    'exec(compile(s,"project-hub-fixed-r2-inspection","exec"))',
  ].join('\n');
  const encoded=zlib.deflateSync(Buffer.from(loader,'ascii')).toString('base64');
  const command='/usr/bin/python3 -I -B -c \'exec(__import__("zlib").decompress(__import__("base64").b64decode("'+encoded+'")))\'';
  check(/^[\x20-\x7e]+$/.test(command)&&Buffer.byteLength(command)<=1024,'R2_INSPECT_COMMAND_BOUND');
  const prefix=Buffer.alloc(4);prefix.writeUInt32BE(compressed.length);const payload=Buffer.concat([prefix,compressed]);
  return {operation:OPERATION,catalog,catalogSHA256,sourceBundleSHA256,sources,command,commandBytes:Buffer.byteLength(command),
    payload,payloadSHA256:hash(payload),payloadBytes:payload.length,programBytes:code.length,programSHA256:hash(code),loader};
}
module.exports={OPERATION,NAMES,BINDING_FIELDS,validateBinding,buildR2InspectBootstrap};
