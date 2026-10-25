'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitw = require('../lib/git');

const winOnly = process.platform === 'win32' ? test : test.skip;
winOnly('Windows read summary reports malformed ancestor as unknown while mutations still reject',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-git-read-unknown-')),data=path.join(root,'project');fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(data);t.after(()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});});const summary=gitw.readSummary(data,{fresh:true});assert.equal(summary.state,'unknown');assert.equal(summary.hasOrigin,null);assert.equal(summary.remote,null);assert.match(summary.error,/Git 中繼資料/);assert.throws(()=>gitw.prepare({base:data,workRoot:path.join(root,'Work/P'),taskId:'one'}));assert.equal(fs.existsSync(path.join(data,'.git')),false);});
winOnly('Windows same task ID across work roots creates a fresh branch and never reuses an old secret-bearing ref',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-git-branch-scope-')),repo=path.join(root,'repo');fs.mkdirSync(repo);t.after(()=>{assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});const cmd=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',encoding:'utf8'}).trim();cmd('init','-q');cmd('config','user.name','Synthetic');cmd('config','user.email','synthetic@example.test');fs.writeFileSync(path.join(repo,'file.txt'),'same baseline');cmd('add','.');cmd('commit','-qm','initial');const first=gitw.prepare({base:repo,workRoot:path.join(root,'Work/P'),taskId:'same'}),other=gitw.prepare({base:repo,workRoot:path.join(root,'Work/Alias'),taskId:'same'});assert.notEqual(first.branch,other.branch);assert.equal(cmd('rev-parse','HEAD'),execFileSync('git',['-C',other.dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim());fs.writeFileSync(path.join(repo,'.env'),'SYNTHETIC_OLD_REF');cmd('add','.env');cmd('commit','-qm','old secret-bearing ref');cmd('branch','hub/old');cmd('rm','.env');cmd('commit','-qm','remove known secret from current HEAD');const fresh=gitw.prepare({base:repo,workRoot:path.join(root,'Work/P'),taskId:'old'});assert.notEqual(fresh.branch,'hub/old');assert.equal(fs.existsSync(path.join(fresh.dir,'.env')),false);});
winOnly('Windows AI worktree does not copy local credentials or work directly', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-win-git-'));
  const repo = path.join(dir, 'repo'), copies = path.join(dir, 'copies');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
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
  for(const d of [repo,other]){fs.mkdirSync(d);cmd(d,'init','-q');cmd(d,'-c','user.name=Test','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','initial');}
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
  cmd('init','-q');cmd('-c','user.name=Test','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','initial');
  const work=gitw.prepare({base:repo,workRoot:copies,taskId:'one'});
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50}));
  fs.mkdirSync(path.join(work.dir,'nested'));fs.symlinkSync(outside,path.join(work.dir,'nested','linked'),'junction');
  assert.throws(()=>gitw.cleanupCopy({dir:work.dir,workRoot:copies,target:repo}),/連結/);
  assert.equal(fs.existsSync(work.dir),true);assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'synthetic');
});
