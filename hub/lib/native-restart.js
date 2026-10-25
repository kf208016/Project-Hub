'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{localPath}=require('./safe-path');
const fail=code=>Object.assign(Error('Windows restart: '+code),{code,status:409});
const preflight=code=>Object.assign(fail(code),{notStarted:true,stage:'preflight'});
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function sourceHash(hubDir){return hash(Buffer.concat(['start-windows.ps1','server.js','package.json','lib/native-restart.js','lib/native-restart-worker.js'].map(name=>{const file=path.join(hubDir,name);localPath(file);const st=fs.statSync(file);if(!st.isFile()||st.size>1024*1024)throw fail('SOURCE_REJECTED');return Buffer.concat([Buffer.from(name+'\0'),fs.readFileSync(file)]);})));}
async function start({root,hubDir,pid=process.pid,launch=spawn}) {
  if(process.platform!=='win32')throw preflight('UNSUPPORTED_PLATFORM');try{localPath(root);localPath(hubDir);}catch{throw preflight('PATH_REJECTED');}
  const stateFile=path.join(root,'_hub/desktop-state.json');let state;try{localPath(stateFile);const st=fs.statSync(stateFile);if(!st.isFile()||st.size>16384)throw Error();state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{throw preflight('LAUNCHER_STATE_REQUIRED');}
  if(state.version!==1||state.root!==root||state.hubDir!==hubDir||state.pid!==pid||typeof state.createdTicks!=='string'||!/^[0-9]{1,19}$/.test(state.createdTicks)||!Number.isSafeInteger(state.port)||state.port<1024||state.port>65535)throw preflight('LAUNCHER_IDENTITY_CHANGED');
  let operation,statusKey,digest,spec;
  try{operation=crypto.randomUUID();statusKey=crypto.randomBytes(32).toString('base64url');digest=sourceHash(hubDir);spec={version:1,operation,statusKey,root,hubDir,sourceHash:digest,pid,createdTicks:state.createdTicks,port:state.port};}catch{throw preflight('SOURCE_REJECTED');}
  try{const folder=path.join(root,'_hub/restart');localPath(folder,{allowMissing:true});fs.mkdirSync(folder,{recursive:true});const planned=path.join(folder,operation+'.planned.json');localPath(planned,{allowMissing:true});const fd=fs.openSync(planned,'wx');try{fs.writeFileSync(fd,JSON.stringify({version:1,operation,sourceHash:digest,pid,createdTicks:state.createdTicks,phase:'planned'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{throw preflight('PLANNED_RECORD_FAILED');}
  const env={...process.env,HUB_RESTART_SPEC:JSON.stringify(spec)};for(const key of Object.keys(env))if(/^HUB_MCP_/i.test(key)||/^HUB_LOCAL_TOKEN$/i.test(key))delete env[key];
  const child=launch(process.execPath,[path.join(__dirname,'native-restart-worker.js')],{cwd:hubDir,env,windowsHide:true,detached:true,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let buffer='',done=false;const timer=setTimeout(()=>finish(fail('HELPER_START_TIMEOUT')),10000);const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill();reject(error);}else{child.unref();child.stdout.unref?.();child.stderr.unref?.();resolve({ok:true,operation,statusKey,statusPort:JSON.parse(buffer).port,sourceHash:digest,phase:'restarting'});}};
    child.on('error',()=>finish(fail('HELPER_START_FAILED')));child.stderr.resume();child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{if(done)return;buffer+=data;if(buffer.length>4096)return finish(fail('HELPER_RESPONSE_REJECTED'));if(!buffer.endsWith('\n'))return;try{const ready=JSON.parse(buffer);if(ready.operation!==operation||!Number.isSafeInteger(ready.port)||ready.port<1024||ready.port>65535)throw Error();finish();}catch{finish(fail('HELPER_RESPONSE_REJECTED'));}});child.on('close',()=>{if(!done)finish(fail('HELPER_EARLY_EXIT'));});
  });
}
module.exports={start,sourceHash};
