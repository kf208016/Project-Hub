'use strict';
// Real loopback requests with synthetic cookies; no real Hub/provider startup.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {create}=require('../lib/browser-login-http'),{BrowserLoginFSM}=require('../lib/browser-login');
async function fixture(t){
  let handler,reads=0,now=1000;
  const auth=require('../lib/local-auth').create('S'.repeat(43));
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{try{if(!await handler.handle(req,res,new URL(req.url,'http://'+req.headers.host)))send(res,404,{});}catch{send(res,500,{error:'fixture_failure'});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,base='http://127.0.0.1:'+port;
  const fsm=new BrowserLoginFSM({now:()=>now});
  handler=create({auth,port,fsm,send,readBody:async req=>{reads++;const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('bound');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const owner=auth.cookie.split(';')[0];
  async function request(route,body={},headers={},method='POST'){
    const h={'X-Hub':'1','Content-Type':'application/json',Origin:base,...headers};for(const key of Object.keys(h))if(h[key]===null)delete h[key];
    // Native HTTP preserves deliberately invalid Host; fetch silently rewrites it.
    const payload=typeof body==='string'?body:JSON.stringify(body);
    return await new Promise((resolve,reject)=>{
      const request=http.request(base+'/api/local/browser/'+route,{method,headers:h},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
        response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,body:JSON.parse(text),text,cookies:response.headers['set-cookie']||[],headers:{get:name=>response.headers[name]??null}});});
      });
      request.on('error',reject);request.setTimeout(5000,()=>request.destroy(Error('fixture_timeout')));request.end(method==='GET'?undefined:payload);
    });
  }
  async function begin(){const r=await request('begin');assert.equal(r.status,200);return {id:r.body.requestId,cookie:r.cookies[0].split(';')[0],response:r};}
  return {request,begin,owner,fsm,base,port,reads:()=>reads,setTime:value=>{now=value;}};
}
test('HTTP pending cookie requires exact owner approval and consumes once',async t=>{
  const f=await fixture(t),b=await f.begin();
  assert.deepEqual(Object.keys(b.response.body).sort(),['expiresInSeconds','ok','requestId']);
  assert.match(b.id,/^[a-f0-9]{32}$/);assert.equal(b.response.body.expiresInSeconds,60);
  const pending=b.response.cookies[0],nonce=b.cookie.split('.').at(-1);
  for(const attr of ['HttpOnly','SameSite=Strict','Path=/api/local/browser','Max-Age=60'])assert.ok(pending.includes(attr));
  assert.equal(b.response.text.includes(nonce),false);assert.equal(b.response.headers.get('cache-control'),'no-store');
  assert.deepEqual((await f.request('poll',{requestId:b.id},{Cookie:b.cookie})).body,{ok:false,pending:true});
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie})).status,202);
  assert.equal((await f.request('approve',{requestId:b.id},{Cookie:f.owner,Origin:null})).status,200);
  assert.equal((await f.request('approve',{requestId:b.id},{Cookie:f.owner})).status,409);
  const done=await f.request('poll',{requestId:b.id},{Cookie:b.cookie});assert.equal(done.status,200);assert.deepEqual(done.body,{ok:true});
  assert.equal(done.cookies.length,2);assert.ok(done.cookies.some(value=>value.startsWith(f.owner+';')));assert.ok(done.cookies.some(value=>value.includes('Max-Age=0')&&value.includes('Path=/api/local/browser')));
  assert.equal(done.text.includes(nonce),false);assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie})).status,409);
});
test('HTTP public ID, owner cookie alone, wrong nonce and mismatched cookie ID cannot consume',async t=>{
  const f=await fixture(t),b=await f.begin();await f.request('approve',{requestId:b.id},{Cookie:f.owner});
  for(const Cookie of [null,f.owner,b.cookie.replace(/.$/,b.cookie.endsWith('0')?'1':'0'),b.cookie.replace(b.id,'f'.repeat(32))]){
    assert.equal((await f.request('poll',{requestId:b.id},{Cookie})).status,409);
  }
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie})).status,200);
});
test('HTTP pending, missing, invalid, bearer and duplicate cookies cannot approve before body read',async t=>{
  const f=await fixture(t),b=await f.begin();
  for(const headers of [{},{Cookie:b.cookie},{Cookie:'hub_local_session=invalid'},{Cookie:f.owner,Authorization:'Bearer synthetic'},{Cookie:f.owner+'; '+f.owner}]){
    const before=f.reads(),r=await f.request('approve',{requestId:b.id},headers);assert.ok([400,403].includes(r.status));assert.equal(f.reads(),before);
  }
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie})).status,202);
});
test('HTTP exact origin, host, X-Hub and transport guards reject foreign callers',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:null},{Origin:'https://foreign.invalid'},{Host:'foreign.invalid'},{'X-Hub':null},{'X-Hub':'0'},{Authorization:'Bearer synthetic'},{Forwarded:'for=synthetic'},{'X-Forwarded-For':'synthetic'},{'X-Forwarded-Host':'synthetic'},{'X-Real-IP':'synthetic'}]){
    const result=await f.request('begin',{},headers);
    assert.ok([400,403].includes(result.status),Object.keys(headers).join(',')+' status='+result.status);
  }
  const b=await f.begin();
  assert.equal((await f.request('approve',{requestId:b.id},{Cookie:f.owner,Origin:'http://localhost:'+f.port})).status,403);
  assert.equal((await f.request('approve',{requestId:b.id},{Cookie:f.owner,Origin:null})).status,200);
});
test('HTTP malformed body, method, query, content type, duplicate own cookies fail closed',async t=>{
  const f=await fixture(t);
  for(const body of [[],null,1,'"scalar"',{extra:1},'{broken']){
    const r=await f.request('begin',body);assert.equal(r.status,400);
  }
  for(const body of [{requestId:''},{requestId:'a'.repeat(31)},{requestId:'A'.repeat(32)},{requestId:'a'.repeat(33)},{requestId:'a'.repeat(32),actor:'owner'}])assert.equal((await f.request('poll',body)).status,400);
  assert.equal((await f.request('begin?unexpected=1')).status,400);
  assert.equal((await f.request('begin',{}, {'Content-Type':'text/plain'})).status,400);
  assert.equal((await f.request('begin',{}, {},'GET')).status,405);
  assert.equal((await f.request('begin',{}, {},'PUT')).status,405);
  assert.equal((await f.request('begin',{padding:'x'.repeat(1100)})).status,400);
  // another localhost app's cookie is none of our business, whatever its size (see the foreign-cookie test below)
  assert.equal((await f.request('begin',{}, {Cookie:'x='.concat('x'.repeat(8192))})).status,200);
  const b=await f.begin();assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie+'; '+b.cookie})).status,400);
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:'hub_local_pending_'+f.port+'=malformed'})).status,409);
});
test('HTTP enforces eight pending requests, exact expiry and independent approvals',async t=>{
  const f=await fixture(t),all=[];for(let i=0;i<8;i++)all.push(await f.begin());
  assert.equal((await f.request('begin')).status,409);
  const b=all[0],other=all[1];await f.request('approve',{requestId:b.id},{Cookie:f.owner});
  assert.equal((await f.request('poll',{requestId:other.id},{Cookie:other.cookie})).status,202);
  f.setTime(60999);assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie})).status,200);
  f.setTime(61000);assert.equal((await f.request('approve',{requestId:other.id},{Cookie:f.owner})).status,409);
  assert.equal((await f.request('poll',{requestId:other.id},{Cookie:other.cookie})).status,409);assert.equal((await f.request('begin')).status,200);
});
test('HTTP constructor and non-loopback sockets cannot create approval authority',async()=>{
  const auth={check:()=>true,cookie:'synthetic=owner'},readBody=async()=>({}),send=()=>{};
  for(const port of [0,80,1023,65536,1.2,'4545'])assert.throws(()=>create({auth,port,readBody,send}));
  assert.throws(()=>create({auth:{},port:4545,readBody,send}));
  const results=[],handler=create({auth,port:4545,readBody,send:(_res,status,value)=>results.push({status,value})});
  const req={method:'POST',headers:{host:'127.0.0.1:4545',origin:'http://127.0.0.1:4545','x-hub':'1','content-type':'application/json'},socket:{remoteAddress:'198.51.100.1'}};
  assert.equal(await handler.handle(req,{},new URL('http://127.0.0.1:4545/api/local/browser/begin')),true);assert.equal(results[0].status,403);
  assert.equal(await handler.handle(req,{},new URL('http://127.0.0.1:4545/api/not-login')),false);
});

test('HTTP cookies of OTHER localhost apps never block the routes; duplicates of the Hub own cookies are still refused',async t=>{
  // Browsers share cookies between ports, so another app on 127.0.0.1 can leave duplicate or very large cookies behind.
  const f=await fixture(t),foreign='csrftoken=1; csrftoken=2; session='+'x'.repeat(9000),b=await f.begin();
  assert.equal((await f.request('begin',{},{Cookie:foreign})).status,200);
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie+'; '+foreign})).status,202);
  assert.equal((await f.request('approve',{requestId:b.id},{Cookie:f.owner+'; '+foreign})).status,200);
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:b.cookie+'; '+b.cookie})).status,400);
  assert.ok([400,403].includes((await f.request('approve',{requestId:b.id},{Cookie:f.owner+'; '+f.owner})).status));
  assert.equal((await f.request('poll',{requestId:b.id},{Cookie:foreign+'; '+b.cookie})).status,200);
});