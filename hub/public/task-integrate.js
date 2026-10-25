'use strict';
// Standalone UI fixtures keep the original language when the runtime is absent.
if(typeof globalThis.L!=='function')globalThis.L=text=>text;
if(typeof globalThis.UI!=='function')globalThis.UI=(strings,...values)=>strings.reduce((out,part,n)=>out+part+(n<values.length?String(values[n]):''),'');
let integratePreview=null,integrateBusy=false,integrateEpoch=0;
const integrateKey=x=>x.project+'\0'+x.task;
function integrateChoices(){
  const d=integratePreview;if(!d||d.resume)return;
  document.querySelectorAll('[data-integrate-item]').forEach(el=>{
    const i=d.items[Number(el.dataset.integrateItem)];if(!i)return;
    i.checked=Boolean(el.querySelector('[data-integrate-check]')?.checked);
    i.chosenFiles=[...el.querySelectorAll('[data-integrate-file]:checked')].map(x=>x.dataset.integrateFile);
    i.chosenOptional=[...el.querySelectorAll('[data-integrate-optional]:checked')].map(x=>x.dataset.integrateOptional);
  });
}
function drawTaskIntegration(){
  const d=integratePreview,sheet=$('#integrate-sheet');
  sheet.innerHTML=UI`<div class="remove-box"><h2>${d.resume?L('統合の続きを行う'):L('子作業の成果を統合する')}</h2><p>統合先：${esc(d.target)}</p><p>${(typeof state!=='undefined'&&state.windowsBrowser)?'先依核准順序完成 Git 合併，再依序接收成果並將已核准的工作複本與管理檔移至可復原區。失敗時停止並保留交易紀錄；內容或 FileID 改變需重新檢查。':L('1件ずつ統合し、成果を保存した後に、その子のコピー・管理記録・専用一時フォルダをゴミ箱へ移します。ぶつかったらそこで止め、済んだ子の成果は保持します。')}</p>
    ${d.requiresSkipHooksConfirmation?'<p>此批次 Git 操作會略過預覽列出的 hooks。</p><label><input type="checkbox" id="integrate-hooks">核准本次略過 hooks</label>':''}
    ${(typeof state!=='undefined'&&state.windowsBrowser)?`<details><summary>原生移動核准範圍</summary>${d.items.flatMap(i=>i.nativeCleanup?.entries||[]).map(e=>`<p>${esc(e.from)} → ${esc(e.to)}<br>FileID：<code>${esc(e.objectId)}</code><br>Tree SHA-256：<code>${esc(e.treeHash)}</code></p>`).join('')}</details>`:''}
    ${d.items.map((i,n)=>d.resume?`<p>${esc(i.title)}：${esc(i.state)}</p>`:UI`<section class="integration-item" data-integrate-item="${n}"><label class="maintenance-choice"><input type="checkbox" data-integrate-check ${i.checked?'checked':''} ${i.blockers.length?'disabled':''}><b>${esc(i.route || i.title)}</b></label><p>${i.handedUp?L('渡し済み'):L('未引渡し（自動で拾います）')} ／ 変更 ${i.preview?.files || i.integrated?.files?.length || 0} ファイル</p>
    ${i.preview?.conflict?UI`<p class="danger">統合先とぶつかる可能性があります。</p>`:''}${i.preview?.mainDirty?UI`<p>統合先に未保存の変更があります。統合前に保存します。</p>`:''}${i.overlaps?.length?UI`<p>変更ファイルが重なる子：${i.overlaps.map(esc).join('、')}</p>`:''}
    ${i.blockers.map(x=>`<p class="danger">${esc(x)}</p>`).join('')}
    <div class="acts"><button class="btn plain sm" data-integrate-action="up" data-index="${n}" type="button" ${n===0?'disabled':''}>↑</button><button class="btn plain sm" data-integrate-action="down" data-index="${n}" type="button" ${n===d.items.length-1?'disabled':''}>↓</button></div>
    <details open><summary>受け取る成果ファイル</summary>${i.files.map(f=>`<label class="maintenance-choice"><input type="checkbox" data-integrate-file="${esc(f.id)}" ${(i.chosenFiles || []).includes(f.id)?'checked':''}>${esc(f.id)} <small>${f.bytes} bytes</small></label>`).join('') || UI`<p>コードの統合記録を受け取ります。</p>`}</details>
    <details><summary>片付けるもの・残すもの</summary>${i.copy?UI`<p>ゴミ箱：作業用コピー全体（中の一時ファイルも含む）</p>`:''}${i.move.map(f=>UI`<p>ゴミ箱：${esc(f.path)}</p>`).join('')}${i.optional.map(f=>UI`<label class="maintenance-choice"><input type="checkbox" data-integrate-optional="${esc(f.id)}" ${(i.chosenOptional || []).includes(f.id)?'checked':''}>ゴミ箱へ移す：${esc(f.path)}</label>`).join('')}${i.keep.map(f=>UI`<p>残す：${esc(f.path)}<br>${esc(f.why)}</p>`).join('')}<p>残す：受け取った成果、共有ファイル、操作・受領・統合・復元の記録</p></details></section>`).join('')}
    ${d.items.length?'':UI`<p>今、統合できる完了子作業はありません。</p>`}<p id="integrate-status" role="status"></p><div class="acts"><button class="btn plain" data-integrate-action="close" type="button">やめる</button><button class="btn" data-integrate-action="apply" type="button" ${!d.resume&&!d.items.some(i=>i.checked)?'disabled':''}>${d.resume?L('統合の続きを行う'):L('選んだ成果を統合する')}</button></div></div>`;
}
async function showTaskIntegration(project,task,only){
  if(integrateBusy)return;const epoch=++integrateEpoch;integratePreview=null;
  if(!$('#integrate-sheet'))document.body.insertAdjacentHTML('beforeend',UI`<div id="integrate-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="子作業の統合確認"></div>`);
  const sheet=$('#integrate-sheet');sheet.hidden=false;sheet.innerHTML=UI`<div class="remove-box"><p>子作業の成果と統合先を確認しています…</p><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></div>`;
  try{const d=await api('/api/task/integrate/preview',{project,task,only});if(epoch!==integrateEpoch)return;integratePreview={...d,project,task,only};if(!d.resume)for(const i of d.items){i.checked=!i.blockers.length;i.chosenFiles=i.selected;i.chosenOptional=[];}drawTaskIntegration();}
  catch(e){if(epoch===integrateEpoch)sheet.innerHTML=UI`<div class="remove-box"><p>${esc(transferError(e))}</p><button class="btn plain" data-integrate-action="close" type="button">閉じる</button></div>`;}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-integrate-action]');if(!b||b.disabled||integrateBusy)return;
  const action=b.dataset.integrateAction;
  if(action==='close'){integrateEpoch++;$('#integrate-sheet').hidden=true;return;}
  const d=integratePreview;if(!d)return;
  integrateChoices();
  if(action==='up'||action==='down'){const n=Number(b.dataset.index),to=n+(action==='up'?-1:1);if(to>=0&&to<d.items.length){[d.items[n],d.items[to]]=[d.items[to],d.items[n]];drawTaskIntegration();}return;}
  if(action==='refresh'){await showTaskIntegration(d.project,d.task,d.only);return;}
  if(action!=='apply')return;
  if(d.requiresSkipHooksConfirmation&&!$('#integrate-hooks')?.checked){$('#integrate-status').textContent='請先核准本次 Git hooks 處理';return;}
  integrateBusy=true;b.disabled=true;$('#integrate-status').textContent=L('成果を統合し、保存と片付けを進めています…');
  try{
    const selected=d.resume?undefined:d.items.filter(i=>i.checked).map(i=>({project:i.project,task:i.task,files:i.chosenFiles,optional:i.chosenOptional}));
    const result=await api('/api/task/integrate',{project:d.project,task:d.task,token:d.token,selected,confirm:true,...((typeof state!=='undefined'&&state.windowsBrowser)?{skipHooks:d.requiresSkipHooksConfirmation===true}:{})});
    if(result.complete!==true)throw Error('整合尚未完成，請重新檢查交易紀錄並繼續');
    await load();render();$('#integrate-sheet').hidden=true;toast(L('選んだ成果を統合し、成功した子をゴミ箱へ移しました'));
  }catch(e){$('#integrate-status').textContent=transferError(e);$('#integrate-status').insertAdjacentHTML('beforeend',UI` <button class="btn plain sm" data-integrate-action="refresh" type="button">続きを確認する</button>`);await load();}
  finally{integrateBusy=false;}
});
document.addEventListener('change',e=>{
  if(!e.target.closest?.('[data-integrate-item]')||integrateBusy)return;
  integrateChoices();const d=integratePreview;if(!d||d.resume)return;
  if(e.target.matches?.('[data-integrate-check]')){
    const i=d.items[Number(e.target.closest('[data-integrate-item]').dataset.integrateItem)];
    if(i.checked)for(const child of i.descendants){const x=d.items.find(x=>integrateKey(x)===integrateKey(child));if(x&&!x.blockers.length)x.checked=true;}
    else for(const parent of d.items)if(parent.descendants.some(x=>integrateKey(x)===integrateKey(i)))parent.checked=false;
    drawTaskIntegration();
  }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!integrateBusy&&$('#integrate-sheet')){integrateEpoch++;$('#integrate-sheet').hidden=true;}});
