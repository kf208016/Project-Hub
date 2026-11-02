'use strict';
// Owner-process only. Reads the owner's Grok credential file in memory to obtain the access token and its exact
// expiry. Never logs, never persists, never returns the parsed object or the refresh token.
const fs = require('node:fs');
const path = require('node:path');
const fail = code => Object.assign(Error(code), {code});
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function readOwnerToken({home, now = Date.now()} = {}) {
  try {
    const file = path.join(home, '.grok', 'auth.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw fail('GROK_OWNER_TOKEN_INVALID');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!plain(data)) throw fail('GROK_OWNER_TOKEN_INVALID');
    const scope = Object.keys(data).find(key => key.startsWith('https://auth.x.ai::')) || 'https://accounts.x.ai/sign-in';
    const entry = data[scope];
    if (!plain(entry) || typeof entry.key !== 'string' || entry.key.length < 1 || entry.key.length > 8192 ||
        /[\x00-\x1f\x7f-\x9f]/.test(entry.key) || typeof entry.expires_at !== 'string' || !Number.isFinite(Date.parse(entry.expires_at))) {
      throw fail('GROK_OWNER_TOKEN_INVALID');
    }
    return Object.freeze({key: entry.key, expiresAt: Date.parse(entry.expires_at)});
  } catch (error) {
    throw fail(error.code === 'ENOENT' ? 'GROK_OWNER_TOKEN_MISSING' : 'GROK_OWNER_TOKEN_INVALID');
  }
}
function expiryOf(options) {
  try { return {expiresAt: readOwnerToken(options).expiresAt, code: null}; }
  catch (error) { return {expiresAt: null, code: error?.code || 'GROK_OWNER_TOKEN_INVALID'}; }
}
function mintJson({home, now = Date.now(), marginSec = 60}) {
  const {key, expiresAt} = readOwnerToken({home, now});
  return JSON.stringify({access_token: key, expires_in: Math.max(1, Math.floor((expiresAt - now) / 1000) - marginSec)});
}
module.exports = {readOwnerToken, expiryOf, mintJson};
