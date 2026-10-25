'use strict';
// Minimal owner-only recovery server. It never constructs the normal Store,
// Completion ledger, CLI runners, model refreshers or remote listeners.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {localPath}=require('./safe-path'),{parseDoc}=require('./frontmatter');
const {WebChat}=require('./web-chat'),locks=require('./task-write-lock');
const admissionTool=require('./web-chat-admission');
const {readSmallJson}=require('./small-json-body'),{BrowserLoginFSM}=require('./browser-login'),{isRemote}=require('./remote');
const scalarName=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&value.isWellFormed()&&!/[\\/\0<>:"|?*\x00-\x1f]/.test(value)&&!['.','..'].includes(value)&&!/[. ]$/.test(value);
function readonlyStore(root){
 const checked=(file,max=4*1024*1024)=>{localPath(file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>max)throw Error('RECOVERY_SOURCE_INVALID');return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));};
 const projectDir=id=>{if(!scalarName(id))return null;const dir=path.join(root,'Product',id);try{localPath(dir);localPath(path.join(dir,'PROJECT.md'));return dir;}catch{return null;}};
 const taskFile=(project,task)=>{const dir=projectDir(project);if(!dir||!scalarName(task))return null;const file=path.join(dir,'.ai/tasks',task+'.md');try{localPath(file);return file;}catch{return null;}};
 const listProjects=()=>{
  const product=path.join(root,'Product');localPath(product);const names=fs.readdirSync(product);if(names.length>10000)throw Error('RECOVERY_SOURCE_LIMIT');let total=0;
  return names.filter(scalarName).map(id=>{const dir=projectDir(id);if(!dir)return null;const text=checked(path.join(dir,'PROJECT.md'));total+=Buffer.byteLength(text);if(total>64*1024*1024)throw Error('RECOVERY_SOURCE_LIMIT');const data=parseDoc(text).data;
   let taskNames=[];const folder=path.join(dir,'.ai/tasks');if(fs.existsSync(folder)){localPath(folder);taskNames=fs.readdirSync(folder);if(taskNames.length>10000)throw Error('RECOVERY_SOURCE_LIMIT');}
   // The task being repaired may have incomplete UTF-8 or frontmatter. Never
   // require its damaged bytes to parse before restoring accepted bytes.
   const tasks=taskNames.filter(name=>name.endsWith('.md')).map(name=>{const taskId=name.slice(0,-3),file=taskFile(id,taskId);return file?{id:taskId,workdir:path.join(root,'Work',id,taskId)}:null;}).filter(Boolean);
   return {id,dir,folders:data.folders&&typeof data.folders==='object'&&!Array.isArray(data.folders)?data.folders:{},tasks};
  }).filter(Boolean);
 };
 return {root,projectDir,taskFile,listProjects};
}
function create({root,hubDir,port,secret,admission}){
 if(!admission?.recoveryOnly)throw Error('RECOVERY_ADMISSION_REQUIRED');
 const auth=require('./local-auth').create(secret),store=readonlyStore(root);
 let descriptors=[];
 const watcher=require('./procwatch').create({projects:()=>descriptors,baseOf:project=>{const main=project.folders?.['本体'];return typeof main==='string'?require('./store').expandHome(main):project.dir;}});
 const service=new WebChat({root,store,
  lock:(project,task,operation,receiptId)=>{const dir=store.projectDir(project);if(!dir)throw Error('RECOVERY_SOURCE_INVALID');return locks.run(dir,task,operation,{receiptId});},
  hold:(project,task,receiptId)=>locks.hold(store.projectDir(project),task,receiptId),release:(project,task,receiptId)=>locks.release(store.projectDir(project),task,receiptId),
  busy:async(project,task,authority)=>{descriptors=store.listProjects();if(authority?.receiptId){const record=(await service.receipts.read(authority.receiptId)).value;if(record.transaction){const before=await service.receipts.readBlob(record.transaction.taskBeforeBlob,4*1024*1024),meta=parseDoc(before).data,p=descriptors.find(item=>item.id===project),t=p?.tasks.find(item=>item.id===task);if(t&&typeof meta.workdir==='string'&&meta.workdir)t.workdir=meta.workdir;}}await watcher.scan();watcher.assertKnown();return watcher.list().some(row=>row.project===project&&(!row.task||row.task===task));}
 });
 const scopeKeys=['actor','project','task','receiptId'];
 const write=(res,status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
 const body=req=>new Promise((resolve,reject)=>{const chunks=[];let count=0;req.on('data',chunk=>{count+=chunk.length;if(count>1024*1024){reject(Error('RECOVERY_REQUEST_TOO_LARGE'));req.destroy();}else chunks.push(chunk);});req.on('error',reject);req.on('end',()=>{try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();resolve(value);}catch{reject(Error('RECOVERY_REQUEST_INVALID'));}});});
 let browserLogin;
 const browserLoginRoutes=new Set(['/api/local/browser/begin','/api/local/browser/poll','/api/local/browser/approve']);
 const server=http.createServer(async(req,res)=>{
  try{
   const actualPort=server.address()?.port||port,hosts=[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`];
   if(!hosts.includes(req.headers.host)||isRemote(req)||req.headers.authorization!==undefined)return write(res,403,{error:'復原入口僅限本機使用者'});
   const url=new URL(req.url,'http://127.0.0.1:'+actualPort),route=url.pathname;
   if(!admissionTool.restrictRoutes(route,req.method))return write(res,409,{error:'復原模式只允許查詢及復原已接受的交接；一般作業未啟動',code:'RECOVERY_ONLY'});
   if(req.method==='POST'&&(req.headers['x-hub']!=='1'||req.headers.origin&&!hosts.map(host=>'http://'+host).includes(req.headers.origin)))return write(res,403,{error:'復原操作來源無效'});
   if(browserLoginRoutes.has(route)){
    if(!browserLogin)browserLogin=require('./browser-login-http').create({auth,port:actualPort,readBody:readSmallJson,send:(response,status,value)=>write(response,status,value),fsm:new BrowserLoginFSM()});
    if(await browserLogin.handle(req,res,url))return;
   }
   if(req.method==='GET'&&route==='/local-auth.js'&&!url.search)return write(res,200,fs.readFileSync(path.join(hubDir,'public/local-auth.js')),'text/javascript; charset=utf-8');
   if(req.method==='GET'&&route==='/api/local/proof'){try{return write(res,200,{proof:auth.proof(url.searchParams.get('challenge'))});}catch{return write(res,400,{error:'復原身分挑戰格式無效'});}}
   if(req.method==='POST'&&route==='/api/local/login'){const input=await body(req);if(Object.keys(input).length!==1||!auth.login(input.token))return write(res,403,{error:'復原登入失敗'});res.setHeader('Set-Cookie',auth.cookie);return write(res,200,{ok:true});}
   if(req.method==='GET'&&route==='/')return write(res,200,fs.readFileSync(path.join(hubDir,'public/web-chat-recovery.html'),'utf8'),'text/html; charset=utf-8');
   if(req.method==='GET'&&route==='/api/state')return write(res,200,{recoveryOnly:true,mode:'recovery-only',format:admission.format,transactionsAtStartup:admission.pending.length,inspectionCount:admission.inspection?.length||0});
   if(req.method==='GET'&&route==='/api/web-chat/inspection'){
    const offsetText=url.searchParams.get('offset')||'0';if([...url.searchParams.keys()].some(key=>key!=='offset')||url.searchParams.getAll('offset').length>1||!/^\d{1,5}$/.test(offsetText))return write(res,400,{error:'復原清單頁碼無效'});
    const offset=Number(offsetText),total=Math.max(admission.pending.length,admission.inspection?.length||0);if(offset>total)return write(res,400,{error:'復原清單頁碼超出範圍'});
    const records=[];for(const item of admission.pending.slice(offset,offset+100)){try{const saved=await service.receipts.read(item.receiptId),record=saved.value;if(record.ownerHash!==crypto.createHash('sha256').update('windows-hub-owner').digest('hex')||['committed','revoked'].includes(record.state))continue;records.push({receiptId:record.receiptId,actor:record.actor,project:record.project,task:record.task,state:record.state});}catch{records.push({receiptId:item.receiptId,repairable:false,reasonCode:'RECEIPT_UNVERIFIED'});}}
    return write(res,200,{recoveryOnly:true,records,inspection:(admission.inspection||[]).slice(offset,offset+100),offset,previousOffset:offset?Math.max(0,offset-100):null,nextOffset:offset+100<total?offset+100:null,truncated:offset+100<total});
   }
   if(req.method==='POST'&&route==='/api/quit'){if(locks.active()||require('./web-handoff-writer').active())return write(res,409,{error:'復原寫入仍在進行，請等待私有 helper 退出'});write(res,200,{ok:true});setTimeout(()=>server.close(()=>{if(require.main?.filename===path.join(hubDir,'server.js'))process.exit(0);}),30);return;}
   const methods={'/api/web-chat/status':'status','/api/web-chat/recover/preview':'recoverPreview','/api/web-chat/recover':'recover'},method=methods[route];
   if(!method||!['GET','POST'].includes(req.method)||req.method==='GET'&&method!=='status'||url.search)return write(res,404,{error:'此復原入口不存在'});
   let input;if(req.method==='GET'){try{input=JSON.parse(decodeURIComponent(req.headers['x-hub-web-receipt']||''));}catch{return write(res,400,{error:'交易查詢範圍無效'});}}else input=await body(req);
   const keys=method==='recover'?[...scopeKeys,'confirm','recoveryToken','expectedRecoverySHA256']:scopeKeys;
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))return write(res,400,{error:'復原請求欄位無效'});
   const result=await service[method]({...input,owner:'windows-hub-owner'});return write(res,result.partial?409:200,result);
  }catch(error){return write(res,[400,403,404,409,413].includes(error.status)?error.status:409,{error:'復原未完成；資料與紀錄保留',code:error.code||'RECOVERY_UNVERIFIED'});}
 });
 return {server,PORT:port,webChat:service,recoveryOnly:true};
}
module.exports={create,readonlyStore};
