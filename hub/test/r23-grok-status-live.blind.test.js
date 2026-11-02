'use strict';
// Round 23 blind test (written by Claude from SPEC-R23 only): the Grok status line in the work view follows the login.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registry = require('../lib/provider-registry');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

const EXPIRED = { runtime: { version: '1.0.70', slotPresent: true }, auth: { present: true, mtime: '2026-10-28T13:57:31.296Z' }, login: { state: 'expired' } };
const FRESH = { runtime: { version: '1.0.70', slotPresent: true }, auth: { present: true, mtime: '2026-10-29T05:16:54.930Z' }, login: { state: 'fresh', refreshAt: 1793270514930, expiresAt: 1793272314930 } };

function app() {
  const elements = new Map(), timeouts = new Map(), details = [];
  let nextTimer = 0;
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100, tagName: 'DIV',
      dataset: {}, handlers: {}, attributes: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(name, cb) { this.handlers[name] = cb; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {}, contains() { return false; },
    });
    return elements.get(key);
  }
  class EventSource { close() {} }
  const document = {
    hidden: false, activeElement: null,
    querySelector: s => s.startsWith('details[open]') ? details.find(d => d.open && (!s.includes(':not(.project-notes)') || !d.classList.contains('project-notes'))) || null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const context = vm.createContext({
    document, window: { addEventListener() {} }, navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}),
    EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval() { return ++nextTimer; }, clearInterval() {},
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  return { context, document, element, details, timeouts, run: code => vm.runInContext(code, context) };
}

const snapshot = (owner, grokStatus) => ({
  providers: registry.list({ platform: 'darwin' }), webChatAvailable: false, grokStatus,
  root: '/tmp', roles: { models: { codex: [], 'claude-code': [] }, roles: [], permissions: {} },
  projects: [{
    id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '', phases: [],
    tasks: [{ id: 't', title: 'Task', state: '実行中', owner, role: '', model: '', effort: '', phase: '', steps: [], skills: [], question: '', next: '', copy: false }],
    folders: [], related: [], issues: [], chats: [],
  }],
  sessions: [], chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
});

// Renders the work view with `first`, then serves `next` to every GET /api/state and counts writes to #grok-status.
function fixture({ owner = 'grok', first = EXPIRED, next = FRESH, kind = 'work' } = {}) {
  const f = app();
  f.calls = [];
  f.context.toast = () => {};
  f.context.next = snapshot(owner, next);
  f.context.api = async (route, body) => { f.calls.push({ route, body }); return route === '/api/state' ? JSON.parse(JSON.stringify(f.context.next)) : {}; };
  f.run('state=' + JSON.stringify(snapshot(owner, first)) + ';view={kind:"work",project:"p",task:"t"}');
  f.run('render()');
  f.renders = 0;
  f.context.__countRender = () => { f.renders++; };
  f.run('const __realRender=render;render=()=>{__countRender();__realRender();}');
  const box = f.element('#grok-status');
  let html = box.innerHTML;
  f.writes = 0;
  Object.defineProperty(box, 'innerHTML', { configurable: true, get: () => html, set: value => { f.writes++; html = String(value); } });
  f.box = box;
  if (kind !== 'work') f.run(`view={kind:${JSON.stringify(kind)},project:"p",task:"t"}`);
  f.composerBefore = [f.element('#composer').innerHTML, f.element('#msgs').innerHTML, f.element('#main').innerHTML];
  f.poll = () => f.context.pollState();
  return f;
}
const stateGets = f => f.calls.filter(c => c.route === '/api/state').length;

test('R23 blind: the rendered work view still shows the expired status before any poll', () => {
  const f = fixture();
  assert.match(f.run('chatHtml(proj("p"),taskOf(proj("p"),"t"))'), /已過期/);
  assert.equal(typeof f.context.refreshGrokStatus, 'function');
  f.context.refreshGrokStatus();
  assert.equal(f.writes, 0, 'the status the render wrote is already shown');
});

test('R23 blind: a poll redraws only the status block while the composer textarea is focused', async () => {
  const f = fixture();
  f.document.activeElement = { tagName: 'TEXTAREA' };
  await f.poll();
  assert.equal(f.writes, 1);
  assert.match(f.box.innerHTML, /建議更新時間：/);
  assert.doesNotMatch(f.box.innerHTML, /已過期/);
  assert.ok(f.box.innerHTML.includes('data-grok-mode="refresh"'));
  assert.equal(f.renders, 0, 'render() must not run while typing');
  assert.deepEqual([f.element('#composer').innerHTML, f.element('#msgs').innerHTML, f.element('#main').innerHTML], f.composerBefore);
});

test('R23 blind: a poll redraws the status block while a details element is open', async () => {
  const f = fixture();
  f.details.push({ open: true, classList: { contains: () => false } });
  await f.poll();
  assert.equal(f.writes, 1);
  assert.match(f.box.innerHTML, /建議更新時間：/);
  assert.equal(f.renders, 0);
});

test('R23 blind: an unchanged status writes nothing, including the first poll after a render', async () => {
  const f = fixture({ next: EXPIRED });
  f.document.activeElement = { tagName: 'TEXTAREA' };
  await f.poll();
  await f.poll();
  assert.equal(f.writes, 0);
  f.context.next = snapshot('grok', FRESH);
  await f.poll();
  await f.poll();
  assert.equal(f.writes, 1, 'one write for one change');
});

test('R23 blind: no write while the focus is inside the block; the next poll after it leaves writes', async () => {
  const f = fixture();
  const button = { tagName: 'BUTTON' };
  f.box.contains = el => el === button;
  f.document.activeElement = button;
  await f.poll();
  assert.equal(f.writes, 0);
  assert.doesNotMatch(f.box.innerHTML, /建議更新時間/);
  f.document.activeElement = { tagName: 'BODY' };
  await f.poll();
  assert.equal(f.writes, 1);
  assert.match(f.box.innerHTML, /建議更新時間：/);
});

test('R23 blind: a task not owned by Grok keeps an empty block and is not rewritten', async () => {
  const f = fixture({ owner: 'codex' });
  f.document.activeElement = { tagName: 'TEXTAREA' };
  await f.poll();
  await f.poll();
  assert.equal(f.writes, 0);
  assert.equal(f.box.innerHTML, '');
});

test('R23 blind: views other than work never write the block', async () => {
  for (const kind of ['project', 'turn', 'settings']) {
    const f = fixture({ kind });
    f.document.activeElement = { tagName: 'TEXTAREA' };
    f.context.refreshGrokStatus();
    await f.poll();
    assert.equal(f.writes, 0, kind);
  }
});

test('R23 blind: refreshTree() also redraws the block', async () => {
  const f = fixture();
  f.document.activeElement = { tagName: 'TEXTAREA' };
  await f.context.refreshTree();
  assert.equal(f.writes, 1);
  assert.match(f.box.innerHTML, /建議更新時間：/);
});

test('R23 blind: a refreshed manual window fetches the state once and shows the new status', async () => {
  const f = fixture();
  f.document.activeElement = { tagName: 'TEXTAREA' };
  f.context.acceptGrokLoginWindow({ running: false, mode: 'refresh', outcome: 'refreshed', timedOut: false, exitCode: 0 });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(stateGets(f), 1);
  assert.equal(f.writes, 1);
  assert.match(f.box.innerHTML, /建議更新時間：/);
});

test('R23 blind: a running, unchanged or failed window result fetches nothing extra', async () => {
  for (const value of [
    { running: true, mode: 'refresh' },
    { running: false, mode: 'refresh', outcome: 'unchanged', timedOut: false, exitCode: 0 },
    { running: false, mode: 'refresh', outcome: 'failed', timedOut: true, exitCode: null },
    { running: false, mode: 'login', outcome: 'failed', timedOut: false, exitCode: 1 },
  ]) {
    const f = fixture();
    f.context.acceptGrokLoginWindow(value);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(stateGets(f), 0, JSON.stringify(value));
    assert.equal(f.writes, 0, JSON.stringify(value));
  }
});

test('R23 blind: mainKey() still ignores the Grok status (no full re-render on a login change)', () => {
  const f = fixture();
  const before = f.run('mainKey()');
  f.run('state.grokStatus=' + JSON.stringify(FRESH));
  assert.equal(f.run('mainKey()'), before);
});

test('R23 blind: refreshGrokStatus is called next to refreshWorkspaceLifecycle in pollState and refreshTree', () => {
  const body = name => { const at = source.indexOf(name); assert.ok(at >= 0, name); return source.slice(at, source.indexOf('\n}', at)); };
  for (const name of ['async function pollState()', 'async function refreshTree()']) {
    const text = body(name);
    const a = text.indexOf('refreshWorkspaceLifecycle();'), b = text.indexOf('refreshGrokStatus();');
    assert.ok(a >= 0 && b > a, name);
    assert.ok(!/editing\(\)/.test(text.slice(a, b)), name + ': no editing() gate between them');
  }
});
