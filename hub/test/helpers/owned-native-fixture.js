'use strict';
// Owned synthetic providers only. Git and Windows helpers remain real; the
// provider inventory does not consult the user's installed AI executables.
const fs=require('node:fs'),path=require('node:path');
function provider(root,options={}) {
 const bin=path.join(root,'fixture-bin'),entry=path.join(bin,'node_modules/@openai/codex/bin/codex.js');fs.mkdirSync(path.dirname(entry),{recursive:true});
 fs.writeFileSync(path.join(bin,'codex.cmd'),'@echo off\r\nexit /b 99\r\n');
 fs.writeFileSync(entry,`const fs=require('node:fs'),o=${JSON.stringify(options)};let buffer='',settings,turn;const out=x=>console.log(JSON.stringify(x));
 if(o.count)fs.appendFileSync(o.count,'1\\n');
 process.stdin.setEncoding('utf8');process.stdin.on('end',()=>process.exit(0));process.stdin.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\\n');buffer=lines.pop();for(const line of lines){if(!line)continue;const m=JSON.parse(line);
 if(m.method==='initialize')out({id:m.id,result:{}});
 if(m.method==='model/list')out({id:m.id,result:{data:(o.models||['gpt-6.1-sol','gpt-6-astra','gpt-6-sol']).map(model=>({id:model,model})),nextCursor:null}});
 if(m.method==='thread/start'||m.method==='thread/resume'){settings=m.params;if(o.rejectModel&&settings.model===o.rejectModel){out({id:m.id,error:{code:400,message:'The '+settings.model+' model is not supported when using Codex with a ChatGPT account.'}});continue;}out({id:m.id,result:{thread:{id:'fixture-thread'},cwd:settings.cwd,model:settings.model||'fixture-default',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true}}});}
 if(m.method==='turn/start'){turn=m.params;if(o.capture)fs.writeFileSync(o.capture,JSON.stringify({args:process.argv.slice(2),settings,turn}));out({id:m.id,result:{turn:{id:'fixture-turn'}}});out({method:'turn/started',params:{threadId:'fixture-thread',turn:{id:'fixture-turn'}}});setTimeout(()=>{const left=String.fromCharCode(92)+'u005b',right=String.fromCharCode(92)+'u005d',text=o.echo?JSON.stringify({args:process.argv.slice(2),settings,turn}).replaceAll('[[質問]]',left+left+'質問'+right+right).replaceAll('[[/質問]]',left+left+'/質問'+right+right):(o.text||'fixture reply');out({method:'item/completed',params:{threadId:'fixture-thread',turnId:'fixture-turn',item:{id:'answer',type:'agentMessage',text}}});out({method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}});},o.delay||0);}
 }});`);
 return {bin,entry};
}
function environment(bin) {
 const cli=require('../../lib/cli-platform'),git=cli.find('git');if(!git)throw Error('Fixture requires the verified local Git executable');
 const runtime=[path.dirname(git),path.dirname(process.execPath),path.join(process.env.SystemRoot,'System32'),path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0')];
 for(const dir of runtime)for(const ai of ['codex','claude','agy'])for(const ext of ['.exe','.cmd'])if(fs.existsSync(path.join(dir,ai+ext)))throw Error('Fixture runtime PATH contains a real AI provider');
 return [bin,...runtime].join(path.delimiter);
}
function freshInventory() {
 const pw=require('../../lib/procwatch'),original=pw.create;
 pw.create=options=>original({...options,exec:async()=>JSON.stringify([{pid:process.pid,ppid:0,since:new Date().toISOString(),name:'node.exe',command:'synthetic owned test controller'}])});
 return ()=>{pw.create=original;};
}
module.exports={provider,environment,freshInventory};
