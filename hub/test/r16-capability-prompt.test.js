'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {CapabilityAuth}=require('../lib/capability-auth');
const {Chatgpt,TOOLS}=require('../lib/chatgpt');
const {decide}=require('../lib/native-provider-tool-policy');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));

test('R16 nativeProviderMcp grants exact read/report and optional write lists with actor',async()=>{
  const read=['hub_list_tasks','hub_get_task','hub_get_chat'];
  for(const work of [false,true])for(const actor of ['grok','claude']){
    let issued;const modules={
      './lib/native-runtime-base':{resolve:async()=>({physicalBase:'C:\\SyntheticRuntime'})},
      './lib/safe-path':{localPath:p=>p},
      './lib/scoped-file':{identity:async()=>({rootFingerprint:'b'.repeat(64)})},
      './lib/native-mcp-proxy':{create:()=>({handle(){}})},
      './lib/grok-auth-route':{create:()=>({handle(){},close(){}}),clearStaleRouteFile:()=>false}
    };
    const context=vm.createContext({require:n=>{assert.ok(Object.hasOwn(modules,n),n);return modules[n];},
      os:{homedir:()=> 'C:\\SyntheticHome'},path:path.win32,process:{execPath:'C:\\Synthetic\\node.exe'},Buffer,crypto,
      fs:{mkdirSync(){},openSync(){return 1;},writeFileSync(){},fsyncSync(){},closeSync(){}},grokTokenMint:async()=>({access_token:'synthetic',expires_in:60}),
      gpt:{settings:()=>({work})},READ_TOOLS:read,ROOT:'C:\\SyntheticLedger',PORT:49152,MAX_WALL_MS:1800000,__dirname:'C:\\SyntheticHub',
      store:{readProject:()=>({tasks:[{id:'t',completionHash:'c'.repeat(64)}]})},launch:{CLI_DEFAULT_LABEL:'CLI預設',flagFor:()=> 'fixture-model'},
      mcpCapabilities:{issue:o=>{issued=plain(o);return {token:'synthetic',capability:{id:'cap',expiresAt:123}};}},nativeProviderResources:new Map(),heldNativeDone:new Set(),chats:{key:(p,t)=>p+'\0'+t},record(){}});
    vm.runInContext(source.slice(source.indexOf('async function nativeProviderMcp('),source.indexOf('async function nativeProviderDispose(')),context);
    await context.nativeProviderMcp({project:'p',task:'t',runId:'r'.repeat(16),actor,model:'fixture'}, {dir:'C:\\SyntheticWorkspace',rootFingerprint:'a'.repeat(64),workspaceRun:'w'.repeat(16)});
    assert.deepEqual(issued.tools,[...read,'hub_read_file','hub_report','hub_ask_owner','hub_mark_step',...(work?['hub_write_file','hub_request_command','hub_get_command_result','hub_delegate']:[])]);
    assert.equal(issued.actor,actor);assert.equal(issued.root,'C:\\SyntheticWorkspace');
  }
});

test('R16 actor is optional, exactly claude/grok, returned by every grant view and validated on stored records',()=>{
  for(const actor of [undefined,'claude','grok']){
    const auth=new CapabilityAuth(),runId='r'.repeat(16),grant=auth.issue({project:'p',task:'t',runId,tools:['hub_report'],...(actor?{actor}:{})});
    for(const scope of [grant.capability,auth.current(grant.capability.id,runId),auth.consume({token:grant.token,runId,nonce:'n'.repeat(16),tool:'hub_report',arguments:{project:'p',task:'t',text:'report'}})]){
      assert.equal(scope.actor,actor);assert.equal(Object.hasOwn(scope,'actor'),actor!==undefined);
    }
    [...auth.records.values()][0].actor='codex';assert.throws(()=>auth.current(grant.capability.id,runId),/MCP capability is invalid or expired/);
  }
  for(const actor of [null,'','codex','chatgpt','Grok',0,{},[],true])assert.throws(()=>new CapabilityAuth().issue({project:'p',runId:'r'.repeat(16),tools:['hub_report'],actor}),/MCP capability scope is invalid/);
});

test('R16 report and ask rows/logs use actor, legacy calls remain ChatGPT, and mark_step stays unchanged with work off',async()=>{
  for(const actor of ['grok','claude',undefined]){
    const rows=[],sections=[],logs=[],task={id:'t',state:'実行中'};
    const gpt=new Chatgpt({file:'unused',store:{readProject:()=>({id:'p',dir:'synthetic'}),taskFile:()=> 'task',readTask:()=>task,
      appendSection:(p,t,section,text)=>sections.push({section,text}),updateTask:(p,t,fields)=>Object.assign(task,fields),setStep:()=>({steps:[]})},
      chat:{append:(p,t,row)=>{rows.push(row);return row;}},emitRow(){},ended(){},record:(action,row,detail)=>logs.push({action,row,detail})});
    gpt.settings=()=>({work:false});const scope={project:'p',task:'t',tools:['hub_report','hub_ask_owner','hub_mark_step'],...(actor?{actor}:{})};
    await gpt.call('hub_report',{project:'p',task:'t',text:'report'},scope);
    await gpt.call('hub_ask_owner',{project:'p',task:'t',question:'question'},scope);
    const label=actor==='grok'?'Grok':actor==='claude'?'Claude Code':'ChatGPT';
    assert.match(sections[0].text,new RegExp(label+'：report'));assert.equal(sections[0].section,'やったこと');
    assert.deepEqual(rows.map(r=>r.ai),[actor||'chatgpt',actor||'chatgpt']);assert.deepEqual(logs.map(r=>r.row.ai),[actor||'chatgpt',actor||'chatgpt']);
    await gpt.call('hub_mark_step',{project:'p',task:'t',index:0,done:true},scope);assert.equal(logs.at(-1).row.ai,'chatgpt');
    for(const name of scope.tools)assert.equal(TOOLS.find(t=>t.name===name).work,undefined);
  }
});

test('R16 ungranted MCP declines while unknown non-MCP Claude remains manual',()=>{
  const policy={root:'C:\\workspace',modelFlag:'fixture',commandsApproved:true,subagentsApproved:true,mcpTools:[]};
  assert.equal(decide('grok',{title:'Use tool',kind:'other',rawInput:{variant:'UseTool',tool_name:'hub__outside',tool_input:{}}},policy),'accept');
  assert.equal(decide('claude',{toolName:'mcp__hub__outside',input:{}},policy),'decline');
  assert.equal(decide('claude',{toolName:'FutureTool',input:{}},policy),'manual');
});

test('R16 Windows working copy prompt uses ledger tools; direct, terminal and POSIX keep old wording',()=>{
  const fn=source.slice(source.indexOf('function taskPrompt('),source.indexOf('function usageWithLimit('));
  const expected='台帳は読むだけ（cwd外へは書けない）。手順の[x]はhub_mark_step、やったことはhub_report。無い時は返事に書く。';
  for(const platform of ['win32','darwin','linux']){
    const context=vm.createContext({process:{platform},path:path.win32,workRoot:()=> 'C:\\Work\\p',store:{listProjects:()=>[],readProject:()=>null},
      require:n=>{assert.equal(n,'./lib/work-context');return {family:()=>[],sourceOf:()=>null};},instructions:{packet:o=>o.common},modelPolicy:()=>'',PORT:49152,
      launch:{CONTEXT_RULE:''},chat:{ASK_RULE:''},TERMINAL_HANDOFF_NOTE:'',TERMINAL_LIMIT_NOTE:''});vm.runInContext(fn,context);
    const p={id:'p',dir:'C:\\Ledger\\p',folders:[],related:[]},t={id:'t',title:'task'};
    const copy=context.taskPrompt(p,t,'task','C:\\Work\\p\\t');
    if(platform==='win32'){assert.ok(copy.includes(expected));assert.doesNotMatch(copy,/区切りで更新/);}else assert.match(copy,/区切りで更新、実施した手順だけ\[x\]（無ければ3〜5個）。/);
    assert.match(context.taskPrompt(p,t,'task',p.dir),/区切りで更新/);
    assert.match(context.taskPrompt(p,t,'task','C:\\Work\\p\\t','terminal'),/区切りごとに作業ファイルを更新/);
  }
});

test('R16 initial SSE rows include running AI in every approval',()=>{
  const statement=source.split('\n').find(l=>l.includes("emit({ type: 'rows', rows: chat.read"));
  for(const ai of ['claude','grok','codex']){
    let emitted;vm.runInNewContext(statement,{emit:e=>{emitted=e;},chat:{read:()=>[]},p:{dir:'fixture'},task:'t',project:'p',chats:{queue:()=>[]},
      run:{ai,model:'fixture',texts:[],child:{listApprovals:()=>[{token:'a'},{token:'b',ai:'wrong'}]}}});
    assert.deepEqual(plain(emitted.approvals),[{token:'a',ai},{token:'b',ai}]);
  }
});
