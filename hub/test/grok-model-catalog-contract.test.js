'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { AiTools } = require('../lib/ai-tools');

const FIXTURE = '{"fetched_at":"2026-10-23T00:00:00Z","auth_method":"oidc","identity":"SECRET_IDENTITY_SENTINEL","etag":"x","models":{"grok-4.7":{"info":{"id":"grok-4.7","name":"Grok 4.7","hidden":false,"supports_reasoning_effort":true,"reasoning_efforts":[{"id":"low","value":"low"},{"id":"high","value":"high"},{"id":"xhigh","value":"xhigh"}]},"api_key":"SECRET_KEY_SENTINEL","env_key":"SECRET_ENV_SENTINEL","api_base_url":"https://secret.example/"},"grok-4.5":{"info":{"id":"grok-4.5","name":"Grok 4.5","hidden":false,"supports_reasoning_effort":true,"reasoning_efforts":[{"id":"low","value":"low"},{"id":"high","value":"high"}]},"api_key":"SECRET_KEY_SENTINEL"},"grok-hidden":{"info":{"id":"grok-hidden","name":"Hidden","hidden":true}}}}';
const SENTINELS = ['SECRET_KEY_SENTINEL', 'SECRET_ENV_SENTINEL', 'SECRET_IDENTITY_SENTINEL', 'secret.example'];
const winOnly = process.platform === 'win32' ? test : test.skip;

function layout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-grok-catalog-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

function writeFixture(home) {
  const dir = path.join(home, '.grok');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models_cache.json'), FIXTURE);
}

function labels(models) {
  return models.map(row => row.label);
}

function openTools(root, home) {
  return new AiTools({
    root,
    home,
    platform: 'win32',
    dry: true,
    nativeUpdater: { useActive() {} },
    find() { throw new Error('no CLI lookup'); },
    run() { throw new Error('no CLI process'); },
  });
}

function leaked(value) {
  const text = JSON.stringify(value);
  return SENTINELS.filter(secret => text.includes(secret));
}

test('refreshGrokCatalogFromCache reads the local fixture, drops hidden models, and leaks no secrets', async t => {
  const { root, home } = layout(t);
  writeFixture(home);
  const tools = openTools(root, home);
  const result = await tools.refreshGrokCatalogFromCache();
  assert.equal(result.source, 'local-cache');
  assert.deepEqual(labels(result.models), ['Grok 4.7', 'Grok 4.5']);
  assert.deepEqual(leaked(result), []);
  assert.deepEqual(leaked(tools.catalog().grok), []);
});

test('missing Grok cache throws and leaves the previous catalog unchanged', async t => {
  const { root, home } = layout(t);
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.writeFileSync(path.join(root, '_hub', 'ai-tools-models.json'), JSON.stringify({
    v: 1,
    grok: {
      models: [{ id: 'grok-kept-1', label: 'Kept Before' }],
      known: [{ id: 'grok-kept-1', label: 'Kept Before' }],
      refreshedAt: '2020-01-01T00:00:00.000Z',
      source: 'saved',
    },
  }));
  const tools = openTools(root, home);
  const before = structuredClone(tools.catalog().grok);
  assert.deepEqual(labels(before.models), ['Kept Before']);
  await assert.rejects(
    async () => { await tools.refreshGrokCatalogFromCache(); },
    error => error && error.status === 502 && error.stage === 'models',
  );
  assert.deepEqual(tools.catalog().grok, before);
});

async function dryRun(t, prepare) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-grok-catalog-http-'));
  const home = path.join(root, 'ai-home');
  fs.mkdirSync(home, { recursive: true });
  prepare(home);
  const secret = 'C'.repeat(43);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HUB_ROOT: root,
      HUB_AI_HOME: home,
      HUB_PORT: String(port),
      HUB_DRY_RUN: '1',
      HUB_LOCAL_TOKEN: secret,
      HUB_RECOVERY_ONLY: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let stateText = '';
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try {
      const response = await fetch(base + '/api/state');
      if (response.status === 200) {
        stateText = await response.text();
        break;
      }
    } catch { /* wait for local startup */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(stateText, stderr);
  const toolsResponse = await fetch(base + '/api/ai-tools');
  const toolsText = await toolsResponse.text();
  assert.equal(toolsResponse.status, 200, toolsText);
  return { stateText, toolsText, models: JSON.parse(stateText).roles.models.grok };
}

winOnly('dry-run state lists cache labels with CLI default first, without Grok 4.6, and neither state nor ai-tools leaks sentinels', async t => {
  const { stateText, toolsText, models } = await dryRun(t, writeFixture);
  assert.ok(Array.isArray(models));
  assert.equal(models[0], 'CLI預設');
  assert.equal(models.includes('Grok 4.7'), true);
  assert.equal(models.includes('Grok 4.5'), true);
  assert.equal(models.includes('Grok 4.6'), false);
  for (const secret of SENTINELS) {
    assert.equal(stateText.includes(secret), false, secret);
    assert.equal(toolsText.includes(secret), false, secret);
  }
});

winOnly('dry-run state with an empty AI home offers only CLI default and Grok 4.6', async t => {
  const { models } = await dryRun(t, () => {});
  assert.deepEqual(models, ['CLI預設', 'Grok 4.6']);
});
