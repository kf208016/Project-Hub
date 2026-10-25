'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const os=require('os'),path=require('path');
const pw=require('../lib/procwatch');

const MAC=`    1     0 Sat Oct  3 08:00:00 2026     /sbin/launchd
  500     1 Sun Oct  4 09:00:00 2026     /bin/zsh -l
  501   500 Sun Oct  4 09:01:02 2026     /Applications/ChatGPT.app/Contents/Resources/codex exec --full-auto "fix tests"
  502   500 Sun Oct  4 09:02:03 2026     node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js
  503   500 Sun Oct  4 09:03:04 2026     node /Users/me/.local/bin/claude -p hello
  504   500 Sun Oct  4 09:04:05 2026     /Applications/Claude Code.app/Contents/Resources/bin/claude --resume
  505   500 Sun Oct  4 09:05:06 2026     grep codex
  506   500 Sun Oct  4 09:06:07 2026     vim /tmp/claude
  900     1 Sun Oct  4 07:00:00 2026     node /Users/me/hub/server.js
  901   900 Sun Oct  4 07:10:00 2026     /bin/zsh -c claude
  902   901 Sun Oct  4 07:10:01 2026     claude --model opus
  903   900 Sun Oct  4 07:11:00 2026     codex exec hi
  510     1 Sun Oct  4 10:00:00 2026     agy run
  511   510 Sun Oct  4 10:00:01 2026     /usr/local/bin/agy worker
`;
const LINUX=`      1       0 Sat Oct  3 08:00:00 2026 /sbin/init
   2001       1 Sun Oct  4 11:22:33 2026 codex exec OPENAI_API_KEY=sk-abcdefghijklmnop --api-key secret123 do it
   2002       1 Sun Oct  4 11:22:34 2026 /usr/bin/node /usr/lib/node_modules/@openai/codex/bin/codex.js exec x
   2003       1 Sun Oct  4 11:22:35 2026 claude -p "hi"
   bad line
`;

test('parse ps rows on both platforms',()=>{
 assert.deepEqual(pw.psArgs('darwin'),['-axo','pid=,ppid=,lstart=,command=']);
 assert.deepEqual(pw.psArgs('linux'),['-eo','pid=,ppid=,lstart=,args=']);
 const m=pw.parsePs(MAC);assert.equal(m.length,14);
 const r=m.find(x=>x.pid===501);assert.equal(r.ppid,500);assert.equal(r.since,new Date(2026,9,4,9,1,2).toISOString());
 assert.match(r.command,/^\/Applications\/ChatGPT\.app\/.*codex exec --full-auto "fix tests"$/);
 assert.equal(m.find(x=>x.pid===504).command,'/Applications/Claude Code.app/Contents/Resources/bin/claude --resume');
 const l=pw.parsePs(LINUX);assert.deepEqual(l.map(x=>x.pid),[1,2001,2002,2003]);assert.equal(l[1].since,new Date(2026,9,4,11,22,33).toISOString());
 assert.equal(pw.parseLstart('garbage'),'');
});

test('recognize AI executables only',()=>{
 assert.equal(pw.aiOf('"C:\\Synthetic\\grok.exe" run'),'grok');assert.equal(pw.aiOf('"C:\\Synthetic\\Grok Bot.exe"'),'', 'desktop Bot is not a CLI process');assert.equal(pw.aiOf('echo grok'),'');
 const cases={'codex exec x':'codex','/opt/bin/claude -p hi':'claude','agy':'agy','node /x/claude':'claude','node --no-warnings /x/codex.js exec':'codex',
  '/Applications/Claude Code.app/Contents/Resources/bin/claude --resume':'claude','grep codex':'','vim /tmp/claude':'','/bin/zsh -c claude':'','claudex':'','node /x/cli.js':'','node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js':'claude',
  '/Applications/Claude.app/Contents/MacOS/Claude':''};
 for(const [c,ai] of Object.entries(cases)) assert.equal(pw.aiOf(c),ai,c);
});

test('drop Hub descendants and same-AI wrapper children; strip secrets',()=>{
 const k=pw.pickAi(pw.parsePs(MAC),900);
 assert.deepEqual(k.map(x=>[x.pid,x.ai]),[[501,'codex'],[502,'claude'],[503,'claude'],[504,'claude'],[510,'agy']]);
 const c=pw.cleanCmd(pw.parsePs(LINUX)[1].command);
 assert.ok(!/abcdefghijklmnop|secret123/.test(c),c);assert.match(c,/OPENAI_API_KEY=\*\*\*/);
 assert.equal(pw.cleanCmd('x'.repeat(300)).length,160);
});

test('lsof output and cwd → project/task mapping',()=>{
 const m=pw.parseLsof('p501\nfcwd\nn/Users/me/Work/p1/t1/sub\np503\nfcwd\nn/Users/me/Product/p1\n');
 assert.equal(m.get(501),'/Users/me/Work/p1/t1/sub');assert.equal(m.get(503),'/Users/me/Product/p1');
 const projects=[{id:'p1',dir:'/Users/me/Product/p1',tasks:[{id:'t1',workdir:'/Users/me/Work/p1/t1'},{id:'t2',workdir:'/Users/me/Work/p1/t1/sub'},{id:'t3',workdir:''}]},
  {id:'p2',dir:'/Users/me/Product/p2',tasks:[{id:'h',workdir:'~/home-task'}]}];
 const baseOf=p=>p.id==='p2'?'/Users/me/code/p2':p.dir;
 assert.deepEqual(pw.mapCwd('/Users/me/Work/p1/t1/sub/deep',projects,baseOf),{project:'p1',task:'t2'});
 assert.deepEqual(pw.mapCwd('/Users/me/Work/p1/t1',projects,baseOf),{project:'p1',task:'t1'});
 assert.deepEqual(pw.mapCwd('/Users/me/Work/p1/t10',projects,baseOf),{project:null,task:null});
 assert.deepEqual(pw.mapCwd('/Users/me/code/p2/src',projects,baseOf),{project:'p2',task:null});
 assert.deepEqual(pw.mapCwd('/Users/me/Product/p2',projects,baseOf),{project:'p2',task:null});
 assert.deepEqual(pw.mapCwd(path.join(os.homedir(),'home-task','x'),projects,baseOf),{project:'p2',task:'h'});
 assert.deepEqual(pw.mapCwd('',projects,baseOf),{project:null,task:null});
});

test('scan via injected exec (mac): lsof once, cache, change callback, keeps last on failure',async()=>{
 let ps=MAC,calls=[],fail=false;const logs=[];
 const exec=async(cmd,args)=>{calls.push([cmd,...args].join(' '));if(fail)throw new Error('boom');
  if(cmd==='ps')return ps;
  return args[4].split(',').map(p=>`p${p}\nfcwd\nn${p==='501'?'/w/p1/t1':p==='510'?'/w/p2':'/elsewhere'}`).join('\n');};
 const projects=()=>[{id:'p1',dir:'/w/p1',tasks:[{id:'t1',workdir:'/w/p1/t1',state:'実行中'}]},{id:'p2',dir:'/w/p2',tasks:[]}];
 const w=pw.create({platform:'darwin',exec,selfPid:900,projects,baseOf:p=>p.dir,log:m=>logs.push(m)});
 const events=[];w.onChange((list,d)=>events.push(d));
 await w.scan();
 assert.deepEqual(calls,['ps -axo pid=,ppid=,lstart=,command=','lsof -a -d cwd -p 501,502,503,504,510 -Fpn']);
 const l=w.list();assert.equal(l.length,5);
 assert.deepEqual(l.find(x=>x.pid===501),{pid:501,ai:'codex',cmd:'/Applications/ChatGPT.app/Contents/Resources/codex exec --full-auto "fix tests"',since:new Date(2026,9,4,9,1,2).toISOString(),cwd:'/w/p1/t1',project:'p1',task:'t1'});
 assert.deepEqual(l.find(x=>x.pid===503).project,null);
 assert.equal(events.length,1);assert.equal(events[0].added.length,5);
 calls=[];await w.scan();assert.deepEqual(calls,['ps -axo pid=,ppid=,lstart=,command=']);assert.equal(events.length,1);
 ps=MAC.split('\n').filter(x=>!/^\s*501 /.test(x)).join('\n');
 await w.scan();assert.equal(events.length,2);assert.deepEqual(events[1].removed.map(x=>[x.pid,x.project,x.task]),[[501,'p1','t1']]);assert.equal(events[1].added.length,0);
 fail=true;await w.scan();await w.scan();assert.equal(w.list().length,4);assert.equal(logs.length,1);assert.match(logs[0],/ps/);
});

test('scan on linux reads /proc cwd',async()=>{
 const seen=[];
 const w=pw.create({platform:'linux',selfPid:42,exec:async(cmd,args)=>{assert.equal(cmd,'ps');assert.deepEqual(args,['-eo','pid=,ppid=,lstart=,args=']);return LINUX;},
  readlink:p=>{seen.push(p);if(p==='/proc/2003/cwd')throw new Error('EACCES');return '/w/p1';},projects:()=>[{id:'p1',dir:'/w/p1',tasks:[]}],baseOf:p=>p.dir});
 const l=await w.scan();
 assert.deepEqual(seen,['/proc/2001/cwd','/proc/2002/cwd','/proc/2003/cwd']);
 assert.deepEqual(l.map(x=>[x.pid,x.ai,x.project]),[[2001,'codex','p1'],[2002,'codex','p1'],[2003,'claude',null]]);
 assert.equal(l[2].cwd,'');
});


test('ps and lsof use five seconds; query and internal failures stay diagnostic while lsof failure keeps scanning',async()=>{
  let mode='ok';const w=pw.create({platform:'darwin',selfPid:900,log:()=>{},exec:async(cmd,args,opts)=>{assert.equal(opts.timeoutMs,5000);if(mode==='spawn')throw Object.assign(Error('PRIVATE'),{code:'ENOENT'});if(mode==='rows')return 'PRIVATE_BAD_ROW';if(mode==='empty')return '';if(cmd==='lsof'&&mode==='cwd')throw Object.assign(Error('PRIVATE'),{killed:true});return cmd==='ps'?MAC:'';}});
  await w.scan();assert.equal(w.status().state,'ok');for(const [value,code]of [['spawn','PROCWATCH_SPAWN_FAILED'],['rows','PROCWATCH_EMPTY'],['empty','PROCWATCH_EMPTY']]){mode=value;await w.scan();assert.equal(w.status().code,code);}
  const logs=[],lw=pw.create({platform:'darwin',selfPid:900,log:m=>logs.push(m),exec:async(cmd)=>{if(cmd==='lsof')throw Object.assign(Error('PRIVATE'),{killed:true});return MAC;}});await lw.scan();assert.equal(lw.status().state,'ok');assert.ok(lw.list().length>0);assert.ok(logs.some(m=>m.includes('lsof')));
  const internal=pw.create({platform:'linux',log:()=>{},exec:async()=>MAC,projects:()=>[{tasks:{}}],readlink:()=>'/work'});await internal.scan();assert.equal(internal.status().code,'PROCWATCH_INTERNAL');assert.equal(internal.status().detail.stage,'internal');assert.ok(internal.status().detail.message.length<=200);
});



test('default exec carries elapsed time, byte count and stderr without relaxing nonzero stdout behavior',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');let callback,options;
  const context=vm.createContext({require:name=>name==='child_process'?{execFile:(cmd,args,opts,cb)=>{options=opts;callback=cb;}}:require('node:module').createRequire(path.join(__dirname,'../lib/procwatch.js'))(name),module:{exports:{}},process,Buffer,Date,console,setTimeout,clearTimeout,setInterval,clearInterval,structuredClone});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib/procwatch.js'),'utf8')+'\nmodule.exports.testExec=defaultExec;',context);
  const run=context.module.exports.testExec;
  const first=run('synthetic',[],{timeoutMs:15000});assert.equal(options.timeout,15000);assert.equal(options.windowsHide,true);const original=Object.assign(Error('PRIVATE_COMMAND'),{code:'ENOENT'});callback(original,'許功','diagnostic');
  await assert.rejects(first,e=>e===original&&e.stderr==='diagnostic'&&e.stdoutBytes===6&&e.elapsedMs>=0);
  const partial=run('synthetic',[],{timeoutMs:5000});callback(Object.assign(Error('exit'),{code:1}),'usable','private');assert.equal(await partial,'usable');assert.equal(options.timeout,5000);
  const failed=run('synthetic',[],{timeoutMs:5000});callback(Object.assign(Error('exit'),{code:1}),'','diagnostic');await assert.rejects(failed,e=>e.code===1&&e.stdoutBytes===0);
});
test('later exception has INTERNAL code, preserves last good scan, and status copies cannot rewrite evidence',async()=>{
  let source='1 0 Sun Oct 4 11:22:33 2026 system',bad=false;const w=pw.create({platform:'linux',selfPid:900,log:()=>{},exec:async()=>source,readlink:()=>'/work',projects:()=>bad?[{tasks:{}}]:[]});await w.scan();const good=w.status().checkedAt;
  bad=true;source='2 0 Sun Oct 4 11:22:33 2026 codex';await w.scan();const status=w.status();
  assert.equal(status.code,'PROCWATCH_INTERNAL');assert.equal(status.checkedAt,good);assert.equal(typeof status.detail.message,'string');assert.ok(status.detail.message.length>0&&status.detail.message.length<=200&&!status.detail.message.includes('\n'));status.detail.code='changed';status.lastFailure.message='changed';assert.equal(w.status().detail.code,'PROCWATCH_INTERNAL');assert.notEqual(w.status().lastFailure.message,'changed');
});

test('listener exceptions are logged and never turn a good scan into an unknown state',async()=>{
  const logs=[];let source='1 0 Sun Oct 4 11:22:33 2026 system';const w=pw.create({platform:'linux',selfPid:900,log:m=>logs.push(m),exec:async()=>source,readlink:()=>'/work'});
  w.onChange(()=>{throw Error('synthetic listener failure');});await w.scan();source='2 0 Sun Oct 4 11:22:33 2026 codex';await w.scan();
  assert.equal(w.status().state,'ok');assert.deepEqual(w.list().map(x=>x.pid),[2]);assert.ok(logs.some(m=>m.includes('synthetic listener failure')));
});

test('preview snapshot reuse does not conceal a new unknown AI from fresh prepare scan',async t=>{
 let now=Date.now(),calls=0,unknown=false;t.mock.method(Date,'now',()=>now);
 const w=pw.create({platform:'linux',selfPid:900,exec:async()=>{calls++;return unknown?'2 0 Sun Oct 4 11:22:33 2026 codex':'1 0 Sun Oct 4 11:22:33 2026 system';},readlink:()=>'/unknown',projects:()=>[]});
 await w.scan();now=Date.parse(w.status().checkedAt);w.assertKnown();unknown=true;await w.scan({maxAgeMs:10000});assert.equal(calls,1);w.assertKnown();
 await w.scan();assert.equal(calls,2);assert.throws(()=>w.assertKnown(),{code:'PROCWATCH_UNASSIGNED_AI'});
 now=Date.parse(w.status().checkedAt)+10001;await w.scan({maxAgeMs:10000});assert.equal(calls,3);assert.throws(()=>w.scan({maxAgeMs:-1}));
});
