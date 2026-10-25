'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');

// Exercise the real public operation/invoke path with synthetic managed children
// and a deterministic clock. These tests cannot compile, prompt, access the
// Windows credential vault, launch a process or establish an SSH connection.
function fixture(){
  const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const source=Buffer.from('synthetic broker source'),binary=Buffer.from('synthetic broker binary');
  const timers=new Map(),children=[],sourceReads=[];let now=0,nextTimer=0,fixtureFlag=false;
  const dependencies={
    'node:fs':{
      mkdirSync(){},existsSync:()=>true,
      readFileSync(filename){
        if(filename.endsWith('.cs')){sourceReads.push(source);return source;}
        if(filename.endsWith('.exe'))return binary;
        if(filename.endsWith('.build.json'))return JSON.stringify({sourceHash:digest(Buffer.concat([Buffer.from(fixtureFlag?'fixture-v2':'production-v2'),...sourceReads.splice(0)])),binarySHA256:digest(binary)});
        throw Error('Unexpected fixture file read');
      },
    },
    'node:path':path.win32,
    'node:child_process':{execFileSync(){throw Error('Native execution forbidden');}},
    './scoped-file':{identity(){throw Error('Unexpected root preparation');}},
    './managed-process':{
      spawn(){
        const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.killCalls=0;
        child.kill=()=>{child.killCalls++;return true;};children.push(child);return child;
      },
    },
  };
  const context={Buffer,Object,process:{platform:'win32',arch:'x64',env:{}},
    setTimeout(callback,delay){const id=++nextTimer;timers.set(id,{at:now+delay,callback});return id;},clearTimeout(id){timers.delete(id);},
  };
  const module={exports:{}},filename=path.join(__dirname,'../lib/ssh-password-vault.js');
  vm.runInNewContext('(function(require,module,exports,__dirname){'+fs.readFileSync(filename,'utf8')+'\n})',context,{filename})(name=>Object.hasOwn(dependencies,name)?dependencies[name]:require(name),module,module.exports,'C:\\fixture\\hub\\lib');
  const descriptor=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/ssh-password-vault-examples.json'),'utf8')).validDescriptor;
  descriptor.brokerSHA256=digest(binary);
  return {
    children,timers,
    start(mode='enroll',options={}){fixtureFlag=options.fixture===true;const promise=module.exports.operation(mode,descriptor,options);return {promise,child:children.at(-1)};},
    advance(ms){const end=now+ms;for(;;){const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0]);if(!due.length)break;const [id,timer]=due[0];now=timer.at;timers.delete(id);timer.callback();}now=end;},
  };
}
function finish(child,result={ok:true,state:'stored'},code=0){child.stdout.write(JSON.stringify(result));child.emit('close',code);}
const eventsOf=result=>Array.from(result.events);
const enrollmentStart=['ENROLLMENT_READY','ENROLLMENT_REQUESTED','PROMPT_REQUESTED'];
function emitEvents(child,events){child.stderr.write(events.map(event=>'HUB_VAULT_EVENT:'+event+'\n').join(''));}

test('vault streams prompt phases before completion and keeps native fixture options',async()=>{
  const f=fixture(),seen=[];const {promise,child}=f.start('enroll-fixture',{fixture:true,onEvent:event=>seen.push(event)});
  child.stderr.write('HUB_VAULT_EVENT:PROMPT_REQUESTED\n');
  assert.deepEqual(seen,['PROMPT_REQUESTED']);assert.equal(child.killCalls,0);
  child.stderr.write('HUB_VAULT_EVENT:PROMPT_RETURNED\r\nHUB_VAULT_EVENT:PROMPT_UNPACKED\nHUB_VAULT_EVENT:SUBMITTED\n');
  finish(child);const result=await promise;
  assert.deepEqual(eventsOf(result),seen);assert.equal(f.timers.size,0);assert.equal(f.children.length,1);
});

test('vault timeout retains streaming events and cannot be replaced by delayed success',async()=>{
  const f=fixture(),seen=[];const {promise,child}=f.start('enroll',{onEvent:event=>seen.push(event)});
  const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_OPERATION_TIMEOUT');assert.deepEqual(eventsOf(error),enrollmentStart);assert.equal(error.childCloseObserved,true);return true;});
  emitEvents(child,enrollmentStart);f.advance(299999);assert.equal(child.killCalls,0);f.advance(1);
  assert.equal(child.killCalls,1);assert.deepEqual(seen,enrollmentStart);
  finish(child);await rejected;assert.equal(f.children.length,1);assert.equal(f.timers.size,0);
});

test('vault enrollment idle deadline stays bounded before Start, including before READY',async()=>{
  for(const ready of [false,true]){
    const f=fixture(),seen=[];const {promise,child}=f.start('enroll',{onEvent:event=>seen.push(event)});
    const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_ENROLLMENT_IDLE_TIMEOUT');assert.deepEqual(eventsOf(error),ready?['ENROLLMENT_READY']:[]);assert.equal(error.childCloseObserved,true);return true;});
    f.advance(600000);assert.equal(child.killCalls,0);
    if(ready)emitEvents(child,['ENROLLMENT_READY']);
    f.advance(299999);assert.equal(child.killCalls,0);assert.deepEqual(seen,ready?['ENROLLMENT_READY']:[]);
    f.advance(1);assert.equal(child.killCalls,1);finish(child);await rejected;assert.equal(f.timers.size,0);
  }
});

test('vault explicit Start replaces the idle deadline with exactly one credential deadline',async()=>{
  const f=fixture();const {promise,child}=f.start('enroll');
  const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_OPERATION_TIMEOUT');assert.deepEqual(eventsOf(error),enrollmentStart);return true;});
  emitEvents(child,['ENROLLMENT_READY']);f.advance(899999);assert.equal(child.killCalls,0);
  emitEvents(child,['ENROLLMENT_REQUESTED']);assert.equal(f.timers.size,1);
  f.advance(200000);assert.equal(child.killCalls,0);emitEvents(child,['PROMPT_REQUESTED']);
  f.advance(99999);assert.equal(child.killCalls,0);f.advance(1);assert.equal(child.killCalls,1);
  finish(child);await rejected;assert.equal(f.timers.size,0);
});

test('vault rejects enrollment replay and out-of-order events without restarting the deadline',async()=>{
  for(const [accepted,invalid] of [
    [[], 'ENROLLMENT_REQUESTED'],
    [[], 'PROMPT_REQUESTED'],
    [['ENROLLMENT_READY'], 'PROMPT_REQUESTED'],
    [['ENROLLMENT_READY'], 'ENROLLMENT_READY'],
    [['ENROLLMENT_READY','ENROLLMENT_REQUESTED'], 'ENROLLMENT_REQUESTED'],
    [enrollmentStart, 'ENROLLMENT_READY'],
  ]){
    const f=fixture(),seen=[];const {promise,child}=f.start('enroll',{onEvent:event=>seen.push(event)});
    const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_ENROLLMENT_ORDER_REJECTED');assert.deepEqual(eventsOf(error),accepted);return true;});
    if(accepted.length)emitEvents(child,accepted);f.advance(123456);
    const deadline=[...f.timers.values()].map(timer=>timer.at);
    emitEvents(child,[invalid]);assert.equal(child.killCalls,1);assert.deepEqual(seen,accepted);
    assert.deepEqual([...f.timers.values()].map(timer=>timer.at),[...deadline,128456]);
    emitEvents(child,['ENROLLMENT_READY','ENROLLMENT_REQUESTED','STORED']);finish(child);await rejected;
    assert.equal(child.killCalls,1);assert.equal(f.children.length,1);assert.equal(f.timers.size,0);
  }
});

test('vault rejects enrollment window events outside the enrollment mode',async()=>{
  for(const mode of ['probe','enroll-fixture'])for(const event of ['ENROLLMENT_READY','ENROLLMENT_REQUESTED']){
    const f=fixture();const {promise,child}=f.start(mode,{fixture:mode==='enroll-fixture'});
    const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_ENROLLMENT_ORDER_REJECTED');assert.deepEqual(eventsOf(error),[]);return true;});
    emitEvents(child,[event]);assert.equal(child.killCalls,1);finish(child);await rejected;
  }
});

test('vault fixture mode retains the original operation timeout without window events',async()=>{
  const f=fixture();const {promise,child}=f.start('enroll-fixture',{fixture:true});
  const rejected=assert.rejects(promise,{code:'VAULT_OPERATION_TIMEOUT'});
  emitEvents(child,['SUBMITTED']);f.advance(59999);assert.equal(child.killCalls,0);f.advance(1);assert.equal(child.killCalls,1);
  finish(child);await rejected;assert.equal(f.timers.size,0);
});

test('vault enrollment cancellation before Start preserves the native result without a prompt',async()=>{
  const f=fixture();const {promise,child}=f.start('enroll');
  const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'SSH_VAULT_ENROLLMENT_CANCELLED');assert.deepEqual(eventsOf(error),['ENROLLMENT_READY']);return true;});
  emitEvents(child,['ENROLLMENT_READY']);finish(child,{ok:false,code:'SSH_VAULT_ENROLLMENT_CANCELLED'},1);await rejected;
  assert.equal(child.killCalls,0);assert.equal(f.timers.size,0);
});

test('vault timeout without a close event settles after bounded stop grace with unverified close',async()=>{
  const f=fixture();const {promise,child}=f.start('probe');
  const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_OPERATION_TIMEOUT');assert.equal(error.childCloseObserved,false);assert.deepEqual(eventsOf(error),[]);return true;});
  f.advance(60000);assert.equal(child.killCalls,1);f.advance(5000);await rejected;
  assert.equal(f.timers.size,0);assert.equal(f.children.length,1);
  finish(child);assert.equal(child.killCalls,1);
});

test('vault preserves cancellation and hard native failures with accumulated phases',async()=>{
  for(const [event,code] of [['PROMPT_CANCELLED','SSH_VAULT_PROMPT_CANCELLED'],['PROMPT_RETURNED','SSH_VAULT_PROMPT_FAILED_5']]){
    const f=fixture();const {promise,child}=f.start();
    const rejected=assert.rejects(promise,error=>{assert.equal(error.code,code);assert.deepEqual(eventsOf(error),[...enrollmentStart,event]);assert.equal(error.childCloseObserved,true);return true;});
    emitEvents(child,[...enrollmentStart,event]);finish(child,{ok:false,code},1);await rejected;
    assert.equal(child.killCalls,0);assert.equal(f.children.length,1);
  }
});

test('vault exposes only exact allowlisted events and bounded numeric SSH PIDs across split records',async()=>{
  const f=fixture(),seen=[];const {promise,child}=f.start('probe',{onEvent:event=>seen.push(event)});
  const wire='raw diagnostic synthetic secret\nHUB_VAULT_EVENT:SECRET_TOKEN\nHUB_VAULT_EVENT:{"password":"synthetic"}\nHUB_VAULT_EVENT:SSH_PID:0\nHUB_VAULT_EVENT:SSH_PID:042\nHUB_VAULT_EVENT:SSH_PID:4294967296\nHUB_VAULT_EVENT:SSH_PID:42\r\nHUB_VAULT_EVENT:SSH_HOST_PIN_MATCHED\nHUB_VAULT_EVENT:IDENTITY_VERIFIED';
  for(const byte of Buffer.from(wire))child.stderr.write(Buffer.from([byte]));
  assert.deepEqual(seen,['SSH_PID:42','SSH_HOST_PIN_MATCHED']);finish(child);
  const result=await promise;assert.deepEqual(eventsOf(result),['SSH_PID:42','SSH_HOST_PIN_MATCHED','IDENTITY_VERIFIED']);assert.deepEqual(seen,eventsOf(result));
});

test('vault bounds split unfinished diagnostic lines without forwarding raw text',async()=>{
  const f=fixture(),seen=[];const {promise,child}=f.start('probe',{onEvent:event=>seen.push(event)});
  const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_DIAGNOSTIC_LINE_LIMIT');assert.deepEqual(eventsOf(error),['PROMPT_REQUESTED']);return true;});
  child.stderr.write('HUB_VAULT_EVENT:PROMPT_REQUESTED\n');child.stderr.write('x'.repeat(128));child.stderr.write('x'.repeat(128));assert.equal(child.killCalls,0);child.stderr.write('x');assert.equal(child.killCalls,1);
  child.emit('close',1);await rejected;assert.deepEqual(seen,['PROMPT_REQUESTED']);
});

test('vault bounds total diagnostic bytes, event count and stdout separately',async()=>{
  for(const kind of ['stderr','events','stdout']){
    const f=fixture();const {promise,child}=f.start('probe');
    const expected={stderr:'VAULT_DIAGNOSTIC_LIMIT',events:'VAULT_EVENT_LIMIT',stdout:'VAULT_OUTPUT_LIMIT'}[kind];
    const rejected=assert.rejects(promise,{code:expected});
    if(kind==='stderr')for(let i=0;i<33;i++)child.stderr.write('x'.repeat(255)+'\n');
    if(kind==='events')for(let i=0;i<65;i++)child.stderr.write('HUB_VAULT_EVENT:PROMPT_REQUESTED\n');
    if(kind==='stdout')child.stdout.write('x'.repeat(8193));
    assert.equal(child.killCalls,1);child.emit('close',1);await rejected;assert.equal(f.children.length,1);
  }
});

test('vault callback exceptions fail closed, retain the accepted event and suppress later callbacks',async()=>{
  const f=fixture(),seen=[];const {promise,child}=f.start('enroll',{onEvent:event=>{seen.push(event);throw Error('synthetic callback failure');}});
  const rejected=assert.rejects(promise,error=>{assert.equal(error.code,'VAULT_EVENT_CALLBACK_FAILED');assert.deepEqual(eventsOf(error),['ENROLLMENT_READY']);assert.doesNotMatch(error.message,/synthetic/);return true;});
  emitEvents(child,['ENROLLMENT_READY','STORED']);finish(child);await rejected;
  assert.equal(child.killCalls,1);assert.deepEqual(seen,['ENROLLMENT_READY']);assert.equal(f.children.length,1);
});

test('vault rejects async or nonfunction callbacks without unhandled rejections or retries',async()=>{
  const invalid=fixture();await assert.rejects(invalid.start('enroll',{onEvent:true}).promise,{code:'VAULT_EVENT_CALLBACK_REJECTED'});assert.equal(invalid.children.length,0);
  const f=fixture();const {promise,child}=f.start('enroll',{onEvent:()=>Promise.reject(Error('synthetic async callback failure'))});
  const rejected=assert.rejects(promise,{code:'VAULT_EVENT_CALLBACK_FAILED'});emitEvents(child,['ENROLLMENT_READY']);child.emit('close',1);await rejected;await Promise.resolve();assert.equal(child.killCalls,1);
});

test('vault missing result and child errors stay distinct from timeout and cancellation',async()=>{
  const f=fixture();const {promise,child}=f.start('probe');const rejected=assert.rejects(promise,{code:'VAULT_OPERATION_FAILED'});child.emit('close',0);await rejected;assert.equal(f.timers.size,0);
  const g=fixture();const second=g.start('probe');const failed=assert.rejects(second.promise,{code:'VAULT_PROCESS_FAILED'});second.child.emit('error',Error('raw private diagnostic'));finish(second.child);await failed;assert.equal(second.child.killCalls,1);
});
