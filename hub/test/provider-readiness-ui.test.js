'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const registry=require('../lib/provider-registry'),locale=require('../public/i18n');
for(const name of ['main','main-extra','aux','empty'])locale.add(JSON.parse(fs.readFileSync(path.join(__dirname,'../public/locales/zh-TW-'+name+'.json'),'utf8')));
function fixture({platform='win32',language='zh-TW'}={}){
 locale.setLocale(language);const elements=new Map(),events={},calls=[],messages=[],handoffs=[],confirmations=[];
 const element=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',value:'',textContent:'',hidden:false,disabled:false,dataset:{},style:{},attributes:{},scrollTop:0,scrollHeight:100,clientHeight:100,focus(){},setAttribute(k,v){this.attributes[k]=v;},addEventListener(){},querySelector(){return null;},querySelectorAll(){return[];},insertAdjacentHTML(){}});return elements.get(key);};
 const document={querySelector:element,querySelectorAll:()=>[],addEventListener:(name,fn)=>(events[name]||=[]).push(fn)};
 const context=vm.createContext({document,window:{L:locale.L,UI:locale.UI,HubI18n:locale,HubWebChat:{open:options=>handoffs.push(options)},location:{protocol:'http:'},addEventListener(){}},navigator:{userAgent:''},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>new Promise(()=>{}),EventSource:class{close(){}},setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},requestAnimationFrame(){},URLSearchParams,console,ModelOrder:require('../public/model-order'),ProjectOrder:require('../public/project-order'),confirm:message=>{confirmations.push(message);return true;}});
 const run=code=>vm.runInContext(code,context);run(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'));
 const p={id:'p',name:'原文<USER>',parent:'',status:'進行中',description:'',phases:[],folders:[],related:[],issues:[],chats:[],tasks:[{id:'t',title:'作業',owner:'codex',model:'GPT-6.1-Sol',effort:'高',role:'',state:'未着手',steps:[],skills:[],question:'',copy:false}]};
 context.snapshot={root:'C:\\synthetic',providers:registry.list({platform}),webChatAvailable:platform==='win32',windowsBrowser:platform==='win32',projects:[p],sessions:[],chatting:[],unread:[],terminal:true,agyAvailable:true,efforts:['中','高'],roles:{models:{codex:['GPT-6.1-Sol'],'claude-code':['Opus 5.5'],agy:['Gemini 3.1 Pro (High)'],grok:['Saved model']},roles:[],permissions:{}},initialPick:{ai:'codex',model:'GPT-6.1-Sol',effort:'高'},cliFlags:{},version:'4.68.2',latest:'4.68.2'};
 context.notice=message=>messages.push(message);context.stubApi=async(route,body)=>{calls.push({route,body:JSON.parse(JSON.stringify(body||{}))});return {};};
 run('state=snapshot;view={kind:"project",project:"p",task:null};toast=notice;api=stubApi;load=async()=>{};loadAiTools=()=>{};loadCliModels=()=>{};loadChatgpt=()=>{};loadRemote=()=>{};');
 return{context,run,element,events,calls,messages,handoffs,confirmations,p};
}
const tag=(html,attribute,value)=>html.match(new RegExp('<(?:option|button)[^>]*'+attribute+'="'+value+'"[^>]*>'))?.[0];

test('native Chat authority does not advertise an unimplemented raw PTY start',async()=>{
 const f=fixture();f.run('state.providers=state.providers.map(p=>["claude","grok"].includes(p.id)?{...p,readiness:{...p.readiness,ready:true}}:p)');
 for(const actor of ['claude','grok']){assert.equal(f.run('cliReady("'+actor+'")'),true);assert.equal(f.run('cliTerminalReady("'+actor+'")'),false);await assert.rejects(()=>f.context.startAI('p','t',actor),/對話畫面/);}
 assert.equal(f.run('cliTerminalReady("codex")'),true);
});

test('all platforms use exact registry readiness; missing state never grants a CLI start',async()=>{
 for(const platform of ['win32','darwin']){
  const f=fixture({platform}),html=f.run('quickControls(proj("p"))');
  assert.doesNotMatch(tag(html,'value','codex'),/disabled/);
  assert.match(tag(html,'value','grok'),/disabled/);
  for(const actor of ['claude','agy'])assert.equal(/disabled/.test(tag(html,'value',actor)),platform==='win32');
  await assert.rejects(f.context.startAI('p','t','grok'),/未驗證/);assert.equal(f.calls.length,0);
  await f.context.act({dataset:{act:'handoff',p:'p',t:'t',from:'codex',to:'grok'}});assert.equal(f.calls.length,0);
  f.run('state.providers=[]');assert.equal(f.run('actorReady("codex")'),false);await assert.rejects(f.context.startAI('p','t','codex'),/未驗證/);assert.equal(f.calls.length,0);
 }
});

test('both web quick entries show manual handoff, disable attachments and never show Discord/model controls',async()=>{
 const f=fixture();for(const actor of ['chatgpt','claude-chat']){
  f.context.actor=actor;f.run('Object.assign(quickDraft(proj("p")),{ai:actor,model:"app",effort:"",images:[]})');const html=f.run('quickControls(proj("p"))');
  assert.match(html,/手動交接/);assert.match(html,/網站選擇/);assert.doesNotMatch(html,/Discord|id="quick-model"|id="quick-effort"/);assert.match(tag(html,'id','quick-attach'),/disabled/);
  await f.context.addQuickImages(f.p,[{name:'owned.png',type:'image/png'}]);assert.equal(f.calls.length,0);
 }
});

test('terminal start/handoff controls disable every unready target without disabling verified Codex',()=>{
 const f=fixture();f.run('view={kind:"work",project:"p",task:"t"};workMode=()=>"term";attach=()=>{};renderWork()');let html=f.element('#main').innerHTML;
 for(const actor of ['claude','agy','grok'])assert.match(tag(html,'data-ai',actor),/disabled/);assert.doesNotMatch(tag(html,'data-ai','codex'),/disabled/);
 f.run('state.sessions=[{project:"p",task:"t",ai:"codex",running:true}];renderWork()');html=f.element('#main').innerHTML;
 for(const actor of ['claude','agy','grok'])assert.match(tag(html,'data-to',actor),/disabled/);
});

test('manual workflow labels follow JA/TC while exact actor/project/task values remain opaque',()=>{
 const f=fixture();for(const language of ['zh-TW','ja']){
  locale.setLocale(language);const html=f.run('gptBox(proj("p"),taskOf(proj("p"),"t"),true)');assert.match(html,/data-actor="claude-chat"/);assert.match(html,/data-p="p" data-t="t"/);
  assert.match(html,language==='ja'?/確認してコピー.*手動で送信/:/確認並複製.*人工送出/);assert.match(html,language==='ja'?/Claude 手動引き継ぎ/:/Claude 手動交接/);
  assert.doesNotMatch(html,language==='ja'?/預覽|交接|送出/:/プレビュー|引き継ぎ/);
 }
 locale.setLocale('zh-TW');
});

test('owner/initial/role forms retain six exact actors, preserve blocked assignment and omit web CLI settings',async()=>{
 const f=fixture();f.context.renderOverview(f.p);const owners=f.element('#main').innerHTML.match(/<select name="owner">([\s\S]*?)<\/select>/)[1];
 const values=[...owners.matchAll(/value="([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(values,['claude-code','codex','agy','grok','chatgpt','claude-chat','人']);
 assert.doesNotMatch(tag(owners,'value','grok'),/disabled/,'assignment is separate from execution');
 f.run('state.initialPick={ai:"claude-chat",model:"app",effort:""}');const initial=f.context.initialPickHtml();assert.match(initial,/value="claude-chat" selected/);assert.doesNotMatch(initial,/data-initial="model"|data-initial="effort"/);assert.match(initial,/模型請在網站選擇/);
 f.context.api=async(route,body)=>{f.calls.push({route,body:JSON.parse(JSON.stringify(body))});return{initialPick:body};};
 await f.events.change.find(fn=>fn.toString().includes('dataset.initial'))({target:{dataset:{initial:'ai'},value:'chatgpt'}});assert.deepEqual(f.calls[0].body,{ai:'chatgpt',model:'app',effort:''});
 f.run('state.roles.roles=[{name:"調査",main:{ai:"claude-chat",model:"",effort:""},backup:{ai:"人",model:"",effort:""}}];rolesDraft=null;view.kind="settings";renderSettings()');const settings=f.element('#main').innerHTML;assert.match(settings,/value="grok"/);assert.doesNotMatch(settings,/data-f="model"|data-f="effort"/);
});

test('new-project web initial request creates a handoff and opens its exact scope without a sent-to-AI claim',async()=>{
 const f=fixture();f.run('state.initialPick={ai:"claude-chat",model:"app",effort:""}');
 f.context.FormData=class{get(key){return key==='firstTask'?'合成 initial request':null;}getAll(){return [];}entries(){return [['name','child']][Symbol.iterator]();}};
 f.context.api=async(route,body)=>{f.calls.push({route,body:JSON.parse(JSON.stringify(body))});return route==='/api/project/new'?{id:'child',name:'child'}:{task:'fresh',webManual:true,actor:'claude-chat'};};
 await f.events.submit.find(fn=>fn.toString().includes("'projform'"))({target:{id:'projform',classList:{contains:()=>false}},preventDefault(){}});
 assert.deepEqual(f.calls.find(x=>x.route==='/api/start').body,{project:'child',text:'合成 initial request',ai:'claude-chat',model:'',effort:'',images:[]});assert.equal(f.handoffs.length,1);assert.equal(f.handoffs[0].actor,'claude-chat');assert.equal(f.handoffs[0].project,'child');assert.equal(f.handoffs[0].task,'fresh');assert.match(f.messages[0],/尚未送出/);assert.doesNotMatch(f.messages[0],/已.*AI/);
});

test('split web starts create manual tasks and open the first dialog without replacing it with the last',async()=>{
 const f=fixture();f.run('state.initialPick={ai:"chatgpt",model:"app",effort:""}');let count=0;
 f.context.api=async(route,body)=>{f.calls.push({route,body:JSON.parse(JSON.stringify(body))});return route==='/api/project/new'?{id:'child'+(++count),name:body.name}:{task:'t'+count,webManual:true,actor:'chatgpt'};};
 f.context.splitProject(f.p);assert.match(f.element('#fsheet').innerHTML,/逐一預覽/);f.element('#split-lines').value='one｜first synthetic\ntwo｜second synthetic';await f.element('#split-go').onclick();
 assert.equal(f.calls.filter(x=>x.route==='/api/start').length,2);assert.equal(f.handoffs.length,1);assert.equal(f.handoffs[0].project,'child1');assert.equal(f.handoffs[0].text,'first synthetic');assert.match(f.messages.at(-1),/尚未送出/);assert.doesNotMatch(f.messages.at(-1),/已.*開始/);
});

test('AI-tools static installed metadata cannot enable update or model probes for deferred providers',async()=>{
 const f=fixture();f.run('aiTools=Object.fromEntries(AIS.map(ai=>[ai,{installed:true,version:"synthetic",modelRefreshAvailable:true,updateCheck:{ok:true,available:true,applicable:true,latestVersion:"synthetic"}}]));drawAiTools()');const html=f.element('#ai-tools').innerHTML;
 for(const ai of ['claude','agy','grok'])for(const attr of ['data-ai-check','data-ai-update','data-ai-model-refresh'])assert.match(tag(html,attr,ai),/disabled/);
 await f.context.runAiTool('grok','models');assert.equal(f.calls.length,0);assert.match(f.messages.at(-1),/未驗證/);
});

test('pasted web assistant results show unattested provenance rather than a CLI completed badge in either language',()=>{
 const f=fixture();f.context.row={role:'assistant',ai:'claude-chat',text:'原文<USER>',exit:0,ms:30,webHandoff:{transport:'web-manual'}};
 for(const language of ['zh-TW','ja']){
  locale.setLocale(language);const html=f.run('msgHtml(row)');assert.match(html,language==='ja'?/ユーザー貼り付け／出所未検証/:/使用者貼上／來源未驗證/);assert.doesNotMatch(html,/✓|class="done"/);assert.match(html,/原文&lt;USER&gt;/);
  f.run('state.backgroundStatus={state:"ok",unassigned:2};view={kind:"project",project:"p"};render()');const notice=f.element('#windows-notice').textContent;assert.match(notice,/Claude／Agy／Grok CLI/);assert.match(notice,/ChatGPT／Claude Chat/);assert.match(notice,language==='ja'?/未検証.*手動引き継ぎ/:/尚未驗證.*手動交接/);
 }
 locale.setLocale('zh-TW');const cli=f.run('msgHtml({...row,ai:"codex",webHandoff:undefined})');assert.match(cli,/✓ 已完成/);
});

test('quick web submit preserves the exact request in its manual dialog, refuses attached images and sends no CLI model',async()=>{
 const f=fixture();f.run('Object.assign(quickDraft(proj("p")),{ai:"claude-chat",model:"app",effort:"",images:[]})');
 f.context.api=async(route,body)=>{f.calls.push({route,body:JSON.parse(JSON.stringify(body))});return{task:'fresh',webManual:true,actor:'claude-chat'};};
 const textarea={value:'合成 quick request',disabled:false},form={id:'quickform',dataset:{p:'p'},classList:{contains:()=>false},elements:{namedItem:()=>textarea}},event={target:form,preventDefault(){}};
 await f.events.submit.find(fn=>fn.toString().includes("'projform'"))(event);const started=f.calls[0];assert.equal(started.route,'/api/start');assert.equal(started.body.model,'');assert.equal(started.body.effort,'');assert.equal(started.body.ai,'claude-chat');assert.deepEqual(started.body.images,[]);assert.equal(f.handoffs[0].text,'合成 quick request');assert.match(f.messages[0],/預覽.*手動交接/);assert.equal(textarea.disabled,false);
 f.run('quickDraft(proj("p")).images=[{id:"existing-image"}]');await f.events.submit.find(fn=>fn.toString().includes("'projform'"))(event);assert.equal(f.calls.length,1);assert.equal(f.handoffs.length,1);assert.match(f.messages.at(-1),/移除已附加/);
});
