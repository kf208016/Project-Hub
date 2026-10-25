'use strict';
// 祖先側の確認→子孫ごとの取り込み→受領→片付け。段階を保存し再開する。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const graph = require('../public/project-order'), git = require('./git');
const { noLinks, exists, snapshot } = require('./remove');
const journal=require('./local-journal');
const hash = s => createHash('sha256').update(s).digest('hex');
const key = x => x.project + '\0' + x.task;
const expand = s => s?.startsWith('~/') ? path.join(os.homedir(),s.slice(2)) : s;
class TaskIntegrate {
  constructor({store,transfer,removal,baseOf=p=>p.dir,gitw=git}) {
    Object.assign(this,{store,transfer,removal,baseOf,gitw});this.tokens=new Map();
    this.dir=path.join(store.root,'_hub/task-integrations');
    this.nativeContexts=new Map();this.nativeCount=0;
    if(process.platform==='win32')this.reviewed=new (require('./reviewed-merge').ReviewedMerge)({root:store.root,deferCleanup:true,busy:(project,task)=>removal.busy(project,task)||removal.locked(project),resolve:(project,task)=>{const d=this.nativeContexts.get(key({project,task}));if(!d)throw Error('No private hierarchy merge authority');const current=store.readProject(project)?.tasks.find(t=>t.id===task);if(current&&current.completionHash!==d.taskHash)throw Error('Hierarchy source task changed');return d;}});
    transfer.beforeCleanup=r=>process.platform==='win32'&&r.nativeCleanup?this.cleanupCopyAsync(r):this.cleanupCopy(r);
  }
  file(project,task){for(const value of [project,task])if(typeof value!=='string'||!value||value.length>255||/[\\/\0]|^\.{1,2}$/.test(value))throw Error('Invalid hierarchy task identity');return path.join(this.dir,hash(project+'\0'+task)+'.json');}
  validate(r){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if(!r||typeof r!=='object'||Array.isArray(r)||!uuid.test(r.id||'')||typeof r.complete!=='boolean'||typeof r.target!=='string'||!path.isAbsolute(r.target)||typeof r.at!=='string'||!Number.isFinite(Date.parse(r.at))||!Array.isArray(r.items)||!r.items.length||r.items.length>100||r.nativeVersion!==undefined&&r.nativeVersion!==1||r.error!==undefined&&typeof r.error!=='string')throw Error('Invalid hierarchy integration record');
    this.file(r.project,r.task);noLinks(r.target);const seen=new Set(),recordFields=new Set('id project task target items at complete error nativeVersion nativeDestination'.split(' ')),itemFields=new Set('project task title taskHash route depth handedUp files selected copy source preview integrated descendants blockers move optional keep overlaps branch state nativeCleanup gitExecution sourceSnapshot sourceHead copyTrashPlanned copyTrashed receipt mergeRecordId'.split(' '));
    if(r.nativeVersion===1&&(Object.keys(r).some(k=>!recordFields.has(k))||!r.nativeDestination||Object.keys(r.nativeDestination).sort().join(',')!=='root,rootFingerprint'||r.nativeDestination.root!==path.join(this.store.product,r.project)||!/^[a-f0-9]{64}$/.test(r.nativeDestination.rootFingerprint)))throw Error('Invalid confirmed hierarchy destination');
    for(const i of r.items){this.file(i.project,i.task);if(seen.has(key(i))||typeof i.title!=='string'||!['待ち','衝突','取り込み済み','片付け済み'].includes(i.state)||!Array.isArray(i.files)||!Array.isArray(i.optional)||!Array.isArray(i.descendants)||typeof i.taskHash!=='string')throw Error('Invalid hierarchy item');seen.add(key(i));this.transfer.validate({id:r.id,project:i.project,task:i.task,files:i.files,optional:i.optional});
      if(r.nativeVersion===1){if(Object.keys(i).some(k=>!itemFields.has(k))||!i.nativeCleanup||i.mergeRecordId!==undefined&&!uuid.test(i.mergeRecordId)||i.copy!==null&&(typeof i.copy!=='string'||!path.isAbsolute(i.copy))||i.copy&&['取り込み済み','片付け済み'].includes(i.state)&&!i.mergeRecordId)throw Error('Missing confirmed native hierarchy cleanup');this.removal.validateNativeRecord(i.nativeCleanup);if(i.nativeCleanup.project!==i.project||i.nativeCleanup.task!==i.task)throw Error('Native hierarchy cleanup belongs to another task');if(i.files.some(f=>!f.native))throw Error('Missing confirmed hierarchy artifact FileID');}
    }
    if(r.complete&&r.items.some(i=>i.state!=='片付け済み'))throw Error('Hierarchy record claims completion before cleanup');return r;
  }
  read(project,task){const r=journal.read(this.file(project,task));if(!r)return null;this.validate(r);if(r.project!==project||r.task!==task)throw Error('Hierarchy record identity mismatch');return r;}
  save(r){this.validate(r);journal.save(this.file(r.project,r.task),r);}
  pending(){
    if(!exists(this.dir))return [];noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).flatMap(n=>{
      try{const f=path.join(this.dir,n);noLinks(f);const r=this.validate(journal.read(f));if(this.file(r.project,r.task)!==f)throw Error('Hierarchy record identity mismatch');return r.complete?[]:[{project:r.project,task:r.task,id:r.id,items:r.items.map(x=>({project:x.project,task:x.task,title:x.title,state:x.state}))}];}catch(error){if(process.platform==='win32')throw error;return [];}
    });
  }
  ancestor(project,task){
    const all=this.store.listProjects(),p=all.find(x=>x.id===project),t=p?.tasks.find(x=>x.id===task);
    if(!t)throw Error('統合する親作業が見つかりません');
    if(this.removal.busy(project,task)||this.removal.locked(project))throw Error('親作業でAI・整理・確認が動いています。この返事が終わってから統合してください');
    const q=path.join(p.dir,'.ai/chat',task+'.queue.json');noLinks(q);
    if(exists(q)){const rows=JSON.parse(fs.readFileSync(q,'utf8'));if(!Array.isArray(rows)||rows.length)throw Error('親作業に順番待ちがあります');}
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))throw Error('親の作業場所の記録が不正です');
    if(copy&&!exists(wd))throw Error('親の作業用コピーが見つかりません。記録を片付けてから統合してください');
    const target=copy?wd:this.baseOf(p);noLinks(target);
    return {all,p,t,target};
  }
  details(a,p,t,ownId){
    const r=this.transfer.read(p.id,t.id),d=this.removal.describe(p.id,t.id);
    const blockers=d.blockers.filter(x=>!x.startsWith('作業用コピー')&&!x.startsWith('下の作業や'));
    if(!graph.finished(t)||t.question)blockers.push('子作業の手順・質問が残っています');
    if(t.mergeExcluded)blockers.push('取り込み対象から外されています');
    if(t.kind==='derived'&&!require('./work-context').sourceOf(p,t.derivedFrom,a.all))blockers.push('派生元が同じ大きなプロジェクト内にありません');
    if(r?.complete)blockers.push('受領済みの作業が復元されています。再統合はできません');
    if(r?.integrating&&r.integrating!==ownId)blockers.push('別の祖先の統合が進行中です');
    if(r&&!r.handedUp&&!r.integrating&&!r.complete)blockers.push('旧版の引渡しが進行中です。先にその続きを行ってください');
    const ancestors=graph.ancestorsOf(p,t,a.all),depth=ancestors.findIndex(x=>x.project.id===a.p.id&&x.task.id===a.t.id)+1;
    const route=ancestors.slice(0,depth-1).reverse().map(x=>x.task.title).concat(t.title).join(' › ');
    const descendants=a.all.flatMap(q=>q.tasks.filter(x=>graph.ancestorsOf(q,x,a.all).some(y=>y.project.id===p.id&&y.task.id===t.id)).map(x=>({project:q.id,task:x.id,title:x.title,finished:graph.finished(x)&&!x.question})));
    if(descendants.some(x=>!x.finished))blockers.push('未完了の子孫があります。先に下の作業を済ませてください');
    let files=[];
    try{files=r?.handedUp?r.files:this.transfer.artifacts(p,t);for(const f of files)if(snapshot(f.path)!==f.fingerprint)throw Error('渡し済みの成果が変わっています。成果を渡し直してください');}catch(e){blockers.push(e.message);}
    const wd=expand(t.workdir),rel=wd&&path.relative(this.removal.workRoot(p),wd);
    const copy=Boolean(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));
    if(wd&&!copy&&path.resolve(wd)!==path.resolve(this.baseOf(p)))blockers.push('子の作業場所の記録が不正です');
    if(copy&&!exists(wd))blockers.push('子の作業用コピーが見つかりません。記録を確認してください');
    const preview=copy&&exists(wd)?this.gitw.preview({dir:wd,workRoot:this.removal.workRoot(p),target:a.target}):null;
    const source=copy&&exists(wd)?this.gitw.inspect(wd):null;
    if(copy&&!source)blockers.push('子の作業用コピーのGitを確認できません');
    const integrated=!copy?this.transfer.integration(p,t):null;
    if(!files.length&&!copy&&!integrated?.files?.length)blockers.push('成果ファイルがありません。子の［成果を渡す］でファイルを指定してください');
    return {project:p.id,task:t.id,title:t.title,taskHash:t.completionHash,route,depth,handedUp:Boolean(r?.handedUp),files,selected:files.map(f=>f.id),copy:copy?wd:null,source,preview,integrated,descendants,blockers:[...new Set(blockers)],move:d.move,optional:d.optional,keep:d.keep};
  }
  preview(project,task,only){
    const a=this.ancestor(project,task),old=this.read(project,task);
    if(old&&!old.complete){
      if(path.resolve(old.target)!==path.resolve(a.target))throw Error('途中の統合先が変わっています。保存された統合先を確認してください');
      return this.token({project,task,target:old.target,resume:true,id:old.id,items:old.items,ancestorHash:a.t.completionHash});
    }
    let items=a.all.flatMap(p=>p.tasks.filter(t=>graph.canIntegrate({project:a.p,task:a.t},p,t,a.all)&&graph.finished(t)).map(t=>this.details(a,p,t)));
    if(only){
      if(!Array.isArray(only))throw Error('統合対象を確認してください');
      const keys=new Set(only.map(key));
      for(const x of only){this.transfer.expectTitle(x.project,x.task,x.expectTitle);if(!items.some(i=>key(i)===key(x)))throw Error('この祖先からはその子を統合できません');}
      // 子を選んだ時は完了した孫も拾い、下から片付ける。
      for(const i of items)if(keys.has(key(i)))for(const d of i.descendants)keys.add(key(d));
      items=items.filter(i=>keys.has(key(i)));
    }
    items.sort((x,y)=>y.depth-x.depth||(x.preview?.files||0)-(y.preview?.files||0)||x.title.localeCompare(y.title));
    for(const i of items){
      if(i.descendants.some(d=>!items.some(x=>key(x)===key(d))))i.blockers.push('子孫を先に統合する必要があります');
      if(i.descendants.some(d=>items.find(x=>key(x)===key(d))?.blockers.length))i.blockers.push('先に統合する子孫に確認が必要です');
      i.overlaps=items.filter(j=>key(j)!==key(i)&&(j.preview?.paths||[]).some(f=>i.preview?.paths?.includes(f))).map(j=>j.title);
    }
    return this.token({project,task,target:a.target,ancestorHash:a.t.completionHash,targetSnapshot:this.gitw.inspect(a.target),items});
  }
  token(value){for(const [id,x]of this.tokens)if(Date.now()-x.at>600000)this.tokens.delete(id);const token=randomUUID();this.tokens.set(token,{at:Date.now(),value});return {...value,token};}
  apply({project,task,token,selected,confirm}){
    const x=this.tokens.get(token);
    if(!x||Date.now()-x.at>600000||confirm!==true||x.value.project!==project||x.value.task!==task)throw Error('もう一度統合内容を確認してください');
    const d=x.value,a=this.ancestor(project,task);let r=this.read(project,task);
    if(r?.complete&&r.id===d.id)return {ok:true,complete:true,duplicate:true};
    if(!d.resume){
      if(r&&!r.complete)throw Error('別の統合が始まりました。続きを確認してください');
      if(a.t.completionHash!==d.ancestorHash||path.resolve(a.target)!==path.resolve(d.target)||JSON.stringify(this.gitw.inspect(a.target))!==JSON.stringify(d.targetSnapshot))throw Error('確認中に親作業・統合先が変わりました');
      if(!Array.isArray(selected)||!selected.length||new Set(selected.map(key)).size!==selected.length)throw Error('統合する子作業を選んでください');
      const items=selected.map(s=>{
        const i=d.items.find(i=>key(i)===key(s));if(!i||i.blockers.length)throw Error(i?.blockers.join(' / ')||'統合対象が不正です');
        const p=a.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:a.p,task:a.t},p,t,a.all))throw Error('確認中に子作業・祖先の関係が変わりました');
        const now=this.details(a,p,t);if(now.blockers.length)throw Error(now.blockers.join(' / '));
        if(JSON.stringify(now.source)!==JSON.stringify(i.source))throw Error('確認中に子の変更が変わりました');
        if(!i.copy&&JSON.stringify(now.integrated)!==JSON.stringify(i.integrated))throw Error('確認中に既存の取り込み記録が変わりました');
        const ids=s.files===undefined?i.selected:s.files;
        if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!i.files.some(f=>f.id===id)))throw Error('成果ファイルの選択が不正です');
        const optional=s.optional||[];if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>!i.optional.some(f=>f.id===id)))throw Error('片付ける専用フォルダが不正です');
        const files=i.files.filter(f=>ids.includes(f.id));if(!files.length&&!i.copy&&!i.integrated?.files?.length)throw Error('成果ファイルを選んでください');
        for(const f of files)if(snapshot(f.path)!==f.fingerprint)throw Error('確認中に成果ファイルが変わりました');
        return {...i,files,optional,branch:i.source?.branch,state:'待ち'};
      });
      // 表示順を変更できても孫→子の制約は崩さない。
      for(let n=0;n<items.length;n++)for(const kid of items[n].descendants)if(!items.slice(0,n).some(i=>key(i)===key(kid)))throw Error('子孫を一緒に選び、孫から先に統合してください');
      r={id:randomUUID(),project,task,target:a.target,items,at:new Date().toISOString(),complete:false};this.save(r);d.id=r.id;
      for(const i of items){const h=this.transfer.read(i.project,i.task);if(h?.integrating&&h.integrating!==r.id)throw Error('別の祖先が同じ子を統合しています');this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }else if(!r||r.id!==d.id||r.complete)throw Error('統合記録が変わりました');
    if(path.resolve(a.target)!==path.resolve(r.target))throw Error('統合先が変わりました');
    this.active=r;
    try { return this.run(r); }catch(e){r.error=e.message;this.save(r);throw e;}finally{this.active=null;}
  }
  run(r){
    const a=this.ancestor(r.project,r.task);
    // 初回の予約保存が途中で止まった場合も、残りを予約してから処理する。
    for(const i of r.items){
      if(i.state==='片付け済み')continue;
      const h=this.transfer.read(i.project,i.task);
      if(h?.integrating&&h.integrating!==r.id)throw Error('別の祖先が同じ子を統合しています');
      if(!h?.integrating){if(h?.complete||h?.destination)throw Error('子の受領記録が変わりました');this.transfer.save({...h,id:h?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}
    }
    for(const i of r.items){
      if(i.state==='片付け済み')continue;
      const receipt=this.transfer.read(i.project,i.task);
      if(receipt?.integrating!==r.id)throw Error('子の統合予約が変わりました');
      if(!receipt.receiving&&!receipt.complete){
        const current=this.ancestor(r.project,r.task),p=current.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);
        if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:current.p,task:current.t},p,t,current.all))throw Error('途中で子作業・祖先の関係が変わりました');
        const details=this.details(current,p,t,r.id);if(details.blockers.length)throw Error(details.blockers.join(' / '));
        for(const f of i.files)if(snapshot(f.path)!==f.fingerprint)throw Error('成果ファイルが変わりました');
        if(i.state==='待ち'||i.state==='衝突'){
          if(i.copy){
            const merged=this.gitw.merge({dir:i.copy,workRoot:this.removal.workRoot(p),title:`${i.task} ${i.title}`,target:r.target,cleanup:false});
            if(merged.conflict){
              i.state='衝突';this.save(r);
              this.store.updateTask(r.project,r.task,{state:'返事待ち',question:`子作業「${i.title}」を統合する時にぶつかりました。AIを始めて「ブランチ ${i.branch} を統合先 ${r.target} へ取り込み、ぶつかった所を直して保存して」と頼んでから、もう一度［統合…］を押してください`});
              return {ok:false,conflict:true,complete:false,error:merged.error,items:r.items.map(x=>({title:x.title,state:x.state}))};
            }
            if(!merged.ok)throw Error(merged.error);
            i.integrated={dir:r.target,commit:merged.commit,files:merged.files};i.sourceSnapshot=this.gitw.inspect(i.copy);i.sourceHead=i.sourceSnapshot.head;
          }
          i.state='取り込み済み';this.save(r);
        }
      }
      const out=this.transfer.receiveIntegrated({project:i.project,task:i.task,targetProject:r.project,targetTask:r.task,integrating:r.id,files:i.files,integrated:i.integrated,optional:i.optional});
      i.receipt=out.record;i.state='片付け済み';this.save(r);
    }
    r.complete=true;r.error='';this.save(r);
    return {ok:true,complete:true,items:r.items.map(x=>({title:x.title,state:x.state})),parentProject:a.p.id,parent:a.t.id};
  }
  cleanupCopy(receipt){
    const r=this.active?.id===receipt.integrating?this.active:this.read(receipt.targetProject,receipt.targetTask),i=r?.items.find(x=>x.project===receipt.project&&x.task===receipt.task);
    if(!r||r.id!==receipt.integrating||!i)throw Error('統合の片付け記録が見つかりません');
    if(!i.copy||i.copyTrashed)return;
    if(!exists(i.copy)){
      // 移動後に停止しても、退避先とコミットを照合して登録整理を続ける。
      if(!i.copyTrashPlanned||!exists(i.copyTrashPlanned)||!i.sourceHead||!this.gitw.isAncestor(r.target,i.sourceHead))throw Error('作業用コピーの退避先を確認できません');
      noLinks(i.copyTrashPlanned);
      this.gitw.finishCleanupCopy({target:r.target,branch:i.branch,sourceHead:i.sourceHead});
      i.copyTrashed=i.copyTrashPlanned;this.save(r);return;
    }
    const out=this.gitw.cleanupCopy({dir:i.copy,workRoot:path.join(this.store.root,'Work',i.project),target:r.target,expectedSnapshot:i.sourceSnapshot,beforeMove:({trashed,branch,sourceHead})=>{i.copyTrashPlanned=trashed;i.branch=branch;i.sourceHead=sourceHead;this.save(r);}});
    i.copyTrashed=out.trashed;this.save(r);
  }
}
TaskIntegrate.prototype.nativeActive=function(){return this.nativeCount;};
TaskIntegrate.prototype.nativeBusy=function(project,task){
 if(!this.nativeCount||!this.nativeScope)return false;const scope=[{project:this.nativeScope.project,task:this.nativeScope.task},...(this.nativeScope.items||[])];if(scope.some(x=>x.project===project&&(!task||x.task===task)))return true;const p=this.store.readProject(project);if(!p)return false;const canonical=value=>path.resolve(value).toLowerCase(),base=canonical(this.baseOf(p));return scope.some(x=>{const q=this.store.readProject(x.project);return q&&canonical(this.baseOf(q))===base;})||typeof this.nativeScope.target==='string'&&canonical(this.nativeScope.target)===base;
};
TaskIntegrate.prototype.bindNativeMerge=function(i,target){
 const p=this.store.readProject(i.project);if(!p)throw Error('Hierarchy source project is missing');const d={project:i.project,task:i.task,title:i.title,taskHash:i.taskHash,dir:i.copy,workRoot:this.removal.workRoot(p),target};this.nativeContexts.set(key(i),d);return d;
};
TaskIntegrate.prototype.previewAsync=async function(project,task,only) {
 if(process.platform!=='win32')return this.preview(project,task,only);if(this.nativeCount)throw Error('Hierarchy integration is active');this.nativeCount++;this.nativeScope={project,task};
 let base;try{base=this.preview(project,task,only);const entry=this.tokens.get(base.token);this.tokens.delete(base.token);const d=entry.value,grants=new Map();this.nativeScope=d;if(d.resume&&this.read(project,task)?.nativeVersion!==1)throw Error('Legacy hierarchy cleanup requires an explicit manual recovery review');
  for(const i of d.items){if(i.state==='片付け済み'||i.blockers?.length)continue;
   if(!d.resume){const p=this.store.readProject(i.project),t=p?.tasks.find(t=>t.id===i.task);if(!t||t.completionHash!==i.taskHash)throw Error('Hierarchy source changed during native preview');i.nativeCleanup=await this.transfer.planNativeCleanup(p,t,[...i.move,...i.optional]);const scoped=require('./scoped-file'),artifact=require('./scoped-artifact');for(const f of i.files){const root=f.location==='body'?this.baseOf(p):p.dir,relative=path.relative(root,f.path).split(path.sep).join('/');if(!relative||path.isAbsolute(relative)||relative.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Hierarchy artifact is outside its confirmed source');const rootFingerprint=(await scoped.identity(root)).rootFingerprint,value=await artifact.inspect({root,rootFingerprint,path:relative});if(snapshot(f.path)!==f.fingerprint)throw Error('Hierarchy artifact changed during native preview');f.native={root,rootFingerprint,path:relative,sha256:value.sha256,fileFingerprint:value.fileFingerprint};}}
   else this.removal.validateNativeRecord(i.nativeCleanup);
   if(i.copy){this.bindNativeMerge(i,d.target);if(!d.resume||i.state==='待ち'||i.state==='衝突'){const merged=await this.reviewed.previewAsync(i.project,i.task);grants.set(key(i),merged.token);i.gitExecution=merged.gitExecution;}}
  }
  const destinationRoot=path.join(this.store.product,project);d.nativeDestination=d.resume?this.read(project,task).nativeDestination:{root:destinationRoot,rootFingerprint:(await require('./scoped-file').identity(destinationRoot)).rootFingerprint};if(!d.nativeDestination||d.nativeDestination.root!==destinationRoot)throw Error('Missing confirmed hierarchy destination');d.nativeVersion=1;d.nativeGrants=grants;d.targetSnapshot=this.gitw.inspect(d.target);const token=randomUUID();this.tokens.set(token,{at:Date.now(),value:d});return {...d,token,nativeGrants:undefined,items:d.items.map(i=>{const {nativeCleanup,...visible}=i;return {...visible,nativeCleanup:nativeCleanup?{id:nativeCleanup.id,entries:nativeCleanup.entries.map(e=>({from:e.from,to:e.to,objectId:e.native.objectId,treeHash:e.native.treeHash}))}:undefined};}),requiresSkipHooksConfirmation:d.items.some(i=>i.gitExecution?.requiresSkipHooksConfirmation)};
 }catch(error){if(base)this.tokens.delete(base.token);throw error;}finally{this.nativeScope=null;this.nativeCount--;}
};
TaskIntegrate.prototype.applyAsync=async function(input) {
 if(process.platform!=='win32')return this.apply(input);if(this.nativeCount)throw Error('Hierarchy integration is active');const saved=this.tokens.get(input?.token);this.tokens.delete(input?.token);if(!saved||saved.value.nativeVersion!==1||input.confirm!==true||saved.value.project!==input.project||saved.value.task!==input.task||Date.now()<saved.at||Date.now()-saved.at>600000)throw Error('Please preview and confirm this hierarchy integration again');
 this.nativeCount++;const d=saved.value;this.nativeScope=d;try{const a=this.ancestor(input.project,input.task);if(a.t.completionHash!==d.ancestorHash||JSON.stringify(this.gitw.inspect(a.target))!==JSON.stringify(d.targetSnapshot))throw Error('Hierarchy ancestor or target changed since preview');}catch(error){this.nativeScope=null;this.nativeCount--;throw error;}
 const privateToken=randomUUID(),originalRun=this.run,originalSave=this.save;let r;this.tokens.set(privateToken,{at:saved.at,value:d});this.run=value=>value;
 this.save=value=>{if(!value.nativeVersion){value.nativeVersion=1;value.nativeDestination=d.nativeDestination;for(const i of value.items){const original=d.items.find(x=>key(x)===key(i)),paths=new Set([...i.move,...original.optional.filter(x=>i.optional.includes(x.id))].map(x=>x.path));i.nativeCleanup={...i.nativeCleanup,entries:i.nativeCleanup.entries.filter(e=>paths.has(e.from))};}}return originalSave.call(this,value);};
 try{r=this.apply({...input,token:privateToken});}catch(error){this.nativeScope=null;this.nativeCount--;throw error;}finally{this.run=originalRun;this.save=originalSave;this.tokens.delete(privateToken);}
 this.active=r;try{return await this.runAsync(r,d.nativeGrants,input.skipHooks===true);}catch(error){r.error=error.message;this.save(r);throw error;}finally{this.active=null;this.nativeScope=null;this.nativeCount--;}
};
TaskIntegrate.prototype.runAsync=async function(r,grants,skipHooks) {
 this.validate(r);if(r.nativeVersion!==1)throw Error('Missing native hierarchy authority');const a=this.ancestor(r.project,r.task);
 for(const i of r.items){if(i.state==='片付け済み')continue;const receipt=this.transfer.read(i.project,i.task);if(receipt?.integrating&&receipt.integrating!==r.id)throw Error('Another ancestor reserved this child');if(!receipt?.integrating){if(receipt?.complete||receipt?.destination)throw Error('Child receipt changed');this.transfer.save({...receipt,id:receipt?.id||randomUUID(),project:i.project,task:i.task,title:i.title,integrating:r.id});}}
 // Merge all confirmed sources first. Receipt notifications alter Product
 // metadata, so they run only after the complete Git target receipt chain.
 for(const i of r.items){if(i.state==='片付け済み')continue;const receipt=this.transfer.read(i.project,i.task);if(receipt?.integrating!==r.id)throw Error('Hierarchy child reservation changed');if(i.copy)this.bindNativeMerge(i,r.target);
  if(i.state==='取り込み済み'){if(i.copy){const merged=this.reviewed.read(i.project,i.task);if(!merged||merged.id!==i.mergeRecordId||merged.commit!==i.integrated?.commit||!this.reviewed.proof(merged))throw Error('Existing hierarchy merge evidence changed');}continue;}
  if(receipt.receiving||receipt.complete)throw Error('Receipt preceded verified hierarchy merge');const current=this.ancestor(r.project,r.task),p=current.all.find(p=>p.id===i.project),t=p?.tasks.find(t=>t.id===i.task);if(!t||t.completionHash!==i.taskHash||!graph.canIntegrate({project:current.p,task:current.t},p,t,current.all))throw Error('Hierarchy source relationship changed');const details=this.details(current,p,t,r.id);if(details.blockers.length)throw Error(details.blockers.join(' / '));for(const f of i.files)if(snapshot(f.path)!==f.fingerprint)throw Error('Hierarchy artifact changed');
  if(i.copy){const token=grants?.get(key(i));if(!token)throw Error('Missing fresh confirmed hierarchy merge preview');const merged=await this.reviewed.applyAsync({project:i.project,task:i.task,token,confirm:true,skipHooks});if(merged.conflict){i.state='衝突';this.save(r);this.store.updateTask(r.project,r.task,{state:'返事待ち',question:`子作業「${i.title}」の Git 合併が衝突しました。保存されたブランチと統合先で解決し、もう一度［統合…］から確認してください`});return {ok:false,conflict:true,complete:false,error:merged.error,items:r.items.map(x=>({title:x.title,state:x.state}))};}if(!merged.ok||!merged.merged)throw Error(merged.error||'Hierarchy merge has no complete merge evidence');i.mergeRecordId=merged.recordId;i.integrated={dir:r.target,commit:merged.commit,files:merged.files};i.sourceHead=merged.sourceHead;i.sourceSnapshot=this.gitw.inspect(i.copy);
   for(const next of r.items){if(key(next)===key(i)||!next.copy||!['待ち','衝突'].includes(next.state))continue;const pending=grants?.get(key(next));if(pending)this.reviewed.advanceTarget(pending,merged.recordId);}
  }
  i.state='取り込み済み';this.save(r);
 }
 for(const i of r.items){if(i.state==='片付け済み')continue;if(i.state!=='取り込み済み')throw Error('Hierarchy merge phase is incomplete');const out=await this.transfer.receiveIntegratedAsync({project:i.project,task:i.task,targetProject:r.project,targetTask:r.task,integrating:r.id,files:i.files,integrated:i.integrated,optional:i.optional,nativeCleanup:i.nativeCleanup,nativeDestination:r.nativeDestination});const receipt=this.transfer.read(i.project,i.task);if(!out.ok||receipt?.complete!==true||receipt.integrating!==r.id)throw Error('Hierarchy receive/cleanup is incomplete');i.receipt=out.record;i.state='片付け済み';this.save(r);}
 r.complete=true;r.error='';this.save(r);return {ok:true,complete:true,items:r.items.map(x=>({title:x.title,state:x.state})),parentProject:a.p.id,parent:a.t.id};
};
TaskIntegrate.prototype.cleanupCopyAsync=async function(receipt) {
 const r=this.active?.id===receipt.integrating?this.active:this.read(receipt.targetProject,receipt.targetTask),i=r?.items.find(x=>x.project===receipt.project&&x.task===receipt.task);if(!r||r.nativeVersion!==1||r.id!==receipt.integrating||!i)throw Error('Native hierarchy cleanup record is missing');if(!i.copy)return;this.bindNativeMerge(i,r.target);const record=this.reviewed.read(i.project,i.task);if(!record||record.id!==i.mergeRecordId||record.commit!==i.integrated?.commit)throw Error('Native hierarchy copy receipt changed');const out=await this.reviewed.cleanupAsync(i.project,i.task,{confirmedResume:this.active?.id===r.id});if(!out.ok||out.state!=='complete'||!out.trashed)throw Error(out.error||'Hierarchy copy cleanup needs recovery review');i.copyTrashed=out.trashed;this.save(r);
};
TaskIntegrate.prototype.verifyCompletedAsync=async function(r) {
 this.validate(r);if(r.nativeVersion!==1||!r.complete)throw Error('Hierarchy has no complete native evidence');const artifact=require('./scoped-artifact'),rooted=require('./rooted-move');
 for(const i of r.items){const receipt=this.transfer.read(i.project,i.task);if(!receipt?.complete||receipt.integrating!==r.id||receipt.targetProject!==r.project||receipt.targetTask!==r.task||receipt.cleanup!==i.receipt||receipt.cleanup!==i.nativeCleanup.id||!receipt.nativeDestination)throw Error('Completed hierarchy receive evidence changed');const cleanup=this.removal.nativeRecord(receipt.cleanup);for(const e of cleanup.entries){this.transfer.assertNativeCleanupEntry(receipt,cleanup,e);if(!e.moved||e.moving||e.restored||e.restoring||(await rooted.recover(e.native)).state!=='complete')throw Error('Completed hierarchy cleanup evidence changed');}
  for(const f of receipt.files){if(!f.copyReceipt)throw Error('Missing completed hierarchy artifact evidence');const relative=path.relative(receipt.nativeDestination.root,f.to).split(path.sep).join('/'),current=await artifact.inspect({root:receipt.nativeDestination.root,rootFingerprint:receipt.nativeDestination.rootFingerprint,path:relative});if(current.sha256!==f.digest||current.sha256!==f.copyReceipt.sha256||current.fileFingerprint!==f.copyReceipt.fileFingerprint)throw Error('Completed hierarchy artifact changed');}
  if(i.copy){this.bindNativeMerge(i,r.target);const merged=await this.reviewed.receiptAsync(i.project,i.task);if(!merged||merged.recordId!==i.mergeRecordId||merged.trashed!==i.copyTrashed)throw Error('Completed hierarchy Work receipt changed');}
 }
 return true;
};
TaskIntegrate.prototype.pendingAsync=async function() {
 if(process.platform!=='win32')return this.pending();if(!exists(this.dir))return [];noLinks(this.dir);const names=fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));if(names.length>10000)throw Error('Hierarchy journal exceeds the review limit');const pending=[];
 for(const name of names){const file=path.join(this.dir,name),r=this.validate(journal.read(file));if(this.file(r.project,r.task)!==file)throw Error('Hierarchy record identity mismatch');if(r.complete)await this.verifyCompletedAsync(r);else pending.push({project:r.project,task:r.task,id:r.id,items:r.items.map(x=>({project:x.project,task:x.task,title:x.title,state:x.state}))});}
 return pending;
};
module.exports={TaskIntegrate};
