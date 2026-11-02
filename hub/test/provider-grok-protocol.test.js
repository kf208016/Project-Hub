'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createProtocol,decode,SOURCE,LIMITS}=require('../lib/providers/grok-protocol');
const registry=require('../lib/provider-registry');
const S='session-fixture',R='run-fixture',P=17;
const wire=x=>Buffer.from(JSON.stringify(x)+'\n');
const options=()=>[{optionId:'allow-once',name:'允許這次',kind:'allow_once'},{optionId:'reject-once',name:'拒絕這次',kind:'reject_once'},{optionId:'enable-always-approve',name:'Enable automatic approval',kind:'allow_once'}];
const request=(id='permission-1',tool='tool-1')=>({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:S,toolCall:{toolCallId:tool,title:'Synthetic operation',kind:'execute',status:'pending',rawInput:{command:'synthetic',count:1}},options:options()}});
const update=(update,sessionId=S)=>({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
const text=value=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}});
const result=(stopReason='end_turn')=>({jsonrpc:'2.0',id:P,result:{stopReason}});
function fixture(extra={}){const owner=Object.freeze({}),time={wall:1000,mono:2000};const protocol=createProtocol({sessionId:S,runId:R,promptRequestId:P,ownerAuthority:owner,now:()=>time.wall,monotonic:()=>time.mono,...extra});return {protocol,owner,time};}
function decision(p,optionId='allow-once'){const item=p.pending()[0];return {sessionId:S,runId:R,requestId:item.requestId,requestSHA256:item.requestSHA256,optionId,confirm:true};}
function failure(p,fn,code){assert.throws(fn,error=>error.code===code&&error.message===code&&!error.message.includes('PRIVATE_PAYLOAD'));assert.equal(p.state().phase,'failed');assert.equal(p.state().pending,0);assert.throws(()=>p.tick(),error=>error.code===code);}

test('Grok source-derived contract remains separate from binary verification and readiness',()=>{
 const source=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/grok-protocol/source.json'),'utf8'));
 assert.equal(SOURCE.revision,source.revision);assert.equal(SOURCE.acpSchemaSHA256,source.acpSchema.sha256);assert.equal(source.fixtureProvenance,'generated-from-source');
 assert.equal(SOURCE.binaryVersionVerified,false);assert.equal(SOURCE.liveProtocolVerified,false);assert.equal(source.grok1050SourceMappingVerified,false);
 for(const platform of ['win32','linux','darwin'])assert.equal(registry.status('grok',{platform}).ready,false);
});
test('source-derived permission fixture needs an explicit owner decision and preserves exact input digest',()=>{
 const {protocol:p,owner}=fixture();const row=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/grok-protocol/permission.jsonl'),'utf8'));
 const [event]=p.push(wire(row));assert.equal(event.type,'permission');assert.match(event.inputSHA256,/^[a-f0-9]{64}$/);assert.equal(p.state().pending,1);
 const out=p.decide(owner,decision(p));assert.deepEqual(JSON.parse(out),{jsonrpc:'2.0',id:'permission-1',result:{outcome:{outcome:'selected',optionId:'allow-once'}}});assert.equal(p.state().pending,0);
 assert.deepEqual(p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'})))[0],{type:'tool-state',toolCallId:'tool-1',status:'completed',descriptiveOnly:true,approvalVerified:false});
 p.push(wire(text('已收到合成回覆。')));p.push(wire(result()));const end=p.end();assert.equal(end.replyComplete,true);assert.equal(end.taskSuccess,null);assert.equal(end.terminal,true);
});
test('permission rejection remains incomplete even when provider says end_turn',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(request()));p.decide(owner,decision(p,'reject-once'));p.push(wire(result()));const end=p.end();assert.equal(end.permissionDenied,true);assert.equal(end.replyComplete,false);assert.equal(end.taskSuccess,null);
});
test('descriptive completed tool state is never an approval or task success receipt',()=>{
 const {protocol:p}=fixture();const [event]=p.push(wire(update({sessionUpdate:'tool_call',toolCallId:'descriptive',title:'Provider self report',status:'completed',rawInput:{file:'synthetic'}})));
 assert.equal(event.approvalVerified,false);assert.equal(p.pending().length,0);p.push(wire(result()));assert.equal(p.end().taskSuccess,null);
});
test('partial permission toolCall resolves only against the preceding exact tool input',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Synthetic operation',rawInput:{command:'synthetic'}})));
 const r=request();r.params.toolCall={toolCallId:'tool-1'};p.push(wire(r));assert.deepEqual(p.pending()[0].toolCall.rawInput,{command:'synthetic'});p.decide(owner,decision(p));
 const missing=fixture().protocol,r2=request();r2.params.toolCall={toolCallId:'tool-1'};failure(missing,()=>missing.push(wire(r2)),'GROK_PERMISSION_INPUT_REQUIRED');
});
test('changed raw input, pending metadata and terminal tool state fail closed',()=>{
 for(const change of [{rawInput:{command:'changed'}},{title:'Changed review'},{status:'in_progress'}]){const {protocol:p}=fixture();p.push(wire(request()));failure(p,()=>p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',...change}))),change.rawInput?'GROK_TOOL_INPUT_CHANGED':'GROK_PERMISSION_STATE_CONFLICT');}
 const {protocol:p}=fixture();p.push(wire(update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'done',status:'completed'})));failure(p,()=>p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'pending'}))),'GROK_TOOL_STATE_INVALID');
});

test('a previously absent tool input may be supplied before permission and is then immutable',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Synthetic operation'})));
 p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',rawInput:{command:'synthetic'}})));
 const r=request();r.params.toolCall={toolCallId:'tool-1'};p.push(wire(r));assert.deepEqual(p.pending()[0].toolCall.rawInput,{command:'synthetic'});
 p.decide(owner,decision(p));failure(p,()=>p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',rawInput:{command:'changed'}}))),'GROK_TOOL_INPUT_CHANGED');
 const f=fixture();f.protocol.push(wire(update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Synthetic operation',rawInput:{command:'first'}})));
 failure(f.protocol,()=>f.protocol.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',rawInput:{command:'second'}}))),'GROK_TOOL_INPUT_CHANGED');
});

test('permission decisions preserve reviewed tool identity while allowing status and result updates',()=>{
 for(const optionId of ['allow-once','reject-once'])for(const change of [{title:'Changed after decision'},{kind:'read'},{_meta:{review:'changed'}}]){
   const {protocol:p,owner}=fixture();p.push(wire(request()));p.decide(owner,decision(p,optionId));failure(p,()=>p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',...change}))),'GROK_PERMISSION_IDENTITY_CHANGED');
 }
 const {protocol:p,owner}=fixture();p.push(wire(request()));p.decide(owner,decision(p));
 assert.equal(p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'in_progress',rawOutput:{stage:'synthetic'}})))[0].status,'in_progress');
 p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{result:'synthetic'}})));p.push(wire(result()));assert.equal(p.end().replyComplete,true);
});

test('cancellation drains existing tool state but rejects new tools and keeps reviewed identity',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(request()));p.decide(owner,decision(p));p.cancel(owner,{sessionId:S,runId:R,confirm:true});
 p.push(wire(text('Synthetic cancellation acknowledgement')));p.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:{cancelled:true}})));p.push(wire(result('cancelled')));assert.equal(p.end().cancelled,true);
 const f=fixture();f.protocol.cancel(f.owner,{sessionId:S,runId:R,confirm:true});failure(f.protocol,()=>f.protocol.push(wire(update({sessionUpdate:'tool_call',toolCallId:'new-tool',title:'New after cancellation'}))),'GROK_STATE_INVALID');
 const q=fixture();q.protocol.push(wire(request()));q.protocol.cancel(q.owner,{sessionId:S,runId:R,confirm:true});failure(q.protocol,()=>q.protocol.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',title:'Changed after cancellation'}))),'GROK_PERMISSION_IDENTITY_CHANGED');
});
test('request digest is canonical and binds run, session, prompt id, options and exact input',()=>{
 const baseline=()=>{const f=fixture();f.protocol.push(wire(request()));return f.protocol.pending()[0].requestSHA256;},hash=baseline();
 const reorder=fixture(),r=request();r.params.toolCall.rawInput={count:1,command:'synthetic'};reorder.protocol.push(wire(r));assert.equal(reorder.protocol.pending()[0].requestSHA256,hash);
 for(const extra of [{runId:'another-run'},{promptRequestId:18}]){const f=fixture(extra);f.protocol.push(wire(request()));assert.notEqual(f.protocol.pending()[0].requestSHA256,hash);}
 for(const mutate of [r=>r.params.toolCall.rawInput.count++,r=>r.params.options[0].name='Different label',r=>r.params._meta={review:'different'}]){const f=fixture(),r=request();mutate(r);f.protocol.push(wire(r));assert.notEqual(f.protocol.pending()[0].requestSHA256,hash);}
});
test('wrong owner, scope, stale digest, missing confirmation or modified decision fields permanently fail',()=>{
 for(const mutate of [d=>d.runId='other',d=>d.sessionId='other',d=>d.requestId='stale',d=>d.requestSHA256='0'.repeat(64),d=>d.confirm=false,d=>d.rawInput={command:'changed'}]){const {protocol:p,owner}=fixture();p.push(wire(request()));const d=decision(p);mutate(d);assert.throws(()=>p.decide(owner,d),e=>e.code.startsWith('GROK_'));assert.equal(p.state().phase,'failed');assert.equal(p.state().pending,0);}
 const {protocol:p}=fixture();p.push(wire(request()));failure(p,()=>p.decide({},decision(p)),'GROK_OWNER_REQUIRED');
});
test('special YOLO option marked allow_once and all persistent or invented options cannot be selected',()=>{
 for(const optionId of ['enable-always-approve','allow-always','reject-always','invented']){const {protocol:p,owner}=fixture();p.push(wire(request()));failure(p,()=>p.decide(owner,decision(p,optionId)),'GROK_PERMISSION_OPTION_FORBIDDEN');}
 for(const mutate of [r=>r.params.options.push({...r.params.options[0]}),r=>r.params.options[0].kind='allow_always',r=>r.params.options.splice(1,1),r=>r.params.options[0].kind='unknown']){const {protocol:p}=fixture(),r=request();mutate(r);failure(p,()=>p.push(wire(r)),'GROK_PERMISSION_OPTIONS_INVALID');}
});
test('permission request ids, tool ids, scope and resolved response are not replayable',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(request()));const d=decision(p);p.decide(owner,d);failure(p,()=>p.decide(owner,d),'GROK_DECISION_STALE');
 const {protocol:q}=fixture();q.push(wire(request()));failure(q,()=>q.push(wire(request())),'GROK_REQUEST_REPLAY');
 const {protocol:r}=fixture(),foreign=request();foreign.params.sessionId='foreign';failure(r,()=>r.push(wire(foreign)),'GROK_SESSION_MISMATCH');
 const {protocol:u}=fixture();failure(u,()=>u.push(wire(update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'safe'}},'foreign'))),'GROK_SESSION_MISMATCH');
});
test('numeric and string request ids stay distinct; prompt response binds exact id type',()=>{
 const {protocol:p}=fixture();p.push(wire(request(1,'tool-1')));p.push(wire(request('1','tool-2')));assert.equal(p.pending().length,2);
 const {protocol:q}=fixture();const wrong=result();wrong.id=String(P);failure(q,()=>q.push(wire(wrong)),'GROK_RESPONSE_UNKNOWN');
 for(const id of [null,-1,1.5,{},[]]){const {protocol:r}=fixture();failure(r,()=>r.push(wire(request(id))),'GROK_REQUEST_ID_INVALID');}
});
test('constructor scope and prompt ids reject every trailing line terminator with exact 256-character bounds',()=>{
 const endings=['\n','\r','\r\n','\u2028','\u2029'];
 for(const field of ['sessionId','runId','promptRequestId']){
   for(const ending of endings)assert.throws(()=>fixture({[field]:'constructor-id'+ending}),e=>e.code.startsWith('GROK_'));
   const maximum='a'.repeat(256);assert.equal(fixture({[field]:maximum}).protocol.state()[field],maximum);
   assert.throws(()=>fixture({[field]:'a'.repeat(257)}),e=>e.code.startsWith('GROK_'));
 }
});
test('wire request, tool and permission option ids reject trailing terminators and accept only bounded complete strings',()=>{
 for(const field of ['request','tool','option']){
   const mutate=(row,id)=>{if(field==='request')row.id=id;else if(field==='tool')row.params.toolCall.toolCallId=id;else row.params.options[2].optionId=id;};
   for(const ending of ['\n','\r','\r\n','\u2028','\u2029']){const {protocol:p}=fixture(),r=request();mutate(r,'permission-id'+ending);failure(p,()=>p.push(wire(r)),field==='request'?'GROK_REQUEST_ID_INVALID':'GROK_PROTOCOL_INVALID');}
   const {protocol:p}=fixture(),valid=request();mutate(valid,'a'.repeat(256));assert.equal(p.push(wire(valid))[0].type,'permission');
   const {protocol:q}=fixture(),invalid=request();mutate(invalid,'a'.repeat(257));failure(q,()=>q.push(wire(invalid)),field==='request'?'GROK_REQUEST_ID_INVALID':'GROK_PROTOCOL_INVALID');
 }
});
test('decision SHA format rejects line terminators and 63 or 65 characters before stale lookup',()=>{
 for(const ending of ['\n','\r','\r\n','\u2028','\u2029']){const {protocol:p,owner}=fixture();p.push(wire(request()));const d=decision(p);d.requestSHA256+=ending;failure(p,()=>p.decide(owner,d),'GROK_DECISION_INVALID');}
 for(const length of [63,65]){const {protocol:p,owner}=fixture();p.push(wire(request()));failure(p,()=>p.decide(owner,{...decision(p),requestSHA256:'a'.repeat(length)}),'GROK_DECISION_INVALID');}
 const {protocol:p,owner}=fixture();p.push(wire(request()));assert.equal(JSON.parse(p.decide(owner,decision(p))).result.outcome.optionId,'allow-once');
});
test('owner decisions reject trailing terminators in request and option ids',()=>{
 for(const field of ['requestId','optionId'])for(const ending of ['\n','\r','\r\n','\u2028','\u2029']){const {protocol:p,owner}=fixture();p.push(wire(request()));const d=decision(p);d[field]+=ending;failure(p,()=>p.decide(owner,d),field==='requestId'?'GROK_REQUEST_ID_INVALID':'GROK_PERMISSION_OPTION_FORBIDDEN');}
});
test('owner cancel emits the ACP notification before every pending cancelled response',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(request()));p.push(wire(request('permission-2','tool-2')));const outputs=p.cancel(owner,{sessionId:S,runId:R,confirm:true}).map(b=>JSON.parse(b));
 assert.deepEqual(outputs,[{jsonrpc:'2.0',method:'session/cancel',params:{sessionId:S}},{jsonrpc:'2.0',id:'permission-1',result:{outcome:{outcome:'cancelled'}}},{jsonrpc:'2.0',id:'permission-2',result:{outcome:{outcome:'cancelled'}}}]);assert.equal(p.pending().length,0);
 p.push(wire(result('cancelled')));const terminal=p.end();assert.equal(terminal.cancelled,true);assert.equal(terminal.replyComplete,false);
 const f=fixture();f.protocol.cancel(f.owner,{sessionId:S,runId:R,confirm:true});failure(f.protocol,()=>f.protocol.push(wire(result())),'GROK_CANCEL_RESULT_CONFLICT');
});
test('fatal sessions cannot later approve or cancel; late permission after cancellation fails',()=>{
 const {protocol:p,owner}=fixture();p.push(wire(request()));const d=decision(p);assert.throws(()=>p.push(wire({jsonrpc:'2.0',method:'unknown',params:{}})));assert.throws(()=>p.decide(owner,d));assert.throws(()=>p.cancel(owner,{sessionId:S,runId:R,confirm:true}));
 const f=fixture();f.protocol.cancel(f.owner,{sessionId:S,runId:R,confirm:true});failure(f.protocol,()=>f.protocol.push(wire(request())),'GROK_STATE_INVALID');
});
test('permission expiry uses both clocks, inclusive deadline and explicit tick without timers',()=>{
 for(const clock of ['wall','mono']){const f=fixture();f.protocol.push(wire(request()));f.time[clock]+=LIMITS.permissionTtlMs;failure(f.protocol,()=>f.protocol.tick(),'GROK_PERMISSION_EXPIRED');}
 const f=fixture();f.protocol.push(wire(request()));f.time.wall--;failure(f.protocol,()=>f.protocol.pending(),'GROK_CLOCK_INVALID');
 for(const bad of [NaN,Infinity,-1,'now']){const f=fixture({now:()=>bad});failure(f.protocol,()=>f.protocol.tick(),'GROK_CLOCK_INVALID');}
 assert.throws(()=>fixture({monotonic:null}),e=>e.code==='GROK_OPTIONS_INVALID');
});
test('unsupported reverse fs, terminal, auth and extension requests never produce an executable event',()=>{
 for(const method of ['fs/read_text_file','fs/write_text_file','terminal/create','terminal/output','terminal/kill','authenticate','x.ai/terminal/pty/input','session/cancel','initialize']){const {protocol:p}=fixture();failure(p,()=>p.push(wire({jsonrpc:'2.0',id:'reverse',method,params:{sessionId:S,path:'PRIVATE_PAYLOAD'}})),'GROK_REVERSE_METHOD_UNSUPPORTED');}
});
test('unknown notification envelopes, fields, content and rendered tool output fail closed',()=>{
 for(const value of [{...text('x'),extra:true},text('x').params,update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE_PAYLOAD'}}),update({sessionUpdate:'agent_message_chunk',content:{type:'image',data:'PRIVATE_PAYLOAD'}}),update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'synthetic',content:[{type:'content',content:{type:'text',text:'PRIVATE_PAYLOAD'}}]})]){const {protocol:p}=fixture();assert.throws(()=>p.push(wire(value)),e=>e.code.startsWith('GROK_')&&!e.message.includes('PRIVATE_PAYLOAD'));assert.equal(p.state().phase,'failed');}
});
test('result errors are sanitized and abnormal stop reasons never report a complete reply',()=>{
 for(const stop of ['max_tokens','max_turn_requests','refusal','cancelled']){const {protocol:p}=fixture();p.push(wire(result(stop)));const end=p.end();assert.equal(end.replyComplete,false);assert.equal(end.stopReason,stop);assert.equal(end.taskSuccess,null);}
 const {protocol:p}=fixture();p.push(wire({jsonrpc:'2.0',id:P,error:{code:-32000,message:'PRIVATE_PAYLOAD',data:{token:'PRIVATE_PAYLOAD'}}}));const end=p.end();assert.equal(end.errorCode,'GROK_REMOTE_ERROR');assert.equal(end.rpcCode,-32000);assert.ok(!JSON.stringify(end).includes('PRIVATE_PAYLOAD'));
 const {protocol:q}=fixture();failure(q,()=>q.push(wire(result('unknown'))),'GROK_STOP_REASON_UNSUPPORTED');
});
test('end_turn is only protocol completion, including a provider model-block message',()=>{
 const {protocol:p}=fixture();p.push(wire(text('Synthetic model unavailable message')));p.push(wire({...result(),result:{stopReason:'end_turn',_meta:{completionKind:'response',providerFlag:'synthetic'}}}));const end=p.end();assert.equal(end.replyComplete,true);assert.equal(end.taskSuccess,null);assert.equal(end.metadata.providerFlag,'synthetic');
 const {protocol:q}=fixture();q.push(wire(update({sessionUpdate:'tool_call',toolCallId:'pending',title:'not finished'})));q.push(wire(result()));assert.equal(q.end().replyComplete,false);
 const {protocol:r}=fixture();r.push(wire(update({sessionUpdate:'tool_call',toolCallId:'failed',title:'failed',status:'failed'})));r.push(wire(result()));const recovered=r.end();assert.equal(recovered.toolFailureObserved,true);assert.equal(recovered.replyComplete,true);assert.equal(recovered.taskSuccess,null);
});
test('failed terminal tools do not hide open tools or override an owner denial',()=>{
 const {protocol:p}=fixture();
 p.push(wire(update({sessionUpdate:'tool_call',toolCallId:'failed',title:'Optional read',status:'failed'})));
 p.push(wire(update({sessionUpdate:'tool_call',toolCallId:'open',title:'Unfinished operation',status:'in_progress'})));
 p.push(wire(result()));const incomplete=p.end();assert.equal(incomplete.replyComplete,false);assert.equal(incomplete.openTools,1);assert.equal(incomplete.toolFailureObserved,true);assert.equal(incomplete.taskSuccess,null);
 const {protocol:q,owner}=fixture();q.push(wire(request()));q.decide(owner,decision(q,'reject-once'));
 q.push(wire(update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'failed'})));
 q.push(wire(result()));const denied=q.end();assert.equal(denied.permissionDenied,true);assert.equal(denied.replyComplete,false);assert.equal(denied.toolFailureObserved,true);assert.equal(denied.taskSuccess,null);
});
test('UTF-8 split chunks and exact frame limit CRLF boundary are accepted',()=>{
 const {protocol:p}=fixture(),b=wire(text('繁體中文🙂'));let events=[];for(const byte of b)events.push(...p.push(Buffer.from([byte])));assert.equal(events[0].text,'繁體中文🙂');p.push(wire(result()));p.end();
 const line=Buffer.from(JSON.stringify(text('界限'))),f=fixture({limits:{maxFrameBytes:line.length}});assert.deepEqual(f.protocol.push(Buffer.concat([line,Buffer.from('\r')])),[]);assert.equal(f.protocol.push(Buffer.from('\n'))[0].text,'界限');
});
test('raw parser rejects duplicate keys, invalid UTF-8, surrogates, NUL and prototype pollution without payload leaks',()=>{
 for(const raw of ['{"jsonrpc":"2.0","jsonrpc":"2.0"}','{"jsonrpc":"PRIVATE_PAYLOAD","x":"\\ud800"}','{"x":"\\u0000"}','{"__proto__":{"x":1}}','{"constructor":{}}','{"prototype":{}}','{"x":9007199254740993}','{"x":0.10000000000000001}']){const {protocol:p}=fixture();assert.throws(()=>p.push(Buffer.from(raw+'\n')),e=>e.code.startsWith('GROK_')&&!e.message.includes('PRIVATE_PAYLOAD'));assert.equal(p.state().phase,'failed');}
 const {protocol:p}=fixture();failure(p,()=>p.push(Buffer.from([0xc0,0xaf,10])),'GROK_UTF8_INVALID');
 assert.throws(()=>decode(Buffer.from('{"secret":"PRIVATE_PAYLOAD",}')),e=>!e.message.includes('PRIVATE_PAYLOAD'));
});
test('frame, run, frame count, event burst, output, pending, string and JSON complexity limits are enforced',()=>{
 const cases=[[{maxFrameBytes:20},()=>wire(text('too big')),'GROK_FRAME_SIZE'],[{maxRunBytes:20},()=>wire(text('too big')),'GROK_RUN_SIZE'],[{maxFrames:1},()=>Buffer.concat([wire(text('a')),wire(text('b'))]),'GROK_FRAME_COUNT'],[{maxEventsPerPush:1},()=>Buffer.concat([wire(text('a')),wire(text('b'))]),'GROK_EVENT_BURST'],[{maxOutputBytes:2},()=>wire(text('中')),'GROK_OUTPUT_SIZE'],[{maxStringBytes:10},()=>wire(text('long enough text')),'GROK_PROTOCOL_INVALID'],[{maxDepth:1},()=>wire(text('x')),'GROK_JSON_COMPLEXITY'],[{maxNodes:2},()=>wire(text('x')),'GROK_JSON_COMPLEXITY']];
 for(const [limits,data,code]of cases){const {protocol:p}=fixture({limits});failure(p,()=>p.push(data()),code);}
 const {protocol:p}=fixture({limits:{maxPending:1}});p.push(wire(request()));failure(p,()=>p.push(wire(request('second','tool-2'))),'GROK_PENDING_SIZE');
 for(const limits of [{maxFrames:0},{maxFrames:LIMITS.maxFrames+1},{unknown:1}])assert.throws(()=>fixture({limits}));
});
test('malformed tails and EOF are errors; a terminal result cannot hide extra bytes in the same push',()=>{
 const {protocol:p}=fixture();p.push(Buffer.from('{'));failure(p,()=>p.end(),'GROK_EOF_TRUNCATED');
 const {protocol:q}=fixture();failure(q,()=>q.end(),'GROK_EOF_INCOMPLETE');
 const {protocol:r}=fixture();r.push(wire(request()));failure(r,()=>r.push(wire(result())),'GROK_RESULT_WITH_PENDING');
 for(const tail of [wire(text('extra')),Buffer.from('x')]){const {protocol:s}=fixture();failure(s,()=>s.push(Buffer.concat([wire(result()),tail])),'GROK_DATA_AFTER_RESULT');}
 const {protocol:t}=fixture();t.push(wire(result()));t.end();failure(t,()=>t.end(),'GROK_STATE_INVALID');
});
test('closed schema matches source fixtures, emitted decisions and cancellation without granting runtime authority',()=>{
 const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/grok-protocol.schema.json'),'utf8'));
 // Independent test-only evaluator for this schema's keywords. Contextual
 // session/state/hash/TTL and byte/Unicode validation remain the codec's job.
 function valid(rule,value){
   if(rule.$ref)return valid(schema.$defs[rule.$ref.split('/').pop()],value);
   if(rule.const!==undefined&&JSON.stringify(rule.const)!==JSON.stringify(value))return false;
   if(rule.enum&&!rule.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))return false;
   if(rule.not&&valid(rule.not,value))return false;
   if(rule.oneOf&&rule.oneOf.filter(x=>valid(x,value)).length!==1)return false;
   if(rule.allOf&&!rule.allOf.every(x=>valid(x,value)))return false;
   if(rule.if&&!valid(valid(rule.if,value)?rule.then||{}:rule.else||{},value))return false;
   if(rule.type){const types=Array.isArray(rule.type)?rule.type:[rule.type];if(!types.some(t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isInteger(value):typeof value===t))return false;}
   if(typeof value==='string'&&(rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength||rule.pattern&&!new RegExp(rule.pattern,'u').test(value)))return false;
   if(typeof value==='number'&&(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))return false;
   if(Array.isArray(value)){if(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)return false;if(rule.items&&!value.every(x=>valid(rule.items,x)))return false;if(rule.contains&&!value.some(x=>valid(rule.contains,x)))return false;}
   if(value!==null&&typeof value==='object'&&!Array.isArray(value)){if(rule.required&&!rule.required.every(k=>Object.hasOwn(value,k)))return false;for(const [key,item]of Object.entries(value)){if(rule.propertyNames&&!valid(rule.propertyNames,key))return false;if(rule.properties?.[key]){if(!valid(rule.properties[key],item))return false;}else if(rule.additionalProperties===false)return false;else if(rule.additionalProperties&&typeof rule.additionalProperties==='object'&&!valid(rule.additionalProperties,item))return false;}}
   return true;
 }
 for(const file of ['permission.jsonl','text-turn.jsonl'])for(const line of fs.readFileSync(path.join(__dirname,'fixtures/grok-protocol',file),'utf8').trim().split('\n')){const row=JSON.parse(line);assert.equal(valid(schema,row),true);assert.equal(valid(schema,{...row,unexpected:true}),false);}
 for(const optionId of ['allow-once','reject-once']){const f=fixture();f.protocol.push(wire(request()));assert.equal(valid(schema,JSON.parse(f.protocol.decide(f.owner,decision(f.protocol,optionId)))),true);}
 const f=fixture();f.protocol.push(wire(request()));for(const output of f.protocol.cancel(f.owner,{sessionId:S,runId:R,confirm:true}))assert.equal(valid(schema,JSON.parse(output)),true);
 const bad=request();bad.params.options[0].kind='allow_always';assert.equal(valid(schema,bad),false);
 const badStatus=request();badStatus.params.toolCall.status='completed';assert.equal(valid(schema,badStatus),false);
 for(const row of [update({sessionUpdate:'tool_call',toolCallId:'t'}),update({sessionUpdate:'tool_call_update',toolCallId:'t',extra:1}),{...result(),error:{code:-1,message:'ambiguous'}},{jsonrpc:'2.0',id:1,method:'terminal/create',params:{}}])assert.equal(valid(schema,row),false);
 const polluted=request();polluted.params.toolCall.rawInput=JSON.parse('{"__proto__":{}}');assert.equal(valid(schema,polluted),false);
 // Check the schema ID policy on short terminator inputs and length boundaries.
 assert.equal(valid(schema.$defs.id,'a'.repeat(256)),true);assert.equal(valid(schema.$defs.id,'a'.repeat(257)),false);
 for(const ending of ['\n','\r','\r\n','\u2028','\u2029']){
   assert.equal(valid(schema.$defs.id,'short-id'+ending),false);
   for(const mutate of [r=>r.id='permission-1'+ending,r=>r.params.sessionId=S+ending,r=>r.params.toolCall.toolCallId='tool-1'+ending,r=>r.params.options[2].optionId='extra-option'+ending]){const r=request();mutate(r);assert.equal(valid(schema,r),false);}
 }
});
