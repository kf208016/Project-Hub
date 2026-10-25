'use strict';
// Standalone UI fixtures keep the original language when the runtime is absent.
if(typeof globalThis.L!=='function')globalThis.L=text=>text;
if(typeof globalThis.UI!=='function')globalThis.UI=(strings,...values)=>strings.reduce((out,part,n)=>out+part+(n<values.length?String(values[n]):''),'');
let transferPreview = null, transferPending = false, transferEpoch = 0;
function drawTaskTransfer(d, paths = '') {
  const sheet = $('#transfer-sheet');
  sheet.innerHTML = UI`<div class="remove-box"><h2>「${esc(d.title)}」を本作業へ渡す</h2><p>渡す先：<b>${esc(d.target)}</b></p>
    <p>${d.offer?L('渡し済みを記録して親へ通知します。作業用コピー・会話は残し、取り込みと片付けは親の［統合…］で行います。'):L('成果を保存して本作業へ通知した後、この作業の管理記録・会話をゴミ箱へ移します。成果の元ファイル・共有ファイルは残します。')}</p>
    ${d.resume ? UI`<p>前回保存した成果を使って、通知・片付けの残りを続けます。</p>` : UI`<h3>渡す成果ファイル</h3><div class="transfer-files">${d.files.map(f=>`<label class="maintenance-choice"><input type="checkbox" data-transfer-file="${esc(f.id)}"><span>${esc(f.id)}<small>${f.bytes} bytes</small></span></label>`).join('') || UI`<p>候補がありません。下の欄でファイルを指定できます。</p>`}</div>
    ${d.integrated ? UI`<p>本体への取り込み済み：${esc(d.integrated.dir)}</p><details><summary>取り込んだ変更</summary>${d.integrated.files.map(f=>`<p>${esc(f)}</p>`).join('')}</details>` : ''}
    <details ${d.files.length?'':'open'}><summary>ほかの成果ファイルを指定</summary><label>プロジェクト内の相対パスを1行に1ファイル。本体内は body: を先頭に付けます。<textarea id="transfer-paths" class="transfer-paths" placeholder="資料/調査.txt&#10;body:src/app.js">${esc(paths)}</textarea></label><button class="btn plain" data-transfer-action="refresh" type="button">ファイルを確認</button></details>
    ${d.offer?UI`<p>この操作ではファイルを片付けません。片付けるものは親の［統合…］で確認できます。</p>`:UI`<details><summary>片付ける管理記録・残すファイル</summary>${(d.move||[]).map(f=>UI`<p>ゴミ箱：${esc(f.path)}</p>`).join('')}${(d.keep||[]).map(f=>UI`<p>残す：${esc(f.path)}<br>${esc(f.why)}</p>`).join('')}</details>`}`}
    <p>${esc(d.guidance)}</p>${d.blockers.map(x=>`<p class="danger">${esc(x)}</p>`).join('')}
    <p id="transfer-status" role="status"></p><div class="acts"><button class="btn plain" data-transfer-action="close" type="button">やめる</button><button class="btn" data-transfer-action="apply" type="button" ${d.blockers.length || !d.resume && !d.integrated?.files?.length && !d.hasCode && !d.selected?.length?'disabled':''}>${d.resume?L('引渡しの残りを続ける'):d.offer?L('成果を渡す'):L('本作業へ渡して片付ける')}</button></div></div>`;
  if(d.offer)sheet.querySelectorAll('[data-transfer-file]').forEach(x=>{x.checked=(d.selected || []).includes(x.dataset.transferFile);});
}
const transferError = e => e.status === 404 && e.message === 'not found' ? transferUpdateMessage() : e.message;
async function showTaskTransfer(project,task,paths = [],expectTitle) {
  if(transferPending)return; const epoch=++transferEpoch;transferPreview=null;
  if(!$('#transfer-sheet'))document.body.insertAdjacentHTML('beforeend',UI`<div id="transfer-sheet" class="remove-sheet" hidden role="dialog" aria-modal="true" aria-label="本作業への引渡し確認"></div>`);
  $('#transfer-sheet').hidden=false;$('#transfer-sheet').innerHTML=UI`<div class="remove-box"><p>成果と渡す先を確認しています…</p><button class="btn plain" data-transfer-action="close" type="button">閉じる</button></div>`;
  try {if(transferNeedsUpdate())throw Error(transferUpdateMessage());const d=await api('/api/task/handup/preview',{project,task,paths,expectTitle}); if(epoch!==transferEpoch)return;transferPreview={...d,project,task,expectTitle};drawTaskTransfer(d,paths.join('\n'));}
  catch(e){if(epoch===transferEpoch)$('#transfer-sheet').innerHTML=UI`<div class="remove-box"><p>${esc(transferError(e))}</p><button class="btn plain" data-transfer-action="close" type="button">閉じる</button></div>`;}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('[data-transfer-action]');if(!b||transferPending||b.disabled)return;
  const action=b.dataset.transferAction;
  if(action==='close'){transferEpoch++;$('#transfer-sheet').hidden=true;return;}
  const d=transferPreview;if(!d)return;
  if(action==='refresh'){await showTaskTransfer(d.project,d.task,($('#transfer-paths')?.value||'').split('\n').map(x=>x.trim()).filter(Boolean),d.expectTitle);return;}
  if(action!=='apply')return;
  transferPending=true;$('#transfer-status').textContent=d.offer?L('渡し済みを記録し、親へ通知しています…'):L('成果を保存し、通知・片付けを進めています…');b.disabled=true;
  try {
    if(transferNeedsUpdate())throw Error(transferUpdateMessage());
    const r=await api('/api/task/handup',{project:d.project,task:d.task,token:d.token,selected:[...document.querySelectorAll('[data-transfer-file]:checked')].map(x=>x.dataset.transferFile),confirm:true,expectTitle:d.expectTitle});
    view={kind:'work',project:r.parentProject,task:r.parent};save();await load();render();$('#transfer-sheet').hidden=true;toast(r.handedUp?L('成果を渡しました。統合と片付けは親の［統合…］で行います'):L('成果を本作業へ渡し、管理記録をゴミ箱へ移しました'));
  }catch(err){$('#transfer-status').textContent=transferError(err);$('#transfer-status').insertAdjacentHTML('beforeend',UI` <button class="btn plain sm" data-transfer-action="refresh" type="button">内容を読み直す</button>`);}
  finally{transferPending=false;}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!transferPending&&$('#transfer-sheet')){transferEpoch++;$('#transfer-sheet').hidden=true;}});

document.addEventListener('change',e=>{
  if(!e.target.matches?.('[data-transfer-file]')||transferPending)return;
  const b=$('#transfer-sheet [data-transfer-action="apply"]'),d=transferPreview;
  if(b&&d)b.disabled=!!d.blockers.length||!d.resume&&!d.integrated?.files?.length&&!d.hasCode&&!document.querySelector('[data-transfer-file]:checked');
});
