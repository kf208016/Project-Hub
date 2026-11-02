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



function fixture() {
  const a = app(), instances = [], warnings = [];
  class FakeEventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 1; this.closed = false; instances.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    frame(value) { this.onmessage({data: JSON.stringify(value)}); }
  }
  a.context.EventSource = FakeEventSource;
  a.context.console = {warn: (...args) => warnings.push(args)};
  a.context.toast = () => {};
  a.context.api = async () => ({});
  const state = snapshot();
  vm.runInContext('state=' + JSON.stringify(state) + ';view={kind:"work",project:"p",task:"t"}', a.context);
  const render = () => a.context.render();
  const current = () => instances.at(-1);
  const rows = values => current().frame({type:'rows',rows:values,queue:[],approvals:[],busy:null});
  const row = text => ({role:'user',text,at:'2026-10-26T00:00:00Z'});
  const timers = ms => [...a.timeouts.entries()].filter(([,timer]) => timer.ms === ms);
  const fire = ms => {const [id,timer] = timers(ms)[0]; a.timeouts.delete(id); timer.cb();};
  const cache = () => JSON.parse(vm.runInContext('JSON.stringify([...chatRowCache])',a.context));
  return {...a,instances,warnings,state,render,current,rows,row,timers,fire,cache};
}

test('R15 initial work render loads; only an empty rows frame displays empty chat', () => {
  const a=fixture(); a.render();
  assert.match(a.element('#main').innerHTML, /class="chat-loading">会話を読み込んでいます…/);
  assert.doesNotMatch(a.element('#main').innerHTML, /chat-empty/);
  a.rows([]); assert.match(a.element('#msgs').innerHTML, /chat-empty/);
  assert.equal(a.timers(8000).length,0);
  a.render(); assert.match(a.element('#main').innerHTML,/chat-empty/);
});

test('R15 refreshTree turn boundary followed by a 304 preserves cached rows across rerenders', async () => {
  const a=fixture(); a.render(); a.rows([a.row('retained synthetic history')]);
  const changed=structuredClone(a.state); changed.projects[0].tasks[0].title='Task updated';
  a.context.fetchState=async()=>changed; await a.context.refreshTree();
  a.context.fetchState=async()=>null; await a.context.pollState();
  assert.equal(a.instances.length,2);
  for(let i=0;i<3;i++){
    a.render(); assert.match(a.element('#main').innerHTML,/retained synthetic history/);
    assert.doesNotMatch(a.element('#main').innerHTML,/chat-empty|chat-loading/);
  }
  assert.equal(a.instances.filter(es=>!es.closed).length,1);
});

test('R15 stale streams cannot clear rows, append rows, change queue or reconnect', () => {
  const a=fixture(); a.render(); const old=a.current(); a.rows([a.row('latest history')]);
  a.render(); const before=a.element('#msgs').innerHTML,cache=JSON.stringify(a.cache());
  for(const event of [{type:'rows',rows:[]},{type:'row',row:a.row('stale')},{type:'queue',queue:[{}]},{type:'idle'},{type:'busy'},{type:'approvals',approvals:[{}]},{type:'partial',text:'stale'}])old.frame(event);
  old.onerror();
  assert.equal(a.element('#msgs').innerHTML,before); assert.equal(JSON.stringify(a.cache()),cache);
  assert.equal(a.timers(2000).length,0);
});

test('R15 CLOSED schedules exactly one 2000 ms reconnect; CONNECTING stays browser-owned', () => {
  const a=fixture(); a.render(); const old=a.current(),url=old.url;
  old.readyState=0; old.onerror(); assert.equal(a.timers(2000).length,0);
  old.readyState=2; old.onerror(); old.onerror();
  assert.equal(a.timers(2000).length,1); assert.equal(a.timers(8000).length,0);
  a.fire(2000); assert.equal(a.instances.length,2); assert.equal(a.current().url,url);
  assert.equal(old.closed,true); assert.equal(a.instances.filter(es=>!es.closed).length,1);
  a.current().readyState=2; a.current().onerror(); a.context.closePanes();
  assert.equal(a.timers(2000).length,0); assert.equal(a.timers(8000).length,0);
});

test('R15 missing first rows reopens once at each 8000 ms expiry and rows disarm watchdog', () => {
  const a=fixture(); a.render(); const first=a.current();
  assert.equal(a.timers(8000).length,1); a.fire(8000);
  assert.equal(a.instances.length,2); assert.equal(first.closed,true); assert.equal(a.timers(8000).length,1);
  a.fire(8000); assert.equal(a.instances.length,3); assert.equal(a.instances.filter(es=>!es.closed).length,1);
  a.rows([a.row('first frame')]); assert.equal(a.timers(8000).length,0);
});

test('R15 lifecycle-only poll does not rebuild main or open a new stream', async () => {
  const a=fixture();a.render();const before=a.element('#main').innerHTML;
  const changed=structuredClone(a.state);changed.projects[0].tasks[0].workspaceLifecycle={state:'running',ownedChildren:5};
  a.context.fetchState=async()=>changed;await a.context.pollState();
  assert.equal(a.element('#main').innerHTML,before);assert.equal(a.instances.length,1);
  changed.projects[0].tasks[0].workspaceLifecycle.ownedChildren=0;await a.context.pollState();
  assert.equal(a.element('#main').innerHTML,before);assert.equal(a.instances.length,1);
});

test('R15 cache includes hidden tool rows, bounds rows at 2000, and evicts the oldest of 21 tasks', () => {
  const a=fixture();a.render();a.rows(Array.from({length:2005},(_,i)=>a.row('row-'+i)));
  let cached=a.cache()[0][1];assert.equal(cached.length,2000);assert.equal(cached[0].text,'row-5');
  const hidden={role:'event',tool:true,text:'hidden tool'};
  assert.equal(a.context.msgHtml(hidden),'');
  a.current().frame({type:'row',row:hidden});
  cached=a.cache()[0][1];assert.equal(cached.length,2000);assert.equal(cached[0].text,'row-6');assert.equal(cached.at(-1).text,'hidden tool');
  for(let i=1;i<=20;i++){
    vm.runInContext(`state.projects[0].tasks[0].id='t${i}';view.task='t${i}'`,a.context);
    a.render();a.rows([a.row('task-'+i)]);
  }
  assert.equal(a.cache().length,20);assert.equal(a.cache()[0][0],JSON.stringify(['p','t1']));
  assert.equal(a.cache().some(([key])=>key===JSON.stringify(['p','t'])),false);
  vm.runInContext("view.task='t';state.projects[0].tasks[0].id='t'",a.context);a.render();
  assert.match(a.element('#main').innerHTML,/chat-loading/);
});

test('R15 malformed rows preserve previous DOM and warn only once per stream', () => {
  const a=fixture();a.render();a.rows([a.row('keep original')]);const before=a.element('#msgs').innerHTML;
  a.rows([null]);a.rows({length:1});a.current().onmessage({data:'{'});
  assert.equal(a.element('#msgs').innerHTML,before);assert.equal(a.warnings.length,1);
  assert.equal(a.cache()[0][1][0].text,'keep original');
});

test('R15 exceptions after innerHTML assignment restore previous DOM', () => {
  const a=fixture();a.render();a.rows([a.row('previous')]);const before=a.element('#msgs').innerHTML;
  a.context.refreshAsks=()=>{throw Error('synthetic render failure');};
  assert.doesNotThrow(()=>a.rows([a.row('replacement')]));
  assert.equal(a.element('#msgs').innerHTML,before);assert.equal(a.warnings.length,1);
});

test('R15 switching task clears old timer and restart pause leaves no streams or timers', () => {
  const a=fixture();a.render();a.current().readyState=2;a.current().onerror();
  vm.runInContext("view.task='other';state.projects[0].tasks[0].id='other'",a.context);a.render();
  assert.equal(a.timers(2000).length,0);assert.equal(a.timers(8000).length,1);
  a.context.window.HubNativeRestart={paused:true};a.windowEvents.get('hub-restart-pause')();
  assert.equal(a.timers(8000).length,0);assert.equal(a.timers(2000).length,0);
  const count=a.instances.length;a.render();assert.equal(a.instances.length,count);
  assert.equal(a.instances.filter(es=>!es.closed).length,0);
});

test('R15 locked and unlocked Grok status have byte-identical version and auth lines', () => {
  const a=fixture(),status={runtime:{version:'1.0.70',slotPresent:true},auth:{present:true,mtime:'2026-10-26T00:00:00Z'}};
  const plain=a.context.grokStatusHtml(status);
  status.auth.lockPresent=true;status.auth.lockMtime='2026-10-26T00:01:00Z';
  assert.equal(a.context.grokStatusHtml(status),plain);assert.doesNotMatch(plain,/登入檔鎖存在|未正常結束/);
  status.auth.present=false;assert.match(a.context.grokStatusHtml(status),/data-copy="grok login"/);
});
