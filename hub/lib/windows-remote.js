'use strict';
const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),net=require('node:net'),crypto=require('node:crypto');
const {localPath}=require('./safe-path'),managed=require('./managed-process'),journal=require('./local-journal');
const fail=(code,status=409)=>Object.assign(Error('Windows HTTPS: '+code),{code,status});
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const forwarded=req=>Object.keys(req.headers).some(key=>/^(?:x-forwarded-|forwarded$|tailscale-)/i.test(key));
function dpapi(bytes,operation){
  if(process.platform!=='win32'||!Buffer.isBuffer(bytes)||bytes.length>100*1024||!['Protect','Unprotect'].includes(operation))return Promise.reject(fail('DPAPI_INPUT'));
  const script="Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $e=[Text.Encoding]::UTF8.GetBytes('ProjectHub.RemoteTLS.v1'); $r=[Security.Cryptography.ProtectedData]::"+operation+"($v,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  const executable=localPath(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'));
  return new Promise((resolve,reject)=>{
    const child=managed.spawn(executable,['-NoProfile','-NonInteractive','-Command',script],{env:{SystemRoot:process.env.SystemRoot||'C:\\Windows',WINDIR:process.env.SystemRoot||'C:\\Windows'},stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='',invalid=false;const timer=setTimeout(()=>{invalid=true;child.kill();},15000);
    child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{output+=part;if(output.length>150*1024){invalid=true;child.kill();}});child.stderr.resume();child.stdin.on('error',()=>{invalid=true;});child.on('error',()=>{invalid=true;});
    child.once('close',code=>{clearTimeout(timer);if(invalid||code!==0||!output||! /^[A-Za-z0-9+/]+={0,2}$/.test(output))reject(fail('DPAPI_FAILED'));else resolve(Buffer.from(output,'base64'));});child.stdin.end(bytes.toString('base64'));
  });
}
function bounded(file){
  const safe=localPath(file),before=fs.lstatSync(safe);if(!before.isFile()||before.nlink!==1||before.size<1||before.size>64*1024)throw fail('TLS_FILE_INVALID');
  const fd=fs.openSync(safe,'r');try{const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw fail('TLS_FILE_CHANGED');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(localPath(safe));if(bytes.length!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||current.dev!==opened.dev||current.ino!==opened.ino)throw fail('TLS_FILE_CHANGED');return{bytes,sha256:hash(bytes),fileId:String(opened.dev)+':'+String(opened.ino)};}finally{fs.closeSync(fd);}
}
function endpoint(input){
  if(!plain(input)||Object.keys(input).sort().join(',')!=='bindAddress,certFile,host,keyFile,port'||typeof input.host!=='string'||input.host!==input.host.toLowerCase()||input.host.length>253||! /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(input.host)||net.isIP(input.host)||typeof input.bindAddress!=='string'||net.isIP(input.bindAddress)!==4||!Number.isSafeInteger(input.port)||input.port<1024||input.port>65535||typeof input.certFile!=='string'||typeof input.keyFile!=='string'||!path.isAbsolute(input.certFile)||!path.isAbsolute(input.keyFile))throw fail('CONFIG_INVALID',400);
  const oct=input.bindAddress.split('.').map(Number),privateAddress=oct[0]===10||oct[0]===192&&oct[1]===168||oct[0]===172&&oct[1]>=16&&oct[1]<=31||oct[0]===100&&oct[1]>=64&&oct[1]<=127||input.host==='localhost'&&input.bindAddress==='127.0.0.1';
  if(!privateAddress)throw fail('BIND_MUST_BE_EXPLICIT_PRIVATE_ADDRESS',400);
  return{...input,origin:'https://'+input.host+':'+input.port,authority:input.host+':'+input.port};
}
function inspect(input,now){
  const config=endpoint(input),cert=bounded(config.certFile),key=bounded(config.keyFile);let x509,privateKey;
  try{x509=new crypto.X509Certificate(cert.bytes);privateKey=crypto.createPrivateKey(key.bytes);}catch{throw fail('CERTIFICATE_OR_KEY_INVALID',400);}
  if(!Number.isSafeInteger(now)||now<0||!(Date.parse(x509.validFrom)<=now&&now<Date.parse(x509.validTo))||x509.checkHost(config.host)!==config.host||!x509.checkPrivateKey(privateKey))throw fail('CERTIFICATE_IDENTITY_OR_VALIDITY',400);
  const descriptor={host:config.host,bindAddress:config.bindAddress,port:config.port,origin:config.origin,certFingerprint:x509.fingerprint256,certSubject:x509.subject,notAfter:new Date(x509.validTo).toISOString(),certHash:cert.sha256,keyHash:key.sha256,certFileId:cert.fileId,keyFileId:key.fileId};
  return{config,cert,key,descriptor};
}
class WindowsRemote{
  constructor({root,handle,now=Date.now,monotonic=()=>Number(process.hrtime.bigint()/1000000n),protect=bytes=>dpapi(bytes,'Protect'),unprotect=bytes=>dpapi(bytes,'Unprotect')}={}){
    if(typeof root!=='string'||typeof handle!=='function')throw fail('CONFIG_INVALID');Object.assign(this,{root,handle,now,monotonic,protect,unprotect});this.file=path.join(root,'_hub','remote-tls.json');this.previews=new Map();this.server=null;this.sockets=new Set();this.operation=false;this.error='';
  }
  clock(){const wall=this.now(),mono=this.monotonic();if(!Number.isSafeInteger(wall)||wall<0||!Number.isSafeInteger(mono)||mono<0)throw fail('INVALID_CLOCK');return{wall,mono};}
  preview(input){
    if(this.operation)throw fail('BUSY');const clock=this.clock();for(const[token,row]of this.previews)if(clock.wall>=row.expiresAt||clock.mono>=row.expiresMono||clock.wall<row.createdAt||clock.mono<row.createdMono)this.previews.delete(token);
    if(this.previews.size>=32)throw fail('PREVIEW_LIMIT');const inspected=inspect(input,clock.wall),token=crypto.randomBytes(32).toString('base64url');
    this.previews.set(token,{input:{...input},descriptor:inspected.descriptor,createdAt:clock.wall,createdMono:clock.mono,expiresAt:clock.wall+60000,expiresMono:clock.mono+60000});return{token,...inspected.descriptor,expiresAt:clock.wall+60000,keyReadRisk:'來源私鑰可能仍可被其他原生程序讀取；Hub 只將它的副本以目前使用者 DPAPI 保存。未變更來源 ACL、未刪除來源、未安裝憑證。'};
  }
  async configure(input){
    if(!plain(input)||Object.keys(input).sort().join(',')!=='certFingerprint,confirm,origin,token'||input.confirm!==true)throw fail('CONFIRM_REQUIRED',400);
    const clock=this.clock(),row=this.previews.get(input.token);this.previews.delete(input.token);
    if(!row||this.operation||this.server||clock.wall<row.createdAt||clock.mono<row.createdMono||clock.wall>=row.expiresAt||clock.mono>=row.expiresMono||input.origin!==row.descriptor.origin||input.certFingerprint!==row.descriptor.certFingerprint)throw fail('PREVIEW_CHANGED');
    this.operation=true;try{const current=inspect(row.input,clock.wall);if(JSON.stringify(current.descriptor)!==JSON.stringify(row.descriptor))throw fail('TLS_FILE_CHANGED');const protectedKey=await this.protect(current.key.bytes),fresh=inspect(row.input,this.clock().wall);if(JSON.stringify(fresh.descriptor)!==JSON.stringify(row.descriptor))throw fail('TLS_FILE_CHANGED');
      if(!Buffer.isBuffer(protectedKey)||protectedKey.length<1||protectedKey.length>100*1024)throw fail('DPAPI_FAILED');journal.save(this.file,{version:1,host:current.config.host,bindAddress:current.config.bindAddress,port:current.config.port,certificate:current.cert.bytes.toString('base64'),protectedKey:protectedKey.toString('base64'),certFingerprint:current.descriptor.certFingerprint,notAfter:current.descriptor.notAfter});this.error='';return this.status();
    }finally{this.operation=false;}
  }
  settings(){const raw=journal.read(this.file,256*1024);if(!raw)return null;if(!plain(raw)||Object.keys(raw).sort().join(',')!=='bindAddress,certFingerprint,certificate,host,notAfter,port,protectedKey,version'||raw.version!==1||typeof raw.certificate!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(raw.certificate)||typeof raw.protectedKey!=='string'||! /^[A-Za-z0-9+/]+={0,2}$/.test(raw.protectedKey)||raw.protectedKey.length>150*1024)throw fail('SAVED_CONFIG_INVALID');
    const config=endpoint({host:raw.host,bindAddress:raw.bindAddress,port:raw.port,certFile:path.join(this.root,'_hub','certificate.pem'),keyFile:path.join(this.root,'_hub','private.key')});let cert;try{cert=new crypto.X509Certificate(Buffer.from(raw.certificate,'base64'));}catch{throw fail('SAVED_CERTIFICATE_INVALID');}
    const now=this.clock().wall;if(!(Date.parse(cert.validFrom)<=now&&now<Date.parse(cert.validTo))||cert.checkHost(raw.host)!==raw.host||cert.fingerprint256!==raw.certFingerprint||new Date(cert.validTo).toISOString()!==raw.notAfter)throw fail('SAVED_CERTIFICATE_IDENTITY_OR_VALIDITY');return{...raw,...config};
  }
  status(){let config;try{config=this.settings();}catch(error){return{configured:false,running:false,busy:this.operation,error:error.message};}return{configured:Boolean(config),running:Boolean(this.server?.listening),busy:this.operation,error:this.error,...(config?{url:config.origin,bindAddress:config.bindAddress,certFingerprint:config.certFingerprint,notAfter:config.notAfter}:{})};}
  async start(){
    if(this.operation)throw fail('BUSY');if(this.server?.listening)return this.status();this.operation=true;
    try{const config=this.settings();if(!config)throw fail('TLS_NOT_CONFIGURED');const key=await this.unprotect(Buffer.from(config.protectedKey,'base64'));if(JSON.stringify(this.settings())!==JSON.stringify(config))throw fail('SAVED_CONFIG_CHANGED');const cert=new crypto.X509Certificate(Buffer.from(config.certificate,'base64'));if(!cert.checkPrivateKey(crypto.createPrivateKey(key)))throw fail('SAVED_KEY_MISMATCH');
      const server=https.createServer({cert:Buffer.from(config.certificate,'base64'),key,minVersion:'TLSv1.2',requestTimeout:30000,headersTimeout:15000},async(req,res)=>{
        const reject=code=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'HTTPS request refused'}));};
        if(req.headers.host!==config.authority||forwarded(req)||req.headers.authorization||req.headers.origin!==undefined&&req.headers.origin!==config.origin||!['GET','HEAD'].includes(req.method)&&req.headers.origin!==config.origin||req.headers['sec-fetch-site']==='cross-site')return reject(403);
        let url;try{url=new URL(req.url,config.origin);if(url.origin!==config.origin||url.pathname.startsWith('/api/local/')||url.pathname.startsWith('/api/mcp/')||url.pathname.startsWith('/api/commands/'))return reject(403);}catch{return reject(400);}
        try{await this.handle(req,res,url);}catch{if(!res.headersSent)reject(500);else res.destroy();}
      });
      server.on('connection',socket=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bindAddress,()=>{server.removeListener('error',reject);resolve();});});this.server=server;server.on('error',()=>{this.error='HTTPS_LISTENER_FAILED';});this.error='';return this.status();
    }catch(error){this.error=error.code||'HTTPS_START_FAILED';throw fail(this.error);}finally{this.operation=false;}
  }
  async stop(){const server=this.server;this.server=null;if(!server)return;await new Promise(resolve=>{server.close(resolve);for(const socket of this.sockets)socket.destroy();});}
}
module.exports={WindowsRemote,endpoint,dpapi,inspect};
