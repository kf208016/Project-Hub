'use strict';
// Project Hub 第3版の画面
// 左：プロジェクトと作業の木 ／ 右：概要画面 または 作業画面（Claude Code と Codex を並べられる）
const $ = s => document.querySelector(s);
var L = window.L || (text=>text), UI = window.UI || ((strings,...values)=>strings.reduce((text,part,index)=>text+part+(index<values.length?String(values[index]??''):''),''));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATES = ['未着手', '実行中', '返事待ち', '停止', '上限で停止', '完了'];
const BUILTIN_ROLES = ['司令塔','調査','デザイン','画像生成','コーディング','チェック','文章','最終確認'];
const roleLabel = name => BUILTIN_ROLES.includes(name) ? L(name) : name;
const NEEDS = t => t.completionPending || t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了');
// 返事が必要（あなたの番の数に入れる）。完了に移すだけのものは入れない
const REPLY = (p, t) => t.state === '返事待ち' || t.state === '上限で停止' || (t.question && t.state !== '完了') || aiWaiting(p.id, t.id).length > 0;
const CONFIRM = (p, t) => t.completionPending && !REPLY(p, t);
const canonicalActor = value => value === 'claude-code' ? 'claude' : value;
const CLI = o => !o || ['claude','codex','agy','grok'].includes(canonicalActor(o));
const aiOf = o => !o ? 'claude' : ['claude','codex','agy','grok'].includes(canonicalActor(o)) ? canonicalActor(o) : '';
const webActor = value => ['chatgpt','claude-chat'].includes(value);
const actorReady = value => (state.providers || []).find(x=>x.id===canonicalActor(value))?.readiness?.ready === true;
const manualReady = value => webActor(value) && actorReady(value) && state.webChatAvailable === true;
const cliReady = value => AIS.includes(canonicalActor(value)) && actorReady(value) && (canonicalActor(value) !== 'agy' || state.agyAvailable === true);
const cliTerminalReady=value=>cliReady(value)&&!(state.windowsBrowser&&['claude','grok'].includes(canonicalActor(value)));
function requireCliReady(value,operation='chat') {
  if (!cliReady(value)) throw Error(L('この CLI の実行と分離は未検証です。まだ起動できません。'));
  if(operation==='terminal'&&!cliTerminalReady(value))throw Error('此 CLI 的自主命令與委派請由對話畫面執行；原生終端機入口尚未接線。');
}
const AIS = ['claude', 'codex', 'agy', 'grok'];
const AI_ICON = { claude: 'C', codex: 'X', agy: 'G', grok:'K', chatgpt: 'G', 'claude-chat':'C' };
const AI_KEY = { claude: 'claude-code', codex: 'codex', agy: 'agy', grok:'grok' };
const AI_LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'Agy CLI', grok:'Grok CLI', chatgpt: 'ChatGPT Chat', 'claude-chat':'Claude Chat' };
// 未保存の新規開始とツリーからの子作業に使う初期AI。役割の担当設定とは別。
const INITIAL_PICK = { ai: 'codex', model: 'GPT-6.1-Sol', effort: '高' };
const WINDOWS_INITIAL_PICK = { ai: 'codex', model: 'CLI預設', effort: '高' };
const defaultInitialPick = () => state?.windowsBrowser ? WINDOWS_INITIAL_PICK : INITIAL_PICK;
const initialPick = () => state?.initialPick || defaultInitialPick();
const startSpec = pick => webActor(pick.ai) ? { ai:pick.ai, model:'', effort:'' } : pick;
function openManualStart(result, project, text) {
  if (result.webManual !== true || !webActor(result.actor) || typeof result.task !== 'string') throw Error(L('手動引き継ぎの作業を確認できませんでした。'));
  return window.HubWebChat.open({actor:result.actor,project,task:result.task,text,api,refresh:()=>load()});
}
// 担当の種類：画面の中の AI（丸）・Discord のエージェント（角）・あなた（黄）・ChatGPT（貼る文と返事を人が受け渡す。ここからは始められない）
function ownerOf(o) {
  const v = String(o || '').trim();
  if (webActor(v)) return { kind: v, name: AI_LABEL[v], ic: AI_ICON[v] };
  if (CLI(v)) return { kind: aiOf(v), name: AI_LABEL[aiOf(v)], ic: AI_ICON[aiOf(v)] };
  if (/^(人|あなた)$/.test(v)) return { kind: 'you', name: L('あなた'), ic: '人' };
  const name = v.replace(/^discord:\s*/i, '');
  return { kind: 'agent', name, ic: name.slice(0, 1), sub: 'Discord' };
}
function chip(p, t) {
  const o = ownerOf(t.owner), running = AIS.includes(o.kind) ? live(p.id, t.id, o.kind) : false;
  const sub = o.kind === 'agent' ? o.sub : (o.kind === 'you' || webActor(o.kind) ? '' : specText(t, o.kind));
  return UI`<span class="chip k-${o.kind}"><span class="ic">${esc(o.ic)}</span>${esc(o.name)}${sub ? UI`<small>・${esc(sub)}</small>` : ''}${running ? '<span class="blink" title="作業中"></span>' : ''}</span>`;
}
// 進み具合：手順があれば手順の数、なければ状態から
function progressOf(t) {
  if (t.steps.length) return { done: t.steps.filter(x => x.done).length, all: t.steps.length };
  return { done: t.state === '完了' ? 1 : 0, all: 1 };
}
function progressBar(t) {
  const { done, all } = progressOf(t), fin = t.state === '完了';
  const segs = t.steps.length ? t.steps.map(x => UI`<i class="${x.done ? 'on' : ''}"></i>`).join('') : UI`<i class="${fin ? 'on' : ''}"></i>`;
  return UI`<div class="prog ${fin ? 'fin' : ''}"><div class="segs">${segs}</div><span>${t.steps.length ? `${done} / ${all}` : ''}${fin ? '　完了 ✓' : ''}</span></div>`;
}
// フェーズ：今のフェーズ＝最初の未完了。作業は phase で分ける（無ければ今のフェーズに入れる）
function phaseInfo(p) {
  const names = p.phases.map(ph => ph.name);
  const cur = p.phases.findIndex(ph => ph.state !== '完了');
  const curName = cur >= 0 ? names[cur] : '';
  const inPhase = (t, i) => (names.includes(t.phase) ? t.phase === names[i] : i === cur);
  const list = p.phases.map((ph, i) => {
    const ts = p.tasks.filter(t => inPhase(t, i));
    const got = ts.reduce((a, t) => a + progressOf(t).done, 0), all = ts.reduce((a, t) => a + progressOf(t).all, 0);
    const tasksDone = ts.length > 0 && ts.every(t => t.state === '完了');
    return { name: ph.name, role: ph.role, completionPending: ph.completionPending, state: ph.state || '未着手', tasks: ts, ratio: ph.state === '完了' ? 1 : all ? got / all : 0, tasksDone };
  });
  return { list, cur, curName, done: list.filter(x => x.state === '完了').length, inPhase };
}
function ring(done, all) {
  const c = 37.7, off = all ? c * (1 - done / all) : c;
  return UI`<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--idle-bg)" stroke-width="3"/><circle cx="8" cy="8" r="6" fill="none" stroke="${done === all && all ? 'var(--ok)' : 'var(--accent)'}" stroke-width="3" stroke-dasharray="${c}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>`;
}

let state = { projects: [], root: '', roles: { models: {}, roles: [] }, sessions: [], terminal: false, efforts: [] };
let view = { kind: 'project', project: null, task: null }; // project | work | turn | settings
let open = new Set(); // 左の木で開いているプロジェクト
const projectNotesOpen = new Set(); // 説明・メモは初期状態で閉じ、ページ内だけ開閉を覚える
let panes = {}; // ai → { xterm, fit, es, ro }
let rolesDraft = null;
let stateLoadEpoch = 0;
let renderedTreeKey = '', renderedMainKey = '';
try { const v = JSON.parse(localStorage.getItem('hub-view') || 'null'); if (v) view = v; open = new Set(JSON.parse(localStorage.getItem('hub-open') || '[]')); } catch (e) { /* 使えない時はそのまま */ }

let stateTag = ''; // 一覧の印（本体が「変わっていない」を答えるために送り返す）
async function api(path, body, headers, workspaceRetried = false, nativeRetried=false,destinationRetried=false) {
  if(window.hubI18nReady)await window.hubI18nReady;
  if(window.HubNativeRestart?.paused&&path!=='/api/restart')throw Error('重新啟動期間已暫停介面連線，等待身分證明。');
  if (window.hubAuthReady) await window.hubAuthReady;
  if(window.HubNativeRestart?.paused&&path!=='/api/restart')throw Error('重新啟動期間已暫停介面連線，等待身分證明。');
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(body) } : {};
  if (headers) opt.headers = { ...opt.headers, ...headers };
  const r = await fetch(path, opt);
  if (r.status === 304) return null; // 変わっていない（一覧の取得）
  if (path === '/api/state') stateTag = (r.headers && r.headers.get && r.headers.get('etag')) || '';
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const starts = ['/api/start','/api/chat/send','/api/term/start','/api/term/handoff','/api/continue','/api/delegate'];
    if (!workspaceRetried && r.status === 409 && j.code === 'WORKSPACE_REQUIRED' && j.workspaceRequired === true && starts.includes(path) && body && j.project === body.project && typeof j.task === 'string' && (!body.task || body.task === j.task)) {
      const permit = await requestNativeWorkspace(j.project, j.task,body.ai||j.actor||'codex');
      return api(path, {...body, task:j.task, workspacePermit:permit}, headers, true,nativeRetried,destinationRetried);
    }
    if(!nativeRetried&&r.status===409&&j.code==='NATIVE_PROVIDER_APPROVAL_REQUIRED'&&starts.includes(path)&&body&&
      j.project===body.project&&(!body.task||j.task===body.task)&&(j.actor===body.ai||body.fromQueue&&!body.ai)&&['claude','grok'].includes(j.actor)){
      await requestNativeProvider({...body,task:j.task,ai:j.actor,model:body.model||j.model,effort:body.effort??j.effort});
      return api(path,{...body,task:j.task},headers,workspaceRetried,true,destinationRetried);
    }
    if(!destinationRetried&&r.status===409&&j.code==='WORKSPACE_DESTINATION_REQUIRED'&&j.actor==='codex'&&starts.includes(path)&&body&&j.project===body.project&&(!body.task||body.task===j.task)){
      const preview=await api('/api/workspace-destination/preview',{project:j.project,task:j.task,actor:j.actor});
      await api('/api/workspace-destination/approve',{token:preview.token,confirm:true,ackDestination:true,ackReadLimits:true});
      toast('已自動核准切換至 '+preview.destination+'。');
      return api(path,{...body,task:j.task},headers,workspaceRetried,nativeRetried,true);
    }
    const e = new Error(j.error || L('失敗しました')); e.status = r.status; e.reason = j.reason; e.stage = j.stage; e.task = j.task; e.notStarted = j.notStarted === true;
    const webRoutes=['/api/web-chat/result','/api/web-chat/status','/api/web-chat/recover'];
    if(r.status===409&&webRoutes.includes(path)){
      e.webChatStatus=window.HubWebChat?.failureStatus(path,r.status,j,body)||null;
      e.webChatRecoveryRequired=j.partial===true&&j.recoveryRequired===true;
    }
    if(typeof j.code==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(j.code)){e.code=j.code;if(!e.message.includes(j.code))e.message+=`（代碼：${j.code}）`;}
    throw e;
  }
  return j;
}
async function requestNativeProvider(body){
  const p=proj(body.project),t=taskOf(p,body.task),spec=t?specOf(t,body.ai):null;
  const model=body.model||spec?.model||'',effort=body.effort||spec?.effort||'';
  const preview=await api('/api/native-provider/preview',{project:body.project,task:body.task,actor:body.ai,model,effort});
  await api('/api/native-provider/approve',{token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
  toast('已自動核准 '+(AI_LABEL[body.ai]||body.ai)+' 原生 CLI 執行。');
}
const workspaceClosePending = new Set();
function workspaceLifecycleHtml(p,t){const lifecycle=t.workspaceLifecycle;if(!state.windowsBrowser||!lifecycle?.retryClose)return '';const pending=workspaceClosePending.has(JSON.stringify([p.id,t.id])),label=lifecycle.state==='cleanup-failed'?'工作區停止或清理未完成；檔案、紀錄與互斥鎖保留。':lifecycle.state==='verification-blocked'?'工作區驗證未通過；流程與互斥鎖保留。':lifecycle.state==='waiting'?'工作區流程仍保留；可停止待執行指示並完成清理。':'工作區正在停止或清理；完成前保持互斥鎖。';return UI`<div class="wq workspace-cleanup" role="status"><p>${esc(label)}</p><button class="btn plain" data-act="workspaceclose" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" ${pending?'disabled':''}>${pending?'停止／清理中…':'重試停止／清理工作區'}</button></div>`;}
function refreshWorkspaceLifecycle(){if(view.kind!=='work')return;const p=proj(view.project),t=taskOf(p,view.task),box=$('#workspace-lifecycle');if(box&&p&&t)box.innerHTML=workspaceLifecycleHtml(p,t);}
async function closeNativeWorkspace(project,task,button){const key=JSON.stringify([project,task]);if(workspaceClosePending.has(key))return;if(!confirm('停止此作業的全部 Hub owned 程序、取消待執行指示並撤銷 MCP 授權，然後重試機密清理？檔案內容或 FileID 已變更時仍會保留檔案與互斥鎖供覆核。'))return;workspaceClosePending.add(key);button.disabled=true;const label=button.textContent;button.textContent='停止／清理中…';try{const result=await api('/api/task/workspace/close',{project,task,confirm:true});if(result.ok!==true||result.partial===true||result.workspaceLifecycle!==null)throw Error('工作區停止或清理尚未完成；未顯示成功，請保留檔案與紀錄後重試');toast(result.duplicate?'目前 controller 沒有此作業的有效工作區流程；沒有執行額外清理。':'工作區程序已停止，授權已撤銷，清理已完成');await load();}finally{workspaceClosePending.delete(key);button.disabled=false;button.textContent=label;refreshWorkspaceLifecycle();}}
async function requestNativeWorkspace(project,task,actor='codex') {
  if(!['codex','claude','grok'].includes(actor))throw Error('此工作區的 CLI 目的地無效');
  const scope={project,task,...(actor==='codex'?{}:{actor})},label=AI_LABEL[actor]||actor;
  await api('/api/task/workspace/discover',scope);
  const preview=await api('/api/task/workspace/preview',{...scope,secrets:[]}),hooks=preview.execution?.hooks||[];
  const prepared=await api('/api/task/workspace/prepare',{...scope,token:preview.token,confirm:true,skipHooks:hooks.length>0,ackReadLimits:true,ackNetworkLimits:true});
  if(prepared.ok!==true||typeof prepared.permit!=='string')throw Error(prepared.error||'工作區準備未完成，未啟動 AI');
  toast('已自動核准本次 '+label+' 工作流程。');
  return prepared.permit;
}
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { e.hidden = true; }, 3000); }
function save() { try { localStorage.setItem('hub-view', JSON.stringify(view)); localStorage.setItem('hub-open', JSON.stringify([...open])); } catch (e) { /* 無視 */ } }
window.HubPrepareLanguageChange=()=>{
  const roleChanges=rolesDraft&&JSON.stringify(rolesDraft)!==JSON.stringify(state.roles.roles);
  const cliChanges=[...document.querySelectorAll('input.cm')].some(input=>input.value!==(input.getAttribute('value')||''));
  if((roleChanges||cliChanges)&&!confirm(L('切換語言會重新載入畫面；尚未儲存的角色或 CLI 模型設定將消失。繼續？')))return false;
  save();return true;
};

const proj = id => state.projects.find(p => p.id === id);
const taskOf = (p, id) => p && p.tasks.find(t => t.id === id);
const WAIT_SEC = 20;   // 画面がこの秒数止まっていたら「入力待ち」
const TURN_SEC = 60;   // これ以上待たせていたら「あなたの番」に出す
const sessOf = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && s.ai === ai && s.running);
const aiWaiting = (p, t) => state.sessions.filter(s => s.project === p && s.task === t && s.running && s.quiet >= TURN_SEC);
function statusText(s) {
  if (!s) return '';
  if (s.quiet < WAIT_SEC) return '<span class="pst busy"><i></i>作業中</span>';
  const m = Math.floor(s.quiet / 60);
  return UI`<span class="pst wait" title="画面が止まっています。返事や指示を待っているかもしれません">入力待ち${m ? `（${m}分）` : ''}</span>`;
}
const live = (p, t, ai) => state.sessions.find(s => s.project === p && s.task === t && (!ai || s.ai === ai) && s.running)
  || (!ai && (state.chatting || []).find(c => c.project === p && c.task === t));

function specOf(t, ai) {
  if (ai === 'agy') return { model: (state.roles.models.agy || [])[0] || 'Gemini 3.1 Pro (High)', effort: '高' };
  const r = state.roles.roles.find(x => x.name === t.role);
  const key = AI_KEY[ai];
  const slot = r ? (r.main.ai === key ? r.main : r.backup.ai === key ? r.backup : null) : null;
  return { model: t.model || (slot && slot.model) || '', effort: state.efforts.includes(t.effort) ? t.effort : (slot && slot.effort) || '' };
}
const specText = (t, ai) => { const s = specOf(t, ai); return [s.model, s.effort].filter(Boolean).join('・'); };

// 一覧の取得。本体は前回と同じなら中身を送らない（304）ので、その時は今の state を使う
async function fetchState() {
  const next = await api('/api/state', null, stateTag ? { 'If-None-Match': stateTag } : undefined);
  return next || (state ? null : await api('/api/state'));
}
async function load({ preserveMain = false } = {}) {
  const epoch = ++stateLoadEpoch;
  const next = await fetchState();
  if (epoch !== stateLoadEpoch) return;
  if (next) state = next;
  if (!proj(view.project)) view.project = state.projects[0] ? state.projects[0].id : null;
  if (view.kind === 'work' && !taskOf(proj(view.project), view.task)) view.kind = 'project';
  showInTree();
  if (preserveMain && view.kind === 'work') { syncWorkQuestion(); refreshWorkspaceLifecycle(); updateTurnCounts(); renderTree(); window.HubMobile?.badges(); }
  else render();
}
// 今見ている物が左の木で見えるように、上の階層だけ開く（開き直すのは見る物が変わった時だけ。閉じた物は閉じたまま）
let shownKey = '';
function showInTree() {
  const key = [view.kind, view.project, view.task].join('/');
  if (key === shownKey) return;
  shownKey = key;
  let p = proj(view.project);
  if (!p) return;
  if (view.task) { const all = treeTasks(p); for (let t = all.find(x => x.id === view.task), n = 0; t && t.parent && n < 20; n++) { open.add(`t:${p.id}/${t.parent}`); t = all.find(x => x.id === t.parent); } }
  for (let n = 0; p && n < 20; n++) { open.add(p.id); p = p.parent ? state.projects.find(x => x.id === p.parent || x.name === p.parent) : null; }
  save();
}

// ---- 左の木 ----
function childrenProjects(parent) {
  return state.projects.filter(p => (p.parent || '') === parent || (parent && proj(parent) && p.parent === proj(parent).name));
}
// 子プロジェクト：親（parent）か派生元（derivedFrom）がこのプロジェクト
function childrenOf(p) { return state.projects.filter(q => q.id !== p.id && (q.parent === p.id || q.parent === p.name || q.derivedFrom === p.id)); }
const unfinishedChildren = p => childrenOf(p).filter(q => q.status !== '完了');
function displayParent(item, all) {
  return ProjectOrder.displayParent(item, all);
}
const isProjectPinned = id => (state.projectPins || []).includes(id);
const canReorderProjects = () => true;
const canDragProjects = () => !isPhone();
const projectSiblings = parent => ProjectOrder.siblings(state.projects, parent, state.projectOrder || {}, state.projectPins || []);
// 派生元も載せる既存の子一覧は保ち、各階層内だけを左の一覧と同じ順にする。
function orderedChildren(p) {
  const children = childrenOf(p), result = children.slice(), groups = new Map();
  children.forEach((q, i) => { const parent = displayParent(q, state.projects); if (!groups.has(parent)) groups.set(parent, []); groups.get(parent).push(i); });
  for (const [parent, slots] of groups) {
    const ordered = projectSiblings(parent).filter(q => children.some(c => c.id === q.id));
    slots.forEach((slot, i) => { result[slot] = ordered[i]; });
  }
  return result;
}
function treeMenuButton(p, t) {
  return UI`<button class="tree-menu" data-tree-menu="1" data-p="${esc(p.id)}" ${t ? `data-t="${esc(t.id)}"` : ''} type="button" aria-label="${esc(t ? t.title : p.name)}の操作" title="名前の変更・分岐・子を作成">⋯</button>`;
}
// 未読：AI の作業が終わったのに、まだその作業を開いていない（本体の unread に入っている）
const isUnread = (pid, tid) => (state.unread || []).some(u => u.project === pid && u.task === tid);
function markRead(pid, tid) {
  if (!isUnread(pid, tid)) return;
  state.unread = state.unread.filter(u => !(u.project === pid && u.task === tid));
  api('/api/task/read', { project: pid, task: tid }).catch(() => {});
}
// 数字だけでは用件が分からないため、プロジェクト・作業で同じ名前を使う。
function notificationBadges(p, tasks, count = false) {
  const unread = tasks.filter(t => isUnread(p.id, t.id)).length;
  const reply = tasks.filter(t => REPLY(p, t)).length;
  const done = tasks.filter(t => CONFIRM(p, t)).length;
  const badge = (n, kind, label, tip) => n ? UI`<span class="notice ${kind}" title="${tip}">${label}${count ? ' ' + n : ''}</span>` : '';
  const html = badge(unread, 'notice-unread', '未読', L('まだ開いていないAIの結果です。作業の会話を開くと消えます'))
    + badge(reply, 'notice-reply', L('返事待ち'), L('質問への返事・停止の対処・AIへの入力が必要です'))
    + badge(done, 'notice-confirm', '完了確認', L('完了に移すか、まだ続けるかを選んでください'));
  return html ? UI`<span class="notifications">${html}</span>` : '';
}
// GitHub の場所（作業用コピーがあればその枝、無ければ本体）
function githubCreateButton(p) {
  if(p.gitReadState==='unknown')return UI`<button class="btn plain" type="button" disabled title="${esc(p.gitReadError||'Git 狀態未知')}">GitHubに作る（確認不可）</button><span class="small">${esc(p.gitReadError||'Git 中繼資料尚未確認')}</span>`;
  if (p.github || p.githubHasOrigin) return '';
  const reason = state.github?.ready ? '' : state.github?.error || L('GitHubのログインを設定画面で確認してください');
  return UI`<button class="btn plain" data-github-create="${esc(p.id)}" type="button" ${reason ? 'disabled' : ''} title="${esc(reason || L('非公開リポジトリを作る'))}">GitHubに作る（非公開）</button>${reason ? UI`<span class="small">${esc(reason)}</span>` : ''}`;
}
function githubUrl(p, t) {
  const g = (t && t.github) || p.github;
  if (!g || !g.url) return '';
  return g.branch && !['main', 'master', 'HEAD'].includes(g.branch) ? `${g.url}/tree/${encodeURIComponent(g.branch)}` : g.url;
}
const TASK_TRANSFER_MIN_VERSION = [4, 61, 0];
function transferNeedsUpdate() {
  if (!/^\d+\.\d+\.\d+$/.test(state.version || '')) return false;
  const parts = state.version.split('.').map(Number);
  for (let i = 0; i < TASK_TRANSFER_MIN_VERSION.length; i++) if (parts[i] !== TASK_TRANSFER_MIN_VERSION[i]) return parts[i] < TASK_TRANSFER_MIN_VERSION[i];
  return false;
}
function transferUpdateMessage() {
  const next = state.latest ? UI`［新しい版 v${state.latest} にする］` : L('新版へ切り替えるボタン');
  const reason = transferNeedsUpdate() ? UI`受け取りは新しい版の機能です。今動いている Hub はまだ v${state.version} です。` : UI`この稼働版では受け取りの窓口を確認できませんでした（稼働版 v${state.version || '不明'}）。`;
  return UI`${reason}AI と順番待ちが終わってから、プロジェクト「${proj(view.project)?.name || view.project}」の画面上部に${next}が表示されていれば押してください。`;
}
function transferButton(project, task, title, label = L('成果を受け取る'), action = 'absorb', classes = 'btn sm') {
  const update = transferNeedsUpdate();
  const hint = action === 'handup' ? UI`「${title}」の成果を親へ知らせます。統合と片付けは親の［統合…］で行います` : UI`子作業「${title}」の成果と統合内容を確認します`;
  return UI`<button class="${classes}" data-act="${action}" data-p="${esc(project)}" data-t="${esc(task)}" data-expect-title="${esc(title)}" type="button" ${update ? 'disabled' : ''} title="${esc(update ? transferUpdateMessage() : hint)}">${label}</button>`;
}
// 終わった子作業（手順がすべて済・完了）があれば、上の作業の画面の上に出す。押すと結果を受け取って子作業を片付ける
function kidsDoneBar(p, t) {
  const pending = (state.taskHandoffs || []).filter(r=>r.targetProject===p.id&&r.targetTask===t.id);
  const all=state.projects || [p];
  const kids=all.flatMap(q=>q.tasks.filter(x=>ProjectOrder.canIntegrate({project:p,task:t},q,x,all)&&ProjectOrder.finished(x)&&!x.question&&!live(q.id,x.id)).map(x=>({project:q,task:x})));
  const active=(state.taskIntegrations || []).find(r=>r.project===p.id&&r.task===t.id);
  if (!kids.length && !pending.length && !active) return '';
  const button=UI`<button class="btn sm" data-act="integrate" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" ${transferNeedsUpdate()?'disabled':''} title="${esc(transferNeedsUpdate()?transferUpdateMessage():L('子孫の成果・統合順・片付けを確認します'))}">${active?L('統合の続きを行う'):'統合…'}</button>`;
  return UI`<div class="wq kids-done"><b>子作業の成果：</b>${kids.map(({project:q,task:x})=>{const ancestors=ProjectOrder.ancestorsOf(q,x,all),n=ancestors.findIndex(a=>a.project.id===p.id&&a.task.id===t.id);const route=ancestors.slice(0,n).reverse().map(a=>a.task.title).concat(x.title).join(' › ');const offered=(state.taskOffers || []).some(r=>r.project===q.id&&r.task===x.id);return UI`<span class="kid">${esc(route)} <small>${offered?L('渡し済み'):L('未引渡し（自動で拾います）')}</small></span>`;}).join('')}${kids.length||active?button:''}${pending.map(r=>UI`<span class="kid">${esc(r.title)}${transferButton(r.project,r.task,r.title,L('引渡しの残りを続ける'))}</span>`).join('')}${transferNeedsUpdate() ? UI`<p class="transfer-hint">${esc(transferUpdateMessage())}</p>` : ''}</div>`;
}
// 作業用コピーが残っている作業の一覧（押すとその作業へ。作業画面の［本体に取り込む］で取り込み、コピーはゴミ箱へ）
function copiesHtml(p) {
  const list = p.tasks.filter(t => t.copy), other = p.copies - list.length;
  return UI`<details class="copies small"><summary title="Work フォルダに残っている作業用コピー">作業用コピー ${p.copies} 件</summary><div>${list.map(t => UI`<button class="lnk" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button">${esc(t.title)}</button>`).join(' ')}${other > 0 ? UI`<span>ほか、作業の記録が無いコピー ${other} 件</span>` : ''}<span>作業を開いて［本体に取り込む］を押すと、取り込んだ後にコピーはゴミ箱へ移ります</span></div></details>`;
}
// 所属する子だけを字下げし、派生は元と同じ段に並べる。
function treeTasks(p) { return ProjectOrder.taskItems(p); }
function taskTarget(p,t) { return ProjectOrder.taskTarget(p,taskOf(proj(p.id),t.id)||t,state.projects); }
function branchText(p,t) {
  const src = taskTarget(p,t); return t.kind === 'derived' ? UI`⑂ 分岐：${src ? src.task.title : t.derivedFrom || L('元が不明')}から` : '';
}
function taskTree(p, parentId) {
  const all = treeTasks(proj(p.id)||p).filter(x=>p.tasks.some(t=>t.id===x.id)), kids = ProjectOrder.nearSources(all.filter(t => displayParent(t, all) === (parentId || '')).map(t=>({...t, derivedFrom:t.kind==='derived' ? (taskTarget(p,t)?.task.id || t.derivedFrom) : ''})));
  if (!kids.length) return '';
  return kids.map(t => {
    const isLive = live(p.id, t.id) || bgOf(p.id, t.id).length > 0;
    const isWait = aiWaiting(p.id, t.id).length > 0;
    const sub = taskTree(p, t.id);
    const tk = `t:${p.id}/${t.id}`;
    const hot = all.some(x => x.parent === t.id && (live(p.id, x.id) || NEEDS(x) || isUnread(p.id, x.id))); // 作業中・返事待ち・新がある子は見せる
    const tOpen = open.has(tk) || hot;
    return UI`<div class="tree-line"><button class="node t ${view.kind === 'work' && view.project === p.id && view.task === t.id ? 'sel' : ''}" data-go="work" data-p="${esc(p.id)}" data-t="${esc(t.id)}" type="button" title="${esc(t.title)}">
        <span class="caret" ${sub ? `data-toggle="${esc(tk)}"` : ''}>${sub ? (tOpen ? '▼' : '▶') : ''}</span><span class="sdot ${taskLight(p, t, isLive, isWait).cls}" title="${taskLight(p, t, isLive, isWait).tip}"></span>
        ${t.parent && t.kind !== 'derived' ? '<span class="fork" title="子作業（小作業）">↳</span>' : ''}<span class="nm">${esc(t.title)}${branchText(p,t) ? UI`<small class="branch-label">${esc(branchText(p,t))}</small>` : ''}</span>${notificationBadges(p, [t])}</button>${treeMenuButton(p, t)}</div>
      ${sub && tOpen ? UI`<div class="kids">${sub}</div>` : ''}`;
  }).join('');
}
// プロジェクトの丸：灰＝まだ始めていない／赤＝AI が作業中／薄緑＝処理が終わった／紫＝人が完了にした
// 裏で動いている AI：Hub を通さずに起動された codex / claude / agy（本体の見張りが見つけたもの）
const bgOf = (pid, tid) => (state.background || []).filter(x => x.project === pid && (!tid || x.task === tid));
const bgText = list => list.map(x => `${AI_LABEL[x.ai] || x.ai}（${dur(Date.now() - Date.parse(x.since))}）`).join('・');
function projectLight(p) {
  if (p.status === '完了') return { cls: 'pl-fin', tip: '完了' };
  const working = state.sessions.some(s => s.project === p.id && s.running) || (state.chatting || []).some(c => c.project === p.id) || bgOf(p.id).length;
  if (working) return { cls: 'pl-work', tip: L('AI が作業中') };
  if (p.tasks.some(t => t.state && t.state !== '未着手')) return { cls: 'pl-rest', tip: L('処理が終わりました（完了にするまで続けられます）') };
  return { cls: 'pl-new', tip: L('まだ始めていません') };
}
// 作業（子）の丸：灰＝まだ／赤＝AI が作業中／黄＝返事待ち／青＝完了確認／薄緑＝処理が終わった／紫＝完了
function taskLight(p, t, isLive, isWait) {
  if (isWait) return { cls: 'wait', tip: L('AI が入力を待っています') };
  if (isLive) return { cls: 'pl-work', tip: L('AI が作業中') };
  if (REPLY(p, t)) return { cls: 'wait', tip: L('返事待ち：質問への返事や停止の対処が必要です') };
  if (CONFIRM(p, t)) return { cls: 'confirm', tip: L('完了確認：完了に移すか、まだ続けるかを選んでください') };
  if (t.state === '停止') return { cls: 'wait', tip: L('停止中です') };
  if (t.state === '完了') return { cls: 'pl-fin', tip: '完了' };
  if (!t.state || t.state === '未着手') return { cls: 'pl-new', tip: L('まだ始めていません') };
  return { cls: 'pl-rest', tip: L('処理が終わりました') };
}
function projectNode(p, depth) {
  const isOpen = open.has(p.id);
  const subs = projectSiblings(p.id);
  const forks = state.projects.filter(q=>ProjectOrder.source(q,state.projects)?.id===p.id).length;
  const visible = new Set(p.tasks.filter(t => t.state !== '完了' || isUnread(p.id,t.id)).map(t=>t.id));
  const full = treeTasks(p);
  for(const t of full.filter(x=>visible.has(x.id))) {
    let parent=t.parent;const seen=new Set([t.id]);
    while(parent&&!seen.has(parent)){seen.add(parent);const x=full.find(x=>x.id===parent);if(!x)break;visible.add(x.id);parent=x.parent;}
  }
  const tasks = p.tasks.filter(t=>visible.has(t.id));
  return UI`<div class="tree-line${depth === 0 ? ' project-root' : ''}"><button class="node p ${view.kind === 'project' && view.project === p.id ? 'sel' : ''}" data-go="project" data-p="${esc(p.id)}" type="button" ${canDragProjects() ? 'draggable="true"' : ''}>
      ${canDragProjects() ? UI`<span class="project-grip" aria-hidden="true" title="ドラッグで並べ替え（同じ階層の中だけ）">⋮⋮</span>` : ''}
      <span class="caret" data-toggle="${esc(p.id)}">${tasks.length || subs.length ? (isOpen ? '▼' : '▶') : ''}</span>
      <span class="sdot ${projectLight(p).cls}" title="${projectLight(p).tip}"></span>
      ${isProjectPinned(p.id) ? UI`<span class="project-pin" title="上部に固定中" aria-label="上部に固定中">📌</span>` : ''}${p.parent && !p.derivedFrom ? UI`<span class="fork" title="子プロジェクト">↳</span>` : ''}<span class="nm">${esc(p.name)}${p.derivedFrom ? UI`<small class="branch-label">⑂ 分岐：${esc(ProjectOrder.source(p,state.projects)?.name || p.derivedFrom)}から</small>` : ''}</span>
      ${forks ? UI`<span class="fork" title="分岐の数">分岐${forks}</span>` : ''}
      ${p.phases.length ? UI`<span class="phn" title="終わったフェーズ ${phaseInfo(p).done} / ${p.phases.length}">${ring(phaseInfo(p).done, p.phases.length)}</span>` : ''}${notificationBadges(p, p.tasks, true)}</button>${treeMenuButton(p)}</div>
    ${isOpen ? UI`<div class="kids">${taskTree({ ...p, tasks }, '')}${subs.map(s => projectNode(s, depth + 1)).join('')}</div>` : ''}`;
}
// quiet は毎秒増えるので、表示が変わる境目だけ比較する。
const waitingKey = s => s.running ? [s.project, s.task, s.ai, Math.floor((s.quiet || 0) / 60), s.quiet >= TURN_SEC] : [s.project, s.task, s.ai, false];
function treeKey() {
  return JSON.stringify([state.projects, state.projectOrder, state.projectPins, state.unread, state.sessions.map(s => [s.project, s.task, s.ai, s.running, s.quiet >= TURN_SEC]), state.chatting, view.kind, view.project, view.task, [...open]]);
}
function mainKey() {
  const p = proj(view.project);
  const common = [view.kind, view.project, view.task, state.root, state.terminal, state.roles, state.efforts, state.cliFlags, state.completionWarning, state.modelOrder, state.hiddenModels];
  if (view.kind === 'work') {
    const sessions = workMode() === 'term' ? state.sessions.filter(s => s.project === view.project && s.task === view.task).map(s => [s.ai, s.running]) : [];
    return JSON.stringify([...common, p && p.name, p && p.phases, taskOf(p, view.task), sessions]);
  }
  if (view.kind === 'project') return JSON.stringify([...common, p, state.github, state.projectOrder, state.projectPins, state.projects.map(x => [x.id, x.name]), state.sessions.filter(s => s.project === view.project).map(waitingKey), state.chatting]);
  if (view.kind === 'turn') return JSON.stringify([...common, state.projects, state.sessions.map(waitingKey), state.chatting]);
  return JSON.stringify([...common, state.projects]);
}
function renderTree() {
  const roots = projectSiblings('');
  $('#list').innerHTML = UI`<div class="cap">プロジェクト</div><div class="tree">${roots.map(p => projectNode(p, 0)).join('')}</div>
    <button class="newp ${view.kind === 'newproject' ? 'sel' : ''}" data-go="newproject" type="button">＋ 新しいプロジェクト</button>`;
  renderedTreeKey = treeKey();
}

// ---- 全体 ----
function updateTurnCounts() {
  const items = state.projects.flatMap(p => p.tasks.map(t => ({ p, t })));
  const replies = items.filter(({ p, t }) => REPLY(p, t)).length;
  const confirmations = items.filter(({ p, t }) => CONFIRM(p, t)).length;
  $('#turn-n').textContent = L('返事待ち ') + replies;
  $('#turn-done-n').textContent = L('完了確認 ') + confirmations;
  $('#turn').setAttribute('aria-label', UI`あなたの番：返事待ち ${replies}件、完了確認 ${confirmations}件`);
}
function render() {
  if (view.kind !== 'settings') { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  const waiting = state.projects.flatMap(p => p.tasks.filter(t => NEEDS(t) || aiWaiting(p.id, t.id).length).map(t => ({ p, t })));
  updateTurnCounts();
  showVersion(state.version, state.latest);
  const windowsNotice = $('#windows-notice');
  if (windowsNotice) {
    windowsNotice.hidden = !state.windowsBrowser;
    if(state.windowsBrowser) {
      const monitoring=state.backgroundStatus;
      const status=monitoring?.state==='ok' ? (monitoring.unassigned ? UI`未割り当ての外部 AI プロセスを ${monitoring.unassigned} 件検出しました。作業場所は確認できません。` : L('バックグラウンドプロセスの照会に成功しました。')) : L('バックグラウンドの状態は不明です。作業がないとは判断できません。')+(monitoring?.code?`（代碼：${monitoring.code}）`:'');
      windowsNotice.textContent=UI`Windows 原生 Codex：作業範囲の承認、会話、ConPTY ターミナル。${status} 整理・復元の前に、実行中や未割り当ての作業がないことを確認してください。Claude／Agy／Grok CLI の実行と分離は未検証です。ChatGPT／Claude Chat は手動引き継ぎです。`;
    }
  }
  $('#turn').setAttribute('aria-pressed', view.kind === 'turn');
  $('#gear').setAttribute('aria-pressed', view.kind === 'settings');
  renderTree();
  if (view.kind !== 'work') closePanes();
  if (view.kind === 'settings') renderSettings();
  else if (view.kind === 'newproject') renderNewProject();
  else if (!state.projects.length) renderEmpty();
  else if (view.kind === 'turn') renderTurn(waiting);
  else if (view.kind === 'work') renderWork();
  else renderOverview(proj(view.project));
  renderedMainKey = mainKey();
  window.HubMobile?.badges();
}

// 分岐・子の名前：元の名前のまま、後ろに空いている番号（「台湾市場 2」「台湾市場 3」…）
function nextName(base, existing) {
  const stem = String(base || '').replace(/\s+\d+$/, '').trim();
  const used = new Set(existing.map(x => String(x || '').trim()));
  for (let n = 2; n < 1000; n++) if (!used.has(`${stem} ${n}`)) return `${stem} ${n}`;
  return `${stem} 2`;
}
function renderEmpty() {
  if (state.windowsBrowser) {
    $('#main').innerHTML = UI`<div class="view"><div class="empty"><h2>まだプロジェクトがありません</h2>
      <p>［新しいプロジェクト］から台帳を作成できます。AI の実行は、作業を選び、作業範囲と接続先を確認してから始めます。</p>
      <button class="btn" data-go="newproject" type="button">＋ 新しいプロジェクト</button></div></div>`;
    return;
  }
  $('#main').innerHTML = UI`<div class="view"><div class="empty"><h2>台帳が見つかりません</h2>
    <p><code>${esc(state.root)}/Product/</code> に台帳（PROJECT.md）がありません。</p>
    <p>ターミナルで <code>bash setup.sh</code> を実行すると、今の作業の台帳が作られます。</p></div></div>`;
}

let turnTab = 'reply'; // reply＝返事が必要 ／ done＝完了に移す
function renderTurn(list) {
  const reply = list.filter(({ p, t }) => REPLY(p, t));
  const done = list.filter(x => !reply.includes(x));
  const cur = turnTab === 'done' ? done : reply;
  $('#main').innerHTML = UI`<div class="view"><div class="ph"><h2>あなたの番</h2>
      <div class="seg" role="tablist"><button class="${turnTab === 'reply' ? 'on' : ''}" data-turn-tab="reply" type="button" role="tab">返事待ち（${reply.length}）</button><button class="${turnTab === 'done' ? 'on' : ''}" data-turn-tab="done" type="button" role="tab">完了確認（${done.length}）</button></div>
      <span class="small">${turnTab === 'done' ? L('AI が終わったと言っている作業。中身を見て、完了に移すか続けるかを決めます') : L('返事待ち・上限で止まっている作業と、AI が入力や選択を待っている作業')}</span><span class="sp"></span>
      ${turnTab === 'reply' && reply.length > 1 ? UI`<button class="btn plain sm" id="turn-answer-all" type="button" title="AI には送らず、すべての返事待ちの表示を消します。AI は続きを始めません。">すべて送らずに消す（${reply.length}）</button>` : ''}</div>
    ${turnTab === 'reply' && cur.length ? UI`<p class="small">［送らずに消す］は質問と返事待ちの表示だけを消します。AI には送らず、続きを始めません。</p>` : ''}
    ${cur.length ? UI`<div class="card">${cur.map(({ p, t }) => taskRow(p, t, true, turnTab)).join('')}</div>` : UI`<p class="note">${turnTab === 'done' ? L('完了に移すものはありません。') : L('返事が必要なものはありません。')}</p>`}</div>`;
}
// 子プロジェクトに分ける：1行に1つ「名前｜やること」。名前が無ければ元の名前＋番号。それぞれ作って、最初の作業をすぐ AI に頼む
function splitProject(p) {
  if (!p) return;
  const manualMode = webActor(initialPick().ai);
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  el.innerHTML = UI`<div class="fs-box"><div class="fs-head"><b>「${esc(p.name)}」を子プロジェクトに分ける</b><span class="small">1行に1つ。「名前｜やること」の形。名前を省くと「${esc(p.name)} 2」「${esc(p.name)} 3」…になります。${manualMode ? L('作ったあと、手動引き継ぎを準備します。各作業から一つずつプレビューして送信してください。') : L('作ったあと、それぞれの最初の作業をすぐ AI に頼みます（同時に進みます）')}</span></div>
    <div class="fs-list" style="padding:12px"><textarea id="split-lines" rows="6" style="width:100%" placeholder="例：\n受付画面｜入退室の受付画面を作る\n決済｜決済の仕組みを調べて設計する\n通知｜保護者への通知を作る"></textarea></div>
    <div class="acts fs-acts"><span class="small" id="split-note"></span><span class="sp"></span><button type="button" class="btn plain" data-fs-close>やめる</button><button type="button" class="btn" id="split-go">分けて始める</button></div></div>`;
  $('#split-lines').focus();
  $('#split-go').onclick = async () => {
    const lines = $('#split-lines').value.split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.length) { toast(L('1行以上書いてください')); return; }
    if (lines.length > 8) { toast(L('一度に分けるのは8つまでにしてください')); return; }
    if (!confirm(manualMode ? UI`${lines.length} つの子プロジェクトを作り、手動引き継ぎを準備します。Web サイトへの送信は自分で行います。よいですか？` : UI`${lines.length} つの子プロジェクトを作り、それぞれの最初の作業を AI に頼みます。よいですか？`)) return;
    $('#split-go').disabled = true;
    const names = state.projects.map(x => x.name);
    let made = 0; const manual = [];
    for (const line of lines) {
      const m = line.match(/^(.*?)\s*[|｜:：]\s*(.+)$/);
      const text = m ? m[2].trim() : line;
      const name = m && m[1].trim() ? m[1].trim() : nextName(p.name, names);
      names.push(name);
      $('#split-note').textContent = UI`${name} を作っています…`;
      try {
        const child = await api('/api/project/new', { name, parent: p.id, description: text.slice(0, 200), phases: (p.phases || []).map(x => x.name).join('\n') });
        const result = await api('/api/start', { project: child.id, text, ...startSpec(initialPick()), images: [] });
        if (result.webManual) manual.push({result,project:child.id,text});
        open.add(child.id); made++;
      } catch (err) { toast(`${name}：${err.message}`); }
    }
    $('#fsheet').hidden = true;
    toast(manual.length ? UI`${made} つの子プロジェクトを作り、手動引き継ぎの作業を準備しました。送信はまだ行っていません。` : UI`${made} つの子プロジェクトを作って、作業を始めました`);
    open.add(p.id); save(); await load();
    if (manual.length) openManualStart(manual[0].result, manual[0].project, manual[0].text);
  };
}
// 作業画面の質問に答える：答えを、この作業の AI に指示として送る（送ると質問は済んだことになる）
document.addEventListener('submit', e => {
  if (e.target.id !== 'ask-form') return;
  e.preventDefault();
  const answer = e.target.elements.namedItem('answer').value.trim();
  if (!answer) { toast(L('答えを書いてください')); return; }
  if (chatSending.has(chatAttachmentKey(e.target.dataset.p, e.target.dataset.t))) return;
  const ta = $('#chat-in');
  if (!ta) { toast(L('会話画面で送ってください（上の「会話」を選ぶ）')); return; }
  const text = `（質問「${(e.target.closest('.ask-box').querySelector('.ask-head span') || {}).textContent || ''}」への答え）${answer}`;
  if (sendWorkAnswer?.project === e.target.dataset.p && sendWorkAnswer.task === e.target.dataset.t) sendWorkAnswer.send(text);
});
// 子が途中のまま親で作業を始めようとした時の知らせ
function warnChildren(p) {
  const u = p ? unfinishedChildren(p) : [];
  return !u.length || confirm(UI`子プロジェクトの作業が ${u.length} 件終わっていません（${u.map(x => x.name).join('、')}）。\n親で作業を進めますか？`);
}
// AI へ送らず、返事待ちの表示だけをまとめて消す
document.addEventListener('click', async e => {
  if (!e.target.closest || !e.target.closest('#turn-answer-all')) return;
  const list = state.projects.flatMap(p => p.tasks.filter(t => REPLY(p, t)).map(t => ({ p, t })));
  if (list.some(({p,t}) => chatSending.has(chatAttachmentKey(p.id,t.id)))) { toast(L('回答を送っています。受付結果が出てから操作してください')); return; }
  if (!list.length || !confirm(UI`${list.length} 件すべての質問を AI に送らずに消しますか？ AI は続きを始めません。`)) return;
  let ok = 0;
  for (const { p, t } of list) { try { await api('/api/task', { project: p.id, task: t.id, question: '', state: '実行中', memo: '人が質問を AI に送らずに消した' }); ok++; } catch (err) { toast(err.message); } }
  toast(UI`${ok} 件の質問を消しました（AI には送っていません）`); await load();
});
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-turn-tab]');
  if (b) { turnTab = b.dataset.turnTab; render(); }
});

// ---- 新しいプロジェクト ----
let newRefs = [];
let newProjectPreset = null;
function drawRefs() {
  const box = $('#np-reflist'); if (!box) return;
  box.innerHTML = newRefs.length ? newRefs.map((r, i) => UI`<span class="ref" title="${esc(r)}">${esc(r.split('/').filter(Boolean).pop() || r)}<button type="button" data-rmref="${i}" aria-label="外す">×</button></span>`).join('') : UI`<span class="small">ここに落とす、または［選ぶ］</span>`;
}
function addNewRefs(paths) {
  for (const x of paths) if (x && !newRefs.includes(x)) newRefs.push(x);
  drawRefs();
  const d = $('#np-refs') && $('#np-refs').closest('details'); if (d) d.open = true;
}
function renderNewProject() {
  const opts = state.projects.map(p => UI`<option value="${esc(p.id)}" ${newProjectPreset?.parent === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#main').innerHTML = UI`<div class="view"><div class="ph"><h2>${newProjectPreset?.derivedFrom ? L('同じ階層に分岐') : newProjectPreset?.parent ? L('子プロジェクトを作る') : L('新しいプロジェクト')}</h2></div>
    <div class="card"><form class="newform" id="projform">
      <input type="hidden" name="derivedFrom" value="${esc(newProjectPreset?.derivedFrom || '')}"><label>プロジェクト名<input name="name" id="np-name" required maxlength="60" placeholder="例：HD 占いアプリ" value="${esc(newProjectPreset?.name || '')}"></label>
      ${newProjectPreset ? UI`<label>最初の作業（やりたいこと。書くと、作ったあとすぐ AI に頼みます。名前だけのプロジェクトにしないため）<textarea name="firstTask" rows="2" maxlength="4000" placeholder="例：台湾向けの投稿を3本作る"></textarea></label>` : ''}
      <label>説明（何を作るか・誰のためか。1〜2行）<textarea name="description" id="np-desc" rows="2" maxlength="400"></textarea></label>
      <label>フェーズ（1行に1つ。順番どおり）<textarea name="phases" id="np-phases" rows="4" maxlength="400">計画\n作る\nチェック\n仕上げ</textarea></label>
      <details class="more"><summary>くわしく（なくてもよい）</summary><div class="newform" style="margin-top:10px">
        <label>本体のフォルダ（もうコードや資料がある時）
          <div class="dropfield" id="np-drop"><input name="body" id="np-body" maxlength="300" placeholder="ここにフォルダを落とす、または［選ぶ］"><button class="btn plain sm" id="np-pick" type="button">選ぶ…</button></div></label>
        <label>親プロジェクト（小分けにする時）<select name="parent" id="np-parent"><option value="">（なし）</option>${opts}</select></label>
        <label>参考にするフォルダ・ファイル（Hub の外。AI は読むだけで書き換えない。何個でも）
          <div class="dropfield refs" id="np-refs"><div class="reflist" id="np-reflist"><span class="small">ここに落とす、または［選ぶ］</span></div><button class="btn plain sm" id="np-refpick" type="button">選ぶ…</button></div></label>
        ${state.projects.length ? UI`<fieldset class="rels"><legend>関連プロジェクト（Hub の他のプロジェクト。AI がその資料を読んでよい）</legend>${state.projects.map(p => UI`<label class="chk"><input type="checkbox" name="related" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join('')}</fieldset>` : ''}
      </div></details>
      <p class="small">台帳（PROJECT.md）・AI 用の指示（CLAUDE.md・AGENTS.md）・作業用のフォルダ（資料・作業・成果物・.ai）を <span class="path">${esc(state.root)}/Product/</span> に作ります。</p>
      <div><button class="btn" type="submit">プロジェクトを作る</button></div>
    </form></div></div>`;
  drawRefs();
  if (newRefs.length) $('#np-refs').closest('details').open = true;
}

// ---- 概要画面（プロジェクトの説明と作業の一覧） ----
function projectFamily(p) {
  const root = q => { let seen = new Set(); while (q && !seen.has(q.id)) { seen.add(q.id); const next = proj(displayParent(q,state.projects)); if (!next) return q.id; q=next; } return p.id; };
  const id=root(p); return state.projects.filter(q=>root(q)===id);
}
function sourceTask(p, ref) {
  if (!ref) return null; const i=ref.indexOf('/'); const q=i<0?p:proj(ref.slice(0,i)), t=taskOf(q,i<0?ref:ref.slice(i+1)); return q&&t?{p:q,t}:null;
}
// compact：一覧の行では1行に詰める（派生は件数だけ）。作業画面では全部の名前と状態を出す
function taskContext(p,t,compact) {
  const src = sourceTask(p,t.derivedFrom);
  if (compact) {
    const derived = projectFamily(p).flatMap(q=>q.tasks.filter(x=>x.kind==='derived' && (x.derivedFrom===`${p.id}/${t.id}` || q.id===p.id && x.derivedFrom===t.id)).map(x=>({p:q,t:x})));
    const busy = derived.filter(x => live(x.p.id, x.t.id)).length, fin = derived.filter(x => x.t.state === '完了').length;
    const parts = [UI`<span class="pill">${t.kind==='derived'?L('派生'):L('本作業')}</span>`];
    if (src) parts.push(UI`派生元：<button class="lnk" data-go="work" data-p="${esc(src.p.id)}" data-t="${esc(src.t.id)}" type="button">${esc(src.t.title)}</button>`);
    if (derived.length) parts.push(UI`渡した作業 ${derived.length}件（作業中 ${busy}・終わった ${fin}）`);
    parts.push(t.copy ? L('作業用コピー') : t.workspaceMode==='direct' || t.workspaceStarted ? L('本体で作業') : L('場所は開始時に決定'));
    return UI`<div class="task-context small">${parts.join(UI`<i class="sep">・</i>`)}</div>`;
  }
  const derived = projectFamily(p).flatMap(q=>q.tasks.filter(x=>x.kind==='derived' && (x.derivedFrom===`${p.id}/${t.id}` || q.id===p.id && x.derivedFrom===t.id)).map(x=>({p:q,t:x})));
  const stat = x => (live(x.p.id, x.t.id) ? UI`<span class="pst busy"><i></i>${esc(ownerOf(x.t.owner).name)} が作業中</span>` : x.t.state === '完了' ? UI`<span class="small">終わった</span>` : UI`<span class="small">${esc(L(x.t.state))}</span>`);
  const link = x => UI`<button class="lnk" data-go="work" data-p="${esc(x.p.id)}" data-t="${esc(x.t.id)}" type="button">${esc(x.p.name)} / ${esc(x.t.title)}</button>`;
  return UI`<div class="task-context small"><span class="pill">${t.kind==='derived'?L('派生'):L('本作業')}</span>${src ? L(' 派生元：')+link(src) : ''}${derived.length ? L('　渡した・派生した作業：')+derived.map(x => `${link(x)} ${stat(x)}`).join(' / ') : ''}　${t.copy?L('作業用コピーで作業'):t.workspaceMode==='direct' || t.workspaceStarted?L('本体で作業（合体不要）'):L('作業場所：開始時に決定（Gitのない場所は本体）')}</div>`;
}
function sourceOptions(p,t) {
  return projectFamily(p).flatMap(q=>q.tasks.filter(x=>!t || x.id!==t.id || q.id!==p.id).map(x=>UI`<option value="${esc(q.id+'/'+x.id)}" ${t && (t.derivedFrom===q.id+'/'+x.id || q.id===p.id && t.derivedFrom===x.id) ? 'selected' : ''}>${esc(q.name)} / ${esc(x.title)}</option>`)).join('');
}
// tab：あなたの番のタブ（reply＝返事が必要→［返事した］を出す／done＝完了に移す→その操作だけ）
function taskRow(p, t, showProject, tab) {
  const cur = t.steps.find(x => !x.done);
  const w = aiWaiting(p.id, t.id);
  const sub = t.question ? UI`<span class="q2">あなたへの質問：${linkify(t.question)}</span>`
    : w.length ? UI`<span class="q2">${w.map(x => AI_LABEL[x.ai]).join(L('・'))} が入力を待っています（${Math.floor(Math.max(...w.map(x => x.quiet)) / 60)}分）</span>`
    : UI`<span>${showProject ? esc(p.name) + L('・') : ''}${t.state === '完了' ? L('完了') : cur ? L('次：') + esc(cur.text) : t.next ? L('次：') + esc(t.next.split('\n')[0]) : esc(L(t.state))}</span>`;
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const pending = t.completionPending && !(t.question && t.state !== '完了') && tab !== 'reply';
  const action = tab === 'reply' ? UI`<button class="btn sm" data-act="answered" ${k} type="button" title="AI には送りません。この質問と返事待ちの表示だけを消します。AI は続きを始めません。">送らずに消す</button>`
    : pending || (t.question && t.state !== '完了') ? '' : completionButtons(p, t);
  return UI`<div class="trow ${t.parent ? 'child' : ''} ${t.state === '完了' ? 'fin' : ''}">
    <div class="tt"><b>${esc(t.title)}</b>${sub}</div>
    <div class="tw">${chip(p, t)}${t.via ? UI`<span class="via">${esc(t.via)}</span>` : ''}</div>
    ${progressBar(t)}
    <div class="tact">${action}<button class="btn plain sm" data-go="work" ${k} type="button">作業画面へ</button></div>
    ${taskContext(p, t, true)}
    ${pending ? pendingBar(p, t) : ''}
  </div>`;
}
// 一覧の行の下に出す「完了に移しますか？」の帯（やったことは1行だけ）
function pendingBar(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const first = (t.done || '').split('\n').find(x => x.trim()) || '';
  return UI`<div class="pend"><span><b>AI が手順をすべて済にしました。</b>完了に移しますか？</span>
    <button class="btn sm" data-act="taskcomplete" ${k} type="button">完了に移す</button><button class="btn plain sm" data-act="taskcontinue" ${k} type="button">まだ続ける</button>
    ${first ? UI`<span class="small note">やったこと：${esc(first.replace(/^[-*]\s*/, '').slice(0, 160))}</span>` : ''}</div>`;
}
function completionButtons(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  if (t.question && t.state !== '完了') return ''; // 質問がある間は、まず答える（完了の操作は出さない）
  if (t.completionPending) return UI`<div class="wq"><span>AI が手順をすべて済にしました。完了に移しますか？</span><button class="btn sm" data-act="taskcomplete" ${k} type="button">完了に移す</button><button class="btn plain sm" data-act="taskcontinue" ${k} type="button">まだ続ける</button>
    ${t.done ? UI`<div class="small done-note"><b>やったこと：</b>${linkify(t.done.length > 400 ? t.done.slice(0, 400) + '…' : t.done)}</div>` : ''}</div>`;
  return UI`<button class="btn plain sm" data-act="${t.state === '完了' ? 'taskcontinue' : 'taskcomplete'}" ${k} type="button">${t.state === '完了' ? L('再開する') : L('完了に移す')}</button>`;
}

function phaseRoad(p, info) {
  if (!info.list.length) return '';
  const road = info.list.map((ph, i) => {
    const done = ph.state === '完了';
    return UI`<div class="step ${done ? 'done' : ''} ${i === info.cur && !done ? 'now' : ''}">
      ${done ? '<span class="stamp">COMPLETE</span>' : ''}
      <span class="no">フェーズ ${i + 1}</span><span class="nm">${esc(L(ph.name))}</span>
      <div class="pbar"><i style="width:${Math.round((done ? 1 : ph.ratio) * 100)}%"></i></div>
      <span class="st">${esc(ph.state === '完了' ? '完了' : ph.completionPending ? L('完了報告あり・確認待ち') : i === info.cur ? '進行中' : '未着手')}・作業 ${ph.tasks.filter(t => t.state === '完了').length} / ${ph.tasks.length}</span></div>`;
  }).join('');
  const c = info.list[info.cur];
  const continued = p.phaseContinueKey && p.phaseContinueKey === p.phaseOfferKey;
  const banner = c && (c.tasksDone && !continued || p.phases[info.cur]?.completionPending) ? UI`<div class="banner"><b>確認</b><span>「${esc(c.name)}」を完了に移しますか？</span><span class="sp"></span>
      <button class="btn" data-act="nextphase" data-p="${esc(p.id)}" type="button">${info.list[info.cur + 1] ? UI`次のフェーズ「${esc(info.list[info.cur + 1].name)}」へ進む` : L('プロジェクトを完了にする')}</button><button class="btn plain" data-act="phasecontinue" data-p="${esc(p.id)}" type="button">まだ続ける</button></div>` : '';
  return UI`<div class="road">${road}</div>${banner}`;
}

// プロジェクトごとの下書き。画像本体はMac内、ここには参照番号だけを残す。
const quickDrafts = new Map(), quickUploading = new Set(), quickStarting = new Set();
const isQuickImage = f => /\.(png|jpe?g|webp|gif|heic)$/i.test(typeof f === 'string' ? f : f.name || '') || /^image\/(png|jpeg|webp|gif|heic)$/i.test(f.type || '');
function quickDraft(p) {
  if (!quickDrafts.has(p.id)) {
    let old; try { old = JSON.parse(localStorage.getItem('hub-start-' + p.id) || 'null'); } catch (e) { /* 初回 */ }
    const spec = p.startSpec || initialPick();
    quickDrafts.set(p.id, { text: '', images: [], ...spec, ...old });
  }
  return quickDrafts.get(p.id);
}
function keepQuick(pid) {
  try { localStorage.setItem('hub-start-' + pid, JSON.stringify(quickDrafts.get(pid))); }
  catch (e) { toast(L('下書きを保存できません。保存領域を確認してください')); }
}
function quickOwners() {
  const agents = new Set(state.roles.agents || []);
  state.projects.forEach(p => p.tasks.forEach(t => { if (ownerOf(t.owner).kind === 'agent') agents.add(ownerOf(t.owner).name); }));
  return [...AIS.map(ai => ({ ai, name: AI_LABEL[ai] })), ...(state.windowsBrowser?['chatgpt','claude-chat'].map(ai=>({ai,name:AI_LABEL[ai]})):[]), ...[...agents].map(a => ({ ai: 'discord:' + a, name: a + '（Discord）' }))];
}
function quickControls(p) {
  const d = quickDraft(p), busy = quickStarting.has(p.id), cli = AIS.includes(d.ai), web = webActor(d.ai), models = shownModels(AI_KEY[d.ai], d.model);
  const missing = d.model && !models.includes(d.model);
  return UI`<button class="btn plain" id="quick-attach" ${busy || web ? 'disabled' : ''} type="button" aria-label="画像を選ぶ" title="画像を選ぶ">📎</button>
    <input type="file" id="quick-files" accept=".png,.jpg,.jpeg,.webp,.gif,.heic" multiple hidden ${busy || web ? 'disabled' : ''}>
    <select id="quick-ai" ${busy ? 'disabled' : ''} aria-label="始めるAI">${quickOwners().map(x => UI`<option value="${esc(x.ai)}" ${x.ai === d.ai ? 'selected' : ''} ${AIS.includes(x.ai) && !cliReady(x.ai) || webActor(x.ai) && !manualReady(x.ai) ? 'disabled' : ''}>${esc(x.name)}${AIS.includes(x.ai) && !cliReady(x.ai) ? L('（まだ利用できません）') : ''}</option>`).join('')}</select>
    ${cli ? UI`<select id="quick-model" aria-label="モデル" ${d.ai === 'agy' || busy || !cliReady(d.ai) ? 'disabled' : ''}><option value="">モデル：役割どおり</option>${missing ? UI`<option selected disabled value="${esc(d.model)}">${esc(d.model)}（利用不可）</option>` : ''}${models.map(m => UI`<option ${m === d.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <select id="quick-effort" aria-label="思考" ${d.ai === 'agy' || busy || !cliReady(d.ai) ? 'disabled' : ''}><option value="">思考：役割どおり</option>${(d.ai === 'agy' ? ['高'] : state.efforts).map(e => UI`<option ${e === d.effort ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>` : web ? UI`<span class="small">手動引き継ぎ：内容をプレビューして確認し、Web サイトに自分で貼って送信します。添付ファイルは Web サイトで選んでください。</span>` : UI`<span class="small">Discordへの自動送信は未対応。依頼と画像の場所を保存します。</span>`}
    <span class="sp"></span><button class="btn" type="submit" ${quickUploading.has(p.id) || busy || cli && !cliReady(d.ai) || web && !manualReady(d.ai) ? 'disabled' : ''}>${quickUploading.has(p.id) ? L('画像を保存中…') : busy ? L('始めています…') : web ? L('手動引き継ぎを準備') : L('始める')}</button>`;
}
function drawQuick(p) {
  if (view.kind !== 'project' || view.project !== p.id) return;
  const thumbs = $('#quick-images'), controls = $('#quick-controls'), d = quickDraft(p);
  if (thumbs) thumbs.innerHTML = d.images.map((x, i) => UI`<span class="quick-image"><img src="${esc(x.url)}" alt="${esc(x.name)}"><button type="button" data-quick-remove="${i}" aria-label="${esc(x.name)}を取り消す">×</button><small title="${esc(x.name)}">${esc(x.name)}</small></span>`).join('');
  if (controls) controls.innerHTML = quickControls(p);
}
async function addQuickImages(p, files, native = false) {
  if (!p || quickUploading.has(p.id) || quickStarting.has(p.id)) { toast(L('保存が終わってから画像を追加してください')); return; }
  const d = quickDraft(p);
  if (webActor(d.ai)) { toast(L('手動引き継ぎの添付ファイルは Web サイトで選んでください。')); return; }
  const images = files.filter(isQuickImage);
  if (d.images.length + images.length > 10) { toast(L('画像は1回10枚までです。不要な画像を取り消してください')); return; }
  quickUploading.add(p.id); drawQuick(p);
  try {
    for (const f of images) {
      let r;
      if (native) r = await api('/api/start/image-path', { project: p.id, path: f });
      else {
        const name = f.name || `貼り付け画像-${Date.now()}.png`;
        if(window.HubNativeRestart?.paused)throw Error('重新啟動期間已暫停上傳。');
        const response = await fetch('/api/start/image?' + new URLSearchParams({ project: p.id, name }), { method: 'POST', headers: { 'X-Hub': '1' }, body: f });
        r = await response.json(); if (!response.ok) throw Error(r.error || L('画像を保存できません'));
      }
      d.images.push(r); keepQuick(p.id); drawQuick(p);
    }
    if (images.length) toast(UI`画像を${images.length}枚追加しました`);
    return true;
  } catch (e) { toast(e.message); return false; }
  finally { quickUploading.delete(p.id); drawQuick(p); }
}
document.addEventListener('input', e => {
  const f = e.target.closest && e.target.closest('#quickform');
  if (f && e.target.name === 'text') { quickDraft(proj(f.dataset.p)).text = e.target.value; keepQuick(f.dataset.p); }
});
document.addEventListener('click', e => {
  const p = view.kind === 'project' && proj(view.project); if (!p) return;
  if (e.target.id === 'quick-attach') $('#quick-files').click();
  if (e.target.dataset && e.target.dataset.quickRemove !== undefined && !quickStarting.has(p.id)) { quickDraft(p).images.splice(+e.target.dataset.quickRemove, 1); keepQuick(p.id); drawQuick(p); }
});

const refsOf = p => p.folders.filter(f => /^参考/.test(f.label));
function renderOverview(p) {
  if (!p) return renderEmpty();
  const info = phaseInfo(p);
  const here = t => !info.list.length || info.cur < 0 || info.inPhase(t, info.cur);
  const active = p.tasks.filter(t => t.state !== '完了' && here(t));
  const others = p.tasks.filter(t => t.state !== '完了' && !here(t));
  const done = p.tasks.filter(t => t.state === '完了');
  const phaseOpts = p.phases.map((ph, i) => UI`<option value="${esc(ph.name)}" ${i === info.cur ? 'selected' : ''}>${esc(L(ph.name))}</option>`).join('');
  const agentOpts = (state.roles.agents || []).map(a => UI`<option value="discord:${esc(a)}">${esc(a)}（Discord）</option>`).join('');
  const roleOpts = state.roles.roles.map(r => UI`<option value="${esc(r.name)}">${esc(roleLabel(r.name))}</option>`).join('');
  const taskOpts = p.tasks.map(t => UI`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
  const description = p.description || p.notes;
  $('#main').innerHTML = UI`<div class="view">
    <div class="ph"><h2>${esc(p.name)}</h2><span class="pill s-${esc(p.status)}">${esc(p.status)}</span>
      <span class="small">最終更新 ${esc(p.updated || '—')}</span>
      ${p.copies ? copiesHtml(p) : ''}<span class="sp"></span>
      <button class="btn plain" data-act="split" data-p="${esc(p.id)}" type="button" title="やることを子プロジェクトに分けて、それぞれ同時に始めます">子プロジェクトに分ける</button>
      ${(p.parent || p.derivedFrom) ? UI`<button class="btn plain" data-act="handoff-parent" data-p="${esc(p.id)}" type="button" title="このプロジェクトの結果を、親の作業に書き込みます（親の AI が次に読みます）">親に結果を渡す</button>` : ''}
      <button class="btn plain" data-act="pstatus" data-p="${esc(p.id)}" data-s="${p.status === '完了' ? '進行中' : '完了'}" type="button">${p.status === '完了' ? L('完了を取り消す') : L('プロジェクトを完了にする')}</button>
      <button class="btn plain" data-maintenance="1" data-p="${esc(p.id)}" type="button">整理と確認</button>${githubUrl(p) ? UI`<button class="btn plain" data-url="${esc(githubUrl(p))}" type="button" title="GitHub で開く（${esc(githubUrl(p))}）">GitHub</button>` : UI`<span id="github-create-status">${githubCreateButton(p)}</span>`}<button class="btn plain" data-act="files" type="button">ファイルを見る</button></div>
    ${description ? UI`<details class="more project-notes" data-p="${esc(p.id)}" ${projectNotesOpen.has(p.id) ? 'open' : ''}><summary>説明・メモ</summary><p class="desc">${esc(description)}</p></details>` : ''}
    ${state.completionWarning ? UI`<p class="wq">${esc(state.completionWarning)}</p>` : ''}
    ${p.completionPending ? UI`<p class="wq">プロジェクトの完了報告があります。上の［完了にする］で確認するか、［まだ続ける］を選んでください。</p><button class="btn plain" data-act="pstatus" data-p="` + esc(p.id) + UI`" data-s="進行中" type="button">まだ続ける</button>` : ''}
    ${p.derivedFrom ? UI`<p class="small">派生元：${proj(p.derivedFrom) ? UI`<button class="lnk" data-go="project" data-p="${esc(p.derivedFrom)}" type="button">${esc(proj(p.derivedFrom).name)}</button>` : esc(p.derivedFrom)}</p>` : ''}
    ${phaseRoad(p, info)}
    <div class="card"><h3 class="sec">${info.curName ? UI`今のフェーズの作業（${esc(info.curName)}）` : '作業'}</h3>
      <form class="quick" id="quickform" data-p="${esc(p.id)}">
        <textarea name="text" rows="2" maxlength="4000" placeholder="やりたいことを書くだけで始められます（例：入退室の画面を作って）">${esc(quickDraft(p).text)}</textarea>
        <div class="quick-images" id="quick-images"></div>
        <div class="quick-controls" id="quick-controls">${quickControls(p)}</div>
        <p class="small">画像はここに落とす・⌘V・📎で追加（最大10枚）。入力内容はプロジェクトごとに保存します。</p>
      </form>
      ${active.length ? active.map(t => taskRow(p, t)).join('') : UI`<p class="note">進行中の作業はありません。</p>`}
      ${others.length ? UI`<details class="more"><summary>他のフェーズの作業（${others.length}）</summary>${others.map(t => taskRow(p, t)).join('')}</details>` : ''}
      ${done.length ? UI`<details class="more"><summary>完了した作業（${done.length}）</summary>${done.map(t => taskRow(p, t)).join('')}</details>` : ''}
      <details class="more"><summary>＋ 細かく決めて作業を足す</summary>
        <form class="newform" id="newform" style="margin-top:10px">
          <label>作業名<input name="title" required maxlength="80" placeholder="例：メモ一覧の文言を直す"></label>
          <label>作業の種類<select name="kind"><option value="main">本作業</option><option value="derived">派生</option></select></label>
          <label>派生元<select name="derivedFrom"><option value="">（派生の場合は選ぶ）</option>${sourceOptions(p)}</select></label>
          <label>作業する場所<select name="workspaceMode"><option value="isolated">作業用コピー（コードは後で本体へ取り込む）</option><option value="direct">本体で作業（合体不要・同時作業不可）</option></select></label>
          <label>ツリーの親作業<select name="parent"><option value="">（なし）</option>${taskOpts}</select></label>
          <label>役割<select name="role"><option value="">（なし）</option>${roleOpts}</select></label>
          ${phaseOpts ? UI`<label>フェーズ<select name="phase">${phaseOpts}</select></label>` : ''}
          <label>担当<select name="owner">${[...AIS,'chatgpt','claude-chat'].map(ai=>UI`<option value="${AI_KEY[ai] || ai}">${esc(AI_LABEL[ai])}${webActor(ai)?L('（手動引き継ぎ）'):!cliReady(ai)?L('（まだ利用できません）'):''}</option>`).join('')}${agentOpts}<option value="人">あなた</option></select></label>
          <label>どこで頼んだか（Discord の時。例：#サンプル作業）<input name="via" maxlength="80"></label>
          <label>手順（1行に1つ。3〜5個）<textarea name="steps" rows="4" maxlength="600" placeholder="題材を決める&#10;下書き&#10;チェック&#10;投稿"></textarea></label>
          <div><button class="btn" type="submit">作業を足す</button></div>
        </form></details>
    </div>
    ${projectFamily(p).length>1 ? UI`<details class="more"><summary>同じ大きなプロジェクトの作業</summary>${projectFamily(p).filter(q=>q.id!==p.id).map(q=>UI`<h3><button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button></h3>${q.tasks.map(t=>taskRow(q,t,true)).join('')}`).join('')}</details>` : ''}
    ${bgOf(p.id).length ? UI`<div class="wq bg-note"><b>裏で作業中：</b><span>${esc(bgText(bgOf(p.id)))}</span><span class="small">Hub を通さずに起動された AI（作業：${esc(bgOf(p.id).map(x => x.task ? (taskOf(p, x.task) || {}).title || x.task : '不明').join(L('・')))}）</span></div>` : ''}
    ${childrenOf(p).length ? UI`<div class="card"><h3 class="sec">子プロジェクト（${childrenOf(p).length}）${unfinishedChildren(p).length ? UI`<span class="small">・終わっていない ${unfinishedChildren(p).length} 件</span>` : UI`<span class="small">・すべて終わりました</span>`}</h3>
      ${orderedChildren(p).map(q => { const open = q.tasks.filter(t => t.state !== '完了'); const ask = q.tasks.find(t => t.question); return UI`<div class="trow"><div class="tt"><b><button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button></b><span>${q.status === '完了' ? '完了' : UI`${esc(q.status)}・作業 ${q.tasks.length - open.length} / ${q.tasks.length}`}${ask ? UI`・<span class="q2">質問あり：${esc(ask.question.slice(0, 60))}</span>` : ''}</span></div><div class="tw"><span class="sdot ${projectLight(q).cls}"></span></div><div class="prog"></div><div class="tact"><button class="btn plain sm" data-go="project" data-p="${esc(q.id)}" type="button">開く</button></div></div>`; }).join('')}
      <p class="small">子が終わると、結果は親のいちばん新しい作業に書き込まれ、「新」が付きます。子が途中のまま親で作業を始めようとすると、知らせます。</p></div>` : ''}
    <div class="grid2">
      <div class="card issues-card"><h3 class="sec">問題点</h3>${issuesHtml(p.issues)}</div>
      <div class="card"><h3 class="sec">関連プロジェクト・参考（AI が読むだけ）</h3>${p.related.length || refsOf(p).length ? UI`<ul>${p.related.map(r => { const q = state.projects.find(x => x.name === r || x.id === r); return UI`<li>${q ? UI`<button class="lnk" data-go="project" data-p="${esc(q.id)}" type="button">${esc(q.name)}</button>` : esc(r)}</li>`; }).join('')}${refsOf(p).map(f => UI`<li><span class="ref" title="${esc(f.path)}">${esc(f.path.split('/').filter(Boolean).pop() || f.path)}</span></li>`).join('')}</ul>` : UI`<p class="note">なし</p>`}
        <p class="small">参考にしたいフォルダは、この画面に落とすと足せます。</p></div>
      ${p.chats.length ? UI`<div class="card"><h3 class="sec">ブラウザのチャット</h3><ul>${p.chats.map(c => UI`<li>${c.url ? UI`<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title || c.url)}</a>` : esc(c.title || c)}</li>`).join('')}</ul></div>` : ''}
    </div></div>`;
  drawQuick(p);
}

// 保存された要約と未整理の原文を区別する。ここでは意味や状態を推測しない。
function issuesHtml(issues = []) {
  if (!issues.length) return UI`<p class="note">なし</p>`;
  const current = [], pending = [], history = [];
  for (const issue of issues) {
    if (!issue.summary) pending.push(issue);
    else if (['解決済み', '履歴'].includes(issue.summary.state)) history.push(issue);
    else current.push(issue);
  }
  const row = issue => {
    const text = typeof issue === 'string' ? issue : issue.text;
    const s = issue.summary;
    const heading = String(text).match(/^\s*(【[^】\r\n]+】)/)?.[1] || '見出しなし';
    return UI`<li class="issue-row"><div class="issue-heading">${issue.level ? UI`<span class="pill">${esc(issue.level)}</span>` : ''}${s ? UI`<span class="pill">${esc(s.state)}</span>` : ''}<b class="issue-title${s ? '' : ' issue-unprepared'}">${esc(s ? s.title : heading)}</b></div>
      ${s ? (s.next ? UI`<p class="issue-next">次：${s.who === '人' ? L('あなた：') : s.who === 'AI' ? 'AI：' : ''}${esc(s.next)}</p>` : '') : UI`<p class="small">まだ短くまとめていません</p>`}
      <details class="issue-detail"><summary>詳しく</summary><p class="issue-original">${esc(text)}</p></details></li>`;
  };
  const list = items => UI`<ul class="issue-list">${items.map(row).join('')}</ul>`;
  return UI`<section class="issue-group"><h4>今の問題</h4>${current.length ? list(current) : UI`<p class="note">今の問題はありません</p>`}</section>
    ${pending.length ? UI`<section class="issue-group"><h4>まだまとめていない（${pending.length}件）</h4>${list(pending)}<p class="small">要約がないか、原文との照合に合いません。このプロジェクトの作業の会話で「問題点を短くまとめて」と頼むと、AI が読んでまとめます。</p></section>` : ''}
    ${history.length ? UI`<details class="issue-history issue-group"><summary>解決済み・履歴（${history.length}件）</summary>${list(history)}</details>` : ''}`;
}

// 「ファイルを見る」：場所が1つならすぐ開く。複数なら選ぶ
async function openFiles(btn) {
  const p = proj(view.project); if (!p) return;
  const t = view.kind === 'work' ? taskOf(p, view.task) : null;
  const list = [];
  if (t && t.workdir) list.push({ label: L('作業の場所'), path: t.workdir, kind: 'workdir' });
  p.folders.forEach(f => list.push({ label: f.label, path: f.path, kind: 'folder' }));
  list.push({ label: L('台帳（PROJECT.md・指示ファイル）'), path: p.dir, kind: 'project' });
  const go = async it => {
    try { await api('/api/open', { project: p.id, kind: it.kind, label: it.label, task: t && t.id }); toast(UI`${it.label}を開きました`); }
    catch (e) { toast(`${it.label}：${e.message}`); }
  };
  if (list.length === 1) return go(list[0]);
  const m = $('#menu');
  m.innerHTML = list.map((it, i) => UI`<button type="button" data-i="${i}">${esc(it.label)}<span>${esc(it.path)}</span></button>`).join('');
  m.hidden = false;
  const r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; m.hidden = true; go(list[+b.dataset.i]); };
}

// ---- 作業画面 ----
// 担当が ChatGPT の時：貼る文は Hub が作業の中身を入れて作る（普段の ChatGPT は Mac の道具を使えない）。返事は貼って戻す
const gptDraft = {}; // 画面を描き直しても、貼った返事を消さない
const gptBox = (p,t,show) => state.windowsBrowser ? UI`<div class="gptbox" data-p="${esc(p.id)}" data-t="${esc(t.id)}"><b>ChatGPT / Claude Chat</b><span class="small">プレビュー → 確認してコピー → 手動で送信 → 返事を貼る。API は使いません。</span><button class="btn plain sm" data-act="webchat" data-actor="chatgpt" type="button" ${manualReady('chatgpt')?'':'disabled'}>ChatGPT 手動引き継ぎ</button><button class="btn plain sm" data-act="webchat" data-actor="claude-chat" type="button" ${manualReady('claude-chat')?'':'disabled'}>Claude 手動引き継ぎ</button></div>` : legacyGptBox(p,t,show);
document.addEventListener('input', e => { const b = e.target.classList.contains('gpt-back') && e.target.closest('.gptbox'); if (b) gptDraft[b.dataset.p + '/' + b.dataset.t] = e.target.value; });
async function gptPrompt(p, t, text = '') { return (await api('/api/chatgpt/prompt', { project: p.id, task: t.id, text })).text; }
// 貼る文を作ってコピーし、アプリの中なら横に ChatGPT を開く（ブラウザで使っている時は ChatGPT を別のタブで）
// msgP は文が届く Promise。コピーは押した直後に始める。コピーできなかった時は、貼る文の欄を開いて選んだ状態にする
let gptLast = null; // { key, copied }：最後に頼んだ作業と、Hub がコピーした文（同じ文が知らされても無視する）
const gptOut = {}, gptFail = new Set(); // 作った貼る文（作業ごと）・コピーできなかった作業（貼る文の欄を開いておく）
async function gptSend(P, T, msgP) {
  const okP = copyLater(msgP);
  const msg = await msgP, key = P + '/' + T;
  gptLast = { key, copied: msg }; gptOut[key] = msg;
  const ok = await okP;
  if (ok) gptFail.delete(key); else gptFail.add(key);
  document.querySelectorAll(`.gptbox[data-p="${CSS.escape(P)}"][data-t="${CSS.escape(T)}"]`).forEach(b => {
    const out = b.querySelector('.gpt-out'), d = b.querySelector('.gpt-text');
    if (out) out.value = msg;
    if (d) { d.hidden = false; if (!ok) { d.open = true; out.focus(); out.select(); } }
  });
  if (IN_APP) location.href = 'hubapp://gpt?open=1'; else window.open('https://chatgpt.com/', 'hub-chatgpt');
  toast(ok ? (IN_APP ? L('貼る文をコピーしました。右の ChatGPT の入力欄を押して ⌘V → 送ってください') : L('貼る文をコピーしました。ChatGPT に貼って送ってください')) : L('コピーできませんでした。開いた「貼る文」を ⌘C でコピーして、ChatGPT に貼ってください'));
  return ok;
}
// ChatGPT に頼む（［ChatGPT に頼む］か、ChatGPT を選んで［送る］）。この時に初めて貼る文を作る。下の欄の依頼は「今回の依頼」として入れ、会話にも残す
async function gptAsk(p, t) {
  const selected=$('#chat-ai')?.value?.split('|')[0];
  if(state.windowsBrowser || selected === 'claude-chat') {
    const actor=webActor(selected)?selected:'chatgpt';
    if (!manualReady(actor)) throw Error(L('手動引き継ぎを利用できません。設定と状態を確認してください。'));
    if (chatImages(p.id,t.id).length || chatImageUploads.get(chatAttachmentKey(p.id,t.id))) throw Error(L('添付画像を外してから手動引き継ぎを準備してください。画像は Web サイトで選びます。'));
    return window.HubWebChat.open({actor,project:p.id,task:t.id,text:$('#chat-in')?.value||'',api,refresh:()=>load()});
  }
  const ta = $('#chat-in'), text = ta ? ta.value.trim() : '', key = p.id + '/' + t.id;
  try {
    const sending = gptSend(p.id, t.id, gptPrompt(p, t, text)); // 押した直後にコピーを始める
    if (ownerOf(t.owner).kind !== 'chatgpt') {
      try { localStorage.setItem('hub-gpt-prev-' + key, t.owner || ''); } catch (e) { /* 無視 */ } // 閉じた時に元の担当へ戻す
      await api('/api/task', { project: p.id, task: t.id, owner: 'chatgpt' });
    }
    if (text) await api('/api/chat/note', { project: p.id, task: t.id, text, to: 'chatgpt' }).catch(() => {});
    await sending;
    if (ta) ta.value = ''; chatDraft[chatAttachmentKey(p.id, t.id)] = '';
    await load();
  } catch (err) { toast(err.message); }
}
// アプリから：横の ChatGPT の中で［コピー］が押された。最後に頼んだ作業へ戻す用意をする
window.hubGptClip = text => {
  if (!gptLast || !text || !text.trim() || text === gptLast.copied) return;
  const [P, T] = [gptLast.key.slice(0, gptLast.key.indexOf('/')), gptLast.key.slice(gptLast.key.indexOf('/') + 1)];
  gptDraft[gptLast.key] = text;
  document.querySelectorAll(`.gptbox[data-p="${CSS.escape(P)}"][data-t="${CSS.escape(T)}"] .gpt-back`).forEach(x => { x.value = text; });
  let bar = $('#gpt-clip'); if (!bar) { bar = document.createElement('div'); bar.id = 'gpt-clip'; document.body.appendChild(bar); }
  const t = taskOf(proj(P), T);
  bar.dataset.p = P; bar.dataset.t = T;
  bar.innerHTML = UI`<b>ChatGPT の返事をコピーしました</b><span class="small">（${text.length} 文字・${esc(t ? t.title : T)}）</span><button class="btn sm" data-act="gptback" type="button">Hub に戻す</button><button class="btn sm" data-act="gptback" data-next="codex" type="button">戻して Codex に続けさせる</button><button class="btn plain sm" data-act="gptclipoff" type="button">閉じる</button>`;
};
const legacyGptBox = (p, t, show) => UI`<div class="gptbox" data-p="${esc(p.id)}" data-t="${esc(t.id)}"${show ? '' : ' hidden'}><b>ChatGPT</b><button class="btn plain sm gpt-close" data-act="gptclose" type="button" title="ChatGPT をやめて、元の AI に戻します">✕ 閉じる</button><span class="small">${IN_APP ? L('① 下の欄に依頼を書いて［ChatGPT に頼む］（ここで初めて貼る文を作ってコピー）→ 右の ChatGPT で ⌘V → 送る　② 返事の［コピー］を押すと、Hub が気づいて戻すボタンを出します') : L('① 貼る文をコピー → ChatGPT でモデルを選んで貼って送る　② 返事をコピーして下に貼る → ［Hub に戻す］')}</span><button class="btn sm" data-act="gptcopy" type="button">① ChatGPT に頼む（貼る文を作ってコピー${IN_APP ? L('・横に開く') : ''}）</button>${IN_APP ? UI`<a class="btn plain sm" href="hubapp://gpt?open=0">横の ChatGPT を閉じる</a>` : ''}
  <details class="gpt-text"${gptOut[p.id + '/' + t.id] ? '' : ' hidden'}${gptFail.has(p.id + '/' + t.id) ? ' open' : ''}><summary>貼る文を見る（自分でコピーする時）</summary><textarea class="gpt-out" rows="5" readonly>${esc(gptOut[p.id + '/' + t.id] || '')}</textarea></details>
  <textarea class="gpt-back" rows="3" placeholder="② ChatGPT の返事${IN_APP ? L('（横で［コピー］を押すと自動で入ります）') : L('をここに貼る')}">${esc(gptDraft[p.id + '/' + t.id] || '')}</textarea><button class="btn sm" data-act="gptback" type="button">Hub に戻す</button><button class="btn sm" data-act="gptback" data-next="codex" type="button" title="返事を会話に残し、担当を Codex に戻して、返事をもとに続きを頼みます">戻して Codex に続けさせる</button></div>`;
let sendWorkAnswer = null;
function workQuestionHtml(p, t) {
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  return t.question ? UI`<div class="wq ask-box"><div class="ask-head"><b>あなたへの質問：</b><span>${richText(t.question)}</span></div>
      <form class="ask-form" id="ask-form" ${k}><input type="text" name="answer" maxlength="2000" placeholder="答えや指示を書く（例：A で進めて）" aria-label="答え"><button class="btn sm" type="submit" title="この答えを、この作業の AI に指示として送ります。作業の続きがこの会話に残ります">この作業で AI に送る</button><button class="btn plain sm" data-act="answered" ${k} type="button" title="AI には送りません。この質問と返事待ちの表示だけを消します。AI は続きを始めません。">送らずに消す</button></form>
      <span class="small">答えを送ると、この作業の AI が続きをします。［送らずに消す］は AI には送りません。AI は続きを始めません。</span></div>` : '';
}
// 会話や入力欄を作り直さず、質問の変更だけを反映する。
function syncWorkQuestion() {
  const slot = $('#work-question'), p = proj(view.project), t = taskOf(p, view.task);
  if (view.kind !== 'work' || !slot || !t) return;
  const box = $('#msgs'), top = box?.scrollTop;
  if (slot.dataset.question !== (t.question || '')) {
    slot.dataset.question = t.question || ''; slot.innerHTML = workQuestionHtml(p,t);
  }
  const badge = $('.whead .pill');
  if (badge) { badge.className = `pill s-${t.state}`; badge.textContent = L(t.state); }
  const select = $('.wfoot [data-act="state"]'); if (select) select.value = t.state;
  if (box) box.scrollTop = top;
  updateWorkAnswerControls();
}
function updateWorkAnswerControls() {
  if (view.kind !== 'work') return;
  const pending = chatSending.has(chatAttachmentKey(view.project, view.task));
  $('#ask-form')?.querySelectorAll('button, input').forEach(el => { el.disabled = pending; });
  if ($('#msgs')) refreshAsks($('#msgs'));
  document.querySelectorAll('.ask').forEach(updateAskControls);
}
async function acceptedWorkAnswer(p, t, question, result, askKey) {
  // API の受付結果と、今の質問の両方を照合する。別の質問は消さない。
  if (!question) return;
  ++stateLoadEpoch; // 送信前の定期取得と、早い busy 通知の取り直しを無効にする。
  const current = taskOf(proj(p.id), t.id);
  const matched = result.answeredQuestion === question && current && (current.question === question || !current.question);
  if (matched) { current.question = ''; current.state = '実行中'; }
  if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id) return;
  if (matched && askKey) document.querySelectorAll('.ask').forEach(a => {
    if (a.dataset.askKey !== askKey) return;
    a.classList.add('answered', 'done'); askDrafts.delete(askKey);
    a.querySelector('.ask-status').textContent = result.queued ? L('回答を受け付けました。AI の開始待ちです。') : L('回答を送信しました。');
  });
  syncWorkQuestion(); updateTurnCounts(); renderTree(); window.HubMobile?.badges();
  if (matched && result.queued && !current?.question) {
    const slot = $('#work-question');
    if (slot) slot.innerHTML = UI`<div class="wq" role="status">回答を受け付けました。今の作業が終わったら、この回答で AI が続けます。</div>`;
  }
  try { await load({ preserveMain: true }); } catch (err) { toast(L('回答は受け付けました。表示の再取得に失敗しました：') + err.message); }
}

const workDetailsOpen = new Set();
function renderWork() {
  const scrollKey = JSON.stringify([view.project,view.task]);
  const savedScroll = window.HubChatScroll?.capture($('#msgs'),scrollKey);
  const p = proj(view.project), t = taskOf(p, view.task);
  if (!p || !t) { view.kind = 'project'; return render(); }
  const running = AIS.filter(a => live(p.id, t.id, a));
  const main = aiOf(t.owner);
  const shown = running.length ? running : [];
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"`;
  const mode = workMode();
  const modeSeg = UI`<div class="seg" role="group" aria-label="画面の切り替え">
      <button class="${mode === 'chat' ? 'on' : ''}" data-act="mode" data-m="chat" type="button" title="1本の会話で、答える AI を選んで話す">会話</button>
      <button class="${mode === 'term' ? 'on' : ''}" data-act="mode" data-m="term" type="button" title="AI の画面をそのまま動かす">ターミナル${running.length ? `（${running.length}）` : ''}</button></div>`;
  const startBtns = mode === 'chat' ? '' : AIS.filter(a => !running.includes(a)).map(a =>
    UI`<button class="btn ${a}${a === main || running.length ? '' : ' sub'}" data-act="start" data-ai="${a}" ${k} type="button" ${!cliTerminalReady(a) ? 'disabled' : ''}>${running.length ? '＋ ' : ''}${AI_LABEL[a]}${running.length ? L('も並べる') : L('で始める')}</button>`).join('');
  $('#main').innerHTML = UI`<div class="work">
    <div class="whead">
      <button class="back" data-go="project" data-p="${esc(p.id)}" type="button">← ${esc(p.name)}</button>
      <h2>${esc(t.title)}</h2><span class="pill s-${esc(t.state)}">${esc(L(t.state))}</span>
      ${(t.gitReadState||p.gitReadState)==='unknown'?UI`<span class="small" role="status">${esc(t.gitReadError||p.gitReadError||'Git 狀態未知')}</span>`:''}
      ${t.role ? UI`<span class="small wrole">${esc(roleLabel(t.role))}</span>` : ''}
      ${modeSeg}<span class="sp"></span>${startBtns}
      ${t.mergeRecovery && !t.copy ? UI`<span class="small">合併交易：${esc(t.mergeRecovery.state)}</span><button class="btn plain" data-act="merge" ${k} type="button">恢復合併</button>` : ''}
      ${t.copyMissing && !t.mergeRecovery ? UI`<span class="small" title="作業ファイルには作業用コピーの場所が書いてありますが、その場所がありません（取り込み済みの可能性）">作業用コピーが見つかりません</span><button class="btn plain" data-act="copyclear" ${k} type="button" title="作業ファイルの古い記録を片付けます。変更が本体に入っていれば、続きは本体で始められます">記録を片付ける</button>` : ''}
      ${t.copy ? (t.mergeExcluded
        ? UI`<span class="small">取り込み対象外（コピー保管中）</span><button class="btn plain" data-act="mergeinclude" ${k} type="button">取り込み対象に戻す</button>`
        : !ProjectOrder.integrators(p,t,state.projects).length ? UI`<button class="btn plain" data-act="merge" ${k} type="button" ${(t.gitReadState||p.gitReadState)==='unknown'?'disabled':''} title="この作業の作業用コピーを本体に取り込み、作業用コピーはゴミ箱へ移します">本体に取り込む</button><button class="btn plain" data-act="mergeexclude" ${k} type="button" title="本体には取り込まず、作業用コピーと再開先を残します">取り込み対象から外す</button>` : '') : ''}
      ${githubUrl(p, t) ? UI`<button class="btn plain" data-url="${esc(githubUrl(p, t))}" type="button" title="GitHub で開く（${esc(githubUrl(p, t))}）">GitHub</button>` : ''}${taskTarget(p,t) && ProjectOrder.finished(t) && !t.question ? transferButton(p.id,t.id,t.title,L('成果を渡す'),'handup','btn plain wfiles') : ''}<button class="btn plain wfiles" data-act="files" type="button">ファイルを見る</button>
    </div>
    <div id="workspace-lifecycle">${workspaceLifecycleHtml(p,t)}</div>
    ${taskTarget(p,t) && transferNeedsUpdate() ? UI`<div class="wq"><p class="transfer-hint">${esc(transferUpdateMessage())}</p></div>` : ''}
    ${bgOf(p.id, t.id).length || (!t.parent && bgOf(p.id).filter(x => !x.task).length) ? UI`<div class="wq bg-note"><b>裏で作業中：</b><span>${esc(bgText(bgOf(p.id, t.id).length ? bgOf(p.id, t.id) : bgOf(p.id).filter(x => !x.task)))}</span><span class="small">Hub を通さずに起動された AI です。終わると「新」が付きます。次からは「渡す」（Hub 経由）を使うよう AI に伝えてあります</span></div>` : ''}
    <div id="work-question" data-question="${esc(t.question || '')}">${workQuestionHtml(p,t)}</div>
    <div class="work-meta">${taskContext(p, t, isPhone())}<div class="wdone">${completionButtons(p, t)}</div></div>${kidsDoneBar(p, t)}
    ${mode === 'chat' ? chatHtml(p, t) : UI`<div class="panes ${shown.length >= 2 ? 'two' : ''}" id="panes">
      ${shown.length ? shown.map(a => UI`<section class="pane" data-ai="${a}">
          <div class="phead"><span class="who w-${AI_KEY[a]}">${AI_LABEL[a]}</span><span class="pstat" data-ai="${a}">${statusText(sessOf(p.id, t.id, a))}</span>${specSelect(p, t, a, true)}<span class="sp"></span>
            ${AIS.filter(other => other !== a).map(other => UI`<button class="btn plain sm" data-act="handoff" data-from="${a}" data-to="${other}" ${k} type="button" ${!cliTerminalReady(other) ? 'disabled' : ''} title="${a === 'agy' ? L('画面に残っている分だけを') : L('今までの会話を')}引き継ぎ資料にまとめて渡します">${AI_LABEL[other]}に交代 →</button>`).join('')}
            ${state.windowsBrowser ? UI`<span class="small" id="view-state-${a}"></span><button class="btn plain sm" data-act="termclaim" data-ai="${a}" ${k} type="button">接管輸入</button><button class="btn plain sm" data-act="termwindow" data-ai="${a}" ${k} type="button">獨立終端機視窗（Hub）</button>` : ''}
            <button class="btn plain sm" data-act="stop" data-ai="${a}" ${k} type="button">${L('止める')}</button></div>
          <div class="pbody" id="pane-${a}"></div></section>`).join('')
        : UI`<div class="pane"><div class="pempty">${state.windowsBrowser && webActor(ownerOf(t.owner).kind)
            ? L('この作業は手動引き継ぎです。上の Web Chat ボタンでプレビューと確認を行い、Web サイトに自分で貼って送信してください。')
            : ownerOf(t.owner).kind === 'chatgpt'
            ? UI`この作業は ChatGPT に頼んでいます。上の［① 貼る文をコピー］を押して ChatGPT アプリに貼り、返事を「② 返事を貼る」欄に貼って［Hub に戻す］を押してください。<br>ここで Claude Code・Codex・Agy CLI に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'agent'
            ? UI`この作業は ${esc(ownerOf(t.owner).name)}（Discord）に頼んでいます${t.via ? `（${esc(t.via)}）` : ''}。<br>報告を受けたら、下の「手順」に印を付けてください。全部付いたら、完了に移すか確認してください。<br>ここで Claude Code・Codex・Agy CLI に手伝わせることもできます。`
            : ownerOf(t.owner).kind === 'you' ? UI`この作業は、あなたの担当です。<br>終わったら、下の「手順」に印を付けるか、状態を「完了」にしてください。`
            : state.terminal
            ? UI`まだ AI は動いていません。<br>上の「${AI_LABEL[main]}で始める」を押すと、ここで作業が始まります。<br>ファイルやスクショは、この画面に落とす（または ⌘V で貼る）と AI に渡せます。<br>${esc(t.next ? L('次にやること：') + t.next.split('\n')[0] : '')}`
            : UI`作業画面の部品が未設定です。［設定］をご覧ください。<br>それまでは、始めると別の窓で開きます。`}</div></div>`}
    </div>`}
    <details class="work-details" ${workDetailsOpen.has(scrollKey)?'open':''}><summary>作業設定、記事與網頁交接</summary>
    ${mode === 'chat' || state.windowsBrowser && webActor(ownerOf(t.owner).kind) ? gptBox(p, t, webActor(chatPick(p, t).ai)) : ''}
    <div class="wfoot">
      <select data-act="state" ${k} aria-label="状態">${!STATES.includes(t.state) ? UI`<option selected disabled value="${esc(t.state)}">${esc(t.state)}</option>` : ''}${STATES.map(s => UI`<option value="${esc(s)}" ${s === t.state ? 'selected' : ''}>${esc(L(s))}</option>`).join('')}</select>
      ${mode === 'term' && CLI(t.owner) && !shown.length ? specSelect(p, t, main) : ''}
      ${p.phases.length ? UI`<select data-act="phase" ${k} aria-label="フェーズ" title="この作業のフェーズ"><option value="">フェーズ：今のフェーズ</option>${p.phases.map(ph => UI`<option value="${esc(ph.name)}" ${t.phase === ph.name ? 'selected' : ''}>${esc(L(ph.name))}</option>`).join('')}</select>` : ''}
      <details class="more steps" ${stepsOpen ? 'open' : ''}><summary>手順 ${t.steps.length ? `${progressOf(t).done} / ${t.steps.length}` : L('（なし）')}</summary><div class="step-tools"><button class="btn plain sm" data-steps-close type="button">手順を閉じる</button></div><div class="stepbox">${t.steps.map((x, i) => UI`<label><input type="checkbox" data-act="step" data-i="${i}" ${k} ${x.done ? 'checked' : ''}> ${esc(x.text)}</label>`).join('')}
        <form class="addstep" data-p="${esc(p.id)}" data-t="${esc(t.id)}"><input name="step" maxlength="120" placeholder="手順を足す（例：下書き）" aria-label="手順を足す"><button class="btn plain sm" type="submit">足す</button></form></div></details>
      <label class="small">種類<select data-act="kind" ${k}><option value="main" ${t.kind!=='derived'?'selected':''}>本作業</option><option value="derived" ${t.kind==='derived'?'selected':''}>派生</option></select></label>
      <label class="small">派生元<select data-act="derivedFrom" ${k}><option value="">（なし）</option>${sourceOptions(p,t)}</select></label>
      <label class="small">場所<select data-act="workspaceMode" ${k} ${t.workspaceStarted || t.state!=='未着手' || t.workdir || live(p.id,t.id) ? 'disabled' : ''}><option value="isolated" ${t.workspaceMode!=='direct'?'selected':''}>作業用コピー</option><option value="direct" ${t.workspaceMode==='direct'?'selected':''}>本体（合体不要）</option></select></label>
      <input id="memo" maxlength="300" placeholder="メモ（例：デザイン案Aに決めた）" aria-label="メモ">
      <button class="btn plain sm" data-act="memo" ${k} type="button">メモを残す</button>
      ${t.skills.length ? UI`<details class="more"><summary>使ったスキル（${t.skills.length}）</summary><ul class="skills">${t.skills.map(s => UI`<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}
    </div></details></div>`;
  closePanes();
  const workDetails = $('.work-details');
  workDetails?.addEventListener('toggle', () => { if (workDetails.open) workDetailsOpen.add(scrollKey); else workDetailsOpen.delete(scrollKey); });
  window.HubMobile?.mount(scrollKey);
  if (mode === 'chat') openChat(p, t, savedScroll); else shown.forEach(a => attach(p.id, t.id, a));
  if (t.copy && !t.mergeExcluded) loadPreview(p.id, t.id);
}

// ---- 会話画面（Goose のような形）：1本の会話で、送るたびに答える AI とモデルを選ぶ ----
let chatES = null, chatDraft = {}, chatBusy = null;
const chatAttachments = new Map();
const chatImageUploads = new Map();
const chatSending = new Set();
const chatAttachmentKey = (project, task) => JSON.stringify([project, task]);
function chatImages(project, task) {
  const key = chatAttachmentKey(project, task);
  if (!chatAttachments.has(key)) chatAttachments.set(key, []);
  return chatAttachments.get(key);
}
function chatImagesHtml(project, task) {
  return chatImages(project, task).map(x => UI`<span class="quick-image"><img src="${esc(x.url)}" alt="${esc(x.name)}"><button type="button" data-chat-remove="${esc(x.id)}" aria-label="${esc(x.name)}を取り消す">×</button><small title="${esc(x.name)}">${esc(x.name)}</small></span>`).join('');
}
function drawChatImages(project, task) {
  if (view.kind !== 'work' || view.project !== project || view.task !== task || workMode() !== 'chat') return;
  const box = $('#chat-images');
  if (box) { box.innerHTML = chatImagesHtml(project, task); box.hidden = !chatImages(project, task).length; }
  const status = $('#chat-image-state');
  if (status) status.hidden = !chatImageUploads.get(chatAttachmentKey(project, task));
  window.HubMobile?.draft();
}
async function addChatImage(project, task, file, native = false) {
  const key = chatAttachmentKey(project, task);
  chatImageUploads.set(key, (chatImageUploads.get(key) || 0) + 1);
  drawChatImages(project, task);
  try {
    let image;
    if (native) image = await api('/api/start/image-path', { project, path: file });
    else {
      const name = file.name || `screenshot-${Date.now()}.png`;
      if(window.HubNativeRestart?.paused)throw Error('重新啟動期間已暫停上傳。');
      const r = await fetch('/api/start/image?' + new URLSearchParams({ project, name }), { method: 'POST', headers: { 'X-Hub': '1' }, body: file });
      image = await r.json();
      if (!r.ok) throw Error(image.error || L('画像を追加できませんでした'));
    }
    chatImages(project, task).push(image);
  } finally {
    chatImageUploads.set(key, chatImageUploads.get(key) - 1);
    drawChatImages(project, task);
  }
}
function removeChatImage(project, task, id) {
  const images = chatImages(project, task), i = images.findIndex(x => x.id === id);
  if (i >= 0) images.splice(i, 1);
  drawChatImages(project, task);
}
function chatSendText(text, images) {
  return images.length ? (text.trim() || '添付画像を確認してください。') + '\n\n参照画像（絶対パス）：\n' + images.map(x => x.path).join('\n') : text.trim();
}
function clearSentChatImages(project, task, sent) {
  const ids = new Set(sent.map(x => x.id));
  chatAttachments.set(chatAttachmentKey(project, task), chatImages(project, task).filter(x => !ids.has(x.id)));
  drawChatImages(project, task);
}
const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width:900px)').matches;
// 表示用の文字だけを短縮する。選択値やCLIに渡すモデル名には使わない。
function shortModelLabel(ai, model) {
  if (ai === 'chatgpt') return 'ChatGPT';
  if (ai === 'claude-chat') return AI_LABEL[ai];
  if (ai === 'codex') return String(model).replace(/^GPT-/, '');
  if (ai === 'agy') return String(model).replace(/\s*[（(][^）)]*[）)]\s*$/, '');
  return String(model);
}
function phoneModelLabel(ai, model, full, suffix = '') {
  if (state.windowsBrowser && (webActor(ai) || model === 'unavailable')) return full;
  const phone = state.phoneLabels, key = `${AI_KEY[ai] || ai}|${webActor(ai)?'app':model}`;
  return phone?.labels === 'full' ? full : (phone?.names?.[key] || shortModelLabel(ai, model)) + suffix;
}
function chatModelOption(ai, model, full, attrs = '', suffix = '') {
  const short = phoneModelLabel(ai, model, full, suffix);
  return UI`<option value="${ai}|${esc(model)}" data-full="${esc(full)}" data-short="${esc(short)}" data-phone-suffix="${esc(suffix)}" ${attrs}>${esc(isPhone() ? short : full)}</option>`;
}
function syncChatPhoneLabels() {
  for (const option of ($('#chat-ai')?.options || [])) {
    if (option.dataset.full === undefined) continue;
    const [ai, model] = option.value.split('|');
    option.dataset.short = phoneModelLabel(ai, model, option.dataset.full, option.dataset.phoneSuffix || '');
    option.textContent = isPhone() ? option.dataset.short : option.dataset.full;
  }
}
function workMode() { try { return localStorage.getItem('hub-mode') === 'term' ? 'term' : 'chat'; } catch (e) { return 'chat'; } }
function setMode(m) { try { localStorage.setItem('hub-mode', m); } catch (e) { /* 無視 */ } render(); }
const EMPTY_CHAT = () => state.windowsBrowser ? UI`<div class="chat-empty"><span class="empty-kicker">PROJECT HUB</span><h3>明確な依頼から始めましょう</h3><p>AI を選び、やりたいことを書いてください。<br>Codex はここで実行できます。Web AI は手動引き継ぎを開きます。</p></div>` : UI`<p class="chat-empty">ここで AI と話します。<br>下で答える AI とモデルを選び、依頼を書いて送ってください（⌘ + Enter でも送れます）。<br>途中で AI を変えると、それまでの会話を自動で引き継ぎます。ファイルやスクショは、ここに落とすか ⌘V で貼れます。</p>`;
// 選ぶ欄に出すモデル（設定で隠したものは出さない。ただし今選んでいるものは残す）
function orderedModels() { return ModelOrder.ordered(state.roles.models, state.modelOrder); }
function shownModels(key, ...keep) {
  const hidden = (state.hiddenModels || {})[key] || [];
  return orderedModels().filter(id => id.startsWith(key + '|')).map(id => id.slice(key.length + 1)).filter(m => !hidden.includes(m) || keep.includes(m));
}
function chatActionLabel(ai) {
  return state.windowsBrowser ? webActor(ai) ? L('準備手動交接') : L('交由') + ' ' + AI_LABEL[ai] + ' ' + L('執行') : L('送る');
}
function chatRouteHint(ai) {
  return state.windowsBrowser && webActor(ai) ? L('先預覽與確認內容，再自行到網站貼上送出。') : L('選擇 AI 與模型，確認需求後送出。');
}
function chatHtml(p, t) {
  const pick = chatPick(p, t);
  // 名前が未設定のモデルは、CLI の既定のモデルで動く（設定画面で名前を入れられる）
  const flag = (a, m) => ((state.cliFlags || {})[a] || {})[m];
  if (!webActor(pick.ai) && pick.model && !(state.roles.models[AI_KEY[pick.ai]] || []).includes(pick.model)) { // 作業ファイルに本当の名前で書かれていた時
    const hit = Object.entries((state.cliFlags || {})[pick.ai] || {}).find(([, id]) => id === pick.model);
    if (hit) pick.model = hit[0];
  }
  const available = webActor(pick.ai) || (state.roles.models[AI_KEY[pick.ai]] || []).includes(pick.model);
  const unavailable = L('（利用できません。選び直してください）');
  const old = pick.model && !available ? chatModelOption(pick.ai, pick.model, UI`${AI_LABEL[pick.ai]}・${pick.model}${unavailable}`, 'selected disabled', unavailable) : '';
  const gptOpt = state.windowsBrowser ? ['chatgpt','claude-chat'].map(actor=>chatModelOption(actor,'web-manual',AI_LABEL[actor]+' · '+L('手動引き継ぎ'),`${pick.ai===actor?'selected':''} ${manualReady(actor)?'':'disabled'}`)).join('') : chatModelOption('chatgpt', 'app', L('ChatGPT（アプリで作業。送ると貼る文をコピー）'), pick.ai === 'chatgpt' ? 'selected' : '');
  const modelOpts = orderedModels().filter(id => { const [key, m] = id.split('|'); const a = key === 'claude-code' ? 'claude' : key; return shownModels(key, pick.ai === a ? pick.model : '').includes(m); }).map(id => {
    const [key, m] = id.split('|'), a = key === 'claude-code' ? 'claude' : key;
    const suffix = flag(a, m) === '' ? '（既定）' : '';
    return chatModelOption(a, m, UI`${AI_LABEL[a]}・${m}${suffix}`, `${!cliReady(a) ? 'disabled' : ''} ${pick.ai === a && pick.model === m ? 'selected' : ''}`, suffix);
  }).join('');
  const blockedOpts = ['claude','agy','grok'].filter(actor=>!actorReady(actor)).map(actor=>chatModelOption(actor,'unavailable',AI_LABEL[actor]+' · '+L('まだ利用できません'),'disabled')).join('');
  const opts = old + (state.windowsBrowser ? `<optgroup label="${esc(L('本機執行'))}">${modelOpts}</optgroup><optgroup label="${esc(L('網頁手動交接'))}">${gptOpt}</optgroup><optgroup label="${esc(L('尚未就緒'))}">${blockedOpts}</optgroup>` : modelOpts + gptOpt);
  return UI`<div class="chat" data-p="${esc(p.id)}" data-t="${esc(t.id)}">
    <section id="chat-approvals" class="chat-approvals" aria-label="待處理授權" hidden></section>
    <div class="msgs" id="msgs">${EMPTY_CHAT()}</div>
    <button class="chat-latest btn plain sm" id="chat-latest" type="button" hidden>↓ 最新へ</button>
    <form class="composer" id="composer">
      <div class="queue" id="chat-queue" hidden></div>
      <div class="quick-images" id="chat-images" aria-label="添付画像" ${chatImages(p.id, t.id).length ? '' : 'hidden'}>${chatImagesHtml(p.id, t.id)}</div>
      <span class="small" id="chat-image-state" role="status" ${chatImageUploads.get(chatAttachmentKey(p.id, t.id)) ? '' : 'hidden'}>画像を追加中…</span>
      <label class="composer-label" for="chat-in">此次需求</label>
      <textarea id="chat-in" rows="2" maxlength="100000" placeholder="依頼を書く（例：このスクショの崩れを直して）" aria-label="依頼">${esc(chatDraft[chatAttachmentKey(p.id, t.id)] || '')}</textarea>
      <div class="crow">
        <select id="chat-ai" aria-label="答える AI とモデル" aria-describedby="chat-route-hint">${opts}</select>
        <select id="chat-effort" aria-label="思考" ${webActor(pick.ai)?'hidden':''} ${pick.ai === 'agy' || webActor(pick.ai) ? 'disabled' : ''}>${(webActor(pick.ai) ? [] : pick.ai === 'agy' ? ['高'] : state.efforts).map(e => UI`<option ${(pick.ai === 'agy' ? '高' : pick.effort) === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>
        <span class="small" id="chat-state"></span><span class="sp"></span>
        <button class="btn" id="chat-send" type="submit">${esc(chatActionLabel(pick.ai))}</button>
      </div>
      <p id="chat-route-hint" class="route-hint">${esc(chatRouteHint(pick.ai))}</p>
      <div class="crow busyrow" id="chat-busyrow" hidden>
        <span class="sp"></span>
        <button class="btn plain" id="chat-stop" type="button" title="今の作業を止めます（待っている指示も取り消します）">${L('止める')}</button>
        <button class="btn warn" id="chat-redo" type="button" hidden title="今の指示が間違いだった時。今の指示を取り消し、この指示でやり直します">① やり直し</button>
        <button class="btn" id="chat-amend" type="button" hidden title="今の指示に足りない所がある時。今の指示は続け、この指示も合わせて行います">② 追加指示</button>
        <button class="btn plain" id="chat-q" type="button" hidden title="別の作業を順番待ちにします。今の作業が終わったら自動で始めます（⌘ + Enter）">③ 次の作業</button>
      </div>
    </form></div>`;
}
// 最初に選んでおく AI：前回選んだもの → 作業の担当と役割の設定
function chatPick(p, t) {
  try { const v = JSON.parse(localStorage.getItem('hub-chat-' + p.id + '/' + t.id) || 'null'); if (v && v.ai) return v; } catch (e) { /* 無視 */ }
  if (webActor(ownerOf(t.owner).kind)) return { ai:ownerOf(t.owner).kind,model:'web-manual',effort:'' };
  const ai = aiOf(t.owner), sp = specOf(t, ai);
  return { ai, model: sp.model || (state.roles.models[AI_KEY[ai]] || [])[0], effort: sp.effort || '高' };
}
// 文の中の URL とファイルの場所を押せるようにする（URL＝ブラウザで開く・コピー、場所＝開き方を選ぶ）
const LINK_RE = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)|(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%()]+)|`([^`\n]+)`|((?:~\/|\/(?:Users|Volumes|private|tmp|opt|home)\/)[^\s<>"'`()（）「」『』【】\[\]、。，]+)|((?<![\p{L}\p{N}_\/.:@-])(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_@-]+\.[A-Za-z0-9]{1,6})(?![\p{L}\p{N}_\/])/gu;
const urlLink = (u, label) => UI`<a href="#" class="lk" data-url="${esc(u)}" title="ブラウザで開く">${esc(label || u)}</a><button type="button" class="cp" data-copy="${esc(u)}" title="コピー" aria-label="コピー">⧉</button>`;
const pathLink = (x, label) => UI`<a href="#" class="lk lp" data-path="${esc(x)}" title="ファイル・フォルダの開き方を選ぶ">${esc(label || x)}</a>`;
// URL の終わりの句読点や、対になっていない ) ] は URL に含めない
function trimUrl(u) {
  let x = u.replace(/[.,;:!?'*]+$/, '');
  for (;;) {
    const n = x.length;
    if (x.endsWith(')') && (x.match(/\(/g) || []).length < (x.match(/\)/g) || []).length) x = x.slice(0, -1);
    if (x.endsWith(']') && (x.match(/\[/g) || []).length < (x.match(/\]/g) || []).length) x = x.slice(0, -1);
    x = x.replace(/[.,;:!?'*]+$/, '');
    if (x.length === n) return x;
  }
}
const isPath = x => /^(~\/|\/)/.test(x) || (/\//.test(x) && !/\s{2,}/.test(x) && !/^[\/.]$/.test(x));
function linkify(text) {
  const s = String(text == null ? '' : text);
  let out = '', last = 0, m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(s))) {
    out += esc(s.slice(last, m.index));
    last = LINK_RE.lastIndex;
    if (m[1] !== undefined) { // [名前](URL または場所)
      const t = m[2].replace(/^<|>$/g, '').replace(/^file:\/\//, '');
      let dec = t; try { dec = decodeURI(t); } catch (e) { /* そのまま */ }
      out += /^https?:\/\//.test(t) ? urlLink(t, m[1]) : isPath(dec) ? pathLink(dec.replace(/#L?\d+(-L?\d+)?$/, ''), m[1]) : esc(m[0]);
    } else if (m[3]) { const u = trimUrl(m[3]); out += urlLink(u) + esc(m[3].slice(u.length)); LINK_RE.lastIndex = last = m.index + m[3].length; }
    else if (m[4] !== undefined) {
      const c = m[4].trim();
      out += /^https?:\/\//.test(c) ? '`' + urlLink(c) + '`' : isPath(c) ? '`' + pathLink(c) + '`' : esc(m[0]);
    }
    else { const raw = m[5] || m[6], x = raw.replace(/[.,;:!?]+$/, ''); out += pathLink(x) + esc(raw.slice(x.length)); }
  }
  return out + esc(s.slice(last));
}
// 囲みの中はリンクにせず、そのままコピーできる形にする。
function richText(text) {
  const lines=String(text??'').match(/[^\n]*\n|[^\n]+$/g)||[];
  let out='', plain='', code='', fence=0, lang='';
  for(const line of lines) {
    const raw=line.replace(/\r?\n$/, ''), start=raw.match(/^ {0,3}(`{3,})([^`]*)$/);
    if(!fence && start) {out+=tables(plain);plain='';fence=start[1].length;lang=start[2].trim().split(/\s+/)[0]||L('テキスト');code='';}
    else if(fence && new RegExp('^ {0,3}`{'+fence+',}\\s*$').test(raw)) {
      out+=block(code, false);fence=0;
    } else if(fence) code+=line; else plain+=line;
  }
  if(fence)out+=block(code,true);else out+=tables(plain);
  return out;
  function block(value,partial) {return UI`<div class="codeblock"><div class="cb-head"><span>${esc(lang)}${partial?L(' ・書きかけ'):''}</span>${partial?'': UI`<button type="button" class="cb-copy" aria-label="この囲みをコピー">⧉ コピー</button>`}</div><pre><code>${esc(value).replace(/\r/g,'&#13;')}</code></pre></div>`;}
  function cells(line) {
    const row=[''];let pipes=0,slashes=0;
    for(const ch of line.replace(/\r?\n$/, '')) {
      if(ch==='|') {
        if(slashes%2)row[row.length-1]=row[row.length-1].slice(0,-1)+'|';
        else {row.push('');pipes++;}
      } else row[row.length-1]+=ch;
      slashes=ch==='\\'?slashes+1:0;
    }
    if(!pipes)return null;
    if(!row[0].trim())row.shift();
    if(row.length && !row[row.length-1].trim())row.pop();
    return row.map(x=>x.trim());
  }
  function inline(value) {
    const tokens=/\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)\)|`([^`\n]+)`|\*\*([^\n]+?)\*\*/g;
    let html='',last=0,m;
    while((m=tokens.exec(value))) {
      html+=linkify(value.slice(last,m.index));
      html+=m[1]!==undefined?UI`<code class="rt-inline">${linkify(m[1])}</code>`:m[2]!==undefined?UI`<strong>${inline(m[2])}</strong>`:linkify(m[0]);
      last=tokens.lastIndex;
    }
    return html+linkify(value.slice(last));
  }
  function tables(value) {
    const rows=value.match(/[^\n]*\n|[^\n]+$/g)||[];
    let html='',pending='';
    for(let i=0;i<rows.length;i++) {
      const head=cells(rows[i]),sep=i+1<rows.length?cells(rows[i+1]):null;
      if(!head||!head.length||!sep||head.length!==sep.length||!sep.every(x=>/^:?-{2,}:?$/.test(x))) {pending+=rows[i];continue;}
      html+=linkify(pending);pending='';
      const align=sep.map(x=>x.startsWith(':')&&x.endsWith(':')?'center':x.endsWith(':')?'right':'left');
      const tr=(row,tag)=>'<tr>'+head.map((_,n)=>'<'+tag+(tag==='th'?' scope="col"':'')+' class="rt-'+align[n]+'">'+inline(row[n]??'')+'</'+tag+'>').join('')+'</tr>';
      html+='<div class="rt-table-wrap" tabindex="0" role="region" aria-label="'+esc(L('表（横にスクロールできます）'))+'"><table class="rt-table"><thead>'+tr(head,'th')+'</thead><tbody>';
      i++;
      while(i+1<rows.length) {
        const row=cells(rows[i+1]);
        if(!row||!row.length||row.length>head.length)break;
        html+=tr(row,'td');i++;
      }
      html+='</tbody></table></div>';
    }
    return html+linkify(pending);
  }
}
document.addEventListener('click', async e=>{
  const b=e.target.closest?.('.cb-copy');if(!b || b.disabled)return;
  b.disabled=true;
  const ok=await copyText(b.closest('.codeblock').querySelector('code').textContent,true);
  b.textContent=ok?L('✓ コピーしました'):L('コピーできませんでした。選んで ⌘C');
  setTimeout(()=>{b.textContent=L('⧉ コピー');b.disabled=false;},2000);
});
// コピーできたかを返す（できなかった時に「コピーしました」と言わない）
async function copyText(v, quiet) {
  let ok = false;
  try { await navigator.clipboard.writeText(v); ok = true; }
  catch (e) { const ta = document.createElement('textarea'); ta.value = v; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove(); }
  if (!quiet) toast(ok ? L('コピーしました') : L('コピーできませんでした。文を選んで ⌘C でコピーしてください'));
  return ok;
}
// 押した直後にコピーを始める（文はあとから届く）。アプリ（WebKit）は、押した後に時間がたつとコピーを断るため
async function copyLater(promise) {
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': promise.then(t => new Blob([t], { type: 'text/plain' })) })]);
      return true;
    }
  } catch (e) { /* 下で試す */ }
  try { return await copyText(await promise, true); } catch (e) { return false; }
}
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-url],[data-path],[data-copy]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.copy) copyText(el.dataset.copy);
  else if (el.dataset.url) api('/api/open-url', { url: el.dataset.url }).catch(err => toast(err.message));
  else showPath(el.dataset.path);
});
// 場所を押した時は開き方を選ぶ。元ファイルを開く・Finderで表示・フォルダの中身を見る。
const IN_APP = /ProjectHubApp/.test(navigator.userAgent);
const fsize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
async function openPath(p, how) {
  try {
    const r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how });
    if (r.byApp) location.href = `hubapp://reveal?dir=${r.dir ? 1 : 0}&open=${r.how === 'open' ? 1 : 0}&path=${encodeURIComponent(r.path)}`;
    toast(`${r.how === 'open' ? L('開きました') : L('Finder で開きました')}：${r.path.split('/').pop()}`);
  } catch (err) { toast(err.message); }
}
async function showPath(p, how = 'info') {
  let r;
  try { r = await api('/api/reveal', { project: view.project, task: view.task, path: p, app: IN_APP, how }); }
  catch (err) { toast(err.message); return; }
  let el = $('#fsheet');
  if (!el) { document.body.insertAdjacentHTML('beforeend', '<div class="fsheet" id="fsheet" role="dialog" aria-modal="true"></div>'); el = $('#fsheet'); }
  el.hidden = false;
  const head = UI`<div class="fs-head"><b>${r.dir ? '📁' : '📄'} ${esc(r.path.split('/').pop())}</b><span class="small fs-path">${esc(r.path)}</span></div>`;
  if (!r.entries) {
    el.innerHTML = UI`<div class="fs-box">${head}<p class="note fs-list">${r.dir ? L('フォルダの開き方を選んでください。') : L('コピーを作らず、元のファイルを既定のアプリで開けます。')}</p>
      <div class="acts fs-acts">${r.dir ? UI`<button type="button" class="btn" data-fs-finder="${esc(r.path)}">Finderで開く</button><button type="button" class="btn plain" data-fs-list="${esc(r.path)}">中身を見る</button>` : UI`<button type="button" class="btn" data-fs-open="${esc(r.path)}">元のファイルを開く</button><button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finderで表示</button>`}
      <button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn plain" data-fs-close>閉じる</button></div></div>`;
    return;
  }
  el.innerHTML = UI`<div class="fs-box">${head}
    <div class="fs-list">${r.parent ? UI`<button type="button" class="fs-row" data-fs-list="${esc(r.parent)}">↩︎ 上のフォルダへ</button>` : ''}
    ${r.entries.length ? r.entries.map(x => UI`<button type="button" class="fs-row" ${x.dir ? `data-fs-dir="${esc(x.path)}"` : `data-fs-file="${esc(x.path)}"`}><span>${x.dir ? '📁' : '📄'} ${esc(x.name)}</span><span class="small">${x.dir ? '' : fsize(x.size)}</span></button>`).join('') : UI`<p class="note">空のフォルダです</p>`}</div>
    <div class="acts fs-acts"><button type="button" class="btn plain" data-fs-finder="${esc(r.path)}">Finder で開く</button><button type="button" class="btn plain" data-fs-copy="${esc(r.path)}">場所をコピー</button><span class="sp"></span><button type="button" class="btn" data-fs-close>閉じる</button></div></div>`;
}
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('[data-fs-dir],[data-fs-file],[data-fs-open],[data-fs-list],[data-fs-finder],[data-fs-copy],[data-fs-close],.fsheet');
  if (!t) return;
  const d = t.dataset;
  if (d.fsDir || d.fsFile) await showPath(d.fsDir || d.fsFile);
  else if (d.fsList) await showPath(d.fsList, 'list');
  else if (d.fsOpen || d.fsFinder) await openPath(d.fsOpen || d.fsFinder, d.fsOpen ? 'open' : 'finder');
  else if (d.fsCopy) copyText(d.fsCopy);
  else if (d.fsClose !== undefined || t.classList.contains('fsheet') && e.target === t) $('#fsheet').hidden = true;
});
// コマンドなどの細かい作業を会話に出すか（設定画面で変える。最初は出さない）
const showDetail = () => { try { return localStorage.getItem('hub-detail') === '1'; } catch (e) { return false; } };
// Enter だけで送るか（設定。最初は ⌘ + Enter）。Shift + Enter はいつも改行
const enterSends = () => { try { return localStorage.getItem('hub-enter') === '1'; } catch (e) { return false; } };
const isSendKey = e => e.key === 'Enter' && !e.isComposing && ((e.metaKey || e.ctrlKey) || (enterSends() && !e.shiftKey && !e.altKey));
const isToolRow = r => r.tool || !/やり直/.test(r.text || ''); // 前の記録には印が無いため、やり直しの知らせ以外は細かい作業とみなす
function msgHtml(r) {
  const time = r.at ? new Date(r.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
  if (r.role === 'event') return isToolRow(r) && !showDetail() ? '' : UI`<div class="ev">▸ ${esc(r.text)}</div>`;
  if (r.role === 'user' && (r.from === 'delegate' || r.from === 'child' || r.from === 'subtask')) {
    // 過去の結果通知でも、実際の成果を確認する共通引渡しへ進む。
    const childProject = proj(r.childProject || view.project);
    const candidate = r.child && r.from !== 'child' && taskOf(childProject, r.child);
    const receiver = candidate && taskTarget(childProject,candidate);
    const recordedTitle = typeof r.childTitle === 'string' ? r.childTitle : /^（子作業「(.+)」の結果）(?:\r?\n|$)/.exec(r.text || '')?.[1];
    const mismatch = candidate && recordedTitle !== undefined && recordedTitle !== candidate.title;
    const kid = !mismatch && !r.handoff && receiver?.project.id === view.project && receiver.task.id === view.task ? candidate : null;
    const absorb = kid ? transferButton(childProject.id,kid.id,recordedTitle ?? kid.title,r.offer?'統合…':L('成果を受け取る')) : '';
    const note = r.handoff ? (r.integrating ? L('この成果はもう受け取っています。統合や片付けが残っている場合は上部の［統合の続きを行う］から進めてください。') : L('この成果はもう受け取っています。片付けが残っている場合は上部の［引渡しの残りを続ける］から進めてください。'))
      : mismatch ? L('この結果の子作業は今はありません（同じ番号の別の作業があります）。')
      : r.child && r.from !== 'child' && !candidate ? L('この子作業は今はありません。受け取った成果は本作業の会話と［ファイルを見る］で確認できます。')
      : kid && transferNeedsUpdate() ? transferUpdateMessage() : '';
    return UI`<div class="m ai"><div class="mh"><span class="chip"><span class="ic">↩</span>${r.from === 'delegate' ? L('渡した作業の結果') : r.from === 'subtask' ? L('子作業の結果') : L('子プロジェクトの結果')}${r.ai ? UI`<small>・${esc(AI_LABEL[r.ai] || r.ai)}</small>` : ''}</span><span class="small">${time}</span>${absorb}</div>${note ? UI`<p class="transfer-hint">${esc(note)}</p>` : ''}<div class="mb">${richText(r.text)}</div></div>`;
  }
  if (r.role === 'user') return UI`<div class="m me"><div class="mh">${r.mode === 'redo' || r.mode === 'interrupt' ? UI`<span class="tagm int">やり直し</span>` : r.mode === 'amend' ? '<span class="tagm am">追加指示</span>' : r.mode === 'queued' ? UI`<span class="tagm">順番待ちの指示</span>` : ''}<span class="small">${time}・${esc(AI_LABEL[r.to] || '')}${r.model ? L('・') + esc(r.model) : ''} へ</span></div><div class="mb">${richText(r.text)}</div></div>`;
  return UI`<div class="m ai"><div class="mh"><span class="chip k-${esc(r.ai)}"><span class="ic">${AI_ICON[r.ai] || '?'}</span>${esc(AI_LABEL[r.ai] || r.ai)}${r.model ? UI`<small>・${esc(r.model)}${r.effort ? L('・') + esc(r.effort) : ''}</small>` : ''}</span><span class="small">${time}</span>${r.webHandoff?.transport==='web-manual' ? UI`<span class="small web-unattested">ユーザー貼り付け／出所未検証</span>` : r.error ? UI`<span class="done bad">⚠ 止まりました</span>` : UI`<span class="done">✓ 完了${r.ms ? '（' + dur(r.ms) + '）' : ''}</span>`}${r.text ? UI`<button type="button" class="cp cp-msg" data-copy="${esc(r.text)}" title="この返事をコピー">⧉ コピー</button>` : ''}</div>
    ${r.text ? UI`<div class="mb">${richText(r.text)}</div>` : ''}${r.asks && r.asks.length ? askHtml(r.asks) : ''}${r.error ? UI`<div class="merr">${esc(r.error)}</div>` : ''}</div>`;
}
// 質問ごとに選択と自由入力を保持し、最後にまとめて送る。
const askDrafts = new Map();
const askPending = new Set();
// 起動前の user/error 行でも、受付に失敗した質問は再送できるようにする。
// 作業・原文・回答欄を限定し、新質問や受付済みの欄には引き継がない。
const askAttempts = new Map();
const cleanOpt = o => o.replace(/[（(]おすすめ[）)]/g, '').trim();
function askHtml(asks) {
  const key = JSON.stringify([view.project, view.task, asks]);
  const saved = askDrafts.get(key) || [];
  return UI`<div class="ask${askPending.has(key) ? ' pending' : ''}" data-ask-key="${esc(key)}">${asks.map((a, i) => {
    const d = saved[i] || { selected: [], free: '' };
    return UI`<div class="ask-q" data-i="${i}" data-multi="${a.multi ? 1 : 0}" data-q="${esc(a.question)}">
      <div class="ask-t">❓ ${richText(a.question || L('選んでください'))}</div>
      <div class="ask-opts">${a.options.map(o => UI`<button type="button" class="ask-o${d.selected.includes(o) ? ' on' : ''}" data-ask="${esc(o)}" aria-pressed="${d.selected.includes(o)}">${esc(o)}</button>`).join('')}</div>
      <label class="ask-free-label">ほかの回答・補足<textarea class="ask-free" rows="2" placeholder="選択肢にない回答を書けます。選んだ回答への補足もできます。">${esc(d.free)}</textarea></label></div>`;
  }).join('')}
    <div class="ask-foot"><span class="small">質問ごとに選ぶか入力して、まとめて［選んで送る］を押してください。</span><button type="button" class="btn sm ask-send">選んで送る</button></div><div class="ask-status small" role="status"></div></div>`;
}
function askValues(ask) {
  return [...ask.querySelectorAll('.ask-q')].map(q => ({ question: q.dataset.q,
    selected: [...q.querySelectorAll('.ask-o.on')].map(b => b.dataset.ask), free: q.querySelector('.ask-free').value }));
}
function askAnswer(values) {
  return values.map(v => {
    const selected = v.selected.map(cleanOpt).join('、'), free = v.free.trim();
    const answer = selected && free ? `${selected}\n自由入力：${free}` : selected || free;
    return values.length > 1 ? `${v.question}：${answer}` : answer;
  }).join('\n\n');
}
function updateAskControls(ask) {
  const disabled = ask.classList.contains('done') || askPending.has(ask.dataset.askKey) || (typeof chatSending !== 'undefined' && chatSending.has(JSON.stringify(JSON.parse(ask.dataset.askKey).slice(0,2))));
  ask.querySelectorAll('button, textarea').forEach(el => { el.disabled = disabled; });
  ask.querySelector('.ask-send').textContent = askPending.has(ask.dataset.askKey) ? L('送っています…') : L('選んで送る');
}
function bindAskAnswers(box, send) {
  box.addEventListener('input', e => {
    const ask = e.target.closest('.ask');
    if (!ask || !e.target.matches('.ask-free') || ask.classList.contains('done') || askPending.has(ask.dataset.askKey)) return;
    askDrafts.set(ask.dataset.askKey, askValues(ask)); ask.querySelector('.ask-status').textContent = '';
  });
  box.addEventListener('click', async e => {
    const ask = e.target.closest('.ask');
    if (!ask || ask.classList.contains('done') || askPending.has(ask.dataset.askKey)) return;
    const opt = e.target.closest('.ask-o');
    if (opt) {
      const q = opt.closest('.ask-q'), wasOn = opt.classList.contains('on');
      if (q.dataset.multi !== '1') q.querySelectorAll('.ask-o').forEach(b => b.classList.remove('on'));
      opt.classList.toggle('on', !wasOn);
      q.querySelectorAll('.ask-o').forEach(b => b.setAttribute('aria-pressed', String(b.classList.contains('on'))));
      askDrafts.set(ask.dataset.askKey, askValues(ask)); ask.querySelector('.ask-status').textContent = ''; return;
    }
    if (!e.target.closest('.ask-send')) return;
    const values = askValues(ask), missing = values.findIndex(v => !v.selected.length && !v.free.trim());
    askDrafts.set(ask.dataset.askKey, values);
    if (missing !== -1) {
      ask.querySelector('.ask-status').textContent = UI`質問${missing + 1}の選択肢を選ぶか、ほかの回答を入力してください。`;
      ask.querySelectorAll('.ask-free')[missing].focus(); return;
    }
    const key = ask.dataset.askKey;
    const currentAsks = () => [...new Set([ask, ...document.querySelectorAll('.ask')])].filter(a => a.dataset.askKey === key);
    askPending.add(key); updateAskControls(ask);
    ask.querySelector('.ask-status').textContent = '';
    try {
      if (await send(askAnswer(values))) {
        askDrafts.delete(key); currentAsks().forEach(a => { a.classList.add('answered', 'done'); a.querySelector('.ask-status').textContent = L('回答をまとめて送信しました。'); });
      } else { currentAsks().forEach(a => { a.querySelector('.ask-status').textContent = L('送信されていません。回答はそのまま残っています。'); }); }
    } catch (err) { currentAsks().forEach(a => { a.querySelector('.ask-status').textContent = UI`送信できませんでした。回答は残っています。${err.message}`; }); }
    finally { askPending.delete(key); currentAsks().forEach(updateAskControls); }
  });
}
// 答えられるのは最後の返事の質問だけ。過去の回答欄は読み取り専用。
function refreshAsks(box) {
  const all = [...box.querySelectorAll('.m')];
  const last = all.filter(m => !m.id).pop();
  const asks = [...box.querySelectorAll('.ask')];
  const workKey = JSON.stringify([view.project, view.task]), attempt = askAttempts.get(workKey);
  const current = attempt && taskOf(proj(view.project), view.task);
  const target = attempt && asks.filter(a => a.dataset.askKey === attempt.askKey).at(-1);
  const newer = target && asks.slice(asks.indexOf(target) + 1).some(a => a.dataset.askKey !== attempt.askKey);
  const retry = attempt && current?.question === attempt.question && target && !newer && !target.classList.contains('answered');
  // 初期履歴が届く前の空DOMは、対象の質問が消えたという情報ではない。
  if (attempt && (current?.question !== attempt.question || newer || target?.classList.contains('answered') || (!target && box.dataset?.askHistoryPending !== '1'))) askAttempts.delete(workKey);
  asks.forEach(a => {
    a.classList.toggle('done', a.classList.contains('answered') || (!(retry && a === target) && (!last || !last.contains(a))));
    updateAskControls(a);
  });
}
// かかった時間：「45秒」「1分20秒」
function dur(ms) { const t = Math.max(0, Math.round(ms / 1000)); return t < 60 ? `${t}秒` : `${Math.floor(t / 60)}分${t % 60 ? (t % 60) + '秒' : ''}`; }
let busyTimer = null;
function openChat(p, t, savedScroll) {
  const box = $('#msgs');
  const approvalsBox = $('#chat-approvals');
  const drawApprovals = rows => {
    approvalsBox.hidden = !rows?.length;
    approvalsBox.innerHTML = (rows || []).map(a => UI`<div class="approval" data-approval-token="${esc(a.token)}"><b>${a.questions ? 'Codex 需要你的回答' : 'Codex 需要額外權限'}</b>
      <p>${esc(a.reason || '')}</p><pre>${esc(a.detail)}</pre>
      ${(a.questions || []).map(q => UI`<label>${esc(q.question)}<input data-question-id="${esc(q.id)}" type="${q.isSecret ? 'password' : 'text'}" autocomplete="off" maxlength="10000" placeholder="${esc((q.options || []).map(o => o.label).join(' / '))}"></label>`).join('')}
      <div class="approval-actions">${a.questions ? '<button type="button" class="btn" data-approval-decision="answer">送出回答</button>' : UI`<button type="button" class="btn" data-approval-decision="accept">${a.kind.includes('/permissions/') ? '允許本回合權限' : '僅允許這次'}</button><button type="button" class="btn plain" data-approval-decision="decline">拒絕</button>`}<button type="button" class="btn plain" data-approval-decision="cancel">取消作業</button></div></div>`).join('');
  };
  approvalsBox.addEventListener('click', async e => {
    const button=e.target.closest('[data-approval-decision]'); if(!button)return;
    const card=button.closest('[data-approval-token]'); if(!card)return;
    const answers=Object.fromEntries([...card.querySelectorAll('[data-question-id]')].map(input=>[input.dataset.questionId,input.value]));
    const buttons=[...card.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try { await api('/api/chat/approval',{project:p.id,task:t.id,token:card.dataset.approvalToken,decision:button.dataset.approvalDecision,answers}); }
    catch(error) { toast(error.message);buttons.forEach(b=>b.disabled=false); }
  });
  box.dataset.askHistoryPending = '1';
  const ta = $('#chat-in');
  const draftKey = chatAttachmentKey(p.id, t.id);
  ta.addEventListener('input', () => { chatDraft[draftKey] = ta.value; });
  $('#chat-images').addEventListener('click', e => {
    const button = e.target.closest('[data-chat-remove]');
    if (button) removeChatImage(p.id, t.id, button.dataset.chatRemove);
  });
  ta.addEventListener('keydown', e => { if (isSendKey(e)) { e.preventDefault(); $('#composer').requestSubmit(); } });
  const keep = () => { const [ai, model] = $('#chat-ai').value.split('|'); try { localStorage.setItem('hub-chat-' + p.id + '/' + t.id, JSON.stringify({ ai, model, effort: $('#chat-effort').value })); } catch (e) { /* 無視 */ } };
  $('#chat-ai').addEventListener('change', () => { document.querySelectorAll('.gptbox').forEach(b => { b.hidden = state.windowsBrowser ? false : !$('#chat-ai').value.startsWith('chatgpt|'); }); });
  $('#chat-ai').addEventListener('change', () => { const selected = $('#chat-ai').value.split('|')[0], agy = selected === 'agy', web = webActor(selected); $('#chat-send').textContent = chatActionLabel(selected); $('#chat-route-hint').textContent = chatRouteHint(selected); const e = $('#chat-effort'), previous = e.value; e.hidden = web; e.disabled = agy || web; e.innerHTML = (web ? [] : agy ? ['高'] : state.efforts).map(v => UI`<option ${v === (agy ? '高' : previous) ? 'selected' : ''}>${esc(v)}</option>`).join(''); keep(); }); $('#chat-effort').addEventListener('change', keep);
  $('#chat-stop').addEventListener('click', () => api('/api/chat/stop', { project: p.id, task: t.id }).catch(e => toast(e.message)));
  // mode: ''（普通）／'interrupt'（① 中断して送る）／'queue'（② 追加：終わったら続けて）
  const sendChat = async (mode, answer) => {
    if (chatSending.has(draftKey)) return false;
    if (webActor($('#chat-ai').value.split('|')[0])) {
      const original = ta.value; if (answer !== undefined) ta.value = answer;
      try { await gptAsk(p, t); } catch(error) { toast(error.message); } finally { if (answer !== undefined) ta.value = original; }
      return false;
    } // ChatGPT は Hub から動かせない：貼る文を作ってコピーする
    if (chatImageUploads.get(draftKey)) { toast(L('画像の追加が終わってから送ってください')); return false; }
    const original = answer === undefined ? ta.value : answer, sent = answer === undefined ? [...chatImages(p.id, t.id)] : [];
    const text = chatSendText(original, sent);
    if (!text) { toast(L('依頼を書いてください')); return false; }
    if ($('#chat-ai').selectedOptions?.[0]?.disabled) { toast(L('利用できないモデルです。新しい候補を選んでください')); return false; }
    if (!mode && !warnChildren(p)) return false;
    const [ai, model] = $('#chat-ai').value.split('|');
    if (!cliReady(ai)) { toast(L('この CLI の実行と分離は未検証です。まだ起動できません。')); return false; }
    keep();
    if (answer === undefined) chatDraft[draftKey] = original;
    const question = taskOf(proj(p.id), t.id)?.question || '';
    const askKey = [...box.querySelectorAll('.ask')].filter(a => !a.classList.contains('done')).at(-1)?.dataset.askKey;
    const attempt = question && askKey ? { question, askKey } : null;
    if (attempt) askAttempts.set(draftKey, attempt);
    chatSending.add(draftKey); updateWorkAnswerControls();
    try {
      const r = await api('/api/chat/send', { project: p.id, task: t.id, ai, model, effort: $('#chat-effort').value, text, mode, answerQuestion: question });
      if (r.freshSession?.code) toast('舊對話無法接續（代碼：' + r.freshSession.code + '），已改開新對話，並附上先前的文字紀錄。');
      if (askAttempts.get(draftKey) === attempt) askAttempts.delete(draftKey);
      await acceptedWorkAnswer(p, t, question, r, askKey);
      if (answer === undefined && chatDraft[draftKey] === original) {
        chatDraft[draftKey] = '';
        const current = view.kind === 'work' && view.project === p.id && view.task === t.id && workMode() === 'chat' ? $('#chat-in') : null;
        if (current && current.value === original) current.value = '';
      }
      clearSentChatImages(p.id, t.id, sent);
      if (view.kind === 'work' && view.project === p.id && view.task === t.id && $('#chat-in') === ta) {
        scroll(true);
        if (answer === undefined) window.HubMobile?.sent();
      }
      if (r.queued) { toast(UI`順番待ちにしました。今の作業が終わったら始めます（待っている指示 ${r.queue} 件）`); return true; }
      if (view.kind !== 'work' || view.project !== p.id || view.task !== t.id || $('#chat-in') !== ta) return true;
      if (mode === 'redo') { chatBusy = null; toast(L('前の指示を取り消して、新しい指示でやり直しています')); }
      if (mode === 'amend') { chatBusy = null; toast(L('追加の説明を合わせて、作業を続けています')); }
      if (!chatBusy) setBusy({ ai, model: r.model || model, started: Date.now(), text: '' }); // 知らせを待たずに「作業中」を出す
      if (r.note) toast(r.note);
      return true;
    } catch (err) { toast(err.message); return false; }
    finally { chatSending.delete(draftKey); updateWorkAnswerControls(); }
  };
  $('#composer').addEventListener('submit', e => { e.preventDefault(); sendChat(chatBusy ? 'queue' : ''); });
  $('#chat-redo').addEventListener('click', () => sendChat('redo'));
  $('#chat-amend').addEventListener('click', () => sendChat('amend'));
  $('#chat-q').addEventListener('click', () => sendChat('queue'));
  sendWorkAnswer = { project: p.id, task: t.id, send: answer => sendChat(chatBusy ? 'queue' : '', answer) };
  updateWorkAnswerControls();
  bindAskAnswers(box, answer => sendChat(chatBusy ? 'queue' : '', answer));
  // 待っている指示。作業中でない時（再起動の後など）は［▶ 始める］で今すぐ始められる
  let lastQueue = [];
  const drawQueue = q => {
    const el = $('#chat-queue'); if (!el) return;
    const before = position();
    lastQueue = q || [];
    el.hidden = !lastQueue.length;
    el.innerHTML = (!chatBusy && lastQueue.length ? UI`<div class="small qh">待っている指示があります（止まっています）。［▶ 始める］で送れます</div>` : '')
      + lastQueue.map((x, i) => UI`<div class="qi"><span class="qn">次 ${i + 1}</span><span class="qt" title="${esc(x.text)}">${esc(x.text.split('\n')[0])}</span><span class="small">${esc(AI_LABEL[x.ai])}・${esc(x.model || '')}</span>${!chatBusy && i === 0 ? UI`<button type="button" class="qgo" data-run="${esc(x.id)}">▶ 始める</button>` : ''}<button type="button" class="qx" data-unq="${esc(x.id)}" aria-label="取り消す">✕</button></div>`).join('');
    scroll(false,before);
  };
  $('#chat-queue').addEventListener('click', e => {
    const d = e.target.dataset || {};
    if (d.unq) api('/api/chat/unqueue', { project: p.id, task: t.id, id: d.unq }).then(() => toast(L('取り消しました'))).catch(err => toast(err.message));
    if (d.run) api('/api/chat/send', { project: p.id, task: t.id, fromQueue: d.run }).catch(err => toast(err.message)); // 「作業中」は知らせで出る
  });
  const scroller = window.HubChatScroll?.create(box,$('#chat-latest'),savedScroll);
  box.dataset.scrollKey = JSON.stringify([p.id,t.id]);
  const position = () => scroller ? scroller.capture() : {top:box.scrollTop,follow:box.scrollHeight-box.scrollTop-box.clientHeight<80};
  const scroll = (force, before = position()) => { if (scroller) scroller.restore(before,force); else if(force || before.follow) box.scrollTop=box.scrollHeight; };
  // 作業中の表示：動く印・かかった時間・今していること。終わったら消して、知らせる
  const setBusy = b => {
    const before = position();
    const was = chatBusy;
    chatBusy = b;
    $('#chat-busyrow').hidden = !b; $('#chat-send').hidden = Boolean(b);
    $('#chat-redo').hidden = !b; $('#chat-amend').hidden = !b; $('#chat-q').hidden = !b;
    if (Boolean(was) !== Boolean(b)) drawQueue(lastQueue); // ［▶ 始める］の出し入れ
    let tmp = $('#msg-partial');
    if (!b) {
      clearInterval(busyTimer); busyTimer = null;
      if (tmp) tmp.remove();
      $('#chat-state').innerHTML = '';
      scroll(false,before); window.HubMobile?.badges();
      return;
    }
    if (!b.started) b.started = (was && was.started) || Date.now();
    if (!tmp) {
      box.insertAdjacentHTML('beforeend', UI`<div class="m ai working" id="msg-partial"><div class="mh"><span class="chip k-${esc(b.ai)}"><span class="ic">${AI_ICON[b.ai] || '?'}</span>${esc(AI_LABEL[b.ai] || b.ai)}${b.model ? UI`<small>・${esc(b.model)}</small>` : ''}</span>
        <span class="wk"><i class="spin"></i>作業中<span class="dots"><i>.</i><i>.</i><i>.</i></span> <span class="wk-time"></span></span></div>
        <div class="wk-last"></div><div class="mb" hidden></div></div>`);
      tmp = $('#msg-partial');
    }
    const mb = tmp.querySelector('.mb');
    mb.hidden = !b.text; mb.innerHTML = richText(b.text || '');
    if (b.last && showDetail()) tmp.querySelector('.wk-last').textContent = '▸ ' + b.last;
    if (!was || was.ai !== b.ai || was.model !== b.model) {
      $('#chat-state').innerHTML = UI`<span class="wk"><i class="spin"></i>${esc(AI_LABEL[b.ai])}${b.model ? L('・') + esc(b.model) : ''} が作業中… <span id="chat-elapsed"></span></span>`;
    }
    const tick = () => {
      if (!chatBusy) return;
      const elapsed = dur(Date.now() - chatBusy.started);
      const w = $('#msg-partial')?.querySelector('.wk-time'); if (w) w.textContent = elapsed;
      const label = $('#chat-elapsed'); if (label) label.textContent = elapsed;
    };
    if (!busyTimer) { tick(); busyTimer = setInterval(tick, 1000); }
    else if (was && was.started !== b.started) tick();
    scroll(false,before); window.HubMobile?.badges();
  };
  if(window.HubNativeRestart?.paused)return;
  chatES = new EventSource(`/api/chat/stream?project=${encodeURIComponent(p.id)}&task=${encodeURIComponent(t.id)}`);
  chatES.onmessage = m => {
    const ev = JSON.parse(m.data);
    const before = position();
    if (ev.type === 'queue') { drawQueue(ev.queue); return; }
    if (ev.type === 'approvals') { drawApprovals(ev.approvals); return; }
    if (ev.type === 'rows') drawApprovals(ev.approvals);
    if (ev.type === 'rows') { setBusy(null); drawQueue(ev.queue); box.innerHTML = ev.rows.length ? ev.rows.map(msgHtml).join('') : EMPTY_CHAT(); delete box.dataset.askHistoryPending; refreshAsks(box); setBusy(ev.busy); if(scroller) scroller.rows(before); else scroll(true); }
    else if (ev.type === 'row') {
      const e = box.querySelector('.chat-empty'); if (e) e.remove();
      const tmp = $('#msg-partial');
      if (tmp) tmp.insertAdjacentHTML('beforebegin', msgHtml(ev.row)); else box.insertAdjacentHTML('beforeend', msgHtml(ev.row));
      refreshAsks(box);
      if (ev.row.role === 'assistant' && ev.row.asks && ev.row.asks.length) toast(L('AI から質問があります。選んで答えてください'));
      if (ev.row.role === 'event' && chatBusy) setBusy({ ...chatBusy, last: ev.row.text });
      if (ev.row.role === 'assistant' && !(ev.row.asks && ev.row.asks.length)) toast(ev.row.error ? UI`${AI_LABEL[ev.row.ai]} が止まりました。赤い字をご覧ください` : UI`${AI_LABEL[ev.row.ai]} の返事が届きました（${dur(ev.row.ms || 0)}）`);
      scroll(ev.row.role === 'user' && chatSending.has(draftKey),before);
      window.HubMobile?.badges();
    } else if (ev.type === 'busy') { setBusy({ ...(chatBusy || {}), ai: ev.ai, model: ev.model, started: ev.started, text: '' }); refreshTree(); }
    else if (ev.type === 'partial') setBusy({ ...(chatBusy || { ai: ev.ai }), text: ev.text });
    else if (ev.type === 'idle') { setBusy(null); refreshTree(); }
  };
}

// ［本体に取り込む］の横に、変更の量とぶつかりそうかを出す
async function loadPreview(pid, tid) {
  try {
    const r = await api(`/api/task/preview?project=${encodeURIComponent(pid)}&task=${encodeURIComponent(tid)}`);
    const el = document.querySelector('[data-act="merge"]');
    if (!r || !el || view.task !== tid) return;
    const txt = r.files ? UI`${r.files}ファイル +${r.added} −${r.removed}` : L('変更なし');
    el.insertAdjacentHTML('beforebegin', UI`<span class="pv ${r.conflict ? 'bad' : ''}" title="作業用コピーで変わった量（本体と比べて）">${txt}${r.conflict ? L('・本体とぶつかりそう') : ''}</span>`);
  } catch (e) { /* 出せなくても困らない */ }
}

// live=true：動いている AI の見出しに置く。変えるとその AI に切り替えを伝える
function specSelect(p, t, ai, live) {
  if (ai === 'agy') return UI`<span class="spec"><select aria-label="モデル" disabled><option>Gemini 3.1 Pro (High)</option></select><select aria-label="思考" disabled><option>高</option></select></span>`;
  const key = AI_KEY[ai], models = state.roles.models[key] || [], s = specOf(t, ai);
  const missing = t.model && !models.includes(t.model);
  const k = `data-p="${esc(p.id)}" data-t="${esc(t.id)}"${live ? ` data-ai="${ai}"` : ''}`;
  return UI`<span class="spec" title="${live ? UI`変えると ${AI_LABEL[ai]} に切り替えを伝えます` : UI`次に始める時の ${AI_LABEL[ai]} のモデルと思考（空なら役割の設定）`}">
    <select data-act="model" ${k} aria-label="モデル"><option value="" ${t.model ? '' : 'selected'}>モデル：役割どおり（${esc(s.model || '—')}）</option>${missing ? UI`<option selected disabled value="${esc(t.model)}">${esc(t.model)}（現在の指定・利用不可）</option>` : ''}${shownModels(key, t.model).map(m => UI`<option ${t.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
    <select data-act="effort" ${k} aria-label="思考"><option value="" ${t.effort ? '' : 'selected'}>思考：役割どおり（${esc(s.effort || '—')}）</option>${state.efforts.map(e => UI`<option ${t.effort === e ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select></span>`;
}

// 端末の部品（xterm.js・290KB）は、ターミナル画面を初めて開く時だけ読み込む（会話画面しか使わない時は読まない）
let xtermLoading = null;
function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (!xtermLoading) {
    const one = src => new Promise((ok, ng) => { const sc = document.createElement('script'); sc.src = src; sc.onload = ok; sc.onerror = () => ng(new Error(`${src} を読み込めませんでした`)); document.head.appendChild(sc); });
    xtermLoading = one('vendor/xterm.js').then(() => one('vendor/addon-fit.js')).catch(e => { xtermLoading = null; throw e; });
  }
  return xtermLoading;
}
async function attach(project, task, ai) {
  if(window.HubNativeRestart?.paused)return;
  try { await loadXterm(); } catch (e) { toast(e.message); return; }
  if(window.HubNativeRestart?.paused)return;
  const el = document.getElementById('pane-' + ai);
  if (!el || panes[ai]) return; // 読み込みを待つ間に画面が変わった・もう付いている
  const xterm = new window.Terminal({ fontSize: 13, fontFamily: 'Menlo, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: { background: '#10131a' } });
  const fit = new window.FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(el);
  const pane = { xterm, fit, es: null, ro: null, project, task, controller: null };
  panes[ai] = pane;
  if (state.windowsBrowser) {
    pane.controller = new window.HubTerminalView({ api, project, task, ai, onState: s => {
      xterm.options.disableStdin = s.role !== 'owner' || s.readonly;
      const label = $('#view-state-' + ai); if (label) label.textContent = s.disconnected ? '連線已中斷，請重開作業畫面' : s.readonly ? '僅供觀看' : s.role === 'owner' ? '此視窗控制輸入' : '此視窗僅供觀看';
    }, onError: e => toast(e.message) });
    try { await pane.controller.connect(); } catch (e) { pane.controller.lost(e); }
    if (panes[ai] !== pane) { await pane.controller.close(); return; }
  }
  const doFit = () => { try { fit.fit(); const resized = pane.controller ? pane.controller.resize(xterm.cols, xterm.rows) : api('/api/term/resize', { project, task, ai, cols: xterm.cols, rows: xterm.rows }); Promise.resolve(resized).catch(e => { if (state.windowsBrowser) toast(e.message); }); } catch (e) { /* 表示前 */ } };
  pane.ro = new ResizeObserver(doFit); pane.ro.observe(el);
  setTimeout(doFit, 0);
  xterm.onData(d => (pane.controller ? pane.controller.write(d) : api('/api/term/input', { project, task, ai, data: d })).catch(e => { if (state.windowsBrowser) toast(e.message); }));
  if(window.HubNativeRestart?.paused)return;
  const es = new EventSource(`/api/term/stream?project=${encodeURIComponent(project)}&task=${encodeURIComponent(task)}&ai=${ai}`);
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'data') xterm.write(ev.data);
    if (ev.type === 'exit') { xterm.write(`\r\n\x1b[90m— 終了しました（code ${ev.code}）—\x1b[0m\r\n`); es.close(); setTimeout(() => load().catch(() => {}), 500); }
  };
  pane.es = es;
}
function closePanes() {
  if (chatES) { chatES.close(); chatES = null; }
  clearInterval(busyTimer); busyTimer = null; chatBusy = null;
  for (const ai of Object.keys(panes)) {
    const p = panes[ai];
    if (p.es) p.es.close();
    if (p.ro) p.ro.disconnect();
    if (p.controller) p.controller.close().catch(() => {});
    try { p.xterm.dispose(); } catch (e) { /* 無視 */ }
  }
  panes = {};
}

async function startAI(p, t, ai) {
  requireCliReady(ai,'terminal');
  if (!state.terminal) {
    const r = await api('/api/continue', { project: p, task: t, ai });
    if(state.windowsBrowser)openTerminalWindow(p,t,ai);
    toast(UI`別の窓で起動しました（${r.dir}）`);
    return;
  }
  const r = await api('/api/term/start', { project: p, task: t, ai, cols: 100, rows: 30 });
  toast(UI`${AI_LABEL[ai]} を起動しました${r.model ? `（${r.model}${r.effort ? L('・') + r.effort : ''}）` : ''}${r.note ? '。' + r.note : ''}`);
  await load();
}
window.addEventListener?.('hub-restart-pause',()=>closePanes());

function terminalCredentials(ai) { return state.windowsBrowser ? panes[ai]?.controller?.credentials() || {} : {}; }
function openTerminalWindow(project, task, ai) {
  if (!state.windowsBrowser || !AIS.includes(ai)) return;
  const url = 'terminal.html?' + new URLSearchParams({ project, task, ai });
  const popup = window.open(url, '_blank', 'popup,width=1100,height=720');
  if (popup) popup.opener = null; else toast('瀏覽器阻擋了新視窗，請允許此 Hub 的彈出視窗。');
}

// ---- 設定（役割・モデル・思考） ----
let aiTools = null, aiToolsOperation = null, aiToolsError = '', aiToolsLoadingBox = null, aiToolsWatchTimer = null;
let aiToolsBusyCount = 0;
const aiCheckPending = Object.fromEntries(AIS.map(ai=>[ai,false]));
const aiToolPending = Object.fromEntries(AIS.map(ai=>[ai,false]));
const aiToolMessage = Object.fromEntries(AIS.map(ai=>[ai,'']));
const aiToolMethod = method => ({ standalone: L('単独インストール'), 'homebrew-cask': 'Homebrew', native: L('公式インストール'), missing: '未導入', unknown: L('確認できません') }[method] || method || '不明');
const aiToolErrorText = e => [e.message, e.reason && e.reason !== e.message ? e.reason : '', e.stage ? `段階：${e.stage}` : ''].filter(Boolean).join('。');
function drawAiTools() {
  const box = $('#ai-tools'); if (!box) return;
  if (!aiTools) { box.textContent = aiToolsError || '確認中…'; return; }
  const localBusy = AIS.some(a => aiToolPending[a]);
  box.innerHTML = (aiToolsError ? UI`<p class="ai-tool-result" role="status">${esc(aiToolsError)}</p>` : '') + AIS.map(ai => {
    const tool = aiTools[ai] || {}, busy = localBusy || tool.updating || Boolean(aiToolsOperation);
    const check = tool.updateCheck, checking = aiCheckPending[ai] || tool.checking;
    const running = Math.max(aiToolsBusyCount, (state.chatting || []).length + state.sessions.filter(s => s.running).length);
    const message = aiToolMessage[ai] || (tool.updating ? L('更新中です') : aiToolsOperation ? L('ほかの更新が進行中です') : !tool.installed ? L('この AI は見つかりませんでした') : '');
    const canRefresh = cliReady(ai) && tool.modelRefreshAvailable !== false;
    const count = Array.isArray(tool.models) ? UI`選べるモデル ${tool.models.length} 件` : '';
    const models = Array.isArray(tool.models) ? tool.models : [];
    return UI`<div class="ai-tool-row" data-ai="${ai}">
      <div class="ai-tool-head"><b>${esc(AI_LABEL[ai])}</b><span class="small">現在版：${esc(tool.version || L('確認できません'))}</span><span class="small">導入方法：${esc(aiToolMethod(tool.method))}</span></div>
      ${tool.nativeUpdate ? UI`<div class="small">可安裝的已審核版本：${tool.nativeUpdate.versions.map(version=>UI`<button class="btn sm" type="button" data-ai-check="${ai}" data-ai-version="${esc(version)}" ${checking||busy?'disabled':''}>預覽 ${esc(version)}</button>`).join('')}<p>作用中槽位：${esc(tool.nativeUpdate.active?tool.nativeUpdate.active.version+' · '+tool.nativeUpdate.active.slot:'無')}；上一個槽位：${esc(tool.nativeUpdate.previous?tool.nativeUpdate.previous.version+' · '+tool.nativeUpdate.previous.slot:'無')}</p>${tool.nativeUpdate.error?UI`<p role="status">私有版本槽無法使用：${esc(tool.nativeUpdate.error)}。請檢查版本槽狀態，再安裝已審核版本。</p>`:''}</div>`:''}
      <div class="ai-tool-actions"><button class="btn sm" type="button" data-ai-check="${ai}" ${checking || tool.installed === false || !cliReady(ai) ? 'disabled' : ''}>${checking ? '確認中…' : L('更新を確認')}</button>
        ${check?.ok && check.available ? UI`<button class="btn sm" type="button" data-ai-update="${ai}" ${busy || running || !check.applicable || !cliReady(ai) ? 'disabled' : ''}>v${esc(check.latestVersion)} を適用</button>` : ''}
        <button class="btn plain sm" type="button" data-ai-model-refresh="${ai}" ${busy || !canRefresh || tool.installed === false ? 'disabled' : ''}>モデル一覧を再取得</button>
        ${count ? UI`<span class="small">${esc(count)}</span>` : ''}</div>
      ${tool.source ? UI`<span class="small">モデル候補の取得元：${esc(tool.source)}</span>` : ''}
      ${check ? UI`<p class="small">${check.ok ? `最新版：${esc(check.latestVersion)}（${check.available === null ? L('比較できません') : check.available ? L('更新があります') : L('更新はありません')}）` : L('今回の更新確認に失敗しました。前回の情報では適用できません。')}${check.checkedAt ? ` · ${esc(new Date(check.checkedAt).toLocaleString())} 確認` : ''}</p>` : ''}
      ${check?.available && running ? UI`<p class="small">適用は動いている AI ${running} 件が終わってから行えます。更新確認はいつでもできます。</p>` : ''}
      ${check?.available && !check.applicable ? UI`<p class="small">この導入方法は画面からの適用に未対応です。</p>` : ''}
      ${models.length ? UI`<details class="more ai-tool-models"><summary>取得したモデル候補</summary><div>${models.map(m => UI`<span class="ai-model-name">${esc(m.label || m.id)}${m.label && m.label !== m.id ? UI`<small>${esc(m.id)}</small>` : ''}</span>`).join('')}</div></details>` : ''}
      ${!canRefresh ? UI`<p class="small">この AI のモデル一覧の再取得にはまだ対応していません。</p>` : ''}
      ${!cliReady(ai) ? UI`<p class="small">この CLI の実行と分離は未検証です。まだ起動できません。</p>` : ''}
      ${message ? UI`<p class="ai-tool-result" role="status">${esc(message)}</p>` : ''}
    </div>`;
  }).join('');
}
function scheduleAiToolsWatch() {
  clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null;
  if (view.kind !== 'settings' || document.hidden || (!aiToolsOperation && !aiToolsBusyCount)) return;
  aiToolsWatchTimer = setTimeout(() => {
    aiToolsWatchTimer = null;
    if (view.kind === 'settings' && !document.hidden) loadAiTools();
  }, aiToolsOperation ? 3000 : 10000);
}
async function loadAiTools() {
  const box = $('#ai-tools'); if (!box || aiToolsLoadingBox === box) return;
  aiToolsLoadingBox = box;
  const wasOperating = Boolean(aiToolsOperation);
  try {
    const r = await api('/api/ai-tools');
    if ($('#ai-tools') !== box) return;
    aiTools = r.tools || {}; aiToolsOperation = r.operation || null; aiToolsBusyCount = r.busyCount || 0; aiToolsError = '';
    if (wasOperating && !aiToolsOperation && !AIS.some(a => aiToolPending[a])) {
      try { await refreshAiToolCatalog(); }
      catch (e) { aiToolsError = UI`モデル一覧を画面へ反映できませんでした：${aiToolErrorText(e)}`; }
    }
  } catch (e) { if ($('#ai-tools') === box) { aiTools = null; aiToolsError = aiToolErrorText(e); } }
  finally { if (aiToolsLoadingBox === box) aiToolsLoadingBox = null; if ($('#ai-tools') === box) { drawAiTools(); scheduleAiToolsWatch(); } }
}
function refreshRoleModelChoices() {
  if (view.kind !== 'settings') return;
  document.querySelectorAll('select[data-r][data-f="model"]').forEach(el => {
    const slot = rolesDraft?.[+el.dataset.r]?.[el.dataset.k]; if (!slot) return;
    const models = shownModels(slot.ai, slot.model);
    const names = slot.model && !models.includes(slot.model) ? [slot.model, ...models] : models;
    el.innerHTML = names.map(m => UI`<option value="${esc(m)}">${esc(m)}</option>`).join('');
    el.value = slot.model;
  });
  const note = $('#model-catalog');
  if (note) note.textContent = UI`選べるモデル：Claude Code は ${(state.roles.models['claude-code'] || []).join(' / ')}、Codex は ${(state.roles.models.codex || []).join(' / ')}。思考は ${state.efforts.join(' → ')}。`;
}
async function refreshAiToolCatalog() {
  const epoch = ++stateLoadEpoch;
  const next = await api('/api/state');
  if (epoch !== stateLoadEpoch) return;
  state = next;
  refreshRoleModelChoices();
  if (view.kind === 'settings') await loadCliModels(true);
}
function aiToolResultText(action, r) {
  if(r.scope==='Hub-private-slot'||r.phase==='blocked'){
    if(r.phase==='blocked'||r.ok===false)return `候選 ${r.version||''} 已保存但未啟用：${r.blocker||'尚未完成相容性驗收'}。目前版本 ${r.beforeVersion||''} 保留；全域 CLI 未變更。`;
    if(r.phase==='activated')return `Hub 私有 Codex 版本 ${r.version||r.afterVersion} 已通過來源、檔案雜湊及零模型沙箱 probe 後啟用；全域 CLI 未變更。`;
  }
  const modelReport = result => {
    if (!result) return L('モデル一覧の状態を確認できませんでした。');
    if (result.ok === false) return UI`モデル一覧の再取得に失敗しました：${result.error || L('理由を確認できません')}。`;
    const unchanged = Boolean(result.unchanged);
    const added = !unchanged && typeof result.added === 'number' ? `（追加 ${result.added} 件）` : '';
    return `${unchanged ? L('モデル一覧は前回の内容を使用しています') : UI`モデル一覧を再取得しました${added}`}。`
      + (result.source ? `取得元：${result.source}。` : '')
      + (result.warning ? `注意：${result.warning}。` : '');
  };
  if (action === 'models') return modelReport(r);
  const before = r.beforeVersion || '', after = r.afterVersion || '';
  const base = r.verified === false ? UI`更新操作は終わりましたが、版を確認できませんでした${r.verifyError ? `：${r.verifyError}` : ''}。` : r.changed
    ? before && after ? UI`更新しました：${before} → ${after}。` : UI`更新しましたが、版を確認できませんでした。`
    : before || after ? UI`版は変わりませんでした（${after || before}）。` : L('版の変化を確認できませんでした。');
  return base + modelReport(r.models);
}
async function runAiTool(ai, action, version) {
  if (!cliReady(ai)) { toast(L('この CLI の実行と分離は未検証です。まだ起動できません。')); return; }
  if (action === 'check') {
    if (!AIS.includes(ai) || aiCheckPending[ai] || aiTools?.[ai]?.checking || aiTools?.[ai]?.installed === false&&!version) return;
    aiCheckPending[ai] = true; aiToolMessage[ai] = L('更新情報を確認しています…'); drawAiTools();
    try { const r = await api('/api/ai-tools/check', { ai, ...(version?{version}:{}) }); if (aiTools) aiTools[ai].updateCheck = r; aiToolMessage[ai] = r.available ? L('更新があります。適用する時は別のボタンを押してください。') : L('更新の確認が終わりました。'); }
    catch (e) { aiToolMessage[ai] = aiToolErrorText(e); }
    finally { aiCheckPending[ai] = false; await loadAiTools(); drawAiTools(); }
    return;
  }
  if (!AIS.includes(ai) || !['update', 'models'].includes(action) || AIS.some(a => aiToolPending[a]) || aiToolsOperation || aiTools?.[ai]?.updating || aiTools?.[ai]?.installed === false && !(action==='update'&&aiTools?.[ai]?.nativeUpdate) || (action === 'models' && aiTools?.[ai]?.modelRefreshAvailable === false)) return;
  if (action === 'update' && (!aiTools?.[ai]?.updateCheck?.available || aiToolsBusyCount)) return; // 確認は［更新を確認］で済んでいるので、そのまま適用する
  let approval={};
  if(state.windowsBrowser&&action==='update'){
    const preview=aiTools?.[ai]?.updateCheck?.nativePreview;
    if(ai!=='codex'||!preview?.token||!preview.version){aiToolMessage[ai]='請重新核對官方來源與精確版本，再建立更新核准。';drawAiTools();return;}
    if(!confirm(`${preview.compatible?'下載、驗證並啟用':'下載、驗證但不啟用尚未驗收的'} Codex ${preview.version}？\n\n主套件：${preview.main.url}\nSRI：${preview.main.integrity}\n原生套件：${preview.native.url}\nSRI：${preview.native.integrity}\n\n只寫入 Hub 私有版本槽；不執行套件安裝腳本、不改全域 CLI。來源、雜湊或沙箱 probe 失敗會保留目前版本。${preview.blocker?'\n未啟用原因：'+preview.blocker:''}`))return;
    approval={version:preview.version,token:preview.token,confirm:true};
  }
  aiToolPending[ai] = true; aiToolsOperation = { ai, kind: action }; aiToolMessage[ai] = action === 'update' ? L('更新を適用しています…') : L('モデル一覧を確認しています…'); drawAiTools();
  try {
    const path = action === 'update' ? '/api/ai-tools/update' : '/api/ai-tools/models/refresh';
    const result = await api(path, { ai, ...approval });
    aiToolMessage[ai] = aiToolResultText(action, result);
    try { await refreshAiToolCatalog(); }
    catch (e) { aiToolMessage[ai] += UI`画面のモデル一覧を更新できませんでした：${aiToolErrorText(e)}。`; }
  } catch (e) { aiToolMessage[ai] = UI`失敗しました：${aiToolErrorText(e)}`; }
  finally { aiToolPending[ai] = false; aiToolsOperation = null; await loadAiTools(); drawAiTools(); }
}
document.addEventListener('click', e => {
  const ai = e.target.dataset.aiCheck || e.target.dataset.aiUpdate || e.target.dataset.aiModelRefresh;
  if (ai) runAiTool(ai, e.target.dataset.aiCheck ? 'check' : e.target.dataset.aiUpdate ? 'update' : 'models', e.target.dataset.aiVersion);
});
// モデル一覧の並べ替え。役割や会話の選択値には触れない。
let modelViewSaving = false, modelOrderDrag = '', modelOrderNotice = '';
function modelOrderHtml() {
  const ids = orderedModels();
  return UI`<div class="model-order-rows">${ids.map((id, i) => {
    const [ai, model] = id.split('|'), label = UI`${AI_LABEL[ai === 'claude-code' ? 'claude' : ai]}・${model}`;
    return UI`<div class="model-order-row" data-mo-row="${esc(id)}">
      <span class="model-grip" draggable="${!modelViewSaving}" data-mo-grip="${esc(id)}" aria-hidden="true" title="ドラッグして順番を変える">⋮⋮</span>
      <label class="chk"><input type="checkbox" data-mv-ai="${ai}" data-mv="${esc(model)}" ${((state.hiddenModels || {})[ai] || []).includes(model) ? '' : 'checked'} ${modelViewSaving ? 'disabled' : ''}> <span>${esc(label)}</span></label>
      <button class="btn plain sm" type="button" data-mo-up="${esc(id)}" aria-label="${esc(label)} を上へ" ${modelViewSaving || i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn plain sm" type="button" data-mo-down="${esc(id)}" aria-label="${esc(label)} を下へ" ${modelViewSaving || i === ids.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`;
  }).join('') || UI`<span class="small">まだありません</span>`}</div>
  <div class="acts"><button class="btn plain sm" id="model-order-reset" type="button" ${modelViewSaving || !ModelOrder.clean(state.modelOrder).length ? 'disabled' : ''}>元の順に戻す</button></div>
  <p class="small" id="model-order-status" role="status">${esc(modelViewSaving ? '保存中…' : modelOrderNotice)}</p>`;
}
function drawModelOrder(focus) {
  const box = $('#model-order-list');
  if (view.kind !== 'settings' || !box) return;
  box.innerHTML = modelOrderHtml();
  if (focus) {
    const id = typeof focus === 'string' ? focus : focus.id;
    const controls = [...box.querySelectorAll('[data-mo-up],[data-mo-down],[data-mv]')].filter(x => !x.disabled && (x.dataset.moUp === id || x.dataset.moDown === id || `${x.dataset.mvAi}|${x.dataset.mv}` === id));
    const button = controls.find(x => focus.checkbox ? x.dataset.mv !== undefined : focus.direction === 'down' ? x.dataset.moDown === id : x.dataset.moUp === id)
      || controls.find(x => x.dataset.moUp || x.dataset.moDown) || controls[0];
    button?.focus({ preventScroll: true });
  }
}
function syncRoleModelOrder() {
  if (view.kind !== 'settings') return;
  document.querySelectorAll('select[data-f="model"]').forEach(select => {
    const spec = rolesDraft?.[select.dataset.r]?.[select.dataset.k];
    if (!spec) return;
    const rank = shownModels(spec.ai, select.value), value = select.value;
    if (value && !rank.includes(value) && [...select.options].some(o => o.value === value)) rank.push(value);
    select.innerHTML = rank.map(model => UI`<option ${model === value ? 'selected' : ''}>${esc(model)}</option>`).join('');
    select.value = value;
  });
}
async function saveModelOrder(visible, focus, reset = false) {
  if (modelViewSaving) return;
  const before = orderedModels(), previous = state.modelOrder;
  const next = reset ? [] : ModelOrder.retainMissing(previous, visible);
  ++stateLoadEpoch; modelViewSaving = true; modelOrderNotice = ''; state.modelOrder = next; drawModelOrder();
  try {
    const r = await api('/api/models/order', { order: next, before });
    state.modelOrder = r.modelOrder; state.hiddenModels = r.hiddenModels;
    modelOrderNotice = L('並び順を保存しました'); toast(modelOrderNotice);
    syncRoleModelOrder(); drawInitialPick();
  } catch (e) {
    state.modelOrder = previous;
    modelOrderNotice = UI`並び順を保存できませんでした：${e.message}`; toast(modelOrderNotice);
    // 他の画面が先に保存した順を読み直す。役割の入力欄は作り直さない。
    if (e.status === 409) { try { const fresh = await fetchState(); if (fresh) { state.modelOrder = fresh.modelOrder; state.hiddenModels = fresh.hiddenModels; syncRoleModelOrder(); } } catch (_) {} }
  } finally { ++stateLoadEpoch; modelViewSaving = false; drawModelOrder(focus); }
}
async function toggleModelVisibility(el) {
  if (modelViewSaving) { el.checked = !el.checked; return; }
  const { mvAi: ai, mv: model } = el.dataset, checked = el.checked;
  ++stateLoadEpoch; modelViewSaving = true; modelOrderNotice = ''; drawModelOrder();
  try {
    const r = await api('/api/models/hidden', { ai, model, hidden: !checked });
    state.hiddenModels = r.hiddenModels; state.modelOrder = r.modelOrder;
    syncRoleModelOrder(); drawInitialPick();
    toast(checked ? UI`${model} を出します` : UI`${model} を隠しました`);
  } catch (e) { modelOrderNotice = `表示の設定を保存できませんでした：${e.message}`; toast(modelOrderNotice); }
  finally { ++stateLoadEpoch; modelViewSaving = false; drawModelOrder({ id: `${ai}|${model}`, checkbox: true }); }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mo-up],[data-mo-down],#model-order-reset');
  if (!b || b.disabled || modelViewSaving) return;
  if (b.id === 'model-order-reset') {
    if (confirm(L('モデルの並びを元の順（AI ごと・取り直した順）に戻しますか？ 出す・隠すの設定はそのままです。'))) saveModelOrder([], '', true);
    return;
  }
  const id = b.dataset.moUp || b.dataset.moDown, ids = orderedModels(), i = ids.indexOf(id), j = i + (b.dataset.moUp ? -1 : 1);
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i],ids[j]] = [ids[j],ids[i]]; saveModelOrder(ids, { id, direction: b.dataset.moUp ? 'up' : 'down' });
});
document.addEventListener('dragstart', e => {
  const grip = e.target.closest('[data-mo-grip]');
  if (!grip) return;
  if (modelViewSaving || window.matchMedia?.('(max-width:900px)').matches) { e.preventDefault(); return; }
  modelOrderDrag = grip.dataset.moGrip; e.dataTransfer.setData('text/plain', modelOrderDrag); e.dataTransfer.effectAllowed = 'move';
});
function clearModelDrop() { document.querySelectorAll('.model-order-row').forEach(x => x.classList.remove('model-drop-before','model-drop-after')); }
document.addEventListener('dragover', e => {
  const row = e.target.closest('[data-mo-row]');
  if (!modelOrderDrag || modelViewSaving || !row) return;
  e.preventDefault(); e.stopImmediatePropagation(); e.dataTransfer.dropEffect = 'move';
  clearModelDrop(); row.classList.add(e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 'model-drop-before' : 'model-drop-after');
}, true);
document.addEventListener('drop', e => {
  const row = e.target.closest('[data-mo-row]'), id = modelOrderDrag; modelOrderDrag = ''; clearModelDrop();
  if (!id || modelViewSaving || !row) return;
  e.preventDefault(); e.stopImmediatePropagation(); const before = orderedModels(), ids = before.filter(x => x !== id);
  const i = ids.indexOf(row.dataset.moRow); if (i < 0) return;
  const after = e.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
  ids.splice(i + (after ? 1 : 0), 0, id);
  if (JSON.stringify(ids) !== JSON.stringify(before)) saveModelOrder(ids, id);
}, true);
document.addEventListener('dragend', () => { modelOrderDrag = ''; clearModelDrop(); });
let initialPickSaving = false;
function initialPickHtml() {
  const pick = initialPick(), key = AI_KEY[pick.ai], web = webActor(pick.ai);
  const missing = !web && !(state.roles.models[key] || []).includes(pick.model), unavailable = missing || state.initialPickError || (web ? !manualReady(pick.ai) : !cliReady(pick.ai));
  const disabled = initialPickSaving ? 'disabled' : '';
  return UI`<div class="cfg">
    <select data-initial="ai" aria-label="新規開始のAI" ${disabled}>${[...AIS,'chatgpt','claude-chat'].map(ai => UI`<option value="${ai}" ${pick.ai === ai ? 'selected' : ''} ${(webActor(ai)?manualReady(ai):cliReady(ai))?'':'disabled'}>${AI_LABEL[ai]}${webActor(ai)?L('（手動引き継ぎ）'):!cliReady(ai)?L('（まだ利用できません）'):''}</option>`).join('')}</select>
    ${web ? UI`<span class="small">手動引き継ぎ。モデルは Web サイトで選びます。</span>` : UI`<select data-initial="model" aria-label="新規開始のモデル" ${disabled}>${missing ? UI`<option selected disabled value="${esc(pick.model)}">${esc(pick.model)}（利用不可）</option>` : ''}${shownModels(key, pick.model).map(m => UI`<option ${m === pick.model ? 'selected' : ''}>${esc(m)}${m === pick.model && state.initialPickError ? '（利用不可）' : ''}</option>`).join('')}</select>
    <select data-initial="effort" aria-label="新規開始の思考" ${disabled}>${state.efforts.map(e => UI`<option ${e === pick.effort ? 'selected' : ''}>${esc(e)}</option>`).join('')}</select>`}
    </div><div class="acts"><button type="button" class="btn plain" data-initial-reset ${disabled}>初期値に戻す</button></div>
    <p class="small" role="status">${initialPickSaving ? '保存中…' : unavailable ? UI`選んだ入口またはモデルは利用不可です。設定と状態を確認してください。${esc(state.initialPickError || '')}` : L('変更するとすぐ保存します。')}</p>`;
}
function drawInitialPick() { if (view.kind === 'settings') $('#initial-pick').innerHTML = initialPickHtml(); }
async function saveInitialPick(next) {
  if (initialPickSaving) return;
  const previous = state.initialPick, previousError = state.initialPickError, previousPick = initialPick();
  ++stateLoadEpoch; initialPickSaving = true; state.initialPick = next; state.initialPickError = ''; drawInitialPick();
  try {
    const r = await api('/api/models/initial', next);
    state.initialPick = r.initialPick;
    // 保存した下書き・前回選択・入力中の内容を残し、未入力の初期値だけ更新する。
    for (const [id, draft] of quickDrafts) {
      let saved = true;
      try { saved = Boolean(localStorage.getItem('hub-start-' + id)); } catch (_) { /* 読めなければ保持 */ }
      if (!saved && !proj(id)?.startSpec && !draft.text && !draft.images.length &&
          ['ai', 'model', 'effort'].every(key => draft[key] === previousPick[key])) quickDrafts.delete(id);
    }
    toast(L('新しく始めるときのAIを保存しました'));
  } catch (e) { state.initialPick = previous; state.initialPickError = previousError; toast(UI`初期AIを保存できませんでした：${e.message}`); }
  finally { ++stateLoadEpoch; initialPickSaving = false; drawInitialPick(); }
}
document.addEventListener('click', e => {
  const button = e.target.closest('[data-initial-reset]');
  if (button && !button.disabled) void saveInitialPick({ ...defaultInitialPick() });
});
let phoneLabelsSaving = false, phoneLabelsNotice = '', renderedPhoneKey = '';
const phoneLabelDrafts = new Map(), phoneLabelQueue = [], phoneLabelErrors = new Map();
let phoneLabelActive = null;
function phoneLabelStatus() {
  const failures = [...phoneLabelErrors.values()].join(' ／ ');
  return failures ? `${phoneLabelsSaving ? '保存中… ' : ''}${failures}` : phoneLabelsSaving ? '保存中…' : phoneLabelsNotice;
}
function phoneLabelMode() {
  return [...phoneLabelQueue].reverse().find(spec => spec.labels)?.labels || phoneLabelActive?.labels || state.phoneLabels?.labels || 'short';
}
const phoneSettingsKey = () => JSON.stringify([state.phoneLabels, orderedModels()]);
function phoneLabelsHtml() {
  const phone = state.phoneLabels || { labels: 'short', names: {} }, full = phoneLabelMode() === 'full';
  return UI`<div class="phone-label-mode" role="group" aria-label="AI一覧の名前">
    <label><input type="radio" name="phone-label-mode" data-phone-mode="short" ${full ? '' : 'checked'}> 短い名前</label>
    <label><input type="radio" name="phone-label-mode" data-phone-mode="full" ${full ? 'checked' : ''}> AI名・モデル名（PCと同じ）</label>
  </div><p class="small">名前を入力するとスマホの一覧に使います。空欄で元の短い名前に戻ります（24字以内・改行なし）。</p>
  <div class="phone-label-rows">${[...orderedModels(), 'chatgpt|app', ...(state.windowsBrowser?['claude-chat|app']:[])].map(key => {
    const [k, model] = key.split('|'), ai = k === 'claude-code' ? 'claude' : k;
    const label = webActor(ai) ? AI_LABEL[ai] : UI`${AI_LABEL[ai]}・${model}`;
    return UI`<label class="phone-label-row"><span>${esc(label)}</span><input type="text" data-phone-name="${esc(key)}" maxlength="24" aria-label="${esc(label)} のスマホ表示名" placeholder="${esc(shortModelLabel(ai, model))}" value="${esc(phoneLabelDrafts.has(key) ? phoneLabelDrafts.get(key) : phone.names?.[key] || '')}" ${full ? 'disabled' : ''}></label>`;
  }).join('')}</div><p class="small" role="status" id="phone-label-status">${esc(phoneLabelStatus())}</p>`;
}
function drawPhoneLabels() {
  const box = $('#phone-labels');
  if (view.kind !== 'settings' || !box) return;
  const inputs = [...box.querySelectorAll('[data-phone-name]')], keys = [...orderedModels(), 'chatgpt|app', ...(state.windowsBrowser?['claude-chat|app']:[])];
  if (JSON.stringify(inputs.map(el => el.dataset.phoneName)) !== JSON.stringify(keys)) {
    // 候補が変わった時だけ組み直す。入力・保存中は次のpollまで待つ。
    if (inputs.length && (phoneLabelsSaving || box.contains(document.activeElement))) return;
    box.innerHTML = phoneLabelsHtml();
  } else {
    const full = phoneLabelMode() === 'full';
    for (const el of box.querySelectorAll('[data-phone-mode]')) el.checked = el.dataset.phoneMode === (full ? 'full' : 'short');
    for (const el of inputs) {
      el.disabled = full;
      if (el !== document.activeElement && !phoneLabelDrafts.has(el.dataset.phoneName)) el.value = state.phoneLabels?.names?.[el.dataset.phoneName] || '';
    }
    const status = box.querySelector('#phone-label-status');
    if (status) status.textContent = phoneLabelStatus();
  }
  renderedPhoneKey = phoneSettingsKey();
}
async function savePhoneLabels(spec) {
  if (spec.key) phoneLabelDrafts.set(spec.key, spec.name);
  phoneLabelQueue.push(spec);
  if (phoneLabelsSaving) { drawPhoneLabels(); return; }
  ++stateLoadEpoch; phoneLabelsSaving = true; phoneLabelsNotice = '';
  try {
    while (phoneLabelQueue.length) {
      phoneLabelActive = phoneLabelQueue.shift(); drawPhoneLabels();
      try {
        const r = await api('/api/models/phone', phoneLabelActive);
        state.phoneLabels = r.phoneLabels; syncChatPhoneLabels();
        if (phoneLabelActive.key && phoneLabelDrafts.get(phoneLabelActive.key) === phoneLabelActive.name) phoneLabelDrafts.delete(phoneLabelActive.key);
        phoneLabelErrors.delete(phoneLabelActive.key || 'mode');
        phoneLabelsNotice = L('スマホの表示を保存しました');
        toast(phoneLabelErrors.size ? [...phoneLabelErrors.values()].join(' ／ ') : phoneLabelsNotice);
      } catch (e) {
        const [key, model] = (phoneLabelActive.key || '').split('|');
        const item = key ? UI`${shortModelLabel(key === 'claude-code' ? 'claude' : key, model)} の名前` : L('AI一覧の名前の表示方法');
        phoneLabelErrors.set(phoneLabelActive.key || 'mode', UI`${item}は未保存です。保存できませんでした：${e.message}`);
        toast([...phoneLabelErrors.values()].join(' ／ '));
      }
      finally { phoneLabelActive = null; }
    }
  } finally { ++stateLoadEpoch; phoneLabelsSaving = false; drawPhoneLabels(); }
}
document.addEventListener('input', e => {
  if (e.target.dataset.phoneName) phoneLabelDrafts.set(e.target.dataset.phoneName, e.target.value);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.disabled) return;
  if (el.dataset.phoneMode) void savePhoneLabels({ labels: el.dataset.phoneMode });
  if (el.dataset.phoneName) void savePhoneLabels({ key: el.dataset.phoneName, name: el.value });
});
function renderSettings() {
  if (!rolesDraft) rolesDraft = JSON.parse(JSON.stringify(state.roles.roles));
  const models = state.roles.models;
  const opt = (list, v) => list.map(x => UI`<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const cell = (i, k, s) => UI`<div class="cfg">
      <select data-r="${i}" data-k="${k}" data-f="ai" aria-label="AI">${[...AIS.map(a=>AI_KEY[a]),'chatgpt','claude-chat','人'].map(a => UI`<option value="${a}" ${s.ai === a ? 'selected' : ''}>${a === '人' ? L('あなた') : AI_LABEL[canonicalActor(a)]}${webActor(a)?L('（手動引き継ぎ）'):a!=='人'&&!cliReady(a)?L('（まだ利用できません）'):''}</option>`).join('')}</select>
      ${s.ai === '人' ? '' : webActor(s.ai) ? UI`<span class="small">手動引き継ぎ。モデルは Web サイトで選びます。</span>` : UI`<select data-r="${i}" data-k="${k}" data-f="model" aria-label="モデル">${opt(shownModels(s.ai, s.model), s.model)}</select>
      <select data-r="${i}" data-k="${k}" data-f="effort" aria-label="思考">${opt(state.efforts, s.effort)}</select>`}</div>`;
  const dirty = JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles);
  $('#main').innerHTML = UI`<div class="view"><div class="settings">
    <div class="card"><h2>${window.HubI18n?.locale==='ja'?'表示言語':'介面語言'}</h2>
      <label>${window.HubI18n?.locale==='ja'?'言語':'語言'} <select id="hub-language" aria-label="${window.HubI18n?.locale==='ja'?'表示言語':'介面語言'}"><option value="zh-TW" ${window.HubI18n?.locale!=='ja'?'selected':''}>繁體中文（台灣）</option><option value="ja" ${window.HubI18n?.locale==='ja'?'selected':''}>日本語</option></select></label></div>
    <div class="card"><h2>作業画面</h2>
      <p><span class="badge ${state.terminal ? '' : 'off'}"><i></i>${state.windowsBrowser ? (state.terminal ? L('Windows 原生 Codex の会話と ConPTY ターミナル。Claude／Agy／Grok CLI は未検証。ChatGPT／Claude Chat は手動引き継ぎです。') : L('Codex の会話は利用できます。node-pty 原生部品がないため、ターミナルは開けません。')) : state.terminal ? L('画面の中で Claude Code / Codex / Agy CLI を動かせます') : L('部品（node-pty）が未設定です。ターミナルで setup.sh を実行してください。それまでは別の窓で開きます')}</span></p>
      <p>${state.windowsBrowser ? 'Codex 固定使用 workspace-write；設定檔中的權限命令不會覆蓋此限制。' : UI`権限：Claude Code は <code>${esc(state.roles.permissions['claude-code'] || '')}</code>、Codex は <code>${esc(state.roles.permissions.codex || '')}</code>`}</p></div>
    <div class="card"><h2>AI の更新</h2>
      <p>それぞれの AI を確認して更新します。Agy CLI は Gemini 3.1 Pro (High) の手動選択専用です。モデル一覧だけを読み直すこともできます。今使っているモデルや役割は自動では変わりません。</p>
      <div id="ai-tools" aria-live="polite">確認中…</div></div>
    <div class="card"><h2>選ぶ欄に出すモデル</h2>
      <p>会話・役割・ターミナルのモデルを選ぶ欄に出すかどうかを決めます。外しても、今そのモデルを使っている所はそのまま動きます。一覧は「AI の更新」で取り直した、今使えるモデルです。</p>
      <p>上から順に、会話などのモデルを選ぶ欄に並びます。［↑］［↓］で順番を変えられます。パソコンでは左の印をドラッグしても動かせます。役割の担当と今の選択は変わりません。</p>
      <div id="model-order-list">${modelOrderHtml()}</div>
      <div class="acts" style="margin-top:10px"><button class="btn plain" id="models-tidy" type="button">最新のモデルに整理する</button>
        <span class="small">役割で使っている古いモデル名（6sol など）を、同じ系統の一番新しいモデルに置き換え、roles.yaml の一覧も今のものにします。</span></div>
      <div id="tidy-result" class="small"></div></div>
    <div class="card"><h2>スマホの表示</h2>
      <p>スマホの会話でAIを選ぶ一覧の名前を変えます。設定はMacとiPhoneで共通です。保存は変更時に行います。</p>
      <div id="phone-labels">${phoneLabelsHtml()}</div></div>
    <div class="card"><h2>新しく始めるときのAI</h2>
      <p>新規プロジェクト・子作業・分岐の初期値です。役割の担当・既存作業・各プロジェクトで前回選んだ［始める］欄は変わりません。</p>
      <div id="initial-pick">${initialPickHtml()}</div></div>
    ${state.windowsBrowser ? UI`<div class="card"><h2>Windows 檔案存取</h2><p>Hub 以目前 Windows 使用者的權限讀取所選專案。Codex 執行仍需逐次核准工作區與已揭露的讀取、網路限制；此處不更改 Windows 系統權限。</p></div>` : UI`    <div class="card"><h2>Mac のファイルの許可</h2>
      <p>書類・デスクトップ・ダウンロードのフォルダを、Project Hub が読めるか確かめます。「システム設定 → プライバシーとセキュリティ → ファイルとフォルダ」に Project Hub が無い時は、［確認をもう一度出す］を押し、Mac の確認で「許可」を選んでください。</p>
      ${/ProjectHubApp/.test(navigator.userAgent) ? UI`<div class="acts"><a class="btn plain" href="hubapp://access">許可を確かめる</a><a class="btn" href="hubapp://access?reset=1">確認をもう一度出す</a></div>
      <p class="small">それでも出ない時は、確かめた後の画面の［フルディスクアクセスを開く］から、Project Hub をリストに入れてオンにしてください（アプリのメニューからも同じことができます）。</p>`
        : UI`<p class="small">アプリ（Project Hub.app）で開いた時に使えます。アプリが古い時は、ターミナルで <code>bash hub/app/build-app.sh</code> を実行して作り直してください。</p>`}</div>
`}
    <div class="card"><h2>外から使う（iPhone）</h2>
      <p>${state.windowsBrowser?'手機可透過已核對的 HTTPS 入口使用 Hub；實際操作由這台 Windows 主機執行。':'iPhone からも、Mac と同じ操作ができます。操作は接続先の Mac で実行されます。'}</p>
      <div id="remote-box" aria-live="polite">確認中…</div>
      ${state.windowsBrowser?UI`<details class="more"><summary>開始使用的步驟</summary><ol class="small"><li>核對 HTTPS 設定中的私有網路位址、DNS 名稱及憑證；連線裝置必須信任該憑證。</li><li>儲存至少 8 字元的通關密語，確認目標後再啟用 HTTPS 入口。</li><li>在手機瀏覽器開啟顯示的 HTTPS 網址，輸入通關密語。</li><li>系統憑證與防火牆仍須由管理者依實際網路規劃設定。</li></ol></details>`:UI`      <details class="more"><summary>使い始める手順</summary><ol class="small">
        <li>Mac と iPhone に Tailscale を入れ、同じアカウントでログインします。</li>
        <li><div>Mac のターミナルで <code>tailscale serve --bg 4545</code><button type="button" class="cp" data-copy="tailscale serve --bg 4545" title="コピー" aria-label="コピー">⧉ コピー</button> を1回だけ実行します。</div></li>
        <li>ここで合言葉（8文字以上）を保存し、「外から使う」をオンにします。</li>
        <li><div>iPhone の Safari で、上の「iPhone で開くアドレス」を開き、合言葉を入れます。<br>アドレスが出ていない時は、Mac のターミナルで <code>tailscale serve status</code><button type="button" class="cp" data-copy="tailscale serve status" title="コピー" aria-label="コピー">⧉ コピー</button> を実行します。1行目の <code>https://〜.ts.net</code> が開くアドレスです。</div></li>
        <li>共有メニューの「ホーム画面に追加」で、アプリのように開けます。</li></ol></details>`}</div>
    <div class="card"><h2>GitHub</h2><div id="github-box" aria-live="polite">確認中…</div></div>
    <div class="card"><h2>ChatGPT</h2>
      <p>ChatGPT アプリ（6pro など）に作業を頼めます。Hub は ChatGPT を動かせないので、貼る文を作り、返事を貼って戻します。</p>
      <p class="small"><b>使い方</b>：会話のモデル欄で「ChatGPT」を選んで依頼を書き［送る］→ 貼る文がコピーされる → ChatGPT アプリでモデルを選んで貼って送る → 返事をコピーして、作業画面の「② 返事を貼る」欄に貼り［Hub に戻す］（続きを Codex に作らせる時は［戻して Codex に続けさせる］）。貼る文には作業ファイル・台帳・最近の会話が入っているので、ChatGPT が自分で読みに行く必要はありません。</p>
      <details class="more"><summary>上級：ChatGPT アプリの中の Codex に Hub の道具をつなぐ（普段は不要）</summary>
        <div class="small">
        <p>普段の ChatGPT の会話は Mac の中の道具を使えません（確認済み）。ChatGPT アプリの中の Codex だけが <span class="path">~/.codex/config.toml</span> の道具を読めます。Codex から Hub の作業を読み書きさせたい時だけ登録してください。</p>
        <div id="chatgpt-box" aria-live="polite">確認中…</div>
        </div></details></div>
    <div class="card"><h2>空の作業を片付ける</h2>
      <p>Hub の会話が空のままの作業や子プロジェクト（AI が勝手に作った物など）を探して、まとめてゴミ箱へ移します。最初から選ばれているのは、派生・子プロジェクトの作業で「やったこと」も空の物だけです。</p>
      <div class="acts"><button class="btn plain" data-act="emptyscan" type="button">探す</button></div>
      <div id="empty-box">${emptyHtml()}</div></div>
    <div class="card"><h2>会話画面</h2>
      <label class="chk"><input type="checkbox" id="set-detail" ${showDetail() ? 'checked' : ''}> コマンドなど、AI の細かい作業も会話に出す</label>
      <label class="chk"><input type="checkbox" id="set-enter" ${enterSends() ? 'checked' : ''}> Enter だけで送る（改行は Shift + Enter。外すと今まで通り ⌘ + Enter）</label>
      <p class="small">出さない時も、作業中の印と返事はいつも通り出ます。モデル名を断られた時などの大事な知らせは、いつも出ます。</p></div>
    <div class="card"><h2>役割分担</h2>
      <p>役割ごとに、いつもの担当と上限の時の担当を決めます（AI・モデル・思考）。作業ごとに変えたい時は、作業画面の下で選べます。</p>
      <div class="tbl"><table><tr><th>役割</th><th>いつもの担当</th><th>上限の時</th><th>内容</th></tr>
      ${rolesDraft.map((r, i) => UI`<tr><td class="now">${esc(roleLabel(r.name))}</td><td>${cell(i, 'main', r.main)}</td><td>${cell(i, 'backup', r.backup)}</td><td class="job">${esc(BUILTIN_ROLES.includes(r.name)?L(r.job):r.job)}</td></tr>`).join('')}</table></div>
      <div class="acts" style="margin-top:12px"><button class="btn" id="roles-save" type="button" ${dirty ? '' : 'disabled'}>保存する</button>
        <button class="btn plain" id="roles-reset" type="button" ${dirty ? '' : 'disabled'}>元に戻す</button>
        <span class="${dirty ? 'dirty' : 'saved'}">${dirty ? L('変更があります（まだ保存していません）') : L('保存済み')}</span></div>
      <p class="small"><span id="model-catalog">選べるモデル：Claude Code は ${esc((models['claude-code'] || []).join(' / '))}、Codex は ${esc((models.codex || []).join(' / '))}。思考は ${esc(state.efforts.join(' → '))}。</span>保存先 <span class="path">${esc(state.root)}/_hub/roles.yaml</span></p></div>
    <div class="card"><h2>CLI に渡すモデル名</h2>
      <p>画面のモデルの呼び名を、Claude Code・Codex が受け付ける名前に直します。<b>空にすると、モデルを指定せず CLI の既定のモデルを使います。</b>モデル名が拒否された場合は理由を表示し、設定を勝手に変えません。</p>
      <div id="climodels" class="small">読み込み中…</div></div>
    <div class="card"><h2>バージョン</h2><p>今の版：<b>v${esc(state.version || '')}</b>${state.latest && state.latest !== state.version ? UI`（新しい版 v${esc(state.latest)} を取り込み済み。上の［新しい版にする］で切り替わります）` : ''}</p>
      ${state.windowsBrowser&&window.location?.protocol!=='https:'?'<button class="btn" data-act="nativerestart" type="button">重新啟動 Hub</button><p class="small">先停止工作流程並完成清理。只有驗證新程序身分後，介面才會重新連線。</p>':''}
      <details class="more" id="verd" ${verOpen ? 'open' : ''}><summary>変更の記録</summary><div id="verbox" class="small">読み込み中…</div></details></div>
    <div class="card"><details class="more" id="logd"><summary>最近の操作（記録）</summary><div id="logbox" class="small">読み込み中…</div></details></div>
  </div></div>`;
  renderedPhoneKey = phoneSettingsKey();
  drawAiTools(); loadAiTools();
  loadCliModels(); loadRemote(); loadChatgpt(); if (typeof loadGithub === 'function') loadGithub();
}
// ChatGPT：実作業（ファイルの書き換え・コマンド）を許すか
async function loadChatgpt() {
  const box = $('#chatgpt-box'); if (!box) return;
  try {
    const r = await api('/api/chatgpt');
    if ($('#chatgpt-box') !== box) return;
    if (state.windowsBrowser) {
      box.innerHTML = UI`<p class="small">為指定作業建立暫時 MCP 授權。同機使用與原版 Project Hub 一樣不需登入；任何本機程式都能操作 Hub，包括核准命令與讀寫檔案。MCP 憑證仍獨立受限；授權 10 分鐘、最多 100 次呼叫，停止 Hub 也會撤銷。</p>
        <label>專案 <select id="mcp-scope-project">${state.projects.map(p=>UI`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>作業 <select id="mcp-scope-task"></select></label>
        <label class="chk"><input type="checkbox" id="chatgpt-work" ${r.work ? 'checked' : ''}> 允許 MCP 檔案寫入及命令要求（另需指定作業授權；命令逐次核准）</label>
        <label>範圍 <select id="mcp-scope-access"><option value="read">讀取作業與對話</option><option value="report">讀取、回報結果與更新步驟</option><option value="files-read">加上讀取此作業檔案</option><option value="files-create" ${r.work ? '' : 'disabled'}>加上讀取、新增及依雜湊覆寫此作業檔案</option><option value="commands" ${r.work?'':'disabled'}>加上逐次核准的命令要求</option><option value="work-all" ${r.work?'':'disabled'}>此作業的檔案寫入及逐次核准命令</option></select></label>
        <div class="acts"><button class="btn" id="mcp-scope-issue" type="button">確認範圍並建立暫時授權</button><button class="btn plain" id="mcp-scope-revoke" type="button" hidden>撤銷此授權</button></div>
        <label class="chk"><input type="checkbox" id="mcp-delegate" ${r.work?'':'disabled'}> 另允許此作業委派以下 Codex 模型一次（會計入帳戶用量）</label><label>委派模型<select id="mcp-delegate-model">${(r.delegationModels||[]).map(row=>UI`<option value="${esc(row.id)}">${esc(row.label)} · ${esc(row.id)}</option>`).join('')}</select></label>
        <p class="small" id="mcp-scope-note"></p><div id="mcp-scope-output" hidden><textarea id="mcp-scope-config" rows="9" readonly aria-label="暫時 MCP 設定"></textarea><button class="btn plain" id="mcp-scope-copy" type="button">複製暫時 MCP 設定</button><button class="btn" id="mcp-register-preview" type="button">預覽暫時註冊至 Codex</button></div>
        <div id="mcp-register-review" hidden><h4>確認新增片段</h4><p class="small" id="mcp-register-meta"></p><textarea id="mcp-register-patch" rows="10" readonly aria-label="逐字 TOML 新增片段"></textarea><p class="small">片段寫入本使用者的全域 Codex 設定，其他同使用者 Codex client 也可能看見並使用此 MCP。工具仍限此 project／task／授權 run，呼叫數共同計算；沒有驗證唯一 app-server thread。只新增此片段，保留既有私人 MCP；Token 與設定備份使用目前 Windows 使用者的 DPAPI 加密，設定只保存加密檔路徑。權限仍在原期限／100 次呼叫／Hub 重啟後失效，撤權後舊 transport 也會被拒絕。Codex 或 ChatGPT 應用程式需要重新載入設定；寫入設定不代表已載入。使用者修改過的設定會保留並要求人工覆核。</p><label class="chk"><input type="checkbox" id="mcp-register-confirm"> 我已核對片段、設定檔位置、作業、共享 client 範圍與期限，確認新增暫時註冊</label><div class="acts"><button class="btn" id="mcp-register-apply" type="button" disabled>確認寫入</button><button class="btn plain" id="mcp-register-dismiss" type="button">取消預覽</button></div></div>
        <h4>暫時註冊與清理</h4><div id="mcp-registrations" aria-live="polite"></div>
        <p class="small">檔案授權只限已準備的 Git 工作複本，需原生 AMD64／Windows 26200／本機 NTFS；不接受連結。覆寫前會保存原檔；中斷需人工核對紀錄後復原。命令讀取範圍比工作區廣，且無完整斷網保證，每次執行前皆須確認。</p>
        <h4>命令核准與結果</h4><div id="command-intents" aria-live="polite"></div>`;
      const selectProject=$('#mcp-scope-project'),selectTask=$('#mcp-scope-task'),issue=$('#mcp-scope-issue'),revoke=$('#mcp-scope-revoke'),note=$('#mcp-scope-note'),output=$('#mcp-scope-output'),config=$('#mcp-scope-config');
      let grant=null;
      let registrationPreview=null;
      const review=$('#mcp-register-review'),patchBox=$('#mcp-register-patch'),applyRegistration=$('#mcp-register-apply'),confirmRegistration=$('#mcp-register-confirm');
      const clearRegistrationPreview=()=>{registrationPreview=null;review.hidden=true;patchBox.value='';confirmRegistration.checked=false;applyRegistration.disabled=true;};
      const loadRegistrations=async()=>{
        const target=$('#mcp-registrations');if(!target)return;
        try{const status=await api('/api/chatgpt/register/status');if($('#mcp-registrations')!==target)return;target.innerHTML=(status.error?UI`<p class="small">保留人工覆核：${esc(status.error)}</p>`:'')+(status.registrations||[]).filter(row=>row.phase!=='cleaned').map(row=>UI`<div class="small"><b>${esc(row.serverName)}</b> · ${esc(row.phase)} · 原期限 ${esc(new Date(row.expiresAt).toLocaleString())}<div class="acts"><button class="btn plain" type="button" data-mcp-cleanup="${esc(row.registrationId)}">撤權並清理此註冊</button>${row.recoveryRecordId?UI`<button class="btn plain" type="button" data-mcp-recover="${esc(row.registrationId)}">檢查已知交易並還原</button>`:''}</div>${row.manualReview?'設定或身分已變更；檔案保留，未自動覆寫。':''}</div>`).join('');if(!target.textContent.trim())target.textContent='尚無暫時註冊。';
          target.onclick=async event=>{const clean=event.target.dataset.mcpCleanup,recover=event.target.dataset.mcpRecover;if(!clean&&!recover)return;event.target.disabled=true;try{if(clean){const result=await api('/api/chatgpt/register/cleanup',{registrationId:clean,confirm:true});note.textContent=result.ok?'已撤銷授權並清理未變更的註冊；請重新載入 Codex 設定。':'授權已撤銷；設定已改變而保留，需人工覆核。';}else{const preview=await api('/api/chatgpt/register/recover/preview',{registrationId:recover});if(!confirm(`還原已知的不完整註冊交易？\n設定檔：${preview.configFile}\n目前 SHA-256：${preview.expectedHash}\n原始 SHA-256：${preview.beforeHash}\nFileID：${preview.fileFingerprint}\n交易：${preview.recordId}\n\n先撤銷授權，再以 DPAPI 備份還原；不同雜湊或 FileID 會拒絕。`))return;await api('/api/chatgpt/register/recover',{registrationId:recover,expectedHash:preview.expectedHash,confirm:true});note.textContent='已撤權並還原已知交易；請重新載入 Codex 設定。';}await loadRegistrations();}catch(error){note.textContent=error.message;}finally{event.target.disabled=false;}};
        }catch(error){target.textContent=error.message;}
      };
      $('#mcp-register-preview').onclick=async event=>{if(!grant)return;event.target.disabled=true;clearRegistrationPreview();try{const selected=grant,preview=await api('/api/chatgpt/register/preview',{capabilityId:selected.capability.id,runId:selected.capability.runId,token:selected.token});if(grant!==selected||$('#chatgpt-box')!==box)return;registrationPreview=preview;patchBox.value=preview.patch;$('#mcp-register-meta').textContent=`${preview.project}／${preview.task}；設定檔：${preview.configFile}；原設定 SHA-256：${preview.configHash}；新增片段 SHA-256：${preview.fragmentHash}；授權期限：${new Date(preview.grantExpiresAt).toLocaleString()}；此次預覽核准期限：${new Date(preview.expiresAt).toLocaleTimeString()}`;review.hidden=false;}catch(error){note.textContent=error.message;}finally{event.target.disabled=false;}};
      confirmRegistration.onchange=()=>{applyRegistration.disabled=!confirmRegistration.checked||!registrationPreview;};
      $('#mcp-register-dismiss').onclick=clearRegistrationPreview;
      applyRegistration.onclick=async()=>{if(!registrationPreview||!confirmRegistration.checked||patchBox.value!==registrationPreview.patch)return;applyRegistration.disabled=true;try{await api('/api/chatgpt/register',{token:registrationPreview.token,confirm:true});note.textContent='暫時註冊片段已寫入，Token 與備份以 DPAPI 加密。請重新載入 Codex／ChatGPT 設定；原授權期限與呼叫數仍有效。';clearRegistrationPreview();await loadRegistrations();}catch(error){note.textContent=error.message+(error.partial?'；可能部分完成，請檢查下方註冊與恢復狀態，勿自動重試。':'');clearRegistrationPreview();await loadRegistrations();}finally{applyRegistration.disabled=true;}};
      loadRegistrations();
      const tasks=()=>{const p=proj(selectProject.value);selectTask.innerHTML=(p?.tasks||[]).map(t=>UI`<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');issue.disabled=!(p?.tasks||[]).length;if(issue.disabled)note.textContent='先建立作業，再選擇 MCP 授權範圍。';};
      tasks();selectProject.onchange=tasks;
      issue.onclick=async()=>{
        const p=proj(selectProject.value),task=p?.tasks.find(t=>t.id===selectTask.value),access=$('#mcp-scope-access').value,write=['report','files-create','commands','work-all'].includes(access),files=['files-read','files-create','work-all'].includes(access),create=['files-create','work-all'].includes(access),commands=['commands','work-all'].includes(access);
        const delegate=$('#mcp-delegate').checked,delegationModel=$('#mcp-delegate-model').value;
        if(!task)return;
        if(typeof state.nodeExe!=='string'||!/^[a-z]:[\\/]/i.test(state.nodeExe)){note.textContent='無法確認 Hub 的 Node 執行檔，尚未建立授權。';return;}
        if(!['read','report','files-read','files-create','commands','work-all'].includes(access)||(create||commands)&&!r.work){note.textContent='先開啟檔案寫入／命令要求，再選擇明確的授權範圍。';return;}
        if(delegate&&(!r.work||!(r.delegationModels||[]).some(row=>row.id===delegationModel))){note.textContent='請先開啟實作權限並選擇有效的精確委派模型。';return;}
        if((files||commands||delegate)&&!task.workdir){note.textContent='先準備此作業的 Git 工作複本，再授權檔案、命令或委派。';return;}
        if(!confirm(`授權 MCP 連線${write?'讀取並回報結果／更新步驟':'讀取作業與對話'}：\n${p.name}／${task.title}${files?`\n檔案範圍：${task.workdir}\n${create?'可新增及依完整原檔 SHA-256 覆寫，保存原檔與交易紀錄。':'只讀取此作業檔案。'}`:''}${commands?`\n命令 cwd：${task.workdir}\n此授權只能提出命令要求，執行需另在 Hub 逐次核准。讀取範圍較工作區廣，無完整斷網保證。`:''}\n\n工具呼叫限此作業，10 分鐘或 100 次呼叫後失效。繼續？`))return;
        issue.disabled=true;
        try{
          if(grant)await api('/api/mcp/capability/revoke',{id:grant.capability.id,confirm:true});
          grant=null;output.hidden=true;revoke.hidden=true;config.value='';
          clearRegistrationPreview();
          const tools=['hub_list_tasks','hub_get_task','hub_get_chat',...(write?['hub_report','hub_ask_owner','hub_mark_step']:[]),...(files?['hub_read_file']:[]),...(create?['hub_write_file']:[]),...(commands?['hub_request_command','hub_get_command_result']:[]),...(delegate?['hub_delegate']:[])];
          if(delegate&&!confirm(`另授權 ${p.name}／${task.title} 委派 Codex 模型 ${delegationModel} 一次？\n\n作業內容、交接文字及相關對話可能送至 OpenAI 模型服務，並計入帳戶用量。只限此作業仍有效的工作區執行授權，不建立新作業，不使用其他 AI。`))return;
          const next=await api('/api/mcp/capability',{project:p.id,task:task.id,tools,confirm:true,expectedHash:task.completionHash,...(delegate?{delegationModel}:{})});
          if($('#chatgpt-box')!==box){await api('/api/mcp/capability/revoke',{id:next.capability.id,confirm:true});return;}
          grant=next;
          config.value=JSON.stringify({command:state.nodeExe,args:[state.hubDir.replace(/[\\/]$/,'')+'/mcp.js'],env:{HUB_MCP_PORT:String(new URL(location.href).port||4545),HUB_MCP_TOKEN:next.token,HUB_MCP_RUN_ID:next.capability.runId}},null,2);
          output.hidden=false;revoke.hidden=false;note.textContent=`已授權 ${p.name}／${task.title}，到期 ${new Date(next.capability.expiresAt).toLocaleString()}。設定只保留於此畫面，未寫入全域設定。`;
        }catch(error){note.textContent=error.message;}finally{issue.disabled=false;}
      };
      revoke.onclick=async()=>{if(!grant)return;revoke.disabled=true;try{await api('/api/mcp/capability/revoke',{id:grant.capability.id,confirm:true});grant=null;clearRegistrationPreview();config.value='';output.hidden=true;revoke.hidden=true;note.textContent='此 MCP 授權已撤銷。';}catch(error){note.textContent=error.message;}finally{revoke.disabled=false;}};
      $('#mcp-scope-copy').onclick=async()=>{if(!grant)return;try{await navigator.clipboard.writeText(config.value);note.textContent='已複製暫時設定；此授權仍受原作業、期限與呼叫數限制。';}catch{note.textContent='無法存取剪貼簿，請手動複製上方設定。';}};
      loadCommandIntents();
      return;
    }
    box.innerHTML = UI`<label class="chk"><input type="checkbox" id="chatgpt-work" ${r.work ? 'checked' : ''}> 実作業もできる（ファイルの書き換え・コマンドの実行を ChatGPT に許す）</label>
      <p class="small">${r.work ? UI`<b>オン：</b>ChatGPT が本体フォルダのファイルを書き換え、コマンドを実行できます。記録は「最近の操作」に残ります。` : L('オフ：ChatGPT は読む・報告する・質問する・作業を提案するだけです。')}</p>
      <div class="acts">${r.registered ? UI`<span class="saved">登録済み：ChatGPT アプリ（Codex）の設定に Hub の道具が入っています</span>` : UI`<button class="btn" id="chatgpt-register" type="button">ChatGPT アプリ（Codex）に登録する</button><span class="small">${r.configExists ? '' : L('設定ファイルはまだありません（作ります）')}</span>`}</div>
      <p class="small">設定ファイル：<span class="path">${esc(r.configFile || '')}</span></p>`;
  } catch (e) { if ($('#chatgpt-box') === box) box.textContent = L('読み込めませんでした'); }
}
document.addEventListener('click', async e => {
  if (e.target.id !== 'chatgpt-register') return;
  try { const r = await api('/api/chatgpt/register', {}); toast(r.added ? L('登録しました。ChatGPT アプリを開き直してください') : L('もう登録されています')); }
  catch (err) { toast(err.message); }
  loadChatgpt();
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'chatgpt-work') return;
  try { await api('/api/chatgpt', { work: e.target.checked }); toast(state.windowsBrowser ? (e.target.checked ? '已開啟檔案寫入與命令要求；仍需指定作業授權，命令逐次核准。' : '已關閉 MCP 檔案寫入，並取消命令要求。') : (e.target.checked ? L('ChatGPT に実作業も許しました') : L('ChatGPT は相談・レビューだけにしました'))); }
  catch (err) { toast(err.message); }
  loadChatgpt();
});
// 外から使う（iPhone）：設定を読み込んで出す・変える
async function loadCommandIntents() {
  const box=$('#command-intents');if(!box)return;
  let signature='',timer;
  const refresh=async()=>{
    if($('#command-intents')!==box)return;
    try{
      const data=await api('/api/commands');if($('#command-intents')!==box)return;
      const rows=data.intents||[],next=JSON.stringify(rows);
      if(next!==signature){signature=next;box.innerHTML=rows.length?rows.map(row=>UI`<div class="card small" data-command="${esc(row.id)}"><p><b>${esc(row.project)}／${esc(row.task)}</b> · ${esc(row.state)}${row.outcome?' · '+esc(row.outcome):''}</p><p>argv（JSON）</p><pre>${esc(JSON.stringify(row.argv,null,2))}</pre><p>cwd：${esc(row.cwd)}<br>作業 SHA-256：${esc(row.taskHash)}<br>工作區識別：${esc(row.rootFingerprint)}<br>逾時：${row.timeoutMs} ms；核准到期：${esc(new Date(row.expiresAt).toLocaleString())}</p>${row.state==='pending'?UI`<label class="chk"><input type="checkbox" data-command-ack="read"> 我了解讀取範圍較工作區廣，這項命令可讀取工作區外部分檔案。</label><label class="chk"><input type="checkbox" data-command-ack="network"> 我了解 networkAccess=false 無完整斷網保證，已確認本次命令的網路行為。</label><div class="acts"><button class="btn" data-command-action="approve" type="button">核准此次命令</button><button class="btn plain" data-command-action="decline" type="button">拒絕</button></div>`:['validating','running','canceling'].includes(row.state)?UI`<button class="btn plain" data-command-action="cancel" type="button" ${row.state==='canceling'?'disabled':''}>取消並等待程序退出</button>`:''}${row.result?UI`<pre>${esc(JSON.stringify(row.result,null,2).slice(0,16000))}</pre>${JSON.stringify(row.result).length>16000?'<p>畫面顯示前 16,000 字元；完整結果由同回合 MCP 讀取。</p>':''}`:''}</div>`).join(''):'<p class="small">目前沒有命令要求。</p>';
        box.onclick=async event=>{
          const button=event.target.closest('[data-command-action]'),card=button?.closest('[data-command]');if(!card)return;
          const row=rows.find(row=>row.id===card.dataset.command),action=button.dataset.commandAction;if(!row)return;
          const ackBroaderRead=card.querySelector('[data-command-ack="read"]')?.checked===true,ackNetworkLimits=card.querySelector('[data-command-ack="network"]')?.checked===true;
          if(action==='approve'&&(!ackBroaderRead||!ackNetworkLimits)){toast('請先逐項確認讀取及網路限制。');return;}
          if(!confirm(action==='approve'?`執行一次：\n${JSON.stringify(row.argv,null,2)}\ncwd：${row.cwd}\n\n核准不會擴大寫入根目錄，但讀取及網路有上述限制。`:`${action==='cancel'?'取消':'拒絕'}此命令要求？`))return;
          button.disabled=true;
          try{if(action==='cancel')await api('/api/commands/cancel',{id:row.id,confirm:true});else await api('/api/commands/decide',{id:row.id,decision:action,confirm:true,...(action==='approve'?{ackBroaderRead,ackNetworkLimits,argv:row.argv,cwd:row.cwd,expectedHash:row.taskHash,rootFingerprint:row.rootFingerprint}:{})});signature='';await refresh();}catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
        };
      }
    }catch(error){if($('#command-intents')===box)box.textContent=error.message;}
    clearTimeout(timer);if($('#command-intents')===box)timer=setTimeout(refresh,3000);
  };
  await refresh();
}

async function loadRemote() {
  const box = $('#remote-box'); if (!box) return;
  try {
    const r = await api('/api/remote');
    if ($('#remote-box') !== box) return;
    if(state.windowsBrowser){
      const tls=r.tls||{};
      box.innerHTML=UI`<p class="small">Windows HTTPS：${tls.running?'已啟動':r.enabled?'已設定啟用，但監聽未啟動':'已關閉'}${tls.error?' · '+esc(tls.error):''}</p><label class="chk"><input type="checkbox" id="remote-on" ${r.enabled?'checked':''} ${r.hasPasscode&&tls.configured?'':'disabled'}> 啟用已核對的 HTTPS 入口</label><p>${tls.url?UI`<a href="${esc(tls.url)}" target="_blank" rel="noopener">${esc(tls.url)}</a><br>綁定位址：${esc(tls.bindAddress)}<br>憑證 SHA-256：${esc(tls.certFingerprint)}<br>到期：${esc(tls.notAfter)}`:'尚未設定 HTTPS 憑證與綁定位址。'}</p><div class="acts"><input type="password" id="remote-pass" autocomplete="new-password" minlength="8" maxlength="200" placeholder="${r.hasPasscode?'新的登入通關密語':'登入通關密語（至少 8 字元）'}"><button class="btn plain" id="remote-pass-save" type="button">保存通關密語</button></div><p class="small">${r.sessions.length} 個已登入裝置；修改密語會撤銷原裝置登入。</p><button class="btn plain" id="remote-logout-all" type="button" ${r.sessions.length?'':'disabled'}>登出所有裝置</button><details class="more"><summary>核對 HTTPS 設定</summary><p class="small">填入精確私有網路位址、DNS 名稱及現有憑證。私鑰副本以目前使用者 DPAPI 保存；來源檔案仍可能被其他原生程序讀取。此操作不安裝憑證、不改來源 ACL、不開防火牆。憑證須已受連線裝置信任。</p><label>DNS 名稱<input id="tls-host" placeholder="hub.example.net"></label><label>綁定位址<input id="tls-bind" placeholder="100.x.x.x 或 LAN 私有 IPv4"></label><label>HTTPS 埠<input id="tls-port" type="number" min="1024" max="65535" value="4546"></label><label>PEM 憑證完整路徑<input id="tls-cert" placeholder="C:\\…\\certificate.pem"></label><label>未加密 PEM 私鑰完整路徑<input id="tls-key" placeholder="C:\\…\\private.key"></label><button class="btn plain" id="tls-preview" type="button" ${r.enabled?'disabled':''}>核對憑證及目標</button><div id="tls-review" class="small"></div></details>`;
      $('#tls-preview').onclick=async()=>{
        const button=$('#tls-preview'),review=$('#tls-review');button.disabled=true;
        try{const result=await api('/api/remote/tls/preview',{host:$('#tls-host').value.trim().toLowerCase(),bindAddress:$('#tls-bind').value.trim(),port:Number($('#tls-port').value),certFile:$('#tls-cert').value.trim(),keyFile:$('#tls-key').value.trim()});review.innerHTML=UI`<p>入口：${esc(result.origin)}<br>綁定：${esc(result.bindAddress)}<br>憑證：${esc(result.certSubject)}<br>SHA-256：${esc(result.certFingerprint)}<br>到期：${esc(result.notAfter)}</p><p>${esc(result.keyReadRisk)}</p><button class="btn" id="tls-confirm" type="button">保存此次已核對設定（維持關閉）</button>`;
          $('#tls-confirm').onclick=async()=>{if(!confirm(`保存 HTTPS 設定：\n${result.origin}\n綁定 ${result.bindAddress}\n憑證 ${result.certFingerprint}\n\n${result.keyReadRisk}\n\n另須明確勾選啟用，才會監聽此位址。`))return;$('#tls-confirm').disabled=true;try{await api('/api/remote/tls/configure',{token:result.token,origin:result.origin,certFingerprint:result.certFingerprint,confirm:true});toast('HTTPS 設定已保存，入口仍關閉。');await loadRemote();}catch(error){toast(error.message);}};
        }catch(error){review.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}
      };
      return;
    }
    box.innerHTML = UI`<label class="chk"><input type="checkbox" id="remote-on" ${r.enabled ? 'checked' : ''} ${r.hasPasscode ? '' : 'disabled'}> 外から使う${r.hasPasscode ? '' : L('（先に合言葉を保存してください）')}</label>
      <div class="acts" style="margin-top:8px"><input type="password" id="remote-pass" autocomplete="new-password" minlength="8" maxlength="200" placeholder="${r.hasPasscode ? L('新しい合言葉（8文字以上）') : '合言葉（8文字以上）'}">
        <button class="btn plain" id="remote-pass-save" type="button">合言葉を保存</button></div>
      <p class="small">${r.hasPasscode ? L('合言葉は保存済みです。変えると、入っている端末はすべて出ます。') : L('まだ合言葉がありません。')}</p>
      <p>iPhone で開くアドレス：${r.url ? UI`<b>${esc(r.url)}</b><button type="button" class="cp" data-copy="${esc(r.url)}" title="コピー" aria-label="コピー">⧉ コピー</button>` : UI`<span class="small">見つかりません（Tailscale が動いていないか、Mac に入っていません。下の「使い始める手順」を見てください）</span>`}</p>
      <div class="acts"><span>ログイン中の端末：${r.sessions.length} 台</span>
        <button class="btn plain" id="remote-logout-all" type="button" ${r.sessions.length ? '' : 'disabled'}>すべての端末から出る</button></div>
`;
  } catch (e) { if ($('#remote-box') === box) box.textContent = L('読み込めませんでした'); toast(e.message); }
}
document.addEventListener('click', async e => {
  const id = e.target.id;
  if (id !== 'remote-pass-save' && id !== 'remote-logout-all') return;
  try {
    if (id === 'remote-pass-save') {
      const v = $('#remote-pass').value;
      if ([...v].length < 8) return toast(L('合言葉は8文字以上にしてください'));
      await api('/api/remote', { passcode: v }); toast(L('合言葉を保存しました'));
    } else { await api('/api/remote/logout-all', {}); toast(L('すべての端末から出ました')); }
  } catch (err) { toast(err.message); }
  loadRemote();
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'remote-on') return;
  try { if(state.windowsBrowser&&e.target.checked){const status=await api('/api/remote');if(!confirm(`啟用 HTTPS 入口：\n${status.tls?.url||''}\n綁定 ${status.tls?.bindAddress||''}\n\n可連線裝置仍須登入通關密語。本機管理與 MCP 核准 API 不提供遠端存取。`)){e.target.checked=false;return;}} await api('/api/remote', { enabled: e.target.checked }); toast(e.target.checked ? L('外から使えるようにしました') : L('外からの利用をオフにしました')); }
  catch (err) { toast(err.message); }
  loadRemote();
});
// CLI に渡すモデル名：読み込んで表にする・保存する
let cliModelsLoadSeq = 0;
async function loadCliModels(keepDraft = false) {
  const box = $('#climodels'); if (!box) return;
  const seq = ++cliModelsLoadSeq;
  try {
    const r = await api('/api/cli-models');
    if ($('#climodels') !== box || seq !== cliModelsLoadSeq) return;
    const draft = new Map();
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => draft.set(`${el.dataset.ai}/${el.dataset.name}`, el.value));
    const table = ai => UI`<div class="tbl"><table><tr><th>${AI_LABEL[ai]}</th><th>CLI に渡す名前</th></tr>${(r[ai] || []).map(x => UI`<tr><td class="now">${esc(x.name)}</td><td><input class="cm" data-ai="${ai}" data-name="${esc(x.name)}" value="${esc(x.flag)}" list="hint-${ai}" placeholder="（空＝${AI_LABEL[ai]} の既定のモデル）" maxlength="60"></td></tr>`).join('')}</table></div>
      <datalist id="hint-${ai}">${(r.hints[ai] || []).map(h => UI`<option value="${esc(h)}">`).join('')}</datalist>`;
    box.innerHTML = UI`${table('claude')}${table('codex')}${table('grok')}<p>Agy CLI：Gemini 3.1 Pro (High) → <code>gemini-3.1-pro-high</code>（承認されたモデルに固定）</p>
      ${(r.hints.codex || []).length ? UI`<p class="small">Codex の設定で見つかった名前：${r.hints.codex.map(esc).join('、')}</p>` : ''}
      <div class="acts" style="margin-top:10px"><button class="btn" id="cm-save" type="button">保存する</button></div>`;
    if (keepDraft) document.querySelectorAll('input.cm').forEach(el => { const key = `${el.dataset.ai}/${el.dataset.name}`; if (draft.has(key)) el.value = draft.get(key); });
  } catch (e) { box.textContent = L('読み込めませんでした'); }
}
document.addEventListener('click', async e => {
  if (e.target.id !== 'cm-save') return;
  const o = { claude: {}, codex: {},grok:{} };
  document.querySelectorAll('input.cm').forEach(i => { o[i.dataset.ai][i.dataset.name] = i.value.trim(); });
  try { await api('/api/cli-models', o); toast(L('モデル名を保存しました（次に送る時から使います）')); loadCliModels(); } catch (err) { toast(err.message); }
});
// 版の表示と［新しい版にする］。どの画面にいても、30秒ごとに確かめる
function showVersion(version, latest) {
  $('#ver').textContent = version ? 'v' + version : '';
  const newer = latest && version && latest !== version;
  if ($('#upd').disabled) return; // 切り替え中
  $('#upd').hidden = !newer;
  if (newer) $('#upd').textContent = UI`新しい版 v${latest} にする`;
}
let verOpen = false;
async function loadChangelog() {
  const box = $('#verbox'); if (!box) return;
  try {
    const rows = await api('/api/changelog');
    box.innerHTML = UI`<ul class="log">${rows.map(r => UI`<li><b>v${esc(r.version)}</b> <span class="small">${esc(r.date)}</span><ul>${r.items.map(x => UI`<li>${esc(x)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
  } catch (e) { box.textContent = L('読み込めませんでした'); }
}
// 新しい版にする：本体を起動し直し、戻ってきたら画面を読み直す
async function restartHub() {
  if(window.HubNativeRestart?.paused||$('#upd').disabled)return;
  const b = $('#upd'); b.disabled = true; b.textContent = L('切り替えています…');
  document.querySelectorAll('[data-act="nativerestart"]').forEach(button=>{button.disabled=true;});
  try { if(state.windowsBrowser){window.HubNativeRestart.broadcastPause();const result=await api('/api/restart',{});await window.HubNativeRestart.begin(result);location.reload();return;} await api('/api/restart', {}); }
  catch (e) { if(state.windowsBrowser&&e.notStarted===true&&['busy','preflight'].includes(e.stage)){window.HubNativeRestart.broadcastResumePreflight(e);location.reload();return;}toast(e.message); b.disabled = false; render(); return; }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const s = await api('/api/state'); if (s.version === s.latest) { location.reload(); return; } } catch (e) { /* まだ */ }
  }
  toast(L('切り替わりませんでした。アプリを開き直してください'));
}
const ACTION = { githubcreate: 'GitHubの非公開リポジトリ作成を実行した', emptytrash: '空の作業を片付けた', chatredo: '取り消してやり直した', chatamend: '追加説明を送った', chatqueue: '順番待ちにした', climodels: 'モデル名を直した', refs: '参考を足した', restart: '新しい版にした', chat: '会話で頼んだ', newproject: 'プロジェクトを作った', start: '始めた', stop: '止めた', handoff: '交代した', upload: 'ファイルを渡した', switch: 'モデル・思考を変えた', merge: '本体に取り込んだ', mergeexclude: '取り込み対象から外した', mergeinclude: '取り込み対象に戻した', nextphase: '次のフェーズへ', projectdone: 'プロジェクトを完了にした', projectreopen: 'プロジェクトの完了を取り消した', newtask: '作業を足した', chatgpt: 'ChatGPT が道具を使った', chatgptwork: 'ChatGPT の実作業の設定を変えた' };
async function loadLog() {
  const box = $('#logbox'); if (!box) return;
  try {
    const rows = await api('/api/log?n=30');
    box.innerHTML = rows.length ? UI`<ul class="log">${rows.map(r => UI`<li><span class="small">${esc(new Date(r.at).toLocaleString(document.documentElement?.lang==='ja'?'ja-JP':'zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span> ${esc(r.project || '')}${r.task ? L('・') + esc(r.task) : ''}：${esc(L(ACTION[r.action] || r.action))}${r.ai ? `（${esc(AI_LABEL[r.ai] || r.ai)}）` : ''}${r.action === 'merge' && r.conflict ? L('・ぶつかったので中止') : ''}</li>`).join('')}</ul>` : UI`<p class="note">まだありません。</p>`;
  } catch (e) { box.textContent = L('読み込めませんでした'); }
}
async function saveRoles() {
  try { state.roles = await api('/api/roles', { roles: rolesDraft }); rolesDraft = null; toast(L('役割分担を保存しました')); render(); }
  catch (e) { toast(e.message); }
}

// 空の作業を片付ける：探した結果（画面を描き直しても残す）
let emptyFound=null,emptySelected=null,emptyBlocked=[],emptyHistory=[],emptyReview=null,emptyPending=false,emptyNotice='';
function emptyNative(){return Boolean(state.windowsBrowser);}
function emptyMoveText(paths,reverse=false){if(!Array.isArray(paths)||paths.some(p=>!p||typeof p.from!=='string'||typeof p.to!=='string'||!/^[a-f0-9]{64}$/.test(p.objectId||'')||!/^[a-f0-9]{64}$/.test(p.treeHash||'')))throw Error(L('移動範圍或完整 FileID／目錄 SHA-256 缺漏，請重新預覽'));return paths.map(p=>(reverse?p.to:p.from)+' → '+(reverse?p.from:p.to)+'\nFileID: '+p.objectId+'\nTree SHA-256: '+p.treeHash).join('\n\n');}
function emptyMoveHtml(paths){emptyMoveText(paths);return paths.map(p=>UI`<p class="small">${esc(p.from)} → ${esc(p.to)}<br>FileID：<code>${esc(p.objectId)}</code><br>Tree SHA-256：<code>${esc(p.treeHash)}</code></p>`).join('');}
function emptyHistoryLabel(value){switch(value){case'complete':return L('已完整移動');case'partial':return L('批次尚未完成');case'restored':return L('已還原');case'mixed-restored':return L('部分已還原，禁止續作');case'running':return L('執行紀錄待檢查');default:return L('等待核准');}}
function emptyHtml(){
  if(!emptyFound&&!emptyHistory.length&&!emptyBlocked.length)return '';
  const locked=emptyPending||Boolean(emptyReview),row=(x,key,label,sub)=>UI`<label class="chk"><input type="checkbox" data-key="${esc(key)}" ${(emptySelected?emptySelected.has(key):x.pick)?'checked':''} ${locked?'disabled':''}> ${label}${sub?UI`<span class="small">　${sub}</span>`:''}</label>`;
  const found=(emptyFound||[]).length?(emptyFound||[]).map(x=>x.whole?row(x,x.project+'/',UI`<b>子プロジェクトごと</b>：${esc(x.projectName)}`,UI`作業 ${x.tasks.length} 件・すべて会話が空`):row(x,x.project+'/'+x.task,`${esc(x.projectName)} / ${esc(x.title)}`,`${esc(STATES.includes(x.state)?L(x.state):x.state)}${x.done?L('・やったこと：')+esc(x.done.replace(/\s+/g,' ').slice(0,80)):''}`)).join('')+(emptyNative()?UI`<div class="acts"><button class="btn plain sm" data-act="emptyall" data-on="1" type="button" ${locked?'disabled':''}>すべて選ぶ</button><button class="btn plain sm" data-act="emptyall" data-on="0" type="button" ${locked?'disabled':''}>すべて外す</button><button class="btn" data-act="emptytrash" type="button" ${locked?'disabled':''}>預覽所選空作業的原生移動範圍</button></div>`:UI`<div class="acts"><button class="btn plain sm" data-act="emptyall" data-on="1" type="button">すべて選ぶ</button><button class="btn plain sm" data-act="emptyall" data-on="0" type="button">すべて外す</button><button class="btn" data-act="emptytrash" type="button">選んだ物をゴミ箱へ</button></div>`):UI`<p class="small">片付ける物はありません。</p>`;
  const blocked=emptyBlocked.length?UI`<details open><summary>無法確認為空的項目</summary>${emptyBlocked.map(x=>`<p class="small">${esc(x.project)}${x.task?' / '+esc(x.task):''}：${esc(x.reason)}</p>`).join('')}</details>`:'';
  const review=emptyReview?UI`<section class="card"><h4>${emptyReview.resume?L('重新核准未完成的同一批次'):L('核准此次空作業批次')}</h4><p>以下順序及每個來源、目的地、FileID、目錄 SHA-256 已綁定此次預覽。核准憑證兩分鐘內有效且只能使用一次；內容或身分改變會停止。移動與整棵內容雜湊不是單一原子交易。</p><p>批次紀錄：<code>${esc(emptyReview.id)}</code></p>${emptyReview.items.map(i=>UI`<details open><summary>${esc(i.title)} · ${esc(i.project)}${i.task?' / '+esc(i.task):''}</summary>${emptyMoveHtml(i.paths)}</details>`).join('')}<p>部分失敗時會保留紀錄並停止剩餘項目。移動數為完整驗證項目數，不代表部分項目的檔案未變動。還原後不得續作舊批次。</p><div class="acts"><button class="btn plain" data-act="emptycancel" type="button" ${emptyPending?'disabled':''}>取消此次核准</button><button class="btn" data-act="emptyconfirm" type="button" ${emptyPending?'disabled':''}>核准此精確範圍並移至可復原區</button></div></section>`:'';
  const history=emptyNative()&&emptyHistory.length?UI`<details open><summary>批次紀錄與恢復</summary><p>整個專案還原時，先還原父專案，再還原子專案。已還原的項目不能用舊批次續作；檔案身分或內容改變會拒絕。</p>${emptyHistory.map(r=>UI`<section class="card"><b>${esc(emptyHistoryLabel(r.currentState||r.state))}</b> · <code>${esc(r.id)}</code><p>${esc(r.error||'')}</p>${r.state==='partial'&&!['restored','mixed-restored'].includes(r.currentState)?UI`<button class="btn plain" data-act="emptyresume" data-record="${esc(r.id)}" type="button" ${emptyPending?'disabled':''}>檢查同一批次並重新核准續作</button>`:''}${r.items.slice().reverse().map(i=>UI`<details><summary>${esc(i.title)} · 個別還原紀錄 <code>${esc(i.removalId)}</code></summary>${emptyMoveHtml(i.paths)}${(r.currentState||r.state)==='restored'?'':UI`<button class="btn plain" data-act="emptyrestore" data-record="${esc(r.id)}" data-removal="${esc(i.removalId)}" type="button" ${emptyPending?'disabled':''}>核對此項目並還原</button>`}</details>`).join('')}</section>`).join('')}</details>`:'';
  return found+blocked+review+history+UI`<p id="empty-status" class="note" role="status">${esc(emptyNotice)}</p>`;
}
async function emptyRefresh(){const result=await api('/api/empty/scan',{});emptyFound=result.items;emptyBlocked=Array.isArray(result.blocked)?result.blocked:[];emptyHistory=Array.isArray(result.history)?result.history:[];$('#empty-box').innerHTML=emptyHtml();}
async function emptyAct(el){const action=el.dataset.act;if(emptyPending)return;
  if(action==='emptyall'){if(emptyReview)return;document.querySelectorAll('#empty-box input[type=checkbox]').forEach(i=>{i.checked=el.dataset.on==='1';});emptySelected=new Set([...document.querySelectorAll('#empty-box input:checked')].map(i=>i.dataset.key));return;}
  if(action==='emptycancel'){emptyReview=null;emptyNotice=L('已取消此次核准，未送出移動請求');$('#empty-box').innerHTML=emptyHtml();return;}
  emptyPending=true;el.disabled=true;let applied=false;
  try{
    if(action==='emptyscan'){emptyReview=null;emptySelected=null;emptyNotice='';await emptyRefresh();return;}
    if(action==='emptyresume'){emptyReview=await api('/api/empty/preview',{record:el.dataset.record});emptyReview.items.forEach(i=>emptyMoveText(i.paths));emptyNotice=L('已核對舊批次，請檢查下方精確範圍後重新核准');return;}
    if(action==='emptytrash'){
      const keys=[...document.querySelectorAll('#empty-box input:checked')].map(i=>i.dataset.key);if(!keys.length){toast(L('選ばれていません'));return;}emptySelected=new Set(keys);if(keys.length>100&&emptyNative())throw Error(L('一次最多選取 100 項空作業'));
      const items=keys.map(k=>{const i=k.indexOf('/');return{project:k.slice(0,i),task:k.slice(i+1)||undefined};});
      if(emptyNative()){emptyReview=await api('/api/empty/preview',{items});emptyReview.items.forEach(i=>emptyMoveText(i.paths));emptyNotice=L('移動尚未執行，請檢查下方精確範圍並核准');return;}
      if(!confirm(UI`${keys.length} 件をゴミ箱へ移しますか？（ゴミ箱から戻せます）`))return;const r=await api('/api/empty/trash',{items});emptyFound=null;toast(UI`${r.moved} 件をゴミ箱へ移しました`);await load();return;
    }
    if(action==='emptyconfirm'){
      const preview=emptyReview;if(!preview||typeof preview.token!=='string'||!preview.token)throw Error(L('請重新預覽空作業批次'));preview.items.forEach(i=>emptyMoveText(i.paths));
      if(!confirm(L('核准畫面列出的精確批次順序、來源、目的地、FileID 與完整目錄 SHA-256，並移至可復原區？')))return;
      emptyReview=null;applied=true;const result=await api('/api/empty/trash',{token:preview.token,confirm:true});if(result.ok!==true||result.complete!==true)throw Error(L('批次未確認完整，請檢查交易紀錄；勿直接重送'));emptyNotice=L('批次已完整驗證並移動；可從紀錄逐項還原');await emptyRefresh();await load();return;
    }
    if(action==='emptyrestore'){
      const batch=emptyHistory.find(r=>r.id===el.dataset.record),item=batch?.items.find(i=>i.removalId===el.dataset.removal);if(!item)throw Error(L('找不到已核對的個別還原紀錄，請重新搜尋'));
      if(!confirm(L('還原此已核對的個別紀錄？整個專案需先還原父專案。同名目標不覆寫；目前 FileID 與內容需符合原生紀錄。')+'\n\n'+emptyMoveText(item.paths,true)))return;
      emptyReview=null;applied=true;const result=await api('/api/hierarchy/remove/restore',{record:item.removalId,confirm:true});if(result.ok!==true)throw Error(L('還原尚未確認完成，請人工檢查紀錄'));emptyNotice=L('個別還原已完成；已還原的舊批次不會重新執行');await emptyRefresh();await load();
    }
  }catch(error){emptyReview=null;emptyNotice=(applied?L('操作未確認完整；請檢查紀錄，不自動重試。')+' ':'')+error.message;toast(emptyNotice);if(applied)try{await emptyRefresh();}catch(refreshError){emptyNotice+=' '+L('無法重新取得紀錄：')+refreshError.message;}}
  finally{emptyPending=false;el.disabled=false;$('#empty-box').innerHTML=emptyHtml();}
}

// ---- 操作 ----
async function act(el) {
  const a = el.dataset.act, p = el.dataset.p || view.project, t = el.dataset.t;
  try {
    if (a === 'start') await startAI(p, t, el.dataset.ai);
    else if (a === 'workspaceclose') await closeNativeWorkspace(p,t,el);
    else if (a === 'termwindow') openTerminalWindow(p, t, el.dataset.ai);
    else if (a === 'nativerestart') await restartHub();
    else if (a === 'termclaim') {
      const controller = panes[el.dataset.ai]?.controller;
      if (!controller) throw Error('終端機尚未連線，請重新開啟作業畫面');
      if (!confirm('將此會話的輸入與尺寸控制移轉到目前視窗？其他視窗會繼續觀看。')) return;
      await controller.claim(true); panes[el.dataset.ai].fit.fit(); await controller.resize(panes[el.dataset.ai].xterm.cols, panes[el.dataset.ai].xterm.rows); panes[el.dataset.ai].xterm.focus();
    }
    else if (a === 'stop') { await api('/api/term/stop', { project: p, task: t, ai: el.dataset.ai }); toast(L('止めました')); await load(); }
    else if (a === 'handoff') {
      requireCliReady(el.dataset.to,'terminal');
      el.disabled = true;
      try {
        const r = await api('/api/term/handoff', { project: p, task: t, from: el.dataset.from, to: el.dataset.to, cols: 100, rows: 30 });
        toast(UI`${r.started ? UI`${AI_LABEL[el.dataset.to]} を始め、` : UI`${AI_LABEL[el.dataset.to]} に`}引き継ぎ資料を渡しました${r.kind === 'screen' ? L('（会話の記録が読めず、画面の文字で代わりにしました）') : ''}`);
      } finally { await load(); }
    }
    else if (a === 'files') await openFiles(el);
    else if (a === 'mode') setMode(el.dataset.m);
    else if (a === 'split') splitProject(proj(p));
    else if (a === 'handoff-parent') {
      const r = await api('/api/project/handoff', { project: p });
      toast(UI`親「${r.parent || ''}」の作業に結果を書き込みました`); await load();
    }
    else if (a === 'pstatus') {
      const done = el.dataset.s === '完了';
      if (done && !confirm(L('このプロジェクトを完了にしますか？（あとで［完了を取り消す］で戻せます）'))) return;
      await api('/api/project/status', { project: p, status: el.dataset.s, confirm: true, expectedHash: proj(p).completionHash }); toast(done ? L('プロジェクトを完了にしました') : L('完了を取り消しました')); await load();
    }
    else if (a === 'nextphase') {
      const info = phaseInfo(proj(p));
      if (!confirm(info.cur === info.list.length - 1 ? L('最後のフェーズとプロジェクトを完了に移しますか？') : L('今のフェーズを完了に移して、次へ進みますか？'))) return;
      await api('/api/phase/next', { project: p, confirm: true, expectedHash: proj(p).completionHash }); toast(L('フェーズを完了にしました')); await load();
    }
    else if (a === 'phasecontinue') { await api('/api/phase/continue', { project: p, expectedHash: proj(p).completionHash }); toast(L('このフェーズを続けます')); await load(); }
    else if (a === 'taskcomplete' || a === 'taskcontinue') {
      if (a === 'taskcomplete' && !confirm(L('この作業を完了に移しますか？あとで再開できます。'))) return;
      await api('/api/task/completion', { project: p, task: t, action: a === 'taskcomplete' ? 'approve' : 'continue', confirm: true, expectedHash: taskOf(proj(p), t).completionHash }); toast(a === 'taskcomplete' ? L('完了に移しました') : L('この作業を続けます')); await load();
    }
    else if (a === 'mergeexclude' || a === 'mergeinclude') {
      const excluded = a === 'mergeexclude';
      if (excluded && !confirm(L('本体に取り込まず、取り込み対象から外しますか？作業用コピーとファイルは残り、同じ場所で作業を続けられます。あとで［取り込み対象に戻す］で戻せます。'))) return;
      el.disabled = true;
      try {
        await api('/api/task/merge-exclusion', { project: p, task: t, excluded });
        toast(excluded ? L('取り込み対象から外しました。作業用コピーは残しています') : L('取り込み対象に戻しました'));
      } finally { await load(); }
    }
    else if (['emptyscan','emptyall','emptytrash','emptyconfirm','emptycancel','emptyresume','emptyrestore'].includes(a)) await emptyAct(el);
    else if (a === 'gptcopy') { const b = el.closest('.gptbox'), P = proj(b.dataset.p); await gptAsk(P, taskOf(P, b.dataset.t)); }
    else if (a === 'webchat') { if(!manualReady(el.dataset.actor))throw Error(L('手動引き継ぎを利用できません。設定と状態を確認してください。')); const box=el.closest('.gptbox'); if(chatImages(box.dataset.p,box.dataset.t).length || chatImageUploads.get(chatAttachmentKey(box.dataset.p,box.dataset.t)))throw Error(L('添付画像を外してから手動引き継ぎを準備してください。画像は Web サイトで選びます。')); await window.HubWebChat.open({actor:el.dataset.actor,project:box.dataset.p,task:box.dataset.t,text:$('#chat-in')?.value||'',api,refresh:()=>load()}); }
    else if (a === 'gptclose') { // ChatGPT をやめる：緑の欄を閉じ、担当とモデル欄を元の AI に戻す
      const b = el.closest('.gptbox'), P = b.dataset.p, T = b.dataset.t, key = P + '/' + T, task = taskOf(proj(P), T);
      let prev = ''; try { prev = localStorage.getItem('hub-gpt-prev-' + key) || ''; localStorage.removeItem('hub-gpt-prev-' + key); localStorage.removeItem('hub-chat-' + key); } catch (e) { /* 無視 */ }
      if (task && ownerOf(task.owner).kind === 'chatgpt') await api('/api/task', { project: P, task: T, owner: prev && !/^chatgpt$/i.test(prev) ? prev : 'claude-code' });
      $('#gpt-clip')?.remove(); await load(); render();
    }
    else if (a === 'gptclipoff') $('#gpt-clip')?.remove();
    else if (a === 'handup') await showTaskTransfer(p,t,[],el.dataset.expectTitle);
    else if (a === 'integrate') await showTaskIntegration(p,t);
    else if (a === 'absorb') {
      const legacy=(state.taskHandoffs || []).some(r=>r.project===p&&r.task===t);
      if(legacy)await showTaskTransfer(p,t,[],el.dataset.expectTitle);
      else await showTaskIntegration(view.project,view.task,[{project:p,task:t,expectTitle:el.dataset.expectTitle}]);
    }
    else if (a === 'gptback') {
      const b = el.closest('[data-p][data-t]'), P = b.dataset.p, T = b.dataset.t, box = b.querySelector('.gpt-back');
      const text = (box ? box.value : gptDraft[P + '/' + T] || '').trim();
      if (!text) { toast(L('ChatGPT の返事を貼ってください')); box && box.focus(); return; }
      await api('/api/chatgpt/result', { project: P, task: T, text }); delete gptDraft[P + '/' + T];
      document.querySelectorAll('.gpt-back').forEach(x => { if (x.closest('.gptbox')?.dataset.t === T) x.value = ''; }); $('#gpt-clip')?.remove();
      if (el.dataset.next === 'codex') { // 担当を Codex に戻し、ChatGPT の返事（会話に残した）をもとに続きを頼む
        const task = proj(P).tasks.find(x => x.id === T), sp = specOf(task, 'codex');
        const model = sp.model || (state.roles.models.codex || [])[0];
        await api('/api/task', { project: P, task: T, owner: 'codex' });
        try { localStorage.setItem('hub-chat-' + P + '/' + T, JSON.stringify({ ai: 'codex', model, effort: sp.effort || '高' })); } catch (e) { /* 無視 */ }
        await api('/api/chat/send', { project: P, task: T, ai: 'codex', model, effort: sp.effort || '高', text: 'すぐ上の ChatGPT の返事をもとに、この作業の続きをしてください。' });
        toast(L('ChatGPT の返事を残し、Codex に続きを頼みました'));
      } else toast(L('ChatGPT の返事を会話に残しました'));
      await load();
    }
    else if (a === 'copyclear') { const r = await api('/api/task/copyclear', { project: p, task: t }); toast(r.merged ? L('本体に取り込み済みでした。記録を片付けたので、続きは本体で始められます') : L('記録を片付けました。続きは本体で始められます')); await load(); }
    else if (a === 'merge') {
      el.disabled = true;
      try {
        let body = { project: p, task: t };
        if (state.windowsBrowser) {
          const preview = await api('/api/task/merge/preview', body);
          const execution = preview.gitExecution || {};
          if (execution.blockers?.length) { toast(execution.blockers.join(' / ')); return; }
          const source = preview.source || {}, target = preview.target || {};
          const text = [preview.resume ? '恢復這筆合併交易？' : '確認將此工作複本合併至本體？',
            preview.action || '', `來源：${source.head || '已退避'}\n本體：${target.head || ''}`,
            `來源內容 SHA-256：${source.content || '已退避'}\n本體內容 SHA-256：${target.content || ''}`,
            `變更檔案：${preview.files ?? '需確認'}；新增 ${preview.added ?? 0} 行、刪除 ${preview.removed ?? 0} 行`,
            (preview.paths || []).length ? '變更路徑：\n' + preview.paths.join('\n') : '',
            (preview.notStagedSecrets || []).length ? '依檔名規則不加入 Git 的新增檔案：\n' + preview.notStagedSecrets.join('\n') : '',
            preview.dirty ? '目前的未提交變更也在此次預覽與保存範圍內。' : '',
            preview.conflictUnknown ? '衝突預演只檢查已提交內容；未提交內容已綁定本次確認，保存後仍可能衝突。' : '',
            preview.conflict ? '預演發現衝突；請先處理衝突。' : '',
            preview.recordId ? `交易：${preview.recordId}；狀態：${preview.state || ''}` : ''].filter(Boolean).join('\n\n');
          if (preview.conflict || !confirm(text)) return;
          body = { ...body, token: preview.token, confirm: true };
          if (execution.requiresSkipHooksConfirmation) {
            const hooks = (execution.hooks || []).map(h => `${h.path}\nSHA-256：${h.sha256}`).join('\n\n');
            if (!confirm(`此次自動合併需要略過下列 Git hooks。它們不會在本次操作執行；Git 原設定維持有效。需要 hook 檢查時，請先在可信的人工 Git 流程完成。\n\n${hooks}\n\n同意僅此次略過並繼續？`)) return;
            body.skipHooks = true;
          }
        }
        await api('/api/task/merge', body); toast(L('本体に取り込みました。作業用コピーはゴミ箱へ移しました'));
      }
      finally { await load(); }
    }
    else if (a === 'memo') {
      const input = $('#memo');
      if (!input || !input.value.trim()) { toast(L('メモを入れてください')); return; }
      await api('/api/task', { project: p, task: t, memo: input.value }); input.value = ''; toast(L('メモを残しました')); await load();
    } else if (a === 'answered') { if (chatSending.has(chatAttachmentKey(p,t))) return; if (!confirm(L('この質問を AI に送らずに消しますか？ AI は続きを始めません。答えを伝えたい時は［この作業で AI に送る］か［選んで送る］を使ってください。'))) return; await api('/api/task', { project: p, task: t, question: '', state: '実行中', memo: '人が質問を AI に送らずに消した' }); toast(L('質問を消しました（AI には送っていません）')); await load(); }
  } catch (e) { toast(e.message); }
}

document.addEventListener('click', e => {
  if (!e.target.closest('#menu') && !e.target.closest('[data-tree-menu]') && !e.target.closest('[data-act="files"]')) $('#menu').hidden = true;
  const tg = e.target.closest('[data-toggle]');
  if (tg) { const id = tg.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); save(); renderTree(); e.stopPropagation(); return; }
  const go = e.target.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'newproject') newProjectPreset = null;
    view = { kind: go.dataset.go, project: go.dataset.p || view.project, task: go.dataset.t || null };
    if (go.closest('#list')) closeDrawer(); // スマホの引き出しから選んだ時（描き直す前に判断する）
    if (view.kind === 'work' && view.task) markRead(view.project, view.task);
    showInTree(); save(); render(); return;
  }
  if (e.target.id === 'set-enter') { try { localStorage.setItem('hub-enter', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? L('Enter だけで送ります') : L('⌘ + Enter で送ります')); return; }
  if (e.target.id === 'set-detail') { try { localStorage.setItem('hub-detail', e.target.checked ? '1' : '0'); } catch (err) { /* 無視 */ } toast(e.target.checked ? L('細かい作業を出します') : L('細かい作業を隠します')); return; }
  if (e.target.id === 'models-tidy') {
    if (rolesDraft && JSON.stringify(rolesDraft) !== JSON.stringify(state.roles.roles) && !confirm(L('役割分担の保存していない変更は消えます。整理しますか？'))) return;
    api('/api/models/tidy', {}).then(async r => {
      rolesDraft = null; await load();
      const box = $('#tidy-result');
      const msg = r.changes.length ? `整理しました（${r.changes.length} か所）：` + r.changes.map(c => `${c.role}の${c.slot} ${c.from} → ${c.to}`).join('、') : '整理しました。役割はもう最新のモデルを使っています';
      if (box) box.textContent = msg; toast(r.changes.length ? UI`${r.changes.length} か所を最新のモデルにしました` : L('役割はもう最新です'));
    }).catch(err => toast(err.message));
    return;
  }
  if (e.target.dataset && e.target.dataset.mv !== undefined) { toggleModelVisibility(e.target); return; }
  if (e.target.id === 'roles-save') { saveRoles(); return; }
  if (e.target.id === 'roles-reset') { rolesDraft = null; render(); return; }
  const b = e.target.closest('[data-act]');
  if (b && b.tagName !== 'SELECT') act(b);
});
let stepsOpen = false;
document.addEventListener('toggle', e => {
  if (e.target.classList && e.target.classList.contains('project-notes') && e.target.isConnected !== false) {
    const id = e.target.dataset.p;
    if (e.target.open) projectNotesOpen.add(id); else projectNotesOpen.delete(id);
  }
  if (e.target.classList && e.target.classList.contains('steps')) stepsOpen = e.target.open;
  if (e.target.id === 'logd' && e.target.open) loadLog();
  if (e.target.id === 'verd') { verOpen = e.target.open; if (verOpen) loadChangelog(); }
}, true);
document.addEventListener('change', async e => {
  const f = e.target.closest && e.target.closest('#quickform');
  if (f) {
    const p = proj(f.dataset.p), d = quickDraft(p);
    if (e.target.id === 'quick-files') { await addQuickImages(p, [...e.target.files]); return; }
    if (e.target.id === 'quick-ai') { d.ai = e.target.value; d.model = d.ai === 'agy' ? 'Gemini 3.1 Pro (High)' : ''; d.effort = d.ai === 'agy' ? '高' : ''; }
    if (e.target.id === 'quick-model') d.model = e.target.value;
    if (e.target.id === 'quick-effort') d.effort = e.target.value;
    keepQuick(p.id); drawQuick(p); return;
  }

  const s = e.target;
  if (s.dataset.initial) {
    if (initialPickSaving) { drawInitialPick(); return; }
    const next = { ...initialPick(), [s.dataset.initial]: s.value };
    if (s.dataset.initial === 'ai') {
      next.model = webActor(next.ai) ? 'app' : shownModels(AI_KEY[next.ai])[0] || '';
      if (webActor(next.ai)) next.effort = '';
      else if (!state.efforts.includes(next.effort)) next.effort = '高';
    }
    await saveInitialPick(next); return;
  }
  if (s.dataset.r !== undefined && rolesDraft) {
    const r = rolesDraft[+s.dataset.r][s.dataset.k];
    r[s.dataset.f] = s.value;
    if (s.dataset.f === 'ai') {
      const list = shownModels(s.value);
      r.model = s.value === '人' || webActor(s.value) ? '' : (list.includes(r.model) ? r.model : list[0] || '');
      r.effort = s.value === '人' || webActor(s.value) ? '' : (r.effort || '高');
    }
    render(); return;
  }
  const a = s.dataset.act;
  if (a === 'step') {
    try { const r = await api('/api/task/step', { project: s.dataset.p, task: s.dataset.t, index: +s.dataset.i, done: s.checked }); toast(r.completionPending ? L('手順が終わりました。完了に移すか確認してください') : L('手順を更新しました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (a === 'phase') {
    try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, phase: s.value }); toast(L('フェーズを変えました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (['kind','derivedFrom','workspaceMode'].includes(a)) {
    const t=taskOf(proj(s.dataset.p),s.dataset.t), body={project:s.dataset.p,task:s.dataset.t,[a]:s.value};
    if(a==='kind' && s.value==='derived') body.derivedFrom=$('[data-act="derivedFrom"]').value;
    if(a==='derivedFrom' && s.value) body.kind='derived';
    if(a==='workspaceMode' && s.value==='direct' && !confirm(L('本体で作業しますか？同じ場所での同時作業はできません。'))) {s.value=t.workspaceMode || 'isolated';return;}
    try {await api('/api/task',body);await load();} catch(err) {s.value=t[a] || '';toast(err.message);} return;
  }
  if (!['state', 'model', 'effort'].includes(a)) return;
  if (s.dataset.ai && a !== 'state') {
    try {
      const r = await api('/api/term/switch', { project: s.dataset.p, task: s.dataset.t, ai: s.dataset.ai, field: a, value: s.value, ...terminalCredentials(s.dataset.ai) });
      toast(r.sent ? UI`${AI_LABEL[s.dataset.ai]} に「${r.command}」を送りました` : L('保存しました（次に始める時から使います）'));
      await load();
    } catch (err) { toast(err.message); }
    return;
  }
  if (a === 'state' && s.value === '完了') {
    const t = taskOf(proj(s.dataset.p), s.dataset.t);
    if (!confirm(L('この作業を完了に移しますか？'))) { s.value = t.state; return; }
    try { await api('/api/task/completion', { project: s.dataset.p, task: s.dataset.t, action: 'approve', confirm: true, expectedHash: t.completionHash }); await load(); } catch (err) { s.value = t.state; toast(err.message); } return;
  }
  try { await api('/api/task', { project: s.dataset.p, task: s.dataset.t, [a]: s.value }); toast(a === 'state' ? UI`「${s.value}」にしました` : L('変えました')); await load(); }
  catch (err) { toast(err.message); }
});
document.addEventListener('submit', async e => {
  if (e.target.classList.contains('addstep')) {
    e.preventDefault();
    const f = e.target, v = f.step.value.trim();
    if (!v) return;
    try { await api('/api/task/step', { project: f.dataset.p, task: f.dataset.t, add: v }); stepsOpen = true; toast(L('手順を足しました')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'projform') {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const first = String(f.get('firstTask') || '').trim();
      const p = await api('/api/project/new', { ...Object.fromEntries(f.entries()), related: f.getAll('related'), refs: newRefs });
      newRefs = []; newProjectPreset = null;
      if (first) {
        // 作ったプロジェクトで、最初の作業を初期選択で始める（役割は今のフェーズから）
        try {
          const r = await api('/api/start', { project: p.id, text: first, ...startSpec(initialPick()), images: [] });
          try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
          toast(r.webManual ? UI`「${p.name}」を作り、手動引き継ぎの作業を準備しました。送信はまだ行っていません。` : UI`「${p.name}」を作り、最初の作業を AI に頼みました`);
          view = { kind: 'work', project: p.id, task: r.task }; open.add(p.id); save(); await load();
          if(r.webManual)openManualStart(r,p.id,first); return;
        } catch (err) { toast(UI`「${p.name}」は作りましたが、最初の作業を始められませんでした：${err.message}`); }
      } else toast(UI`「${p.name}」を作りました。作業を足して始めましょう`);
      view = { kind: 'project', project: p.id, task: null }; open.add(p.id); save(); await load();
    } catch (err) { toast(err.message); }
    return;
  }
  // すぐ始める：書いた文から作業を作り、会話画面で AI に送る（役割・担当は今のフェーズから）
  if (e.target.id === 'quickform') {
    e.preventDefault();
    const f = e.target, p = proj(f.dataset.p);
    if (!p || quickStarting.has(p.id) || quickUploading.has(p.id)) return;
    if (!warnChildren(p)) return;
    const d = quickDraft(p); d.text = f.elements.namedItem('text').value; keepQuick(p.id);
    if (AIS.includes(d.ai) && !cliReady(d.ai)) { toast(L('この CLI の実行と分離は未検証です。まだ起動できません。')); return; }
    if (webActor(d.ai) && (!manualReady(d.ai) || d.images.length)) { toast(L('添付画像を外してから手動引き継ぎを準備してください。画像は Web サイトで選びます。')); return; }
    if (!d.text.trim() && !d.images.length) { toast(L('依頼を書くか画像を追加してください')); return; }
    d.request ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`; keepQuick(p.id);
    quickStarting.add(p.id); f.elements.namedItem('text').disabled = true; drawQuick(p);
    try {
      const r = await api('/api/start', { project: p.id, text: d.text, ...startSpec({ai:d.ai,model:d.model,effort:d.effort}), images: d.images.map(x => x.id), task: d.task, request: d.request });
      const handoffText=d.text;
      d.text = ''; d.images = []; delete d.task; delete d.request; keepQuick(p.id);
      try { localStorage.setItem('hub-mode', 'chat'); } catch (err) { /* 無視 */ }
      toast(r.webManual?L('作業を作りました。今回の手動引き継ぎをプレビューしてください。'):r.agent ? L('担当・依頼・画像の場所を保存しました。Discordで渡してください') : L('作業を作って、AI に頼みました'));
      view = { kind: 'work', project: p.id, task: r.task }; save(); await load();
      if(r.webManual)openManualStart(r,p.id,handoffText);
    } catch (err) { if (err.task) { d.task = err.task; keepQuick(p.id); } toast(err.message); }
    finally { quickStarting.delete(p.id); f.elements.namedItem('text').disabled = false; drawQuick(p); }
    return;
  }
  if (e.target.id !== 'newform') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const t = await api('/api/task/new', { project: view.project, title: f.get('title'), owner: f.get('owner'), role: f.get('role'), kind:f.get('kind'),derivedFrom:f.get('derivedFrom'),workspaceMode:f.get('workspaceMode'),parent: f.get('parent'), phase: f.get('phase') || '', via: f.get('via') || '', steps: f.get('steps') || '' });
    toast(L('作業を足しました')); view = { kind: 'work', project: view.project, task: t.id }; save(); await load();
  } catch (err) { toast(err.message); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {$('#menu').hidden = true; if ($('#fsheet')) $('#fsheet').hidden = true; }
  if (isSendKey(e) && e.target.closest && e.target.closest('#quickform')) { e.preventDefault(); $('#quickform').requestSubmit(); }
});
$('#turn').addEventListener('click', () => { view = { ...view, kind: view.kind === 'turn' ? 'project' : 'turn' }; render(); });
$('#ver').addEventListener('click', () => { view = { ...view, kind: 'settings' }; rolesDraft = null; verOpen = true; render(); loadChangelog(); });
$('#upd').addEventListener('click', restartHub);
// 本体のフォルダ：Mac のフォルダ選択の窓で選ぶ
document.addEventListener('click', async e => {
  if (e.target.dataset && e.target.dataset.rmref !== undefined) { newRefs.splice(+e.target.dataset.rmref, 1); drawRefs(); return; }
  if (e.target.id === 'np-refpick') {
    try { const r = await api('/api/pick-folder', { prompt: '参考にするフォルダを選んでください' }); if (r.path) addNewRefs([r.path]); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id !== 'np-pick') return;
  try { const r = await api('/api/pick-folder', { prompt: '本体のフォルダを選んでください' }); if (r.path) setBodyFolder(r.path); }
  catch (err) { toast(err.message); }
});
function setBodyFolder(p) {
  const i = $('#np-body'); if (!i) return;
  i.value = p;
  const d = i.closest('details'); if (d) d.open = true;
  const n = $('#np-name');
  if (n && !n.value.trim()) n.value = p.split('/').filter(Boolean).pop() || ''; // 名前が空ならフォルダ名を使う
  toast(L('本体のフォルダを入れました'));
}
// アプリの窓に落とした時（本当の場所が分かる）：Mac アプリから呼ばれる
window.hubNativeDrop = async paths => {
  if (!Array.isArray(paths) || !paths.length) return;
  if (view.kind === 'newproject') {
    // 参考の欄に落とした時は参考に。本体の欄（や本体が空の時）は1つ目を本体に、残りは参考に
    if (lastDropZone === 'refs') { addNewRefs(paths); toast(UI`参考に ${paths.length} 件足しました`); return; }
    const body = $('#np-body');
    if (lastDropZone === 'body' || (body && !body.value.trim())) { setBodyFolder(paths[0]); if (paths.length > 1) addNewRefs(paths.slice(1)); return; }
    addNewRefs(paths); toast(UI`参考に ${paths.length} 件足しました`); return;
  }
  if (view.kind === 'project' && view.project) {
    const images = paths.filter(isQuickImage), other = paths.filter(x => !isQuickImage(x));
    if (images.length) await addQuickImages(proj(view.project), images, true);
    if (!other.length) return;
    paths = other;
    try { const r = await api('/api/project/refs', { project: view.project, paths }); toast(r.added ? UI`参考に ${r.added} 件足しました（AI は読むだけ）` : L('もう入っています')); await load(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (view.kind !== 'work') { toast(L('ファイルは作業画面に落としてください')); return; }
  const ta = $('#chat-in');
  if (ta) {
    const project = view.project, task = view.task;
    const other = [];
    for (const file of paths) {
      if (isQuickImage(file)) {
        try { await addChatImage(project, task, file, true); }
        catch (e) { toast(`${file.split('/').pop()}：${e.message}`); }
      } else other.push(file);
    }
    if (other.length) {
      try {
        const r = await api('/api/task/attach', { project, task, paths: other });
        appendChatPaths(project, task, r.paths);
      } catch (e) { toast(e.message); }
    }
    return;
  }
  const ai = lastDropAi;
  try {
    const r = await api('/api/task/attach', { project: view.project, task: view.task, ai, paths, ...terminalCredentials(ai) });
    toast(r.typed ? UI`${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : L('作業ファイルに記録しました。AI を始めると読めます'));
    if (r.typed && panes[ai]) panes[ai].xterm.focus();
  } catch (err) { toast(err.message); }
};
window.hubNativePaste = paths => {
  if (view.kind === 'project') return addQuickImages(proj(view.project), paths, true);
  if (view.kind === 'work') return window.hubNativeDrop(paths);
  toast(L('画像は依頼の入力欄か作業画面で貼り付けてください'));
};
// スマホ：☰ で左の一覧を出し入れ。一覧で何かを選んだらしまう
$('#menu-toggle').addEventListener('click', () => window.HubNavigation?.toggle());
function closeDrawer() { window.HubNavigation?.close(); }
// 一覧の外を押したら、引き出しをしまう（一覧の中の選択は、下の [data-go] の処理でしまう）
document.addEventListener('click', e => { const b=e.target.closest?.('[data-steps-close]'); if(b){const d=b.closest('.steps');if(d)d.open=false;stepsOpen=false;return;} if (document.body.classList.contains('show-list') && e.target.closest && !e.target.closest('#list') && !e.target.closest('#menu-toggle')) closeDrawer(); }, true);
$('#gear').addEventListener('click', () => { view = { ...view, kind: view.kind === 'settings' ? 'project' : 'settings' }; rolesDraft = null; render(); });

// 左の木だけすぐ読み直す（AI が始めた・終わった時。丸の色を変えるため）
async function refreshTree() {
  const epoch = stateLoadEpoch;
  try { const next = await fetchState(); if (epoch !== stateLoadEpoch || initialPickSaving || phoneLabelsSaving || !next) return; state = next; syncChatPhoneLabels(); refreshWorkspaceLifecycle(); if (treeKey() !== renderedTreeKey) renderTree(); }
  catch (e) { /* 次に */ }
}
const editing = () => document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
let statePolling = false;
async function pollState() {
  if (document.hidden || statePolling) return;
  statePolling = true;
  const epoch = stateLoadEpoch;
  try {
    const next = await fetchState();
    if (epoch !== stateLoadEpoch || initialPickSaving || phoneLabelsSaving) return; // 保存後などの明示 load() を古い定期取得で上書きしない
    const previousModels = JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models]);
    const previousInitial = JSON.stringify([state.initialPick, state.initialPickError]);
    if (next) state = next;
    refreshWorkspaceLifecycle();
    // 通知のrefreshTreeが先にstateを更新した時や304でも、実際のoptionを同期する。
    // 表示名はmainKeyに含めず、会話の入力欄・選択欄は作り直さない。
    syncChatPhoneLabels();
    if (view.kind === 'settings' && !phoneLabelsSaving && renderedPhoneKey !== phoneSettingsKey() && !$('#phone-labels')?.contains?.(document.activeElement)) drawPhoneLabels();
    if (view.kind === 'settings' && !modelViewSaving && previousModels !== JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models])) { drawModelOrder(); syncRoleModelOrder(); }
    if (view.kind === 'settings' && !initialPickSaving && (previousInitial !== JSON.stringify([state.initialPick, state.initialPickError]) || previousModels !== JSON.stringify([state.modelOrder, state.hiddenModels, state.roles?.models]))) drawInitialPick();
    if (!next && state.sessions.length) { state.sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; } // 止まっている秒数だけ取り直す
    if (document.hidden) return;
    showVersion(state.version, state.latest);
    updateTurnCounts();
    window.HubMobile?.badges();
    const keepMain = view.kind === 'settings' || view.kind === 'newproject' || editing() || document.querySelector('details[open]:not(.project-notes)');
    if (!keepMain && mainKey() !== renderedMainKey) render();
    else {
      if (treeKey() !== renderedTreeKey) renderTree();
      // 入力中は画面を作り直さず、このボタンと理由だけ最新にする。
      if (keepMain && view.kind === 'project') {
        const box = $('#github-create-status'), p = proj(view.project);
        if (box && p) box.innerHTML = githubCreateButton(p);
      }
      if (!keepMain) updateStatus();
    }
  } catch (e) { /* 次に */ }
  finally { statePolling = false; }
}
setInterval(pollState, 15000);

// ---- ファイル・スクショを渡す（落とす／⌘V で貼る） ----
// 落とした AI の画面に渡す。画面の外なら、動いている AI が1つの時はそれに、無ければ保存して作業ファイルに記録するだけ
function dropTarget(el) {
  if (el && el.closest && el.closest('.chat')) return '';
  const pane = el && el.closest && el.closest('.pane[data-ai]');
  if (pane) return pane.dataset.ai;
  const run = AIS.filter(a => document.getElementById('pane-' + a));
  return run.length === 1 ? run[0] : '';
}
async function sendFiles(files, ai) {
  if (view.kind !== 'work' || !files.length) return;
  const project = view.project, task = view.task;
  const ta = $('#chat-in');
  if (ta) ai = ''; // 会話画面では、場所を依頼の欄に入れる
  const got = [];
  for (const f of files) {
    if (ta && isQuickImage(f)) {
      try { await addChatImage(project, task, f); }
      catch (e) { toast(`${f.name || '画像'}：${e.message}`); }
      continue;
    }
    const name = f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const q = new URLSearchParams({ project, task, ai, name });
    try {
      const credentials = terminalCredentials(ai);
      if(window.HubNativeRestart?.paused)throw Error('重新啟動期間已暫停上傳。');
      const r = await fetch('/api/task/upload?' + q, { method: 'POST', headers: { 'X-Hub': '1', 'Content-Type': 'application/octet-stream', ...(credentials.viewId ? { 'X-Hub-Term-View': credentials.viewId, 'X-Hub-Term-Lease': credentials.lease } : {}) }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || L('渡せませんでした'));
      got.push(j);
    } catch (e) { toast(`${f.name || L('ファイル')}：${e.message}`); }
  }
  if (ta) {
    if (got.length) appendChatPaths(project, task, got.map(x => x.path));
    return;
  }
  if (!got.length) return;
  const typed = got.some(x => x.typed);
  toast(typed ? UI`${AI_LABEL[ai]} の入力欄にファイルの場所を入れました。続けて指示を書いて Enter を押してください` : UI`ファイルを保存し、作業ファイルに記録しました（${got.length}件）。AI を始めると読めます`);
  if (typed && panes[ai]) panes[ai].xterm.focus();
}
function appendChatPaths(project, task, paths) {
  const ta = view.kind === 'work' && view.project === project && view.task === task && workMode() === 'chat' ? $('#chat-in') : null;
  const key = chatAttachmentKey(project, task);
  const text = ta ? ta.value : chatDraft[key] || '';
  const next = (text ? text.replace(/\s*$/, '\n') : '') + paths.join('\n') + '\n';
  chatDraft[key] = next;
  if (ta) { ta.value = next; ta.focus(); }
  toast(L('依頼の欄にファイルの場所を入れました。続けて指示を書いて送ってください'));
}
let dropTimer = null, lastDropAi = '', lastDropZone = '';
function showDrop(ai) {
  document.querySelectorAll('.pane, .chat').forEach(p => p.classList.toggle('dropping', p.dataset.ai ? p.dataset.ai === ai : !ai));
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => document.querySelectorAll('.dropping').forEach(p => p.classList.remove('dropping')), 250);
}
// 窓にファイルを落としても、ファイルが開いて Hub が消えないようにする
document.addEventListener('dragover', e => {
  e.preventDefault();
  if (view.kind === 'project' && e.target.closest && e.target.closest('#quickform')) {
    e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; return;
  }
  if (view.kind === 'work' && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.dataTransfer.dropEffect = 'copy'; lastDropAi = dropTarget(e.target); showDrop(lastDropAi); }
  else if (view.kind === 'newproject' && e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
    const inRefs = e.target.closest && e.target.closest('#np-refs');
    lastDropZone = inRefs ? 'refs' : (e.target.closest && e.target.closest('#np-drop')) ? 'body' : '';
    const z = inRefs ? $('#np-refs') : $('#np-drop');
    if (z) { document.querySelectorAll('.dropfield.dropping').forEach(x => x !== z && x.classList.remove('dropping')); z.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => z.classList.remove('dropping'), 250); }
  } else if (view.kind === 'project' && e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; const v = document.querySelector('.view'); if (v) { v.classList.add('dropping'); clearTimeout(dropTimer); dropTimer = setTimeout(() => v.classList.remove('dropping'), 250); } }
  else if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
document.addEventListener('drop', e => {
  e.preventDefault();
  if (view.kind === 'project' && e.dataTransfer) {
    const images = [...e.dataTransfer.files].filter(isQuickImage);
    if (images.length) { e.stopPropagation(); addQuickImages(proj(view.project), images); return; }
  }
  // ブラウザで開いている時は、落としたフォルダの場所が分からない
  if (view.kind === 'newproject' || view.kind === 'project') { toast(L('ブラウザでは場所が分かりません。［選ぶ…］を押すか、アプリの窓で落としてください')); return; }
  if (view.kind !== 'work' || !e.dataTransfer) return;
  sendFiles([...e.dataTransfer.files], dropTarget(e.target));
});
document.addEventListener('paste', e => {
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  if (view.kind === 'project' && e.target.closest && e.target.closest('#quickform') && files.some(isQuickImage)) {
    e.preventDefault(); e.stopPropagation(); addQuickImages(proj(view.project), files); return;
  }
  if (view.kind !== 'work' || !files.length) return;
  e.preventDefault(); e.stopPropagation();
  sendFiles(files, dropTarget(document.activeElement));
}, true);

// 作業画面では「作業中／入力待ち」を数秒ごとに更新する（画面は作り直さない）
function updateStatus() {
  if (view.kind !== 'work') return;
  document.querySelectorAll('.pstat').forEach(el => { el.innerHTML = statusText(sessOf(view.project, view.task, el.dataset.ai)); });
}
let sessionsPolling = false;
async function pollSessions() {
  if (document.hidden || sessionsPolling || view.kind !== 'work' || !document.querySelector('.pstat')) return;
  sessionsPolling = true;
  const epoch = stateLoadEpoch;
  try { const sessions = await api('/api/sessions'); if (epoch !== stateLoadEpoch) return; state.sessions = sessions; if (!document.hidden) updateStatus(); } catch (e) { /* 次に */ }
  finally { sessionsPolling = false; }
}
setInterval(pollSessions, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(aiToolsWatchTimer); aiToolsWatchTimer = null; }
  else { pollState(); pollSessions(); if (view.kind === 'settings' && aiToolsOperation) loadAiTools(); }
});

load().catch(e => { $('#main').innerHTML = UI`<div class="view"><p class="note">読み込めませんでした：${esc(e.message)}</p></div>`; });
