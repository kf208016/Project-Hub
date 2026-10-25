'use strict';
const { BrowserLoginFSM } = require('./browser-login');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_JSON = 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const ID_NONCE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;

function genericError(status, code) {
  return { status, body: { ok: false, error: code } };
}

// Browsers do not isolate cookies by port, so every other app on 127.0.0.1 shares this header. Only the Hub's own
// cookie names are inspected; a duplicate of THEIR names is ambiguous and refused, foreign cookies are ignored
// (their size is already bounded by the HTTP server's header limit).
function parseCookies(header, ownNames) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!ownNames.has(name)) continue;
    if (name in out) throw new Error('duplicate_cookie');
    out[name] = part.slice(idx + 1).trim();
  }
  return out;
}

function isLoopbackSocket(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function exactHostAllowed(hostHeader, port) {
  if (typeof hostHeader !== 'string') return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function hasForbiddenHeaders(req) {
  const h = req.headers || {};
  if (h.authorization !== undefined) return true;
  for (const key of Object.keys(h)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-forwarded-')) return true;
    if (lower === 'forwarded') return true;
    if (lower === 'x-real-ip') return true;
  }
  return false;
}

function exactContentType(h) {
  const ct = h['content-type'];
  if (typeof ct !== 'string') return false;
  return ct === 'application/json' || ct === 'application/json; charset=utf-8';
}

function validateBeginBody(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  return Object.keys(obj).length === 0;
}

function validatePollApproveBody(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'requestId') return false;
  const v = obj.requestId;
  if (typeof v !== 'string') return false;
  return HEX32.test(v);
}

function create({ auth, port, readBody, send, fsm }) {
  if (!auth || typeof auth.check !== 'function' || typeof auth.cookie !== 'string') {
    throw new Error('invalid_auth');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('invalid_port');
  }
  if (typeof readBody !== 'function') throw new Error('invalid_readBody');
  if (typeof send !== 'function') throw new Error('invalid_send');
  const machine = fsm || new BrowserLoginFSM();

  const pendingCookieName = `hub_local_pending_${port}`;
  const ownCookieNames = new Set([pendingCookieName, auth.cookie.split('=')[0]]);

  function clearPendingCookieHeader() {
    return `${pendingCookieName}=; Path=/api/local/browser; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  function baseGuards(req, res, url) {
    if (!isLoopbackSocket(req)) return genericError(403, 'forbidden');
    const hostHeader = req.headers.host;
    if (!exactHostAllowed(hostHeader, port)) return genericError(403, 'forbidden');
    const hub = req.headers['x-hub'];
    if (hub !== '1') return genericError(403, 'forbidden');
    if (hasForbiddenHeaders(req)) return genericError(403, 'forbidden');
    if (!exactContentType(req.headers)) return genericError(400, 'bad_request');
    if (url.search && url.search.length > 0) {
      // any query string present is unexpected
      return genericError(400, 'bad_request');
    }
    return null;
  }

  function checkOriginMatchesHost(req, hostHeader, required) {
    const origin = req.headers.origin;
    if (origin === undefined) {
      return required ? genericError(400, 'bad_request') : null;
    }
    const expected = `http://${hostHeader}`;
    if (origin !== expected) return genericError(403, 'forbidden');
    return null;
  }

  async function readJsonBody(req) {
    const MAX_JSON = 1024;

    // Validate optional content-length header: must be exact decimal 0..1024
    const rawLen = req && req.headers ? req.headers['content-length'] : undefined;
    if (rawLen !== undefined && rawLen !== null) {
      const s = String(rawLen);
      if (!/^[0-9]+$/.test(s)) {
        throw new Error('INVALID_CONTENT_LENGTH');
      }
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > MAX_JSON) {
        throw new Error('INVALID_CONTENT_LENGTH');
      }
    }

    // readBody already returns parsed JSON (not a raw string). Do not JSON.parse it.
    const parsed = await readBody(req);

    // Reject null, scalars, Buffer, Date, and non-plain objects.
    // Accept only plain objects or Arrays (route validator rejects arrays later).
    if (parsed === null || parsed === undefined) {
      throw new Error('INVALID_JSON_BODY');
    }

    const t = typeof parsed;
    if (t !== 'object') {
      // scalars (string/number/boolean/bigint/symbol/function)
      throw new Error('INVALID_JSON_BODY');
    }

    if (Buffer.isBuffer(parsed)) {
      throw new Error('INVALID_JSON_BODY');
    }

    if (parsed instanceof Date) {
      throw new Error('INVALID_JSON_BODY');
    }

    const isArray = Array.isArray(parsed);
    if (!isArray) {
      // must be a plain object: prototype is Object.prototype or null
      const proto = Object.getPrototypeOf(parsed);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('INVALID_JSON_BODY');
      }
    }

    // Bound size via serialization (do not re-parse; just measure size).
    let serialized;
    try {
      serialized = JSON.stringify(parsed);
    } catch (e) {
      throw new Error('INVALID_JSON_BODY');
    }

    if (typeof serialized !== 'string') {
      throw new Error('INVALID_JSON_BODY');
    }

    const byteLength = Buffer.byteLength(serialized);
    if (byteLength > MAX_JSON) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }

    return parsed;
  }

  async function handleBegin(req, res, url) {
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const g = baseGuards(req, res, url);
    if (g) { send(res, g.status, g.body); return true; }
    const hostHeader = req.headers.host;
    const originErr = checkOriginMatchesHost(req, hostHeader, true);
    if (originErr) { send(res, originErr.status, originErr.body); return true; }
    try {
      parseCookies(req.headers.cookie, ownCookieNames);
    } catch (e) {
      send(res, 400, { ok: false, error: 'bad_request' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      send(res, 400, { ok: false, error: 'bad_request' });
      return true;
    }
    if (!validateBeginBody(body)) { send(res, 400, { ok: false, error: 'bad_request' }); return true; }
    const result = machine.createPending();
    if (!result.ok) { send(res, 409, { ok: false, error: 'conflict' }); return true; }
    const cookieVal = `${result.id}.${result.nonce}`;
    const cookieHeader = `${pendingCookieName}=${cookieVal}; Path=/api/local/browser; HttpOnly; SameSite=Strict; Max-Age=60`;
    res.setHeader('Set-Cookie', cookieHeader);
    send(res, 200, { ok: true, requestId: result.id, expiresInSeconds: 60 });
    return true;
  }

  async function handlePoll(req, res, url) {
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const g = baseGuards(req, res, url);
    if (g) { send(res, g.status, g.body); return true; }
    const hostHeader = req.headers.host;
    const originErr = checkOriginMatchesHost(req, hostHeader, true);
    if (originErr) { send(res, originErr.status, originErr.body); return true; }
    let cookies;
    try {
      cookies = parseCookies(req.headers.cookie, ownCookieNames);
    } catch (e) {
      send(res, 400, { ok: false, error: 'bad_request' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      send(res, 400, { ok: false, error: 'bad_request' });
      return true;
    }
    if (!validatePollApproveBody(body)) { send(res, 400, { ok: false, error: 'bad_request' }); return true; }
    const pendingCookie = cookies[pendingCookieName];
    if (typeof pendingCookie !== 'string' || !ID_NONCE.test(pendingCookie)) {
      send(res, 409, { ok: false, error: 'conflict' });
      return true;
    }
    const [cookieId, cookieNonce] = pendingCookie.split('.');
    if (cookieId !== body.requestId) {
      send(res, 409, { ok: false, error: 'conflict' });
      return true;
    }
    const result = machine.pollAndConsume(cookieId, cookieNonce);
    if (result.ok) {
      res.setHeader('Set-Cookie', [auth.cookie, clearPendingCookieHeader()]);
      send(res, 200, { ok: true });
      return true;
    }
    if (result.error === 'NOT_APPROVED') {
      send(res, 202, { ok: false, pending: true });
      return true;
    }
    send(res, 409, { ok: false, error: 'conflict' });
    return true;
  }

  async function handleApprove(req, res, url) {
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const g = baseGuards(req, res, url);
    if (g) { send(res, g.status, g.body); return true; }
    const hostHeader = req.headers.host;
    const originErr = checkOriginMatchesHost(req, hostHeader, false);
    if (originErr) { send(res, originErr.status, originErr.body); return true; }
    // Bound and reject duplicate cookies before authenticating the owner.
    try { parseCookies(req.headers.cookie, ownCookieNames); }
    catch { send(res, 400, { ok: false, error: 'bad_request' }); return true; }
    // owner cookie check BEFORE body read
    const ownerOk = (() => {
      try {
        return auth.check(req) === true;
      } catch (e) {
        return false;
      }
    })();
    if (!ownerOk) { send(res, 403, { ok: false, error: 'forbidden' }); return true; }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      send(res, 400, { ok: false, error: 'bad_request' });
      return true;
    }
    if (!validatePollApproveBody(body)) { send(res, 400, { ok: false, error: 'bad_request' }); return true; }
    const result = machine.approve(body.requestId);
    if (result.ok) { send(res, 200, { ok: true }); return true; }
    send(res, 409, { ok: false, error: 'conflict' });
    return true;
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/api/local/browser/begin') return handleBegin(req, res, url);
    if (pathname === '/api/local/browser/poll') return handlePoll(req, res, url);
    if (pathname === '/api/local/browser/approve') return handleApprove(req, res, url);
    return false;
  }

  return { handle };
}

module.exports = { create };
