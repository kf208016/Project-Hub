'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 2 * 1024 * 1024; // 2 MiB
const MAX_REPLY = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_TIMEOUT = 120000;
const MAX_TIMEOUT = 120000;

const ALLOWED_GET_HEADERS = new Set(['host', 'authorization', 'x-hub-mcp-run', 'proxy-authorization', 'accept', 'x-hub']);
const ALLOWED_POST_HEADERS = new Set([
  'host', 'authorization', 'x-hub-mcp-run', 'content-type', 'content-length', 'x-hub-mcp-nonce', 'proxy-authorization', 'accept', 'x-hub'
]);
const FORBIDDEN_HEADERS = new Set(['cookie', 'transfer-encoding']);

function validateOpts(opts) {
  if (!opts || typeof opts !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(opts)) || Object.getOwnPropertySymbols(opts).length || Object.getOwnPropertyNames(opts).length!==3 || Object.values(Object.getOwnPropertyDescriptors(opts)).some(d=>!d.enumerable||!Object.hasOwn(d,'value'))) throw new TypeError('opts required');
  const keys = Object.keys(opts).sort();
  const expected = ['port', 'runId', 'token'].sort();
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
    throw new TypeError('opts must have exact keys: port, token, runId');
  }
  const { port, token, runId } = opts;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError('invalid port');
  }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    throw new TypeError('invalid token');
  }
  if (typeof runId !== 'string' || !UUID_RE.test(runId)) {
    throw new TypeError('invalid runId');
  }
  return { port, token, runId };
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // still do a compare to avoid timing leak of length difference significance
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function safeDestroy(res) {
  try {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain');
      res.end('Bad Gateway');
    } else {
      res.destroy();
    }
  } catch {
    try { res.destroy(); } catch {}
  }
}

function create(rawOpts) {
  const { port, token, runId } = validateOpts(rawOpts);

  const GET_TARGET = `http://127.0.0.1:${port}/api/mcp/tools`;
  const POST_TARGET = `http://127.0.0.1:${port}/api/mcp/call`;

  function validateHeaders(req, isPost) {
    const headers = req.headers;
    const rawHeaderNames = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      rawHeaderNames.push(req.rawHeaders[i].toLowerCase());
    }
    const seen = new Set();
    for (const name of rawHeaderNames) {
      if (FORBIDDEN_HEADERS.has(name)) return null;
      if (seen.has(name)) return null;
      seen.add(name);
    }
    const allowedSet = isPost ? ALLOWED_POST_HEADERS : ALLOWED_GET_HEADERS;
    for (const name of rawHeaderNames) {
      if (!allowedSet.has(name) && name !== 'connection' && name !== 'content-length' && !name.startsWith(':')) {
        // unknown headers: only allow a tiny safe allowlist beyond required; reject others
        if (!allowedSet.has(name)) return null;
      }
    }

    const hostHeader = headers['host'];
    if (typeof hostHeader !== 'string' || hostHeader !== `127.0.0.1:${port}`) return null;

    const auth = headers['authorization'];
    if (typeof auth !== 'string') return null;
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m) return null;
    const providedToken = m[1];
    if (!constantTimeEqual(providedToken, token)) return null;

    const runHeader = headers['x-hub-mcp-run'];
    if (typeof runHeader !== 'string' || runHeader !== runId) return null;

    if (isPost) {
      const ct = headers['content-type'];
      if (typeof ct !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(ct)) return null;

      const clRaw = headers['content-length'];
      if (typeof clRaw !== 'string'||! /^(?:0|[1-9][0-9]{0,6})$/.test(clRaw)) return null;
      const cl = Number(clRaw);
      if (!Number.isInteger(cl) || cl < 1 || cl > MAX_BODY) return null;

      const nonce = headers['x-hub-mcp-nonce'];
      if (typeof nonce !== 'string' || !UUID_RE.test(nonce)) return null;
      return { contentLength: cl, nonce };
    } else {
      if (headers['content-length'] !== undefined) return null;
      if (headers['transfer-encoding'] !== undefined) return null;
      return {};
    }
  }

  function handle(req, res) {
    if (req.headers.upgrade) {
      destroyNoResponse(req, res);
      return;
    }
    if (req.method === 'CONNECT') {
      destroyNoResponse(req, res);
      return;
    }

    const method = req.method;
    const url = req.url || '';

    let isPost;
    if (method === 'GET') {
      if (url !== GET_TARGET) return reject(res, 404);
      isPost = false;
    } else if (method === 'POST') {
      if (url !== POST_TARGET) return reject(res, 404);
      isPost = true;
    } else {
      return reject(res, 405);
    }

    const validated = validateHeaders(req, isPost);
    if (!validated) return reject(res, 403);

    if (!isPost) {
      // GET must have no body
      req.on('data', () => {
        reject(res, 400);
        req.destroy();
      });
      forward(req, res, { method: 'GET', path: '/api/mcp/tools', contentLength: 0, nonce: undefined });
      return;
    }

    // POST: read exactly contentLength bytes
    const expectedLen = validated.contentLength;
    const chunks = [];
    let received = 0;
    let finished = false;

    function fail(code) {
      if (finished) return;
      finished = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      reject(res, code);
      req.resume();
    }

    req.on('data', (chunk) => {
      if (finished) return;
      received += chunk.length;
      if (received > expectedLen) return fail(400);
      chunks.push(chunk);
    });
    req.on('error', () => fail(502));
    req.on('end', () => {
      if (finished) return;
      if (received !== expectedLen) return fail(400);
      finished = true;
      const body = Buffer.concat(chunks);
      try {
        JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
      } catch {
        return reject(res, 400);
      }
      forward(req, res, {
        method: 'POST',
        path: '/api/mcp/call',
        body,
        contentLength: expectedLen,
        nonce: validated.nonce
      });
    });
  }

  function forward(clientReq, clientRes, { method, path, body, contentLength, nonce }) {
    const headers = {
      'x-hub': '1',
      'authorization': `Bearer ${token}`,
      'x-hub-mcp-run': runId,
      'host': `127.0.0.1:${port}`
    };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(contentLength);
      if (nonce) headers['x-hub-mcp-nonce'] = nonce;
    }

    let settled = false;
    const upstreamReq = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
      agent: false,
      timeout: DEFAULT_TIMEOUT
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        upstreamReq.destroy();
        safeDestroy(clientRes);
      }
    }, Math.min(DEFAULT_TIMEOUT, MAX_TIMEOUT));

    function cleanup() {
      clearTimeout(timeout);
    }

    upstreamReq.on('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      safeDestroy(clientRes);
    });

    upstreamReq.on('timeout', () => {
      if (settled) return;
      settled = true;
      cleanup();
      upstreamReq.destroy();
      safeDestroy(clientRes);
    });

    upstreamReq.on('response', (upstreamRes) => {
      if (settled) {
        upstreamRes.destroy();
        return;
      }
      if (upstreamRes.headers.upgrade) {
        settled = true;
        cleanup();
        upstreamRes.destroy();
        safeDestroy(clientRes);
        return;
      }
      const status = upstreamRes.statusCode;
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        settled = true;
        cleanup();
        upstreamRes.destroy();
        safeDestroy(clientRes);
        return;
      }

      let size = 0;
      const resChunks = [];
      let overflowed = false;

      upstreamRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_REPLY) {
          overflowed = true;
          upstreamRes.destroy();
          return;
        }
        resChunks.push(chunk);
      });

      upstreamRes.on('error', () => {
        if (settled) return;
        settled = true;
        cleanup();
        safeDestroy(clientRes);
      });

      upstreamRes.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (overflowed) {
          safeDestroy(clientRes);
          return;
        }
        try {
          const safeHeaders = {};
          const ct = upstreamRes.headers['content-type'];
          if (ct) safeHeaders['content-type'] = ct;
          const outBody = Buffer.concat(resChunks);
          safeHeaders['content-length'] = String(outBody.length);
          clientRes.writeHead(status, safeHeaders);
          clientRes.end(outBody);
        } catch {
          safeDestroy(clientRes);
        }
      });
    });

    clientRes.on('close', () => {
      if (!settled) {
        settled = true;
        cleanup();
        upstreamReq.destroy();
      }
    });

    if (method === 'POST' && body) {
      upstreamReq.end(body);
    } else {
      upstreamReq.end();
    }
  }

  function reject(res, code) {
    try {
      if (!res.headersSent) {
        res.statusCode = code;
        res.setHeader('content-type', 'text/plain');
        res.end(code === 404 || code === 403 || code === 405 ? 'Forbidden' : 'Bad Request');
      } else {
        res.destroy();
      }
    } catch {
      try { res.destroy(); } catch {}
    }
  }

  function destroyNoResponse(req, res) {
    try { req.destroy(); } catch {}
    try { res.destroy(); } catch {}
  }

  return { handle };
}

module.exports = { create };
