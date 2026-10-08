'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const bridge=require('../lib/codex-bridge');
const win=process.platform==='win32'?test:test.skip;
function fixture(t,options={},extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-bridge-測試 space-')),bin=path.join(dir,'bin');
  require('./helpers/codex-server').install(bin,options);
  const child=bridge.start({cwd:dir,model:'fixture-model',effort:'high',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},...extra});
  let out='',err='';const errors=[];child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',e=>errors.push(e.message));
  const closed=new Promise(resolve=>child.on('close',(code)=>resolve({code,events:out.trim().split('\n').filter(Boolean).map(JSON.parse),err,errors})));
  t.after(async()=>{child.kill();await closed;fs.rmSync(dir,{recursive:true,force:true});});
  return {child,closed,dir};
}
win('Codex bridge accepts only a single explicit decision for the active request', {timeout:15000}, async t=>{
  const f=fixture(t,{mode:'approval',echo:true});
  const approval=new Promise(resolve=>f.child.on('approvals',a=>{if(a.length)resolve(a[0]);}));
  f.child.stdin.end('synthetic prompt');const a=await approval;
  assert.match(a.detail,/synthetic command/);
  assert.throws(()=>f.child.respond('another-run-token','accept'),/失效|過期/);
  assert.throws(()=>f.child.respond(a.token,'acceptForSession'),/不支援/);
  assert.equal(f.child.respond(a.token,'accept'),true);
  assert.throws(()=>f.child.respond(a.token,'accept'),/失效|過期/);
  const result=await f.closed;assert.equal(result.errors.length,0,result.err);
  const answer=JSON.parse(result.events.find(x=>x.type==='hub.agent_snapshot').text);
  assert.equal(answer.decision,'accept');assert.equal(result.events.at(-1).type,'turn.completed');
});
win('Codex bridge approval timeout declines without user approval', {timeout:15000}, async t=>{
  const f=fixture(t,{mode:'approval',echo:true},{approvalTimeout:50});f.child.stdin.end('synthetic');
  const result=await f.closed;
  const answer=JSON.parse(result.events.find(x=>x.type==='hub.agent_snapshot').text);
  assert.equal(answer.decision,'decline');assert.deepEqual(f.child.listApprovals(),[]);
});
for(const mode of ['wrong-thread','malformed','incomplete','missing-model','wrong-reviewer','wrong-sandbox','wrong-temp-policy','broken-question','broken-request-id','file-updated','failure-then-success'])win('Codex bridge rejects '+mode,{timeout:15000},async t=>{
  const f=fixture(t,{mode});f.child.stdin.end('synthetic');const result=await f.closed;
  assert.equal(result.events.at(-1).type,'turn.failed');assert.deepEqual(f.child.listApprovals(),[]);assert.equal(result.events.some(x=>x.type==='turn.completed'),false);
});
win('Codex bridge streams text without duplicated final message and reports usage',{timeout:15000},async t=>{
  const f=fixture(t,{mode:'stream'});f.child.stdin.end('synthetic');const r=await f.closed;
  assert.deepEqual(r.events.filter(x=>x.type==='hub.agent_snapshot').map(x=>x.text),['fixture ','fixture reply','fixture reply']);
  assert.deepEqual(r.events.at(-1).usage,{input_tokens:100,cached_input_tokens:20});
});
win('Codex file approval refuses a changed file and can still decline',{timeout:15000},async t=>{
  const f=fixture(t,{mode:'file',echo:true});const file=path.join(f.dir,'review.txt');fs.writeFileSync(file,'before');
  const wait=new Promise(resolve=>f.child.on('approvals',a=>{if(a.length)resolve(a[0]);}));f.child.stdin.end('synthetic');const a=await wait;
  assert.match(a.detail,/-before\n\+after/);fs.writeFileSync(file,'new state');
  assert.throws(()=>f.child.respond(a.token,'accept'),/檔案已變更/);f.child.respond(a.token,'decline');
  assert.equal(JSON.parse((await f.closed).events.find(x=>x.type==='hub.agent_snapshot').text).decision,'decline');
});
win('Codex question validates answers and permissions cannot become session grants',{timeout:15000},async t=>{
  for(const mode of ['question','permissions']){
    const f=fixture(t,{mode,echo:true});const wait=new Promise(resolve=>f.child.on('approvals',a=>{if(a.length)resolve(a[0]);}));f.child.stdin.end('synthetic');const a=await wait;
    if(mode==='question'){assert.throws(()=>f.child.respond(a.token,'answer',{}),/填寫/);f.child.respond(a.token,'answer',{q1:'synthetic answer'});}
    else f.child.respond(a.token,'accept');
    const decision=JSON.parse((await f.closed).events.find(x=>x.type==='hub.agent_snapshot').text).decision;
    assert.deepEqual(decision,mode==='question'?{answers:{q1:{answers:['synthetic answer']}}}:{permissions:{network:{enabled:true}},scope:'turn'});
  }
});
win('Codex cancel clears pending approvals and kills the owned connection',{timeout:15000},async t=>{
  const f=fixture(t,{mode:'approval'});const wait=new Promise(resolve=>f.child.on('approvals',a=>{if(a.length)resolve(a[0]);}));f.child.stdin.end('synthetic');const a=await wait;
  f.child.respond(a.token,'cancel');await f.closed;assert.deepEqual(f.child.listApprovals(),[]);assert.throws(()=>f.child.respond(a.token,'accept'),/過期/);
});
win('Codex move approval binds the destination snapshot and can still decline',{timeout:15000},async t=>{
 const f=fixture(t,{mode:'file-move'});fs.writeFileSync(path.join(f.dir,'review.txt'),'before');const wait=new Promise(resolve=>f.child.on('approvals',a=>{if(a.length)resolve(a[0]);}));f.child.stdin.end('synthetic');const a=await wait;
 assert.match(a.detail,/destination.txt/);fs.writeFileSync(path.join(f.dir,'destination.txt'),'new owner');assert.throws(()=>f.child.respond(a.token,'accept'),/已變更/);f.child.respond(a.token,'decline');await f.closed;
});
win('Codex explicit CLI-default model setting remains usable without selecting another named model',{timeout:15000},async t=>{
 const f=fixture(t,{echo:true},{model:''});f.child.stdin.end('synthetic');assert.equal(await f.child.ready,true);const result=await f.closed;assert.equal(result.code,0);const reply=JSON.parse(result.events.find(x=>x.type==='hub.agent_snapshot').text);assert.equal(reply.settings.model,null);assert.equal(reply.turn.model,null);
});
