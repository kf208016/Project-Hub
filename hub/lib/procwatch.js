'use strict';
// 裏で動いている AI（codex / claude / agy）の見張り。チャットの AI が nohup や & で別の CLI を起動して
// 自分の番を終えると、Hub では終わったように見えるため、ps で探して「裏で作業中」として出す
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { expandHome } = require('./store');
const processCwd = require('./process-cwd');

const AIS = require('./provider-registry').cliIds;
const INTERVAL = 10000, TIMEOUT = 5000, WARN_EVERY = 5 * 60 * 1000;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// 外のコマンドを動かして出力を返す。終わり方が 0 以外でも出力があれば使う（lsof は一部の番号が無いと 1 で終わる）
function defaultExec(cmd, args, opts = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? TIMEOUT, windowsHide:true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (e, stdout, stderr) => {
      if (e && !(typeof e.code === 'number' && stdout)) return reject(Object.assign(e, {stderr:String(stderr || ''), stdoutBytes:Buffer.byteLength(stdout || ''), elapsedMs:Date.now()-started}));
      resolve(String(stdout || ''));
    });
  });
}

function psArgs(platform) {
  return platform === 'darwin' ? ['-axo', 'pid=,ppid=,lstart=,command='] : ['-eo', 'pid=,ppid=,lstart=,args='];
}

// lstart（例 "Sun Oct  4 12:34:56 2026"）→ ISO。読めなければ ''
function parseLstart(s) {
  const m = String(s).trim().match(/^\S+\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!m || !(m[1] in MONTHS)) return '';
  const d = new Date(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  return isNaN(d) ? '' : d.toISOString();
}

// ps の出力 → [{ pid, ppid, since, command }]。日付は曜日・月・日・時刻・年の5つ
function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*\S)\s*$/);
    if (!m) continue;
    rows.push({ pid: +m[1], ppid: +m[2], since: parseLstart(m[3]), command: m[4] });
  }
  return rows;
}

// コマンドから AI の種類を見分ける（実行する物の名前が codex / claude / agy の時だけ。引数に出てくるだけの物は除く）
const NAME = '(codex|claude|agy|grok)(?:\\.[cm]?js)?(?=\\s|$)';
const RE_FIRST = new RegExp(`^(?:\\S*/)?${NAME}`);
const RE_APP = new RegExp(`^/.*?\\.app/\\S*?/${NAME}`); // 空白のあるアプリの中の場所
const RE_INTERP = new RegExp(`^(?:\\S*/)?(?:node|nodejs|bun|deno)\\s+(?:-\\S+\\s+)*(?:\\S*/)?${NAME}`);
const RE_PKG = /^(?:\S*\/)?(?:node|nodejs|bun)\s+(?:-\S+\s+)*\S*\/@(?:anthropic-ai\/claude-code|openai\/(codex))\/\S+(?=\s|$)/; // npm で入れた物
function aiOf(command) {
  const c = String(command || '').replace(/\\/g,'/').replace(/"([^"\r\n]+)"/g,(_,s)=>s.replace(/ /g,'\ue000')).replace(/\.exe(?=\s|$)/gi,'');
  const m = c.match(RE_FIRST) || c.match(RE_APP) || c.match(RE_INTERP);
  if (m) return m[1];
  const k = c.match(RE_PKG);
  return k ? (k[1] ? 'codex' : 'claude') : '';
}

const WINDOWS_QUERY = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ErrorActionPreference="Stop"; $rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;since=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString("o")}else{""};command=[string]$_.CommandLine;name=[string]$_.Name} }); ConvertTo-Json -InputObject $rows -Compress';
function parseWindows(text) {
  let rows;
  try { rows=JSON.parse(text); }
  catch(e) {
    // Modern V8 parser messages can quote input. Keep the parser diagnosis,
    // but never its raw token/excerpt; the bounded code points are separate.
    const first=String(e.message).split('\n')[0];
    const parseError=first.replace(/Unexpected token.*?(?= in JSON| at position|$)/,'Unexpected token [redacted]').replace(/"[^"\n]*"|'[^'\n]*'/g,'[redacted]').slice(0,200);
    const match=first.match(/position (\d+)/),position=match?Number(match[1]):null;
    const around=position===null?{}:{position,around:Array.from(text.slice(Math.max(0,position-8),position+8)).slice(0,16).map(c=>'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0'))};
    throw Object.assign(Error('程序查詢 JSON 格式無效'),{code:'PROCWATCH_OUTPUT_INVALID',parseStage:'json',parseError,stdoutBytes:Buffer.byteLength(text),...around});
  }
  if(!Array.isArray(rows))throw Object.assign(Error('Windows 程序查詢格式無效'),{code:'PROCWATCH_OUTPUT_INVALID',parseStage:'rows'});
  if(!rows.length)throw Object.assign(Error('Windows 程序查詢沒有完整結果'),{code:'PROCWATCH_EMPTY'});
  return rows.map(r=>{
    if(!r||!Number.isInteger(r.pid)||r.pid<0||!Number.isInteger(r.ppid)||r.ppid<0||typeof r.since!=='string'||typeof r.command!=='string'||typeof r.name!=='string')throw Object.assign(Error('Windows 程序查詢格式無效'),{code:'PROCWATCH_OUTPUT_INVALID',parseStage:'rows'});
    // If a candidate's command line is protected, preserve it as unassigned.
    return {...r,command:r.command||r.name};
  });
}

// 見せる時に、鍵らしい物を伏せる
function cleanCmd(command, limit = 160) {
  return String(command || '')
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*=)\S+/gi, '$1***')
    .replace(/(--?[\w-]*(?:key|token|secret|password)[\w-]*(?:=|\s+))(?!-)\S+/gi, '$1***')
    .replace(/\b(sk-|sk-ant-|ghp_|gho_|github_pat_|xox[bp]-|AIza)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .slice(0, limit);
}

// Hub 自身の子孫を除き、AI の物だけ残す。同じ AI の子（node の包み → 本体など）は親の方だけ残す
function pickAi(rows, selfPid) {
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const underSelf = r => { const seen = new Set(); for (let p = r.ppid; p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) { if (p === selfPid) return true; seen.add(p); if (!byPid.has(p)) break; } return false; };
  const kept = rows.filter(r => r.pid !== selfPid && aiOf(r.command) && !underSelf(r));
  const keptAi = new Map(kept.map(r => [r.pid, aiOf(r.command)]));
  return kept.filter(r => keptAi.get(r.ppid) !== keptAi.get(r.pid)).map(r => ({ ...r, ai: keptAi.get(r.pid) }));
}

// lsof -Fpn の出力 → Map(pid → cwd)
function parseLsof(text) {
  const out = new Map(); let pid = 0;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1) || 0;
    else if (line[0] === 'n' && pid && !out.has(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

// 場所 → プロジェクト・作業。作業の workdir がいちばん長く一致する物、無ければ本体 / 台帳のフォルダ
const pathFor = value => /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
const inside = (dir, cwd) => { if(!dir)return false;const p=pathFor(cwd),rel=p.relative(dir,cwd);return !p.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+p.sep); };
function mapCwd(cwd, projects, baseOf, real = x => x) {
  if (!cwd) return { project: null, task: null };
  let best = null;
  const consider = (dir, project, task) => {
    for (const d of new Set([dir, real(dir)])) if (inside(d, cwd) && (!best || d.length > best.len || (d.length === best.len && task && !best.task))) best = { len: d.length, project, task };
  };
  const paths=pathFor(cwd);
  for (const p of projects || []) for (const t of p.tasks || []) { const wd = expandHome(t.workdir); if (wd) consider(paths.resolve(wd), p.id, t.id); }
  if (best) return { project: best.project, task: best.task };
  for (const p of projects || []) {
    let b = ''; try { b = baseOf ? baseOf(p) : ''; } catch (e) { b = ''; }
    for (const d of [b, p.dir]) if (d) consider(paths.resolve(expandHome(d)), p.id, null);
  }
  return best ? { project: best.project, task: best.task } : { project: null, task: null };
}

// Diagnostics never reuse execFile's command-bearing Error.message. Paths,
// echoed commands and quoted input are removed before status or audit logging.
function diagnosticText(value, limit) {
  return cleanCmd(String(value || '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'')
    .replace(/^.*(?:Command failed:|Get-CimInstance|ConvertTo-Json|powershell(?:\.exe)?|\bps -[ae]|\blsof -|\b(?:node|claude|grok|codex)(?:\.exe)?\s).*$/gim,'[command redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:[^\s/]+\/))[^\s,;]*/g,'[path redacted]')
    .replace(/"[^"\n]*"|'[^'\n]*'/g,'[redacted]'), Infinity).slice(-limit);
}
function failureDetail(e, platform, stage, timeoutMs, elapsedMs, stdoutBytes) {
  let code='PROCWATCH_INTERNAL',extra={};
  if(stage==='internal')extra.message=diagnosticText(String(e.message||'程序查詢內部錯誤').split('\n')[0],200);
  else if(['PROCWATCH_OUTPUT_INVALID','PROCWATCH_EMPTY'].includes(e.code)){
    code=e.code;
    if(code==='PROCWATCH_OUTPUT_INVALID')extra={parseStage:e.parseStage,parseError:e.parseStage==='json'?e.parseError:'程序查詢資料列格式無效',stdoutBytes:e.stdoutBytes??stdoutBytes,...(Number.isSafeInteger(e.position)?{position:e.position,around:e.around}:{})};
  }else if(e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')code='PROCWATCH_OUTPUT_LIMIT';
  else if(e.killed===true||e.signal&&typeof e.code!=='number'){code='PROCWATCH_TIMEOUT';extra.timeoutMs=timeoutMs;}
  else if(typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(e.code)){code='PROCWATCH_SPAWN_FAILED';extra.errno=e.code;}
  else if(typeof e.code==='number'){code='PROCWATCH_EXIT_FAILED';extra.exitCode=e.code;}
  else extra.message=diagnosticText(String(e.message||'程序查詢內部錯誤').split('\n')[0],200);
  return {code,stage,at:new Date().toISOString(),platform,stderr:diagnosticText(e.stderr,1000),
    ...(Number.isFinite(e.elapsedMs??elapsedMs)?{elapsedMs:e.elapsedMs??elapsedMs}:{}),...extra};
}

function create(opts = {}) {
  const platform = opts.platform || process.platform;
  const exec = opts.exec || defaultExec;
  const readlink = opts.readlink || (p => fs.readlinkSync(p));
  const selfPid = opts.selfPid || process.pid;
  const projects = opts.projects || (() => []);
  const baseOf = opts.baseOf;
  const windowsCwds = opts.windowsCwds || processCwd.query;
  const log = opts.log || (m => console.log(m));
  const realCache = new Map();
  const real = d => { if (!realCache.has(d)) { if (realCache.size > 1000) realCache.clear(); let r = d; try { r = fs.realpathSync(d); } catch (e) { r = d; } realCache.set(d, r); } return realCache.get(d); };
  const cwdCache = new Map(); // "pid:since" → cwd
  const listeners = [];
  let current = [], timer = null, inFlight = null, lastWarn = 0, lastLsofWarn = 0;
  let lastFailure = null;
  let status = {state:'unknown',checkedAt:null,error:'尚未取得程序狀態（代碼：PROCWATCH_NOT_READY）',code:'PROCWATCH_NOT_READY'};
  const failed = detail => {
    const changed=status.state!=='unknown'||status.code!==detail.code,now=Date.now();
    lastFailure=detail;status={state:'unknown',checkedAt:status.checkedAt,error:`程序查詢失敗；無法確認是否有背景作業（代碼：${detail.code}）`,code:detail.code,detail};
    if(changed||now-lastWarn>=WARN_EVERY){lastWarn=now;try{log(`[裏の作業の見張り] ${platform==='win32'?'Windows':'ps'} ${detail.code} ${JSON.stringify(detail)}`);}catch{}try{opts.onFailure?.(structuredClone(detail));}catch{}}
  };

  async function cwds(rows) {
    const key = r => `${r.pid}:${r.since}`;
    const need = rows.filter(r => !cwdCache.has(key(r)));
    if (need.length) {
      if (platform === 'darwin') {
        try {
          const found = parseLsof(await exec('lsof', ['-a', '-d', 'cwd', '-p', need.map(r => r.pid).join(','), '-Fpn'], {timeoutMs:TIMEOUT}));
          for (const r of need) if (found.has(r.pid)) cwdCache.set(key(r), found.get(r.pid));
        } catch (e) { const now = Date.now(); if (now - lastLsofWarn >= WARN_EVERY) { lastLsofWarn = now; log(`[裏の作業の見張り] lsof が使えません：${diagnosticText(String(e.message || e).split('\n')[0], 200)}`); } }
      } else {
        for (const r of need) { try { cwdCache.set(key(r), readlink(`/proc/${r.pid}/cwd`)); } catch (e) { /* 他人の物・もう無い */ } }
      }
    }
    const alive = new Set(rows.map(key));
    for (const k of cwdCache.keys()) if (!alive.has(k)) cwdCache.delete(k);
    return rows.map(r => cwdCache.get(key(r)) || '');
  }

  async function scanNow() {
    const started=Date.now(),timeoutMs=platform==='win32'?15000:TIMEOUT;
    let stage='query';
    try {
      let rows,text;
      try {
        text=platform==='win32'?await exec(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',WINDOWS_QUERY],{timeoutMs}):await exec('ps',psArgs(platform),{timeoutMs});
        stage='parse';
        rows=platform==='win32'?parseWindows(text):parsePs(text);
        if(!rows.length)throw Object.assign(Error('程序查詢沒有完整結果'),{code:'PROCWATCH_EMPTY'});
      } catch(e) { failed(failureDetail(e,platform,stage,timeoutMs,Date.now()-started,Buffer.byteLength(text||'')));return current; }
      stage='internal';
      const kept = pickAi(rows, selfPid);
      let cwdResults = [];
      if (platform === 'win32' && kept.length) {
        try {
          cwdResults = await windowsCwds(kept.map(({pid,since}) => ({pid,since})));
          if (!Array.isArray(cwdResults) || cwdResults.length !== kept.length || cwdResults.some((x,i) => !x || x.pid !== kept[i].pid || typeof x.status !== 'string' || typeof x.cwd !== 'string' || typeof x.creationTime !== 'string' || (x.status === 'ok' && (!x.cwd || !processCwd.sameCreation(x.creationTime,kept[i].since))))) throw Error('Invalid cwd result');
        } catch { cwdResults = kept.map(({pid}) => ({pid,creationTime:'',cwd:'',status:'helper-failed'})); }
      }
      const dirs = platform==='win32'?cwdResults.map(x => x.status === 'ok' ? x.cwd : ''):kept.length ? await cwds(kept) : [];
      let all = [];
      let mappingKnown = true;
      if (kept.length) { try { all = projects();if(!Array.isArray(all))throw Error('Invalid projects'); } catch (e) { all = []; mappingKnown = false; } }
      let mappedBaseOf = baseOf;
      if (platform === 'win32') {
        const bases = new Map();
        for (const p of all) {try{bases.set(p.id,baseOf ? baseOf(p) : '');}catch{mappingKnown=false;}}
        mappedBaseOf = p => bases.get(p.id) || '';
      }
      const next = kept.map((r, i) => {
        const mapped = mapCwd(dirs[i], all, mappedBaseOf, real);
        return { pid: r.pid, ai: r.ai, cmd: cleanCmd(r.command), since: r.since, cwd: dirs[i], ...mapped,
          ...(platform === 'win32' ? {cwdStatus:cwdResults[i].status,attribution:mapped.project?'known-related':cwdResults[i].status==='ok'&&mappingKnown?'known-unrelated':'unknown'} : {}) };
      });
      const identity=x=>`${x.pid}:${x.since}`;
      const before = new Set(current.map(identity)), after = new Set(next.map(identity));
      const removed = current.filter(x => !after.has(identity(x))), added = next.filter(x => !before.has(identity(x)));
      current = next;
      status={state:'ok',checkedAt:new Date().toISOString(),error:''};
      if (removed.length || added.length) for (const fn of listeners) { try { fn(current, { added, removed }); } catch (e) { try { log(`[裏の作業の見張り] ${diagnosticText(String(e.message || e).split('\n')[0], 200)}`); } catch {} } }
      return current;
    } catch (e) { failed(failureDetail(e,platform,stage,TIMEOUT,Date.now()-started)); return current; }
  }
  function scan({maxAgeMs=0}={}) {
    if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<0)throw Error('Invalid process snapshot age');
    const age=Date.now()-Date.parse(status.checkedAt);
    if(!inFlight&&maxAgeMs>0&&status.state==='ok'&&age>=0&&age<=maxAgeMs)return Promise.resolve(current);
    if(!inFlight)inFlight=scanNow().finally(()=>{inFlight=null;});
    return inFlight;
  }

  return {
    scan,
    list: () => current.slice(),
    status: () => ({...structuredClone(status),lastFailure:structuredClone(lastFailure),unassigned:current.filter(x=>!x.project&&x.attribution!=='known-unrelated').length,...(platform==='win32'?{unrelated:current.filter(x=>x.attribution==='known-unrelated').length}:{})}),
    assertKnown() { const code=status.state!=='ok'?status.code||'PROCWATCH_NOT_READY':Date.now()-Date.parse(status.checkedAt)>2*INTERVAL?'PROCWATCH_STALE':current.some(x=>!x.project&&x.attribution!=='known-unrelated')?'PROCWATCH_UNASSIGNED_AI':null;if(code)throw Object.assign(Error(`背景程序狀態未知或有未歸屬 AI；請先確認作業已停止（代碼：${code}）`),{code}); },
    onChange: fn => { listeners.push(fn); },
    start(ms = INTERVAL) { if (timer) return; scan().catch(() => {}); timer = setInterval(() => { scan().catch(() => {}); }, ms); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { WINDOWS_QUERY, create, parsePs, parseWindows, parseLstart, parseLsof, aiOf, cleanCmd, pickAi, mapCwd, psArgs };
