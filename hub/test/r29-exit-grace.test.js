'use strict';
// Protocol fixtures only: fake children, no provider executable or account.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const immediate=()=>new Promise(r=>setImmediate(r)),sid='12345678-1234-4234-8234-123456789abc';
const win=process.platform==='win32'?test:test.skip;
function options(ai){return {project:'p',task:'t',runId:'r',cwd:'C:\\synthetic',effort:'low',resume:false,
  ...(ai==='grok'?{model:'grok-selected',sessionId:null,validatedMcpServers:[]}:{model:'sonnet',sessionId:sid,validatedMcpConfig:{mcpServers:{}}})};}
function fixture(t,ai,extra={}){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-backend'});
  let wire='',output='',ended=false,kills=0;c.kill=()=>{kills++;return true;};c.stdin.on('data',d=>wire+=d);
  const p=require('../lib/'+ai+'-native-bridge').start({...options(ai),graceMs:20,...extra,openEndpoint:()=>{setImmediate(()=>c.emit('spawn'));return c;}});
  p.stdout.on('data',d=>output+=d);p.stderr.resume();const closed=once(p,'close');
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse),push=v=>c.stdout.write(Buffer.from(JSON.stringify(v)+'\n'));
  const response=(req,result)=>push({jsonrpc:'2.0',id:req.id,result});
  function finish(code=0,signal=null,receipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}){
    if(ended)return;ended=true;c.cleanupReceipt=receipt;c.stdout.end();c.stderr.end();c.emit('close',code,signal);
  }
  t.after(async()=>{p.kill();finish(1,null,null);await closed;});
  async function init(){
    p.stdin.end('synthetic prompt');await immediate();await immediate();const first=rows()[0];
    if(ai==='grok'){
      assert.equal(first.method,'initialize');response(first,{protocolVersion:1,agentCapabilities:{loadSession:true}});await immediate();
      response(rows().at(-1),{sessionId:sid,models:{currentModelId:options(ai).model,availableModels:[]}});
    }else{
      assert.equal(first.type,'control_request');push({type:'control_response',response:{subtype:'success',request_id:first.request_id,response:{}}});
      push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5',tools:['Read']});
    }
    await immediate();assert.equal(await p.ready,true);
  }
  function result(complete=true){
    if(ai==='grok'){
      push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture reply'}}}});
      response(rows().findLast(r=>r.method==='session/prompt'),{stopReason:complete?'end_turn':'max_tokens'});
    }else push({type:'result',subtype:complete?'success':'error_max_turns',is_error:!complete,session_id:sid,result:'fixture reply',permission_denials:[]});
  }
  return {p,c,closed,init,result,finish,kills:()=>kills,events:()=>output.trim().split('\n').filter(Boolean).map(JSON.parse)};
}
for(const ai of ['grok','claude']){
  const prefix=ai.toUpperCase()+'_NATIVE_';
  for(const mode of ['code','invalid-receipt','partial','signal','late-failure'])test('R29 '+ai+' completed slow exit: '+mode,async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,ai);await f.init();f.result();
    if(mode==='partial')f.c.stdout.write(Buffer.from('{"partial":'));
    t.mock.timers.tick(19);assert.equal(f.kills(),0);t.mock.timers.tick(1);assert.equal(f.kills(),1);
    if(mode==='late-failure'){f.c.stdout.write(Buffer.from('malformed frame\n'));assert.equal(f.kills(),2);}
    if(mode==='invalid-receipt')f.finish(1,null,{rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0});
    else if(mode==='signal')f.finish(null,'SIGTERM');else f.finish(1);
    const closed=await f.closed,completion=await f.p.completion,success=mode!=='invalid-receipt';
    assert.equal(completion.responseComplete,success);assert.equal(completion.errorCode,success?null:prefix+'CLEANUP_UNVERIFIED');
    assert.equal(completion.cleanupVerified,success);assert.deepEqual(closed,[success?0:1,null]);
    assert.equal(f.p.exitWait.forced,true);assert.ok(Number.isFinite(f.p.exitWait.ms)&&f.p.exitWait.ms>=0);
    assert.equal(f.events().filter(r=>r.type==='turn.completed').length,success?1:0);
    assert.ok(f.events().some(r=>r.text==='fixture reply'||r.item?.text==='fixture reply'));
    assert.equal(f.kills(),['late-failure','partial'].includes(mode)?2:1);
  });
  test('R29 '+ai+' incomplete result times out without forced success',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,ai);await f.init();f.result(false);t.mock.timers.tick(20);
    assert.equal(f.kills(),1);f.finish(1);await f.closed;
    assert.equal((await f.p.completion).errorCode,prefix+'EXIT_TIMEOUT');assert.equal((await f.p.completion).responseComplete,false);
    assert.equal(f.p.exitWait.forced,false);assert.equal(f.events().some(r=>r.type==='turn.completed'),false);
  });
  test('R29 '+ai+' normal exit records wait without killing',async t=>{
    const f=fixture(t,ai);await f.init();f.result();f.finish();assert.deepEqual(await f.closed,[0,null]);
    assert.equal((await f.p.completion).responseComplete,true);assert.equal(f.p.exitWait.forced,false);
    assert.ok(Number.isFinite(f.p.exitWait.ms)&&f.p.exitWait.ms>=0);assert.equal(f.kills(),0);
  });
  for(const forced of [false,true])test('R29 '+ai+' user stop '+(forced?'after':'before')+' forced kill remains cancelled',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,ai);await f.init();f.result();if(forced)t.mock.timers.tick(20);
    f.p.kill();assert.equal(f.kills(),forced?2:1);f.finish(1);await f.closed;
    const completion=await f.p.completion;assert.equal(completion.errorCode,prefix+'CANCELLED');assert.equal(completion.cancelled,true);
    assert.equal(completion.responseComplete,false);assert.equal(f.events().some(r=>r.type==='turn.completed'),false);assert.equal(f.p.exitWait.forced,forced);
  });
  test('R29 '+ai+' no result leaves exitWait absent',async t=>{
    const f=fixture(t,ai);await f.init();f.finish();await f.closed;
    assert.equal(f.p.exitWait,undefined);assert.equal((await f.p.completion).errorCode,prefix+'INCOMPLETE');
  });
  test('R29 '+ai+' default and explicit grace cap are 15000 ms',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    for(const graceMs of [undefined,15000]){
      const f=fixture(t,ai,{graceMs});await f.init();f.result();t.mock.timers.tick(14999);assert.equal(f.kills(),0);
      t.mock.timers.tick(1);assert.equal(f.kills(),1);f.finish(1);await f.closed;assert.equal((await f.p.completion).responseComplete,true);
    }
    assert.throws(()=>require('../lib/'+ai+'-native-bridge').start({...options(ai),graceMs:15001,openEndpoint:()=>assert.fail('invalid options must not open endpoint')}),{code:prefix+'OPTIONS'});
  });
}

function chatFixture(t,ai,exitWait){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r29-chat-')),children=[];
  t.mock.method(registry,'assertCapability',actor=>registry.cliActor(actor));
  const handler={prepare(){return {scope:{actor:ai,project:'p',task:'t',rootFingerprint:'a'.repeat(64),runtimeProfileId:'fixture-runtime',accountProfileId:'fixture-account'},
    modelFlag:ai==='claude'?'sonnet':'grok-4.6',effortFlag:'low',...(ai==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[]})};},openEndpoint:()=>assert.fail('bridge is mocked')};
  t.mock.method(require('../lib/'+ai+'-native-bridge'),'start',()=>{
    const c=new EventEmitter();children.push(c);Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),normalizedOutput:true,ready:Promise.resolve(true),
      cleanupReceipt:{cleanupVerified:true,rootExited:true,ownedTreeEmpty:true,exitCode:exitWait?.forced?1:0},kill:()=>{},...(exitWait?{exitWait}:{})});
    setImmediate(()=>{c.emit('spawn');c.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fixture reply'}})+'\n');
      c.stdout.write('{"type":"turn.completed"}\n');c.stdout.end();c.stderr.end();c.emit('close',0,null);});return c;
  });
  const runner=new chat.ChatRunner({dirOf:()=>root,nativeProviders:{[ai]:handler}});
  t.after(()=>{runner.stopAll();for(const c of children)for(const s of [c.stdin,c.stdout,c.stderr])s.destroy();
    assert.equal(path.dirname(fs.realpathSync(root)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());fs.rmSync(root,{recursive:true,force:true});});
  async function send(){runner.send({project:'p',task:'t',pdir:root,dir:root,ai,model:'fixture-model',effort:'low',text:'synthetic prompt',basePrompt:'fixture rules',nativeRootPin:{root,rootFingerprint:'a'.repeat(64)}});await runner.busy('p','t').finishedP;return chat.read(root,'t').at(-1);}
  return {runner,send};
}
for(const ai of ['grok','claude'])for(const mode of ['forced','slow','fast','absent','throw'])win('R29 '+ai+' chat exit wait observer: '+mode,async t=>{
  const exitWait=mode==='absent'?undefined:{ms:mode==='slow'?2000:1999,forced:mode==='forced'||mode==='throw'},f=chatFixture(t,ai,exitWait),waits=[],ends=[];
  f.runner.nativeTurnEnded=(project,task,detail)=>ends.push({project,task,...detail});
  f.runner.nativeExitWait=(project,task,detail)=>{waits.push({project,task,...detail});if(mode==='throw')throw Error('observer');};
  const row=await f.send();assert.equal(row.text,'fixture reply');assert.equal(row.error,'');assert.equal(f.runner.busy('p','t'),null);
  assert.deepEqual(ends,[{project:'p',task:'t',clean:true}]);
  assert.deepEqual(waits,['forced','slow','throw'].includes(mode)?[{project:'p',task:'t',ai,...exitWait}]:[]);
});
test('R29 server records native-exit-wait with scoped identity and wait details',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),assignment=source.match(/^chats\.nativeExitWait=.*$/m);
  assert.ok(assignment);const records=[],chats={};vm.runInNewContext(assignment[0],{chats,record:(...args)=>records.push(args)});
  chats.nativeExitWait('p','t',{ai:'grok',ms:15000,forced:true});
  assert.equal(JSON.stringify(records),JSON.stringify([['native-exit-wait',{project:'p',task:'t',ai:'grok'},{ms:15000,forced:true}]]));
});
