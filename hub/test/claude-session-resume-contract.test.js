'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events');
const {PassThrough}=require('node:stream');
const {start}=require('../lib/claude-native-bridge');
const sid='12345678-1234-4234-8234-123456789abc';
const options={model:'sonnet',effort:'low',sessionId:sid,resume:false,project:'p',task:'t',runId:'run-1',cwd:'C:\\synthetic',validatedMcpConfig:{mcpServers:{}}};
const immediate=()=>new Promise(r=>setImmediate(r));
function fixture(t,extra={}){
  const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),backendId:'fixture-backend'});
  let killed=0,ended=false,wire='',args;
  c.kill=()=>{killed++;return true;};
  c.stdin.on('data',d=>wire+=d);
  const p=start({...options,...extra,openEndpoint:a=>{args=a;setImmediate(()=>c.emit('spawn'));return c;}});
  let output='';p.stdout.on('data',d=>output+=d);p.stderr.resume();
  const closed=once(p,'close');
  function finish(code=0,receipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:code}){
    if(ended)return;ended=true;c.cleanupReceipt=receipt;c.stdout.end();c.stderr.end();c.emit('close',code,null);
  }
  t.after(async()=>{p.kill();finish(1,null);await closed;});
  const rows=()=>wire.trim().split('\n').filter(Boolean).map(JSON.parse);
  const push=f=>c.stdout.write(Buffer.from(JSON.stringify(f)+'\n'));
  return {p,c,push,finish,closed,rows,events:()=>output.trim().split('\n').filter(Boolean).map(JSON.parse),kills:()=>killed,args:()=>args};
}
async function handshake(f,{sendInit=true}={}){
  f.p.stdin.end('Synthetic task');await immediate();await immediate();
  const r=f.rows().find(x=>x.type==='control_request'&&x.request&&x.request.subtype==='initialize');
  if(!r)return null;
  f.push({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{commands:[],models:[]}}});
  if(sendInit)f.push({type:'system',subtype:'init',session_id:sid,model:'claude-sonnet-5',tools:['Read'],extraMetadata:{preserve:'inert'}});
  await immediate();await immediate();
  return r;
}
function userFrames(f){return f.rows().filter(x=>x.type==='user');}

test('resumed turn calls onSession before any user prompt frame is written to child stdin',async t=>{
  let bound=0,usersAtBind=null;
  const f=fixture(t,{resume:true,onSession:()=>{if(bound===0)usersAtBind=userFrames(f);bound++;}});
  await handshake(f);
  assert.ok(bound>=1,'onSession must run on a resumed turn');
  assert.deepEqual(usersAtBind,[]);
  assert.ok(userFrames(f).length>=1,'prompt is still sent after the owner binding check');
  f.push({type:'result',subtype:'success',is_error:false,session_id:sid,result:'fixture reply',permission_denials:[]});
  f.finish();await f.closed;
});

test('resumed turn writes no user prompt frame when onSession throws',async t=>{
  const f=fixture(t,{resume:true,onSession:()=>{throw Object.assign(Error('SESSION_SCOPE_CHANGED'),{code:'SESSION_SCOPE_CHANGED'});}});
  await handshake(f);
  await immediate();await immediate();
  assert.deepEqual(userFrames(f),[]);
  f.finish(1);await f.closed;
});

test('resumed turn that exits before init with non-English or empty stderr is CLAUDE_NATIVE_RESUME_FAILED',async t=>{
  for(const stderr of ['错误','']){
    const f=fixture(t,{resume:true});
    f.p.stdin.end('synthetic');await immediate();await immediate();
    if(stderr)f.c.stderr.write(stderr);
    f.finish(1);await f.closed;
    assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_RESUME_FAILED',stderr===''?'empty stderr':stderr);
  }
});

test('non-resumed turn that exits before init with non-English or empty stderr is CLAUDE_NATIVE_EXIT_UNSUCCESSFUL',async t=>{
  for(const stderr of ['错误','']){
    const f=fixture(t,{resume:false});
    f.p.stdin.end('synthetic');await immediate();await immediate();
    if(stderr)f.c.stderr.write(stderr);
    f.finish(1);await f.closed;
    assert.equal((await f.p.completion).errorCode,'CLAUDE_NATIVE_EXIT_UNSUCCESSFUL',stderr===''?'empty stderr':stderr);
  }
});

test('resumed turn cancelled by the owner before init is not CLAUDE_NATIVE_RESUME_FAILED',async t=>{
  const f=fixture(t,{resume:true});
  f.p.stdin.end('synthetic');await immediate();await immediate();
  f.p.kill();f.finish(1);await f.closed;
  assert.notEqual((await f.p.completion).errorCode,'CLAUDE_NATIVE_RESUME_FAILED');
});
