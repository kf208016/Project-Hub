'use strict';
const nodeTest=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const test=(name,fn)=>nodeTest(name,{timeout:3000},fn);
const {PassThrough,Writable}=require('node:stream'),{createHash}=require('node:crypto');
const {createTurnController,LIMITS,SOURCE}=require('../lib/providers/claude-turn-controller');
const S='synthetic-session',R='synthetic-run',B='synthetic-owned-backend';
const wire=x=>Buffer.from(JSON.stringify(x)+'\n'),flush=()=>new Promise(resolve=>setImmediate(resolve));
const init=()=>({type:'system',subtype:'init',session_id:S,uuid:'init-1',permissionMode:'default'});
const result=extra=>({type:'result',subtype:'success',session_id:S,uuid:'result-1',duration_ms:1,duration_api_ms:1,is_error:false,num_turns:1,result:'合成回覆',...extra});
const request=(id='permission-1',tool='tool-1')=>({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:'Read',input:{file_path:'synthetic.txt',limit:20},tool_use_id:tool}});
class Clock{
  constructor(){this.wall=1000;this.mono=2000;this.sequence=0;this.tasks=new Map();}
  schedule=(fn,ms)=>{const id=++this.sequence;this.tasks.set(id,{at:this.mono+ms,fn});return id;};
  cancel=id=>this.tasks.delete(id);
  advance(ms){const target=this.mono+ms;let count=0;while(true){const next=[...this.tasks.entries()].filter(([,x])=>x.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;assert.ok(++count<10000);const [id,x]=next,delta=x.at-this.mono;this.wall+=delta;this.mono=x.at;this.tasks.delete(id);x.fn();}this.wall+=target-this.mono;this.mono=target;}
}
function fixture(extra={}){
  const owner={},backend={},events=[],writes=[],stops=[],held=[],clock=new Clock(),stdout=new PassThrough(),stderr=new PassThrough();
  const stdin=new Writable({highWaterMark:extra.backpressure?1:16384,write(bytes,_encoding,callback){writes.push(Buffer.from(bytes));if(extra.hold)held.push(callback);else callback();}});
  const options={sessionId:S,runId:R,prompt:'繁體中文合成輸入',ownerAuthority:owner,backendAuthority:backend,endpoint:{backendId:B,stdin,stdout,stderr,requestStop:info=>{stops.push(info);return extra.stop?.(info);}},onEvent:event=>{events.push(event);return extra.event?.(event);},now:()=>clock.wall,monotonic:()=>clock.mono,schedule:clock.schedule,cancelSchedule:clock.cancel,limits:{maxWallMs:1000,maxIdleMs:500,maxWriteMs:100,maxStopMs:100,permissionTtlMs:300,...extra.limits}};
  return {controller:extra.deferCreate?null:createTurnController(options),owner,backend,events,writes,stops,held,clock,stdin,stdout,stderr,options};
}
async function begin(f){f.controller.start();await flush();f.stdout.write(wire(init()));}
const receipt=extra=>({backendId:B,sessionId:S,runId:R,rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0,signal:null,...extra});
const scope=()=>({sessionId:S,runId:R,confirm:true});
function decision(f,value='allow'){const p=f.controller.pending()[0];return {sessionId:S,runId:R,requestId:p.requestId,requestSHA256:p.requestSHA256,decision:value,confirm:true};}
async function close(f,extra={}){if(!f.stdout.destroyed)f.stdout.end();if(!f.stderr.destroyed)f.stderr.end();await flush();if(f.controller.snapshot().phase!=='finished')f.controller.reportExit(f.backend,receipt(extra));return f.controller.completion;}
function discard(f){f.stdin.destroy();f.stdout.destroy();f.stderr.destroy();}

test('source pin and user wire are SDK-derived, not an ACP or live compatibility claim',async()=>{
  const f=fixture();await begin(f);
  assert.equal(SOURCE.revision,'615d88b9baebfe155263fbdd2ca22cecc1da3430');assert.equal(SOURCE.liveProtocolVerified,false);
  assert.equal(SOURCE.clientSHA256,'70740865b70711cdd6b9b06ef5553a6b0026f020aea5ed38a75bdf9d547331ea');
  assert.deepEqual(JSON.parse(f.writes[0]),{type:'user',message:{role:'user',content:'繁體中文合成輸入'},parent_tool_use_id:null,session_id:S});assert.equal(f.writes[0].at(-1),10);
  assert.equal(f.controller.snapshot().promptSHA256,createHash('sha256').update('繁體中文合成輸入').digest('hex'));
  f.stdout.write(wire(result()));const done=await close(f);assert.equal(done.completionKind,'reply-complete');assert.equal(done.taskSuccess,null);assert.equal(f.clock.tasks.size,0);
  assert.equal(require('../lib/provider-registry').status('claude',{platform:'win32'}).ready,false);
});
test('result waits for both EOFs and the bound final tree receipt; it never completes a task',async()=>{
  const f=fixture();await begin(f);f.stdout.write(wire(result()));assert.equal(f.controller.snapshot().phase,'stopping');assert.equal(f.stops[0].reasonCode,'CLAUDE_TURN_TERMINAL');assert.equal(f.controller.snapshot().cleanupVerified,false);
  f.controller.reportExit(f.backend,receipt());f.stdout.end();await flush();assert.notEqual(f.controller.snapshot().phase,'finished');f.stderr.end();const done=await f.controller.completion;
  assert.equal(done.responseComplete,true);assert.equal(done.cleanupVerified,true);assert.equal(done.taskSuccess,null);assert.equal(f.events.filter(x=>x.type==='finished').length,1);
  const saved=f.controller.snapshot();assert.throws(()=>f.controller.start(),e=>e.code==='CLAUDE_TURN_FINISHED');assert.deepEqual(f.controller.snapshot(),saved);
});
test('permission is a deep copy and owner allow retains the exact original input',async()=>{
  const f=fixture();await begin(f);f.stdout.write(wire(request()));f.controller.pending()[0].input.limit=999;f.events.find(x=>x.type==='permission').input.file_path='mutated';
  assert.deepEqual(f.controller.pending()[0].input,{file_path:'synthetic.txt',limit:20});f.controller.decide(f.owner,decision(f));await flush();
  assert.deepEqual(JSON.parse(f.writes[1]),{type:'control_response',response:{subtype:'success',request_id:'permission-1',response:{behavior:'allow',updatedInput:{file_path:'synthetic.txt',limit:20}}}});
  f.stdout.write(wire(result()));assert.equal((await close(f)).completionKind,'reply-complete');
});
test('owner denial and observed refusal stop reasons remain incomplete, not task success',async()=>{
  const f=fixture();await begin(f);f.stdout.write(wire(request()));f.controller.decide(f.owner,decision(f,'deny'));await flush();assert.deepEqual(JSON.parse(f.writes[1]).response.response,{behavior:'deny',message:'Denied by Hub owner'});f.stdout.write(wire(result()));assert.equal((await close(f)).completionKind,'incomplete');
  const g=fixture();await begin(g);g.stdout.write(wire(result({stop_reason:'max_tokens'})));const done=await close(g);assert.equal(done.completionKind,'incomplete');assert.equal(done.responseComplete,false);assert.equal(done.taskSuccess,null);
});
test('remote result errors and unsuccessful process exits cannot become reply-complete',async()=>{
  for(const [extra,exit,code]of [[{subtype:'error_during_execution',is_error:true,errors:['synthetic error']},0,'CLAUDE_TURN_REMOTE_ERROR'],[{},125,'CLAUDE_TURN_EXIT_UNSUCCESSFUL']]){const f=fixture();await begin(f);f.stdout.write(wire(result(extra)));const done=await close(f,{exitCode:exit});assert.equal(done.completionKind,'failed');assert.equal(done.errorCode,code);assert.equal(done.taskSuccess,null);}
});
test('wrong owner, scope, digest, unknown input changes and replay permanently stop decisions',async()=>{
  for(const variant of ['owner','scope','digest','input','confirm','replay']){
    const f=fixture();await begin(f);f.stdout.write(wire(request()));const d=decision(f);if(variant==='scope')d.runId='other';if(variant==='digest')d.requestSHA256='0'.repeat(64);if(variant==='input')d.updatedInput={};if(variant==='confirm')d.confirm=false;
    if(variant==='replay'){f.controller.decide(f.owner,d);await flush();}
    assert.throws(()=>f.controller.decide(variant==='owner'?{}:f.owner,d),e=>e.code.startsWith('CLAUDE_'));assert.deepEqual(f.controller.pending(),[]);assert.equal(f.stops.length,1);assert.equal((await close(f)).completionKind,'failed');
  }
});
test('backpressure preserves user then permission response order',async()=>{
  const f=fixture({hold:true,backpressure:true});await begin(f);f.stdout.write(wire(request()));f.controller.decide(f.owner,decision(f));assert.equal(f.writes.length,1);assert.equal(f.controller.snapshot().queuedFrames,2);
  f.held.shift()();await flush();assert.equal(f.writes.length,2);f.held.shift()();await flush();f.stdout.write(wire(result()));assert.equal((await close(f)).completionKind,'reply-complete');
});
test('cancel withdraws queued allow before releasing a blocked write and invents no vendor cancel',async()=>{
  const f=fixture({hold:true,backpressure:true});await begin(f);f.stdout.write(wire(request()));f.controller.decide(f.owner,decision(f));f.stdout.write(wire(request('permission-2','tool-2')));
  assert.equal(f.controller.snapshot().queuedFrames,2);f.controller.cancel(f.owner,scope());assert.deepEqual(f.controller.pending(),[]);assert.equal(f.controller.snapshot().queuedFrames,1);assert.equal(f.stops[0].reasonCode,'CLAUDE_TURN_OWNER_CANCELLED');
  f.held.shift()();await flush();assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.writes[0]).type,'user');const done=await close(f,{exitCode:125});assert.equal(done.completionKind,'cancelled');assert.equal(done.responseComplete,false);assert.equal(done.protocolTerminal,false);
});
test('cancel cannot recall an allow already handed to the transport',async()=>{
  const f=fixture({hold:true});await begin(f);f.held.shift()();await flush();f.stdout.write(wire(request()));f.controller.decide(f.owner,decision(f));assert.equal(f.writes.length,2);assert.equal(JSON.parse(f.writes[1]).response.response.behavior,'allow');
  f.controller.cancel(f.owner,scope());assert.equal(f.controller.snapshot().queuedFrames,1);f.held.shift()();await flush();assert.equal(f.writes.length,2);assert.equal((await close(f,{exitCode:125})).completionKind,'cancelled');
});
test('cancel validates owner and scope and cannot mask malformed UTF8 or a truncated line',async()=>{
  for(const variant of ['owner','scope']){const f=fixture();await begin(f);assert.throws(()=>f.controller.cancel(variant==='owner'?{}:f.owner,{...scope(),...(variant==='scope'?{runId:'other'}:{})}),e=>e.code.startsWith('CLAUDE_'));assert.equal((await close(f)).completionKind,'failed');}
  for(const bytes of [Buffer.from([0xc0,0xaf,10]),Buffer.from('{')]){const f=fixture();await begin(f);f.controller.cancel(f.owner,scope());f.stdout.write(bytes);const done=await close(f);assert.equal(done.completionKind,'failed');assert.notEqual(done.errorCode,null);}
});
test('pending expiry, idle, wall and backwards clocks are independent gates',async()=>{
  for(const [kind,limits,amount,code]of [['idle',{},500,'CLAUDE_TURN_IDLE_TIMEOUT'],['wall',{permissionTtlMs:2000},1000,'CLAUDE_TURN_WALL_TIMEOUT'],['permission',{permissionTtlMs:30},30,'CLAUDE_PERMISSION_EXPIRED']]){
    const f=fixture({limits});await begin(f);if(kind!=='idle')f.stdout.write(wire(request()));f.clock.advance(amount);assert.equal(f.controller.snapshot().errorCode,code);assert.deepEqual(f.controller.pending(),[]);f.clock.advance(100);assert.equal((await f.controller.completion).completionKind,'cleanup-unknown');
  }
  const f=fixture();await begin(f);f.clock.wall--;assert.throws(()=>f.controller.pending(),e=>e.code==='CLAUDE_CLOCK_INVALID');f.clock.advance(100);assert.equal((await f.controller.completion).errorCode,'CLAUDE_CLOCK_INVALID');
});
test('outbound frame count, bytes and stalled write callbacks are bounded',async()=>{
  for(const limits of [{maxQueuedFrames:1},{maxQueuedBytes:200}]){const f=fixture({hold:true,limits});await begin(f);f.stdout.write(wire(request()));assert.throws(()=>f.controller.decide(f.owner,decision(f)),e=>e.code==='CLAUDE_TURN_WRITE_BUDGET');const done=await close(f);assert.equal(done.errorCode,'CLAUDE_TURN_WRITE_BUDGET');f.held.shift()();await flush();assert.equal(f.writes.length,1);}
  const f=fixture({hold:true});f.controller.start();f.clock.advance(100);assert.equal(f.controller.snapshot().errorCode,'CLAUDE_TURN_WRITE_TIMEOUT');f.clock.advance(100);assert.equal((await f.controller.completion).completionKind,'cleanup-unknown');f.held.shift()();await flush();assert.equal(f.controller.snapshot().phase,'finished');
});
test('premature EOF, missing init, cross-session and bytes after result remain explicit failures',async()=>{
  const cases=[{bytes:null,code:'CLAUDE_EOF_INCOMPLETE'},{bytes:wire(result()),withoutInit:true,code:'CLAUDE_STATE_INVALID'},{bytes:wire({...result(),session_id:'other'}),code:'CLAUDE_SESSION_MISMATCH'},{bytes:Buffer.concat([wire(result()),Buffer.from('extra')]),code:'CLAUDE_DATA_AFTER_RESULT'}];
  for(const c of cases){const f=fixture();if(c.withoutInit){f.controller.start();await flush();}else await begin(f);if(c.bytes)f.stdout.write(c.bytes);const done=await close(f);assert.equal(done.completionKind,'failed');assert.equal(done.errorCode,c.code);}
});
test('SDK initialize responses and foreign control methods never enable a fallback protocol',async()=>{
  for(const frame of [{type:'control_response',response:{subtype:'success',request_id:'initialize-1',response:{}}},{type:'control_request',request_id:'initialize-1',request:{subtype:'initialize'}}]){const f=fixture();await begin(f);f.stdout.write(wire(frame));const done=await close(f);assert.equal(done.completionKind,'failed');assert.ok(done.errorCode.startsWith('CLAUDE_'));assert.equal(f.writes.length,1);assert.deepEqual(f.controller.pending(),[]);}
});
test('stderr is split-UTF8 validated, bounded and counted without forwarding raw text',async()=>{
  const f=fixture();await begin(f);const secret=Buffer.from('PRIVATE合成');f.stderr.write(secret.subarray(0,8));f.stderr.write(secret.subarray(8));f.stdout.write(wire(result()));const done=await close(f);assert.deepEqual(f.events.filter(x=>x.type==='stderr-observed'),[{type:'stderr-observed',bytes:secret.length}]);assert.ok(!JSON.stringify([done,f.events]).includes('PRIVATE'));
  for(const [bytes,limits,code]of [[Buffer.from([0xc0,0xaf]),{},'CLAUDE_TURN_STDERR_UTF8'],[Buffer.from([0]),{},'CLAUDE_TURN_STDERR_INVALID'],[Buffer.from('中'),{maxStderrBytes:2},'CLAUDE_TURN_STDERR_BUDGET'],[Buffer.from([0xe4]),{},'CLAUDE_TURN_STDERR_UTF8']]){const g=fixture({limits});await begin(g);g.stderr.write(bytes);if(!g.controller.snapshot().errorCode)g.stdout.write(wire(result()));assert.equal((await close(g)).errorCode,code);}
});
test('terminal without physical cleanup times out as unknown and no late receipt revives it',async()=>{
  const f=fixture();await begin(f);f.stdout.write(wire(result()));f.clock.advance(100);const done=await f.controller.completion;assert.equal(done.completionKind,'cleanup-unknown');assert.equal(done.errorCode,'CLAUDE_TURN_STOP_TIMEOUT');assert.equal(done.responseComplete,true);assert.equal(done.taskSuccess,null);assert.throws(()=>f.controller.reportExit(f.backend,receipt()),e=>e.code==='CLAUDE_TURN_FINISHED');assert.deepEqual(f.controller.snapshot(),done);
});
test('backend authority, receipt scope, root/tree observation and final replay are separate gates',async()=>{
  for(const mode of ['authority','scope','root','tree','cleanup','replay']){
    const f=fixture();await begin(f);f.stdout.write(wire(result()));const r=receipt(mode==='scope'?{runId:'other'}:mode==='root'?{rootExited:false}:mode==='tree'?{ownedTreeEmpty:false}:mode==='cleanup'?{cleanupVerified:false}:{});
    if(['authority','scope','root'].includes(mode))assert.throws(()=>f.controller.reportExit(mode==='authority'?{}:f.backend,r),e=>e.code.startsWith('CLAUDE_'));
    else {f.controller.reportExit(f.backend,r);if(mode==='replay')assert.throws(()=>f.controller.reportExit(f.backend,r),e=>e.code==='CLAUDE_TURN_EXIT_REPLAY');}
    f.stdout.end();f.stderr.end();await flush();if(['authority','scope','root','tree','cleanup'].includes(mode))f.clock.advance(100);const done=await f.controller.completion;assert.equal(done.completionKind,mode==='replay'?'failed':'cleanup-unknown');
  }
});
test('stream, event and Stop exceptions never expose raw exception messages',async()=>{
  for(const kind of ['stream','event','stop']){const f=fixture(kind==='event'?{event:e=>{if(e.type==='session')throw Error('PRIVATE_EXCEPTION');}}:kind==='stop'?{stop:()=>Promise.reject(Error('PRIVATE_EXCEPTION'))}:{});await begin(f);if(kind==='stream')f.stdout.emit('error',Error('PRIVATE_EXCEPTION'));if(kind==='stop'){f.stdout.write(wire(result()));await flush();}const done=await close(f);assert.equal(done.completionKind,'failed');assert.ok(!JSON.stringify([done,f.events]).includes('PRIVATE_EXCEPTION'));}
});
test('async event handlers, early stream close and non-Buffer data fail closed',async()=>{
  const f=fixture({event:()=>Promise.resolve()});await begin(f);assert.equal((await close(f)).errorCode,'CLAUDE_TURN_EVENT_HANDLER_FAILED');
  const g=fixture();await begin(g);g.stdout.emit('data','PRIVATE_PAYLOAD');assert.equal((await close(g)).errorCode,'CLAUDE_TURN_CHUNK_INVALID');
  const h=fixture();await begin(h);h.stdout.destroy();await flush();h.clock.advance(100);assert.equal((await h.controller.completion).errorCode,'CLAUDE_TURN_STDOUT_CLOSED_EARLY');
});
test('constructor rejects relaxed limits, unknown options, bad prompts and pre-owned endpoints before adoption',()=>{
  for(const change of [{unknown:true},{prompt:''},{prompt:'\ud800'},{prompt:'a\0b'},{prompt:'x'.repeat(65537)},{prompt:'\x01'.repeat(65536)},{limits:{maxWallMs:LIMITS.maxWallMs+1}},{limits:{unknown:1}},{limits:{maxWriteMs:0}},{now:null}]){const f=fixture({deferCreate:true});assert.throws(()=>createTurnController({...f.options,...change}),e=>e.code.startsWith('CLAUDE_'));assert.equal(f.stdout.listenerCount('data'),0);discard(f);}
  const f=fixture({deferCreate:true});assert.throws(()=>createTurnController({...f.options,backendAuthority:f.owner}),e=>e.code==='CLAUDE_TURN_OPTIONS_INVALID');f.stdout.setEncoding('utf8');assert.throws(()=>createTurnController(f.options),e=>e.code==='CLAUDE_TURN_ENDPOINT_NOT_EXCLUSIVE');discard(f);
});
test('a Writable cannot be claimed by another controller even with different read streams',async()=>{
  const f=fixture(),g=fixture({deferCreate:true});assert.throws(()=>createTurnController({...g.options,endpoint:{...g.options.endpoint,stdin:f.stdin}}),e=>e.code==='CLAUDE_TURN_ENDPOINT_NOT_EXCLUSIVE');assert.equal(g.stdout.listenerCount('data'),0);discard(g);await begin(f);f.stdout.write(wire(result()));assert.equal((await close(f)).completionKind,'reply-complete');
});

// Deliberately independent, test-only Schema keyword subset, not a general validator.
function validate(schema,value,document,documents){
  if(schema.$ref){const [name,fragment]=schema.$ref.split('#'),doc=name?documents[name]:document;return validate(fragment?fragment.slice(1).split('/').filter(Boolean).reduce((x,k)=>x[k],doc):doc,value,doc,documents);}
  if(schema.oneOf&&schema.oneOf.filter(s=>validate(s,value,document,documents)).length!==1)return false;
  if(schema.anyOf&&!schema.anyOf.some(s=>validate(s,value,document,documents)))return false;
  if(schema.allOf&&!schema.allOf.every(s=>validate(s,value,document,documents)))return false;
  if(schema.not&&validate(schema.not,value,document,documents))return false;
  if(schema.if&&!validate(validate(schema.if,value,document,documents)?schema.then||{}:schema.else||{},value,document,documents))return false;
  if(Object.hasOwn(schema,'const')&&JSON.stringify(value)!==JSON.stringify(schema.const))return false;
  if(schema.enum&&!schema.enum.some(x=>JSON.stringify(value)===JSON.stringify(x)))return false;
  if(schema.type){const types={object:value!==null&&typeof value==='object'&&!Array.isArray(value),array:Array.isArray(value),string:typeof value==='string',integer:Number.isSafeInteger(value),number:typeof value==='number'&&Number.isFinite(value),boolean:typeof value==='boolean',null:value===null};if(!types[schema.type])return false;}
  if(typeof value==='string'&&(schema.pattern&&!new RegExp(schema.pattern).test(value)||schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength))return false;
  if(typeof value==='number'&&(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))return false;
  if(Array.isArray(value)&&(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems||schema.items&&!value.every(x=>validate(schema.items,x,document,documents))))return false;
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){if(schema.required?.some(k=>!Object.hasOwn(value,k)))return false;for(const [k,v]of Object.entries(value)){if(schema.properties?.[k]){if(!validate(schema.properties[k],v,document,documents))return false;}else if(schema.additionalProperties===false)return false;}}
  return true;
}
test('closed Schema matches actual wire, decisions, receipts, events and states and rejects promoted success',async()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/claude-turn-controller.schema.json'))),documents={'claude-protocol.schema.json':JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/claude-protocol.schema.json')))};
  const f=fixture(),states=[f.controller.snapshot()];await begin(f);states.push(f.controller.snapshot());f.stdout.write(wire(request()));const d=decision(f);f.controller.decide(f.owner,d);await flush();f.stdout.write(wire(result()));states.push(f.controller.snapshot());states.push(await close(f));
  for(const value of [...states,...f.events,d,scope(),receipt(),...f.writes.map(x=>JSON.parse(x))])assert.equal(validate(schema,value,schema,documents),true,JSON.stringify(value));
  for(const value of [{...states.at(-1),taskSuccess:true},{...d,updatedInput:{}},{...receipt(),extra:true},{...JSON.parse(f.writes[0]),jsonrpc:'2.0'},{...states.at(-1),cleanupVerified:false}])assert.equal(validate(schema,value,schema,documents),false);
});
test('source-derived assistant and stream fixtures retain codec semantics and match the controller Schema',async()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/claude-turn-controller.schema.json'))),documents={'claude-protocol.schema.json':JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/claude-protocol.schema.json')))};
  for(const name of ['text-stream.jsonl','tool-turn.jsonl']){const f=fixture();f.controller.start();await flush();const rows=fs.readFileSync(path.join(__dirname,'fixtures/claude-protocol',name),'utf8').trimEnd().split('\n').map(x=>JSON.parse(x));for(const row of rows){if(Object.hasOwn(row,'session_id'))row.session_id=S;f.stdout.write(wire(row));if(f.controller.pending().length){f.controller.decide(f.owner,decision(f));await flush();}}assert.equal((await close(f)).completionKind,'reply-complete');for(const event of f.events)assert.equal(validate(schema,event,schema,documents),true,JSON.stringify(event));}
});
