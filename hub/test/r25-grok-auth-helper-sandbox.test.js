'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const helper=path.resolve(__dirname,'../lib/grok-auth-helper-sandbox.js');
const route={version:1,port:12345,runId:'synthetic-run-123456',token:'s'.repeat(43)},password='a'.repeat(64);
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r25-sandbox-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const file=path.join(home,'hub-grok-auth.json');fs.writeFileSync(file,JSON.stringify(route));
  return {home,file};
}
function run(home,proxy,extra={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[helper],{env:{...process.env,GROK_HOME:home,HTTP_PROXY:proxy,HUB_SECRET:'synthetic-env-secret',...extra},stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
async function broker(t,handler){
  const server=http.createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return 'http://hub:'+password+'@127.0.0.1:'+server.address().port;
}
test('sandbox helper proxy contract, boolean expired and exact stdout',async t=>{
  const f=fixture(t);let requests=0;
  const proxy=await broker(t,(req,res)=>{
    requests++;assert.equal(req.method,'POST');assert.equal(req.url,'http://127.0.0.1:'+route.port+'/api/native/grok-token');
    assert.deepEqual(Object.keys(req.headers).sort(),['authorization','connection','content-length','content-type','host','proxy-authorization','x-hub','x-hub-grok-nonce','x-hub-grok-run'].sort());
    assert.equal(req.headers.host,'127.0.0.1:'+route.port);assert.equal(req.headers.authorization,'Bearer '+route.token);assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('hub:'+password).toString('base64'));assert.equal(req.headers['x-hub'],'1');assert.equal(req.headers['x-hub-grok-run'],route.runId);assert.equal(req.headers['content-type'],'application/json');
    assert.match(req.headers['x-hub-grok-nonce'],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{assert.equal(req.headers['content-length'],String(Buffer.byteLength(body)));assert.deepEqual(JSON.parse(body),{expired:requests===2});res.end('{"access_token":"synthetic-access","expires_in":60,"ignored":true}');});
  });
  const preload=path.join(f.home,'preload.js');fs.writeFileSync(preload,"process.on('exit',()=>{if(Object.keys(process.env).some(k=>/^HUB_/i.test(k)||/^HTTP_PROXY$/i.test(k)))process.exitCode=99;});");
  for(const expired of ['0','1'])assert.deepEqual(await run(f.home,proxy,{GROK_AUTH_EXPIRED:expired,NODE_OPTIONS:'--require='+JSON.stringify(preload)}),{code:0,stdout:'{"access_token":"synthetic-access","expires_in":60}',stderr:''});
  assert.equal(requests,2);
});
test('sandbox helper rejects 503, garbage, oversized, malformed and invalid UTF-8 replies',async t=>{
  const f=fixture(t);let reply;
  const proxy=await broker(t,(req,res)=>{req.resume();res.statusCode=reply.status||200;res.end(reply.body);});
  for(reply of [{status:503,body:'secret'},{body:'garbage'},{body:'x'.repeat(4097)},{body:'[]'},{body:'{"access_token":"","expires_in":1}'},{body:'{"access_token":"x","expires_in":0}'},{body:'{"access_token":"x","expires_in":1.5}'},{body:Buffer.from([0xff])}]){
    const r=await run(f.home,proxy);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.match(r.stderr,/^grok-auth-helper-sandbox: (UNAVAILABLE|RESPONSE_INVALID)\n$/);
  }
});
test('sandbox helper stops after five-second deadline',async t=>{
  const f=fixture(t),proxy=await broker(t,req=>req.resume()),start=Date.now();
  const r=await run(f.home,proxy);assert.deepEqual(r,{code:1,stdout:'',stderr:'grok-auth-helper-sandbox: TIMEOUT\n'});assert.ok(Date.now()-start>=4900);assert.ok(Date.now()-start<12000);
});
test('sandbox helper rejects absent or invalid route and proxy before any request',async t=>{
  const f=fixture(t);let requests=0;const proxy=await broker(t,(req,res)=>{requests++;res.end('{}');});
  for(const data of [null,[],{}, {...route,version:2},{...route,port:65536},{...route,port:0},{...route,runId:'short'},{...route,token:'short'}]){
    fs.writeFileSync(f.file,JSON.stringify(data));const r=await run(f.home,proxy);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'grok-auth-helper-sandbox: ROUTE_INVALID\n');
  }
  fs.writeFileSync(f.file,'x'.repeat(1025));assert.equal((await run(f.home,proxy)).code,1);fs.unlinkSync(f.file);assert.equal((await run(f.home,proxy)).code,1);
  fs.writeFileSync(f.file,JSON.stringify(route));
  for(const invalid of ['',proxy.replace('127.0.0.1','localhost'),proxy.replace('hub:','other:'),proxy+'/',proxy.replace(/:\d+$/,':65536')]){const r=await run(f.home,invalid);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'grok-auth-helper-sandbox: PROXY_INVALID\n');}
  assert.equal(requests,0);
});
test('sandbox cmd is exactly three CRLF lines',()=>{
  assert.equal(fs.readFileSync(path.join(__dirname,'../lib/grok-auth-helper-sandbox.cmd'),'utf8'),'@echo off\r\n"%HUB_NODE%" "%~dp0grok-auth-helper-sandbox.js"\r\nexit /b %ERRORLEVEL%\r\n');
});
