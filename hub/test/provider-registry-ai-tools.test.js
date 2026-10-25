'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AiTools,claudeInitialize}=require('../lib/ai-tools');
test('Windows status shows four CLI identities while deferred installed entries never execute',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-deferred-ai-tools-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],tools=new AiTools({root,home:path.join(root,'home'),platform:'win32',nativeUpdater:{useActive(){}},find:ai=>path.join(root,ai+'.exe'),run:async(file,args)=>{calls.push({file,args});return 'codex-cli 0.154.0';},latest:async()=>{throw Error('network must not run');},refreshClaude:async()=>{throw Error('Claude must not start');},refreshCodex:async()=>[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'}]});
  const result=await tools.status();assert.deepEqual(Object.keys(result.tools),['codex','claude','agy','grok']);assert.equal(calls.length,1);assert.equal(path.basename(calls[0].file),'codex.exe');
  for(const actor of ['claude','agy','grok']){
    assert.equal(result.tools[actor].installed,true);assert.equal(result.tools[actor].ready,false);assert.equal(result.tools[actor].readiness.state,'blocked');assert.equal(result.tools[actor].version,'');assert.equal(result.tools[actor].modelRefreshAvailable,['claude','grok'].includes(actor));
    for(const action of [()=>tools.version(actor,'must-not-run.exe'),()=>tools.checkUpdate(actor),()=>tools.refresh(actor),()=>tools.fetchModels(actor,'must-not-run.exe'),()=>tools.update(actor,{confirm:true}),()=>tools.check(actor)]){
      await assert.rejects(Promise.resolve().then(action),error=>error.status===409&&error.notStarted===true);
    }
  }
  assert.equal(calls.length,1);assert.equal(tools.isOperating(),false);assert.equal(fs.existsSync(tools.file),false);
});
test('Direct native Claude initialize rejects before process creation; aliases cannot bypass AiTools gates',async t=>{
  await assert.rejects(claudeInitialize('must-not-run.exe',1000,{platform:'win32'}),error=>error.code==='WINDOWS_PROVIDER_ISOLATION_UNVERIFIED');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-deferred-ai-alias-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let lookup=0,run=0;const tools=new AiTools({root,platform:'win32',home:path.join(root,'home'),nativeUpdater:{useActive(){}},find:()=>{lookup++;return 'must-not-run.exe';},run:async()=>{run++;return '0.0.0';}});
  for(const actor of ['claude-code','claude-chat','chatgpt','unknown'])for(const action of [()=>tools.checkUpdate(actor),()=>tools.refresh(actor),()=>tools.update(actor),()=>tools.fetchModels(actor,'must-not-run.exe'),()=>tools.version(actor,'must-not-run.exe')])await assert.rejects(Promise.resolve().then(action));
  assert.equal(lookup,0);assert.equal(run,0);
});
