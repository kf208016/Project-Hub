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
winOnly('Windows refuses traversal, junction and unrelated existing worktrees before writes', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-git-boundaries-')),repo=path.join(dir,'repo'),other=path.join(dir,'other'),copies=path.join(dir,'copies'),outside=path.join(dir,'outside');
  const cmd=(d,...args)=>execFileSync('git',['-C',d,...args],{stdio:'pipe'});
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50}));
  for(const d of [repo,other]){fs.mkdirSync(d);cmd(d,'init','-q');cmd(d,'-c','user.name=Test','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','initial');}
  fs.mkdirSync(copies);fs.mkdirSync(outside);
  const initial=cmd(repo,'rev-parse','HEAD').toString();
  for(const taskId of ['../escape','..\\escape','C:\\escape','file:stream'])assert.throws(()=>gitw.prepare({base:repo,workRoot:copies,taskId}));
  fs.symlinkSync(outside,path.join(copies,'linked'),'junction');
  assert.throws(()=>gitw.prepare({base:repo,workRoot:copies,taskId:'linked'}),/junction|symlink/);
  cmd(other,'worktree','add','-qb','foreign',path.join(copies,'foreign'));
  assert.throws(()=>gitw.prepare({base:repo,workRoot:copies,taskId:'foreign'}),/不屬於/);
  assert.equal(cmd(repo,'rev-parse','HEAD').toString(),initial);assert.deepEqual(fs.readdirSync(outside),[]);
});
winOnly('Windows Git cleanup refuses a nested junction and preserves source and linked target',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-git-cleanup-link-')),repo=path.join(dir,'repo'),copies=path.join(dir,'copies'),outside=path.join(dir,'outside');
  fs.mkdirSync(repo);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep.txt'),'synthetic');
  const cmd=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  cmd('init','-q');cmd('-c','user.name=Test','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','initial');
  const work=gitw.prepare({base:repo,workRoot:copies,taskId:'one'});
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50}));
  fs.mkdirSync(path.join(work.dir,'nested'));fs.symlinkSync(outside,path.join(work.dir,'nested','linked'),'junction');
  assert.throws(()=>gitw.cleanupCopy({dir:work.dir,workRoot:copies,target:repo}),/連結/);
  assert.equal(fs.existsSync(work.dir),true);assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'synthetic');
});
