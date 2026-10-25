'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {WorkspaceRuntime}=require('../lib/workspace-runtime');

test('native close without required cleanup receipt retains the exact workspace lease',async()=>{
 const f=fixture(),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'}),child=new EventEmitter();
 child.requiresCleanupReceipt=true;child.cleanupReceipt=null;f.runtime.track(flow,child);child.emit('close',1,null);
 assert.equal(flow.children.has(child),true);assert.equal(f.runtime.summary('p','t').state,'cleanup-failed');
 await assert.rejects(f.runtime.finish(flow.id),/尚未完全退出/);assert.equal(f.released(),0);
});

test('owned summary exposes failed cleanup without credentials and retries only the retained flow',async()=>{const f=fixture();assert.equal(f.runtime.summary('p','t'),null);const flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});assert.equal(f.runtime.summary('p','t').state,'starting');flow.starting=false;const release=f.review.releaseRun;f.review.releaseRun=async()=>{throw Error('SYNTHETIC_PRIVATE_VALUE_MUST_NOT_BE_SUMMARY');};await assert.rejects(f.runtime.finish(flow.id),/SYNTHETIC_PRIVATE/);assert.deepEqual(f.runtime.summary('p','t'),{kind:'chat',state:'cleanup-failed',ownedChildren:0,retryClose:true,errorCode:'WORKSPACE_CLEANUP_REQUIRED'});assert.equal(f.runtime.current('p','t'),null);assert.equal(f.runtime.flows.size,1);assert.doesNotMatch(JSON.stringify(f.runtime.summary('p','t')),/PRIVATE_VALUE|private-run|permit|flow|supply/);await assert.rejects(f.runtime.begin({project:'p',task:'t',kind:'chat'}),/停止或清理/);f.review.releaseRun=release;await f.runtime.stop(flow.id);await f.runtime.finish(flow.id);assert.equal(f.runtime.summary('p','t'),null);assert.equal(f.released(),1);});

test('never-started partial supply returning ok false retains recovery rather than reporting finish success',async()=>{const f=fixture(),head={id:'head',text:'original queued request'},tail={id:'tail',text:'follow-up'};f.setQueue([head,tail]);f.review.permits.get('permit').record.secrets.files.push({relative:'.env'});f.review.supply=async()=>({id:'synthetic-supply'});f.review.consumeRun=async()=>{throw Error('synthetic post-supply startup failure');};let cleanupOk=false;f.review.secretSupply={cleanup:async()=>({ok:cleanupOk,error:'SYNTHETIC_DESTINATION_CHANGED'})};let error;try{await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});}catch(value){error=value;}const flow=f.runtime.flows.get(error.workspaceFlow);assert.ok(flow);assert.equal(flow.workspace,null);await assert.rejects(f.runtime.failed(flow),/清理未完成/);assert.equal(f.runtime.flows.get(flow.id),flow);assert.equal(f.runtime.byTask.get(f.runtime.key('p','t')),flow.id);assert.equal(f.runtime.summary('p','t').state,'cleanup-failed');assert.deepEqual(f.chats.queue(),[head,tail]);assert.equal(f.released(),0);cleanupOk=true;await f.runtime.finish(flow.id);assert.equal(f.runtime.summary('p','t'),null);assert.deepEqual(f.chats.queue(),[head,tail]);});

test('failed startup revokes its workspace but preserves the exact queued head and followers; explicit stop still clears them',async()=>{
 const f=fixture(),queue=[{id:'head',requireModel:true,requiredModel:'gpt-6-astra',text:'原始要求'},{id:'follower',text:'後續要求'}],before=JSON.stringify(queue),stopOptions=[];f.setQueue(queue);
 f.chats.stop=(_p,_t,options)=>{stopOptions.push(options);f.setBusy(null);if(!options?.interrupting)f.setQueue([]);};
 const flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});await f.runtime.failed(flow);assert.equal(JSON.stringify(f.chats.queue()),before);assert.equal(stopOptions[0].interrupting,true);assert.equal(f.released(),1);assert.equal(f.runtime.current('p','t'),null);assert.equal(f.runtime.flows.size,0);
 await assert.rejects(f.runtime.begin({project:'p',task:'t',kind:'chat'}),error=>error.code==='WORKSPACE_REQUIRED');const fresh=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});await f.runtime.stop(fresh.id);await f.runtime.finish(fresh.id);assert.deepEqual(f.chats.queue(),[]);assert.equal(stopOptions[1],undefined);assert.equal(f.released(),2);
});

test('actual idle ChatRunner preserves persisted queue bytes during failed-start cleanup and clears them on explicit stop',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{ChatRunner}=require('../lib/chat'),root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-failed-queue-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const f=fixture(),chats=new ChatRunner({dirOf:()=>root});f.runtime.chats=chats;chats.setQueue('p','t',[{id:'head',ai:'codex',model:'Astra',requiredModel:'gpt-6-astra',requireModel:true,text:'原始要求'},{id:'follower',ai:'codex',model:'GPT-6.1-Sol',text:'後續要求'}]);const file=path.join(root,'.ai/chat/t.queue.json'),before=fs.readFileSync(file);
 const flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});await f.runtime.failed(flow);assert.deepEqual(fs.readFileSync(file),before);assert.equal(chats.queue('p','t').length,2);assert.equal(chats.stops.get(chats.key('p','t')),undefined);assert.equal(f.released(),1);
 const fresh=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});await f.runtime.stop(fresh.id);await f.runtime.finish(fresh.id);assert.deepEqual(chats.queue('p','t'),[]);assert.equal(chats.stops.get(chats.key('p','t')),1);
});
function fixture(){let binding=null,released=0,extra=0,busy=null,queue=[];const record={secrets:{files:[]}},review={permits:new Map([['permit',{record}]]),async consumeRun(){binding={run:'private-run',dir:process.cwd()};return binding;},binding:()=>binding,async verifiedBinding(){if(!binding)throw Error('missing binding');return binding;},async releaseRun(){released++;binding=null;}};const chats={busy:()=>busy,queue:()=>queue,stop(){busy=null;}},sessions={stop(){}};const runtime=new WorkspaceRuntime({review,chats,sessions,store:{},stopExtra:async()=>{extra++;return{stopped:true,treeExited:true};}});return{runtime,review,chats,setBusy:x=>busy=x,setQueue:x=>queue=x,released:()=>released,extra:()=>extra};}
test('workspace workflow requires a permit and rejects forged flow or a restarted controller',async()=>{const f=fixture();await assert.rejects(f.runtime.begin({project:'p',task:'t',kind:'chat'}),e=>e.workspaceRequired===true&&e.code==='WORKSPACE_REQUIRED');const flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});assert.equal(f.runtime.assertStart('p','t',flow.id,process.cwd()),flow);assert.throws(()=>f.runtime.assertStart('other','t',flow.id,process.cwd()),/授權/);assert.throws(()=>f.runtime.assertStart('p','t','metadata-only',process.cwd()),/授權/);const restarted=new WorkspaceRuntime({...f.runtime});assert.equal(restarted.current('p','t'),null);await assert.rejects(restarted.begin({project:'p',task:'t',kind:'chat'}),e=>e.workspaceRequired===true);flow.starting=false;await f.runtime.finish(flow.id);});
test('workspace stop retains the lease until the owned child close event and revokes only after exit',async()=>{const f=fixture(),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'}),child=new EventEmitter();f.setBusy({child});f.runtime.observeChat('p','t');const stopping=f.runtime.stop(flow.id);await new Promise(setImmediate);assert.equal(f.released(),0);assert.equal(f.runtime.current('p','t'),null);child.on('error',()=>{});child.emit('error',Error('synthetic early error'));assert.equal(f.released(),0);child.emit('close');const proof=await stopping;assert.deepEqual(proof,{stopped:true,treeExited:true});await f.runtime.finish(flow.id);assert.equal(f.released(),1);assert.ok(f.extra()>=1);});
test('queued workflow reuses one lease while terminal workflows require a real finished promise',async()=>{const f=fixture(),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'}),child=new EventEmitter();f.setBusy({child});f.setQueue([{}]);f.runtime.observeChat('p','t');child.emit('close');f.setBusy(null);await new Promise(r=>setTimeout(r,250));assert.equal(f.released(),0);assert.equal(await f.runtime.begin({project:'p',task:'t',kind:'chat'}),flow);await assert.rejects(f.runtime.begin({project:'p',task:'t',kind:'terminal'}),/另一種/);f.setQueue([]);await f.runtime.finish(flow.id);assert.equal(f.released(),1);const terminal=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'});assert.throws(()=>f.runtime.trackTerminal(terminal,{}),/退出證據/);const h=terminalHarness(f),session=h.add('codex');f.runtime.trackTerminal(terminal,session);assert.equal(terminal.children.size,1);session.close();await session.finishedP;await new Promise(setImmediate);await f.runtime.finish(terminal.id);assert.equal(f.released(),2);});
test('workflow restart reserves its lease while async root verification crosses the natural-close timer',async()=>{const f=fixture(),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'}),old=new EventEmitter();f.setBusy({child:old});f.runtime.observeChat('p','t');old.emit('close');f.setBusy(null);let release;const barrier=new Promise(r=>release=r),verify=f.review.verifiedBinding;f.review.verifiedBinding=async()=>{await barrier;return verify();};const restarting=f.runtime.begin({project:'p',task:'t',kind:'chat'});await new Promise(r=>setTimeout(r,250));assert.equal(f.released(),0);release();assert.equal(await restarting,flow);const next=new EventEmitter();f.setBusy({child:next});f.runtime.observeChat('p','t');assert.equal(flow.children.size,1);next.emit('close');f.setBusy(null);await f.runtime.finish(flow.id);assert.equal(f.released(),1);});
test('GitHub source verification refusal retains the flow until explicit stop or a fresh successful validation',async()=>{const f=fixture(),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'chat'});flow.starting=false;f.runtime.deferFinish(flow);const verify=f.review.verifiedBinding;f.review.verifiedBinding=async(_p,_t,options)=>{assert.equal(options.verifySource,true);throw Error('synthetic stale source');};await assert.rejects(f.runtime.begin({project:'p',task:'t',kind:'chat',verifySource:true}),/stale source/);f.runtime.deferFinish(flow);await new Promise(r=>setTimeout(r,250));assert.equal(f.runtime.current('p','t'),flow);assert.equal(f.released(),0);f.review.verifiedBinding=verify;assert.equal(await f.runtime.begin({project:'p',task:'t',kind:'chat',verifySource:true}),flow);assert.equal(flow.verificationBlocked,false);await f.runtime.stop(flow.id);await f.runtime.finish(flow.id);assert.equal(f.released(),1);});

function terminalHarness(f){
  const entries=new Map(),calls=[],key=(p,t,ai)=>JSON.stringify([p,t,ai]);
  const sessions={get:(p,t,ai)=>entries.get(key(p,t,ai)),stop(p,t,ai){calls.push([p,t,ai]);return Boolean(this.get(p,t,ai));}};
  f.runtime.sessions=sessions;
  function add(ai,{project='p',task='t',dir=process.cwd()}={}){let close,reject;const finishedP=new Promise((resolve,fail)=>{close=resolve;reject=fail;});const session={ai,dir,finishedP,close,reject};entries.set(key(project,task,ai),session);return session;}
  return{sessions,calls,add};
}

test('terminal Stop captures each owned actor and waits for every exact session without stopping untracked actors',async()=>{
  const registry=require('../lib/provider-registry'),before=registry.list({platform:'win32'}),f=fixture(),h=terminalHarness(f),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'});
  const claude=h.add('claude'),grok=h.add('grok');h.add('codex');h.add('agy');h.add('claude',{task:'other'});
  f.runtime.trackTerminal(flow,claude);f.runtime.trackTerminal(flow,grok);f.runtime.trackTerminal(flow,grok);assert.equal(flow.children.size,2);
  claude.ai='codex'; // A later mutable field cannot redirect the captured stop target.
  const stopping=f.runtime.stop(flow.id);await new Promise(setImmediate);assert.deepEqual(h.calls,[['p','t','claude'],['p','t','grok']]);assert.equal(f.released(),0);
  claude.close();await new Promise(setImmediate);assert.equal(f.released(),0);assert.equal(flow.children.size,1);grok.close();assert.deepEqual(await stopping,{stopped:true,treeExited:true});await f.runtime.finish(flow.id);assert.equal(f.released(),1);
  assert.deepEqual(registry.list({platform:'win32'}),before);assert.equal(registry.status('claude',{platform:'win32'}).ready,false);assert.equal(registry.status('grok',{platform:'win32'}).ready,false);
});

test('Codex terminal Stop keeps its original target and a never-started terminal cleanup stops no actor',async()=>{
  const f=fixture(),h=terminalHarness(f),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'}),session=h.add('codex');f.runtime.trackTerminal(flow,session);
  const stopping=f.runtime.stop(flow.id);await new Promise(setImmediate);assert.deepEqual(h.calls,[['p','t','codex']]);assert.equal(f.released(),0);session.close();assert.equal((await stopping).treeExited,true);await f.runtime.finish(flow.id);
  const empty=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'});await f.runtime.failed(empty);assert.equal(h.calls.length,1);assert.equal(f.released(),2);
});

test('terminal tracking rejects unknown, web and alias actors before taking ownership',async()=>{
  const f=fixture(),h=terminalHarness(f),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'});
  for(const [ai,code] of [['unknown','UNKNOWN_ACTOR'],['chatgpt','CLI_ACTOR_REQUIRED'],['claude-chat','CLI_ACTOR_REQUIRED']]){const session=h.add(ai);assert.throws(()=>f.runtime.trackTerminal(flow,session),error=>error.code===code);session.close();}
  const alias=h.add('claude-code');assert.throws(()=>f.runtime.trackTerminal(flow,alias),/身分/);alias.close();assert.equal(flow.children.size,0);assert.equal(flow.terminals.size,0);await f.runtime.failed(flow);assert.deepEqual(h.calls,[]);
});

test('terminal tracking rejects another task, directory, flow, session object and non-Promise completion',async()=>{
  const path=require('node:path'),f=fixture(),h=terminalHarness(f),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'});
  const foreign=h.add('claude',{task:'other'});assert.throws(()=>f.runtime.trackTerminal(flow,foreign),/身分/);foreign.close();
  const outside=h.add('claude',{dir:path.dirname(process.cwd())});assert.throws(()=>f.runtime.trackTerminal(flow,outside),/身分/);outside.close();
  const owned=h.add('claude');assert.throws(()=>f.runtime.trackTerminal(flow,{...owned}),/身分/);assert.throws(()=>f.runtime.trackTerminal({...flow},owned),/退出證據/);assert.throws(()=>f.runtime.trackTerminal(flow,{...owned,finishedP:{then(){}}}),/退出證據/);
  assert.equal(flow.children.size,0);owned.close();await f.runtime.failed(flow);assert.deepEqual(h.calls,[]);
});

test('terminal replacement rejects Stop before affecting any actor and retains its lease until exact exit',async()=>{
  const f=fixture(),h=terminalHarness(f),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'}),first=h.add('claude'),second=h.add('grok');f.runtime.trackTerminal(flow,first);f.runtime.trackTerminal(flow,second);const replacement=h.add('grok');
  await assert.rejects(f.runtime.stop(flow.id),/身分已變更/);assert.deepEqual(h.calls,[]);assert.equal(f.released(),0);assert.equal(f.runtime.summary('p','t').state,'cleanup-failed');await assert.rejects(f.runtime.finish(flow.id),/尚未完全退出/);
  first.close();second.close();await new Promise(setImmediate);await f.runtime.finish(flow.id);assert.equal(f.released(),1);assert.deepEqual(h.calls,[]);replacement.close();
});

test('rejected terminal completion retains ownership and cannot be counted as an exited tree',async()=>{
  const f=fixture(),h=terminalHarness(f),flow=await f.runtime.begin({project:'p',task:'t',permit:'permit',kind:'terminal'}),session=h.add('claude');f.runtime.trackTerminal(flow,session);session.reject(Error('synthetic completion failure'));await new Promise(setImmediate);
  assert.equal(flow.children.size,1);assert.equal(f.runtime.summary('p','t').state,'cleanup-failed');assert.equal(f.released(),0);await assert.rejects(f.runtime.finish(flow.id),/尚未完全退出/);assert.equal(f.released(),0);assert.deepEqual(h.calls,[]);
});
