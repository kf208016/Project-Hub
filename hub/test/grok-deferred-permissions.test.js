'use strict';

const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const {createDeferredPermissions}=require('../lib/grok-deferred-permissions');

function rejected(fn,code) {
  assert.throws(fn,e=>e instanceof Error && e.code===code);
}

describe('grok-deferred-permissions: pure bounded storage',()=>{
  test('default and boundary capacities are accepted; API and exports are frozen',()=>{
    assert.equal(Object.isFrozen(require('../lib/grok-deferred-permissions')),true);
    for(const limit of [undefined,1,16]) {
      const queue=createDeferredPermissions(limit);
      assert.equal(Object.isFrozen(queue),true);
      assert.deepEqual(Object.keys(queue).sort(),['add','clear','size','takeForTool']);
      assert.equal(queue.size(),0);
    }
  });

  for(const value of [0,17,-1,1.5,NaN,Infinity,null,'1',{},[],true]) {
    test('invalid capacity is refused: '+String(value),()=>rejected(()=>createDeferredPermissions(value),'E_LIMIT'));
  }

  test('retains opaque identity, original deadline and deterministic insertion order',()=>{
    const queue=createDeferredPermissions();
    const first={value:1},second={value:2},third={value:3};
    queue.add('r1','t1',first,50);
    queue.add('r2','t2',second,0);
    queue.add('r3','t3',third,Number.MAX_SAFE_INTEGER);
    const taken=queue.takeForTool('t2');
    assert.equal(Object.isFrozen(taken),true);
    assert.equal(taken.length,1);
    assert.deepEqual(Object.keys(taken[0]),['requestKey','toolCallId','record','expiresAt']);
    assert.equal(taken[0].record,second);
    assert.equal(taken[0].expiresAt,0);
    const rest=queue.clear();
    assert.equal(Object.isFrozen(rest),true);
    assert.deepEqual(rest.map(x=>x.requestKey),['r1','r3']);
    assert.equal(rest[0].record,first);
    assert.equal(rest[1].record,third);
    assert.equal(rest[1].expiresAt,Number.MAX_SAFE_INTEGER);
    assert.equal(queue.size(),0);
    for(const entry of [...taken,...rest]) assert.equal(Object.isFrozen(entry),true);
  });

  test('duplicate request or tool rejection does not leave partial indices or replace records',()=>{
    const queue=createDeferredPermissions(2);
    const record={};
    queue.add('first','tool',record,100);
    rejected(()=>queue.add('first','different-tool',{},200),'E_DUPLICATE_REQUEST');
    rejected(()=>queue.add('different-request','tool',{},200),'E_DUPLICATE_TOOL');
    assert.equal(queue.size(),1);
    assert.deepEqual(queue.takeForTool('different-tool'),[]);
    queue.add('different-request','different-tool',{},200);
    assert.equal(queue.size(),2);
    assert.equal(queue.takeForTool('tool')[0].record,record);
  });

  test('capacity rejection is atomic and retrieval permits reuse without retained indices',()=>{
    const queue=createDeferredPermissions(1);
    queue.add('first','tool',{},0);
    rejected(()=>queue.add('next','next-tool',{},1),'E_CAPACITY');
    assert.equal(queue.size(),1);
    assert.equal(queue.takeForTool('tool').length,1);
    queue.add('next','next-tool',{},1);
    assert.equal(queue.takeForTool('next-tool')[0].requestKey,'next');
    queue.add('first','tool',{},2);
    assert.equal(queue.clear()[0].expiresAt,2);
  });

  test('default bound is exactly sixteen, clear resets all indices',()=>{
    const queue=createDeferredPermissions();
    for(let i=0;i<16;i++) queue.add('r'+i,'t'+i,{},i);
    rejected(()=>queue.add('r16','t16',{},16),'E_CAPACITY');
    assert.equal(queue.size(),16);
    assert.deepEqual(queue.clear().map(e=>e.expiresAt),Array.from({length:16},(_,i)=>i));
    for(let i=0;i<16;i++) queue.add('r'+i,'t'+i,{},i);
    assert.equal(queue.size(),16);
  });

  test('absent retrieval and empty clear return frozen arrays and do not change size',()=>{
    const queue=createDeferredPermissions();
    for(const result of [queue.takeForTool('missing'),queue.clear()]) {
      assert.equal(Object.isFrozen(result),true);
      assert.deepEqual(result,[]);
    }
    assert.equal(queue.size(),0);
  });

  test('entry or result mutation cannot rewrite indices, record identity or deadline',()=>{
    const queue=createDeferredPermissions();
    const record={requestKey:'fake',expiresAt:0};
    queue.add('real','tool',record,123);
    const result=queue.takeForTool('tool');
    assert.throws(()=>{result[0].requestKey='changed';},TypeError);
    assert.throws(()=>{result[0].toolCallId='changed';},TypeError);
    assert.throws(()=>{result[0].expiresAt=999;},TypeError);
    assert.throws(()=>{result.push({});},TypeError);
    record.requestKey='caller-mutated';
    assert.equal(result[0].requestKey,'real');
    assert.equal(result[0].record,record);
    assert.equal(result[0].expiresAt,123);
    assert.equal(Object.isFrozen(record),false);
    assert.deepEqual(queue.takeForTool('tool'),[]);
  });

  test('record getters, toJSON and proxy traps are never invoked or frozen',()=>{
    let touched=0;
    const proxy=new Proxy({}, {get(){touched++;throw new Error('private');},getPrototypeOf(){touched++;throw new Error('private');},ownKeys(){touched++;throw new Error('private');},preventExtensions(){touched++;throw new Error('private');}});
    const queue=createDeferredPermissions();
    queue.add('r','t',proxy,1);
    assert.equal(queue.takeForTool('t')[0].record,proxy);
    const revocable=Proxy.revocable({},{});
    revocable.revoke();
    queue.add('r2','t2',revocable.proxy,2);
    assert.equal(queue.clear()[0].record,revocable.proxy);
    assert.equal(touched,0);
  });

  test('objects including arrays are opaque; primitive records and callbacks are rejected atomically',()=>{
    const queue=createDeferredPermissions();
    for(const record of [null,undefined,false,0,'record',()=>{}]) {
      rejected(()=>queue.add('same','same-tool',record,1),'E_RECORD');
      assert.equal(queue.size(),0);
    }
    const record=[];
    queue.add('same','same-tool',record,1);
    assert.equal(queue.clear()[0].record,record);
  });

  test('all malformed IDs and deadline values fail before mutation',()=>{
    const queue=createDeferredPermissions();
    for(const id of ['',null,undefined,0,{},[],true,'-x','x/y','x y','x'.repeat(257)]) {
      rejected(()=>queue.add(id,'tool',{},1),'E_REQUEST_KEY');
      rejected(()=>queue.add('request',id,{},1),'E_TOOL_ID');
      rejected(()=>queue.takeForTool(id),'E_TOOL_ID');
      assert.equal(queue.size(),0);
    }
    for(const expires of [undefined,null,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1',{},[],false]) {
      rejected(()=>queue.add('request','tool',{},expires),'E_EXPIRES');
      assert.equal(queue.size(),0);
    }
    queue.add('r'.repeat(256),'t'.repeat(256),{},0);
    assert.equal(queue.takeForTool('t'.repeat(256)).length,1);
  });

  test('hostile argument objects are never coerced and errors are fixed fresh objects',()=>{
    let calls=0;
    const hostile=new Proxy({}, {get(){calls++;throw new Error('secret');},getPrototypeOf(){calls++;throw new Error('secret');},ownKeys(){calls++;throw new Error('secret');}});
    const queue=createDeferredPermissions();
    rejected(()=>createDeferredPermissions(hostile),'E_LIMIT');
    rejected(()=>queue.add(hostile,'tool',{},1),'E_REQUEST_KEY');
    rejected(()=>queue.add('request',hostile,{},1),'E_TOOL_ID');
    rejected(()=>queue.add('request','tool',{},hostile),'E_EXPIRES');
    rejected(()=>queue.takeForTool(hostile),'E_TOOL_ID');
    const errors=[];
    for(let i=0;i<2;i++)try{queue.add('','tool',{},1);}catch(e){errors.push(e);}
    assert.equal(calls,0);
    assert.equal(errors.length,2);
    assert.notEqual(errors[0],errors[1]);
    assert.equal(errors[0].message,'invalid request key');
    assert.equal(queue.size(),0);
  });
});
