'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createProtocol,decode,canonical,SOURCE,LIMITS}=require('../lib/providers/claude-protocol');
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures/claude-protocol',name),'utf8');
const rows=name=>fixture(name).trimEnd().split('\n').map(line=>JSON.parse(line));
const toolRows=rows('tool-turn.jsonl'),streamRows=rows('text-stream.jsonl');
const clone=x=>JSON.parse(JSON.stringify(x)),wire=x=>Buffer.from(JSON.stringify(x)+'\n');
function setup(limits){let wall=10000,mono=20000;const owner=Object.freeze({}),p=createProtocol({sessionId:'session-fixture',runId:'run-fixture',ownerAuthority:owner,now:()=>wall,monotonic:()=>mono,...(limits?{limits}:{})});return {p,owner,set:(w,m)=>{wall=w;mono=m;},advance:(w,m=w)=>{wall+=w;mono+=m;}};}
const init=s=>s.p.push(wire(toolRows[0]));
function request(s){init(s);s.p.push(wire(toolRows[1]));return s.p.push(wire(toolRows[2]))[0];}
const approval=(p,decision='allow')=>({sessionId:p.sessionId,runId:p.runId,requestId:p.requestId,requestSHA256:p.requestSHA256,decision,confirm:true});
function fatal(s,fn,code){let caught;assert.throws(fn,error=>{caught=error;return code?error.code===code:/^CLAUDE_[A-Z_]+$/.test(error.code);});assert.equal(s.p.state().phase,'failed');assert.equal(s.p.state().pending,0);for(const call of [()=>s.p.tick(),()=>s.p.pending(),()=>s.p.end(),()=>s.p.decide(s.owner,{})])assert.throws(call,error=>error===caught);assert.equal(caught.message,caught.code);return caught;}

test('offline source pin and generated fixtures do not claim live protocol or readiness',()=>{
  const source=JSON.parse(fixture('source.json'));assert.equal(source.kind,'generated-from-contract');assert.equal(source.revision,SOURCE.revision);assert.equal(source.bundledCliVersion,'2.1.252');assert.equal(source.liveStreamVerified,false);assert.equal(SOURCE.liveProtocolVerified,false);assert.equal(source.sources.length,4);for(const file of source.sources)assert.match(file.sha256,/^[a-f0-9]{64}$/);
  const registry=require('../lib/provider-registry');assert.equal(registry.status('claude',{platform:'win32'}).ready,false);
});

test('tool-use is descriptive until the exact owner decision; original input is immutable',()=>{
  const s=setup();init(s);const tool=s.p.push(wire(toolRows[1]));assert.equal(tool[0].type,'assistant');assert.deepEqual(s.p.pending(),[]);
  const event=s.p.push(wire(toolRows[2]))[0],expected=clone(toolRows[2].request.input);event.input.limit=999;s.p.pending()[0].input.file_path='mutated';
  const current=s.p.pending()[0];assert.deepEqual(current.input,expected);assert.match(current.requestSHA256,/^[a-f0-9]{64}$/);
  const encoded=s.p.decide(s.owner,approval(current));assert.ok(Buffer.isBuffer(encoded));const answer=JSON.parse(encoded);
  assert.deepEqual(answer,{type:'control_response',response:{subtype:'success',request_id:'request-1',response:{behavior:'allow',updatedInput:expected}}});assert.equal(encoded.at(-1),10);assert.deepEqual(s.p.pending(),[]);
  s.p.push(Buffer.concat(toolRows.slice(3).map(wire)));assert.deepEqual(s.p.end(),{terminal:true,ok:true,responseComplete:true,sessionId:'session-fixture',runId:'run-fixture',subtype:'success',isError:false,terminalReason:'completed',stopReasons:[],lastStopReason:null,permissionDenied:false,permissionDenials:0,permissionCanceled:false,incompleteReasons:[],text:'合成回覆：已完成。'});
});

test('owner deny uses the SDK response shape and does not invent a tool execution',()=>{
  const s=setup(),p=request(s);assert.deepEqual(JSON.parse(s.p.decide(s.owner,approval(p,'deny'))),{type:'control_response',response:{subtype:'success',request_id:'request-1',response:{behavior:'deny',message:'Denied by Hub owner'}}});assert.equal(s.p.state().phase,'active');assert.deepEqual(s.p.pending(),[]);
});

test('non-owner object, wire control_response and invented approval fields permanently fail closed',()=>{
  const s=setup(),p=request(s);fatal(s,()=>s.p.decide({},approval(p)),'CLAUDE_OWNER_REQUIRED');
  const t=setup();request(t);fatal(t,()=>t.p.push(wire({type:'control_response',response:{subtype:'success',request_id:'request-1',response:{behavior:'allow'}}})),'CLAUDE_EVENT_UNSUPPORTED');
  for(const extra of [{updatedInput:{}},{updatedPermissions:[]},{source:'owner'}]){const u=setup(),pending=request(u);fatal(u,()=>u.p.decide(u.owner,{...approval(pending),...extra}));}
});

test('stale digest, cross-run/session, unconfirmed and repeated owner decisions are refused',()=>{
  for(const changed of [{requestSHA256:'0'.repeat(64)},{runId:'other-run'},{sessionId:'other-session'},{confirm:false},{decision:'accept'}]){const s=setup(),p=request(s);fatal(s,()=>s.p.decide(s.owner,{...approval(p),...changed}));}
  const s=setup(),p=request(s);s.p.decide(s.owner,approval(p));fatal(s,()=>s.p.decide(s.owner,approval(p)),'CLAUDE_DECISION_STALE');
});

test('request digest is canonical, input-sensitive and bound to controller run/session',()=>{
  const a=setup(),b=setup(),pa=request(a);init(b);const perm=clone(toolRows[2]);perm.request.input={file_path:perm.request.input.file_path,limit:20};const pb=b.p.push(wire(perm))[0];assert.equal(pa.requestSHA256,pb.requestSHA256);
  const c=setup();init(c);const modified=clone(perm);modified.request.input.limit=21;assert.notEqual(c.p.push(wire(modified))[0].requestSHA256,pa.requestSHA256);
  const owner={},d=createProtocol({sessionId:'session-fixture',runId:'other-run',ownerAuthority:owner});d.push(wire(toolRows[0]));assert.notEqual(d.push(wire(perm))[0].requestSHA256,pa.requestSHA256);
  assert.equal(canonical({z:'繁體中文',a:{b:1,c:0.1}}),canonical({a:{c:0.1,b:1},z:'繁體中文'}));
});

test('cancel consumes the pending request without manufacturing a control response',()=>{
  const s=setup(),p=request(s);assert.deepEqual(s.p.push(wire({type:'control_cancel_request',request_id:p.requestId})),[{type:'permission-canceled',requestId:p.requestId}]);assert.deepEqual(s.p.pending(),[]);fatal(s,()=>s.p.decide(s.owner,approval(p)),'CLAUDE_DECISION_STALE');
  const t=setup();init(t);fatal(t,()=>t.p.push(wire({type:'control_cancel_request',request_id:'unknown'})),'CLAUDE_CANCEL_UNKNOWN');
});

test('expiry is explicit, boundary-inclusive, sticky and checked by both clocks',()=>{
  for(const deltas of [[600000,0],[0,600000],[600000,600000]]){const s=setup();request(s);s.advance(...deltas);fatal(s,()=>s.p.tick(),'CLAUDE_PERMISSION_EXPIRED');}
  const s=setup(),p=request(s);s.advance(599999);assert.equal(s.p.tick().pending,1);assert.equal(JSON.parse(s.p.decide(s.owner,approval(p))).response.response.behavior,'allow');
  for(const entry of ['decide','push','pending','end']){const t=setup(),r=request(t);t.advance(600001);fatal(t,()=>entry==='decide'?t.p.decide(t.owner,approval(r)):entry==='push'?t.p.push(wire(toolRows[3])):t.p[entry](),'CLAUDE_PERMISSION_EXPIRED');}
});

test('clock rollback and invalid options do not preserve authorizable requests',()=>{
  for(const changed of [[9999,20000],[10000,19999],[NaN,20000]]){const s=setup();request(s);s.set(...changed);fatal(s,()=>s.p.tick(),'CLAUDE_CLOCK_INVALID');}
  for(const options of [{sessionId:undefined},{runId:12},{ownerAuthority:null},{limits:{maxPending:LIMITS.maxPending+1}},{limits:{extra:1}}])assert.throws(()=>createProtocol({sessionId:'s',runId:'r',ownerAuthority:{},...options}));
  for(const key of ['now','monotonic'])for(const value of [null,0,false,NaN,''])assert.throws(()=>createProtocol({sessionId:'s',runId:'r',ownerAuthority:{},[key]:value}),{code:'CLAUDE_OPTIONS_INVALID'});
});

test('UTF-8 JSONL accepts bytewise Traditional Chinese and CRLF at every split',()=>{
  const text=fixture('text-stream.jsonl').replace(/\n/g,'\r\n'),bytes=Buffer.from(text),s=setup(),events=[];for(const byte of bytes)events.push(...s.p.push(Buffer.from([byte])));assert.equal(events.find(x=>x.type==='text-delta').text,'台灣繁體中文');assert.equal(s.p.end().ok,true);
  const raw=Buffer.from(JSON.stringify(toolRows[0])),t=setup({maxFrameBytes:raw.length});assert.deepEqual(t.p.push(Buffer.concat([raw,Buffer.from('\r')])),[]);assert.equal(t.p.push(Buffer.from('\n'))[0].type,'session');
});

test('malformed UTF-8, duplicate keys, lone surrogates, NUL and prototype keys stay out of errors',()=>{
  const cases=[Buffer.from([0xff,10]),Buffer.from('{"type":"system","type":"MARKER_SECRET"}\n'),Buffer.from('{"x":"\\ud800"}\n'),Buffer.from('{"x":"\\u0000"}\n'),Buffer.from('{"__proto__":{"polluted":true}}\n'),Buffer.from('{"x":{"constructor":{"prototype":1}}}\n'),Buffer.from('\ufeff{}\n'),Buffer.from('{"x":NaN}\n'),Buffer.from('{"x":Infinity}\n')];
  for(const bytes of cases){const s=setup();const error=fatal(s,()=>s.p.push(bytes));assert.equal(error.message.includes('MARKER_SECRET'),false);assert.equal(Object.hasOwn(error,'payload'),false);assert.equal(Object.hasOwn(error,'cause'),false);}assert.equal({}.polluted,undefined);
});

test('numeric precision, unsafe magnitude and underflow cannot alter approval inputs silently',()=>{
  for(const value of ['9007199254740993','9007199254740991.1','0.1000000000000000001','1e999','1e-999'])assert.throws(()=>decode(Buffer.from('{"number":'+value+'}')),{code:'CLAUDE_JSON_NUMBER'});
  assert.deepEqual(JSON.parse(JSON.stringify(decode(Buffer.from('{"number":1e2,"cost":0.001,"zero":-0}')))),{number:100,cost:0.001,zero:0});
});

test('unknown fields/types/subagents and permission updates do not reach the owner',()=>{
  const invalid=[{...toolRows[2],session_id:'other-session'},{...toolRows[2],request:{...toolRows[2].request,subtype:'hook_callback'}},{...toolRows[2],request:{...toolRows[2].request,agent_id:'agent-1'}},{...toolRows[2],request:{...toolRows[2].request,permission_suggestions:[{type:'addRules'}]}},{...toolRows[2],request:{...toolRows[2].request,unknown:true}},{type:'system',subtype:'task_started',session_id:'session-fixture',uuid:'unknown-event'},{...toolRows[3],parent_tool_use_id:'foreign-tool'}];
  for(const row of invalid){const s=setup();init(s);fatal(s,()=>s.p.push(wire(row)));}
  const s=setup();fatal(s,()=>s.p.push(wire({...toolRows[0],permissionMode:'bypassPermissions'})),'CLAUDE_PERMISSION_MODE');
});

test('cross-session frames, duplicate request/event/tool IDs and changed tool input fail closed',()=>{
  const s=setup();init(s);fatal(s,()=>s.p.push(wire({...toolRows[3],session_id:'other-session'})),'CLAUDE_SESSION_MISMATCH');
  const t=setup();request(t);fatal(t,()=>t.p.push(wire(toolRows[2])),'CLAUDE_REQUEST_REPLAY');
  const u=setup();init(u);u.p.push(wire(toolRows[3]));fatal(u,()=>u.p.push(wire(toolRows[3])),'CLAUDE_EVENT_REPLAY');
  const v=setup();init(v);v.p.push(wire(toolRows[1]));const changed=clone(toolRows[2]);changed.request.input.limit=21;fatal(v,()=>v.p.push(wire(changed)),'CLAUDE_TOOL_CHANGED');
  const w=setup();request(w);const duplicate=clone(toolRows[2]);duplicate.request_id='request-2';fatal(w,()=>w.p.push(wire(duplicate)),'CLAUDE_TOOL_REPLAY');
  const z=setup();init(z);const snapshot=clone(toolRows[1]);snapshot.message.content.push(clone(snapshot.message.content[0]));fatal(z,()=>z.p.push(wire(snapshot)),'CLAUDE_TOOL_REPLAY');
});

test('frame, run, event burst/count, pending, depth, node and text limits are enforced',()=>{
  const s=setup({maxFrameBytes:64});fatal(s,()=>s.p.push(Buffer.from('x'.repeat(65))),'CLAUDE_FRAME_SIZE');
  const t=setup({maxRunBytes:1});fatal(t,()=>t.p.push(wire(toolRows[0])),'CLAUDE_RUN_SIZE');
  const u=setup({maxEventsPerPush:1});fatal(u,()=>u.p.push(Buffer.concat([wire(toolRows[0]),wire(toolRows[3])])),'CLAUDE_EVENT_BURST');
  const v=setup({maxFrames:1});init(v);fatal(v,()=>v.p.push(wire(toolRows[3])),'CLAUDE_FRAME_COUNT');
  const w=setup({maxPending:1});request(w);const second=clone(toolRows[2]);second.request_id='request-2';second.request.tool_use_id='tool-2';fatal(w,()=>w.p.push(wire(second)),'CLAUDE_PENDING_SIZE');
  const z=setup({maxDepth:2});fatal(z,()=>z.p.push(Buffer.from('{"nested":{"nested":{"value":1}}}\n')),'CLAUDE_JSON_COMPLEXITY');
  const a=setup({maxNodes:2});fatal(a,()=>a.p.push(Buffer.from('{"x":1,"y":2}\n')),'CLAUDE_JSON_COMPLEXITY');
  const b=setup({maxStringBytes:3});fatal(b,()=>b.p.push(wire(toolRows[0])));
});

test('output byte cap covers assistant snapshots, text deltas and result text',()=>{
  for(const source of ['assistant','result']){const s=setup({maxOutputBytes:8});init(s);const row=clone(source==='assistant'?toolRows[3]:toolRows[4]);if(source==='assistant')row.message.content[0].text='ninebytes';else row.result='ninebytes';fatal(s,()=>s.p.push(wire(row)),'CLAUDE_OUTPUT_SIZE');}
  const t=setup({maxOutputBytes:8});for(const row of streamRows.slice(0,3))t.p.push(wire(row));fatal(t,()=>t.p.push(wire(streamRows[3])),'CLAUDE_OUTPUT_SIZE');
  const u=setup({maxOutputBytes:8});for(const row of streamRows.slice(0,2))u.p.push(wire(row));const nonempty=clone(streamRows[2]);nonempty.event.content_block.text='ninebytes';fatal(u,()=>u.p.push(wire(nonempty)),'CLAUDE_STREAM_ORDER');
});

test('SDK success subtype with error, abort or errors never becomes success; HTTP contradictions refuse',()=>{
  for(const delta of [{is_error:true,api_error_status:429},{terminal_reason:'aborted_tools'},{terminal_reason:'aborted_streaming'},{errors:['synthetic failure']},{subtype:'error_max_turns',is_error:true}]){const s=setup();init(s);const result=s.p.push(wire({...toolRows[4],...delta}))[0];assert.equal(result.ok,false);assert.equal(s.p.end().ok,false);}
  const t=setup();init(t);fatal(t,()=>t.p.push(wire({...toolRows[4],api_error_status:429})),'CLAUDE_RESULT_CONFLICT');
  const u=setup();init(u);u.p.push(wire({...toolRows[4],is_error:true,api_error_status:null}));assert.equal(u.p.end().ok,false);
});

test('terminal protocol frames preserve denials and non-normal stops as incomplete responses',()=>{
  for(const reason of ['max_tokens','refusal','unknown-stop','tool_use','stop_sequence']){
    const s=setup();init(s);const result=s.p.push(wire({...toolRows[4],stop_reason:reason}))[0];assert.equal(result.terminal,true);assert.equal(result.ok,false);assert.equal(result.responseComplete,false);assert.deepEqual(result.stopReasons,[reason]);assert.equal(result.lastStopReason,reason);assert.ok(result.incompleteReasons.includes('stop-reason'));assert.equal(s.p.end().ok,false);
  }
  const t=setup();init(t);const result=t.p.push(wire({...toolRows[4],permission_denials:[{tool_name:'Read',tool_use_id:'tool-1',tool_input:{}}]}))[0];assert.equal(result.ok,false);assert.equal(result.permissionDenied,true);assert.equal(result.permissionDenials,1);assert.ok(result.incompleteReasons.includes('permission-denied'));
  for(const decision of ['deny','cancel']){const s=setup(),p=request(s);if(decision==='deny')s.p.decide(s.owner,approval(p,'deny'));else s.p.push(wire({type:'control_cancel_request',request_id:p.requestId}));const result=s.p.push(wire(toolRows[4]))[0];assert.equal(result.ok,false);assert.equal(decision==='deny'?result.permissionDenied:result.permissionCanceled,true);}
});

test('assistant-only and stream-only stop markers cannot be erased by a later success result',()=>{
  for(const source of ['assistant','stream'])for(const reason of ['max_tokens','refusal','unknown-stop']){
    const s=setup();
    if(source==='assistant'){init(s);const row=clone(toolRows[3]);row.message.stop_reason=reason;s.p.push(wire(row));}
    else {for(const row of streamRows.slice(0,-1)){const item=clone(row);if(item.event?.type==='message_delta')item.event.delta.stop_reason=reason;s.p.push(wire(item));}}
    const result=s.p.push(wire({...toolRows[4],stop_reason:'end_turn'}))[0];assert.equal(result.terminal,true);assert.equal(result.responseComplete,false);assert.equal(result.ok,false);assert.deepEqual(result.stopReasons,[reason,'end_turn']);assert.ok(result.incompleteReasons.includes('stop-reason'));
  }
  const t=setup();init(t);const tool=clone(toolRows[1]);tool.message.stop_reason='tool_use';t.p.push(wire(tool));const permission=t.p.push(wire(toolRows[2]))[0];t.p.decide(t.owner,approval(permission));const final=clone(toolRows[3]);final.message.stop_reason='end_turn';t.p.push(wire(final));t.p.push(wire(toolRows[4]));assert.equal(t.p.end().responseComplete,true);
});

test('terminal result with unresolved permission, open stream or extra data never completes',()=>{
  const s=setup();request(s);fatal(s,()=>s.p.push(wire(toolRows[4])),'CLAUDE_RESULT_WITH_PENDING');
  const t=setup();for(const row of streamRows.slice(0,2))t.p.push(wire(row));fatal(t,()=>t.p.push(wire(toolRows[4])),'CLAUDE_RESULT_WITH_PENDING');
  const u=setup();init(u);fatal(u,()=>u.p.push(Buffer.concat([wire(toolRows[4]),Buffer.from('garbage')])),'CLAUDE_DATA_AFTER_RESULT');
  const v=setup();init(v);v.p.push(wire(toolRows[4]));fatal(v,()=>v.p.push(wire(toolRows[4])),'CLAUDE_DATA_AFTER_RESULT');
  const w=setup();init(w);fatal(w,()=>w.p.push(Buffer.concat([wire(toolRows[4]),wire(toolRows[3])])),'CLAUDE_DATA_AFTER_RESULT');
});

test('EOF is distinct from result or process exit; incomplete frames/runs are errors',()=>{
  for(const prepare of [()=>{},s=>init(s),s=>request(s),s=>{init(s);s.p.push(Buffer.from('{'));}]){const s=setup();prepare(s);fatal(s,()=>s.p.end());}
  const s=setup();init(s);s.p.push(Buffer.from(JSON.stringify(toolRows[4])));fatal(s,()=>s.p.end(),'CLAUDE_EOF_TRUNCATED');
  const t=setup();t.p.push(Buffer.concat([wire(toolRows[0]),wire(toolRows[4])]));assert.equal(t.p.end().terminal,true);fatal(t,()=>t.p.end(),'CLAUDE_STATE_INVALID');
});

test('stream ordering, nested metadata and unsupported deltas are strict',()=>{
  const invalid=[{...streamRows[3],event:{...streamRows[3].event,index:3}},{...streamRows[3],event:{...streamRows[3].event,delta:{type:'thinking_delta',thinking:'synthetic'}}},{...streamRows[3],event:{...streamRows[3].event,unknown:1}}];
  for(const row of invalid){const s=setup();for(const item of streamRows.slice(0,3))s.p.push(wire(item));fatal(s,()=>s.p.push(wire(row)));}
  for(const meta of [{stop_reason:{}},{stop_sequence:42},{usage:'not-stats'}]){const s=setup();init(s);const row=clone(toolRows[3]);Object.assign(row.message,meta);fatal(s,()=>s.p.push(wire(row)));}
});

test('stream snapshots bind model/content and cannot restart a completed assistant ID',()=>{
  const s=setup();for(const row of streamRows.slice(0,-1))s.p.push(wire(row));const matching=clone(toolRows[3]);matching.message.id='message-stream';matching.message.content[0].text='台灣繁體中文';assert.equal(s.p.push(wire(matching))[0].type,'assistant');
  const t=setup();for(const row of streamRows.slice(0,-1))t.p.push(wire(row));const changed=clone(matching);changed.message.model='other-model';fatal(t,()=>t.p.push(wire(changed)),'CLAUDE_MESSAGE_CHANGED');
  const u=setup();init(u);const first=clone(toolRows[3]);first.message.id='message-stream';u.p.push(wire(first));fatal(u,()=>u.p.push(wire(streamRows[1])),'CLAUDE_STREAM_ORDER');
});

test('tool input stream is assembled before binding and requires the exact permission input',()=>{
  const s=setup();for(const row of streamRows.slice(0,2))s.p.push(wire(row));let n=10;
  const event=e=>({type:'stream_event',session_id:'session-fixture',uuid:'tool-stream-'+n++,event:e});
  s.p.push(wire(event({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-1',name:'Read',input:{}}})));
  s.p.push(wire(event({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(toolRows[2].request.input)}})));
  s.p.push(wire(event({type:'content_block_stop',index:0})));s.p.push(wire(event({type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:2}})));s.p.push(wire(event({type:'message_stop'})));
  const p=s.p.push(wire(toolRows[2]))[0];assert.deepEqual(JSON.parse(s.p.decide(s.owner,approval(p))).response.response.updatedInput,toolRows[2].request.input);
});

test('malformed frame after a valid pending request is atomic and cannot leave an approval alive',()=>{
  const s=setup();request(s);fatal(s,()=>s.p.push(Buffer.concat([wire(toolRows[3]),Buffer.from('{"type":"bad","type":"secret"}\n')])),'CLAUDE_JSON_DUPLICATE_KEY');
});

test('schema is closed for each wire envelope and covers all generated fixtures plus owner responses',()=>{
  const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/claude-protocol.schema.json'),'utf8'));
  // Small independent evaluator for the keywords this single schema uses. It is
  // test-only and does not grant runtime authority or replace codec validation.
  function valid(rule,value){
    if(rule.$ref)return valid(schema.$defs[rule.$ref.split('/').pop()],value);
    if(rule.const!==undefined&&JSON.stringify(rule.const)!==JSON.stringify(value))return false;
    if(rule.enum&&!rule.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))return false;
    if(rule.not&&valid(rule.not,value))return false;
    if(rule.oneOf&&rule.oneOf.filter(x=>valid(x,value)).length!==1)return false;
    if(rule.anyOf&&!rule.anyOf.some(x=>valid(x,value)))return false;
    if(rule.type){const types=Array.isArray(rule.type)?rule.type:[rule.type];if(!types.some(t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isInteger(value):typeof value===t))return false;}
    if(typeof value==='string'&&(rule.minLength!==undefined&&value.length<rule.minLength||rule.maxLength!==undefined&&value.length>rule.maxLength||rule.pattern&&!new RegExp(rule.pattern,'u').test(value)))return false;
    if(typeof value==='number'&&(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))return false;
    if(Array.isArray(value)){if(rule.maxItems!==undefined&&value.length>rule.maxItems)return false;if(rule.items&&!value.every(x=>valid(rule.items,x)))return false;}
    if(value!==null&&typeof value==='object'&&!Array.isArray(value)){if(rule.maxProperties!==undefined&&Object.keys(value).length>rule.maxProperties)return false;if(rule.required&&!rule.required.every(k=>Object.hasOwn(value,k)))return false;for(const [key,item]of Object.entries(value)){if(rule.propertyNames&&!valid(rule.propertyNames,key))return false;if(rule.properties?.[key]){if(!valid(rule.properties[key],item))return false;}else if(rule.additionalProperties===false)return false;else if(rule.additionalProperties&&typeof rule.additionalProperties==='object'&&!valid(rule.additionalProperties,item))return false;}}
    return true;
  }
  for(const row of [...toolRows,...streamRows]){assert.equal(valid(schema,row),true,JSON.stringify(row));assert.equal(valid(schema,{...row,unexpected:true}),false);}
  for(const decision of ['allow','deny']){const s=setup(),p=request(s);assert.equal(valid(schema,JSON.parse(s.p.decide(s.owner,approval(p,decision)))),true);}
  for(const block of [{type:'text',text:'nonempty'},{type:'tool_use',id:'t',name:'Read',input:{path:'nonempty'}}]){
    const frame=clone(streamRows[2]);frame.event.content_block=block;assert.equal(valid(schema,frame),false);const s=setup();for(const row of streamRows.slice(0,2))s.p.push(wire(row));fatal(s,()=>s.p.push(wire(frame)),'CLAUDE_STREAM_ORDER');
  }
  assert.equal(valid(schema,JSON.parse('{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Read","tool_use_id":"t","input":{"__proto__":{}}}}')),false);
});
