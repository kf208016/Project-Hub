'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {replaceSync,openRetrySync}=require('../lib/atomic-replace');

test('replace retries only sharing errno, returns attempt count and observes fs patches at call time',t=>{
  const delays=[],errors=['EPERM','EACCES','EBUSY'];let count=0;
  t.mock.method(fs,'renameSync',(tmp,dest)=>{assert.equal(tmp,'tmp');assert.equal(dest,'dest');const code=errors[count++];if(code)throw Object.assign(Error('PRIVATE_PATH'),{code});});
  t.mock.method(fs,'unlinkSync',()=>assert.fail('success must not unlink'));
  assert.equal(replaceSync('tmp','dest',{sleep:ms=>delays.push(ms)}),4);assert.deepEqual(delays,[25,50,100]);
});
test('final failure retries eight times, cleans tmp, preserves errno/attempts and hides raw errors',t=>{
  let attempts=0,removed=0;const delays=[];
  t.mock.method(fs,'renameSync',()=>{attempts++;throw Object.assign(Error('PRIVATE_PATH'),{code:'EPERM'});});
  t.mock.method(fs,'unlinkSync',tmp=>{assert.equal(tmp,'tmp');removed++;throw Error('cleanup locked');});
  assert.throws(()=>replaceSync('tmp','dest',{sleep:ms=>delays.push(ms)}),e=>e.code==='EPERM'&&e.attempts===8&&!e.message.includes('PRIVATE_PATH'));
  assert.equal(attempts,8);assert.equal(removed,1);assert.deepEqual(delays,[25,50,100,200,300,400,500]);
});
test('nonretryable failure never sleeps and custom retry delays work',t=>{
  let attempts=0,removed=0,code='ENOENT';const delays=[];
  t.mock.method(fs,'renameSync',()=>{attempts++;throw Object.assign(Error('private'),{code});});t.mock.method(fs,'unlinkSync',()=>removed++);
  assert.throws(()=>replaceSync('tmp','dest',{sleep:()=>assert.fail('no sleep')}),e=>e.code==='ENOENT'&&e.attempts===1);
  code='EBUSY';assert.throws(()=>replaceSync('tmp','dest',{delays:[1,2],sleep:ms=>delays.push(ms)}),e=>e.code==='EBUSY'&&e.attempts===3);
  assert.equal(attempts,4);assert.equal(removed,2);assert.deepEqual(delays,[1,2]);
});
test('openRetry returns descriptor and never removes the destination on exhaustion',t=>{
  let calls=0,fail=false;const delays=[];
  t.mock.method(fs,'openSync',(file,flags)=>{assert.equal(file,'dest');assert.equal(flags,'r+');if(fail||++calls<3)throw Object.assign(Error('private'),{code:'EACCES'});return 42;});
  t.mock.method(fs,'unlinkSync',()=>assert.fail('must keep destination'));
  assert.equal(openRetrySync('dest','r+',{delays:[1,2],sleep:ms=>delays.push(ms)}),42);assert.deepEqual(delays,[1,2]);
  fail=true;assert.throws(()=>openRetrySync('dest','r+',{delays:[],sleep:()=>{}}),e=>e.attempts===1&&e.code==='EACCES');
});


test('async replace retries sharing errors and awaits injected Promise delays',async t=>{
  const {replaceAsync}=require('../lib/atomic-replace'),delays=[];let calls=0,waiting=false;
  t.mock.method(fs,'renameSync',()=>{assert.equal(waiting,false);const code=['EPERM','EACCES','EBUSY'][calls++];if(code)throw Object.assign(Error('private'),{code});});
  t.mock.method(fs,'unlinkSync',()=>assert.fail('success must not unlink'));
  assert.equal(await replaceAsync('tmp','dest',{sleep:async ms=>{waiting=true;await new Promise(r=>setImmediate(r));delays.push(ms);waiting=false;}}),4);
  assert.deepEqual(delays,[25,50,100]);
});
test('async replace exhaustion preserves errno and attempts, cleans tmp, and nonsharing errors never retry',async t=>{
  const {replaceAsync}=require('../lib/atomic-replace');let code='EBUSY',removed=0;const delays=[];
  t.mock.method(fs,'renameSync',()=>{throw Object.assign(Error('PRIVATE_PATH'),{code});});t.mock.method(fs,'unlinkSync',()=>{removed++;});
  await assert.rejects(replaceAsync('tmp','dest',{sleep:async ms=>{delays.push(ms);}}),e=>e.code==='EBUSY'&&e.attempts===8&&!e.message.includes('PRIVATE'));
  assert.deepEqual(delays,[25,50,100,200,300,400,500]);
  code='ENOSPC';await assert.rejects(replaceAsync('tmp','dest',{sleep:async()=>assert.fail('no retry')}),e=>e.code==='ENOSPC'&&e.attempts===1);assert.equal(removed,2);
});
test('async default waits let timers run and open retry keeps descriptor and destination contracts',async t=>{
  const {replaceAsync,openRetryAsync}=require('../lib/atomic-replace');let calls=0,ticked=false;
  t.mock.method(fs,'renameSync',()=>{if(++calls===1)throw Object.assign(Error('private'),{code:'EPERM'});assert.equal(ticked,true);});
  const timer=setTimeout(()=>{ticked=true;},0);t.after(()=>clearTimeout(timer));
  assert.equal(await replaceAsync('tmp','dest'),2);
  calls=0;t.mock.method(fs,'openSync',(file,flags)=>{assert.equal(file,'dest');assert.equal(flags,'r+');if(++calls<3)throw Object.assign(Error('private'),{code:'EACCES'});return 42;});
  t.mock.method(fs,'unlinkSync',()=>assert.fail('must keep destination'));const delays=[];
  assert.equal(await openRetryAsync('dest','r+',{delays:[1,2],sleep:async ms=>{delays.push(ms);}}),42);assert.deepEqual(delays,[1,2]);
  calls=0;await assert.rejects(openRetryAsync('dest','r+',{delays:[]}),e=>e.code==='EACCES'&&e.attempts===1);
});
