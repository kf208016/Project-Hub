'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createChecker}=require('../lib/local-drives');
const types=()=>Object.fromEntries(Array.from({length:26},(_,i)=>[String.fromCharCode(65+i),i===2?3:0]));
test('drive snapshot lasts 5 seconds; unknown letters query synchronously and remain closed',()=>{
 let time=1000,calls=0,map=types();const check=createChecker({platform:'win32',now:()=>time,query:()=>{calls++;return map;}});
 check('C:\\fixture');time+=4999;check('C:\\fixture');assert.equal(calls,1);time++;check('C:\\fixture');assert.equal(calls,2);
 assert.throws(()=>check('Z:\\fixture'),/Unknown/);assert.equal(calls,3);map={...map,Z:3};check('Z:\\fixture');assert.equal(calls,4);
 time--;check('C:\\fixture');assert.equal(calls,5);
});
test('drive helper diagnostics retain bounded sanitized stderr, status and signal at 15-second timeout',()=>{
 const file=path.join(__dirname,'../lib/local-drives.js'),req=require('node:module').createRequire(file);let options;
 const context={module:{exports:{}},require:name=>name==='node:child_process'?{execFileSync:(_f,_a,o)=>{options=o;throw Object.assign(Error('failure'),{status:17,signal:'SIGTERM',stderr:'x'.repeat(400)+'\n\u001bFAIL'});}}:req(name),process,Buffer};
 vm.runInNewContext(fs.readFileSync(file,'utf8')+"\nensureHelper=()=> 'synthetic';module.exports.query=queryTypes;",context);
 assert.throws(()=>context.module.exports.query(),e=>{assert.match(e.message,/^Local drive classification is unavailable \(exit=17, signal=SIGTERM\)/);assert.ok(e.message.split(': ').at(-1).length<=300);assert.doesNotMatch(e.message,/[\x00-\x1f\x7f-\x9f]/);return true;});assert.equal(options.timeout,15000);
});
