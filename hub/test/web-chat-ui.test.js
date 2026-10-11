'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ui=require('../public/web-chat');
const vm=require('node:vm'),crypto=require('node:crypto');
test('web handoff destinations are fixed and scope/drafts never persist authority tokens',()=>{
 assert.deepEqual(Object.keys(ui.DESTINATIONS),['chatgpt','claude-chat']);
 assert.equal(ui.DESTINATIONS.chatgpt,'https://chatgpt.com/');assert.equal(ui.DESTINATIONS['claude-chat'],'https://claude.ai/');
 assert.notEqual(ui.scopeKey('chatgpt','p','t','r'),ui.scopeKey('claude-chat','p','t','r'));
 const value=ui.snapshot({actor:'chatgpt',project:'p',task:'t',text:'draft',result:'untrusted',preview:{receiptId:'r',previewToken:'SECRET'},approved:{token:'SECRET'},requestId:'id'});
 assert.equal(JSON.stringify(value).includes('SECRET'),false);assert.equal(value.result,'untrusted');
});
test('UI refuses invalid Unicode and preserves content rather than replacing it',()=>{
 assert.equal(ui.scalar('台灣繁體中文😀'),true);assert.equal(ui.scalar('\ud800'),false);assert.equal(ui.scalar('a\0b'),false);assert.equal(ui.scalar(42),false);
});
test('status differentiates historic committed receipt from changed or unknown current targets',()=>{
 const changed=ui.describeStatus({state:'committed',actualTargets:{chat:'saved',task:'changed'}});
 assert.match(changed,/歷史收據已提交/);assert.match(changed,/已變更/);assert.doesNotMatch(changed,/本次核對會話與作業記事已保存/);
 const unknown=ui.describeStatus({state:'planned',partial:true,actualTargets:{chat:'unknown',task:'before'}});assert.match(unknown,/未確認/);assert.match(unknown,/保存前/);
 const saved=ui.describeStatus({state:'committed',actualTargets:{chat:'saved',task:'saved'}});assert.match(saved,/本次核對/);assert.match(saved,/未驗證/);
 assert.match(ui.describeStatus({state:'committed',actualTargets:{chat:'changed',task:'unknown'}},'ja'),/再確認/);
});

test('partial failure status binds route and receipt and exports only safe display fields',()=>{
 const request={actor:'chatgpt',project:'p',task:'t',receiptId:'r'};
 const value={...request,ok:false,partial:true,recoveryRequired:true,state:'chat_saved',durableStage:'chat_saved',actualTargets:{chat:'saved',task:'before'},token:'PRIVATE_TOKEN',error:'PRIVATE_DETAIL'};
 const result=ui.failureStatus('/api/web-chat/result',409,value,request);
 assert.deepEqual(result,{state:'chat_saved',durableStage:'chat_saved',partial:true,recoveryRequired:true,actualTargets:{chat:'saved',task:'before'}});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
 for(const changed of [{task:'other'},{receiptId:'other'},{ok:true},{state:'committed'},{durableStage:'planned'},{actualTargets:{chat:'saved',task:'invalid'}}])assert.equal(ui.failureStatus('/api/web-chat/result',409,{...value,...changed},request),null);
 assert.equal(ui.failureStatus('/api/start',409,value,request),null);assert.equal(ui.failureStatus('/api/web-chat/result',403,value,request),null);
});
test('web result handler cannot automatically execute or mark work complete and opens fixed URL without prompt',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/web-chat.js'),'utf8');
 assert.doesNotMatch(source,/\/api\/(?:chat\/send|term\/start|delegate|continue|task)['"]/);
 assert.match(source,/global\.open\(DESTINATIONS\[entry\.actor\],'_blank','noopener'\)/);
 assert.match(source,/clipboard\.writeText\(text\)/);assert.match(source,/複製失敗/);
});

test('manual UI clipboard refusal, failed save and actor switching retain draft without persisting authority',async()=>{
 const elements=new Map(),storage=new Map(),calls=[],opened=[];let copyRefused=true,saveRefused=true;
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{disabled:false,value:'',textContent:'',setAttribute(){},focus(){}});return elements.get(selector);};
 const sheet={style:{},innerHTML:'',open:false,setAttribute(){},addEventListener(){},querySelector:element,querySelectorAll:()=>[],showModal(){this.open=true;},close(){this.open=false;}};
 const window={document:{createElement:()=>sheet,body:{appendChild(){}}},HubI18n:{locale:'zh-TW'},crypto:{subtle:crypto.webcrypto.subtle,randomUUID:crypto.randomUUID},setTimeout,clearTimeout,navigator:{clipboard:{writeText:async text=>{calls.push({copy:text});if(copyRefused)throw Error('denied');}}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},open:(...args)=>opened.push(args)};
 const context=vm.createContext({window,TextEncoder,Uint8Array,console,confirm:()=>true});vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/web-chat.js'),'utf8'),context);
 const api=async(route,input)=>{calls.push({route,input});if(route.endsWith('/preview'))return {receiptId:'synthetic-receipt',previewToken:'PRIVATE_PREVIEW_TOKEN',taskHash:'a'.repeat(64),promptSHA256:'b'.repeat(64),prompt:'synthetic full prompt <script>'};if(route.endsWith('/confirm'))return {token:'PRIVATE_RESULT_TOKEN'};if(route.endsWith('/result')){if(saveRefused)throw Error('synthetic network refusal');return {ok:true,state:'committed',actualTargets:{chat:'saved',task:'saved'}};}throw Error('unexpected route');};
 window.HubWebChat.open({actor:'chatgpt',project:'p',task:'t',text:'retained synthetic request',api});
 await element('[data-web-preview]').onclick();await element('[data-web-confirm]').onclick();assert.match(sheet.innerHTML,/複製失敗/);
 assert.equal(sheet.innerHTML.includes('synthetic full prompt &lt;script&gt;'),true);assert.equal(opened.length,0);
 element('[data-web-result]').oninput({target:{value:'retained reply <script>injection</script>'}});await element('[data-web-save]').onclick();assert.match(sheet.innerHTML,/synthetic network refusal/);assert.match(sheet.innerHTML,/retained reply &lt;script&gt;/);
 assert.ok([...storage.values()].every(value=>!value.includes('PRIVATE_PREVIEW_TOKEN')&&!value.includes('PRIVATE_RESULT_TOKEN')));
 element('[data-web-actor]').onchange({target:{value:'claude-chat'}});assert.equal(sheet.innerHTML.includes('retained reply'),false);element('[data-web-actor]').onchange({target:{value:'chatgpt'}});assert.match(sheet.innerHTML,/retained reply/);
 copyRefused=false;await element('[data-web-copy]').onclick();assert.match(sheet.innerHTML,/已複製；尚未送到網站/);assert.equal(opened.length,0);
 window.navigator.clipboard.writeText=()=>new Promise(()=>{});window.setTimeout=(callback,milliseconds)=>{assert.equal(milliseconds,5000);return setImmediate(callback);};window.clearTimeout=clearImmediate;
 await element('[data-web-copy]').onclick();assert.match(sheet.innerHTML,/複製尚未確認/);assert.equal(sheet.innerHTML.includes('retained reply'),true);assert.equal(opened.length,0);
 saveRefused=false;await element('[data-web-save]').onclick();assert.equal(sheet.innerHTML.includes('retained reply'),false);assert.match(sheet.innerHTML,/本次核對/);assert.ok(calls.filter(call=>call.route).every(call=>call.route.startsWith('/api/web-chat/')));
});

function interactiveSheet(api,options={}) {
 const nodes=new Map(),storage=new Map();let html='',focused='';
 const element=selector=>{
  if(!nodes.has(selector)){
   const attribute=selector.match(/^\[([^\]]+)\]$/)?.[1],tag=attribute?html.match(new RegExp('<[^>]*\\b'+attribute+'(?:\\s|>)[^>]*>'))?.[0]||'':'';
   nodes.set(selector,{disabled:/\bdisabled\b/.test(tag),hidden:/\bhidden\b/.test(tag),textContent:selector,attributes:{},setAttribute(k,v){this.attributes[k]=v;},focus(){focused=selector;},closest(){return null;}});
  }
  return nodes.get(selector);
 };
 const sheet={open:false,setAttribute(){},addEventListener(){},querySelector:element,querySelectorAll(){return [...nodes.entries()].filter(([key])=>key.startsWith('[data-web-')&&!/status|dirty|prompt/.test(key)).map(([,value])=>value);},showModal(){this.open=true;},close(){this.open=false;}};
 Object.defineProperty(sheet,'innerHTML',{get:()=>html,set:value=>{html=value;nodes.clear();focused='BODY';}});
 const window={document:{createElement:()=>sheet,body:{appendChild(){}}},HubI18n:{locale:'zh-TW'},crypto:{subtle:crypto.webcrypto.subtle,randomUUID:crypto.randomUUID},setTimeout,clearTimeout,navigator:{clipboard:{writeText:async()=>{}}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},open(){throw Error('No external navigation expected');}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/web-chat.js'),'utf8'),{window,TextEncoder,Uint8Array});
 window.HubWebChat.open({actor:'chatgpt',project:'synthetic',task:'test',text:'original',api,...options});
 return{element,sheet,storage,window,get focused(){return focused;}};
}
const syntheticPreview=()=>({receiptId:'test',previewToken:'private-preview',taskHash:'a'.repeat(64),promptSHA256:'b'.repeat(64),prompt:'original preview'});

test('manual handoff communicates pending state, freezes drafts, prevents duplicate requests and restores focus',async()=>{
 let resolve,calls=0;
 const view=interactiveSheet(()=>{calls++;return new Promise(r=>resolve=r);});
 const pending=view.element('[data-web-preview]').onclick();
 assert.match(view.element('[data-web-status]').textContent,/處理中/);
 assert.equal(view.element('[data-web-preview]').textContent,'處理中…');
 assert.equal(view.element('.web-chat-sheet').attributes['aria-busy'],'true');
 for(const selector of ['[data-web-request]','[data-web-result]','[data-web-actor]','[data-web-close]'])assert.equal(view.element(selector).disabled,true);
 view.element('[data-web-request]').oninput({target:{value:'racing edit'}});
 await view.element('[data-web-preview]').onclick();assert.equal(calls,1);
 resolve(syntheticPreview());await pending;
 assert.equal(view.focused,'[data-web-preview]');assert.match(view.sheet.innerHTML,/>original<\/textarea>/);
 assert.doesNotMatch(view.sheet.innerHTML,/racing edit/);assert.equal(view.element('[data-web-request]').disabled,false);
});

test('editing a confirmed request disables stale actions, keeps answer and receipt, and requires a new preview',async()=>{
 const calls=[];
 const view=interactiveSheet(async route=>{calls.push(route);return route.endsWith('/preview')?syntheticPreview():{token:'private-approved'};});
 await view.element('[data-web-preview]').onclick();await view.element('[data-web-confirm]').onclick();
 view.element('[data-web-result]').oninput({target:{value:'retained reply'}});
 view.element('[data-web-request]').oninput({target:{value:'changed'}});
 for(const selector of ['[data-web-confirm]','[data-web-copy]','[data-web-open]','[data-web-save]'])assert.equal(view.element(selector).disabled,true);
 const before=calls.length;
 await view.element('[data-web-confirm]').onclick();await view.element('[data-web-save]').onclick();
 assert.equal(calls.length,before,'stale handler invocation must not reach API');
 assert.match(view.sheet.innerHTML,/retained reply/);assert.match(view.sheet.innerHTML,/original preview/);
 view.element('[data-web-request]').oninput({target:{value:'original'}});
 assert.equal(view.element('[data-web-confirm]').disabled,true,'reverting text must not restore consumed authority');
 await view.element('[data-web-preview]').onclick();assert.equal(view.element('[data-web-confirm]').disabled,false);
 assert.ok([...view.storage.values()].every(value=>!value.includes('private-preview')&&!value.includes('private-approved')));
});

test('partial save shows both target states and preserves reply and authority without success refresh',async()=>{
 let refreshed=false;
 const view=interactiveSheet(async route=>{
  if(route.endsWith('/preview'))return syntheticPreview();
  if(route.endsWith('/confirm'))return {token:'private-approved'};
  throw Object.assign(Error('generic HTTP error'),{webChatStatus:{partial:true,state:'chat_saved',actualTargets:{chat:'saved',task:'before'}}});
 },{refresh:async()=>{refreshed=true;}});
 await view.element('[data-web-preview]').onclick();await view.element('[data-web-confirm]').onclick();
 view.element('[data-web-result]').oninput({target:{value:'partial reply retained'}});
 await view.element('[data-web-save]').onclick();
 assert.match(view.sheet.innerHTML,/部分保存/);assert.match(view.sheet.innerHTML,/會話 已核對保存，作業記事 保存前/);
 assert.match(view.sheet.innerHTML,/partial reply retained/);assert.equal(view.element('[data-web-save]').disabled,false);assert.equal(refreshed,false);
 assert.doesNotMatch(JSON.stringify([...view.storage.values()]),/private-approved/);
});
