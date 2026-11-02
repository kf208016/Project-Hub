'use strict';
// No listening port, IPC socket, CLI args, or inherited preload. The controller
// supplies exactly one bounded JSON request over its private child stdin.
const {ReviewedMerge}=require('./reviewed-merge');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {localPath}=require('./safe-path');
const LIMIT=4*1024*1024;let input='',overflow=false;
process.stdin.setEncoding('utf8');
process.stdin.on('data',data=>{input+=data;if(Buffer.byteLength(input)>LIMIT){overflow=true;input='';process.stdin.destroy();}});
async function run(){
  if(overflow)throw Error('Git worker 請求超過大小上限');
  const q=JSON.parse(input);
  if(!q||q.version!==1||!['preview','apply','receipt'].includes(q.method)||typeof q.verifyStore!=='boolean'||Object.keys(q).some(k=>!['version','method','root','descriptor','args','verifyStore'].includes(k))||!q.args||typeof q.args!=='object'||Array.isArray(q.args))throw Error('Git worker 請求格式無效');
  const {project,task}=q.args,d=q.descriptor;
  if(!d||d.project!==project||d.task!==task||Object.keys(d).some(k=>!['project','task','title','taskHash','dir','workRoot','target','forbiddenRoots'].includes(k)))throw Error('Git worker 作業關係無效');
  const canonical=x=>process.platform==='win32'?path.resolve(x).toLowerCase():path.resolve(x);
  const expand=x=>x?.startsWith('~/')?path.join(os.homedir(),x.slice(2)):x;
  const store=q.verifyStore?new (require('./store').Store)(q.root):null;
  const verify=()=>{
    if(!store)return d;
    const p=store.readProject(project),t=p?.tasks.find(x=>x.id===task);if(!t||t.mergeExcluded||t.completionHash!==d.taskHash||d.title!==t.id+' '+t.title)throw Error('Git worker 執行前作業已變更，請重新預覽');
    const expected=path.join(q.root,'Work',project),dir=expand(t.workdir)||path.join(expected,task),body=p.folders.find(x=>x.label==='本体');
    let base=body&&expand(body.path);if(base){localPath(base,{allowMissing:true});if(!fs.existsSync(base))base=null;}base=base||p.dir;
    if(canonical(d.workRoot)!==canonical(expected)||canonical(d.dir)!==canonical(dir)||canonical(d.target)!==canonical(base))throw Error('Git worker 作業路徑已變更，請重新預覽');
    return d;
  };
  const merge=new ReviewedMerge({root:q.root,resolve:verify});
  // Re-read the task before every host mutation, in addition to the fresh Git
  // metadata and content checks. The OS owner remains outside the threat model.
  if(store){const call=merge.call.bind(merge),move=merge.move;merge.call=(dir,args,skip)=>{if(['add','rm','commit','merge','worktree','branch','reset','checkout','restore'].includes(args[0]))verify();return call(dir,args,skip);};merge.move=(from,to)=>{verify();return move(from,to);};merge.beforeNativeMutation=verify;}
  if(q.method==='apply'){
    if(!q.args.entry||!Number.isSafeInteger(q.args.entry.at)||!q.args.entry.value||q.args.entry.value.project!==project||q.args.entry.value.task!==task)throw Error('Git worker 一次性確認無效');
    merge.tokens.set(q.args.token,q.args.entry);const {entry,...args}=q.args;return merge.applyAsync(args);
  }
  return merge[q.method==='preview'?'previewAsync':q.method==='receipt'?'receiptAsync':q.method](project,task);
}
process.stdin.on('end',async()=>{
  let result;try{result={version:1,ok:true,value:await run()};}catch(error){result={version:1,ok:false,error:String(error.message).slice(0,2000),...(require('./rooted-move').messageFor(error.code)?{code:error.code}:{})};}
  const output=JSON.stringify(result)+'\n';if(Buffer.byteLength(output)>LIMIT){process.stdout.write(JSON.stringify({version:1,ok:false,error:'Git worker 結果超過大小上限；請重新預覽持久交易狀態'})+'\n');return;}
  process.stdout.write(output);
});
