'use strict';
// 人が確認した対象だけをゴミ箱へ退避する。親や共有先は移さない。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {expandHome}=require('./store');
const hash=x=>createHash('sha256').update(x).digest('hex');
const inside=(a,b)=>b===a||b.startsWith(a+path.sep);
const exists=f=>{try{fs.lstatSync(f);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
function noLinks(f) {
 if(process.platform==='win32'){try{require('./safe-path').localPath(f,{allowMissing:true});}catch(e){throw Error('リンクまたは無効な場所は移せません：'+e.message);}}
 for(let q=path.resolve(f);;q=path.dirname(q)){if(exists(q)&&fs.lstatSync(q).isSymbolicLink())throw Error('リンクを含む場所は移せません');if(q===path.dirname(q))break;}
}
function snapshot(f) {
 noLinks(f);let n=0,bytes=0;const rows=[];
 const walk=q=>{if(++n>20000)throw Error('ファイルが多すぎて照合できません');const st=fs.lstatSync(q);if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory())throw Error('リンクや特殊なファイルを含むため移せません');bytes+=st.isFile()?st.size:0;if(bytes>256*1024*1024)throw Error('照合できる大きさを超えています');rows.push([path.relative(f,q),st.ino,st.size,st.mtimeMs,st.isFile()?hash(fs.readFileSync(q)):'']);if(st.isDirectory())for(const x of fs.readdirSync(q).sort())walk(path.join(q,x));};walk(f);return hash(JSON.stringify(rows));
}
function referenceTexts(text,file) {
 if(!/\.jsonl?$/.test(file))return [text];
 const out=[];
 for(const part of file.endsWith('.jsonl')?text.split('\n'):[text]){
  let value;try{value=JSON.parse(part);}catch{out.push(part);continue;}
  const pending=[value];while(pending.length){const v=pending.pop();if(typeof v==='string')out.push(v);else if(v&&typeof v==='object')for(const x of Object.values(v))pending.push(x);}
 }
 return out;
}
class Removal {
 constructor({store,busy=()=>false,locked=()=>false,trash=process.env.HUB_TRASH||path.join(os.homedir(),'.Trash'),rename=fs.renameSync}){Object.assign(this,{store,busy,locked,trash,rename});this.tokens=new Map();this.records=path.join(store.root,'_hub/removed');}
 workRoot(p){return path.join(this.store.root,'Work',p.id);}
 describe(project,task) {
  const p=this.store.readProject(project);if(!p)throw Error('プロジェクトがありません');const t=task&&p.tasks.find(x=>x.id===task);if(task&&!t)throw Error('作業がありません');
  const all=this.store.listProjects(),d={project:p.id,task:t?.id||'',title:t?t.title:p.name,move:[],optional:[],keep:[],blockers:[],warnings:[],typed:false};
  const ref=(q,x)=>x===p.id||x===p.name;
  const ext=f=>path.resolve(p.dir,expandHome(f));
  for(const f of p.folders)if(!inside(p.dir,ext(f.path)))d.keep.push({path:ext(f.path),why:'プロジェクトの外の場所（親や他と共有の可能性）なので残します'});
  if(!t)for(const id of p.related){const q=all.find(q=>q.id===id||q.name===id);d.keep.push({path:q?.dir||String(id),why:'参考・関連のプロジェクトなので残します'});}
  if(!t&&this.busy(p.id))d.blockers.push('AIが作業中です。終わってから操作してください');
  if(this.locked(p.id))d.blockers.push('整理・確認が実行中です。終わってから操作してください');
  const queue=x=>{const f=path.join(p.dir,'.ai/chat',x.id+'.queue.json');if(!exists(f))return false;try{const v=JSON.parse(fs.readFileSync(f,'utf8'));return !Array.isArray(v)||v.length>0;}catch{return true;}};
  for(const x of t?[t]:p.tasks){if(this.busy(p.id,x.id))d.blockers.push('AIが作業中です。終わってから操作してください');if(queue(x))d.blockers.push('順番待ちを取り消してから操作してください');}
  const copies=t?path.join(this.workRoot(p),t.id):this.workRoot(p);
  if(exists(copies)&&(t||fs.readdirSync(copies).length))d.blockers.push('作業用コピーが残っています。先に本体への取り込みかコピーの片付けをしてください');
  if(t?.workdir&&inside(this.workRoot(p),path.resolve(expandHome(t.workdir))))d.blockers.push('作業用コピーの記録が残っています。先に記録を片付けてください');
  if(t) {
   if(all.some(q=>q.tasks.some(x=>!(q.id===p.id&&x.id===t.id)&&((q.id===p.id&&x.parent===t.id)||x.derivedFrom===`${p.id}/${t.id}`||(q.id===p.id&&x.derivedFrom===t.id)))))d.blockers.push('下の作業や、この作業から派生した作業があります。先に整理してください');
   for(const f of [this.store.taskFile(p.id,t.id),...['.jsonl','.json','.queue.json','.rules.md'].map(ext=>path.join(p.dir,'.ai/chat',t.id+ext))])if(exists(f))d.move.push({path:f,what:'作業ファイル・会話'});
   const temp=path.join(p.dir,'.ai/work',t.id);
   if(exists(temp))try { snapshot(temp); if(this.referenced(temp,p,t,all))throw Error('他の記録から参照されています');d.move.push({path:temp,what:'この作業の専用一時フォルダ'}); }catch(e){d.keep.push({path:temp,why:e.message});}
   const hdir=path.join(p.dir,'.ai/handoff');
   if(exists(hdir)) {
    noLinks(hdir);
    for(const name of fs.readdirSync(hdir))if(name.startsWith(t.id+'-')&&/^\d{8}-\d{6}-(claude|codex|agy)\.md$/.test(name.slice(t.id.length+1))) {
     const f=path.join(hdir,name);
     try {if(this.referenced(f,p,t,all))d.keep.push({path:f,why:'他の記録から参照される引継ぎ資料は残します'});else d.move.push({path:f,what:'この作業のAI交代引継ぎ記録'});}catch(e){d.keep.push({path:f,why:e.message});}
    }
   }
   for(const f of [path.join(p.dir,'attachments',t.id),path.join(p.dir,'作業',t.id)])if(exists(f)){
    try {snapshot(f);if(this.referenced(f,p,t,all))throw Error('他の台帳・作業・会話から参照されています');d.optional.push({id:path.relative(p.dir,f).split(path.sep).join('/'),path:f,why:'この作業の専用フォルダ。必要な場合だけ選んでください'});}catch(e){d.keep.push({path:f,why:e.message});}
   }
  } else {
   if(p.id==='Project Hub'||p.name==='Project Hub'||path.dirname(p.dir)!==path.resolve(this.store.product))d.blockers.push('Project Hub自身やProductの外は削除できません');
   if(all.some(q=>q.id!==p.id&&(ref(q,q.parent)||ref(q,q.derivedFrom))))d.blockers.push('下に子プロジェクトや分岐があります。先に下のプロジェクトを整理してください');
   for(const q of all.filter(q=>q.id!==p.id)){
    for(const f of q.folders){const resolved=path.resolve(q.dir,expandHome(f.path));if(inside(p.dir,resolved))d.blockers.push(`「${q.name}」がこのフォルダ内を使っています`);}
    if(q.related.some(x=>ref(q,x)))d.warnings.push(`「${q.name}」の関連の記載は残り、リンク切れになります`);
   }
   try {noLinks(p.dir);const query=(dir,args)=>process.platform==='win32'?require('./git-policy').run(dir,args):execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});let top;try{top=query(p.dir,['rev-parse','--show-toplevel']).trim();}catch(e){if(e.status!==128)throw e;}
    if(top&&fs.realpathSync(top)!==fs.realpathSync(p.dir)) {const names=query(top,['ls-files','-z','--',p.dir]);if(names)d.blockers.push('外側のGitで追跡されています');}
   }catch(e){d.blockers.push(e.message);}
   d.move.push({path:p.dir,what:'このプロジェクトのフォルダ全体（台帳・資料・成果物を含む）'});
   d.typed=['資料','成果物'].some(n=>exists(path.join(p.dir,n))&&fs.readdirSync(path.join(p.dir,n)).length>0);
  }
  for(const x of [...d.move,...d.optional])try{x.fingerprint=snapshot(x.path);}catch(e){d.blockers.push(e.message);}
  d.blockers=[...new Set(d.blockers)];return d;
 }
 referenced(f,p,t,all){
  // 持ち主が明確でも、共有や読み切れない参照があれば残す。
  const texts=[];let count=0,bytes=0;
  for(const q of all){for(const fld of q.folders)if(inside(f,path.resolve(q.dir,expandHome(fld.path))))return true;
   for(const base of [path.join(q.dir,'PROJECT.md'),path.join(q.dir,'.ai/tasks'),path.join(q.dir,'.ai/chat')])if(exists(base)){
    const walk=x=>{noLinks(x);const st=fs.lstatSync(x);if(st.isDirectory()){for(const n of fs.readdirSync(x))walk(path.join(x,n));return;}if(q.id===p.id&&(x===this.store.taskFile(p.id,t.id)||path.basename(x).startsWith(t.id+'.')))return;
     if(++count>5000||(bytes+=st.size)>16*1024*1024)throw Error('参照を確認しきれないため専用フォルダを残します');for(const text of referenceTexts(fs.readFileSync(x,'utf8'),x))texts.push({text:text.normalize('NFC'),dir:q.dir.normalize('NFC')});};walk(base);
   }
  }
  // パス全体を参照元のプロジェクトから解決する。../ を保護し、
  // 受領コピー先の途中に含まれる元の相対パスは共有参照と誤認しない。
  const needle=f.normalize('NFC');
  return texts.some(({text,dir})=>{
   // 空白を含む絶対パスも従来どおり保護する。
   if(text.includes(needle))return true;
   const refs=[],tokens=/[^\s"'`<>(){}\[\],;:：|\\*]+/gu,marks=/[。！？「」『』（）、，；【】〈〉《》〔〕［］｛｝]/gu;
   // 引用の内側も、既にパスの途中なら独立した参照にしない。
   let quoteEnd=0;
   for(const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|「([^」\n]+)」|『([^』\n]+)』|（([^）\n]+)）|【([^】\n]+)】|〈([^〉\n]+)〉|《([^》\n]+)》|〔([^〕\n]+)〕|［([^］\n]+)］|｛([^｝\n]+)｝/g)){
    const prefix=text.slice(quoteEnd,m.index).match(/[^\s"'`<>(){}\[\],;:：|\\*]*$/u)[0];
    if(!prefix.includes('/')){refs.push(m.slice(1).find(x=>x));quoteEnd=m.index+m[0].length;}
   }
   for(const m of text.matchAll(tokens)){
    const token=m[0],slash=token.indexOf('/');if(slash<0)continue;
    // 全体のパスも保持し、読点・句点で並ぶ独立した参照を順に読む。
    // 実在するディレクトリ構成要素内の区切り文字では分断しない。
    const parts=[token];let from=0;
    for(const mark of token.matchAll(/[。！？、，；]/gu)){
     const prefix=token.slice(from,mark.index),firstSlash=prefix.indexOf('/'),nextSlash=token.indexOf('/',mark.index+1);
     if(firstSlash>=0&&nextSlash>=0){
      const starts=[0,...[...prefix.slice(0,firstSlash).matchAll(marks)].map(x=>x.index+1)];
      if(starts.some(start=>{try{return fs.statSync(path.resolve(dir,expandHome(token.slice(from+start,nextSlash)))).isDirectory();}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e;}}))continue;
     }
     parts.push(token.slice(from,mark.index));from=mark.index+1;
    }
    parts.push(token.slice(from));
    for(const part of parts){
     const firstSlash=part.indexOf('/');if(firstSlash<0)continue;
     const starts=[0,...[...part.slice(0,firstSlash).matchAll(marks)].map(x=>x.index+1)];
     for(const start of starts){const ref=part.slice(start);refs.push(ref,ref.replace(/[。！？「」『』（）、，；【】〈〉《》〔〕［］｛｝]+$/u,''));}
    }
   }
   return refs.some(ref=>ref.includes('/')&&inside(needle,path.resolve(dir,expandHome(ref))));
  });
 }
 preview(project,task){const d=this.describe(project,task),token=randomUUID();for(const [k,v] of this.tokens)if(Date.now()-v.at>600000)this.tokens.delete(k);this.tokens.set(token,{at:Date.now(),d});return {...d,token};}
 save(r){if(!/^[0-9a-f-]{36}$/.test(r.id))throw Error('記録の識別が不正です');noLinks(this.records);fs.mkdirSync(this.records,{recursive:true});const f=path.join(this.records,r.id+'.json'),tmp=f+'.'+randomUUID()+'.tmp';noLinks(f);noLinks(tmp);try{fs.writeFileSync(tmp,JSON.stringify(r,null,2),{flag:'wx'});fs.renameSync(tmp,f);}finally{if(exists(tmp))fs.unlinkSync(tmp);}}
 apply({token,optional=[],confirm,typed}){
  const old=this.tokens.get(token);if(confirm!==true||!old||Date.now()-old.at>600000)throw Error('もう一度削除内容を確認してください');
  const d=this.describe(old.d.project,old.d.task);if(d.blockers.length)throw Error(d.blockers.join(' / '));if(JSON.stringify(d)!==JSON.stringify(old.d))throw Error('確認中に変わりました。もう一度確認してください');
  if(d.typed&&typed!==d.title)throw Error('プロジェクト名をそのまま入力してください');if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>!d.optional.some(x=>x.id===id)))throw Error('移すものを選び直してください');
  noLinks(this.trash);fs.mkdirSync(this.trash,{recursive:true});this.tokens.delete(token);
  const id=randomUUID(),dest=path.join(this.trash,`ProjectHub 削除 ${new Date().toISOString().replace(/[:.]/g,'-')} ${id}`),files=[...d.move,...d.optional.filter(x=>optional.includes(x.id))];
  const r={id,at:new Date().toISOString(),kind:d.task?'task':'project',project:d.project,task:d.task,title:d.title,entries:files.map(x=>({from:x.path,to:path.join(dest,path.relative(this.store.root,x.path)),moved:false,restored:false,fingerprint:x.fingerprint})),error:''};
  this.save(r);const failed=[];
  for(const e of r.entries){try{noLinks(e.from);noLinks(e.to);fs.mkdirSync(path.dirname(e.to),{recursive:true});e.moving=true;this.save(r);this.rename(e.from,e.to);e.moved=true;e.moving=false;this.save(r);}catch(err){r.error=err.code==='EXDEV'?'同じディスクにないため移せません':err.message;failed.push({path:e.from,why:r.error});this.save(r);break;}}
  return {ok:!failed.length,record:r.id,moved:r.entries.filter(e=>e.moved).map(e=>e.from),failed};
 }
 recover(r){
  // rename後、完了記録の保存前に止まった場合も、確認済みの内容から復元できる。
  let changed=false;const root=path.join(this.store.product,r.project);
  if(path.dirname(root)!==path.resolve(this.store.product)||(r.project==='Project Hub'&&r.kind!=='task'))return r;
  for(const e of r.entries){if(!e.moving&&!e.restoring)continue;
   if(e.from!==path.resolve(e.from)||e.to!==path.resolve(e.to)||!inside(root,e.from)||!inside(path.resolve(this.trash),e.to))continue;
   noLinks(e.from);noLinks(e.to);
   if(e.moving&&!exists(e.from)&&exists(e.to)&&snapshot(e.to)===e.fingerprint){e.moved=true;e.moving=false;changed=true;}
   if(e.restoring&&!exists(e.to)&&exists(e.from)&&snapshot(e.from)===e.fingerprint){e.restored=true;e.restoring=false;changed=true;}
  }
  if(changed)this.save(r);return r;
 }
 history(){try{noLinks(this.records);return fs.readdirSync(this.records).filter(n=>/^[\da-f-]{36}\.json$/.test(n)).map(n=>this.recover(JSON.parse(fs.readFileSync(path.join(this.records,n),'utf8')))).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100).map(r=>({id:r.id,at:r.at,title:r.title,project:r.project,task:r.task,count:r.entries.filter(e=>e.moved).length,restored:r.entries.filter(e=>e.moved).every(e=>e.restored),error:r.error}));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 restore(id,confirm){
  if(confirm!==true||!/^[\da-f-]{36}$/.test(id))throw Error('記録を確認してください');const file=path.join(this.records,id+'.json');noLinks(file);const r=this.recover(JSON.parse(fs.readFileSync(file,'utf8')));
  if(this.locked(r.project)||this.busy(r.project))throw Error('AI・整理・確認が動いています。終わってから元に戻してください');
  const root=path.join(this.store.product,r.project);if(path.dirname(root)!==path.resolve(this.store.product)||(r.project==='Project Hub'&&r.kind!=='task'))throw Error('復元先が不正です');
  let restored=0;const skipped=[];
  for(const e of r.entries.filter(e=>e.moved&&!e.restored))try{
   if(e.from!==path.resolve(e.from)||e.to!==path.resolve(e.to)||!inside(root,e.from)||!inside(path.resolve(this.trash),e.to))throw Error('記録の場所が不正です');noLinks(e.from);noLinks(e.to);
   if(snapshot(e.to)!==e.fingerprint)throw Error('ゴミ箱の中身が変わっています。自動では戻しません');
   if(exists(e.from))throw Error('同名のファイルがあるため上書きしません');if(r.kind==='task'&&!exists(path.join(root,'PROJECT.md')))throw Error('プロジェクトを先に元に戻してください');
   fs.mkdirSync(path.dirname(e.from),{recursive:true});e.restoring=true;this.save(r);this.rename(e.to,e.from);e.restored=true;e.restoring=false;restored++;this.save(r);
  }catch(err){skipped.push({path:e.from,why:err.message});}
  return {ok:!skipped.length,restored,skipped};
 }
}
// Native plans are created before confirmation. The legacy fingerprint remains
// separate; it is never reinterpreted as native-tree-v1 evidence.
Removal.prototype.planNativeEntries=async function({id,project,task='',title,entries,kind=task?'task':'project'}) {
 if(process.platform!=='win32')throw Error('Native removal is Windows-only');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id||'')||!Array.isArray(entries)||!entries.length||entries.length>100||typeof title!=='string')throw Error('Native cleanup plan is invalid');
 const p=this.store.readProject(project);if(!p||task&&!p.tasks.some(t=>t.id===task)||kind!==(task?'task':'project'))throw Error('Native cleanup membership is invalid');
 const safe=require('./safe-path').localPath,rooted=require('./rooted-move');
 const sourceRoot=safe(task?p.dir:this.store.product),targetRoot=safe(this.trash,{allowMissing:true}),journalRoot=safe(path.join(this.store.root,'_hub/rooted-moves'),{allowMissing:true});
 const control=safe(path.join(this.store.root,'_hub'),{allowMissing:true}),code=safe(path.join(__dirname,'..'));
 const overlaps=(a,b)=>{a=a.toLowerCase();b=b.toLowerCase();return inside(a,b)||inside(b,a);};
 for(const e of entries){if(!e||typeof e.from!=='string'||typeof e.to!=='string'||!/^[a-f0-9]{64}$/.test(e.fingerprint||''))throw Error('Native entry is invalid');const from=safe(e.from),to=safe(e.to,{allowMissing:true});if(from===sourceRoot||!inside(sourceRoot,from)||!inside(p.dir,from)||to===targetRoot||!inside(targetRoot,to)||overlaps(from,control)||overlaps(from,code))throw Error('Native cleanup scope overlaps protected Hub controls or code');}
 fs.mkdirSync(targetRoot,{recursive:true});fs.mkdirSync(journalRoot,{recursive:true});safe(targetRoot);safe(journalRoot);
 const planned=[];
 for(const e of entries){const native=await rooted.plan({sourceRoot,sourcePath:path.relative(sourceRoot,e.from),targetRoot,targetPath:path.relative(targetRoot,e.to),journalRoot});if(snapshot(e.from)!==e.fingerprint)throw Error('Cleanup source changed during native preview');planned.push({...e,moved:false,restored:false,native});}
 return this.validateNativeRecord({id,at:new Date().toISOString(),kind,project,task,title,entries:planned,error:'',nativeVersion:1});
};
Removal.prototype.validateNativeRecord=function(r) {
 const rooted=require('./rooted-move'),safe=require('./safe-path').localPath;
 const component=value=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\\/:*?"<>|\x00-\x1f]/.test(value)&&value!=='.'&&value!=='..'&&!/[. ]$/.test(value);
 if(!r||Object.keys(r).sort().join(',')!=='at,entries,error,id,kind,nativeVersion,project,task,title'||r.nativeVersion!==1||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.id||'')||!Array.isArray(r.entries)||!r.entries.length||r.entries.length>100||!['task','project'].includes(r.kind)||!component(r.project)||typeof r.task!=='string'||r.kind==='task'&&!component(r.task)||r.kind==='project'&&r.task!==''||typeof r.title!=='string'||r.title.length>4096||typeof r.error!=='string'||r.error.length>8192||typeof r.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.at)||!Number.isFinite(Date.parse(r.at)))throw Error('Legacy or invalid cleanup record requires a fresh native preview');
 const sourceRoot=safe(r.kind==='task'?path.join(this.store.product,r.project):this.store.product),targetRoot=safe(this.trash),journalRoot=safe(path.join(this.store.root,'_hub/rooted-moves'));
 const control=safe(path.join(this.store.root,'_hub')),code=safe(path.join(__dirname,'..'));
 const overlaps=(a,b)=>{a=a.toLowerCase();b=b.toLowerCase();return inside(a,b)||inside(b,a);};
 const seenFrom=new Set(),seenTo=new Set(),seenNative=new Set(),entryFields=new Set('from to fingerprint moved restored moving restoring native nativeRestore nativeState nativeRestoreState'.split(' '));
 for(const e of r.entries){if(!e||Object.keys(e).some(k=>!entryFields.has(k))||typeof e.from!=='string'||typeof e.to!=='string'||typeof e.moved!=='boolean'||typeof e.restored!=='boolean'||!/^[a-f0-9]{64}$/.test(e.fingerprint||'')||['moving','restoring'].some(k=>e[k]!==undefined&&typeof e[k]!=='boolean')||['nativeState','nativeRestoreState'].some(k=>e[k]!==undefined&&!['planned','complete','partial','moved-unreceipted','not-moved'].includes(e[k])))throw Error('Native cleanup entry is invalid');rooted.validatePlan(e.native);if(seenFrom.has(e.from.toLowerCase())||seenTo.has(e.to.toLowerCase())||seenNative.has(e.native.recordId))throw Error('Duplicate native cleanup entry');seenFrom.add(e.from.toLowerCase());seenTo.add(e.to.toLowerCase());seenNative.add(e.native.recordId);if(path.resolve(e.from)!==e.from||path.resolve(e.to)!==e.to||e.from===sourceRoot||!inside(path.join(this.store.product,r.project),e.from)||overlaps(e.from,control)||overlaps(e.from,code)||e.native.sourceRoot!==sourceRoot||e.native.targetRoot!==targetRoot||e.native.journalRoot!==journalRoot||path.resolve(sourceRoot,e.native.sourcePath)!==e.from||path.resolve(targetRoot,e.native.targetPath)!==e.to)throw Error('Native cleanup authority changed');if(e.nativeRestore){rooted.validatePlan(e.nativeRestore);const undo=e.nativeRestore,forward=e.native;if(undo.sourceRoot!==forward.targetRoot||undo.sourceRootFingerprint!==forward.targetRootFingerprint||undo.sourcePath!==forward.targetPath||undo.targetRoot!==forward.sourceRoot||undo.targetRootFingerprint!==forward.sourceRootFingerprint||undo.targetPath!==forward.sourcePath||undo.objectId!==forward.objectId||undo.treeHash!==forward.treeHash||undo.journalRoot!==forward.journalRoot||undo.journalRootFingerprint!==forward.journalRootFingerprint||undo.recordId===forward.recordId)throw Error('Native restore authority changed');}else if(e.restored||e.restoring)throw Error('Native restore evidence is missing');}
 return r;
};
Removal.prototype.nativeRecord=function(recordOrId) {
 if(typeof recordOrId!=='string')return this.validateNativeRecord(recordOrId);
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(recordOrId))throw Error('Invalid cleanup record id');const file=path.join(this.records,recordOrId+'.json');noLinks(file);const r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.id!==recordOrId)throw Error('Cleanup record identity mismatch');return this.validateNativeRecord(r);
};
Removal.prototype.moveEntryAsync=async function(record,e) {
 const r=this.validateNativeRecord(record);if(!r.entries.includes(e)||e.restored)throw Error('Native cleanup entry is not active');
 if(e.moved&&!e.moving){const evidence=await require('./rooted-move').recover(e.native);if(evidence.state!=='complete')throw Error('Native cleanup completion is unverified');return e;}
 if(e.moving&&e.nativeState){const rooted=require('./rooted-move');let recovery;try{recovery=await rooted.recover(e.native);}catch(error){if(error.code!=='RECORD_NOT_FOUND'||e.nativeState!=='planned')throw error;}if(recovery){if(recovery.state==='moved-unreceipted'){await rooted.finalize(e.native);recovery=await rooted.recover(e.native);}if(recovery.state==='complete'){e.moved=true;e.moving=false;e.nativeState='complete';this.save(r);return e;}throw Object.assign(Error('Native cleanup needs recovery review: '+recovery.state),{recoveryRequired:true,recordId:e.native.recordId});}}
 if(snapshot(e.from)!==e.fingerprint)throw Error('Cleanup source changed since confirmation');
 e.moving=true;e.nativeState='planned';this.save(r);
 const out=await require('./rooted-move').move(e.native);
 e.moved=out.moved;e.nativeState=out.state;e.moving=out.state!=='complete';if(e.moving){r.error=out.error;this.save(r);throw Object.assign(Error('Native cleanup is partial: '+out.error),{recoveryRequired:true,recordId:out.recordId});}this.save(r);return e;
};
Removal.prototype.cleanupRecordAsync=async function(recordOrId,{beforeEntry}={}) {
 if(beforeEntry!==undefined&&typeof beforeEntry!=='function')throw Error('Invalid private cleanup entry validator');
 const r=this.nativeRecord(recordOrId);if(this.busy(r.project)||this.locked(r.project))throw Error('AI or maintenance is active');if(r.entries.some(e=>e.restored))throw Error('Restored cleanup requires a fresh reviewed deletion');const failed=[];
 for(const e of r.entries.filter(e=>!e.restored))try{await beforeEntry?.(r,e);await this.moveEntryAsync(r,e);}catch(error){r.error=error.message;this.save(r);failed.push({path:e.from,why:error.message});break;}
 return {ok:!failed.length,record:r.id,moved:r.entries.filter(e=>e.moved&&!e.moving).map(e=>e.from),failed,recoveryRequired:failed.length>0};
};
Removal.prototype.recoverAsync=async function(recordOrId) {
 const r=this.nativeRecord(recordOrId);let changed=false;
 for(const e of r.entries){if(e.restoring&&e.nativeRestore){const out=await require('./rooted-move').recover(e.nativeRestore);if(out.state==='complete'){e.restored=true;e.restoring=false;changed=true;}else{e.nativeRestoreState=out.state;r.error='Native restore needs recovery review';changed=true;}}else if(e.moving){const out=await require('./rooted-move').recover(e.native);if(out.state==='complete'){e.moved=true;e.moving=false;e.nativeState='complete';changed=true;}else{e.nativeState=out.state;r.error='Native cleanup needs recovery review';changed=true;}}}
 if(changed)this.save(r);return r;
};
Removal.prototype.restoreAsync=async function(id,confirm) {
 if(confirm!==true)throw Error('Confirm the restore');const r=await this.recoverAsync(id);if(this.busy(r.project)||this.locked(r.project))throw Error('AI or maintenance is active');let restored=0;const skipped=[];
 for(const e of r.entries.filter(e=>e.moved&&!e.restored))try{if(e.moving)throw Error('Partial cleanup requires recovery review');if(r.kind==='task'&&!exists(path.join(this.store.product,r.project,'PROJECT.md')))throw Error('Restore the project first');const rooted=require('./rooted-move'),evidence=await rooted.recover(e.native);if(evidence.state!=='complete')throw Error('Native move receipt is not complete');e.nativeRestore=await rooted.plan({sourceRoot:e.native.targetRoot,sourceRootFingerprint:e.native.targetRootFingerprint,sourcePath:e.native.targetPath,targetRoot:e.native.sourceRoot,targetRootFingerprint:e.native.sourceRootFingerprint,targetPath:e.native.sourcePath,journalRoot:e.native.journalRoot,journalRootFingerprint:e.native.journalRootFingerprint});if(e.nativeRestore.objectId!==e.native.objectId||e.nativeRestore.treeHash!==e.native.treeHash)throw Error('Trash content changed');e.restoring=true;this.save(r);const out=await rooted.move(e.nativeRestore);e.nativeRestoreState=out.state;if(out.state!=='complete')throw Error('Native restore is partial: '+out.error);e.restored=true;e.restoring=false;restored++;this.save(r);}catch(error){r.error=error.message;this.save(r);skipped.push({path:e.from,why:error.message});}
 return {ok:!skipped.length,restored,skipped,recoveryRequired:skipped.length>0};
};
Removal.prototype.previewAsync=async function(project,task) {
 if(process.platform!=='win32')return this.preview(project,task);
 const d=this.describe(project,task),token=randomUUID();for(const [k,v]of this.tokens)if(Date.now()-v.at>600000)this.tokens.delete(k);if(this.tokens.size>=128)throw Error('Too many deletion previews');
 let native=null;if(!d.blockers.length){const id=randomUUID(),dest=path.join(this.trash,`ProjectHub 削除 ${new Date().toISOString().replace(/[:.]/g,'-')} ${id}`);native=await this.planNativeEntries({id,project:d.project,task:d.task,title:d.title,entries:[...d.move,...d.optional].map(x=>({from:x.path,to:path.join(dest,path.relative(this.store.root,x.path)),fingerprint:x.fingerprint}))});if(JSON.stringify(this.describe(project,task))!==JSON.stringify(d))throw Error('Deletion source changed during native preview');}
 this.tokens.set(token,{at:Date.now(),d,native});return {...d,token};
};
Removal.prototype.applyAsync=async function({token,optional=[],confirm,typed}) {
 if(process.platform!=='win32')return this.apply({token,optional,confirm,typed});
 const old=this.tokens.get(token);this.tokens.delete(token);if(confirm!==true||!old?.native||Date.now()<old.at||Date.now()-old.at>600000)throw Error('Please preview and confirm the deletion again');
 const d=this.describe(old.d.project,old.d.task);if(d.blockers.length)throw Error(d.blockers.join(' / '));if(JSON.stringify(d)!==JSON.stringify(old.d))throw Error('Deletion source changed since preview');if(d.typed&&typed!==d.title)throw Error('Enter the project title exactly');if(!Array.isArray(optional)||new Set(optional).size!==optional.length||optional.some(id=>!d.optional.some(x=>x.id===id)))throw Error('Invalid optional deletion selection');
 const paths=new Set([...d.move,...d.optional.filter(x=>optional.includes(x.id))].map(x=>x.path)),r={...old.native,entries:old.native.entries.filter(e=>paths.has(e.from))};this.validateNativeRecord(r);this.save(r);return this.cleanupRecordAsync(r);
};
Removal.prototype.historyAsync=async function() {
 if(process.platform!=='win32')return this.history();if(!exists(this.records))return [];noLinks(this.records);const records=[];
 for(const name of fs.readdirSync(this.records).filter(n=>/^[a-f0-9-]{36}\.json$/i.test(n))){const file=path.join(this.records,name);noLinks(file);let r=JSON.parse(fs.readFileSync(file,'utf8'));if(r.id+'.json'!==name)throw Error('Cleanup record identity mismatch');if(r.nativeVersion!==1){records.push({id:r.id,at:r.at,title:r.title,project:r.project,task:r.task,count:0,restored:false,recoveryRequired:true,error:'Legacy record has no native move evidence; review its retained files manually'});continue;}r=await this.recoverAsync(r);let count=0,restored=true,recoveryRequired=false,error=r.error;
  for(const e of r.entries){if(e.restored){const evidence=await require('./rooted-move').recover(e.nativeRestore);if(evidence.state!=='complete')throw Error('Native restore completion is unverified');count++;}else if(e.moved||e.moving){const evidence=await require('./rooted-move').recover(e.native);if(evidence.state==='complete'){count++;restored=false;}else{restored=false;recoveryRequired=true;error='Native cleanup needs recovery review: '+evidence.state;}}}
  records.push({id:r.id,at:r.at,title:r.title,project:r.project,task:r.task,count,restored:count>0&&restored,recoveryRequired,error});
 }
 return records.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100);
};
module.exports={Removal,snapshot,noLinks,inside,exists};
