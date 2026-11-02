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

test('R24 unchanged 409 is remembered with exact prompt, code and three login buttons',async()=>{
  const f=fixture();f.run('state.providers=state.providers.map(p=>({...p,readiness:{...p.readiness,ready:true}}));warnChildren=()=>true;openChat(proj("p"),taskOf(proj("p"),"t"))');
  f.element('#chat-ai').value='grok|model';f.element('#chat-in').value='synthetic unsent request';
  f.context.api=async()=>{throw Object.assign(Error('unchanged'),{status:409,code:'GROK_LOGIN_AUTO_REFRESH_UNCHANGED'});};
  assert.equal(await f.run('sendWorkAnswer.send("synthetic unsent request")'),false);
  assert.equal(f.run('state.grokLoginPrompt.code'),'GROK_LOGIN_AUTO_REFRESH_UNCHANGED');
  const html=f.run('grokLoginPromptHtml("p","t")');buttons(html);
  assert.ok(html.includes(require('../lib/native-provider-messages').messageFor('GROK_LOGIN_AUTO_REFRESH_UNCHANGED')));
  assert.equal(f.element('#chat-in').value,'synthetic unsent request');assert.equal(f.run('grokLoginPromptHtml("other","t")'),'');
});
