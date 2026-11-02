'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const HASH_170 = '1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326';
const HASH_134 = '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94';
const win = process.platform === 'win32' ? test : test.skip;
// File-level isolation: the runner environment must not pick the version under test.
const savedOverride = process.env.PROJECT_HUB_GROK_VERSION;
test.before(() => { delete process.env.PROJECT_HUB_GROK_VERSION; });
test.after(() => { if (savedOverride === undefined) delete process.env.PROJECT_HUB_GROK_VERSION; else process.env.PROJECT_HUB_GROK_VERSION = savedOverride; });

function statusApi() { return require('../lib/grok-status'); }
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-status-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function absentRuntime(result) {
  assert.equal(result.auth.present, false);
  assert.equal(result.auth.bytes, null);
  assert.equal(result.auth.mtime, null);
  assert.equal(result.auth.lockPresent, false);
  assert.equal(result.auth.lockMtime, null);
  assert.equal(result.runtime.version, '1.0.70');
  assert.equal(result.runtime.hashPrefix, HASH_170.slice(0, 12));
  assert.equal(result.runtime.slotPresent, false);
  assert.equal(result.runtime.override, null);
  assert.equal(result.runtime.overrideInvalid, false);
}

test('status without .grok is the absent login shape on the preferred runtime', t => {
  const saved = process.env.PROJECT_HUB_GROK_VERSION;
  delete process.env.PROJECT_HUB_GROK_VERSION;
  t.after(() => { if (saved === undefined) delete process.env.PROJECT_HUB_GROK_VERSION; else process.env.PROJECT_HUB_GROK_VERSION = saved; });
  absentRuntime(statusApi().status(tempHome(t), {}));
});

test('status reports auth.json and lock metadata without reading bytes', t => {
  const home = tempHome(t);
  const dir = path.join(home, '.grok');
  fs.mkdirSync(dir);
  const auth = path.join(dir, 'auth.json');
  const lock = path.join(dir, 'auth.json.lock');
  fs.writeFileSync(auth, Buffer.alloc(1752, 0x61));
  fs.writeFileSync(lock, Buffer.alloc(16, 0x62));
  // Integral-second mtimes make the ISO expectation independent of how the implementation derives it (mtime vs mtimeMs).
  fs.utimesSync(auth, 1700000000, 1700000000);
  fs.utimesSync(lock, 1700000100, 1700000100);
  const result = statusApi().status(home, {});
  assert.equal(result.auth.present, true);
  assert.equal(result.auth.bytes, 1752);
  assert.equal(result.auth.mtime, new Date(1700000000000).toISOString());
  assert.equal(result.auth.lockPresent, true);
  assert.equal(result.auth.lockMtime, new Date(1700000100000).toISOString());
});

test('slotPresent is true only when the preferred private grok.exe exists', t => {
  const home = tempHome(t);
  const slot = path.join(home, 'AppData', 'Local', 'ProjectHub', 'runtime-binaries', 'grok', HASH_170, 'grok.exe');
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  fs.writeFileSync(slot, Buffer.from('synthetic slot'));
  assert.equal(statusApi().status(home, {}).runtime.slotPresent, true);
});

test('a reviewed override selects 1.0.34 and an unknown override stays invalid', t => {
  const home = tempHome(t);
  const reviewed = statusApi().status(home, { version: '1.0.34' });
  assert.equal(reviewed.runtime.version, '1.0.34');
  assert.equal(reviewed.runtime.hashPrefix, HASH_134.slice(0, 12));
  assert.equal(reviewed.runtime.override, '1.0.34');
  assert.equal(reviewed.runtime.overrideInvalid, false);
  const invalid = statusApi().status(home, { version: '9.9.9' });
  assert.equal(invalid.runtime.overrideInvalid, true);
  assert.equal(invalid.runtime.version, '1.0.70');
  assert.equal(invalid.runtime.override, '9.9.9');
});

test('mocked content reads still return the same metadata and the JSON has no path', t => {
  const home = tempHome(t);
  const dir = path.join(home, '.grok');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'auth.json'), Buffer.alloc(1752, 0x61));
  const before = statusApi().status(home, {});
  t.mock.method(fs, 'readFileSync', () => { throw Error('content read forbidden'); });
  t.mock.method(fs, 'openSync', () => { throw Error('open forbidden'); });
  const after = statusApi().status(home, {});
  assert.deepEqual(after, before);
  const body = JSON.stringify(after);
  assert.equal(body.includes(home), false);
  assert.equal(body.includes(JSON.stringify(home).slice(1, -1)), false);
  assert.equal(body.includes(path.basename(home)), false);
  assert.equal(body.includes('auth.json'), false);
  assert.equal(Object.isFrozen(after), true);
  assert.equal(Object.isFrozen(after.auth), true);
  assert.equal(Object.isFrozen(after.runtime), true);
});

test('status(42) returns the absent shape and does not throw', () => {
  const result = statusApi().status(42);
  absentRuntime(result);
});

test('assertKnown names two unassigned Grok processes and status lists them', async () => {
  const pw = require('../lib/procwatch');
  const secret = 'SYNTHETIC_CMD_SECRET_R14';
  const line = pid => ` ${pid} 1 Sun Oct 4 11:22:33 2026 "C:\\Synthetic\\grok.exe" run ${secret}`;
  const w = pw.create({
    platform: 'linux', selfPid: 900, log: () => {}, projects: () => [], readlink: () => '/work',
    exec: async () => [line(45740), line(1234)].join('\n')
  });
  await w.scan();
  assert.throws(() => w.assertKnown(), error => {
    assert.equal(error.code, 'PROCWATCH_UNASSIGNED_AI');
    assert.equal(error.message.includes('grok（PID 45740）'), true);
    assert.equal(error.message.includes('、'), true);
    assert.equal(error.message.includes('Hub 不會結束不是由它啟動的程序'), true);
    assert.equal(error.message.includes('（代碼：PROCWATCH_UNASSIGNED_AI）'), true);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.deepEqual(w.status().unassignedProcesses, [{ pid: 45740, ai: 'grok' }, { pid: 1234, ai: 'grok' }]);
});

test('seven unassigned rows are capped at five and the message says two more', async () => {
  const pw = require('../lib/procwatch');
  const secret = 'SYNTHETIC_CMD_SECRET_R14';
  const pids = [45740, 1234, 11, 12, 13, 14, 15];
  const text = pids.map(pid => ` ${pid} 1 Sun Oct 4 11:22:33 2026 "C:\\Synthetic\\grok.exe" run ${secret}`).join('\n');
  const w = pw.create({ platform: 'linux', selfPid: 900, log: () => {}, projects: () => [], readlink: () => '/work', exec: async () => text });
  await w.scan();
  assert.throws(() => w.assertKnown(), error => error.code === 'PROCWATCH_UNASSIGNED_AI' && error.message.includes('…另 2 件') && !error.message.includes(secret));
  assert.equal(w.status().unassignedProcesses.length, 5);
  assert.deepEqual(w.status().unassignedProcesses, pids.slice(0, 5).map(pid => ({ pid, ai: 'grok' })));
});

test('PROCWATCH_STALE keeps today\'s text', async t => {
  const pw = require('../lib/procwatch');
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const w = pw.create({ platform: 'linux', selfPid: 900, log: () => {}, projects: () => [], exec: async () => '1 0 Sun Oct 4 11:22:33 2026 /sbin/init' });
  await w.scan();
  now = Date.parse(w.status().checkedAt) + 20001;
  assert.throws(() => w.assertKnown(), error => error.code === 'PROCWATCH_STALE' && error.message === '背景程序狀態未知或有未歸屬 AI；請先確認作業已停止（代碼：PROCWATCH_STALE）');
});

const registry = require('../lib/provider-registry');
const locale = require('../public/i18n');
for (const name of ['main', 'main-extra', 'aux', 'empty']) locale.add(JSON.parse(fs.readFileSync(path.join(__dirname, '../public/locales/zh-TW-' + name + '.json'), 'utf8')));
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
  run(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'));
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
const loggedIn = {
  auth: { present: true, bytes: 1752, mtime: '2026-10-25T02:00:00.000Z', lockPresent: false, lockMtime: null },
  runtime: { version: '1.0.70', hashPrefix: '1e03c16cf2bd', slotPresent: false, override: null, overrideInvalid: false }
};

test('grokStatusHtml(null) is empty', () => {
  assert.equal(fixture().run('grokStatusHtml(null)'), '');
});

test('grokStatusHtml shows the login time and the preferred private-copy line', () => {
  const html = fixture().run('grokStatusHtml(' + JSON.stringify(loggedIn) + ')');
  assert.equal(html.includes('Grok 登入檔最後更新：'), true);
  assert.equal(html.includes('Hub 使用 Grok CLI 1.0.70（第一次送出時建立 Hub 私有副本）'), true);
  assert.match(html, /<div class="grok-status small">/);
  assert.equal(html.includes('（Hub 不讀取內容，無法判斷是否仍有效）'), true);
});

test('grokStatusHtml switches slot, override, invalid, absent and lock lines', () => {
  const f = fixture();
  const slot = JSON.parse(JSON.stringify(loggedIn));
  slot.runtime.slotPresent = true;
  assert.equal(f.run('grokStatusHtml(' + JSON.stringify(slot) + ')').includes('Hub 私有副本已建立'), true);
  const override = JSON.parse(JSON.stringify(loggedIn));
  override.runtime.version = '1.0.34';
  override.runtime.override = '1.0.34';
  assert.equal(f.run('grokStatusHtml(' + JSON.stringify(override) + ')').includes('；由 PROJECT_HUB_GROK_VERSION 指定'), true);
  const invalid = JSON.parse(JSON.stringify(loggedIn));
  invalid.runtime.overrideInvalid = true;
  assert.equal(f.run('grokStatusHtml(' + JSON.stringify(invalid) + ')').includes('PROJECT_HUB_GROK_VERSION 的值不在已審核清單'), true);
  const absent = JSON.parse(JSON.stringify(loggedIn));
  absent.auth.present = false;
  const absentHtml = f.run('grokStatusHtml(' + JSON.stringify(absent) + ')');
  assert.equal(absentHtml.includes('Grok 尚未登入：找不到登入檔'), true);
  assert.match(absentHtml, /<button\b[^>]*class="cp"[^>]*data-copy="grok login"/);
  const locked = JSON.parse(JSON.stringify(loggedIn));
  locked.auth.lockPresent = true;
  locked.auth.lockMtime = '2026-10-25T02:05:00.000Z';
  assert.doesNotMatch(f.run('grokStatusHtml(' + JSON.stringify(locked) + ')'), /登入檔鎖存在|未正常結束/);
});

test('grokLoginHintHtml offers both copyable commands and compares mtimes', () => {
  const f = fixture();
  const fresh = f.run('grokLoginHintHtml(' + JSON.stringify({ ai: 'grok', error: 'x（代碼：GROK_NATIVE_AUTH_UNAVAILABLE）', at: '2026-10-25T01:00:00.000Z' }) + ',' + JSON.stringify({ auth: { mtime: '2026-10-25T02:00:00.000Z' } }) + ')');
  assert.match(fresh, /^<div class="grok-login-hint small">在一般終端機執行 <code>grok login<\/code>/);
  assert.equal(fresh.includes('<code>grok login --device-auth</code>'), true);
  assert.equal(fresh.includes('data-copy="grok login"'), true);
  assert.equal(fresh.includes('data-copy="grok login --device-auth"'), true);
  assert.equal(fresh.includes('登入檔已在這則訊息之後更新，可以重新送出。'), true);
  const older = f.run('grokLoginHintHtml(' + JSON.stringify({ ai: 'grok', error: 'x（代碼：GROK_NATIVE_AUTH_UNAVAILABLE）', at: '2026-10-25T01:00:00.000Z' }) + ',' + JSON.stringify({ auth: { mtime: '2026-10-25T00:30:00.000Z' } }) + ')');
  assert.equal(older.includes('登入完成後回到 Hub 重新送出。'), true);
  const idle = f.run('grokLoginHintHtml(' + JSON.stringify({ ai: 'grok', error: 'x（代碼：GROK_NATIVE_IDLE_TIMEOUT）', at: '2026-10-25T01:00:00.000Z' }) + ',null)');
  assert.equal(idle.includes('data-copy="grok login"'), true);
  assert.equal(f.run('grokLoginHintHtml(' + JSON.stringify({ ai: 'claude', error: 'x（代碼：GROK_NATIVE_AUTH_UNAVAILABLE）' }) + ',null)'), '');
  assert.equal(f.run('grokLoginHintHtml(' + JSON.stringify({ ai: 'grok', error: 'x（代碼：GROK_NATIVE_RATE_LIMITED）' }) + ',null)'), '');
});

test('drawAiTools puts grok-status on the Grok row only', () => {
  const f = fixture();
  f.run('state.grokStatus=' + JSON.stringify(loggedIn) + ';aiTools=' + JSON.stringify({ grok: { installed: true, version: 'synthetic', models: [] }, claude: { installed: true, version: 'synthetic', models: [] } }) + ';drawAiTools()');
  const html = f.element('#ai-tools').innerHTML;
  assert.match(rowSlice(html, 'grok'), /<div class="ai-tool-head">[\s\S]*?<\/div>\s*<div class="grok-status small">/);
  assert.equal(rowSlice(html, 'claude').includes('grok-status'), false);
});

test('chatHtml reserves grok-status and fills it for a Grok owner', () => {
  const f = fixture();
  const empty = f.run('chatHtml(proj("p"), taskOf(proj("p"), "t"))');
  assert.equal(empty.includes('id="grok-status"'), true);
  f.run('state.projects[0].tasks[0].owner="grok";state.grokStatus=' + JSON.stringify(loggedIn));
  const filled = f.run('chatHtml(proj("p"), taskOf(proj("p"), "t"))');
  assert.equal(filled.includes('id="grok-status"'), true);
  assert.equal(filled.includes('Hub 使用 Grok CLI 1.0.70（第一次送出時建立 Hub 私有副本）'), true);
});

test('the Windows notice names an unassigned Grok pid', () => {
  const f = fixture();
  f.run('state.backgroundStatus=' + JSON.stringify({ state: 'ok', unassigned: 1, unassignedProcesses: [{ pid: 45740, ai: 'grok' }] }) + ';render()');
  assert.equal(f.element('#windows-notice').textContent.includes('grok PID 45740'), true);
});

win('GET /api/state exposes grokStatus metadata and neither the auth secret nor the temp home', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r14-http-'));
  const home = path.join(root, 'home');
  const secret = 'SYNTHETIC_R14_AUTH_SECRET_9f3c';
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.writeFileSync(path.join(root, '_hub', 'roles.yaml'), 'models:\n  grok: [Grok 4.6]\nroles: {}\n');
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), JSON.stringify({ token: secret, refresh_token: secret }));
  const listener = require('node:net').createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env };
  Object.assign(process.env, { HUB_ROOT: root, HUB_AI_HOME: home, HUB_DRY_RUN: '1', HUB_PORT: String(port) });
  const owned = require('./helpers/owned-native-fixture');
  const restore = owned.freshInventory();
  process.env.PATH = owned.environment(owned.provider(root).bin);
  t.mock.method(require('../lib/web-chat-admission'), 'check', () => ({ ok: true }));
  const { server } = require('../server');
  await new Promise(resolve => server.listen(Number(process.env.HUB_PORT), '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    restore();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/state');
  const data = await response.json();
  assert.equal(response.status, 200);
  const body = JSON.stringify(data);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes(home), false);
  assert.equal(body.includes(JSON.stringify(home).slice(1, -1)), false);
  assert.equal(data.grokStatus.auth.present, true);
  assert.equal(data.grokStatus.runtime.version, '1.0.70');
});
