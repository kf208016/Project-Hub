'use strict';
// Local stdio app-server adapter. Only the authenticated Hub UI can answer
// server approval requests; model text and MCP calls are never approvals.
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cli = require('./cli-platform');
const managed = require('./managed-process');
const { localPath } = require('./safe-path');
const MAX_LINE = 4 * 1024 * 1024;
const APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
function fingerprint(file) {
  try { localPath(file,{allowMissing:true}); const st=fs.lstatSync(file); if (!st.isFile() || st.size>32*1024*1024) throw Error('unsupported'); return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch(e) { if (e.code==='ENOENT') return 'missing'; throw Error('檔案狀態無法確認'); }
}
function start(options) {
  localPath(options.cwd);
  const proc = new EventEmitter();
  let resolveReady;
  proc.ready=new Promise(resolve=>resolveReady=resolve);
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  const command = cli.resolve(options.command || 'codex', ['app-server','--listen','stdio://','-c','analytics.enabled=false'], options.env?.PATH);
  const transport = (options.spawn || managed.spawn)(command.file, command.args, { cwd: options.cwd, env: options.env, stdio:['pipe','pipe','pipe'], windowsHide:true, ...(options.dirPin?{dirPin:options.dirPin}:{}) });
  let sequence=0, threadId='', turnId='', buffer='', prompt='', finished=false, closed=false, stopped=false, inputReady;
  let startup, usage, succeeded=false;
  const textItems = new Map();
  const pending=new Map(), approvals=new Map(), items=new Map();
  const send = message => { if(closed || transport.stdin.destroyed) throw Error('Codex 通道已關閉'); transport.stdin.write(JSON.stringify(message)+'\n'); };
  const output = event => { if(!closed) proc.stdout.write(JSON.stringify(event)+'\n'); };
  const publish = () => proc.emit('approvals', proc.listApprovals());
  const cleanupApprovals = () => { for(const entry of approvals.values()) clearTimeout(entry.timer); approvals.clear(); publish(); };
  const fail = message => {
    if(finished || closed) return;
    finished=true; resolveReady(false); output({type:'turn.failed',error:{message}}); cleanupApprovals(); transport.kill();
  };
  const request = (method,params) => new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('Codex 協定請求逾時：'+method));},options.requestTimeout || 30000);
    pending.set(id,{resolve,reject,timer});
    try {send({id,method,params});} catch(e) {clearTimeout(timer);pending.delete(id);reject(e);}
  });
  const deny = entry => entry.method==='item/permissions/requestApproval' ? {permissions:{},scope:'turn'} : entry.method==='item/tool/requestUserInput' ? {answers:{}} : {decision:'decline'};
  proc.listApprovals = () => [...approvals.values()].map(x=>x.public);
  proc.respond = (token,decision,answers) => {
    const entry=approvals.get(token);
    if(!entry || entry.public.expiresAt<=Date.now() || entry.threadId!==threadId || (turnId && entry.turnId!==turnId)) throw Error('授權要求已過期或不屬於目前回合');
    if(!['accept','decline','cancel','answer'].includes(decision)) throw Error('不支援的授權決定');
    let result;
    if(entry.method==='item/tool/requestUserInput') {
      if(decision==='answer') {
        if(!answers || typeof answers!=='object' || Array.isArray(answers)) throw Error('回答格式錯誤');
        result={answers:Object.create(null)};
        for(const question of entry.params.questions) {
          const value=answers[question.id]; if(typeof value!=='string' || !value.trim() || value.length>10000) throw Error('請填寫所有問題');
          result.answers[question.id]={answers:[value]};
        }
      } else if(decision==='cancel' || decision==='decline') result={answers:{}};
      else throw Error('此要求需要填寫回答');
    } else {
      if(decision==='answer') throw Error('此要求需要允許或拒絕');
      if(decision==='accept') for(const [file,hash] of entry.files) if(fingerprint(file)!==hash) throw Error('檔案已變更，不能套用過期的授權預覽；請拒絕後重新產生');
      result=entry.method==='item/permissions/requestApproval' ? {permissions:decision==='accept'?entry.params.permissions:{},scope:'turn'} : {decision};
    }
    // Consume once before any response is delivered; caller records the decision first.
    approvals.delete(token); clearTimeout(entry.timer); send({id:entry.id,result}); publish();
    if(decision==='cancel') proc.kill();
    return true;
  };
  const approval = message => {
    const p=message.params;
    if((typeof message.id!=='string' && !Number.isSafeInteger(message.id)) || (typeof message.id==='string' && (!message.id || message.id.length>256))) return fail('Codex 授權要求識別無效');
    if(!APPROVAL_METHODS.has(message.method)) { send({id:message.id,error:{code:-32601,message:'Unsupported Hub client request'}}); return; }
    if(!p || p.threadId!==threadId || typeof p.turnId!=='string' || !p.turnId || (turnId && p.turnId!==turnId) || typeof p.itemId!=='string') return fail('Codex 授權要求的回合識別無效');
    if(approvals.size>=16 || [...approvals.values()].some(x=>x.id===message.id)) return fail('Codex 授權要求重複或超過上限');
    const token=randomUUID(), expiresAt=Date.now()+(options.approvalTimeout || 10*60*1000);
    const entry={id:message.id,method:message.method,params:p,threadId:p.threadId,turnId:p.turnId,itemId:p.itemId,files:[]};
    let detail, questions;
    if(message.method==='item/fileChange/requestApproval') {
      const changes=items.get(p.itemId)?.changes;
      if(!Array.isArray(changes) || !changes.length || changes.some(x=>!x||typeof x.path!=='string'||!x.path||typeof x.diff!=='string'||!['add','delete','update'].includes(x.kind?.type)||
        (x.kind.move_path!=null && (x.kind.type!=='update'||typeof x.kind.move_path!=='string'||!x.kind.move_path)))) return fail('Codex 未提供完整的檔案變更預覽，未授權執行');
      try {entry.files=changes.flatMap(x=>[x.path,...(x.kind.move_path?[x.kind.move_path]:[])].map(p=>{const file=path.resolve(options.cwd,p);return [file,fingerprint(file)];}));} catch(e) {return fail(e.message);}
      detail=changes.map(x=>x.kind.type+': '+path.resolve(options.cwd,x.path)+(x.kind.move_path?'\n移動目的地：'+path.resolve(options.cwd,x.kind.move_path):'')+'\n'+x.diff).join('\n\n');
    } else if(message.method==='item/tool/requestUserInput') {
      questions=p.questions;
      if(!Array.isArray(questions) || !questions.length || questions.length>8 || questions.some(q=>!q || typeof q.id!=='string'||!q.id||q.id.length>256||typeof q.question!=='string'||q.question.length>10000||
        (q.options!=null && (!Array.isArray(q.options)||q.options.length>32||q.options.some(x=>!x||typeof x.label!=='string'||typeof x.description!=='string'||x.label.length>1000||x.description.length>10000)))) || new Set(questions.map(q=>q.id)).size!==questions.length) return fail('Codex 問題格式無效');
      detail='請回答後繼續';
    } else if(message.method==='item/permissions/requestApproval') {
      if(!p.permissions || typeof p.permissions!=='object' || Array.isArray(p.permissions)) return fail('Codex 權限格式無效');
      detail='權限僅授予目前回合：\n'+JSON.stringify(p.permissions,null,2);
    } else {
      if(typeof p.command!=='string' && !p.networkApprovalContext) return fail('Codex 未提供可審閱的命令或網路目的地');
      detail=[p.command,p.cwd && '工作目錄：'+p.cwd,p.networkApprovalContext && JSON.stringify(p.networkApprovalContext)].filter(Boolean).join('\n');
    }
    if(detail.length>MAX_LINE/2) return fail('Codex 授權預覽超過上限，未授權執行');
    entry.public={token,kind:message.method,reason:typeof p.reason==='string'?p.reason:'',detail,questions,expiresAt};
    entry.timer=setTimeout(()=>{if(!approvals.has(token))return; approvals.delete(token); try{send({id:entry.id,result:deny(entry)});}catch{} publish();},Math.max(1,expiresAt-Date.now()));
    approvals.set(token,entry); publish();
  };
  const receive = m => {
    if(finished||stopped||closed)return;
    if(!m || typeof m!=='object') return fail('Codex 協定格式無效');
    if(m.method && m.id!==undefined) return approval(m);
    if(m.id!==undefined) {
      const call=pending.get(m.id); if(!call)return;
      pending.delete(m.id);clearTimeout(call.timer);
      if(m.error) call.reject(Error('Codex 協定要求失敗（'+String(m.error.code || 'unknown')+'）'));
      else call.resolve(m.result);
      return;
    }
    const p=m.params || {};
    if(p.threadId && p.threadId!==threadId) return;
    if(m.method==='turn/started' && p.turn?.id) turnId=p.turn.id;
    if(m.method==='item/started' && p.item?.id) items.set(p.item.id,p.item);
    if(m.method==='item/fileChange/patchUpdated') {
      if(typeof p.itemId!=='string'||!Array.isArray(p.changes))return fail('Codex 檔案預覽更新格式無效');
      if([...approvals.values()].some(x=>x.itemId===p.itemId))return fail('待核准的檔案預覽已變更；本次授權作廢，請重新產生');
      items.set(p.itemId,{id:p.itemId,type:'fileChange',changes:p.changes});
    }
    if(m.method==='item/completed') {
      const item=p.item;
      if(item?.type==='agentMessage' && typeof item.text==='string') { textItems.set(item.id,item.text); output({type:'hub.agent_snapshot',id:item.id,text:item.text}); }
      else if(item?.type==='commandExecution') output({type:'item.completed',item:{type:'command_execution',command:item.command,status:item.status}});
      else if(item?.type==='fileChange') output({type:'item.completed',item:{type:'file_change',changes:item.changes}});
      if(item?.id) items.delete(item.id);
    }
    if(m.method==='item/agentMessage/delta') {
      if(typeof p.itemId!=='string'||typeof p.delta!=='string') return fail('Codex 文字串流格式無效');
      const text=(textItems.get(p.itemId)||'')+p.delta;
      if(Buffer.byteLength(text)>32*1024*1024) return fail('Codex 回覆超過上限');
      textItems.set(p.itemId,text); output({type:'hub.agent_snapshot',id:p.itemId,text});
    }
    if(m.method==='thread/tokenUsage/updated' && (!turnId || p.turnId===turnId)) {
      const last=p.tokenUsage?.last;
      if(last) usage={input_tokens:last.inputTokens,cached_input_tokens:last.cachedInputTokens};
    }
    if(m.method==='turn/completed') {
      if(!p.turn || (turnId && p.turn.id!==turnId)) return fail('Codex 完成事件的回合識別無效');
      finished=true; cleanupApprovals();
      if(p.turn.status==='completed') { succeeded=true; output({type:'turn.completed',usage}); }
      else output({type:'turn.failed',error:{message:typeof p.turn.error?.message==='string'?p.turn.error.message.slice(0,4000):'Codex 回合未完成（'+String(p.turn.status || 'unknown')+'）'}});
      transport.stdin.end();
    }
  };
  proc.kill = signal => { stopped=true;resolveReady(false);cleanupApprovals();return transport.kill(signal); };
  proc.stdin.setEncoding('utf8');
  proc.stdin.on('data',chunk=>{prompt+=chunk;if(Buffer.byteLength(prompt)>32*1024*1024)fail('輸入超過上限');});
  const input=new Promise(resolve=>{inputReady=resolve;}); proc.stdin.on('end',()=>inputReady());
  transport.stdout.setEncoding('utf8');
  transport.stdout.on('data',data=>{
    buffer+=data;
    if(Buffer.byteLength(buffer)>MAX_LINE) return fail('Codex 協定輸出超過上限');
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines) {if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch{return fail('Codex 回傳破損 JSON');}try{receive(m);}catch{return fail('Codex 協定處理失敗');}}
  });
  transport.stderr.on('data',data=>proc.stderr.write(data));
  transport.stdin.on('error',()=>fail('Codex 輸入通道中斷'));
  transport.on('error',error=>proc.emit('error',error));
  transport.on('spawn',()=>{
    proc.pid=transport.pid; proc.commandPid=transport.commandPid; proc.emit('spawn');
    startup=(async()=>{
      await request('initialize',{clientInfo:{name:'project_hub',version:'4.68.2'},capabilities:{experimentalApi:false}});
      send({method:'initialized',params:{}});await input;if(stopped||finished)return;
      // Verify the exact requested model before creating a turn; never silently
      // substitute a different paid model when stale Hub labels no longer work.
      if(options.model) {
        let cursor=null, found=false;
        for(let page=0;page<10;page++) {
          const catalog=await request('model/list',{limit:100,...(cursor?{cursor}:{})});
          if(!Array.isArray(catalog?.data))throw Error('Codex 模型列表格式無效');
          found=catalog.data.some(x=>x.model===options.model || x.id===options.model);
          if(found||!catalog.nextCursor)break;
          if(catalog.nextCursor===cursor)throw Error('Codex 模型列表分頁無效');cursor=catalog.nextCursor;
        }
        if(!found)throw Error('Codex model is not available：'+options.model+'；請更新模型列表並重新選擇');
      }
      const config={'sandbox_workspace_write.writable_roots':[],'sandbox_workspace_write.network_access':false,'sandbox_workspace_write.exclude_tmpdir_env_var':true,'sandbox_workspace_write.exclude_slash_tmp':true,'windows.sandbox':'elevated'};
      const settings={cwd:options.cwd,model:options.model || null,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'workspace-write',config};
      const opened=await request(options.sessionId?'thread/resume':'thread/start',options.sessionId?{...settings,threadId:options.sessionId}:settings);
      const samePath=(a,b)=>typeof a==='string' && path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
      if(opened?.approvalPolicy!=='on-request'||opened.approvalsReviewer!=='user'||opened.sandbox?.type!=='workspaceWrite'||opened.sandbox.networkAccess!==false||
          opened.sandbox.excludeTmpdirEnvVar!==true||opened.sandbox.excludeSlashTmp!==true||
          !Array.isArray(opened.sandbox.writableRoots)||opened.sandbox.writableRoots.some(p=>!samePath(p,options.cwd))||!samePath(opened.cwd,options.cwd)||typeof opened.model!=='string'||!opened.model||(options.model&&opened.model!==options.model)) {
        throw Error('Codex 回報的模型、工作目錄或權限與要求不符；未送出模型回合');
      }
      threadId=opened?.thread?.id;
      if(typeof threadId!=='string'||!threadId)throw Error('Codex 未提供會話識別');
      output({type:'thread.started',thread_id:threadId});
      const inputRows=[{type:'text',text:prompt},...(options.images || []).map(file=>({type:'localImage',path:file}))];
      const turn=await request('turn/start',{threadId,input:inputRows,cwd:options.cwd,model:options.model || null,effort:options.effort || null,approvalPolicy:'on-request',approvalsReviewer:'user',sandboxPolicy:{type:'workspaceWrite',writableRoots:[options.cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
      if(typeof turn?.turn?.id!=='string'||!turn.turn.id)throw Error('Codex 未確認接收本次回合');
      turnId=turn.turn.id;resolveReady(true);
    })().catch(e=>fail(e.message));
  });
  transport.on('close',(code,signal)=>{
    resolveReady(false);
    if(!finished&&!stopped) output({type:'turn.failed',error:{message:'Codex 連線在完成前中斷'}});
    closed=true;cleanupApprovals();for(const call of pending.values()){clearTimeout(call.timer);call.reject(Error('Codex 通道已關閉'));}pending.clear();
    proc.stdout.end();proc.stderr.end();proc.stdin.destroy();
    proc.exitCode=finished&&!stopped?(succeeded?0:1):code;proc.emit('close',proc.exitCode,finished&&!stopped?null:signal);
  });
  return proc;
}
module.exports={start};
