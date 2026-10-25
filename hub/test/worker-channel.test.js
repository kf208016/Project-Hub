'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{PassThrough}=require('node:stream');
const {MAX_FRAME,decode,encode,canonical,FramedChannel}=require('../lib/worker-channel');
test('worker JSON rejects duplicate keys, malformed Unicode and rounded/fractional numbers',()=>{
  for(const source of ['{"op":"hello","op":"run"}','{"x":"\\ud800"}','{"x":"\\u0000"}','{"x":9007199254740993}','{"x":9007199254740991.1}','{"x":NaN}','{"x":1e1}','{"x":01}'])assert.throws(()=>decode(Buffer.from(source)));
  assert.throws(()=>decode(Buffer.from([0xff])));assert.throws(()=>decode(Buffer.from('null')));
});
test('worker canonical bytes are deterministic and preserve exact Traditional Chinese',()=>{
  const value={z:'繁體中文',a:1,b:[true,null]};assert.equal(canonical(value),canonical({b:[true,null],a:1,z:'繁體中文'}));
  const frame=encode(value);assert.equal(frame.readUInt32BE(0),frame.length-4);assert.equal(decode(frame.subarray(4)).z,'繁體中文');
});
test('worker framing accepts split prefix/body and preserves frame order',async()=>{
  const input=new PassThrough(),output=new PassThrough(),channel=new FramedChannel(input,output),first=channel.read(1000),frame=encode({op:'one'});
  input.write(frame.subarray(0,2));input.write(frame.subarray(2,7));input.write(Buffer.concat([frame.subarray(7),encode({op:'two'})]));
  assert.equal((await first).op,'one');assert.equal((await channel.read()).op,'two');channel.close();
});
test('worker framing refuses oversize lengths before waiting for their body',async()=>{
  const input=new PassThrough(),channel=new FramedChannel(input,new PassThrough()),pending=channel.read(1000);const prefix=Buffer.alloc(4);prefix.writeUInt32BE(MAX_FRAME+1);input.write(prefix);
  await assert.rejects(pending,{code:'WORKER_FRAME_SIZE_BOUND'});channel.close();
});
test('worker EOF and read deadline remain failures',async()=>{
  const input=new PassThrough(),channel=new FramedChannel(input,new PassThrough()),pending=channel.read(1000);input.end(Buffer.from([0,0]));await assert.rejects(pending,{code:'WORKER_FRAME_TRUNCATED'});channel.close();
  const timed=new FramedChannel(new PassThrough(),new PassThrough());await assert.rejects(timed.read(10),{code:'WORKER_CHANNEL_TIMEOUT'});timed.close();
});
test('worker queue bound rejects unsolicited flooding',async()=>{
  const input=new PassThrough(),channel=new FramedChannel(input,new PassThrough());input.write(Buffer.concat(Array.from({length:5},()=>encode({op:'unsolicited'}))));
  assert.equal(channel.error.code,'WORKER_CHANNEL_QUEUE_BOUND');await assert.rejects(channel.read(),{code:'WORKER_CHANNEL_QUEUE_BOUND'});channel.close();
});
test('worker canonical writer refuses unknown objects, fractional numbers and excessive nesting',()=>{
  for(const value of [new Date(),1.2,Infinity,{x:'\ud800'}])assert.throws(()=>canonical(value));let nested='x';for(let i=0;i<18;i++)nested=[nested];assert.throws(()=>canonical(nested));
});
