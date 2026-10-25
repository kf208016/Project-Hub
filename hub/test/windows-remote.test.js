'use strict';
const {waitForHub,waitFor}=require('./helpers/wait-hub');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{spawn}=require('../lib/managed-process'),{WindowsRemote,endpoint}=require('../lib/windows-remote');
const win=process.platform==='win32'?test:test.skip;
async function port(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const value=s.address().port;await new Promise(resolve=>s.close(resolve));return value;}
function certificate(root){
  const certFile=path.join(root,'synthetic-certificate.pem'),keyFile=path.join(root,'synthetic-private.key'),config=path.join(root,'openssl.cnf');fs.writeFileSync(config,'[req]\ndistinguished_name=dn\n[dn]\n');
  execFileSync(path.join(process.env.ProgramFiles||'C:\\Program Files','Git/usr/bin/openssl.exe'),['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-config',config],{windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000});return{certFile,keyFile};
}
function secureRequest(config,certificate,route,{body,headers={},cookie}={}){
  return new Promise((resolve,reject)=>{const data=body===undefined?null:JSON.stringify(body),req=https.request({hostname:'127.0.0.1',port:config.port,path:route,servername:'localhost',ca:certificate,checkServerIdentity:(_,cert)=>tls.checkServerIdentity('localhost',cert),method:data?'POST':'GET',headers:{Host:config.host+':'+config.port,...(data?{'Content-Type':'application/json','X-Hub':'1',Origin:'https://'+config.host+':'+config.port}:{}),...(cookie?{Cookie:cookie}:{}),...headers}},res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)});});});req.on('error',reject);if(data)req.write(data);req.end();});
}
win('Windows HTTPS binds an exact private endpoint, protects its key with real DPAPI and refuses replay/changed files',{timeout:60000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-tls-')),config={host:'localhost',bindAddress:'127.0.0.1',port:await port(),...certificate(root)},cert=fs.readFileSync(config.certFile),key=fs.readFileSync(config.keyFile);let calls=0;
  const remote=new WindowsRemote({root,handle:(req,res)=>{calls++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');}});t.after(async()=>{await remote.stop();fs.rmSync(root,{recursive:true,force:true});});
  for(const bad of [{...config,bindAddress:'0.0.0.0'},{...config,bindAddress:'203.0.113.2'},{...config,host:'other.example'},{...config,port:'4546'},{...config,extra:true}])assert.throws(()=>remote.preview(bad));
  const stale=remote.preview(config);fs.appendFileSync(config.keyFile,'\n');await assert.rejects(remote.configure({token:stale.token,confirm:true,origin:stale.origin,certFingerprint:stale.certFingerprint}),/TLS_FILE_CHANGED/);fs.writeFileSync(config.keyFile,key);
  const preview=remote.preview(config);assert.equal(remote.status().configured,false);await remote.configure({token:preview.token,confirm:true,origin:preview.origin,certFingerprint:preview.certFingerprint});assert.equal(remote.status().configured,true);assert.equal(remote.status().running,false);await assert.rejects(remote.configure({token:preview.token,confirm:true,origin:preview.origin,certFingerprint:preview.certFingerprint}));
  const saved=fs.readFileSync(path.join(root,'_hub','remote-tls.json'),'utf8');assert.equal(saved.includes('PRIVATE KEY'),false);assert.equal(saved.includes(key.toString('base64')),false);
  await remote.start();assert.equal(remote.status().running,true);assert.equal((await secureRequest(config,cert,'/')).status,200);
  for(const request of [{headers:{Host:'other.example:'+config.port}},{headers:{'X-Forwarded-For':'100.64.0.7'}},{headers:{Authorization:'Bearer '+crypto.randomBytes(32).toString('base64url')}},{headers:{Origin:'https://other.example'}},{headers:{'Sec-Fetch-Site':'cross-site'}}])assert.equal((await secureRequest(config,cert,'/',request)).status,403);
  for(const route of ['/api/local/login','/api/mcp/tools','/api/commands/decide'])assert.equal((await secureRequest(config,cert,route)).status,403);
  assert.equal((await secureRequest(config,cert,'/api/change',{body:{ok:true},headers:{Origin:''}})).status,403);assert.equal((await secureRequest(config,cert,'/api/change',{body:{ok:true}})).status,200);assert.equal(calls,2);
  await remote.stop();assert.equal(remote.status().running,false);
});
win('Actual Windows Hub HTTPS has separate remote sessions, Origin gates and local-only control APIs',{timeout:90000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-remote-http-')),config={host:'localhost',bindAddress:'127.0.0.1',port:await port(),...certificate(root)},cert=fs.readFileSync(config.certFile),localPort=await port(),secret=crypto.randomBytes(32).toString('base64url');
  const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{cwd:path.join(__dirname,'..'),env:{...process.env,HUB_ROOT:root,HUB_AI_HOME:path.join(root,'empty-home'),HUB_PORT:String(localPort),HUB_LOCAL_TOKEN:secret,HUB_DRY_RUN:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});let stderr='';child.stderr.on('data',part=>{stderr+=part;});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('close',resolve));}fs.rmSync(root,{recursive:true,force:true});});const base='http://127.0.0.1:'+localPort;
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Hub':'1',...headers},body:JSON.stringify(body)});await waitForHub(base,child,()=>stderr);
  const login=await post('/api/local/login',{token:secret}),localCookie=login.headers.get('set-cookie').split(';')[0],local={};
  const previewResult=await post('/api/remote/tls/preview',config,local);assert.equal(previewResult.status,200,await previewResult.clone().text());const preview=await previewResult.json();assert.equal((await post('/api/remote/tls/configure',{token:preview.token,origin:preview.origin,certFingerprint:preview.certFingerprint,confirm:true},local)).status,200);
  assert.equal((await post('/api/remote',{passcode:'synthetic HTTPS passphrase'},local)).status,200);const enabled=await post('/api/remote',{enabled:true},local);assert.equal(enabled.status,200,await enabled.clone().text());assert.equal((await enabled.json()).tls.running,true);
  assert.equal((await secureRequest(config,cert,'/api/state',{cookie:localCookie})).status,401,'local cookie is not a remote session');assert.equal((await secureRequest(config,cert,'/api/state')).status,401);
  assert.equal((await secureRequest(config,cert,'/api/login',{body:{passcode:'wrong'}})).status,401);const remoteLogin=await secureRequest(config,cert,'/api/login',{body:{passcode:'synthetic HTTPS passphrase'}});assert.equal(remoteLogin.status,200);const cookie=remoteLogin.headers['set-cookie'][0].split(';')[0];assert.match(remoteLogin.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await secureRequest(config,cert,'/api/state',{cookie})).status,200);assert.equal((await fetch(base+'/api/state',{headers:{Cookie:cookie}})).status,200,'local access does not depend on cookies');
  assert.equal((await secureRequest(config,cert,'/api/project/new',{cookie,body:{name:'Synthetic TLS project'}})).status,200);
  assert.equal((await secureRequest(config,cert,'/api/project/new',{cookie,body:{name:'must refuse'},headers:{Origin:'https://evil.example'}})).status,403);
  for(const route of ['/api/mcp/capability','/api/mcp/capability/revoke','/api/commands/decide','/api/commands/cancel','/api/workspace-destination/preview','/api/workspace-destination/approve','/api/native-provider/preview','/api/native-provider/approve','/api/native-provider/revoke','/api/chatgpt/register/preview','/api/chatgpt/register','/api/remote/tls/preview'])assert.equal((await secureRequest(config,cert,route,{cookie,body:{}})).status,403);
  assert.equal((await secureRequest(config,cert,'/api/remote',{cookie,body:{enabled:false}})).status,403);
  assert.equal((await post('/api/remote/logout-all',{},local)).status,200);assert.equal((await secureRequest(config,cert,'/api/state',{cookie})).status,401);
  assert.equal((await post('/api/remote',{enabled:false},local)).status,200);assert.equal(stderr.includes(secret),false);assert.equal(stderr.includes('PRIVATE KEY'),false);
});
