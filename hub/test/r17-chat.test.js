'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const chat=require('../lib/chat'),registry=require('../lib/provider-registry');
const messages=require('../lib/native-provider-messages');
const win=process.platform==='win32'?test:test.skip;
const AUTH='GROK_NATIVE_AUTH_UNAVAILABLE';
const immediate=()=>new Promise(r=>setImmediate(r));
function fixture(t,{ai='grok',errors=[AUTH],retry=async()=>true,cleanup=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r17-chat-')),events=[],runs=[],starts=[],children=[];
  const options={project:'p',task:'t',pdir:root,dir:root,ai,model:'fixture-model',effort:'low',text:'same message',basePrompt:'fixture rules',
    nativeRootPin:{root,rootFingerprint:'a'.repeat(64)}};
  t.mock.method(registry,'assertCapability',actor=>registry.cliActor(actor));
  let prepares=0,calls=0;
  const handler={prepare(o){prepares++;return {scope:{actor:ai,project:'p',task:'t',rootFingerprint:'a'.repeat(64),runtimeProfileId:'fixture-runtime',accountProfileId:'fixture-account'},
    modelFlag:ai==='claude'?'sonnet':'grok-4.6',effortFlag:'low',...(ai==='claude'?{validatedMcpConfig:{mcpServers:{}}}:{validatedMcpServers:[]})};},openEndpoint:()=>assert.fail('bridge is mocked')};
  const bridge=ai==='codex'?require('../lib/codex-bridge'):ai==='claude'?require('../lib/claude-native-bridge'):require('../lib/grok-native-bridge');
  t.mock.method(bridge,'start',o=>{
    starts.push(o);const index=starts.length-1,c=new EventEmitter();children.push(c);
    c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.normalizedOutput=true;c.ready=Promise.resolve(true);
    c.cleanupReceipt=cleanup?{cleanupVerified:true,rootExited:true,ownedTreeEmpty:true,exitCode:0}:null;
    c.kill=()=>{};
    setImmediate(()=>{c.emit('spawn');if(errors[index])c.stdout.write(JSON.stringify({type:'turn.failed',error:{message:errors[index]}})+'\n');
      else {c.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'retry answer'}})+'\n');c.stdout.write('{"type":"turn.completed"}\n');}
      c.emit('close',0);});
    return c;
  });
  const runner=new chat.ChatRunner({dirOf:()=>root,...(ai==='codex'?{}:{nativeProviders:{[ai]:handler}}),nativeAuthRetry:async o=>{calls++;return retry(o,runner);}});
  runner.watch('p','t',e=>events.push(e));
  const run=runner.run;t.mock.method(runner,'run',function(o,...args){runs.push(o);return run.call(this,o,...args);});
  t.after(()=>{runner.stopAll();for(const c of children)for(const s of [c.stdin,c.stdout,c.stderr])s.destroy();const real=fs.realpathSync(root);
    assert.equal(path.dirname(real).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(real).startsWith('hub-r17-chat-'));fs.rmSync(real,{recursive:true,force:true});});
  function send(){runner.send(options);return runner.busy('p','t').finishedP;}
  return {runner,options,events,runs,starts,send,rows:()=>chat.read(root,'t'),counts:()=>({prepares,calls})};
}
win('R17 auth failure stays busy, emits notice, re-admits once, returns success without duplicate user or assistant error',async t=>{
  const f=fixture(t,{retry:async(o,runner)=>{assert.ok(runner.busy('p','t'));await immediate();assert.ok(runner.busy('p','t'));return true;}});
  await f.send();assert.equal(f.starts.length,2);assert.equal(f.runs[1].authRetried,true);assert.equal(f.runs[1].text,f.runs[0].text);assert.equal(f.runs[1].userRow,f.runs[0].userRow);
  const rows=f.rows();assert.equal(rows.filter(r=>r.role==='user').length,1);assert.equal(rows.filter(r=>r.role==='assistant').length,1);
  assert.equal(rows.at(-1).error,'');assert.equal(rows.at(-1).text,'retry answer');assert.deepEqual(f.counts(),{prepares:2,calls:1});
  const notices=rows.filter(r=>r.code==='GROK_AUTH_REFRESHING');assert.equal(notices.length,1);assert.equal(notices[0].notice,true);
  assert.equal(notices[0].text,'Grok 登入已過期，正在自動更新登入並重送這則訊息…');assert.equal(f.runner.busy('p','t'),null);
  assert.equal(f.events.filter(e=>e.type==='idle').length,1);
});
for(const mode of ['false','throw','stop','stop-version'])win('R17 retry '+mode+' preserves original auth error with no resend',async t=>{
  const f=fixture(t,{retry:async(o,runner)=>{if(mode==='throw')throw Error('PRIVATE');if(mode==='stop'){runner.stop('p','t');return true;}if(mode==='stop-version'){runner.stops.set(runner.key('p','t'),1);return true;}return false;}});
  await f.send();assert.equal(f.starts.length,1);assert.equal(f.rows().at(-1).code,AUTH);assert.equal(f.rows().at(-1).error,messages.messageFor(AUTH));
  assert.match(f.rows().at(-1).error,/grok login/);assert.equal(f.rows().filter(r=>r.role==='user').length,1);assert.equal(f.runner.busy('p','t'),null);
});
win('R17 a second AUTH failure ends the turn without a third attempt',async t=>{
  const f=fixture(t,{errors:[AUTH,AUTH]});await f.send();assert.equal(f.starts.length,2);assert.equal(f.counts().calls,1);
  assert.equal(f.rows().filter(r=>r.notice).length,1);assert.equal(f.rows().at(-1).error,messages.messageFor(AUTH));
});
for(const ai of ['claude','codex'])win('R17 '+ai+' never retries the Grok auth code',async t=>{
  const f=fixture(t,{ai});await f.send();assert.equal(f.starts.length,1);assert.equal(f.counts().calls,0);assert.equal(f.rows().some(r=>r.notice),false);
});
win('R17 other Grok errors and unverified cleanup cannot refresh or resend',async t=>{
  for(const settings of [{errors:['GROK_NATIVE_REMOTE_ERROR']},{cleanup:false}])await t.test(JSON.stringify(settings),async sub=>{
    const f=fixture(sub,settings);await f.send();assert.equal(f.starts.length,1);assert.equal(f.counts().calls,0);
    if(settings.cleanup===false)assert.ok(f.runner.busy('p','t'));
  });
});
test('R17 refresh notice remains visible with details collapsed and uses the exact auth message',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const line=source.split('\n').find(l=>l.startsWith('const isToolRow ='));
  const visible=vm.runInNewContext(line+'\n(r=>!isToolRow(r))');
  assert.equal(visible({role:'event',ai:'grok',notice:true,code:'GROK_AUTH_REFRESHING',text:'notice'}),true);
  assert.equal(visible({role:'event',tool:true,text:'detail'}),false);
  assert.equal(messages.messageFor(AUTH),'Grok 回報登入無效或已過期，這一回合沒有完成。請按「更新 Grok 登入」（或在一般終端機執行 grok login），完成後再送一次。（代碼：GROK_NATIVE_AUTH_UNAVAILABLE）');
});
