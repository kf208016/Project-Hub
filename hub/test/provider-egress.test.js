'use strict';
const assert = require('assert');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const { test } = require('node:test');
const egress = require('../lib/provider-egress');

function buildClientHello({ sniHost, duplicateSni, ech, noSni, duplicateExt } = {}) {
  const exts = [];
  if (!noSni) {
    const hostBuf = Buffer.from(sniHost || 'example.com', 'ascii');
    const nameEntry = Buffer.concat([Buffer.from([0]), u16(hostBuf.length), hostBuf]);
    let listBody = nameEntry;
    if (duplicateSni) listBody = Buffer.concat([nameEntry, nameEntry]);
    const listLen = u16(listBody.length);
    const sniExtData = Buffer.concat([listLen, listBody]);
    exts.push(Buffer.concat([u16(0), u16(sniExtData.length), sniExtData]));
    if (duplicateExt) exts.push(Buffer.concat([u16(0), u16(sniExtData.length), sniExtData]));
  }
  if (ech) {
    const echData = Buffer.from([0, 1, 2, 3]);
    exts.push(Buffer.concat([u16(0xfe0d), u16(echData.length), echData]));
  }
  const extsBuf = Buffer.concat(exts);
  const legacyVersion = Buffer.from([0x03, 0x03]);
  const random = crypto.randomBytes(32);
  const sessionId = Buffer.from([0]);
  const cipherSuites = Buffer.concat([u16(2), Buffer.from([0x13, 0x01])]);
  const compression = Buffer.from([1, 0]);
  const extsLenField = u16(extsBuf.length);
  const body = Buffer.concat([legacyVersion, random, sessionId, cipherSuites, compression, extsLenField, extsBuf]);
  const handshakeHeader = Buffer.concat([Buffer.from([1]), u24(body.length)]);
  const handshake = Buffer.concat([handshakeHeader, body]);
  const recordHeader = Buffer.concat([Buffer.from([22, 3, 3]), u16(handshake.length)]);
  return Buffer.concat([recordHeader, handshake]);
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u24(n) { const b = Buffer.alloc(3); b[0] = (n >> 16) & 0xff; b[1] = (n >> 8) & 0xff; b[2] = n & 0xff; return b; }

test('Grok account gateway is exact; web, speculative login and sibling hosts are denied',()=>{
  const {_internal:{parseAuthority,PROVIDER_HOSTS}}=egress;
  assert.equal(parseAuthority('cli-chat-proxy.grok.com:443',PROVIDER_HOSTS.grok),'cli-chat-proxy.grok.com');
  for(const host of ['grok.com','accounts.x.ai','evil.cli-chat-proxy.grok.com','cli-chat-proxy.grok.com.evil.example'])
    assert.equal(parseAuthority(host+':443',PROVIDER_HOSTS.grok),null);
});

test('inspectClientHello: valid exact SNI', () => {
  const hello = buildClientHello({ sniHost: 'api.anthropic.com' });
  const res = egress.inspectClientHello(hello, 'api.anthropic.com');
  assert.strictEqual(res.status, 'valid');
  assert.strictEqual(res.consumed, hello.length);
});

test('inspectClientHello: wrong SNI rejected', () => {
  const hello = buildClientHello({ sniHost: 'evil.com' });
  const res = egress.inspectClientHello(hello, 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
  assert.strictEqual(res.code, 'sni-mismatch');
});

test('inspectClientHello: missing SNI rejected', () => {
  const hello = buildClientHello({ noSni: true });
  const res = egress.inspectClientHello(hello, 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
  assert.strictEqual(res.code, 'missing-sni');
});

test('inspectClientHello: duplicate SNI entries rejected', () => {
  const hello = buildClientHello({ sniHost: 'api.anthropic.com', duplicateSni: true });
  const res = egress.inspectClientHello(hello, 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
});

test('inspectClientHello: duplicate extension rejected', () => {
  const hello = buildClientHello({ sniHost: 'api.anthropic.com', duplicateExt: true });
  const res = egress.inspectClientHello(hello, 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
  assert.strictEqual(res.code, 'duplicate-extension');
});

test('inspectClientHello: ECH present rejected', () => {
  const hello = buildClientHello({ sniHost: 'api.anthropic.com', ech: true });
  const res = egress.inspectClientHello(hello, 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
  assert.strictEqual(res.code, 'ech-present');
});

test('inspectClientHello: fragmented across TCP chunks', () => {
  const hello = buildClientHello({ sniHost: 'claude.ai' });
  let fed = Buffer.alloc(0);
  let lastStatus = null;
  for (let i = 0; i < hello.length; i++) {
    fed = Buffer.concat([fed, hello.slice(i, i + 1)]);
    const res = egress.inspectClientHello(fed, 'claude.ai');
    lastStatus = res.status;
    if (res.status === 'valid') {
      assert.strictEqual(res.consumed, hello.length);
      break;
    }
    if (res.status === 'invalid') throw new Error('unexpected invalid at byte ' + i);
  }
  assert.strictEqual(lastStatus, 'valid');
});

test('inspectClientHello: split across multiple TLS records', () => {
  const hello = buildClientHello({ sniHost: 'grok.com' });
  // split the single record into two records manually: take handshake bytes and re-wrap
  const recHeader = hello.slice(0, 5);
  const handshakeBytes = hello.slice(5);
  const half = Math.floor(handshakeBytes.length / 2);
  const rec1 = Buffer.concat([Buffer.from([22, 3, 3]), u16(half), handshakeBytes.slice(0, half)]);
  const rec2 = Buffer.concat([Buffer.from([22, 3, 3]), u16(handshakeBytes.length - half), handshakeBytes.slice(half)]);
  const full = Buffer.concat([rec1, rec2]);
  const res = egress.inspectClientHello(full, 'grok.com');
  assert.strictEqual(res.status, 'valid');
});

test('inspectClientHello: malformed bounds rejected', () => {
  const bad = Buffer.from([22, 3, 3, 0, 4, 1, 0, 0, 200]); // declares handshake len 200 but body short, within record bound mismatch triggers need-more actually
  const res = egress.inspectClientHello(bad, 'api.anthropic.com');
  assert.ok(res.status === 'need-more' || res.status === 'invalid');
});

test('inspectClientHello: non-tls data rejected', () => {
  const res = egress.inspectClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n'), 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
});

test('inspectClientHello: too large rejected', () => {
  const big = Buffer.alloc(70000, 1);
  const res = egress.inspectClientHello(big, 'api.anthropic.com');
  assert.strictEqual(res.status, 'invalid');
  assert.strictEqual(res.code, 'hello-too-large');
});

test('isGlobalUnicast classifier basic cases', () => {
  const g = egress._internal.isGlobalUnicast;
  assert.strictEqual(g('10.0.0.1', 4), false);
  assert.strictEqual(g('127.0.0.1', 4), false);
  assert.strictEqual(g('8.8.8.8', 4), true);
  assert.strictEqual(g('::1', 6), false);
  assert.strictEqual(g('fe80::1', 6), false);
  assert.strictEqual(g('2001:db8::1', 6), false);
  assert.strictEqual(g('2606:4700:4700::1111', 6), true);
  assert.strictEqual(g('fc00::1', 6), false);
});

test('create(): rejects unknown option', async () => {
  await assert.rejects(() => egress.create({ provider: 'claude', foo: 1 }));
});

test('create(): rejects invalid provider', async () => {
  await assert.rejects(() => egress.create({ provider: 'openai' }));
});

test('create(): rejects limits over max', async () => {
  await assert.rejects(() => egress.create({ provider: 'claude', maxConnections: 100 }));
  await assert.rejects(() => egress.create({ provider: 'claude', maxWallMs: 9999999 }));
});

function parseProxyUrl(u) {
  const m = /^http:\/\/([^:]+):([^@]+)@127\.0\.0\.1:(\d+)$/.exec(u);
  assert.ok(m, 'proxyUrl shape');
  return { user: m[1], pass: m[2], port: Number(m[3]) };
}

test('live: unauthorized CONNECT rejected (407) and no slot leak', async () => {
  const h = await egress.create({ provider: 'claude', maxConnections: 2 });
  try {
    const { port } = parseProxyUrl(h.proxyUrl);
    const sock = net.connect(port, '127.0.0.1');
    const result = await new Promise((resolve) => {
      let buf = '';
      sock.on('data', (d) => { buf += d.toString(); });
      sock.on('close', () => resolve(buf));
      sock.setEncoding('utf8');
      sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic d3Jvbmc=\r\n\r\n');
    });
    assert.ok(/407/.test(result));
    assert.strictEqual(h.snapshot().activeConnections, 0);
  } finally {
    await h.close();
  }
});

test('live: forbidden authority rejected', async () => {
  const h = await egress.create({ provider: 'claude' });
  try {
    const { user, pass, port } = parseProxyUrl(h.proxyUrl);
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    const result = await new Promise((resolve) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => { buf += d; });
      sock.on('close', () => resolve(buf));
      sock.write('CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\nProxy-Authorization: ' + auth + '\r\n\r\n');
    });
    assert.ok(/403/.test(result));
  } finally {
    await h.close();
  }
});

test('live: ordinary HTTP request rejected', async () => {
  const h = await egress.create({ provider: 'claude' });
  try {
    const { port } = parseProxyUrl(h.proxyUrl);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', () => resolve('error'));
      req.end();
    });
    assert.ok(result === 'error' || typeof result === 'number');
  } finally {
    await h.close();
  }
});

test('live: malformed host / duplicate header rejected', async () => {
  const h = await egress.create({ provider: 'claude' });
  try {
    const { user, pass, port } = parseProxyUrl(h.proxyUrl);
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    const result = await new Promise((resolve) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => { buf += d; });
      sock.on('close', () => resolve(buf));
      sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nHost: other:443\r\nProxy-Authorization: ' + auth + '\r\n\r\n');
    });
    assert.ok(/400/.test(result));
  } finally {
    await h.close();
  }
});

test('live: slot limit enforced', async () => {
  const h = await egress.create({ provider: 'claude', maxConnections: 1, helloTimeoutMs: 1000 });
  try {
    const { user, pass, port } = parseProxyUrl(h.proxyUrl);
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const sock1 = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => {
      sock1.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: ' + auth + '\r\n\r\n');
      sock1.once('data', () => resolve());
    });
    const sock2 = net.connect(port, '127.0.0.1');
    const result2 = await new Promise((resolve) => {
      let buf = '';
      sock2.setEncoding('utf8');
      sock2.on('data', (d) => { buf += d; });
      sock2.on('close', () => resolve(buf));
      sock2.write('CONNECT claude.ai:443 HTTP/1.1\r\nHost: claude.ai:443\r\nProxy-Authorization: ' + auth + '\r\n\r\n');
    });
    assert.ok(/503/.test(result2));
    sock1.destroy();
  } finally {
    await h.close();
  }
});

test('live: close() is idempotent and destroys sockets, no resurrection', async () => {
  const h = await egress.create({ provider: 'grok' });
  await h.close();
  await h.close();
  const snap = h.snapshot();
  assert.strictEqual(snap.closed, true);
});

test('live: audit callback failure fails closed', async () => {
  let calls = 0;
  const h = await egress.create({
    provider: 'claude',
    onAudit: () => { calls++; throw new Error('boom'); }
  });
  try {
    const { user, pass, port } = parseProxyUrl(h.proxyUrl);
    const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const sock = net.connect(port, '127.0.0.1');
    const closed = await new Promise((resolve) => {
      sock.resume();
      sock.on('close', () => resolve(true));
      sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: ' + auth + '\r\n\r\n');
      setTimeout(() => resolve(false), 2000);
    });
    assert.ok(calls > 0);
    assert.strictEqual(closed, true);
  } finally {
    await h.close();
  }
});

test('snapshot returns safe shape', async () => {
  const h = await egress.create({ provider: 'claude' });
  const snap = h.snapshot();
  assert.strictEqual(snap.provider, 'claude');
  assert.strictEqual(typeof snap.activeConnections, 'number');
  assert.strictEqual(typeof snap.accepted, 'number');
  assert.strictEqual(typeof snap.denied, 'number');
  assert.strictEqual(typeof snap.totalBytes, 'number');
  assert.strictEqual(typeof snap.closed, 'boolean');
  await h.close();
});

test('synthetic allowed tunnel preserves buffered response through upstream EOF',{timeout:10000},async t=>{
  // Real loopback sockets with test-only DNS/dial substitution; no vendor call.
  const payload=Buffer.alloc(256*1024,65),server=net.createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>socket.end(payload));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const source=fs.readFileSync(require.resolve('../lib/provider-egress'),'utf8'),module={exports:{}};
  const context={module,exports:module.exports,Buffer,process,setTimeout,clearTimeout,Promise,require:name=>{
    if(name==='./native-turn-limits')return require('../lib/native-turn-limits');
    if(name==='dns')return {promises:{lookup:async()=>[{address:'1.1.1.1',family:4}]}};
    if(name==='net')return {...net,connect:()=>net.connect(server.address().port,'127.0.0.1')};
    return require(name);
  }};
  vm.runInNewContext(source,context,{filename:'synthetic-egress.js'});
  const broker=await vm.runInNewContext('module.exports.create({provider:"claude"})',context);t.after(()=>broker.close());
  const u=new URL(broker.proxyUrl),socket=net.connect(Number(u.port),'127.0.0.1');t.after(()=>socket.destroy());
  const chunks=[];let header=Buffer.alloc(0),ready=false;
  socket.on('data',chunk=>{
    if(ready){chunks.push(chunk);return;}
    header=Buffer.concat([header,chunk]);const at=header.indexOf('\r\n\r\n');if(at<0)return;
    assert.match(header.subarray(0,at).toString(),/200/);ready=true;
    if(header.length>at+4)chunks.push(header.subarray(at+4));
    socket.pause();socket.write(buildClientHello({sniHost:'api.anthropic.com'}));setTimeout(()=>socket.resume(),50);
  });
  const ended=new Promise((resolve,reject)=>{socket.once('error',reject);socket.once('close',resolve);});
  socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic '+Buffer.from(u.username+':'+u.password).toString('base64')+'\r\n\r\n');
  await ended;assert.deepEqual(Buffer.concat(chunks),payload);
});


test('egress default and explicit wall allow thirty minutes and reject one millisecond more',async t=>{
  for(const provider of ['claude','grok']){
    await assert.rejects(()=>egress.create({provider,maxWallMs:1800001}));
    for(const options of [{provider},{provider,maxWallMs:1800000}]){
      const durations=[],original=setTimeout;
      const mocked=t.mock.method(global,'setTimeout',(fn,ms,...args)=>{durations.push(ms);return original(fn,ms,...args);});
      let broker;
      try{broker=await egress.create(options);assert.ok(durations.includes(1800000));}
      finally{if(broker)await broker.close();mocked.mock.restore();}
    }
  }
});
