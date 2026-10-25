'use strict';
// Regression coverage for controller lifetime and native runtime contracts.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events'),{WorkspaceRuntime}=require('../lib/workspace-runtime');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const win=process.platform==='win32'?test:test.skip;
function runtime(t,{ttlMs=80}={}){let binding=null,busy=null,queue=[],released=0;const review={permits:new Map([['permit',{record:{secrets:{files:[]}}}]]),async consumeRun({permit}){this.permits.delete(permit);return binding={run:'run',dir:process.cwd(),mode:'isolated',supplyId:null};},binding:()=>binding,async verifiedBinding(){return binding;},async releaseRun(){released++;binding=null;}};
  const chats={busy:()=>busy,queue:()=>queue,stop(){busy=null;}};
  const rt=new WorkspaceRuntime({review,chats,sessions:{stop(){}},store:{},stopExtra:async()=>({stopped:true,treeExited:true}),warm:{ttlMs,eligible:()=>true,check:async()=>{},parkCheck:()=>true},onError:()=>{}});
  t.after(async()=>{busy=null;queue=[];review.releaseRun=async()=>{released++;binding=null;};for(const x of rt.flows.values()){x.children.clear();x.starting=false;await rt.finish(x.id);}});
  return {rt,review,setBusy:v=>busy=v,setQueue:v=>queue=v,get released(){return released;},begin:o=>rt.begin({project:'p',task:'t',kind:'chat',...o}),start(){return this.begin({permit:'permit'});}};}

test('a held flow whose light verification failed starts its next start with a fresh deadline',async t=>{
  const f=runtime(t),x=await f.start();f.setQueue([{id:'q',text:'排隊中'}]);f.rt.hold(x.id);
  const verified=f.review.verifiedBinding;f.review.verifiedBinding=async()=>{throw Error('light refusal');};
  await assert.rejects(f.begin(),/light refusal/);assert.equal(x.starting,false);assert.equal(x.startAt,0);assert.equal(x.startTimer,null);
  await sleep(120);f.review.verifiedBinding=verified;assert.equal(await f.begin(),x);await sleep(40);
  assert.equal(f.released,0,'the successful start is not killed by the old deadline');assert.equal(f.rt.flows.size,1);
});

test('a verification-blocked held flow is retained past the start deadline',async t=>{
  const f=runtime(t),x=await f.start();f.rt.hold(x.id);f.review.verifiedBinding=async()=>{throw Error('source changed');};
  await assert.rejects(f.begin({verifySource:true}),/source changed/);await sleep(200);
  assert.equal(f.released,0);assert.equal(f.rt.summary('p','t').state,'verification-blocked');
});

test('an expired start deadline that stays busy re-checks at a bounded interval, not every millisecond',async t=>{
  const f=runtime(t,{ttlMs:40}),x=await f.start(),delays=[],original=global.setTimeout;
  t.mock.method(global,'setTimeout',(fn,ms,...rest)=>{delays.push(ms);return original(fn,ms,...rest);});
  f.setBusy({phase:'pending'});await sleep(300);t.mock.restoreAll();f.setBusy(null);
  assert.ok(delays.filter(ms=>ms<=1).length<=1,`1 ms re-arms: ${delays.filter(ms=>ms<=1).length}`);assert.ok(x.starting);
});

test('reserve refuses a flow whose cleanup failed',async t=>{
  const f=runtime(t),x=await f.start();x.starting=false;x.cleanupErrorCode='WORKSPACE_CLEANUP_FAILED';
  assert.equal(f.rt.reserve(x.id),false);assert.equal(x.starting,false);delete x.cleanupErrorCode;
});

test('the kind-switch refusal is a 409 that started nothing',async t=>{
  const f=runtime(t),x=await f.start();f.rt.track(x,new EventEmitter());
  await assert.rejects(f.rt.begin({project:'p',task:'t',kind:'terminal'}),e=>e.status===409&&e.notStarted===true&&/另一種/.test(e.message));
});

win('status keeps the virtualization warning first when current.json is also unverifiable',t=>{
  const os=require('node:os'),tool=require('../windows/native-install.cjs'),tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-installer-status-')));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const base=path.join(tmp,'ProjectHub'),dataRoot=path.join(tmp,'AI-Workspace');fs.mkdirSync(base);fs.mkdirSync(dataRoot);fs.writeFileSync(path.join(base,'current.json'),'{}');
  const i=new tool.Installer({installBase:base,dataRoot,packageContext:()=>null,realpath:file=>path.basename(file).startsWith('.hub-write-probe-')?path.join(tmp,'Packages','Example_0000000000000','LocalCache',path.basename(file)):fs.realpathSync.native(file)});
  const status=i.status();assert.equal(status.virtualized,true);assert.equal(status.installed,null);assert.match(status.warning,/^目前在封裝/);assert.match(status.warning,/不代表尚未安裝/);
});

win('a chat tripwire never leaves a secret staged by add -A',{timeout:300000},async t=>{
  const {fixture}=require('./helpers/warm-git-fixture'),f=fixture(t),{createHash}=require('node:crypto'),secret=require('../lib/scoped-secret'),inspect=secret.inspect;
  // The .env candidate is read through the secret broker; stub it like broker-stub's inspect option.
  secret.inspect=async({root,path:relative})=>{const file=path.join(root,relative),data=fs.readFileSync(file),st=fs.statSync(file,{bigint:true});return {bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),fileFingerprint:createHash('sha256').update(String(st.dev)+':'+String(st.ino)).digest('hex')};};t.after(()=>{secret.inspect=inspect;});
  fs.writeFileSync(path.join(f.base,'.gitignore'),'');f.git('add','.gitignore');f.git('commit','-qm','info exclude only');
  const exclude=path.join(f.base,'.git/info/exclude');fs.writeFileSync(exclude,'.ai/chat/\n');fs.writeFileSync(path.join(f.base,'.env'),'TOKEN=synthetic\n');
  const pv=await f.ws.preview('p','a'),call=f.ws.call.bind(f.ws);let removed=false,afterAdd=null;
  f.ws.call=(dir,args,...rest)=>{if(!removed&&args[0]==='add'){removed=true;fs.writeFileSync(exclude,'');const out=call(dir,args,...rest);afterAdd=f.git('diff','--cached','--name-only');return out;}return call(dir,args,...rest);};
  const result=await f.apply(pv);f.ws.call=call;assert.equal(result.ok,false);assert.match(afterAdd,/^\.env$/m,'add -A must really stage .env, otherwise this test proves nothing');
  assert.match(result.error,/；已取消暫存，未建立保存 commit/);assert.doesNotMatch(result.error,/無法確認/);
  assert.doesNotMatch(f.git('diff','--cached','--name-only'),/\.env/);assert.equal(f.git('ls-files','--stage','--','.ai/chat'),'');
});

win('the installer helper works on the very first use in a fresh runtime, also with concurrent first users',{timeout:300000},async t=>{
  const os=require('node:os'),{spawn}=require('node:child_process'),tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'hub-installer-helper-'))),hub=path.join(tmp,'hub');
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true,maxRetries:20,retryDelay:50}));
  for(const dir of ['lib','windows'])fs.cpSync(path.join(__dirname,'..',dir),path.join(hub,dir),{recursive:true});
  const run=()=>new Promise(resolve=>{const child=spawn(process.execPath,['-e',"process.stdout.write(JSON.stringify(require('./windows/native-install.cjs').native({mode:'package-context'})))"],{cwd:hub,windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('close',code=>resolve({code,out,err}));});
  const first=await run();assert.equal(first.code,0,first.err);assert.equal(JSON.parse(first.out).ok,true);
  fs.rmSync(path.join(hub,'.runtime'),{recursive:true,force:true});
  const results=await Promise.all([run(),run(),run()]);for(const r of results){assert.equal(r.code,0,r.err);assert.equal(JSON.parse(r.out).ok,true);}
  for(const name of fs.readdirSync(path.join(hub,'.runtime')).filter(n=>/^install-files-.*\.exe$/.test(n)))assert.equal(fs.statSync(path.join(hub,'.runtime',name)).nlink,1);
});
