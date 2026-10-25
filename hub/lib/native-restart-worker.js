'use strict';
// Intentionally outlives the old controller for one approved restart. This
// status listener has no Hub credential, MCP tool, write API or public bind.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
const {sourceHash}=require('./native-restart'),{localPath}=require('./safe-path');
let spec;try{const encoded=process.env.HUB_RESTART_SPEC;delete process.env.HUB_RESTART_SPEC;if(!encoded||encoded.length>16384)throw Error();spec=JSON.parse(encoded);if(spec.version!==1||typeof spec.operation!=='string'||!/^[a-f0-9-]{36}$/.test(spec.operation)||!/^[A-Za-z0-9_-]{43}$/.test(spec.statusKey)||!/^[a-f0-9]{64}$/.test(spec.sourceHash)||!Number.isSafeInteger(spec.pid)||spec.pid<=0||!/^[0-9]{1,19}$/.test(spec.createdTicks)||!Number.isSafeInteger(spec.port)||spec.port<1024||spec.port>65535||sourceHash(spec.hubDir)!==spec.sourceHash)throw Error();localPath(spec.root);}catch{process.exit(125);}
const status={operation:spec.operation,phase:'starting',sourceHash:spec.sourceHash,error:null};let helper,expired=false;
const stateFile=path.join(spec.root,'_hub/restart',spec.operation+'.result.json');
function save(){try{localPath(stateFile,{allowMissing:true});const fd=fs.openSync(stateFile,'wx');try{fs.writeFileSync(fd,JSON.stringify(status));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{status.error='STATUS_RECORD_FAILED';status.phase='failed';}}
const server=http.createServer((req,res)=>{
  const port=server.address().port,origins=['http://127.0.0.1:'+spec.port,'http://localhost:'+spec.port];res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.origin&&!origins.includes(req.headers.origin)){res.writeHead(403);res.end();return;}if(req.headers.origin)res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
  const url=new URL(req.url,'http://127.0.0.1:'+port),challenge=url.searchParams.get('challenge');if(req.method!=='GET'||req.headers.host!=='127.0.0.1:'+port||url.pathname!=='/status'||url.searchParams.get('operation')!==spec.operation||!/^[a-f0-9]{64}$/.test(challenge||'')){res.writeHead(404);res.end();return;}
  const body=JSON.stringify(status),proof=crypto.createHmac('sha256',spec.statusKey).update('hub-restart-status-v1\n'+challenge+'\n'+body).digest('hex');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({body,proof}));
});
server.listen(0,'127.0.0.1',()=>{
  process.stdout.on('error',()=>{});console.log(JSON.stringify({operation:spec.operation,port:server.address().port}));
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),script=path.join(spec.hubDir,'start-windows.ps1');localPath(ps);localPath(script);
  helper=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',script,'-Restart','-NoBrowser','-ExpectedPid',String(spec.pid),'-ExpectedCreatedTicks',spec.createdTicks],{cwd:spec.hubDir,env:{...process.env,HUB_ROOT:spec.root,HUB_PORT:String(spec.port),HUB_NO_BROWSER:'1'},windowsHide:true,stdio:['ignore','ignore','ignore']});
  helper.once('error',()=>{status.phase='failed';status.error='LAUNCHER_START_FAILED';save();});helper.once('close',code=>{if(expired)return;if(code===0){status.phase='ready';try{localPath(path.join(spec.root,'_hub/desktop-state.json'));const state=JSON.parse(fs.readFileSync(path.join(spec.root,'_hub/desktop-state.json'),'utf8'));if(state.version!==1||state.root!==spec.root||state.hubDir!==spec.hubDir||!Number.isSafeInteger(state.pid)||state.pid<=0||state.pid===spec.pid||state.port!==spec.port||typeof state.createdTicks!=='string'||!/^[0-9]{1,19}$/.test(state.createdTicks)||sourceHash(spec.hubDir)!==spec.sourceHash)throw Error();
      const verify='$ErrorActionPreference="Stop";$p=Get-Process -Id ([int]$env:HUB_VERIFY_PID);if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:HUB_VERIFY_TICKS -or $p.Path -ine $env:HUB_VERIFY_EXE){exit 125};[Console]::Write("verified")';
      if(execFileSync(ps,['-NoProfile','-NonInteractive','-Command',verify],{env:{...process.env,HUB_VERIFY_PID:String(state.pid),HUB_VERIFY_TICKS:state.createdTicks,HUB_VERIFY_EXE:process.execPath},windowsHide:true,timeout:5000,maxBuffer:4096,encoding:'utf8'})!=='verified')throw Error();status.pid=state.pid;status.createdTicks=state.createdTicks;}catch{status.phase='failed';status.error='NEW_STATE_REJECTED';}}else{status.phase='failed';status.error='LAUNCHER_RESTART_REJECTED';}save();});
});
setTimeout(()=>{expired=true;if(status.phase==='starting'){status.phase='failed';status.error='RESTART_TIMEOUT';save();helper?.kill();}server.close();process.exit(status.phase==='ready'?0:125);},120000).unref();
