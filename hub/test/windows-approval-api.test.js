'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const win=process.platform==='win32'?test:test.skip;
win('Windows approval API requires browser auth, exact task, durable intent record and one-use token',{timeout:25000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-approval-api-')),bin=path.join(root,'bin'),dir=path.join(root,'Product','p');
 require('./helpers/codex-server').install(bin,{mode:'approval'});
 fs.mkdirSync(path.join(root,'_hub'),{recursive:true});fs.copyFileSync(path.join(__dirname,'../windows/roles.yaml'),path.join(root,'_hub','roles.yaml'));fs.mkdirSync(path.join(dir,'.ai/tasks'),{recursive:true});
 fs.writeFileSync(path.join(dir,'PROJECT.md'),'---\nname: p\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
 fs.writeFileSync(path.join(dir,'.ai/tasks/t.md'),'---\nid: t\ntitle: Synthetic\nowner: codex\nmodel: GPT-6.1-Sol\nstate: 未着手\n---\n');
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const secret='A'.repeat(43),child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,HUB_ROOT:root,HUB_PORT:String(port),HUB_DRY_RUN:'1',HUB_LOCAL_TOKEN:secret,HUB_AI_HOME:path.join(root,'home'),HUB_TRASH:path.join(root,'trash')},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/state')).status===401)break;}catch{}await new Promise(r=>setTimeout(r,25));}
 let cookie='';const post=(route,b,headers={})=>fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(b)});
 const login=await post('/api/local/login',{token:secret});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
 const started=await post('/api/chat/send',{project:'p',task:'t',ai:'codex',model:'GPT-6.1-Sol',effort:'高',text:'synthetic'});assert.equal(started.status,200,await started.clone().text());
 async function snapshot(){const abort=new AbortController();const res=await fetch(base+'/api/chat/stream?project=p&task=t',{headers:{Cookie:cookie},signal:abort.signal});const reader=res.body.getReader();let text='';try{while(!text.includes('\n\n')){const next=await reader.read();assert.equal(next.done,false);text+=Buffer.from(next.value);}return JSON.parse(text.split('\n').find(x=>x.startsWith('data:')).slice(5));}finally{abort.abort();await reader.cancel().catch(()=>{});}}
 let a;for(let i=0;i<100;i++){a=(await snapshot()).approvals?.[0];if(a)break;await new Promise(r=>setTimeout(r,25));}assert.ok(a);
 const body={project:'p',task:'t',token:a.token,decision:'accept'};
 assert.equal((await post('/api/chat/approval',body,{Cookie:'',Authorization:'Bearer '+a.token})).status,401);
 assert.equal((await post('/api/chat/approval',{...body,task:'other'})).status,409);
 assert.equal((await post('/api/chat/approval',{...body,decision:'acceptForSession'})).status,400);
 assert.equal((await post('/api/chat/approval',body,{Origin:'https://example.invalid'})).status,403);
 const log=path.join(root,'_hub','approvals.jsonl');fs.mkdirSync(log);
 assert.equal((await post('/api/chat/approval',body)).status,409,'audit write failure must not grant');assert.equal((await snapshot()).approvals[0].token,a.token);
 fs.rmdirSync(log);assert.equal((await post('/api/chat/approval',{...body,decision:'decline'})).status,200);
 assert.equal((await post('/api/chat/approval',body)).status,409,'replay must fail');
 const record=JSON.parse(fs.readFileSync(log,'utf8').trim());assert.equal(record.decision,'decline');assert.equal(record.phase,'requested');assert.match(record.tokenHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(record).includes(a.token));
});
