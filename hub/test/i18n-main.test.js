'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),locale=require('../public/i18n');
for(const name of ['main','main-extra','aux','empty']){const file=path.join(__dirname,'../public/locales/zh-TW-'+name+'.json');if(fs.existsSync(file))locale.add(JSON.parse(fs.readFileSync(file,'utf8')));}
locale.setLocale('zh-TW');
function app(){const elements=new Map(),events=new Map();const element=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},attributes:{},style:{},scrollTop:0,scrollHeight:100,clientHeight:100,setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},querySelector(){return null;},querySelectorAll(){return[];},insertAdjacentHTML(){}});return elements.get(key);};const context=vm.createContext({document:{hidden:false,documentElement:{lang:'zh-Hant'},querySelector:element,querySelectorAll:()=>[],addEventListener(name,fn){const list=events.get(name)||[];list.push(fn);events.set(name,list);}},window:{L:locale.L,UI:locale.UI,HubI18n:locale,location:{protocol:'http:'},addEventListener(){}},navigator:{userAgent:'Windows'},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),EventSource:class{close(){}},URLSearchParams,requestAnimationFrame:fn=>fn(),setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},console,ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order'),confirm:()=>true});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);const p={id:'p',name:'閉じる<USER>',status:'進行中',description:'原文の説明',phases:[{name:'計画',state:'実行中'}],folders:[],related:[],issues:[],chats:[],tasks:[{id:'t',title:'保存する<USER>',state:'実行中',owner:'codex',role:'コーディング',model:'GPT-6.1-Sol',effort:'高',phase:'計画',steps:[],skills:[],question:'',next:'',copy:false}]};vm.runInContext('state='+JSON.stringify({root:'C:\\synthetic',windowsBrowser:true,providers:require("../lib/provider-registry").list({platform:"win32"}),webChatAvailable:true,projects:[p],roles:{models:{codex:['GPT-6.1-Sol'],'claude-code':[]},roles:[{name:'コーディング',job:'既存の原文',main:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'},backup:{ai:'人'}}],permissions:{}},sessions:[],chatting:[],terminal:true,efforts:['高'],cliFlags:{},version:'4.68.2',latest:'4.68.2',initialPick:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'}})+';view={kind:"work",project:"p",task:"t"}',context);return{context,element,events,p};}
test('Main work renderer shows Chinese labels while state/role/phase bindings and user material stay original',async()=>{const a=app();a.context.renderWork();const html=a.element('#main').innerHTML;assert.match(html,/保存する&lt;USER&gt;/);assert.match(html,/程式開發/);assert.match(html,/value="実行中"[^>]*>執行中<\/option>/);assert.match(html,/value="計画"[^>]*>規劃<\/option>/);assert.match(html,/aria-label="狀態"/);const calls=[];a.context.api=async(route,body)=>{calls.push({route,body});return{};};a.context.load=async()=>{};for(const fn of a.events.get('change'))await fn({target:{dataset:{act:'state',p:'p',t:'t'},value:'停止',classList:{contains:()=>false}}});assert.equal(calls.at(-1).body.state,'停止');assert.equal(calls.at(-1).body.project,'p');assert.equal(a.p.tasks[0].state,'実行中');});
test('Windows settings offers both languages and shows Windows guidance without modifying role jobs',()=>{const a=app();vm.runInContext('view.kind="settings"',a.context);a.context.renderSettings();const html=a.element('#main').innerHTML;assert.match(html,/id="hub-language"/);assert.match(html,/value="zh-TW" selected>繁體中文（台灣）/);assert.match(html,/value="ja" >日本語/);assert.match(html,/Windows 檔案存取/);assert.doesNotMatch(html,/Mac のファイルの許可|tailscale serve --bg 4545/);assert.match(html,/既存の原文/);assert.equal(vm.runInContext('rolesDraft[0].name',a.context),'コーディング');});
test('Japanese display selection keeps the same backend bindings and user text',()=>{locale.setLocale('ja');try{const a=app();a.context.renderWork();assert.match(a.element('#main').innerHTML,/value="実行中"[^>]*>実行中<\/option>/);assert.match(a.element('#main').innerHTML,/保存する&lt;USER&gt;/);assert.match(a.element('#main').innerHTML,/コーディング/);}finally{locale.setLocale('zh-TW');}});

test('HTTP failure preserves the actual server diagnostic as an opaque value; only the missing-message fallback is translated',async()=>{const a=app();a.context.fetch=async()=>({ok:false,status:409,json:async()=>({error:'会話',reason:'原始診斷',stage:'validation',notStarted:true})});await assert.rejects(a.context.api('/api/task',{project:'p',task:'t'}),error=>error.message==='会話'&&error.reason==='原始診斷'&&error.stage==='validation'&&error.notStarted===true);a.context.fetch=async()=>({ok:false,status:409,json:async()=>({})});await assert.rejects(a.context.api('/api/task',{project:'p',task:'t'}),/操作失敗/);});

test('Fresh Windows installation offers the real project creation route in TC without requiring a shell setup',()=>{const a=app();a.context.renderEmpty();const html=a.element('#main').innerHTML;assert.match(html,/尚未建立專案/);assert.match(html,/data-go="newproject"/);assert.match(html,/新增專案/);assert.match(html,/確認工作範圍與連線目的地/);assert.doesNotMatch(html,/bash|setup\.sh/);vm.runInContext('state.windowsBrowser=false',a.context);a.context.renderEmpty();assert.match(a.element('#main').innerHTML,/bash setup\.sh/);});

test('Chat empty guidance resolves the language at render time after asynchronous catalogs arrive',()=>{
 const before=locale.locale;
 try{
  locale.setLocale('ja');const a=app();
  const japanese=vm.runInContext('EMPTY_CHAT()',a.context);
  assert.match(japanese,/<span class="empty-kicker">PROJECT HUB<\/span><h3>明確な依頼から始めましょう<\/h3>/);
  assert.match(japanese,/AI を選び、やりたいことを書いてください。/);
  assert.match(japanese,/Codex はここで実行できます。Web AI は手動引き継ぎを開きます。/);
  assert.doesNotMatch(japanese,/從一個|選擇 AI|網頁 AI/);
  locale.setLocale('zh-TW');const text=vm.runInContext('EMPTY_CHAT()',a.context);
  assert.match(text,/<span class="empty-kicker">PROJECT HUB<\/span><h3>從一個清楚的需求開始<\/h3>/);
  assert.match(text,/選擇 AI，寫下要完成的事。/);
  assert.match(text,/Codex 可在此執行；網頁 AI 會先開啟手動交接。/);
  assert.doesNotMatch(text,/ここで|ください|⌘/);
  assert.match(a.context.chatHtml(a.p,a.p.tasks[0]),/從一個清楚的需求開始/);
  // The existing non-Windows guidance still resolves the selected language.
  vm.runInContext('state.windowsBrowser=false',a.context);locale.setLocale('ja');
  assert.match(vm.runInContext('EMPTY_CHAT()',a.context),/ここで AI と話します/);
  locale.setLocale('zh-TW');const legacy=vm.runInContext('EMPTY_CHAT()',a.context);
  assert.match(legacy,/在這裡與 AI 對話/);assert.match(legacy,/請在下方選擇回答的 AI 與模型/);
  assert.doesNotMatch(legacy,/ここで|ください|⌘/);
 }finally{locale.setLocale(before);}
});

test('Stop action remains an imperative and is not translated as the stopped task state',()=>{const a=app();const html=a.context.chatHtml(a.p,a.p.tasks[0]);assert.match(html,/id="chat-stop"[^>]*>停止<\/button>/);assert.doesNotMatch(html,/id="chat-stop"[^>]*>已停止/);assert.equal(locale.L('停止'),'已停止');});
