'use strict';
// 画面の中の作業画面：作業ごとに Claude Code / Codex を動かし、画面とつなぐ
// node-pty が無い時（準備前）は、その旨を返して落ちないようにする
const os = require('os');
const fs = require('fs');
const path = require('path');
const { childEnv, agyAccountError } = require('./launch');
const cli = require('./cli-platform');
const { SessionViews } = require('./session-view');

let pty = null;
try { pty = require('node-pty'); } catch (e) { pty = null; }

// node-pty の配布物は spawn-helper に実行の許可が付いていないことがある（Mac で posix_spawnp failed になる）
function fixHelper() {
  let base;
  try { base = path.dirname(require.resolve('node-pty/package.json')); } catch (e) { return; }
  for (const sub of ['prebuilds', 'build/Release', 'build/Debug']) {
    const dir = path.join(base, sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      const f = n === 'spawn-helper' ? path.join(dir, n) : path.join(dir, n, 'spawn-helper');
      try { if (fs.existsSync(f)) fs.chmodSync(f, 0o755); } catch (e) { /* 無視 */ }
    }
  }
}
if (pty) fixHelper();

// コマンドが PATH のどこにあるか探す（見つからなければ null）
const MAX_SCROLLBACK = 200000; // 画面を開き直した時に見せる分（文字数）

class Sessions {
  constructor({ viewOptions } = {}) {
    this.map = new Map(); // key: project/task/ai → { proc, buf, watchers, ai, dir, started, exited }
    this.onExit = null; // 終わった時に呼ぶ（project, task, ai, s）。未読の印に使う
    this.viewOptions = viewOptions;
  }

  available() { return Boolean(pty); }

  key(project, task, ai) { return `${project}\u0000${task}\u0000${ai}`; }

  get(project, task, ai) { return this.map.get(this.key(project, task, ai)) || null; }

  list() {
    const out = [];
    for (const [k, s] of this.map) {
      const [project, task, ai] = k.split('\u0000');
      // 画面が止まっている秒数。Claude Code・Codex は作業中ずっと表示が動くので、止まっていれば入力待ち
      out.push({ project, task, ai, running: !s.exited, started: s.started, quiet: Math.round((Date.now() - s.lastOut) / 1000) });
    }
    return out;
  }

  // 作業画面を開く。すでに動いていればそれを返す
  start({ project, task, ai, dir, command, args, env, cols, rows, dirPin }) {
    require('./provider-registry').assertCapability(ai,'terminal');
    require('./task-write-lock').assertPathWritable(dir);
    if (!pty) throw new Error('作業画面の部品（node-pty）が入っていません。setup.sh を実行してください');
    const k = this.key(project, task, ai);
    const cur = this.map.get(k);
    if (cur && !cur.exited) return cur;
    if (ai === 'agy') { const error = agyAccountError(); if (error) throw new Error(error); }
    const fullEnv = childEnv(ai, { ...process.env, ...env, TERM: 'xterm-256color', LANG: process.env.LANG || 'ja_JP.UTF-8', HOME: os.homedir() });
    if (!dir || !fs.existsSync(dir)) throw new Error(`作業の場所が見つかりません: ${dir}`);
    let invocation;
    try { invocation = cli.resolve(command, args, fullEnv.PATH); }
    catch (e) { throw new Error(`「${command}」を起動できません：${e.message}`); }
    const views = new SessionViews(this.viewOptions);
    let proc;
    try {
      const terminal=process.platform==='win32'?require('./managed-pty'):pty;
      proc = terminal.spawn(invocation.file, invocation.args, { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env: fullEnv, ...(dirPin?{dirPin}:{}) });
    } catch (e) {
      throw new Error(`作業画面を開けませんでした（${e.message}）`);
    }
    if (cur?.views) cur.views.close();
    const s = { proc, startedP:proc.started||Promise.resolve(true), buf: '', watchers: new Set(), views, ai, dir, started: Date.now(), lastOut: Date.now(), exited: false, code: null };
    s.finishedP=new Promise(resolve=>s.resolveFinished=resolve);
    proc.onData(d => {
      // 大きさを変えた直後の描き直しは「作業中」に数えない
      if (Date.now() - (s.resizedAt || 0) > 1500) s.lastOut = Date.now();
      s.buf += d;
      if (s.buf.length > MAX_SCROLLBACK) s.buf = s.buf.slice(-MAX_SCROLLBACK);
      for (const w of s.watchers) w({ type: 'data', data: d });
    });
    proc.onExit(({ exitCode }) => {
      s.exited = true; s.code = exitCode;
      s.views.finish();
      s.resolveFinished();
      for (const w of s.watchers) w({ type: 'exit', code: exitCode });
      if (this.onExit) { try { this.onExit(project, task, ai, s); } catch (e) { /* 無視 */ } }
    });
    this.map.set(k, s);
    return s;
  }

  write(project, task, ai, data) {
    const s = this.get(project, task, ai);
    if (!s || s.exited) return false;
    s.proc.write(data);
    return true;
  }

  // 入力欄に打ってから Enter を押す（すぐ Enter を送ると、貼り付けと見なされ改行になる CLI がある）
  type(project, task, ai, text) {
    const s = this.get(project, task, ai);
    if (!s || s.exited) return false;
    s.proc.write(text);
    setTimeout(() => { if (!s.exited) s.proc.write('\r'); }, 150);
    return true;
  }

  resize(project, task, ai, cols, rows) {
    const s = this.get(project, task, ai);
    if (!s || s.exited) return false;
    const c = Math.max(20, cols | 0), r = Math.max(5, rows | 0);
    if (s.proc.cols === c && s.proc.rows === r) return true;
    s.resizedAt = Date.now();
    try { s.proc.resize(c, r); } catch (e) { /* 無視 */ }
    return true;
  }

  // The methods above also serve internal follow-ups and attachment insertion.
  // Browser input must use these view methods; never fall back to write/resize
  // when view credentials are missing or rejected.
  viewController(project, task, ai) {
    const s = this.get(project, task, ai);
    if (!s) { const e = new Error('終端機會話不存在'); e.status = 404; throw e; }
    return s.views;
  }

  registerView(project, task, ai) { return this.viewController(project, task, ai).register(); }
  heartbeatView(project, task, ai, credentials) { return this.viewController(project, task, ai).heartbeat(credentials); }
  claimView(project, task, ai, credentials) { return this.viewController(project, task, ai).claim(credentials); }
  disconnectView(project, task, ai, credentials) { return this.viewController(project, task, ai).disconnect(credentials); }
  viewState(project, task, ai) { return this.viewController(project, task, ai).state(); }

  writeView(project, task, ai, data, credentials) {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 1024 * 1024) { const e = new Error('終端機輸入須為文字且不得超過 1 MiB'); e.status = 400; throw e; }
    this.viewController(project, task, ai).assertOwner(credentials);
    return this.write(project, task, ai, data);
  }

  resizeView(project, task, ai, cols, rows, credentials) {
    if (!Number.isSafeInteger(cols) || cols < 20 || cols > 500 || !Number.isSafeInteger(rows) || rows < 5 || rows > 300) {
      const e = new Error('終端機尺寸須為整數，cols 20–500、rows 5–300'); e.status = 400; throw e;
    }
    this.viewController(project, task, ai).assertOwner(credentials);
    return this.resize(project, task, ai, cols, rows);
  }

  stop(project, task, ai) {
    const s = this.get(project, task, ai);
    if (!s) return false;
    s.stopped = true; // 人が止めた（未読にしない）
    s.views.finish();
    if (!s.exited) { try { s.proc.kill(); } catch (e) { /* 無視 */ } }
    // Keep the session visible to activity locks until its entire owned Job exits.
    return true;
  }

  watch(project, task, ai, fn) {
    const s = this.get(project, task, ai);
    if (!s) return () => {};
    s.watchers.add(fn);
    return () => s.watchers.delete(fn);
  }

  stopAll() { for (const [k] of this.map) { const [p, t, a] = k.split('\u0000'); this.stop(p, t, a); } }
}

module.exports = { Sessions };
