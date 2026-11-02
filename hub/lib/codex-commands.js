'use strict';
// Standalone command/exec: no thread, turn, model, or approval bypass.
// Read scope is broader than cwd; networkAccess=false is an incomplete boundary.
const {randomUUID}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const path=require('node:path');
const os=require('node:os');
const cli=require('./cli-platform'),managed=require('./managed-process');
const {localPath}=require('./safe-path');
const failure=code=>Object.assign(Error('Codex command broker: '+code),{code,status:409});
const {reviewed}=require('./codex-versions');
const MAX=1024*1024;
function run(file,options) {
  if(process.platform!=='win32'||process.arch!=='x64'||os.release()!=='10.0.26200')throw failure('UNSUPPORTED_PLATFORM');
  if(!options || !Array.isArray(options.argv)||!options.argv.length||options.argv.some(x=>typeof x!=='string'||x.includes('\0'))||!path.isAbsolute(options.argv[0])||options.cwd!==options.root||!/^[a-f0-9]{64}$/.test(options.rootFingerprint||''))throw failure('INVALID_REQUEST');
  if(!reviewed(options.expectedVersion))throw failure('UNSUPPORTED_CODEX_VERSION');
  const timeoutMs=options.timeoutMs===undefined?30000:options.timeoutMs;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw failure('INVALID_TIMEOUT');
  localPath(options.argv[0]);localPath(file);
  const command=cli.invocation(file,['app-server','--listen','stdio://','-c','analytics.enabled=false','-c','windows.sandbox="elevated"']);
  const env={...(options.env||process.env)};
  for(const key of Object.keys(env))if(/^HUB_/i.test(key)||/^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GOOGLE_API_KEY|GEMINI_API_KEY)$/i.test(key))delete env[key];
  const child=(options.spawn||managed.spawn)(command.file,command.args,{cwd:options.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe'],dirPin:{root:options.root,rootFingerprint:options.rootFingerprint}});
  const processId=randomUUID(),decoder=new StringDecoder('utf8');
  let buffer='',bytes=0,phase='starting',finished=false,canceled=false,result,error,closing=false,stopTimer;
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  const stop=code=>{if(error||finished)return;error=failure(code);cancel();};
  const close=()=>{if(closing)return;closing=true;child.stdin.end();stopTimer=setTimeout(()=>child.kill(),5000);};
  const cancel=()=>{
    if(finished||canceled)return;canceled=true;
    if(phase==='command'){
      // The supervisor retains root pins until its entire Job is empty.
      // Keep the 0.154.0 lifetime contract for both reviewed versions.
      // 0.164.0 must be re-verified on the real machine.
      // Codex 0.154.0 Windows buffered commands do not register protocol
      // terminate sessions. Closing the connection requests cleanup, followed
      // by the supervisor's owned Job termination if shutdown has not finished.
      close();
    }else child.kill();
  };
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const watchdog=setTimeout(()=>stop('COMMAND_TIMEOUT'),timeoutMs+20000);
  child.stdin.on('error',()=>stop('CHANNEL_INTERRUPTED'));
  child.on('error',()=>stop('STARTUP_FAILED'));
  child.on('spawn',()=>{
    if(canceled){child.kill();return;}
    try{send({id:1,method:'initialize',params:{clientInfo:{name:'project_hub_command',version:'1.0.0'}}});}catch{stop('CHANNEL_INTERRUPTED');}
  });
  const receive=message=>{
    if(!message||typeof message!=='object'||Array.isArray(message))throw failure('INVALID_PROTOCOL');
    if(message.method){
      if(message.id!==undefined)throw failure('UNEXPECTED_APPROVAL_REQUEST');
      if(message.method==='command/exec/outputDelta'){
        const params=message.params;
        if(!params||params.processId!==processId||!['stdout','stderr'].includes(params.stream)||typeof params.deltaBase64!=='string'||! /^[A-Za-z0-9+/]*={0,2}$/.test(params.deltaBase64))throw failure('INVALID_OUTPUT');
        if(options.onOutput)options.onOutput(params.stream,Buffer.from(params.deltaBase64,'base64'));
      }
      return;
    }
    if(message.id===1&&phase==='starting'){
      if(message.error||!message.result||typeof message.result!=='object'||Array.isArray(message.result))throw failure('INITIALIZE_FAILED');
      if(message.result.platformOs!=='windows'||message.result.platformFamily!=='windows'||typeof message.result.userAgent!=='string'||!message.result.userAgent.split(' ').some(part=>part.endsWith('/'+options.expectedVersion)))throw failure('UNSUPPORTED_CODEX_VERSION');
      if(canceled)return child.kill();
      send({method:'initialized',params:{}});phase='command';
      // Codex 0.154.0's Windows sandbox rejects custom outputBytesCap. Keep
      // its default capture cap plus the independent transport/result bounds.
      send({id:2,method:'command/exec',params:{command:options.argv.slice(),cwd:options.cwd,processId,timeoutMs,sandboxPolicy:{type:'workspaceWrite',writableRoots:[options.root],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}}});return;
    }
    if(message.id!==2||phase!=='command'||result)throw failure('UNEXPECTED_RESPONSE');
    if(message.error)throw failure('EXECUTION_REJECTED');
    const row=message.result;
    if(!row||!Number.isSafeInteger(row.exitCode)||typeof row.stdout!=='string'||typeof row.stderr!=='string'||Buffer.byteLength(row.stdout)+Buffer.byteLength(row.stderr)>400*1024+4096)throw failure('INVALID_RESULT');
    result={codexVersion:options.expectedVersion,exitCode:row.exitCode,stdout:row.stdout,stderr:row.stderr,canceled,modelCalled:false,readBoundary:'broader-than-task',networkBoundary:'networkAccess=false is not a complete network boundary'};
    phase='closing';close();
  };
  child.stdout.on('data',chunk=>{
    if(error)return;bytes+=chunk.length;if(bytes>MAX)return stop('OUTPUT_LIMIT');buffer+=decoder.write(chunk);
    const lines=buffer.split('\n');buffer=lines.pop();
    try{for(const line of lines)if(line.trim())receive(JSON.parse(line));}catch(e){stop(e.code||'INVALID_PROTOCOL');}
  });
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX)stop('OUTPUT_LIMIT');});
  child.once('close',()=>{finished=true;clearTimeout(watchdog);clearTimeout(stopTimer);if(error)reject(error);else if(result)resolve(result);else if(canceled)resolve({canceled:true,modelCalled:false});else reject(failure('INCOMPLETE_COMMAND'));});
  return {promise,cancel};
}
module.exports={run};
