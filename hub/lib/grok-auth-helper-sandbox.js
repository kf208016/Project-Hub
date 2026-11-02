'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const home = process.env.GROK_HOME, proxyText = process.env.HTTP_PROXY, expired = process.env.GROK_AUTH_EXPIRED === '1';
for (const key of Object.keys(process.env)) if (/^HUB_/i.test(key) || /^HTTP_PROXY$/i.test(key)) delete process.env[key];
const fail = reason => Object.assign(Error(reason), {reason});
async function main() {
  let route;
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home)) throw Error();
    const file = path.join(home, 'hub-grok-auth.json'), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024) throw Error();
    route = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!route || Object.getPrototypeOf(route) !== Object.prototype || Object.keys(route).sort().join(',') !== 'port,runId,token,version' ||
        route.version !== 1 || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535 ||
        typeof route.runId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(route.runId) ||
        typeof route.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(route.token)) throw Error();
  } catch { throw fail('ROUTE_INVALID'); }
  if (typeof proxyText !== 'string' || !/^http:\/\/hub:[a-f0-9]{64}@127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(proxyText)) throw fail('PROXY_INVALID');
  let proxy;
  try { proxy = new URL(proxyText); } catch { throw fail('PROXY_INVALID'); }
  const proxyPort = Number(proxy.port || '80');
  if (proxyPort < 1 || proxyPort > 65535) throw fail('PROXY_INVALID');
  const body = JSON.stringify({expired});
  return new Promise((resolve, reject) => {
    let done = false, timer;
    function finish(error, value) {
      if (done) return;
      done = true;clearTimeout(timer);
      if (error) reject(error);else resolve(value);
    }
    const req = http.request({host: '127.0.0.1', port: proxyPort,
      path: 'http://127.0.0.1:' + route.port + '/api/native/grok-token', method: 'POST', agent: false,
      headers: {Host: '127.0.0.1:' + route.port,
        'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64'),
        'X-Hub': '1', Authorization: 'Bearer ' + route.token, 'X-Hub-Grok-Run': route.runId,
        'X-Hub-Grok-Nonce': crypto.randomUUID(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}
    }, res => {
      const chunks = [];let size = 0;
      res.on('error', () => finish(fail('RESPONSE_INVALID')));
      res.on('aborted', () => finish(fail('RESPONSE_INVALID')));
      if (res.statusCode !== 200) { finish(fail('UNAVAILABLE'));res.destroy();return; }
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) { finish(fail('RESPONSE_INVALID'));res.destroy();return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (done) return;
        try {
          const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
          if (!value || Object.getPrototypeOf(value) !== Object.prototype || typeof value.access_token !== 'string' ||
              value.access_token.length < 1 || value.access_token.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(value.access_token) ||
              !Number.isInteger(value.expires_in) || value.expires_in < 1) throw Error();
          finish(null, {access_token: value.access_token, expires_in: value.expires_in});
        } catch { finish(fail('RESPONSE_INVALID')); }
      });
    });
    const timeout = () => { finish(fail('TIMEOUT'));req.destroy(); };
    timer = setTimeout(timeout, 5000);req.setTimeout(5000, timeout);
    req.on('error', () => finish(fail('UNAVAILABLE')));
    req.end(body);
  });
}
main().then(value => { process.stdout.write(JSON.stringify(value));process.exitCode = 0; }, error => {
  process.stderr.write('grok-auth-helper-sandbox: ' + (error.reason || 'UNAVAILABLE') + '\n');process.exitCode = 1;
});
