'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),path=require('node:path');
const {ChatRunner}=require('../lib/chat'),{Sessions}=require('../lib/sessions');
test('web and unknown actors cannot enter chat or terminal execution before any file or child mutation',()=>{
 const runner=new ChatRunner({dirOf:()=>path.join(os.tmpdir(),'no-write-probe')}),sessions=new Sessions({});
 for(const ai of ['chatgpt','claude-chat','unknown']){
   assert.throws(()=>runner.send({project:'p',task:'t',pdir:path.join(os.tmpdir(),'no-write-probe'),ai,text:'synthetic'}),error=>['ACTOR_CAPABILITY_UNAVAILABLE','UNKNOWN_ACTOR'].includes(error.code));
   assert.throws(()=>sessions.start({project:'p',task:'t',ai,dir:path.join(os.tmpdir(),'no-write-probe')}),error=>['ACTOR_CAPABILITY_UNAVAILABLE','UNKNOWN_ACTOR'].includes(error.code));
 }
 assert.equal(runner.running.size,0);assert.equal(sessions.list().length,0);
});
(process.platform==='win32'?test:test.skip)('unverified Windows CLI actors cannot spawn through direct runners',()=>{
 const runner=new ChatRunner({dirOf:()=>path.join(os.tmpdir(),'no-write-probe')}),sessions=new Sessions({});
 for(const ai of ['claude','agy','grok']){
   assert.throws(()=>runner.send({project:'p',task:'t',pdir:path.join(os.tmpdir(),'no-write-probe'),ai,text:'synthetic'}),error=>error.notStarted===true);
   assert.throws(()=>sessions.start({project:'p',task:'t',ai,dir:path.join(os.tmpdir(),'no-write-probe')}),error=>error.notStarted===true);
 }
});
