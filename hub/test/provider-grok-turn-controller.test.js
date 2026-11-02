'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PassThrough,Writable}=require('node:stream');
const {createHash}=require('node:crypto');
const {createTurnController,LIMITS}=require('../lib/providers/grok-turn-controller');
const S='synthetic-session',R='synthetic-run',B='synthetic-owned-backend',P=17;
const wire=value=>Buffer.from(JSON.stringify(value)+'\n');
const result=stopReason=>({jsonrpc:'2.0',id:P,result:{stopReason:stopReason||'end_turn'}});
const message=text=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:S,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
const request=(id='permission-1',tool='tool-1')=>({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:S,toolCall:{toolCallId:tool,title:'Synthetic operation',kind:'execute',status:'pending',rawInput:{command:'synthetic'}},options:[{optionId:'allow-once',name:'允許這次',kind:'allow_once'},{optionId:'reject-once',name:'拒絕這次',kind:'reject_once'}]}});
const update=(tool,status)=>({jsonrpc:'2.0',method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call_update',toolCallId:tool,status}}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Clock{
  constructor(){this.wall=1000;this.mono=2000;this.sequence=0;this.tasks=new Map();}
  schedule=(fn,ms)=>{const id=++this.sequence;this.tasks.set(id,{at:this.mono+ms,fn});return id;};
  cancel=id=>this.tasks.delete(id);
  advance(ms){const target=this.mono+ms;let count=0;while(true){const next=[...this.tasks.entries()].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert.ok(++count<10000,'synthetic timer loop bounded');const [id,entry]=next;const delta=entry.at-this.mono;this.mono=entry.at;this.wall+=delta;this.tasks.delete(id);entry.fn();}this.wall+=target-this.mono;this.mono=target;}
}
function fixture(extra={}){
  const owner={},backend={},events=[],writes=[],stops=[],held=[],clock=new Clock();
  const stdout=new PassThrough(),stderr=new PassThrough();
  const stdin=new Writable({highWaterMark:extra.backpressure?1:16384,write(bytes,_encoding,callback){writes.push(Buffer.from(bytes));if(extra.hold)held.push(callback);else callback();}});
  const endpoint={backendId:B,stdin,stdout,stderr,requestStop:info=>{stops.push(info);return extra.stop?.(info);}};
  const options={sessionId:S,runId:R,promptRequestId:P,prompt:'合成繁體中文測試',ownerAuthority:owner,backendAuthority:backend,endpoint,onEvent:event=>{events.push(event);extra.event?.(event);},now:()=>clock.wall,monotonic:()=>clock.mono,schedule:clock.schedule,cancelSchedule:clock.cancel,limits:{maxWallMs:1000,maxIdleMs:500,maxWriteMs:100,maxStopMs:100,permissionTtlMs:300,...extra.limits}};
  const controller=extra.deferCreate?null:createTurnController(options);
  return {controller,owner,backend,events,writes,stops,held,clock,stdout,stderr,stdin,options};
}
function decision(f,optionId='allow-once'){const p=f.controller.pending()[0];return {sessionId:S,runId:R,requestId:p.requestId,requestSHA256:p.requestSHA256,optionId,confirm:true};}
const receipt=extra=>({backendId:B,sessionId:S,runId:R,rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0,signal:null,...extra});
async function close(f,extra={}){f.stdout.end();f.stderr.end();await flush();if(f.controller.snapshot().phase!=='finished')f.controller.reportExit(f.backend,receipt(extra));return f.controller.completion;}

test('exclusive synthetic streams send exact prompt and require both EOFs plus owned-tree receipt',async()=>{
  const f=fixture();f.controller.start();await flush();
  assert.deepEqual(JSON.parse(f.writes[0]),{jsonrpc:'2.0',id:P,method:'session/prompt',params:{sessionId:S,prompt:[{type:'text',text:'合成繁體中文測試'}]}});
  assert.equal(f.controller.snapshot().promptSHA256,createHash('sha256').update('合成繁體中文測試').digest('hex'));
  f.stdout.write(wire(message('synthetic reply')));f.stdout.write(wire(result()));
  assert.equal(f.controller.snapshot().phase,'stopping');assert.equal(f.controller.snapshot().cleanupVerified,false);assert.equal(f.stops.length,1);
  const done=await close(f);assert.equal(done.completionKind,'reply-complete');assert.equal(done.taskSuccess,null);assert.equal(done.cleanupVerified,true);
  assert.equal(f.clock.tasks.size,0);assert.equal(f.events.filter(e=>e.type==='finished').length,1);
  assert.throws(()=>f.controller.start(),e=>e.code==='GROK_TURN_FINISHED');
});
test('terminal alone times out as unknown cleanup, never a completed task',async()=>{
  const f=fixture();f.controller.start();await flush();f.stdout.write(wire(result()));f.clock.advance(100);
  const done=await f.controller.completion;assert.equal(done.completionKind,'cleanup-unknown');assert.equal(done.errorCode,'GROK_TURN_STOP_TIMEOUT');assert.equal(done.ownedTreeEmpty,false);assert.equal(done.taskSuccess,null);
});

test('recovered failed tool permits only protocol completion and retains the failure event',async()=>{
  const f=fixture();f.controller.start();await flush();
  f.stdout.write(wire({jsonrpc:'2.0',method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call',toolCallId:'optional-read',title:'Optional read',status:'failed'}}}));
  f.stdout.write(wire({jsonrpc:'2.0',method:'session/update',params:{sessionId:S,update:{sessionUpdate:'tool_call',toolCallId:'actual-read',title:'Actual read',status:'completed'}}}));
  f.stdout.write(wire(result()));const done=await close(f);
  assert.equal(done.replyComplete,true);assert.equal(done.completionKind,'reply-complete');assert.equal(done.taskSuccess,null);assert.equal(done.cleanupVerified,true);
  assert.ok(f.events.some(row=>row.type==='tool-state'&&row.toolCallId==='optional-read'&&row.status==='failed'));
  assert.equal(f.events.find(row=>row.type==='result').toolFailureObserved,true);
});
test('EOF without a prompt result fails even with successful process cleanup',async()=>{
  const f=fixture();f.controller.start();await flush();const done=await close(f);
  assert.equal(done.errorCode,'GROK_EOF_INCOMPLETE');assert.equal(done.completionKind,'failed');assert.equal(done.cleanupVerified,true);
});
test('owner once-only approval writes the exact response and receives descriptive tool completion',async()=>{
  const f=fixture();f.controller.start();await flush();f.stdout.write(wire(request()));
  const view=f.controller.pending();view[0].toolCall.rawInput.command='mutated copy';
  assert.equal(f.controller.pending()[0].toolCall.rawInput.command,'synthetic');
  f.controller.decide(f.owner,decision(f));await flush();
  assert.deepEqual(JSON.parse(f.writes[1]),{jsonrpc:'2.0',id:'permission-1',result:{outcome:{outcome:'selected',optionId:'allow-once'}}});
  f.stdout.write(wire(update('tool-1','completed')));f.stdout.write(wire(result()));const done=await close(f);
  assert.equal(done.completionKind,'reply-complete');assert.equal(f.events.find(e=>e.type==='tool-state').approvalVerified,false);
});
test('wrong owner, stale binding and persistent option fail closed and withdraw pending',async()=>{
  for(const variant of ['owner','scope','digest','persistent']){
    const f=fixture();f.controller.start();await flush();f.stdout.write(wire(request()));const d=decision(f);
    if(variant==='scope')d.runId='other';if(variant==='digest')d.requestSHA256='0'.repeat(64);if(variant==='persistent')d.optionId='enable-always-approve';
    assert.throws(()=>f.controller.decide(variant==='owner'?{}:f.owner,d),e=>e.code.startsWith('GROK_'));
    assert.deepEqual(f.controller.pending(),[]);assert.equal(f.stops.length,1);assert.equal(f.writes.length,1);
    const done=await close(f);assert.equal(done.completionKind,'failed');assert.ok(done.errorCode);
  }
});
test('writable backpressure preserves prompt then approval order',async()=>{
  const f=fixture({hold:true,backpressure:true});f.controller.start();f.stdout.write(wire(request()));f.controller.decide(f.owner,decision(f));
  assert.equal(f.writes.length,1);assert.equal(f.controller.snapshot().queuedFrames,2);
  f.held.shift()();await flush();assert.equal(f.writes.length,2);f.held.shift()();await flush();
  f.stdout.write(wire(update('tool-1','completed')));f.stdout.write(wire(result()));assert.equal((await close(f)).completionKind,'reply-complete');
});
test('outbound queue budget and stalled callbacks stop the backend with no late revival',async()=>{
  const f=fixture({hold:true,limits:{maxQueuedFrames:1}});f.controller.start();f.stdout.write(wire(request()));
  assert.throws(()=>f.controller.decide(f.owner,decision(f)),e=>e.code==='GROK_TURN_WRITE_BUDGET');
  const done=await close(f);assert.equal(done.errorCode,'GROK_TURN_WRITE_BUDGET');f.held.shift()();await flush();assert.equal(f.writes.length,1);assert.equal(f.controller.snapshot().completionKind,'failed');
  const g=fixture({hold:true});g.controller.start();g.clock.advance(100);assert.equal(g.stops.length,1);g.clock.advance(100);assert.equal((await g.controller.completion).errorCode,'GROK_TURN_WRITE_TIMEOUT');
});
test('cancel forwards cancel before cancelled permissions, then requires physical cleanup',async()=>{
  const f=fixture();f.controller.start();await flush();f.stdout.write(wire(request()));f.controller.cancel(f.owner,{sessionId:S,runId:R,confirm:true});await flush();
  assert.equal(JSON.parse(f.writes[1]).method,'session/cancel');assert.equal(JSON.parse(f.writes[2]).result.outcome.outcome,'cancelled');assert.deepEqual(f.controller.pending(),[]);
  const done=await close(f);assert.equal(done.completionKind,'cancelled');assert.equal(done.protocolTerminal,false);assert.equal(done.replyComplete,false);assert.equal(done.cleanupVerified,true);
});
test('cancel withdraws queued approvals before a blocked transport becomes writable',async()=>{
  const f=fixture({hold:true,backpressure:true});f.controller.start();
  f.stdout.write(wire(request()));f.controller.decide(f.owner,decision(f));
  f.stdout.write(wire(request('permission-2','tool-2')));
  assert.equal(f.writes.length,1);assert.equal(f.controller.snapshot().queuedFrames,2);
  f.controller.cancel(f.owner,{sessionId:S,runId:R,confirm:true});
  assert.deepEqual(f.controller.pending(),[]);
  assert.equal(f.controller.snapshot().queuedFrames,3);
  f.held.shift()();await flush();
  assert.equal(JSON.parse(f.writes[1]).method,'session/cancel');
  f.held.shift()();await flush();
  assert.deepEqual(JSON.parse(f.writes[2]),{jsonrpc:'2.0',id:'permission-2',result:{outcome:{outcome:'cancelled'}}});
  f.held.shift()();await flush();
  assert.equal(f.writes.length,3);
  assert.equal(f.writes.some(bytes=>JSON.parse(bytes).result?.outcome?.optionId==='allow-once'),false);
  assert.equal((await close(f)).completionKind,'cancelled');
});
test('extra stdout after terminal and raw stream errors cannot hide behind cleanup',async()=>{
  const f=fixture();f.controller.start();await flush();f.stdout.write(wire(result()));f.stdout.write(wire(message('extra')));
  assert.equal((await close(f)).errorCode,'GROK_DATA_AFTER_RESULT');
  const g=fixture();g.controller.start();await flush();g.stdout.emit('error',Error('PRIVATE_PAYLOAD'));
  const done=await close(g);assert.equal(done.errorCode,'GROK_TURN_STREAM_ERROR');assert.ok(!JSON.stringify(done).includes('PRIVATE_PAYLOAD'));
});
test('stderr handles split UTF8 but rejects malformed, NUL and byte overflow',async()=>{
  const f=fixture();f.controller.start();await flush();const bytes=Buffer.from('中');f.stderr.write(bytes.subarray(0,1));f.stderr.write(bytes.subarray(1));f.stdout.write(wire(result()));await close(f);
  assert.deepEqual(f.events.filter(e=>e.type==='stderr-observed'),[{type:'stderr-observed',bytes:3}]);
  for(const [bytes,limits,code]of [[Buffer.from([0xc0,0xaf]),{},'GROK_TURN_STDERR_UTF8'],[Buffer.from([0]),{},'GROK_TURN_STDERR_INVALID'],[Buffer.from('中'),{maxStderrBytes:2},'GROK_TURN_STDERR_BUDGET']]){
    const g=fixture({limits});g.controller.start();await flush();g.stderr.write(bytes);assert.equal((await close(g)).errorCode,code);
  }
});
test('wall, idle and permission clocks stop independently, including pending approvals',async()=>{
  for(const [kind,limits,amount,code]of [['idle',{},500,'GROK_TURN_IDLE_TIMEOUT'],['wall',{permissionTtlMs:2000},1000,'GROK_TURN_WALL_TIMEOUT'],['permission',{permissionTtlMs:30},30,'GROK_PERMISSION_EXPIRED']]){
    const f=fixture({limits});f.controller.start();await flush();if(kind!=='idle')f.stdout.write(wire(request()));f.clock.advance(amount);
    assert.equal(f.controller.snapshot().errorCode,code);assert.equal(f.stops.length,1);f.clock.advance(100);assert.equal((await f.controller.completion).completionKind,'cleanup-unknown');
  }
});
test('backend authority, scope, final receipt and nonzero exit are distinct gates',async()=>{
  for(const mode of ['authority','scope','tree','cleanup','exit']){
    const f=fixture();f.controller.start();await flush();f.stdout.write(wire(result()));f.stdout.end();f.stderr.end();await flush();
    const r=receipt(mode==='scope'?{runId:'other'}:mode==='tree'?{ownedTreeEmpty:false}:mode==='cleanup'?{cleanupVerified:false}:mode==='exit'?{exitCode:7}:{});
    if(['authority','scope'].includes(mode))assert.throws(()=>f.controller.reportExit(mode==='authority'?{}:f.backend,r),e=>e.code.startsWith('GROK_'));
    else f.controller.reportExit(f.backend,r);
    if(['authority','scope','tree','cleanup'].includes(mode))f.clock.advance(100);
    const done=await f.controller.completion;assert.equal(done.completionKind,mode==='exit'?'failed':'cleanup-unknown');
    assert.equal(done.cleanupVerified,mode==='exit');
  }
});
test('event delivery and backend stop failures stay explicit without leaking raw exceptions',async()=>{
  const f=fixture({event:event=>{if(event.type==='text-delta')throw Error('PRIVATE_PAYLOAD');}});f.controller.start();await flush();f.stdout.write(wire(message('synthetic')));
  assert.equal((await close(f)).errorCode,'GROK_TURN_EVENT_HANDLER_FAILED');
  const g=fixture({stop:()=>Promise.reject(Error('PRIVATE_PAYLOAD'))});g.controller.start();await flush();g.stdout.write(wire(result()));await flush();assert.equal((await close(g)).errorCode,'GROK_TURN_STOP_REQUEST_FAILED');
});
test('constructor rejects unknown fields, invalid prompt, relaxed budgets and shared authority',()=>{
  for(const change of [{extra:true},{prompt:'\ud800'},{prompt:'x\0y'},{prompt:'\x01'.repeat(65536)},{limits:{maxWallMs:LIMITS.maxWallMs+1}},{limits:{unknown:1}},{limits:{maxWallMs:0}}]){
    const f=fixture({deferCreate:true});assert.throws(()=>createTurnController({...f.options,...change}),e=>e.code.startsWith('GROK_'));f.stdin.destroy();f.stdout.destroy();f.stderr.destroy();
  }
  const f=fixture({deferCreate:true});assert.throws(()=>createTurnController({...f.options,backendAuthority:f.owner}),e=>e.code==='GROK_TURN_OPTIONS_INVALID');f.stdin.destroy();f.stdout.destroy();f.stderr.destroy();
});
test('escaped prompt frame budget is checked before handing ownership to streams',()=>{
  const f=fixture({deferCreate:true});assert.throws(()=>createTurnController({...f.options,prompt:'\x01'.repeat(65536)}),e=>e.code==='GROK_TURN_PROMPT_FRAME_SIZE');assert.equal(f.writes.length,0);assert.equal(f.stdout.listenerCount('data'),0);f.stdin.destroy();f.stdout.destroy();f.stderr.destroy();
});
test('endpoint ownership rejects text decoding, existing readers and flowing streams',()=>{
  for(const kind of ['encoding','reader','flowing']){
    const f=fixture({deferCreate:true});if(kind==='encoding')f.stdout.setEncoding('utf8');if(kind==='reader')f.stdout.on('readable',()=>{});if(kind==='flowing')f.stdout.resume();
    assert.throws(()=>createTurnController(f.options),e=>e.code==='GROK_TURN_ENDPOINT_NOT_EXCLUSIVE');f.stdin.destroy();f.stdout.destroy();f.stderr.destroy();
  }
});
test('two controllers cannot claim the same Writable before either start, even with distinct read streams',async()=>{
  const a=fixture({hold:true}),b=fixture({deferCreate:true,hold:true});
  assert.equal(a.writes.length,0);assert.equal(a.stdin.writableLength,0);
  assert.throws(()=>createTurnController({...b.options,sessionId:'other-session',runId:'other-run',promptRequestId:18,prompt:'other synthetic prompt',endpoint:{...b.options.endpoint,stdin:a.stdin}}),e=>e.code==='GROK_TURN_ENDPOINT_NOT_EXCLUSIVE');
  assert.equal(a.writes.length,0);assert.equal(b.writes.length,0);assert.equal(b.stdout.listenerCount('data'),0);assert.equal(b.stderr.listenerCount('data'),0);assert.equal(b.stops.length,0);
  b.stdin.destroy();b.stdout.destroy();b.stderr.destroy();
  a.controller.start();assert.equal(a.writes.length,1);assert.equal(JSON.parse(a.writes[0]).params.sessionId,S);a.held.shift()();await flush();a.stdout.write(wire(result()));assert.equal((await close(a)).completionKind,'reply-complete');
});
test('preoccupied Writable buffers, corks and outstanding backpressure are rejected before adoption',()=>{
  for(const kind of ['buffer','cork','drain']){
    const f=fixture({deferCreate:true,hold:kind==='buffer'||kind==='drain',backpressure:kind==='drain'});
    if(kind==='buffer'){f.stdin.write(Buffer.from('synthetic preexisting bytes'));assert.ok(f.stdin.writableLength>0);assert.equal(f.stdin.writableNeedDrain,false);}
    if(kind==='cork'){f.stdin.cork();assert.equal(f.stdin.writableLength,0);assert.ok(f.stdin.writableCorked>0);}
    if(kind==='drain'){assert.equal(f.stdin.write(Buffer.from('x')),false);assert.ok(f.stdin.writableLength>0);assert.equal(f.stdin.writableNeedDrain,true);}
    const writes=f.writes.length;assert.throws(()=>createTurnController(f.options),e=>e.code==='GROK_TURN_ENDPOINT_NOT_EXCLUSIVE');assert.equal(f.writes.length,writes);assert.equal(f.stdout.listenerCount('data'),0);assert.equal(f.stderr.listenerCount('data'),0);assert.equal(f.stops.length,0);
    if(f.held.length)f.held.shift()();if(f.stdin.writableCorked)f.stdin.uncork();f.stdin.destroy();f.stdout.destroy();f.stderr.destroy();
  }
});
test('failed constructor validation does not reserve otherwise healthy streams',async()=>{
  const f=fixture({deferCreate:true});assert.throws(()=>createTurnController({...f.options,prompt:'\x01'.repeat(65536)}),e=>e.code==='GROK_TURN_PROMPT_FRAME_SIZE');assert.equal(f.stdout.listenerCount('data'),0);
  f.controller=createTurnController(f.options);f.controller.start();await flush();f.stdout.write(wire(result()));assert.equal((await close(f)).completionKind,'reply-complete');
});
test('clock rollback cannot keep an approval alive or write a prompt with invalid clock bounds',async()=>{
  const f=fixture();f.controller.start();await flush();f.stdout.write(wire(request()));f.clock.wall--;
  assert.throws(()=>f.controller.pending(),e=>e.code==='GROK_CLOCK_INVALID');assert.equal((await close(f)).completionKind,'failed');
  const g=fixture();g.clock.wall=Number.MAX_SAFE_INTEGER;assert.throws(()=>g.controller.start(),e=>e.code==='GROK_CLOCK_INVALID');assert.equal(g.writes.length,0);await close(g);
});
test('early stream close and final callback failure are explicit failures',async()=>{
  const f=fixture();f.controller.start();await flush();f.stdout.destroy();await flush();f.stderr.end();await flush();f.controller.reportExit(f.backend,receipt());f.clock.advance(100);assert.equal((await f.controller.completion).errorCode,'GROK_TURN_STDOUT_CLOSED_EARLY');
  const g=fixture({event:event=>{if(event.type==='finished')throw Error('PRIVATE_PAYLOAD');}});g.controller.start();await flush();g.stdout.write(wire(result()));assert.equal((await close(g)).completionKind,'failed');
});
test('asynchronous event callbacks are rejected with handled rejections',async()=>{
  const g=fixture({deferCreate:true});const c=createTurnController({...g.options,onEvent:()=>Promise.reject(Error('PRIVATE_PAYLOAD'))});g.controller=c;c.start();await flush();g.stdout.write(wire(message('synthetic')));await flush();assert.equal((await close(g)).errorCode,'GROK_TURN_EVENT_HANDLER_FAILED');
});
test('arbitrary vendor stderr text never enters events, snapshots or completion',async()=>{
  const f=fixture();f.controller.start();await flush();f.stderr.write(Buffer.from('PRIVATE_TOKEN_MARKER'));f.stdout.write(wire(result()));const done=await close(f);
  assert.ok(!JSON.stringify({events:f.events,state:f.controller.snapshot(),done}).includes('PRIVATE_TOKEN_MARKER'));
  assert.equal(done.stderrBytes,Buffer.byteLength('PRIVATE_TOKEN_MARKER'));assert.equal(done.completionKind,'reply-complete');
});
test('closed schema agrees with actual synthetic messages, events and every completion kind',async()=>{
  const fs=require('node:fs'),path=require('node:path');
  const schemas=Object.fromEntries(['grok-turn-controller.schema.json','grok-protocol.schema.json'].map(name=>[name,JSON.parse(fs.readFileSync(path.join(__dirname,'../windows',name),'utf8'))]));
  const schema=schemas['grok-turn-controller.schema.json'];
  // Independent test-only evaluator for the keywords actually used here.
  // Runtime retains authority, digest, byte, Unicode and state-transition checks.
  function valid(rule,value,document=schema){
    if(rule.$ref){const [name,pointer]=rule.$ref.split('#');const target=name?schemas[name]:document;if(!target)throw Error('unresolved fixture schema');let ref=target;for(const key of pointer.split('/').slice(1))ref=ref[key];if(!valid(ref,value,target))return false;}
    if(rule.const!==undefined&&JSON.stringify(rule.const)!==JSON.stringify(value))return false;
    if(rule.enum&&!rule.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))return false;
    if(rule.not&&valid(rule.not,value,document))return false;
    if(rule.oneOf&&rule.oneOf.filter(x=>valid(x,value,document)).length!==1)return false;
    if(rule.anyOf&&!rule.anyOf.some(x=>valid(x,value,document)))return false;
    if(rule.allOf&&!rule.allOf.every(x=>valid(x,value,document)))return false;
    if(rule.if&&!valid(valid(rule.if,value,document)?rule.then||{}:rule.else||{},value,document))return false;
    if(rule.type){const types=Array.isArray(rule.type)?rule.type:[rule.type];if(!types.some(t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isInteger(value):typeof value===t))return false;}
    if(typeof value==='string'&&(rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength||rule.pattern&&!new RegExp(rule.pattern,'u').test(value)))return false;
    if(typeof value==='number'&&(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))return false;
    if(Array.isArray(value)){if(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)return false;if(rule.items&&!value.every(x=>valid(rule.items,x,document)))return false;if(rule.contains&&!value.some(x=>valid(rule.contains,x,document)))return false;}
    if(value!==null&&typeof value==='object'&&!Array.isArray(value)){if(rule.required&&!rule.required.every(k=>Object.hasOwn(value,k)))return false;for(const [key,item]of Object.entries(value)){if(rule.propertyNames&&!valid(rule.propertyNames,key,document))return false;if(rule.properties?.[key]){if(!valid(rule.properties[key],item,document))return false;}else if(rule.additionalProperties===false)return false;else if(rule.additionalProperties&&typeof rule.additionalProperties==='object'&&!valid(rule.additionalProperties,item,document))return false;}}
    return true;
  }
  const check=value=>{assert.equal(valid(schema,value),true,JSON.stringify(value));assert.equal(valid(schema,{...value,unexpected:true}),false);};
  const observed=new Set();
  for(const mode of ['reply-complete','incomplete','cancelled','failed','cleanup-unknown','remote-error']){
    const f=fixture();check(f.controller.snapshot());check(f.controller.start());await flush();check(JSON.parse(f.writes[0]));check(receipt());
    if(mode==='reply-complete'){
      f.stdout.write(wire(message('synthetic')));f.stderr.write(Buffer.from('private synthetic text'));f.stdout.write(wire(request()));check(decision(f));f.controller.decide(f.owner,decision(f));await flush();f.stdout.write(wire(update('tool-1','completed')));
    }
    if(mode==='cancelled'){const scope={sessionId:S,runId:R,confirm:true};check(scope);f.controller.cancel(f.owner,scope);}
    else if(mode==='remote-error')f.stdout.write(wire({jsonrpc:'2.0',id:P,error:{code:-32000,message:'not returned'}}));
    else if(mode!=='failed')f.stdout.write(wire(result(mode==='incomplete'?'max_tokens':'end_turn')));
    check(f.controller.snapshot());
    let done;if(mode==='cleanup-unknown'){f.clock.advance(100);done=await f.controller.completion;}else done=await close(f);
    observed.add(done.completionKind);check(done);for(const event of f.events)check(event);
    if(mode==='reply-complete')assert.equal(valid(schema,{...done,cleanupVerified:false}),false);
  }
  assert.deepEqual([...observed].sort(),['cancelled','cleanup-unknown','failed','incomplete','reply-complete']);
  assert.equal(valid(schema,{...receipt(),exitCode:null,signal:null}),false);
});
test('stream turn support never changes Grok registry readiness',()=>{
  const registry=require('../lib/provider-registry');for(const platform of ['win32','linux','darwin'])assert.equal(registry.status('grok',{platform}).ready,false);
});
