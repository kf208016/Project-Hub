'use strict';
// 成果の保存→短い受領通知→専用管理記録の退避。各段階を保存して再実行する。
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const chat = require('./chat');
const { taskTarget, integrators, canIntegrate } = require('../public/project-order');
const { snapshot, noLinks, inside, exists } = require('./remove');
const hash = text => createHash('sha256').update(text).digest('hex');
const journal=require('./local-journal'),artifact=require('./scoped-artifact'),nativeFiles=require('./scoped-file');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,DIGEST=/^[a-f0-9]{64}$/;
const RECORD_KEYS=new Set('id project task title taskHash targetProject targetTask targetName targetHash handedUp receiving integrating destination files integrated move cleanupVersion optional notified complete cleanup nativeDestination nativeCleanup error'.split(' '));
const canonical=x=>process.platform==='win32'?path.resolve(x).toLowerCase():path.resolve(x);
const FINAL_CHECK = '成果を確認し、GitHubへの更新やソフト・ホームページの本番適用が必要な場合は、対象・変更内容・検証結果を整理して人に最終確認する。引渡しだけでpush・公開・本番適用は行わない。';
class TaskTransfer {
  constructor({ store, removal, baseOf = p => p.dir, integration = () => null, notify = () => {}, beforeCleanup = () => {}, now=Date.now }) {
    Object.assign(this, { store, removal, baseOf, integration, notify, beforeCleanup }); this.tokens = new Map();
    this.dir = path.join(store.root, '_hub/task-handoffs');
    this.now=now;this.nativeOperations=new Map();
  }
  file(project, task) { for(const x of [project,task])if(typeof x!=='string'||!x||/[\\/\0]|^\.{1,2}$/.test(x))throw Error('引渡し作業識別が不正です');return path.join(this.dir, hash(project + '\0' + task) + '.json'); }
  validate(r){
    if(!r||typeof r!=='object'||Array.isArray(r)||!UUID.test(r.id)||Object.keys(r).some(k=>!RECORD_KEYS.has(k)))throw Error('引渡し記録の型別・識別が不正です');this.file(r.project,r.task);
    for(const k of ['complete','notified','handedUp','receiving'])if(r[k]!==undefined&&typeof r[k]!=='boolean')throw Error('引渡し記録の状態型別が不正です');
    if(r.integrating!==undefined&&!UUID.test(r.integrating))throw Error('引渡し統合識別が不正です');
    if(r.destination){this.file(r.targetProject,r.targetTask);const expected=path.join(this.store.product,r.targetProject,'成果物','受取',r.id);if(typeof r.destination!=='string'||canonical(r.destination)!==canonical(expected))throw Error('受領先が確認範囲の外です');noLinks(r.destination);}
    if(r.files!==undefined){if(!Array.isArray(r.files)||r.files.length>500)throw Error('成果ファイル記録が不正です');for(const f of r.files){if(!f||typeof f.path!=='string'||!path.isAbsolute(f.path)||typeof f.relative!=='string'||path.isAbsolute(f.relative)||f.relative.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))||!['project','body'].includes(f.location)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>64*1024*1024||!DIGEST.test(f.fingerprint))throw Error('成果ファイル記録の型別・範囲が不正です');noLinks(f.path);if(f.digest!==undefined&&!DIGEST.test(f.digest))throw Error('成果ダイジェストが不正です');if(f.to&&(typeof f.to!=='string'||!r.destination||canonical(f.to)!==canonical(path.join(r.destination,f.location,f.relative))))throw Error('成果ファイルの受領先が不正です');if(f.native&&(!DIGEST.test(f.native.rootFingerprint)||!DIGEST.test(f.native.sha256)||!DIGEST.test(f.native.fileFingerprint)||typeof f.native.root!=='string'||typeof f.native.path!=='string'||canonical(path.resolve(f.native.root,f.native.path))!==canonical(f.path)))throw Error('成果の native source binding が不正です');if(f.copyReceipt&&(!DIGEST.test(f.copyReceipt.sha256)||!DIGEST.test(f.copyReceipt.fileFingerprint)))throw Error('成果の native copy receipt が不正です');}}
    if(r.move!==undefined&&(!Array.isArray(r.move)||r.move.some(x=>!x||typeof x.path!=='string'||!path.isAbsolute(x.path))))throw Error('引渡し管理範囲が不正です');
    if(r.files&&r.files.reduce((sum,x)=>sum+x.bytes,0)>64*1024*1024||r.optional!==undefined&&(!Array.isArray(r.optional)||r.optional.some(x=>typeof x!=='string'))||r.cleanup!==undefined&&!UUID.test(r.cleanup)||r.cleanupVersion!==undefined&&r.cleanupVersion!==2||r.error!==undefined&&typeof r.error!=='string')throw Error('引渡し範囲・状態が不正です');
    if(r.nativeDestination){const n=r.nativeDestination;if(typeof n.root!=='string'||!DIGEST.test(n.rootFingerprint)||canonical(n.root)!==canonical(path.join(this.store.product,r.targetProject)))throw Error('native受領先が別プロジェクトです');noLinks(n.root);}
    if(r.nativeCleanup){this.removal.validateNativeRecord(r.nativeCleanup);if(r.nativeCleanup.project!==r.project||r.nativeCleanup.task!==r.task)throw Error('native清理計畫跨作業');}
    return r;
  }
  read(project, task) {const r=journal.read(this.file(project,task));if(!r)return null;this.validate(r);if(r.project!==project||r.task!==task)throw Error('引渡し記録の跨檔識別が不正です');return r;}
  save(r) {this.validate(r);journal.save(this.file(r.project,r.task),r);}
  pending() {
    if (!exists(this.dir)) return []; noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).flatMap(n => {
      try { const f=path.join(this.dir,n); noLinks(f); const r=this.validate(journal.read(f));if(canonical(this.file(r.project,r.task))!==canonical(f))throw Error('引渡し記錄跨檔識別不符');
        return r.complete || r.handedUp && !r.receiving || r.integrating ? [] : [{project:r.project,task:r.task,title:r.title,targetProject:r.targetProject,targetTask:r.targetTask}];
      } catch(error) {if(process.platform==='win32')throw error;return []; } // Windows writes fail closed when the record scope is unknown.
    });
  }
  expectTitle(project, task, expected, receipt) {
    if (expected === undefined) return;
    const file = this.store.taskFile(project, task), title = file ? this.store.readTask(file).title : receipt?.title;
    if (title !== undefined && title !== expected) throw Error(`この結果の子作業はもうありません（同じ番号の別の作業「${title}」があります）`);
  }
  offers() {
    if(!exists(this.dir))return [];noLinks(this.dir);
    return fs.readdirSync(this.dir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).flatMap(n=>{try{const f=path.join(this.dir,n);noLinks(f);const r=this.validate(journal.read(f));if(canonical(this.file(r.project,r.task))!==canonical(f))throw Error('引渡し記錄跨檔識別不符');return r.handedUp&&!r.complete?[{project:r.project,task:r.task,title:r.title,integrating:r.integrating}]:[];}catch(error){if(process.platform==='win32')throw error;return [];}});
  }
  context(project, task, options = {}) {
    const all = this.store.listProjects(), p = all.find(x => x.id === project), t = p?.tasks.find(x => x.id === task);
    if (!t) throw Error(this.read(project,task)?.complete
      ? 'この子作業はもう受け取って片付けてあります。受け取った成果は本作業の会話と［ファイルを見る］で確認できます。'
      : 'この子作業は今はありません（片付けたか、名前を変えた可能性があります）');
    const target = options.targetTask ? { project: all.find(x=>x.id===options.targetProject) } : options.offer ? integrators(p,t,all)[0] || taskTarget(p,t,all) : taskTarget(p, t, all);
    if (options.targetTask && target.project) target.task = target.project.tasks.find(x=>x.id===options.targetTask);
    if (!target?.task) throw Error('この作業には本作業・派生元がありません');
    if (options.integrating && !canIntegrate(target,p,t,all)) throw Error('この祖先は未完の中間親を越えて統合できません');
    if (t.kind === 'derived' && !require('./work-context').sourceOf(p,t.derivedFrom,all)) throw Error('派生元が同じ大きなプロジェクト内にありません');
    if (!options.integrating && !options.offer && target.task.state === '完了') throw Error(`本作業「${target.task.title}」を再開してから渡してください`);
    const d = this.removal.describe(project, task);
    if (options.integrating || options.offer) d.blockers = d.blockers.filter(x=>!x.startsWith('作業用コピー') && !(options.offer && x.startsWith('下の作業や')));
    if (this.removal.busy(target.project.id, target.task.id) || this.removal.locked(target.project.id)) d.blockers.push('本作業でAI・整理・確認が動いています。終わってから渡してください');
    if (!(t.state === '完了' || t.completionPending || t.steps.length && t.steps.every(x => x.done)) || t.question) d.blockers.push('子作業の手順・質問が残っています。済ませてから渡してください');
    if (!options.integrating && !options.offer && t.workdir && path.resolve(t.workdir) !== path.resolve(this.baseOf(p))) d.blockers.push('作業場所の記録が残っています。先に［本体に取り込む］または［記録を片付ける］を行ってください');
    if (!options.offer && all.some(q => q.tasks.some(x => !(q.id === p.id && x.id === t.id) && (() => { const src = taskTarget(q, x, all); return src?.project.id === p.id && src.task.id === t.id; })()))) d.blockers.push('この作業に子作業・派生が残っています。先にそちらを渡してください');
    if ((options.integrating || options.offer) && t.mergeExcluded) d.blockers.push('取り込み対象から外されています');
    return { p, t, target, d };
  }
  artifacts(p, t, paths = []) {
    const out = new Map(); let bytes = 0;
    const add = (relative, location = 'project') => {
      if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => !x || x === '..' || x.startsWith('.')) || /[\0\r\n]/.test(relative)) throw Error('成果ファイルはプロジェクト・本体内の相対パスで指定してください（隠しファイルは対象外）');
      const parts = relative.split('/');
      if (['作業','成果物','attachments'].includes(parts[0]) && p.tasks.some(x => x.id !== t.id && x.id === parts[1])) throw Error('他の作業の専用フォルダは渡せません');
      const base = location === 'body' ? this.baseOf(p) : p.dir, f = path.resolve(base, relative);
      if (!inside(path.resolve(base), f)) throw Error('成果ファイルの場所が不正です'); noLinks(f);
      const st = fs.statSync(f); if (!st.isFile()) throw Error('成果はファイルごとに指定してください');
      const id = location + ':' + relative; if (out.has(id)) return;
      bytes += st.size; if (out.size >= 500 || bytes > 64 * 1024 * 1024) throw Error('成果の確認は500ファイル・64MB以内に分けてください');
      out.set(id, { id, path: f, relative, location, bytes: st.size, fingerprint: snapshot(f) });
    };
    const walk = (dir, rel) => {
      if (!exists(dir)) return; noLinks(dir);
      for (const name of fs.readdirSync(dir).sort()) {
        if (name.startsWith('.') || rel === '成果物' && name === '受取') continue;
        const next = path.join(dir, name), relative = rel + '/' + name; noLinks(next);
        if (fs.statSync(next).isDirectory()) { if (p.tasks.some(x => x.id !== t.id && x.id === name)) continue; walk(next, relative); }
        else add(relative);
      }
    };
    // 自動候補は当該作業の専用領域と直下の資料だけ。他の資料庫は明示指定する。
    for (const rel of ['作業','成果物']) {
      const dir = path.join(p.dir, rel);
      if (!exists(dir)) continue; noLinks(dir);
      for (const name of fs.readdirSync(dir).sort()) {
        if (name.startsWith('.') || name === '受取') continue;
        const f = path.join(dir, name); noLinks(f);
        if (fs.statSync(f).isDirectory()) { if (name === t.id) walk(f, rel + '/' + name); }
        else add(rel + '/' + name);
      }
    }
    walk(path.join(p.dir, 'attachments', t.id), 'attachments/' + t.id);
    if (!Array.isArray(paths) || paths.length > 500) throw Error('成果ファイルの指定を確認してください');
    for (const input of paths) {
      if (typeof input !== 'string') throw Error('成果ファイルのパスは文字列で指定してください');
      const location = input.startsWith('body:') ? 'body' : 'project';
      add(input.replace(/^(body|project):/, ''), location);
    }
    return [...out.values()];
  }
  preview(project, task, paths = [], expectTitle) {
    const pending = this.read(project, task);
    this.expectTitle(project,task,expectTitle,pending);
    if (pending && !pending.complete) return { token: this.token({ pending: pending.id,recordHash:hash(JSON.stringify(pending)), project, task }), title: pending.title, target: pending.targetName, files: pending.files, blockers: [], resume: true, destination: pending.destination, guidance: FINAL_CHECK };
    const { p, t, target, d } = this.context(project, task);
    if (pending?.complete) throw Error('引渡し済みの作業が復元されています。受け取った成果を確認し、削除は［削除…］から行ってください');
    let files = []; try { files = this.artifacts(p, t, paths); } catch (e) { d.blockers.push(e.message); }
    const integrated = this.integration(p, t);
    if (!files.length && !integrated?.files?.length) d.blockers.push('成果ファイルがありません。渡すファイルの相対パスを指定してください。会話だけでは引渡し済みにしません');
    const result = { project, task, title: t.title, target: `${target.project.name}／${target.task.title}`, targetProject: target.project.id, targetTask: target.task.id, taskHash: t.completionHash, targetHash: target.task.completionHash, files, integrated, blockers: [...new Set(d.blockers)], move: d.move, keep: [...d.keep, ...d.optional].map(x => ({path:x.path, why:x.why || '成果の元ファイルは残します'})), guidance: FINAL_CHECK };
    return { ...result, token: this.token(result) };
  }
  token(value) {const at=this.now();for (const [id, x] of this.tokens) if (at<x.at||at-x.at>600000) this.tokens.delete(id);if(this.tokens.size>=128)throw Error('引渡し預覽過多');const token = randomUUID();this.tokens.set(token,{at,value});return token;}
  nativeActive(){return this.nativeOperations.size;}
  nativeBusy(project,task){return [...this.nativeOperations.values()].some(x=>[x.project,x.targetProject].includes(project)&&(!task||[x.task,x.targetTask].includes(task)));}
  async previewAsync(project,task,paths=[],expectTitle){return this.nativePreview('preview',project,task,paths,expectTitle);}
  async offerPreviewAsync(project,task,paths=[],expectTitle){return this.nativePreview('offerPreview',project,task,paths,expectTitle);}
  async nativePreview(method,project,task,paths,expectTitle){
    const out=this[method](project,task,paths,expectTitle),entry=this.tokens.get(out.token);this.tokens.delete(out.token);
    const old=out.resume?this.read(project,task):null,p=this.store.readProject(project),targetProject=entry.value.targetProject||old?.targetProject,sourceProject=p?.dir||path.join(this.store.product,project),targetRoot=path.join(this.store.product,targetProject||project),operation=randomUUID();
    if(this.nativeBusy(project,task)||this.nativeBusy(targetProject))throw Error('引渡しが実行中です');this.nativeOperations.set(operation,{project,task,targetProject,targetTask:entry.value.targetTask||old?.targetTask});
    try{const nativeDestination={root:targetRoot,rootFingerprint:(await nativeFiles.identity(targetRoot)).rootFingerprint},native=[];
      for(const f of out.files||[]){let root=f.location==='body'?this.baseOf(p):sourceProject;noLinks(root);const relative=path.relative(root,f.path).split(path.sep).join('/');if(canonical(path.resolve(root,relative))!==canonical(f.path)||!relative||relative.startsWith('../')||path.isAbsolute(relative))throw Error('成果來源不屬於確認專案');
        if(out.resume&&f.to&&exists(f.to)){const received=await artifact.inspect({root:nativeDestination.root,rootFingerprint:nativeDestination.rootFingerprint,path:path.relative(targetRoot,f.to).split(path.sep).join('/')});if(received.sha256!==f.digest)throw Error('受領済みの成果が変更されています');native.push({id:f.id,native:f.native||null,copyReceipt:{sha256:received.sha256,fileFingerprint:received.fileFingerprint}});continue;}
        const rootFingerprint=(await nativeFiles.identity(root)).rootFingerprint,value=await artifact.inspect({root,rootFingerprint,path:relative});if(snapshot(f.path)!==f.fingerprint)throw Error('預覽中成果檔案已變更');native.push({id:f.id,native:{root,rootFingerprint,path:relative,sha256:value.sha256,fileFingerprint:value.fileFingerprint}});
      }
      if(old&&hash(JSON.stringify(this.read(project,task)))!==hash(JSON.stringify(old)))throw Error('預覽中引渡し記錄已變更');
      if(!old){const c=this.context(project,task,{offer:method==='offerPreview'});if(c.t.completionHash!==entry.value.taskHash||c.target.project.id!==targetProject||c.target.task.id!==entry.value.targetTask)throw Error('預覽中作業關係已變更');}
      let nativeCleanup=old?.nativeCleanup||null;
      if(method!=='offerPreview'&&!nativeCleanup){if(old?.cleanup)throw Error('Legacy cleanup requires a fresh reviewed native recovery plan');const c=this.context(project,task);nativeCleanup=await this.planNativeCleanup(c.p,c.t,[...c.d.move,...c.d.optional]);}
      const value={...entry.value,targetProject,targetTask:entry.value.targetTask||old?.targetTask,nativeFiles:native,nativeDestination,nativeCleanup},token=this.token(value);return {...out,token,nativeFiles:native.map(x=>({id:x.id,sha256:x.native?.sha256||x.copyReceipt?.sha256})),nativeCleanup:nativeCleanup?{id:nativeCleanup.id,entries:nativeCleanup.entries.map(e=>({from:e.from,to:e.to,objectId:e.native.objectId,treeHash:e.native.treeHash}))}:null,guidance:FINAL_CHECK};
    }finally{this.nativeOperations.delete(operation);}
  }
  async applyAsync(input){return this.nativeApply('apply',input);}
  async offerAsync(input){return this.nativeApply('offer',input);}
  async receiveIntegratedAsync(input){return this.nativeApply('receiveIntegrated',input);}
  async planNativeCleanup(p,t,moves){const id=randomUUID(),dest=path.join(this.removal.trash,'ProjectHub 引渡し '+id),taskFile=this.store.taskFile(p.id,t.id);return this.removal.planNativeEntries({id,project:p.id,task:t.id,title:t.title,entries:moves.slice().sort((a,b)=>Number(a.path===taskFile)-Number(b.path===taskFile)).map(x=>({from:x.path,to:path.join(dest,path.relative(this.store.root,x.path)),fingerprint:x.fingerprint}))});}
  async nativeApply(method,input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('引渡し確認格式無效');let grant=null,coreInput=input;
    if(method!=='receiveIntegrated'){
      const x=this.tokens.get(input.token);this.tokens.delete(input.token);const at=this.now();if(!x||input.confirm!==true||input.project!==x.value.project||input.task!==x.value.task||at<x.at||at-x.at>600000||!Array.isArray(x.value.nativeFiles)||!x.value.nativeDestination)throw Error('請重新預覽並明確確認本次引渡し');grant=x.value;
      if(grant.pending&&hash(JSON.stringify(this.read(input.project,input.task)))!==grant.recordHash)throw Error('引渡し恢復記錄已變更，請重新預覽');
      const privateToken=randomUUID();this.tokens.set(privateToken,{at:Date.now(),value:grant});coreInput={...input,token:privateToken};
    }
    const project=input.project,task=input.task,operation=randomUUID();if(this.nativeBusy(project,task)||this.nativeBusy(grant?.targetProject||input.targetProject))throw Error('其他引渡し仍在執行');this.nativeOperations.set(operation,{project,task,targetProject:grant?.targetProject||input.targetProject,targetTask:grant?.targetTask||input.targetTask});
    let planned=null,initial;const continuation=this.continue,prior=method==='receiveIntegrated'?this.read(project,task):null;
    try{
      // Capture the synchronous plan after its durable journal save; no file
      // copy or cleanup happens until the owned native broker returns.
      this.continue=r=>{planned=r;};try{initial=this[method](coreInput);}finally{this.continue=continuation;if(coreInput!==input)this.tokens.delete(coreInput.token);}
      if(!planned){const saved=this.read(project,task);if(saved?.complete){if(!saved.nativeCleanup||!saved.cleanup||saved.cleanup!==saved.nativeCleanup.id)throw Error('缺少完整native接收／清理收據');await this.copyNative(saved);const cleaned=await this.removal.cleanupRecordAsync(saved.cleanup,{beforeEntry:(record,e)=>this.assertNativeCleanupEntry(saved,record,e)});if(!cleaned.ok)throw Error('已完成接收的native清理證據已變更');return initial;}if(method==='offer'&&grant){if(saved&&!saved.complete){saved.nativeDestination=grant.nativeDestination;for(const f of saved.files){const binding=grant.nativeFiles.find(x=>x.id===f.id);if(!binding?.native)throw Error('Offer缺少確認前native成果來源');f.native=binding.native;}this.save(saved);}}return initial;}
      if(grant){planned.nativeDestination=grant.nativeDestination;if(!planned.nativeCleanup&&grant.nativeCleanup)planned.nativeCleanup={...grant.nativeCleanup,entries:grant.nativeCleanup.entries.filter(e=>planned.move.some(m=>canonical(m.path)===canonical(e.from)&&m.fingerprint===e.fingerprint))};for(const f of planned.files){const bound=grant.nativeFiles.find(x=>x.id===f.id);if(!bound)throw Error('成果缺少 native preview binding');if(bound.native)f.native=bound.native;if(bound.copyReceipt)f.copyReceipt=bound.copyReceipt;}}
      else{const targetRoot=path.join(this.store.product,planned.targetProject);planned.nativeDestination=planned.nativeDestination||input.nativeDestination||prior?.nativeDestination;if(!planned.nativeDestination||canonical(planned.nativeDestination.root)!==canonical(targetRoot)||!DIGEST.test(planned.nativeDestination.rootFingerprint))throw Error('統合缺少確認前受領RootFileID');const p=this.store.readProject(project);for(const f of planned.files){if(f.to&&exists(f.to))continue;const root=f.location==='body'?this.baseOf(p):p.dir,relative=path.relative(root,f.path).split(path.sep).join('/');if(!f.native||canonical(f.native.root)!==canonical(root)||f.native.path!==relative)throw Error('統合缺少確認前native成果來源');const value=await artifact.inspect({root,rootFingerprint:f.native.rootFingerprint,path:relative});if(value.sha256!==f.digest||value.sha256!==f.native.sha256||value.fileFingerprint!==f.native.fileFingerprint||snapshot(f.path)!==f.fingerprint)throw Error('統合後成果來源已變更');}}
      if(!planned.nativeCleanup&&input.nativeCleanup)planned.nativeCleanup=input.nativeCleanup;
      if(!planned.nativeCleanup)throw Error('缺少使用者預覽前建立的 native清理計畫，未清理管理記錄');this.removal.validateNativeRecord(planned.nativeCleanup);if(planned.nativeCleanup.project!==project||planned.nativeCleanup.task!==task||planned.move.some(m=>!planned.nativeCleanup.entries.some(e=>e.from===m.path&&e.fingerprint===m.fingerprint))||planned.nativeCleanup.entries.some(e=>!planned.move.some(m=>m.path===e.from&&m.fingerprint===e.fingerprint)))throw Error('native清理計畫與已核准管理範圍不同');
      this.save(planned);await this.copyNative(planned);await this.continueAsync(planned,continuation);return this.result(planned);
    }finally{this.continue=continuation;this.nativeOperations.delete(operation);}
  }
  async copyNative(r){
    const dest=r.nativeDestination;for(const f of r.files){const relative=path.relative(dest.root,f.to).split(path.sep).join('/');if(exists(f.to)){const current=await artifact.inspect({root:dest.root,rootFingerprint:dest.rootFingerprint,path:relative});if(current.sha256!==f.digest||f.copyReceipt&&current.fileFingerprint!==f.copyReceipt.fileFingerprint)throw Error('受領成果或FileID已變更，未覆寫');f.copyReceipt={sha256:current.sha256,fileFingerprint:current.fileFingerprint};f.copyState='copied';this.save(r);continue;}
      if(r.notified||!f.native||snapshot(f.path)!==f.fingerprint)throw Error('成果來源已變更或通知後遺失，管理記錄保留');const source=await artifact.inspect({root:f.native.root,rootFingerprint:f.native.rootFingerprint,path:f.native.path});if(source.sha256!==f.native.sha256||source.fileFingerprint!==f.native.fileFingerprint||source.sha256!==f.digest)throw Error('成果來源native hash/FileID已變更');f.copyState='copying';this.save(r);const copied=await artifact.copy({sourceRoot:f.native.root,sourceRootFingerprint:f.native.rootFingerprint,sourcePath:f.native.path,sourceHash:f.digest,sourceFingerprint:f.native.fileFingerprint,root:dest.root,rootFingerprint:dest.rootFingerprint,path:relative});f.copyReceipt={sha256:copied.sha256,fileFingerprint:copied.fileFingerprint};f.copyState='copied';this.save(r);
    }
  }
  async continueAsync(r,continuation=this.continue){
    const hook=this.beforeCleanup,PAUSE=Symbol('native-cleanup-boundary');let paused=false;this.beforeCleanup=()=>{paused=true;throw PAUSE;};
    try{try{continuation.call(this,r);}catch(error){if(error!==PAUSE)throw error;}}finally{this.beforeCleanup=hook;}
    if(paused){await hook(r);if(!r.nativeCleanup)throw Error('缺少已核准 native清理計畫');if(!r.cleanup){this.removal.save(r.nativeCleanup);r.cleanup=r.nativeCleanup.id;this.save(r);}const result=await this.removal.cleanupRecordAsync(r.cleanup,{beforeEntry:(record,e)=>this.assertNativeCleanupEntry(r,record,e)});if(!result.ok)throw Error('native清理未完成：'+result.failed.map(e=>e.why).join(' / '));r.complete=true;this.save(r);}
  }
  assertNativeCleanupEntry(r,record,e){
    if(record.id!==r.nativeCleanup?.id||record.project!==r.project||record.task!==r.task)throw Error('native清理記錄與已核准接收作業不符');const root=path.join(this.store.product,r.project),allowed=[path.join(root,'.ai/tasks',r.task+'.md'),path.join(root,'.ai/work',r.task),...['.jsonl','.json','.queue.json','.rules.md'].map(ext=>path.join(root,'.ai/chat',r.task+ext)),...(r.optional||[]).filter(x=>x==='作業/'+r.task||x==='attachments/'+r.task).map(x=>path.join(root,x))],handoff=path.dirname(e.from)===path.join(root,'.ai/handoff')&&path.basename(e.from).startsWith(r.task+'-')&&/^\d{8}-\d{6}-(claude|codex|agy)\.md$/.test(path.basename(e.from).slice(r.task.length+1));
    if(!allowed.includes(e.from)&&!handoff||!inside(path.resolve(this.removal.trash),e.to)||e.restored)throw Error('片付け記録の場所・復元状態を確認してください');noLinks(e.from);noLinks(e.to);if(e.moved){if(exists(e.from))throw Error('元の管理記録が復元されています。上書きしません');return;}
    if(e.from===path.join(root,'.ai/work',r.task)||(r.optional||[]).some(x=>e.from===path.join(root,x))||handoff){const p=this.store.readProject(r.project),t=p?.tasks.find(x=>x.id===r.task);if(!t||this.removal.referenced(e.from,p,t,this.store.listProjects()))throw Error('他の記録から参照されているため専用フォルダ・引継ぎ資料を残します');}
  }
  offerPreview(project, task, paths = [], expectTitle) {
    const r=this.read(project,task); this.expectTitle(project,task,expectTitle,r);
    if (r && !r.complete && !r.handedUp && !r.integrating) return this.preview(project,task,paths,expectTitle);
    if (r?.complete) return this.preview(project,task,paths,expectTitle);
    if (r?.integrating) throw Error('祖先の統合が進行中です。祖先側で続きを行ってください');
    const {p,t,target,d}=this.context(project,task,{offer:true});
    let files=[];try { files=this.artifacts(p,t,paths); }catch(e){d.blockers.push(e.message);}
    const code=Boolean(t.workdir && path.resolve(t.workdir)!==path.resolve(this.baseOf(p))) || this.integration(p,t);
    if (!files.length && !code) d.blockers.push('成果ファイルがありません。渡すファイルを指定してください');
    const value={project,task,title:t.title,taskHash:t.completionHash,targetProject:target.project.id,targetTask:target.task.id,target:`${target.project.name}／${target.task.title}`,files,blockers:d.blockers,offer:true,hasCode:Boolean(code),selected:r?.files?.map(f=>f.id) || files.map(f=>f.id),guidance:FINAL_CHECK};
    return {...value,token:this.token(value)};
  }
  offer(b) {
    const x=this.tokens.get(b.token);
    if (!x?.value.offer) return this.apply(b); // 旧版で保存された途中の受領だけ再開。
    const d=x.value;
    if (Date.now()-x.at>600000 || b.confirm!==true || b.project!==d.project || b.task!==d.task) throw Error('もう一度引渡し内容を確認してください');
    this.expectTitle(b.project,b.task,b.expectTitle);
    const old=this.read(b.project,b.task);if(old?.integrating || old?.complete)throw Error('統合・受領記録が変わりました');
    const {t,target,d:now}=this.context(b.project,b.task,{offer:true});
    if(now.blockers.length)throw Error(now.blockers.join(' / '));
    if(t.completionHash!==d.taskHash || target.project.id!==d.targetProject || target.task.id!==d.targetTask)throw Error('確認中に作業が変わりました');
    const selected=b.selected || [];
    if(!Array.isArray(selected) || new Set(selected).size!==selected.length || selected.some(id=>!d.files.some(f=>f.id===id)))throw Error('渡す成果ファイルを選び直してください');
    const files=d.files.filter(f=>selected.includes(f.id));
    if(!files.length && !d.hasCode)throw Error('成果ファイルを選んでください');
    for(const f of files)if(snapshot(f.path)!==f.fingerprint)throw Error('確認中に成果ファイルが変わりました');
    const r={id:old?.id || randomUUID(),project:b.project,task:b.task,title:t.title,taskHash:t.completionHash,targetProject:target.project.id,targetTask:target.task.id,targetName:d.target,handedUp:true,files};this.save(r);
    if(!chat.read(target.project.dir,target.task.id).some(x=>x.offer===r.id))chat.append(target.project.dir,target.task.id,{role:'user',text:`子作業「${t.title}」の成果が渡されました。［統合…］で確認して統合できます。`,from:'subtask',child:b.task,childTitle:t.title,childProject:b.project,offer:r.id});
    this.notify(r.targetProject,r.targetTask,r.id);
    return {ok:true,handedUp:true,parent:r.targetTask,parentProject:r.targetProject,files:files.map(f=>f.path)};
  }
  receiveIntegrated({project,task,targetProject,targetTask,integrating,files,integrated,optional=[]}) {
    let r=this.read(project,task);
    if(r?.complete){if(r.integrating!==integrating)throw Error('別の統合で受領済みです');return this.result(r,true);}
    if(r?.receiving){if(r.integrating!==integrating)throw Error('別の祖先の統合中です');this.continue(r);return this.result(r);}
    if(r?.integrating && r.integrating!==integrating)throw Error('別の祖先の統合中です');
    const {t,target,d}=this.context(project,task,{targetProject,targetTask,integrating});
    if(d.blockers.length)throw Error(d.blockers.join(' / '));
    if(!Array.isArray(optional) || optional.some(id=>!d.optional.some(f=>f.id===id)))throw Error('片付ける専用フォルダを確認してください');
    for(const f of files)if(snapshot(f.path)!==f.fingerprint)throw Error('成果ファイルが変わりました。元の記録は残しています');
    const id=randomUUID(),destination=path.join(target.project.dir,'成果物','受取',id);noLinks(destination);
    r={id,project,task,title:t.title,taskHash:t.completionHash,targetProject,targetTask,targetHash:target.task.completionHash,targetName:`${target.project.name}／${target.task.title}`,integrating,receiving:true,destination,files:files.map(f=>({...f,to:path.join(destination,f.location,f.relative),digest:hash(fs.readFileSync(f.path))})),integrated,move:[...d.move,...d.optional.filter(f=>optional.includes(f.id))],optional,notified:false,complete:false};
    this.save(r);this.continue(r);return this.result(r);
  }
  apply({ project, task, token, selected = [], confirm, expectTitle }) {
    const saved = this.tokens.get(token); if (!saved || Date.now() - saved.at > 600000 || confirm !== true || saved.value.project !== project || saved.value.task !== task) throw Error('もう一度引渡し内容を確認してください');
    const old = saved.value; let r = this.read(project, task);
    this.expectTitle(project,task,expectTitle,r);
    if (r && (old.pending ? old.pending !== r.id : old.taskHash !== r.taskHash || old.targetProject !== r.targetProject || old.targetTask !== r.targetTask)) throw Error('受領記録が変わりました。内容を読み直してください');
    if (r?.complete) {
      const file = this.store.taskFile(project, task);
      if (file && this.store.readTask(file).completionHash !== r.taskHash) throw Error('引渡し後に作業が変わりました。内容を読み直してください');
      return this.result(r, true);
    }
    if (!r) {
      if(old.blockers?.length) throw Error(old.blockers.join(' / '));
      const { p, t, target, d } = this.context(project, task);
      if (d.blockers.length) throw Error(d.blockers.join(' / '));
      if (t.completionHash !== old.taskHash || target.task.completionHash !== old.targetHash || target.project.id !== old.targetProject || target.task.id !== old.targetTask) throw Error('確認中に作業・本作業が変わりました。内容を読み直してください');
      if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(id => !old.files.some(x => x.id === id))) throw Error('渡す成果ファイルを選び直してください');
      const files = old.files.filter(x => selected.includes(x.id));
      if (!files.length && !old.integrated?.files?.length) throw Error('成果ファイルを選んでください');
      for (const f of files) if (snapshot(f.path) !== f.fingerprint) throw Error('確認中に成果ファイルが変わりました');
      if (JSON.stringify(this.integration(p, t)) !== JSON.stringify(old.integrated)) throw Error('本体への取り込み記録が変わりました');
      const id = randomUUID(), destination = path.join(target.project.dir, '成果物', '受取', id); noLinks(destination);
      r = { id, project, task, title: t.title, targetProject: target.project.id, targetTask: target.task.id, targetName: old.target, targetHash: old.targetHash, taskHash: t.completionHash, destination, files: files.map(f => ({ ...f, to: path.join(destination, f.location, f.relative), digest: hash(fs.readFileSync(f.path)) })), integrated: old.integrated, move: d.move, cleanupVersion:2, notified: false, complete: false };
      this.save(r);
    }
    if(old.pending && old.pending !== r.id) throw Error('受領記録が変わりました。内容を読み直してください');
    this.continue(r); return this.result(r);
  }
  continue(r) {
    const target = this.store.readProject(r.targetProject), task = target?.tasks.find(x => x.id === r.targetTask);
    if (!task || !r.integrating && task.state === '完了' || this.removal.busy(r.project, r.task) || this.removal.busy(r.targetProject, r.targetTask) || this.removal.locked(r.project) || this.removal.locked(r.targetProject)) throw Error('作業・本作業が稼働中、完了済み、または見つかりません。成果は保持しています');
    if (r.cleanup && this.store.taskFile(r.project,r.task)) {
      const c=this.context(r.project,r.task,r.integrating ? r : {});
      if(c.d.blockers.length || c.t.completionHash!==r.taskHash || c.target.project.id!==r.targetProject || c.target.task.id!==r.targetTask) throw Error('片付け途中で作業の状態が変わりました。成果は保持しています');
    }
    if (!r.notified && task.completionHash !== r.targetHash && !chat.read(target.dir,r.targetTask).some(x=>x.handoff===r.id)) throw Error('引渡し途中で本作業が変わりました。内容を確認してください');
    if (!r.cleanup) {
      const c = this.context(r.project, r.task, r.integrating ? r : {}); if (c.d.blockers.length) throw Error(c.d.blockers.join(' / '));
      if (!r.integrating && JSON.stringify(this.integration(c.p,c.t)) !== JSON.stringify(r.integrated)) throw Error('本体への取り込み記録が変わりました。成果は保持しています');
      if (c.t.completionHash !== r.taskHash || c.target.project.id !== r.targetProject || c.target.task.id !== r.targetTask) throw Error('引渡し途中で元の作業が変わりました。成果は保持しています');
      let moves=[...c.d.move,...c.d.optional.filter(f=>(r.optional || []).includes(f.id))];
      // 旧版の途中受領は当時確認された片付け範囲を保つ。新版の追加物で再開を止めない。
      if(!r.integrating&&!r.cleanupVersion){const added=[path.join(c.p.dir,'.ai/work',r.task),path.join(c.p.dir,'.ai/chat',r.task+'.rules.md')];moves=moves.filter(f=>!added.includes(f.path)||r.move.some(x=>x.path===f.path));}
      if (JSON.stringify(moves) !== JSON.stringify(r.move)) throw Error('引渡し途中で管理ファイルが変わりました。成果は保持しています');
    }
    for (const f of r.files) {
      noLinks(f.to);
      if (exists(f.to)) { if (hash(fs.readFileSync(f.to)) !== f.digest) throw Error('受け取った成果が変更されています。上書きしません'); continue; }
      if (r.notified || snapshot(f.path) !== f.fingerprint) throw Error('成果ファイルが変わったか失われました。管理記録は保持しています');
      fs.mkdirSync(path.dirname(f.to), { recursive: true });
      const tmp = f.to + '.handoff-tmp'; noLinks(tmp); fs.copyFileSync(f.path, tmp); if (hash(fs.readFileSync(tmp)) !== f.digest) throw Error('成果を正しく保存できませんでした'); fs.renameSync(tmp, f.to);
    }
    // 通知・本文は識別子で照合し、通知後の保存失敗でも二重にしない。
    const recovered = r.integrated?.recovered ? '（古い取り込み記録を本体の履歴と照合）' : '';
    const text = [`「${r.title}」から本作業「${r.targetName}」へ成果を受け取りました。`, ...r.files.map(f => `- ${f.to}`), ...(r.integrated ? [`${r.integrating ? '統合先' : '本体への取り込み済み'}：${r.integrated.dir}（${r.integrated.commit}）${recovered}`, ...(r.integrated.github ? [`更新候補：${r.integrated.github.url}（ブランチ：${r.integrated.github.branch || '未指定'}）`] : []), ...r.integrated.files.map(f => `- ${f}`)] : []), FINAL_CHECK].join('\n');
    if (!chat.read(target.dir, r.targetTask).some(x => x.handoff === r.id)) chat.append(target.dir, r.targetTask, {role:'user',text,from:'subtask',child:r.task,childTitle:r.title,childProject:r.project,handoff:r.id,...(r.integrating?{integrating:r.integrating}:{})});
    const targetFile = this.store.taskFile(r.targetProject, r.targetTask); noLinks(targetFile);
    if (!fs.readFileSync(targetFile, 'utf8').includes(`受領記録：${r.id}`)) this.store.appendSection(r.targetProject, r.targetTask, 'やったこと', `- 「${r.title}」の成果${r.files.length}ファイルを受領：${r.destination}${r.integrated ? (r.integrating ? '／統合先への取り込み済み' : '／本体への取り込み済み') + recovered : ''}。受領記録：${r.id}。${FINAL_CHECK}`);
    r.notified = true; this.save(r); this.notify(r.targetProject, r.targetTask, r.id);
    if(r.integrating||process.platform==='win32'&&r.nativeCleanup)this.beforeCleanup(r);
    if (!r.cleanup) {
      const id = randomUUID(), dest = path.join(this.removal.trash, 'ProjectHub 引渡し ' + id);
      noLinks(dest);
      // taskファイルを最後に移す。途中失敗でも一覧から再実行できる。
      const taskFile=this.store.taskFile(r.project,r.task);
      const moves = r.move.slice().sort((a,b) => Number(a.path===taskFile) - Number(b.path===taskFile));
      const record = {id,at:new Date().toISOString(),kind:'task',project:r.project,task:r.task,title:r.title,entries:moves.map(x => ({from:x.path,to:path.join(dest,path.relative(this.store.root,x.path)),fingerprint:x.fingerprint,moved:false,restored:false})),error:''};
      this.removal.save(record); r.cleanup = id; this.save(r);
    }
    const file = path.join(this.removal.records, r.cleanup + '.json'); noLinks(file);
    const record = this.removal.recover(JSON.parse(fs.readFileSync(file, 'utf8')));
    // 専用領域の管理記録だけを退避。復元・変更された記録は消さない。
    const root = path.join(this.store.product, r.project);
    const allowed = [path.join(root,'.ai/tasks',r.task+'.md'),path.join(root,'.ai/work',r.task), ...['.jsonl','.json','.queue.json','.rules.md'].map(ext => path.join(root,'.ai/chat',r.task+ext)),...(r.optional || []).filter(x=>x==='作業/'+r.task || x==='attachments/'+r.task).map(x=>path.join(root,x))];
    for (const e of record.entries) {
      if (!(allowed.includes(e.from) || path.dirname(e.from) === path.join(root,'.ai/handoff') && path.basename(e.from).startsWith(r.task+'-') && /^\d{8}-\d{6}-(claude|codex|agy)\.md$/.test(path.basename(e.from).slice(r.task.length+1))) || !inside(path.resolve(this.removal.trash), e.to) || e.restored) throw Error('片付け記録の場所・復元状態を確認してください');
      noLinks(e.from); noLinks(e.to);
      if (e.moved) { if (exists(e.from)) throw Error('元の管理記録が復元されています。上書きしません'); continue; }
      if (e.from===path.join(root,'.ai/work',r.task) || (r.optional||[]).some(x=>e.from===path.join(root,x)) || path.dirname(e.from)===path.join(root,'.ai/handoff')) {
        const p=this.store.readProject(r.project),t=p?.tasks.find(x=>x.id===r.task);
        if(!t || this.removal.referenced(e.from,p,t,this.store.listProjects())) throw Error('他の記録から参照されているため専用フォルダ・引継ぎ資料を残します');
      }
      if (!exists(e.from) || snapshot(e.from) !== e.fingerprint) throw Error('片付ける管理記録が変わりました。成果は保持しています');
      fs.mkdirSync(path.dirname(e.to), {recursive:true}); e.moving=true; this.removal.save(record);
      this.removal.rename(e.from,e.to); e.moved=true; e.moving=false; this.removal.save(record);
    }
    r.complete = true; this.save(r);
  }
  result(r, duplicate = false) { return {ok:true,parent:r.targetTask,parentProject:r.targetProject,record:r.cleanup,destination:r.destination,files:r.files.map(f=>f.to),duplicate}; }
}
module.exports = { TaskTransfer, FINAL_CHECK };
