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

test('R16 notices stay visible without details and escape tool titles',()=>{
  const a=fixture();a.render();
  const notice={role:'event',ai:'grok',notice:true,code:'NATIVE_TOOL_DECLINED',text:'refused <script>&'};
  assert.equal(a.context.msgHtml({role:'event',tool:true,text:'hidden'}),'');
  assert.equal(a.context.msgHtml(notice),'<div class="ev notice">▸ refused &lt;script&gt;&amp;</div>');
  assert.equal(a.context.msgHtml({...notice,tool:true}),a.context.msgHtml(notice));
  a.rows([notice]);assert.match(a.element('#msgs').innerHTML,/class="ev notice"/);
  const css=fs.readFileSync(path.join(__dirname,'../public/app.css'),'utf8');
  const style=css.match(/\.ev\.notice\{([^}]+)\}/)[1];assert.match(style,/var\(--hold\)/);assert.match(style,/var\(--hold-bg\)/);assert.doesNotMatch(style,/#[a-f\d]|rgba?\(/i);
});

test('R16 approval headings identify each AI and fall back to AI for unknown names',()=>{
  const a=fixture();a.render();
  for(const [ai,label]of [['codex','Codex'],['claude','Claude Code'],['grok','Grok'],['unknown','AI'],['__proto__','AI'],[undefined,'AI']])for(const questions of [undefined,[]]){
    const approval={token:'synthetic',ai,kind:'tool',reason:'reason',detail:'<file>',questions};
    a.current().frame({type:'approvals',approvals:[approval]});
    assert.match(a.element('#chat-approvals').innerHTML,new RegExp('<b>'+label+' '+(questions?'需要你的回答':'需要額外權限')+'</b>'));
    assert.match(a.element('#chat-approvals').innerHTML,/&lt;file&gt;/);
  }
});

test('R18 stopped-after-decline notice renders with tool details hidden',()=>{
  const a=fixture();a.render();
  const {messageFor}=require('../lib/native-provider-messages');
  const notice={role:'event',ai:'grok',notice:true,code:'GROK_STOPPED_AFTER_DECLINE',text:messageFor('GROK_STOPPED_AFTER_DECLINE')};
  assert.equal(a.context.msgHtml({role:'event',tool:true,text:'hidden'}),'');
  const html='<div class="ev notice">▸ '+notice.text+'</div>';
  assert.equal(a.context.msgHtml(notice),html);
  assert.equal(a.context.msgHtml({...notice,tool:true}),html);
  a.rows([notice]);assert.ok(a.element('#msgs').innerHTML.includes(html));
});
