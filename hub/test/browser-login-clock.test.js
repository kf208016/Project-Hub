'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {BrowserLoginFSM}=require('../lib/browser-login');
test('exact public ID rejects a trailing line feed before any cleanup',()=>{
  const fsm=new BrowserLoginFSM({now:()=>0});
  const pending=fsm.createPending();
  assert.deepEqual(fsm.approve(pending.id+'\n'),{ok:false,error:'INVALID_INPUT'});
});
test('invalid clock invalidates an already approved pending authorization',()=>{
  let now=1000;const fsm=new BrowserLoginFSM({now:()=>now});
  const pending=fsm.createPending();assert.deepEqual(fsm.approve(pending.id),{ok:true});
  now=NaN;assert.deepEqual(fsm.pollAndConsume(pending.id,pending.nonce),{ok:false,error:'INTERNAL_FAILURE'});
  now=1001;assert.deepEqual(fsm.pollAndConsume(pending.id,pending.nonce),{ok:false,error:'NOT_FOUND'});
});
