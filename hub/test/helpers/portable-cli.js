'use strict';
// Synthetic provider entries only. Do not append the user's PATH: a missing
// fixture must fail rather than falling through to an installed AI provider.
const fs = require('node:fs');
const path = require('node:path');

function install(root, source, name = 'claude') {
  if (!['claude', 'codex'].includes(name)) throw Error('Unsupported fixture CLI');
  const bin = path.join(root, 'fixture-bin-' + name);
  const entry = path.join(bin, 'node_modules', name === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code', 'bin', 'fixture.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  if (name === 'codex') {
    // cli-platform deliberately resolves the published Codex entry name.
    fs.writeFileSync(path.join(path.dirname(entry), 'codex.js'), source);
  } else {
    fs.writeFileSync(path.join(path.dirname(path.dirname(entry)), 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'bin/fixture.cjs' } }));
    fs.writeFileSync(entry, source);
  }
  fs.writeFileSync(path.join(bin, name + '.cmd'), '@echo off\r\nexit /b 97\r\n');
  const posix = path.join(bin, name);
  fs.writeFileSync(posix, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
  return { command: name, bin, env: { PATH: bin, HUB_AI_HOME: root }, entry: name === 'codex' ? path.join(path.dirname(entry), 'codex.js') : entry };
}

function codexServer(root, { text = 'fixture reply', usage, echo = false, models = ['gpt-6.1-sol', 'gpt-6-astra'] } = {}) {
  const options = JSON.stringify({ text, usage, echo, models });
  return install(root, `
const options=${options};const output=m=>console.log(JSON.stringify(m));let pending='',settings;
process.stdin.setEncoding('utf8');process.stdin.on('end',()=>process.exit(0));
process.stdin.on('data',chunk=>{pending+=chunk;const lines=pending.split('\\n');pending=lines.pop();for(const line of lines){if(!line)continue;const request=JSON.parse(line);
 if(request.method==='initialize')output({id:request.id,result:{}});
 if(request.method==='model/list')output({id:request.id,result:{data:options.models.map(model=>({id:model,model})),nextCursor:null}});
 if(request.method==='thread/start'||request.method==='thread/resume'){settings=request.params;output({id:request.id,result:{thread:{id:'sid-codex'},cwd:settings.cwd,model:settings.model||'fixture-default',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}}});}
 if(request.method==='turn/start'){const turn=request.params;output({id:request.id,result:{turn:{id:'fixture-turn'}}});output({method:'turn/started',params:{threadId:'sid-codex',turn:{id:'fixture-turn'}}});
  const text=options.echo?JSON.stringify({args:process.argv.slice(2),settings,turn}):options.text;
  output({method:'item/completed',params:{threadId:'sid-codex',turnId:'fixture-turn',item:{id:'answer',type:'agentMessage',text}}});
  if(options.usage)output({method:'thread/tokenUsage/updated',params:{threadId:'sid-codex',turnId:'fixture-turn',tokenUsage:{last:options.usage}}});
  output({method:'turn/completed',params:{threadId:'sid-codex',turn:{id:'fixture-turn',status:'completed'}}});
 }
}});
`, 'codex');
}

module.exports = { install, codexServer };
