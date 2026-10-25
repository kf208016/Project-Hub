'use strict';
// Browser login server wiring and bounded JSON body tests.
// Boots the real server.js / RecoveryOnly listener. No provider calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');

const ROUTES = ['/api/local/browser/begin', '/api/local/browser/poll', '/api/local/browser/approve'];
const MARKER = 'BROWSER_LOGIN_BODY_MARKER';



function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request({ port, method = 'GET', path: route, headers = {}, body, timeout = 5000 }) {
  return new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers, timeout }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json;
        if (text.length) {
          try { json = JSON.parse(text); } catch { json = undefined; }
        } else json = null;
        const rawCookies = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          text,
          json,
          buffer,
          cookies: rawCookies ? (Array.isArray(rawCookies) ? rawCookies : [rawCookies]) : [],
          headers: res.headers,
        });
      });
    });
    req.on('timeout', () => req.destroy(Error('timeout')));
    req.on('error', error => resolve({ status: 0, text: '', json: undefined, buffer: Buffer.alloc(0), cookies: [], headers: {}, error: error.message }));
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') req.end(body);
    else req.end();
  });
}

function browserHeaders(port, extra = {}) {
  const headers = {
    Host: `127.0.0.1:${port}`,
    'Content-Type': 'application/json',
    'X-Hub': '1',
    Origin: `http://127.0.0.1:${port}`,
    Connection: 'close',
    ...extra,
  };
  for (const key of Object.keys(headers)) if (headers[key] == null) delete headers[key];
  return headers;
}

function scrub(text, secret) {
  return String(text || '').split(secret).join('[token]').slice(0, 400);
}

function detail(response, secret, label) {
  return `${label}: expected mismatch status=${response.status} error=${response.error || ''} body=${scrub(response.text, secret)}`;
}

async function bootNormal(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-browser-login-'));
  const port = await freePort();
  assert.ok(port >= 1024 && port <= 65535);
  const secret = crypto.randomBytes(32).toString('base64url');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  let stderr = '';
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: {
      ...process.env,
      HUB_ROOT: root,
      HUB_AI_HOME: path.join(root, 'empty-home'),
      HUB_TRASH: path.join(root, 'trash'),
      HUB_PORT: String(port),
      HUB_DRY_RUN: '1',
      HUB_LOCAL_TOKEN: secret,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw Error('server exited before /api/state was ready: ' + scrub(stderr, secret));
    const ready = await request({ port, method: 'GET', path: '/api/state', headers: { Host: `127.0.0.1:${port}`, Connection: 'close' }, timeout: 1000 });
    if (ready.status === 200) return { port, secret, child };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('server did not answer 200 on /api/state: ' + scrub(stderr, secret));
}

function pairOf(setCookie) {
  const pair = String(setCookie).split(';')[0].trim();
  assert.match(pair, /^[^;=\s]+=\S*$/);
  return pair;
}

function assertBeginShape(response, port, secret) {
  assert.equal(response.status, 200, detail(response, secret, 'begin'));
  assert.deepEqual(Object.keys(response.json).sort(), ['expiresInSeconds', 'ok', 'requestId']);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.expiresInSeconds, 60);
  assert.match(response.json.requestId, /^[0-9a-f]{32}$/);
  assert.equal(response.text.includes(secret), false, 'begin body leaked the owner token');
  assert.equal(response.cookies.length, 1, 'begin must set exactly the pending cookie');
  const cookie = response.cookies[0];
  const parts = cookie.split(';').map(part => part.trim());
  const pair = parts[0];
  const splitAt = pair.indexOf('=');
  const name = pair.slice(0, splitAt);
  const value = pair.slice(splitAt + 1);
  assert.equal(name, `hub_local_pending_${port}`);
  assert.ok(value.startsWith(`${response.json.requestId}.`), 'pending cookie value must be <id>.<nonce>');
  const nonce = value.slice(response.json.requestId.length + 1);
  assert.ok(nonce.length > 0, 'pending nonce is empty');
  assert.equal(response.text.includes(nonce), false, 'begin body leaked the pending nonce');
  for (const attr of ['Path=/api/local/browser', 'HttpOnly', 'SameSite=Strict', 'Max-Age=60']) {
    assert.ok(parts.includes(attr), `pending cookie missing ${attr}: ${cookie}`);
  }
  return { id: response.json.requestId, pair, nonce };
}

async function postBrowser(port, route, body, headers) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return request({
    port,
    method: 'POST',
    path: route,
    headers: browserHeaders(port, { 'Content-Length': String(Buffer.byteLength(payload)), ...headers }),
    body: payload,
  });
}

async function begin(port, secret) {
  const response = await postBrowser(port, '/api/local/browser/begin', {});
  const parsed = assertBeginShape(response, port, secret);
  return { response, ...parsed };
}

function forbidOrdinaryConstructors(t) {
  const restored = [];
  for (const [file, names] of [['store', ['Store']], ['completion', ['Completion']], ['chat', ['ChatRunner']], ['sessions', ['Sessions']], ['ai-tools', ['AiTools']], ['usage', ['Usage']]]) {
    const module = require('../lib/' + file);
    for (const name of names) {
      const original = module[name];
      if (typeof original !== 'function') continue;
      module[name] = class { constructor() { throw Error('Ordinary constructor forbidden in RecoveryOnly: ' + name); } };
      restored.push(() => { module[name] = original; });
    }
  }
  t.after(() => restored.reverse().forEach(restore => restore()));
}

function scriptedRequest(chunks, headers = {}) {
  let index = 0;
  let reads = 0;
  const stream = new Readable({
    read() {
      reads += 1;
      if (index >= chunks.length) this.push(null);
      else this.push(chunks[index++]);
    },
  });
  stream.headers = headers;
  stream.on('error', () => {});
  stream.stats = () => ({ reads, destroyed: stream.destroyed });
  return stream;
}

function controllableRequest(headers = {}) {
  const stream = new Readable({ read() {} });
  stream.headers = headers;
  stream.on('error', () => {});
  stream.destroyCalls = 0;
  const original = stream.destroy;
  stream.destroy = function destroy(...args) {
    stream.destroyCalls += 1;
    return original.apply(this, args);
  };
  return stream;
}

function spyConsole(t) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = console[method];
    console[method] = (...args) => { lines.push(args.map(value => String(value)).join(' ')); };
  }
  t.after(() => { for (const method of Object.keys(originals)) console[method] = originals[method]; });
  return lines;
}

test('5.1.1 legacy begin returns a pending cookie while state needs no owner session', { timeout: 30000 }, async t => {
  const { port, secret } = await bootNormal(t);
  const started = await begin(port, secret);
  const state = await request({
    port,
    method: 'GET',
    path: '/api/state',
    headers: { Host: `127.0.0.1:${port}`, Cookie: started.pair, Connection: 'close' },
  });
  assert.equal(state.status, 200, detail(state, secret, '/api/state with only the pending cookie'));
  assert.equal(state.text.includes(secret), false);
});

test('5.1.2 legacy approval keeps its owner cookie and one-time poll; state remains accessible', { timeout: 30000 }, async t => {
  const { port, secret } = await bootNormal(t);
  const started = await begin(port, secret);
  const denied = await postBrowser(port, '/api/local/browser/approve', { requestId: started.id });
  assert.equal(denied.status, 403, detail(denied, secret, 'approve without owner cookie'));
  assert.equal(denied.text.includes(secret), false);
  const deniedEarly = await postBrowser(port, '/api/local/browser/approve', 'not-json');
  assert.equal(deniedEarly.status, 403, detail(deniedEarly, secret, 'approve without owner cookie must fail before the body is read'));
  const wrong = await postBrowser(port, '/api/local/login', { token: 'wrong' });
  assert.notEqual(wrong.status, 200);
  const login = await postBrowser(port, '/api/local/login', { token: secret });
  assert.equal(login.status, 200, detail(login, secret, 'owner login'));
  assert.ok(login.cookies.length >= 1, 'login did not set the owner cookie');
  const owner = pairOf(login.cookies[0]);
  assert.equal(login.text.includes(secret), false, 'login body leaked the owner token');
  assert.notEqual(owner.split('=')[0], `hub_local_pending_${port}`);
  const approved = await postBrowser(port, '/api/local/browser/approve', { requestId: started.id }, { Cookie: owner });
  assert.equal(approved.status, 200, detail(approved, secret, 'approve'));
  assert.deepEqual(approved.json, { ok: true });
  assert.equal(approved.text.includes(secret), false);
  const polled = await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: started.pair });
  assert.equal(polled.status, 200, detail(polled, secret, 'poll after approve'));
  assert.deepEqual(polled.json, { ok: true });
  assert.equal(polled.text.includes(secret), false);
  assert.equal(polled.text.includes(started.nonce), false, 'poll body leaked the pending nonce');
  assert.equal(polled.cookies.length, 2, `poll must set the owner cookie and the clearing cookie, got ${polled.cookies.length}`);
  assert.ok(polled.cookies.some(cookie => cookie.startsWith(owner + ';') || cookie.split(';')[0].trim() === owner), 'poll Set-Cookie list is missing the owner cookie value from /api/local/login');
  const clearing = polled.cookies.find(cookie => cookie.includes('Max-Age=0') && cookie.includes('Path=/api/local/browser'));
  assert.ok(clearing, `poll Set-Cookie list has no clearing cookie: ${polled.cookies.join(' | ')}`);
  assert.ok(clearing.startsWith(`hub_local_pending_${port}=`), 'clearing cookie name is not the pending cookie');
  const state = await request({
    port,
    method: 'GET',
    path: '/api/state',
    headers: { Host: `127.0.0.1:${port}`, Cookie: owner, Connection: 'close' },
  });
  assert.equal(state.status, 200, detail(state, secret, '/api/state with the owner cookie'));
  assert.equal(state.text.includes(secret), false);
  const again = await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: started.pair });
  assert.equal(again.status, 409, detail(again, secret, 'second poll'));
  const reapprove = await postBrowser(port, '/api/local/browser/approve', { requestId: started.id }, { Cookie: owner });
  assert.equal(reapprove.status, 409, detail(reapprove, secret, 'second approve'));
});

test('5.1.3 normal poll stays pending until approval and rejects a wrong or missing pending cookie', { timeout: 30000 }, async t => {
  const { port, secret } = await bootNormal(t);
  const started = await begin(port, secret);
  const pending = await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: started.pair });
  assert.equal(pending.status, 202, detail(pending, secret, 'poll before approval'));
  assert.deepEqual(pending.json, { ok: false, pending: true });
  const last = started.nonce.slice(-1);
  const flipped = `${started.pair.slice(0, -1)}${last === '0' ? '1' : '0'}`;
  assert.notEqual(flipped, started.pair);
  const wrongNonce = await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: flipped });
  assert.equal(wrongNonce.status, 409, detail(wrongNonce, secret, 'poll with the wrong nonce'));
  const login = await postBrowser(port, '/api/local/login', { token: secret });
  assert.equal(login.status, 200, detail(login, secret, 'login'));
  const owner = pairOf(login.cookies[0]);
  const ownerOnly = await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: owner });
  assert.equal(ownerOnly.status, 409, detail(ownerOnly, secret, 'poll with the owner cookie and no pending cookie'));
});

test('5.1.4 normal guards reject a bad host, missing X-Hub, foreign origin, authorization, oversized or extra-key bodies, and the wrong method', { timeout: 30000 }, async t => {
  const { port, secret, child } = await bootNormal(t);
  const failures = [];
  async function check(label, fn) {
    try { await fn(); }
    catch (error) { failures.push(`${label}: ${error.message}`); }
  }
  await check('wrong Host', async () => {
    const response = await postBrowser(port, '/api/local/browser/begin', {}, { Host: 'invalid.example', Origin: null });
    assert.equal(response.status, 403, detail(response, secret, 'wrong Host'));
  });
  await check('missing X-Hub', async () => {
    const response = await postBrowser(port, '/api/local/browser/begin', {}, { 'X-Hub': null });
    assert.equal(response.status, 403, detail(response, secret, 'missing X-Hub'));
  });
  await check('foreign Origin', async () => {
    const response = await postBrowser(port, '/api/local/browser/begin', {}, { Origin: 'https://invalid.example' });
    assert.equal(response.status, 403, detail(response, secret, 'foreign Origin'));
  });
  await check('Authorization', async () => {
    const response = await postBrowser(port, '/api/local/browser/begin', {}, { Authorization: 'Bearer synthetic' });
    assert.equal(response.status, 403, detail(response, secret, 'Authorization header'));
  });
  await check('body over 1024 bytes', async () => {
    const payload = JSON.stringify({ pad: MARKER + 'x'.repeat(1100) });
    assert.ok(Buffer.byteLength(payload) > 1024);
    const response = await postBrowser(port, '/api/local/browser/begin', payload);
    assert.equal(response.status, 400, detail(response, secret, 'body > 1024'));
    assert.equal(child.exitCode, null, 'server exited after an oversized body');
    const state = await request({ port, method: 'GET', path: '/api/state', headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } });
    assert.equal(state.status, 200, detail(state, secret, 'server health after oversized body'));
    const again = await postBrowser(port, '/api/local/browser/begin', {});
    assert.equal(again.status, 200, detail(again, secret, 'begin after oversized body'));
    assertBeginShape(again, port, secret);
  });
  await check('extra body key', async () => {
    const beginExtra = await postBrowser(port, '/api/local/browser/begin', { extra: 1 });
    assert.equal(beginExtra.status, 400, detail(beginExtra, secret, 'begin extra key'));
    const pollExtra = await postBrowser(port, '/api/local/browser/poll', { requestId: 'a'.repeat(32), extra: 1 });
    assert.equal(pollExtra.status, 400, detail(pollExtra, secret, 'poll extra key'));
  });
  await check('GET is 405', async () => {
    for (const route of ROUTES) {
      const response = await request({ port, method: 'GET', path: route, headers: browserHeaders(port) });
      assert.equal(response.status, 405, detail(response, secret, `GET ${route}`));
    }
  });
  await check('unknown browser path', async () => {
    const response = await postBrowser(port, '/api/local/browser/not-a-route', {});
    assert.equal(response.status, 404, detail(response, secret, 'unknown /api/local/browser/ path'));
  });
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('5.1.5 normal mode keeps at most eight pending begins', { timeout: 30000 }, async t => {
  const { port, secret } = await bootNormal(t);
  for (let index = 0; index < 8; index++) await begin(port, secret);
  const ninth = await postBrowser(port, '/api/local/browser/begin', {});
  assert.equal(ninth.status, 409, detail(ninth, secret, 'ninth begin'));
  assert.deepEqual(ninth.json, { ok: false, error: 'conflict' });
});

test('5.1.6 normal mode permits local requests without a cookie and legacy login is unchanged', { timeout: 30000 }, async t => {
  const { port, secret } = await bootNormal(t);
  const state = await request({ port, path: '/api/state', headers: browserHeaders(port) });
  assert.equal(state.status, 200);
  const created = await postBrowser(port, '/api/project/new', { name: 'Synthetic no-cookie project' });
  assert.equal(created.status, 200, detail(created, secret, 'local POST without cookie'));
  const unknown = await postBrowser(port, '/api/does-not-exist-browser-login', {});
  assert.equal(unknown.status, 404);
  const challenge = 'a'.repeat(64);
  const proof = await request({ port, path: '/api/local/proof?challenge=' + challenge, headers: browserHeaders(port) });
  assert.equal(proof.status, 200);
  assert.equal(proof.json.proof, crypto.createHmac('sha256', secret).update('project-hub-instance-v1:' + challenge).digest('hex'));
  const wrong = await postBrowser(port, '/api/local/login', { token: 'wrong' });
  assert.equal(wrong.status, 403, detail(wrong, secret, 'wrong token'));
  assert.equal(wrong.text.includes(secret), false);
  const right = await postBrowser(port, '/api/local/login', { token: secret });
  assert.equal(right.status, 200, detail(right, secret, 'right token'));
  assert.ok(right.cookies.length >= 1 && /HttpOnly/i.test(right.cookies[0]) && /SameSite=Strict/.test(right.cookies[0]), 'login did not return the owner cookie');
  assert.equal(right.text.includes(secret), false);
});

test('5.1.7 RecoveryOnly mounts browser login, serves local-auth.js exactly, and keeps ordinary routes recovery-only', { timeout: 60000 }, async t => {
  forbidOrdinaryConstructors(t);
  const { fixture } = require('./helpers/web-chat-fixture');
  const recovery = require('../lib/web-chat-recovery-server');
  const admission = require('../lib/web-chat-admission');
  const f = fixture(t);
  const watcherModule = require('../lib/procwatch');
  const originalWatcher = watcherModule.create;
  const restoreInventory = require('./helpers/owned-native-fixture').freshInventory();
  const hubDir = path.join(__dirname, '..');
  const secret = crypto.randomBytes(32).toString('base64url');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  let service;
  try {
    service = recovery.create({
      root: f.root,
      hubDir,
      port: 0,
      secret,
      admission: { recoveryOnly: true, format: 'web-manual-v2', pending: [], inspection: [] },
    });
  } finally {
    restoreInventory();
    watcherModule.create = originalWatcher;
  }
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const port = service.server.address().port;
  assert.ok(port >= 1024);
  t.after(async () => {
    service.server.closeAllConnections?.();
    await new Promise(resolve => service.server.close(resolve));
  });
  const anonymousState = await request({ port, method: 'GET', path: '/api/state', headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } });
  assert.equal(anonymousState.status, 200, detail(anonymousState, secret, 'RecoveryOnly did not start'));
  const failures = [];
  async function check(label, fn) {
    try { await fn(); }
    catch (error) { failures.push(`${label}: ${error.message}`); }
  }
  const fileBytes = fs.readFileSync(path.join(hubDir, 'public/local-auth.js'));
  await check('GET /local-auth.js', async () => {
    const response = await request({ port, method: 'GET', path: '/local-auth.js', headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } });
    assert.equal(response.status, 200, detail(response, secret, 'GET /local-auth.js'));
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.deepEqual(response.buffer, fileBytes);
  });
  await check('local-auth.js is not served from nearby paths', async () => {
    for (const route of ['/local-auth.js/x', '/local-auth.js?x=1', '/Local-Auth.js', '/other.js']) {
      const response = await request({ port, method: 'GET', path: route, headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } });
      assert.equal(response.status, 404, detail(response, secret, `GET ${route}`));
      assert.notDeepEqual(response.buffer, fileBytes, `${route} served public/local-auth.js`);
    }
  });
  await check('restrictRoutes', async () => {
    for (const route of ROUTES) {
      assert.equal(admission.restrictRoutes(route, 'POST'), true, `${route} POST`);
      assert.equal(admission.restrictRoutes(route, 'GET'), false, `${route} GET`);
    }
  });
  await check('cases 1-3 on RecoveryOnly', async () => {
    const started = await begin(port, secret);
    const state = await request({
      port,
      method: 'GET',
      path: '/api/state',
      headers: { Host: `127.0.0.1:${port}`, Cookie: started.pair, Connection: 'close' },
    });
    assert.equal(state.status, 200, detail(state, secret, 'RecoveryOnly /api/state with pending cookie'));
    const denied = await postBrowser(port, '/api/local/browser/approve', { requestId: started.id });
    assert.equal(denied.status, 403, detail(denied, secret, 'RecoveryOnly approve without owner'));
    const login = await postBrowser(port, '/api/local/login', { token: secret });
    assert.equal(login.status, 200, detail(login, secret, 'RecoveryOnly login'));
    const owner = pairOf(login.cookies[0]);
    const approved = await postBrowser(port, '/api/local/browser/approve', { requestId: started.id }, { Cookie: owner });
    assert.equal(approved.status, 200, detail(approved, secret, 'RecoveryOnly approve'));
    assert.deepEqual(approved.json, { ok: true });
    const polled = await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: started.pair });
    assert.equal(polled.status, 200, detail(polled, secret, 'RecoveryOnly poll'));
    assert.deepEqual(polled.json, { ok: true });
    assert.equal(polled.cookies.length, 2);
    assert.ok(polled.cookies.some(cookie => cookie.startsWith(owner + ';') || cookie.split(';')[0].trim() === owner));
    assert.ok(polled.cookies.some(cookie => cookie.includes('Max-Age=0') && cookie.includes('Path=/api/local/browser') && cookie.startsWith(`hub_local_pending_${port}=`)));
    const authed = await request({ port, method: 'GET', path: '/api/state', headers: { Host: `127.0.0.1:${port}`, Cookie: owner, Connection: 'close' } });
    assert.equal(authed.status, 200, detail(authed, secret, 'RecoveryOnly /api/state with owner cookie'));
    assert.equal((await postBrowser(port, '/api/local/browser/poll', { requestId: started.id }, { Cookie: started.pair })).status, 409);
    assert.equal((await postBrowser(port, '/api/local/browser/approve', { requestId: started.id }, { Cookie: owner })).status, 409);
    const second = await begin(port, secret);
    const waiting = await postBrowser(port, '/api/local/browser/poll', { requestId: second.id }, { Cookie: second.pair });
    assert.equal(waiting.status, 202, detail(waiting, secret, 'RecoveryOnly poll before approval'));
    assert.deepEqual(waiting.json, { ok: false, pending: true });
    const flipped = `${second.pair.slice(0, -1)}${second.nonce.slice(-1) === '0' ? '1' : '0'}`;
    assert.equal((await postBrowser(port, '/api/local/browser/poll', { requestId: second.id }, { Cookie: flipped })).status, 409);
    assert.equal((await postBrowser(port, '/api/local/browser/poll', { requestId: second.id }, { Cookie: owner })).status, 409);
  });
  await check('case 6 recovery routes and unchanged login', async () => {
    for (const route of ['/api/state', '/api/web-chat/inspection']) {
      const response = await request({ port, method: 'GET', path: route, headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } });
      assert.equal(response.status, 200, detail(response, secret, `RecoveryOnly GET ${route} without owner`));
    }
    const wrong = await postBrowser(port, '/api/local/login', { token: 'wrong' });
    assert.equal(wrong.status, 403, detail(wrong, secret, 'RecoveryOnly wrong token'));
    const right = await postBrowser(port, '/api/local/login', { token: secret });
    assert.equal(right.status, 200, detail(right, secret, 'RecoveryOnly right token'));
    assert.ok(right.cookies.length >= 1 && /HttpOnly/i.test(right.cookies[0]) && /SameSite=Strict/.test(right.cookies[0]));
    const owner = pairOf(right.cookies[0]);
    for (const route of ['/api/task', '/api/chat/send']) {
      const response = await postBrowser(port, route, { actor: 'chatgpt', project: 'p', task: 't', text: 'do not execute' }, { Cookie: owner });
      assert.equal(response.status, 409, detail(response, secret, `RecoveryOnly POST ${route}`));
      assert.equal(response.json && response.json.code, 'RECOVERY_ONLY');
    }
  });
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('5.1.8 readSmallJson bounds the body, rejects bad UTF-8 inside strings, accepts a split code point, and destroys an oversized stream', async t => {
  const lines = spyConsole(t);
  let readSmallJson;
  try {
    ({ readSmallJson } = require('../lib/small-json-body'));
  } catch (error) {
    assert.fail(`missing lib/small-json-body.js (${error.code || error.message})`);
  }
  assert.equal(typeof readSmallJson, 'function');
  const empty = scriptedRequest([]);
  assert.deepEqual(await readSmallJson(empty), {});
  const valid = await readSmallJson(scriptedRequest([Buffer.from(`{"a":1,"marker":"${MARKER}"}`)]));
  assert.deepEqual(valid, { a: 1, marker: MARKER });
  const exactPayload = Buffer.from(`{"k":"${'a'.repeat(1016)}"}`);
  assert.equal(exactPayload.length, 1024);
  assert.equal((await readSmallJson(scriptedRequest([exactPayload.slice(0, 400), exactPayload.slice(400)], { 'content-length': '1024' }))).k.length, 1016);
  await assert.rejects(readSmallJson(scriptedRequest([Buffer.from([0xc3, 0x28])])));
  await assert.rejects(readSmallJson(scriptedRequest([Buffer.from('{"a":')])));
  const invalidInsideString = [
    ['0xFF inside a JSON string', Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')])],
    ['truncated 3-byte sequence inside a JSON string', Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}')])],
    ['overlong sequence inside a JSON string', Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')])],
  ];
  for (const [label, body] of invalidInsideString) {
    await assert.rejects(readSmallJson(scriptedRequest([body])), () => true, label);
  }
  const euro = await readSmallJson(scriptedRequest([
    Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xe2])]),
    Buffer.concat([Buffer.from([0x82, 0xac]), Buffer.from('"}')]),
  ]));
  assert.deepEqual(euro, { a: '\u20ac' });
  for (const header of ['1025', '1e3', '-1', '1 2']) {
    const fake = scriptedRequest([Buffer.from(`{"marker":"${MARKER}"}`)], { 'content-length': header });
    await assert.rejects(readSmallJson(fake), error => {
      assert.equal(String(error && error.message || '').includes(MARKER), false);
      return true;
    });
    assert.equal(fake.stats().reads, 0, `Content-Length ${header} was read`);
  }
  const oversized = controllableRequest();
  const outcome = { state: 'pending' };
  const finished = readSmallJson(oversized).then(
    value => { outcome.state = 'resolved'; outcome.value = value; },
    error => { outcome.state = 'rejected'; outcome.error = error; },
  );
  oversized.push(Buffer.from('{"pad":"' + MARKER));
  try { oversized.push(Buffer.from('b'.repeat(1100))); } catch { /* destroyed as the limit was crossed */ }
  await Promise.race([finished, new Promise(resolve => setTimeout(resolve, 1000))]);
  assert.equal(outcome.state, 'rejected', 'streamed body over 1024 bytes did not reject before end');
  assert.equal(oversized.destroyed === true || oversized.destroyCalls > 0, true, 'oversized stream was not destroyed');
  try { oversized.push(Buffer.from('late-data')); } catch { /* destroy closes the stream */ }
  try { oversized.push(null); } catch { /* destroy closes the stream */ }
  oversized.emit('data', Buffer.from('late-event'));
  oversized.emit('end');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(outcome.state, 'rejected', 'later data/end resolved an oversized body');
  assert.equal(lines.some(line => line.includes(MARKER)), false, 'readSmallJson logged the body');
});


// --- 5.1.9 added by the acceptor after mutation testing (SV3/RC5 looked equivalent but are observable) ---
// The frozen handler re-checks Content-Length and the SERIALIZED size, so a wide-open body reader is invisible with
// a Content-Length request. Without Content-Length (chunked) a valid JSON object padded with spaces is only refused
// when the server really uses the bounded 1 KiB reader.
async function bootRecovery(t) {
  const { fixture } = require('./helpers/web-chat-fixture');
  const recovery = require('../lib/web-chat-recovery-server');
  const f = fixture(t);
  const watcherModule = require('../lib/procwatch');
  const originalWatcher = watcherModule.create;
  const restoreInventory = require('./helpers/owned-native-fixture').freshInventory();
  const secret = crypto.randomBytes(32).toString('base64url');
  let service;
  try {
    service = recovery.create({ root: f.root, hubDir: path.join(__dirname, '..'), port: 0, secret, admission: { recoveryOnly: true, format: 'web-manual-v2', pending: [], inspection: [] } });
  } finally {
    restoreInventory();
    watcherModule.create = originalWatcher;
  }
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const port = service.server.address().port;
  t.after(async () => {
    service.server.closeAllConnections?.();
    await new Promise(resolve => service.server.close(resolve));
  });
  return { port, secret };
}

test('5.1.9 a chunked body padded past 1 KiB is refused in both modes, a small chunked body is accepted, and the server stays healthy', { timeout: 90000 }, async t => {
  const normal = await bootNormal(t);
  const recoveryMode = await bootRecovery(t);
  for (const [label, { port, secret }] of [['normal', normal], ['recovery', recoveryMode]]) {
    const chunked = body => request({ port, method: 'POST', path: '/api/local/browser/begin', headers: browserHeaders(port, { 'Transfer-Encoding': 'chunked' }), body });
    const small = await chunked('{}');
    assert.equal(small.status, 200, `${label}: a small chunked begin must work (${small.status} ${small.error || ''})`);
    const padded = await chunked('{}' + ' '.repeat(4000));
    // The bounded reader destroys the request stream on overflow, so the client sees either a 400 or a reset (status 0).
    // A wide-open reader would read the whole valid JSON and answer 200.
    assert.ok([0, 400].includes(padded.status), `${label}: a valid but padded chunked body must be refused by the bounded reader (got ${padded.status})`);
    assert.notEqual(padded.status, 200);
    const healthy = await begin(port, secret);
    assert.match(healthy.id, /^[0-9a-f]{32}$/, `${label}: server must stay healthy after the refused body`);
  }
});
test('5.1.10 tunnel markers are refused on the unauthenticated routes in normal and RecoveryOnly mode', { timeout: 90000 }, async t => {
  const normal = await bootNormal(t);
  const recoveryMode = await bootRecovery(t);
  for (const [label, { port }] of [['normal', normal], ['recovery', recoveryMode]]) {
    for (const header of ['Tailscale-User-Login', 'X-Forwarded-For', 'X-Forwarded-Host']) {
      const response = await request({ port, method: 'POST', path: '/api/local/browser/begin', headers: browserHeaders(port, { 'Content-Length': '2', [header]: 'x' }), body: '{}' });
      assert.equal(response.status, 403, `${label}: begin with ${header} must be refused (got ${response.status})`);
    }
  }
  for (const header of ['Tailscale-User-Login', 'X-Forwarded-For']) {
    const response = await request({ port: recoveryMode.port, method: 'GET', path: '/local-auth.js', headers: { Host: `127.0.0.1:${recoveryMode.port}`, Connection: 'close', [header]: 'x' } });
    assert.equal(response.status, 403, `recovery: /local-auth.js with ${header} must be refused (got ${response.status})`);
  }
});