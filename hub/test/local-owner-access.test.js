'use strict';
// Policy regression without native helpers: execute the production listener and
// owner predicates with explicit service fixtures. This is not native acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm'),crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const ownerSource=source.slice(source.indexOf('const fromRemote ='),source.indexOf('const sessions ='));
const allowedSource=source.slice(source.indexOf('function allowed(req)'),source.indexOf('function readBody(req)'));
const listenerSource=source.slice(source.indexOf('const server = http.createServer'),source.indexOf('\nfunction shutdown()'));
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
const readBody=async req=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}');};
function request(port,route,{method='GET',headers={},body}={}){
 return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:'127.0.0.1:'+port,Connection:'close',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,value:text?JSON.parse(text):null}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
test('production local listener allows no-cookie traffic, preserves request boundaries and launcher proof/login',async t=>{
 const reqCtx=new AsyncLocalStorage(),secret='L'.repeat(43),localAuth=require('../lib/local-auth').create(secret),token='M'.repeat(43);
 const context=vm.createContext({http,URL,process:{platform:'win32'},reqCtx,localAuth,browserLogin:null,remoteLib:require('../lib/remote'),send,readBody,PORT:0,
  mcpCapabilities:{inspect:(value,run)=>{assert.equal(value,token);assert.equal(run,'fixture-run');return{fixture:true};}},
  api:(req,res,url)=>send(res,200,{route:url.pathname,mcp:Boolean(reqCtx.getStore()?.mcpScope)}),
  serveStatic:(res,route)=>send(res,200,{route}),remoteGate:()=>assert.fail('Windows main listener must never forward relay traffic'),nativeWorkspaceError:e=>({error:e.message})});
 vm.runInContext(ownerSource+allowedSource+listenerSource+'\nglobalThis.listener=server;',context);
 const server=context.listener;await new Promise(r=>server.listen(0,'127.0.0.1',r));context.PORT=server.address().port;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const call=(route,options)=>request(context.PORT,route,options),post=(route,body={},headers={})=>call(route,{method:'POST',headers:{'X-Hub':'1',...headers},body});
 assert.equal((await call('/api/state')).status,200);
 assert.equal((await call('/api/state',{headers:{Host:'localhost:'+context.PORT,Cookie:'stale=1'}})).status,200);
 assert.equal((await post('/api/project/new')).status,200);
 for(const method of ['POST','PUT','DELETE','HEAD'])assert.equal((await call('/api/project/new',{method})).status,403);
 assert.equal((await post('/api/project/new',{}, {Origin:'https://foreign.invalid'})).status,403);
 assert.equal((await call('/api/state',{headers:{Host:'foreign.invalid'}})).status,403);
 for(const header of ['x-forwarded-for','x-forwarded-host','tailscale-user-login'])for(const value of ['','synthetic'])assert.equal((await call('/api/state',{headers:{[header]:value}})).status,403);
 for(const authorization of ['', 'Basic synthetic', 'Bearer '+token]){
  assert.equal((await post('/api/commands/decide',{}, {Authorization:authorization})).status,403);
  assert.equal((await post('/api/task/new',{}, {Authorization:authorization,Cookie:localAuth.cookie})).status,403);
 }
 const scoped=await call('/api/mcp/tools',{headers:{Authorization:'Bearer '+token,'X-Hub-Mcp-Run':'fixture-run'}});assert.equal(scoped.status,200);assert.equal(scoped.value.mcp,true);
 assert.equal((await call('/api/mcp/tools',{headers:{Authorization:'Bearer wrong'}})).status,403);
 assert.equal((await call('/api/state')).value.mcp,false,'scope does not leak into the next local request');
 assert.equal((await post('/api/local/login',{token:'wrong'})).status,403);
 const login=await post('/api/local/login',{token:secret});assert.equal(login.status,200);assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
 const challenge='a'.repeat(64),proof=await call('/api/local/proof?challenge='+challenge);assert.equal(proof.status,200);assert.equal(proof.value.proof,crypto.createHmac('sha256',secret).update('project-hub-instance-v1:'+challenge).digest('hex'));
 assert.equal((await call('/api/local/proof?challenge=bad')).status,400);
});

const ownerLines=source.split('\n').filter(line=>line.includes('!localOwner(req)')&&!line.includes("url.pathname.startsWith('/api/')"));
test('every production owner predicate accepts local no-cookie requests and rejects scoped or remote requests',()=>{
 assert.equal(ownerLines.length,10,'inventory every replaced owner-check site');
 for(const line of ownerLines){
  const condition=line.slice(line.indexOf('if')+2,line.indexOf('return send')).trim();
  const reqCtx=new AsyncLocalStorage(),req={headers:{}},context=vm.createContext({reqCtx,req,process:{platform:'win32'},localAuth:{},nativeMcpRegistration:{},nativeProviderService:{},nativeRemote:{},b:{confirm:true,id:'00000000-0000-4000-8000-000000000000'}});
  vm.runInContext(ownerSource,context);const refused=()=>Boolean(vm.runInContext(condition,context));
  assert.equal(refused(),false,line);
  assert.equal(reqCtx.run({mcpScope:{fixture:true}},refused),true,line);
  const webHandoff=line.includes('!fromRemote()&&');
  assert.equal(reqCtx.run({remote:true},refused),!webHandoff,line);
  for(const authorization of ['', 'Basic synthetic', 'Bearer '+'M'.repeat(43)]){req.headers.authorization=authorization;assert.equal(refused(),true,line);}
 }
});

test('recovery listener permits local no-cookie inspection and preview but refuses all relay markers',async t=>{
 const filename=path.join(__dirname,'../lib/web-chat-recovery-server.js'),realRequire=require('node:module').createRequire(filename);
 class WebChat {async recoverPreview(){return{fixture:true};}}
 const customRequire=name=>name==='./safe-path'?{localPath:value=>value}:name==='./web-chat'?{WebChat}:name==='./procwatch'?{create:()=>({})}:realRequire(name);
 const context=vm.createContext({require:customRequire,module:{exports:{}},Buffer,TextDecoder,URL,setTimeout});vm.runInContext(fs.readFileSync(filename,'utf8'),context);
 const {server}=context.module.exports.create({root:'unused-fixture-root',hubDir:path.join(__dirname,'..'),port:0,secret:'R'.repeat(43),admission:{recoveryOnly:true,format:'web-manual-v2',pending:[],inspection:[]}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(const route of ['/api/state','/api/web-chat/inspection'])assert.equal((await request(port,route)).status,200);
 const post=(headers={})=>request(port,'/api/web-chat/recover/preview',{method:'POST',headers:{'X-Hub':'1',...headers},body:{actor:'chatgpt',project:'p',task:'t',receiptId:'fixture'}});
 assert.equal((await post()).status,200);
 for(const header of ['x-forwarded-for','x-forwarded-host','tailscale-user-login'])for(const value of ['','synthetic']){
  assert.equal((await request(port,'/api/state',{headers:{[header]:value}})).status,403);
  assert.equal((await post({[header]:value})).status,403);
 }
 for(const headers of [{Authorization:''},{Authorization:'Bearer '+'M'.repeat(43)},{'X-Hub':''},{Origin:'https://foreign.invalid'},{Host:'foreign.invalid'}])assert.equal((await post(headers)).status,403);
 assert.equal((await request(port,'/api/task/new',{method:'POST',headers:{'X-Hub':'1'},body:{}})).status,409);
});

test('launcher opens the browser only and keeps token, instance proof and stop/restart login',()=>{
 const launcher=fs.readFileSync(path.join(__dirname,'../start-windows.ps1'),'utf8');
 assert.doesNotMatch(launcher,/browser-login-approve\.ps1|\$approvalPowerShell|\$approvalScript/);
 assert.match(launcher,/--app=\$url/);assert.match(launcher,/HUB_LOCAL_TOKEN/);assert.match(launcher,/\/api\/local\/proof/);assert.equal(launcher.match(/\/api\/local\/login/g).length,2);
 assert.match(source,/process\.platform === 'win32' && !localAuth/);
 assert.match(source,/server\.listen\(PORT, '127\.0\.0\.1'/);
});
