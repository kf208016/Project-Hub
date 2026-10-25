'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { AiTools } = require('../lib/ai-tools');

const FIXTURE = '{"version":1,"catalog":{"config":{"models":[{"id":"claude-opus-5-5","name":"Opus 5.5","section":"main","thinking":{"type":"effort","effort_options":[{"id":"low"},{"id":"medium"},{"id":"high"},{"id":"xhigh"}]}},{"id":"claude-sonnet-5-5","name":"Sonnet 5.5","section":"main","thinking":{"type":"effort","effort_options":[{"id":"low"},{"id":"medium"},{"id":"high"}]}},{"id":"claude-old-1","name":"Old","section":"overflow"}]}}}';
const winOnly = process.platform === 'win32' ? test : test.skip;

function layout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-catalog-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

function writeFixture(home) {
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture.json'), FIXTURE);
}

function labels(models) {
  return models.map(row => row.label);
}

function openTools(root, home, refreshClaude) {
  return new AiTools({
    root,
    home,
    platform: 'win32',
    dry: true,
    nativeUpdater: { useActive() {} },
    refreshClaude,
  });
}

test('refreshClaudeCatalogFromCache reads the local fixture and does not call refreshClaude', async t => {
  const { root, home } = layout(t);
  writeFixture(home);
  let calls = 0;
  const tools = openTools(root, home, async () => {
    calls += 1;
    throw new Error('refreshClaude must not run');
  });
  const result = await tools.refreshClaudeCatalogFromCache();
  assert.equal(result.source, 'local-cache');
  assert.deepEqual(labels(result.models), ['Opus 5.5', 'Sonnet 5.5']);
  assert.deepEqual(labels(tools.catalog().claude.models), ['Opus 5.5', 'Sonnet 5.5']);
  assert.equal(calls, 0);
});

test('missing Claude cache throws and leaves the previous catalog unchanged', async t => {
  const { root, home } = layout(t);
  fs.mkdirSync(path.join(root, '_hub'), { recursive: true });
  fs.writeFileSync(path.join(root, '_hub', 'ai-tools-models.json'), JSON.stringify({
    v: 1,
    claude: {
      models: [{ id: 'claude-kept-1', label: 'Kept Before' }],
      known: [{ id: 'claude-kept-1', label: 'Kept Before' }],
      refreshedAt: '2020-01-01T00:00:00.000Z',
      source: 'saved',
    },
  }));
  let calls = 0;
  const tools = openTools(root, home, async () => {
    calls += 1;
    throw new Error('refreshClaude must not run');
  });
  const before = structuredClone(tools.catalog().claude);
  assert.deepEqual(labels(before.models), ['Kept Before']);
  await assert.rejects(
    async () => { await tools.refreshClaudeCatalogFromCache(); },
    error => error && error.status === 502 && error.stage === 'models',
  );
  assert.deepEqual(tools.catalog().claude, before);
  assert.equal(calls, 0);
});

async function claudeCodeModels(t, prepare) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-catalog-http-'));
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
  let body = null;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try {
      const response = await fetch(base + '/api/state');
      if (response.status === 200) {
        body = await response.json();
        break;
      }
    } catch { /* wait for local startup */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(body, stderr);
  return body.roles.models['claude-code'];
}

winOnly('dry-run state lists the cache labels with CLI default first and without plain Sonnet', async t => {
  const models = await claudeCodeModels(t, writeFixture);
  assert.equal(models[0], 'CLI預設');
  assert.equal(models.includes('Opus 5.5'), true);
  assert.equal(models.includes('Sonnet 5.5'), true);
  assert.equal(models.includes('Sonnet'), false);
});

winOnly('dry-run state with an empty AI home offers only CLI default and Sonnet', async t => {
  const models = await claudeCodeModels(t, () => {});
  assert.deepEqual(models, ['CLI預設', 'Sonnet']);
});
