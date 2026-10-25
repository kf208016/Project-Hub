'use strict';
const {MAX_WALL_MS}=require('./lib/native-turn-limits');
// Project Hub 第2版：台帳の一覧、画面の中の作業画面、役割・モデル・思考の設定
// 使い方: node server.js  →  http://127.0.0.1:4545
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store, expandHome } = require('./lib/store');
const launch = require('./lib/launch');
const providers = require('./lib/provider-registry');
const taskWrites = require('./lib/task-write-lock');
const roles = require('./lib/roles');
const { Sessions } = require('./lib/sessions');
const gitw = require('./lib/git');
const transcript = require('./lib/transcript');
const chat = require('./lib/chat');
const start = require('./lib/start');
const { AiTools } = require('./lib/ai-tools');
const { Usage } = require('./lib/usage');
const { LimitEvidence } = require('./lib/limit-evidence');
const remoteLib = require('./lib/remote');
const localAuthLib = require('./lib/local-auth');
const { guidance } = require('./lib/guidance');
const instructions = require('./lib/instructions');
const { AsyncLocalStorage } = require('async_hooks');

const PORT = Number(process.env.HUB_PORT || 4545);
const ROOT = expandHome(process.env.HUB_ROOT || path.join(os.homedir(), 'Documents', 'AI-Workspace'));
const webAdmission=process.platform==='win32'?require('./lib/web-chat-admission'):null;
const RECOVERY_ONLY=process.env.HUB_RECOVERY_ONLY==='1';
const dataAdmission=webAdmission?.check(ROOT,{hubDir:__dirname,recoveryOnly:RECOVERY_ONLY});
if(RECOVERY_ONLY){
  const recovery=require('./lib/web-chat-recovery-server').create({root:ROOT,hubDir:__dirname,port:PORT,secret:process.env.HUB_LOCAL_TOKEN,admission:dataAdmission});
  delete process.env.HUB_LOCAL_TOKEN;
  module.exports=recovery;
  if(require.main===module)recovery.server.listen(PORT,'127.0.0.1',()=>console.log('Project Hub recovery-only '+recovery.server.address().port));
  return;
}
if(process.platform==='win32')require('./lib/native-dependencies').apply(ROOT);
const DRY = process.env.HUB_DRY_RUN === '1'; // テスト用：実際には起動しない
const LOCAL_TOKEN = process.env.HUB_LOCAL_TOKEN || '';
delete process.env.HUB_LOCAL_TOKEN; // Never pass the browser credential to an AI child process.
const localAuth = LOCAL_TOKEN ? localAuthLib.create(LOCAL_TOKEN) : null;
const {readSmallJson}=require('./lib/small-json-body');
const {BrowserLoginFSM}=require('./lib/browser-login');
const browserLogin=localAuth&&Number.isInteger(PORT)&&PORT>=1024&&PORT<=65535
  ?require('./lib/browser-login-http').create({auth:localAuth,port:PORT,readBody:readSmallJson,send,fsm:new BrowserLoginFSM()}):null;
const { CapabilityAuth, READ_TOOLS } = require('./lib/capability-auth');
const mcpCapabilities = new CapabilityAuth();
const limitEvidence = new LimitEvidence(path.join(ROOT, '_hub', 'limits.json'));
const usage = new Usage({ dry: DRY, observe: snapshot => {
  try { limitEvidence.observe(snapshot); } catch { /* 保存失敗では直前の保持状態を維持 */ }
} });
async function refreshLimitEvidence(request) {
  if (request.ai !== 'claude' || launch.flagFor('claude', request.model) !== 'claude-fable-5-1' ||
      request.limitSwitch || !fableBackup(rolesData(), request.role) || !limitEvidence.needsRefresh()) return;
  let timer;
  try {
    await Promise.race([usage.status(true), new Promise(resolve => { timer = setTimeout(resolve, 20000); })]);
  } catch { /* 取得失敗では上限継続として扱わない */ } finally { clearTimeout(timer); }
}
const PUBLIC = path.join(__dirname, 'public');
const ROLES_FILE = path.join(ROOT, '_hub', 'roles.yaml');
const store = new Store(ROOT);
const projectOrder = new (require('./lib/project-order').ProjectOrder)(store);
// 外から使う（iPhone）の設定と、今の要求が外からかどうか（記録に「外から」と印を付けるため）
const remote = new remoteLib.Remote({ file: path.join(ROOT, '_hub', 'remote.json') });
const nativeRemote = process.platform==='win32' ? new (require('./lib/windows-remote').WindowsRemote)({root:ROOT,handle:async(req,res,url)=>{try{await reqCtx.run({remote:true,transport:'tls'},()=>remoteGate(req,res,url));}catch(error){if(res.headersSent){res.destroy();return;}if(error.code==='WORKSPACE_REQUIRED'&&error.workspaceRequired===true)return send(res,409,nativeWorkspaceError(error,error.task));return send(res,500,{error:'HTTPS 操作失敗，請在本機檢查交易狀態'});}}}) : null;
const reqCtx = new AsyncLocalStorage();
const fromRemote = () => Boolean(reqCtx.getStore()?.remote);
const localOwner = req => !fromRemote() && !reqCtx.getStore()?.mcpScope && req.headers.authorization === undefined;
const sessions = new Sessions();
const nativeProviderResources=new Map();
const nativeProviderService=process.platform==='win32'&&!DRY?new(require('./lib/native-provider-service').NativeProviderService)({
  resolveWorkspace:(project,task)=>workspaceReview.verifiedBinding(project,task),
  profile:async (actor,{identity})=>{
    const ownerHome=os.homedir(),npm=path.join(ownerHome,'AppData','Roaming','npm','node_modules');
    const codexProfile=reviewedCodexProfile(),codexFile=codexProfile.file;
    const runtimeBase=(await require('./lib/native-runtime-base').resolve(ownerHome,{identity})).physicalBase;
    const gitFile=require('./lib/cli-platform').find('git');
    if(!gitFile||!['cmd','bin'].includes(path.basename(path.dirname(gitFile)).toLowerCase()))throw Error('固定 Git runtime 尚未核對');
    return {ownerHome,runtimeBase,providerFile:actor==='claude'?await require('./lib/native-provider-binary').claudeFile(ownerHome,runtimeBase,{identity}):path.join(ownerHome,'.grok','bin','grok.exe'),
      codexFile,codexSHA256:codexProfile.binaryHash,nodeFile:process.execPath,gitDirectory:path.dirname(path.dirname(gitFile)),
      hubLibDirectory:path.join(__dirname,'lib'),systemRoot:process.env.SystemRoot||'C:\\Windows'};
  },
  modelFlag:(actor,model)=>launch.flagFor(actor,model),
  effortFlag:(actor,effort)=>launch.EFFORT_FLAG[actor]?.[effort]||(['minimal','low','medium','high','xhigh','max','ultra'].includes(effort)?effort:effort?'':'low'),
  supervisedSpawn:require('./lib/managed-process').spawn,mcpFor:nativeProviderMcp,dispose:nativeProviderDispose,
  httpFor:context=>{const owned=nativeProviderResources.get(context.runId);return owned&&owned.actor===context.actor&&owned.project===context.project&&owned.task===context.task?owned.mcpProxy.handle:null;},
  toolPolicyFor:context=>{
    const owned=nativeProviderResources.get(context.runId);if(!owned||owned.actor!==context.actor)return null;
    return {root:context.dir,modelFlag:context.modelFlag,commandsApproved:true,subagentsApproved:true,
      mcpTools:owned.tools.map(name=>context.actor==='claude'?'mcp__hub__'+name:'hub__'+name)};
  },
  recordDecision:(context,row,decision)=>record('native-provider-tool-decision',{project:context.project,task:context.task,ai:context.actor},{runId:context.runId,tokenHash:crypto.createHash('sha256').update(row.token).digest('hex'),decision,source:'owner-approved-development-scope'})
}):null;
const nativeProviderOptions=()=>nativeProviderService?{nativeAuthorities:nativeProviderService.authorities()}:{};
const chats = new chat.ChatRunner({ dirOf: id => { const p = store.readProject(id); return p ? p.dir : ''; },
  ...(nativeProviderService?{nativeProviders:nativeProviderService.handlers()}:{}),
  delegates: (p, t) => [...readLog(5000), ...readLog(5000, LOG_FILE.replace(/\.jsonl$/, '.old.jsonl'))].filter(r => r.project === p && r.task === t),
  permFor: chatPermCmd,
  limitBackup: o => fableBackup(rolesData(), o.role),
  limitPreflight: () => limitEvidence.active(),
  beforeQueued: async o => {if(process.platform==='win32'){if(o.ai==='codex')await ensureCodexCatalog(15000);const p=store.readProject(o.project);await workspaceReview.verifiedBinding(o.project,o.task,{verifySource:Boolean(p&&github.locked(baseOf(p)))});workspaceRuntime.assertStart(o.project,o.task,o.workspaceFlow,o.dir);assertNativeCliPresent(o.ai);await prepareNativeProviderTurn(o);}await refreshLimitEvidence(o);},
  onLimit: o => {
    try { limitEvidence.record(o); }
    catch (e) { record('limit-save-error', o); throw e; }
    void usage.status(true).catch(() => {});
  },
  onFableSuccess: started => limitEvidence.success(started),
  refreshQueued: o => {
    const p = store.readProject(o.project), t = p?.tasks.find(t => t.id === o.task);
    if (!p || !t) throw Error('作業が見つかりません');
    const dir = o.dir && fs.existsSync(o.dir) ? o.dir : workDir(p, t).dir;
    if (!dir || !fs.existsSync(dir)) throw Error('作業場所を用意できませんでした');
    if(process.platform==='win32')workspaceRuntime.assertStart(p.id,t.id,o.workspaceFlow,dir);
    return { dir, policy: modelPolicy(p, t), basePrompt: taskPrompt(p, t, store.taskFile(p.id, t.id), dir) + ' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。' };
  },
  canStart: (ai, model, o) => {
    if (aiTools.isOperating()) return 'AI の更新・モデル再取得が進行中です';
    const invalid=modelError(ai,model)||nativeEffortError(ai,model,o?.effort); if(invalid)return invalid;
    if(o) { const p=store.readProject(o.project), t=p?.tasks.find(t=>t.id===o.task);
      if(!p || !t)return '作業が見つかりません';
      if(o.requireModel && t.state === '完了')return DELEGATE_COMPLETED_ERROR;
      if(o.requireModel) {const blocked=delegateTerminalError(p.id,t.id);if(blocked)return blocked;}
      try {if(process.platform==='win32'){workspaceRuntime.assertStart(p.id,t.id,o.workspaceFlow,o.dir);o.nativeRootPin=nativeRootPin(p.id,t.id);}assertWorkspaceIdle(p,t,false,false,o.workspaceFlow);} catch(e) {return e.message;}
    }
    return '';
  } });
const { Maintenance } = process.platform==='win32'?{Maintenance:require('./lib/native-maintenance').NativeMaintenance}:require('./lib/maintenance');
const emptyLib = require('./lib/empty');
const maintenance = new Maintenance({store,baseOf,busy:id=>{
  const p=store.readProject(id);if(!p)return false;
  const all=store.listProjects(), familyIds=require('./lib/work-context').family(p,all).map(q=>q.id);
  const base=fs.realpathSync(baseOf(p));
  if (github.locked(base) || process.platform === 'win32' && (reviewedMerge.locked(base)||taskTransfer.nativeActive()||taskIntegrate.nativeActive()||nativeEmpty?.nativeBusy(id)||workspaceReview.operations.size||[...workspaceReview.runs.values()].some(x=>x.record.project===id))) return true;
  const active=[...sessions.list().filter(x=>x.running),...[...chats.running.keys()].map(k=>({project:k.split('\u0000')[0]}))];
  return procwatch.list().some(x=>x.project && (familyIds.includes(x.project)||all.some(q=>q.id===x.project&&fs.realpathSync(baseOf(q))===base))) || active.some(a=>{const q=all.find(x=>x.id===a.project);return q && (familyIds.includes(q.id) || fs.realpathSync(baseOf(q))===base);});
}});
const {Removal}=require('./lib/remove');
const removal=new Removal({store,locked:id=>{const p=store.readProject(id);return p?maintenance.locked(id) || process.platform === 'win32' && (maintenance.nativeBusy(id)||reviewedMerge.locked(baseOf(p))):false;},busy:(project,task)=>
  sessions.list().some(x=>x.running&&x.project===project&&(!task||x.task===task)) ||
  [...chats.running.keys()].some(k=>k.split('\u0000')[0]===project&&(!task||k.split('\u0000')[1]===task)) ||
  procwatch.list().some(x=>x.project===project&&(!task||!x.task||x.task===task)) ||
  process.platform==='win32'&&(workspaceReview.operations.size||[...workspaceReview.runs.values()].some(x=>x.record.project===project&&(!task||x.record.task===task)))});
const aiTools = new AiTools({ root: ROOT, dry: DRY, busy: () => sessions.list().filter(x => x.running).length + chats.running.size });
function reviewedCodexProfile() {
  return require('./lib/native-codex-profile').resolve({updater:aiTools.nativeUpdater,file:require('./lib/cli-platform').find('codex')});
}
// The model catalog must come from the Codex the chat bridge actually runs: PATH resolution, which the
// native updater keeps pointed at its active slot. An npm JS entry maps to its packaged vendor binary.
function codexCatalogFile() {
  const resolved=require('./lib/cli-platform').resolveProvider('codex',[],process.env.PATH);
  if(resolved.file!==process.execPath)return resolved.file;
  const entry=resolved.args[0],vendor=path.join(path.dirname(path.dirname(entry)),'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  return fs.existsSync(vendor)?vendor:entry;
}
function applyModelCatalog() {
  const catalog = aiTools.catalog();
  // Known CLI catalogs replace roles.yaml names in the picker; saved aliases still resolve.
  const shown=process.platform==='win32'&&catalog.codex.models.length?{...catalog,codex:{...catalog.codex,models:[{id:'',label:launch.CLI_DEFAULT_LABEL},...catalog.codex.models.filter(row=>row.label!==launch.CLI_DEFAULT_LABEL)]}}:{...catalog};
  for(const ai of ['claude','grok'])if(process.platform==='win32'&&catalog[ai].models.length)shown[ai]={...catalog[ai],models:[{id:'',label:launch.CLI_DEFAULT_LABEL},...catalog[ai].models.filter(row=>row.label!==launch.CLI_DEFAULT_LABEL)]};
  launch.setDiscoveredModels(shown);
  roles.setModelCatalog(shown);
}
const nativeCatalogCheckedAt={claude:-Infinity,grok:-Infinity};
function ensureNativeCatalog(ai){
  if(process.platform!=='win32'||Date.now()-nativeCatalogCheckedAt[ai]<30000)return;
  nativeCatalogCheckedAt[ai]=Date.now();
  try{aiTools.refreshNativeCatalogFromCache(ai,{ifChanged:true});applyModelCatalog();}catch{/* Missing or malformed cache retains the previous catalog. */}
}
for(const ai of ['claude','grok'])ensureNativeCatalog(ai);
applyModelCatalog();
if(process.platform==='win32'&&!DRY){
  try{const file=codexCatalogFile();aiTools.setCodexBinary(file);void aiTools.refreshCodexCatalog({file}).then(applyModelCatalog).catch(()=>{});}catch{/* request-time refresh retains unknown admission */}
}
async function ensureCodexCatalog(timeout=15000){
  if(process.platform!=='win32'||DRY)return;
  let file;try{file=codexCatalogFile();aiTools.setCodexBinary(file);}catch{return;}
  const catalog=aiTools.catalog().codex,refreshed=Date.parse(catalog.refreshedAt),fresh=aiTools.codexAvailability(launch.CLI_DEFAULT_LABEL)!=='unknown'&&Number.isFinite(refreshed)&&Date.now()-refreshed<=600000;
  if(fresh)return;
  const pending=aiTools.refreshCodexCatalog({file}).then(applyModelCatalog).catch(()=>{});
  let timer;try{await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(resolve,timeout);})]);}finally{clearTimeout(timer);}
}

// 版：起動した時の番号と、ファイル上の番号（更新を取り込むと変わる）
const PKG = path.join(__dirname, 'package.json');
// 版の番号：package.json が変わっていなければ読み直さない（一覧のたびに読んでいた）
let pkgSeen = null;
const readVersion = () => {
  try {
    const st = fs.statSync(PKG), key = `${st.mtimeMs}:${st.size}`;
    if (!pkgSeen || pkgSeen.key !== key) pkgSeen = { key, version: JSON.parse(fs.readFileSync(PKG, 'utf8')).version || '' };
    return pkgSeen.version;
  } catch (e) { return ''; }
};
const VERSION = readVersion();
function changelog(n) {
  let text = '';
  try { text = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    const m = head.match(/^([\d.]+)\s*（?([^）]*)）?/);
    out.push({ version: m ? m[1] : head.trim(), date: m ? m[2] : '', items: rest.filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, '').trim()) });
    if (out.length >= n) break;
  }
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// このパソコンの画面からの操作だけ受け付ける
function allowed(req) {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return false;
  return req.headers['x-hub'] === '1';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks=[];let size=0;
    req.on('data', c => { size+=c.length;if(size>2*1024*1024){reject(Object.assign(Error('JSON 請求超過 2 MiB'),{status:413}));req.destroy();}else chunks.push(c); });
    req.on('end', () => { try { const data=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));resolve(data?JSON.parse(data):{}); } catch {reject(Object.assign(Error('JSON 或 UTF-8 請求格式無效'),{status:400}));} });
    req.on('error',reject);
  });
}

// 操作の記録（_hub/log.jsonl に1行ずつ）。1MB を超えたら log.old.jsonl に回す
const LOG_FILE = path.join(ROOT, '_hub', 'log.jsonl');
function record(action, b, extra) {
  const strictFileRecord = process.platform === 'win32' && (action === 'chatgpt' && extra?.tool === 'hub_write_file' || ['commandapprove','mcpregister','mcpgrant','mcprevoke','workspaceapprove','workspace-destination-intent','workspace-destination-preview','native-provider-tool-decision','native-provider-mcp','native-provider-approve'].includes(action));
  try {
    if (strictFileRecord) require('./lib/safe-path').localPath(LOG_FILE, { allowMissing: true });
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      const old = LOG_FILE.replace(/\.jsonl$/, '.old.jsonl');
      if (strictFileRecord) require('./lib/safe-path').localPath(old, { allowMissing: true });
      fs.renameSync(LOG_FILE, old);
    }
    const row = { at: new Date().toISOString(), action, project: b.project, task: b.task, ai: b.ai || b.to, ...(extra || {}), ...(fromRemote() ? { remote: true } : {}) };
    if (strictFileRecord) {
      const fd = fs.openSync(LOG_FILE, 'a');
      try { fs.writeFileSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  } catch (e) { if (strictFileRecord) throw Error('MCP 檔案操作紀錄未能保存'); /* 既有其他記錄仍是 best effort。 */ }
}
function readLog(n, file = LOG_FILE) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}

// 受け取ったファイルの置き場：AI-Workspace/Inbox/hub/<日付>/<時刻>-<名前>（場所に空白が入らないように）
const MAX_UPLOAD = 50 * 1024 * 1024;
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function saveUpload(name, data) {
  const d = new Date(), z = x => String(x).padStart(2, '0');
  const day = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
  const time = `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  const safe = path.basename(String(name || 'file')).replace(/[\x00-\x1f\x7f/\\:*?"<>|\s]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const dir = path.join(ROOT, 'Inbox', 'hub', day);
  fs.mkdirSync(dir, { recursive: true });
  let f = path.join(dir, `${time}-${safe}`), i = 1;
  while (fs.existsSync(f)) f = path.join(dir, `${time}-${i++}-${safe}`);
  fs.writeFileSync(f, data);
  return f;
}

// CLI に渡すモデル名（設定画面で直せる）。空の文字＝モデルを指定しない（CLI の既定）
const CLI_MODELS = path.join(ROOT, '_hub', 'cli-models.json');
function loadCliModels() {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(CLI_MODELS, 'utf8')); } catch (e) { o = {}; }
  // 4.5.1 までに「断られたので渡さない」と自動で覚えた空の名前は、推測した名前へのものなので消す（1回だけ）
  if (o && !o.v && Object.keys(o).length) {
    for (const ai of launch.AIS) for (const [k, v] of Object.entries(o[ai] || {})) if (v === '') delete o[ai][k];
    o.v = 2;
    try { fs.writeFileSync(CLI_MODELS, JSON.stringify(o, null, 2)); } catch (e) { /* 書けなくても続ける */ }
  }
  launch.setOverrides(o);
}
function saveCliModels(o) { fs.mkdirSync(path.dirname(CLI_MODELS), { recursive: true }); fs.writeFileSync(CLI_MODELS, JSON.stringify({ ...o, v: 2 }, null, 2)); loadCliModels(); }
loadCliModels();
// 候補：CLI 自身の設定から、実際に使えそうなモデル名を集める
function cliModelHints() {
  const home = process.env.HUB_AI_HOME || os.homedir();
  const catalog = aiTools.catalog();
  const out = { claude: new Set(catalog.claude.models.map(x => x.id)), codex: new Set(catalog.codex.models.map(x => x.id)), agy: new Set(catalog.agy.models.map(x => x.id)),grok:new Set(['grok-4.6']) };
  try { const m = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m); if (m) out.codex.add(m[1]); } catch (e) { /* 無い */ }
  try { const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); if (j.model) out.claude.add(j.model); } catch (e) { /* 無い */ }
  return { claude: [...out.claude], codex: [...out.codex], agy: [...out.agy],grok:[...out.grok] };
}

function rolesData() {
  const data=roles.read(ROLES_FILE).data;
  if(process.platform==='win32')for(const [ai,key,fallback] of [['claude','claude-code','Sonnet'],['grok','grok','Grok 4.6']]){
    const models=aiTools.catalog()[ai].models;
    data.models[key]=models.length?[launch.CLI_DEFAULT_LABEL,...models.map(row=>row.label).filter(label=>label!==launch.CLI_DEFAULT_LABEL)]:[launch.CLI_DEFAULT_LABEL,fallback];
  }
  return data;
}

function delegateTerminalError(project, task) {
  const terminals = sessions.list().filter(s => s.project === project && s.task === task && s.running);
  if (!terminals.length) return '';
  const names = [...new Set(terminals.map(s => launch.AI_LABEL[s.ai] || s.ai))].join('・');
  return `この作業のターミナルで AI（${names}）が動いているため、委任できません。人に「この作業の作業画面で［ターミナル］に切り替え、${names}の欄の［停止］を押してから、会話でもう一度頼んでください」と案内してください。会話画面の［停止］は押させない（待っている指示も取り消されます）。裏で別の CLI を起動したり、この依頼を繰り返し送ったりしないでください。`;
}

// 人が承認した例外は司令塔・チェックの Fable → Astra だけ。別の予備担当には広げない。
function fableBackup(data, role) {
  if (data.switch.auto !== true || (role && !['司令塔', 'チェック'].includes(role))) return null;
  const r = data.roles.find(r => ['司令塔', 'チェック'].includes(r.name) && (!role || r.name === role) &&
    r.main.ai === 'claude-code' && launch.flagFor('claude', r.main.model) === 'claude-fable-5-1' &&
    r.backup.ai === 'codex' && launch.flagFor('codex', r.backup.model) === 'gpt-6-astra' && roles.EFFORTS.includes(r.backup.effort));
  return r ? { ai: 'codex', model: launch.modelLabel('codex', r.backup.model), effort: r.backup.effort, role: r.name,
    requireModel: true, requiredModel: 'gpt-6-astra', perm: permCmd('codex') } : null;
}
// ChatGPT アプリ・Codex の設定ファイル（~/.codex/config.toml）に、Hub の MCP が登録されているか
const CODEX_CONFIG = () => path.join(process.env.HUB_AI_HOME || os.homedir(), '.codex', 'config.toml');
const nativeMcpRegistration = process.platform==='win32'&&Number.isSafeInteger(PORT)&&PORT>=1024&&PORT<=65535 ? new (require('./lib/native-mcp-registration').NativeMcpRegistration)({
  root:ROOT,hubDir:__dirname,configFile:CODEX_CONFIG(),port:PORT,
  resolveGrant:async({capabilityId,runId,token})=>{
    const scope=mcpCapabilities.inspect(token,runId);
    if(scope.id!==capabilityId||!scope.task)throw Object.assign(Error('MCP 註冊必須綁定已核准的同一作業與回合'),{status:403});
    const grant=mcpCapabilities.current(capabilityId,runId),p=store.readProject(grant.project),t=p?.tasks.find(x=>x.id===grant.task);
    if(!t)throw Object.assign(Error('MCP 註冊作業已不存在'),{status:403});
    if(grant.workspaceRun)await validateWorkspaceCapability(grant);
    if(grant.root){if(!t.workdir||path.resolve(expandHome(t.workdir)).toLowerCase()!==grant.root.toLowerCase()||(await require('./lib/scoped-file').identity(grant.root)).rootFingerprint!==grant.rootFingerprint)throw Object.assign(Error('MCP 註冊工作區身分已變更'),{status:403});}
    const fresh=mcpCapabilities.inspect(token,runId);if(fresh.id!==capabilityId)throw Object.assign(Error('MCP 註冊授權已失效'),{status:403});return fresh;
  },
  revokeGrant:async({capabilityId,runId})=>{mcpCapabilities.revoke(capabilityId);for(const row of commandIntents.list())if(row.capId===capabilityId&&row.run===runId)commandIntents.cancelRun(runId);}
}) : null;
let nativeMcpRegistrationError='';
const nativeMcpRegistrationReady=Promise.resolve().then(()=>nativeMcpRegistration?.prune({all:true})).catch(error=>{nativeMcpRegistrationError=error.code||'STARTUP_CLEANUP_REQUIRES_REVIEW';});
if(nativeMcpRegistration){const timer=setInterval(()=>{if(!nativeMcpRegistration.active())void nativeMcpRegistration.prune({}).catch(error=>{nativeMcpRegistrationError=error.code||'EXPIRED_CLEANUP_REQUIRES_REVIEW';});},30000);timer.unref();}
function nativeMcpRegistrationStatus(){if(!nativeMcpRegistration)return{configFile:CODEX_CONFIG(),registrations:[],configured:false,error:'REGISTRATION_PORT_UNCONFIGURED'};try{return{...nativeMcpRegistration.status(),...(nativeMcpRegistrationError?{manualReview:true,error:nativeMcpRegistrationError}:{})};}catch(error){return{configFile:CODEX_CONFIG(),registrations:[],manualReview:true,error:error.code||'REGISTRATION_RECORD_REQUIRES_REVIEW'};}}
async function nativeMcpRegistrationRoute(req,res,url,b={}){
  if(!nativeMcpRegistration||!localOwner(req)||fromRemote()||reqCtx.getStore()?.mcpScope||req.headers.authorization!==undefined)return send(res,403,{error:'暫時 MCP 註冊僅限本機使用者'});
  await nativeMcpRegistrationReady;
  const action=url.pathname==='/api/chatgpt/register'?'apply':url.pathname.slice('/api/chatgpt/register/'.length);
  if(action==='status')return req.method==='GET'?send(res,200,nativeMcpRegistrationStatus()):send(res,405,{error:'method'});
  if(req.method!=='POST')return send(res,405,{error:'method'});
  try{
    if(action==='preview')return send(res,200,await nativeMcpRegistration.preview(b));
    if(action==='apply'){
      const result=await nativeMcpRegistration.apply(b);
      try{record('mcpregister',{}, {registrationId:result.registrationId,capabilityId:result.capabilityId,fragmentHash:result.fragmentHash,configured:true});}
      catch{mcpCapabilities.revoke(result.capabilityId);for(const row of commandIntents.list())if(row.capId===result.capabilityId)commandIntents.cancelRun(row.run);const cleanup=await nativeMcpRegistration.cleanup({registrationId:result.registrationId}).catch(()=>({ok:false,manualReview:true}));return send(res,500,{error:'MCP 設定寫入後操作記錄失敗；已撤銷授權，請確認設定清理狀態',partial:true,registrationId:result.registrationId,grantRevoked:true,configured:cleanup.ok===true?false:null,configState:cleanup.ok===true?'restored':'unknown',manualReview:cleanup.ok!==true});}
      return send(res,200,result);
    }
    if(action==='cleanup'){
      if(b.confirm!==true||Object.keys(b).some(key=>!['registrationId','confirm'].includes(key)))return send(res,400,{error:'請確認此暫時 MCP 註冊的撤權與清理'});
      return send(res,200,await nativeMcpRegistration.cleanup({registrationId:b.registrationId}));
    }
    if(action==='recover/preview'){
      if(Object.keys(b).length!==1||typeof b.registrationId!=='string')return send(res,400,{error:'請指定已知的註冊恢復記錄'});
      const{record}=nativeMcpRegistration.checkedRecord(b.registrationId);
      if(record.phase!=='manual-review'||!/^[a-f0-9]{32}$/.test(record.recoveryRecordId||''))return send(res,409,{error:'沒有已知的不完整原生交易；請人工檢查，不自動採用未知檔案'});
      const current=await nativeMcpRegistration.snapshot(record.snapshot);
      if(current.fileFingerprint!==record.snapshot.fileFingerprint)return send(res,409,{error:'設定檔 FileID 已变更；未自動恢復'});
      return send(res,200,{registrationId:record.id,configFile:CODEX_CONFIG(),expectedHash:current.sha256,beforeHash:record.snapshot.sha256,fileFingerprint:current.fileFingerprint,recordId:record.recoveryRecordId});
    }
    if(action==='recover'){
      if(Object.keys(b).some(key=>!['registrationId','expectedHash','confirm'].includes(key)))return send(res,400,{error:'恢復確認格式無效'});
      return send(res,200,await nativeMcpRegistration.recover(b));
    }
    return send(res,404,{error:'not found'});
  }catch(error){return send(res,error.status||409,{error:error.code?'MCP 註冊：'+error.code:'MCP 註冊未完成',...(error.partial?{partial:true}:{}),...(error.registrationId?{registrationId:error.registrationId}:{}),...(error.grantRevoked===true?{grantRevoked:true}:{}),...(error.manualReview?{manualReview:true}:{}),...(error.recoveryRequired?{recoveryRequired:true}:{})});}
}
const MCP_BLOCK = () => `\n# Project Hub の道具（作業を読む・結果を書き戻す）。Hub を起動しておくこと\n[mcp_servers.project-hub]\ncommand = "node"\nargs = ["${path.join(__dirname, 'mcp.js')}"]\n`;
function codexMcpStatus() {
  if(process.platform==='win32'){const status=nativeMcpRegistrationStatus();return{...status,registered:status.registrations.some(row=>row.phase==='configured'),configExists:null};}
  let text = '';
  try { text = fs.readFileSync(CODEX_CONFIG(), 'utf8'); } catch (e) { return { registered: false, configFile: CODEX_CONFIG(), configExists: false }; }
  return { registered: /^\s*\[mcp_servers\.project-hub\]/m.test(text), configFile: CODEX_CONFIG(), configExists: true };
}
function codexMcpRegister() {
  const file = CODEX_CONFIG();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { error: `設定ファイルを読めません：${file}` }; }
  if (/^\s*\[mcp_servers\.project-hub\]/m.test(text)) return { file, added: false };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().slice(0, 10)}`); // 念のため前の内容を残す
    fs.writeFileSync(file, text.replace(/\s*$/, '') + (text ? '\n' : '') + MCP_BLOCK());
  } catch (e) { return { error: `設定ファイルに書けません：${e.message}` }; }
  return { file, added: true };
}
// 表示・非表示と順番を同じ設定へ、互いを保って保存する。
const modelView = new (require('./lib/model-view').ModelView)(path.join(ROOT, '_hub', 'model-view.json'));
const hiddenModels = () => modelView.hidden();

// 未読：見ていない間に AI の作業が終わった作業（_hub/unread.json に「プロジェクト\0作業」で残す）
const UNREAD_FILE = path.join(ROOT, '_hub', 'unread.json');
const unread = new Set((() => { try { return [].concat(JSON.parse(fs.readFileSync(UNREAD_FILE, 'utf8')).items || []).map(String); } catch (e) { return []; } })());
function saveUnread() {
  try { // 書きかけを読まないよう、別の名前に書いてから置き換える
    fs.mkdirSync(path.dirname(UNREAD_FILE), { recursive: true });
    const tmp = `${UNREAD_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: [...unread] }, null, 2));
    fs.renameSync(tmp, UNREAD_FILE);
  } catch (e) { /* 書けなくても続ける */ }
}
function setUnread(project, task, on) {
  const k = `${project}\u0000${task}`;
  if (!project || !task || on === unread.has(k)) return;
  if (on) unread.add(k); else unread.delete(k);
  saveUnread();
}
function pruneUnread() {
  if (require('./lib/unread').removeMissing(unread, store.product)) saveUnread();
}
// 会話の1回分が終わった時：誰も会話画面を見ていなければ未読にする
const chatEnded = (project, task) => { if (!(chats.watchers.get(chats.key(project, task))?.size > 0)) setUnread(project, task, true); };
// 作業画面（端末）が終わった時：見ている画面が無く、人が止めたのでなければ未読にする
sessions.onExit = (project, task, ai, s) => { if (!s?.stopped && !(s?.watchers.size > 0)) setUnread(project, task, true); };
// ChatGPT との連携：mcp.js から /api/mcp/* で呼ばれる道具。報告は会話画面にも流し、未読にする
// 子プロジェクトの結果を親へ渡す（親の受け取る作業に書き、会話に流し、未読にする）。失敗しても元の操作は続ける
const handoff = require('./lib/handoff');
function reportChild(child, kind, text) {
  try { return handoff.reportToParent(store, child, { kind, text }, { record, unread: chatEnded, emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }) }); }
  catch (e) { console.log(`[親への報告] ${e.message}`); return false; }
}
// 裏で動いている AI（チャットの AI が nohup などで起動した codex / claude / agy）。終わったら、その作業を未読にする
const procwatch = require('./lib/procwatch').create({ projects: () => store.listProjects(), baseOf, onFailure: d => record('procwatch', {}, {code: d.code, detail: d}) });
function windowsMutationBlocker() {
  if(process.platform!=='win32')return '';
  try{procwatch.assertKnown();return '';}catch(e){return e.message;}
}
async function assertFreshWindowsProcesses({reap=null}={}) {
  if(process.platform!=='win32')return;
  await reapWorkspaceLeases(reap);await procwatch.scan();procwatch.assertKnown();
}
procwatch.onChange((list, { removed }) => {
  for (const x of removed) {
    if (!x.project) continue;
    let task = x.task;
    if (!task) { try { task = store.listProjects().find(p => p.id === x.project)?.tasks.find(t => t.state !== '完了')?.id; } catch (e) { task = null; } }
    if (!task) continue;
    setUnread(x.project, task, true);
    record('bgended', { project: x.project, task, ai: x.ai }, { pid: x.pid });
  }
});
const gpt = new (require('./lib/chatgpt').Chatgpt)({ file: path.join(ROOT, '_hub', 'chatgpt.json'), store, chat, baseOf, record,
  emitRow: (project, task, row) => chats.emit(project, task, { type: 'row', row }), ended: (project, task) => chatEnded(project, task) });

const github = require('./lib/github').createGithub({ settingsFile: path.join(ROOT, '_hub', 'github.json'), dry: DRY,
  idle: p => {
    assertWorkspaceIdle(p, { workspaceMode: 'isolated' }, false, true);
    const canonical = d => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const base = canonical(baseOf(p));
    const all = store.listProjects();
    const active = [...sessions.list().filter(s => s.running), ...[...chats.running.keys()].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }), ...procwatch.list()];
    if (active.some(a => {
      const q = all.find(x => x.id === a.project); if (!q || canonical(baseOf(q)) !== base) return false;
      const t = q.tasks.find(x => x.id === a.task);
      return !t || t.workspaceMode === 'direct' || !t.workdir || canonical(expandHome(t.workdir)) === base;
    })) { const e = Error('同じ本体でAIが作業中です。終わってから作ってください'); e.status = 409; throw e; }
  }
});
const githubProject = p => ({ ...p, base: baseOf(p) });
function chatPermCmd(ai){return require('./lib/native-chat-permission').forChat(ai,{legacy:permCmd,...nativeProviderOptions()});}
function permCmd(ai) {
  // Windows browser edition currently supports Codex with the CLI's own
  // approval and sandbox defaults. Existing Mac roles.yaml files may contain
  // bypass flags; they must never be inherited on Windows.
  if (process.platform === 'win32') {
    if (ai !== 'codex') throw Error('Windows 版目前只支援 Codex CLI');
    return 'codex';
  }
  const p = rolesData().permissions || {};
  if (ai === 'agy') return launch.DEFAULT_CMD.agy;
  const v = p[launch.AI_KEY[ai]];
  return typeof v === 'string' && /^(claude|codex)\b/.test(v) ? v : launch.DEFAULT_CMD[ai];
}

// 作業の役割 → いつもの担当（AI・モデル・思考）。作業ファイルに指定があればそちら
function pickSpec(task, ai) {
  if (ai === 'agy') return { model: launch.AGY_MODEL.label, effort: '高' };
  const data = rolesData();
  const r = data.roles.find(x => x.name === task.role);
  const slot = r ? (r.main.ai === (launch.AI_KEY[ai]) ? r.main : r.backup.ai === (launch.AI_KEY[ai]) ? r.backup : null) : null;
  // 作業に指定があれば、候補から消えていても別のモデルへ置き換えない。
  const model = launch.modelLabel(ai, task.model || (slot && slot.model) || '');
  const effort = roles.EFFORTS.includes(task.effort) ? task.effort : (slot && slot.effort) || '';
  return { model, effort };
}

function modelError(ai, model) {
  if(['claude','grok'].includes(ai))ensureNativeCatalog(ai);
  try { const actor=providers.resolveActor(ai); if(actor.kind==='external-chat')return ''; providers.assertCapability(actor.id,'chat',nativeProviderOptions()); } catch(error) { return error.message; }
  if (process.platform === 'win32' && ai !== 'codex'&&!['claude','grok'].includes(ai)) return '此 Windows CLI 尚未接入原生 runtime';
  model = launch.modelLabel(ai, model);
  if (model === launch.CLI_DEFAULT_LABEL) return '';
  if (process.platform === 'win32' && ai === 'codex') {
    const availability=aiTools.codexAvailability(model);
    if(availability==='available')return '';
    if(availability==='unavailable'){
      const labels=[launch.CLI_DEFAULT_LABEL,...aiTools.catalog().codex.models.map(row=>row.label)].filter((label,index,all)=>all.indexOf(label)===index).slice(0,12).join(', ');
      return `Hub 使用的 Codex 目前不提供模型「${model}」。可用的模型：${labels}。請在模型選單改選，或到「設定」修改角色的預設模型。`;
    }
    // Unknown live catalog (offline, dry run, refresh failed): keep the static label checks below.
  }
  if (process.platform === 'win32' && (ai === 'grok' || ai === 'claude' && aiTools.catalog().claude.models.length)) {
    const models=aiTools.catalog()[ai].models;
    if(models.some(row=>row.label===model||row.id===model)||Object.hasOwn(launch.MODEL_FLAG[ai],model)||Object.values(launch.MODEL_FLAG[ai]).includes(model))return '';
    const labels=[launch.CLI_DEFAULT_LABEL,...(models.length?models.map(row=>row.label):['Grok 4.6'])].join(', ');
    return `Hub 使用的 ${ai==='claude'?'Claude Code':'Grok CLI'} 目前不提供模型「${model}」。可用的模型：${labels}。請在模型選單改選，或到「設定」修改角色的預設模型。`;
  }
  if (ai === 'agy') {
    const route = launch.agyAccountError();
    if (route) return route;
    if (launch.flagFor(ai, model) !== launch.AGY_MODEL.id) return 'Agy で承認されているモデルは Gemini 3.1 Pro (High) だけです';
    if (!aiTools.catalog().agy.models.some(x => x.id === launch.AGY_MODEL.id)) return '設定画面で Agy のモデル一覧を再取得してください。別のモデルへは切り替えません';
  }
  if (!model) return '';
  if (aiTools.staleModel(ai, model)) return `モデル「${model}」は現在の候補から外れています。新しいモデルを選んでください`;
  if (Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, model)) return '';
  return launch.flagFor(ai, model) ? '' : `モデル「${model}」の CLI 名が分かりません。設定で直してください`;
}

function nativeEffortError(ai,model,effort){
  if(process.platform!=='win32'||!['claude','grok'].includes(ai)||model===launch.CLI_DEFAULT_LABEL)return '';
  ensureNativeCatalog(ai);
  const id=launch.flagFor(ai,model),models=aiTools.catalog()[ai].models;
  const row=models.find(row=>row.label===model||row.id===id||row.id===model)||
    (ai==='claude'&&id==='sonnet'?models.find(row=>row.id.startsWith('claude-sonnet-')):null);
  const flag=launch.EFFORT_FLAG[ai][effort]||effort||'low';
  if(row?.efforts&&!row.efforts.includes(flag))return `${ai==='claude'?'Claude Code':'Grok CLI'} 的「${model}」不支援思考強度「${effort||flag}」。可用：${row.efforts.join(', ')}。`;
  return '';
}

// 作業する場所：作業ファイルの workdir → なければ用意する（Git なら作業用コピー、無ければ保存を始めて本体）
const workRoot = p => path.join(ROOT, 'Work', p.id);
function baseOf(p) {
  const body = p.folders.find(f => f.label === '本体');
  const d = body && expandHome(body.path);
  return d && fs.existsSync(d) ? d : p.dir;
}
function assertWorkspaceIdle(p, t, permitChat, githubOperation = false, workspaceFlow = null) {
  if (maintenance.locked(p.id)) {const e=Error('同じ本体で検証中です。終わってからAIを始めてください');e.status=409;throw e;}
  const ownFlow=process.platform==='win32'&&workspaceFlow?workspaceRuntime.assertStart(p.id,t.id,workspaceFlow,workspaceReview.binding(p.id,t.id)?.dir):null;
  if (process.platform === 'win32' && (reviewedMerge.pending(baseOf(p)) || reviewedMerge.locked(baseOf(p))&&!ownFlow || workspaceReview.pending(baseOf(p))&&!ownFlow)) {const e=Error('此 Git 儲存庫有工作流程、合併或恢復作業；請待該作業結束後再啟動 AI');e.status=409;throw e;}
  if (!githubOperation) github.assertStart(githubProject(p), { ...t, workdir: expandHome(t.workdir) });
  const canonical = dir => { try { return fs.realpathSync(dir); } catch(e) { return path.resolve(dir); } };
  const base = canonical(baseOf(p));
  const targetDirect = t.workspaceMode === 'direct';
  const active = [...sessions.list().filter(s=>s.running), ...[...chats.running.keys()].map(k=>{const [project,task]=k.split('\u0000');return {project,task,chat:true};})];
  if (!active.length) return;
  const all = store.listProjects();
  for (const a of active) {
    if ((permitChat||ownFlow) && a.chat && a.project===p.id && a.task===t.id) continue;
    const q=all.find(x=>x.id===a.project), at=q?.tasks.find(x=>x.id===a.task); if(!q || !at)continue;
    if(canonical(baseOf(q))===base && (targetDirect || at.workspaceMode==='direct')) {
      const e=Error('同じ本体でAIが作業中です。本体での同時作業はできません');e.status=409;throw e;
    }
  }
}
function workDir(p, t) {
  const wd = expandHome(t.workdir);
  if (wd && fs.existsSync(wd)) {
    if (process.platform === 'win32') {
      require('./lib/safe-path').localPath(wd);
      require('./lib/safe-path').localPath(workRoot(p));
      require('./lib/safe-path').localPath(baseOf(p));
      const actual = fs.realpathSync(wd);
      const root = path.resolve(workRoot(p));
      const rel = path.relative(root, actual);
      const expected = path.resolve(root, t.id);
      const taskRel = path.relative(expected, actual);
      const tree = gitw.repoTop(actual);
      const main = gitw.mainOf(actual), base = gitw.repoTop(baseOf(p));
      if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel) ||
          taskRel === '..' || taskRel.startsWith('..' + path.sep) || path.isAbsolute(taskRel) ||
          !tree || path.resolve(tree).toLowerCase() !== expected.toLowerCase() ||
          !main || !base || fs.realpathSync(main) !== fs.realpathSync(base)) {
        throw new Error('Windows 版只允許在此作業已登錄的隔離 Git 工作複本執行 AI');
      }
    }
    return { dir: wd };
  }
  const base = baseOf(p);
  if (DRY) return { dir: base };
  try {
    const r = gitw.prepare({ base, workRoot: workRoot(p), taskId: t.id, direct: t.workspaceMode === 'direct' || base === p.dir });
    if (r.worktree) store.updateTask(p.id, t.id, { workdir: r.dir });
    return r;
  } catch (e) {
    if (process.platform === 'win32') throw e; // Never fall back to the project root.
    return { dir: base, note: `作業用コピーを作れなかったため、本体で作業します（${String(e.message || e).split('\n')[0]}）` };
  }
}
function startDir(p,t,permitChat=false) {
  assertWorkspaceIdle(p,t,permitChat);
  const result=workDir(p,t);
  if(!t.workspaceStarted)store.updateTask(p.id,t.id,{workspaceStarted:new Date().toISOString()});
  return result;
}
const inWork = (p, t) => { const wd = expandHome(t.workdir); const rel = wd && path.relative(workRoot(p), wd); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };
// 作業ファイルに作業用コピーの場所が書いてあるのに、その場所が無い（取り込んでゴミ箱へ移した後に、AI が古い内容で書き戻した時など）
const copyMissing = (p, t) => inWork(p, t) && !fs.existsSync(expandHome(t.workdir));
// この作業を本体に取り込んだ記録（いちばん新しいもの）
const lastMerge = (project, task) => require('./lib/integration-log').lastMerge(LOG_FILE, project, task)
  || (process.platform === 'win32' ? reviewedMerge.reader.receipt(project, task) : null);

function reviewedMergeDescriptor(project, task) {
  if (typeof project !== 'string' || typeof task !== 'string' || !project || !task) throw Error('請指定專案與作業');
  const p = store.readProject(project), t = p?.tasks.find(x => x.id === task);
  if (!p || !t) throw Error('找不到專案或作業');
  if (require('./public/project-order').integrators(p, t, store.listProjects()).length) throw Error('請由父作業的整合流程接收此子作業成果');
  if (t.mergeExcluded) throw Error('此作業已排除合併；請先恢復為合併對象');
  const dir = expandHome(t.workdir) || path.join(workRoot(p), t.id);
  const expected = path.resolve(workRoot(p), t.id), rel = path.relative(expected, dir);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('此作業沒有有效的隔離工作複本');
  if (fs.existsSync(dir)) {
    const tree = gitw.repoTop(dir);
    if (!tree || path.resolve(tree).toLowerCase() !== expected.toLowerCase()) throw Error('此作業的工作複本根目錄與作業識別不符');
  }
  return { project: p.id, task: t.id, title: `${t.id} ${t.title}`, taskHash: t.completionHash, dir, workRoot: workRoot(p), target: baseOf(p), forbiddenRoots: [path.resolve(__dirname, '..'), path.join(ROOT, '_hub')] };
}
function reviewedMergeBusy(project, task) {
  const p = store.readProject(project); if (!p) return true;
  if (maintenance.locked(project) || github.locked(baseOf(p))) return true;
  const common = dir => { const top = gitw.repoTop(dir); return top && fs.realpathSync(gitw.mainOf(top) || top).toLowerCase(); };
  const target = common(baseOf(p)); if (!target) throw Error('無法確認合併目標的 Git 儲存庫');
  const all = store.listProjects();
  const active = [...sessions.list().filter(x => x.running), ...[...chats.running.keys()].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }), ...procwatch.list().filter(x => x.project)];
  if (active.some(x => { const q = all.find(p => p.id === x.project); return q && common(baseOf(q)) === target; })) return true;
  const queue = path.join(p.dir, '.ai', 'chat', task + '.queue.json');
  require('./lib/remove').noLinks(queue);
  if (fs.existsSync(queue)) { const pending = JSON.parse(fs.readFileSync(queue, 'utf8')); if (!Array.isArray(pending) || pending.length) return true; }
  return false;
}
const reviewedMerge = new (require('./lib/reviewed-git-service').ReviewedGitService)({ root: ROOT, resolve: reviewedMergeDescriptor, busy: reviewedMergeBusy, verifyStore: true });
const workspaceReview = new (require('./lib/reviewed-workspace').ReviewedWorkspace)({
  root:ROOT,
  chatLedger:project=>{const p=store.readProject(project);return p?{dir:p.dir,taskIds:p.tasks.map(t=>t.id)}:null;},
  resolve:(project,task)=>{const p=store.readProject(project),t=p?.tasks.find(x=>x.id===task);if(!t)throw Error('找不到工作區作業');return {project,task,title:t.id+' '+t.title,taskHash:t.completionHash,base:baseOf(p),workRoot:workRoot(p),forbiddenRoots:[path.resolve(__dirname,'..'),path.join(ROOT,'_hub')]};},
  busy:(project,task,baseInput,authority)=>{const p=store.readProject(project),t=p?.tasks.find(x=>x.id===task);if(!t)return true;const preapprovedIsolated=authority?.phase==='consume'&&authority.record?.mode==='isolated'&&authority.record.state==='ready';if(maintenance.locked(project)||maintenance.nativeBusy(project)||nativeEmpty?.nativeBusy(project)||github.locked(baseOf(p))&&!preapprovedIsolated||reviewedMerge.pending(baseOf(p))||taskTransfer.nativeBusy?.(project)||taskIntegrate.nativeBusy?.(project))return true;const base=fs.realpathSync(baseOf(p)).toLowerCase(),all=store.listProjects(),active=[...sessions.list().filter(x=>x.running),...[...chats.running.keys()].map(k=>({project:k.split('\0')[0],task:k.split('\0')[1]}))],other=procwatch.list().filter(x=>x.project);return [...active,...other].some(x=>{const q=all.find(y=>y.id===x.project),qt=q?.tasks.find(y=>y.id===x.task);return q&&fs.realpathSync(baseOf(q)).toLowerCase()===base&&(x.project===project&&x.task===task||t.workspaceMode==='direct'||qt?.workspaceMode==='direct');});}
});
const workspaceRuntime = new (require('./lib/workspace-runtime').WorkspaceRuntime)({review:workspaceReview,sessions,chats,store,stopExtra:(project,task)=>stopTaskCommands(project,task),onError:error=>record('workspaceclose-error',{}, {error:String(error.message).slice(0,1000)}),warm:process.platform==='win32'?{
  ttlMs:600000,eligible:warmEligible,parkCheck:x=>workspaceReview.warmBaseClean(x.project,x.task,x.workspace.run),check:warmReentryCheck,
  onPark:x=>workspaceDestinations.revokeAll(x),
  onParked:x=>{record('workspace-idle',{project:x.project,task:x.task},{});emitChat(x.project,x.task,{type:'idle'});},
  onResumed:x=>record('workspace-warm',{project:x.project,task:x.task},{}),
  onRejected:(x,reason)=>record('workspace-warm-reject',{project:x.project,task:x.task},{reason}),
  onSkipped:(x,reason)=>record('workspace-park-skip',{project:x.project,task:x.task},{reason}),
  onExpired:x=>record('workspace-idle-expired',{project:x.project,task:x.task},{}),
  onCleanupFailed:x=>{if(!chats.busy(x.project,x.task))emitChat(x.project,x.task,{type:'idle'});}
}:null});
const workspaceDestinations=new(require('./lib/destination-consent'))({resolve:async(project,task)=>{
  const flow=workspaceRuntime.current(project,task),b=await workspaceReview.verifiedBinding(project,task);
  if(!flow||workspaceRuntime.isParked(flow)||flow!==workspaceRuntime.current(project,task)||flow.workspace.run!==b.run)throw Error('工作區流程已變更');
  const record=workspaceReview.runs.get(b.run)?.record;if(!record)throw Error('工作區紀錄已失效');
  return {flow,binding:{project,task,run:b.run,rootFingerprint:b.rootFingerprint,dir:b.dir},
    review:{workspace:b.dir,rootFingerprint:b.rootFingerprint,files:record.secrets.files.map(f=>({relative:f.relative,sha256:f.sha256})),
      readLimits:'Codex 使用既有 Windows sandbox 設定；可能讀取工作區以外檔案，loopback 也不由網域白名單過濾。此確認不會新增檔案或網路權限。'}};
}});
const secretSupply = new (require('./lib/secret-supply').SecretSupply)({root:ROOT,stopRun:id=>workspaceRuntime.stop(id)});
workspaceReview.secretSupply=secretSupply;
// Private lifecycle observation does not count as a browser watcher.
const emitChat=chats.emit.bind(chats);
chats.emit=(project,task,event)=>{if(process.platform==='win32'&&event.type==='busy')workspaceRuntime.observeChat(project,task);return emitChat(project,task,event);};

function assertNativeCliPresent(actor){if(actor==='codex')try{require('./lib/cli-platform').resolveProvider('codex');}catch(error){throw Object.assign(error,{status:409,notStarted:true});}}
async function nativeStartDir(p,t,{workspacePermit,kind='chat',allowExisting=false,actor='codex',noReentry=false}={}){
  if(process.platform!=='win32')return startDir(p,t,allowExisting);
  // Reject a known missing CLI before creating a lease or advancing task
  // metadata. The eventual launch still resolves and verifies it again.
  assertNativeCliPresent(actor);
  assertNativeMutationUnlocked(p.id,{task:t.id,allowOwned:true});
  await workspaceRuntime.settle(p.id,t.id);let current=workspaceRuntime.current(p.id,t.id);
  if(current&&current.kind!==kind&&await workspaceRuntime.reap(current))current=null;
  if(current&&workspaceRuntime.reenterable(current)&&workspaceReview.permits.has(workspacePermit)){await workspaceRuntime.finish(current.id);current=null;}
  if(noReentry&&current&&workspaceRuntime.reenterable(current))throw Object.assign(Error('工作區閒置中；請由使用者在 Hub 畫面送出'),{status:409,notStarted:true});
  const approvedActor=workspaceReview.permits.get(workspacePermit)?.approvalActor||'codex';
  if(!current){assertWorkspaceIdle(p,t,allowExisting);if(workspacePermit){await procwatch.scan();procwatch.assertKnown();}}
  let flow;try{flow=await workspaceRuntime.begin({project:p.id,task:t.id,permit:workspacePermit,kind,noReentry,verifySource:github.locked(baseOf(p))});}catch(error){if(error.workspaceRequired)error.actor=actor;if(error.workspaceFlow){try{await failNativeWorkspace(error.workspaceFlow);}catch(cleanup){error.message+='；供應清理待覆核：'+String(cleanup.message).slice(0,500);}}throw error;}
  if(!current)workspaceDestinations.mark(flow,approvedActor);
  try{if(actor==='codex')assertWorkspaceDestination(flow,actor);
  assertNativeMutationUnlocked(p.id,{task:t.id,allowOwned:true});const dir=flow.workspace.dir;
  const beforeTask=store.readTask(store.taskFile(p.id,t.id));
  if(beforeTask.workdir!==dir||!beforeTask.workspaceStarted)nativeTaskMetadataWrite(p.id,t.id,current=>store.updateTask(p.id,t.id,{workdir:dir,...(!current.workspaceStarted?{workspaceStarted:new Date().toISOString()}:{})}));
  return {dir,workspaceFlow:flow.id,note:flow.workspace.mode==='direct'?'此工作流程已明確核准本體作業；Git基線与互斥鎖已建立':'此工作流程使用已核准的隔離工作複本'};
  }catch(error){await failNativeWorkspace(flow.id,error);throw error;}
}
// Only synchronous controller writes may extend this run's approved task hash.
// A lifecycle write without a receipt remains stale; it is never adopted here.
function nativeTaskMetadataWrite(project,task,write){
  const p=store.readProject(project),file=store.taskFile(project,task),before=store.readTask(file),taskHash=require('./lib/completion').hash;
  const rawHash=taskHash(fs.readFileSync(file,'utf8'));
  const flow=workspaceRuntime.current(project,task),binding=workspaceReview.metadataBinding(project,task),entry=binding&&workspaceReview.runs.get(binding.run);
  const continuous=Boolean(flow&&binding&&binding.run===flow.workspace?.run&&before.completionHash===rawHash&&entry?.approvedTaskHash===rawHash);
  if(github.locked(baseOf(p))&&!continuous)throw Object.assign(Error('GitHub期間作業metadata缺少連續controller收據；請先停止後重新核准'),{status:409});
  if(continuous&&entry.taskAdvances.length>=128)throw Object.assign(Error('工作區metadata更新收據已達上限；請停止後重新核准'),{status:409});
  const after=write(before);
  if(continuous){
    if(taskHash(fs.readFileSync(file,'utf8'))!==after.completionHash)throw Object.assign(Error('作業資料已寫入但實際 bytes 與收據讀取不一致；請停止後重新核准'),{status:409});
    workspaceReview.advanceTaskMetadata({run:binding.run,project,task,beforeHash:rawHash,afterHash:after.completionHash});
  }
  return after;
}
async function failNativeWorkspace(flowId,error){if(process.platform!=='win32'||!flowId)return;if(['NATIVE_PROVIDER_APPROVAL_REQUIRED','WORKSPACE_DESTINATION_REQUIRED'].includes(error?.code)){workspaceRuntime.hold(flowId);return;}const x=workspaceRuntime.flows.get(flowId);if(x&&!x.children.size)await workspaceRuntime.failed(x);}
function warmEligible(x){const entry=workspaceReview.runs.get(x.workspace.run),r=entry?.record,p=store.readProject(x.project),t=p?.tasks.find(t=>t.id===x.task);return Boolean(entry&&!entry.closing&&r.state==='run-active'&&r.mode==='isolated'&&!r.secrets.files.length&&!r.trackedSecrets.length&&!r.supplied.length&&!entry.supplyId&&entry.taskAdvances.length<96&&t&&t.workspaceMode!=='direct'&&!github.locked(baseOf(p)));}
async function warmReentryCheck(x){const fail=reason=>Object.assign(Error('工作區保溫重新確認未通過'),{warmReason:reason}),p=store.readProject(x.project),t=p?.tasks.find(t=>t.id===x.task);if(!t||t.workspaceMode==='direct')throw fail('task');if(commandIntents.list().some(row=>row.project===x.project&&row.task===x.task&&['validating','running','canceling'].includes(row.state)))throw fail('commands');try{assertWorkspaceIdle(p,t,false);}catch{throw fail('idle-gate');}await workspaceReview.warmBinding(x.project,x.task,x.workspace.run,{afterBase:async()=>{try{await procwatch.scan();procwatch.assertKnown();}catch{throw fail('procwatch');}if(workspaceReview.busy(x.project,x.task))throw fail('claimed');}});}
async function reapWorkspaceLeases(scope){if(process.platform!=='win32'||!scope)return;await workspaceRuntime.reapAll(scope==='all'?()=>true:x=>x.project===scope.project&&(!scope.task||x.task===scope.task));}
function leaseReapAllowed(){return process.platform==='win32'&&!aiTools.isOperating()&&!nativeOperationsBusy({unusedLeases:false})&&!sessions.list().some(x=>x.running)&&chats.running.size===0;}
function assertWorkspaceDestination(flow,actor){try{workspaceDestinations.assert(flow,actor);}catch(error){Object.assign(error,{project:flow.project,task:flow.task,actor});throw error;}}
function nativeRootPin(project,task){if(process.platform!=='win32')return undefined;const b=workspaceReview.binding(project,task);if(!b?.rootFingerprint)throw Error('缺少本次已驗證工作區的根目錄 FileID');return {root:b.dir,rootFingerprint:b.rootFingerprint};}
function workspaceFlowOf(project,task){return workspaceRuntime.current(project,task)||workspaceRuntime.flows.get(workspaceRuntime.byTask.get(workspaceRuntime.key(project,task)));}
// Only a Codex terminal needs the active slot version (for --no-daemon); a rejected or unreadable
// slot must not stop other terminals or escape the workspace-flow cleanup.
function activeCodexVersion(ai){if(ai!=='codex')return undefined;try{return aiTools.nativeUpdater?.active()?.version;}catch{return undefined;}}
function nativeWorkspaceError(error,task){const diagnosticCode=require('./lib/native-provider-diagnostic').codeOf(error);const bare=diagnosticCode&&String(error.message||'')===diagnosticCode?require('./lib/native-provider-messages').messageFor(diagnosticCode,error.version):null;return {error:bare||String(error.message||error),...(diagnosticCode?{code:diagnosticCode}:{}),...(error.notStarted===true?{notStarted:true}:{}),...(error.workspaceRequired?{workspaceRequired:true,code:'WORKSPACE_REQUIRED',project:error.project,task:error.task||task,...(error.actor?{actor:error.actor}:{})}:{}),...(['NATIVE_PROVIDER_APPROVAL_REQUIRED','WORKSPACE_DESTINATION_REQUIRED'].includes(error.code)?{code:error.code,project:error.project,task:error.task,actor:error.actor,model:error.model,effort:error.effort}:{}),...(task&&!error.workspaceRequired?{task}:{})};}
async function prepareNativeProviderTurn(o){
  if(process.platform==='win32'&&['claude','grok'].includes(o.ai)){const invalid=modelError(o.ai,o.model)||nativeEffortError(o.ai,o.model,o.effort);if(invalid)throw Object.assign(Error(invalid),{status:409,notStarted:true});}
  if(process.platform==='win32'&&o.ai==='codex')assertWorkspaceDestination(workspaceRuntime.assertStart(o.project,o.task,o.workspaceFlow,o.dir),'codex');
  if(!nativeProviderService||!['claude','grok'].includes(o.ai))return;
  o.nativeRootPin=nativeRootPin(o.project,o.task);
  await nativeProviderService.prepareTurn(o);
}
async function sendNativeProviderChat(o){
  await prepareNativeProviderTurn(o);
  try{return chats.send(o);}
  catch(error){if(nativeProviderService&&['claude','grok'].includes(o.ai))await nativeProviderService.cancel({actor:o.ai,project:o.project,task:o.task});throw error;}
}
async function cancelNativeProviders(project,task){
  if(!nativeProviderService)return;
  const results=await Promise.allSettled(['claude','grok'].map(actor=>nativeProviderService.cancel({actor,project,task})));
  if(results.some(r=>r.status==='rejected'))throw Object.assign(Error('原生 CLI 的出口或授權清理尚未完成；工作區流程保留。'),{code:'NATIVE_CLEANUP_REQUIRED',status:409});
}
async function stopNativeWorkspace(flow){
  const results=await Promise.allSettled([cancelNativeProviders(flow.project,flow.task),workspaceRuntime.stop(flow.id)]);
  if(results.some(r=>r.status==='rejected'))throw Object.assign(Error('owned 程序或原生 CLI 授權清理未完成；流程保留。'),{code:'NATIVE_CLEANUP_REQUIRED',status:409});
  return results[1].value;
}
async function nativeProviderMcp(r,binding){
  const runtimeBase=(await require('./lib/native-runtime-base').resolve(os.homedir())).physicalBase;
  const writable=gpt.settings().work,tools=[...READ_TOOLS,'hub_read_file',...(writable?['hub_report','hub_ask_owner','hub_mark_step','hub_write_file','hub_request_command','hub_get_command_result','hub_delegate']:[])];
  const p=store.readProject(r.project),t=p?.tasks.find(t=>t.id===r.task);if(!t)throw Error('找不到已授權的原生 CLI 作業');
  const fileScope={root:binding.dir,rootFingerprint:binding.rootFingerprint,workspaceRun:binding.workspaceRun};
  if(writable){
    const journalRoot=require('./lib/safe-path').localPath(path.join(ROOT,'_hub','file-write'),{allowMissing:true});fs.mkdirSync(journalRoot,{recursive:true});
    Object.assign(fileScope,{journalRoot,journalRootFingerprint:(await require('./lib/scoped-file').identity(journalRoot)).rootFingerprint,
      taskHash:t.completionHash,delegationActor:r.actor,delegationModel:['claude','grok'].includes(r.actor)&&r.model===launch.CLI_DEFAULT_LABEL?launch.CLI_DEFAULT_LABEL:launch.flagFor(r.actor,r.model)});
  }
  const issued=mcpCapabilities.issue({project:r.project,task:r.task,runId:r.runId,tools,ttlMs:MAX_WALL_MS,maxCalls:500,...fileScope});
  const folder=path.join(runtimeBase,'runtime',binding.rootFingerprint,r.actor,'mcp');
  const credentialFile=path.join(folder,r.runId+'.json');
  const bytes=Buffer.from(JSON.stringify({version:1,actor:r.actor,rootFingerprint:binding.rootFingerprint,runId:r.runId,port:PORT,token:issued.token}));
  const owned={capabilityId:issued.capability.id,project:r.project,task:r.task,actor:r.actor,effort:r.effort,tools:[...tools],credentialFile,created:false,credentialSHA256:crypto.createHash('sha256').update(bytes).digest('hex'),mcpProxy:require('./lib/native-mcp-proxy').create({port:PORT,runId:r.runId,token:issued.token})};
  nativeProviderResources.set(r.runId,owned);
  const safe=require('./lib/safe-path');safe.localPath(folder,{allowMissing:true});fs.mkdirSync(folder,{recursive:true});safe.localPath(folder);
  safe.localPath(credentialFile,{allowMissing:true});
  const fd=fs.openSync(credentialFile,'wx',0o600);
  owned.created=true;
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{record('native-provider-mcp',{project:r.project,task:r.task,ai:r.actor},{capabilityId:issued.capability.id,runId:r.runId,tools,expiresAt:issued.capability.expiresAt,rootFingerprint:binding.rootFingerprint});}
  catch(error){mcpCapabilities.revokeRun(r.runId);throw error;}
  const env={HUB_MCP_TASK_CREDENTIAL_FILE:credentialFile},args=[path.join(__dirname,'mcp.js')];
  return r.actor==='claude'?{mcpServers:{hub:{command:process.execPath,args,env}}}:[{name:'hub',command:process.execPath,args,env:Object.entries(env).map(([name,value])=>({name,value}))}];
}
async function nativeProviderDispose(r){
  mcpCapabilities.revokeRun(r.runId);commandIntents?.cancelRun(r.runId);
  const owned=nativeProviderResources.get(r.runId);
  if(owned?.created){
    require('./lib/safe-path').localPath(owned.credentialFile);const stat=fs.lstatSync(owned.credentialFile);
    if(!stat.isFile()||stat.nlink!==1||stat.size>8192||crypto.createHash('sha256').update(fs.readFileSync(owned.credentialFile)).digest('hex')!==owned.credentialSHA256)throw Error('原生 MCP 暫時授權檔已變更；保留檔案及流程供覆核。');
    fs.unlinkSync(owned.credentialFile);
  }
  nativeProviderResources.delete(r.runId);
}

// A bearer can request a command. Only the logged-in browser can approve it.
const commandIntents = new (require('./lib/command-intents').CommandIntents)({
  resolve: async (project, task, scope) => {
    const grant = mcpCapabilities.current(scope.id, scope.run);
    if(grant.workspaceRun)await validateWorkspaceCapability(grant);
    if (!grant.tools.includes('hub_request_command') || grant.project !== project || grant.task !== task || !gpt.settings().work) throw Object.assign(Error('命令授權已失效'), { status: 403 });
    const read = () => {
      const p = store.readProject(project), t = p?.tasks.find(row => row.id === task);
      if (!t?.workdir || t.completionHash !== scope.taskHash || path.resolve(expandHome(t.workdir)).toLowerCase() !== grant.root?.toLowerCase()) throw Object.assign(Error('命令作業範圍已變更'), { status: 409 });
      const binding=grant.workspaceRun?workspaceReview.binding(project,task):null;
      if (reviewedMerge.pending(baseOf(p)) || reviewedMerge.locked(baseOf(p))&&(!binding||binding.run!==grant.workspaceRun)|| taskTransfer.nativeBusy?.(project,task) || taskIntegrate.nativeBusy?.(project,task)) throw Object.assign(Error('此儲存庫正在處理交易'), {status:409});
      return t;
    };
    read(); const identity = await require('./lib/scoped-file').identity(grant.root); const taskNow=read();
    const fresh = mcpCapabilities.current(scope.id, scope.run);
    if (fresh.rootFingerprint !== identity.rootFingerprint) throw Object.assign(Error('命令工作區識別已變更'),{status:409});
    return {...fresh,taskHash:taskNow.completionHash};
  },
  record: intent => {
    const dir=path.join(ROOT,'_hub','commands');require('./lib/safe-path').localPath(dir,{allowMissing:true});fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,intent.id+'.approved.json');require('./lib/safe-path').localPath(file,{allowMissing:true});
    const {argv,result,...binding}=intent;
    const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,JSON.stringify({version:1,...binding,argvHash:crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex'),state:'approved'})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    record('commandapprove',{project:intent.project,task:intent.task,ai:'codex'},{id:intent.id,capId:intent.capId,argvHash:crypto.createHash('sha256').update(JSON.stringify(intent.argv)).digest('hex'),rootFingerprint:intent.rootFingerprint});
  },
  execute: (intent, identity) => {
    if(DRY)throw Object.assign(Error('測試模式不執行命令'),{status:409});
    const profile=reviewedCodexProfile();
    return require('./lib/codex-commands').run(profile.file,{expectedVersion:profile.version,...identity,argv:intent.argv,cwd:intent.cwd,timeoutMs:intent.timeoutMs});
  }
});
gpt.commandIntents = commandIntents;
async function validateWorkspaceCapability(scope){
  const binding=await workspaceReview.verifiedBinding(scope.project,scope.task);
  if(binding.run!==scope.workspaceRun||binding.rootFingerprint!==scope.rootFingerprint||path.resolve(binding.dir).toLowerCase()!==scope.root?.toLowerCase())throw Object.assign(Error('工作區執行授權已變更或結束'),{status:403});
  const fresh=mcpCapabilities.current(scope.id,scope.runId);if(fresh.workspaceRun!==scope.workspaceRun)throw Object.assign(Error('工作區能力授權已失效'),{status:403});return binding;
}
gpt.validateWorkspaceScope=validateWorkspaceCapability;
gpt.delegate = async (scope,args) => {
  const current=()=>{const grant=mcpCapabilities.current(scope.id,scope.runId);if(!grant.tools.includes('hub_delegate')||grant.delegationModel!==args.model||grant.project!==args.project||grant.task!==args.task||!gpt.settings().work)throw Object.assign(Error('委派授權已失效'),{status:403});return grant;};
  const grant=current(),p=store.readProject(args.project),task=p?.tasks.find(row=>row.id===args.task);
  if(!task?.workdir||path.resolve(expandHome(task.workdir)).toLowerCase()!==grant.root?.toLowerCase())throw Object.assign(Error('委派工作目錄已變更'),{status:409});
  assertNativeMutationUnlocked(p.id,{task:task.id,allowOwned:Boolean(grant.workspaceRun)});
  const live=workspaceRuntime.current(p.id,task.id);if(live&&(workspaceRuntime.isParked(live)||workspaceRuntime.reusable(live)))throw Object.assign(Error('工作區閒置中；請由使用者在 Hub 畫面送出'),{status:409});
  const binding=await workspaceReview.verifiedBinding(p.id,task.id);
  if(!binding||path.resolve(binding.dir).toLowerCase()!==grant.root.toLowerCase())throw Object.assign(Error('委派需要此作業仍有效的工作區執行授權'),{status:409});
  const identity=await require('./lib/scoped-file').identity(grant.root);current();
  if(identity.rootFingerprint!==grant.rootFingerprint)throw Object.assign(Error('委派工作區識別已變更'),{status:409});
  const folder=path.join(ROOT,'_hub','delegations');require('./lib/safe-path').localPath(folder,{allowMissing:true});fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,grant.id+'.json');require('./lib/safe-path').localPath(file,{allowMissing:true});
  const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,JSON.stringify({version:1,capId:grant.id,run:grant.runId,project:p.id,task:task.id,model:args.model,rootFingerprint:grant.rootFingerprint,textHash:crypto.createHash('sha256').update(args.text).digest('hex'),state:'authorized'})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const native=nativeProviderResources.get(grant.runId);
  if(native&&(native.capabilityId!==grant.id||native.actor!==grant.delegationActor||args.effort!==undefined&&args.effort!==native.effort))throw Object.assign(Error('委派與本回合已核准的 CLI／思考設定不一致'),{status:403});
  current();return delegateTask({...args,ai:grant.delegationActor||'codex'},native?{effort:native.effort}:null,{origin:'mcp'});
};
async function stopTaskCommands(project,task){
  mcpCapabilities.revokeTask(project,task);
  for(const row of commandIntents.list())if(row.project===project&&row.task===task)commandIntents.cancelRun(row.run);
  const deadline=Date.now()+25000;
  while(commandIntents.list().some(row=>row.project===project&&row.task===task&&['validating','running','canceling'].includes(row.state))){if(Date.now()>=deadline)return{stopped:false,treeExited:false};await new Promise(resolve=>setTimeout(resolve,25));}
  return{stopped:true,treeExited:true};
}

function assertNativeMutationUnlocked(project,{task,allowOwned=false}={}) {
  if(taskWrites.active()||taskWrites.pending().length){const dir=project&&store.projectDir(project);if(!dir||taskWrites.blocked(dir))throw Object.assign(Error('網頁交接正在保存或待復原，請待交易完成後再變更'),{status:409,code:'HANDOFF_WRITE_BUSY'});}
  if(process.platform!=='win32')return;
  // Shared file references can be added by any Product while a helper awaits.
  // Freeze controller metadata until the transfer/integration transaction exits.
  if(taskTransfer.nativeActive?.()||taskIntegrate.nativeActive?.())throw Object.assign(Error('正在交接或整合；請待全域參考檢查與交易完成後再變更作業資料'),{status:409});
  const operations=[...workspaceReview.operations.values()],direct=[...workspaceReview.runs.values()].filter(x=>x.record.mode==='direct').map(x=>x.record);
  if(!reviewedMerge.active()&&!taskTransfer.nativeActive?.()&&!taskIntegrate.nativeActive?.()&&!maintenance.nativeActive()&&!nativeEmpty?.nativeActive()&&!require('./lib/rooted-move').active()&&!operations.length&&!direct.length)return;
  const p=project?store.readProject(project):null;
  const sameBase=(a,b)=>{if(path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase())return true;try{return reviewedMerge.reader.common(a).toLowerCase()===reviewedMerge.reader.common(b).toLowerCase();}catch{return true;}};
  const binding=allowOwned&&p&&task?workspaceReview.binding(p.id,task):null;
  if(!p||reviewedMerge.pending(baseOf(p))||taskTransfer.nativeBusy?.(p.id)||taskIntegrate.nativeBusy?.(p.id)||maintenance.nativeBusy(p.id)||nativeEmpty?.nativeBusy(p.id)||require('./lib/rooted-move').active()||operations.some(x=>sameBase(x.base,baseOf(p)))||direct.some(x=>sameBase(x.base,baseOf(p))&&(!binding||binding.recordId!==x.id)))throw Object.assign(Error('此儲存庫正在處理工作區或持久交易；請待該流程完成後再變更'),{status:409});
}

const taskTransfer = new (require('./lib/task-transfer').TaskTransfer)({store,removal,baseOf,
  integration:(p,t)=>gitw.integrationReceipt(baseOf(p),lastMerge(p.id,t.id),t),
  notify:(project,task,id)=>{const p=store.readProject(project);const row=p&&chat.read(p.dir,task).find(x=>x.handoff===id||x.offer===id);if(row)chats.emit(project,task,{type:'row',row});chatEnded(project,task);}
});
const taskIntegrate = new (require('./lib/task-integrate').TaskIntegrate)({store,transfer:taskTransfer,removal,baseOf});
const nativeEmpty=process.platform==='win32'?new (require('./lib/empty-native').NativeEmptyCleanup)({store,removal,busy:(project,task)=>{const p=store.readProject(project);return Boolean(sessions.list().some(x=>x.running&&x.project===project&&(!task||x.task===task))||[...chats.running.keys()].some(k=>k.split('\0')[0]===project&&(!task||k.split('\0')[1]===task))||procwatch.list().some(x=>x.project===project&&(!task||!x.task||x.task===task))||p&&(github.locked(baseOf(p))||reviewedMerge.pending(baseOf(p))||taskTransfer.nativeBusy(project)||taskIntegrate.nativeBusy(project)||maintenance.nativeBusy(project)||workspaceReview.operations.size||[...workspaceReview.runs.values()].some(x=>x.record.project===project)));}}):null;
function nativeOperationsBusy({unusedLeases=true}={}){return process.platform==='win32'&&Boolean(taskWrites.active()||require('./lib/web-handoff-writer').active()||commandIntents.active()||reviewedMerge.active()||taskTransfer.nativeActive()||taskIntegrate.nativeActive()||(unusedLeases?workspaceReview.active()||workspaceRuntime.flows.size:workspaceReview.operations.size||workspaceRuntime.inUse()||[...workspaceReview.runs.keys()].some(run=>![...workspaceRuntime.flows.values()].some(x=>x.workspace?.run===run)))||secretSupply.active()||maintenance.nativeActive()||nativeEmpty.nativeActive()||require('./lib/scoped-file').active()||require('./lib/rooted-move').active()||nativeMcpRegistration?.active()||nativeProviderService?.active());}

const webChat=process.platform==='win32'?new (require('./lib/web-chat').WebChat)({
  root:ROOT,store,chat,
  admitPreview:()=>webAdmission.ensureFormat(ROOT,{hubDir:__dirname}),
  lock:(project,task,operation,receiptId)=>{const dir=store.projectDir(project);if(!dir)throw Object.assign(Error('找不到交接專案'),{status:404});return taskWrites.run(dir,task,operation,{receiptId});},
  hold:(project,task,receiptId)=>taskWrites.hold(store.projectDir(project),task,receiptId),
  release:(project,task,receiptId)=>taskWrites.release(store.projectDir(project),task,receiptId),
  busy:(project,task)=>{assertNativeMutationUnlocked(project,{task});return Boolean(workspaceRuntime.byTask.has(workspaceRuntime.key(project,task))||workspaceReview.busy(project,task)||chats.busy(project,task)||chats.queue(project,task).length||sessions.list().some(s=>s.project===project&&s.task===task&&s.running)||procwatch.list().some(s=>s.project===project&&(!s.task||s.task===task)));},
  emitRow:(project,task,row)=>chats.emit(project,task,{type:'row',row})
}):null;
const WEB_REQUEST_KEYS={preview:['actor','project','task','text','responseLanguage'],confirm:['actor','project','task','receiptId','previewToken','expectedTaskHash','expectedPromptSHA256','confirm'],result:['actor','project','task','receiptId','taskHash','promptSHA256','requestId','resultSHA256','text','token'],status:['actor','project','task','receiptId'],'recover/preview':['actor','project','task','receiptId'],recover:['actor','project','task','receiptId','confirm','recoveryToken','expectedRecoverySHA256'],revoke:['actor','project','task','receiptId']};
async function webChatRoute(req,res,action,input){
  if(!webChat)return send(res,404,{error:'此交接版本目前適用於 Windows'});
  if(reqCtx.getStore()?.mcpScope||!fromRemote()&&!localOwner(req))return send(res,403,{error:'網頁交接僅限本機使用者或已登入的遠端 Hub 使用者'});
  const keys=WEB_REQUEST_KEYS[action];
  if(!keys||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))return send(res,400,{error:'網頁交接請求格式無效',code:'HANDOFF_REQUEST_INVALID'});
  if(!['status','revoke'].includes(action)){if(typeof input.project==='string'&&typeof input.task==='string')await reapWorkspaceLeases({project:input.project,task:input.task});await procwatch.scan();procwatch.assertKnown();}
  try{const result=await webChat[action==='recover/preview'?'recoverPreview':action]({...input,owner:'windows-hub-owner'});return send(res,result.partial?409:200,result);}
  catch(error){return send(res,[400,403,404,409,413,415].includes(error.status)?error.status:409,{error:error.code?'網頁交接拒絕：'+error.code:'網頁交接未完成；請保留草稿並查看交易狀態',code:error.code||'HANDOFF_FAILED',...(error.partial?{partial:true,recoveryRequired:true}:{} )});}
}

// iPhone で開くアドレス（Tailscale の Mac の名前）。tailscale が無い・止まっている時は空。1分は覚えておく
let tsCache = { at: 0, url: '' };
function tailscaleUrl() {
  if (Date.now() - tsCache.at < 60000) return Promise.resolve(tsCache.url);
  const { execFile } = require('child_process');
  const bins = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
  const tryAt = i => new Promise(done => {
    if (i >= bins.length) return done('');
    execFile(bins[i], ['status', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return tryAt(i + 1).then(done);
      try { const dns = String(JSON.parse(out).Self.DNSName || '').replace(/\.$/, ''); done(dns ? 'https://' + dns : ''); } catch (e) { done(''); }
    });
  });
  return tryAt(0).then(u => { tsCache = { at: Date.now(), url: u }; return u; });
}
// 別の AI に作業を渡す時の決まり（AI が裏で codex/claude を起動すると Hub に見えず、画面では終わったことになるため）
const CHAT_DELEGATE_NOTE = 'この委任APIは会話画面からだけ使えます。委任が「この作業のターミナルで AI が動いています」と断られた時だけ、人に次のように頼む：「この作業の作業画面で［ターミナル］に切り替え、動いている AI の欄の［停止］を押してから、もう一度この会話で頼んでください」。断られていない時は、ターミナルの停止や終了を人に頼まない。裏で別のCLIを起動したり、この依頼を繰り返し送ったりしないでください。';
const TERMINAL_LIMIT_NOTE = 'ターミナルでは自動の引き継ぎは無い。上限で止まったら、渡す内容を作業ファイルに書いて返事を終える。人が［会話］から依頼を送った番で Fable の正式な上限が確認された時は、上の決まりで引き継がれる。';
const TERMINAL_HANDOFF_NOTE = 'あなたはターミナルで動いている。ここからは別の AI に委任できない。渡したい時は、渡す内容と指定モデルを作業ファイルに書いて返事を終える。人には「この作業の作業画面で［会話］に切り替えて、記録した依頼を送ってください」とだけ案内する。ターミナルを止める操作は頼まない（会話から送った依頼が断られた時に、会話側の AI が案内する）。';
const DELEGATE_COMPLETED_ERROR = 'この作業は完了済みのため委任できません。続ける場合は、人がこの作業の作業画面の上部の［再開する］を押してから依頼してください。新しい作業は作っていません';
function delegateRule(p, t) {
  const ids = p && t ? `"project":"${p.id}","task":"${t.id}"` : '"project":"<プロジェクトID>","task":"<作業ID>"';
  return `【別の AI に作業を渡す時】自分で codex / claude / agy を裏で起動しない。${CHAT_DELEGATE_NOTE} 会話画面で渡す時は Hub を使う：curl -s -X POST http://127.0.0.1:${PORT}/api/delegate -H 'X-Hub: 1' -H 'Content-Type: application/json' -d '{${ids},"ai":"codex","model":"gpt-6.1-sol","title":"短い名前","text":"頼む内容（必要な背景も）"}'。ai は codex / claude / agy。model は依頼文の中だけでなく、この欄で必ず指定する（チェックは ai: claude・model: claude-fable-5-1、文章・調査・デザインは claude-opus-5-5）。Hub は同じ作業の会話で担当 AI を切り替え、今の AI が動いている間は順番待ちにする。子作業は作らない。画面に順番待ち・作業中と出て、結果もこの会話に残る。相手に「実際のモデルを確かめて違えば止まれ」と書かない。モデルは model 欄で Hub が起動設定として保証する（実際のモデルの証明ではない）。モデル名を返させる時は「起動設定のモデル名」と頼む。上記の自動交代が有効な時は、Fable が上限なら Hub が Astra に引き継ぐので、自分で別のモデルへ委任し直さない。渡したらこの番を終えること。\n【プロジェクトや作業を増やさない】新しいプロジェクト・子プロジェクト・作業ファイル（.ai/tasks）を自分で作らない。分ける必要がある時は、人に提案して決めてもらう。やっていない手順に [x] を付けない。`;
}
// 人が決めた役割とモデル（roles.yaml）。AI が他のファイル（エージェントの設定など）の古い指定に従わないよう、毎回伝える
function modelPolicy(p, t, where = 'chat', projects) {
  // startDir が保存したコピーの場所・手順なども、同じ台帳の最新値で渡す。
  const current = store.readProject(p.id);
  if (current) { p = current; t = current.tasks.find(x => x.id === t.id) || t; }
  const d = rolesData();
  const label = s => (launch.AI_LABEL[s.ai === 'claude-code' ? 'claude' : s.ai] || s.ai);
  const slot = s => { if (!s || s.ai === '人' || !s.model) return ''; const f = launch.flagFor(s.ai === 'claude-code' ? 'claude' : s.ai, s.model); return `${label(s)}・${s.model}${f ? `（${f}）` : ''}`; };
  const limitPolicy = fableBackup(d) ? '【利用上限の時】司令塔・チェックの Fable 5.1 が利用上限で止まった時だけ、Hub が同じ作業で Codex・GPT-6-Astra に自動で引き継ぐ（人の決まり、会話画面のみ）。上限かどうかは Hub が CLI のエラー構造と正式な上限文で判断し、プロセス終了後に交代する。保持中は解除日時または手動解除までHubがAstraで開始。AIは確認不要。あなたは本文の「上限」という言葉や過去の引用で担当を変えない・止まらない。人の決めた担当モデル（main）は変わらない。引き継ぎで始まった番は、済んだ部分を繰り返さず残りを続ける。' : '【利用上限の時】現在は自動交代がオフ、または司令塔・チェックの Fable から Astra への予備担当が設定されていない。自分で別のモデルへ切り替えない。';
  const list = d.roles.map(r => slot(r.main) ? `${r.name}＝${slot(r.main)}` : '').filter(Boolean).join('、');
  return `【モデルの決まり（人が決めた。他のファイルや前の指示より優先）】${list}。人が Agy CLI を手動選択した依頼に限り Gemini 3.1 Pro (High)（gemini-3.1-pro-high）を使ってよい。既定の役割は変更しない。claude-opus-4-6 などの古いモデルは使わない。エージェント（紬・律など）に頼む時も、この決まりのモデルを指定すること。\n${limitPolicy}\n${delegateRule(p, t)}\n\n${guidance(p, t, { where, projects: projects || (t.kind === 'derived' && t.derivedFrom?.includes('/') && !t.derivedFrom.startsWith(p.id + '/') ? store.listProjects() : [p]), copy: inWork(p, t) && !copyMissing(p, t), copyMissing: copyMissing(p, t) })}`;
}

function taskPrompt(p, t, file, dir, where = 'chat', startup) {
  const issuesRule = `【問題点を短くまとめる決まり】PROJECT.md の issues を足す・変える時は、同じプロジェクトの .ai/issues-summary.json も更新する（他プロジェクトには書かない）。保存形式は {"items":[{"hash":"原文のsha256先頭16文字","title":"30字までの問題名","state":"未解決/確認待ち/判断待ち/解決済み/履歴のいずれか","next":"50字までの次の対応（無ければ空）","who":"人/AI/空のいずれか"}]}。原文は文字列ならそのまま、オブジェクトなら text。hash は Node の require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) で計算する（text は原文そのもの。空白・改行を変えない）。問題名と次の対応に作業ID・commit・テスト件数を入れない。新しい状態の項目を足したら、同じ件の古い項目は「履歴」にする。確かめていない事は「確認待ち」にし、不具合・解決と断定しない。原文は消さない。`;
  const rel = dir && path.relative(workRoot(p), dir);
  const copy = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `今いるフォルダ（${dir}）はこの作業専用の作業用コピー。ここだけで作業し、本体には触らないこと（取り込みは人が作業画面の［本体に取り込む］で行う）。`
    : dir ? `今いるフォルダ（${dir}）は本体。この作業は作業用コピーを使わず、ここで作業してよい（Hub が本体で作業すると決めた。作業ルールに「作業用コピーの中だけ」とあっても、この作業では本体に保存してよい。作業用コピーを作るよう人に頼まない）。` : '';
  const refs = p.folders.filter(f => /^参考/.test(f.label)).map(f => expandHome(f.path));
  let projects;
  const rels = p.related.map(r => {
    const byId = store.readProject(r);
    if (byId) return byId.dir;
    projects ||= store.listProjects();
    return projects.find(x => x.name === r)?.dir;
  }).filter(Boolean);
  const { family, sourceOf } = require('./lib/work-context');
  const all = projects ||= store.listProjects(), same = family(p, all);
  const source = sourceOf(p,t.derivedFrom,all);
  const sameRefs = same.filter(q=>q.id!==p.id).map(q=>q.dir);
  const context = `この作業は${t.kind === 'derived' ? '派生作業' : '本作業'}。${source ? '派生元の作業ファイル: ' + store.taskFile(source.project.id,source.task.id) + '。' : ''}${sameRefs.length ? '同じ大きなプロジェクト内の参照（読むだけ）: '+sameRefs.join(' / ')+'。' : ''}`;
  const look = refs.length || rels.length ? `参考にしてよい場所（読むだけ。書き換えない）: ${[...refs, ...rels].join(' / ')}。` : '';
  if (where !== 'terminal') {
    const read = `作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きを。読む：台帳/.ai/rules.md・台帳/PROJECT.md・台帳/.ai/tasks/${t.id}.md。区切りで更新、実施した手順だけ[x]（無ければ3〜5個）。workdir・state・questionは書き換えない（Hub管理）。`;
    return instructions.packet({ pdir: p.dir, project: p.id, task: t.id, policy: modelPolicy(p, t, where, all), issues: issuesRule, port: PORT, contextRule: launch.CONTEXT_RULE, askRule: chat.ASK_RULE,
      common: [dir ? `cwd=${dir === p.dir ? '台帳' : '台帳/' + path.relative(p.dir, dir).split(path.sep).join('/')}。${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? '専用の作業用コピー。ここだけで作業。本体には触らない（取り込みは人の［本体に取り込む］）。' : '本体。コピーは使わず、ここで作業してよい（Hub指定）。'}` : '', look, context, read].filter(Boolean).join('\n') });
  }
  return [modelPolicy(p, t, where, all), where === 'terminal' ? TERMINAL_HANDOFF_NOTE + '\n' + TERMINAL_LIMIT_NOTE : '', where === 'terminal' && startup ? launch.startupInfo(startup.ai, startup.model) : '', launch.CONTEXT_RULE, copy, look, context, issuesRule, `作業「${String(t.title).replace(/[\r\n]+/g, ' ')}」（作業ID ${t.id}）の続きをしてください。まず次の3つを読むこと: ${path.join(p.dir, '.ai', 'rules.md')} / ${path.join(p.dir, 'PROJECT.md')} / ${file}。区切りごとに作業ファイルを更新し、「## 手順」の終わった所を [x] にすること（手順が無ければ3〜5個書く）。作業ファイルの先頭の workdir・state・question の行は Hub が管理する：書き換えない（特に、取り込み済みの後に古い内容で書き戻さない）。`].filter(Boolean).join('\n\n');
}

function usageWithLimit(snapshot) {
  // 表示も開始前の共通判定から作る。旧fable-limit.jsonは読まず変更もしない。
  const state = fableBackup(rolesData()) && limitEvidence.active();
  return { ...snapshot, fableLimit: state ? { model: 'claude-fable-5-1', at: state.at, until: state.validUntil, untilSource: state.untilSource, hold: true } : null };
}

function delegateResult(status,value){if(status!==200)throw Object.assign(Error(value.error||'委派未完成'),{status});return value;}
async function delegateTask(b,nativeContext=null,{origin='api'}={}){
    const p = store.readProject(b.project);
    const file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const ai = b.ai === 'claude-code' ? 'claude' : b.ai;
    if (!p || !file || !launch.AIS.includes(ai)) return delegateResult(400, { error: 'project・task・ai（codex / claude / agy）を確かめてください' });
    if (!text || text.length > 8000) return delegateResult(400, { error: 'text は1〜8000文字' });
    if (aiTools.isOperating()) return delegateResult(409, { error: 'AI の更新・モデル再取得が進行中です' });
    const t = store.readTask(file);
    const sizeNote = text.length > 1500 ? ' Hub が付ける内容を除き、差分だけにすると短くなります' : '';
    const title = String(b.title || text.split('\n')[0]).trim().slice(0, 60) || '渡した作業';
    if (t.state === '完了') return delegateResult(409, { error: DELEGATE_COMPLETED_ERROR });
    // 委任先の役割は元の担当と異なることがある。親の role/model や CLI の既定へは戻さない。
    const role = b.role && rolesData().roles.find(r => r.name === b.role);
    if (b.role && (!role || role.main.ai !== launch.AI_KEY[ai])) return delegateResult(400, { error: 'role は指定した AI が主担当の役割を選んでください' });
    const model = launch.modelLabel(ai, typeof b.model === 'string' ? b.model.trim() : role?.main.model || '');
    if (!model) return delegateResult(400, { error: 'model 又は role を明示してください。例：チェックは ai: claude・model: claude-fable-5-1、書込は ai: codex・model: gpt-6.1-sol。作業は増やしていません' });
    if(ai==='codex')await ensureCodexCatalog(15000);
    const invalid = modelError(ai, model);
    if (invalid) return delegateResult(409, { error: invalid });
    if (!launch.flagFor(ai, model) && !((ai==='codex'||process.platform==='win32'&&['claude','grok'].includes(ai))&&model===launch.CLI_DEFAULT_LABEL)) return delegateResult(409, { error: '委任には CLI に渡すモデル名が必要です。指定なしでは起動しません' });
    const terminalError = delegateTerminalError(p.id, t.id);
    if (terminalError) return delegateResult(409, { error: terminalError });
    const sourceTurn = chats.busy(p.id, t.id)?.userRow?.turn || null;
    const busy = Boolean(chats.busy(p.id, t.id));
    let dir,workspaceFlow;
    try { ({ dir,workspaceFlow } = await nativeStartDir(p,t,{workspacePermit:b.workspacePermit,allowExisting:busy,actor:ai,noReentry:origin==='mcp'})); } catch (e) {if(e.workspaceRequired)throw e;return delegateResult(409,nativeWorkspaceError(e));}
    const effort = nativeContext?nativeContext.effort:ai === 'agy' ? '高' : roles.EFFORTS.includes(b.effort) ? b.effort : role?.main.effort || '';
    const shown = `【渡した依頼：${title}】\n${text}`;
    const request = { ai, model, effort, sourceTurn, workspaceFlow, role: b.role || '', requireModel: true, requiredModel: launch.flagFor(ai, model), shown, text: shown + '\n\n新しい作業・子作業を作らず、この既存作業で依頼を行い、結果をこの会話へ返してください。', perm: chatPermCmd(ai) };
    const enqueue = () => {
      if(!chats.busy(p.id,t.id))workspaceRuntime.hold(workspaceFlow);
      const item = chats.enqueue(p.id, t.id, request);
      record('delegate', { project: p.id, task: t.id, ai }, { title, model, effort, queued: true, id: item.id, sourceTurn });
      return delegateResult(200, { ok: true, project: p.id, task: t.id, title, model, effort, queued: true, id: item.id, queue: chats.queue(p.id, t.id).length, note: (chats.busy(p.id, t.id) ? '今の AI が終わったら、同じ作業で指定の AI が始まります。開始時に上限継続を確かめた時は Astra で始めます。この番を終えてください' : '同じ作業の順番待ちに追加しました。画面の［始める］で再開できます') + sizeNote });
    };
    if (busy || chats.queue(p.id, t.id).length) return enqueue();
    const basePrompt = taskPrompt(p, t, file, dir) + ' 同じ作業で担当 AI から渡された依頼です。結果と残った課題をこの会話へ返してください。';
    const onEnd = row => {
      if (row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || '選んでください' });
      chatEnded(p.id, t.id);
      record('delegateend', { project: p.id, task: t.id, ai: row.ai }, { title, model: row.model, error: Boolean(row.error) });
    };
    try {
      const stopVersion = chats.stops.get(chats.key(p.id, t.id)) || 0;
      await refreshLimitEvidence(request);
      if ((chats.stops.get(chats.key(p.id, t.id)) || 0) !== stopVersion) throw Error('利用上限の確認中に停止されたため、委任を開始していません');
      const terminalError = delegateTerminalError(p.id, t.id);
      if (terminalError) throw Error(terminalError);
      // 状態要求を待つ間に他の依頼が始まった場合も同じ待ち順へ入れる。
      if (chats.busy(p.id, t.id) || chats.queue(p.id, t.id).length) return enqueue();
      const r = await sendNativeProviderChat({ ...request, project: p.id, task: t.id, pdir: p.dir, dir, basePrompt, policy: modelPolicy(p, t), onEnd });
      if (!(await r.started)) throw Error('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません');
      store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      record('delegate', { project: p.id, task: t.id, ai: r.ai }, { title, model: r.model, effort: r.effort, queued: false, preflight: Boolean(r.limitSwitch?.preflight), sourceTurn, receivedTurn: r.userRow.turn });
      return delegateResult(200, { ok: true, project: p.id, task: t.id, title, ai: r.ai, model: r.model, effort: r.effort, queued: false, resume: r.resume, note: `${r.limitSwitch?.preflight ? 'Fable上限保持中のため Astra で開始しました。' : ''}同じ作業で ${launch.AI_LABEL[r.ai]}・${r.model} が作業中です。結果もこの会話へ届きます` + sizeNote });
    } catch (e) {await failNativeWorkspace(workspaceFlow,e);return delegateResult(409,nativeWorkspaceError(e));}
  }

async function api(req, res, url) {
  if(shutdown.running&&req.method!=='GET')return send(res,503,{error:'Hub 正在關閉；未啟動任何程序',notStarted:true});
  if(req.method==='GET'&&url.pathname==='/api/web-chat/status'){
    let input;try{input=JSON.parse(decodeURIComponent(req.headers['x-hub-web-receipt']||''));}catch{return send(res,400,{error:'請在 X-Hub-Web-Receipt 提供此次交易的範圍'});}
    if(url.search)return send(res,400,{error:'交易查詢不接受 URL 參數'});
    return webChatRoute(req,res,'status',input);
  }
  if(process.platform==='win32'&&url.pathname.startsWith('/api/chatgpt/register')&&req.method==='GET')return nativeMcpRegistrationRoute(req,res,url);
  if(process.platform==='win32'&&fromRemote()&&['/api/quit','/api/restart','/api/pick-folder','/api/chatgpt','/api/chatgpt/register','/api/ai-tools/update'].includes(url.pathname)&&req.method!=='GET')return send(res,403,{error:'此主機管理操作僅限本機使用者'});
  // Mac の許可が無くて中を読めない時の知らせ（Finder が違う場所で開くのを防ぐ）
  const denied = x => { try { fs.readdirSync(fs.statSync(x).isDirectory() ? x : path.dirname(x)); return ''; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code) ? 'Mac の許可が無くて開けません。設定画面の「Mac のファイルの許可」で［確認をもう一度出す］を押し、「許可」を選んでください' : ''; } };
  // 本体が台帳のフォルダ（書類フォルダの中）を読めるか。Mac の許可が本体に効いているかをアプリが確かめる
  if (req.method === 'GET' && url.pathname === '/api/access') {
    try { fs.readdirSync(ROOT); return send(res, 200, { ok: true, root: ROOT }); }
    catch (e) { return send(res, 200, { ok: false, root: ROOT, code: e.code || '' }); }
  }
  // 一覧
  // 生きているかだけ答える（ファイルを読まないので、台帳が大きくても・iCloud が遅くてもすぐ返る）
  if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true, version: VERSION, pid: process.pid });
  if (req.method === 'GET' && url.pathname === '/api/state') {
    for(const ai of ['claude','grok'])ensureNativeCatalog(ai);
    const t0 = Date.now();
    res.on('finish', () => { const ms = Date.now() - t0; if (ms > 2000) console.log(`[遅い] 一覧を作るのに ${ms}ms かかりました（台帳のファイルの読み込みが遅い可能性）`); });
    const roleData = rolesData(), modelSettings = modelView.read(), initialPick = modelView.initial(modelSettings);
    pruneUnread(); // 起動前から残っていた通知・外で片付けられた作業にも対応する。
    // 画面で使う物だけ送る：作業の「やったこと」「注意」「メモ」の本文は送らず、「次にやること」は1行目だけ（1MB → 数百KB）
    const slim = t => { const { done, note, memo, next, ...rest } = t; return { ...rest, next: String(next || '').split('\n')[0] }; };
    const state = {
      providers:providers.list(nativeProviderOptions()),webChatAvailable:Boolean(webChat),
      root: ROOT, roles: roleData, version: VERSION, latest: readVersion(),
      github: github.summary(),
      completionWarning: store.completion.warning, projectOrder: projectOrder.read(), projectPins: projectOrder.readPins(),
      taskHandoffs: taskTransfer.pending(),
      taskOffers: taskTransfer.offers(), taskIntegrations: taskIntegrate.pending(),
      cliFlags: Object.fromEntries(launch.AIS.map(ai => [ai, Object.fromEntries((roleData.models[launch.AI_KEY[ai]] || []).map(m => [m, launch.flagFor(ai, m)]))])),
      // github：origin の場所と今のブランチ（120秒覚えておく）。作業は作業用コピーがある物だけ（ブランチが別のため）
      projects: (all => { const kids = handoff.childCounts(all); return all.map(p => {
        const base = baseOf(p),gitRead=gitw.readSummary(base);
        return { ...p, children: kids[p.id], startSpec: start.lastSpec(p), copies: gitw.countCopies(workRoot(p)), githubHasOrigin: gitRead.hasOrigin, github: gitRead.remote, gitReadState:gitRead.state,gitReadError:gitRead.error, tasks: p.tasks.map(t => {
          const missing = copyMissing(p, t);
          const mergeRecovery = process.platform === 'win32' ? reviewedMerge.recovery(p.id, t.id) : null;
          return { ...slim(t), copy: inWork(p, t) && !missing, copyMissing: missing,
            ...(process.platform==='win32'?{workspaceLifecycle:workspaceRuntime.summary(p.id,t.id)}:{}),
            ...(mergeRecovery && (!mergeRecovery.complete || missing) ? { mergeRecovery } : {}),
            ...(t.workdir && !missing ? (()=>{const view=gitw.readSummary(expandHome(t.workdir));return {github:view.remote,gitReadState:view.state,gitReadError:view.error};})() : {}) };
        }) };
      }); })(store.listProjects()),
      sessions: sessions.list(), terminal: sessions.available(),
      chatting: [...chats.running.entries()].map(([k, r]) => { const [project, task] = k.split('\u0000'); return { project, task, ai: r.ai, model: r.model }; }),
      initialPick, initialPickError: modelError(initialPick.ai, initialPick.model),
      efforts: roles.EFFORTS, hiddenModels: modelView.hidden(modelSettings), modelOrder: modelView.saved(modelSettings), phoneLabels: modelView.phone(modelSettings),
      unread: [...unread].map(k => { const [project, task] = k.split('\u0000'); return { project, task }; }),
      background: procwatch.list().filter(x => x.project), backgroundMonitoring: true, backgroundStatus: procwatch.status(), windowsBrowser: process.platform === 'win32',
        remote: { enabled: process.platform === 'win32' ? false : remote.enabled() }, chatgpt: gpt.settings(), hubDir: __dirname, nodeExe: process.execPath,
      agyAvailable: Boolean(aiTools.find('agy') && aiTools.catalog().agy.models.some(x => x.id === launch.AGY_MODEL.id) && !launch.agyAccountError()),
    };
    // 変わっていなければ中身を送らない（304）。画面は15秒ごとに聞いてくるので、何も変わらない時はほぼ空の返事で済む
    // 止まっている秒数（quiet）は毎秒変わるので印には入れない（画面は別に /api/sessions で取る）
    const body = JSON.stringify(state);
    const tagBody = state.sessions.length ? JSON.stringify({ ...state, sessions: state.sessions.map(({ quiet, ...x }) => x) }) : body;
    const tag = `"${crypto.createHash('sha1').update(tagBody).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ETag: tag });
    return res.end(body);
  }
  // 裏で動いている AI の全部（どのプロジェクトにも当たらない物も含む）
  if (req.method === 'GET' && url.pathname === '/api/background') return send(res, 200, { items: procwatch.list(), supported: true, status: procwatch.status() });
  if (req.method === 'GET' && url.pathname === '/api/ai-tools') {
    const status = await aiTools.status();
    applyModelCatalog();
    return send(res, 200, status);
  }
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const origin = req.headers.origin;
    if (req.headers['x-hub'] !== '1' || origin && ![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(origin)) return send(res,403,{ error:'forbidden' });
    return send(res, 200, usageWithLimit(await usage.status()));
  }
  if (req.method === 'POST' && url.pathname === '/api/limits/fable/clear') {
    try { limitEvidence.clear(); }
    catch { return send(res, 500, { error: '解除を保存できませんでした' }); }
    record('limit-clear', {});
    // 解除に利用枠の取得を待たせない。遅れて届く応答もフラグを作らない。
    return send(res, 200, usageWithLimit(usage.snapshot()));
  }
  if (req.method === 'POST' && url.pathname === '/api/usage/refresh') return send(res, 200, usageWithLimit(await usage.status(true)));

  // 会話画面：今までの会話と、書いている途中の返事を流す
  if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task');
    const p = store.readProject(project);
    if (!p || !store.taskFile(project, task)) return send(res, 404, { error: '作業が見つかりません' });
    setUnread(project, task, false); // 開いたので読んだことにする
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const run = chats.busy(project, task);
    emit({ type: 'rows', rows: chat.read(p.dir, task), busy: run ? { ai: run.ai, model: run.model, text: run.texts.join(run.ai === 'agy' ? '' : '\n\n'), started: run.started, last: run.last } : null, queue: chats.queue(project, task), approvals: run?.child?.listApprovals?.() || [] });
    const off = chats.watch(project, task, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/api/cli-models') {
    const m = rolesData().models;
    const rows = ai => (m[launch.AI_KEY[ai]] || []).map(name => ({ name, flag: launch.flagFor(ai, name), set: Object.prototype.hasOwnProperty.call(launch.getOverrides()[ai] || {}, name) }));
    return send(res, 200, { claude: rows('claude'), codex: rows('codex'), agy: rows('agy'),grok:rows('grok'), hints: cliModelHints() });
  }
  // ChatGPT の道具（mcp.js から）。X-Hub の印がある物だけ
  if (url.pathname.startsWith('/api/mcp/')) {
    if (req.headers['x-hub'] !== '1') return send(res, 403, { error: 'forbidden' });
    const scope = reqCtx.getStore()?.mcpScope;
    if (process.platform === 'win32' && ['/api/mcp/tools','/api/mcp/call'].includes(url.pathname) && !scope) return send(res, 403, { error: '此 MCP 呼叫需要專案及回合限定的獨立憑證' });
    if (req.method === 'GET' && url.pathname === '/api/mcp/tools') return send(res, 200, { tools: gpt.tools(scope), work: gpt.settings().work });
    if (req.method === 'POST' && url.pathname === '/api/mcp/call') {
      const b = await readBody(req);
      try {
        if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['name','arguments'].includes(k)) || typeof b.name !== 'string' || !b.arguments || typeof b.arguments !== 'object' || Array.isArray(b.arguments)) return send(res, 400, { error: 'MCP 道具呼叫格式無效' });
        const grant = scope ? mcpCapabilities.consume({ token: req.headers.authorization.slice(7), runId: req.headers['x-hub-mcp-run'], nonce: req.headers['x-hub-mcp-nonce'], tool: b.name, arguments: b.arguments }) : null;
        if(!['hub_list_projects','hub_list_tasks','hub_get_task','hub_get_chat','hub_read_file','hub_get_command_result'].includes(b.name))assertNativeMutationUnlocked(b.arguments.project,{task:b.arguments.task,allowOwned:Boolean(grant?.workspaceRun)});
        const r = await gpt.call(b.name, b.arguments, grant);
        return send(res, 200, { text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) });
      }
      catch (e) { return send(res, e.status || 500, { error: String(e.message || e), unknown: e.status === 404 && /^その道具/.test(e.message), ...(e.partial === true ? { partial: true } : {}), ...(e.created === true ? { created: true } : {}), ...(e.overwritten===true?{overwritten:true}:{}), ...(e.recoveryRequired===true?{recoveryRequired:true}:{}), ...(e.recordId?{recordId:e.recordId}:{}) }); }
    }
    if (!['/api/mcp/capability','/api/mcp/capability/revoke'].includes(url.pathname)) return send(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && url.pathname === '/api/github') return send(res, 200, { ...await github.status({ fresh: url.searchParams.get('fresh') === '1' }), settings: github.settings() });
  if (req.method === 'GET' && url.pathname === '/api/chatgpt') return send(res, 200, { ...gpt.settings(), ...codexMcpStatus(),...(process.platform==='win32'?{delegationModels:(rolesData().models.codex||[]).map(label=>({label,id:launch.flagFor('codex',label)})).filter(row=>row.id&&!modelError('codex',row.label))}:{}) });
  if (req.method === 'GET' && url.pathname === '/api/commands') return send(res,200,{intents:commandIntents.list()});
  // 外から使う（iPhone）の設定
  if (req.method === 'GET' && url.pathname === '/api/remote') {
    if (nativeRemote) return send(res,200,{...remote.status(),tls:nativeRemote.status(),url:nativeRemote.status().url||'',hint:'指定 Windows 私有網路位址與有效 HTTPS 憑證；預設關閉。'});
    const st = remote.status(); return (st.url ? Promise.resolve(st.url) : tailscaleUrl()).then(u => send(res, 200, { ...st, url: u }));
  }
  if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: VERSION, latest: readVersion() });
  if (req.method === 'GET' && url.pathname === '/api/changelog') return send(res, 200, changelog(12));
  if (req.method === 'GET' && url.pathname === '/api/sessions') return send(res, 200, sessions.list());
  if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, readLog(Math.min(200, Number(url.searchParams.get('n')) || 50)));
  // 取り込む前の見通し（変更の量・ぶつかりそうか）
  if (req.method === 'GET' && url.pathname === '/api/task/preview') {
    const p = store.readProject(url.searchParams.get('project'));
    const file = p && store.taskFile(p.id, url.searchParams.get('task'));
    if (!file) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 200, null);
    let r = null;
    try { r = gitw.preview({ dir: expandHome(t.workdir), workRoot: workRoot(p) }); } catch (e) { r = null; }
    return send(res, 200, r);
  }

  // 作業画面の出力を流す（Server-Sent Events）
  if (req.method === 'GET' && url.pathname === '/api/term/stream') {
    const project = url.searchParams.get('project'), task = url.searchParams.get('task'), ai = url.searchParams.get('ai');
    const s = sessions.get(project, task, ai);
    if (!s) return send(res, 404, { error: '作業画面がありません' });
    setUnread(project, task, false); // 開いたので読んだことにする
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    emit({ type: 'data', data: s.buf, replay: true });
    if (s.exited) emit({ type: 'exit', code: s.code });
    const off = sessions.watch(project, task, ai, emit);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { off(); clearInterval(ping); });
    return undefined;
  }

  // GitHub の場所（その場で読み直す）。作業に作業用コピーがあればそのブランチ
  if (req.method === 'GET' && url.pathname === '/api/project/github') {
    const p = store.readProject(url.searchParams.get('project'));
    const task = url.searchParams.get('task');
    const file = p && task ? store.taskFile(p.id, task) : null;
    const wd = file ? expandHome(store.readTask(file).workdir) : '';
    const info = p ? gitw.remoteInfo(wd && fs.existsSync(wd) ? wd : baseOf(p), { fresh: true }) : null;
    return info ? send(res, 200, info) : send(res, 404, { error: 'GitHub の場所が見つかりません' });
  }

  // 子プロジェクトの一覧（親で作業を続ける前に、終わっていない子を知らせるため）
  if (req.method === 'GET' && url.pathname === '/api/project/children') {
    const r = handoff.childrenSummary(store, url.searchParams.get('project'));
    return r ? send(res, 200, r) : send(res, 404, { error: 'プロジェクトが見つかりません' });
  }
  if (req.method === 'GET' && url.pathname === '/api/start/image') {
    const p = store.readProject(url.searchParams.get('project'));
    try {
      if (!p) throw Error('プロジェクトがありません');
      const f = start.imageFile(p, url.searchParams.get('id'), true);
      return send(res, 200, fs.readFileSync(f), /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png');
    } catch { return send(res, 404, { error: '画像が見つかりません' }); }
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method' });

  // ファイル・スクショを受け取る（本文はファイルそのもの）。Inbox に置き、作業ファイルに記録し、動いている AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/upload') {
    const q = k => url.searchParams.get(k) || '';
    const p = store.readProject(q('project'));
    assertNativeMutationUnlocked(q('project'));
    const file = p && store.taskFile(p.id, q('task'));
    if (!file) { req.resume(); return send(res, 400, { error: '作業が見つかりません' }); }
    let data;
    try { data = await readRaw(req, MAX_UPLOAD); } catch (e) { return send(res, 413, { error: 'ファイルが大きすぎます（50MB まで）' }); }
    const saved = saveUpload(q('name'), data);
    store.updateTask(p.id, q('task'), { memo: `ファイルを渡した: ${saved}` });
    const ai = launch.AIS.includes(q('ai')) ? q('ai') : '';
    let typed = false;
    if (ai) {
      if (process.platform === 'win32') { try { typed = sessions.writeView(p.id, q('task'), ai, (/\s/.test(saved) ? `"${saved}"` : saved) + ' ', { viewId: req.headers['x-hub-term-view'], lease: req.headers['x-hub-term-lease'] }); } catch (e) { if (![400,403,404,409].includes(e.status)) throw e; } }
      else typed = sessions.write(p.id, q('task'), ai, (/\s/.test(saved) ? `"${saved}"` : saved) + ' ');
    }
    record('upload', { project: p.id, task: q('task'), ai }, { file: saved, bytes: data.length });
    return send(res, 200, { ok: true, path: saved, typed });
  }

  if (url.pathname === '/api/start/image') {
    const p = store.readProject(url.searchParams.get('project'));
    assertNativeMutationUnlocked(url.searchParams.get('project'));
    if (!p) { req.resume(); return send(res, 400, { error: 'プロジェクトがありません' }); }
    try { return send(res, 200, start.saveImage(p, url.searchParams.get('name') || 'image.png', await readRaw(req, start.MAX))); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  const b = await readBody(req);
  if(url.pathname.startsWith('/api/web-chat/'))return webChatRoute(req,res,url.pathname.slice('/api/web-chat/'.length),b);
  if(process.platform==='win32'&&['/api/chatgpt/prompt','/api/chatgpt/result'].includes(url.pathname)){
    const action=url.pathname.endsWith('/prompt')?'confirm':'result';
    const mandatory=action==='confirm'?['receiptId','previewToken','expectedTaskHash','expectedPromptSHA256']:['receiptId','token','requestId','resultSHA256','taskHash','promptSHA256'];
    if(!b||mandatory.some(key=>typeof b[key]!=='string')||action==='confirm'&&b.confirm!==true)return send(res,409,{error:'請先預覽並確認此次交接',code:'HANDOFF_PREVIEW_REQUIRED'});
    if(Object.hasOwn(b,'actor')&&b.actor!=='chatgpt')return send(res,400,{error:'舊入口僅適用 ChatGPT'});
    return webChatRoute(req,res,action,{...b,actor:'chatgpt'});
  }
  if(process.platform==='win32'&&url.pathname.startsWith('/api/chatgpt/register'))return nativeMcpRegistrationRoute(req,res,url,b);
  if(url.pathname.startsWith('/api/workspace-destination/')){
    if(process.platform!=='win32'||!localOwner(req)||fromRemote()||reqCtx.getStore()?.mcpScope||req.headers.authorization!==undefined)return send(res,403,{error:'工作區目的地確認僅限本機使用者'});
    try{
      if(url.pathname==='/api/workspace-destination/preview'){const preview=await workspaceDestinations.preview(b);record('workspace-destination-preview',b,{tokenHash:crypto.createHash('sha256').update(preview.token).digest('hex'),destination:preview.destination,reviewHash:crypto.createHash('sha256').update(JSON.stringify(preview.review)).digest('hex')});return send(res,200,preview);}
      if(url.pathname==='/api/workspace-destination/approve'){
        // Persistent audit must precede the usable mark. A failed approval can
        // leave an intent record, never a fabricated successful completion.
        record('workspace-destination-intent',{}, {tokenHash:crypto.createHash('sha256').update(String(b.token)).digest('hex'),ackDestination:b.ackDestination===true,ackReadLimits:b.ackReadLimits===true});
        return send(res,200,await workspaceDestinations.approve(b));
      }
      return send(res,404,{error:'未知工作區目的地操作'});
    }catch(error){return send(res,error.status||409,{error:'工作區目的地核准失敗；未啟動 AI',code:error.code});}
  }
  if(url.pathname.startsWith('/api/native-provider/')){
    if(!nativeProviderService||!localOwner(req)||fromRemote()||reqCtx.getStore()?.mcpScope||req.headers.authorization!==undefined)return send(res,403,{error:'原生 CLI 登入檔授權僅限本機使用者'});
    const action=url.pathname.slice('/api/native-provider/'.length);
    try{
      if(action==='preview')return send(res,200,await nativeProviderService.preview(b));
      if(action==='approve'){
        const result=await nativeProviderService.approve(b);
        try{record('native-provider-approve',{project:result.project,task:result.task,ai:result.actor},{grantId:result.grantId,expiresAt:result.expiresAt,destination:result.actor==='claude'?'Anthropic':'xAI',authenticationReadOnly:true,ackCommandAccess:true});}
        catch{await nativeProviderService.revoke({actor:result.actor,project:result.project,task:result.task});return send(res,500,{error:'授權操作記錄未完成，已撤銷此次 CLI 授權'});}
        const flow=workspaceRuntime.current(result.project,result.task);if(flow&&!workspaceRuntime.isParked(flow))workspaceDestinations.mark(flow,result.actor);
        return send(res,200,result);
      }
      if(action==='revoke'){
        for(const [runId,owned]of nativeProviderResources)if(owned.project===b.project&&owned.task===b.task&&owned.actor===b.actor){mcpCapabilities.revokeRun(runId);commandIntents.cancelRun(runId);}
        return send(res,200,await nativeProviderService.revoke(b));
      }
      return send(res,404,{error:'未知原生 CLI 授權操作'});
    }catch(error){return send(res,error.status||409,nativeWorkspaceError(error));}
  }
  const transactionReadRoutes=new Set(['/api/task/merge/preview','/api/task/merge','/api/task/handup/preview','/api/task/handup','/api/task/absorb','/api/task/integrate/preview','/api/task/integrate','/api/task/recovery','/api/github/owners','/api/github/preview','/api/chatgpt/prompt','/api/empty/scan','/api/empty/preview','/api/hierarchy/remove/preview','/api/hierarchy/remove/history','/api/maintenance/preview','/api/maintenance/restore/preview','/api/term/view/register','/api/term/view/heartbeat','/api/term/view/claim','/api/term/view/disconnect','/api/term/input','/api/term/resize','/api/term/stop','/api/chat/stop','/api/mcp/capability/revoke','/api/commands/cancel','/api/commands/decide','/api/quit']);
  const workflowRoutes=['/api/task/workspace/discover','/api/task/workspace/preview','/api/task/workspace/prepare','/api/task/workspace/close','/api/chat/send','/api/delegate','/api/term/start','/api/term/handoff','/api/continue'];
  const ownTaskDisplay=url.pathname==='/api/task'&&Object.keys(b).every(k=>['project','task','state','question','memo'].includes(k))&&typeof b.project==='string'&&typeof b.task==='string'&&['state','question','memo'].some(k=>Object.hasOwn(b,k))&&['state','question','memo'].every(k=>!Object.hasOwn(b,k)||typeof b[k]==='string');
  if(!transactionReadRoutes.has(url.pathname)&&!workflowRoutes.includes(url.pathname))assertNativeMutationUnlocked(b.project,{task:b.task,allowOwned:(ownTaskDisplay||['/api/task/step','/api/task/read','/api/chat/note','/api/chat/approval','/api/chat/unqueue'].includes(url.pathname))&&Boolean(workspaceRuntime.current(b.project,b.task))});
  if (url.pathname === '/api/github') return send(res, 200, await github.save(b));
  if (url.pathname === '/api/github/owners') return send(res, 200, { owners: await github.owners(b.account) });
  if (url.pathname === '/api/github/preview' || url.pathname === '/api/github/create') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 404, { error: 'プロジェクトが見つかりません' });
    if (url.pathname.endsWith('/preview')) return send(res, 200, await github.preview(githubProject(p)));
    if (b.confirm !== true) return send(res, 400, { error: '確認画面で［作る］を押してください' });
    const r = await github.create(githubProject(p), b);
    record('githubcreate', { project: p.id }, { ok: r.ok, pushed: r.pushed, private: true, partial: Boolean(r.partial) });
    return send(res, 200, r);
  }
  if (url.pathname === '/api/remote') {
    if(nativeRemote){
      if(fromRemote()||!localOwner(req))return send(res,403,{error:'請由本機使用者設定遠端入口'});
      if(Object.keys(b).some(k=>!['enabled','passcode'].includes(k))||b.enabled!==undefined&&typeof b.enabled!=='boolean')return send(res,400,{error:'遠端設定格式無效'});
      if(b.enabled===true){await nativeRemote.start();try{const r=remote.update(b);if(r.error)throw Object.assign(Error(r.error),{status:400});}catch(error){await nativeRemote.stop();throw error;}}
      else{const r=remote.update(b);if(r.error)return send(res,400,{error:r.error});if(b.enabled===false)await nativeRemote.stop();}
      record('remote',{}, {enabled:remote.enabled(),passcode:b.passcode!==undefined});return send(res,200,{...remote.status(),tls:nativeRemote.status(),url:nativeRemote.status().url||''});
    }
    const r = remote.update({ enabled: b.enabled, passcode: b.passcode });
    if (r.error) return send(res, 400, { error: r.error });
    record('remote', {}, { enabled: remote.enabled(), passcode: b.passcode !== undefined });
    return send(res, 200, remote.status());
  }
  if(['/api/remote/tls/preview','/api/remote/tls/configure'].includes(url.pathname)){
    if(!nativeRemote||fromRemote()||!localOwner(req))return send(res,403,{error:'HTTPS 設定僅限本機使用者'});
    if(remote.enabled())return send(res,409,{error:'請先關閉遠端入口，再核對新的 HTTPS 設定'});
    return send(res,200,url.pathname.endsWith('/preview')?nativeRemote.preview(b):await nativeRemote.configure(b));
  }
  // ChatGPT に貼る文：普段の ChatGPT の会話は Mac の道具（MCP）を使えないので、作業の中身を文に入れる
  if (url.pathname === '/api/chatgpt/prompt') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    if (!file || !fs.existsSync(file)) return send(res, 400, { error: '作業が見つかりません' });
    const cut = (v, n) => (v.length > n ? v.slice(0, n) + '\n…（長いので省略）' : v);
    let ledger = ''; try { ledger = fs.readFileSync(path.join(p.dir, 'PROJECT.md'), 'utf8'); } catch (e) { /* 無くてもよい */ }
    const rows = chat.read(p.dir, b.task).filter(r => (r.role === 'user' || r.role === 'assistant') && r.text).slice(-6);
    const talk = rows.map(r => `[${r.role === 'user' ? (r.from ? '結果' : '人') : (launch.AI_LABEL[r.ai] || r.ai || 'AI')}] ${cut(r.text, 1500)}`).join('\n\n');
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const out = [`Project Hub の作業「${b.task}」をお願いします。必要な中身は下に全部入れてあります（道具やファイルを探す必要はありません）。相談・レビュー役として、日本語で答えてください。最後に「## 結果」と「## 次にやること」を短くまとめてください。人に決めてほしいことがあれば「## 質問」に書いてください。`,
      `# 作業ファイル\n${cut(fs.readFileSync(file, 'utf8'), 12000)}`,
      ledger && `# 台帳（PROJECT.md）\n${cut(ledger, 4000)}`,
      talk && `# これまでの会話（新しい6件）\n${talk}`,
      text && `# 今回の依頼\n${text}`].filter(Boolean).join('\n\n');
    return send(res, 200, { ok: true, text: out });
  }
  // ChatGPT の返事を貼って Hub に戻す（会話に ChatGPT の返事として残し、作業ファイルに1行書く）
  if (url.pathname === '/api/chatgpt/result') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!file || !fs.existsSync(file) || !text || text.length > 50000) return send(res, 400, { error: '作業と返事を確かめてください' });
    const row = chat.append(p.dir, b.task, { role: 'assistant', ai: 'chatgpt', text });
    chats.emit(p.id, b.task, { type: 'row', row });
    try { store.appendSection(p.id, b.task, 'やったこと', `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ChatGPT の返事を受け取った（会話に記録）`); } catch (e) { /* 無くてもよい */ }
    return send(res, 200, { ok: true });
  }
  // ChatGPT アプリ（中身は Codex）に Hub の道具を登録する：~/.codex/config.toml に [mcp_servers.project-hub] を書き足す
  if (url.pathname === '/api/chatgpt/register') {
    if (process.platform === 'win32') return send(res, 409, { error: 'Windows 瀏覽器版尚不支援 ChatGPT MCP 註冊' });
    const r = codexMcpRegister();
    if (r.error) return send(res, 400, { error: r.error });
    record('chatgptregister', {}, { file: r.file, added: r.added });
    return send(res, 200, { ...gpt.settings(), ...codexMcpStatus(), ...r });
  }
  if (url.pathname === '/api/mcp/capability') {
    try {
      if (process.platform !== 'win32' || !localAuth || !localOwner(req) || fromRemote() || reqCtx.getStore()?.mcpScope) return send(res, 403, { error: '能力授權僅能由本機 Windows 使用者建立' });
      if (b.confirm !== true || Object.keys(b).some(k => !['project','task','tools','confirm','expectedHash','delegationModel'].includes(k))) return send(res, 400, { error: '請確認精確的 MCP 授權範圍' });
      const project = store.readProject(b.project), task = b.task === undefined ? null : project?.tasks.find(t => t.id === b.task);
      if (!project || b.task !== undefined && !task) return send(res, 400, { error: '找不到 MCP 授權專案或作業' });
      if (b.expectedHash !== (task || project).completionHash) return send(res, 409, { error: '確認期間專案或作業已變更，請重新取得授權範圍' });
      const tools = b.tools === undefined ? READ_TOOLS : b.tools;
      if (Array.isArray(tools) && tools.some(t=>['hub_write_file','hub_request_command','hub_delegate'].includes(t)) && !gpt.settings().work) return send(res, 403, { error: '請先由使用者開啟 MCP 檔案寫入／命令要求，再建立此作業的授權' });
      let fileScope = {};
      if (Array.isArray(tools) && tools.some(t => ['hub_read_file','hub_write_file','hub_request_command','hub_get_command_result','hub_delegate'].includes(t))) {
        if (!task || !task.workdir) return send(res, 403, { error: '檔案能力授權需要指定已建立隔離工作複本的作業' });
        const safe = require('./lib/safe-path'), policy = require('./lib/git-policy');
        const root = safe.localPath(expandHome(task.workdir));
        let workspaceRun;
        const binding=workspaceReview.binding(project.id,task.id);
        if(binding?.mode==='direct'){
          const live=await workspaceReview.verifiedBinding(project.id,task.id);
          if(path.resolve(live.dir).toLowerCase()!==root.toLowerCase()||safe.localPath(baseOf(project)).toLowerCase()!==root.toLowerCase())return send(res,403,{error:'本體能力授權與目前已核准的工作區不一致'});
          workspaceRun=live.run;
        }else{
        const expectedTree = safe.localPath(path.join(ROOT, 'Work', project.id, task.id));
        const rel = path.relative(expectedTree, root);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return send(res, 403, { error: '作業的檔案根目錄不屬於此作業的工作複本' });
        const tree = path.resolve(policy.run(root, ['rev-parse', '--show-toplevel']).trim());
        const common = dir => path.resolve(policy.run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()).toLowerCase();
        if (tree.toLowerCase() !== expectedTree.toLowerCase() || common(tree) !== common(baseOf(project))) return send(res, 403, { error: '工作複本與此專案的 Git 儲存庫不一致' });
        const registered = policy.run(baseOf(project), ['worktree', 'list', '--porcelain', '-z']).split('\0').filter(x => x.startsWith('worktree ')).map(x => path.resolve(x.slice(9)).toLowerCase());
        if (!registered.includes(tree.toLowerCase())) return send(res, 403, { error: '工作複本未登錄於此專案' });
        }
        const identity = await require('./lib/scoped-file').identity(root);
        const current = store.readProject(project.id)?.tasks.find(t => t.id === task.id);
        if (!current || safe.localPath(expandHome(current.workdir)).toLowerCase() !== root.toLowerCase() || current.completionHash !== task.completionHash) return send(res, 409, { error: '建立授權期間作業或工作目錄已變更，請重新確認' });
        fileScope = { root, rootFingerprint: identity.rootFingerprint,...(workspaceRun?{workspaceRun}: {}) };
        if(workspaceRun){const fresh=await workspaceReview.verifiedBinding(project.id,task.id);if(fresh.run!==workspaceRun||fresh.rootFingerprint!==identity.rootFingerprint)return send(res,409,{error:'建立授權期間本體工作區流程已變更'});}
        if(tools.includes('hub_write_file')) {
          const journalRoot=safe.localPath(path.join(ROOT,'_hub','file-write'),{allowMissing:true});fs.mkdirSync(journalRoot,{recursive:true});
          fileScope.journalRoot=journalRoot;fileScope.journalRootFingerprint=(await require('./lib/scoped-file').identity(journalRoot)).rootFingerprint;
        }
        if(tools.some(t=>['hub_request_command','hub_get_command_result'].includes(t)))fileScope.taskHash=task.completionHash;
        const finalTask=store.readProject(project.id)?.tasks.find(t=>t.id===task.id);
        if(!finalTask||finalTask.completionHash!==task.completionHash||path.resolve(expandHome(finalTask.workdir)).toLowerCase()!==root.toLowerCase())return send(res,409,{error:'建立授權期間作業已變更'});
      }
      if(Array.isArray(tools)&&tools.includes('hub_delegate')){
        await ensureCodexCatalog(15000);
        if(typeof b.delegationModel!=='string'||b.delegationModel!==launch.flagFor('codex',launch.modelLabel('codex',b.delegationModel)))return send(res,400,{error:'請選擇精確的 Codex 委派模型 ID'});
        const invalid=modelError('codex',launch.modelLabel('codex',b.delegationModel));if(invalid)return send(res,409,{error:invalid});fileScope.delegationModel=b.delegationModel;
      }else if(b.delegationModel!==undefined)return send(res,400,{error:'此授權沒有指定委派工具'});
      const result = mcpCapabilities.issue({ project: project.id, ...(task ? { task: task.id } : {}), tools, runId: crypto.randomUUID(), ...fileScope });
      try{record('mcpgrant',{project:project.id,task:task?.id},{capabilityId:result.id,runId:result.runId,tools:result.tools,expiresAt:result.expiresAt,rootFingerprint:fileScope.rootFingerprint||null});}catch(error){mcpCapabilities.revoke(result.id);throw error;}
      return send(res, 200, result);
    } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }
  if (url.pathname === '/api/mcp/capability/revoke') {
    if (!localAuth || !localOwner(req) || fromRemote() || reqCtx.getStore()?.mcpScope || b.confirm !== true || typeof b.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(b.id) || Object.keys(b).some(k => !['id','confirm'].includes(k))) return send(res, 403, { error: '請由本機使用者確認撤銷此能力授權' });
    for(const intent of commandIntents.list())if(intent.capId===b.id)commandIntents.cancelRun(intent.run);
    const revoked=mcpCapabilities.revoke(b.id);try{record('mcprevoke',{}, {capabilityId:b.id,revoked});}catch(error){return send(res,500,{error:'MCP 已撤銷，但持久操作記錄未完成',revoked,partial:true});}return send(res, 200, { ok: true, revoked });
  }
  if(url.pathname==='/api/commands/decide') {
    if(process.platform!=='win32'||!localOwner(req)||fromRemote()||reqCtx.getStore()?.mcpScope)return send(res,403,{error:'僅限本機使用者核准命令'});
    return send(res,200,await commandIntents.decide(b));
  }
  if(url.pathname==='/api/commands/cancel') {
    if(!localOwner(req)||b.confirm!==true||Object.keys(b).some(k=>!['id','confirm'].includes(k)))return send(res,400,{error:'請確認取消的命令'});
    const row=commandIntents.list().find(row=>row.id===b.id);if(!row)return send(res,404,{error:'找不到命令要求'});
    return send(res,200,commandIntents.cancel({id:row.capId,project:row.project,task:row.task,run:row.run,taskHash:row.taskHash,root:row.cwd,rootFingerprint:row.rootFingerprint},row.id));
  }
  if (url.pathname === '/api/chatgpt') {
    if (typeof b.work !== 'boolean') return send(res, 400, { error: '形式が違います' });
    const s = gpt.save({ work: b.work }); record('chatgptwork', {}, { work: s.work });
    if(!s.work)for(const intent of commandIntents.list())commandIntents.cancelRun(intent.run);
    return send(res, 200, s);
  }
  if (url.pathname === '/api/remote/logout-all') {
    const n = remote.logoutAll();
    record('remotelogoutall', {}, { sessions: n });
    return send(res, 200, remote.status());
  }
  if (url.pathname === '/api/start/image-path') {
    const p = store.readProject(b.project);
    try { if (!p) throw Error('プロジェクトがありません'); return send(res, 200, start.imageFromPath(p, b.path)); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if(url.pathname.startsWith('/api/task/workspace/')){
    if(process.platform!=='win32')return send(res,404,{error:'此核准入口適用於 Windows Codex'});
    const action=url.pathname.slice('/api/task/workspace/'.length),allowed={discover:['project','task','actor'],preview:['project','task','secrets','actor'],prepare:['project','task','token','confirm','skipHooks','ackReadLimits','ackNetworkLimits','actor'],close:['project','task','confirm']}[action];
    if(!allowed||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k))||typeof b.project!=='string'||typeof b.task!=='string')return send(res,400,{error:'工作區請求格式無效'});
    const p=store.readProject(b.project),t=p?.tasks.find(x=>x.id===b.task);if(!t)return send(res,404,{error:'找不到工作區作業'});
    const actor=b.actor??'codex';if(!['codex','claude','grok'].includes(actor))return send(res,400,{error:'此工作區 CLI 目的地無效'});
    if(action==='close'){if(b.confirm!==true)return send(res,400,{error:'請明確確認停止此作業的 owned 程序、撤銷授權並重試機密清理'});const flow=workspaceFlowOf(p.id,t.id);if(!flow)return send(res,200,{ok:true,duplicate:true,workspaceLifecycle:null});try{const proof=await stopNativeWorkspace(flow);if(!proof.stopped||!proof.treeExited)return send(res,409,{ok:false,partial:true,error:'owned 工作區程序尚未完全退出，清理與鎖保留',workspaceLifecycle:workspaceRuntime.summary(p.id,t.id)});await workspaceRuntime.finish(flow.id);return send(res,200,{ok:true,workspaceLifecycle:null});}catch{return send(res,409,{ok:false,partial:true,error:'工作區停止或清理未完成；檔案、紀錄與互斥鎖保留，請確認後重試',workspaceLifecycle:workspaceRuntime.summary(p.id,t.id)});}}
    if(['preview','prepare'].includes(action)){await reapWorkspaceLeases({project:p.id,task:t.id});if(workspaceRuntime.byTask.has(workspaceRuntime.key(p.id,t.id)))throw Error('此作業的工作區流程仍在執行、重新確認或清理；請等待完成或先停止');}
    await procwatch.scan({maxAgeMs:['discover','preview'].includes(action)?10000:0});procwatch.assertKnown();
    if(action==='discover'){const d=workspaceReview.context(p.id,t.id);if(workspaceReview.busy(p.id,t.id)||workspaceReview.pending(d.base))return send(res,409,{error:'此工作區仍有執行中的流程'});const value=await workspaceReview.candidates(d.base);return send(res,200,{project:p.id,task:t.id,base:d.base,mode:t.workspaceMode==='direct'?'direct':'isolated',taskHash:d.taskHash,candidates:value.files});}
    if(action==='preview'){const preview=await workspaceReview.preview(p.id,t.id,{direct:t.workspaceMode==='direct',secrets:b.secrets||[]});workspaceReview.tokens.get(preview.token).approvalActor=actor;return send(res,200,preview);}
    if(b.ackReadLimits!==true||b.ackNetworkLimits!==true||b.confirm!==true)return send(res,400,{error:'必須明確核准原生 Codex 的主機讀取／網路限制與此次工作區'});
    const entry=workspaceReview.tokens.get(b.token);if(!entry||entry.value.project!==p.id||entry.value.task!==t.id||(entry.approvalActor||'codex')!==actor)return send(res,409,{error:'工作區預覽或模型目的地已失效'});
    record('workspaceapprove',{project:p.id,task:t.id,ai:actor},{mode:entry.value.mode,taskHash:entry.value.taskHash,sourceHash:entry.value.original.allContent,files:entry.value.secrets.files.map(f=>({relative:f.relative,sha256:f.sha256})),destination:{codex:'OpenAI',claude:'Anthropic',grok:'xAI'}[actor],ackReadLimits:true,ackNetworkLimits:true,skipHooks:b.skipHooks===true});
    const prepared=await workspaceReview.apply({project:p.id,task:t.id,token:b.token,confirm:true,skipHooks:b.skipHooks});if(prepared.ok)workspaceReview.permits.get(prepared.permit).approvalActor=actor;return send(res,prepared.ok?200:prepared.status||409,prepared);
  }
  if (url.pathname === '/api/start') {
    const p = store.readProject(b.project), text = String(b.text || '').trim();
    const ai = b.ai === 'claude-code' ? 'claude' : b.ai;
    const manual=process.platform==='win32'&&providers.isActor(ai)&&providers.resolveActor(ai).kind==='external-chat';
    if(manual&&(typeof b.text!=='string'||!b.text.isWellFormed()||b.text.includes('\0')||b.request!==undefined&&(typeof b.request!=='string'||b.request.length>120)))return send(res,400,{error:'人工交接的文字與請求識別碼無效'});
    const agents = new Set([...rolesData().agents, ...store.listProjects().flatMap(x => x.tasks.map(t => t.owner).filter(o => o && !/claude|codex|agy|^chatgpt$|^(人|あなた)$/i.test(o)).map(o => o.replace(/^discord:\s*/i, '')))]);
    const agent = typeof ai === 'string' && ai.startsWith('discord:') && agents.has(ai.slice(8));
    if (!p || (!text && !(b.images || []).length) || (!launch.AIS.includes(ai) && !agent&&!manual)) return send(res, 400, { error: '依頼と担当を確認してください' });
    if (text.length > 4000 || !Array.isArray(b.images) || b.images.length > 10) return send(res, 400, { error: '依頼は4000文字、画像は10枚までです' });
    if(manual&&b.images.length)return send(res,400,{error:'網頁交接不會自動傳送圖片，請自行在網站選擇'});
    if(manual&&b.task!==undefined&&b.task!==null&&(typeof b.task!=='string'||b.task&&!store.taskFile(p.id,b.task)))return send(res,400,{error:'人工交接指定的既有作業不存在'});
    if (!agent && aiTools.isOperating()) return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です' });
    const ph = p.phases.find(x => x.state !== '完了');
    const spec = agent||manual ? { model: '', effort: '' } : pickSpec({ role: ph?.role, model: b.model, effort: b.effort }, ai);
    if(!agent&&!manual&&ai==='codex')await ensureCodexCatalog(15000);
    const invalid = !agent&&!manual && modelError(ai, spec.model);
    if (invalid) return send(res, 409, { error: invalid });
    const receiptFile = path.join(p.dir, '.ai', 'start-request.json');
    const manualRequestHash=manual?crypto.createHash('sha256').update(JSON.stringify({actor:ai,text,project:p.id})).digest('hex'):null;
    let receipt; try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { if(manual&&fs.existsSync(receiptFile))return send(res,409,{error:'開始請求記錄無法核對；未建立新作業'}); }
    if(manual&&b.request&&receipt?.request===b.request&&receipt.manualRequestHash!==manualRequestHash)return send(res,409,{error:'此請求識別碼已綁定不同內容或入口'});
    if (b.request && receipt?.request === b.request && receipt.result) {if(manual&&(receipt.result.actor!==ai||!receipt.result.webManual))return send(res,409,{error:'此請求識別碼已綁定不同入口'});return send(res, 200, receipt.result);}
    const writeReceipt = value => { if (b.request) { taskWrites.assertPathWritable(receiptFile);fs.mkdirSync(path.dirname(receiptFile), { recursive: true }); fs.writeFileSync(receiptFile, JSON.stringify({ request: b.request, ...(manual?{manualRequestHash}:{}), ...value })); } };
    let t,workspaceFlow;
    try {
      for (const id of b.images) if (!fs.existsSync(start.imageFile(p, id))) throw Error('添付画像が見つかりません');
      // 途中で失敗しても同じ作業を再開し、重複作成を防ぐ。
      if (b.request && receipt?.request === b.request) b.task = receipt.task;
      t = b.task && store.taskFile(p.id, b.task) ? store.readTask(store.taskFile(p.id, b.task)) : null;
      if (t && chats.busy(p.id, t.id)) throw Error('この作業はすでに始まっています');
      if(manual)require('./lib/web-chat-admission').ensureFormat(ROOT,{hubDir:__dirname});
      t ||= store.createTask(p.id, { title: (text.split('\n')[0] || '画像を確認する').slice(0, 40), owner: agent||manual ? ai : launch.AI_KEY[ai], role: ph?.role || '', phase: ph?.name || '' });
      writeReceipt({ task: t.id });
      if(manual){const result={ok:true,task:t.id,webManual:true,actor:ai};writeReceipt({task:t.id,result});return send(res,200,result);}
      const prepared=agent?startDir(p,t):await nativeStartDir(p,t,{workspacePermit:b.workspacePermit,actor:ai});const {dir,note}=prepared;workspaceFlow=prepared.workspaceFlow;
      const images = start.copyImages(p, b.images, dir, t.id);
      store.updateTask(p.id, t.id, { owner: agent ? ai : launch.AI_KEY[ai], ...spec });
      const prompt = start.imagePrompt(ai, text || '添付画像を確認してください。', images);
      const file = store.taskFile(p.id, t.id);
      if (agent) {
        const notice = 'Discordへの自動送信は未対応です。依頼文と画像の場所を保存しました。Discordで担当へ渡してください。';
        store.updateTask(p.id, t.id, { state: '返事待ち', question: notice, memo: prompt });
        chat.append(p.dir, t.id, { role: 'user', to: ai, text: prompt });
      } else {
        const basePrompt = taskPrompt(p, t, file, dir);
        const turn = { request: b.request, workspaceFlow, role: t.role, project: p.id, task: t.id, pdir: p.dir, dir, ai, ...spec, text: prompt, images, basePrompt, policy: modelPolicy(p, t), perm: chatPermCmd(ai), onEnd: row => {
          if (row.asks?.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).join(' / ').slice(0, 300) });
          chatEnded(p.id, t.id);
        } };
        if (!DRY && !(await(await sendNativeProviderChat(turn)).started)) throw Error('AIを起動できませんでした。CLIの導入状態を確認してください');
        store.updateTask(p.id, t.id, { state: '実行中', question: '', memo: images.length ? '参照画像: ' + images.join(' / ') : '' });
        if (DRY) {t.turn = chat.buildTurn({ ...turn, rows: [], meta: {} });await failNativeWorkspace(workspaceFlow);}
      }
      start.saveSpec(p, { ai, ...spec });
      record('quickstart', { project: p.id, task: t.id, ai }, { ...spec, images });
      const result = { ok: true, task: t.id, agent, note, images, ...(DRY ? { dry: true, turn: t.turn } : {}) };
      writeReceipt({ task: t.id, result });
      return send(res, 200, result);
    } catch (e) {await failNativeWorkspace(workspaceFlow,e);return send(res,409,nativeWorkspaceError(e,t?.id));}
  }

  if (url.pathname === '/api/ai-tools/check') {
    try { return send(res, 200, await aiTools.checkUpdate(b.ai,b.version===undefined?{}:{version:b.version})); }
    catch (e) { return send(res, e.status || 502, { error: e.reason || '更新情報の確認に失敗しました', stage: e.stage }); }
  }
  if (url.pathname === '/api/ai-tools/update' || url.pathname === '/api/ai-tools/models/refresh') {
    if(process.platform==='win32'&&url.pathname.endsWith('/update')){
      if(b.ai!=='codex'||b.confirm!==true||typeof b.version!=='string'||typeof b.token!=='string'||Object.keys(b).some(k=>!['ai','version','token','confirm'].includes(k)))return send(res,400,{error:'請核准精確 Codex 版本與此次來源預覽'});
      await assertFreshWindowsProcesses();if(leaseReapAllowed())await workspaceRuntime.reapAll();
      if(nativeOperationsBusy())return send(res,409,{error:'原生工作區、交易或命令仍在執行，請等候程序與紀錄完成'});
    }
    try {
      const result = url.pathname.endsWith('/update') ? await aiTools.update(b.ai,process.platform==='win32'?{version:b.version,token:b.token,confirm:b.confirm}:undefined) : process.platform==='win32'&&['claude','grok'].includes(b.ai)?{ok:true,ai:b.ai,...aiTools.refreshNativeCatalogFromCache(b.ai)}:await aiTools.refresh(b.ai);
      applyModelCatalog();
      record(url.pathname.endsWith('/update') ? 'aiupdate' : 'aimodels', { ai: b.ai }, { added: result.models?.added ?? result.added ?? 0 });
      return send(res, 200, result);
    } catch (e) {
      return send(res, e.status || 502, { error: e.reason || e.message || 'CLI の操作に失敗しました', stage: e.stage || 'operation', reason: e.reason || e.message || '' });
    }
  }
  if (aiTools.isOperating() && ['/api/term/start', '/api/term/handoff', '/api/continue', '/api/chat/send'].includes(url.pathname)) {
    return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です。終わってから始めてください' });
  }

  // 作業画面を開く（画面の中）
  if (url.pathname === '/api/term/start') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    assertNativeMutationUnlocked(p.id,{task:t.id,allowOwned:true});
    const { model, effort } = pickSpec(t, b.ai);
    if(b.ai==='codex')await ensureCodexCatalog(15000);
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const cur = sessions.get(b.project, b.task, b.ai);
    const { dir, note,workspaceFlow } = cur && !cur.exited ? { dir: cur.dir } : await nativeStartDir(p,t,{workspacePermit:b.workspacePermit,kind:'terminal'});
    const argv = launch.buildArgv({ codexVersion:activeCodexVersion(b.ai), ai: b.ai, prompt: taskPrompt(p, t, file, dir, 'terminal', { ai: b.ai, model }), cmd: permCmd(b.ai), model, effort });
    if (DRY) {await failNativeWorkspace(workspaceFlow);return send(res,200,{ok:true,dry:true,dir,model,effort,...argv});}
    try {
      const s = sessions.start({ project: b.project, task: b.task, ai: b.ai, dir, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows,dirPin:nativeRootPin(b.project,b.task) });
      if(workspaceFlow)workspaceRuntime.trackTerminal(workspaceRuntime.flows.get(workspaceFlow),s);
      if(!await s.startedP){await failNativeWorkspace(workspaceFlow);return send(res,409,{error:'終端機的 CLI 啟動失敗；請檢查終端機輸出'});}
      record('start', b, { model, effort, dir });
      return send(res, 200, { ok: true, dir, note, model, effort, running: !s.exited });
    } catch (e) {
      await failNativeWorkspace(workspaceFlow);return send(res,e.status||500,nativeWorkspaceError(e));
    }
  }
  // 交代する：前の AI の会話を「引き継ぎ資料」にまとめ、相手の AI に読ませて続けさせる
  // 相手が動いていなければ、役割どおりのモデル・思考で始める。相手が作業中なら断る（勝手に割り込まない）
  if (url.pathname === '/api/term/handoff') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.to)) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    assertNativeMutationUnlocked(p.id,{task:t.id,allowOwned:true});
    const from = b.from || (b.to === 'claude' ? 'codex' : b.to === 'codex' ? 'claude' : '');
    if (!launch.AIS.includes(from) || from === b.to) return send(res, 400, { error: '交代元を指定してください' });
    const LABEL = launch.AI_LABEL;
    const tgt = sessions.get(b.project, b.task, b.to);
    const tgtLive = tgt && !tgt.exited;
    if (!tgtLive) {
      if(b.to==='codex')await ensureCodexCatalog(15000);
      const invalidModel = modelError(b.to, pickSpec(t, b.to).model);
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    if (tgtLive && Date.now() - tgt.lastOut < 20000) return send(res, 409, { error: `${LABEL[b.to]} が作業中です。止まってから（入力待ちになってから）交代してください` });
    const src = sessions.get(b.project, b.task, from);
    const { dir,workspaceFlow } = tgtLive ? { dir: tgt.dir } : await nativeStartDir(p,t,{workspacePermit:b.workspacePermit,kind:'terminal'});
    const convo = transcript.collect({ ai: from, dir: (src && src.dir) || dir, since: src ? src.started : Date.now() - 3 * 86400000, buf: src && src.buf });
    const board = path.join(p.dir, '.ai', 'board.md');
    const note = b.note ? String(b.note).replace(/[\r\n]+/g, ' ').slice(0, 300) : '';
    const hdir = path.join(p.dir, '.ai', 'handoff');
    fs.mkdirSync(hdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const packetFile = path.join(hdir, `${t.id}-${stamp}-${from}.md`);
    fs.writeFileSync(packetFile, transcript.packet({ fromLabel: LABEL[from], toLabel: LABEL[b.to], taskFile: file, board, convo, extra: note }));
    const msg = `${LABEL[from]} から交代です。引き継ぎ資料 ${packetFile} を読み、${file} と ${board} も確かめてから、あなたの役割で続けてください。`;
    let started = false, spec = null;
    if (tgtLive) {
      sessions.type(b.project, b.task, b.to, msg);
    } else {
      spec = pickSpec(t, b.to);
      const argv = launch.buildArgv({ codexVersion:activeCodexVersion(b.to), ai: b.to, prompt: msg + ' ' + taskPrompt(p, t, file, dir, 'terminal', { ai: b.to, model: spec.model }), cmd: permCmd(b.to), model: spec.model, effort: spec.effort });
      if (DRY) {await failNativeWorkspace(workspaceFlow);return send(res,200,{ok:true,dry:true,packet:packetFile,kind:convo.kind,...argv});}
      try {
        const session = sessions.start({ project: b.project, task: b.task, ai: b.to, dir, command: argv.command, args: argv.args, cols: b.cols, rows: b.rows,dirPin:nativeRootPin(b.project,b.task) });
        if(workspaceFlow)workspaceRuntime.trackTerminal(workspaceRuntime.flows.get(workspaceFlow),session);
        if(!await session.startedP)return send(res,409,{error:'交接 CLI 未成功啟動；原作業負責人保留',packet:packetFile});
        started = true;
      }
      catch (e) {await failNativeWorkspace(workspaceFlow);return send(res,500,{...nativeWorkspaceError(e),packet:packetFile});}
    }
    store.updateTask(p.id, t.id, { owner: launch.AI_KEY[b.to], memo: `${LABEL[from]} から ${LABEL[b.to]} へ交代（引き継ぎ資料: ${packetFile}）` });
    record('handoff', b, { packet: packetFile, kind: convo.kind, started });
    return send(res, 200, { ok: true, packet: packetFile, kind: convo.kind, started, ...(spec || {}) });
  }
  // 動いている AI のモデル・思考を変える：作業ファイルに残し、その AI に /model・/effort を打つ
  if (url.pathname === '/api/term/switch') {
    if (b.ai === 'agy') return send(res, 409, { error: 'Agy は承認された Gemini 3.1 Pro (High) に固定しています' });
    if (!launch.AIS.includes(b.ai) || !['model', 'effort'].includes(b.field)) return send(res, 400, { error: '指定が正しくありません' });
    if (b.field === 'model') {
      if(b.ai==='codex')await ensureCodexCatalog(15000);
      const invalidModel = modelError(b.ai, String(b.value || ''));
      if (invalidModel) return send(res, 409, { error: invalidModel });
    }
    if (process.platform === 'win32' && sessions.get(b.project, b.task, b.ai) && !sessions.get(b.project, b.task, b.ai).exited) sessions.viewController(b.project, b.task, b.ai).assertOwner({ viewId: b.viewId, lease: b.lease });
    const t = store.updateTask(b.project, b.task, { [b.field]: typeof b.value === 'string' ? b.value : '' });
    if (!t) return send(res, 400, { error: '作業が見つかりません' });
    const spec = pickSpec(t, b.ai);
    const cmd = launch.switchCommand(b.ai, b.field, spec[b.field]);
    const sent = Boolean(cmd) && sessions.type(b.project, b.task, b.ai, cmd);
    record('switch', b, { [b.field]: spec[b.field], sent });
    return send(res, 200, { ok: true, sent, command: cmd, ...spec });
  }
  if (url.pathname.startsWith('/api/term/view/')) {
    if (process.platform !== 'win32') return send(res, 404, { error: '此入口適用於 Windows 終端機視窗' });
    const action = url.pathname.slice('/api/term/view/'.length), allowed = ['project','task','ai',...(action === 'register' ? [] : ['viewId','lease']),...(action === 'claim' ? ['expectedEpoch','takeover'] : [])];
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !allowed.includes(k)) || typeof b.project !== 'string' || typeof b.task !== 'string' || !launch.AIS.includes(b.ai)) return send(res, 400, { error: '終端機視窗請求格式無效' });
    const credentials = { viewId: b.viewId, lease: b.lease };
    let result;
    if (action === 'register') result = sessions.registerView(b.project, b.task, b.ai);
    else if (action === 'heartbeat') result = sessions.heartbeatView(b.project, b.task, b.ai, credentials);
    else if (action === 'claim') result = sessions.claimView(b.project, b.task, b.ai, { ...credentials, expectedEpoch: b.expectedEpoch, takeover: b.takeover });
    else if (action === 'disconnect') result = sessions.disconnectView(b.project, b.task, b.ai, credentials);
    else return send(res, 404, { error: '找不到終端機視窗操作' });
    return send(res, 200, result);
  }
  if (url.pathname === '/api/term/input') {
    const ok = process.platform === 'win32' ? sessions.writeView(b.project, b.task, b.ai, b.data, { viewId: b.viewId, lease: b.lease }) : sessions.write(b.project, b.task, b.ai, String(b.data || ''));
    return send(res, ok ? 200 : 404, { ok });
  }
  if (url.pathname === '/api/term/resize') {
    const ok = process.platform === 'win32' ? sessions.resizeView(b.project, b.task, b.ai, b.cols, b.rows, { viewId: b.viewId, lease: b.lease }) : sessions.resize(b.project, b.task, b.ai, b.cols, b.rows);
    return send(res, ok ? 200 : 404, { ok });
  }
  if (url.pathname === '/api/term/stop') {
    record('stop', b);
    if(process.platform==='win32'){const flow=workspaceFlowOf(b.project,b.task);if(flow?.kind==='terminal'){const proof=await stopNativeWorkspace(flow);if(!proof.treeExited)return send(res,409,{error:'終端機程序樹尚未退出，工作區鎖保留'});await workspaceRuntime.finish(flow.id);return send(res,200,{ok:true});}}
    return send(res, 200, { ok: sessions.stop(b.project, b.task, b.ai) });
  }

  // 別の窓で開く（作業画面の部品が無い時の代わり）
  if (url.pathname === '/api/continue') {
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    const spec = pickSpec(t, b.ai);
    if(b.ai==='codex')await ensureCodexCatalog(15000);
    const invalidModel = modelError(b.ai, spec.model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const { dir,workspaceFlow } = await nativeStartDir(p,t,{workspacePermit:b.workspacePermit,kind:'terminal'});
    if(process.platform==='win32'){
      const argv=launch.buildArgv({ codexVersion:activeCodexVersion(b.ai),ai:b.ai,dir,prompt:taskPrompt(p,t,file,dir,'terminal',{ai:b.ai,model:spec.model}),cmd:permCmd(b.ai),...spec});
      if(DRY){await failNativeWorkspace(workspaceFlow);return send(res,200,{ok:true,dry:true,dir,...argv});}
      try{const s=sessions.start({project:p.id,task:t.id,ai:b.ai,dir,command:argv.command,args:argv.args,cols:b.cols,rows:b.rows,dirPin:nativeRootPin(p.id,t.id)});workspaceRuntime.trackTerminal(workspaceRuntime.flows.get(workspaceFlow),s);if(!await s.startedP)throw Error('終端機 CLI 啟動失敗');return send(res,200,{ok:true,dir,running:!s.exited,window:true});}catch(error){await failNativeWorkspace(workspaceFlow);throw error;}
    }
    const command = launch.buildCommand({ ai: b.ai, dir, prompt: taskPrompt(p, t, file, dir, 'terminal', { ai: b.ai, model: spec.model }), cmd: permCmd(b.ai), ...spec });
    const r = await launch.openTerminal(command, DRY);
    return send(res, 200, { ok: true, dir, ...(DRY ? { command, r } : {}) });
  }

  // フォルダを Finder で開く（台帳に書かれた場所だけ）
  if (url.pathname === '/api/open') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: 'プロジェクトが見つかりません' });
    let target = null;
    if (b.kind === 'project') target = p.dir;
    else if (b.kind === 'folder') target = (p.folders.find(f => f.label === b.label) || {}).path;
    else if (b.kind === 'workdir') { const f = store.taskFile(b.project, b.task); target = f && store.readTask(f).workdir; }
    target = expandHome(target || '');
    if (!target || !fs.existsSync(target)) return send(res, 404, { error: 'その場所が見つかりません', path: target });
    if (denied(target)) return send(res, 403, { error: denied(target), path: target });
    const r = await launch.openFolder(target, DRY);
    return send(res, 200, { ok: true, path: target, ...(DRY ? { r } : {}) });
  }

  // 文の中のファイル・フォルダを Finder で開く（作業の場所からの相対でもよい。ホームの中だけ）
  if (url.pathname === '/api/reveal') {
    const raw = String(b.path || '').trim();
    if (!raw) return send(res, 400, { error: '場所がありません' });
    const p = store.readProject(b.project);
    const f = p && b.task ? store.taskFile(b.project, b.task) : null;
    const t = f ? store.readTask(f) : null;
    const bases = [t && expandHome(t.workdir), p && baseOf(p), p && p.dir, ROOT].filter(Boolean);
    const list = raw.startsWith('~') || path.isAbsolute(raw) ? [expandHome(raw)] : bases.map(d => path.join(d, raw));
    const home = [os.homedir(), ROOT].map(d => fs.realpathSync(d));
    const within = x => home.some(h => x === h || x.startsWith(h + path.sep));
    const target = list.map(x => { try { return fs.realpathSync(x); } catch { return ''; } }).find(within);
    if (!target) return send(res, 404, { error: `見つかりません：${raw}` });
    if (denied(target)) return send(res, 403, { error: denied(target) });
    const isDir = fs.statSync(target).isDirectory();
    // info＝開かず種類と場所を返す／list＝フォルダの中身／open＝元ファイルを既定アプリで開く／finder＝Finderで表示
    const how = ['info', 'list', 'open'].includes(b.how) ? b.how : 'finder';
    if (how === 'info') return send(res, 200, { ok: true, path: target, dir: isDir, how });
    if (how === 'list' && isDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true }).filter(d => !d.name.startsWith('.')).slice(0, 500)
          .map(d => { const full = path.join(target, d.name); let st = null; try { if (within(fs.realpathSync(full))) st = fs.statSync(full); } catch (e) { /* 読めない物 */ } return st ? { name: d.name, path: full, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs } : null; }).filter(Boolean)
          .sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name, 'ja') : x.dir ? -1 : 1));
      } catch (e) { return send(res, 403, { error: denied(target) || String(e.message) }); }
      const up = path.dirname(target);
      return send(res, 200, { ok: true, path: target, dir: true, entries, parent: within(up) ? up : '' });
    }
    record('reveal', { project: b.project, task: b.task }, { path: target, dir: isDir, how, app: Boolean(b.app) });
    const act = how === 'list' ? 'open' : how; // ファイルに list が来たら開く
    // アプリの中では、アプリ自身が開く（許可がアプリに付いているため）。ブラウザの時は本体が open で開く
    if (b.app) return send(res, 200, { ok: true, path: target, dir: isDir, byApp: true, how: act });
    const r = act === 'open' || isDir ? await launch.openFolder(target, DRY) : await launch.revealFile(target, DRY);
    return send(res, 200, { ok: true, path: target, dir: isDir, how: act, ...(DRY ? { r } : {}) });
  }
  // URL を既定のブラウザで開く（http・https だけ）
  if (url.pathname === '/api/open-url') {
    const u = String(b.url || '');
    if (!/^https?:\/\/[^\s]+$/.test(u)) return send(res, 400, { error: '開けない URL です' });
    const r = await launch.openUrl(u, DRY);
    return send(res, 200, { ok: true, ...(DRY ? { r } : {}) });
  }

  // 作業の状態・質問・メモ・モデル・思考
  // 作業用コピーの古い記録を片付ける（場所が無い時だけ。取り込み済みの後に AI が書き戻した時など）
  if (url.pathname === '/api/task/copyclear') {
    if (process.platform === 'win32') {
      const recovery = reviewedMerge.recovery(b.project, b.task);
      if (recovery && !recovery.complete) return send(res, 409, { error: '此工作複本仍有未完成合併交易；請先使用恢復合併', recordId: recovery.recordId });
    }
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task), t = file && store.readTask(file);
    if (!t) return send(res, 400, { error: '作業が見つかりません' });
    if (!copyMissing(p, t)) return send(res, 409, { error: '作業用コピーはまだあります（片付けるのは、場所が無い時だけ）' });
    const m = lastMerge(p.id, t.id);
    const done = store.updateTask(p.id, t.id, { workdir: '', memo: m ? '本体に取り込み済み。作業用コピーの古い記録を片付けた' : '作業用コピーの古い記録を片付けた' });
    record('copyclear', b, { merged: Boolean(m) });
    return send(res, 200, { ok: true, merged: Boolean(m), task: done });
  }
  if (url.pathname === '/api/task') {
    if (fromRemote()) record('task', b, { state: b.state, question: b.question !== undefined, memo: b.memo !== undefined });
    if (b.state === '完了') return send(res, 409, { error: '［完了に移す］で内容を確認してから完了にしてください' });
    const str = k => (typeof b[k] === 'string' ? b[k] : undefined);
    let context = {};
    if (['kind','derivedFrom','parent','workspaceMode'].some(k => b[k] !== undefined)) {
      try {
        const p=store.readProject(b.project), file=store.taskFile(b.project,b.task), t=file && store.readTask(file);
        if (!p || !t) throw Error('作業がありません');
        context=require('./lib/work-context').validateTask(p,t,b,store.listProjects());
        if (b.workspaceMode !== undefined && b.workspaceMode !== t.workspaceMode && (t.workspaceStarted || t.state !== '未着手' || t.workdir || chats.busy(p.id,t.id) || sessions.list().some(s=>s.project===p.id && s.task===t.id && s.running))) throw Error('場所は作業開始前に選んでください。既存コピーは自動で移しません');
      } catch(e) { return send(res,409,{error:e.message}); }
    }
    const update=() => store.updateTask(b.project, b.task, {
      state: str('state'), question: str('question'), owner: str('owner'), role: str('role'),
      ...context, model: str('model'), effort: str('effort'), parent: str('parent'), phase: str('phase'), via: str('via'), memo: b.memo,
    });
    const t=process.platform==='win32'&&ownTaskDisplay&&store.taskFile(b.project,b.task)?nativeTaskMetadataWrite(b.project,b.task,update):update();
    return t ? send(res, 200, t) : send(res, 400, { error: '作業が見つかりません' });
  }
  if (url.pathname === '/api/task/completion') {
    if (b.confirm !== true) return send(res, 400, { error: '完了に移すか確認してください' });
    if (b.action === 'approve' && (chats.running.has(`${b.project}\u0000${b.task}`) || launch.AIS.some(a => { const s = sessions.get(b.project, b.task, a); return s && !s.exited; }))) return send(res, 409, { error: 'AIが作業中です。終わってから完了を確認してください' });
    const t = store.decideTask(b.project, b.task, b.action, b.expectedHash);
    if (t?.error) return send(res, t.status, { error: t.error });
    if (t) record(b.action === 'approve' ? 'taskdone' : 'taskreopen', b);
    if (t && b.action === 'approve') { const p = store.readProject(b.project); if (p) reportChild(p, '作業の完了', [t.title, handoff.lastEntry(t.done)].filter(Boolean).join('\n')); }
    return t ? send(res, 200, t) : send(res, 400, { error: '作業が見つかりません' });
  }
  // 手順に印を付ける・外す
  if (url.pathname === '/api/task/step') {
    if (typeof b.add !== 'string' && (!Number.isSafeInteger(b.index) || b.index < 0 || typeof b.done !== 'boolean')) return send(res, 400, { error: 'index 必須是非負整數，done 必須是 boolean' });
    const t = typeof b.add === 'string' ? store.addStep(b.project, b.task, b.add) : store.setStep(b.project, b.task, b.index, b.done);
    return t ? send(res, 200, t) : send(res, 400, { error: 'その手順が見つかりません' });
  }
  if (url.pathname === '/api/phase/continue') {
    const current = store.readProject(b.project);
    if (!current || current.completionHash !== b.expectedHash) return send(res, 409, { error: '確認中にフェーズが更新されました' });
    const p = store.continuePhase(b.project); return send(res, 200, p);
  }
  // プロジェクトを完了にする・戻す（人がはっきり押した時だけ）
  if (url.pathname === '/api/project/status') {
    if (b.status === '完了' && b.confirm !== true) return send(res, 400, { error: '完了に移すか確認してください' });
    const current = store.readProject(b.project);
    if ((b.status === '完了' || b.expectedHash) && current?.completionHash !== b.expectedHash) return send(res, 409, { error: '確認中にプロジェクトが更新されました' });
    if (!['完了', '進行中'].includes(b.status)) return send(res, 400, { error: '形式が違います' });
    if (b.status === '完了') {
    if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: 'このプロジェクトでAIが作業中です。終わってから完了を確認してください' });
    }
    const p = store.setProjectStatus(b.project, b.status);
    if (p) record(b.status === '完了' ? 'projectdone' : 'projectreopen', { project: b.project });
    if (p && b.status === '完了' && p.status === '完了') reportChild(p, '完了', handoff.completionText(p));
    return p ? send(res, 200, { ok: true, status: p.status }) : send(res, 400, { error: 'プロジェクトが見つかりません' });
  }
  // 親に結果を渡す（人がはっきり押した時）。文が無ければ一番新しい作業の「やったこと」の最後
  if (url.pathname === '/api/project/handoff') {
    const p = store.readProject(b.project);
    if (!p) return send(res, 400, { error: 'プロジェクトが見つかりません' });
    const t = handoff.newestTask(p);
    const text = (typeof b.text === 'string' && b.text.trim()) || (t ? handoff.lastEntry(t.done) : '');
    if (!text) return send(res, 400, { error: '渡す内容がありません。文を書くか、作業の「やったこと」を書いてください' });
    if (text.length > 4000) return send(res, 400, { error: '渡す文は4000文字までです' });
    const r = reportChild(p, '報告', text);
    if (!r) return send(res, 400, { error: '親プロジェクトが見つかりません' });
    return send(res, 200, { ok: true, parent: r.parent, task: r.task, duplicate: r.duplicate });
  }
  // 次のフェーズへ進む（今のフェーズを完了に）
  if (url.pathname === '/api/phase/next') {
    if (b.confirm !== true) return send(res, 400, { error: '今のフェーズを完了に移すか確認してください' });
    const current = store.readProject(b.project);
    if (!current || b.expectedHash !== current.completionHash) return send(res, 409, { error: '確認中にフェーズが更新されました。内容を読み直してください' });
    if (sessions.list().some(x => x.project === b.project && x.running) || [...chats.running.keys()].some(k => k.startsWith(b.project + '\u0000'))) return send(res, 409, { error: 'このプロジェクトでAIが作業中です。終わってから完了を確認してください' });
    const p = store.nextPhase(b.project);
    if (p) record('nextphase', b);
    return p ? send(res, 200, { ok: true, phases: p.phases }) : send(res, 400, { error: 'プロジェクトが見つかりません' });
  }
  // コピーと再開先は保持したまま、取り込み対象から外す・戻す
  if (url.pathname === '/api/task/merge-exclusion') {
    if (typeof b.excluded !== 'boolean') return send(res, 400, { error: '除外するかどうかを指定してください' });
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    if (!file) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    if (!inWork(p, t)) return send(res, 400, { error: 'この作業には作業用コピーがありません' });
    if (t.mergeExcluded === b.excluded) return send(res, 200, { ok: true, task: t });
    const updated = store.updateTask(p.id, t.id, {
      mergeExcluded: b.excluded,
      memo: b.excluded ? '取り込み対象から外しました（作業用コピーと再開先は保持）' : '取り込み対象に戻しました',
    });
    record(b.excluded ? 'mergeexclude' : 'mergeinclude', b);
    return send(res, 200, { ok: true, task: updated });
  }
  // 作業用コピーを本体に取り込んで片付ける
  if (url.pathname === '/api/task/merge/preview') {
    if (process.platform !== 'win32') return send(res, 404, { error: '此預覽入口適用於 Windows 合併流程' });
    try {
      await assertFreshWindowsProcesses();
      return send(res, 200, await reviewedMerge.preview(b.project, b.task));
    } catch (e) { return send(res, 409, { error: require('./lib/rooted-move').messageFor(e.code)||e.message, ...(e.code?{code:e.code}:{}), ...(e.recordId ? { recordId: e.recordId, partial: true } : {}) }); }
  }
  if (url.pathname === '/api/task/merge') {
    if (process.platform === 'win32') {
      let merged;
      try {
        await assertFreshWindowsProcesses({reap:{project:b.project,task:b.task}});if(workspaceRuntime.byTask.has(workspaceRuntime.key(b.project,b.task)))throw Error('此作業的工作區流程仍在執行或清理；請先停止後再合併');
        merged = await reviewedMerge.apply({ project: b.project, task: b.task, token: b.token, confirm: b.confirm, skipHooks: b.skipHooks });
        if (!merged?.ok) return send(res, 409, { error: merged?.error || '合併尚未完成', ...merged, ok: false });
        const done = store.updateTask(b.project, b.task, { workdir: '', state: '完了', question: '', memo: `已合併至本體並將工作複本退避（${merged.main}；交易 ${merged.recordId}）` });
        if (!done) throw Error('Git 已合併，但作業紀錄未能更新；請重新預覽以恢復紀錄');
        record('merge', { project: b.project, task: b.task }, { ok: true, main: merged.main, commit: merged.commit, files: merged.files, transaction: merged.recordId });
        return send(res, 200, { ...merged, task: done });
      } catch (e) {
        return send(res, 409, { error: require('./lib/rooted-move').messageFor(e.code)||e.message, ...(e.code?{code:e.code}:{}), ...(merged?.ok ? { partial: true, commit: merged.commit, recordId: merged.recordId, main: merged.main, trashed: merged.trashed } : {}), ...(e.recordId ? { recordId: e.recordId, partial: true } : {}) });
      }
    }
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    if (!p || !file) return send(res, 400, { error: '作業が見つかりません' });
    const t = store.readTask(file);
    if(require('./public/project-order').integrators(p,t,store.listProjects()).length) return send(res,409,{error:'親作業の［統合…］で取り込みます。子作業では［成果を渡す］を行ってください'});
    if (!inWork(p, t)) return send(res, 400, { error: 'この作業には作業用コピーがありません' });
    if (copyMissing(p, t)) {
      const m = lastMerge(p.id, t.id);
      const when = m ? new Date(m.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const note = m ? `この作業は ${when} に本体へ取り込み済みです（作業用コピーはゴミ箱へ移してあります）。` : '作業用コピーの場所が見つかりません（消えたか、別の場所に移っています）。';
      store.updateTask(p.id, t.id, { workdir: '', memo: `${note} 作業ファイルの古い記録を片付けました` });
      record('mergeskip', b, { merged: Boolean(m) });
      return send(res, 409, { error: `${note} 変更は本体に入っています。作業ファイルの古い記録を片付けたので、続きは本体でそのまま始められます` });
    }
    if (t.mergeExcluded) return send(res, 409, { error: '取り込み対象から外されています。先に［取り込み対象に戻す］を選んでください' });
    if (removal.busy(p.id, t.id) || maintenance.locked(p.id)) return send(res, 409, { error: 'AI・整理・確認が動いています。この返事が終わってから取り込んでください' });
    let r;
    try { r = gitw.merge({ dir: expandHome(t.workdir), workRoot: workRoot(p), title: `${t.id} ${t.title}` }); }
    catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    record('merge', b, { ok: Boolean(r.ok), conflict: Boolean(r.conflict), ...(r.ok ? {main:r.main,commit:r.commit,files:r.files} : {}) });
    if (r.conflict) {
      store.updateTask(p.id, t.id, { state: '返事待ち', question: '本体に取り込む時にぶつかりました。AI を始めて「本体の最新を取り込み、ぶつかった所を直して」と頼んでから、もう一度［本体に取り込む］を押してください' });
      return send(res, 409, { error: r.error, conflict: true });
    }
    if (!r.ok) return send(res, 400, { error: r.error });
    for (const a of launch.AIS) sessions.stop(b.project, b.task, a);
    const done = store.updateTask(p.id, t.id, { workdir: '', state: '完了', question: '', memo: `本体に取り込み、作業用コピーをゴミ箱へ移しました（${r.main}）` });
    try { store.appendSection(p.id, t.id, 'やったこと', `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} 本体に取り込み済み（${r.main}）。作業用コピーはゴミ箱へ。workdir は空のままにすること`); } catch (e) { /* 無くてもよい */ }
    return send(res, 200, { ok: true, main: r.main, trashed: r.trashed, task: done });
  }
  // 成果ファイルを選び、保存と受領通知の後に子作業・派生を片付ける。
  if (url.pathname === '/api/task/handup/preview') {
    if(process.platform==='win32')await reapWorkspaceLeases('all');
    try { return send(res, 200, process.platform==='win32'?await taskTransfer.offerPreviewAsync(b.project,b.task,b.paths||[],b.expectTitle):taskTransfer.offerPreview(b.project, b.task, b.paths || [], b.expectTitle)); }
    catch (e) { return send(res, 409, {error:e.message}); }
  }
  if (url.pathname === '/api/task/handup' || url.pathname === '/api/task/absorb' && taskTransfer.read(b.project,b.task)?.destination && !taskTransfer.read(b.project,b.task)?.integrating) {
    try {
      if(process.platform==='win32')await assertFreshWindowsProcesses({reap:'all'});
      const r = process.platform==='win32'?await(url.pathname==='/api/task/handup'?taskTransfer.offerAsync(b):taskTransfer.applyAsync(b)):url.pathname === '/api/task/handup' ? taskTransfer.offer(b) : taskTransfer.apply(b); if(!r.handedUp)setUnread(b.project,b.task,false);
      record('absorb', {project:r.parentProject,task:r.parent}, {child:b.task,childProject:b.project,files:r.files,receipt:r.record});
      return send(res,200,r);
    } catch(e) { return send(res,409,{error:e.message}); }
  }
  if(url.pathname === '/api/task/integrate/preview') {
    if(process.platform==='win32')await reapWorkspaceLeases('all');
    try{return send(res,200,process.platform==='win32'?await taskIntegrate.previewAsync(b.project,b.task,b.only):taskIntegrate.preview(b.project,b.task,b.only));}catch(e){return send(res,409,{error:e.message});}
  }
  if(['/api/task/integrate','/api/task/absorb'].includes(url.pathname)) {
    try { if(process.platform==='win32')await assertFreshWindowsProcesses({reap:'all'});const r=process.platform==='win32'?await taskIntegrate.applyAsync(b):taskIntegrate.apply(b); record('integrate',b,{ok:r.ok,complete:r.complete,conflict:r.conflict});pruneUnread();return send(res,r.conflict||r.ok===false?409:200,r); }
    catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/delegate') return send(res,200,await delegateTask(b));
  // 会話に「人の依頼」を残すだけ（ChatGPT アプリに貼って頼んだ時など、Hub では AI を動かさない）
  if (url.pathname === '/api/chat/note') {
    const p = store.readProject(b.project), file = p && store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!file || !text || text.length > 8000) return send(res, 400, { error: '作業と依頼を確かめてください' });
    const row = chat.append(p.dir, b.task, { role: 'user', text, to: String(b.to || '').slice(0, 20) });
    chats.emit(p.id, b.task, { type: 'row', row });
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat/send') {
    // 待っている指示を今すぐ始める（再起動の後など、作業中でない時）
    const fromQueue = b.fromQueue ? chats.queue(b.project, b.task).find(x => x.id === String(b.fromQueue)) : null;
    if (b.fromQueue && !fromQueue) return send(res, 404, { error: 'その指示はもう待っていません' });
    if (fromQueue) Object.assign(b, { ai: fromQueue.ai, model: fromQueue.model, effort: fromQueue.effort, text: fromQueue.text, mode: '' });
    const p = store.readProject(b.project);
    const file = store.taskFile(b.project, b.task);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!p || !file || !launch.AIS.includes(b.ai)) return send(res, 400, { error: '作業が見つかりません' });
    if (!text) return send(res, 400, { error: '依頼を書いてください' });
    const t = store.readTask(file);
    const delegated = Boolean(fromQueue?.requireModel);
    if (delegated && t.state === '完了') return send(res, 409, { error: DELEGATE_COMPLETED_ERROR });
    const busy = chats.busy(p.id, b.task);
    // redo: 取り消してやり直す ／ amend: 追加説明（一緒にやる）／ queue: 終わったら次に（interrupt は前の呼び名）
    const want = b.mode === 'interrupt' ? 'redo' : b.mode;
    const mode = busy ? (['redo', 'amend', 'queue'].includes(want) ? want : '') : '';
    if (busy && !mode) return send(res, 409, { error: 'まだ作業中です。［取り消してやり直す］［追加説明（一緒にやる）］［終わったら次に］から選んでください' });
    const spec = pickSpec(t, b.ai);
    const model = launch.modelLabel(b.ai, b.model || spec.model);
    if(b.ai==='codex')await ensureCodexCatalog(15000);
    const invalidModel = modelError(b.ai, model);
    if (invalidModel) return send(res, 409, { error: invalidModel });
    const effort = b.ai === 'agy' ? '高' : ((process.platform==='win32'&&['claude','grok'].includes(b.ai)&&['minimal','low','medium','high','xhigh','max','ultra'].includes(b.effort))||roles.EFFORTS.includes(b.effort)) ? b.effort : spec.effort;
    const invalidEffort=nativeEffortError(b.ai,model,effort);
    if(invalidEffort)return send(res,409,{error:invalidEffort});
    const { dir, note,workspaceFlow } = await nativeStartDir(p,t,{workspacePermit:b.workspacePermit,allowExisting:Boolean(mode),actor:b.ai});
    const basePrompt = taskPrompt(p, t, file, dir) + ' ここは会話画面。人からの依頼に答え、区切りで作業ファイルを更新すること。';
    // 受付時の質問だけを消す。起動待ち中に来た新しい質問には触れない。
    const answerQuestion = typeof b.answerQuestion === 'string' ? b.answerQuestion : t.question;
    const acceptAnswer = () => {
      const current = store.readTask(file);
      if (current.question !== answerQuestion) return null;
      if (current.question || current.state === '返事待ち') store.updateTask(p.id, t.id, { question: '', state: '実行中' });
      return answerQuestion;
    };
    // 追加：今の作業が終わったら続けて行う
    if (mode === 'queue') {
      const it = chats.enqueue(p.id, t.id, { ai: b.ai, model, effort, role: t.role, text, perm: chatPermCmd(b.ai) });
      record('chatqueue', { project: p.id, task: t.id, ai: b.ai }, { model });
      return send(res, 200, { ok: true, queued: true, id: it.id, queue: chats.queue(p.id, t.id).length, answeredQuestion: acceptAnswer() });
    }
    // 取り消し・追加説明：今の作業を区切って（終わるのを待って）から、元の指示と合わせて伝え直す
    let sendText = text;
    if (!busy?.pending && (mode === 'redo' || mode === 'amend')) {
      const last = chat.read(p.dir, t.id).filter(r => r.role === 'user').pop();
      const prev = last ? String(last.text).replace(/\s+/g, ' ').slice(0, 400) : '';
      if(process.platform==='win32'&&!workspaceRuntime.reserve(workspaceFlow))return send(res,409,{error:'工作區狀態已變更；請重新送出',notStarted:true});
      try{await chats.stop(p.id,t.id,{interrupting:true});}catch(error){if(process.platform==='win32')workspaceRuntime.unreserve(workspaceFlow);throw error;}
      record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: b.ai });
      sendText = mode === 'redo'
        ? `（人が前の指示「${prev}」を取り消しました。途中で変えたファイルがあれば、必要に応じて元に戻してから、この新しい指示だけを行ってください）\n${text}`
        : `（人が追加の説明を送りました。今の指示「${prev}」は取り消さずに続けてください。途中までの作業を活かし、この追加説明も合わせて行ってください）\n${text}`;
    }
    try {
      // 答えを送ったら、AI からの質問は済んだことにする
      // 質問は spawn の成功後にだけ解除する。
      // AI が質問して終わったら「あなたの番」にする（左の丸が黄色になる）
      const onEnd = row => { if (row.asks && row.asks.length) store.updateTask(p.id, t.id, { state: '返事待ち', question: row.asks.map(a => a.question).filter(Boolean).join(' / ').slice(0, 300) || '選んでください' }); chatEnded(p.id, t.id); };
      let replacement;
      if (busy?.pending && (mode === 'redo' || mode === 'amend')) {
        replacement = chats.replacePending(p.id, t.id, text, mode);
        await replacement.finished;
      }
      const r = replacement
        ? await chats.sendQueued(replacement.options)
        : await (fromQueue ? chats.sendQueued.bind(chats) : sendNativeProviderChat)({ project: p.id, task: t.id, pdir: p.dir, dir, workspaceFlow, ai: b.ai, model, effort, role: fromQueue ? fromQueue.role || '' : t.role, limitSwitch: fromQueue?.limitSwitch, request: fromQueue?.id, requireModel: Boolean(fromQueue?.requireModel), requiredModel: fromQueue?.requiredModel, text: sendText, shown: fromQueue?.shown || text, mode: mode || (fromQueue ? 'queued' : undefined), basePrompt, policy: modelPolicy(p, t), perm: chatPermCmd(b.ai), onEnd });
      if (!(await r.started)) throw Error('AIを起動できませんでした。CLIの導入状態を確認してください。作業の状態と質問は変更していません');
      const answeredQuestion = delegated ? null : acceptAnswer();
      if (delegated) {
        store.updateTask(p.id, t.id, { state: '実行中', question: '' });
      }
      if (fromQueue) chats.unqueue(p.id, t.id, fromQueue.id);
      if (replacement) {
        chats.unqueue(p.id, t.id, replacement.options.request);
        record(mode === 'redo' ? 'chatredo' : 'chatamend', { project: p.id, task: t.id, ai: r.ai });
      }
      record('chat', { project: p.id, task: t.id, ai: r.ai }, { model: r.model, effort: r.effort, resume: r.resume });
      return send(res, 200, { ok: true, model: r.model, effort: r.effort, note: r.limitSwitch?.preflight ? 'Fable上限保持中のため Astra で開始しました。' : note, resume: r.resume, answeredQuestion,...(r.freshSession?{freshSession:r.freshSession}:{}) });
    } catch (e) {await failNativeWorkspace(workspaceFlow,e);return send(res,409,nativeWorkspaceError(e));}
  }
  // 未読の印を消す（画面が作業を開いた時）
  if (url.pathname === '/api/task/read') {
    if (typeof b.project !== 'string' || typeof b.task !== 'string') return send(res, 400, { error: '作業が見つかりません' });
    setUnread(b.project, b.task, false);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/chat/approval') {
    if (typeof b.project !== 'string' || typeof b.task !== 'string' || typeof b.token !== 'string') return send(res, 400, { error: '授權要求格式錯誤' });
    if (!['accept', 'decline', 'cancel', 'answer'].includes(b.decision)) return send(res, 400, { error: '授權決定格式錯誤' });
    const run = chats.busy(b.project, b.task);
    if (!run?.child?.respond || !run.child.listApprovals().some(a => a.token === b.token)) return send(res, 409, { error: '授權要求已失效或不屬於此作業' });
    try {
      // This route is protected by the browser's local authentication. Never accept an AI/MCP token here.
      const log = path.join(ROOT, '_hub', 'approvals.jsonl');
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), project: b.project, task: b.task, tokenHash: crypto.createHash('sha256').update(b.token).digest('hex'), decision: b.decision, phase: 'requested' }) + '\n');
      run.child.respond(b.token, b.decision, b.answers);
      return send(res, 200, { ok: true });
    } catch (e) {return send(res,409,nativeWorkspaceError(e));}
  }
  if (url.pathname === '/api/chat/unqueue') {
    if (fromRemote()) record('chatunqueue', b);
    return send(res, 200, { ok: true, queue: chats.unqueue(b.project, b.task, String(b.id || '')) });
  }
  if (url.pathname === '/api/chat/stop') {
    if(process.platform==='win32'){const flow=workspaceFlowOf(b.project,b.task);if(flow?.kind==='chat'){const proof=await stopNativeWorkspace(flow);if(!proof.treeExited)return send(res,409,{error:'對話程序樹尚未退出，工作區鎖保留'});await workspaceRuntime.finish(flow.id);record('chatstop',b);return send(res,200,{ok:true});}}
    const stopping=chats.stop(b.project,b.task),ok=Boolean(stopping);
    if(stopping)await stopping;
    if (ok) record('chatstop', b);
    return send(res, 200, { ok });
  }

  // 新しい版にする：本体を起動し直す（動いている AI があれば断る。止まってしまうため）
  // 本体を止める（アプリが、許可のある自分から起動し直すため）。AI が動いている間は断る
  if (url.pathname === '/api/quit') {
    if (aiTools.isOperating()) return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です' });
    if(process.platform==='win32'&&leaseReapAllowed())await workspaceRuntime.reapAll();
    if(nativeOperationsBusy())return send(res,409,{error:'原生工作區或交易仍在執行／清理，請先停止並完成清理後再關閉 Hub'});
    if (process.platform === 'win32' && commandIntents.active() > 0) return send(res, 409, { error: '命令程序尚未完全退出，請先取消命令並等待清理完成' });
    if (process.platform === 'win32' && reviewedMerge.active() > 0) return send(res, 409, { error: 'Git 交易尚未結束，請待持久紀錄完成後再停止 Hub' });
    if (process.platform === 'win32' && require('./lib/scoped-file').active() > 0) return send(res, 409, { error: '受限檔案作業尚未結束，請稍後再停止 Hub' });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: `動いている AI が ${busy} つあります` });
    record('quit', {}, { reason: String(b.reason || '') });
    send(res, 200, { ok: true });
    if (!DRY) setTimeout(shutdown, 200);
    return undefined;
  }
  if (url.pathname === '/api/restart') {
    if (process.platform === 'win32') {
      if(leaseReapAllowed())await workspaceRuntime.reapAll();
      if (aiTools.isOperating() || nativeOperationsBusy() || sessions.list().some(x => x.running) || chats.running.size > 0) return send(res, 409, { error: '原生工作區、AI 或交易尚未結束；未停止 Hub', notStarted: true, stage: 'busy' });
      let result;try { result = await require('./lib/native-restart').start({ root: ROOT, hubDir: __dirname }); } catch (error) { if (error.notStarted === true) return send(res,error.status||409,{error:error.message,notStarted:true,stage:error.stage});throw error; }
      record('restart', {}, { from: VERSION, to: readVersion(), phase: 'planned', operation: result.operation });
      return send(res, 200, { ...result, from: VERSION, to: readVersion() });
    }
    if (aiTools.isOperating()) return send(res, 409, { error: 'AI の更新・モデル再取得が進行中です' });
    const busy = sessions.list().filter(x => x.running).length + chats.running.size;
    if (busy) return send(res, 409, { error: `動いている AI が ${busy} つあります。止めてから（または返事が終わってから）押してください` });
    record('restart', {}, { from: VERSION, to: readVersion() });
    send(res, 200, { ok: true, from: VERSION, to: readVersion() });
    if (DRY) return undefined;
    setTimeout(() => {
      server.close();
      const { spawn } = require('child_process');
      // 同じ設定で新しい本体を起動してから、この本体は終わる（新しい方は待ち受けが空くまで少し待つ）
      const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, env: { ...process.env, HUB_RESTART_WAIT: '1', ...(localAuth ? { HUB_LOCAL_TOKEN: LOCAL_TOKEN } : {}) }, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
      process.exit(0);
    }, 200);
    return undefined;
  }

  // CLI に渡すモデル名を保存する
  if (url.pathname === '/api/cli-models') {
    const clean = x => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length < 40 && /^[\w.:\-/\[\]]*$/.test(v.trim())).map(([k, v]) => [k, v.trim()])) : {});
    saveCliModels({ claude: clean(b.claude), codex: clean(b.codex),grok:clean(b.grok) });
    record('climodels', {});
    return send(res, 200, { ok: true, overrides: launch.getOverrides() });
  }

  // Mac のフォルダ選択の窓を出して、選んだ場所を返す
  if (url.pathname === '/api/pick-folder') {
    if (DRY) return send(res, 200, { path: '' });
    const { execFile } = require('child_process');
    if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description=$env:HUB_PICK_PROMPT; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}';
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        env: { ...process.env, HUB_PICK_PROMPT: String(b.prompt || '選擇資料夾').slice(0, 200) },
        timeout: 120000, windowsHide: true, maxBuffer: 4096,
      }, (err, out) => {
        if (err) return send(res, 409, { error: '無法開啟 Windows 資料夾選擇器' });
        return send(res, 200, { path: String(out).trim() });
      });
      return undefined;
    }
    execFile('osascript', ['-e', `POSIX path of (choose folder with prompt "${String(b.prompt || 'フォルダを選んでください').replace(/["\\]/g, '')}")`], (err, out) => {
      if (err) return send(res, 200, { path: '' }); // 取り消した時
      return send(res, 200, { path: String(out).trim().replace(/\/$/, '') });
    });
    return undefined;
  }
  // アプリの窓に落としたファイル（場所が分かる物）を渡す：作業ファイルに記録し、AI の入力欄に場所を入れる
  if (url.pathname === '/api/task/attach') {
    const p = store.readProject(b.project);
    const file = p && store.taskFile(p.id, b.task);
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x)).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 20);
    if (!file) return send(res, 400, { error: '作業が見つかりません' });
    if (!paths.length) return send(res, 400, { error: 'ファイルが見つかりません' });
    store.updateTask(p.id, b.task, { memo: `ファイルを渡した: ${paths.join(' , ')}` });
    const ai = launch.AIS.includes(b.ai) ? b.ai : '';
    let typed = false;
    if (ai) {
      if (process.platform === 'win32') { try { typed = sessions.writeView(p.id, b.task, ai, paths.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ') + ' ', { viewId: b.viewId, lease: b.lease }); } catch (e) { if (![400,403,404,409].includes(e.status)) throw e; } }
      else typed = sessions.write(p.id, b.task, ai, paths.map(x => (/\s/.test(x) ? `"${x}"` : x)).join(' ') + ' ');
    }
    record('upload', { project: p.id, task: b.task, ai }, { file: paths.join(' , ') });
    return send(res, 200, { ok: true, paths, typed });
  }

  // 参考フォルダ・ファイルを足す（作った後のプロジェクトにも）
  if (url.pathname === '/api/project/refs') {
    const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x)).slice(0, 30);
    if (!paths.length) return send(res, 400, { error: 'フォルダが見つかりません' });
    const r = store.addRefs(b.project, paths);
    if (!r) return send(res, 400, { error: 'プロジェクトが見つかりません' });
    record('refs', { project: b.project }, { paths: paths.join(' , ') });
    return send(res, 200, { ok: true, added: r.added, folders: r.project.folders });
  }

  // 新しいプロジェクトを始める
  // 中身の無い作業・子プロジェクトを探す／ゴミ箱へまとめて移す
  if (url.pathname.startsWith('/api/empty/')) {
    if(process.platform==='win32'){
      try{let result;
        if(url.pathname==='/api/empty/scan'){if(Object.keys(b).length)return send(res,400,{error:'空作業搜尋不接受額外參數'});return send(res,200,{ok:true,...nativeEmpty.scan(),history:await nativeEmpty.history()});}
        if(url.pathname==='/api/empty/preview'){if(process.platform==='win32')await reapWorkspaceLeases('all');if(Object.keys(b).some(k=>!['items','record'].includes(k))||Boolean(b.items)===Boolean(b.record))return send(res,400,{error:'請選取精確項目或單一續作紀錄'});result=b.record?await nativeEmpty.resumePreview(b.record):await nativeEmpty.preview({items:b.items});return send(res,200,result);}
        if(url.pathname==='/api/empty/trash'){if(Object.keys(b).some(k=>!['token','confirm'].includes(k))||b.confirm!==true||typeof b.token!=='string')return send(res,400,{error:'請預覽並明確核准本次空作業批次'});await assertFreshWindowsProcesses({reap:'all'});result=await nativeEmpty.apply({token:b.token,confirm:true});record('emptytrash',{}, {transaction:result.id,moved:result.moved,complete:result.complete});pruneUnread();return send(res,result.ok?200:409,result);}
        return send(res,404,{error:'not found'});
      }catch(error){return send(res,409,{error:error.message});}
    }
    const busy = (project, task) => sessions.list().some(x => x.running && x.project === project && x.task === task) || Boolean(chats.busy(project, task));
    if (url.pathname === '/api/empty/scan') return send(res, 200, { ok: true, items: emptyLib.scan(store, busy) });
    const r = emptyLib.trash(store, busy, Array.isArray(b.items) ? b.items : []);
    record('emptytrash', {}, { moved: r.moved });
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname.startsWith('/api/hierarchy/remove/')) {
    try {
      let result;
      if(url.pathname.endsWith('/apply')||url.pathname.endsWith('/restore'))await assertFreshWindowsProcesses({reap:'all'});
      if(url.pathname.endsWith('/preview')) {if(process.platform==='win32')await reapWorkspaceLeases('all');result=process.platform==='win32'?await removal.previewAsync(b.project,b.task):removal.preview(b.project,b.task);const blocker=windowsMutationBlocker();if(blocker)result.blockers.push(blocker);}
      else if(url.pathname.endsWith('/apply')) {result=process.platform==='win32'?await removal.applyAsync(b):removal.apply(b);pruneUnread();record('remove',{}, {transaction:result.record,moved:result.moved.length});}
      else if(url.pathname.endsWith('/restore')) {result=process.platform==='win32'?await removal.restoreAsync(b.record,b.confirm):removal.restore(b.record,b.confirm);record('removerestore',{}, {transaction:b.record});}
      else if(url.pathname.endsWith('/history')) result={history:process.platform==='win32'?await removal.historyAsync():removal.history()};
      else return send(res,404,{error:'not found'});
      return send(res,200,result);
    }catch(e){return send(res,409,{error:e.message});}
  }
  if (url.pathname.startsWith('/api/maintenance/')) {
    try {
      let result;
      if(['/api/maintenance/apply','/api/maintenance/restore','/api/maintenance/verify'].includes(url.pathname))await assertFreshWindowsProcesses({reap:'all'});
      if (url.pathname === '/api/maintenance/preview') {if(process.platform==='win32')await reapWorkspaceLeases('all');result=process.platform==='win32'?await maintenance.previewAsync(b.project):maintenance.preview(b.project);const blocker=windowsMutationBlocker();if(blocker){result.busy=true;result.busyReason=blocker;}result.hostScript=process.platform==='win32';}
      else if (url.pathname === '/api/maintenance/apply') {result=process.platform==='win32'?await maintenance.applyAsync(b.project,b.token,b.selected,b.confirm):maintenance.apply(b.project,b.token,b.selected,b.confirm);record('cleanup', {project:b.project}, {transaction:result.id,moved:result.moved,complete:result.complete});}
      else if (url.pathname === '/api/maintenance/restore/preview'&&process.platform==='win32'){await reapWorkspaceLeases('all');result=await maintenance.restorePreviewAsync(b.project,b.transaction);}
      else if (url.pathname === '/api/maintenance/restore') {result=process.platform==='win32'?await maintenance.restoreAsync(b.project,b.transaction,b.confirm,b.token):maintenance.restore(b.project,b.transaction,b.confirm);record('restore',{project:b.project},{transaction:b.transaction});}
      else if (url.pathname === '/api/maintenance/verify') {result=await maintenance.verify(b.project,b.script,b.expectedHash,b.confirm);record('verify',{project:b.project},{ok:result.ok,script:b.script});}
      else return send(res,404,{error:'操作が見つかりません'});
      return send(res,200,result);
    } catch(e) {return send(res,409,{error:e.message});}
  }
  if (url.pathname === '/api/hierarchy/pin') {
    try {
      const result = projectOrder.pin(b);
      record('projectpin', { project: b.project }, { pinned: b.pinned });
      return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/hierarchy/order') {
    try {
      const result = projectOrder.save(b);
      record('projectorder', {}, { parent: b.parent, order: b.order });
      return send(res, 200, result);
    } catch (e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/hierarchy/rename') {
    try {
      const { Hierarchy } = require('./lib/hierarchy');
      const value = new Hierarchy(store, id => sessions.list().some(s=>s.project===id && s.running) || [...chats.running.keys()].some(k=>k.startsWith(id+'\u0000'))).rename(b.project, b.task, b.name, b.expectedHash);
      record('rename', { project: b.project, task: b.task }); return send(res, 200, value);
    } catch(e) { return send(res, 409, { error: e.message }); }
  }
  if (url.pathname === '/api/project/new') {
    const body = expandHome(b.body || '');
    if (body && !fs.existsSync(body)) return send(res, 400, { error: `本体のフォルダが見つかりません: ${body}` });
    if (body && !fs.statSync(body).isDirectory()) return send(res, 400, { error: `フォルダではありません（ファイルです）: ${body}` });
    const refs = (Array.isArray(b.refs) ? b.refs : []).map(x => expandHome(String(x))).filter(x => path.isAbsolute(x) && fs.existsSync(x));
    const r = store.createProject({ ...b, body, refs }, path.join(__dirname, '..', 'docs', 'project-hub', 'templates', 'project'));
    if (r.error) return send(res, 400, { error: r.error });
    record('newproject', { project: r.project.id });
    return send(res, 200, r.project);
  }
  if (url.pathname === '/api/task/new') {
    if(process.platform==='win32'&&providers.isActor(b.owner)&&providers.resolveActor(b.owner).kind==='external-chat')webAdmission.ensureFormat(ROOT,{hubDir:__dirname});
    const t = store.createTask(b.project, b);
    if (t) record('newtask', { project: b.project, task: t.id }, { title: t.title });
    return t ? send(res, 200, t) : send(res, 400, { error: '作業名・親作業・派生元を確認してください' });
  }

  // 選ぶ欄にモデルを出す・出さない
  if (url.pathname === '/api/models/hidden') {
    if (!providers.ownerKeys.filter(key=>providers.resolveActor(key).kind==='cli').includes(b.ai) || typeof b.model !== 'string' || !b.model) return send(res, 400, { error: '形式が違います' });
    return send(res, 200, { ok: true, ...modelView.setHidden(b.ai, b.model, Boolean(b.hidden)) });
  }
  if (url.pathname === '/api/models/initial') {
    if(b.ai==='codex')await ensureCodexCatalog(15000);
    const r = modelView.setInitial(b, rolesData().models, modelError);
    if (r.error) return send(res, r.status, { error: r.error });
    record('initialai', {}, r.initialPick);
    return send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/phone') {
    const r = modelView.setPhone(b, rolesData().models);
    return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
  }
  if (url.pathname === '/api/models/order') {
    const r = modelView.setOrder(b.order, b.before, rolesData().models);
    return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, { ok: true, ...r });
  }
  // 最新のモデルに整理：役割の古いモデル名を、同じ系統の一番新しいモデルに。roles.yaml の一覧も今のものに
  if (url.pathname === '/api/models/tidy') {
    const r = roles.tidy(ROLES_FILE);
    if (!r.ok) return send(res, 400, { error: r.error });
    record('modeltidy', {}, { changes: r.changes.length });
    return send(res, 200, { ok: true, changes: r.changes, roles: rolesData() });
  }
  // 役割分担の保存
  if (url.pathname === '/api/roles') {
    if (!Array.isArray(b.roles)) return send(res, 400, { error: '形式が違います' });
    const r = roles.write(ROLES_FILE, b.roles);
    return r.ok ? send(res, 200, r.data) : send(res, 400, { error: r.errors.join(' / ') });
  }

  return send(res, 404, { error: 'not found' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// 外から（tailscale serve 越し）の要求：オフなら断る。オンなら合言葉で入った札が要る
async function remoteGate(req, res, url) {
  const isApi = url.pathname.startsWith('/api/');
  if (!remote.enabled()) return isApi ? send(res, 403, { error: '外からの利用はオフです' }) : send(res, 403, remoteLib.offPage(), 'text/html; charset=utf-8');
  remote.noteHost(req.headers['x-forwarded-host'] || req.headers.host);
  // 書き換える操作は、この画面から送った物だけ（ほかのサイトから送らせない）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin, hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map(h => `https://${h}`);
    if (req.headers['x-hub'] !== '1' || (origin && !hosts.includes(origin))) return send(res, 403, { error: 'forbidden' });
  }
  if (req.method === 'GET' && url.pathname === '/login') return send(res, 200, remoteLib.loginPage(), 'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let b; try { b = await readBody(req); } catch (e) { return send(res, 400, { error: '形式が違います' }); }
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>k!=='passcode'))return send(res,400,{error:'登入格式無效'});
    const who = reqCtx.getStore()?.transport==='tls' ? crypto.createHash('sha256').update(String(req.socket.remoteAddress)).digest('hex') : remoteLib.whoOf(req), r = remote.login(b.passcode, who, req.headers['user-agent']);
    record('remotelogin', {}, { ok: Boolean(r.ok), who });
    if (!r.ok) return send(res, r.status, { error: r.error });
    res.setHeader('Set-Cookie', remoteLib.sessionCookie(r.token));
    return send(res, 200, { ok: true });
  }
  const token = remoteLib.cookieOf(req);
  if (!remote.check(token)) {
    if (isApi) return send(res, 401, { error: 'ログインしてください', login: true });
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    remote.logout(token); record('remotelogout', {});
    res.setHeader('Set-Cookie', remoteLib.clearCookie());
    return send(res, 200, { ok: true });
  }
  if (isApi) return api(req, res, url);
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  return serveStatic(res, url.pathname);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (process.platform === 'win32' && remoteLib.isRemote(req)) return send(res, 403, { error: 'HTTP 中繼標頭未受信任；請使用核准的 HTTPS 入口' });
    if (remoteLib.isRemote(req)) return await reqCtx.run({ remote: true }, () => remoteGate(req, res, url));
    if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
    if (process.platform === 'win32' && ['/api/mcp/tools','/api/mcp/call'].includes(url.pathname) && req.headers.authorization) {
      let mcpScope;
      try {
        if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization)) return send(res, 403, { error: 'MCP 能力憑證無效' });
        mcpScope = mcpCapabilities.inspect(req.headers.authorization.slice(7), req.headers['x-hub-mcp-run']);
      } catch { return send(res, 403, { error: 'MCP 能力憑證無效、已撤銷或已到期' }); }
      return await reqCtx.run({ mcpScope }, () => api(req, res, url));
    }
    if (localAuth) {
      if(req.method==='GET'&&url.pathname==='/api/local/proof') {
        try {return send(res,200,{proof:localAuth.proof(url.searchParams.get('challenge'))});}
        catch {return send(res,400,{error:'Invalid challenge'});}
      }
      if (req.method === 'POST' && url.pathname === '/api/local/login') {
        let body; try { body = await readBody(req); } catch { return send(res, 400, { error: 'invalid request' }); }
        if (!localAuth.login(body.token)) return send(res, 403, { error: 'forbidden' });
        res.setHeader('Set-Cookie', localAuth.cookie);
        return send(res, 200, { ok: true });
      }
      if (browserLogin && await browserLogin.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/') && !localOwner(req)) return send(res, 403, { error: '此入口僅限本機使用者；MCP 請使用能力授權入口' });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    return serveStatic(res, url.pathname);
  } catch (e) {
    return send(res,e.status||500,nativeWorkspaceError(e));
  }
});

function shutdown() { if(shutdown.running)return;shutdown.running=true;procwatch.stop(); sessions.stopAll(); chats.stopAll(); server.close();void nativeRemote?.stop();const exit=()=>{try{chats.stopAll();sessions.stopAll();}catch{}process.exit(0);};if(process.platform!=='win32')return exit();const timer=setTimeout(exit,3000);workspaceRuntime.reapAll().catch(()=>{}).finally(()=>{clearTimeout(timer);exit();}); }

if (require.main === module) {
  if (process.platform === 'win32' && !localAuth) {
    console.error('Windows 版須使用 start-windows.ps1 啟動');
    process.exit(1);
  }
  // 新しい版に切り替える時は、前の本体が待ち受けを空けるまで少し待つ
  let tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && process.env.HUB_RESTART_WAIT && tries++ < 50) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 200);
    console.error(e.code === 'EADDRINUSE' ? `ポート ${PORT} は使われています（もう起動しているかもしれません）` : e);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Project Hub ${VERSION}`);
    console.log(`Project Hub: http://127.0.0.1:${PORT}  （台帳の場所: ${ROOT}）`);
    console.log(sessions.available() ? '作業画面: 使えます' : '作業画面: 部品（node-pty）が未設定。setup.sh を実行してください');
    console.log('止める時は、この窓で Control + C');
    if (!DRY) procwatch.start();
    if(nativeRemote&&remote.enabled())void nativeRemote.start().catch(()=>console.error('已保存的 HTTPS 入口未能啟動；本機 Hub 仍可使用，請由本機檢查設定。'));
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, PORT, sessions, taskPrompt, nativeRemote, workspaceReview, workspaceRuntime, webChat };
