'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),restart=require('../lib/native-restart');
const win=process.platform==='win32'?test:test.skip;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-restart-preflight-')),hubDir=path.join(root,'source');fs.mkdirSync(path.join(root,'_hub'));fs.mkdirSync(path.join(hubDir,'lib'),{recursive:true});for(const name of ['start-windows.ps1','server.js','package.json','lib/native-restart.js','lib/native-restart-worker.js'])fs.writeFileSync(path.join(hubDir,name),'synthetic source '+name);const stateFile=path.join(root,'_hub/desktop-state.json');fs.writeFileSync(stateFile,JSON.stringify({version:1,root,hubDir,pid:12345,createdTicks:'123456789',port:4545}));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,hubDir,pid:12345,stateFile};}
win('Restart preflight refusals report notStarted only when no helper has launched',async t=>{
 const f=fixture(t);let launches=0;const launch=()=>{launches++;throw Error('must not launch');},expect=code=>error=>error.code===code&&error.notStarted===true&&error.stage==='preflight';
 fs.renameSync(f.stateFile,f.stateFile+'.backup');await assert.rejects(restart.start({...f,launch}),expect('LAUNCHER_STATE_REQUIRED'));fs.renameSync(f.stateFile+'.backup',f.stateFile);
 await assert.rejects(restart.start({...f,pid:23456,launch}),expect('LAUNCHER_IDENTITY_CHANGED'));
 fs.unlinkSync(path.join(f.hubDir,'server.js'));await assert.rejects(restart.start({...f,launch}),expect('SOURCE_REJECTED'));fs.writeFileSync(path.join(f.hubDir,'server.js'),'synthetic source server.js');
 fs.writeFileSync(path.join(f.root,'_hub/restart'),'obstruct planned directory');await assert.rejects(restart.start({...f,launch}),expect('PLANNED_RECORD_FAILED'));assert.equal(launches,0);
});
win('Restart launch exceptions have no notStarted claim and a successful handshake returns the exact source digest',async t=>{
 const f=fixture(t);await assert.rejects(restart.start({...f,launch:()=>{throw Error('synthetic unknown launch result');}}),error=>error.notStarted===undefined);
 let received,unref=false;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.unref=()=>{unref=true;};child.kill=()=>{};
 const value=await restart.start({...f,launch:(file,args,options)=>{received={file,args,options};queueMicrotask(()=>child.stdout.write(JSON.stringify({operation:JSON.parse(options.env.HUB_RESTART_SPEC).operation,port:4567})+'\n'));return child;}});
 assert.equal(value.sourceHash,restart.sourceHash(f.hubDir));assert.equal(value.statusPort,4567);assert.equal(unref,true);assert.equal(received.options.windowsHide,true);assert.equal(received.options.env.HUB_MCP_TOKEN,undefined);assert.equal(received.options.env.HUB_LOCAL_TOKEN,undefined);assert.equal(received.args.length,1);child.stdout.destroy();child.stderr.destroy();
});
