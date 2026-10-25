'use strict';
// One admitted, exclusive endpoint. This module never spawns or authenticates.
const {Readable,Writable}=require('node:stream');
const {TextDecoder}=require('node:util');
const {createHash}=require('node:crypto');
const {createProtocol,canonical,LIMITS:PROTOCOL_LIMITS,SOURCE:PROTOCOL_SOURCE}=require('./claude-protocol');
const SOURCE=Object.freeze({...PROTOCOL_SOURCE,clientPath:'src/claude_agent_sdk/client.py',clientSHA256:'70740865b70711cdd6b9b06ef5553a6b0026f020aea5ed38a75bdf9d547331ea',clientLines:'248-269'});
const LIMITS=Object.freeze({maxWallMs:900000,maxIdleMs:60000,maxWriteMs:10000,maxStopMs:5000,permissionTtlMs:600000,maxPromptBytes:65536,maxStderrBytes:65536,maxQueuedBytes:1048576,maxQueuedFrames:32});
const claimedStreams=new WeakSet();
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const rejected=code=>Object.assign(Error(code),{code});
function check(value,code='CLAUDE_TURN_OPTIONS_INVALID'){if(!value)throw rejected(code);}
function keys(value,required,optional=[]){check(plain(value));check(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const clone=x=>JSON.parse(JSON.stringify(x));

function createTurnController(options){
  keys(options,['sessionId','runId','prompt','ownerAuthority','backendAuthority','endpoint','onEvent'],['limits','now','monotonic','schedule','cancelSchedule']);
  const {sessionId,runId,prompt,ownerAuthority,backendAuthority,endpoint,onEvent}=options;
  check(typeof sessionId==='string'&&ID.test(sessionId)&&typeof runId==='string'&&ID.test(runId));
  check(ownerAuthority!==null&&typeof ownerAuthority==='object'&&backendAuthority!==null&&typeof backendAuthority==='object'&&ownerAuthority!==backendAuthority);
  check(typeof onEvent==='function');keys(endpoint,['backendId','stdin','stdout','stderr','requestStop']);
  const {backendId,stdin,stdout,stderr,requestStop}=endpoint;
  check(typeof backendId==='string'&&ID.test(backendId)&&typeof requestStop==='function');
  check(stdin instanceof Writable&&stdout instanceof Readable&&stderr instanceof Readable&&stdout!==stderr&&stdin!==stdout&&stdin!==stderr);
  check([stdin,stdout,stderr].every(stream=>!claimedStreams.has(stream)),'CLAUDE_TURN_ENDPOINT_NOT_EXCLUSIVE');
  check(!stdin.destroyed&&!stdin.writableEnded&&!stdin.writableFinished&&stdin.writableLength===0&&!stdin.writableCorked&&!stdin.writableNeedDrain&&!stdout.destroyed&&!stderr.destroyed,'CLAUDE_TURN_ENDPOINT_NOT_EXCLUSIVE');
  for(const stream of [stdout,stderr])check(!stream.readableEnded&&!stream.readableEncoding&&stream.readableFlowing!==true&&stream.listenerCount('data')===0&&stream.listenerCount('readable')===0,'CLAUDE_TURN_ENDPOINT_NOT_EXCLUSIVE');
  const limits={...LIMITS};
  if(options.limits!==undefined){keys(options.limits,[],Object.keys(LIMITS));for(const [key,value]of Object.entries(options.limits)){check(integer(value)&&value>=1&&value<=LIMITS[key]);limits[key]=value;}}
  check(typeof prompt==='string'&&prompt.length>0&&prompt.isWellFormed()&&!prompt.includes('\0')&&Buffer.byteLength(prompt)<=limits.maxPromptBytes,'CLAUDE_TURN_PROMPT_INVALID');
  const now=options.now===undefined?Date.now:options.now,monotonic=options.monotonic===undefined?()=>Number(process.hrtime.bigint()/1000000n):options.monotonic;
  const schedule=options.schedule===undefined?setTimeout:options.schedule,cancelSchedule=options.cancelSchedule===undefined?clearTimeout:options.cancelSchedule;
  check([now,monotonic,schedule,cancelSchedule].every(x=>typeof x==='function'));
  const protocol=createProtocol({sessionId,runId,ownerAuthority,now,monotonic,limits:{permissionTtlMs:limits.permissionTtlMs}});
  // Pinned SDK client.query(string, session_id), not an ACP RPC request.
  const promptWire=Buffer.from(canonical({type:'user',message:{role:'user',content:prompt},parent_tool_use_id:null,session_id:sessionId})+'\n');
  check(promptWire.length<=PROTOCOL_LIMITS.maxFrameBytes,'CLAUDE_TURN_PROMPT_FRAME_SIZE');
  const promptSHA256=createHash('sha256').update(Buffer.from(prompt)).digest('hex');
  let phase='created',completionKind=null,errorCode=null,started=null,lastActivity=null,lastClock=null,timer=null,stopTimer=null;
  let stopRequested=false,ownerCancelled=false,eventBroken=false,ending=false,stdoutEnded=false,stderrEnded=false;
  let terminal=null,exitReceipt=null,stdoutBytes=0,stderrBytes=0,queue=[],queuedBytes=0,current=null;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  let resolveCompletion;const completion=new Promise(resolve=>{resolveCompletion=resolve;});
  const codeOf=error=>typeof error?.code==='string'&&/^CLAUDE_[A-Z0-9_]+$/.test(error.code)?error.code:'CLAUDE_TURN_INTERNAL_ERROR';
  function clock(){const wall=now(),mono=monotonic();check(integer(wall)&&integer(mono)&&(!lastClock||wall>=lastClock.wall&&mono>=lastClock.mono),'CLAUDE_TURN_CLOCK_INVALID');lastClock={wall,mono};return mono;}
  function cleanupKnown(){return Boolean(exitReceipt?.rootExited&&exitReceipt.ownedTreeEmpty&&exitReceipt.cleanupVerified);}
  function snapshot(){return {schema:'claude-turn-state/v1',phase,completionKind,backendId,sessionId,runId,promptSHA256,errorCode,stopRequested,ownerCancelled,protocolTerminal:terminal!==null,responseComplete:!ownerCancelled&&terminal?.responseComplete===true,taskSuccess:null,stdoutEnded,stderrEnded,rootExited:exitReceipt?.rootExited===true,ownedTreeEmpty:exitReceipt?.ownedTreeEmpty===true,cleanupVerified:cleanupKnown(),exitCode:exitReceipt?.exitCode??null,signal:exitReceipt?.signal??null,pending:phase==='running'?protocol.state().pending:0,queuedFrames:queue.length+(current?1:0),queuedBytes,stdoutBytes,stderrBytes};}
  function emit(value){if(eventBroken)return;try{const result=onEvent(clone(value));if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw rejected('CLAUDE_TURN_EVENT_HANDLER_FAILED');}check(result===undefined,'CLAUDE_TURN_EVENT_HANDLER_FAILED');}catch{eventBroken=true;if(phase==='finished'){errorCode=errorCode||'CLAUDE_TURN_EVENT_HANDLER_FAILED';completionKind=cleanupKnown()?'failed':'cleanup-unknown';}else fail('CLAUDE_TURN_EVENT_HANDLER_FAILED');}}
  function finish(forced=false){
    if(phase==='finished'||!forced&&(!stdoutEnded||!stderrEnded||!cleanupKnown()))return;
    if(!cleanupKnown())completionKind='cleanup-unknown';
    else if(errorCode)completionKind='failed';
    else if(ownerCancelled)completionKind='cancelled';
    else if(!terminal||exitReceipt.exitCode!==0||exitReceipt.signal!==null){errorCode='CLAUDE_TURN_EXIT_UNSUCCESSFUL';completionKind='failed';}
    else if(terminal.isError||terminal.subtype!=='success'){errorCode='CLAUDE_TURN_REMOTE_ERROR';completionKind='failed';}
    else completionKind=terminal.responseComplete?'reply-complete':'incomplete';
    phase='finished';if(timer!==null)cancelSchedule(timer);if(stopTimer!==null)cancelSchedule(stopTimer);
    queue=[];current=null;queuedBytes=0;
    stdout.removeListener('data',onStdout);stderr.removeListener('data',onStderr);
    for(const stream of [stdin,stdout,stderr])try{stream.destroy();}catch{}
    emit({type:'finished',state:snapshot()});resolveCompletion(clone(snapshot()));
  }
  function endInput(){if(ending||current||queue.length||phase==='finished')return;ending=true;try{stdin.end();}catch{fail('CLAUDE_TURN_WRITE_FAILED');}}
  function stop(reasonCode){
    if(phase==='finished'||stopRequested)return;
    stopRequested=true;phase='stopping';
    stopTimer=schedule(()=>{if(phase==='finished')return;errorCode=errorCode||'CLAUDE_TURN_STOP_TIMEOUT';finish(true);},limits.maxStopMs);
    emit({type:'pending-cleared',reasonCode});endInput();
    try{const result=requestStop({backendId,sessionId,runId,reasonCode});if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>fail('CLAUDE_TURN_STOP_REQUEST_FAILED'));}catch{fail('CLAUDE_TURN_STOP_REQUEST_FAILED');}
    finish();
  }
  function withdrawQueued(){queue=[];queuedBytes=current?current.bytes.length:0;}
  function fail(code){if(phase==='finished')return;errorCode=errorCode||code;withdrawQueued();stop(errorCode);try{stdout.resume();stderr.resume();}catch{}finish();}
  function safe(fn){if(phase==='finished')return;try{fn();}catch(error){fail(codeOf(error));}}
  function action(fn){check(phase!=='finished','CLAUDE_TURN_FINISHED');try{return fn();}catch(error){const code=codeOf(error);fail(code);throw rejected(code);}}
  function writeDone(operation){if(current!==operation||!operation.returned||!operation.complete||operation.needDrain||phase==='finished')return;queuedBytes-=operation.bytes.length;current=null;lastActivity=clock();pump();}
  function pump(){
    if(current||phase==='finished')return;if(!queue.length){if(stopRequested)endInput();return;}
    const operation={bytes:queue.shift(),started:clock(),complete:false,returned:false,needDrain:false,drained:false};current=operation;
    try{const accepted=stdin.write(operation.bytes,error=>safe(()=>{if(current!==operation)return;if(error)throw rejected('CLAUDE_TURN_WRITE_FAILED');operation.complete=true;writeDone(operation);}));operation.returned=true;operation.needDrain=!accepted&&!operation.drained;writeDone(operation);}catch{fail('CLAUDE_TURN_WRITE_FAILED');}
  }
  function enqueue(bytes){check(Buffer.isBuffer(bytes)&&bytes.length>0,'CLAUDE_TURN_WRITE_INVALID');check(queue.length+(current?1:0)<limits.maxQueuedFrames&&queuedBytes+bytes.length<=limits.maxQueuedBytes,'CLAUDE_TURN_WRITE_BUDGET');queue.push(Buffer.from(bytes));queuedBytes+=bytes.length;pump();}
  function poll(){safe(()=>{const time=clock();if(!ownerCancelled&&!errorCode)protocol.tick();check(time-started<limits.maxWallMs,'CLAUDE_TURN_WALL_TIMEOUT');if(phase==='running'&&protocol.state().pending===0)check(time-lastActivity<limits.maxIdleMs,'CLAUDE_TURN_IDLE_TIMEOUT');if(current)check(time-current.started<limits.maxWriteMs,'CLAUDE_TURN_WRITE_TIMEOUT');});if(phase!=='finished')timer=schedule(poll,Math.min(250,limits.maxWallMs,limits.maxIdleMs,limits.maxWriteMs,limits.permissionTtlMs));}
  function onStdout(chunk){safe(()=>{
    if(errorCode)return;check(phase!=='created','CLAUDE_TURN_BEFORE_START');check(!stdoutEnded,'CLAUDE_TURN_STDOUT_AFTER_EOF');check(Buffer.isBuffer(chunk)&&chunk.length>0,'CLAUDE_TURN_CHUNK_INVALID');lastActivity=clock();stdoutBytes+=chunk.length;
    for(const event of protocol.push(chunk)){if(event.type==='result')terminal=event;if(!ownerCancelled)emit(event);if(errorCode)return;if(event.type==='result')stop('CLAUDE_TURN_TERMINAL');}
  });}
  function onStderr(chunk){safe(()=>{
    if(errorCode)return;check(phase!=='created','CLAUDE_TURN_BEFORE_START');check(!stderrEnded,'CLAUDE_TURN_STDERR_AFTER_EOF');check(Buffer.isBuffer(chunk)&&chunk.length>0,'CLAUDE_TURN_CHUNK_INVALID');stderrBytes+=chunk.length;check(stderrBytes<=limits.maxStderrBytes,'CLAUDE_TURN_STDERR_BUDGET');
    let text;try{text=decoder.decode(chunk,{stream:true});}catch{throw rejected('CLAUDE_TURN_STDERR_UTF8');}check(!text.includes('\0'),'CLAUDE_TURN_STDERR_INVALID');
  });}
  function onStdoutEnd(){safe(()=>{stdoutEnded=true;try{terminal=protocol.end();}catch(error){if(!(ownerCancelled&&error.code==='CLAUDE_EOF_INCOMPLETE'))throw error;}if(!stopRequested)stop('CLAUDE_TURN_STDOUT_EOF');finish();});}
  function onStderrEnd(){safe(()=>{stderrEnded=true;try{decoder.decode();}catch{throw rejected('CLAUDE_TURN_STDERR_UTF8');}if(stderrBytes&&!errorCode)emit({type:'stderr-observed',bytes:stderrBytes});finish();});}
  function streamError(){if(phase!=='finished')fail('CLAUDE_TURN_STREAM_ERROR');}
  for(const stream of [stdin,stdout,stderr])claimedStreams.add(stream);
  stdout.pause();stderr.pause();stdout.on('data',onStdout);stderr.on('data',onStderr);stdout.on('end',onStdoutEnd);stderr.on('end',onStderrEnd);
  stdout.on('close',()=>{if(phase!=='finished'&&!stdoutEnded)fail('CLAUDE_TURN_STDOUT_CLOSED_EARLY');});stderr.on('close',()=>{if(phase!=='finished'&&!stderrEnded)fail('CLAUDE_TURN_STDERR_CLOSED_EARLY');});
  for(const stream of [stdin,stdout,stderr])stream.on('error',streamError);
  stdin.on('close',()=>{if(phase!=='finished'&&!ending)fail('CLAUDE_TURN_STDIN_CLOSED_EARLY');});
  stdin.on('drain',()=>safe(()=>{if(current){current.drained=true;current.needDrain=false;writeDone(current);}}));
  function start(){return action(()=>{check(phase==='created','CLAUDE_TURN_STATE_INVALID');started=lastActivity=clock();protocol.tick();phase='running';enqueue(promptWire);stdout.resume();stderr.resume();timer=schedule(poll,Math.min(250,limits.maxWallMs,limits.maxIdleMs,limits.maxWriteMs,limits.permissionTtlMs));return snapshot();});}
  function decide(owner,decision){return action(()=>{check(phase==='running','CLAUDE_TURN_STATE_INVALID');enqueue(protocol.decide(owner,decision));return snapshot();});}
  function cancel(owner,scope){return action(()=>{check(phase==='running','CLAUDE_TURN_STATE_INVALID');check(owner===ownerAuthority,'CLAUDE_OWNER_REQUIRED');keys(scope,['sessionId','runId','confirm']);check(scope.sessionId===sessionId&&scope.runId===runId&&scope.confirm===true,'CLAUDE_TURN_CANCEL_SCOPE');ownerCancelled=true;withdrawQueued();stop('CLAUDE_TURN_OWNER_CANCELLED');return snapshot();});}
  function reportExit(authority,receipt){return action(()=>{
    check(phase!=='created','CLAUDE_TURN_STATE_INVALID');check(authority===backendAuthority,'CLAUDE_TURN_BACKEND_REQUIRED');keys(receipt,['backendId','sessionId','runId','rootExited','ownedTreeEmpty','cleanupVerified','exitCode','signal']);
    check(receipt.backendId===backendId&&receipt.sessionId===sessionId&&receipt.runId===runId,'CLAUDE_TURN_EXIT_SCOPE');check(receipt.rootExited===true&&typeof receipt.ownedTreeEmpty==='boolean'&&typeof receipt.cleanupVerified==='boolean','CLAUDE_TURN_EXIT_INVALID');
    check((receipt.exitCode===null||Number.isInteger(receipt.exitCode)&&receipt.exitCode>=-2147483648&&receipt.exitCode<=4294967295)&&(receipt.signal===null||typeof receipt.signal==='string'&&/^[A-Z][A-Z0-9_]{0,31}$/.test(receipt.signal))&&(receipt.exitCode!==null||receipt.signal!==null),'CLAUDE_TURN_EXIT_INVALID');
    check(exitReceipt===null,'CLAUDE_TURN_EXIT_REPLAY');exitReceipt=clone(receipt);if(!cleanupKnown())fail('CLAUDE_TURN_CLEANUP_UNVERIFIED');else if(!stopRequested)stop('CLAUDE_TURN_ROOT_EXIT');finish();return snapshot();
  });}
  return Object.freeze({start,decide,cancel,reportExit,pending:()=>phase==='running'?action(()=>protocol.pending()):[],snapshot,completion});
}
module.exports={createTurnController,LIMITS,SOURCE};
