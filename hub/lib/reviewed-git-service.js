'use strict';
// A private, owned worker keeps expensive, freshly checked Git operations off
// the HTTP event loop. One-time browser grants stay in the parent only. This
// transports the existing transaction; it does not cache Git trust decisions.
const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const managed=require('./managed-process');
const {ReviewedMerge}=require('./reviewed-merge');
const LIMIT=4*1024*1024,TTL=600000;
const canonical=x=>process.platform==='win32'?path.resolve(x).toLowerCase():path.resolve(x);
function workerEnvironment() {
  const env={};
  for(const key of ['PATH','Path','SystemRoot','WINDIR','ProgramFiles','ProgramFiles(x86)','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','TEMP','TMP','LANG','LC_ALL'])if(process.env[key]!==undefined)env[key]=process.env[key];
  for(const key of Object.keys(process.env))if(/^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/.test(key))env[key]=process.env[key];
  // Preserve the documented fixture autocrlf override, never arbitrary Git env.
  for(let n=0;n<Math.min(Number(process.env.GIT_CONFIG_COUNT)||0,100);n++)if(process.env['GIT_CONFIG_KEY_'+n]==='core.autocrlf'&&/^(true|false|input)$/.test(process.env['GIT_CONFIG_VALUE_'+n]||''))Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.autocrlf',GIT_CONFIG_VALUE_0:process.env['GIT_CONFIG_VALUE_'+n]});
  return env;
}
class ReviewedGitService {
  constructor({root,resolve,busy=()=>false,now=Date.now,spawn=managed.spawn,timeoutMs=600000,verifyStore=false}) {
    if(typeof resolve!=='function'||typeof busy!=='function'||typeof now!=='function'||typeof spawn!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>1800000)throw Error('Git worker 設定無效');
    if(typeof verifyStore!=='boolean')throw Error('Git worker store 檢查設定無效');
    this.reader=new ReviewedMerge({root,resolve,busy,now});Object.assign(this,{root:this.reader.root,resolve,busy,now,spawn,timeoutMs,verifyStore});this.tokens=new Map();this.operations=new Map();this.closed=false;
  }
  active(){return this.operations.size;}
  pending(dir){if(!dir||!this.operations.size)return false;const key=canonical(dir),rows=[...this.operations.values()];if(rows.some(x=>[x.target,x.dir].filter(Boolean).some(y=>canonical(y)===key)))return true;let common;try{common=canonical(this.reader.common(dir));}catch(error){if(error.status===128&&/not a git repository/i.test(String(error.stderr)))return false;throw error;}return rows.some(x=>x.common===common);}
  locked(dir){return this.pending(dir)||this.reader.locked(dir);}
  recovery(project,task){return this.reader.recovery(project,task);}
  async preview(project,task){
    const descriptor=this.descriptor(project,task);
    const result=await this.invoke('preview',{project,task},descriptor);
    // Task metadata may change during preview; never issue a stale consent.
    if(JSON.stringify(this.resolve(project,task))!==JSON.stringify(descriptor))throw Error('預覽期間作業或路徑已變更，請重新預覽');
    const at=this.now();for(const [id,x]of this.tokens)if(at<x.at||at-x.at>TTL)this.tokens.delete(id);
    if(this.tokens.size>=128)throw Error('Git 預覽過多，請等候舊預覽到期');
    const token=randomUUID(),{token:unused,...value}=result;this.tokens.set(token,{at,value});return {...value,token};
  }
  async apply(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['project','task','token','confirm','skipHooks'].includes(k))||input.skipHooks!==undefined&&typeof input.skipHooks!=='boolean')throw Error('合併確認格式無效');
    const entry=this.tokens.get(input.token);this.tokens.delete(input.token);
    const at=this.now();if(!entry||input.confirm!==true||entry.value.project!==input.project||entry.value.task!==input.task||at<entry.at||at-entry.at>TTL)throw Error('請重新預覽並明確確認這項合併');
    const descriptor=this.descriptor(input.project,input.task);
    return this.invoke('apply',{...input,entry},descriptor);
  }
  async receipt(project,task){return this.invoke('receipt',{project,task},this.descriptor(project,task));}
  descriptor(project,task){
    if(this.closed)throw Error('Git worker 已停止');
    const d=this.resolve(project,task);if(!d||d.project!==project||d.task!==task)throw Error('Git 作業關係無效');
    if(this.pending(d.target)||this.pending(d.dir)||this.busy(project,task,d.target))throw Error('AI 或其他整理／Git 操作正在執行，請先等它結束');
    Object.defineProperty(d,'common',{value:canonical(this.reader.common(d.target)),enumerable:false});return d;
  }
  invoke(method,args,descriptor){
    if(this.closed)return Promise.reject(Error('Git worker 已停止'));
    const id=randomUUID(),request=JSON.stringify({version:1,method,root:this.root,descriptor,args,verifyStore:this.verifyStore})+'\n';
    if(Buffer.byteLength(request)>LIMIT)return Promise.reject(Error('Git worker 請求超過大小上限'));
    // Install the pending gate before spawning: the server may continue serving
    // reads, but it must reject all same-repo AI/Git/cleanup metadata mutations.
    this.operations.set(id,{...descriptor,common:descriptor.common});
    return new Promise((resolve,reject)=>{
      let child,timer,stdout='',stderr='',message=null,protocolError=null,settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);this.operations.delete(id);if(error)reject(error);else resolve(message.value);};
      try{child=this.spawn(process.execPath,[path.join(__dirname,'reviewed-git-worker.js')],{cwd:path.join(__dirname,'..'),env:workerEnvironment(),stdio:['pipe','pipe','pipe'],windowsHide:true});}
      catch(error){finish(error);return;}
      this.operations.get(id).child=child;
      const fail=message=>{protocolError=Error(message);child.kill();};
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>LIMIT)return fail('Git worker 回應超過大小上限');});
      child.stderr.on('data',data=>{stderr+=data;if(Buffer.byteLength(stderr)>16384)fail('Git worker 診斷超過大小上限');});
      child.on('error',error=>{protocolError=Error('Git worker 啟動／通道失敗；交易是否已部分完成需重新預覽');child.kill();});
      child.on('close',(code)=>{
        if(protocolError)return finish(protocolError);
        try{if(code!==0)throw Error('Git worker 未正常結束；請重新預覽持久交易狀態');message=JSON.parse(stdout);if(!message||message.version!==1||typeof message.ok!=='boolean'||Object.keys(message).some(k=>!['version','ok','value','error','code'].includes(k)))throw Error('Git worker 協定無效');if(message.code!==undefined&&!require('./rooted-move').messageFor(message.code))throw Error('Git worker 協定無效');if(!message.ok)throw Object.assign(Error(typeof message.error==='string'?message.error:'Git worker 拒絕請求'),message.code?{code:message.code}:{});if(!Object.hasOwn(message,'value'))throw Error('Git worker 缺少結果');finish();}catch(error){finish(error);}
      });
      timer=setTimeout(()=>fail('Git worker 逾時；已停止此 Hub 擁有的程序樹，請重新預覽持久交易狀態'),this.timeoutMs);
      child.stdin.end(request);
    });
  }
  stop(){if(this.active())throw Error('Git 交易仍在執行，請等候持久記錄完成');this.closed=true;this.tokens.clear();}
}
module.exports={ReviewedGitService,workerEnvironment};
