'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {create}=require('../lib/grok-auth-route');
const port=12345,runId='synthetic-run-id-1234',token='s'.repeat(43),target='http://127.0.0.1:'+port+'/api/native/grok-token';
function fixture(extra={}){
  const calls=[],records=[];let time=0;
  const route=create({port,runId,token,mint:async o=>{calls.push(o);return {access_token:'synthetic-access',expires_in:99,ignored:'not-output'};},now:()=>time,record:(...r)=>records.push(r),...extra});
  return {route,calls,records,advance:n=>{time+=n;}};
}
async function request(f,changes={}){
  const body=changes.body??Buffer.from('{"expired":false}');
  const headers={Host:'127.0.0.1:'+port,'X-Hub':'1',Authorization:'Bearer '+token,'X-Hub-Grok-Run':runId,'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),'X-Hub-Grok-Nonce':crypto.randomUUID(),...changes.headers};
  const raw=Object.entries(headers).filter(([,v])=>v!==undefined).flat();raw.push(...(changes.extraHeaders||[]));
  const req=Object.assign(new EventEmitter(),{method:'POST',url:target,...changes.request,rawHeaders:raw});
  const res={headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},end(bytes){this.body=JSON.parse(bytes);}};
  const promise=f.route.handle(req,res);if(changes.abort)req.emit('aborted');else{req.emit('data',body);req.emit('end');}await promise;
  assert.equal(res.headers['cache-control'],'no-store');return res;
}
test('route mints exact boolean requests and exact token JSON without logging secrets',async()=>{
  const f=fixture();for(const expired of [false,true]){const r=await request(f,{body:Buffer.from(JSON.stringify({expired}))});assert.equal(r.statusCode,200);assert.deepEqual(r.body,{access_token:'synthetic-access',expires_in:99});}
  assert.deepEqual(f.calls,[{expired:false},{expired:true}]);
  assert.deepEqual(f.records.map(x=>x[1]),[false,true].map(expired=>({runId,outcome:'ok',expired,expiresIn:99})));
  assert.ok(!JSON.stringify(f.records).includes(token));assert.ok(!JSON.stringify(f.records).includes('synthetic-access'));
});
test('route rejects complete header matrix including case-insensitive duplicates',async t=>{
  const bad=[{Host:undefined},{Host:'localhost:'+port},{'X-Hub':undefined},{'X-Hub':'0'},{Authorization:undefined},{Authorization:'Bearer '+'x'.repeat(43)},{Authorization:'Bearer short'},{'X-Hub-Grok-Run':'other'},{'X-Hub-Grok-Run':undefined},
    {'Content-Type':'text/plain'},{'Content-Type':undefined},...['0','257','-1','1.0','1e2',' 1','01'].map(x=>({'Content-Length':x})),{'Content-Length':undefined},
    {'X-Hub-Grok-Nonce':undefined},{'X-Hub-Grok-Nonce':crypto.randomUUID().toUpperCase()},{'X-Hub-Grok-Nonce':'00000000-0000-1000-8000-000000000000'},
    ...['Cookie','Transfer-Encoding','X-Forwarded-For','X-Forwarded-Host','Forwarded','Tailscale-User-Login'].map(k=>({[k]:'anything'}))];
  for(let i=0;i<bad.length;i++)await t.test('invalid header '+i,async()=>{const f=fixture();assert.equal((await request(f,{headers:bad[i]})).statusCode,403);assert.equal(f.calls.length,0);});
  for(const name of ['host','authorization','x-hub','content-length','connection']){
    const f=fixture();assert.equal((await request(f,{headers:{Connection:'close'},extraHeaders:[name,name==='connection'?'close':'duplicate']})).statusCode,403);
  }
  assert.equal((await request(fixture(),{headers:{'Content-Type':'application/json; charset=utf-8'}})).statusCode,200);
});
test('route rejects method, target, replay, malformed body, length mismatch and invalid UTF-8',async()=>{
  const f=fixture();assert.equal((await request(f,{request:{method:'GET'}})).statusCode,405);assert.equal((await request(f,{request:{url:target+'?x=1'}})).statusCode,404);
  const nonce=crypto.randomUUID();assert.equal((await request(f,{headers:{'X-Hub-Grok-Nonce':nonce}})).statusCode,200);assert.equal((await request(f,{headers:{'X-Hub-Grok-Nonce':nonce}})).statusCode,403);
  for(const body of ['{}','[]','null','{"expired":1}','{"expired":true,"other":1}','not-json',Buffer.from([0xff])])assert.equal((await request(fixture(),{body})).statusCode,400);
  for(const length of ['1','100'])assert.equal((await request(fixture(),{headers:{'Content-Length':length}})).statusCode,400);
  assert.equal((await request(fixture(),{abort:true})).statusCode,400);
});
test('route rate limit has three tokens and refills one each twenty seconds',async()=>{
  const f=fixture();for(let i=0;i<3;i++)assert.equal((await request(f)).statusCode,200);
  assert.equal((await request(f)).statusCode,429);f.advance(19999);assert.equal((await request(f)).statusCode,429);f.advance(1);assert.equal((await request(f)).statusCode,200);assert.equal((await request(f)).statusCode,429);
  f.advance(100000);for(let i=0;i<3;i++)assert.equal((await request(f)).statusCode,200);assert.equal((await request(f)).statusCode,429);
});
test('route retains at most sixty-four nonces and still rejects recent replay',async()=>{
  const f=fixture();let first,last;
  for(let i=0;i<65;i++){f.advance(20000);last=crypto.randomUUID();first??=last;assert.equal((await request(f,{headers:{'X-Hub-Grok-Nonce':last}})).statusCode,200);}
  assert.equal((await request(f,{headers:{'X-Hub-Grok-Nonce':last}})).statusCode,403);
  f.advance(20000);assert.equal((await request(f,{headers:{'X-Hub-Grok-Nonce':first}})).statusCode,200);
});
test('route returns fixed unavailable for mint exceptions and invalid output',async()=>{
  for(const value of [null,[],{access_token:'',expires_in:1},{access_token:'x\nsecret',expires_in:1},{access_token:'x'.repeat(8193),expires_in:1},{access_token:'valid',expires_in:0},{access_token:'valid',expires_in:1.5}]){
    const f=fixture({mint:async()=>value}),r=await request(f);assert.equal(r.statusCode,503);assert.deepEqual(r.body,{error:'GROK_AUTH_ROUTE_UNAVAILABLE'});
  }
  assert.equal((await request(fixture({mint:async()=>{throw Error('synthetic secret');}}))).statusCode,503);
});
test('route closes immediately and never delivers an in-flight minted token after close',async()=>{
  const f=fixture();f.route.close();assert.equal((await request(f)).statusCode,410);assert.equal(f.calls.length,0);
  let resolve;const g=fixture({mint:()=>new Promise(r=>{resolve=r;})});const pending=request(g);await Promise.resolve();g.route.close();resolve({access_token:'secret',expires_in:1});assert.equal((await pending).statusCode,410);
});
