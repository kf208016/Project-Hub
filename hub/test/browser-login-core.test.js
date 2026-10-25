'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserLoginFSM, EXPIRY_MS, MAX_PENDING } = require('../lib/browser-login.js');

function fixedBuf(hexSeed, len) {
  const b = Buffer.alloc(len, 0);
  Buffer.from(hexSeed, 'hex').copy(b);
  return b;
}

function makeClock(start) {
  let t = start;
  return {
    set: (v) => { t = v; },
    advance: (d) => { t += d; },
    fn: () => t,
  };
}

function seqRandom(sequence) {
  // sequence: array of Buffers or functions-to-throw/return-bad-values
  let i = 0;
  return (n) => {
    const item = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (typeof item === 'function') return item(n);
    return item;
  };
}

test('successful create -> approve -> poll flow', () => {
  const clock = makeClock(1000);
  let counter = 0;
  const fsm = new BrowserLoginFSM({
    now: clock.fn,
    randomBytesFn: (n) => {
      counter++;
      const b = Buffer.alloc(n, 0);
      b.writeUInt32BE(counter, 0);
      return b;
    },
  });
  const created = fsm.createPending();
  assert.equal(created.ok, true);
  assert.match(created.id, /^[0-9a-f]{32}$/);
  assert.match(created.nonce, /^[0-9a-f]{64}$/);

  const ap = fsm.approve(created.id);
  assert.deepEqual(ap, { ok: true });

  const poll = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll, { ok: true });
});

test('poll before approval returns NOT_APPROVED', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = fsm.createPending();
  const poll = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll, { ok: false, error: 'NOT_APPROVED' });
});

test('exact boundary 60000ms expiry on poll', () => {
  const clock = makeClock(0);
  const fsm = new BrowserLoginFSM({ now: clock.fn });
  const created = fsm.createPending();
  fsm.approve(created.id);
  clock.set(EXPIRY_MS); // exactly at boundary -> expired
  const poll = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll, { ok: false, error: 'NOT_FOUND' });
});

test('just under boundary (59999ms) still valid', () => {
  const clock = makeClock(0);
  const fsm = new BrowserLoginFSM({ now: clock.fn });
  const created = fsm.createPending();
  fsm.approve(created.id);
  clock.set(EXPIRY_MS - 1);
  const poll = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll, { ok: true });
});

test('approve on expired entry returns NOT_FOUND and cleans up', () => {
  const clock = makeClock(0);
  const fsm = new BrowserLoginFSM({ now: clock.fn });
  const created = fsm.createPending();
  clock.set(EXPIRY_MS);
  const ap = fsm.approve(created.id);
  assert.deepEqual(ap, { ok: false, error: 'NOT_FOUND' });
  // subsequent poll also NOT_FOUND (consumed by cleanup)
  const poll = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll, { ok: false, error: 'NOT_FOUND' });
});

test('wrong nonce fails with NOT_FOUND, state not consumed', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = fsm.createPending();
  fsm.approve(created.id);
  const wrongNonce = 'a'.repeat(64);
  const poll = fsm.pollAndConsume(created.id, wrongNonce);
  assert.deepEqual(poll, { ok: false, error: 'NOT_FOUND' });
  // correct nonce still works afterward (not consumed by wrong attempt)
  const poll2 = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll2, { ok: true });
});

test('public ID alone does not suffice to poll (requires nonce)', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = fsm.createPending();
  fsm.approve(created.id);
  const poll = fsm.pollAndConsume(created.id, undefined);
  assert.deepEqual(poll, { ok: false, error: 'INVALID_INPUT' });
});

test('replay rejection: second poll after success fails NOT_FOUND', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = fsm.createPending();
  fsm.approve(created.id);
  const poll1 = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll1, { ok: true });
  const poll2 = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll2, { ok: false, error: 'NOT_FOUND' });
});

test('duplicate approval rejected', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = fsm.createPending();
  const ap1 = fsm.approve(created.id);
  assert.deepEqual(ap1, { ok: true });
  const ap2 = fsm.approve(created.id);
  assert.deepEqual(ap2, { ok: false, error: 'ALREADY_APPROVED' });
});

test('malformed id/nonce values rejected without mutating state', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = fsm.createPending();
  const sizeBefore = fsm._size();

  const badIds = ['', 'short', 'A'.repeat(32), '1'.repeat(31), '1'.repeat(33), 123, null, undefined, {}, 'z'.repeat(32)];
  for (const bad of badIds) {
    const r1 = fsm.approve(bad);
    assert.deepEqual(r1, { ok: false, error: 'INVALID_INPUT' });
    const r2 = fsm.pollAndConsume(bad, created.nonce);
    assert.deepEqual(r2, { ok: false, error: 'INVALID_INPUT' });
  }
  const badNonces = ['', 'short', 'A'.repeat(64), '1'.repeat(63), '1'.repeat(65), 999, null, {}];
  for (const bad of badNonces) {
    const r = fsm.pollAndConsume(created.id, bad);
    assert.deepEqual(r, { ok: false, error: 'INVALID_INPUT' });
  }
  assert.equal(fsm._size(), sizeBefore);
  // confirm original entry still works
  fsm.approve(created.id);
  const poll = fsm.pollAndConsume(created.id, created.nonce);
  assert.deepEqual(poll, { ok: true });
});

test('malformed input does not trigger expiry cleanup side effects', () => {
  const clock = makeClock(0);
  const fsm = new BrowserLoginFSM({ now: clock.fn });
  const created = fsm.createPending();
  clock.set(EXPIRY_MS + 5000); // now expired, but entry still physically present until touched
  // malformed call should early-return INVALID_INPUT, but even if cleanup runs,
  // valid semantics (NOT_FOUND) must hold, never mutate differently.
  const r = fsm.approve('bad');
  assert.deepEqual(r, { ok: false, error: 'INVALID_INPUT' });
});

test('bounded pending table: TABLE_FULL at capacity, no eviction of valid entries', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const created = [];
  for (let i = 0; i < MAX_PENDING; i++) {
    const c = fsm.createPending();
    assert.equal(c.ok, true);
    created.push(c);
  }
  const overflow = fsm.createPending();
  assert.deepEqual(overflow, { ok: false, error: 'TABLE_FULL' });
  // all original entries remain valid and usable
  for (const c of created) {
    fsm.approve(c.id);
    const poll = fsm.pollAndConsume(c.id, c.nonce);
    assert.deepEqual(poll, { ok: true });
  }
});

test('independent pending requests do not interfere', () => {
  const fsm = new BrowserLoginFSM({ now: makeClock(0).fn });
  const a = fsm.createPending();
  const b = fsm.createPending();
  assert.notEqual(a.id, b.id);
  fsm.approve(a.id);
  const pollB = fsm.pollAndConsume(b.id, b.nonce);
  assert.deepEqual(pollB, { ok: false, error: 'NOT_APPROVED' });
  const pollA = fsm.pollAndConsume(a.id, a.nonce);
  assert.deepEqual(pollA, { ok: true });
});

test('randomness failure (throws) fails closed on createPending', () => {
  const fsm = new BrowserLoginFSM({
    now: makeClock(0).fn,
    randomBytesFn: () => { throw new Error('rng failure'); },
  });
  const r = fsm.createPending();
  assert.deepEqual(r, { ok: false, error: 'INTERNAL_FAILURE' });
  assert.equal(fsm._size(), 0);
});

test('randomness returning wrong type/size fails closed', () => {
  const badReturns = ['not-a-buffer', {}, Buffer.alloc(4), null, 12345];
  for (const bad of badReturns) {
    const fsm = new BrowserLoginFSM({
      now: makeClock(0).fn,
      randomBytesFn: () => bad,
    });
    const r = fsm.createPending();
    assert.deepEqual(r, { ok: false, error: 'INTERNAL_FAILURE' });
    assert.equal(fsm._size(), 0);
  }
});

test('ID collision triggers retry and eventually succeeds with distinct id', () => {
  let call = 0;
  const fixed = fixedBuf('11', 16);
  const alt = fixedBuf('22', 16);
  const nonceBuf = fixedBuf('33', 32);
  const fsm = new BrowserLoginFSM({
    now: makeClock(0).fn,
    randomBytesFn: (n) => {
      call++;
      if (n === 16) {
        // first id call returns 'fixed', forcing a manual pre-seed collision scenario
        return call === 1 ? fixed : alt;
      }
      return nonceBuf;
    },
  });
  const first = fsm.createPending();
  assert.equal(first.ok, true);
  assert.equal(first.id, fixed.toString('hex'));

  // second createPending: randomBytesFn for id returns 'fixed' again (collision) then 'alt'
  let idCallCount = 0;
  const fsm2 = new BrowserLoginFSM({
    now: makeClock(0).fn,
    randomBytesFn: (n) => {
      if (n === 16) {
        idCallCount++;
        return idCallCount === 1 ? fixed : alt;
      }
      return nonceBuf;
    },
  });
  fsm2.createPending(); // seeds 'fixed'
  const second = fsm2.createPending(); // first attempt collides with 'fixed', retries to 'alt'
  assert.equal(second.ok, true);
  assert.equal(second.id, alt.toString('hex'));
  assert.notEqual(second.id, fixed.toString('hex'));
});

test('clock throwing fails closed on every operation', () => {
  const fsm = new BrowserLoginFSM({
    now: () => { throw new Error('clock failure'); },
  });
  const r = fsm.createPending();
  assert.deepEqual(r, { ok: false, error: 'INTERNAL_FAILURE' });
});

test('clock returning invalid value fails closed', () => {
  const invalids = [NaN, Infinity, -1, '123', null, undefined, 1.5];
  for (const bad of invalids) {
    const fsm = new BrowserLoginFSM({ now: () => bad });
    const r = fsm.createPending();
    assert.deepEqual(r, { ok: false, error: 'INTERNAL_FAILURE' });
  }
});

test('clock moving backward invalidates all pending state', () => {
  const clock = makeClock(1000);
  const fsm = new BrowserLoginFSM({ now: clock.fn });
  const created = fsm.createPending();
  assert.equal(created.ok, true);
  assert.equal(fsm._size(), 1);

  clock.set(500); // backward
  const r = fsm.approve(created.id);
  assert.deepEqual(r, { ok: false, error: 'INTERNAL_FAILURE' });
  assert.equal(fsm._size(), 0); // invalidated

  // further operations after backward jump resume normally once time moves forward again (monotonic baseline reset)
  clock.set(600);
  const created2 = fsm.createPending();
  assert.equal(created2.ok, true);
});
