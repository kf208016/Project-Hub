'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// R15 / L1 blind acceptance: the Grok status line no longer mentions the auth lock file.
const registry = require('../lib/provider-registry');
const locale = require('../public/i18n');
for (const name of ['main', 'main-extra', 'aux', 'empty']) locale.add(JSON.parse(fs.readFileSync(path.join(__dirname, '../public/locales/zh-TW-' + name + '.json'), 'utf8')));
const APP = path.join(__dirname, '../public/app.js');

// Same loading pattern as test/r14-grok-status.blind.test.js.
function fixture({ platform = 'win32', language = 'zh-TW' } = {}) {
  locale.setLocale(language);
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', value: '', textContent: '', hidden: false, disabled: false, dataset: {}, style: {}, attributes: {}, scrollTop: 0, scrollHeight: 100, clientHeight: 100, focus() {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {} });
    return elements.get(key);
  };
  const document = { querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const context = vm.createContext({ document, window: { L: locale.L, UI: locale.UI, HubI18n: locale, HubWebChat: { open() {} }, location: { protocol: 'http:' }, addEventListener() {} }, navigator: { userAgent: '' }, localStorage: { getItem: () => null, setItem() {} }, fetch: () => new Promise(() => {}), EventSource: class { close() {} }, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {}, URLSearchParams, console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'), confirm: () => true });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(APP, 'utf8'));
  const p = { id: 'p', name: '原文', parent: '', status: '進行中', description: '', phases: [], folders: [], related: [], issues: [], chats: [], tasks: [{ id: 't', title: '作業', owner: 'codex', model: 'GPT-6.1-Sol', effort: '高', role: '', state: '未着手', steps: [], skills: [], question: '', copy: false }] };
  context.snapshot = { root: 'C:\\synthetic', providers: registry.list({ platform }), webChatAvailable: platform === 'win32', windowsBrowser: platform === 'win32', projects: [p], sessions: [], chatting: [], unread: [], terminal: true, agyAvailable: true, efforts: ['中', '高'], roles: { models: { codex: ['GPT-6.1-Sol'], 'claude-code': ['Opus 5.5'], agy: ['Gemini 3.1 Pro (High)'], grok: ['Saved model'] }, roles: [], permissions: {} }, initialPick: { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' }, cliFlags: {}, version: '4.68.2', latest: '4.68.2' };
  run('state=snapshot;view={kind:"project",project:"p",task:null};toast=()=>{};api=async()=>({});load=async()=>{};loadAiTools=()=>{};loadCliModels=()=>{};loadChatgpt=()=>{};loadRemote=()=>{};');
  return { context, run, element };
}
function rowSlice(html, ai) {
  const marker = `data-ai="${ai}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0);
  const next = html.indexOf('data-ai="', start + marker.length);
  return html.slice(start, next === -1 ? html.length : next);
}
const clone = value => JSON.parse(JSON.stringify(value));
const loggedIn = {
  auth: { present: true, bytes: 1752, mtime: '2026-10-25T02:00:00.000Z', lockPresent: false, lockMtime: null },
  runtime: { version: '1.0.70', hashPrefix: '1e03c16cf2bd', slotPresent: false, override: null, overrideInvalid: false }
};
function locked(base, lockMtime = '2026-10-25T02:05:00.000Z') {
  const value = clone(base);
  value.auth.lockPresent = true;
  value.auth.lockMtime = lockMtime;
  return value;
}
function html(f, status) { return f.run('grokStatusHtml(' + JSON.stringify(status) + ')'); }
function assertNoLock(text) {
  assert.equal(text.includes('登入檔鎖存在'), false);
  assert.equal(text.includes('未正常結束'), false);
  assert.equal(text.includes('auth.json.lock'), false);
}

test('L1 grokStatusHtml with lockPresent:true has no lock sentence and keeps the version and login-time lines', () => {
  const f = fixture();
  const out = html(f, locked(loggedIn));
  assertNoLock(out);
  assert.equal(out.includes('Hub 使用 Grok CLI 1.0.70（第一次送出時建立 Hub 私有副本）'), true);
  assert.equal(out.includes('Grok 登入檔最後更新：'), true);
  assert.equal(out.includes('（Hub 不讀取內容，無法判斷是否仍有效）'), true);
  // R19 appends the expiry estimate and the owner login buttons after the login-time line.
  assert.match(out, /^<div class="grok-status small"><div>Hub 使用 Grok CLI 1\.0\.70（第一次送出時建立 Hub 私有副本）<\/div><div>Grok 登入檔最後更新：[^<]+（Hub 不讀取內容，無法判斷是否仍有效）<\/div>(?:<div>(?:已過期|預估到期：[^<]+)<\/div>)?<div class="grok-login-actions"[\s\S]*<\/div><\/div>$/);
});

test('L1 the locked status line is byte-identical to the unlocked one', () => {
  const f = fixture();
  assert.equal(html(f, locked(loggedIn)), html(f, loggedIn));
  for (const lockMtime of [null, 'not-a-date', '2026-10-26T00:00:00.000Z']) assert.equal(html(f, locked(loggedIn, lockMtime)), html(f, loggedIn), String(lockMtime));
});

test('L1 slot, override and invalid-override variants ignore the lock', () => {
  const f = fixture();
  const slot = clone(loggedIn); slot.runtime.slotPresent = true;
  const override = clone(loggedIn); override.runtime.version = '1.0.34'; override.runtime.override = '1.0.34';
  const invalid = clone(loggedIn); invalid.runtime.overrideInvalid = true;
  for (const [base, marker] of [[slot, 'Hub 私有副本已建立'], [override, '；由 PROJECT_HUB_GROK_VERSION 指定'], [invalid, 'PROJECT_HUB_GROK_VERSION 的值不在已審核清單']]) {
    const out = html(f, locked(base));
    assertNoLock(out);
    assert.equal(out.includes(marker), true, marker);
    assert.equal(out, html(f, base));
  }
});

test('L1 a missing login with a lock still shows the not-logged-in line and the copy button', () => {
  const f = fixture();
  const absent = clone(loggedIn);
  absent.auth.present = false;
  absent.auth.bytes = null;
  absent.auth.mtime = null;
  const out = html(f, locked(absent));
  assertNoLock(out);
  assert.equal(out.includes('Grok 尚未登入：找不到登入檔'), true);
  assert.match(out, /<button\b[^>]*class="cp"[^>]*data-copy="grok login"/);
  assert.equal(out.includes('Hub 使用 Grok CLI 1.0.70'), true);
  assert.equal(out, html(f, absent));
});

test('L1 chatHtml and drawAiTools for Grok never show the lock sentence', () => {
  const f = fixture();
  f.run('state.projects[0].tasks[0].owner="grok";state.grokStatus=' + JSON.stringify(locked(loggedIn)));
  const chat = f.run('chatHtml(proj("p"), taskOf(proj("p"), "t"))');
  assert.equal(chat.includes('id="grok-status"'), true);
  assert.equal(chat.includes('Hub 使用 Grok CLI 1.0.70（第一次送出時建立 Hub 私有副本）'), true);
  assertNoLock(chat);
  f.run('aiTools=' + JSON.stringify({ grok: { installed: true, version: 'synthetic', models: [] }, claude: { installed: true, version: 'synthetic', models: [] } }) + ';drawAiTools()');
  const grokRow = rowSlice(f.element('#ai-tools').innerHTML, 'grok');
  assert.equal(grokRow.includes('grok-status'), true);
  assertNoLock(grokRow);
});

test('L1 public/app.js no longer carries the lock sentence and grokStatusHtml does not read the lock fields', () => {
  const source = fs.readFileSync(APP, 'utf8');
  assert.equal(source.includes('登入檔鎖存在'), false);
  assert.equal(source.includes('表示上次程序未正常結束'), false);
  const start = source.indexOf('function grokStatusHtml(');
  assert.ok(start >= 0);
  const end = source.indexOf('\nfunction ', start + 1);
  const body = source.slice(start, end === -1 ? source.length : end);
  assert.equal(body.includes('lockPresent'), false);
  assert.equal(body.includes('lockMtime'), false);
});
