'use strict';
// lib/git.js：作業用コピーを作る・本体に取り込む・Git の無いフォルダで保存を始める
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const g = require('../lib/git');
const WINDOWS = process.platform === 'win32';
if (WINDOWS) Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-git-'));
process.env.HUB_TRASH = path.join(tmp, 'Trash');
const sh = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const W = path.join(tmp, 'Work', 'P');

function repo(name) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  sh(d, 'init', '-q');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', 'init');
  return d;
}

test('Git のある本体：作業ごとに作業用コピーができ、取り込むと片付く', () => {
  const main = repo('code');
  const r = g.prepare({ base: main, workRoot: W, taskId: '20260926-記事' });
  assert.strictEqual(r.dir, path.join(W, '20260926-記事'));
  assert.ok(r.created);
  // 同じ作業でもう一度始めても、同じ場所を使う
  assert.strictEqual(g.prepare({ base: main, workRoot: W, taskId: '20260926-記事' }).dir, r.dir);
  fs.writeFileSync(path.join(r.dir, 'b.txt'), 'new\n');
  assert.strictEqual(g.countCopies(W), 1);
  const m = g.merge({ dir: r.dir, workRoot: W, title: '記事' });
  assert.ok(m.ok, m.error);
  assert.strictEqual(fs.readFileSync(path.join(main, 'b.txt'), 'utf8'), 'new\n');
  assert.ok(!fs.existsSync(r.dir));
  assert.ok(fs.existsSync(m.trashed)); // 消さずにゴミ箱へ
  assert.strictEqual(g.countCopies(W), 0);
  assert.strictEqual(sh(main, 'branch', '--list', 'hub/*'), '');
});

test('ぶつかった時は取り込まず、本体も作業用コピーもそのまま', () => {
  const main = repo('code2');
  const w2 = path.join(tmp, 'Work', 'Q');
  const a = g.prepare({ base: main, workRoot: w2, taskId: 't1' });
  const b = g.prepare({ base: main, workRoot: w2, taskId: 't2' });
  fs.writeFileSync(path.join(a.dir, 'a.txt'), 'A\n');
  fs.writeFileSync(path.join(b.dir, 'a.txt'), 'B\n');
  assert.ok(g.merge({ dir: a.dir, workRoot: w2, title: 't1' }).ok);
  const m = g.merge({ dir: b.dir, workRoot: w2, title: 't2' });
  assert.ok(m.conflict);
  assert.strictEqual(fs.readFileSync(path.join(main, 'a.txt'), 'utf8'), 'A\n');
  assert.strictEqual(sh(main, 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(b.dir));
});

test('Git の無いフォルダ：保存を始めて本体で作業し、次からは始める前に保存する', () => {
  const d = path.join(tmp, 'docs');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'memo.md'), 'x\n');
  if (WINDOWS) {
    assert.throws(() => g.prepare({ base: d, workRoot: path.join(tmp, 'Work', 'D'), taskId: 't' }), /不會替非 Git/);
    assert.ok(!fs.existsSync(path.join(d, '.git')));
    return;
  }
  const r = g.prepare({ base: d, workRoot: path.join(tmp, 'Work', 'D'), taskId: 't' });
  assert.deepStrictEqual([r.dir, r.inited], [d, true]);
  assert.match(sh(d, 'log', '--oneline'), /最初の保存/);
  fs.writeFileSync(path.join(d, 'memo.md'), 'y\n');
  const r2 = g.prepare({ base: d, workRoot: path.join(tmp, 'Work', 'D'), taskId: 't' });
  assert.strictEqual(r2.dir, d);
  assert.ok(!r2.worktree);
  assert.match(sh(d, 'log', '--oneline'), /作業前の保存/);
  assert.ok(!fs.existsSync(path.join(tmp, 'Work', 'D')));
});

test('台帳のフォルダは、別の Git の中にあっても作業用コピーを作らない', () => {
  const outer = repo('outer');
  const ledger = path.join(outer, 'Product', 'X');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(ledger, 'PROJECT.md'), '---\nname: X\n---\n');
  if (WINDOWS) {
    assert.throws(() => g.prepare({ base: ledger, workRoot: path.join(tmp, 'Work', 'X'), taskId: 't', direct: true }), /不允許/);
    assert.strictEqual(sh(outer, 'log', '--oneline').split('\n').length, 1);
    return;
  }
  const r = g.prepare({ base: ledger, workRoot: path.join(tmp, 'Work', 'X'), taskId: 't', direct: true });
  assert.strictEqual(r.dir, ledger);
  assert.ok(fs.existsSync(path.join(ledger, '.git')));
  assert.strictEqual(sh(outer, 'log', '--oneline').split('\n').length, 1); // 外の Git は触らない
});

test('作業用コピーに .env を写し、取り込む前に変更の量とぶつかりそうかが分かる', () => {
  const main = repo('code4');
  fs.writeFileSync(path.join(main, '.gitignore'), '.env\n');
  sh(main, 'add', '-A'); sh(main, 'commit', '-q', '-m', 'ignore');
  fs.writeFileSync(path.join(main, '.env'), 'KEY=1\n');
  const w4 = path.join(tmp, 'Work', 'E');
  const r = g.prepare({ base: main, workRoot: w4, taskId: 'env' });
  assert.deepStrictEqual(r.copied, WINDOWS ? [] : ['.env']);
  if (WINDOWS) assert.ok(!fs.existsSync(path.join(r.dir, '.env')));
  else assert.strictEqual(fs.readFileSync(path.join(r.dir, '.env'), 'utf8'), 'KEY=1\n');
  assert.deepStrictEqual(g.preview({ dir: r.dir, workRoot: w4 }).files, 0);
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(r.dir, 'new.txt'), 'x\n');
  let pv = g.preview({ dir: r.dir, workRoot: w4 });
  assert.deepStrictEqual([pv.files, pv.added, pv.conflict], [2, 1, false]);
  // 本体で同じ所を変えると「ぶつかりそう」
  sh(r.dir, 'add', '-A'); sh(r.dir, 'commit', '-q', '-m', 'wt');
  fs.writeFileSync(path.join(main, 'a.txt'), 'ONE\n');
  sh(main, 'commit', '-qam', 'main');
  pv = g.preview({ dir: r.dir, workRoot: w4 });
  assert.strictEqual(pv.conflict, true);
});

test('Work フォルダの外は取り込まない', () => {
  const main = repo('code3');
  const m = g.merge({ dir: main, workRoot: W, title: 'x' });
  assert.ok(!m.ok);
});

test('ignore が無くても新規の秘密設定は保存せず、例示と通常ファイルは保存する', () => {
  const main = repo('private-settings');
  const secrets = ['.env', '.env.local', '.npmrc', '.dev.vars', '.dev.vars.local', 'nested/.env.production', 'nested/[local]/.env.production', '.claude/settings.local.json'];
  for (const f of secrets) {
    const full = path.join(main, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'LOCAL_TEST_VALUE=placeholder\n');
  }
  fs.writeFileSync(path.join(main, '.env.example'), 'TOKEN=\n');
  fs.writeFileSync(path.join(main, '.env.sample'), 'TOKEN=\n');
  fs.writeFileSync(path.join(main, 'a.txt'), 'two\n');
  assert.strictEqual(g.save(main, 'safe save'), true);
  const tracked = sh(main, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  for (const f of secrets) {
    assert.ok(!tracked.includes(f), f);
    assert.ok(fs.existsSync(path.join(main, f)), f + ' stays on disk');
  }
  assert.ok(tracked.includes('.env.example'));
  assert.ok(tracked.includes('.env.sample'));
  assert.strictEqual(sh(main, 'show', 'HEAD:a.txt'), 'two');
});

test('秘密設定だけの変更は空の保存を作らず、すでに追跡された例示の変更は保存する', () => {
  const main = repo('only-secret');
  fs.writeFileSync(path.join(main, '.env'), 'LOCAL_TEST_VALUE=placeholder\n');
  sh(main, 'add', '.env'); // 先にステージされていても自動commitでは含めない
  const before = sh(main, 'rev-parse', 'HEAD');
  assert.strictEqual(g.save(main, 'nothing public'), false);
  assert.strictEqual(sh(main, 'rev-parse', 'HEAD'), before);
  assert.strictEqual(sh(main, 'diff', '--cached', '--name-only'), '');
  fs.writeFileSync(path.join(main, '.env.example'), 'TOKEN=\n');
  assert.strictEqual(g.save(main, 'example'), true);
  fs.writeFileSync(path.join(main, '.env.example'), 'TOKEN=\nMODE=example\n');
  assert.strictEqual(g.save(main, 'update example'), true);
  assert.match(sh(main, 'show', 'HEAD:.env.example'), /MODE=example/);
});

test('すでに追跡された秘密設定の変更は、意図せず追跡解除しない', () => {
  const main = repo('tracked-settings');
  fs.writeFileSync(path.join(main, '.env'), 'LOCAL_TEST_VALUE=old\n');
  sh(main, 'add', '.env'); sh(main, 'commit', '-qm', 'existing tracked setting');
  fs.writeFileSync(path.join(main, '.env'), 'LOCAL_TEST_VALUE=new\n');
  if (WINDOWS) {
    const before = sh(main, 'rev-parse', 'HEAD');
    assert.throws(() => g.save(main, 'requires trusted manual save'), /機密|敏感|人工/);
    assert.strictEqual(sh(main, 'rev-parse', 'HEAD'), before);
    assert.match(sh(main, 'show', 'HEAD:.env'), /LOCAL_TEST_VALUE=old/);
    assert.match(fs.readFileSync(path.join(main, '.env'), 'utf8'), /LOCAL_TEST_VALUE=new/);
    assert.strictEqual(sh(main, 'ls-files', '--', '.env'), '.env');
  } else {
    assert.strictEqual(g.save(main, 'keep existing behavior'), true);
    assert.match(sh(main, 'show', 'HEAD:.env'), /LOCAL_TEST_VALUE=new/);
  }
});

test('初回の保存と未コミットrepoの準備でも秘密設定を追跡しない', () => {
  for (const preInit of [false, true]) {
    const dir = path.join(tmp, preInit ? 'unborn-private' : 'init-private');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.env.local'), 'LOCAL_TEST_VALUE=placeholder\n');
    fs.writeFileSync(path.join(dir, 'memo.md'), 'public\n');
    if (WINDOWS) {
      if (preInit) sh(dir, 'init', '-q');
      assert.throws(() => preInit
        ? g.prepare({ base: dir, workRoot: path.join(tmp, 'Work', 'unborn'), taskId: 'safe' })
        : g.init(dir), /需要先建立 Git 提交|不會替非 Git/);
      assert.ok(fs.existsSync(path.join(dir, '.env.local')));
      continue;
    }
    if (preInit) {
      sh(dir, 'init', '-q');
      g.prepare({ base: dir, workRoot: path.join(tmp, 'Work', 'unborn'), taskId: 'safe' });
    } else {
      assert.ok(g.init(dir).ok);
    }
    assert.strictEqual(sh(dir, 'ls-tree', '-r', '--name-only', 'HEAD'), 'memo.md');
    assert.ok(fs.existsSync(path.join(dir, '.env.local')));
  }
});

test('GitHub の場所：origin を https の形にし、今のブランチと合わせて返す（120秒覚える）', () => {
  const d = repo('remote');
  sh(d, 'checkout', '-q', '-b', 'feature/x');
  sh(d, 'remote', 'add', 'origin', 'git@github.com:kieiken/admin.git');
  g.remoteInfoCache.clear();
  const a = g.remoteInfo(d);
  assert.deepStrictEqual(a, { url: 'https://github.com/kieiken/admin', branch: 'feature/x' });
  // 覚えている間は同じ物を返す。fresh なら読み直す
  sh(d, 'remote', 'set-url', 'origin', 'ssh://git@github.com/kieiken/other.git');
  assert.strictEqual(g.remoteInfo(d), a);
  assert.strictEqual(g.remoteInfo(d, { fresh: true }).url, 'https://github.com/kieiken/other');
  // 途中のコミットを見ている時はブランチ名を空に
  sh(d, 'checkout', '-q', '--detach');
  assert.strictEqual(g.remoteInfo(d, { fresh: true }).branch, '');
  // origin が無い・Git でない・無い場所は null
  assert.strictEqual(g.remoteInfo(repo('no-origin')), null);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-plain-'));
  assert.strictEqual(g.remoteInfo(plain), null);
  assert.strictEqual(g.remoteInfo(path.join(tmp, 'nothing')), null);
  // URL の形
  assert.strictEqual(g.webUrl('https://user:secret@github.com/o/r.git'), 'https://github.com/o/r');
  assert.strictEqual(g.webUrl('/local/path/repo.git'), '');
});

test('コピーされた秘密設定を取り込まず、作業成果だけ本体へ反映する', () => {
  const main = repo('private-copy');
  fs.writeFileSync(path.join(main, '.env.local'), 'LOCAL_TEST_VALUE=placeholder\n');
  const workRoot = path.join(tmp, 'Work', 'private-copy');
  const r = g.prepare({ base: main, workRoot, taskId: 'safe' });
  assert.deepStrictEqual(r.copied, WINDOWS ? [] : ['.env.local']);
  fs.writeFileSync(path.join(r.dir, 'result.txt'), 'public\n');
  const m = g.merge({ dir: r.dir, workRoot, title: 'safe merge' });
  assert.ok(m.ok, m.error);
  assert.strictEqual(sh(main, 'ls-tree', '-r', '--name-only', 'HEAD'), 'a.txt\nresult.txt');
  assert.ok(fs.existsSync(path.join(main, '.env.local')));
  assert.strictEqual(fs.existsSync(path.join(m.trashed, '.env.local')), !WINDOWS);
});

test('取り込み証跡はその作業の変更だけを示し、別本体・存在しないcommitを拒否する', () => {
  const main = repo('receipt'), workRoot = path.join(tmp, 'Work', 'receipt');
  const r = g.prepare({base:main,workRoot,taskId:'child'});
  fs.writeFileSync(path.join(r.dir,'child.txt'),'child result\n');
  fs.writeFileSync(path.join(main,'parent.txt'),'unrelated parent change\n');
  const m = g.merge({dir:r.dir,workRoot,title:'child'});
  assert.ok(m.ok,m.error);assert.deepStrictEqual(m.files,['child.txt']);
  const receipt = g.integrationReceipt(main,m);
  assert.strictEqual(receipt.commit,m.commit);assert.deepStrictEqual(receipt.files,['child.txt']);
  assert.strictEqual(g.integrationReceipt(repo('other-receipt'),m),null);
  assert.strictEqual(g.integrationReceipt(main,{...m,commit:'f'.repeat(40)}),null);
  assert.strictEqual(g.integrationReceipt(main,{main,files:['child.txt']}),null);
});
