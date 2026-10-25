'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const childProcess = require('node:child_process');

const realExec = childProcess.execFileSync;
const gitArgv = [];
childProcess.execFileSync = function(file, args, options) {
  if (Array.isArray(args)) gitArgv.push(args);
  return realExec.apply(this, arguments);
};
const git = require('../lib/git');
const policy = require('../lib/git-policy');
const {codeOf} = require('../lib/native-provider-diagnostic');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
function sh(dir, args) {
  realExec('git', args, {cwd: dir, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe']});
}
function toplevels() {
  return gitArgv.filter(args => args.includes('rev-parse') && args.includes('--show-toplevel') && !args.includes('--git-dir')).length;
}

test('taskOf maps Hub chat filenames to a known id and rejects the others', () => {
  const {taskOf} = require('../lib/chat-files');
  const id = 'task-a1';
  const ids = new Set([id]);
  const uuid = randomUUID();
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(taskOf(`${id}.jsonl`, ids), id);
  assert.equal(taskOf(`${id}.queue.json`, ids), id);
  assert.equal(taskOf(`${id}.json`, ids), id);
  assert.equal(taskOf(`${id}.json.${uuid}.tmp`, ids), id);
  assert.equal(taskOf(`${id}.queue.json.limit-${process.pid}.tmp`, ids), id);
  assert.equal(taskOf(`${id}.rules.md`, ids), null);
  assert.equal(taskOf('other-task.jsonl', ids), null);
  assert.equal(taskOf(`nested/${id}.jsonl`, ids), null);
  assert.equal(taskOf('CON.jsonl', new Set(['CON'])), null);
});

test('taskOf returns null for a case variant of the id on win32', {skip: process.platform !== 'win32'}, () => {
  const {taskOf} = require('../lib/chat-files');
  assert.equal(taskOf('taska.jsonl', new Set(['TaskA'])), null);
  assert.equal(taskOf('TaskA.jsonl', new Set(['TaskA'])), 'TaskA');
});

test('repoTopChain matches repoTop, dedupes one chain, and does not cache null', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-warm-chain-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  const later = path.join(root, 'later');
  fs.mkdirSync(repo);
  fs.mkdirSync(later);
  sh(repo, ['init', '-q']);
  const direct = git.repoTop(repo);
  assert.equal(typeof direct, 'string');
  assert.equal(git.repoTop(later), null);
  sh(later, ['init', '-q']);
  assert.equal(typeof git.repoTop(later), 'string');
  assert.equal(typeof git.repoTopChain, 'function');

  const chain = git.repoTopChain();
  const first = chain(repo);
  assert.equal(first, direct);
  const afterFirst = toplevels();
  assert.equal(chain(repo), first);
  assert.equal(toplevels(), afterFirst);

  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(emptyDir);
  const fresh = git.repoTopChain();
  assert.equal(fresh(emptyDir), null);
  const beforeInit = toplevels();
  sh(emptyDir, ['init', '-q']);
  const found = fresh(emptyDir);
  assert.ok(toplevels() > beforeInit);
  assert.equal(found, git.repoTop(emptyDir));
  assert.equal(typeof found, 'string');

  const again = git.repoTopChain();
  const beforeNew = toplevels();
  assert.equal(again(repo), direct);
  assert.equal(toplevels(), beforeNew + 1);
});

test('policy.execution(dir) deepEquals policy.execution(dir, {index})', {skip: process.platform !== 'win32'}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-warm-exec-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  sh(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  sh(root, ['add', '-A']);
  sh(root, ['commit', '-q', '-m', 'init']);
  assert.deepEqual(policy.execution(root), policy.execution(root, {index: policy.indexSnapshot(root)}));
});

test('codeOf admits WORKSPACE_CLEANUP_REQUIRED and WORKSPACE_REENTRY_BUSY', () => {
  assert.equal(codeOf({code: 'WORKSPACE_CLEANUP_REQUIRED'}), 'WORKSPACE_CLEANUP_REQUIRED');
  assert.equal(codeOf({code: 'WORKSPACE_REENTRY_BUSY'}), 'WORKSPACE_REENTRY_BUSY');
  assert.equal(codeOf({code: 'WORKSPACE_CLEANUP_REQUIRED_PRIVATE'}), null);
  assert.equal(codeOf({code: 'WORKSPACE_REENTRY_BUSY\nprivate'}), null);
  assert.equal(codeOf(Object.create({code: 'WORKSPACE_REENTRY_BUSY'})), null);
});

test('workspace lifecycle state enum contains idle', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../windows/workspace-lifecycle.schema.json'), 'utf8'));
  const branch = schema.oneOf.find(item => item.type === 'object');
  assert.ok(branch.properties.state.enum.includes('idle'));
});
