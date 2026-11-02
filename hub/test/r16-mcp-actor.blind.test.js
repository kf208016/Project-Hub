'use strict';
// R16 / T1 blind acceptance: MCP capabilities carry the real native AI (actor),
// and hub_report / hub_ask_owner label their rows and ledger line with it.
// Synthetic temp workspace only; no Hub, port, CLI or network.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {CapabilityAuth}=require('../lib/capability-auth');
const {Chatgpt}=require('../lib/chatgpt');
const {Store}=require('../lib/store');
const chat=require('../lib/chat');
const runId=()=>crypto.randomUUID(),nonce=()=>crypto.randomUUID();
const invalidScope=operation=>assert.throws(operation,error=>error.status===403&&error.message==='MCP capability scope is invalid');
const REPORT_TOOLS=['hub_get_task','hub_report','hub_ask_owner','hub_mark_step'];

// ---- capability-auth actor ----

test('R16 T1 issue accepts actor claude and grok and returns it from issue, inspect, current and consume',()=>{
  for(const actor of ['claude','grok']){
    const auth=new CapabilityAuth(),run=runId();
    const grant=auth.issue({project:'one',task:'t',runId:run,tools:REPORT_TOOLS,actor});
    assert.equal(grant.capability.actor,actor);
    assert.equal(auth.inspect(grant.token,run).actor,actor);
    assert.equal(auth.current(grant.capability.id,run).actor,actor);
    const consumed=auth.consume({token:grant.token,runId:run,nonce:nonce(),tool:'hub_report',arguments:{project:'one',task:'t',text:'synthetic'}});
    assert.equal(consumed.actor,actor);assert.equal(Object.isFrozen(consumed),true);
    assert.equal(auth.consume({token:grant.token,runId:run,nonce:nonce(),tool:'hub_ask_owner',arguments:{project:'one',task:'t',question:'synthetic?'}}).actor,actor);
    assert.equal(auth.consume({token:grant.token,runId:run,nonce:nonce(),tool:'hub_mark_step',arguments:{project:'one',task:'t',index:0,done:true}}).actor,actor);
  }
});

test('R16 T1 actor also works on a project-only read grant',()=>{
  const auth=new CapabilityAuth(),run=runId(),grant=auth.issue({project:'one',runId:run,actor:'grok'});
  assert.equal(grant.capability.actor,'grok');
  assert.equal(auth.consume({token:grant.token,runId:run,nonce:nonce(),tool:'hub_list_tasks',arguments:{project:'one'}}).actor,'grok');
});

test('R16 T1 any other actor value fails with the scope error and issues nothing',()=>{
  const auth=new CapabilityAuth(),run=runId();
  for(const actor of ['codex','chatgpt','agy','Claude','GROK','grok ','',null,0,1,true,{},['grok']]){
    invalidScope(()=>auth.issue({project:'one',task:'t',runId:run,tools:REPORT_TOOLS,actor}));
  }
  assert.equal(auth.records.size,0);
});

test('R16 T1 callers without actor behave as before (no actor field)',()=>{
  const auth=new CapabilityAuth(),run=runId(),grant=auth.issue({project:'one',task:'t',runId:run,tools:REPORT_TOOLS});
  assert.equal(Object.hasOwn(grant.capability,'actor'),false);
  assert.equal(Object.hasOwn(auth.inspect(grant.token,run),'actor'),false);
  assert.equal(Object.hasOwn(auth.current(grant.capability.id,run),'actor'),false);
  const consumed=auth.consume({token:grant.token,runId:run,nonce:nonce(),tool:'hub_report',arguments:{project:'one',task:'t',text:'synthetic'}});
  assert.equal(Object.hasOwn(consumed,'actor'),false);
  invalidScope(()=>auth.issue({project:'one',runId:run,future:true}));
});

test('R16 T1 a stored actor is part of record validation',()=>{
  const auth=new CapabilityAuth(),run=runId(),grant=auth.issue({project:'one',task:'t',runId:run,tools:REPORT_TOOLS,actor:'claude'});
  assert.equal(auth.inspect(grant.token,run).actor,'claude');
  [...auth.records.values()][0].actor='codex';
  assert.throws(()=>auth.inspect(grant.token,run),error=>error.status===403);
});

// ---- chatgpt.js labelling ----

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r16-actor-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  const root=path.join(dir,'workspace'),body=path.join(dir,'body'),workdir=path.join(dir,'task-work');
  const project='サンプルアプリ',task='sample-app-01',pdir=path.join(root,'Product',project);
  fs.mkdirSync(body);fs.mkdirSync(workdir);
  fs.cpSync(path.join(__dirname,'../seed/サンプルアプリ'),pdir,{recursive:true});
  const projectFile=path.join(pdir,'PROJECT.md');fs.writeFileSync(projectFile,fs.readFileSync(projectFile,'utf8').replace('~/Documents/SampleApp',body));
  const store=new Store(root);store.updateTask(project,task,{workdir});
  const rows=[],records=[];
  const gpt=new Chatgpt({file:path.join(root,'_hub','chatgpt.json'),store,chat,baseOf:()=>body,emitRow:(p,tk,row)=>rows.push(row),ended:()=>{},record:(...event)=>records.push(event)});
  const doneSection=()=>{const text=fs.readFileSync(store.taskFile(project,task),'utf8').replace(/\r\n/g,'\n');const at=text.indexOf('## やったこと');assert.ok(at>=0);const rest=text.slice(at+'## やったこと'.length);const next=rest.indexOf('\n## ');return next<0?rest:rest.slice(0,next);};
  return {project,task,pdir,store,gpt,rows,records,doneSection};
}
const LINE=(label,text)=>new RegExp('^- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} '+label+'：'+text+'$','m');

for(const [actor,label] of [['grok','Grok'],['claude','Claude Code']]){
  test(`R16 T1 hub_report with scope.actor=${actor} writes an ai:${actor} row and a ${label}： line`,async t=>{
    const f=fixture(t),scope={project:f.project,task:f.task,tools:REPORT_TOOLS,actor};
    const text=`${actor} synthetic report\nsecond line`;
    const r=await f.gpt.call('hub_report',{project:f.project,task:f.task,text},scope);
    assert.equal(r.ok,true);
    const section=f.doneSection();
    assert.match(section,LINE(label,`${actor} synthetic report`));
    assert.match(section,/^ {2}second line$/m);
    assert.equal(section.includes(`ChatGPT：${actor} synthetic report`),false);
    assert.equal(f.rows.length,1);assert.equal(f.rows[0].role,'assistant');assert.equal(f.rows[0].ai,actor);assert.equal(f.rows[0].text,text);
    const saved=chat.read(f.pdir,f.task).findLast(row=>row.role==='assistant');assert.equal(saved.ai,actor);assert.equal(saved.text,text);
    assert.equal(f.records.at(-1)[1].ai,actor);assert.equal(f.records.at(-1)[2].tool,'hub_report');
  });

  test(`R16 T1 hub_ask_owner with scope.actor=${actor} writes an ai:${actor} question row`,async t=>{
    const f=fixture(t),scope={project:f.project,task:f.task,tools:REPORT_TOOLS,actor};
    const r=await f.gpt.call('hub_ask_owner',{project:f.project,task:f.task,question:'A or B?'},scope);
    assert.equal(r.ok,true);assert.equal(r.state,'返事待ち');
    assert.equal(f.rows.length,1);assert.equal(f.rows[0].ai,actor);assert.equal(f.rows[0].text,'【質問】A or B?');
    assert.equal(chat.read(f.pdir,f.task).findLast(row=>row.role==='assistant').ai,actor);
    assert.equal(f.records.at(-1)[1].ai,actor);assert.equal(f.records.at(-1)[2].tool,'hub_ask_owner');
  });
}

test('R16 T1 without scope.actor hub_report and hub_ask_owner stay ChatGPT',async t=>{
  for(const scoped of [true,false]){
    const f=fixture(t),scope=scoped?{project:f.project,task:f.task,tools:REPORT_TOOLS}:undefined;
    await f.gpt.call('hub_report',{project:f.project,task:f.task,text:'plain report'},scope);
    assert.match(f.doneSection(),LINE('ChatGPT','plain report'));
    assert.equal(f.rows.at(-1).ai,'chatgpt');assert.equal(f.records.at(-1)[1].ai,'chatgpt');
    await f.gpt.call('hub_ask_owner',{project:f.project,task:f.task,question:'plain question?'},scope);
    assert.equal(f.rows.at(-1).ai,'chatgpt');assert.equal(f.records.at(-1)[1].ai,'chatgpt');
  }
});

test('R16 T1 report tools keep working with MCP file writes off and hub_mark_step is unchanged',async t=>{
  const f=fixture(t);assert.equal(f.gpt.settings().work,false);
  const scope={project:f.project,task:f.task,tools:REPORT_TOOLS,actor:'grok'};
  const step=await f.gpt.call('hub_mark_step',{project:f.project,task:f.task,index:0,done:true},scope);
  assert.equal(step.ok,true);assert.equal(step.steps[0].done,true);assert.equal(f.rows.length,0);
  const before=f.store.readProject(f.project).tasks.find(x=>x.id===f.task).state;
  const report=await f.gpt.call('hub_report',{project:f.project,task:f.task,text:'step done',done:true},scope);
  assert.equal(report.ok,true);assert.match(f.doneSection(),LINE('Grok','step done'));
  const after=f.store.readProject(f.project).tasks.find(x=>x.id===f.task).state;
  assert.equal(report.state,after);assert.notEqual(after,before,'done=true still moves the task state');
});
