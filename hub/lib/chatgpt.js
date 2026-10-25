'use strict';
// ChatGPT との連携（版1）：ChatGPT が MCP（hub/mcp.js）を通って Hub の作業を読み、結果を書き戻す
// 道具の中身はここ（Hub 本体の中）で動かす。mcp.js は Hub に聞くだけ（書くのは Hub だけ）
// 設定は <ROOT>/_hub/chatgpt.json：{ work }（true＝ファイルの書き換え・コマンドの実行も許す。最初は false）
const fs = require('fs');
const path = require('path');
const { spawn } = require('./managed-process');
const cli = require('./cli-platform');
const { localPath } = require('./safe-path');
const scopedFile = require('./scoped-file');
const { expandHome } = require('./store');

const READ_MAX = 200 * 1024, OUT_MAX = 64 * 1024, CMD_MAX_SEC = 120;
const WORK_OFF = '設定で「実作業もできる」をオンにしてください';
// 秘密が入りがちなファイル（OpenAI に送らない）
const SECRET = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.netrc|\.npmrc|\.pypirc)$/i;
// These paths configure AI execution/credentials. Ordinary source-file writes
// must not bypass the separate hook/MCP/config approval flow.
const AI_CONTROL_DIRS = new Set(['.codex','.claude','.gemini','.agents']);
const AI_PRIVATE_FILES = /^(config\.toml|settings(\.local)?\.json|auth\.json|\.?credentials(\.json)?|oauth_creds\.json|mcp(-config)?\.json)$/i;
const SHELL = ['/bin/zsh', '/bin/bash', '/bin/sh'].find(f => fs.existsSync(f)) || 'sh';

const S = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = description => ({ type: 'string', minLength: 1, maxLength: READ_MAX, description });
const id = description => ({ ...str(description), maxLength: 200, pattern: '^(?!\\.\\.?$)[^/\\\\:\\u0000-\\u001f\\u007f]+$' });
const P = id('プロジェクトの ID（hub_list_projects の id）'), T = id('作業の ID（hub_list_tasks の id）');
const commandProperties = process.platform === 'win32' ? {
  file: { ...str('実行ファイル（Windows MCP command sandbox 未対応）'), maxLength: 32768 },
  args: { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 8192 } }
} : { command: str('実行するコマンド（zsh）') };
const TOOLS = [
  { name: 'hub_list_projects', description: 'Project Hub のプロジェクト一覧（ID・名前・状態・フェーズ・作業の数）を返す', inputSchema: S({}, []), read: true },
  { name: 'hub_list_tasks', description: 'プロジェクトの作業一覧（ID・題名・状態・担当・質問・手順）を返す', inputSchema: S({ project: P }, ['project']), read: true },
  { name: 'hub_get_task', description: '作業ファイル（依頼・手順・やったこと・メモ）を返す。task限定の能力ではそのファイルだけ。project単位の能力・従来の連携では台帳PROJECT.md全文も返す。作業を始める前に必ず読む', inputSchema: S({ project: P, task: T }, ['project', 'task']), read: true },
  { name: 'hub_get_chat', description: 'その作業の会話画面の記録（新しい方から limit 件。文字だけ）を返す', inputSchema: S({ project: P, task: T, limit: { type: 'integer', minimum: 1, maximum: 200, description: '何件まで（既定 20）' } }, ['project', 'task']), read: true },
  { name: 'hub_read_file', description: process.platform==='win32'?'授権済み作業フォルダのUTF-8ファイルを読む（先頭200KBまで。フォルダは名前の一覧だけ）':'プロジェクトの台帳フォルダ・本体フォルダ・作業の場所の中のファイルを読む（200KB まで。フォルダなら中身の一覧）', inputSchema: S({ project: P, path: str('読む場所（本体フォルダからの相対、または絶対パス）'), task: T }, ['project', 'path',...(process.platform==='win32'?['task']:[])]), read: true },
  { name: 'hub_report', description: '結果を作業ファイルの「## やったこと」に書き、会話画面に ChatGPT の報告として出す。done=true なら完了の報告（人が確認して完了にする）', inputSchema: S({ project: P, task: T, text: str(process.platform==='win32'?'供使用者閱讀的報告，預設台灣繁體中文；保留使用者指定的語言':'報告の文（人が読む日本語で）'), done: { type: 'boolean', description: '作業が終わったら true' } }, ['project', 'task', 'text']) },
  { name: 'hub_ask_owner', description: '人に質問する（作業を「返事待ち」にして、Hub の「あなたの番」に出す）', inputSchema: S({ project: P, task: T, question: str('人への質問（選択肢があれば文に書く）') }, ['project', 'task', 'question']) },
  { name: 'hub_mark_step', description: '作業ファイルの「## 手順」の index 番目（0から）に印を付ける・外す', inputSchema: S({ project: P, task: T, index: { type: 'integer', minimum: 0, description: '手順の番号（0から）' }, done: { type: 'boolean', description: '終わったら true' } }, ['project', 'task', 'index', 'done']) },
  { name: 'hub_propose_task', description: '新しい作業を提案する（担当 ChatGPT・未着手で作る。中身は「## 次にやること」に入る）', inputSchema: S({ project: P, title: str('作業の題名（40文字くらいまで）'), text: str('やること・理由') }, ['project', 'title', 'text']) },
  { name: 'hub_write_file', description: process.platform === 'win32' ? '【実作業】授權作業根目錄內寫入 UTF-8 檔案（200KB）。新增需 expectedHash="missing"；覆寫需完整原檔 SHA-256，保存原檔與持久紀錄後才寫入。失敗可能 partial，禁止盲目重試。' : '【実作業】プロジェクトの本体フォルダ・作業の場所の中のファイルを書く（親のフォルダも作る。.git の中は不可）', inputSchema: S({ project: P, path: str('書く場所（本体フォルダからの相対、または絶対パス）'), text: { ...str('ファイルの中身（全部）'), minLength: 0 }, task: T, ...(process.platform==='win32'?{expectedHash:{type:'string',pattern:'^(missing|[a-f0-9]{64})$',description:'新增填 missing；覆寫填 hub_read_file 返回的完整 SHA-256'}}:{}) }, ['project', 'path', 'text', ...(process.platform==='win32'?['task','expectedHash']:[])]), work: true },
  ...(process.platform==='win32' ? [
    {name:'hub_request_command',description:'提出 argv 命令核准要求；此工具不執行。須等待使用者於 Hub 確認精確參數及讀取／網路限制。讀取範圍較工作區廣；networkAccess=false 不是完整斷網。',inputSchema:S({project:P,task:T,argv:{type:'array',minItems:1,maxItems:128,items:{type:'string',maxLength:8192}},cwd:{...str('授權作業根目錄的完整路徑'),maxLength:32768},timeoutMs:{type:'integer',minimum:100,maximum:120000},expectedHash:{type:'string',pattern:'^[a-f0-9]{64}$'}},['project','task','argv','cwd','expectedHash']),work:true},
    {name:'hub_get_command_result',description:'讀取同一授權回合的命令核准狀態及執行結果；不批准、不執行。',inputSchema:S({project:P,task:T,id:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}},['project','task','id']),read:true},
    {name:'hub_delegate',description:'僅在此作業有有效工作區執行授權時，委派使用者核准的 CLI 與模型一次，沿用同作業及對話。先讀 hub_get_task 核對本回合授權模型。可能啟動或排隊一次模型請求並計入帳戶用量；無法自選其他 AI、模型、新作業或更大權限。排隊後結束目前回合。',inputSchema:S({project:P,task:T,model:{type:'string',description:'已授權的明確模型 ID；Claude／Grok 可使用 CLI預設，仍須符合 issuer 的 actor 與 model。',minLength:1,maxLength:100,pattern:'^(CLI預設|[a-z0-9][a-z0-9._-]{0,99})$'},title:{...str('短標題'),maxLength:60},text:{...str('交接差分、目標與條件'),maxLength:8000},effort:{type:'string',pattern:'^(中|高|極高|MAX|Ultra)$'}},['project','task','model','title','text']),work:true}
  ] : []),
  { name: 'hub_run_command', description: process.platform === 'win32' ? 'Windows MCP command sandbox 未対応。実行は拒否されます' : '【実作業】プロジェクトの本体フォルダ（または作業の場所）でコマンドを実行する（120秒・出力 64KB まで）', inputSchema: S({ project: P, ...commandProperties, cwd: str('実行する場所（本体フォルダからの相対。省略で本体）'), timeoutSec: { type: 'integer', minimum: 1, maximum: CMD_MAX_SEC, description: '待つ秒数（既定 60）' }, task: T }, ['project', ...(process.platform === 'win32' ? ['file', 'args'] : ['command'])]), work: true },
];

const fail = (status, msg) => { const e = Error(msg); e.status = status; throw e; };
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const real = x => { try { return fs.realpathSync(x); } catch (e) { return path.resolve(x); } };
const within = (x, roots) => roots.some(r => x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
function validate(schema, value) {
  if (Object.hasOwn(schema,'const')&&value!==schema.const)return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    if ((schema.required || []).some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, item]) => validate(schema.properties[key], item));
  }
  if (schema.type === 'string') return typeof value === 'string' && !value.includes('\0') && value.length >= (schema.minLength || 0) && value.length <= (schema.maxLength || READ_MAX) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems || 0) && value.length <= schema.maxItems && value.every(item => validate(schema.items, item));
  return false;
}
const validateArguments = (name, args) => { const tool = TOOLS.find(t => t.name === name); return Boolean(tool && validate(tool.inputSchema, args)); };

class Chatgpt {
  // deps: store, chat（lib/chat）, baseOf, emitRow(project, task, row), ended(project, task), record(action, b, extra)
  constructor({ file, ...deps }) { this.file = file; Object.assign(this, deps); }
  settings() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { work: d.work === true }; } catch (e) { return { work: false }; } }
  save(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(key => key !== 'work') || (o.work !== undefined && typeof o.work !== 'boolean')) fail(400, 'ChatGPT settings are invalid');
    const s = { ...this.settings(), ...(typeof o.work === 'boolean' ? { work: o.work } : {}) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2));
    return s;
  }
  tools(scope) { const work = this.settings().work; return TOOLS.filter(t => (work || !t.work) && !(process.platform === 'win32' && (t.name==='hub_run_command'||['hub_read_file','hub_write_file','hub_request_command','hub_get_command_result'].includes(t.name)&&(!scope?.task||!scope?.rootFingerprint))) && (!scope || scope.tools?.includes(t.name))).map(({ name, description, inputSchema, read }) => ({ name, description, inputSchema, ...(read ? { annotations: { readOnlyHint: true } } : {}) })); }

  project(id) { return this.store.readProject(String(id || '')) || fail(404, `プロジェクト「${id}」が見つかりません（hub_list_projects の id を使ってください）`); }
  task(p, id) { const f = this.store.taskFile(p.id, String(id || '')); return f ? { file: f, t: this.store.readTask(f) } : fail(404, `作業「${id}」が見つかりません（hub_list_tasks の id を使ってください）`); }
  // 読み書きしてよい場所：作業の場所 → 本体 → 台帳（書く時は台帳を除く）
  roots(p, t, write, taskOnly = false) { return [...new Set([t && expandHome(t.workdir), taskOnly ? '' : this.baseOf(p), write || taskOnly ? '' : p.dir].filter(d => d && fs.existsSync(d)).map(d => process.platform === 'win32' ? localPath(path.resolve(d)) : path.resolve(d)))]; }
  resolve(p, t, raw, write, taskOnly = false) {
    raw = String(raw || '').trim();
    if (!raw) fail(400, '場所を指定してください');
    const roots = this.roots(p, t, write, taskOnly);
    if (!roots.length) fail(404, '本体フォルダが見つかりません');
    const abs = raw.startsWith('~') || path.isAbsolute(raw);
    const list = (abs ? [path.resolve(expandHome(raw))] : roots.map(r => path.resolve(r, raw))).filter(x => within(x, roots));
    if (!list.length) fail(403, `プロジェクトの外は${write ? '書けません' : '読めません'}：${raw}`);
    const x = write ? list[0] : list.find(f => fs.existsSync(f)) || fail(404, `見つかりません：${raw}`);
    if (process.platform === 'win32') { try { localPath(x, { allowMissing: write }); } catch { fail(403, 'Windows path is invalid or contains a link'); } }
    const parts = path.relative(roots.find(r => within(x, [r])), x).split(path.sep);
    if (parts.some(part => part.toLowerCase() === '.git')) fail(403, '.git の中は扱えません');
    if (SECRET.test(path.basename(x))) fail(403, `秘密が入っていそうなファイルは扱えません：${path.basename(x)}`);
    // つながり（シンボリックリンク）で外へ出ていないか
    let probe = x; while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!within(real(probe), roots.map(real))) fail(403, `プロジェクトの外を指しています：${raw}`);
    return x;
  }
  optTask(p, id) { return id ? this.task(p, id).t : null; }
  windowsFilePath(scope,t,raw,write) {
    if(!scope?.task||!scope.root||typeof scope.rootFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(scope.rootFingerprint)||!t||!t.workdir||!path.isAbsolute(expandHome(t.workdir))||path.resolve(expandHome(t.workdir)).toLowerCase()!==scope.root.toLowerCase())fail(403,'MCP 作業根目錄已變更或未綁定能力授權');
    if(typeof raw!=='string'||raw.startsWith('~')||raw.replace(/\\/g,'/').split('/').includes('..'))fail(403,'不接受未授權的檔案路徑');
    const file=path.isAbsolute(raw)?path.resolve(raw):path.resolve(scope.root,raw), relative=path.relative(scope.root,file);
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)||relative.split(path.sep).some(part=>part.toLowerCase()==='.git')||SECRET.test(path.basename(file)))fail(403,'不接受未授權的檔案路徑');
    const parts=relative.split(path.sep).map(part=>part.toLowerCase()), control=parts.some(part=>AI_CONTROL_DIRS.has(part));
    if((write&&control)||(control&&AI_PRIVATE_FILES.test(path.basename(file)))||parts[parts.length-1]==='.mcp.json')fail(403,'AI 執行設定及憑證須使用專用核准流程');
    const project=this.project(scope.project), hubRelative=path.relative(project.dir,file), hubParts=hubRelative.split(path.sep).map(part=>part.toLowerCase());
    if(!path.isAbsolute(hubRelative)&&hubRelative!=='..'&&!hubRelative.startsWith('..'+path.sep)&&(hubParts[0]==='.ai'||hubParts.length===1&&hubParts[0]==='project.md'))fail(403,'Hub 控制資料須使用同作業範圍的專用工具');
    if(write&&!relative)fail(400,'不能寫入資料夾');return {file,relative};
  }

  async call(name, a = {}, scope) {
    const def = TOOLS.find(t => t.name === name);
    if (!def) fail(404, `その道具はありません：${name}`);
    if (!validate(def.inputSchema, a)) fail(400, 'Tool arguments do not match the input schema');
    if (scope && (!scope.tools?.includes(name) || (name !== 'hub_list_projects' && a.project !== scope.project) ||
        (scope.task && !['hub_list_projects', 'hub_list_tasks'].includes(name) && a.task !== scope.task))) fail(403, 'MCP capability scope does not match');
    if (process.platform === 'win32' && name === 'hub_run_command') fail(409, 'Windows MCP command sandbox 尚未完成；未執行命令');
    if(process.platform==='win32'&&scope?.workspaceRun){if(typeof this.validateWorkspaceScope!=='function')fail(403,'工作區授權不可驗證');await this.validateWorkspaceScope(scope);}
    if (def.work && !this.settings().work) fail(403, WORK_OFF);
    if(name==='hub_delegate') {
      if(!scope?.task||!scope.rootFingerprint||scope.delegationModel!==a.model||typeof this.delegate!=='function')fail(403,'此作業未授權該 CLI 模型委派');
      return this.delegate(scope,a);
    }
    if(process.platform==='win32' && ['hub_request_command','hub_get_command_result'].includes(name)) {
      if(!scope?.taskHash||!this.commandIntents)fail(403,'命令要求未綁定此作業與授權回合');
      // Reports/step updates are allowed by the same grant. Capture the task's
      // current hash for each new intent; approval still binds that snapshot.
      const currentTask=this.task(this.project(scope.project),scope.task).t;
      const commandScope={...scope,taskHash:currentTask.completionHash,run:scope.runId};
      return name==='hub_request_command' ? this.commandIntents.request(commandScope,{argv:a.argv,cwd:a.cwd,expectedHash:a.expectedHash,...(a.timeoutMs===undefined?{}:{timeoutMs:a.timeoutMs})}) : this.commandIntents.get(commandScope,a.id);
    }
    const log = extra => this.record('chatgpt', { project: a.project, task: a.task, ai: 'chatgpt' }, { tool: name, ...extra });
    if (name === 'hub_list_projects') return this.store.listProjects().filter(p => !scope || p.id === scope.project).map(p => {
      const tasks = p.tasks.filter(t => !scope?.task || t.id === scope.task), counts = { all: tasks.length };
      for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;
      return { id: p.id, name: p.name, status: p.status, description: p.description, phases: p.phases.map(ph => ({ name: ph.name, state: ph.state })), counts };
    });
    const p = this.project(a.project);
    if (name === 'hub_list_tasks') return p.tasks.filter(t => !scope?.task || t.id === scope.task).map(t => ({ id: t.id, title: t.title, state: t.state, owner: t.owner, question: t.question, steps: t.steps }));
    if (name === 'hub_get_task') {
      const { file, t } = this.task(p, a.task);
      const pf = path.join(p.dir, 'PROJECT.md');
      if(scope?.task)return `# 作業ファイル（${file}）\n状態：${t.state}\n作業 SHA-256：${t.completionHash}${scope.delegationModel?`\n授權委派模型：${scope.delegationModel}；剩餘委派：${scope.remainingDelegations}`:''}\n\n${fs.readFileSync(file,'utf8')}`;
      return `# 作業ファイル（${file}）\n状態：${t.state}\n\n${fs.readFileSync(file, 'utf8')}\n\n# 台帳（${pf}）\n\n${fs.readFileSync(pf, 'utf8')}`;
    }
    if (name === 'hub_get_chat') {
      this.task(p, a.task);
      const n = Math.min(200, Math.max(1, Number(a.limit) || 20));
      return this.chat.read(p.dir, a.task).filter(r => r.text && r.role !== 'event').slice(-n).map(r => ({ role: r.role, ai: r.ai || r.to || '', text: r.text, at: r.at }));
    }
    if (name === 'hub_read_file') {
      if(process.platform==='win32') {
        const t=this.optTask(p,a.task), target=this.windowsFilePath(scope,t,a.path,false), result=await scopedFile.read(scope.root,target.relative,scope.rootFingerprint);
        if(result.kind==='directory')return {path:target.file,entries:result.entries,limit:result.limit,truncated:result.truncated};
        return `# ${target.file}${result.truncated?`（${result.size} バイトのうち先頭 ${result.bytesRead} バイト；無完整檔案雜湊）`:''}${result.sha256?`\nSHA-256: ${result.sha256}`:''}\n\n${result.text}`;
      }
      const f = this.resolve(p, this.optTask(p, a.task), a.path, false, Boolean(scope?.task)), st = fs.statSync(f);
      if (st.isDirectory()) return { path: f, entries: fs.readdirSync(f, { withFileTypes: true }).slice(0, 500).map(d => d.name + (d.isDirectory() ? '/' : '')) };
      const buf = Buffer.alloc(Math.min(st.size, READ_MAX)), fd = fs.openSync(f, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      if (buf.includes(0)) fail(415, `文字のファイルではないため読めません：${path.basename(f)}`);
      return `# ${f}${st.size > READ_MAX ? `（${st.size} バイトのうち先頭 ${READ_MAX} バイト）` : ''}\n\n${buf.toString('utf8')}`;
    }
    if (name === 'hub_report') {
      const { t } = this.task(p, a.task), text = String(a.text || '').trim();
      if (!text) fail(400, '報告の文を書いてください');
      const [first, ...rest] = text.split(/\r?\n/);
      this.store.appendSection(p.id, t.id, 'やったこと', [`- ${stamp()} ChatGPT：${first}`, ...rest.map(l => (l.trim() ? '  ' + l : ''))].join('\n'));
      if (a.done === true) this.store.updateTask(p.id, t.id, { state: '完了', question: '' });
      this.emitRow(p.id, t.id, this.chat.append(p.dir, t.id, { role: 'assistant', ai: 'chatgpt', text }));
      this.ended(p.id, t.id); log({ done: a.done === true });
      return { ok: true, state: this.task(p, t.id).t.state };
    }
    if (name === 'hub_ask_owner') {
      const { t } = this.task(p, a.task), q = String(a.question || '').trim();
      if (!q) fail(400, '質問を書いてください');
      this.store.updateTask(p.id, t.id, { state: '返事待ち', question: q.replace(/\s+/g, ' ').slice(0, 300) });
      this.emitRow(p.id, t.id, this.chat.append(p.dir, t.id, { role: 'assistant', ai: 'chatgpt', text: `【質問】${q}` }));
      this.ended(p.id, t.id); log({});
      return { ok: true, state: '返事待ち', note: '人の返事は ChatGPT のこの会話か、Hub の作業ファイルのメモに来ます' };
    }
    if (name === 'hub_mark_step') {
      this.task(p, a.task);
      const t = this.store.setStep(p.id, a.task, a.index, a.done) || fail(400, 'その手順が見つかりません');
      log({ index: a.index, done: a.done });
      return { ok: true, steps: t.steps };
    }
    if (name === 'hub_propose_task') {
      const title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!title) fail(400, '題名を書いてください');
      const t = this.store.createTask(p.id, { title, owner: 'chatgpt' }) || fail(400, '作業を作れませんでした');
      if (String(a.text || '').trim()) this.store.appendSection(p.id, t.id, '次にやること', String(a.text).trim());
      this.record('chatgpt', { project: p.id, task: t.id, ai: 'chatgpt' }, { tool: name, title });
      return { ok: true, task: t.id, title, state: '未着手' };
    }
    if (name === 'hub_write_file') {
      if(process.platform==='win32') {
        const t=this.optTask(p,a.task),target=this.windowsFilePath(scope,t,a.path,true),result=a.expectedHash==='missing' ? await scopedFile.create(scope.root,target.relative,a.text,a.expectedHash,scope.rootFingerprint) : await scopedFile.overwrite(scope.root,target.relative,a.text,a.expectedHash,scope.rootFingerprint,{root:scope.journalRoot,rootFingerprint:scope.journalRootFingerprint});
        try{log({path:target.file,bytes:result.bytes,sha256:result.sha256,...(result.recordId?{recordId:result.recordId}:{}),created:result.created===true,overwritten:result.overwritten===true});}catch{const error=Error('檔案已寫入，但操作記錄未成功；請人工確認，勿自動重試');error.status=500;error.partial=true;error.created=result.created===true;error.overwritten=result.overwritten===true;error.recordId=result.recordId;throw error;}return {ok:true,path:target.file,bytes:result.bytes,sha256:result.sha256,created:result.created===true,overwritten:result.overwritten===true,...(result.recordId?{recordId:result.recordId,beforeHash:result.beforeHash}: {})};
      }
      const f = this.resolve(p, this.optTask(p, a.task), a.path, true, Boolean(scope?.task));
      if (typeof a.text !== 'string') fail(400, '中身（text）を指定してください');
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) fail(400, 'フォルダには書けません');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, a.text);
      log({ path: f, bytes: Buffer.byteLength(a.text) });
      return { ok: true, path: f, bytes: Buffer.byteLength(a.text) };
    }
    if (name === 'hub_run_command') {
      const t = this.optTask(p, a.task), command = String(a.command || '').trim();
      if (!command) fail(400, 'コマンドを書いてください');
      const cwd = a.cwd ? this.resolve(p, t, a.cwd, true) : this.roots(p, t, true)[0] || fail(404, '本体フォルダが見つかりません');
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(400, `フォルダではありません：${cwd}`);
      const r = await run(command, cwd, Math.min(CMD_MAX_SEC, Math.max(1, Number(a.timeoutSec) || 60)));
      log({ command: command.slice(0, 300), cwd, code: r.code, timedOut: r.timedOut });
      return { cwd, ...r };
    }
    return fail(404, `その道具はありません：${name}`);
  }
}

// コマンドを動かす：時間を過ぎたら子のプロセスごと止める。出力は合わせて 64KB まで
function run(command, cwd, sec) {
  return new Promise(resolve => {
    const out = { stdout: '', stderr: '' }; let size = 0, truncated = false, timedOut = false;
    if (process.platform === 'win32') return fail(409, 'Windows MCP command sandbox 尚未完成；未執行命令');
    const invocation = cli.resolve(SHELL, ['-lc', command]);
    const child = spawn(invocation.file, invocation.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = k => c => { if (size >= OUT_MAX) { truncated = true; return; } const s = c.toString('utf8').slice(0, OUT_MAX - size); size += s.length; out[k] += s; if (s.length < c.length) truncated = true; };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); } }, sec * 1000);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, ...out, stderr: out.stderr + String(e.message), truncated, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, ...out, truncated, timedOut }); });
  });
}

module.exports = { Chatgpt, TOOLS, WORK_OFF, validateArguments };
