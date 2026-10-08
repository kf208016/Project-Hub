'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),pw=require('../lib/procwatch');
const row=(pid,ppid,command,since='2026-10-08T01:00:00.0000000Z')=>({pid,ppid,command,name:'node.exe',since});
const unreadable = async rows => rows.map(({pid}) => ({pid,creationTime:'',cwd:'',status:'access-denied'}));
test('Windows process names recognize only CLI executables including quoted paths',()=>{
 const cases=[['"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\node_modules\\@openai\\codex\\bin\\codex.js" app-server','codex'],['"C:\\a b\\claude.exe" -p hi','claude'],['C:\\a\\agy.exe --print=hi','agy'],['cmd.exe /c echo codex',''],['node.exe "C:\\x\\script.js" codex','']];
 for(const [cmd,expected]of cases)assert.equal(pw.aiOf(cmd),expected,cmd);
});
test('Windows unknown query never means zero processes; unassigned and reused PIDs remain guarded',async()=>{
 let rows=[row(1,0,'system'),row(101,1,'codex.exe exec --synthetic'),row(901,900,'claude.exe -p synthetic')],fail=false;
 const w=pw.create({platform:'win32',selfPid:900,log:()=>{},windowsCwds:unreadable,exec:async(cmd,args)=>{assert.match(cmd,/powershell\.exe$/);assert.ok(args.includes('-NonInteractive'));if(fail)throw Error('test error');return JSON.stringify(rows);}});
 assert.throws(()=>w.assertKnown(),/未知/);const first=await w.scan();assert.equal(first.length,1);assert.equal(first[0].pid,101);assert.equal(first[0].project,null);assert.equal(first[0].cwd,'');assert.equal(w.status().state,'ok');assert.throws(()=>w.assertKnown(),/未歸屬/);
 const changes=[];w.onChange((_,d)=>changes.push(d));rows[1]={...rows[1],since:'2026-10-08T02:00:00.0000000Z'};await w.scan();assert.equal(changes[0].removed.length,1);assert.equal(changes[0].added.length,1);
 fail=true;await w.scan();assert.equal(w.status().state,'unknown');assert.equal(w.list().length,1);assert.throws(()=>w.assertKnown(),/未知/);
 fail=false;rows=[row(1,0,'system')];await w.scan();assert.equal(w.list().length,0);assert.doesNotThrow(()=>w.assertKnown());
 assert.throws(()=>pw.parseWindows('[]'));assert.throws(()=>pw.parseWindows('{broken'));assert.throws(()=>pw.parseWindows('[{"pid":"1"}]'));
});
test('overlapping Windows process checks await the same fresh result before a mutation',async()=>{
 let release,calls=0;
 const w=pw.create({platform:'win32',log:()=>{},windowsCwds:unreadable,exec:()=>{calls++;return new Promise(r=>release=r);}});
 const first=w.scan(),second=w.scan();assert.equal(first,second);assert.equal(calls,1);assert.throws(()=>w.assertKnown(),/未知/);
 release(JSON.stringify([row(1,0,'system'),row(101,1,'codex.exe')]));await second;assert.equal(w.list().length,1);assert.throws(()=>w.assertKnown(),/未歸屬/);
});

test('Windows known unrelated cwd is distinct from unknown and mapped background work remains visible',async()=>{
 let rows=[row(1,0,'system'),row(101,1,'codex.exe'),row(102,1,'claude.exe')],unknown=false,calls=0;
 const w=pw.create({platform:'win32',selfPid:900,log:()=>{},exec:async()=>JSON.stringify(rows),
  projects:()=>[{id:'p',dir:'C:\\ledger\\p',tasks:[{id:'t',workdir:'C:\\Work\\p\\t'}]}],baseOf:()=> 'C:\\source\\p',
  windowsCwds:async wanted=>{calls++;assert.equal(wanted.length,2);return wanted.map(({pid,since})=>({pid,creationTime:since,cwd:unknown&&pid===102?'':pid===101?'C:\\Work\\p\\t\\src':'C:\\different-project',status:unknown&&pid===102?'access-denied':'ok'}));}});
 await w.scan();assert.equal(calls,1);assert.equal(w.list()[0].project,'p');assert.equal(w.list()[0].task,'t');assert.equal(w.list()[0].attribution,'known-related');
 assert.equal(w.list()[1].attribution,'known-unrelated');assert.equal(w.status().unrelated,1);assert.equal(w.status().unassigned,0);assert.doesNotThrow(()=>w.assertKnown());
 unknown=true;await w.scan();assert.equal(w.list()[1].cwd,'');assert.equal(w.list()[1].attribution,'unknown');assert.equal(w.status().unassigned,1);assert.throws(()=>w.assertKnown(),/未歸屬/);
});

test('Windows cwd is reread every scan and changed PID time, helper or project failures never look unrelated',async()=>{
 const rows=[row(1,0,'system'),row(101,1,'codex.exe')];let cwd='C:\\outside',failure='',calls=0;
 const w=pw.create({platform:'win32',selfPid:900,log:()=>{},exec:async()=>JSON.stringify(rows),projects:()=>{if(failure==='projects')throw Error('broken');return [{id:'p',dir:'C:\\source\\p',tasks:[]}];},baseOf:p=>p.dir,
  windowsCwds:async wanted=>{calls++;if(failure==='helper')throw Error('timeout');return wanted.map(({pid,since})=>({pid,creationTime:failure==='reused'?'2026-10-08T01:00:00.0000100Z':since,cwd,status:'ok'}));}});
 await w.scan();assert.doesNotThrow(()=>w.assertKnown());cwd='C:\\source\\p';await w.scan();assert.equal(calls,2);assert.equal(w.list()[0].project,'p');
 cwd='C:\\outside';for(const kind of ['helper','reused','projects']){failure=kind;await w.scan();assert.equal(w.list()[0].attribution,'unknown',kind);assert.throws(()=>w.assertKnown(),/未歸屬/,kind);}
});

test('Windows base-path mapping errors keep otherwise readable external cwd unknown',async()=>{
 const w=pw.create({platform:'win32',selfPid:900,log:()=>{},exec:async()=>JSON.stringify([row(1,0,'system'),row(101,1,'codex.exe')]),projects:()=>[{id:'p',dir:'C:\\ledger',tasks:[]}],baseOf:()=>{throw Error('unavailable');},windowsCwds:async wanted=>wanted.map(({pid,since})=>({pid,creationTime:since,cwd:'C:\\elsewhere',status:'ok'}))});
 await w.scan();assert.equal(w.list()[0].cwdStatus,'ok');assert.equal(w.list()[0].attribution,'unknown');assert.throws(()=>w.assertKnown(),/未歸屬/);
});
