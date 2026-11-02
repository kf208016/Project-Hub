'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {createRestoreInheritance,createGrokHydrator}=require('../lib/grok-hydrate');

test('restore inheritance uses the system executable, exact arguments and bounded timeout',async()=>{
  const file='C:\\Synthetic\\provider\\auth.json';
  for(const [result,expected]of [[{status:0,timedOut:false},true],[{status:1},false],[{status:0,timedOut:true},false]]){
    const calls=[];
    const restore=createRestoreInheritance({systemRoot:'C:\\Synthetic\\Windows',run:async(...args)=>{calls.push(args);return result;}});
    assert.equal(await restore(file),expected);
    assert.deepEqual(calls,[['C:\\Synthetic\\Windows\\System32\\icacls.exe',[file,'/inheritance:e','/Q'],{timeoutMs:10000}]]);
  }
});

test('restore inheritance defaults to SystemRoot and falls back when it is absent',async t=>{
  const previous=process.env.SystemRoot;
  t.after(()=>{if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;});
  for(const root of ['C:\\Synthetic\\Environment',undefined]){
    if(root===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=root;
    const calls=[],file='C:\\Synthetic\\provider\\auth.json.lock';
    const restore=createRestoreInheritance({run:async(...args)=>{calls.push(args);return {status:0,timedOut:false};}});
    assert.equal(await restore(file),true);
    assert.deepEqual(calls,[[path.win32.join(root||'C:\\Windows','System32','icacls.exe'),[file,'/inheritance:e','/Q'],{timeoutMs:10000}]]);
  }
});

test('hydrator builds its default restorer from systemRoot and injected run',async t=>{
  const runtimeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'r27-hydrate-'));
  t.after(()=>fs.rmSync(runtimeDirectory,{recursive:true,force:true}));
  const providerHome=path.join(runtimeDirectory,'grok'),authPath=path.join(providerHome,'auth.json'),lockPath=authPath+'.lock';
  const calls=[],child=Object.assign(new EventEmitter(),{pid:12345});
  const hydrator=createGrokHydrator({systemRoot:'C:\\Synthetic\\Windows',run:async(...args)=>{calls.push(args);return {status:0,timedOut:false};},
    resolveGrok:async()=> 'C:\\Synthetic\\grok.exe',spawn:()=>child,nodeFile:process.execPath,hubLibDirectory:'C:\\Synthetic\\lib',env:{},
    kill:()=>{},setTimeout:()=>1,clearTimeout:()=>{}});
  t.after(()=>hydrator.dispose());
  const pending=hydrator.hydrate({runtimeDirectory,providerHome,authPath,lockPath});
  await Promise.resolve();assert.deepEqual(calls,[]);
  fs.writeFileSync(authPath,'synthetic');child.emit('exit',0);
  const result=await pending;
  assert.equal(result.outcome,'hydrated');assert.equal(result.acl,'inherited');
  assert.deepEqual(calls,[authPath,lockPath].map(file=>['C:\\Synthetic\\Windows\\System32\\icacls.exe',[file,'/inheritance:e','/Q'],{timeoutMs:10000}]));
});
