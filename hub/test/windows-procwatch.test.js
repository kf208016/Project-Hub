'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),pw=require('../lib/procwatch');
const row=(pid,ppid,command,since='2026-10-08T01:00:00.000Z')=>({pid,ppid,command,name:'node.exe',since});
test('Windows process names recognize only CLI executables including quoted paths',()=>{
 const cases=[['"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\node_modules\\@openai\\codex\\bin\\codex.js" app-server','codex'],['"C:\\a b\\claude.exe" -p hi','claude'],['C:\\a\\agy.exe --print=hi','agy'],['cmd.exe /c echo codex',''],['node.exe "C:\\x\\script.js" codex','']];
 for(const [cmd,expected]of cases)assert.equal(pw.aiOf(cmd),expected,cmd);
});
test('Windows unknown query never means zero processes; unassigned and reused PIDs remain guarded',async()=>{
 let rows=[row(1,0,'system'),row(101,1,'codex.exe exec --synthetic'),row(901,900,'claude.exe -p synthetic')],fail=false;
 const w=pw.create({platform:'win32',selfPid:900,log:()=>{},exec:async(cmd,args)=>{assert.match(cmd,/powershell\.exe$/);assert.ok(args.includes('-NonInteractive'));if(fail)throw Error('test error');return JSON.stringify(rows);}});
 assert.throws(()=>w.assertKnown(),/未知/);const first=await w.scan();assert.equal(first.length,1);assert.equal(first[0].pid,101);assert.equal(first[0].project,null);assert.equal(first[0].cwd,'');assert.equal(w.status().state,'ok');assert.throws(()=>w.assertKnown(),/未歸屬/);
 const changes=[];w.onChange((_,d)=>changes.push(d));rows[1]={...rows[1],since:'2026-10-08T02:00:00.000Z'};await w.scan();assert.equal(changes[0].removed.length,1);assert.equal(changes[0].added.length,1);
 fail=true;await w.scan();assert.equal(w.status().state,'unknown');assert.equal(w.list().length,1);assert.throws(()=>w.assertKnown(),/未知/);
 fail=false;rows=[row(1,0,'system')];await w.scan();assert.equal(w.list().length,0);assert.doesNotThrow(()=>w.assertKnown());
 assert.throws(()=>pw.parseWindows('[]'));assert.throws(()=>pw.parseWindows('{broken'));assert.throws(()=>pw.parseWindows('[{"pid":"1"}]'));
});
test('overlapping Windows process checks await the same fresh result before a mutation',async()=>{
 let release,calls=0;
 const w=pw.create({platform:'win32',log:()=>{},exec:()=>{calls++;return new Promise(r=>release=r);}});
 const first=w.scan(),second=w.scan();assert.equal(first,second);assert.equal(calls,1);assert.throws(()=>w.assertKnown(),/未知/);
 release(JSON.stringify([row(1,0,'system'),row(101,1,'codex.exe')]));await second;assert.equal(w.list().length,1);assert.throws(()=>w.assertKnown(),/未歸屬/);
});
