'use strict';
// Synthetic Hub stand-in for the native approval controller tests.
// It uses the REAL local-auth module and the REAL one-time browser login handler, so the controller
// is exercised against the production request/response contract. It never touches a provider or a real DataRoot.
// FIXTURE_MODE: normal | wrong-proof (answers the proof without the secret) | oversized-proof |
//   odd-cookie (login succeeds but the Set-Cookie has the wrong shape) | two-cookies (login sets two cookies)
// FIXTURE_HOST: address to listen on (default 127.0.0.1; 127.0.0.2 proves the controller checks the listener address)
const http = require('node:http');
const { create: createAuth } = require('../../lib/local-auth');
const { create: createBrowserLogin } = require('../../lib/browser-login-http');

const port = Number(process.env.FIXTURE_PORT);
const token = process.env.FIXTURE_TOKEN;
const mode = process.env.FIXTURE_MODE || 'normal';
delete process.env.FIXTURE_TOKEN; // keep the synthetic credential out of any child environment

const auth = createAuth(token);
const stats = { proofs: 0, logins: 0, loginAccepted: 0 };
const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error('bound');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return text ? JSON.parse(text) : {};
}
// Mirrors server.js allowed().
function allowed(req) {
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return false;
  return req.headers['x-hub'] === '1';
}

const browserLogin = createBrowserLogin({ auth, port, send, readBody });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/__stats') return send(res, 200, stats);
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/api/local/proof') {
      stats.proofs++;
      if (mode === 'wrong-proof') return send(res, 200, { proof: '0'.repeat(64) });
      if (mode === 'oversized-proof') return send(res, 200, { proof: 'a'.repeat(5000) });
      try { return send(res, 200, { proof: auth.proof(url.searchParams.get('challenge')) }); }
      catch { return send(res, 400, { error: 'Invalid challenge' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local/login') {
      stats.logins++;
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { error: 'invalid request' }); }
      if (!auth.login(body.token)) return send(res, 403, { error: 'forbidden' });
      stats.loginAccepted++;
      if (mode === 'odd-cookie') res.setHeader('Set-Cookie', 'hub_local_session=short; Path=/; HttpOnly; SameSite=Strict');
      else if (mode === 'two-cookies') res.setHeader('Set-Cookie', [auth.cookie, 'extra=1; Path=/']);
      else res.setHeader('Set-Cookie', auth.cookie);
      return send(res, 200, { ok: true });
    }
    if (await browserLogin.handle(req, res, url)) return;
    return send(res, 404, { error: 'not found' });
  } catch {
    return send(res, 500, { error: 'fixture_failure' });
  }
});
server.listen(port, process.env.FIXTURE_HOST || '127.0.0.1', () => console.log('ready'));
