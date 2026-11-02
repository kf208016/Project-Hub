'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registry = require('../lib/provider-registry');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function app() {
  const elements = new Map();
  const events = new Map(), windowEvents=new Map();
  const timers = new Map();
  const timeouts = new Map();
  const details = [];
  const missing = new Set();
  const writes = new Map();
  let nextTimer = 0;
  let stream;
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      html: '', textContent: '', value: '', hidden: false, disabled: false,
      get innerHTML() { return this.html; },
      set innerHTML(value) {
        this.html = value;
        writes.set(key, (writes.get(key) || 0) + 1);
        if (key === '#main') {
          // Model the status child created by the real renderWork/chatHtml template.
          const status = value.match(/<div id="grok-status">([\s\S]*?)<\/div>\s*<div id="grok-login-prompt">/);
          if (status) element('#grok-status').innerHTML = status[1];
        }
      },
      contains(node) { return node === this || node?.parent === this; },
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      dataset: {}, handlers: {}, attributes: {}, addEventListener(name, cb) { this.handlers[name] = cb; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {},
    });
    return elements.get(key);
  }
  class EventSource {
    constructor() { stream = this; }
    close() {}
  }
  const document = {
    hidden: false, activeElement: null,
    querySelector: s => missing.has(s) ? null : s.startsWith('details[open]') ? details.find(d => d.open && (!s.includes(':not(.project-notes)') || !d.classList.contains('project-notes'))) || null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener(name, cb) { events.set(name, cb); },
  };
  const context = vm.createContext({
    document, window: {addEventListener(name,callback){windowEvents.set(name,callback);}}, navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}), // 起動時の load() は試験用の状態を上書きしない
    EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; timers.set(id, { cb, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  return { context, document, elements, element, events, windowEvents, timers, timeouts, details, missing, writes, stream: () => stream };
}

const project = (state = '実行中') => ({
  id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '',
  phases: [], tasks: [{ id: 't', title: 'Task', state, owner: 'grok', role: '', model: '', effort: '',
    phase: '', steps: [], skills: [], question: '', next: '', copy: false }],
  folders: [], related: [], issues: [], chats: [],
});
const snapshot = (taskState = '実行中', sessions = []) => ({
  providers:registry.list({platform:'darwin'}),webChatAvailable:false,
  root: '/tmp', projects: [project(taskState)], roles: { models: { codex: [], 'claude-code': [] }, roles: [], permissions: {} },
  sessions, chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
});


const expired = {
  runtime: {version: '1.0.70'},
  auth: {present: true, mtime: '2026-10-28T13:57:00Z'},
  login: {state: 'expired', refreshAt: Date.parse('2026-10-28T19:22:00Z')},
};
const fresh = {
  ...expired, auth: {present: true, mtime: '2026-10-29T05:16:54Z'},
  login: {state: 'fresh', refreshAt: Date.parse('2026-10-29T10:41:54Z')},
};
function fixture(owner = 'grok') {
  const f = app();
  f.run = code => vm.runInContext(code, f.context);
  f.next = {...snapshot(), grokStatus: expired};
  f.next.projects[0].tasks[0].owner = owner;
  f.context.initial = f.next;
  f.run('state=initial;view={kind:"work",project:"p",task:"t"};render()');
  f.calls = [];
  f.context.fetch = async (route, options = {}) => {
    f.calls.push({route, method: options.method || 'GET'});
    assert.equal(route, '/api/state', 'fixture must never make other requests');
    return {ok: true, status: f.next ? 200 : 304, headers: {get: () => ''}, json: async () => f.next};
  };
  f.renderCount = 0;
  const render = f.context.render;
  f.context.render = () => { f.renderCount++; return render(); };
  f.element('#chat-in').tagName = 'TEXTAREA';
  f.element('#chat-in').value = 'unsent synthetic draft';
  f.document.activeElement = f.element('#chat-in');
  f.before = new Map(f.writes);
  f.update = () => { f.next = {...f.next, grokStatus: fresh}; };
  f.poll = () => f.context.pollState();
  f.statusWrites = () => (f.writes.get('#grok-status') || 0) - (f.before.get('#grok-status') || 0);
  return f;
}
function assertPreserved(f) {
  assert.equal(f.renderCount, 0, 'render() must not run');
  for (const key of ['#main', '#composer', '#chat-in', '#msgs']) {
    assert.equal(f.writes.get(key) || 0, f.before.get(key) || 0, key + ' must not be rewritten');
  }
  assert.equal(f.element('#chat-in').value, 'unsent synthetic draft');
}
function assertFresh(f) {
  const html = f.element('#grok-status').innerHTML;
  assert.match(html, /\u5efa\u8b70\u66f4\u65b0\u6642\u9593/);
  assert.doesNotMatch(html, /\u5df2\u904e\u671f/);
  f.context.freshStatus = fresh;
  assert.equal(html, f.run('grokStatusHtml(freshStatus)'));
  assert.equal(f.run('renderedGrokStatusHtml'), html);
}

test('R23 poll updates expired status while composer is focused without rewriting chat', async () => {
  const f = fixture();
  assert.match(f.element('#grok-status').innerHTML, /\u5df2\u904e\u671f/);
  assert.equal(f.run('renderedGrokStatusHtml'), f.element('#grok-status').innerHTML);
  assert.equal(f.run('mainKey()===renderedMainKey'), true);
  f.update();
  await f.poll();
  assertFresh(f);
  assert.equal(f.statusWrites(), 1);
  assert.equal(f.document.activeElement, f.element('#chat-in'));
  assert.equal(f.run('mainKey()===renderedMainKey'), true);
  assertPreserved(f);
});

test('R23 poll updates status with an open details element', async () => {
  const f = fixture();
  f.document.activeElement = null;
  f.details.push({open: true, classList: {contains: () => false}});
  f.update();
  await f.poll();
  assertFresh(f);
  assert.equal(f.statusWrites(), 1);
  assertPreserved(f);
});

test('R23 unchanged status including first poll after render and HTTP 304 writes nothing', async () => {
  const f = fixture();
  await f.poll();
  await f.poll();
  f.next = null;
  await f.poll();
  assert.equal(f.statusWrites(), 0);
  assertPreserved(f);
});

test('R23 focused login button defers writing and retains cache until focus leaves', async () => {
  const f = fixture(), html = f.element('#grok-status').innerHTML;
  const button = {tagName: 'BUTTON', parent: f.element('#grok-status')};
  f.document.activeElement = button;
  f.update();
  await f.poll();
  assert.equal(f.statusWrites(), 0);
  assert.equal(f.run('renderedGrokStatusHtml'), html);
  assert.equal(f.element('#grok-status').innerHTML, html);
  assert.equal(f.document.activeElement, button);
  f.document.activeElement = f.element('#chat-in');
  // A 304 must retry the previously deferred state.
  f.next = null;
  await f.poll();
  assert.equal(f.statusWrites(), 1);
  assertFresh(f);
  assertPreserved(f);
});

test('R23 non-Grok task keeps empty block without writes', async () => {
  const f = fixture('codex');
  assert.equal(f.element('#grok-status').innerHTML, '');
  f.update();
  await f.poll();
  await f.context.refreshTree();
  assert.equal(f.element('#grok-status').innerHTML, '');
  assert.equal(f.statusWrites(), 0);
  assertPreserved(f);
});

test('R23 non-work views never write the status block', async () => {
  for (const kind of ['project', 'settings', 'newproject', 'turn']) {
    const f = fixture();
    f.context.kind = kind;
    f.run('view.kind=kind');
    f.update();
    await f.poll();
    await f.context.refreshTree();
    assert.equal(f.statusWrites(), 0, kind);
    assertPreserved(f);
  }
});

for (const missing of ['block', 'project', 'task']) {
  test('R23 missing ' + missing + ' is a no-op', async () => {
    const f = fixture();
    f.update();
    if (missing === 'block') f.missing.add('#grok-status');
    if (missing === 'project') f.next.projects = [];
    if (missing === 'task') f.next.projects[0].tasks = [];
    await f.poll();
    await f.context.refreshTree();
    assert.equal(f.statusWrites(), 0);
    assertPreserved(f);
  });
}

test('R23 successful manual window immediately requests exactly one extra GET state', async () => {
  const f = fixture();
  await f.poll();
  const before = f.calls.length;
  f.update();
  // Observe completion of fire-and-forget refreshTree without real timers.
  const refresh = f.context.refreshTree;
  let pending;
  f.context.refreshTree = () => (pending = refresh());
  assert.equal(f.context.acceptGrokLoginWindow({running: false, outcome: 'refreshed'}), undefined);
  await pending;
  assert.deepEqual(f.calls.slice(before), [{route: '/api/state', method: 'GET'}]);
  assertFresh(f);
  assertPreserved(f);
});

test('R23 running, unchanged and failed window results do not fetch state', () => {
  for (const value of [
    {running: true, outcome: 'refreshed'}, {running: true},
    {running: false, outcome: 'unchanged'}, {running: false, outcome: 'failed'},
  ]) {
    const f = fixture();
    f.context.acceptGrokLoginWindow(value);
    assert.deepEqual(f.calls, []);
    assert.equal(f.statusWrites(), 0);
    assertPreserved(f);
  }
});

test('R23 refreshTree redraws status while editing and details are open', async () => {
  const f = fixture();
  f.details.push({open: true, classList: {contains: () => false}});
  f.update();
  await f.context.refreshTree();
  assertFresh(f);
  assert.equal(f.statusWrites(), 1);
  await f.context.refreshTree();
  assert.equal(f.statusWrites(), 1);
  assertPreserved(f);
});
