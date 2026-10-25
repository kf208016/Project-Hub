'use strict';
// Controller-only workflow leases. Child close events prove owned process-tree
// exit; task metadata or a remembered direct flag cannot reconstruct a lease.
const {randomUUID}=require('node:crypto'),path=require('node:path'),providers=require('./provider-registry');
const canonical=x=>process.platform==='win32'?path.resolve(x).toLowerCase():path.resolve(x);
const warmFail=(reason,message)=>Object.assign(Error(message||'工作區保溫重新確認未通過'),{warmReason:reason});
const LABELS=Object.freeze({'expired':'已閒置超過 10 分鐘','base-head':'本體 Git 有新的提交或已切換分支','base-index':'本體 Git 暫存區已變更','base-tracked':'本體已追蹤的檔案有未提交變更','base-root':'本體資料夾已被替換','procwatch':'偵測到不屬於 Hub 的 AI 程序，或程序狀態無法確認','claimed':'此工作區有 AI 或其他操作執行中','idle-gate':'此儲存庫有其他工作區、合併或交易進行中','commands':'此作業仍有命令程序','task':'作業已不存在或改為本體模式','worktree':'隔離工作複本已變更','registration':'隔離工作複本已變更','worktree-secrets':'隔離工作複本已變更'});
const reenterMessage=reason=>`工作區保留已釋放（${LABELS[reason]||'重新確認未通過'}）；需重新核准此次工作區`;
class WorkspaceRuntime {
  constructor({review,sessions,chats,store,stopExtra=async()=>({stopped:true,treeExited:true}),onError=()=>{},warm=null,now=Date.now,monotonic=()=>Number(process.hrtime.bigint()/1000000n),ttlMs:optionTtl}){if(optionTtl!==undefined&&warm?.ttlMs!==undefined&&optionTtl!==warm.ttlMs)throw Error('工作區保溫設定無效');const ttlMs=warm?.ttlMs!==undefined?warm.ttlMs:optionTtl!==undefined?optionTtl:600000;if(typeof now!=='function'||typeof monotonic!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>600000||warm!==null&&(typeof warm!=='object'||Array.isArray(warm)||['eligible','check','parkCheck'].some(k=>typeof warm[k]!=='function')||['onPark','onParked','onResumed','onRejected','onSkipped','onExpired','onCleanupFailed'].some(k=>warm[k]!==undefined&&typeof warm[k]!=='function')))throw Error('工作區保溫設定無效');Object.assign(this,{review,sessions,chats,store,stopExtra,onError,warm,ttlMs,now,monotonic});this.flows=new Map();this.byTask=new Map();}
  key(p,t){return p+'\0'+t;}
  current(p,t){const id=this.byTask.get(this.key(p,t)),x=id&&this.flows.get(id);return x&&!x.closing?x:null;}
  summary(project,task){const x=this.flows.get(this.byTask.get(this.key(project,task)));if(!x)return null;const state=x.cleanupErrorCode?'cleanup-failed':x.closing?(x.finishing?'cleaning':'stopping'):x.verificationBlocked?'verification-blocked':x.starting?'starting':x.children.size?'active':this.isIdle(x)?'idle':'waiting';return {kind:x.kind,state,ownedChildren:x.children.size,retryClose:!['starting','active','idle'].includes(state),errorCode:x.cleanupErrorCode||''};}
  async begin({project,task,permit,kind,verifySource=false,noReentry=false}){
    const projectDir=this.store?.readProject?.(project)?.dir;
    if(projectDir)require('./task-write-lock').assertPathWritable(projectDir);
    const blocked=()=>{if(this.byTask.has(this.key(project,task))&&!this.current(project,task))throw Error('此工作區仍在停止或清理；請等待 owned 程序退出與紀錄完成');};blocked();
    let old=this.current(project,task);if(old?.parking){await old.parking;blocked();old=this.current(project,task);}
    if(old?.reentering)throw Object.assign(Error('此作業的工作區正在重新確認；請稍候再送出'),{status:409,code:'WORKSPACE_REENTRY_BUSY',notStarted:true});
    if(old&&noReentry&&(this.isParked(old)||this.reusable(old)))throw Object.assign(Error('工作區閒置中；請由使用者在 Hub 畫面送出'),{status:409,notStarted:true});
    if(old&&old.kind!==kind)throw Object.assign(Error('此作業的另一種工作畫面仍在執行；請先停止原流程'),{status:409,notStarted:true});
    if(old&&this.reenterable(old)){if(typeof permit==='string'&&this.review.permits?.has?.(permit)){await this.finish(old.id);old=null;}else if(old.parkedAt>0||this.#warmable(old))return this.#reenter(old);}
    if(old&&old.dirty===true&&this.warmCandidate(old)&&old.starting&&!old.held&&!old.children.size&&!this.chats.busy(project,task))throw Object.assign(Error('此作業的工作區正在啟動；請稍候再送出'),{status:409,code:'WORKSPACE_REENTRY_BUSY',notStarted:true});
    if(old){if(old.children.size&&!this.chats.busy(project,task)&&kind==='chat')throw Error('前一個 owned 工作程序仍在退出，請等待程序樹 close 後再開始');const reserved=!old.children.size&&!this.chats.busy(project,task),starting=old.starting,wasHeld=old.held;if(reserved){clearTimeout(old.finishTimer);old.starting=true;old.held=false;}old.verifying++;
      try{await this.review.verifiedBinding(project,task,{verifySource});if(this.current(project,task)!==old)throw Error('工作區流程已停止，請重新核准');old.verificationBlocked=false;if(reserved)this.#armStart(old);return old;}
      catch(error){old.noPark=true;if(verifySource)old.verificationBlocked=true;if(reserved){old.starting=wasHeld&&!verifySource?false:starting;if(!verifySource)this.deferFinish(old);}
      // A verification-blocked flow waits for an explicit stop or a fresh validation, and a flow that
      // left starting must not carry an old deadline into its next start.
      if(verifySource||!old.starting){this.#clearStart(old);old.startAt=old.startMono=0;}throw error;}
      finally{old.verifying--;if(!old.verifying&&!old.starting&&!old.children.size&&!old.closing&&this.flows.get(old.id)===old)this.deferFinish(old);}}
    if(typeof permit!=='string'||!permit)throw Object.assign(Error('請先預覽並核准此次工作區'),{status:409,code:'WORKSPACE_REQUIRED',workspaceRequired:true,project,task});
    const id=randomUUID(),x={id,project,task,kind,children:new Set(),known:new WeakSet(),terminals:new Map(),closing:false,starting:true,closedWaiters:new Set(),workspace:null,dirty:false,unverifiedClose:false,noPark:false,held:false,verifying:0,parking:null,reentering:null,parkedAt:0,parkedMono:0,idleTimer:null,startAt:0,startMono:0,startTimer:null};this.flows.set(id,x);this.byTask.set(this.key(project,task),id);
    try{const entry=this.review.permits.get(permit);if(!entry)throw Error('工作區核准已失效');if(entry.record.secrets.files.length)x.supply=await this.review.supply({project,task,permit,runId:id});x.workspace=await this.review.consumeRun({project,task,permit});x.verifiedAt=this.now();this.#armStart(x);return x;}
    catch(error){x.starting=false;x.closing=true;if(error.supplyId)x.supply={id:error.supplyId};if(!x.supply){this.flows.delete(id);this.byTask.delete(this.key(project,task));}else error.workspaceFlow=id;throw error;}
  }
  assertStart(project,task,flowId,dir){const x=this.flows.get(flowId);if(!x||x.closing||x.parkedAt>0||x.parking||x.reentering||x.project!==project||x.task!==task||!x.workspace||canonical(x.workspace.dir)!==canonical(dir)||x.supply&&Date.now()>=x.supply.expiresAt)throw Error('缺少本次controller工作區流程授權');const b=this.review.binding(project,task);if(!b||b.run!==x.workspace.run||canonical(b.dir)!==canonical(dir))throw Error('工作區流程授權已撤銷');return x;}
  observeChat(project,task){const x=this.current(project,task),r=this.chats.busy(project,task);if(!x||x.kind!=='chat'||!r?.child||x.known.has(r.child))return;this.track(x,r.child);}
  track(x,child){if(x.parkedAt>0||x.parking||x.reentering)x.noPark=true;this.#clearIdle(x);this.#clearStart(x);x.startAt=0;x.held=false;x.dirty=true;x.known.add(child);x.children.add(child);x.starting=false;const closed=()=>{if(child.requiresCleanupReceipt===true&&child.cleanupReceipt?.cleanupVerified!==true){x.cleanupErrorCode='WORKSPACE_CLEANUP_REQUIRED';return;}if(!(child.requiresCleanupReceipt===true&&child.cleanupReceipt?.cleanupVerified===true))x.unverifiedClose=true;x.children.delete(child);for(const fn of x.closedWaiters)fn();this.deferFinish(x);};if(typeof child.prependOnceListener==='function')child.prependOnceListener('close',closed);else child.once('close',closed);}
  trackTerminal(x,session){
    if(!x||this.flows.get(x.id)!==x||x.kind!=='terminal'||!(session?.finishedP instanceof Promise))throw Error('缺少受管理終端機退出證據');
    const ai=providers.cliActor(session.ai).id;
    if(ai!==session.ai||!x.workspace||typeof session.dir!=='string'||canonical(session.dir)!==canonical(x.workspace.dir)||this.sessions.get(x.project,x.task,ai)!==session)throw Error('終端機身分不屬於此工作區流程');
    if(!x.known.has(session)){x.known.add(session);x.children.add(session);x.terminals.set(session,ai);x.starting=false;x.held=false;this.#clearStart(x);x.startAt=0;session.finishedP.then(()=>{x.children.delete(session);x.terminals.delete(session);for(const fn of x.closedWaiters)fn();this.deferFinish(x);},()=>{x.cleanupErrorCode='WORKSPACE_CLEANUP_REQUIRED';});}
  }
  stopTerminals(x){
    // Bind to the exact Sessions entry captured at tracking time, not mutable
    // session metadata, a default provider, or a later replacement session.
    const terminals=[...x.terminals];
    if(terminals.length!==x.children.size||terminals.some(([session,ai])=>!x.children.has(session)||this.sessions.get(x.project,x.task,ai)!==session))throw Error('受管理終端機身分已變更；保留工作區待清理');
    for(const [session,ai] of terminals){if(!x.children.has(session))continue;if(this.sessions.get(x.project,x.task,ai)!==session)throw Error('受管理終端機身分已變更；保留工作區待清理');this.sessions.stop(x.project,x.task,ai);}
  }
  warmCandidate(x){return Boolean(this.warm)&&x.kind==='chat'&&x.workspace?.mode==='isolated'&&!x.workspace.supplyId&&!x.supply&&x.dirty===true&&!x.unverifiedClose&&!x.noPark&&!x.cleanupErrorCode&&!x.verificationBlocked;}
  quiet(x){return this.flows.get(x.id)===x&&!x.closing&&!x.finishing&&!x.starting&&!x.reentering&&!x.verifying&&!x.verificationBlocked&&!x.children.size&&!this.chats.busy(x.project,x.task)&&(x.kind!=='chat'||!this.chats.queue(x.project,x.task).length);}
  reusable(x){return this.flows.get(x.id)===x&&!x.closing&&!x.finishing&&!x.reentering&&!x.parking&&!x.verifying&&(!x.starting||x.held)&&!x.children.size&&!this.chats.busy(x.project,x.task)&&this.warmCandidate(x);}
  isParked(x){return Boolean(x&&(x.parkedAt>0||x.parking));}
  reenterable(x){return Boolean(x)&&this.flows.get(x.id)===x&&!x.closing&&(x.parkedAt>0||this.reusable(x));}
  isIdle(x){return this.isParked(x)||this.quiet(x)&&this.warmCandidate(x);}
  reapable(x){return Boolean(x)&&this.flows.get(x.id)===x&&!x.closing&&!x.finishing&&!x.reentering&&!x.verifying&&!x.starting&&!x.children.size&&!this.chats.busy(x.project,x.task)&&!x.cleanupErrorCode&&!x.verificationBlocked&&this.warmCandidate(x)&&(x.parkedAt>0||Boolean(x.parking)||this.quiet(x));}
  inUse(){return [...this.flows.values()].some(x=>!this.reapable(x));}
  #warmable(x){try{return this.warm.eligible(x)===true;}catch{return false;}}
  #expired(at,mono){const n=this.now(),m=this.monotonic();return n<at||n-at>=this.ttlMs||m-mono>=this.ttlMs;}
  #left(at,mono){const n=this.now(),m=this.monotonic();return Math.min(this.ttlMs,Math.max(1,Math.min(this.ttlMs-(n-at),this.ttlMs-(m-mono))));}
  #event(name,...args){try{this.warm?.[name]?.(...args);}catch{}}
  #cleanupFailed(x){try{this.warm?.onCleanupFailed?.(x);}catch{}}
  deferFinish(x){clearTimeout(x.finishTimer);x.finishTimer=setTimeout(()=>{if(x.parking||x.parkedAt>0||!this.quiet(x))return;if(this.warmCandidate(x)&&this.#warmable(x))this.park(x).catch(this.onError);else this.finish(x.id).catch(this.onError);},this.warm?Math.min(200,this.ttlMs):200);x.finishTimer.unref?.();}
  park(x){if(x.parking)return x.parking;x.parking=Promise.resolve().then(async()=>{try{this.#event('onPark',x);const extra=await this.stopExtra(x.project,x.task);if(!extra?.treeExited)throw warmFail('commands');if(!this.quiet(x)||!this.warmCandidate(x)||!this.#warmable(x))throw warmFail('changed');if(this.warm.parkCheck(x)!==true)throw warmFail('base-changed');if(!this.quiet(x))throw warmFail('changed');this.#armIdle(x);this.#event('onParked',x);}catch(error){this.#event('onSkipped',x,error.warmReason||'base-changed');if(this.quiet(x))try{await this.finish(x.id);}catch(error){this.onError(error);this.#cleanupFailed(x);}}finally{x.parking=null;}});return x.parking;}
  #armIdle(x){this.#clearIdle(x);x.parkedAt=this.now();x.parkedMono=this.monotonic();x.idleTimer=setTimeout(()=>this.#expireIdle(x),this.ttlMs);x.idleTimer.unref?.();}
  #clearIdle(x){clearTimeout(x.idleTimer);x.idleTimer=null;x.parkedAt=x.parkedMono=0;}
  #expireIdle(x){if(this.flows.get(x.id)!==x||!x.parkedAt||x.reentering||x.closing)return;if(!this.#expired(x.parkedAt,x.parkedMono)){x.idleTimer=setTimeout(()=>this.#expireIdle(x),this.#left(x.parkedAt,x.parkedMono));x.idleTimer.unref?.();return;}this.#clearIdle(x);this.#event('onExpired',x);this.finish(x.id).catch(error=>{this.onError(error);this.#cleanupFailed(x);});}
  async #reenter(x){const parked=x.parkedAt>0,expired=parked&&this.#expired(x.parkedAt,x.parkedMono);clearTimeout(x.finishTimer);this.#clearIdle(x);this.#clearStart(x);x.startAt=x.startMono=0;x.held=false;x.starting=true;let done;x.reentering=new Promise(resolve=>done=resolve);
    try{if(x.kind!=='chat')throw warmFail('kind');if(expired)throw warmFail('expired');if(!this.warmCandidate(x)||!this.#warmable(x))throw warmFail('ineligible');if(!parked){const extra=await this.stopExtra(x.project,x.task);if(!extra?.treeExited)throw warmFail('commands');}await this.warm.check(x);if(this.flows.get(x.id)!==x||x.closing)throw warmFail('stopped');x.dirty=false;x.verifiedAt=this.now();this.#armStart(x);this.#event('onResumed',x);return x;}
    catch(error){x.starting=false;if(x.closing||this.flows.get(x.id)!==x)throw Object.assign(Error('工作區流程已停止；請重新送出'),{status:409,notStarted:true});try{await this.finish(x.id);}catch{this.#cleanupFailed(x);throw Object.assign(Error('工作區重新確認未通過，停止或清理也未完成；檔案、紀錄與互斥鎖保留，請在作業畫面上方的清理提示按「重試停止／清理工作區」'),{status:409,code:'WORKSPACE_CLEANUP_REQUIRED',notStarted:true});}const reason=error.warmReason||'ineligible';this.#event('onRejected',x,reason);throw Object.assign(Error(reenterMessage(reason)),{status:409,code:'WORKSPACE_REQUIRED',workspaceRequired:true,project:x.project,task:x.task,warmReason:reason});}
    finally{x.reentering=null;done();}
  }
  #armStart(x){if(!this.warm)return;if(!x.startAt){x.startAt=this.now();x.startMono=this.monotonic();}this.#clearStart(x);x.startTimer=setTimeout(()=>this.#expireStart(x),this.#left(x.startAt,x.startMono));x.startTimer.unref?.();}
  #clearStart(x){clearTimeout(x.startTimer);x.startTimer=null;}
  #expireStart(x){x.startTimer=null;if(this.flows.get(x.id)!==x||!x.starting||x.reentering||x.closing)return;const busy=x.children.size||this.chats.busy(x.project,x.task);if(busy||!this.#expired(x.startAt,x.startMono)){x.startTimer=setTimeout(()=>this.#expireStart(x),busy?Math.min(1000,this.#expired(x.startAt,x.startMono)?this.ttlMs:this.#left(x.startAt,x.startMono)):this.#left(x.startAt,x.startMono));x.startTimer.unref?.();return;}x.held=false;this.failed(x).catch(error=>{this.onError(error);this.#cleanupFailed(x);});}
  hold(id){const x=this.flows.get(id);if(x?.starting&&!x.children.size&&!x.closing&&!x.reentering){x.held=true;this.#armStart(x);}}
  reserve(id){const x=this.flows.get(id);if(!x||x.closing||x.finishing||x.reentering||x.cleanupErrorCode||this.isParked(x))return false;clearTimeout(x.finishTimer);x.starting=true;x.held=false;this.#armStart(x);return true;}
  unreserve(id){const x=this.flows.get(id);if(x&&!x.closing){x.starting=false;x.held=false;this.#clearStart(x);x.startAt=0;this.deferFinish(x);}}
  async settle(p,t){await this.current(p,t)?.parking;}
  async reap(x){if(x?.parking)await x.parking;if(!this.reapable(x))return false;this.#clearIdle(x);this.#clearStart(x);x.held=false;x.starting=false;await this.finish(x.id);return true;}
  async reapAll(match=()=>true){let failed=0;for(const x of this.flows.values())if(match(x))try{await this.reap(x);}catch(error){this.onError(error);this.#cleanupFailed(x);failed++;}return {failed};}
  async awaitClosed(x,timeoutMs=25000){if(!x.children.size)return true;return new Promise(resolve=>{const check=()=>{if(!x.children.size){clearTimeout(timer);x.closedWaiters.delete(check);resolve(true);}};const timer=setTimeout(()=>{x.closedWaiters.delete(check);resolve(false);},timeoutMs);x.closedWaiters.add(check);check();});}
  async stop(id,{preserveQueue=false}={}){if(typeof preserveQueue!=='boolean')throw Error('控制器停止選項無效');const x=this.flows.get(id);if(!x)return {stopped:false,treeExited:false};x.closing=true;this.#clearIdle(x);this.#clearStart(x);x.held=false;x.cleanupErrorCode='';clearTimeout(x.finishTimer);try{const extra=await this.stopExtra(x.project,x.task);if(x.kind==='chat')this.chats.stop(x.project,x.task,preserveQueue?{interrupting:true}:undefined);else this.stopTerminals(x);const closed=await this.awaitClosed(x);if(closed&&extra?.treeExited){x.starting=false;setTimeout(()=>this.finish(id).catch(this.onError),0);}else x.cleanupErrorCode='WORKSPACE_CLEANUP_REQUIRED';return {stopped:closed&&extra?.stopped===true,treeExited:closed&&extra?.treeExited===true};}catch(error){x.cleanupErrorCode='WORKSPACE_CLEANUP_REQUIRED';throw error;}}
  async finish(id){const x=this.flows.get(id);if(!x)return {ok:true,duplicate:true};if(x.finishing)return x.finishing;x.finishing=(async()=>{if(x.children.size)throw Error('owned工作區程序樹尚未完全退出');x.closing=true;this.#clearIdle(x);this.#clearStart(x);x.held=false;clearTimeout(x.finishTimer);const extra=await this.stopExtra(x.project,x.task);if(!extra?.treeExited)throw Error('MCP命令程序仍未完全退出，工作區鎖保留');if(x.workspace)await this.review.releaseRun(x.workspace.run);else if(x.supply){const cleanup=await this.review.secretSupply.cleanup(x.supply.id);if(cleanup?.ok!==true)throw Error('機密供應清理未完成，保留工作區流程與恢復紀錄');}this.flows.delete(id);this.byTask.delete(this.key(x.project,x.task));return {ok:true};})();try{return await x.finishing;}catch(error){x.finishing=null;x.cleanupErrorCode='WORKSPACE_CLEANUP_REQUIRED';throw error;}}
  async failed(x){if(!x)return;const stopped=await this.stop(x.id,{preserveQueue:true});if(!stopped.treeExited)throw Error('工作區啟動失敗且尚未確認所有owned程序退出');x.starting=false;return this.finish(x.id);}
}
module.exports={WorkspaceRuntime};
