'use strict';
// A browser-confirmed, local Git transaction. Journal facts are recoverable
// local evidence; they are not signatures or protection against the OS owner.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const git=require('./git'),policy=require('./git-policy');
const {localPath,localTree}=require('./safe-path');
const {exists}=require('./remove');
const hash=x=>createHash('sha256').update(x).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const eqPath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const within=(a,b)=>{const r=path.relative(a,b);return Boolean(r&&!r.startsWith('..')&&!path.isAbsolute(r));};
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES=new Set(['planned','source-saving','source-saved','target-saving','target-saved','merging','conflict','merged','cleanup-planned','cleanup-moved','complete']);
const COMMIT=/^[a-f0-9]{40,64}$/,DIGEST=/^[a-f0-9]{64}$/;
const snapValid=s=>s&&typeof s==='object'&&!Array.isArray(s)&&Object.keys(s).every(k=>['head','branch','status','content','allContent'].includes(k))&&typeof s.head==='string'&&COMMIT.test(s.head)&&typeof s.branch==='string'&&typeof s.status==='string'&&typeof s.content==='string'&&DIGEST.test(s.content)&&typeof s.allContent==='string'&&DIGEST.test(s.allContent);
const RECORD_KEYS=new Set('version id at project task title taskHash source target workRoot state complete files error sourceOriginal targetOriginal sourceSaved targetMerged sourceHead mergeBefore commit mergeMessage sourceFingerprint trashPlanned trashed skipHooks gitExecution nativeCleanup nativeVerified nativeRepaired'.split(' '));
class ReviewedMerge {
  constructor({root,resolve,busy=()=>false,now=()=>Date.now(),deferCleanup=false}) {
    this.root=localPath(root);if(typeof resolve!=='function')throw Error('需要合併作業解析器');
    if(typeof deferCleanup!=='boolean')throw Error('合併清理設定無效');Object.assign(this,{resolve,busy,now,deferCleanup});this.tokens=new Map();this.owner=randomUUID();this.nativeActive=false;
    this.records=path.join(this.root,'_hub','reviewed-merges');
    this.trash=path.join(this.root,'_hub','merge-trash');
    localPath(this.records,{allowMissing:true});localPath(this.trash,{allowMissing:true});
    this.move=(from,to)=>fs.renameSync(from,to);
  }
  key(project,task){for(const x of [project,task])if(typeof x!=='string'||!x||x.length>4096||x.includes('\0'))throw Error('作業識別無效');return project+'\0'+task;}
  call(dir,args,skipHooks=false){return policy.run(dir,args,{skipHooks}).trim();}
  common(dir){localPath(dir);const d=path.resolve(this.call(dir,['rev-parse','--path-format=absolute','--git-common-dir']));localPath(d);return d;}
  lockPath(dir){return path.join(this.common(dir),'hub-reviewed-merge.lock');}
  locked(dir){if(!dir)return false;localPath(dir,{allowMissing:true});if(!exists(dir))return false;let f;try{f=this.lockPath(dir);}catch(e){if(e.status===128&&/not a git repository/i.test(String(e.stderr)))return false;throw e;}localPath(f,{allowMissing:true});localPath(f+'.recovery-claim',{allowMissing:true});return exists(f)||exists(f+'.recovery-claim');}
  lock(dir,recordId,resume) {
    const file=this.lockPath(dir),claim=file+'.recovery-claim';localPath(file,{allowMissing:true});localPath(claim,{allowMissing:true});
    let claimFd;try{claimFd=fs.openSync(claim,'wx');}catch(e){if(e.code==='EEXIST')throw Error('另一個 Hub 正在取得／恢復 Git 鎖；遺留 claim 需人工確認，未自動刪除');throw e;}
    let fd,claimWritten=false;
    try {
      fs.writeFileSync(claimFd,JSON.stringify({version:1,pid:process.pid,owner:this.owner,recordId,root:this.root,at:this.now()}));fs.fsyncSync(claimFd);claimWritten=true;
      if(exists(file)) {
        const old=this.readFile(file,16384);
        if(!resume||old.version!==1||old.recordId!==recordId||!ID.test(old.recordId)||!ID.test(old.owner)||old.root!==this.root||!Number.isSafeInteger(old.pid)||old.pid<=0||!Number.isSafeInteger(old.at)||!Number.isFinite(new Date(old.at).getTime()))throw Error('此 Git 儲存庫有其他 Hub 合併鎖，或鎖記錄無效');
        let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw Error('無法確認合併鎖擁有者是否已退出');}
        if(alive)throw Error('合併鎖擁有者仍存在（含無法排除 PID 重用）；未自動解除');
        // Every Hub takes this claim, so a second recovery cannot unlink a
        // freshly created main lock between the old-lock check and creation.
        fs.unlinkSync(file);
      }
      fd=fs.openSync(file,'wx');
      fs.writeFileSync(fd,JSON.stringify({version:1,pid:process.pid,owner:this.owner,recordId,root:this.root,at:this.now()}));fs.fsyncSync(fd);
    }catch(e){if(fd!==undefined){fs.closeSync(fd);fd=undefined;}throw e;}
    finally {
      fs.closeSync(claimFd);
      if(claimWritten){const current=this.readFile(claim,16384);if(current.owner!==this.owner||current.recordId!==recordId)throw Error('Git 恢復 claim 已改變，未刪除');fs.unlinkSync(claim);}
      // A failed claim write is retained as unknown, never silently reused.
    }
    return ()=>{fs.closeSync(fd);const current=this.readFile(file,16384);if(current.owner!==this.owner||current.recordId!==recordId)throw Error('Git 合併鎖已改變，未刪除');fs.unlinkSync(file);};
  }
  readFile(file,max=1024*1024) {localPath(file);const st=fs.statSync(file);if(!st.isFile()||st.size>max)throw Error('合併記錄大小或型別無效');return JSON.parse(fs.readFileSync(file,'utf8'));}
  validateRecord(r) {
    if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!RECORD_KEYS.has(k)))throw Error('合併記錄含未知欄位或型別無效');
    if(!r||r.version!==1||!ID.test(r.id)||!STATES.has(r.state)||typeof r.complete!=='boolean'||r.complete!==(r.state==='complete')||typeof r.at!=='string'||!Number.isFinite(Date.parse(r.at))||new Date(r.at).toISOString()!==r.at||typeof r.error!=='string'||typeof r.title!=='string'||typeof r.taskHash!=='string'||typeof r.skipHooks!=='boolean'||!Array.isArray(r.files)||r.files.some(x=>typeof x!=='string'||x.includes('\0')||path.isAbsolute(x)||x.split(/[\\/]/).some(y=>y==='..'))||!snapValid(r.sourceOriginal)||!snapValid(r.targetOriginal)||!r.gitExecution||!Array.isArray(r.gitExecution.hooks)||!Array.isArray(r.gitExecution.blockers)||!DIGEST.test(r.gitExecution.configHash))throw Error('合併記錄格式無效');
    if(r.gitExecution.hooks.some(h=>!h||typeof h.path!=='string'||!path.isAbsolute(h.path)||typeof h.sha256!=='string'||!DIGEST.test(h.sha256)||Object.keys(h).some(k=>!['path','sha256'].includes(k)))||r.gitExecution.blockers.some(x=>typeof x!=='string')||typeof r.gitExecution.configHash!=='string')throw Error('Git 執行審查記錄格式無效');
    for(const h of r.gitExecution.hooks)localPath(h.path,{allowMissing:true});
    this.key(r.project,r.task);
    for(const k of ['source','target','workRoot']){if(typeof r[k]!=='string'||!path.isAbsolute(r[k])||path.resolve(r[k])!==r[k])throw Error('合併記錄路徑無效');localPath(r[k],{allowMissing:true});}
    if(!within(r.workRoot,r.source)||eqPath(r.source,r.target))throw Error('合併記錄來源關係無效');
    if(r.trashPlanned){localPath(r.trashPlanned,{allowMissing:true});if(!within(this.trash,r.trashPlanned))throw Error('合併退避位置無效');}
    if(r.trashed&&r.trashed!==r.trashPlanned)throw Error('合併退避收據無效');
    for(const key of ['sourceHead','mergeBefore','commit'])if(r[key]!==undefined&&!COMMIT.test(r[key]))throw Error('合併 commit 無效');
    if(r.sourceSaved!==undefined&&!snapValid(r.sourceSaved))throw Error('已保存來源快照無效');
    if(r.targetMerged!==undefined&&!snapValid(r.targetMerged))throw Error('已合併目標快照無效');
    if(r.sourceFingerprint!==undefined&&!DIGEST.test(r.sourceFingerprint))throw Error('退避內容快照無效');
    if(['source-saved','target-saving','target-saved','merging','conflict','merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)&&(!COMMIT.test(r.sourceHead)||!snapValid(r.sourceSaved)))throw Error('缺少來源保存證據');
    if(['target-saved','merging','conflict','merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)&&!COMMIT.test(r.mergeBefore))throw Error('缺少合併前目標證據');
    if(['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)&&(!COMMIT.test(r.commit)||!DIGEST.test(r.sourceFingerprint)))throw Error('缺少合併成功證據');
    if(['cleanup-planned','cleanup-moved','complete'].includes(r.state)&&!r.trashPlanned)throw Error('缺少退避意圖');
    if(r.complete&&!r.trashed)throw Error('缺少退避收據');
    if(r.nativeCleanup){require('./rooted-move').validatePlan(r.nativeCleanup);const n=r.nativeCleanup;if(!eqPath(n.sourceRoot,r.workRoot)||!eqPath(path.resolve(n.sourceRoot,n.sourcePath),r.source)||!eqPath(n.targetRoot,this.trash)||!eqPath(path.resolve(n.targetRoot,n.targetPath),path.join(this.trash,r.id))||!eqPath(n.journalRoot,path.join(this.root,'_hub/rooted-moves')))throw Error('Native merge cleanup authority mismatch');}
    if(r.nativeVerified&&(!r.nativeCleanup||Object.keys(r.nativeVerified).sort().join(',')!=='objectId,recordId,treeHash'||r.nativeVerified.objectId!==r.nativeCleanup.objectId||r.nativeVerified.treeHash!==r.nativeCleanup.treeHash||r.nativeVerified.recordId!==r.nativeCleanup.recordId))throw Error('Native merge cleanup evidence mismatch');
    if(r.nativeRepaired&&(!r.nativeCleanup||Object.keys(r.nativeRepaired).sort().join(',')!=='algorithm,bytes,directory,entries,objectId,ok,treeHash'||r.nativeRepaired.algorithm!=='native-tree-v1'||r.nativeRepaired.ok!==true||r.nativeRepaired.directory!==true||r.nativeRepaired.objectId!==r.nativeCleanup.objectId||!DIGEST.test(r.nativeRepaired.treeHash)||!Number.isSafeInteger(r.nativeRepaired.entries)||r.nativeRepaired.entries<1||r.nativeRepaired.entries>20000||!Number.isSafeInteger(r.nativeRepaired.bytes)||r.nativeRepaired.bytes<0||r.nativeRepaired.bytes>256*1024*1024))throw Error('Native post-repair snapshot invalid');
    if(r.complete&&r.nativeCleanup&&!r.nativeRepaired)throw Error('Native complete cleanup lacks post-repair FileID snapshot');
    return r;
  }
  read(project,task) {
    this.key(project,task);localPath(this.records,{allowMissing:true});if(!exists(this.records))return null;
    const names=fs.readdirSync(this.records).filter(n=>ID.test(n.slice(0,-5))&&n.endsWith('.json'));
    if(names.length>10000)throw Error('合併記錄超過確認上限');
    return names.map(n=>{const r=this.validateRecord(this.readFile(path.join(this.records,n)));if(r.id!==n.slice(0,-5))throw Error('合併記錄跨檔識別不符');return r;}).filter(r=>r.project===project&&r.task===task).sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id))[0]||null;
  }
  save(r) {
    this.validateRecord(r);const text=JSON.stringify(r,null,2)+'\n';if(Buffer.byteLength(text)>1024*1024)throw Error('合併記錄超過可恢復大小上限，未繼續修改 Git');localPath(this.records,{allowMissing:true});fs.mkdirSync(this.records,{recursive:true});localPath(this.records);
    const file=path.join(this.records,r.id+'.json'),temp=file+'.'+randomUUID()+'.tmp';localPath(file,{allowMissing:true});
    const fd=fs.openSync(temp,'wx');
    try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.renameSync(temp,file);const dst=fs.openSync(file,'r+');try{fs.fsyncSync(dst);}finally{fs.closeSync(dst);}}
    catch(e){try{fs.unlinkSync(temp);}catch{}throw e;}
  }
  context(project,task,{missing=false}={}) {
    this.key(project,task);const d=this.resolve(project,task);
    if(!d||d.project!==project||d.task!==task||typeof d.taskHash!=='string'||typeof d.title!=='string')throw Error('合併作業關係或指紋無效');
    for(const k of ['dir','workRoot','target'])localPath(d[k],{allowMissing:missing&&k==='dir'});
    const rel=path.relative(d.workRoot,d.dir),first=rel.split(path.sep)[0];
    const source=exists(d.dir)?path.resolve(this.call(d.dir,['rev-parse','--show-toplevel'])):path.join(d.workRoot,first);
    const target=path.resolve(this.call(d.target,['rev-parse','--show-toplevel']));localPath(target);localPath(source,{allowMissing:missing});
    if(!Array.isArray(d.forbiddenRoots||[]))throw Error('合併禁止範圍格式無效');
    for(const f of [path.join(this.root,'_hub'),path.resolve(__dirname,'../..'),...(d.forbiddenRoots||[])]){localPath(f,{allowMissing:true});if([source,target].some(x=>eqPath(x,f)||within(x,f)||within(f,x)))throw Error('合併工作區不得與 Hub 執行碼／控制資料重疊');}
    if(!within(d.workRoot,source)||eqPath(source,target))throw Error('來源不是 Work 範圍內的獨立工作複本');
    if(exists(source)) {
      if(!eqPath(this.common(source),this.common(target)))throw Error('合併來源與目標不是同一個 Git 儲存庫');
      const sourceBranch=this.call(source,['rev-parse','--abbrev-ref','HEAD']),targetBranch=this.call(target,['rev-parse','--abbrev-ref','HEAD']);
      if(sourceBranch!=='HEAD'&&sourceBranch===targetBranch)throw Error('來源工作複本與目標共用同一個 branch；請用獨立分支工作複本');
      const registered=this.call(target,['worktree','list','--porcelain','-z']).split('\0').filter(x=>x.startsWith('worktree ')).map(x=>x.slice(9));
      if(!registered.some(x=>eqPath(x,source)))throw Error('合併來源未登錄為此儲存庫的工作複本');
      localTree(source);
    }
    // Reparse points under the target could redirect checkout writes.
    localTree(target);
    return {...d,source,target,workRoot:path.resolve(d.workRoot)};
  }
  execution(d) {
    if(exists(d.source))git.assertTrackedSecrets(d.source);git.assertTrackedSecrets(d.target);
    const source=exists(d.source)?policy.execution(d.source):null,target=policy.execution(d.target);
    const hooks=[...new Map([...(source?.hooks||[]),...target.hooks].map(x=>[x.path,x])).values()];
    return {hooks,requiresSkipHooksConfirmation:hooks.length>0,skippedHooks:false,blockers:[...new Set([...(source?.blockers||[]),...target.blockers])],configHash:hash(JSON.stringify({source:source?.configHash||'',target:target.configHash})),sourceExecution:source,targetExecution:target,fsmonitorSuppressed:true,externalDiffAndTextconvSuppressed:true};
  }
  fingerprint(dir) {
    return git.rawContent(dir);
  }
  inspect(dir){const snapshot=git.inspect(dir);return {...snapshot,allContent:snapshot?.allContent||this.fingerprint(dir)};}
  checkBusy(d){if(this.busy(d.project,d.task,d.target))throw Error('AI 或其他整理／合併正在執行，請先等它結束');}
  proof(r) {
    if(!r.commit||!r.sourceHead||!r.mergeBefore)return false;
    if(!git.isAncestor(r.target,r.commit)||!git.isAncestor(r.target,r.sourceHead)||!git.isAncestor(r.target,r.mergeBefore))return false;
    return true;
  }
  recoverEvidence(r) {
    if(r.state==='merging'&&!r.commit&&r.sourceHead&&r.mergeBefore) {
      const head=this.call(r.target,['rev-parse','HEAD']),subject=this.call(r.target,['log','-1','--format=%s',head]);
      if((subject===r.mergeMessage||head===r.mergeBefore)&&git.isAncestor(r.target,r.sourceHead)&&git.isAncestor(r.target,r.mergeBefore)) {
        if(!exists(r.source)||!same(this.inspect(r.source),r.sourceSaved))throw Error('Git 合併之後来源已變更，未自動認定交易成功');
        r.commit=head;r.files=this.call(r.target,['diff','--no-ext-diff','--no-textconv','--name-only','-z',r.mergeBefore,head]).split('\0').filter(Boolean);r.sourceFingerprint=this.fingerprint(r.source);r.state='merged';r.error='';
      } else if(head===r.mergeBefore) {
        let active=false;try{this.call(r.target,['rev-parse','--verify','-q','MERGE_HEAD']);active=true;}catch(e){if(e.status!==1&&e.status!==128)throw e;}
        if(active)throw Error('Git 合併仍在進行；請先以人工可信 Git 流程完成或取消');
      }
    }
    if(r.trashPlanned&&!exists(r.source)&&exists(r.trashPlanned)) {
      if(!this.proof(r)||this.fingerprint(r.trashPlanned)!==r.sourceFingerprint)throw Error('來源已不存在，但無法確認已合併的退避內容');
    }
    return r;
  }
  token(d) {
    const now=this.now();for(const [k,v]of this.tokens)if(now-v.at>600000||now<v.at)this.tokens.delete(k);
    if(this.tokens.size>=128)throw Error('合併預覽過多，請等候舊預覽到期');
    const token=randomUUID();this.tokens.set(token,{at:now,value:d});return {...d,token};
  }
  preview(project,task) {
    let r=this.read(project,task);const d=this.context(project,task,{missing:Boolean(r)});this.checkBusy(d);
    if(r&&(!eqPath(r.source,d.source)||!eqPath(r.target,d.target)||!eqPath(r.workRoot,d.workRoot)))throw Error('作業來源／目標與合併記錄不同');
    const recordHash=r?hash(JSON.stringify(r)):null;
    if(r&&(!r.complete||!exists(d.source))) {
      r=this.recoverEvidence(r);
      if(r.complete&&exists(d.source))throw Error('已完成交易的來源位置出現新內容，未清理新來源');
      const source=exists(d.source)?this.inspect(d.source):null,target=this.inspect(d.target),gitExecution=this.execution(d);
      if(['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)&&!this.proof(r))throw Error('已合併 commit 的祖先證據已改變');
      const retry=!['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)&&source?git.preview({dir:d.source,workRoot:d.workRoot,target:d.target}):null;
      const dirty=Boolean(source?.status||target.status);
      return this.token({project,task,title:d.title,taskHash:d.taskHash,dir:d.source,main:d.target,workRoot:d.workRoot,source,target,files:retry?.files??r.files.length,paths:retry?.paths||r.files,notStagedSecrets:retry?.notStagedSecrets||[],added:retry?.added||0,removed:retry?.removed||0,conflict:retry?.conflict||false,conflictUnknown:Boolean(retry&&dirty),dirty,dirtyState:{source:Boolean(source?.status),target:Boolean(target.status)},resume:true,recordId:r.id,recordHash,state:r.state,gitExecution,action:r.complete?'再次確認已完成收據，修復作業資訊；不刪除新來源':'明確確認後繼續此交易；已合併內容不會重複合併，退避保留分支與工作複本。衝突預演只檢查已提交內容；未提交內容雜湊已綁定此次確認，保存後仍可能衝突，衝突時保留兩側 commit 和來源。'});
    }
    if(!exists(d.source))throw Error('來源不存在且沒有可恢復的合併證據');
    const gitExecution=this.execution(d);
    if(gitExecution.blockers.length)throw Error(gitExecution.blockers.join(' / '));
    const source=this.inspect(d.source),target=this.inspect(d.target),pv=git.preview({dir:d.source,workRoot:d.workRoot,target:d.target});
    if(!pv)throw Error('無法確認 Git 合併基礎');
    const dirty=Boolean(source.status||target.status);
    return this.token({project,task,title:d.title,taskHash:d.taskHash,dir:d.source,main:d.target,workRoot:d.workRoot,source,target,files:pv.files,paths:pv.paths,notStagedSecrets:pv.notStagedSecrets||[],added:pv.added,removed:pv.removed,conflict:pv.conflict,conflictUnknown:dirty,dirty,dirtyState:{source:Boolean(source.status),target:Boolean(target.status)},resume:false,gitExecution,action:'明確確認後保存兩側未提交變更，再合併來源 commit；合併成功收據持久保存後將來源移至本機可回復退避目錄，保留分支。衝突預演只檢查已提交內容；未提交內容雜湊已綁定此次確認，保存後仍可能衝突，衝突時保留兩側 commit 和來源。依檔名規則排除的新可能機密路徑不加入 Git；這不代表已偵測全部秘密。若有 hooks，需另行確認本次不執行；外部 filters／drivers／簽章要求交由人工可信 Git 流程。'});
  }
  async previewAsync(project,task){
    if(process.platform!=='win32')return this.preview(project,task);if(this.nativeActive)throw Error('此合併已有原生交易進行中');this.nativeActive=true;
    let out;try{out=this.preview(project,task);const entry=this.tokens.get(out.token),r=this.read(project,task);let nativeCleanup=r?.nativeCleanup;if(r&&!r.complete&&!nativeCleanup&&['merged','cleanup-planned','cleanup-moved'].includes(r.state))throw Error('Legacy merge cleanup needs a fresh manual recovery review');
      if((!nativeCleanup||r&&!['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state))&&exists(out.dir)){const id=r?.id||randomUUID(),journalRoot=path.join(this.root,'_hub/rooted-moves');localPath(this.trash,{allowMissing:true});localPath(journalRoot,{allowMissing:true});fs.mkdirSync(this.trash,{recursive:true});fs.mkdirSync(journalRoot,{recursive:true});nativeCleanup=await require('./rooted-move').plan({sourceRoot:out.workRoot,sourcePath:path.relative(out.workRoot,out.dir),targetRoot:this.trash,targetPath:id,journalRoot});entry.value.nativeRecordId=id;}
      if(nativeCleanup){entry.value.nativeCleanup=nativeCleanup;out.nativeCleanup=nativeCleanup;out.nativeRecordId=entry.value.nativeRecordId;}
      if(!same(out.source,exists(out.dir)?this.inspect(out.dir):null)||!same(out.target,this.inspect(out.main)))throw Error('Native cleanup preview期間來源或目標已變更');return out;
    }catch(error){if(out)this.tokens.delete(out.token);throw error;}finally{this.nativeActive=false;}
  }
  advanceTarget(token,previousRecordId){const entry=this.tokens.get(token);if(!entry||this.now()<entry.at||this.now()-entry.at>600000||!ID.test(previousRecordId))throw Error('階層合併确认或連續收據無效');const r=this.validateRecord(this.readFile(path.join(this.records,previousRecordId+'.json'))),v=entry.value;if(r.id!==previousRecordId||!['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)||!r.targetMerged||!eqPath(r.target,v.main)||!same(r.targetOriginal,v.target)||!this.proof(r)||!same(this.inspect(r.target),r.targetMerged)||!same(exists(v.dir)?this.inspect(v.dir):null,v.source))throw Error('階層合併目標不是上一筆已核准收據的精確結果');const execution=this.execution({source:v.dir,target:v.main}),before=v.gitExecution;if(!same(execution.sourceExecution,before.sourceExecution)||!before.targetExecution?.configRowsHash||execution.targetExecution.configRowsHash!==before.targetExecution.configRowsHash||!same(execution.targetExecution.externalHelpers,before.targetExecution.externalHelpers)||!same(execution.hooks,before.hooks)||execution.blockers.length||before.blockers.length)throw Error('階層合併設定／hooks／source evidence已變更，未更新授權');v.target=r.targetMerged;v.gitExecution=execution;return {recordId:r.id,target:v.target};}
  async applyAsync(input){
    if(process.platform!=='win32')return this.apply(input);if(this.nativeActive)throw Error('此合併已有原生交易進行中');const entry=this.tokens.get(input.token);if(!entry?.value.nativeCleanup&&!entry?.value.resume)throw Error('缺少使用者確認前建立的 native cleanup plan');this.nativeActive=true;
    const originalLock=this.lock,originalDeferred=this.deferCleanup,held=[];this.lock=function(...args){const release=originalLock.apply(this,args);held.push(release);return()=>{};};this.deferCleanup=true;
    try{const out=this.apply(input);if(!out.merged||originalDeferred)return out;const r=this.read(input.project,input.task);return await this.cleanupNative(r,{allowRetry:true});}finally{this.lock=originalLock;this.deferCleanup=originalDeferred;try{for(const release of held.reverse())release();}finally{this.nativeActive=false;}}
  }
  async cleanupAsync(project,task,{confirmedResume=false}={}){
    if(process.platform!=='win32'||typeof confirmedResume!=='boolean')throw Error('Native cleanup setting is invalid');if(this.nativeActive)throw Error('此合併已有原生交易進行中');const r=this.read(project,task);if(!r||!['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state)||!r.nativeCleanup)throw Error('缺少已合併收據和確認前 native cleanup plan');const d=this.context(project,task,{missing:true});this.checkBusy(d);if(!eqPath(d.source,r.source)||!eqPath(d.target,r.target)||d.taskHash!==r.taskHash)throw Error('合併清理作業已變更');this.nativeActive=true;const release=this.lock(r.target,r.id,false);try{return await this.cleanupNative(r,{allowRetry:confirmedResume});}finally{try{release();}finally{this.nativeActive=false;}}
  }
  async cleanupNative(r,{allowRetry=false}={}){
    try{if(!this.proof(r))throw Error('缺少可信合併祖先證據，未清理');if(r.complete){if(!await this.receiptAsync(r.project,r.task))throw Error('合併收據無效');return this.result(r);}if(!r.nativeCleanup)throw Error('缺少確認前 native cleanup plan');const rooted=require('./rooted-move');
      if(exists(r.source)){if(!same(this.inspect(r.source),r.sourceSaved)||this.fingerprint(r.source)!==r.sourceFingerprint)throw Error('合併後來源已變更，未清理');const observed=await rooted.snapshot({root:r.nativeCleanup.sourceRoot,rootFingerprint:r.nativeCleanup.sourceRootFingerprint,path:r.nativeCleanup.sourcePath});if(observed.objectId!==r.nativeCleanup.objectId||observed.treeHash!==r.nativeCleanup.treeHash)throw Error('合併後 native來源FileID/tree已變更');}
      let planned=r.state==='cleanup-planned'||r.state==='cleanup-moved';r.trashPlanned=path.join(this.trash,r.id);if(planned&&allowRetry&&exists(r.source)&&!exists(r.trashPlanned)){try{await rooted.recover(r.nativeCleanup);}catch(error){if(error.code!=='RECORD_NOT_FOUND')throw error;planned=false;}}if(!planned){r.state='cleanup-planned';this.save(r);await this.beforeNativeMutation?.(r);const moved=await rooted.move(r.nativeCleanup);if(moved.state!=='complete')throw Error('Native合併清理 partial，保留紀錄待人工恢復');}else{let recovery=await rooted.recover(r.nativeCleanup);if(recovery.state==='moved-unreceipted'){await rooted.finalize(r.nativeCleanup);recovery=await rooted.recover(r.nativeCleanup);}if(recovery.state!=='complete')throw Error('Native合併清理需人工恢復：'+recovery.state);}
      r.nativeVerified={objectId:r.nativeCleanup.objectId,treeHash:r.nativeCleanup.treeHash,recordId:r.nativeCleanup.recordId};r.state='cleanup-moved';this.save(r);if(exists(r.source)||!exists(r.trashPlanned)||this.fingerprint(r.trashPlanned)!==r.sourceFingerprint)throw Error('Native退避後內容已變更，未標示完成');this.call(r.target,['worktree','repair',r.trashPlanned],r.skipHooks);r.sourceFingerprint=this.fingerprint(r.trashPlanned);const repaired=await rooted.snapshot({root:r.nativeCleanup.targetRoot,rootFingerprint:r.nativeCleanup.targetRootFingerprint,path:r.nativeCleanup.targetPath});if(repaired.objectId!==r.nativeCleanup.objectId||this.fingerprint(r.trashPlanned)!==r.sourceFingerprint)throw Error('Native repair後內容或FileID已變更');r.nativeRepaired=repaired;r.trashed=r.trashPlanned;r.state='complete';r.complete=true;r.error='';this.save(r);return this.result(r);
    }catch(error){r.error=String(error.message).slice(0,2000);this.save(r);return{...this.result(r),ok:false,partial:true,error:require('./rooted-move').messageFor(error.code)||r.error,...(require('./rooted-move').messageFor(error.code)?{code:error.code}:{})};}
  }
  saveChanges(dir,message,skipHooks) {
    if(process.platform==='win32')policy.assertIndexVisible(dir);
    git.assertTrackedSecrets(dir);
    if(!this.call(dir,['status','--porcelain'],skipHooks))return;
    this.call(dir,['add','-A'],skipHooks);
    const secrets=this.call(dir,['diff','--cached','--name-only','--diff-filter=A','--no-renames','-z'],skipHooks).split('\0').filter(Boolean).filter(git.isSensitivePath);
    for(let n=0;n<secrets.length;n+=100)this.call(dir,['rm','--cached','-q','--',...secrets.slice(n,n+100).map(f=>':(top,literal)'+f)],skipHooks);
    try{this.call(dir,['diff','--cached','--quiet'],skipHooks);return;}catch(e){if(e.status!==1)throw e;}
    this.call(dir,['commit','-q','-m',message],skipHooks);
  }
  apply({project,task,token,confirm,skipHooks=false}) {
    const entry=this.tokens.get(token);this.tokens.delete(token);
    if(!entry||confirm!==true||entry.value.project!==project||entry.value.task!==task||this.now()-entry.at>600000||this.now()<entry.at)throw Error('請重新預覽並明確確認這項合併');
    const v=entry.value,d=this.context(project,task,{missing:v.resume}),execution=this.execution(d);this.checkBusy(d);
    if(!eqPath(d.source,v.dir)||!eqPath(d.target,v.main)||!eqPath(d.workRoot,v.workRoot))throw Error('確認中合併路徑已變更');
    if(!same(execution,v.gitExecution)||execution.blockers.length)throw Error('Git 執行設定／hooks 已變更或存在阻擋，請重新預覽');
    if(execution.requiresSkipHooksConfirmation&&skipHooks!==true)throw Error('請另行明確確認本次不執行預覽列出的 Git hooks');
    if(!same(exists(d.source)?this.inspect(d.source):null,v.source)||!same(this.inspect(d.target),v.target))throw Error('確認中來源或目標內容已變更，請重新預覽');
    let r=this.read(project,task);
    if(v.resume) {if(!r||r.id!==v.recordId||hash(JSON.stringify(r))!==v.recordHash||!eqPath(r.source,d.source)||!eqPath(r.target,d.target)||!eqPath(r.workRoot,d.workRoot))throw Error('合併恢復記錄已變更，請重新預覽');if(!r.complete&&d.taskHash!==v.taskHash)throw Error('確認中作業內容已變更');if(v.nativeCleanup&&!['merged','cleanup-planned','cleanup-moved','complete'].includes(r.state))r.nativeCleanup=v.nativeCleanup;}
    else {if(r&&!r.complete)throw Error('另一筆合併交易已開始，請預覽恢復');if(d.taskHash!==v.taskHash)throw Error('確認中作業內容已變更');r={version:1,id:v.nativeRecordId||randomUUID(),at:new Date(this.now()).toISOString(),project,task,title:d.title,taskHash:d.taskHash,source:d.source,target:d.target,workRoot:d.workRoot,state:'planned',complete:false,files:[],error:'',sourceOriginal:v.source,targetOriginal:v.target,gitExecution:execution,skipHooks:skipHooks===true,...(v.nativeCleanup?{nativeCleanup:v.nativeCleanup}:{})};}
    const release=this.lock(d.target,r.id,v.resume);
    try {
      // Every state preceding a Git or filesystem mutation is flushed first.
      if(!v.resume)this.save(r);
      r=this.recoverEvidence(r);
      if(r.complete){if(exists(r.source))throw Error('來源位置出現新內容，未清理');return this.result(r);}
      if(!['merged','cleanup-planned','cleanup-moved'].includes(r.state)) {
        if(!exists(r.source))throw Error('尚未合併的來源不存在');
        policy.assertMergeExecution(r.source,r.target);
        if(!same(this.inspect(r.source),v.source)||!same(this.inspect(r.target),v.target))throw Error('取得鎖後來源或目標已變更，請重新預覽');
        r.state='source-saving';r.error='';this.save(r);this.saveChanges(r.source,'Project Hub source '+r.id,skipHooks);
        r.sourceHead=this.call(r.source,['rev-parse','HEAD']);r.sourceSaved=this.inspect(r.source);
        if(r.sourceSaved.allContent!==v.source.allContent)throw Error('保存來源時檔案內容已變更；保留來源並要求重新預覽');
        r.state='source-saved';this.save(r);
        if(!same(this.inspect(r.target),v.target))throw Error('保存來源後目標已變更，未保存目標，請重新預覽');
        r.state='target-saving';this.save(r);this.saveChanges(r.target,'Project Hub target '+r.id,skipHooks);
        r.mergeBefore=this.call(r.target,['rev-parse','HEAD']);
        if(this.fingerprint(r.target)!==v.target.allContent)throw Error('保存目標時檔案內容已變更；保留來源並要求重新預覽');
        r.state='target-saved';this.save(r);
        r.mergeMessage='Project Hub merge '+r.id+': '+r.title;r.state='merging';this.save(r);
        if(!git.isAncestor(r.target,r.sourceHead)) {
          try{this.call(r.target,['merge','--no-ff','--no-edit','-m',r.mergeMessage,r.sourceHead],skipHooks);}
          catch(e){
            let inMerge=false;try{this.call(r.target,['rev-parse','--verify','MERGE_HEAD']);inMerge=true;}catch(x){if(x.status!==128&&x.status!==1)throw x;}
            if(inMerge)this.call(r.target,['merge','--abort'],skipHooks);
            r.state='conflict';r.error='Git 合併未成功；來源已保留，兩侧已保存的 commit 保留：'+String(e.stderr||e.message).slice(0,2000);this.save(r);
            return {...this.result(r),ok:false,conflict:inMerge,partial:true,state:r.state,error:r.error};
          }
        }
        r.commit=this.call(r.target,['rev-parse','HEAD']);r.files=this.call(r.target,['diff','--no-ext-diff','--no-textconv','--name-only','-z',r.mergeBefore,r.commit]).split('\0').filter(Boolean);
        r.sourceSaved=this.inspect(r.source);r.sourceFingerprint=this.fingerprint(r.source);r.targetMerged=this.inspect(r.target);r.state='merged';this.save(r);
      }
      if(!this.proof(r))throw Error('無法確認已合併 commit，來源未清理');
      if(this.deferCleanup)return {...this.result(r),ok:true,merged:true,complete:false};
      if(exists(r.source)) {
        if(!same(this.inspect(r.source),r.sourceSaved)||this.fingerprint(r.source)!==r.sourceFingerprint)throw Error('合併後來源內容已變更，保留來源且未清理');
        localTree(r.source);localPath(this.trash,{allowMissing:true});fs.mkdirSync(this.trash,{recursive:true});
        r.trashPlanned=r.trashPlanned||path.join(this.trash,r.id);localPath(r.trashPlanned,{allowMissing:true});if(exists(r.trashPlanned))throw Error('退避位置已有內容，未覆蓋');
        r.state='cleanup-planned';this.save(r);this.move(r.source,r.trashPlanned);r.state='cleanup-moved';this.save(r);
      }
      if(!r.trashPlanned||!exists(r.trashPlanned)||this.fingerprint(r.trashPlanned)!==r.sourceFingerprint)throw Error('無法確認退避內容，未標示完成');
      this.call(r.target,['worktree','repair',r.trashPlanned],skipHooks);
      // repair changes the .git pointer; keep its post-repair fingerprint.
      r.sourceFingerprint=this.fingerprint(r.trashPlanned);r.trashed=r.trashPlanned;r.state='complete';r.complete=true;r.error='';this.save(r);
      return this.result(r);
    }catch(e){
      r.error=String(e.message).slice(0,2000);let journalError='';try{this.save(r);}catch(j){journalError=String(j.message).slice(0,1000);}
      return {...this.result(r),ok:false,partial:r.state!=='planned',state:r.state,error:r.error,journalError};
    }finally{release();}
  }
  result(r){return {ok:r.complete===true,main:r.target,commit:r.commit||null,files:r.files,trashed:r.trashed||null,recordId:r.id,at:r.at,state:r.state,sourceHead:r.sourceHead||null,targetSavedHead:r.mergeBefore||null};}
  receipt(project,task) {const r=this.read(project,task);if(!r||!r.complete)return null;if(!this.proof(r)||!r.trashed||!exists(r.trashed)||this.fingerprint(r.trashed)!==r.sourceFingerprint)throw Error('合併收據與實際 commit／退避內容不符');return this.result(r);}
  async receiptAsync(project,task){const out=this.receipt(project,task);if(!out)return null;const r=this.read(project,task);if(r.nativeCleanup){const observed=await require('./rooted-move').snapshot({root:r.nativeCleanup.targetRoot,rootFingerprint:r.nativeCleanup.targetRootFingerprint,path:r.nativeCleanup.targetPath});if(!same(observed,r.nativeRepaired))throw Error('Native合併收據post-repair FileID/tree已變更');}return out;}
  recovery(project,task) {const r=this.read(project,task);if(!r)return null;return {recordId:r.id,state:r.state,complete:r.complete,sourceMissing:!exists(r.source)};}
}
module.exports={ReviewedMerge};
