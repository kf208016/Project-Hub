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
    try {snapshot(f);if(this.referenced(f,p,t,all))throw Error('他の台帳・作業・会話から参照されています');d.optional.push({id:path.relative(p.dir,f),path:f,why:'この作業の専用フォルダ。必要な場合だけ選んでください'});}catch(e){d.keep.push({path:f,why:e.message});}
   }
  } else {
   if(p.id==='Project Hub'||p.name==='Project Hub'||path.dirname(p.dir)!==path.resolve(this.store.product))d.blockers.push('Project Hub自身やProductの外は削除できません');
   if(all.some(q=>q.id!==p.id&&(ref(q,q.parent)||ref(q,q.derivedFrom))))d.blockers.push('下に子プロジェクトや分岐があります。先に下のプロジェクトを整理してください');
   for(const q of all.filter(q=>q.id!==p.id)){
    for(const f of q.folders){const resolved=path.resolve(q.dir,expandHome(f.path));if(inside(p.dir,resolved))d.blockers.push(`「${q.name}」がこのフォルダ内を使っています`);}
    if(q.related.some(x=>ref(q,x)))d.warnings.push(`「${q.name}」の関連の記載は残り、リンク切れになります`);
   }
   try {noLinks(p.dir);let top;try{top=execFileSync('git',['-C',p.dir,'rev-parse','--show-toplevel'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch(e){if(e.status!==128)throw e;}
    if(top&&fs.realpathSync(top)!==fs.realpathSync(p.dir)) {const names=execFileSync('git',['-C',top,'ls-files','-z','--',p.dir],{encoding:'utf8'});if(names)d.blockers.push('外側のGitで追跡されています');}
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
module.exports={Removal,snapshot,noLinks,inside,exists};
