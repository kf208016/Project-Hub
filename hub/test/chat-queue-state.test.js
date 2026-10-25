'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readQueue}=require('../lib/chat-state-reader');
const chat=require('../lib/chat');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-chat-queue-'));t.after(()=>{const actual=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());assert.ok(path.basename(actual).startsWith('hub-chat-queue-'));fs.rmSync(actual,{recursive:true,force:true});});return root;}
function rejected(code,status,file,marker='PRIVATE_QUEUE_FIXTURE_9F2'){return e=>{assert.equal(e.code,code);assert.equal(e.status,status);assert.equal(e.notStarted,true);assert.equal(Object.hasOwn(e,'cause'),false);for(const s of [String(e),JSON.stringify(e),String(e.stack)]){assert.equal(s.includes(file),false);assert.equal(s.includes(marker),false);}return true;};}
function queueFile(root,task='one'){const d=path.join(root,'.ai','chat');fs.mkdirSync(d,{recursive:true});return path.join(d,`${task}.queue.json`);}
test('missing and valid empty queue return fresh arrays',t=>{const root=fixture(t),missing=path.join(root,'missing.json');const a=readQueue(missing);a.push({id:'local'});assert.deepEqual(readQueue(missing),[]);const f=queueFile(root);fs.writeFileSync(f,'[]');assert.deepEqual(readQueue(f),[]);assert.equal(fs.existsSync(missing),false);});
test('valid queue preserves order, Unicode, extensions and original bytes',t=>{const root=fixture(t),f=queueFile(root),rows=[{id:'a',text:'接續模組🧪',legacy:{flag:true}},{oldKey:[1,'二']},{id:'a',text:'同指示仍保留'}],bytes=Buffer.from(JSON.stringify(rows));fs.writeFileSync(f,bytes);assert.deepEqual(readQueue(f),rows);assert.deepEqual(fs.readFileSync(f),bytes);});
test('truncated, empty, non-array, invalid entries, invalid UTF-8 and BOM are rejected unchanged',t=>{const root=fixture(t),f=queueFile(root);for(const bytes of [Buffer.from('[{"id":'),Buffer.from(''),Buffer.from('{}'),Buffer.from('[null]'),Buffer.from('[[]]'),Buffer.from('[false]'),Buffer.from([0xc3,0x28]),Buffer.from([0xef,0xbb,0xbf,0x5b,0x5d])]){fs.writeFileSync(f,bytes);assert.throws(()=>readQueue(f),rejected('CHAT_QUEUE_CORRUPT',409,f));assert.deepEqual(fs.readFileSync(f),bytes);}});
test('directory read failure is distinguished from missing and corrupt queue',t=>{const root=fixture(t),d=path.join(root,'queue-directory');fs.mkdirSync(d);assert.throws(()=>readQueue(d),rejected('CHAT_QUEUE_READ_FAILED',503,d));assert.equal(fs.statSync(d).isDirectory(),true);});
test('ChatRunner does not cache a failed queue read and can recover after explicit repair',t=>{const root=fixture(t),f=queueFile(root);fs.writeFileSync(f,'[broken');const runner=new chat.ChatRunner({dirOf:()=>root});assert.throws(()=>runner.queue('p','one'),rejected('CHAT_QUEUE_CORRUPT',409,f));assert.equal(runner.queues.has(runner.key('p','one')),false);const rows=[{id:'fixed',text:'修復後重讀'}];fs.writeFileSync(f,JSON.stringify(rows));assert.deepEqual(runner.queue('p','one'),rows);});
test('queue state remains separated by task',t=>{const root=fixture(t),one=queueFile(root,'one'),two=queueFile(root,'two');fs.writeFileSync(one,JSON.stringify([{id:'one'}]));fs.writeFileSync(two,JSON.stringify([{id:'two'}]));const runner=new chat.ChatRunner({dirOf:()=>root});assert.deepEqual(runner.queue('p','one'),[{id:'one'}]);assert.deepEqual(runner.queue('p','two'),[{id:'two'}]);});
test('memory-only runner keeps its empty queue behavior',()=>{const runner=new chat.ChatRunner();assert.deepEqual(runner.queue('p','one'),[]);});


test('required queue saves retry sharing errors and clean tmp on all write failures',t=>{
  const root=fixture(t),f=queueFile(root),runner=new chat.ChatRunner({dirOf:()=>root}),rename=fs.renameSync;let attempts=0,fail=false;
  runner.setQueue('p','one',[{id:'old'}],true);
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f&&(fail||++attempts<3))throw Object.assign(Error('PRIVATE'),{code:fail?'EINVAL':'EPERM'});return rename(a,b);});
  runner.setQueue('p','one',[{id:'new'}],true);assert.equal(attempts,3);assert.deepEqual(readQueue(f),[{id:'new'}]);
  fail=true;assert.throws(()=>runner.setQueue('p','one',[{id:'failed'}],true));assert.deepEqual(readQueue(f),[{id:'new'}]);assert.deepEqual(runner.queue('p','one'),[{id:'new'}]);
  const write=fs.writeFileSync;t.mock.method(fs,'writeFileSync',(file,...args)=>{if(String(file).endsWith('.tmp')){write(file,'partial');throw Error('partial write');}return write(file,...args);});
  assert.throws(()=>runner.setQueue('p','one',[{id:'partial'}],true));assert.deepEqual(fs.readdirSync(path.dirname(f)).filter(x=>x.endsWith('.tmp')),[]);
});

test('required synchronous queue save uses only the explicit 300 ms retry budget',t=>{
  const root=fixture(t),f=queueFile(root),runner=new chat.ChatRunner({dirOf:()=>root}),rename=fs.renameSync,delays=[];let calls=0;
  runner.setQueue('p','one',[{id:'old'}],true);
  t.mock.method(Atomics,'wait',(_a,_i,_v,ms)=>{delays.push(ms);});
  t.mock.method(fs,'renameSync',(a,b)=>{if(b===f){calls++;throw Object.assign(Error('private'),{code:'EPERM'});}return rename(a,b);});
  assert.throws(()=>runner.setQueue('p','one',[{id:'new'}],true));assert.equal(calls,6);assert.deepEqual(delays,[10,20,40,80,150]);assert.deepEqual(readQueue(f),[{id:'old'}]);
});
