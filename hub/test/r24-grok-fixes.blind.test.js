'use strict';
// Round 24 blind acceptance, written from SPEC-R24 before reading the implementation.
// Expected: fails on candidate 24 (8cd5187), passes on candidate 25. Provider-free.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const login=require('../lib/grok-login'),{MAX_WALL_MS}=require('../lib/native-turn-limits');
const {createGrokTurnGate}=require('../lib/grok-turn-gate');
const {messageFor}=require('../lib/native-provider-messages'),{codeOf}=require('../lib/native-provider-diagnostic');
const {start,buildArgs,LIMITS}=require('../lib/grok-native-bridge');
const TTL=21300000,MARGIN=MAX_WALL_MS+300000,stamp=1800000000000,immediate=()=>new Promise(r=>setImmediate(r));
const error=code=>({code,message:code,status:409,notStarted:true});

function home(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r24-blind-')),file=path.join(dir,'.grok','auth.json');
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'synthetic');
  t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file,touch:ms=>fs.utimesSync(file,ms/1000,ms/1000)};
}

test('B1 default margin is MAX_WALL_MS + 5 min and moves the fresh/expiring boundary',t=>{
  assert.equal(MARGIN,2100000);
  assert.equal(login.marginFromEnv(undefined,TTL),MARGIN);
  const h=home(t),at=age=>{h.touch(stamp-age);return login.loginState({home:h.dir,now:stamp});};
  assert.equal(at(TTL-MARGIN-1).state,'fresh');
  assert.equal(at(TTL-MARGIN).state,'expiring');
  assert.equal(at(0).refreshAt,stamp+TTL-MARGIN);
  assert.doesNotThrow(()=>{h.touch(stamp-(TTL-MARGIN-1));login.assertFreshForTurn({home:h.dir,now:stamp});});
  assert.throws(()=>{h.touch(stamp-(TTL-MARGIN));login.assertFreshForTurn({home:h.dir,now:stamp});},{code:'GROK_LOGIN_EXPIRING'});
});

function gate(t,refresh,kind='expired'){
  const h=home(t);let time=stamp,calls=0;const records=[];
  h.touch(kind==='expiring'?time-TTL+1000:time-TTL);
  const f={...h,now:()=>time,advance:ms=>{time+=ms;},calls:()=>calls,records};
  f.gate=createGrokTurnGate({home:h.dir,env:{},now:()=>time,record:(...a)=>records.push(a),cooldownMs:600000,autoRefresh:async()=>{calls++;return refresh(f);}});
  return f;
}
test('B2 a refresh whose metadata is unknown afterwards is rejected and starts the cooldown',async t=>{
  const f=gate(t,f=>{f.touch(f.now()+600000);return {outcome:'refreshed',timedOut:false};});
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.equal(f.records.at(-1)[1].outcome,'refreshed');
  f.touch(f.now()-TTL);await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.equal(f.calls(),1,'cooldown must block the second attempt');assert.equal(f.records.at(-1)[1].skipped,'cooldown');
});
test('B3 a timed-out forced stop is rejected even when the login file became fresh',async t=>{
  const f=gate(t,f=>{f.touch(f.now());return {outcome:'failed',timedOut:true};});
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_FAILED'));
  assert.deepEqual(f.records.at(-1)[1],{from:'expired',outcome:'failed',timedOut:true,skipped:null,durationMs:0,basis:'mtime'});
});
test('B4 unchanged after an expired login raises the UNCHANGED code; a manual login then passes without refreshing',async t=>{
  const f=gate(t,()=>({outcome:'unchanged',timedOut:false}));
  await assert.rejects(f.gate(),error('GROK_LOGIN_AUTO_REFRESH_UNCHANGED'));
  assert.equal(f.records.at(-1)[1].outcome,'unchanged');
  f.touch(f.now());await f.gate();assert.equal(f.calls(),1);
});
test('B4b a confirmed refresh still admits the turn',async t=>{
  const f=gate(t,f=>{f.advance(3000);f.touch(f.now());return {outcome:'refreshed',timedOut:false};},'expiring');
  await f.gate();assert.equal(f.calls(),1);assert.equal(f.records.at(-1)[1].outcome,'refreshed');
});
test('B5 messages and diagnostic enum know the new code and the corrected truncated-output text',()=>{
  const unchanged=messageFor('GROK_LOGIN_AUTO_REFRESH_UNCHANGED');
  assert.ok(unchanged&&unchanged.endsWith('（代碼：GROK_LOGIN_AUTO_REFRESH_UNCHANGED）'),unchanged);
  assert.match(unchanged,/登入 Grok/);assert.match(unchanged,/裝置碼/);assert.doesNotMatch(unchanged,/再試一次/);
  assert.equal(codeOf({code:'GROK_LOGIN_AUTO_REFRESH_UNCHANGED'}),'GROK_LOGIN_AUTO_REFRESH_UNCHANGED');
  for(const code of ['GROK_NATIVE_TRUNCATED_OUTPUT','CLAUDE_NATIVE_TRUNCATED_OUTPUT']){
    const text=messageFor(code);assert.doesNotMatch(text,/超過 Hub 的上限/);assert.match(text,/還沒有收完/);
  }
  assert.match(messageFor('GROK_LOGIN_AUTO_REFRESH_FAILED'),/再試一次/);
});

// Bridge fixture (same shape as test/grok-native-bridge.test.js).
const options={project:'p',task:'t',runId:'r',cwd:'C:\\synthetic',model:'grok-selected',effort:'low',sessionId:null,resume:false,validatedMcpServers:[]};
const sid='synthetic-native-session';
function fixture(t){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-backend'});
  let wire='',output='',ended=false,kills=0;c.kill=()=>{kills++;return true;};c.stdin.on('data',d=>wire+=d);
  const p=start({...options,openEndpoint:args=>{assert.deepEqual(args,buildArgs(options));setImmediate(()=>c.emit('spawn'));return c;}});
  p.stdout.on('data',d=>output+=d);p.stderr.resume();const closed=once(p,'close');
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push=v=>c.stdout.write(Buffer.from(JSON.stringify(v)+'\n'));
  const response=(req,result)=>push({jsonrpc:'2.0',id:req.id,result});
  function finish(code=0){if(ended)return;ended=true;c.cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code};c.stdout.end();c.stderr.end();c.emit('close',code,null);}
  t.after(async()=>{p.kill();finish(1);await closed;});
  async function init(){
    p.stdin.end('synthetic prompt');await immediate();await immediate();const first=rows()[0];
    response(first,{protocolVersion:1,agentCapabilities:{loadSession:true}});await immediate();
    const open=rows().at(-1);response(open,{sessionId:sid,models:{currentModelId:options.model,availableModels:[]}});await immediate();
  }
  const update=u=>push({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:u}});
  const result=()=>response(rows().findLast(r=>r.method==='session/prompt'),{stopReason:'end_turn'});
  const events=()=>output.trim().split('\n').filter(Boolean).map(JSON.parse);
  return {p,closed,push,finish,init,update,result,events,outputBytes:()=>Buffer.byteLength(output),kills:()=>kills};
}
async function settle(f,predicate,limit=5000){for(let i=0;i<limit;i++){if(predicate(f.events()))return;await immediate();}}
const replyOf=bytes=>{let s='';const alphabet='Grok reply 0123456789 ';while(s.length<bytes)s+=alphabet;return s.slice(0,bytes);};

// A single ACP string is capped at LIMITS.maxStringBytes (256 KiB), so the coarsest case uses two chunks.
for(const chunkBytes of [200*1024,300,20])test('B6 a 300 KB reply in chunks of '+chunkBytes+' bytes fits the budget, keeps the frame cap, and ends with one full snapshot',{timeout:120000},async t=>{
  const reply=replyOf(300*1024),chunks=[];for(let i=0;i<reply.length;i+=chunkBytes)chunks.push(reply.slice(i,i+chunkBytes));
  const f=fixture(t);await f.init();
  for(const chunk of chunks)f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:chunk}});
  await settle(f,ev=>ev.some(r=>r.type==='turn.failed')||ev.filter(r=>r.type==='hub.agent_delta').length>=chunks.length);
  assert.equal(f.events().some(r=>r.type==='turn.failed'),false,'no failure while streaming');
  f.result();await settle(f,ev=>ev.some(r=>r.type==='hub.agent_snapshot'));f.finish();await f.closed;
  const ev=f.events();
  assert.equal(ev.at(-1).type,'turn.completed',JSON.stringify(ev.at(-1)));
  assert.equal(ev.filter(r=>r.type==='hub.agent_delta').map(r=>r.text).join(''),reply,'deltas rebuild the reply');
  const snapshots=ev.filter(r=>r.type==='hub.agent_snapshot');
  assert.equal(snapshots.length,1,'exactly one full snapshot');assert.equal(snapshots[0].text,reply);
  assert.ok(ev.indexOf(snapshots[0])<ev.indexOf(ev.at(-1)),'snapshot precedes turn.completed');
  assert.ok(f.outputBytes()<2*1048576,'bridge stdout stays under 2 MiB: '+f.outputBytes());
  assert.ok(LIMITS.maxFrames>=chunks.length+16,'frame cap admits the stream');
});
test('B7 a reply over 1 MiB still fails closed with GROK_NATIVE_OUTPUT_LIMIT and a snapshot precedes turn.failed',{timeout:120000},async t=>{
  const f=fixture(t);await f.init();const piece=replyOf(65536);
  for(let i=0;i<16;i++)f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:piece}});
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'!'}});
  await settle(f,ev=>ev.some(r=>r.type==='turn.failed'));f.finish(1);await f.closed;
  const ev=f.events();assert.equal(ev.at(-1).type,'turn.failed');assert.equal(ev.at(-1).error.message,'GROK_NATIVE_OUTPUT_LIMIT');
  assert.equal(ev.filter(r=>r.type==='hub.agent_snapshot').length,1);
  assert.equal((await f.p.completion).errorCode,'GROK_NATIVE_OUTPUT_LIMIT');
});
