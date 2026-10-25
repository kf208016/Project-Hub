'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const commands=require('../lib/codex-commands'),broker=require('../lib/scoped-file');
const win=process.platform==='win32'?test:test.skip;
async function setup(t,mode='normal'){
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'hub-command-protocol-')),root=path.join(parent,'task'),bin=path.join(parent,'bin'),entry=path.join(bin,'node_modules/@openai/codex/bin/codex.js');fs.mkdirSync(root);fs.mkdirSync(path.dirname(entry),{recursive:true});const shim=path.join(bin,'codex.cmd');fs.writeFileSync(shim,'@echo off\r\nexit /b 99\r\n');t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 fs.writeFileSync(entry,`const mode=${JSON.stringify(mode)},out=x=>console.log(JSON.stringify(x));require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')out({id:m.id,result:{userAgent:mode==='version'?'Codex Desktop/0.153.0':mode==='new'?'Codex Desktop/0.164.0':'Codex Desktop/0.154.0',platformOs:'windows',platformFamily:'windows'}});if(m.method==='command/exec'){if(mode==='approval')out({id:90,method:'item/commandExecution/requestApproval',params:{command:'unexpected'}});else if(mode==='incomplete')process.exit(0);else if(mode==='pending'){}else if(mode==='broken')out({id:m.id,result:{exitCode:0,stdout:[],stderr:''}});else out({id:m.id,result:{exitCode:0,stdout:JSON.stringify({params:m.params,args:process.argv.slice(2),env:{token:process.env.HUB_MCP_TOKEN,local:process.env.HUB_LOCAL_TOKEN,openai:process.env.OPENAI_API_KEY}}),stderr:''}});}}).on('close',()=>process.exit(0));`);
 return{root,shim,pin:(await broker.identity(root)).rootFingerprint};
}
win('Codex command protocol uses exact argv/cwd, native root pin and fixed write/network policy with no model turn',{timeout:20000},async t=>{
 const {root,shim,pin}=await setup(t),argv=[process.execPath,'a"b','臺灣 & | $(literal)',''];const owned=commands.run(shim,{expectedVersion:'0.154.0',argv,cwd:root,root,rootFingerprint:pin,env:{...process.env,HUB_MCP_TOKEN:'synthetic',HUB_LOCAL_TOKEN:'synthetic',OPENAI_API_KEY:'synthetic'}});const result=await owned.promise,row=JSON.parse(result.stdout);assert.deepEqual(row.params.command,argv);assert.equal(row.params.cwd,root);assert.equal(row.params.sandboxPolicy.type,'workspaceWrite');assert.deepEqual(row.params.sandboxPolicy.writableRoots,[root]);assert.equal(row.params.sandboxPolicy.networkAccess,false);assert.equal(row.params.sandboxPolicy.excludeTmpdirEnvVar,true);assert.equal(row.params.outputBytesCap,undefined);assert.equal(row.params.streamStdoutStderr,undefined);assert.deepEqual(row.env,{});assert.ok(row.args.includes('windows.sandbox="elevated"'));assert.equal(result.modelCalled,false);assert.equal(result.readBoundary,'broader-than-task');
});
win('Codex commands refuse unexpected approval requests, malformed results, incomplete execution and unknown versions',{timeout:30000},async t=>{
 for(const [mode,code]of[['approval','UNEXPECTED_APPROVAL_REQUEST'],['broken','INVALID_RESULT'],['incomplete','INCOMPLETE_COMMAND'],['version','UNSUPPORTED_CODEX_VERSION']]){const {root,shim,pin}=await setup(t,mode);await assert.rejects(commands.run(shim,{expectedVersion:'0.154.0',argv:[process.execPath,'-e','fixture'],cwd:root,root,rootFingerprint:pin}).promise,{code});}
});
win('Cancel closes the command connection and only resolves after the pinned supervisor finishes',{timeout:20000},async t=>{
 const {root,shim,pin}=await setup(t,'pending'),owned=commands.run(shim,{expectedVersion:'0.154.0',argv:[process.execPath,'fixture'],cwd:root,root,rootFingerprint:pin});setTimeout(()=>owned.cancel(),200);const result=await owned.promise;assert.equal(result.canceled,true);const renamed=root+'-released';fs.renameSync(root,renamed);assert.ok(fs.existsSync(renamed));
});

win('0.164.0 command handshake must match the expected launched version',async t=>{
 const {root,shim,pin}=await setup(t,'new'),options={argv:[process.execPath,'fixture'],cwd:root,root,rootFingerprint:pin};
 const result=await commands.run(shim,{...options,expectedVersion:'0.164.0'}).promise;assert.equal(result.codexVersion,'0.164.0');assert.equal(JSON.parse(result.stdout).params.outputBytesCap,undefined);
 await assert.rejects(commands.run(shim,{...options,expectedVersion:'0.154.0'}).promise,{code:'UNSUPPORTED_CODEX_VERSION'});
 for(const version of [undefined,'0.153.0','0.165.0'])assert.throws(()=>commands.run(shim,{...options,expectedVersion:version}),{code:'UNSUPPORTED_CODEX_VERSION'});
});

win('synthetic command transport checks both version handshakes and rejects mismatches without native helpers',async t=>{
 const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'command-wire-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const [expected,actual,accepted]of [['0.154.0','0.154.0',true],['0.164.0','0.164.0',true],['0.154.0','0.164.0',false],['0.164.0','0.154.0',false],['0.164.0','0.153.0',false]]){
  let sent=0;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>queueMicrotask(()=>child.emit('close'));
  const out=m=>queueMicrotask(()=>child.stdout.write(JSON.stringify(m)+'\n'));
  child.stdin=new Writable({write(data,_encoding,done){const m=JSON.parse(String(data));if(m.method==='initialize')out({id:1,result:{platformOs:'windows',platformFamily:'windows',userAgent:'Fixture/'+actual}});if(m.method==='command/exec'){sent++;assert.equal(m.params.outputBytesCap,undefined);out({id:2,result:{exitCode:0,stdout:'synthetic',stderr:''}});}done();},final(done){done();child.kill();}});
  const owned=commands.run(process.execPath,{expectedVersion:expected,argv:[process.execPath],root,cwd:root,rootFingerprint:'a'.repeat(64),spawn:()=>{queueMicrotask(()=>child.emit('spawn'));return child;}});
  if(accepted){const result=await owned.promise;assert.equal(result.codexVersion,actual);assert.equal(sent,1);}else{await assert.rejects(owned.promise,{code:'UNSUPPORTED_CODEX_VERSION'});assert.equal(sent,0);}
 }
});
