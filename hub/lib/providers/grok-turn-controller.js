'use strict';
// One already-admitted, exclusive stream endpoint. No spawn, auth or OS policy.
const {Readable,Writable}=require('node:stream');
const {TextDecoder}=require('node:util');
const {createHash}=require('node:crypto');
const {createProtocol,LIMITS:PROTOCOL_LIMITS}=require('./grok-protocol');
const {canonical}=require('./claude-protocol');
const LIMITS=Object.freeze({maxWallMs:900000,maxIdleMs:60000,maxWriteMs:10000,maxStopMs:5000,permissionTtlMs:600000,maxPromptBytes:65536,maxStderrBytes:65536,maxQueuedBytes:1048576,maxQueuedFrames:32});
const claimedStreams=new WeakSet();
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const rejected=code=>Object.assign(Error(code),{code});
function check(value,code='GROK_TURN_OPTIONS_INVALID'){if(!value)throw rejected(code);}
function keys(value,required,optional=[]){check(plain(value));check(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const clone=x=>JSON.parse(JSON.stringify(x));

function createTurnController(options){
  keys(options,['sessionId','runId','promptRequestId','prompt','ownerAuthority','backendAuthority','endpoint','onEvent'],['limits','now','monotonic','schedule','cancelSchedule']);
  const {sessionId,runId,promptRequestId,prompt,ownerAuthority,backendAuthority,endpoint,onEvent}=options;
  check(typeof sessionId==='string'&&ID.test(sessionId)&&typeof runId==='string'&&ID.test(runId));
  check(ownerAuthority!==null&&typeof ownerAuthority==='object'&&backendAuthority!==null&&typeof backendAuthority==='object'&&ownerAuthority!==backendAuthority);
  check(typeof onEvent==='function');
  keys(endpoint,['backendId','stdin','stdout','stderr','requestStop']);
  check(typeof endpoint.backendId==='string'&&ID.test(endpoint.backendId)&&typeof endpoint.requestStop==='function');
  const {backendId,stdin,stdout,stderr,requestStop}=endpoint;
  check(stdin instanceof Writable&&stdout instanceof Readable&&stderr instanceof Readable&&stdout!==stderr&&stdin!==stdout&&stdin!==stderr);
  check([stdin,stdout,stderr].every(stream=>!claimedStreams.has(stream)),'GROK_TURN_ENDPOINT_NOT_EXCLUSIVE');
  check(!stdin.destroyed&&!stdin.writableEnded&&!stdin.writableFinished&&stdin.writableLength===0&&!stdin.writableCorked&&!stdin.writableNeedDrain&&!stdout.destroyed&&!stderr.destroyed,'GROK_TURN_ENDPOINT_NOT_EXCLUSIVE');
  for(const stream of [stdout,stderr])check(!stream.readableEnded&&!stream.readableEncoding&&stream.readableFlowing!==true&&stream.listenerCount('data')===0&&stream.listenerCount('readable')===0,'GROK_TURN_ENDPOINT_NOT_EXCLUSIVE');
  const limits={...LIMITS};
  if(options.limits!==undefined){keys(options.limits,[],Object.keys(LIMITS));for(const [key,value]of Object.entries(options.limits)){check(integer(value)&&value>=1&&value<=LIMITS[key]);limits[key]=value;}}
  check(typeof prompt==='string'&&prompt.length>0&&prompt.isWellFormed()&&!prompt.includes('\0')&&Buffer.byteLength(prompt)<=limits.maxPromptBytes,'GROK_TURN_PROMPT_INVALID');
  const now=options.now===undefined?Date.now:options.now;
  const monotonic=options.monotonic===undefined?()=>Number(process.hrtime.bigint()/1000000n):options.monotonic;
  const schedule=options.schedule===undefined?setTimeout:options.schedule;
  const cancelSchedule=options.cancelSchedule===undefined?clearTimeout:options.cancelSchedule;
  check([now,monotonic,schedule,cancelSchedule].every(x=>typeof x==='function'));
  const protocol=createProtocol({sessionId,runId,promptRequestId,ownerAuthority,now,monotonic,limits:{permissionTtlMs:limits.permissionTtlMs}});
  const promptWire=Buffer.from(canonical({jsonrpc:'2.0',id:promptRequestId,method:'session/prompt',params:{sessionId,prompt:[{type:'text',text:prompt}]}})+'\n');
  check(promptWire.length<=PROTOCOL_LIMITS.maxFrameBytes,'GROK_TURN_PROMPT_FRAME_SIZE');
  const promptSHA256=createHash('sha256').update(Buffer.from(prompt)).digest('hex');
  let phase='created',completionKind=null,errorCode=null,started=null,lastActivity=null,lastClock=null;
  let timer=null,stopTimer=null,stopRequested=false,ownerCancelled=false,eventBroken=false,ending=false;
  let stdoutEnded=false,stderrEnded=false,terminal=null,exitReceipt=null,stdoutBytes=0,stderrBytes=0;
  let queue=[],queuedBytes=0,current=null;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  let resolveCompletion;
  const completion=new Promise(resolve=>{resolveCompletion=resolve;});
  function codeOf(error){return typeof error?.code==='string'&&/^GROK_[A-Z0-9_]+$/.test(error.code)?error.code:'GROK_TURN_INTERNAL_ERROR';}
  function clock(){const wall=now(),mono=monotonic();check(integer(wall)&&integer(mono)&&(!lastClock||wall>=lastClock.wall&&mono>=lastClock.mono),'GROK_TURN_CLOCK_INVALID');lastClock={wall,mono};return mono;}
  function emit(value){if(eventBroken)return;try{const returned=onEvent(clone(value));if(returned&&typeof returned.then==='function'){Promise.resolve(returned).catch(()=>{});throw rejected('GROK_TURN_EVENT_HANDLER_FAILED');}check(returned===undefined,'GROK_TURN_EVENT_HANDLER_FAILED');}catch{eventBroken=true;if(phase==='finished'){if(!errorCode)errorCode='GROK_TURN_EVENT_HANDLER_FAILED';completionKind=cleanupKnown()?'failed':'cleanup-unknown';}else fail('GROK_TURN_EVENT_HANDLER_FAILED');}}
  function cleanupKnown(){return Boolean(exitReceipt?.rootExited&&exitReceipt.ownedTreeEmpty&&exitReceipt.cleanupVerified);}
  function snapshot(){return {schema:'grok-turn-state/v1',phase,completionKind,backendId,sessionId,runId,promptRequestId,promptSHA256,errorCode,stopRequested,ownerCancelled,protocolTerminal:terminal!==null,replyComplete:terminal?.replyComplete===true,taskSuccess:null,stdoutEnded,stderrEnded,rootExited:exitReceipt?.rootExited===true,ownedTreeEmpty:exitReceipt?.ownedTreeEmpty===true,cleanupVerified:cleanupKnown(),exitCode:exitReceipt?.exitCode??null,signal:exitReceipt?.signal??null,pending:phase==='running'?protocol.state().pending:0,queuedFrames:queue.length+(current?1:0),queuedBytes,stdoutBytes,stderrBytes};}
  function finish(forced=false){
    if(phase==='finished')return;
    if(!forced&&(!stdoutEnded||!stderrEnded||!cleanupKnown()))return;
    if(!cleanupKnown())completionKind='cleanup-unknown';
    else if(errorCode)completionKind='failed';
    else if(ownerCancelled)completionKind='cancelled';
    else if(!terminal||exitReceipt.exitCode!==0||exitReceipt.signal!==null){errorCode='GROK_TURN_EXIT_UNSUCCESSFUL';completionKind='failed';}
    else completionKind=terminal.replyComplete?'reply-complete':'incomplete';
    phase='finished';if(timer!==null)cancelSchedule(timer);if(stopTimer!==null)cancelSchedule(stopTimer);
    queue=[];current=null;queuedBytes=0;
    // Endpoint ownership is exclusive. Closing streams does not prove tree exit.
    stdout.removeListener('data',onStdout);stderr.removeListener('data',onStderr);
    for(const stream of [stdin,stdout,stderr]){try{stream.destroy();}catch{}}
    emit({type:'finished',state:snapshot()});resolveCompletion(clone(snapshot()));
  }
  function endInput(){if(ending||current||queue.length||phase==='finished')return;ending=true;try{stdin.end();}catch{fail('GROK_TURN_WRITE_FAILED');}}
  function stop(reasonCode){
    if(phase==='finished'||stopRequested)return;
    stopRequested=true;phase='stopping';
    stopTimer=schedule(()=>{if(phase==='finished')return;if(!errorCode)errorCode='GROK_TURN_STOP_TIMEOUT';finish(true);},limits.maxStopMs);
    emit({type:'pending-cleared',reasonCode});
    endInput();
    try{const response=requestStop({backendId,sessionId,runId,reasonCode});if(response&&typeof response.then==='function')response.catch(()=>{fail('GROK_TURN_STOP_REQUEST_FAILED');});}catch{fail('GROK_TURN_STOP_REQUEST_FAILED');}
    finish();
  }
  function fail(code){
    if(phase==='finished')return;
    if(!errorCode)errorCode=code;
    // Withdraw approval first; an RPC cancel is not a process Stop receipt.
    try{protocol.cancel(ownerAuthority,{sessionId,runId,confirm:true});}catch{}
    queue=[];current=null;queuedBytes=0;stop(errorCode);
    try{stdout.resume();stderr.resume();}catch{}
    finish();
  }
  function safe(fn){if(phase==='finished')return;try{fn();}catch(error){fail(codeOf(error));}}
  function action(fn){check(phase!=='finished','GROK_TURN_FINISHED');try{return fn();}catch(error){const code=codeOf(error);fail(code);throw rejected(code);}}
  function writeDone(operation){
    if(current!==operation||!operation.returned||!operation.complete||operation.needDrain||phase==='finished')return;
    queuedBytes-=operation.bytes.length;current=null;lastActivity=clock();pump();
  }
  function pump(){
    if(current||phase==='finished')return;
    if(!queue.length){if(stopRequested)endInput();return;}
    const operation={bytes:queue.shift(),started:clock(),complete:false,returned:false,needDrain:false,drained:false};current=operation;
    try{
      const accepted=stdin.write(operation.bytes,error=>safe(()=>{if(current!==operation)return;if(error)throw rejected('GROK_TURN_WRITE_FAILED');operation.complete=true;writeDone(operation);}));
      operation.returned=true;operation.needDrain=!accepted&&!operation.drained;writeDone(operation);
    }catch{fail('GROK_TURN_WRITE_FAILED');}
  }
  function enqueue(bytes){
    check(Buffer.isBuffer(bytes)&&bytes.length>0,'GROK_TURN_WRITE_INVALID');
    check(queue.length+(current?1:0)<limits.maxQueuedFrames&&queuedBytes+bytes.length<=limits.maxQueuedBytes,'GROK_TURN_WRITE_BUDGET');
    queue.push(Buffer.from(bytes));queuedBytes+=bytes.length;pump();
  }
  function poll(){safe(()=>{
    const time=clock();protocol.tick();
    check(time-started<limits.maxWallMs,'GROK_TURN_WALL_TIMEOUT');
    if(phase==='running'&&protocol.state().pending===0)check(time-lastActivity<limits.maxIdleMs,'GROK_TURN_IDLE_TIMEOUT');
    if(current)check(time-current.started<limits.maxWriteMs,'GROK_TURN_WRITE_TIMEOUT');
  });if(phase!=='finished')timer=schedule(poll,Math.min(250,limits.maxWallMs,limits.maxIdleMs,limits.maxWriteMs,limits.permissionTtlMs));}
  function onStdout(chunk){safe(()=>{
    if(errorCode)return;
    check(phase!=='created','GROK_TURN_BEFORE_START');check(!stdoutEnded,'GROK_TURN_STDOUT_AFTER_EOF');check(Buffer.isBuffer(chunk)&&chunk.length>0,'GROK_TURN_CHUNK_INVALID');lastActivity=clock();stdoutBytes+=chunk.length;
    for(const event of protocol.push(chunk)){
      if(event.type==='result')terminal=event;
      emit(event);if(errorCode)return;
      if(event.type==='result')stop('GROK_TURN_TERMINAL');
    }
  });}
  function onStderr(chunk){safe(()=>{
    if(errorCode)return;
    check(phase!=='created','GROK_TURN_BEFORE_START');check(!stderrEnded,'GROK_TURN_STDERR_AFTER_EOF');check(Buffer.isBuffer(chunk)&&chunk.length>0,'GROK_TURN_CHUNK_INVALID');stderrBytes+=chunk.length;
    check(stderrBytes<=limits.maxStderrBytes,'GROK_TURN_STDERR_BUDGET');
    let text;try{text=decoder.decode(chunk,{stream:true});}catch{throw rejected('GROK_TURN_STDERR_UTF8');}
    check(!text.includes('\0'),'GROK_TURN_STDERR_INVALID');
  });}
  function onStdoutEnd(){safe(()=>{
    stdoutEnded=true;
    try{const result=protocol.end();terminal=result;}catch(error){if(!(ownerCancelled&&error.code==='GROK_EOF_INCOMPLETE'))throw error;}
    if(!stopRequested)stop('GROK_TURN_STDOUT_EOF');finish();
  });}
  function onStderrEnd(){safe(()=>{stderrEnded=true;try{decoder.decode();}catch{throw rejected('GROK_TURN_STDERR_UTF8');}if(stderrBytes&&!errorCode)emit({type:'stderr-observed',bytes:stderrBytes});finish();});}
  function streamError(){if(phase!=='finished')fail('GROK_TURN_STREAM_ERROR');}
  // Pausing ownership transfer cannot undo bytes already consumed by another reader.
  for(const stream of [stdin,stdout,stderr])claimedStreams.add(stream);
  stdout.pause();stderr.pause();
  stdout.on('data',onStdout);stderr.on('data',onStderr);
  stdout.on('end',onStdoutEnd);stderr.on('end',onStderrEnd);
  stdout.on('close',()=>{if(phase!=='finished'&&!stdoutEnded)fail('GROK_TURN_STDOUT_CLOSED_EARLY');});
  stderr.on('close',()=>{if(phase!=='finished'&&!stderrEnded)fail('GROK_TURN_STDERR_CLOSED_EARLY');});
  for(const stream of [stdin,stdout,stderr])stream.on('error',streamError);
  stdin.on('drain',()=>safe(()=>{if(current){current.drained=true;current.needDrain=false;writeDone(current);}}));
  function start(){return action(()=>{check(phase==='created','GROK_TURN_STATE_INVALID');started=lastActivity=clock();protocol.tick();phase='running';enqueue(promptWire);stdout.resume();stderr.resume();timer=schedule(poll,Math.min(250,limits.maxWallMs,limits.maxIdleMs,limits.maxWriteMs,limits.permissionTtlMs));return snapshot();});}
  function decide(owner,decision){return action(()=>{check(phase==='running','GROK_TURN_STATE_INVALID');enqueue(protocol.decide(owner,decision));return snapshot();});}
  function cancel(owner,scope){return action(()=>{
    check(phase==='running','GROK_TURN_STATE_INVALID');
    const frames=protocol.cancel(owner,scope);ownerCancelled=true;
    // Withdraw frames that have not reached stdin.write. Bytes already handed
    // to the exclusive transport cannot be retracted; retain their accounting.
    queue=[];queuedBytes=current?current.bytes.length:0;
    for(const frame of frames)enqueue(frame);
    stop('GROK_TURN_OWNER_CANCELLED');return snapshot();
  });}
  function reportExit(authority,receipt){return action(()=>{
    check(authority===backendAuthority,'GROK_TURN_BACKEND_REQUIRED');
    keys(receipt,['backendId','sessionId','runId','rootExited','ownedTreeEmpty','cleanupVerified','exitCode','signal']);
    check(receipt.backendId===backendId&&receipt.sessionId===sessionId&&receipt.runId===runId,'GROK_TURN_EXIT_SCOPE');
    check(receipt.rootExited===true&&typeof receipt.ownedTreeEmpty==='boolean'&&typeof receipt.cleanupVerified==='boolean','GROK_TURN_EXIT_INVALID');
    check((receipt.exitCode===null||Number.isInteger(receipt.exitCode)&&receipt.exitCode>=-2147483648&&receipt.exitCode<=4294967295)&&(receipt.signal===null||typeof receipt.signal==='string'&&/^[A-Z][A-Z0-9_]{0,31}$/.test(receipt.signal))&&(receipt.exitCode!==null||receipt.signal!==null),'GROK_TURN_EXIT_INVALID');
    check(exitReceipt===null,'GROK_TURN_EXIT_REPLAY');exitReceipt=clone(receipt);
    if(!cleanupKnown())fail('GROK_TURN_CLEANUP_UNVERIFIED');
    else if(!stopRequested)stop('GROK_TURN_ROOT_EXIT');
    finish();return snapshot();
  });}
  return Object.freeze({start,decide,cancel,reportExit,pending:()=>phase==='running'?action(()=>protocol.pending()):[],snapshot,completion});
}
module.exports={createTurnController,LIMITS};
