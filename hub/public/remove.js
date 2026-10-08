'use strict';
// Standalone UI fixtures keep the original language when the runtime is absent.
if(typeof globalThis.L!=='function')globalThis.L=text=>text;
if(typeof globalThis.UI!=='function')globalThis.UI=(strings,...values)=>strings.reduce((out,part,n)=>out+part+(n<values.length?String(values[n]):''),'');
let removePreview=null, removePending=false, removeEpoch=0;
function drawRemoval(d) {
 const el=$('#remove-sheet');el.innerHTML=UI`<div class="remove-box"><h2>「${esc(d.title)}」を削除しますか</h2><h3>ゴミ箱へ移すもの（${d.move.length}）</h3>${d.move.map(x=>`<p>${esc(x.what)}<br><small>${esc(x.path)}</small></p>`).join('')}
 ${d.optional.length?UI`<h3>選べば一緒に移すもの</h3>${d.optional.map(x=>`<label class="maintenance-choice"><input type="checkbox" data-remove-option="${esc(x.id)}"><span>${esc(x.path)}<small>${esc(x.why)}</small></span></label>`).join('')}`:''}
 <h3>残すもの</h3>${d.keep.length?d.keep.map(x=>`<p>${esc(x.path)}<br><small>${esc(x.why)}</small></p>`).join(''):UI`<p>確認した範囲に共有先はありません。</p>`}
 ${d.blockers.length?UI`<h3 class="danger">削除できない理由</h3>${d.blockers.map(x=>`<p class="danger">${esc(x)}</p>`).join('')}`:''}${d.warnings.map(x=>`<p>${esc(x)}</p>`).join('')}
 ${d.typed?UI`<label>資料・成果物を含みます。確認のため「${esc(d.title)}」を入力してください<input id="remove-typed" autocomplete="off"></label>`:''}
 <p>あとで［整理と確認］の記録から元に戻せます。</p><p id="remove-status" role="status"></p><div class="acts"><button class="btn plain" data-remove-action="close" type="button">やめる</button><button class="btn danger" id="remove-apply" data-remove-action="apply" type="button" ${d.blockers.length||d.typed?'disabled':''}>ゴミ箱へ移す</button></div></div>`;
}
async function showRemoval(project,task) {
 if(removePending)return;const epoch=++removeEpoch;
 if(!$('#remove-sheet'))document.body.insertAdjacentHTML('beforeend',UI`<div id="remove-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="削除内容の確認"></div>`);
 $('#remove-sheet').hidden=false;$('#remove-sheet').innerHTML=UI`<div class="remove-box"><p>削除できる範囲を確認しています…</p><button class="btn plain" data-remove-action="close" type="button">閉じる</button></div>`;
 try {const d=await api('/api/hierarchy/remove/preview',{project,task});if(epoch!==removeEpoch)return;removePreview=d;drawRemoval(d);}catch(e){if(epoch===removeEpoch)$('#remove-sheet').innerHTML=UI`<div class="remove-box"><p>${esc(e.message)}</p><button class="btn plain" data-remove-action="close" type="button">閉じる</button></div>`;}
}
async function restoreRemoval(record) {
 if(!confirm(L('ゴミ箱へ移したものを元に戻しますか？同名のファイルは上書きしません。')))return null;
 const r=await api('/api/hierarchy/remove/restore',{record,confirm:true});await load();return r;
}
document.addEventListener('input',e=>{if(e.target.id==='remove-typed')$('#remove-apply').disabled=removePending||removePreview.blockers.length>0||e.target.value!==removePreview.title;});
document.addEventListener('click',async e=>{
 const b=e.target.closest?.('[data-remove-action]');if(!b||removePending)return;
 if(b.dataset.removeAction==='close'){removeEpoch++;$('#remove-sheet').hidden=true;return;}
 if(b.dataset.removeAction!=='apply'||!removePreview||removePreview.blockers.length||b.disabled)return;
 const d=removePreview;removePending=true;b.disabled=true;$('#remove-status').textContent=L('ゴミ箱へ移しています…');
 try {
  const r=await api('/api/hierarchy/remove/apply',{token:d.token,optional:[...document.querySelectorAll('[data-remove-option]:checked')].map(x=>x.dataset.removeOption),typed:$('#remove-typed')?.value,confirm:true});
  $('#remove-status').textContent=r.failed.length?UI`途中で止まりました。移した${r.moved.length}件は元に戻せます。${r.failed.map(x=>x.why).join(' / ')}`:UI`${r.moved.length}件をゴミ箱へ移しました。`;
  if(r.moved.length){$('#remove-status').insertAdjacentHTML('beforeend',UI` <button class="btn plain sm" data-remove-restore="${esc(r.record)}" type="button">元に戻す</button>`);if(view.project===d.project&&(!d.task||view.task===d.task)){const p=proj(d.project);view={kind:'project',project:d.task?d.project:displayParent(p,state.projects)||'Project Hub',task:null};save();}await load();}
 }catch(err){$('#remove-status').textContent=err.message;}
 finally{removePending=false;/* 古いプレビューで再送しない */}
});
document.addEventListener('click',async e=>{const b=e.target.closest?.('[data-remove-restore]');if(!b||b.disabled)return;b.disabled=true;try{const r=await restoreRemoval(b.dataset.removeRestore);if(r){b.parentElement.textContent=r.skipped.length?UI`戻した${r.restored}件。残した理由：${r.skipped.map(x=>x.why).join(' / ')}`:UI`${r.restored}件を元に戻しました`;}}catch(err){toast(err.message);}finally{b.disabled=false;}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!removePending&&$('#remove-sheet')){removeEpoch++;$('#remove-sheet').hidden=true;}});
