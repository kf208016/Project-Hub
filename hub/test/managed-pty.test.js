'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {spawn}=require('../lib/managed-pty');
const win=process.platform==='win32'?test:test.skip;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function watch(child){let output='';child.onData(x=>output+=x);const closed=new Promise(r=>child.onExit(r));return{closed,output:()=>output};}
async function until(check){for(let i=0;i<200;i++){const value=check();if(value)return value;await pause(25);}throw Error('PTY fixture timed out');}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
win('managed ConPTY supports Unicode input and resize, then releases native workers',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pty-'));const script=path.join(dir,'io.cjs');
 // Node caches columns/rows until SIGWINCH; ask the native TTY handle for the
 // current console dimensions so this checks the ConPTY itself.
 fs.writeFileSync(script,'process.stdin.setEncoding("utf8");process.stdin.on("data",x=>{const size=[];process.stdout._handle.getWindowSize(size);console.log("PTY_RESULT:"+JSON.stringify({input:x,cols:size[0],rows:size[1]}));process.exit(0);});console.log("PTY_READY");');
 const p=spawn(process.execPath,[script],{cwd:dir,env:process.env,cols:80,rows:24}),w=watch(p);t.after(async()=>{p.kill();await w.closed;fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
 assert.equal(await p.started,true);await until(()=>w.output().includes('PTY_READY'));p.resize(110,37);p.write('中文 & literal\r');
 const result=await w.closed;assert.equal(result.exitCode,0,w.output());
 const match=w.output().match(/PTY_RESULT:(\{[^\r\n]*\})/);assert.ok(match,w.output());const data=JSON.parse(match[1]);assert.match(data.input,/中文 & literal/);assert.equal(data.cols,110);assert.equal(data.rows,37);
});
win('managed ConPTY cancel removes its synthetic descendant and retains unrelated process',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pty-tree-'));const pidFile=path.join(dir,'ids.json'),script=path.join(dir,'tree.cjs');
 fs.writeFileSync(script,'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[2],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);');
 const unrelated=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const p=spawn(process.execPath,[script,pidFile],{cwd:dir,env:process.env,cols:80,rows:24}),w=watch(p);t.after(async()=>{p.kill();unrelated.kill();await w.closed;fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
 assert.equal(await p.started,true);await until(()=>fs.existsSync(pidFile));const ids=JSON.parse(fs.readFileSync(pidFile));p.kill();await w.closed;await until(()=>ids.every(id=>!alive(id)));assert.equal(alive(unrelated.pid),true);
});
win('managed ConPTY refuses invalid executable without reporting a successful start',{timeout:20000},async()=>{
 const p=spawn('C:\\hub-no-such-pty-command.exe',[],{cwd:process.cwd(),env:process.env,cols:80,rows:24}),w=watch(p);assert.equal(await p.started,false);assert.equal((await w.closed).exitCode,125);
});
win('managed ConPTY owner crash ends the console process tree',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-pty-crash-')),idsFile=path.join(dir,'ids.json'),ownerFile=path.join(dir,'owner.cjs'),treeFile=path.join(dir,'tree.cjs');
 fs.writeFileSync(treeFile,'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[2],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);');
 fs.writeFileSync(ownerFile,`const p=require(${JSON.stringify(require.resolve('../lib/managed-pty'))}).spawn(process.execPath,${JSON.stringify([treeFile,idsFile])},{cwd:${JSON.stringify(dir)},env:process.env,cols:80,rows:24});p.onData(()=>{});p.onExit(()=>process.exit(0));`);
 const owner=require('node:child_process').spawn(process.execPath,[ownerFile],{stdio:'ignore'}),closed=new Promise(r=>owner.once('exit',r));
 t.after(async()=>{owner.kill();await closed;fs.rmSync(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
 await until(()=>fs.existsSync(idsFile));const ids=JSON.parse(fs.readFileSync(idsFile));assert.ok(ids.every(alive));owner.kill();await closed;await until(()=>ids.every(id=>!alive(id)));
});
