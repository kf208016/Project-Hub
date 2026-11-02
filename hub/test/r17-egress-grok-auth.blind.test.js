'use strict';
// R17 / A1 blind acceptance: a refresh-only egress provider 'grok-auth' admits
// exactly auth.x.ai:443. Turn providers keep their host lists. Every CONNECT
// here stays on loopback; the admitted tunnel uses a vm copy of the broker with
// test-only DNS and dial substitution, so no name is resolved and no vendor is
// contacted.
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('node:net'),crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const egress=require('../lib/provider-egress');

const TURN_HOSTS=Object.freeze({claude:['api.anthropic.com','claude.ai'],grok:['api.x.ai','cli-chat-proxy.grok.com']});
const DENIED_FOR_REFRESH=[
  'api.x.ai:443','cli-chat-proxy.grok.com:443','x.ai:443','accounts.x.ai:443','auth.grok.com:443','grok.com:443',
  'evil.auth.x.ai:443','auth.x.ai.evil.example:443','authx.ai:443','api.anthropic.com:443','claude.ai:443',
  'auth.x.ai:80','auth.x.ai:8443','auth.x.ai:4443','auth.x.ai:0','auth.x.ai','auth.x.ai.:443','auth.x.ai:443:443'
];

function u16(n){const b=Buffer.alloc(2);b.writeUInt16BE(n,0);return b;}
function u24(n){const b=Buffer.alloc(3);b[0]=(n>>16)&0xff;b[1]=(n>>8)&0xff;b[2]=n&0xff;return b;}
function buildClientHello(sniHost){
  const hostBuf=Buffer.from(sniHost,'ascii');
  const nameEntry=Buffer.concat([Buffer.from([0]),u16(hostBuf.length),hostBuf]);
  const sniExtData=Buffer.concat([u16(nameEntry.length),nameEntry]);
  const extsBuf=Buffer.concat([u16(0),u16(sniExtData.length),sniExtData]);
  const body=Buffer.concat([Buffer.from([3,3]),crypto.randomBytes(32),Buffer.from([0]),u16(2),Buffer.from([0x13,0x01]),
    Buffer.from([1,0]),u16(extsBuf.length),extsBuf]);
  const handshake=Buffer.concat([Buffer.from([1]),u24(body.length),body]);
  return Buffer.concat([Buffer.from([22,3,3]),u16(handshake.length),handshake]);
}
function proxyParts(u){
  const m=/^http:\/\/([^:]+):([^@]+)@127\.0\.0\.1:(\d+)$/.exec(u);
  assert.ok(m,'proxyUrl shape');
  return {user:m[1],pass:m[2],port:Number(m[3])};
}
// One CONNECT on loopback; resolves with the proxy's response head (or '' on close).
function connectOnce(broker,authority,{hostHeader=authority,keep=false}={}){
  const {user,pass,port}=proxyParts(broker.proxyUrl);
  const auth='Basic '+Buffer.from(user+':'+pass).toString('base64');
  const sock=net.connect(port,'127.0.0.1');
  return new Promise(resolve=>{
    let buf='';let done=false;
    const end=value=>{if(done)return;done=true;if(!keep)sock.destroy();resolve({head:value,sock});};
    sock.setEncoding('latin1');sock.on('error',()=>end(buf));
    sock.on('data',d=>{buf+=d;if(buf.includes('\r\n\r\n'))end(buf.slice(0,buf.indexOf('\r\n\r\n')));});
    sock.on('close',()=>end(buf));
    sock.write('CONNECT '+authority+' HTTP/1.1\r\nHost: '+hostHeader+'\r\nProxy-Authorization: '+auth+'\r\n\r\n');
  });
}
// The broker module evaluated with test-only dns and net; records every lookup and dial.
function syntheticEgress(upstreamPort){
  const lookups=[],dials=[];
  const source=fs.readFileSync(require.resolve('../lib/provider-egress'),'utf8'),module={exports:{}};
  const context={module,exports:module.exports,Buffer,process,setTimeout,clearTimeout,Promise,require:name=>{
    if(name==='./native-turn-limits')return require('../lib/native-turn-limits');
    if(name==='dns')return {promises:{lookup:async(host,opts)=>{lookups.push(host);return [{address:'1.1.1.1',family:4}];}}};
    if(name==='net')return {...net,connect:o=>{dials.push(o);return net.connect(upstreamPort||1,'127.0.0.1');}};
    return require(name);
  }};
  vm.runInNewContext(source,context,{filename:'synthetic-r17-egress.js'});
  // Options are built inside the vm realm so the plain-object check sees its own Object.prototype.
  const create=options=>vm.runInNewContext('module.exports.create('+JSON.stringify(options)+')',context);
  return {create,lookups,dials};
}

test('A1 PROVIDER_HOSTS gains exactly grok-auth = [auth.x.ai]; turn lists are unchanged',()=>{
  const {PROVIDER_HOSTS}=egress._internal;
  assert.deepEqual(Object.keys(PROVIDER_HOSTS).sort(),['claude','grok','grok-auth']);
  assert.deepEqual([...PROVIDER_HOSTS['grok-auth']],['auth.x.ai']);
  assert.deepEqual([...PROVIDER_HOSTS.grok],TURN_HOSTS.grok);
  assert.deepEqual([...PROVIDER_HOSTS.claude],TURN_HOSTS.claude);
  assert.ok(Object.isFrozen(PROVIDER_HOSTS['grok-auth']));
  assert.equal(PROVIDER_HOSTS.grok.includes('auth.x.ai'),false);
  assert.equal(PROVIDER_HOSTS.claude.includes('auth.x.ai'),false);
});

test('A1 parseAuthority with the grok-auth list admits only auth.x.ai:443',()=>{
  const {parseAuthority,PROVIDER_HOSTS}=egress._internal;
  assert.ok(Array.isArray(PROVIDER_HOSTS['grok-auth']),'grok-auth list exists');
  assert.equal(parseAuthority('auth.x.ai:443',PROVIDER_HOSTS['grok-auth']),'auth.x.ai');
  for(const authority of DENIED_FOR_REFRESH)
    assert.equal(parseAuthority(authority,PROVIDER_HOSTS['grok-auth']),null,authority);
  // Turn lists never admit the login host.
  assert.equal(parseAuthority('auth.x.ai:443',PROVIDER_HOSTS.grok),null);
  assert.equal(parseAuthority('auth.x.ai:443',PROVIDER_HOSTS.claude),null);
});

test('A1 create accepts grok-auth with the same option rules and limits',async()=>{
  const broker=await egress.create({provider:'grok-auth'});
  try{
    proxyParts(broker.proxyUrl);
    const snap=broker.snapshot();
    assert.equal(snap.provider,'grok-auth');assert.equal(snap.closed,false);assert.equal(snap.accepted,0);
  }finally{await broker.close();}
  // The refresher asks for timeoutMs + 10000 (30000 with the default timeout).
  const timed=await egress.create({provider:'grok-auth',maxWallMs:30000});await timed.close();
  await assert.rejects(()=>egress.create({provider:'grok-auth',maxWallMs:1800001}));
  await assert.rejects(()=>egress.create({provider:'grok-auth',maxConnections:100}));
  await assert.rejects(()=>egress.create({provider:'grok-auth',hosts:['api.x.ai']}));
  for(const provider of ['grok_auth','GROK-AUTH','grok-auth ','auth','grok-login','x.ai'])
    await assert.rejects(()=>egress.create({provider}),undefined,provider);
});

test('A1 live grok-auth broker denies every other host and port with 403 and audits the denial',async()=>{
  const audits=[];
  const broker=await egress.create({provider:'grok-auth',onAudit:e=>{audits.push(e);}});
  try{
    for(const authority of DENIED_FOR_REFRESH.filter(a=>/:\d+$/.test(a)&&a.split(':').length===2&&!a.includes('.:'))){
      const {head}=await connectOnce(broker,authority);
      assert.match(head,/^HTTP\/1\.1 403 /,authority);
    }
    const snap=broker.snapshot();
    assert.equal(snap.accepted,0);assert.equal(snap.activeConnections,0);
    assert.ok(audits.length>0);
    assert.ok(audits.every(e=>e.provider==='grok-auth'));
    assert.ok(audits.every(e=>e.event==='denied'&&e.code==='forbidden-authority'));
  }finally{await broker.close();}
});

test('A1 live grok-auth broker admits auth.x.ai:443 (no lookup before the ClientHello)',async()=>{
  const audits=[];
  const broker=await egress.create({provider:'grok-auth',onAudit:e=>{audits.push(e);}});
  try{
    const {head,sock}=await connectOnce(broker,'auth.x.ai:443',{keep:true});
    sock.destroy();
    assert.match(head,/^HTTP\/1\.1 200 /);
    assert.ok(audits.some(e=>e.event==='accepted-connect'&&e.hostname==='auth.x.ai'&&e.provider==='grok-auth'));
    assert.equal(broker.snapshot().accepted,1);
  }finally{await broker.close();}
});

test('A1 turn brokers grok and claude still deny auth.x.ai:443',async()=>{
  for(const provider of ['grok','claude']){
    const broker=await egress.create({provider});
    try{
      const {head}=await connectOnce(broker,'auth.x.ai:443');
      assert.match(head,/^HTTP\/1\.1 403 /,provider);
      assert.equal(broker.snapshot().accepted,0);
    }finally{await broker.close();}
  }
});

test('A1 synthetic tunnel: grok-auth forwards an auth.x.ai ClientHello through test DNS/dial only',{timeout:15000},async t=>{
  const reply=Buffer.from('synthetic-upstream-bytes');
  const seen=[];
  const upstream=net.createServer(socket=>{socket.on('error',()=>{});socket.once('data',d=>{seen.push(d);socket.end(reply);});});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
  const synthetic=syntheticEgress(upstream.address().port);
  const broker=await synthetic.create({provider:'grok-auth'});t.after(()=>broker.close());
  const {user,pass,port}=proxyParts(broker.proxyUrl);
  const socket=net.connect(port,'127.0.0.1');t.after(()=>socket.destroy());
  const hello=buildClientHello('auth.x.ai');
  const chunks=[];let header=Buffer.alloc(0),ready=false;
  socket.on('data',chunk=>{
    if(ready){chunks.push(chunk);return;}
    header=Buffer.concat([header,chunk]);const at=header.indexOf('\r\n\r\n');if(at<0)return;
    assert.match(header.subarray(0,at).toString(),/ 200 /);ready=true;
    if(header.length>at+4)chunks.push(header.subarray(at+4));
    socket.write(hello);
  });
  const ended=new Promise((resolve,reject)=>{socket.once('error',reject);socket.once('close',resolve);});
  socket.write('CONNECT auth.x.ai:443 HTTP/1.1\r\nHost: auth.x.ai:443\r\nProxy-Authorization: Basic '+Buffer.from(user+':'+pass).toString('base64')+'\r\n\r\n');
  await ended;
  assert.deepEqual(Buffer.concat(chunks),reply);
  assert.deepEqual(synthetic.lookups,['auth.x.ai']);
  assert.equal(synthetic.dials.length,1);assert.equal(synthetic.dials[0].port,443);
  assert.deepEqual(Buffer.concat(seen).subarray(0,hello.length),hello);
});

test('A1 synthetic tunnel: grok-auth refuses an SNI that is not auth.x.ai and never dials',{timeout:15000},async t=>{
  const synthetic=syntheticEgress(0);
  const broker=await synthetic.create({provider:'grok-auth',helloTimeoutMs:2000});t.after(()=>broker.close());
  const {user,pass,port}=proxyParts(broker.proxyUrl);
  const socket=net.connect(port,'127.0.0.1');t.after(()=>socket.destroy());
  let header='';
  socket.on('data',chunk=>{header+=chunk.toString('latin1');if(header.includes('\r\n\r\n')&&/ 200 /.test(header))socket.write(buildClientHello('api.x.ai'));});
  const ended=new Promise(resolve=>{socket.once('error',resolve);socket.once('close',resolve);});
  socket.write('CONNECT auth.x.ai:443 HTTP/1.1\r\nHost: auth.x.ai:443\r\nProxy-Authorization: Basic '+Buffer.from(user+':'+pass).toString('base64')+'\r\n\r\n');
  await ended;
  assert.deepEqual(synthetic.lookups,[]);assert.equal(synthetic.dials.length,0);
});

test('A1 synthetic broker: api.x.ai and cli-chat-proxy.grok.com never reach lookup or dial under grok-auth',{timeout:15000},async t=>{
  const synthetic=syntheticEgress(0);
  const broker=await synthetic.create({provider:'grok-auth'});t.after(()=>broker.close());
  for(const authority of ['api.x.ai:443','cli-chat-proxy.grok.com:443','auth.x.ai:80']){
    const {head}=await connectOnce(broker,authority);
    assert.match(head,/^HTTP\/1\.1 403 /,authority);
  }
  assert.deepEqual(synthetic.lookups,[]);assert.equal(synthetic.dials.length,0);
});
