'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registry = require('../lib/provider-registry');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function app() {
  const elements = new Map();
  const events = new Map(), windowEvents=new Map();
  const timers = new Map();
  const timeouts = new Map();
  const details = [];
  let nextTimer = 0;
  let stream;
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
      scrollTop: 0, scrollHeight: 100, clientHeight: 100,
      dataset: {}, handlers: {}, attributes: {}, addEventListener(name, cb) { this.handlers[name] = cb; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      querySelector() { return null; }, querySelectorAll() { return []; }, insertAdjacentHTML() {},
    });
    return elements.get(key);
  }
  class EventSource {
    constructor() { stream = this; }
    close() {}
  }
  const document = {
    hidden: false, activeElement: null,
    querySelector: s => s.startsWith('details[open]') ? details.find(d => d.open && (!s.includes(':not(.project-notes)') || !d.classList.contains('project-notes'))) || null : s === '#msg-partial' ? elements.get(s) || null : element(s),
    querySelectorAll: () => [],
    addEventListener(name, cb) { events.set(name, cb); },
  };
  const context = vm.createContext({
    document, window: {addEventListener(name,callback){windowEvents.set(name,callback);}}, navigator: { userAgent: '' },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => new Promise(() => {}), // 起動時の load() は試験用の状態を上書きしない
    EventSource, URLSearchParams,
    requestAnimationFrame: cb => cb(),
    setInterval(cb, ms) { const id = ++nextTimer; timers.set(id, { cb, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(cb, ms) { const id = ++nextTimer; timeouts.set(id, { cb, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    console, ModelOrder: require('../public/model-order'), ProjectOrder: require('../public/project-order'),
    confirm: () => true,
  });
  vm.runInContext(source, context);
  return { context, document, elements, element, events, windowEvents, timers, timeouts, details, stream: () => stream };
}

const project = (state = '実行中') => ({
  id: 'p', name: 'Project', parent: '', status: '進行中', description: '', updated: '',
  phases: [], tasks: [{ id: 't', title: 'Task', state, owner: 'codex', role: '', model: '', effort: '',
    phase: '', steps: [], skills: [], question: '', next: '', copy: false }],
  folders: [], related: [], issues: [], chats: [],
});
const snapshot = (taskState = '実行中', sessions = []) => ({
  providers:registry.list({platform:'darwin'}),webChatAvailable:false,
  root: '/tmp', projects: [project(taskState)], roles: { models: { codex: [], 'claude-code': [] }, roles: [], permissions: {} },
  sessions, chatting: [], terminal: true, efforts: [], cliFlags: {}, version: '1', latest: '1',
});

function fixture(){
  const f=app();f.run=code=>vm.runInContext(code,f.context);
  f.run('state='+JSON.stringify(snapshot())+';view={kind:"work",project:"p",task:"t"}');
  f.calls=[];f.messages=[];f.context.toast=message=>f.messages.push(message);f.context.api=async(route,body)=>{f.calls.push({route,body});return {};};
  return f;
}
const buttons=html=>{for(const mode of ['refresh','login','device'])assert.match(html,new RegExp('data-grok-mode="'+mode+'"'));};
test('R19 shared buttons render in failed rows, status with expiry and task prompt',()=>{
  const f=fixture();f.context.sample={runtime:{version:'1.0.70'},auth:{present:true,mtime:'2026-10-28T00:00:00Z'},login:{state:'fresh',refreshAt:1800000000000}};
  buttons(f.run('grokStatusHtml(sample)'));assert.match(f.run('grokStatusHtml(sample)'),/建議更新時間：/);assert.match(f.run('grokStatusHtml({...sample,login:{state:"expired"}})'),/已過期/);
  for(const code of ['GROK_NATIVE_AUTH_UNAVAILABLE','GROK_NATIVE_IDLE_TIMEOUT']){f.context.code=code;const html=f.run('grokLoginHintHtml({ai:"grok",error:"（代碼："+code+"）"},sample)');buttons(html);assert.match(html,/data-copy="grok login --device-auth"/);}
  f.run('rememberGrokLoginError({code:"GROK_LOGIN_MISSING"},"p","t")');buttons(f.run('chatHtml(proj("p"),taskOf(proj("p"),"t"))'));assert.match(f.run('grokLoginPromptHtml("p","t")'),/找不到 Grok 登入檔/);
});
test('R19 actual failed send persists only for its task, preserves draft, survives state reload and clears on successful send',async()=>{
  const f=fixture();f.run('state.providers=state.providers.map(p=>({...p,readiness:{...p.readiness,ready:true}}));warnChildren=()=>true;openChat(proj("p"),taskOf(proj("p"),"t"))');f.element('#chat-ai').value='grok|model';f.element('#chat-in').value='synthetic unsent request';
  f.context.api=async()=>{throw Object.assign(Error('expired'),{code:'GROK_LOGIN_EXPIRED'});};
  assert.equal(await f.run('sendWorkAnswer.send("synthetic unsent request")'),false);
  assert.equal(f.run('state.grokLoginPrompt.code'),'GROK_LOGIN_EXPIRED');assert.equal(f.run('state.grokLoginPrompt.project'),'p');assert.equal(f.run('state.grokLoginPrompt.task'),'t');assert.equal(typeof f.run('state.grokLoginPrompt.at'),'number');
  buttons(f.element('#grok-login-prompt').innerHTML);assert.equal(f.run('grokLoginPromptHtml("other","t")'),'');assert.equal(f.run('grokLoginPromptHtml("p","other")'),'');assert.equal(f.element('#chat-in').value,'synthetic unsent request');
  f.context.nextSnapshot=snapshot();f.context.nextSnapshot.providers=f.run('state.providers');f.run('fetchState=async()=>nextSnapshot;showInTree=()=>{};render=()=>{}');await f.context.load();assert.equal(f.run('state.grokLoginPrompt.code'),'GROK_LOGIN_EXPIRED');
  f.element('#msg-partial').querySelector=selector=>f.element('partial '+selector);f.context.api=async()=>({});assert.equal(await f.run('sendWorkAnswer.send("synthetic unsent request")'),true,JSON.stringify(f.messages));assert.equal(f.run('state.grokLoginPrompt'),undefined);
});
test('R19 window polling shows running and all results, disables controls and never resends',async()=>{
  for(const outcome of ['refreshed','unchanged','failed','timeout']){
    const f=fixture();f.run('rememberGrokLoginError({code:"GROK_LOGIN_EXPIRED"},"p","t")');
    f.context.api=async(route,body)=>{f.calls.push({route,body});if(route==='/api/state')return snapshot();return body?{running:true}:{running:false,outcome:outcome==='timeout'?'failed':outcome,timedOut:outcome==='timeout',exitCode:7,login:{mtime:1800000000000}};};
    await f.context.act({dataset:{act:'groklogin',grokMode:'refresh'}});assert.match(f.run('grokLoginActionsHtml("test")'),/disabled/);assert.match(f.run('grokLoginActionsHtml("test")'),/Grok 視窗執行中/);
    const timer=[...f.timeouts.values()].find(x=>x.ms===2000);assert.ok(timer);await timer.cb();
    const html=f.run('grokLoginActionsHtml("test")');assert.doesNotMatch(html,/disabled/);
    assert.match(html,outcome==='refreshed'?/登入已更新（\d{2}:\d{2}）。請再送一次/:outcome==='unchanged'?/登入檔沒有變化；請改按「登入 Grok」/:outcome==='timeout'?/逾時/:/結束代碼 7/);
    assert.equal(f.run('Boolean(state.grokLoginPrompt)'),outcome!=='refreshed');assert.deepEqual(f.calls.map(c=>c.route),['/api/grok/login-window','/api/grok/login-window',...(outcome==='refreshed'?['/api/state']:[])]);
  }
});
test('R19 remote refusal preserves server text; polling has a sixteen minute bound',async()=>{
  const f=fixture();f.context.api=async()=>{throw Object.assign(Error('此主機管理操作僅限本機使用者'),{status:403});};await f.context.startGrokLoginWindow('device');assert.match(f.run('grokLoginActionsHtml("test")'),/此主機管理操作僅限本機使用者/);assert.equal(f.messages.at(-1),'此主機管理操作僅限本機使用者');
  f.run('grokLoginPollUntil=Date.now()-1');f.context.api=async()=>assert.fail('expired polling must not request');await f.context.pollGrokLoginWindow();assert.match(f.run('grokLoginActionsHtml("test")'),/查詢逾時/);assert.match(source,/grokLoginPollUntil=Date.now\(\)\+16\*60\*1000/);
});

test('R21 expiring error preserves per-task draft and renders exact server message with three buttons',async()=>{
  const f=fixture();f.run('state.providers=state.providers.map(p=>({...p,readiness:{...p.readiness,ready:true}}));warnChildren=()=>true;openChat(proj("p"),taskOf(proj("p"),"t"))');f.element('#chat-ai').value='grok|model';f.element('#chat-in').value='synthetic unsent request';
  f.context.api=async()=>{throw Object.assign(Error('expiring'),{code:'GROK_LOGIN_EXPIRING'});};
  assert.equal(await f.run('sendWorkAnswer.send("synthetic unsent request")'),false);
  assert.equal(f.run('state.grokLoginPrompt.code'),'GROK_LOGIN_EXPIRING');
  const html=f.run('grokLoginPromptHtml("p","t")');buttons(html);
  assert.ok(html.includes(require('../lib/native-provider-messages').messageFor('GROK_LOGIN_EXPIRING')));
  assert.equal(f.run('grokLoginPromptHtml("other","t")'),'');assert.equal(f.run('grokLoginPromptHtml("p","other")'),'');
  assert.equal(f.element('#chat-in').value,'synthetic unsent request');
  f.context.sample={runtime:{version:'1.0.70'},auth:{present:true},login:{state:'expiring',refreshAt:1800000000000,expiresAt:1800001800000}};
  const status=f.run('grokStatusHtml(sample)');buttons(status);assert.match(status,/即將到期/);assert.match(status,/建議更新時間：/);
  const refreshTime=new Date(1800000000000).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  const expiryTime=new Date(1800001800000).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  assert.ok(status.includes(refreshTime));assert.ok(!status.includes(expiryTime));
});
