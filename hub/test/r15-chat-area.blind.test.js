'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registry = require('../lib/provider-registry');

// R15 / C1 blind acceptance: the task chat area never blanks (row cache, loading block,
// stream identity, robust rows handler, reconnect, first-frame watchdog, mainKey without workspaceLifecycle).
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// The fixture has no translator, so UI text stays in the Japanese source; zh-TW comes from the catalog.
const LOADING = '<div class="chat-loading">会話を読み込んでいます…</div>';
const CHAT_URL = '/api/chat/stream?project=p&task=t';
const CLOSED = 2, CONNECTING = 0;

// Inner HTML of the element that carries id="<id>" (balanced on that element's own tag name); null when absent.
function innerOf(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf('<', at);
  const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open))?.[1];
  const end = html.indexOf('>', at);
  if (!tag || end < 0) return null;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  re.lastIndex = end + 1;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) { if (--depth === 0) return html.slice(end + 1, m.index); }
    else depth++;
  }
  return null;
}

// Minimal copy of the app() harness in test/app-ui.test.js, with three additions:
// - EventSource is a recording fake (url, readyState, close(), onmessage/onerror, listeners);
// - writing #main re-creates #msgs from the markup, like a real DOM (old handlers keep the detached box);
// - fetch answers /api/state from a queue (default 304) once the boot load() has been left pending.
function app() {
  const elements = new Map(), timeouts = new Map(), intervals = new Map();
  const streams = [], warnings = [], stateReplies = [];
  let nextTimer = 0, armed = false;
  function makeElement() {
    return {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      dataset: {}, handlers: {}, attributes: {}, style: {},
      addEventListener(name, cb) { this.handlers[name] = cb; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector() { return null; }, querySelectorAll() { return []; },
      insertAdjacentHTML(where, html) { if (where === 'beforeend') this.innerHTML += html; else if (where === 'afterbegin') this.innerHTML = html + this.innerHTML; },
    };
  }
  function element(key) {
    if (!elements.has(key)) {
      const el = makeElement();
      if (key === '#main') {
        let html = '';
        Object.defineProperty(el, 'innerHTML', {
          enumerable: true,
          get: () => html,
          set: value => {
            html = String(value);
            const inner = innerOf(html, 'msgs');
            if (inner !== null) { const box = makeElement(); box.innerHTML = inner; elements.set('#msgs', box); }
          },
        });
      }
      elements.set(key, el);
    }
    return elements.get(key);
  }
  class EventSource {
    constructor(url) {
      this.url = String(url); this.readyState = CONNECTING; this.closed = false; this.listeners = {};
      this.onmessage = null; this.onerror = null; this.onopen = null;
      streams.push(this);
    }
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
    removeEventListener(type, cb) { this.listeners[type] = (this.listeners[type] || []).filter(x => x !== cb); }
    close() { this.closed = true; this.readyState = CLOSED; }
  }
  for (const target of [EventSource, EventSource.prototype]) Object.assign(target, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
  const document = {
    hidden: false, activeElement: null,
    querySelector: s => s.startsWith('details[open]') ? null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { addEventListener() {} };
  const fetch = route => {
    if (!armed || route !== '/api/state') return new Promise(() => {});
    const reply = stateReplies.length ? stateReplies.shift() : { status: 304 };
    const body = reply.body === undefined ? {} : JSON.parse(JSON.stringify(reply.body));
    return Promise.resolve({ ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: { get: () => 'synthetic-etag' }, json: async () => body });
  };
  const quiet = { log() {}, info() {}, debug() {}, error() {}, warn: (...args) => { warnings.push(args); } };
  const context = vm.createContext({
    document, window, navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch, EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; intervals.set(id, { cb, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console: quiet, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  armed = true; // the boot load() already awaits a fetch that never settles
  const run = code => vm.runInContext(code, context);
  const chatStreams = () => streams.filter(s => s.url.includes('/api/chat/stream'));
  const api = {
    context, run, window, elements, element, timeouts, streams, warnings, stateReplies,
    chatStreams,
    live: () => chatStreams().filter(s => !s.closed && s.readyState !== CLOSED),
    current: () => chatStreams().at(-1),
    msgs: () => (elements.has('#msgs') ? elements.get('#msgs').innerHTML : ''),
    main: () => element('#main').innerHTML,
    empty: () => run('EMPTY_CHAT()'),
    mark: () => nextTimer,
    pending: (since, ms) => [...timeouts.entries()].filter(([id, t]) => id > since && t.ms === ms).map(([id]) => id),
    fire(id) { const t = timeouts.get(id); assert.ok(t, 'timer ' + id + ' is pending'); timeouts.delete(id); t.cb(); },
    fireIfPending(id) { const t = timeouts.get(id); if (!t) return false; timeouts.delete(id); t.cb(); return true; },
    setState: s => run('state=' + JSON.stringify(s)),
    openWork(task = 't') { run('view=' + JSON.stringify({ kind: 'work', project: 'p', task })); context.render(); },
  };
  return api;
}

const task = id => ({ id, title: 'Task ' + id, state: '実行中', owner: 'codex', role: '', model: '', effort: '', phase: '', steps: [], skills: [], question: '', next: '', copy: false });
const snapshot = (ids = ['t'], { windowsBrowser = false } = {}) => ({
  providers: registry.list({ platform: windowsBrowser ? 'win32' : 'darwin' }), webChatAvailable: windowsBrowser,
  ...(windowsBrowser ? { windowsBrowser: true } : {}),
  root: '/synthetic-root',
  projects: [{ id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '', phases: [], tasks: ids.map(task), folders: [], related: [], issues: [], chats: [] }],
  roles: { models: { codex: [], 'claude-code': [] }, roles: [], permissions: {} },
  sessions: [], chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
});
const clone = value => JSON.parse(JSON.stringify(value));
const said = text => ({ role: 'assistant', ai: 'codex', text });
const hiddenTool = text => ({ role: 'event', tool: true, text });
const rowsFrame = (rows, extra = {}) => ({ type: 'rows', rows, busy: null, queue: [], approvals: [], ...extra });
function deliver(es, value) {
  const ev = { data: JSON.stringify(value) };
  if (typeof es.onmessage === 'function') es.onmessage(ev);
  for (const cb of es.listeners.message || []) cb(ev);
}
function fail(es, readyState) {
  es.readyState = readyState;
  const ev = { type: 'error' };
  if (typeof es.onerror === 'function') es.onerror(ev);
  for (const cb of es.listeners.error || []) cb(ev);
}
function assertShowsRows(a, pattern) {
  assert.match(a.msgs(), pattern);
  assert.equal(a.msgs().includes('chat-empty'), false, 'chat area shows EMPTY_CHAT');
  assert.equal(a.main().includes('chat-empty'), false, '#main pre-blanks with EMPTY_CHAT');
}

test('C1 app.css styles .chat-loading like the muted placeholder text', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /\.chat-loading\b[^{}]*\{[^}]*color\s*:\s*var\(--muted\)/);
});

test('C1(a) cached rows survive a turn-boundary refreshTree and the 304 poll re-render that follows', async () => {
  const a = app(), s = snapshot();
  a.setState(s);
  a.openWork('t');
  const first = a.current();
  assert.equal(first.url, CHAT_URL);
  deliver(first, rowsFrame([said('CachedRowAlpha'), said('CachedRowBeta')]));
  assert.match(a.msgs(), /CachedRowAlpha[\s\S]*CachedRowBeta/);
  const changed = clone(s);
  changed.projects[0].tasks[0].next = 'SyntheticNextStep';
  a.stateReplies.push({ status: 200, body: changed });
  await a.context.refreshTree();
  assert.equal(a.chatStreams().length, 1, 'refreshTree alone does not re-render');
  a.stateReplies.push({ status: 304 });
  await a.context.pollState();
  assert.equal(a.chatStreams().length, 2, 'the 304 poll re-rendered the work view');
  assert.equal(first.closed, true);
  assertShowsRows(a, /CachedRowAlpha[\s\S]*CachedRowBeta/);
  assert.match(a.main(), /CachedRowAlpha[\s\S]*CachedRowBeta/);
  assert.equal(a.live().length, 1);
});

test('C1 invariant: rows stay visible across any number of work-view re-renders until a new rows frame', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  deliver(a.current(), rowsFrame([said('SurvivorRow')]));
  for (let i = 0; i < 6; i++) {
    a.context.render();
    assertShowsRows(a, /SurvivorRow/);
    assert.equal(a.live().length, 1);
  }
  deliver(a.current(), rowsFrame([said('SurvivorRow'), said('FreshRow')]));
  assert.match(a.msgs(), /SurvivorRow[\s\S]*FreshRow/);
  a.context.render();
  assertShowsRows(a, /SurvivorRow[\s\S]*FreshRow/);
});

test('C1(b) without a cache the work view shows the loading block; EMPTY_CHAT only after rows:[]', () => {
  for (const windowsBrowser of [false, true]) {
    const a = app();
    a.setState(snapshot(['t'], { windowsBrowser }));
    a.openWork('t');
    assert.equal(a.msgs().includes(LOADING), true, 'loading block in the chat area');
    assert.equal(a.main().includes(LOADING), true, 'loading block in the rendered work view');
    assert.equal(a.msgs().includes('chat-empty'), false);
    assert.equal(a.main().includes('chat-empty'), false);
    deliver(a.current(), rowsFrame([]));
    assert.equal(a.msgs(), a.empty());
  }
});

test('C1 row frames append to the cache (hidden tool rows too) and are drawn after a re-render', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const first = a.current();
  deliver(first, rowsFrame([said('AppendBase')]));
  deliver(first, { type: 'row', row: said('AppendNext') });
  deliver(first, { type: 'row', row: hiddenTool('HiddenToolStep') });
  a.context.render();
  assertShowsRows(a, /AppendBase[\s\S]*AppendNext/);
  assert.equal(a.msgs().includes('HiddenToolStep'), false);
});

test('C1(c) frames from a stale stream after a newer stream opened change nothing', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const first = a.current();
  deliver(first, rowsFrame([said('KeptRow')]));
  a.context.render();
  const second = a.current();
  assert.notEqual(second, first);
  assert.equal(first.closed, true);
  const shown = a.msgs(), queue = a.element('#chat-queue').innerHTML, mark = a.mark();
  deliver(first, rowsFrame([], { queue: [{ id: 'q-stale', text: 'StaleQueueText', ai: 'codex', model: '' }] }));
  deliver(first, { type: 'row', row: said('StaleRow') });
  fail(first, CLOSED);
  assert.equal(a.msgs(), shown);
  assert.equal(a.element('#chat-queue').innerHTML, queue);
  assert.equal(a.element('#chat-queue').innerHTML.includes('StaleQueueText'), false);
  assert.deepEqual(a.pending(mark, 2000), [], 'a stale stream error schedules no reconnect');
  assert.equal(a.chatStreams().length, 2);
  assert.equal(second.closed, false);
  a.context.render();
  assertShowsRows(a, /KeptRow/);
  assert.equal(a.msgs().includes('StaleRow'), false, 'stale row frame did not reach the cache');
});

test('C1 a rows frame that cannot be rendered keeps the previous chat content and warns once', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const first = a.current();
  deliver(first, rowsFrame([said('StableRow')]));
  const before = a.msgs(), warned = a.warnings.length;
  const broken = { role: 'assistant', ai: 'codex', text: 'BrokenRow', asks: [{ question: 'synthetic?', options: null }] };
  assert.doesNotThrow(() => deliver(first, rowsFrame([said('NewRow'), broken])));
  assert.equal(a.msgs(), before);
  assert.equal(a.warnings.length, warned + 1, 'exactly one console.warn');
  assert.equal(first.closed, false);
  deliver(first, rowsFrame([said('RecoveredRow')]));
  assert.match(a.msgs(), /RecoveredRow/);
});

test('C1(d) onerror with CLOSED schedules exactly one 2000 ms reconnect that opens one stream with the same URL', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const first = a.current();
  deliver(first, rowsFrame([said('BeforeDropRow')]));
  const mark = a.mark();
  fail(first, CLOSED);
  assert.equal(a.chatStreams().length, 1, 'no synchronous reopen');
  const retry = a.pending(mark, 2000);
  assert.equal(retry.length, 1);
  a.fire(retry[0]);
  assert.equal(a.chatStreams().length, 2);
  const second = a.current();
  assert.equal(second.url, first.url);
  assert.equal(second.url, CHAT_URL);
  assert.equal(a.live().length, 1);
  assertShowsRows(a, /BeforeDropRow/);
  for (const id of [...a.pending(0, 2000), ...a.pending(0, 8000)]) {
    a.fireIfPending(id);
    assert.ok(a.live().length <= 1, 'never more than one open chat stream');
  }
});

test('C1(d) a transient error while CONNECTING needs no action', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const first = a.current();
  const mark = a.mark();
  fail(first, CONNECTING);
  assert.deepEqual(a.pending(mark, 2000), []);
  assert.equal(a.chatStreams().length, 1);
  assert.equal(first.closed, false);
});

test('C1(d) closePanes cancels a pending reconnect', () => {
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const first = a.current();
  const mark = a.mark();
  fail(first, CLOSED);
  const [retry] = a.pending(mark, 2000);
  assert.ok(retry);
  a.context.closePanes();
  assert.equal(a.timeouts.has(retry), false, 'closePanes clears the reconnect timer');
  assert.equal(a.chatStreams().length, 1);
  assert.equal(a.live().length, 0);
});

test('C1(d) leaving the task or opening another stream cancels a pending reconnect', () => {
  const leave = app();
  leave.setState(snapshot());
  leave.openWork('t');
  let mark = leave.mark();
  fail(leave.current(), CLOSED);
  let [retry] = leave.pending(mark, 2000);
  assert.ok(retry);
  leave.run('view={kind:"project",project:"p",task:null}');
  leave.context.render();
  assert.equal(leave.timeouts.has(retry), false);
  assert.equal(leave.live().length, 0);

  const reopen = app();
  reopen.setState(snapshot());
  reopen.openWork('t');
  mark = reopen.mark();
  fail(reopen.current(), CLOSED);
  [retry] = reopen.pending(mark, 2000);
  assert.ok(retry);
  reopen.context.render();
  assert.equal(reopen.timeouts.has(retry), false);
  assert.equal(reopen.live().length, 1);
});

test('C1(e) the 8000 ms first-frame watchdog closes a silent stream and reopens it once', () => {
  const a = app();
  a.setState(snapshot());
  const mark = a.mark();
  a.openWork('t');
  const first = a.current();
  const dogs = a.pending(mark, 8000);
  assert.equal(dogs.length, 1);
  a.fire(dogs[0]);
  assert.equal(first.closed, true);
  assert.equal(a.chatStreams().length, 2, 'exactly one reopen per expiry');
  assert.equal(a.current().url, first.url);
  assert.equal(a.live().length, 1);
  assert.equal(a.msgs().includes('chat-empty'), false);
  deliver(first, rowsFrame([]));
  assert.equal(a.msgs().includes('chat-empty'), false, 'late frame of the replaced stream is ignored');
  deliver(a.current(), rowsFrame([said('AfterWatchdogRow')]));
  assert.match(a.msgs(), /AfterWatchdogRow/);
});

test('C1(e) a rows frame before 8000 ms disarms the watchdog', () => {
  const a = app();
  a.setState(snapshot());
  const mark = a.mark();
  a.openWork('t');
  const first = a.current();
  deliver(first, rowsFrame([said('InTimeRow')]));
  for (const id of a.pending(mark, 8000)) a.fireIfPending(id);
  assert.equal(first.closed, false);
  assert.equal(a.chatStreams().length, 1);
  assertShowsRows(a, /InTimeRow/);
});

test('C1 while HubNativeRestart is paused the work view opens no stream and arms no timers', () => {
  const a = app();
  a.setState(snapshot());
  a.window.HubNativeRestart = { paused: true };
  const mark = a.mark();
  a.openWork('t');
  assert.equal(a.chatStreams().length, 0);
  assert.deepEqual(a.pending(mark, 2000), []);
  assert.deepEqual(a.pending(mark, 8000), []);
});

test('C1 a reconnect or watchdog that fires after pausing opens no stream and re-arms nothing', () => {
  const a = app();
  a.setState(snapshot());
  const mark = a.mark();
  a.openWork('t');
  fail(a.current(), CLOSED);
  const armed = [...a.pending(mark, 2000), ...a.pending(mark, 8000)];
  a.window.HubNativeRestart = { paused: true };
  const pausedAt = a.mark();
  for (const id of armed) a.fireIfPending(id);
  assert.equal(a.chatStreams().length, 1);
  assert.deepEqual(a.pending(pausedAt, 2000), []);
  assert.deepEqual(a.pending(pausedAt, 8000), []);
});

test('C1(f) a poll that changes only workspaceLifecycle does not re-render the work view', async () => {
  for (const windowsBrowser of [false, true]) {
    const a = app(), s = snapshot(['t'], { windowsBrowser });
    s.projects[0].tasks[0].workspaceLifecycle = { kind: 'chat', state: 'active', ownedChildren: 1, retryClose: false, errorCode: '' };
    a.setState(s);
    a.openWork('t');
    const first = a.current();
    deliver(first, rowsFrame([said('LifecycleRow')]));
    const main = a.main(), box = a.elements.get('#msgs'), shown = a.msgs(), key = a.context.mainKey();
    const lifecycles = [
      { kind: 'chat', state: 'active', ownedChildren: 3, retryClose: false, errorCode: '' },
      { kind: 'chat', state: 'idle', ownedChildren: 0, retryClose: false, errorCode: '' },
      { kind: 'chat', state: 'waiting', ownedChildren: 0, retryClose: true, errorCode: '' },
      null,
      undefined,
    ];
    for (const lifecycle of lifecycles) {
      const next = clone(s);
      if (lifecycle === undefined) delete next.projects[0].tasks[0].workspaceLifecycle;
      else next.projects[0].tasks[0].workspaceLifecycle = lifecycle;
      a.stateReplies.push({ status: 200, body: next });
      await a.context.pollState();
      assert.equal(a.chatStreams().length, 1, `no new stream (${JSON.stringify(lifecycle)})`);
      assert.equal(first.closed, false);
      assert.equal(a.main(), main);
      assert.equal(a.elements.get('#msgs'), box);
      assert.equal(a.msgs(), shown);
      assert.equal(a.context.mainKey(), key);
      if (windowsBrowser && lifecycle?.state === 'waiting') assert.match(a.element('#workspace-lifecycle').innerHTML, /data-act="workspaceclose"/, 'lifecycle box is updated in place');
    }
    const renamed = clone(s);
    renamed.projects[0].tasks[0].next = 'ChangedNextStep';
    a.stateReplies.push({ status: 200, body: renamed });
    await a.context.pollState();
    assert.equal(a.chatStreams().length, 2, 'any other task change still re-renders');
    assertShowsRows(a, /LifecycleRow/);
  }
});

test('C1(g) the cache keeps at most 20 tasks and drops the oldest', () => {
  const ids = Array.from({ length: 21 }, (_, i) => 't' + String(i).padStart(2, '0'));
  const a = app();
  a.setState(snapshot(ids));
  for (const [i, id] of ids.entries()) {
    a.openWork(id);
    assert.equal(a.current().url, `/api/chat/stream?project=p&task=${id}`);
    deliver(a.current(), rowsFrame([said('TaskRow' + String(i).padStart(2, '0') + 'Q')]));
  }
  a.openWork('t00');
  assert.equal(a.msgs().includes('TaskRow00Q'), false, 'oldest task was evicted');
  assert.equal(a.msgs().includes(LOADING), true);
  a.openWork('t01');
  assertShowsRows(a, /TaskRow01Q/);
  a.openWork('t20');
  assertShowsRows(a, /TaskRow20Q/);
});

test('C1(g) the cache keeps the newest 2000 rows per task, counting appended hidden rows', () => {
  const tag = i => 'R' + String(i).padStart(4, '0') + 'Q';
  // Assistant rows repeat their text in the copy button (data-copy), so count distinct row tags.
  const count = html => new Set(html.match(/R\d{4}Q/g) || []).size;
  const a = app();
  a.setState(snapshot());
  a.openWork('t');
  const all = Array.from({ length: 2001 }, (_, i) => said(tag(i)));
  deliver(a.current(), rowsFrame(all));
  a.context.render();
  assert.equal(count(a.msgs()), 2000);
  assert.equal(a.msgs().includes(tag(0)), false);
  assert.match(a.msgs(), new RegExp(`${tag(1)}[\\s\\S]*${tag(2000)}`));
  const second = a.current();
  deliver(second, rowsFrame(all));
  deliver(second, { type: 'row', row: said(tag(2001)) });
  deliver(second, { type: 'row', row: hiddenTool('HiddenToolStep') });
  a.context.render();
  assert.equal(count(a.msgs()), 1999);
  assert.equal(a.msgs().includes(tag(1)), false);
  assert.equal(a.msgs().includes(tag(2)), false);
  assert.match(a.msgs(), new RegExp(`${tag(3)}[\\s\\S]*${tag(2001)}`));
});
