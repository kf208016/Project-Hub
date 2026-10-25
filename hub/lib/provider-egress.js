'use strict';
const {MAX_WALL_MS}=require('./native-turn-limits');
/*
 * provider-egress.js
 * Scoped HTTPS CONNECT broker. It never reads provider credentials or decrypts
 * TLS. A vendor connection occurs only when an admitted client requests one.
 * Caller MUST separately enforce OS-level direct-network deny; this proxy
 * alone is bypassable if the caller does not restrict egress.
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const dns = require('dns').promises;

const PROVIDER_HOSTS = Object.freeze({
  claude: Object.freeze(['api.anthropic.com', 'claude.ai']),
  // Public fixed-revision xai-grok-env/src/lib.rs production endpoint.
  // No wildcard, web relay, assets, or unverified login hostname grants.
  grok: Object.freeze(['api.x.ai', 'cli-chat-proxy.grok.com'])
});

const DEFAULTS = {
  maxConnections: 4,
  maxTunnelBytes: 33554432,
  maxTotalBytes: 67108864,
  maxWallMs: MAX_WALL_MS,
  connectTimeoutMs: 10000,
  helloTimeoutMs: 5000
};
const LIMITS = {
  maxConnections: { min: 1, max: 8 },
  maxTunnelBytes: { min: 1, max: 33554432 },
  maxTotalBytes: { min: 1, max: 67108864 },
  maxWallMs: { min: 1, max: MAX_WALL_MS },
  connectTimeoutMs: { min: 1, max: 10000 },
  helloTimeoutMs: { min: 1, max: 5000 }
};
const ALLOWED_KEYS = new Set(['provider', 'maxConnections', 'maxTunnelBytes', 'maxTotalBytes', 'maxWallMs', 'connectTimeoutMs', 'helloTimeoutMs', 'onAudit','handleHttp']);

const MAX_HELLO_BYTES = 65536;
const MAX_PENDING_BUFFER = 65536;
const ECH_EXT_TYPE = 0xfe0d;

function checkInt(name, val) {
  const def = DEFAULTS[name];
  if (val === undefined) return def;
  const { min, max } = LIMITS[name];
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < min || val > max) {
    throw new Error('invalid-option:' + name);
  }
  return val;
}

function isAsciiNoControl(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x21 || c === 0x7f || c > 0x7e) return false;
  }
  return true;
}

const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseAuthority(authorityLower, allowedHosts) {
  if (!isAsciiNoControl(authorityLower)) return null;
  if (authorityLower.includes('@') || authorityLower.includes('%')) return null;
  const parts = authorityLower.split(':');
  if (parts.length !== 2) return null;
  const [host, port] = parts;
  if (port !== '443') return null;
  if (host.endsWith('.') || host.length === 0) return null;
  if (!DNS_LABEL_RE.test(host)) return null;
  if (!allowedHosts.includes(host)) return null;
  return host;
}

// ---------- IP classification (global unicast only) ----------
function ipv4Octets(ip) {
  const m = ip.split('.').map(Number);
  if (m.length !== 4 || m.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return m;
}

function isGlobalIPv4(ip) {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && o[2] === 2) return false; // doc
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark
  if (a === 198 && b === 51 && o[2] === 100) return false; // doc
  if (a === 203 && b === 0 && o[2] === 113) return false; // doc
  if (a >= 224) return false; // multicast + reserved
  if (a === 255 && b === 255 && o[2] === 255 && o[3] === 255) return false;
  return true;
}

function isGlobalIPv6(ip) {
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return false;
  // normalize via net to get full groups
  const buf = ipv6ToBytes(low);
  if (!buf) return false;
  // ::ffff:0:0/96 ipv4-mapped
  if (buf.slice(0, 10).every((b) => b === 0) && buf[10] === 0xff && buf[11] === 0xff) return false;
  // 64:ff9b::/96 and 2002::/16 (6to4) ipv4-embedding
  if (buf[0] === 0x00 && buf[1] === 0x64 && buf[2] === 0xff && buf[3] === 0x9b) return false;
  if (buf[0] === 0x20 && buf[1] === 0x02) return false;
  if (buf[0]===0x20&&buf[1]===0x01&&(buf[2]&0xfe)===0) return false;
  if (buf[0]===0x3f&&buf[1]===0xff&&(buf[2]&0xf0)===0) return false;
  // fc00::/7 ULA
  if ((buf[0] & 0xfe) === 0xfc) return false;
  // fe80::/10 link-local
  if (buf[0] === 0xfe && (buf[1] & 0xc0) === 0x80) return false;
  // ff00::/8 multicast
  if (buf[0] === 0xff) return false;
  // 2001:db8::/32 documentation
  if (buf[0] === 0x20 && buf[1] === 0x01 && buf[2] === 0x0d && buf[3] === 0xb8) return false;
  // must be within 2000::/3 global unicast
  if ((buf[0] & 0xe0) !== 0x20) return false;
  return true;
}

function ipv6ToBytes(ip) {
  if (!net.isIPv6(ip)) return null;
  let head = ip;
  let tail = '';
  if (ip.includes('::')) {
    const idx = ip.indexOf('::');
    head = ip.slice(0, idx);
    tail = ip.slice(idx + 2);
  } else {
    tail = '';
  }
  const headParts = head.length ? head.split(':') : [];
  const tailParts = tail.length ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const groups = headParts.concat(new Array(missing).fill('0'), tailParts);
  if (groups.length !== 8) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (groups[i].includes('.')) {
      // ipv4 embedded in last group textual form not standard split; bail
      return null;
    }
    const v = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    buf[i * 2] = (v >> 8) & 0xff;
    buf[i * 2 + 1] = v & 0xff;
  }
  return buf;
}

function isGlobalUnicast(addr, family) {
  if (family === 4) return isGlobalIPv4(addr);
  if (family === 6) return isGlobalIPv6(addr);
  return false;
}

// ---------- Pure TLS ClientHello inspector ----------
function inspectClientHello(buffer, expectedHost) {
  if (!Buffer.isBuffer(buffer)) return { status: 'invalid', code: 'bad-input' };
  if (buffer.length > MAX_HELLO_BYTES) return { status: 'invalid', code: 'hello-too-large' };
  const expected = String(expectedHost).toLowerCase();
  let offset = 0;
  let handshake = Buffer.alloc(0);
  while (true) {
    if (buffer.length - offset < 5) {
      if (handshake.length === 0 && offset === 0) return { status: 'need-more' };
      return { status: 'need-more' };
    }
    const type = buffer[offset];
    const verMajor = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 3);
    if (type !== 22) return { status: 'invalid', code: 'non-handshake-record' };
    if (verMajor !== 3) return { status: 'invalid', code: 'bad-record-version' };
    if (length > 16384) return { status: 'invalid', code: 'record-too-large' };
    const recordTotal = 5 + length;
    if (buffer.length - offset < recordTotal) return { status: 'need-more' };
    const payload = buffer.slice(offset + 5, offset + recordTotal);
    handshake = Buffer.concat([handshake, payload]);
    offset += recordTotal;

    if (handshake.length < 4) continue;
    const htype = handshake[0];
    if (htype !== 1) return { status: 'invalid', code: 'not-client-hello' };
    const hlen = (handshake[1] << 16) | (handshake[2] << 8) | handshake[3];
    if (hlen > 65532) return { status: 'invalid', code: 'handshake-too-large' };
    if (handshake.length - 4 < hlen) {
      if (offset >= buffer.length) return { status: 'need-more' };
      continue;
    }
    const body = handshake.slice(4, 4 + hlen);
    const result = parseClientHelloBody(body, expected);
    if (result.status === 'valid') {
      return { status: 'valid', code: 'ok', consumed: offset };
    }
    return result;
  }
}

function parseClientHelloBody(body, expectedHost) {
  let p = 0;
  function need(n) { return body.length - p >= n; }
  if (!need(2 + 32 + 1)) return { status: 'invalid', code: 'malformed-hello' };
  if(body[0]!==3||body[1]<1||body[1]>3)return {status:'invalid',code:'malformed-hello'};
  p += 2; // legacy version
  p += 32; // random
  const sidLen = body[p]; p += 1;
  if(sidLen>32)return {status:'invalid',code:'malformed-hello'};
  if (!need(sidLen)) return { status: 'invalid', code: 'malformed-hello' };
  p += sidLen;
  if (!need(2)) return { status: 'invalid', code: 'malformed-hello' };
  const csLen = body.readUInt16BE(p); p += 2;
  if(csLen<2||csLen%2)return {status:'invalid',code:'malformed-hello'};
  if (!need(csLen)) return { status: 'invalid', code: 'malformed-hello' };
  p += csLen;
  if (!need(1)) return { status: 'invalid', code: 'malformed-hello' };
  const compLen = body[p]; p += 1;
  if(compLen<1)return {status:'invalid',code:'malformed-hello'};
  if (!need(compLen)) return { status: 'invalid', code: 'malformed-hello' };
  p += compLen;
  if (p === body.length) return { status: 'invalid', code: 'missing-sni' };
  if (!need(2)) return { status: 'invalid', code: 'malformed-hello' };
  const extsLen = body.readUInt16BE(p); p += 2;
  if (body.length - p !== extsLen) return { status: 'invalid', code: 'malformed-hello' };
  const extsEnd = p + extsLen;
  const seenTypes = new Set();
  let sniHost = null;
  while (p < extsEnd) {
    if (extsEnd - p < 4) return { status: 'invalid', code: 'malformed-hello' };
    const extType = body.readUInt16BE(p);
    const extLen = body.readUInt16BE(p + 2);
    p += 4;
    if (extsEnd - p < extLen) return { status: 'invalid', code: 'malformed-hello' };
    const extData = body.slice(p, p + extLen);
    if (seenTypes.has(extType)) return { status: 'invalid', code: 'duplicate-extension' };
    seenTypes.add(extType);
    if (extType === ECH_EXT_TYPE) return { status: 'invalid', code: 'ech-present' };
    if (extType === 0) {
      if (extData.length < 2) return { status: 'invalid', code: 'malformed-hello' };
      const listLen = extData.readUInt16BE(0);
      if (listLen !== extData.length - 2) return { status: 'invalid', code: 'malformed-hello' };
      let q = 2;
      let count = 0;
      let name = null;
      while (q < extData.length) {
        if (extData.length - q < 3) return { status: 'invalid', code: 'malformed-hello' };
        const nType = extData[q]; q += 1;
        const nLen = extData.readUInt16BE(q); q += 2;
        if (extData.length - q < nLen) return { status: 'invalid', code: 'malformed-hello' };
        const nameBuf = extData.slice(q, q + nLen);
        q += nLen;
        count += 1;
        if (nType !== 0) return { status: 'invalid', code: 'malformed-hello' };
        if (count > 1) return { status: 'invalid', code: 'duplicate-sni' };
        for (let i = 0; i < nameBuf.length; i++) {
          const c = nameBuf[i];
          if (c < 0x21 || c > 0x7e) return { status: 'invalid', code: 'bad-sni-chars' };
        }
        name = nameBuf.toString('ascii').toLowerCase();
      }
      if (count !== 1 || !name) return { status: 'invalid', code: 'missing-sni' };
      sniHost = name;
    }
    p += extLen;
  }
  if (!sniHost) return { status: 'invalid', code: 'missing-sni' };
  if (sniHost !== expectedHost) return { status: 'invalid', code: 'sni-mismatch' };
  return { status: 'valid' };
}

// ---------- Broker ----------
async function create(options) {
  options = options || {};
  if(typeof options!=='object'||Array.isArray(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new Error('invalid-options');
  for (const k of Object.keys(options)) {
    if (!ALLOWED_KEYS.has(k)) throw new Error('unknown-option');
  }
  const provider = options.provider;
  if (provider !== 'claude' && provider !== 'grok') throw new Error('invalid-provider');
  const allowedHosts = PROVIDER_HOSTS[provider];

  const maxConnections = checkInt('maxConnections', options.maxConnections);
  const maxTunnelBytes = checkInt('maxTunnelBytes', options.maxTunnelBytes);
  const maxTotalBytes = checkInt('maxTotalBytes', options.maxTotalBytes);
  const maxWallMs = checkInt('maxWallMs', options.maxWallMs);
  const connectTimeoutMs = checkInt('connectTimeoutMs', options.connectTimeoutMs);
  const helloTimeoutMs = checkInt('helloTimeoutMs', options.helloTimeoutMs);
  const onAudit = typeof options.onAudit === 'function' ? options.onAudit : null;
  if(options.handleHttp!==undefined&&typeof options.handleHttp!=='function')throw Error('invalid-http-handler');

  const user = 'hub';
  const token = crypto.randomBytes(32).toString('hex');
  const expectedAuthHeader = 'Basic ' + Buffer.from(user + ':' + token).toString('base64');
  const expectedAuthDigest = crypto.createHash('sha256').update(expectedAuthHeader).digest();

  const state = {
    activeConnections: 0,
    accepted: 0,
    denied: 0,
    totalBytes: 0,
    closed: false
  };
  const ownedSockets = new Set();

  function audit(event, code, hostname) {
    if (!onAudit) return true;
    try {
      const obj = { event, provider };
      if (code !== undefined) obj.code = code;
      if (hostname !== undefined) obj.hostname = hostname;
      const result=onAudit(obj);
      if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});return false;}
      return true;
    } catch (e) {
      return false;
    }
  }

  function destroySocketSafe(s) {
    try { ownedSockets.delete(s); } catch (e) { /* noop */ }
    try { if (!s.destroyed) s.destroy(); } catch (e) { /* noop */ }
  }

  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000 });
  server.on('connection',socket=>{
    if(state.closed||ownedSockets.size>=maxConnections+8){socket.destroy();return;}
    ownedSockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>ownedSockets.delete(socket));
    socket.setTimeout(5000,()=>socket.destroy());
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('upgrade',(_req,socket)=>socket.destroy());

  server.on('request', (req, res) => {
    const values=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='proxy-authorization')values.push(req.rawHeaders[i+1]);
    const digest=crypto.createHash('sha256').update(String(values[0]||'')).digest();
    if(state.closed||!options.handleHttp||values.length!==1||!crypto.timingSafeEqual(digest,expectedAuthDigest)||!audit('local-mcp-request')){
      state.denied++;try{res.writeHead(403,{'Connection':'close'});res.end();}catch{req.socket.destroy();}return;
    }
    // Trusted controller callback must still validate exact Hub port, endpoint,
    // task capability, run, nonce and payload. No general loopback CONNECT.
    req.socket.setTimeout(120000,()=>req.socket.destroy());
    try{options.handleHttp(req,res);}catch{req.socket.destroy();}
  });

  function checkAuth(req) {
    const raw = req.rawHeaders;
    let proxyAuthCount = 0;
    let hostCount = 0;
    let proxyAuthVal = null;
    let hostVal = null;
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i].toLowerCase();
      if (name === 'proxy-authorization') { proxyAuthCount++; proxyAuthVal = raw[i + 1]; }
      if (name === 'host') { hostCount++; hostVal = raw[i + 1]; }
      if (['transfer-encoding','content-length','authorization','cookie'].includes(name)) return { ok: false, code: 'forbidden-header' };
    }
    if (proxyAuthCount !== 1) return { ok: false, code: 'missing-auth' };
    if (hostCount !== 1) return { ok: false, code: 'bad-host' };
    const gotDigest = crypto.createHash('sha256').update(String(proxyAuthVal)).digest();
    if (gotDigest.length !== expectedAuthDigest.length || !crypto.timingSafeEqual(gotDigest, expectedAuthDigest)) {
      return { ok: false, code: 'unauthorized' };
    }
    return { ok: true, hostHeader: hostVal };
  }

  server.on('connect', (req, clientSocket, head) => {
    ownedSockets.add(clientSocket);
    clientSocket.setTimeout(0);

    function denyAndClose(code, status) {
      state.denied++;
      audit('denied', code);
      try {
        if (!clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 ' + (status || 400) + ' Denied\r\nConnection: close\r\n\r\n');
        }
      } catch (e) { /* noop */ }
      destroySocketSafe(clientSocket);
    }

    if (state.closed) { denyAndClose('closed', 503); return; }
    if (req.httpVersionMajor !== 1) { denyAndClose('bad-version', 400); return; }

    const authResult = checkAuth(req);
    if (!authResult.ok) {
      const status = authResult.code === 'unauthorized' || authResult.code === 'missing-auth' ? 407 : 400;
      denyAndClose(authResult.code, status);
      return;
    }

    const authorityRaw = String(req.url || '');
    const authorityLower = authorityRaw.toLowerCase();
    if (String(authResult.hostHeader).toLowerCase() !== authorityLower) {
      denyAndClose('host-mismatch', 400);
      return;
    }
    const host = parseAuthority(authorityLower, allowedHosts);
    if (!host) { denyAndClose('forbidden-authority', 403); return; }

    if (state.activeConnections >= maxConnections) { denyAndClose('slot-limit', 503); return; }

    state.activeConnections++;
    let slotReleased = false;
    function releaseSlot() {
      if (!slotReleased) { slotReleased = true; state.activeConnections--; }
    }

    if (!audit('accepted-connect', 'ok', host)) {
      releaseSlot();
      denyAndClose('audit-reject', 500);
      return;
    }

    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    } catch (e) {
      releaseSlot();
      destroySocketSafe(clientSocket);
      return;
    }

    state.accepted++;
    runTunnel(clientSocket, head || Buffer.alloc(0), host, releaseSlot);
  });

  function runTunnel(clientSocket, initialHead, host, releaseSlot) {
    let helloBuffer = initialHead && initialHead.length ? Buffer.from(initialHead) : Buffer.alloc(0);
    let finished = false;
    let upstream = null;

    const helloTimer = setTimeout(() => {
      finish('hello-timeout');
    }, helloTimeoutMs);

    function finish(code) {
      if (finished) return;
      finished = true;
      clearTimeout(helloTimer);
      if (code) audit(code === 'ok' ? 'tunnel-closed' : 'tunnel-error', code, host);
      releaseSlot();
      destroySocketSafe(clientSocket);
      if (upstream) {
        try { if (!upstream.destroyed) upstream.destroy(); } catch (e) { /* noop */ }
        ownedSockets.delete(upstream);
      }
    }

    clientSocket.on('error', () => finish('client-error'));
    clientSocket.on('close', () => finish());
    clientSocket.on('end', () => {if(upstream&&!upstream.destroyed)upstream.end();else finish();});

    function onClientData(chunk) {
      if (finished) return;
      helloBuffer = Buffer.concat([helloBuffer, chunk]);
      if (helloBuffer.length > MAX_PENDING_BUFFER) {
        finish('hello-too-large');
        return;
      }
      let result;
      try {
        result = inspectClientHello(helloBuffer, host);
      } catch (e) {
        finish('hello-parse-error');
        return;
      }
      if (result.status === 'need-more') {
        return;
      }
      if (result.status === 'invalid') {
        finish('sni-invalid:' + result.code);
        return;
      }
      // valid
      clientSocket.pause();
      clientSocket.removeListener('data', onClientData);
      clearTimeout(helloTimer);
      const consumed = result.consumed;
      const helloBytes = helloBuffer.slice(0, consumed);
      const extra = helloBuffer.slice(consumed);
      connectUpstream(helloBytes, extra);
    }
    clientSocket.on('data', onClientData);
    // kick initial data synchronously if head already present
    if (helloBuffer.length) {
      process.nextTick(() => { if (!finished) onClientData(Buffer.alloc(0)); });
    }

    async function connectUpstream(helloBytes, extraClientData) {
      let addrList;
      try {
        addrList = await dns.lookup(host, { all: true, verbatim: true });
      } catch (e) {
        finish('dns-error');
        return;
      }
      if (finished||state.closed) return;
      if(!Array.isArray(addrList)||!addrList.length||addrList.some(a=>!isGlobalUnicast(a.address,a.family))){finish('no-global-address');return;}
      const candidates = addrList
        .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
      if (candidates.length === 0) {
        finish('no-global-address');
        return;
      }
      const chosen = candidates[0];

      const sock = net.connect({ host: chosen.address, port: 443, family: chosen.family });
      upstream=sock;
      let connected=false;
      ownedSockets.add(sock);
      let connectTimedOut = false;
      const connTimer = setTimeout(() => {
        connectTimedOut = true;
        finish('connect-timeout');
      }, connectTimeoutMs);

      sock.once('connect', () => {
        connected=true;
        clearTimeout(connTimer);
        if (finished) { try { sock.destroy(); } catch (e) { /* noop */ } return; }
        upstream = sock;
        if(!audit('upstream-connected', 'ok', host)){finish('audit-reject');return;}
        setupForwarding(sock, helloBytes, extraClientData);
      });
      sock.once('error', () => {
        clearTimeout(connTimer);
        finish(connectTimedOut ? 'connect-timeout' : 'connect-error');
      });
      sock.once('close',()=>{clearTimeout(connTimer);if(!connected)finish(connectTimedOut?'connect-timeout':'connect-closed');});
    }

    function setupForwarding(upstreamSocket, helloBytes, extraClientData) {
      let tunnelBytes = 0;
      function accountBytes(n) {
        tunnelBytes += n;
        state.totalBytes += n;
        if (tunnelBytes > maxTunnelBytes || state.totalBytes > maxTotalBytes) {
          finish('budget-exceeded');
          return false;
        }
        return true;
      }

      if (!accountBytes(helloBytes.length)) return;
      if (!upstreamSocket.destroyed) {
        upstreamSocket.write(helloBytes);
      }
      if (extraClientData.length) {
        if (!accountBytes(extraClientData.length)) return;
        if (!upstreamSocket.destroyed) upstreamSocket.write(extraClientData);
      }

      clientSocket.on('data', (chunk) => {
        if (finished) return;
        if (!accountBytes(chunk.length)) return;
        if (!upstreamSocket.write(chunk)) {
          clientSocket.pause();
          upstreamSocket.once('drain', () => { if (!finished) clientSocket.resume(); });
        }
      });
      upstreamSocket.on('data', (chunk) => {
        if (finished) return;
        if (!accountBytes(chunk.length)) return;
        if (!clientSocket.write(chunk)) {
          upstreamSocket.pause();
          clientSocket.once('drain', () => { if (!finished) upstreamSocket.resume(); });
        }
      });
      upstreamSocket.on('error', () => finish('upstream-error'));
      upstreamSocket.on('end', () => {if(!finished&&!clientSocket.destroyed)clientSocket.end();});
      upstreamSocket.on('close', () => {if(!upstreamSocket.readableEnded)finish('upstream-closed');});
      clientSocket.resume();
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  const proxyUrl = 'http://' + user + ':' + token + '@127.0.0.1:' + port;

  const wallTimer = setTimeout(() => { close(); }, maxWallMs);
  wallTimer.unref();

  let closePromise=null;
  async function close() {
    if (closePromise) return closePromise;
    state.closed = true;
    clearTimeout(wallTimer);
    for (const s of Array.from(ownedSockets)) {
      try { if (!s.destroyed) s.destroy(); } catch (e) { /* noop */ }
    }
    ownedSockets.clear();
    closePromise=new Promise((resolve) => {
      server.close(() => resolve());
    });
    return closePromise;
  }

  function snapshot() {
    return {
      provider,
      activeConnections: state.activeConnections,
      accepted: state.accepted,
      denied: state.denied,
      totalBytes: state.totalBytes,
      closed: state.closed
    };
  }

  return { proxyUrl, close, snapshot };
}

module.exports = {
  create,
  inspectClientHello,
  _internal: { isGlobalUnicast, parseAuthority, PROVIDER_HOSTS }
};
