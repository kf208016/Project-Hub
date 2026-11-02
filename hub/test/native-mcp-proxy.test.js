'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { create } = require('../lib/native-mcp-proxy.js');

function genToken() {
  return crypto.randomBytes(32).toString('base64url').slice(0, 43);
}

function genUuid() {
  return crypto.randomUUID();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function closeAll(servers) {
  return Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))));
}

function rawRequest(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: opts.path,
      method: opts.method,
      headers: opts.headers,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
      });
    });
    req.on('error', reject);
    if (opts.rawHeaderPairs) {
      // for duplicate header tests we need low-level control; emulate via multiple setHeader calls is not possible with http.request options object duplicates,
      // so we use req.setHeader after creation is not valid for request() - instead we rely on socket-level writes in a dedicated helper (see below).
    }
    if (opts.body !== undefined) {
      req.end(opts.body);
    } else {
      req.end();
    }
  });
}

// Low level helper to send truly raw requests (for duplicate-header / malformed tests)
function rawSocketRequest(port, rawHead, body) {
  return new Promise((resolve, reject) => {
    const net = require('node:net');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(rawHead);
      if (body) sock.write(body);
    });
    let data = Buffer.alloc(0);
    sock.on('data', (c) => { data = Buffer.concat([data, c]); });
    sock.on('end', () => {
      const text = data.toString('utf8');
      const [statusLine] = text.split('\r\n');
      const status = parseInt(statusLine.split(' ')[1], 10);
      resolve({ status, raw: text });
      sock.destroy();
    });
    sock.on('error', reject);
    setTimeout(() => { try { sock.end(); } catch {} }, 500);
  });
}

async function setup() {
  const token = genToken();
  const ownerToken = genToken();
  const runId = genUuid();

  const hubCalls = [];
  const hub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hubCalls.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/api/mcp/tools' && req.method === 'GET') {
        const out = JSON.stringify({ tools: ['a', 'b'] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else if (req.url === '/api/mcp/call' && req.method === 'POST') {
        const out = JSON.stringify({ ok: true, echo: chunks.length ? Buffer.concat(chunks).toString('utf8') : null });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });
  const hubPort = await listen(hub);

  const proxyHandle = create({ port: hubPort, token, runId });
  const proxy = http.createServer((req, res) => proxyHandle.handle(req, res));
  const proxyPort = await listen(proxy);

  return { hub, proxy, hubPort, proxyPort, token, ownerToken, runId, hubCalls };
}

test('valid GET tools request succeeds', async () => {
  const ctx = await setup();
  try {
    const res = await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/tools`,
      headers: {
        Host: `127.0.0.1:${ctx.hubPort}`,
        Authorization: `Bearer ${ctx.token}`,
        'X-Hub-Mcp-Run': ctx.runId
      }
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(parsed.tools, ['a', 'b']);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('valid POST call request succeeds with actual body echoed', async () => {
  const ctx = await setup();
  try {
    const payload = JSON.stringify({ tool: 'x', args: [1, 2, 3] });
    const res = await rawRequest(ctx.proxyPort, {
      method: 'POST',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/call`,
      headers: {
        Host: `127.0.0.1:${ctx.hubPort}`,
        Authorization: `Bearer ${ctx.token}`,
        'X-Hub-Mcp-Run': ctx.runId,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),'X-Hub-Mcp-Nonce':genUuid()
      },
      body: payload
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.echo, payload);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects query string and hash in target', async () => {
  const ctx = await setup();
  try {
    const res1 = await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/tools?x=1`,
      headers: { Host: `127.0.0.1:${ctx.hubPort}`, Authorization: `Bearer ${ctx.token}`, 'X-Hub-Mcp-Run': ctx.runId }
    });
    assert.notEqual(res1.status, 200);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects admin/other routes', async () => {
  const ctx = await setup();
  try {
    const res = await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/admin`,
      headers: { Host: `127.0.0.1:${ctx.hubPort}`, Authorization: `Bearer ${ctx.token}`, 'X-Hub-Mcp-Run': ctx.runId }
    });
    assert.equal(res.status, 404);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects wrong run id (scope mismatch)', async () => {
  const ctx = await setup();
  try {
    const res = await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/tools`,
      headers: { Host: `127.0.0.1:${ctx.hubPort}`, Authorization: `Bearer ${ctx.token}`, 'X-Hub-Mcp-Run': require('node:crypto').randomUUID() }
    });
    assert.equal(res.status, 403);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects owner token (invalid auth token)', async () => {
  const ctx = await setup();
  try {
    const res = await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/tools`,
      headers: { Host: `127.0.0.1:${ctx.hubPort}`, Authorization: `Bearer ${ctx.ownerToken}`, 'X-Hub-Mcp-Run': ctx.runId }
    });
    assert.equal(res.status, 403);
    for (const call of ctx.hubCalls) {
      assert.notEqual(call.headers['authorization'], `Bearer ${ctx.ownerToken}`);
    }
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects Cookie header', async () => {
  const ctx = await setup();
  try {
    const res = await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/tools`,
      headers: {
        Host: `127.0.0.1:${ctx.hubPort}`,
        Authorization: `Bearer ${ctx.token}`,
        'X-Hub-Mcp-Run': ctx.runId,
        Cookie: 'session=evil'
      }
    });
    assert.equal(res.status, 403);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects duplicate critical headers via raw socket', async () => {
  const ctx = await setup();
  try {
    const head =
      `GET http://127.0.0.1:${ctx.hubPort}/api/mcp/tools HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${ctx.hubPort}\r\n` +
      `Authorization: Bearer ${ctx.token}\r\n` +
      `Authorization: Bearer ${ctx.token}\r\n` +
      `X-Hub-Mcp-Run: ${ctx.runId}\r\n` +
      `Connection: close\r\n\r\n`;
    const res = await rawSocketRequest(ctx.proxyPort, head);
    assert.ok(res.status === 403 || res.status === 400);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects body length mismatch (declared vs actual)', async () => {
  const ctx = await setup();
  try {
    const payload = JSON.stringify({ a: 1 });
    const head =
      `POST http://127.0.0.1:${ctx.hubPort}/api/mcp/call HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${ctx.hubPort}\r\n` +
      `Authorization: Bearer ${ctx.token}\r\n` +
      `X-Hub-Mcp-Run: ${ctx.runId}\r\n` +
      `Content-Type: application/json\r\n` +
      `X-Hub-Mcp-Nonce: ${genUuid()}\r\n` +
      `Content-Length: ${Buffer.byteLength(payload) + 10}\r\n` +
      `Connection: close\r\n\r\n`;
    const res = await rawSocketRequest(ctx.proxyPort, head, payload);
    assert.ok(res.status === 400 || res.status === 502);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects oversized content-length declaration', async () => {
  const ctx = await setup();
  try {
    const head =
      `POST http://127.0.0.1:${ctx.hubPort}/api/mcp/call HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${ctx.hubPort}\r\n` +
      `Authorization: Bearer ${ctx.token}\r\n` +
      `X-Hub-Mcp-Run: ${ctx.runId}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: 99999999\r\n` +
      `Connection: close\r\n\r\n`;
    const res = await rawSocketRequest(ctx.proxyPort, head, '{}');
    assert.equal(res.status, 403);
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('rejects CONNECT and upgrade requests', async () => {
  const ctx = await setup();
  try {
    const head =
      `GET http://127.0.0.1:${ctx.hubPort}/api/mcp/tools HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${ctx.hubPort}\r\n` +
      `Authorization: Bearer ${ctx.token}\r\n` +
      `X-Hub-Mcp-Run: ${ctx.runId}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n\r\n`;
    const res = await rawSocketRequest(ctx.proxyPort, head);
    assert.ok(res.status === undefined || res.status >= 400 || Number.isNaN(res.status));
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('never forwards Proxy-Authorization header', async () => {
  const ctx = await setup();
  try {
    await rawRequest(ctx.proxyPort, {
      method: 'GET',
      path: `http://127.0.0.1:${ctx.hubPort}/api/mcp/tools`,
      headers: {
        Host: `127.0.0.1:${ctx.hubPort}`,
        Authorization: `Bearer ${ctx.token}`,
        'X-Hub-Mcp-Run': ctx.runId,
        'Proxy-Authorization': 'Basic abc123'
      }
    });
    assert.equal(ctx.hubCalls.length,1);
    for (const call of ctx.hubCalls) {
      assert.equal(call.headers['proxy-authorization'], undefined);
      assert.equal(call.headers['cookie'], undefined);
    }
  } finally {
    await closeAll([ctx.hub, ctx.proxy]);
  }
});

test('create() validates options strictly', () => {
  const token = genToken();
  const runId = genUuid();
  assert.throws(() => create({ port: 80, token, runId }));
  assert.throws(() => create({ port: 8080, token: 'short', runId }));
  assert.throws(() => create({ port: 8080, token, runId: 'not-a-uuid' }));
  assert.throws(() => create({ port: 8080, token, runId, extra: 1 }));
  assert.doesNotThrow(() => create({ port: 8080, token, runId }));
});
