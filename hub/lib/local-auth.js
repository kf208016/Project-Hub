'use strict';
const crypto = require('node:crypto');

const COOKIE = 'hub_local_session';
function create(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,100}$/.test(secret)) throw new Error('Windows local token is invalid');
  const session = crypto.createHmac('sha256', secret).update('project-hub-local-session-v1').digest('base64url');
  const same = candidate => {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate), b = Buffer.from(session);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  function check(req) {
    const pairs = String(req.headers.cookie || '').split(';');
    const value = pairs.map(p => p.trim()).find(p => p.startsWith(COOKIE + '='));
    return same(value ? value.slice(COOKIE.length + 1) : '');
  }
  function login(candidate) {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate), b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return {
    check, login,
    proof(challenge) { if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))throw Error('Invalid instance challenge');return crypto.createHmac('sha256',secret).update('project-hub-instance-v1:'+challenge).digest('hex'); },
    cookie: `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`,
  };
}
module.exports = { create };
