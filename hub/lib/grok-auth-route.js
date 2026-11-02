'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function create({port, runId, token, mint, now = Date.now, record = () => {}}) {
  const target = 'http://127.0.0.1:' + port + '/api/native/grok-token';
  const expectedAuth = Buffer.from('Bearer ' + token);
  const nonces = new Set();
  let closed = false, capacity = 3, lastRefill = now();
  function headers(req) {
    if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2) return null;
    const values = new Map();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (typeof req.rawHeaders[i] !== 'string' || typeof req.rawHeaders[i + 1] !== 'string') return null;
      const name = req.rawHeaders[i].toLowerCase();
      if (values.has(name) || /^(cookie|transfer-encoding|forwarded|tailscale-user-login)$/.test(name) || name.startsWith('x-forwarded-')) return null;
      values.set(name, req.rawHeaders[i + 1]);
    }
    const authorization = Buffer.from(values.get('authorization') || '');
    if (authorization.length !== expectedAuth.length || !crypto.timingSafeEqual(authorization, expectedAuth) ||
        values.get('host') !== '127.0.0.1:' + port || values.get('x-hub') !== '1' || values.get('x-hub-grok-run') !== runId ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(values.get('content-type') || '')) return null;
    const length = values.get('content-length'), nonce = values.get('x-hub-grok-nonce');
    if (!/^[1-9][0-9]{0,2}$/.test(length || '') || Number(length) > 256 || !noncePattern.test(nonce || '') || nonces.has(nonce)) return null;
    nonces.add(nonce);
    if (nonces.size > 64) nonces.delete(nonces.values().next().value);
    return Number(length);
  }
  function readBody(req, length) {
    return new Promise((resolve, reject) => {
      let size = 0, done = false;
      const chunks = [];
      const fail = () => { if (!done) { done = true; reject(Error('BODY')); } };
      req.on('data', chunk => {
        if (done) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > length) return fail();
        chunks.push(bytes);
      });
      req.once('error', fail);req.once('aborted', fail);
      req.once('end', () => {
        if (done) return;
        try {
          if (size !== length) throw Error('BODY');
          const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
          if (!plain(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'expired') || typeof body.expired !== 'boolean') throw Error('BODY');
          done = true;resolve(body.expired);
        } catch { fail(); }
      });
    });
  }
  async function handle(req, res) {
    let expired = null;
    function reply(status, outcome, body, expiresIn = null) {
      try { record('grok-auth-route', {runId, outcome, expired, expiresIn}); } catch { /* Never log credentials or affect delivery. */ }
      const bytes = JSON.stringify(body);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', Buffer.byteLength(bytes));res.end(bytes);
    }
    const reject = status => reply(status, 'rejected', {error: 'GROK_AUTH_ROUTE_REJECTED'});
    const unavailable = () => reply(503, 'unavailable', {error: 'GROK_AUTH_ROUTE_UNAVAILABLE'});
    const gone = () => reply(410, 'closed', {error: 'GROK_AUTH_ROUTE_CLOSED'});
    if (closed) return gone();
    if (req.method !== 'POST') return reject(405);
    if (req.url !== target) return reject(404);
    const length = headers(req);
    if (length === null) return reject(403);
    try { expired = await readBody(req, length); } catch { return closed ? gone() : reject(400); }
    if (closed) return gone();
    const time = now();
    capacity = Math.min(3, capacity + Math.max(0, time - lastRefill) / 20000);
    lastRefill = Math.max(time, lastRefill);
    if (capacity < 1) return reply(429, 'rate-limited', {error: 'GROK_AUTH_ROUTE_RATE_LIMITED'});
    capacity--;
    try {
      const value = await mint({expired});
      if (closed) return gone();
      if (!plain(value) || typeof value.access_token !== 'string' || value.access_token.length < 1 || value.access_token.length > 8192 ||
          /[\x00-\x1f\x7f-\x9f]/.test(value.access_token) || !Number.isInteger(value.expires_in) || value.expires_in < 1) return unavailable();
      return reply(200, 'ok', {access_token: value.access_token, expires_in: value.expires_in}, value.expires_in);
    } catch { return closed ? gone() : unavailable(); }
  }
  function close() { closed = true; nonces.clear(); }
  return Object.freeze({handle, close});
}
// A Hub crash leaves the previous run's route file behind; its listener and token died with that process.
function clearStaleRouteFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw Error('GROK_ROUTE_FILE_UNEXPECTED');
  fs.unlinkSync(file);
  return true;
}
module.exports = {create, clearStaleRouteFile};
