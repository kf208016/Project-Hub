'use strict';
const fs=require('node:fs'),path=require('node:path');
function install(bin,options={}) {
  const entry=path.join(bin,'node_modules','@openai','codex','bin','codex.js');fs.mkdirSync(path.dirname(entry),{recursive:true});
  fs.writeFileSync(path.join(bin,'codex.cmd'),'@echo off\r\nexit /b 99\r\n');
  fs.writeFileSync(entry,`const o=${JSON.stringify(options)};const out=m=>console.log(JSON.stringify(m));let buffer='',settings,turn;
function done(decision){
 const text=o.echo?JSON.stringify({args:process.argv.slice(2),settings,turn,decision}):'fixture reply';
 if(o.mode==='stream'){for(const delta of ['fixture ','reply'])out({method:'item/agentMessage/delta',params:{threadId:'fixture',turnId:'turn1',itemId:'answer',delta}});out({method:'thread/tokenUsage/updated',params:{threadId:'fixture',turnId:'turn1',tokenUsage:{last:{inputTokens:100,cachedInputTokens:20}}}});}
 out({method:'item/completed',params:{threadId:'fixture',turnId:'turn1',item:{id:'answer',type:'agentMessage',text}}});
 if(o.mode==='incomplete')return process.exit(0);
 out({method:'turn/completed',params:{threadId:'fixture',turn:{id:'turn1',status:'completed'}}});
}
process.stdin.setEncoding('utf8');process.stdin.on('end',()=>process.exit(0));process.stdin.on('data',data=>{buffer+=data;let lines=buffer.split('\\n');buffer=lines.pop();for(const line of lines){if(!line)continue;const m=JSON.parse(line);
 if(m.method==='initialize')out({id:m.id,result:{}});
 if(m.method==='model/list')out({id:m.id,result:{data:o.mode==='missing-model'?[]:[{id:'fixture-model',model:'fixture-model'},{id:'gpt-6.1-sol',model:'gpt-6.1-sol'}],nextCursor:null}});
 if(m.method==='thread/start'||m.method==='thread/resume'){settings=m.params;out({id:m.id,result:{thread:{id:'fixture'},cwd:m.params.cwd,model:m.params.model||'fixture-default',approvalPolicy:'on-request',approvalsReviewer:o.mode==='wrong-reviewer'?'auto_review':'user',sandbox:{type:o.mode==='wrong-sandbox'?'dangerFullAccess':'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:o.mode!=='wrong-temp-policy',excludeSlashTmp:true}}});}
 if(m.method==='turn/start'){turn=m.params;out({id:m.id,result:{turn:{id:'turn1'}}});out({method:'turn/started',params:{threadId:'fixture',turn:{id:'turn1'}}});
  if(o.mode==='approval'||o.mode==='wrong-thread')out({id:70,method:'item/commandExecution/requestApproval',params:{threadId:o.mode==='wrong-thread'?'other':'fixture',turnId:'turn1',itemId:'cmd1',command:'synthetic command & literal',cwd:m.params.cwd,reason:'fixture'}});
  else if(['file','file-move','file-updated'].includes(o.mode)){const changes=[{path:'review.txt',kind:{type:'update',move_path:o.mode==='file-move'?'destination.txt':null},diff:'-before\\n+after'}];out({method:'item/started',params:{threadId:'fixture',turnId:'turn1',item:{id:'file1',type:'fileChange',changes:[]}}});out({method:'item/fileChange/patchUpdated',params:{threadId:'fixture',turnId:'turn1',itemId:'file1',changes}});out({id:70,method:'item/fileChange/requestApproval',params:{threadId:'fixture',turnId:'turn1',itemId:'file1'}});if(o.mode==='file-updated')out({method:'item/fileChange/patchUpdated',params:{threadId:'fixture',turnId:'turn1',itemId:'file1',changes}});}
  else if(o.mode==='failure-then-success'){out({method:'turn/completed',params:{threadId:'fixture',turn:{id:'turn1',status:'failed',error:{message:'fixture failure'}}}});done();}
  else if(o.mode==='question')out({id:70,method:'item/tool/requestUserInput',params:{threadId:'fixture',turnId:'turn1',itemId:'question1',questions:[{id:'q1',question:'Synthetic question',options:[]}]}});
  else if(o.mode==='broken-question')out({id:70,method:'item/tool/requestUserInput',params:{threadId:'fixture',turnId:'turn1',itemId:'question1',questions:[{id:'q1',question:'Synthetic question',options:{label:'invalid'}}]}});
  else if(o.mode==='broken-request-id')out({id:{nested:'invalid'},method:'item/commandExecution/requestApproval',params:{threadId:'fixture',turnId:'turn1',itemId:'cmd1',command:'synthetic'}});
  else if(o.mode==='permissions')out({id:70,method:'item/permissions/requestApproval',params:{threadId:'fixture',turnId:'turn1',itemId:'permission1',permissions:{network:{enabled:true}}}});
  else if(o.mode==='malformed'){console.log('broken JSON');}
  else setTimeout(done,o.delay||0);
 }
 if(m.id===70 && m.result)done(m.result.decision||m.result);
}});
`);
  return entry;
}
module.exports={install};
