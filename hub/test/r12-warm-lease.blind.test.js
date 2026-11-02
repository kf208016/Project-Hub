'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {WorkspaceRuntime} = require('../lib/workspace-runtime');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const LABEL = {
  'base-head': '本體 Git 有新的提交或已切換分支',
  expired: '已閒置超過 10 分鐘',
};
const reenterText = reason => `工作區保留已釋放（${LABEL[reason]}）；需重新核准此次工作區`;

function runtimeOptions(extra = {}) {
  let binding = null, released = 0;
  const record = {secrets: {files: []}};
  const review = {
    permits: new Map([['permit', {record}]]),
    async consumeRun() {
      binding = {run: 'private-run', dir: process.cwd(), mode: 'isolated'};
      return binding;
    },
    binding: () => binding,
    async verifiedBinding() {
      if (!binding) throw Error('missing binding');
      return binding;
    },
    async releaseRun() {
      released++;
      binding = null;
    },
  };
  const chats = {busy: () => null, queue: () => [], stop() {}};
  const options = {
    review,
    chats,
    sessions: {stop() {}},
    store: {},
    stopExtra: async () => ({stopped: true, treeExited: true}),
    ...extra,
  };
  return {options, review, released: () => released};
}

function harness(extra) {
  const built = runtimeOptions(extra);
  built.runtime = new WorkspaceRuntime(built.options);
  return built;
}

function validWarm() {
  const state = {checks: 0, parkChecks: 0};
  const warm = {
    eligible() { return true; },
    check() { state.checks++; return true; },
    parkCheck() { state.parkChecks++; return true; },
  };
  return {warm, state};
}

async function beginChat(runtime) {
  return runtime.begin({project: 'p', task: 't', permit: 'permit', kind: 'chat'});
}

function trackClose(runtime, flow, child) {
  runtime.track(flow, child);
  child.emit('close');
}

async function openVerified(f) {
  const flow = await beginChat(f.runtime);
  const child = new EventEmitter();
  child.requiresCleanupReceipt = true;
  child.cleanupReceipt = {cleanupVerified: true};
  trackClose(f.runtime, flow, child);
  return flow;
}

async function parkVerified(extra) {
  const pack = validWarm();
  const f = harness({...extra, warm: pack.warm});
  const flow = await openVerified(f);
  await wait(250);
  assert.equal(f.released(), 0, 'verified close released the lease instead of parking it');
  assert.ok(flow.parkedAt > 0, 'verified close did not park the flow');
  return {f, flow, ...pack};
}

test('constructor rejects a warm object without check and ttlMs 0 or 600001', () => {
  const warm = {eligible() { return true; }, parkCheck() { return true; }};
  const message = error => error instanceof Error && error.message === '工作區保溫設定無效';
  assert.throws(() => new WorkspaceRuntime(runtimeOptions({warm}).options), message);
  const valid = validWarm().warm;
  assert.throws(() => new WorkspaceRuntime(runtimeOptions({warm: valid, ttlMs: 0}).options), message);
  assert.throws(() => new WorkspaceRuntime(runtimeOptions({warm: valid, ttlMs: 600001}).options), message);
});

test('U1 verified receipt close reports idle and parks without releaseRun', async () => {
  const {warm, state} = validWarm();
  const f = harness({warm});
  const flow = await openVerified(f);
  assert.deepEqual(f.runtime.summary('p', 't'), {kind: 'chat', state: 'idle', ownedChildren: 0, retryClose: false, errorCode: ''});
  await wait(250);
  assert.equal(f.runtime.isParked(flow), true);
  assert.ok(flow.parkedAt > 0);
  assert.equal(state.parkChecks, 1);
  assert.equal(state.checks, 0);
  assert.equal(f.released(), 0);
  assert.equal(f.runtime.current('p', 't'), flow);
});

test('U2 a child without a cleanup receipt is released instead of parked', async () => {
  const {warm, state} = validWarm();
  const f = harness({warm});
  const flow = await beginChat(f.runtime);
  trackClose(f.runtime, flow, new EventEmitter());
  await wait(250);
  assert.equal(flow.unverifiedClose, true);
  assert.equal(state.parkChecks, 0);
  assert.equal(f.released(), 1);
  assert.equal(f.runtime.current('p', 't'), null);
  assert.equal(Boolean(flow.parkedAt), false);
});

test('U3 begin without a permit on a parked flow checks once and returns that flow', async () => {
  const {f, flow, state} = await parkVerified();
  const again = await f.runtime.begin({project: 'p', task: 't', kind: 'chat'});
  assert.equal(again, flow);
  assert.equal(state.checks, 1);
  assert.equal(state.parkChecks, 1);
  assert.equal(flow.starting, true);
  assert.equal(flow.dirty, false);
  assert.equal(f.released(), 0);
});

test('U4 a throwing warm check releases the flow before WORKSPACE_REQUIRED', async () => {
  const {f, state} = await parkVerified();
  f.options.warm.check = () => {
    state.checks++;
    throw Object.assign(new Error('synthetic base'), {warmReason: 'base-head'});
  };
  await assert.rejects(f.runtime.begin({project: 'p', task: 't', kind: 'chat', verifySource: true}), error => {
    assert.equal(f.released(), 1);
    assert.equal(f.runtime.flows.size, 0);
    assert.equal(error.code, 'WORKSPACE_REQUIRED');
    assert.equal(error.workspaceRequired, true);
    assert.equal(error.project, 'p');
    assert.equal(error.task, 't');
    assert.equal(error.warmReason, 'base-head');
    assert.equal(error.message, reenterText('base-head'));
    assert.equal(error.message.includes(LABEL['base-head']), true);
    return true;
  });
  assert.equal(state.checks, 1);
});

test('U7 two concurrent begins on a parked flow: one is WORKSPACE_REENTRY_BUSY and check runs once', {timeout: 10000}, async () => {
  const {f, flow, state} = await parkVerified();
  let release = () => {};
  f.options.warm.check = () => new Promise(resolve => {
    state.checks++;
    release = resolve;
  });
  const first = f.runtime.begin({project: 'p', task: 't', kind: 'chat'});
  const second = f.runtime.begin({project: 'p', task: 't', kind: 'chat'});
  try {
    await assert.rejects(second, error => error.code === 'WORKSPACE_REENTRY_BUSY');
    release();
    assert.equal(await first, flow);
    assert.equal(state.checks, 1);
  } finally {
    release();
  }
});

test('U8 ttlMs 30 releases an idle flow after expiry and does not check', async () => {
  const {warm, state} = validWarm();
  const f = harness({warm, ttlMs: 30});
  await openVerified(f);
  await wait(500);
  assert.equal(state.parkChecks, 1);
  assert.equal(state.checks, 0);
  assert.equal(f.released(), 1);
  assert.equal(f.runtime.current('p', 't'), null);
  assert.equal(f.runtime.summary('p', 't'), null);
});

test('U8 a wall clock moved back one hour expires the parked flow and does not check', async () => {
  let wall = 7_200_000, mono = 7_200_000;
  const {f, state} = await parkVerified({ttlMs: 600000, now: () => wall, monotonic: () => mono});
  wall -= 60 * 60 * 1000;
  await assert.rejects(f.runtime.begin({project: 'p', task: 't', kind: 'chat'}), error => {
    assert.equal(state.checks, 0);
    assert.equal(f.released(), 1);
    assert.equal(f.runtime.flows.size, 0);
    assert.equal(error.code, 'WORKSPACE_REQUIRED');
    assert.equal(error.workspaceRequired, true);
    assert.equal(error.warmReason, 'expired');
    assert.equal(error.message, reenterText('expired'));
    return true;
  });
});

test('assertStart refuses a parked flow', async () => {
  const {f, flow} = await parkVerified();
  assert.throws(() => f.runtime.assertStart('p', 't', flow.id, flow.workspace.dir), /缺少本次controller工作區流程授權/);
  assert.equal(f.released(), 0);
  assert.equal(f.runtime.current('p', 't'), flow);
  assert.ok(flow.parkedAt > 0);
});

test('reap releases a parked flow and returns false while a child is running', async () => {
  const activePack = validWarm();
  const active = harness({warm: activePack.warm});
  const running = await beginChat(active.runtime);
  const child = new EventEmitter();
  active.runtime.track(running, child);
  assert.equal(running.children.has(child), true);
  assert.equal(await active.runtime.reap(running), false);
  assert.equal(active.released(), 0);
  assert.equal(active.runtime.current('p', 't'), running);
  assert.equal(running.children.has(child), true);

  const parked = await parkVerified();
  assert.equal(await parked.f.runtime.reap(parked.flow), true);
  assert.equal(parked.f.released(), 1);
  assert.equal(parked.f.runtime.current('p', 't'), null);
});

test('without warm a verified receipt close still finishes the flow', async () => {
  const f = harness();
  await openVerified(f);
  await wait(250);
  assert.equal(f.released(), 1);
  assert.equal(f.runtime.current('p', 't'), null);
  assert.equal(f.runtime.flows.size, 0);
  assert.equal(f.runtime.summary('p', 't'), null);
});
