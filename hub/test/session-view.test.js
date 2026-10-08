'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionViews } = require('../lib/session-view');

function fixture(options = {}) {
  let mono = 0, wall = 1000000;
  const views = new SessionViews({ leaseMs: 30000, clock: () => mono, wallClock: () => wall, ...options });
  return { views, advance(ms) { mono += ms; wall += ms; }, setClock(value) { mono = value; }, setWall(value) { wall = value; } };
}
const credentials = view => ({ viewId: view.viewId, lease: view.lease });
const rejects = (fn, status) => assert.throws(fn, error => error.status === status);

test('first terminal view owns input; other views only watch, without public lease disclosure', () => {
  const { views } = fixture();
  const first = views.register(), second = views.register();
  assert.equal(first.role, 'owner');
  assert.equal(second.role, 'watcher');
  assert.notEqual(first.viewId, second.viewId);
  assert.match(first.viewId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(first.lease, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(views.assertOwner(credentials(first)).role, 'owner');
  rejects(() => views.assertOwner(credentials(second)), 409);
  const state = views.state();
  assert.equal(state.ownerViewId, first.viewId);
  assert.equal(state.views.length, 2);
  assert.equal(JSON.stringify(state).includes(first.lease), false);
  assert.equal(JSON.stringify(state).includes(second.lease), false);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.views) && Object.isFrozen(state.views[0]));
});

test('takeover is explicit and bound to current epoch; old owner loses input immediately', () => {
  const { views } = fixture();
  const first = views.register(), second = views.register();
  const epoch = views.state().epoch;
  rejects(() => views.claim({ ...credentials(second), expectedEpoch: epoch, takeover: false }), 409);
  rejects(() => views.claim({ ...credentials(second), expectedEpoch: epoch, takeover: 'true' }), 400);
  rejects(() => views.claim({ ...credentials(second), expectedEpoch: epoch - 1, takeover: true }), 409);
  const taken = views.claim({ ...credentials(second), expectedEpoch: epoch, takeover: true });
  assert.equal(taken.role, 'owner');
  assert.equal(taken.epoch, epoch + 1);
  rejects(() => views.assertOwner(credentials(first)), 409);
  assert.equal(views.assertOwner(credentials(second)).role, 'owner');
  rejects(() => views.claim({ ...credentials(first), expectedEpoch: epoch, takeover: true }), 409);
  assert.equal(views.state().ownerViewId, second.viewId);
});

test('expiry releases ownership; a live watcher must explicitly claim the vacant controller', () => {
  const f = fixture(), first = f.views.register(), second = f.views.register();
  f.advance(15000);
  assert.equal(f.views.heartbeat(credentials(second)).role, 'watcher');
  f.advance(15000);
  const state = f.views.state();
  assert.equal(state.ownerViewId, null);
  assert.equal(state.views.length, 1);
  assert.equal(state.views[0].viewId, second.viewId);
  rejects(() => f.views.assertOwner(credentials(first)), 403);
  rejects(() => f.views.assertOwner(credentials(second)), 409);
  rejects(() => f.views.claim({ ...credentials(second), expectedEpoch: state.epoch, takeover: false }), 409);
  const taken = f.views.claim({ ...credentials(second), expectedEpoch: state.epoch, takeover: true });
  assert.equal(taken.role, 'owner');
  assert.equal(taken.expiresAt, 1060000);
});

test('owner activity renews only its own lease; wall-clock changes do not extend monotonic expiry', () => {
  const f = fixture(), first = f.views.register(), second = f.views.register();
  f.advance(20000);
  f.setWall(10);
  const renewed = f.views.assertOwner(credentials(first));
  assert.equal(renewed.expiresAt, 30010);
  f.advance(10000);
  assert.equal(f.views.state().views.length, 1);
  rejects(() => f.views.heartbeat(credentials(second)), 403);
  f.advance(20000);
  assert.equal(f.views.state().ownerViewId, null);
  rejects(() => f.views.assertOwner(credentials(first)), 403);
});

test('disconnect authenticates the specified view and cannot clear another controller', () => {
  const { views } = fixture(), first = views.register(), second = views.register();
  rejects(() => views.disconnect({ viewId: first.viewId, lease: second.lease }), 403);
  assert.equal(views.state().ownerViewId, first.viewId);
  views.disconnect(credentials(second));
  assert.equal(views.state().ownerViewId, first.viewId);
  assert.equal(views.state().views.length, 1);
  const epoch = views.state().epoch;
  views.disconnect(credentials(first));
  assert.equal(views.state().ownerViewId, null);
  assert.equal(views.state().epoch, epoch + 1);
  assert.equal(views.state().views.length, 0);
  rejects(() => views.disconnect(credentials(first)), 403);
});

test('stale or cross-session credentials cannot control the replacement session', () => {
  const one = fixture(), old = one.views.register();
  const two = fixture(), fresh = two.views.register();
  rejects(() => two.views.assertOwner(credentials(old)), 403);
  rejects(() => two.views.claim({ ...credentials(old), expectedEpoch: two.views.state().epoch, takeover: true }), 403);
  assert.equal(two.views.state().ownerViewId, fresh.viewId);
  one.views.close();
  rejects(() => one.views.register(), 409);
  rejects(() => one.views.heartbeat(credentials(old)), 409);
});

test('view count is bounded and expired registrations release capacity', () => {
  const f = fixture({ maxViews: 2 });
  f.views.register(); f.views.register();
  rejects(() => f.views.register(), 429);
  f.advance(30000);
  const fresh = f.views.register();
  assert.equal(fresh.role, 'owner');
  assert.equal(f.views.state().views.length, 1);
});

test('malformed credentials or clock failure cannot silently acquire or retain control', () => {
  const f = fixture(), first = f.views.register(), second = f.views.register();
  for (const value of [null, {}, { ...credentials(first), lease: '' }, { viewId: [], lease: first.lease }]) {
    rejects(() => f.views.assertOwner(value), 400);
  }
  rejects(() => f.views.claim({ ...credentials(second), expectedEpoch: NaN, takeover: true }), 400);
  rejects(() => f.views.claim({ ...credentials(second), expectedEpoch: 1, takeover: 1 }), 400);
  assert.equal(f.views.state().ownerViewId, first.viewId);
  f.advance(1000); f.views.state(); f.setClock(999);
  rejects(() => f.views.assertOwner(credentials(first)), 503);
  rejects(() => f.views.register(), 503);
});

test('duplicate random identifiers are bounded failures and never overwrite an existing view', () => {
  const f = fixture({ randomBytes: size => Buffer.alloc(size, 1) });
  const first = f.views.register();
  rejects(() => f.views.register(), 503);
  assert.equal(f.views.state().views.length, 1);
  assert.equal(f.views.state().ownerViewId, first.viewId);
});

test('a finished terminal preserves readonly view registration and heartbeats without granting input', () => {
  const f = fixture(), original = f.views.register();
  f.views.finish();
  const reader = f.views.register();
  assert.equal(reader.role, 'watcher');
  assert.equal(reader.readonly, true);
  assert.equal(f.views.heartbeat(credentials(original)).role, 'watcher');
  rejects(() => f.views.assertOwner(credentials(original)), 409);
  rejects(() => f.views.claim({ ...credentials(reader), expectedEpoch: f.views.state().epoch, takeover: true }), 409);
  f.views.disconnect(credentials(original));
  assert.equal(f.views.state().readonly, true);
  f.views.close();
  assert.equal(f.views.state().closed, true);
  assert.equal(f.views.state().views.length, 0);
});

const win = process.platform === 'win32' ? test : test.skip;
const { Sessions } = require('../lib/sessions');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Synthetic terminal view fixture timed out');
}
async function terminalFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-views-'));
  const script = path.join(dir, 'input.cjs');
  fs.writeFileSync(script, 'process.stdin.setEncoding("utf8");process.stdin.on("data",data=>console.log("VIEW_INPUT:"+JSON.stringify(data)));console.log("VIEW_READY");setInterval(()=>{},1000);');
  const sessions = new Sessions(), key = ['fixture-project', 'fixture-task', 'codex'];
  const start = () => sessions.start({ project: key[0], task: key[1], ai: key[2], dir, command: process.execPath, args: [script], cols: 90, rows: 25 });
  t.after(async () => {
    const current = sessions.get(...key);
    if (current) { sessions.stop(...key); await current.finishedP; }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const session = start();
  assert.equal(await session.startedP, true);
  await until(() => session.buf.includes('VIEW_READY'));
  return { sessions, key, session, start };
}

win('two real ConPTY views share output, enforce owner resize/input, and disconnect without stopping the Job', { timeout: 30000 }, async t => {
  const { sessions, key, session } = await terminalFixture(t);
  const first = sessions.registerView(...key), second = sessions.registerView(...key);
  let one = '', two = '';
  const offOne = sessions.watch(...key, event => { if (event.type === 'data') one += event.data; });
  const offTwo = sessions.watch(...key, event => { if (event.type === 'data') two += event.data; });
  t.after(() => { offOne(); offTwo(); });
  rejects(() => sessions.writeView(...key, 'DENIED\r', credentials(second)), 409);
  rejects(() => sessions.resizeView(...key, 100, 30, credentials(second)), 409);
  rejects(() => sessions.writeView(...key, 'DENIED\r', undefined), 400);
  rejects(() => sessions.writeView(...key, '中'.repeat(350000), credentials(first)), 400);
  rejects(() => sessions.resizeView(...key, '100', 30, credentials(first)), 400);
  rejects(() => sessions.resizeView(...key, 501, 30, credentials(first)), 400);
  rejects(() => sessions.resizeView(...key, 100, NaN, credentials(first)), 400);
  assert.equal(session.proc.cols, 90);
  assert.equal(sessions.resizeView(...key, 110, 37, credentials(first)), true);
  assert.equal(session.proc.cols, 110);
  assert.equal(session.proc.rows, 37);
  assert.equal(sessions.writeView(...key, 'first 中文 & literal\r', credentials(first)), true);
  await until(() => one.includes('VIEW_INPUT:') && two.includes('VIEW_INPUT:'));
  assert.match(one, /first 中文 & literal/);
  assert.match(two, /first 中文 & literal/);
  const before = sessions.viewState(...key);
  sessions.disconnectView(...key, credentials(first)); offOne();
  assert.equal(session.exited, false);
  assert.notEqual(session.stopped, true);
  assert.equal(sessions.viewState(...key).ownerViewId, null);
  rejects(() => sessions.writeView(...key, 'DENIED\r', credentials(second)), 409);
  rejects(() => sessions.claimView(...key, { ...credentials(second), expectedEpoch: before.epoch, takeover: true }), 409);
  sessions.claimView(...key, { ...credentials(second), expectedEpoch: sessions.viewState(...key).epoch, takeover: true });
  assert.equal(sessions.writeView(...key, 'after disconnect\r', credentials(second)), true);
  await until(() => two.includes('after disconnect'));
  assert.equal(one.includes('after disconnect'), false);
  assert.equal(session.buf.includes('VIEW_INPUT:"DENIED'), false);
});

win('stop preserves readonly terminal history and replacement generation rejects old view credentials', { timeout: 30000 }, async t => {
  const { sessions, key, session, start } = await terminalFixture(t);
  const first = sessions.registerView(...key);
  sessions.stop(...key);
  assert.equal(sessions.viewState(...key).readonly, true);
  assert.equal(session.exited, false); // The owned Job remains busy until its exit notification.
  rejects(() => sessions.writeView(...key, 'DENIED\r', credentials(first)), 409);
  await session.finishedP;
  const reader = sessions.registerView(...key);
  assert.equal(reader.role, 'watcher');
  assert.equal(reader.readonly, true);
  assert.equal(sessions.heartbeatView(...key, credentials(reader)).readonly, true);
  assert.ok(session.buf.includes('VIEW_READY'));
  const replacement = start();
  assert.equal(await replacement.startedP, true);
  await until(() => replacement.buf.includes('VIEW_READY'));
  const fresh = sessions.registerView(...key);
  assert.notEqual(fresh.generation, first.generation);
  assert.equal(fresh.role, 'owner');
  rejects(() => sessions.writeView(...key, 'DENIED\r', credentials(first)), 403);
  rejects(() => sessions.disconnectView(...key, credentials(reader)), 403);
  assert.equal(sessions.viewState(...key).ownerViewId, fresh.viewId);
  assert.equal(session.views.state().closed, true);
  rejects(() => sessions.registerView('missing', key[1], key[2]), 404);
});
