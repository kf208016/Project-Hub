(function(global){
 'use strict';
 const SUPPORTED=['zh-TW','ja'],dictionary=Object.create(null);let locale='zh-TW',keys=[];
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function add(values){if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>10000)throw Error('語言檔格式無效');const entries=Object.entries(values);for(const [key,value]of entries){if(['__proto__','constructor','prototype'].includes(key)||typeof value!=='string'||key.length>10000||value.length>10000||/[\ue000\ue001\ue100\ue101]/.test(key+value))throw Error('語言檔內容無效');}for(const [key,value]of entries)dictionary[key]=value;keys=Object.keys(dictionary).filter(key=>key&&key.length>1).sort((a,b)=>b.length-a.length||a.localeCompare(b,'en'));}
 function L(text){if(typeof text!=='string'||locale==='ja')return text;const trimmed=text.trim();if(Object.hasOwn(dictionary,text))return dictionary[text];if(Object.hasOwn(dictionary,trimmed))return text.slice(0,text.indexOf(trimmed))+dictionary[trimmed]+text.slice(text.indexOf(trimmed)+trimmed.length);return text;}
 function fragment(text){if(locale==='ja')return text;const exact=L(text);if(exact!==text)return exact;let result=text;const markers=[];for(const key of keys){if(!result.includes(key))continue;const marker='\ue100'+markers.length+'\ue101';result=result.split(key).join(marker);markers.push(dictionary[key]);}return result.replace(/\ue100(\d+)\ue101/g,(_,n)=>markers[Number(n)]);}
 function translateHtml(html){
  // Input consists only of trusted template fragments and opaque markers.
  // Never inspect dynamic values, user names, paths, messages or model output.
  html=html.replace(/<option\b([^>]*?)>([^<\ue000]*)<\/option>/g,(all,attributes,text)=>!/(?:^|\s)value\s*=/.test(attributes)&&fragment(text)!==text?'<option'+attributes+' value="'+escape(text.trim())+'">'+text+'</option>':all);
  return html.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/g).map(part=>part.startsWith('<')?part.replace(/\b(aria-label|aria-description|title|placeholder)=("([^"]*)"|'([^']*)')/g,(all,name,quoted,double,single)=>name+'="'+escape(fragment(double??single))+'"'):escape(fragment(part)).replace(/&amp;((?:#\d+|#x[0-9a-f]+|[a-z]+);)/gi,'&$1')).join('');
 }
 function UI(strings,...values){let text='';for(let n=0;n<strings.length;n++){text+=strings[n];if(n<values.length)text+='\ue000'+n+'\ue001';}const html=text.includes('<')?translateHtml(text):fragment(text);return html.replace(/\ue000(\d+)\ue001/g,(_,n)=>String(values[Number(n)]??''));}
 function setLocale(value){if(!SUPPORTED.includes(value))throw Error('不支援的介面語言');locale=value;}
 const api={L,UI,add,setLocale,get locale(){return locale;},supported:SUPPORTED.slice()};
 if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
 global.HubI18n=api;global.L=L;global.UI=UI;
 try{const saved=global.localStorage.getItem('hub-language');if(SUPPORTED.includes(saved))setLocale(saved);}catch{}
 global.document.documentElement.lang=locale==='zh-TW'?'zh-Hant':'ja';
 global.hubI18nReady=(async()=>{if(locale==='ja')return;for(const file of ['zh-TW-main.json','zh-TW-main-extra.json','zh-TW-aux.json','zh-TW-empty.json']){const response=await global.fetch('locales/'+file,{cache:'no-cache'});if(!response.ok)throw Error('無法載入繁體中文語言檔');const bytes=await response.arrayBuffer();if(bytes.byteLength>1024*1024)throw Error('語言檔超過大小上限');add(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}global.document.querySelectorAll('[data-i18n]').forEach(element=>{element.textContent=L(element.textContent);});global.document.querySelectorAll('[data-i18n-attrs]').forEach(element=>{for(const name of element.dataset.i18nAttrs.split(',')){if(!['title','aria-label','aria-description','placeholder'].includes(name))throw Error('靜態翻譯屬性無效');element.setAttribute(name,L(element.getAttribute(name)||''));}});})();
 global.hubI18nReady.catch(error=>{const main=global.document.querySelector('#main');if(main)main.textContent=error.message;global.document.querySelectorAll('button,input,select,textarea').forEach(element=>{element.disabled=true;});});
 global.document.addEventListener('change',event=>{if(event.target?.id!=='hub-language')return;const before=locale;try{if(global.HubPrepareLanguageChange?.()===false){event.target.value=locale;return;}setLocale(event.target.value);global.localStorage.setItem('hub-language',locale);global.location.reload();}catch(error){setLocale(before);event.target.value=before;global.alert(error.message);}});
})(typeof window==='undefined'?globalThis:window);
