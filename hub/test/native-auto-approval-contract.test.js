'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function app() {
  const elements = new Map();
  const events = new Map(), windowEvents = new Map();
  const timers = new Map();
  const timeouts = new Map();
  const details = [];
  let nextTimer = 0;
  let stream;
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
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
    querySelector: s => s.startsWith('details[open]') ? details.find(d => d.open && (!s.includes(':not(.project-notes)') || !d.classList.contains('project-notes'))) || null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener(name, cb) { events.set(name, cb); },
  };
  const context = vm.createContext({
    document, window: {addEventListener(name, callback) { windowEvents.set(name, callback); }}, navigator: {userAgent: ''},
    localStorage: {getItem: () => null, setItem() {}},
    fetch: () => new Promise(() => {}),
    EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; timers.set(id, {cb, ms}); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, {cb, ms}); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  return {context, document, elements, element, events, windowEvents, timers, timeouts, details, stream: () => stream};
}

function snapshot() {
  return {
    providers: [], webChatAvailable: false,
    root: '/tmp',
    projects: [{
      id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '',
      phases: [], tasks: [{
        id: 't', title: 'Task', state: '実行中', owner: 'grok', role: '', model: 'grok-4.6', effort: 'low',
        phase: '', steps: [], skills: [], question: '', next: '', copy: false
      }],
      folders: [], related: [], issues: [], chats: []
    }],
    roles: {models: {codex: [], grok: ['grok-4.6']}, roles: [], permissions: {}},
    sessions: [], chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
  };
}

function within(ms, promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

function assertNoDialog(a) {
  assert.equal(a.element('#fsheet').innerHTML, '');
  assert.equal(a.element('#ws-confirm').onclick, undefined);
  assert.equal(a.element('#ws-cancel').onclick, undefined);
}

test('WORKSPACE_REQUIRED auto-approves without a dialog and retries with the permit', async () => {
  const a = app();
  vm.runInContext('state=' + JSON.stringify(snapshot()), a.context);
  const calls = [];
  a.context.fetch = async (route, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({route, body});
    if (route === '/api/start' && !body.workspacePermit) {
      return {ok: false, status: 409, json: async () => ({error: 'approval needed', code: 'WORKSPACE_REQUIRED', workspaceRequired: true, project: 'p', task: 't'})};
    }
    if (String(route).endsWith('/discover')) {
      return {ok: true, status: 200, json: async () => ({base: 'C:\\synthetic', mode: 'isolated', candidates: [{relative: '.env', bytes: 10, sha256: 'a'.repeat(64)}]})};
    }
    if (String(route).endsWith('/preview') && String(route).includes('/workspace/')) {
      return {ok: true, status: 200, json: async () => ({token: 'ws-token', action: 'source Git history remains', original: {allContent: 'b'.repeat(64), head: null}, execution: {hooks: []}, trackedSecrets: []})};
    }
    if (String(route).endsWith('/prepare')) {
      return {ok: true, status: 200, json: async () => ({ok: true, permit: 'permit-1'})};
    }
    if (route === '/api/start' && body.workspacePermit) {
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    return {ok: true, status: 200, json: async () => ({})};
  };
  await within(1000, a.context.api('/api/start', {project: 'p', request: 'same-request', text: 'retained', images: []}),
    'WORKSPACE_REQUIRED auto-approval did not finish; a dialog is still blocking');
  assertNoDialog(a);
  const discover = calls.find(c => c.route === '/api/task/workspace/discover');
  const preview = calls.find(c => c.route === '/api/task/workspace/preview');
  const prepare = calls.find(c => c.route === '/api/task/workspace/prepare');
  const retry = calls.find(c => c.route === '/api/start' && c.body && c.body.workspacePermit);
  assert.ok(discover);
  assert.deepEqual(preview.body.secrets, []);
  assert.equal(prepare.body.confirm, true);
  assert.equal(prepare.body.ackReadLimits, true);
  assert.equal(prepare.body.ackNetworkLimits, true);
  assert.equal(retry.body.workspacePermit, 'permit-1');
  assert.equal(retry.body.request, 'same-request');
});

test('NATIVE_PROVIDER_APPROVAL_REQUIRED auto-approves with the five acknowledgements and no dialog', async () => {
  const a = app();
  vm.runInContext('state=' + JSON.stringify(snapshot()), a.context);
  const calls = [];
  a.context.fetch = async (route, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({route, body});
    if (route === '/api/chat/send' && calls.filter(c => c.route === '/api/chat/send').length === 1) {
      return {ok: false, status: 409, json: async () => ({error: 'native approval needed', code: 'NATIVE_PROVIDER_APPROVAL_REQUIRED', project: 'p', task: 't', actor: 'grok'})};
    }
    if (route === '/api/native-provider/preview') {
      return {ok: true, status: 200, json: async () => ({token: 'np-token', review: {destination: 'xAI', modelFlag: 'grok-4.6', effortFlag: 'low', workspace: 'C:\\w', maxWallMs: 240000, authenticationRead: [], lockWrite: '', sessionWrite: 'C:\\s', tempWrite: 'C:\\t', mcpCredentialRead: 'C:\\m', commands: '', mcp: '', networkHosts: []}})};
    }
    if (route === '/api/native-provider/approve') {
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    if (route === '/api/chat/send') {
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    return {ok: true, status: 200, json: async () => ({})};
  };
  await within(1000, a.context.api('/api/chat/send', {project: 'p', task: 't', ai: 'grok', model: 'grok-4.6', effort: 'low', text: 'go'}),
    'NATIVE_PROVIDER_APPROVAL_REQUIRED auto-approval did not finish; a dialog is still blocking');
  assertNoDialog(a);
  const approve = calls.find(c => c.route === '/api/native-provider/approve');
  assert.ok(approve);
  assert.equal(approve.body.confirm, true);
  assert.equal(approve.body.ackAuthenticationRead, true);
  assert.equal(approve.body.ackCommandAccess, true);
  assert.equal(approve.body.ackDestination, true);
  assert.equal(approve.body.ackSessionWrite, true);
  assert.equal(calls.filter(c => c.route === '/api/chat/send').length, 2);
});

test('WORKSPACE_DESTINATION_REQUIRED auto-approves without a dialog and retries', async () => {
  const a = app();
  vm.runInContext('state=' + JSON.stringify(snapshot()), a.context);
  const calls = [];
  a.context.fetch = async (route, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({route, body});
    if (route === '/api/start' && calls.filter(c => c.route === '/api/start').length === 1) {
      return {ok: false, status: 409, json: async () => ({error: 'destination needed', code: 'WORKSPACE_DESTINATION_REQUIRED', project: 'p', task: 't', actor: 'codex'})};
    }
    if (route === '/api/workspace-destination/preview') {
      return {ok: true, status: 200, json: async () => ({token: 'dest-token', destination: 'OpenAI', review: {workspace: 'C:\\w', readLimits: 'read limits', files: []}})};
    }
    if (route === '/api/workspace-destination/approve') {
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    if (route === '/api/start') {
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    return {ok: true, status: 200, json: async () => ({})};
  };
  await within(1000, a.context.api('/api/start', {project: 'p', task: 't', ai: 'codex', request: 'same-request', text: 'go', images: []}),
    'WORKSPACE_DESTINATION_REQUIRED auto-approval did not finish; a dialog is still blocking');
  assertNoDialog(a);
  const approve = calls.find(c => c.route === '/api/workspace-destination/approve');
  assert.ok(approve);
  assert.equal(approve.body.confirm, true);
  assert.equal(approve.body.ackDestination, true);
  assert.equal(approve.body.ackReadLimits, true);
  assert.equal(calls.filter(c => c.route === '/api/start').length, 2);
});

test('a second identical 409 after automatic approval surfaces an error instead of looping', async () => {
  const a = app();
  vm.runInContext('state=' + JSON.stringify(snapshot()), a.context);
  const counts = {discover: 0, preview: 0, prepare: 0, start: 0, npPreview: 0, npApprove: 0, destPreview: 0, destApprove: 0};
  a.context.fetch = async (route, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    if (route === '/api/start') {
      counts.start++;
      return {ok: false, status: 409, json: async () => ({error: 'still required', code: 'WORKSPACE_REQUIRED', workspaceRequired: true, project: 'p', task: 't'})};
    }
    if (route === '/api/task/workspace/discover') {
      counts.discover++;
      return {ok: true, status: 200, json: async () => ({base: 'C:\\synthetic', mode: 'isolated', candidates: []})};
    }
    if (route === '/api/task/workspace/preview') {
      counts.preview++;
      return {ok: true, status: 200, json: async () => ({token: 'ws-token', action: 'ok', original: {allContent: 'b'.repeat(64), head: null}, execution: {hooks: []}, trackedSecrets: []})};
    }
    if (route === '/api/task/workspace/prepare') {
      counts.prepare++;
      return {ok: true, status: 200, json: async () => ({ok: true, permit: 'permit-1'})};
    }
    return {ok: true, status: 200, json: async () => ({})};
  };
  await assert.rejects(
    within(1000, a.context.api('/api/start', {project: 'p', request: 'same-request', text: 'x', images: []}),
      'second WORKSPACE_REQUIRED 409 still blocked on a dialog instead of stopping'),
    /still required/
  );
  assert.equal(counts.discover, 1);
  assert.equal(counts.preview, 1);
  assert.equal(counts.prepare, 1);
  assert.equal(counts.start, 2);
  assertNoDialog(a);

  const b = app();
  vm.runInContext('state=' + JSON.stringify(snapshot()), b.context);
  let chat = 0, npApprove = 0;
  b.context.fetch = async (route, opt = {}) => {
    if (route === '/api/chat/send') {
      chat++;
      return {ok: false, status: 409, json: async () => ({error: 'native still required', code: 'NATIVE_PROVIDER_APPROVAL_REQUIRED', project: 'p', task: 't', actor: 'grok'})};
    }
    if (route === '/api/native-provider/preview') {
      return {ok: true, status: 200, json: async () => ({token: 'np-token', review: {destination: 'xAI', modelFlag: 'x', effortFlag: 'low', workspace: 'C:\\w', maxWallMs: 1000, authenticationRead: [], sessionWrite: '', tempWrite: '', mcpCredentialRead: '', commands: '', mcp: '', networkHosts: []}})};
    }
    if (route === '/api/native-provider/approve') {
      npApprove++;
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    return {ok: true, status: 200, json: async () => ({})};
  };
  await assert.rejects(
    within(1000, b.context.api('/api/chat/send', {project: 'p', task: 't', ai: 'grok', model: 'grok-4.6', effort: 'low', text: 'x'}),
      'second NATIVE_PROVIDER_APPROVAL_REQUIRED 409 still blocked on a dialog instead of stopping'),
    /native still required/
  );
  assert.equal(npApprove, 1);
  assert.equal(chat, 2);

  const c = app();
  vm.runInContext('state=' + JSON.stringify(snapshot()), c.context);
  let destApprove = 0, destStart = 0;
  c.context.fetch = async (route, opt = {}) => {
    if (route === '/api/start') {
      destStart++;
      return {ok: false, status: 409, json: async () => ({error: 'destination still required', code: 'WORKSPACE_DESTINATION_REQUIRED', project: 'p', task: 't', actor: 'codex'})};
    }
    if (route === '/api/workspace-destination/preview') {
      return {ok: true, status: 200, json: async () => ({token: 'dest-token', destination: 'OpenAI', review: {workspace: 'C:\\w', readLimits: 'limits', files: []}})};
    }
    if (route === '/api/workspace-destination/approve') {
      destApprove++;
      return {ok: true, status: 200, json: async () => ({ok: true})};
    }
    return {ok: true, status: 200, json: async () => ({})};
  };
  await assert.rejects(
    within(1000, c.context.api('/api/start', {project: 'p', task: 't', ai: 'codex', text: 'x', images: []}),
      'second WORKSPACE_DESTINATION_REQUIRED 409 still blocked on a dialog instead of stopping'),
    /destination still required/
  );
  assert.equal(destApprove, 1);
  assert.equal(destStart, 2);
});
