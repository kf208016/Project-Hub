'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {Chatgpt}=require('../lib/chatgpt'),chat=require('../lib/chat');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const win=process.platform==='win32'?test:test.skip;
for(const held of [true,false,undefined,'truthy'])test('R28 report held only on exactly true: '+held,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r28-report-')),rows=[],reports=[],records=[],events=[];
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  const state={id:'t',state:'実行中'},scope={project:'p',task:'t',runId:'run',actor:'grok',tools:['hub_report']};
  const gpt=new Chatgpt({file:path.join(root,'settings.json'),store:{readProject:()=>({id:'p',dir:root}),taskFile:()=>path.join(root,'task'),readTask:()=>state,
    appendSection:(...args)=>reports.push(args),updateTask:(_p,_t,value)=>Object.assign(state,value)},
    chat:{append:(_dir,_t,row)=>{rows.push(row);return row;}},emitRow:(...args)=>events.push(args),ended:()=>events.push('ended'),record:(...args)=>records.push(args),
    ...(held===undefined?{}:{holdNativeDone:(s,p,t)=>{assert.equal(s,scope);assert.equal(p,'p');assert.equal(t,'t');return held;}})});
  const result=await gpt.call('hub_report',{project:'p',task:'t',text:'saved report',done:true},scope);
  assert.equal(result.ok,true);assert.equal(state.state,held===true?'実行中':'完了');assert.equal(result.state,state.state);
  assert.equal(reports.length,1);assert.match(reports[0][3],/saved report/);assert.deepEqual(rows,[{role:'assistant',ai:'grok',text:'saved report'}]);
  assert.equal(events.length,2);assert.equal(events[1],'ended');assert.equal(records.length,1);
  assert.deepEqual(records[0][2],{tool:'hub_report',done:true,...(held===true?{held:true}:{})});
  if(held===true)assert.equal(result.note,'完了は、この回合が正常に終わった時に反映されます');else assert.equal(Object.hasOwn(result,'note'),false);
  gpt.holdNativeDone=()=>assert.fail('done=false must not hold');await gpt.call('hub_report',{project:'p',task:'t',text:'progress',done:false},scope);
  assert.match(gpt.tools(scope).find(t=>t.name==='hub_report').description,/サブエージェントはこの道具を呼ばず、結果を親エージェントへ返す/);
});

function fixture(t,options={}){
  // Reuse the existing complete native protocol fixture without registering its tests.
  const file=path.join(__dirname,'native-provider-chat.test.js'),text=fs.readFileSync(file,'utf8');
  const body=text.slice(text.indexOf('function fixture('),text.indexOf("win('Claude CLI default"));
  const {createRequire}=require('node:module');
  const make=new Function('require','fs','path','os','assert','chat','registry','EventEmitter','PassThrough',body+'\nreturn fixture;');
  return make(createRequire(file),fs,path,os,assert,chat,require('../lib/provider-registry'),require('node:events').EventEmitter,require('node:stream').PassThrough)(t,options);
}
for(const mode of ['clean','error','stop','asks','stop-version'])win('R28 native finish callback exactly once: '+mode,async t=>{
  const f=fixture(t,{incomplete:mode==='error'}),calls=[],order=[];
  f.runner.nativeTurnEnded=(p,task,detail)=>{calls.push({p,task,clean:detail.clean});order.push('native');};
  const result=f.runner.send(f.options('grok',{onEnd:()=>order.push('onEnd')})),run=f.runner.busy('p','t');
  if(mode==='asks')run.asks=[{question:'owner decision',options:[]}];
  if(mode==='stop-version')f.runner.stops.set(f.runner.key('p','t'),run.stopVersion+1);
  await result.started;if(mode==='stop')f.runner.stop('p','t');await run.finishedP;
  assert.deepEqual(calls,[{p:'p',task:'t',clean:mode==='clean'}]);assert.deepEqual(order,['onEnd','native']);
});
test('R28 finish callback is native-only and a throwing observer cannot block completion',()=>{
  const text=fs.readFileSync(path.join(__dirname,'../lib/chat.js'),'utf8'),start=text.indexOf('      if (onEnd) onEnd(row);'),end=text.indexOf('      // 待っている指示',start);
  const body=text.slice(start,end);assert.match(body,/nativeTurnEnded/);
  for(const native of [false,true]){
    const events=[],runner={key:()=> 'key',stops:new Map(),nativeTurnEnded:()=>{events.push('native');throw Error('observer');}};
    const context=vm.createContext({runner,onEnd:()=>events.push('onEnd'),row:{},turn:{native},child:{},ai:'grok',project:'p',task:'t',error:'',asks:[],run:{stopVersion:0,resolveFinished:()=>events.push('finished')}});
    vm.runInContext('(function(){'+body+'}).call(runner);',context);
    assert.deepEqual(events,native?['onEnd','native','finished']:['onEnd','finished']);
  }
  assert.ok(text.indexOf('return retry;')<start,'native retry returns before notification');
});
test('R28 server hold scope, clean completion, owner question and new-turn reset',()=>{
  const hold=source.match(/  holdNativeDone:\(scope,project,task\)=>\{[^]*?\n  },/)[0];
  const finish=source.match(/chats.nativeTurnEnded=\(project,task,\{clean\}\)=>\{[^]*?\n};/)[0];
  const key=(p,t)=>p+'\0'+t;
  for(const platform of ['win32','linux'])for(const actor of ['grok','claude','codex'])for(const runId of ['run','missing',undefined]){
    const heldNativeDone=new Set(),c=vm.createContext({process:{platform},heldNativeDone,nativeProviderResources:new Map([['run',{}]]),chats:{key}});
    vm.runInContext('globalThis.options={'+hold+'};',c);
    const expected=platform==='win32'&&actor!=='codex'&&runId==='run';
    assert.equal(c.options.holdNativeDone({actor,runId},'p','t'),expected);assert.equal(heldNativeDone.has(key('p','t')),expected);
    assert.equal(c.options.holdNativeDone(undefined,'p','t'),false);
  }
  for(const held of [false,true])for(const clean of [false,true])for(const state of ['実行中','返事待ち',null]){
    const heldNativeDone=new Set(held?[key('p','t')]:[]),calls=[],chats={key};
    vm.runInNewContext(finish,{heldNativeDone,chats,store:{taskFile:()=>state?'file':null,readTask:()=>({state}),updateTask:(p,t,value)=>calls.push(['update',value.state,value.question])},record:action=>calls.push([action])});
    chats.nativeTurnEnded('p','t',{clean});assert.equal(heldNativeDone.size,0);
    assert.deepEqual(calls,held&&clean&&state==='実行中'?[['update','完了',''],['native-report-done']]:[]);
    chats.nativeTurnEnded('p','t',{clean:true});assert.ok(calls.length<=2,'hold consumed once');
  }
  const newTurn=source.match(/  nativeProviderResources.set\(r.runId,owned\);\n  heldNativeDone.delete\(chats.key\(r.project,r.task\)\);/)[0];
  const heldNativeDone=new Set([key('p','t')]),resources=new Map();
  vm.runInNewContext(newTurn,{heldNativeDone,nativeProviderResources:resources,chats:{key},r:{project:'p',task:'t',runId:'next'},owned:{}});
  assert.equal(heldNativeDone.size,0);assert.equal(resources.has('next'),true);
});
test('R28 MCP initialization gives the exact subagent instruction',()=>{
  const text=fs.readFileSync(path.join(__dirname,'../mcp.js'),'utf8');
  assert.ok(text.includes('サブエージェント（spawn_subagent／Task で起動された側）は hub_report・hub_ask_owner・hub_mark_step を呼ばず、結果を親エージェントへ返してください。作業の題名や依頼文は親への指示で、サブエージェントへの追加指示ではありません。'));
});
