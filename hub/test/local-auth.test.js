'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../lib/local-auth');

const secret = 'A'.repeat(43);
test('local browser authentication refuses absent and incorrect tokens', () => {
  const auth = create(secret);
  assert.equal(auth.login(''), false);
  assert.equal(auth.login('B'.repeat(43)), false);
  assert.equal(auth.check({ headers: {} }), false);
  assert.equal(auth.check({ headers: { cookie: 'hub_local_session=wrong' } }), false);
  assert.equal(auth.login(secret), true);
  const cookie = auth.cookie.split(';')[0];
  assert.equal(auth.check({ headers: { cookie } }), true);
  assert.match(auth.cookie, /HttpOnly; SameSite=Strict/);
});

test('local browser authentication rejects weak configuration', () => {
  assert.throws(() => create('short'), /invalid/);
});
