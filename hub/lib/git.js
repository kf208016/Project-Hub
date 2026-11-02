'use strict';
// Git の出し入れ：作業ごとの作業用コピー（worktree）を作る・本体に取り込む・片付ける
// Git の無いフォルダは、最初に保存を始める（作業用コピーは作らない）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('child_process');
const {localPath,localTree}=require('./safe-path');
const gitPolicy=require('./git-policy');
const WINDOWS=process.platform==='win32';
const secretApprovals=new WeakMap();
function reviewedSecretApproval({base,paths,snapshotHash}){
  if(!WINDOWS||typeof base!=='string'||!Array.isArray(paths)||paths.some(x=>typeof x!=='string')||!/^[a-f0-9]{64}$/.test(snapshotHash||''))throw Error('工作複本機密供應確認格式無效');
  const key={};secretApprovals.set(key,{base:path.resolve(base).toLowerCase(),paths:new Set(paths),snapshotHash,at:Date.now()});return key;
}

const MAX_FILES = 20000;          // これより多いフォルダは自動で保存を始めない
const MAX_BYTES = 1024 ** 3;      // 1GB

function git(dir, args) {
  return gitPolicy.run(dir,args).trim();
}
function tryGit(dir, args) { try { return git(dir, args); } catch (e) { if(!Number.isInteger(e.status))throw e;return null; } }

function hasIdentity(dir) {
  try { return Boolean(gitPolicy.run(dir,['config','user.email'],{identity:false}).trim()); } catch (e) { return false; }
}

function available() {
  try {const executable=WINDOWS?require('./git-metadata').trustedGit():'git';execFileSync(executable,['--version'],{stdio:'ignore',env:WINDOWS?gitPolicy.environment():process.env,windowsHide:true,timeout:5000});return true;}catch(e){return false;}
}

function repoTop(dir) { return fs.existsSync(dir) ? tryGit(dir, ['rev-parse', '--show-toplevel']) : null; }
function repoTopChain(){const seen=new Map(),k=d=>WINDOWS?path.resolve(d).toLowerCase():path.resolve(d);return dir=>{const key=k(dir);if(seen.has(key))return seen.get(key);const top=repoTop(dir);if(typeof top==='string'&&k(top)===key)seen.set(key,top);return top;};}

// 作業用コピーなら、本体のフォルダを返す
function mainOf(dir) {
  const common = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const own = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  if (!common || !own || common === own) return null;
  return path.dirname(common);
}

function dirty(dir) { return Boolean(git(dir, ['status', '--porcelain'])); }

// ignore の無いプロジェクトでも、新しい秘密設定は自動保存に含めない。
// すでに追跡されているファイルは変更せず、例示用の .env は許容する。
function stageAll(dir) {
  git(dir, ['add', '-A']);
  const added = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '-z'])
    .split('\0').filter(Boolean);
  const secrets = added.filter(f => {
    return isSensitivePath(f);
  });
  for (let i = 0; i < secrets.length; i += 100) {
    git(dir, ['rm', '--cached', '-q', '--', ...secrets.slice(i, i + 100).map(f => `:(top,literal)${f}`)]);
  }
  try { git(dir, ['diff', '--cached', '--quiet']); return false; }
  catch (e) { if (e.status === 1) return true; throw e; }
}

// 変更があれば保存する
function save(dir, message) {
  gitPolicy.assertExecution(dir);
  if(WINDOWS){gitPolicy.assertIndexVisible(dir);assertTrackedSecrets(dir);}
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

function validateWindowsRepo(dir,rt=repoTop) {
  if(!WINDOWS)return;
  localPath(dir);
  const top=rt(dir);if(!top)throw Error('無法確認 Git 儲存庫');
  localPath(top);
  const dirs=[];for(const flag of ['--git-dir','--git-common-dir']){const value=git(dir,['rev-parse','--path-format=absolute',flag]);localPath(value);dirs.push(value);}
  localPath(path.join(top,'.git'));return {gitDir:dirs[0],commonDir:dirs[1]};
}
function validateWindowsWorktree(top,wt,rt=repoTop) {
  if(!WINDOWS)return;
  const {commonDir}=validateWindowsRepo(top,rt),own=validateWindowsRepo(wt,rt).gitDir;
  const common=d=>git(d,['rev-parse','--path-format=absolute','--git-common-dir']).toLowerCase();
  if(common(top)!==common(wt)||path.resolve(top).toLowerCase()===path.resolve(wt).toLowerCase())throw Error('既有作業目錄不屬於此 Git 儲存庫的工作複本');
  const sourceBranch=git(wt,['rev-parse','--abbrev-ref','HEAD']),targetBranch=git(top,['rev-parse','--abbrev-ref','HEAD']);
  if(sourceBranch!=='HEAD'&&sourceBranch===targetBranch)throw Error('來源工作複本與目標共用同一個 branch；請用獨立分支工作複本');
  const registered=git(top,['worktree','list','--porcelain','-z']).split('\0').filter(x=>x.startsWith('worktree ')).map(x=>path.resolve(x.slice(9)).toLowerCase());
  if(!registered.includes(path.resolve(wt).toLowerCase()))throw Error('工作複本未登錄在此 Git 儲存庫');
  const rel=path.relative(path.join(commonDir,'worktrees'),own);if(!rel||rel==='..'||path.isAbsolute(rel)||rel.includes(path.sep))throw Error('工作複本的 Git 目錄不是此儲存庫登錄的 linked worktree');
  const back=path.join(own,'gitdir');localPath(back);const st=fs.lstatSync(back);if(!st.isFile()||st.size>4096)throw Error('工作複本 Git 反向指標無效');
  if(path.resolve(own,fs.readFileSync(back,'utf8').trim()).toLowerCase()!==path.resolve(wt,'.git').toLowerCase())throw Error('工作複本 Git 目錄的反向指標不屬於此作業目錄');
}

// 作業を始める前の準備。作業する場所と、何をしたかを返す
//   base: 本体のフォルダ / workRoot: AI-Workspace/Work/<プロジェクト>
function prepare({ base, workRoot, taskId, direct, secretApproval, repoTop:rt=repoTop }) {
  if(WINDOWS) {
    localPath(base);localPath(workRoot,{allowMissing:true});
    if(typeof taskId!=='string'||!taskId||taskId==='.'||taskId==='..'||/[\\/]/.test(taskId))throw Error('工作複本識別不能包含路徑');
    localPath(path.join(workRoot,taskId),{allowMissing:true});
  }
  if (!available()) {
    if (process.platform === 'win32') throw new Error('Windows 版需要 Git 才能隔離 AI 工作');
    return { dir: base, note: 'Git が無いため、本体で作業します' };
  }
  if (process.platform === 'win32' && direct) throw new Error('Windows 版不允許 AI 直接修改專案本體');
  let top = rt(base);
  if(top)gitPolicy.assertExecution(top);
  if(WINDOWS&&top&&tryGit(top,['rev-parse','--verify','HEAD'])) {
    const secrets=git(top,['ls-tree','-rz','--name-only','HEAD']).split('\0').filter(Boolean).filter(isSensitivePath);
    if(secrets.length){const permit=secretApprovals.get(secretApproval);secretApprovals.delete(secretApproval);if(!permit||permit.base!==path.resolve(top).toLowerCase()||Date.now()<permit.at||Date.now()-permit.at>600000||secrets.some(x=>!permit.paths.has(x))||rawContent(top)!==permit.snapshotHash)throw Error('Git HEAD 已追蹤可能機密檔案；需要使用者明確核准完整檔名及 Git 歷史可讀範圍：'+secrets.join(' / '));}
  }
  if(top)validateWindowsRepo(top,rt);
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
  if (fs.existsSync(wt)) {validateWindowsWorktree(top,wt,rt);return { dir: path.join(wt, rel), worktree: wt };}
  fs.mkdirSync(workRoot, { recursive: true });
  let branch = branchName(taskId);
  let exists = tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if(WINDOWS&&exists){const stem=branch+'-'+require('node:crypto').createHash('sha256').update(path.resolve(workRoot).toLowerCase()).digest('hex').slice(0,10);let count=0;do{branch=stem+(count?'-'+count:'');exists=tryGit(top,['rev-parse','--verify','--quiet',`refs/heads/${branch}`]);if(++count>128)throw Error('同名工作分支過多，請先覆核保留的工作複本');}while(exists);}
  git(top, exists ? ['worktree', 'add', '-q', wt, branch] : ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD']);
  validateWindowsWorktree(top,wt,rt);
  const copied = copyLocalFiles(top, wt);
  return { dir: path.join(wt, rel), worktree: wt, created: true, branch, copied, note: `この作業専用の作業用コピーを作りました${copied.length ? `（${copied.join('・')} も写しました）` : ''}` };
}

// Git に入っていない手元の設定（.env など）を作業用コピーにも写す。無いと AI のテストが動かないため
const LOCAL_FILES = /^(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc)$/;
function isSensitivePath(f) {
  const name=path.posix.basename(String(f).replace(/\\/g,'/')).toLowerCase();
  if(name==='.env.example'||name==='.env.sample')return false;
  return LOCAL_FILES.test(name)||/^(\.netrc|\.pypirc|id_rsa|id_ed25519)$/.test(name)||/\.(pem|key|p12|pfx)$/.test(name)||/(^|\/)\.claude\/settings\.local\.json$/i.test(f);
}
function assertTrackedSecrets(dir) {
  const tracked=new Set(git(dir,['ls-tree','-rz','--name-only','HEAD']).split('\0').filter(Boolean).filter(isSensitivePath));
  const changed=git(dir,['diff','--name-only','-z','HEAD']).split('\0').filter(f=>tracked.has(f));
  if(changed.length)throw Error('已追蹤的可能機密檔案有未提交變更；Hub 不會自動保存，請用人工可信 Git 流程確認：'+changed.join(' / '));
}
function assertMergeSecrets(source,target) {
  if(!WINDOWS)return;
  const base=git(source,['merge-base',git(target,['rev-parse','HEAD']),'HEAD']);
  const changed=git(source,['diff','--name-only','-z',base,'HEAD']).split('\0').filter(isSensitivePath);
  if(changed.length)throw Error('來源 commit 含可能機密檔案變更；Hub 不會自動合併，請用人工可信 Git 流程確認：'+changed.join(' / '));
}
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
  if(WINDOWS){localPath(dir);localPath(workRoot);if(target)localPath(target);}
  const wt = repoTop(dir);
  const main = target ? repoTop(target) : wt && mainOf(wt);
  if (!wt || !main) return null;
  gitPolicy.assertMergeExecution(wt,main);
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const mainHead = tryGit(main, ['rev-parse', 'HEAD']);
  const base = mainHead && tryGit(wt, ['merge-base', mainHead, 'HEAD']);
  if (!base) return null;
  assertMergeSecrets(wt,main);
  const stat = git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--shortstat', base]);
  const num = re => Number((stat.match(re) || [0, 0])[1]);
  const untrackedPaths = git(wt, ['ls-files', '--others', '--exclude-standard','-z']).split('\0').filter(Boolean);
  const notStagedSecrets=[...new Set([...untrackedPaths,...git(wt,['diff','--cached','--name-only','--diff-filter=A','-z']).split('\0').filter(Boolean)].filter(isSensitivePath))];
  const paths=[...new Set([...git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base]).split('\0').filter(Boolean),...untrackedPaths])].filter(f=>!notStagedSecrets.includes(f)).sort();
  const files=paths.length;
  let conflict = false;
  // 保存済みの変更どうしで試しに合わせてみる（git 2.38 以上。使えなければ判定しない）
  if (tryGit(wt, ['rev-parse', 'HEAD']) !== base) {
    try { git(main, ['merge-tree', '--write-tree', '--name-only', '--no-messages', mainHead, tryGit(wt, ['rev-parse', 'HEAD'])]); }
    catch (e) { if(e.status!==1)throw Error('無法預演 Git 合併，未判定無衝突：'+String(e.stderr||e.message).slice(0,1000));conflict = true; }
  }
  return { files, added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/), conflict, mainDirty: dirty(main), paths,notStagedSecrets };
}

// ゴミ箱へ移す（完全には消さない）
function toTrash(dir, trash) {
  if(WINDOWS)localTree(dir);
  const dest = trashPath(dir, trash);
  fs.renameSync(dir, dest);
  return dest;
}
function trashPath(dir, trash) {
  const bin = trash || process.env.HUB_TRASH || path.join(os.homedir(), '.Trash');
  if(WINDOWS)localPath(bin,{allowMissing:true});
  fs.mkdirSync(bin, { recursive: true });
  let dest = path.join(bin, path.basename(dir));
  if (fs.existsSync(dest)) dest += ' ' + new Date().toISOString().replace(/[:.]/g, '-');
  if(WINDOWS)localPath(dest,{allowMissing:true});
  return dest;
}

// 作業用コピーを本体に取り込み、片付ける。ぶつかったら何も変えずに conflict を返す
function merge({ dir, workRoot, title, target, cleanup = true }) {
  if(WINDOWS){localPath(dir);localPath(workRoot);if(target)localPath(target);}
  const wt = repoTop(dir);
  if (!wt) return { ok: false, error: '作業用コピーが見つかりません' };
  const inside = path.relative(workRoot, wt);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Work フォルダの作業用コピーではありません' };
  const origin = mainOf(wt);
  const main = target ? repoTop(target) : origin;
  if (!main) return { ok: false, error: 'Git の作業用コピーではありません' };
  if (!origin || main === wt || git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return { ok: false, error: '統合先は同じ本体の別の作業用コピーにしてください' };
  if(WINDOWS){validateWindowsWorktree(main,wt);localTree(wt);localTree(main);}
  gitPolicy.assertMergeExecution(wt,main);
  assertMergeSecrets(wt,main);
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
// Hash actual bytes rather than Git's filtered/normalized representation. The
// same bounded tree hash is used before saving and after reversible cleanup.
function contentDigests(dir,{exclude=null}={}) {
  const localPath=require('./safe-path').localPathPass();localPath(dir);const digest=createHash('sha256'),baseDigest=createHash('sha256');let count=0,bytes=0;
  const walk=(file,rel)=>{
    if(++count>MAX_FILES)throw Error('來源內容超過確認項目上限');localPath(file);
    const st=fs.lstatSync(file);if(!st.isDirectory()&&!st.isFile())throw Error('來源含連結或特殊檔案');
    const omit=st.isFile()&&exclude?.has(rel),entry=JSON.stringify([rel,st.isDirectory()?'d':'f']);digest.update(entry);if(!omit)baseDigest.update(entry);
    if(st.isDirectory()){for(const n of fs.readdirSync(file).sort()){if(!rel&&n==='.git')continue;walk(path.join(file,n),rel?rel+'/'+n:n);}}
    else {if((bytes+=st.size)>256*1024*1024)throw Error('來源內容超過確認大小上限');const data=fs.readFileSync(file),size=String(st.size)+':';digest.update(size).update(data);if(!omit)baseDigest.update(size).update(data);}
  };walk(dir,'');return {allContent:digest.digest('hex'),baseContent:baseDigest.digest('hex')};
}
function rawContent(dir) { return contentDigests(dir).allContent; }
function inspect(dir) {
  if(WINDOWS) {
    // Each invocation still has fresh local metadata preflight. Combine the
    // pure rev-parse queries; status alone needs the external-helper review.
    const refs=tryGit(dir,['rev-parse','--path-format=absolute','--show-toplevel','--git-dir','--git-common-dir','HEAD','--abbrev-ref','HEAD']);
    if(refs===null)return null;
    const [wt,own,common,head,branch,...extra]=refs.split(/\r?\n/);
    if(extra.length||!/^[a-f0-9]{40,64}$/.test(head)||!branch)throw Error('無法確認 Git 快照參照');
    for(const file of [wt,own,common,path.join(wt,'.git')])localPath(file);
    const status=git(wt,['status','--porcelain']);
    // Stage records contain each path, flags, stage, blob ID and Git mode. Unlike
    // raw index bytes they are stable across incidental index-stat refreshes.
    const index=gitPolicy.indexSnapshot(wt);
    gitPolicy.assertIndexVisible(wt,index);
    const allContent=rawContent(wt),digest=createHash('sha256');
    digest.update(String(index.length)+':').update(index).update(allContent);
    return {head,branch,status,content:digest.digest('hex'),allContent};
  }
  const wt = repoTop(dir); if (!wt) return null;
  // porcelainの同じ変更マークでも、中身・ステージ・未追跡ファイルが変われば拒否する。
  const digest = createHash('sha256');
  for (const args of [['diff','--binary','--no-ext-diff','--no-textconv','HEAD'], ['diff','--cached','--binary','--no-ext-diff','--no-textconv']]) {
    const data = gitPolicy.run(wt,args,{encoding:null});
    digest.update(String(data.length)+':').update(data);
  }
  const files = gitPolicy.run(wt,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).sort();
  let bytes=0;if(files.length>MAX_FILES)throw Error('未追跡ファイルが多すぎて照合できません');
  for (const f of files) {
    const file=path.join(wt,f),st=fs.lstatSync(file);
    if(WINDOWS)localPath(file);
    if((bytes+=st.size)>256*1024*1024)throw Error('未追跡ファイルが大きすぎて照合できません');
    const data=st.isSymbolicLink()?Buffer.from(fs.readlinkSync(file)):fs.readFileSync(file);
    digest.update(JSON.stringify([f,st.mode,data.length])).update(data);
  }
  return { head: git(wt, ['rev-parse', 'HEAD']), branch: git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), status: git(wt, ['status', '--porcelain']), content: digest.digest('hex') };
}
function cleanupCopy({ dir, workRoot, target, expectedSnapshot, beforeMove = () => {} }) {
  if(WINDOWS){localTree(dir);localPath(workRoot);validateWindowsWorktree(target,dir);}
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
function readSummary(dir,options={}){try{if(WINDOWS&&dir&&fs.existsSync(dir))require('./git-metadata').assertLocalMetadata(dir);const remote=remoteInfo(dir,options);return{state:'known',hasOrigin:Boolean(remoteInfoCache.get(dir)?.hasOrigin),remote,error:''};}catch(error){const code=/^[A-Z0-9_]{1,64}$/.test(error.code||'')?error.code:'GIT_READ_FAILED';return{state:'unknown',hasOrigin:null,remote:null,error:'無法確認 Git 中繼資料（'+code+'）；Git 修改操作仍保留拒絕'};}}

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
module.exports = { readSummary, reviewedSecretApproval, isSensitivePath, assertTrackedSecrets, hasOrigin, tooBig, integrationReceipt, available, repoTop, repoTopChain, validateWindowsWorktree, contentDigests, mainOf, save, init, prepare, merge, preview, toTrash, cleanupCopy, finishCleanupCopy, inspect, rawContent, isAncestor, countCopies, dirty, copyLocalFiles, remoteInfo, remoteInfoCache, webUrl };
