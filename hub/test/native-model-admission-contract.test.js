'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launch = require('../lib/launch');
const {AiTools} = require('../lib/ai-tools');

function workspace(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-admission-'));
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const root = path.join(tmp, 'root');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.codex'), {recursive: true});
  fs.mkdirSync(root, {recursive: true});
  return {tmp, root, home};
}

function createTools(root, home, refreshCodex = async () => [{id: 'live-model', label: 'Live Model'}]) {
  return new AiTools({
    root,
    home,
    platform: 'win32',
    dry: false,
    refreshCodex,
    nativeUpdater: {useActive() {}, active() { return null; }},
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('launch.CLI_DEFAULT_LABEL is the traditional-Chinese CLI default label', () => {
  assert.equal(launch.CLI_DEFAULT_LABEL, 'CLI預設');
});

test('flagFor passes no model and modelLabel keeps CLI預設 for codex, claude and grok', () => {
  for (const ai of ['codex', 'claude', 'grok']) {
    assert.equal(launch.flagFor(ai, 'CLI預設'), '');
    assert.equal(launch.modelLabel(ai, 'CLI預設'), 'CLI預設');
  }
});

test('win32 AiTools does not admit cache-only-model from the shared Codex cache', t => {
  const {root, home} = workspace(t);
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({
    models: [{slug: 'cache-only-model', display_name: 'Cache Only', visibility: 'list'}],
  }));
  const tools = createTools(root, home, async () => { throw new Error('refreshCodex must not run during construction'); });
  assert.equal(tools.catalog().codex.models.some(row => row.id === 'cache-only-model'), false);
});

test('refreshCodexCatalog stores the live models and persists source plus binary sha256', async t => {
  const {tmp, root, home} = workspace(t);
  const file = path.join(tmp, 'codex-fixture.bin');
  fs.writeFileSync(file, 'codex-fixture');
  let seen = null;
  const tools = createTools(root, home, async got => { seen = got; return [{id: 'live-model', label: 'Live Model'}]; });
  assert.equal(typeof tools.refreshCodexCatalog, 'function');
  const returned = await tools.refreshCodexCatalog({file});
  assert.equal(seen, file);
  assert.ok(Array.isArray(returned) && returned.some(row => row.id === 'live-model'));
  const catalog = tools.catalog().codex;
  assert.ok(catalog.models.some(row => row.id === 'live-model'));
  assert.equal(catalog.source, 'codex-app-server');
  assert.equal(catalog.binarySha256, sha256(file));
  assert.equal(typeof catalog.refreshedAt, 'string');
  assert.ok(catalog.refreshedAt);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '_hub', 'ai-tools-models.json'), 'utf8'));
  assert.equal(saved.codex.source, 'codex-app-server');
  assert.equal(saved.codex.binarySha256, sha256(file));
  assert.ok(saved.codex.models.some(row => row.id === 'live-model'));
});

test('concurrent refreshCodexCatalog calls share one in-flight refresh', async t => {
  const {tmp, root, home} = workspace(t);
  const file = path.join(tmp, 'codex-fixture.bin');
  fs.writeFileSync(file, 'codex-fixture');
  let calls = 0;
  const tools = createTools(root, home, fileArg => {
    assert.equal(fileArg, file);
    calls += 1;
    return new Promise(resolve => setTimeout(() => resolve([{id: 'live-model', label: 'Live Model'}]), 50));
  });
  assert.equal(typeof tools.refreshCodexCatalog, 'function');
  const [a, b] = await Promise.all([tools.refreshCodexCatalog({file}), tools.refreshCodexCatalog({file})]);
  assert.equal(calls, 1);
  assert.ok(a.some(row => row.id === 'live-model'));
  assert.ok(b.some(row => row.id === 'live-model'));
});

test('codexAvailability is unknown before refresh, then available or unavailable', async t => {
  const {tmp, root, home} = workspace(t);
  const file = path.join(tmp, 'codex-fixture.bin');
  fs.writeFileSync(file, 'codex-fixture');
  const tools = createTools(root, home, async () => [{id: 'live-model', label: 'Live Model'}]);
  assert.equal(typeof tools.codexAvailability, 'function');
  assert.equal(tools.codexAvailability('live-model'), 'unknown');
  assert.equal(tools.codexAvailability('not-a-real-model'), 'unknown');
  assert.equal(typeof tools.refreshCodexCatalog, 'function');
  await tools.refreshCodexCatalog({file});
  assert.equal(tools.codexAvailability('live-model'), 'available');
  assert.equal(tools.codexAvailability('CLI預設'), 'available');
  assert.equal(tools.codexAvailability('GPT-6.1-Sol'), 'unavailable');
  assert.equal(tools.codexAvailability('not-a-real-model'), 'unavailable');
});

test('a persisted catalog whose binarySha256 differs from the current binary is unknown', t => {
  const {tmp, root, home} = workspace(t);
  const file = path.join(tmp, 'codex-fixture.bin');
  fs.writeFileSync(file, 'current-binary');
  const current = sha256(file);
  const stored = crypto.createHash('sha256').update('other-binary').digest('hex');
  assert.notEqual(stored, current);
  fs.mkdirSync(path.join(root, '_hub'), {recursive: true});
  fs.writeFileSync(path.join(root, '_hub', 'ai-tools-models.json'), JSON.stringify({
    v: 1,
    codex: {
      models: [{id: 'persisted-model', label: 'Persisted'}],
      known: [{id: 'persisted-model', label: 'Persisted'}],
      refreshedAt: '2020-01-01T00:00:00.000Z',
      source: 'codex-app-server',
      binarySha256: stored,
    },
  }));
  const tools = createTools(root, home, async () => { throw new Error('reconstruction must not refresh'); });
  assert.equal(typeof tools.codexAvailability, 'function');
  assert.equal(tools.codexAvailability('persisted-model'), 'unknown');
});
