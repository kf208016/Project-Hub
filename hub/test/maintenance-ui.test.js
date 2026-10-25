'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture(overrides={}) {
 const elements=new Map(),events=new Map(),calls=[],selected=[];
 const el=k=>{if(!elements.has(k))elements.set(k,{innerHTML:'',textContent:'',hidden:true,value:'',disabled:false,scrollIntoView(){}});return elements.get(k);};
 const ctx=vm.createContext({document:{querySelector:s=>s==='[data-maint-candidate]:checked'?selected[0]||null:el(s),querySelectorAll:()=>selected,addEventListener:(key,f)=>events.set(key,f)},$:el,
  proj:()=>({id:'p',name:'Project <test>'}),esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),toast(){},load:async()=>{},confirm:()=>false,api:async(route,body)=>{calls.push({route,body});return {token:'token',candidates:[],excluded:[],history:[],scripts:[]};}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/maintenance.js'),'utf8'),ctx);
 const data={token:'token',candidates:[{id:'choice',label:'old <file>',paths:['/old.dat'],bytes:20}],excluded:[],history:[],scripts:[{name:'test',command:'node test.cjs',hash:'hash',allowed:true}],...overrides};
 vm.runInContext('maintenanceProject="p";maintenanceData='+JSON.stringify(data),ctx);ctx.drawMaintenance();
 const click=dataset=>events.get('click')({target:{closest:selector=>selector==='[data-maint-action]'?{dataset,disabled:false}:null}});
 return {ctx,el,events,calls,selected,click};
}
test('native restore preview rejection is caught and never leaks a request or pending UI state',async()=>{const a=fixture();a.ctx.state={windowsBrowser:true};a.ctx.confirm=()=>true;a.ctx.api=async(route,body)=>{a.calls.push({route,body});throw Error('SYNTHETIC_PREVIEW_REJECTED');};await assert.doesNotReject(a.click({maintAction:'restore',transaction:'record'}));assert.deepEqual(a.calls.map(c=>c.route),['/api/maintenance/restore/preview']);assert.equal(a.el('#maintenance-result').textContent,'SYNTHETIC_PREVIEW_REJECTED');assert.equal(vm.runInContext('maintenancePending',a.ctx),false);});
test('native cleanup and restore confirmation show full source/destination FileID/tree SHA-256',async()=>{const entries=[{from:'C:\\fixture\\source',to:'C:\\fixture\\trash',objectId:'a'.repeat(64),treeHash:'b'.repeat(64)}],a=fixture({native:true,candidates:[{id:'choice',label:'fixture',paths:['C:\\fixture\\source'],bytes:20,nativeMoves:entries}]});assert.ok(a.el('#maintenance-body').innerHTML.includes(entries[0].objectId));assert.ok(a.el('#maintenance-body').innerHTML.includes(entries[0].treeHash));let shown='';a.ctx.confirm=text=>{shown=text;return false;};a.selected.push({dataset:{maintCandidate:'choice'}});await a.click({maintAction:'apply'});assert.ok(shown.includes(entries[0].from+' → '+entries[0].to));assert.ok(shown.includes(entries[0].objectId)&&shown.includes(entries[0].treeHash));assert.equal(a.calls.length,0);a.ctx.state={windowsBrowser:true};a.ctx.api=async(route,body)=>{a.calls.push({route,body});return{token:'fresh-restore',entries,guidance:'SYNTHETIC_GUIDANCE',kept:[]};};await a.click({maintAction:'restore',transaction:'record'});assert.equal(a.calls.length,1);assert.ok(shown.includes(entries[0].objectId)&&shown.includes(entries[0].treeHash));});
test('native cleanup refuses incomplete identity metadata instead of using legacy confirmation',async()=>{const a=fixture();a.ctx.confirm=()=>true;a.selected.push({dataset:{maintCandidate:'choice'}});vm.runInContext('maintenanceData.native=true;maintenanceData.candidates[0].nativeMoves=[{from:"x",to:"y",objectId:"short",treeHash:"short"}]',a.ctx);await a.click({maintAction:'apply'});assert.equal(a.calls.length,0);assert.match(a.el('#maintenance-result').textContent,/完整 FileID/);});
test('cleanup candidates start unchecked, apply starts disabled and dangerous text is escaped',()=>{
 const a=fixture(),html=a.el('#maintenance-body').innerHTML;
 assert.match(html,/type="checkbox" data-maint-candidate="choice"/);assert.doesNotMatch(html,/type="checkbox"[^>]*\bchecked\b/);
 assert.match(html,/id="maintenance-apply"[^>]*disabled/);assert.match(html,/old &lt;file&gt;/);
});
test('cancel cleanup, restore or script verification never invokes their API',async()=>{
 const a=fixture();a.selected.push({dataset:{maintCandidate:'choice'}});a.el('#maintenance-script').value='test';
 for(const action of ['apply','restore','test'])await a.click({maintAction:action,transaction:'record'});
 assert.equal(a.calls.length,0);
});
test('apply sends only explicit choices and script verification shows escaped output',async()=>{
 const a=fixture();a.ctx.confirm=()=>true;a.selected.push({dataset:{maintCandidate:'choice'}});
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});return route.endsWith('/preview')?{token:'new',candidates:[],excluded:[],history:[],scripts:[]}:{moved:1};};
 await a.click({maintAction:'apply'});assert.equal(a.calls[0].route,'/api/maintenance/apply');assert.deepEqual(Array.from(a.calls[0].body.selected),['choice']);assert.equal(a.calls[0].body.confirm,true);
 a.el('#maintenance-script').value='';a.ctx.api=async()=>({ok:true,checks:[],note:'structure',result:{command:'node test.cjs',ok:true,output:'<script>bad</script>'}});
 await a.click({maintAction:'verify'});assert.match(a.el('#maintenance-result').innerHTML,/&lt;script&gt;/);
});

test('候補ゼロは無効理由を表示し、ゴミ箱移動のAPIを呼ばない', async()=>{
 const a=fixture({candidates:[]}),html=a.el('#maintenance-body').innerHTML;
 assert.match(html,/片付けるものはありませんでした/);
 assert.match(html,/id="maintenance-apply"[^>]*disabled/);
 assert.match(html,/aria-describedby="maintenance-selection-note"/);
 assert.match(html,/移せる候補がないため、このボタンは使えません/);
 a.ctx.confirm=()=>true;await a.click({maintAction:'apply'});assert.equal(a.calls.length,0);
});
test('候補の選択数と無効理由を更新し、選択を外すと移動を無効にする',()=>{
 const a=fixture(),change=a.events.get('change');
 a.selected.push({dataset:{maintCandidate:'choice'}});change({target:{dataset:{maintCandidate:'choice'}}});
 assert.equal(a.el('#maintenance-apply').disabled,false);assert.match(a.el('#maintenance-selection-note').textContent,/1件を選択/);
 a.selected.length=0;change({target:{dataset:{maintCandidate:'choice'}}});
 assert.equal(a.el('#maintenance-apply').disabled,true);assert.match(a.el('#maintenance-selection-note').textContent,/候補を選んで/);
});
test('候補再取得の処理中・完了を表示し、同じ結果でも完了が分かる',async()=>{
 const a=fixture();let resolve;
 a.ctx.api=async(route,body)=>{if(route.endsWith('/history'))return {history:[]};a.calls.push({route,body});return new Promise(r=>resolve=r);};
 const pending=a.click({maintAction:'refresh'});
 assert.equal(a.el('#maintenance-preview-status').textContent,'探しています…');
 assert.equal(a.el('#maintenance-apply').disabled,true);
 await a.click({maintAction:'refresh'});assert.equal(a.calls.length,1);
 resolve({token:'new',candidates:[],excluded:[],history:[],scripts:[]});await pending;
 assert.match(a.el('#maintenance-body').innerHTML,/片付けるものはありませんでした/);
 const again=a.click({maintAction:'refresh'});assert.equal(a.calls.length,2);
 resolve({token:'newer',candidates:[],excluded:[],history:[],scripts:[]});await again;
});
test('取得失敗を表示し、完了と誤表示しない',async()=>{
 const a=fixture();a.ctx.api=async()=>{throw Error('接続できません');};
 await a.click({maintAction:'refresh'});
 assert.equal(a.el('#maintenance-preview-status').textContent,'候補の取得に失敗しました：接続できません');
 assert.equal(a.el('#maintenance-result').textContent,'接続できません');
});
test('走査中止の理由を上部へ出し、候補なしの正常終了と区別する',()=>{
 const a=fixture({token:'',candidates:[],excluded:[{reason:'大きい参照<file>を確認できません'}]});
 const html=a.el('#maintenance-body').innerHTML;
 assert.match(html,/id="maintenance-preview-status"[^>]*>確認しきれず止めました：大きい参照&lt;file&gt;を確認できません/);
 assert.doesNotMatch(html,/安全に整理できる候補はありません/);
 assert.match(html,/参照を確認しきれないため/);
});

test('unified entry and stopped path are clear; no test command means no execution button',()=>{
 const a=fixture({token:'',candidates:[],scripts:[],stopped:{reason:'large',path:'/資料/<raw>.json',size:2097152}}),h=a.el('#maintenance-body').innerHTML;
 assert.match(h,/資料\/&lt;raw&gt;.json/);assert.match(h,/2.0 MB/);assert.match(h,/アプリが動くかは見ません/);
 assert.doesNotMatch(h,/data-maint-action="test"/);
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');assert.equal((source.match(/data-maintenance="1"/g)||[]).length,1);assert.doesNotMatch(source,/data-maintenance="verify"/);
});
test('busy state blocks apply, verification and restore before calling API',async()=>{
 const a=fixture({busy:true}),h=a.el('#maintenance-body').innerHTML;
 assert.match(h,/AIが作業中/);assert.match(h,/data-maint-action="verify"[^>]*disabled/);
 for(const action of ['apply','verify','test','restore','unremove'])await a.click({maintAction:action});assert.equal(a.calls.length,0);
});
test('Windows unknown process state is explicit and an approved host script shows its authority',async()=>{
 const blocked=fixture({busy:true,busyReason:'背景程序狀態未知 <fixture>'});assert.match(blocked.el('#maintenance-body').innerHTML,/背景程序狀態未知 &lt;fixture&gt;/);
 const a=fixture({hostScript:true});let prompt='';a.el('#maintenance-script').value='test';a.ctx.confirm=text=>{prompt=text;return false;};await a.click({maintAction:'test'});assert.match(prompt,/Windows 使用者權限/);assert.match(prompt,/主機檔案與網路/);assert.equal(a.calls.length,0);
});
test('structural verification never sends a selected app script, test does',async()=>{
 const a=fixture();a.el('#maintenance-script').value='test';a.ctx.confirm=()=>true;
 a.ctx.api=async(route,body)=>{a.calls.push({route,body});return {ok:true,checks:[],note:'fixture'};};
 await a.click({maintAction:'verify'});assert.equal(a.calls[0].body.script,'');
 await a.click({maintAction:'test'});assert.equal(a.calls[1].body.script,'test');assert.equal(a.calls[1].body.expectedHash,'hash');
});
test('history retrieval failure does not hide usable cleanup preview',async()=>{
 const a=fixture();a.ctx.api=async route=>{if(route.endsWith('/history'))throw Error('<failed>');return {token:'new',candidates:[],excluded:[],history:[],scripts:[]};};
 await a.click({maintAction:'refresh'});assert.match(a.el('#maintenance-body').innerHTML,/片付けるものはありませんでした/);assert.match(a.el('#maintenance-body').innerHTML,/削除の記録を取得できませんでした：&lt;failed&gt;/);
});
test('stale project responses do not overwrite a later preview',async()=>{
 const a=fixture();let resolve;a.ctx.api=route=>route.endsWith('/history')?Promise.resolve({history:[]}):new Promise(r=>resolve=r);
 const pending=a.ctx.refreshMaintenance();vm.runInContext('maintenanceProject="other";maintenanceData={marker:"newer"}',a.ctx);
 resolve({token:'old',candidates:[],excluded:[],history:[],scripts:[]});await pending;
 assert.equal(vm.runInContext('maintenanceData.marker',a.ctx),'newer');
});
