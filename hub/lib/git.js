'use strict';
// Git の出し入れ：作業ごとの作業用コピー（worktree）を作る・本体に取り込む・片付ける
// Git の無いフォルダは、最初に保存を始める（作業用コピーは作らない）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('child_process');

const MAX_FILES = 20000;          // これより多いフォルダは自動で保存を始めない
const MAX_BYTES = 1024 ** 3;      // 1GB

function git(dir, args) {
  // 名前が未設定の Mac でも保存できるように、未設定の時だけ仮の名前を使う
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!hasIdentity(dir)) Object.assign(env, { GIT_AUTHOR_NAME: 'Project Hub', GIT_AUTHOR_EMAIL: 'hub@localhost', GIT_COMMITTER_NAME: 'Project Hub', GIT_COMMITTER_EMAIL: 'hub@localhost' });
  return execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(dir, args) { try { return git(dir, args); } catch (e) { return null; } }

function hasIdentity(dir) {
  try { return Boolean(execFileSync('git', ['-C', dir, 'config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (e) { return false; }
}

function available() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

function repoTop(dir) { return fs.existsSync(dir) ? tryGit(dir, ['rev-parse', '--show-toplevel']) : null; }

// 作業用コピーなら、本体のフォルダを返す
function mainOf(dir) {
  const common = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const own = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (!common || !own || common === own) return null;
  return path.dirname(common);
}

function dirty(dir) { return Boolean(tryGit(dir, ['status', '--porcelain'])); }

// ignore の無いプロジェクトでも、新しい秘密設定は自動保存に含めない。
// すでに追跡されているファイルは変更せず、例示用の .env は許容する。
function stageAll(dir) {
  git(dir, ['add', '-A']);
  const added = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '-z'])
    .split('\0').filter(Boolean);
  const secrets = added.filter(f => {
    const name = path.posix.basename(f);
    if (name === '.env.example' || name === '.env.sample') return false;
    return LOCAL_FILES.test(name) || /(^|\/)\.claude\/settings\.local\.json$/.test(f);
  });
  for (let i = 0; i < secrets.length; i += 100) {
    git(dir, ['rm', '--cached', '-q', '--', ...secrets.slice(i, i + 100).map(f => `:(top,literal)${f}`)]);
  }
  try { git(dir, ['diff', '--cached', '--quiet']); return false; }
  catch (e) { if (e.status === 1) return true; throw e; }
}

// 変更があれば保存する
function save(dir, message) {
  if (!dirty(dir)) return false;
  if (!stageAll(dir)) return false;
  git(dir, process.platform === 'win32' ? ['commit', '-q', '-m', message] : ['commit', '-q', '--no-verify', '-m', message]);
  return true;
}

// 大きすぎないか数える（途中で上限を超えたら止める）
function tooBig(dir) {
  let files = 0, bytes = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (walk(f)) return true; continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += fs.statSync(f).size; } catch (x) { /* 無視 */ }
      if (files > MAX_FILES || bytes > MAX_BYTES) return true;
    }
    return false;
  };
  return walk(dir);
}

// Git の無いフォルダで保存を始める。できなければ理由を返す
function init(dir) {
  if (process.platform === 'win32') throw new Error('Windows 版不會替非 Git 專案自動初始化或提交；請先確認專案並自行建立 Git 儲存庫');
  if (tooBig(dir)) return { ok: false, reason: 'ファイルが多すぎるため、Git の保存は始めませんでした' };
  git(dir, ['init', '-q']);
  stageAll(dir);
  git(dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'Project Hub: 最初の保存']);
  return { ok: true };
}

const real = p => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
// ブランチ名に使えない文字だけ置き換える（日本語はそのまま）
const branchName = s => 'hub/' + (String(s).replace(/[\s~^:?*[\\\x00-\x1f\x7f]+|\.\.|@\{/g, '-').replace(/^[-.]+|[-.]+$|\.lock$/g, '') || 'task');

// 作業を始める前の準備。作業する場所と、何をしたかを返す
//   base: 本体のフォルダ / workRoot: AI-Workspace/Work/<プロジェクト>
function prepare({ base, workRoot, taskId, direct }) {
  if (!available()) {
    if (process.platform === 'win32') throw new Error('Windows 版需要 Git 才能隔離 AI 工作');
    return { dir: base, note: 'Git が無いため、本体で作業します' };
  }
  if (process.platform === 'win32' && direct) throw new Error('Windows 版不允許 AI 直接修改專案本體');
  let top = repoTop(base);
  // 台帳のフォルダが別の Git の中にある時は、台帳だけの保存を始める
  if (top && direct && real(top) !== real(base)) top = null;
  if (!top) {
    const r = init(base);
    if (!r.ok) return { dir: base, note: r.reason };
    git(base, ['config', 'hub.mode', 'direct']);
    return { dir: base, note: 'Git の保存を始めました（本体で作業します）', inited: true };
  }
  // 元々 Git の無かったフォルダ・台帳のフォルダは、本体で作業する（始める前に保存だけする）
  if (direct || tryGit(top, ['config', 'hub.mode']) === 'direct') {
    if (process.platform === 'win32') throw new Error('Windows 版不允許 AI 直接修改專案本體');
    save(top, '作業前の保存');
    return { dir: base, note: '作業前に保存しました' };
  }
  // まだ一度も保存していない Git なら、まず保存する
  if (!tryGit(top, ['rev-parse', '--verify', 'HEAD'])) {
    if (process.platform === 'win32') throw new Error('Windows 版需要先建立 Git 提交，才能建立隔離工作複本');
    stageAll(top); git(top, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'Project Hub: 最初の保存']);
  }
  const wt = path.join(workRoot, taskId);
  const rel = path.relative(top, base);
  if (fs.existsSync(wt)) return { dir: path.join(wt, rel), worktree: wt };
  fs.mkdirSync(workRoot, { recursive: true });
  const branch = branchName(taskId);
  const exists = tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  git(top, exists ? ['worktree', 'add', '-q', wt, branch] : ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD']);
  const copied = copyLocalFiles(top, wt);
  return { dir: path.join(wt, rel), worktree: wt, created: true, branch, copied, note: `この作業専用の作業用コピーを作りました${copied.length ? `（${copied.join('・')} も写しました）` : ''}` };
}

// Git に入っていない手元の設定（.env など）を作業用コピーにも写す。無いと AI のテストが動かないため
const LOCAL_FILES = /^(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc)$/;
function copyLocalFiles(top, wt) {
  if (process.platform === 'win32') return []; // Never copy local credentials into an AI worktree.
  const copied = [];
  const cands = [];
  try { for (const n of fs.readdirSync(top)) if (LOCAL_FILES.test(n)) cands.push(n); } catch (e) { return copied; }
  for (const f of ['.claude/settings.local.json']) if (fs.existsSync(path.join(top, f))) cands.push(f);
  for (const rel of cands) {
    const src = path.join(top, rel), dst = path.join(wt, rel);
    try {
      if (!fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
      if (tryGit(top, ['ls-files', '--error-unmatch', rel]) !== null) continue; // Git に入っている物は写さない
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    } catch (e) { /* 写せない物は飛ばす */ }
  }
  return copied;
}

// 取り込む前の見通し：変わったファイルの数・行数、本体とぶつかりそうか（本体は触らない）
function preview({ dir, workRoot, target }) {
  const wt = repoTop(dir);
  const main = target ? repoTop(target) : wt && mainOf(wt);
  if (!wt || !main) return null;
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const mainHead = tryGit(main, ['rev-parse', 'HEAD']);
  const base = mainHead && tryGit(wt, ['merge-base', mainHead, 'HEAD']);
  if (!base) return null;
  const stat = tryGit(wt, ['diff', '--shortstat', base]) || '';
  const num = re => Number((stat.match(re) || [0, 0])[1]);
  const untracked = (tryGit(wt, ['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean).length;
  const files = num(/(\d+) files? changed/) + untracked;
  let conflict = false;
  // 保存済みの変更どうしで試しに合わせてみる（git 2.38 以上。使えなければ判定しない）
  if (tryGit(wt, ['rev-parse', 'HEAD']) !== base) {
    try { git(main, ['merge-tree', '--write-tree', '--name-only', '--no-messages', mainHead, tryGit(wt, ['rev-parse', 'HEAD'])]); }
    catch (e) { conflict = e.status === 1; }
  }
  return { files, added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/), conflict, mainDirty: dirty(main), paths: (tryGit(wt, ['diff', '--name-only', '-z', base]) || '').split('\0').filter(Boolean) };
}

// ゴミ箱へ移す（完全には消さない）
function toTrash(dir, trash) {
  const dest = trashPath(dir, trash);
  fs.renameSync(dir, dest);
  return dest;
}
function trashPath(dir, trash) {
  const bin = trash || process.env.HUB_TRASH || path.join(os.homedir(), '.Trash');
  fs.mkdirSync(bin, { recursive: true });
  let dest = path.join(bin, path.basename(dir));
  if (fs.existsSync(dest)) dest += ' ' + new Date().toISOString().replace(/[:.]/g, '-');
  return dest;
}

// 作業用コピーを本体に取り込み、片付ける。ぶつかったら何も変えずに conflict を返す
function merge({ dir, workRoot, title, target, cleanup = true }) {
  const wt = repoTop(dir);
  if (!wt) return { ok: false, error: '作業用コピーが見つかりません' };
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Work フォルダの作業用コピーではありません' };
  const origin = mainOf(wt);
  const main = target ? repoTop(target) : origin;
  if (!main) return { ok: false, error: 'Git の作業用コピーではありません' };
  if (!origin || main === wt || git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return { ok: false, error: '統合先は同じ本体の別の作業用コピーにしてください' };
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  save(wt, `${title}（作業の保存）`);
  save(main, '取り込み前の保存');
  const before = git(main, ['rev-parse', 'HEAD']);
  const already = isAncestor(main, git(wt, ['rev-parse', 'HEAD']));
  try {
    if (!already) git(main, ['merge', '--no-ff', '--no-edit', '-m', `取り込み: ${title}`, branch]);
  } catch (e) {
    tryGit(main, ['merge', '--abort']);
    return { ok: false, conflict: true, error: '本体とぶつかったため、取り込みませんでした' };
  }
  const commit = git(main, ['rev-parse', 'HEAD']);
  const files = (tryGit(main, ['diff', '--name-only', '-z', before, commit]) || '').split('\0').filter(Boolean);
  const sourceSnapshot = inspect(wt);
  const trashed = cleanup ? cleanupCopy({ dir: wt, workRoot, target: main, expectedSnapshot:sourceSnapshot }).trashed : null;
  return { ok: true, main, trashed, commit, files, already, branch };
}
function isAncestor(dir, commit) { return /^[a-f0-9]{40,64}$/.test(commit || '') && tryGit(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']) !== null; }
function inspect(dir) {
  const wt = repoTop(dir); if (!wt) return null;
  // porcelainの同じ変更マークでも、中身・ステージ・未追跡ファイルが変われば拒否する。
  const digest = createHash('sha256');
  for (const args of [['diff','--binary','--no-ext-diff','--no-textconv','HEAD'], ['diff','--cached','--binary','--no-ext-diff','--no-textconv']]) {
    const data = execFileSync('git', ['-C',wt,...args], {maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
    digest.update(String(data.length)+':').update(data);
  }
  const files = execFileSync('git',['-C',wt,'ls-files','--others','--exclude-standard','-z'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\0').filter(Boolean).sort();
  let bytes=0;if(files.length>MAX_FILES)throw Error('未追跡ファイルが多すぎて照合できません');
  for (const f of files) {
    const file=path.join(wt,f),st=fs.lstatSync(file);
    if((bytes+=st.size)>256*1024*1024)throw Error('未追跡ファイルが大きすぎて照合できません');
    const data=st.isSymbolicLink()?Buffer.from(fs.readlinkSync(file)):fs.readFileSync(file);
    digest.update(JSON.stringify([f,st.mode,data.length])).update(data);
  }
  return { head: git(wt, ['rev-parse', 'HEAD']), branch: git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), status: git(wt, ['status', '--porcelain']), content: digest.digest('hex') };
}
function cleanupCopy({ dir, workRoot, target, expectedSnapshot, beforeMove = () => {} }) {
  const wt = repoTop(dir), rel = wt && path.relative(workRoot, wt);
  if (!wt || !rel || rel.startsWith('..') || path.isAbsolute(rel) || !mainOf(wt)) throw Error('片付ける作業用コピーの場所が不正です');
  const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!isAncestor(target, git(wt, ['rev-parse', 'HEAD'])) || tryGit(wt, ['diff', '--quiet', 'HEAD']) === null) throw Error('未統合の変更があるため作業用コピーを残します');
  if (expectedSnapshot ? JSON.stringify(inspect(wt)) !== JSON.stringify(expectedSnapshot) : Boolean(git(wt,['ls-files','--others','--exclude-standard','-z']))) throw Error('片付け前に未統合のファイルが変わりました。作業用コピーを残します');
  const sourceHead = git(wt, ['rev-parse', 'HEAD']), trashed = trashPath(wt);
  beforeMove({trashed, branch, sourceHead});
  fs.renameSync(wt, trashed);
  finishCleanupCopy({target, branch, sourceHead});
  return { trashed, branch };
}
function finishCleanupCopy({ target, branch, sourceHead }) {
  if (!isAncestor(target, sourceHead)) throw Error('統合済みのコミットを確認できません');
  git(target, ['worktree', 'prune']);
  const head = tryGit(target, ['rev-parse', '--verify', 'refs/heads/' + branch]);
  if (head && head !== sourceHead) throw Error('片付け途中でブランチが変わりました。登録は残します');
  if (head) git(target, ['branch', '-D', branch]);
}

// Work/<プロジェクト>/ に残っている作業用コピーの数
function countCopies(workRoot) {
  try { return fs.readdirSync(workRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).length; } catch (e) { return 0; }
}

// GitHub などの場所：origin の URL をブラウザで開ける https の形に直す（直せない物は空）
function webUrl(raw) {
  let s = String(raw || '').trim();
  let m;
  if ((m = s.match(/^[\w.-]+@([^:/]+):(.+)$/))) s = `https://${m[1]}/${m[2]}`; // git@github.com:o/r.git
  else if ((m = s.match(/^(?:ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/))) s = `https://${m[1]}/${m[2]}`;
  if (!/^https?:\/\//.test(s)) return '';
  try { const u = new URL(s); u.username = ''; u.password = ''; s = u.origin + u.pathname; } catch (e) { return ''; } // 合言葉入りの URL は外す
  return s.replace(/\/+$/, '').replace(/\.git$/, '');
}
// { url, branch } か null。一覧は15秒ごとに来るので、場所ごとに120秒覚えておく（fresh で読み直す）
const REMOTE_TTL = 120000;
const remoteInfoCache = new Map(); // dir → { at, value }
function remoteInfo(dir, { fresh } = {}) {
  const hit = remoteInfoCache.get(dir);
  if (!fresh && hit && Date.now() - hit.at < REMOTE_TTL) return hit.value;
  let value = null, hasOrigin = false;
  if (dir && fs.existsSync(dir)) {
    const raw = tryGit(dir, ['config', '--get', 'remote.origin.url']);
    hasOrigin = raw !== null;
    const url = webUrl(raw);
    if (url) {
      const b = tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '';
      value = { url, branch: b === 'HEAD' ? '' : b };
    }
  }
  remoteInfoCache.set(dir, { at: Date.now(), value, hasOrigin });
  return value;
}

function hasOrigin(dir) { remoteInfo(dir); return Boolean(remoteInfoCache.get(dir)?.hasOrigin); }

function integrationReceipt(dir, record, task) {
  // 旧版の成功ログにはこの3項目が無い。名前と時刻が一意に合う本体履歴だけで補う。
  if (record?.ok === true && !['main', 'commit', 'files'].some(k => Object.hasOwn(record, k))) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || !task?.id || typeof task.title !== 'string' || !task.title || record.task !== task.id) return null;
    const subject = `取り込み: ${task.id} ${task.title}`;
    const log = tryGit(dir, ['log', '--merges', '--format=%H%x09%cI%x09%P%x09%s', 'HEAD']);
    if (log === null) return null;
    const matches = log.split('\n').map(line => line.split('\t')).filter(row =>
      row.length === 4 && row[3] === subject && row[2].split(' ').length === 2 &&
      Math.abs(Date.parse(row[1]) - at) <= 10000);
    if (matches.length !== 1) return null;
    const commit = matches[0][0];
    if (tryGit(dir, ['merge-base', '--is-ancestor', commit, 'HEAD']) === null) return null;
    const files = tryGit(dir, ['diff', '--name-only', '-z', `${commit}^1`, commit]);
    if (files === null) return null;
    return {dir, commit, files:files.split('\0').filter(Boolean), github:remoteInfo(dir), recovered:true};
  }
  if (!record?.commit || !record.main || !Array.isArray(record.files) || path.resolve(dir) !== path.resolve(record.main)) return null;
  if (tryGit(dir, ['merge-base', '--is-ancestor', record.commit, 'HEAD']) === null) return null;
  return {dir, commit:record.commit, files:record.files, github:remoteInfo(dir)};
}
module.exports = { hasOrigin, tooBig, integrationReceipt, available, repoTop, mainOf, save, init, prepare, merge, preview, toTrash, cleanupCopy, finishCleanupCopy, inspect, isAncestor, countCopies, dirty, copyLocalFiles, remoteInfo, remoteInfoCache, webUrl };
