 'use strict';
// Standalone UI fixtures keep the original language when the runtime is absent.
if(typeof globalThis.L!=='function')globalThis.L=text=>text;
if(typeof globalThis.UI!=='function')globalThis.UI=(strings,...values)=>strings.reduce((out,part,n)=>out+part+(n<values.length?String(values[n]):''),'');
let maintenanceProject='', maintenanceData=null, maintenanceEpoch=0, maintenancePending=false;
const maintenanceSize=n=>n<1024*1024?`${Math.ceil(n/1024)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
function maintenanceNativeText(entries) {
  if(!Array.isArray(entries)||entries.some(e=>!e||typeof e.from!=='string'||typeof e.to!=='string'||!/^[a-f0-9]{64}$/.test(e.objectId||'')||!/^[a-f0-9]{64}$/.test(e.treeHash||'')))throw Error(L('原生範圍或完整 FileID／SHA-256 缺漏；請重新取得預覽'));
  return entries.map(e=>e.from+' → '+e.to+'\nFileID: '+e.objectId+'\nTree SHA-256: '+e.treeHash).join('\n\n');
}
function maintenanceNativeHtml(entries) {maintenanceNativeText(entries);return entries.map(e=>UI`<p class="small">${esc(e.from)} → ${esc(e.to)}<br>FileID：<code>${esc(e.objectId)}</code><br>Tree SHA-256：<code>${esc(e.treeHash)}</code></p>`).join('');}
function drawMaintenance() {
  const p=proj(maintenanceProject),d=maintenanceData;if(!p || !d)return;
  const disabled=d.busy||maintenancePending?'disabled':'';
  const stopped=d.stopped||d.excluded[0];
  const records=[...d.history.map(r=>({...r,kind:'cleanup'})),...(d.removed||[]).map(r=>({...r,kind:'remove'}))].sort((a,b)=>b.at.localeCompare(a.at));
  $('#maintenance-title').textContent=p.name+L('：整理と確認');
  $('#maintenance-body').innerHTML=UI`<p class="maintenance-status" role="status">${d.busy?esc(d.busyReason||L('AIが作業中のため使えません。終わってから押してください。')):L('片付けるものを選び、必要に応じて確認・復元できます。')}</p>
    <h3>① 片付け</h3><p class="small">古い一時ファイルと過去版を探します。資料・成果物・作業台帳・Gitは対象外です。</p>
    <button class="btn plain" data-maint-action="refresh" type="button" ${maintenancePending?'disabled':''}>候補を探す</button>
    <p id="maintenance-preview-status" class="note" role="status">${d.token?d.candidates.length?UI`${d.candidates.length}件見つかりました（合計${maintenanceSize(d.candidates.reduce((n,x)=>n+x.bytes,0))}）。移すものを選んでください。`:UI`片付けるものはありませんでした。${esc(new Date().toLocaleTimeString(globalThis.HubI18n?.locale==='zh-TW'?'zh-TW':'ja-JP'))}`:UI`確認しきれず止めました：${esc(stopped?.reason||L('参照を確認できません'))}`}</p>
    ${!d.token&&stopped?.path?`<p class="small">${esc(stopped.path)} ${stopped.size?`（${maintenanceSize(stopped.size)}）`:''}</p>`:''}
    ${!d.token?UI`<p class="small">参照を確認しきれないため移動はできません。下の台帳とリンクの確認は利用できます。資料ファイルの置き場所は人が確認してから変更してください。</p>`:''}
    ${d.candidates.map(c=>`<label class="maintenance-choice"><input type="checkbox" data-maint-candidate="${esc(c.id)}" ${disabled}><span><b>${esc(c.label)}</b><small>${c.paths.map(esc).join('<br>')} (${maintenanceSize(c.bytes)})</small></span></label>${d.native?UI`<details><summary>原生移動範圍、FileID 與目錄雜湊</summary>${maintenanceNativeHtml(c.nativeMoves)}</details>`:''}`).join('')}
    <button class="btn" id="maintenance-apply" data-maint-action="apply" type="button" aria-describedby="maintenance-selection-note" disabled>選んだものをゴミ箱へ移す</button>
    <p id="maintenance-selection-note" class="small">${d.candidates.length?L('移す候補を選んでください。'):L('移せる候補がないため、このボタンは使えません。')}</p>
    <details class="more"><summary>候補の条件・除外した理由（${d.excluded.length}）</summary><p class="small">一時物は7日、過去版・完了作業の会話は30日以上更新がないもの。参照・Git追跡・リンクがあるものは残します。</p>${d.excluded.map(x=>`<p class="small">${esc(x.path||'')}：${esc(x.reason)}</p>`).join('')}</details>
    <h3 id="maintenance-verify-title">② 確認</h3><p class="small">台帳に書かれた場所とつながりを確認します。アプリが動くかは見ません。</p>
    <button class="btn plain" data-maint-action="verify" type="button" ${disabled}>台帳とリンクを確認</button>
    ${d.scripts.some(s=>s.allowed)?UI`<label class="maintenance-choice">アプリのテスト<select id="maintenance-script">${d.scripts.filter(s=>s.allowed).map(s=>`<option value="${esc(s.name)}">npm run ${esc(s.name)}：${esc(s.command)}</option>`).join('')}</select></label><button class="btn" data-maint-action="test" type="button" ${disabled}>アプリのテストを実行（1分まで）</button>`:UI`<p class="small">このプロジェクトには実行できるテストのコマンドがありません。</p>`}
    <div id="maintenance-result" role="status"></div>
    <h3>③ 記録</h3>${d.historyError?UI`<p class="note">削除の記録を取得できませんでした：${esc(d.historyError)}</p>`:''}${records.length?records.map(r=>UI`<p>${esc(new Date(r.at).toLocaleString(globalThis.HubI18n?.locale==='zh-TW'?'zh-TW':'ja-JP'))}・${r.kind==='remove'?L('削除 ')+esc(r.title):L('片付け')}・${r.count}件 ${r.restored?L('元に戻しました'):UI`<button class="btn plain sm" data-maint-action="${r.kind==='remove'?'unremove':'restore'}" data-transaction="${esc(r.id)}" type="button" ${disabled}>元に戻す</button>`}${r.error?`<small>${esc(r.error)}</small>`:''}</p>`).join(''):UI`<p class="note">記録はまだありません。</p>`}`;
}
function updateMaintenanceSelection() {
  const selected=document.querySelectorAll('[data-maint-candidate]:checked').length;
  $('#maintenance-apply').disabled=maintenancePending || maintenanceData?.busy || !selected;
  $('#maintenance-selection-note').textContent=selected?UI`${selected}件を選択しています。`:maintenanceData?.candidates.length?L('移す候補を選んでください。'):L('移せる候補がないため、このボタンは使えません。');
}
async function refreshMaintenance() {
  const epoch=++maintenanceEpoch, id=maintenanceProject;
  const status=$('#maintenance-preview-status');if(status)status.textContent=L('探しています…');
  try {
    const data=await api('/api/maintenance/preview',{project:id});
    try {data.removed=(await api('/api/hierarchy/remove/history',{})).history||[];} catch(err){data.removed=[];data.historyError=err.message;}
    if(epoch!==maintenanceEpoch || id!==maintenanceProject)return;
    maintenanceData=data;drawMaintenance();
  } catch(err) {
    if(epoch===maintenanceEpoch && id===maintenanceProject) {
      const box=$('#maintenance-preview-status');if(box)box.textContent=L('候補の取得に失敗しました：')+err.message;
    }
    throw err;
  }
}
document.addEventListener('click',async e=>{
  const openBtn=e.target.closest('[data-maintenance]');
  if(openBtn) {if(maintenancePending){toast(L('操作が終わるまでお待ちください'));return;} maintenanceProject=openBtn.dataset.p;$('#maintenance-drawer').hidden=false;$('#maintenance-body').textContent=L('取得しています…');
    try {await refreshMaintenance();if(openBtn.dataset.maintenance==='verify')$('#maintenance-verify-title')?.scrollIntoView({block:'center'});}catch(err){$('#maintenance-body').textContent=err.message;}return;}
  if(e.target.id==='maintenance-close'){$('#maintenance-drawer').hidden=true;return;}
  const btn=e.target.closest('[data-maint-action]');if(!btn || btn.disabled || maintenancePending)return;
  if(maintenanceData?.busy && btn.dataset.maintAction!=='refresh'){toast(maintenanceData.busyReason||L('AIが作業中です。終わってから操作してください'));return;}
  const action=btn.dataset.maintAction, project=maintenanceProject;
  let request,result;
  if(action==='apply') {
    const selected=[...document.querySelectorAll('[data-maint-candidate]:checked')].map(x=>x.dataset.maintCandidate);if(!selected.length)return;
    let nativeScope='';try{if(maintenanceData.native){const chosen=selected.map(id=>maintenanceData.candidates.find(c=>c.id===id));if(chosen.some(c=>!c||!c.nativeMoves?.length))throw Error(L('原生範圍或完整 FileID／SHA-256 缺漏；請重新取得預覽'));nativeScope='\n\n'+maintenanceNativeText(chosen.flatMap(c=>c.nativeMoves));}}catch(error){toast(error.message);$('#maintenance-result').textContent=error.message;return;}
    if(!confirm(UI`${selected.length}件の候補をゴミ箱へ移しますか？整理の記録から復元できます。会話履歴を選んだ場合、再開は新しい会話になります。`+nativeScope))return;
    request={project,token:maintenanceData.token,selected,confirm:true};
  } else if(action==='unremove') {if(!confirm(L('削除したものを元に戻しますか？同名のファイルは上書きしません。')))return;request={record:btn.dataset.transaction,confirm:true};}
  else if(action==='restore') {let token;try{if((typeof state!=='undefined'&&state.windowsBrowser)){maintenancePending=true;btn.disabled=true;const preview=await api('/api/maintenance/restore/preview',{project,transaction:btn.dataset.transaction});const scope=maintenanceNativeText(preview.entries),kept=preview.kept?.length?'\n\n'+L('原位保留：')+'\n'+preview.kept.join('\n'):'';if(typeof preview.token!=='string'||!preview.token)throw Error(L('還原預覽未提供有效核准憑證'));if(!confirm(preview.guidance+'\n'+scope+kept))return;token=preview.token;}else if(!confirm(L('この整理でゴミ箱へ移したものを復元しますか？同名のファイルは上書きしません。')))return;request={project,transaction:btn.dataset.transaction,confirm:true,...(token?{token}:{})};}catch(error){toast(error.message);$('#maintenance-result').textContent=error.message;return;}finally{maintenancePending=false;btn.disabled=false;}}
  else if(action==='verify'||action==='test') {
    const script=action==='test'?$('#maintenance-script').value:'', choice=maintenanceData.scripts.find(s=>s.name===script);
    if(script && !confirm(UI`${maintenanceData.hostScript?'此命令會以目前 Windows 使用者權限執行專案程式，可存取主機檔案與網路。請只執行已信任的程式。\n':''}この検証コマンドを実行しますか？
${script}: ${choice.command}`))return;
    request={project,script,expectedHash:choice?.hash,confirm:true};
  }
  maintenancePending=true;btn.disabled=true;updateMaintenanceSelection();
  try {
    if(action==='refresh')await refreshMaintenance();
    else {if(action==='verify'||action==='test')$('#maintenance-result').textContent=L('確認しています…');
      result=await api(action==='unremove'?'/api/hierarchy/remove/restore':'/api/maintenance/'+(action==='test'?'verify':action),request);
      if(action==='verify'||action==='test') {
        const box=$('#maintenance-result');box.innerHTML=`<p><b>${result.ok?L('選んだ範囲に問題は見つかりませんでした'):UI`${result.checks.filter(c=>!c.ok).length}件の問題が見つかりました`}</b></p>${result.checks.map(c=>`<p class="small">${c.ok?'✓':'×'} ${esc(c.name)}${c.detail?'：'+esc(c.detail):''}</p>`).join('')}<p>${esc(result.note)}</p>${result.result?`<p>${esc(result.result.command)}：${result.result.ok?'成功':'失敗'} ${esc(result.result.note||'')}</p><pre>${esc(result.result.output.split(/\r?\n/).slice(-12).join("\n"))}</pre>`:''}`;
      } else {await refreshMaintenance();const note=result.error || (action==='apply'?UI`${result.moved}件をゴミ箱へ移しました`:UI`${result.restored}件を元に戻しました${result.skipped?.length?L('。残した理由：')+result.skipped.map(x=>x.why).join(' / '):''}`);$('#maintenance-result').textContent=note;toast(note);await load();}
    }
  } catch(err){toast(err.message);const box=$('#maintenance-result');if(box)box.textContent=err.message;}
  finally {maintenancePending=false;btn.disabled=false;document.querySelectorAll('[data-maint-action]').forEach(x=>{if(x.dataset?.maintAction&&x.dataset.maintAction!=='apply')x.disabled=Boolean(maintenanceData?.busy)&&x.dataset.maintAction!=='refresh';});updateMaintenanceSelection();if(action==='apply')$('#maintenance-apply').disabled=true;}
});
document.addEventListener('change',e=>{if(e.target.dataset.maintCandidate!==undefined)updateMaintenanceSelection();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#maintenance-drawer').hidden=true;});
