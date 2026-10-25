'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {execFile}=require('node:child_process');
const win=process.platform==='win32'?test:test.skip;
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const script=path.join(__dirname,'../start-windows.ps1');
function environment(root) {
 const fixture=require('./helpers/portable-cli').install(root,"if(process.argv.includes('--version')){console.log('codex-cli fixture');process.exit(0);}throw Error('launcher fixture must not run model requests');",'codex');
 return {...process.env,PATH:fixture.bin+path.delimiter+process.env.PATH,HUB_AI_HOME:path.join(root,'home')};
}
function run(args,env){return new Promise((resolve,reject)=>execFile(ps,['-NoProfile','-NonInteractive','-File',script,'-NoBrowser',...args],{windowsHide:true,env,timeout:30000},(e,out,err)=>e?reject(Object.assign(e,{safeOutput:out+'\n'+err})):resolve(out)));}
win('Windows launcher starts hidden service, reopens same instance, encrypts state and stops cleanly',{timeout:50000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-launcher-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const env={...environment(root),HUB_ROOT:root,HUB_PORT:String(port)};delete env.HUB_DRY_RUN;delete env.HUB_LOCAL_TOKEN;
 t.after(async()=>{try{await run(['-Stop'],env);}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});}});
 let out;try{out=await run([],env);}catch(e){throw Error(e.safeOutput);}
 assert.match(out,/running on/);assert.doesNotMatch(out,/#auth=/);
 const file=path.join(root,'_hub','desktop-state.json'),before=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(before.version,1);assert.equal(Buffer.from(before.protectedToken,'base64').subarray(0,4).toString('hex'),'01000000');assert.equal(before.token,undefined);
 assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status,200);
 await run([],env);const after=JSON.parse(fs.readFileSync(file));assert.equal(after.pid,before.pid);assert.equal(after.createdTicks,before.createdTicks);assert.equal(after.protectedToken,before.protectedToken);
 assert.match(await run(['-Stop'],env),/stopped/);assert.equal(fs.existsSync(file),false);await assert.rejects(fetch(`http://127.0.0.1:${port}/api/state`));
});
win('Windows launcher refuses an occupied unrelated port before creating a credential state',{timeout:15000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-port-')),server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 await assert.rejects(run([],{...environment(root),HUB_ROOT:root,HUB_PORT:String(port)}),e=>/occupied by an unverified service/.test(e.safeOutput));
 assert.equal(fs.existsSync(path.join(root,'_hub','desktop-state.json')),false);
});
win('Windows launcher rejects an aliased control directory and malformed saved process state',{timeout:60000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-launcher-alias-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'hub-launcher-outside-'));
 const control=path.join(root,'_hub'),guard=net.createServer();await new Promise(r=>guard.listen(0,'127.0.0.1',r));const port=guard.address().port;
 t.after(async()=>{await new Promise(r=>guard.close(r));fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
 fs.symlinkSync(outside,control,'junction');
 const env={...environment(root),HUB_ROOT:root,HUB_PORT:String(port)};
 await assert.rejects(run([],env),e=>/filesystem aliases/.test(e.safeOutput));
 assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(control);fs.mkdirSync(control);
 const createdTicks=require('node:child_process').execFileSync(ps,['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
 const live={version:1,root,hubDir:path.dirname(script),pid:process.pid,port,createdTicks,node:process.execPath,protectedToken:'AA=='},file=path.join(control,'desktop-state.json');
 for(const [value,pattern]of [[{...live,version:'1',createdTicks:'0'},/invalid process identity fields/],[{...live,root:root+'-other'},/different workspace\/version/],[{...live,port:999999},/invalid credential fields/],[{...live,createdTicks:'0'},/Cleared stale launcher state[\s\S]*occupied by an unverified service/]]){
  fs.writeFileSync(file,JSON.stringify(value));await assert.rejects(run([],env),e=>pattern.test(e.safeOutput));
 }
 assert.equal(fs.existsSync(file),false);assert.equal(fs.readdirSync(control).filter(x=>/^desktop-state\.stale-0-[a-f0-9]{8}\.json$/.test(x)).length,1);
 assert.equal(fs.existsSync(path.join(control,'server.stdout.log')),false);
});
