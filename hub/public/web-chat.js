(function(global){
 'use strict';
 const DESTINATIONS=Object.freeze({chatgpt:'https://chatgpt.com/','claude-chat':'https://claude.ai/'});
 const LABELS=Object.freeze({chatgpt:'ChatGPT Chat','claude-chat':'Claude Chat'});
 const scopeKey=(actor,project,task,receipt='draft')=>JSON.stringify([actor,project,task,receipt]);
 const scalar=text=>typeof text==='string'&&text.isWellFormed()&&!text.includes('\0');
 const snapshot=entry=>({actor:entry.actor,project:entry.project,task:entry.task,receiptId:entry.preview?.receiptId||entry.receiptId||'',text:entry.text||'',result:entry.result||'',requestId:entry.requestId||''});
 function describeStatus(value,locale='zh-TW'){
   if(!value)return '';
   const ja=locale==='ja',state=value.durableStage||value.state||value.receipt?.state||'',targets=value.actualTargets;
   const labels=ja?{saved:'保存確認済み',before:'保存前',changed:'変更あり',missing:'不在',unknown:'未確認','not-accepted':'未受理'}:{saved:'已核對保存',before:'保存前',changed:'已變更',missing:'不存在',unknown:'未確認','not-accepted':'尚未接受'};
   const detail=targets?(ja?'現在のファイル：会話 ':'目前檔案：會話 ')+(labels[targets.chat]||labels.unknown)+(ja?'、作業メモ ':'，作業記事 ')+(labels[targets.task]||labels.unknown)+'。':'';
   if(state==='committed')return targets?.chat==='saved'&&targets?.task==='saved'?(ja?'今回の照合で会話と作業メモの保存を確認。ユーザー貼付で、出所は未検証です。':'本次核對會話與作業記事已保存；來源為使用者貼上，未驗證網頁／模型。'):(ja?'履歴上は保存済みですが、現在のファイルは再確認が必要です。':'歷史收據已提交；目前檔案需再確認。')+detail;
   if(value.partial)return (ja?'一部保存。回答を残して状態を確認・復旧してください。':'部分保存；回答已保留，請查看狀態或復原。')+detail;
   return (ja?'取引の状態：':'交易狀態：')+state+'。'+detail;
 }
 const exports={DESTINATIONS,LABELS,scopeKey,scalar,snapshot,describeStatus};
 if(typeof module!=='undefined'&&module.exports){module.exports=exports;return;}
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const entries=new Map();let sheet=null,current=null;
 const local=(zh,ja)=>global.HubI18n?.locale==='ja'?ja:zh;
 const error=message=>{const target=sheet?.querySelector('[data-web-status]');if(target){target.textContent=message;target.setAttribute('role','status');}};
 async function digest(text){const bytes=new TextEncoder().encode(text),hash=await global.crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
 function persist(entry){try{global.localStorage.setItem('hub-web-draft-'+scopeKey(entry.actor,entry.project,entry.task),JSON.stringify(snapshot(entry)));}catch{error(local('草稿無法保存到瀏覽器；請保留此視窗或自行複製。','下書きを保存できません。この画面を残すか手動でコピーしてください。'));}}
 function restore(actor,project,task){try{const value=JSON.parse(global.localStorage.getItem('hub-web-draft-'+scopeKey(actor,project,task))||'null');if(value&&value.actor===actor&&value.project===project&&value.task===task&&scalar(value.text)&&scalar(value.result))return value;}catch{}return {text:'',result:''};}
 function statusText(value){return describeStatus(value,global.HubI18n?.locale);}
 function render(entry){
   const preview=entry.preview,approved=Boolean(entry.approved),title=LABELS[entry.actor];
   sheet.innerHTML=`<style>#web-chat-dialog label{display:block;margin:12px 0}#web-chat-dialog textarea{display:block;box-sizing:border-box;width:100%;margin-top:6px;font:inherit;line-height:1.5}#web-chat-dialog [data-web-prompt]{font:14px ui-monospace,monospace}#web-chat-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere}#web-chat-dialog .dh{display:flex;justify-content:space-between;align-items:center}#web-chat-dialog button{margin:4px 4px 4px 0}</style><form method="dialog" class="web-chat-sheet">
    <header class="dh"><h2 id="web-chat-title">${esc(local('網頁 AI 手動交接','Web AI 手動引き継ぎ'))}</h2><button type="button" data-web-close class="btn plain">${esc(local('關閉','閉じる'))}</button></header>
    <p>${esc(local('不使用模型 API。請自行在網站登入、貼上與送出，再將回答貼回同一作業。','モデル API は使いません。サイトでログイン・貼付・送信し、回答を同じ作業に貼り戻してください。'))}</p>
    <label>${esc(local('目的地','送信先'))} <select data-web-actor aria-label="${esc(local('網頁 AI','Web AI'))}">${Object.keys(DESTINATIONS).map(actor=>`<option value="${actor}" ${actor===entry.actor?'selected':''}>${LABELS[actor]}</option>`).join('')}</select></label>
    <p class="small">${esc(entry.project)} / ${esc(entry.task)} · ${esc(DESTINATIONS[entry.actor])}</p>
    <label>${esc(local('此次需求','今回の依頼'))}<textarea data-web-request rows="3" maxlength="49152">${esc(entry.text)}</textarea></label>
    <button type="button" data-web-preview class="btn">${esc(local('預覽交接內容','引き継ぎ内容をプレビュー'))}</button>
    <section data-web-preview-section ${preview?'':'hidden'}>
     <h3>${esc(local('實際交接內容','実際の引き継ぎ内容'))}</h3><textarea data-web-prompt rows="9" readonly aria-label="${esc(local('完整預览提示詞','プレビュー全文'))}">${esc(preview?.text||preview?.prompt||'')}</textarea>
     <details><summary>${esc(local('來源與截斷','出所と省略'))}</summary><pre data-web-sources>${esc(JSON.stringify({sources:preview?.sourceManifest||[],truncation:preview?.truncation||[]},null,2))}</pre></details>
     <p class="small">${esc(local('確認僅准許此次人工交接；Hub 不會自動送出。預覽有效 5 分鐘。','確認は今回の手動引き継ぎだけを許可します。Hub は自動送信しません。プレビューは5分有効です。'))}</p>
     <button type="button" data-web-confirm class="btn" ${approved?'disabled':''}>${esc(local('確認目的地與內容，並複製','送信先と内容を確認してコピー'))}</button>
     <button type="button" data-web-copy class="btn plain" ${approved?'':'disabled'}>${esc(local('再次複製','再コピー'))}</button>
     <button type="button" data-web-open class="btn plain" ${approved?'':'disabled'}>${esc(local('開啟','開く'))} ${esc(title)}</button>
    </section>
    <label>${esc(local('將回答貼回（來源未驗證）','回答を貼り戻す（出所未検証）'))}<textarea data-web-result rows="6">${esc(entry.result)}</textarea></label>
    <p class="small">${esc(local('只保存文字，不會執行回覆中的命令、自動交給 CLI 或完成作業。','文章のみ保存します。回答中の命令・CLI実行・作業完了は自動で行いません。'))}</p>
    <button type="button" data-web-save class="btn" ${approved?'':'disabled'}>${esc(local('保存到此作業','この作業に保存'))}</button>
    <button type="button" data-web-status-button class="btn plain" ${entry.receiptId||preview?'':'disabled'}>${esc(local('查看交易狀態','取引状態を見る'))}</button>
    <button type="button" data-web-recover class="btn plain" ${entry.receiptId||preview?'':'disabled'}>${esc(local('復原已接受的保存','受理済み保存を復旧'))}</button>
    <button type="button" data-web-revoke class="btn plain" ${entry.receiptId||preview?'':'disabled'}>${esc(local('撤銷此次交接','今回の引き継ぎを取り消す'))}</button>
    <p data-web-status role="status">${esc(entry.message||'')}</p>
   </form>`;
   sheet.querySelector('[data-web-close]').onclick=()=>{persist(entry);sheet.close();};
   sheet.querySelector('[data-web-actor]').onchange=e=>{persist(entry);open({...entry.options,actor:e.target.value,text:undefined});};
   sheet.querySelector('[data-web-request]').oninput=e=>{entry.text=e.target.value;persist(entry);};
   sheet.querySelector('[data-web-result]').oninput=e=>{entry.result=e.target.value;persist(entry);};
   const bind=(selector,action)=>{sheet.querySelector(selector).onclick=async()=>{
     if(entry.busy||current!==entry)return;entry.busy=true;
     sheet.querySelectorAll('button').forEach(button=>button.disabled=true);
     try{await action();}catch(err){entry.message=err.message||local('操作失敗，草稿已保留。','操作に失敗しました。下書きは残しています。');}
     finally{entry.busy=false;if(current===entry){render(entry);error(entry.message||'');}}
   };};
   const copy=async()=>{const text=entry.preview?.text||entry.preview?.prompt||'';let timer;try{await Promise.race([global.navigator.clipboard.writeText(text),new Promise((_,reject)=>{timer=global.setTimeout(()=>reject(Object.assign(Error('CLIPBOARD_UNCONFIRMED'),{unconfirmed:true})),5000);})]);entry.message=local('已複製；尚未送到網站。','コピーしました。サイトには未送信です。');}catch(cause){entry.message=cause?.unconfirmed?local('複製尚未確認；請手動選取完整交接內容並複製。尚未送出。','コピーの完了を確認できません。全文を選択して手動コピーしてください。未送信です。'):local('複製失敗；請手動選取完整交接內容並複製。尚未送出。','コピーに失敗しました。全文を選択して手動コピーしてください。未送信です。');}finally{global.clearTimeout(timer);}};
   bind('[data-web-preview]',async()=>{
     if(!scalar(entry.text))throw Error(local('需求包含無效文字。','依頼の文字が無効です。'));
     const value=await entry.options.api('/api/web-chat/preview',{actor:entry.actor,project:entry.project,task:entry.task,text:entry.text,responseLanguage:global.HubI18n?.locale==='ja'?'ja':'zh-TW'});
     entry.preview=value;entry.receiptId=value.receiptId;entry.approved=null;entry.requestId='';entry.message=local('請檢查完整提示詞、來源及截斷後確認。','全文、出所、省略を確認してください。');persist(entry);
   });
   bind('[data-web-confirm]',async()=>{
     const p=entry.preview;if(!p)throw Error('HANDOFF_PREVIEW_REQUIRED');
     entry.approved=await entry.options.api('/api/web-chat/confirm',{actor:entry.actor,project:entry.project,task:entry.task,receiptId:p.receiptId,previewToken:p.previewToken,expectedTaskHash:p.taskHash,expectedPromptSHA256:p.promptSHA256,confirm:true});
     await copy();
   });
   bind('[data-web-copy]',copy);
   sheet.querySelector('[data-web-open]').onclick=()=>{if(!entry.approved||entry.busy)return;global.open(DESTINATIONS[entry.actor],'_blank','noopener');entry.message=local('網站已開啟；請自行貼上並送出。','サイトを開きました。自分で貼り付けて送信してください。');error(entry.message);};
   bind('[data-web-save]',async()=>{
     if(!entry.approved||!entry.preview)throw Error('HANDOFF_PREVIEW_REQUIRED');
     if(!scalar(entry.result)||!entry.result.trim()||new TextEncoder().encode(entry.result).length>256*1024)throw Error(local('回答必須是有效文字，最多 256 KiB。','回答は有効な文字で256 KiB以下にしてください。'));
     entry.requestId ||= global.crypto.randomUUID();persist(entry);
     const value=await entry.options.api('/api/web-chat/result',{actor:entry.actor,project:entry.project,task:entry.task,receiptId:entry.preview.receiptId,taskHash:entry.preview.taskHash,promptSHA256:entry.preview.promptSHA256,requestId:entry.requestId,resultSHA256:await digest(entry.result),text:entry.result,token:entry.approved.token});
     entry.message=statusText(value);
     if(value.ok===true&&!value.partial&&value.state==='committed'&&value.actualTargets?.chat==='saved'&&value.actualTargets?.task==='saved'){entry.result='';entry.approved=null;persist(entry);await entry.options.refresh?.();}
   });
   const ref=()=>({actor:entry.actor,project:entry.project,task:entry.task,receiptId:entry.preview?.receiptId||entry.receiptId});
   bind('[data-web-status-button]',async()=>{entry.message=statusText(await entry.options.api('/api/web-chat/status',ref()));});
   bind('[data-web-recover]',async()=>{
     const preview=await entry.options.api('/api/web-chat/recover/preview',ref());
     const details=(preview.actions||[]).map(action=>`${action.target}: ${action.relative}\nFileID: ${action.currentFileFingerprint||'missing'}\nSHA-256: ${action.currentSHA256||'missing'}\n→ ${action.acceptedAfterSHA256}\n${action.willOverwrite?local('會覆寫此已接受交易的目前目標。','受理済み取引の現在の対象を上書きします。'):local('只對帳已接受的內容。','受理済み内容のみ照合します。')}`).join('\n\n');
     if(!global.confirm(local('確認復原先前已接受的這筆保存？\n','以前に受理した保存を復旧しますか？\n')+details)){entry.message=local('已取消復原，內容與紀錄保留。','復旧を取り消しました。内容と記録は残しています。');return;}
     const value=await entry.options.api('/api/web-chat/recover',{...ref(),confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256});entry.message=statusText(value);
     if(value.state==='committed'&&!value.partial&&value.actualTargets?.chat==='saved'&&value.actualTargets?.task==='saved'){entry.result='';entry.approved=null;persist(entry);await entry.options.refresh?.();}
   });
   bind('[data-web-revoke]',async()=>{const value=await entry.options.api('/api/web-chat/revoke',ref());entry.approved=null;entry.message=statusText(value);});
 }
 function open(options){
   const {actor,project,task}=options;if(!Object.hasOwn(DESTINATIONS,actor)||typeof project!=='string'||typeof task!=='string'||typeof options.api!=='function')throw Error('HANDOFF_SCOPE_INVALID');
   if(current?.busy)throw Error(local('保存中，請等待交易完成。','保存中です。取引の完了を待ってください。'));
   const key=scopeKey(actor,project,task);let entry=entries.get(key);
   if(!entry){entry={...restore(actor,project,task),actor,project,task};entries.set(key,entry);}
   if(options.text!==undefined)entry.text=options.text;
   entry.options=options;current=entry;
   if(!sheet){sheet=global.document.createElement('dialog');sheet.id='web-chat-dialog';sheet.setAttribute('aria-labelledby','web-chat-title');sheet.style.cssText='width:min(760px,calc(100vw - 32px));max-height:90vh;padding:20px;border:1px solid #888;border-radius:8px;overflow:auto';sheet.addEventListener('cancel',event=>{if(current?.busy){event.preventDefault();return;}persist(current);});global.document.body.appendChild(sheet);}
   render(entry);if(!sheet.open)sheet.showModal();
   sheet.querySelector('[data-web-request]').focus();
 }
 global.HubWebChat={...exports,open};
})(typeof window==='undefined'?globalThis:window);
