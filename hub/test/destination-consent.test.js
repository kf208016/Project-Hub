'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DestinationConsent = require('../lib/destination-consent.js');

function makeClock(start) {
  let t = start;
  return {
    now: () => t,
    set: (v) => { t = v; },
    advance: (d) => { t += d; },
  };
}

function makeMono(start) {
  let t = start;
  return {
    mono: () => t,
    set: (v) => { t = v; },
    advance: (d) => { t += d; },
  };
}

function baseFixture() {
  const flow = { label: 'flow-a' };
  const binding = {
    project: 'proj1',
    task: 'task1',
    run: 'run1',
    rootFingerprint: 'fp1',
    dir: 'dirA',
  };
  const review = { summary: 'ok', items: ['a', 'b'] };
  return { flow, binding, review };
}

test('new actor challenge: assert fails then succeeds after preview+approve', async () => {
  const fx = baseFixture();
  const clock = makeClock(1000);
  const mono = makeMono(1000);
  const dc = new DestinationConsent({
    resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }),
    now: clock.now,
    monotonic: mono.mono,
  });

  assert.throws(() => dc.assert(fx.flow, 'codex'), (e) => {
    assert.equal(e.code, 'WORKSPACE_DESTINATION_REQUIRED');
    assert.equal(e.status, 409);
    assert.equal(e.notStarted, true);
    return true;
  });

  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  assert.equal(typeof p.token, 'string');
  assert.deepEqual(p.review, fx.review);
  assert.equal(p.destination, 'OpenAI');

  const res = await dc.approve({ token: p.token, confirm: true, ackDestination: true, ackReadLimits: true });
  assert.equal(res.approved, true);
  assert.equal(res.actor, 'codex');

  dc.assert(fx.flow, 'codex'); // does not throw
});

test('same flow reuse: already-marked actor passes assert without re-approving', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  dc.mark(fx.flow, 'claude');
  dc.assert(fx.flow, 'claude');
  assert.throws(() => dc.assert(fx.flow, 'grok'));
});

test('changed flow/binding/review between preview and approve is refused', async () => {
  const fx = baseFixture();
  let current = { flow: fx.flow, binding: fx.binding, review: fx.review };
  const dc = new DestinationConsent({ resolve: async () => current });

  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'grok' });

  // change flow reference
  current = { flow: { label: 'flow-b' }, binding: fx.binding, review: fx.review };
  await assert.rejects(
    dc.approve({ token: p.token, confirm: true, ackDestination: true, ackReadLimits: true }),
    (e) => { assert.equal(e.code, 'DESTINATION_CHANGED'); return true; }
  );

  // second attempt with a new preview, now change binding instead
  const p2 = await dc.preview({ project: 'proj1', task: 'task1', actor: 'grok' });
  current = { flow: fx.flow, binding: { ...fx.binding, dir: 'dirB' }, review: fx.review };
  await assert.rejects(
    dc.approve({ token: p2.token, confirm: true, ackDestination: true, ackReadLimits: true }),
    (e) => { assert.equal(e.code, 'DESTINATION_CHANGED'); return true; }
  );

  // third attempt, change review
  current = { flow: fx.flow, binding: fx.binding, review: fx.review };
  const p3 = await dc.preview({ project: 'proj1', task: 'task1', actor: 'grok' });
  current = { flow: fx.flow, binding: fx.binding, review: { summary: 'changed', items: ['a', 'b'] } };
  await assert.rejects(
    dc.approve({ token: p3.token, confirm: true, ackDestination: true, ackReadLimits: true }),
    (e) => { assert.equal(e.code, 'DESTINATION_CHANGED'); return true; }
  );
});

test('token can be consumed exactly once', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  const req = { token: p.token, confirm: true, ackDestination: true, ackReadLimits: true };
  const ok = await dc.approve(req);
  assert.equal(ok.approved, true);
  await assert.rejects(dc.approve(req), (e) => { assert.equal(e.code, 'TOKEN_INVALID'); return true; });
});

test('expiry refuses stale approval', async () => {
  const fx = baseFixture();
  const clock = makeClock(0);
  const mono = makeMono(0);
  const dc = new DestinationConsent({
    resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }),
    now: clock.now,
    monotonic: mono.mono,
  });
  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  clock.advance(10 * 60 * 1000 + 1);
  mono.advance(10 * 60 * 1000 + 1);
  await assert.rejects(
    dc.approve({ token: p.token, confirm: true, ackDestination: true, ackReadLimits: true }),
    (e) => { assert.equal(e.code, 'CONSENT_EXPIRED'); return true; }
  );
});

test('wall-clock rollback is refused', async () => {
  const fx = baseFixture();
  const clock = makeClock(5000);
  const dc = new DestinationConsent({
    resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }),
    now: clock.now,
  });
  await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  clock.set(1000); // rollback
  await assert.rejects(
    dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' }),
    (e) => { assert.equal(e.code, 'CLOCK_ROLLBACK'); return true; }
  );
});

test('monotonic rollback at approve time is refused', async () => {
  const fx = baseFixture();
  const mono = makeMono(1000);
  const dc = new DestinationConsent({
    resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }),
    monotonic: mono.mono,
  });
  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  mono.set(500); // monotonic went backwards
  await assert.rejects(
    dc.approve({ token: p.token, confirm: true, ackDestination: true, ackReadLimits: true }),
    (e) => { assert.equal(e.code, 'CLOCK_ROLLBACK'); return true; }
  );
});

test('getters in review are never invoked and are rejected', async () => {
  const fx = baseFixture();
  let getterCalled = false;
  const trickyReview = {};
  Object.defineProperty(trickyReview, 'secret', {
    enumerable: true,
    get() { getterCalled = true; return 'leak'; },
  });
  const dc = new DestinationConsent({
    resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: trickyReview }),
  });
  await assert.rejects(
    dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' }),
    (e) => { assert.equal(e.code, 'JSON_ACCESSOR'); return true; }
  );
  assert.equal(getterCalled, false);
});

test('invalid actor is rejected', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  await assert.rejects(
    dc.preview({ project: 'proj1', task: 'task1', actor: 'gpt' }),
    (e) => { assert.equal(e.code, 'INVALID_ACTOR'); return true; }
  );
  assert.throws(() => dc.assert(fx.flow, 'gpt'), (e) => { assert.equal(e.code, 'INVALID_ACTOR'); return true; });
});

test('unknown keys in requests are rejected and no authority accepted from body', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  await assert.rejects(
    dc.preview({ project: 'proj1', task: 'task1', actor: 'codex', flow: fx.flow }),
    (e) => { assert.equal(e.code, 'UNKNOWN_KEY'); return true; }
  );
  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  await assert.rejects(
    dc.approve({ token: p.token, confirm: true, ackDestination: true, ackReadLimits: true, binding: fx.binding }),
    (e) => { assert.equal(e.code, 'UNKNOWN_KEY'); return true; }
  );
});

test('preview rejects identifiers containing slashes', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  await assert.rejects(
    dc.preview({ project: 'proj/1', task: 'task1', actor: 'codex' }),
    (e) => { assert.equal(e.code, 'INVALID_IDENTIFIER'); return true; }
  );
});

test('clone safety: mutating returned review does not affect stored state', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  const p = await dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' });
  p.review.items.push('tampered');
  p.review.summary = 'tampered';

  const res = await dc.approve({ token: p.token, confirm: true, ackDestination: true, ackReadLimits: true });
  assert.equal(res.approved, true); // internal stored clone was unaffected by external mutation
});

test('resolve rejecting fails closed without marking', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => { throw new Error('boom'); } });
  await assert.rejects(
    dc.preview({ project: 'proj1', task: 'task1', actor: 'codex' }),
    (e) => { assert.equal(e.code, 'RESOLUTION_FAILED'); return true; }
  );
  assert.throws(() => dc.assert(fx.flow, 'codex'));
});

test('revokeAll clears marks for a flow', async () => {
  const fx = baseFixture();
  const dc = new DestinationConsent({ resolve: async () => ({ flow: fx.flow, binding: fx.binding, review: fx.review }) });
  dc.mark(fx.flow, 'codex');
  dc.assert(fx.flow, 'codex');
  dc.revokeAll(fx.flow);
  assert.throws(() => dc.assert(fx.flow, 'codex'));
});
