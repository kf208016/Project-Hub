'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitw = require('../lib/git');

const winOnly = process.platform === 'win32' ? test : test.skip;
winOnly('Windows AI worktree does not copy local credentials or work directly', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-git-'));
  const repo = path.join(dir, 'repo'), copies = path.join(dir, 'copies');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  git('add', 'README.md'); git('commit', '-q', '-m', 'initial');
  fs.writeFileSync(path.join(repo, '.env'), 'DUMMY_TEST_VALUE');
  const work = gitw.prepare({ base: repo, workRoot: copies, taskId: 'one', direct: false });
  t.after(() => {
    try { git('worktree', 'remove', '--force', work.worktree); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(work.worktree);
  assert.deepEqual(work.copied, []);
  assert.equal(fs.existsSync(path.join(work.worktree, '.env')), false);
  assert.throws(() => gitw.prepare({ base: repo, workRoot: copies, taskId: 'direct', direct: true }), /不允許/);
  git('config', 'hub.mode', 'direct');
  assert.throws(() => gitw.prepare({ base: repo, workRoot: copies, taskId: 'configured-direct', direct: false }), /不允許/);
});

winOnly('Windows refuses automatic Git initialization', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => gitw.prepare({ base: dir, workRoot: path.join(dir, 'copies'), taskId: 'one' }), /不會替非 Git/);
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
});
