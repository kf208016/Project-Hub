'use strict';
const {waitForHub,waitFor}=require('./helpers/wait-hub');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process');
// Agent:false avoids keeping fetch's global pool alive during Windows shutdown.
const fetch=(url,options={})=>new Promise((resolve,reject)=>{const req=http.request(url,{method:options.method||'GET',headers:options.headers||{},agent:false},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(body),text:async()=>body,clone(){return this;},headers:{get:name=>{const value=res.headers[name.toLowerCase()];return Array.isArray(value)?value.join(';'):value;}}}));});req.setTimeout(45000,()=>req.destroy(Error('Synthetic HTTP request timed out: '+new URL(url).pathname)));req.on('error',reject);req.end(options.body);});
// Two complete Windows native workspace transactions share this fixture. Each
// request retains the formal harness's 45s limit; the aggregate budget covers
// both actors even when HANDLE brokers are slowed by host file scanning.
test('production native owner gates and real Chat routes reach approval without credentials or provider launch',{timeout:180000},async t=>{
  if(process.platform!=='win32')return;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-native-owner-gates-'));let child;
  t.after(async()=>{if(child){child.kill();if(child.exitCode===null)await new Promise(r=>child.once('close',r));}const absolute=fs.realpathSync(root);assert.equal(path.dirname(absolute).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(absolute).startsWith('hub-native-owner-gates-'));fs.rmSync(absolute,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'_hub'));fs.copyFileSync(path.join(__dirname,'../../docs/project-hub/templates/_hub/roles.yaml'),path.join(root,'_hub/roles.yaml'));
  const pdir=path.join(root,'Product/synthetic');fs.mkdirSync(path.join(pdir,'.ai/tasks'),{recursive:true});
  fs.writeFileSync(path.join(pdir,'PROJECT.md'),'---\nname: synthetic\nstatus: 進行中\nphases: []\nfolders: {}\nrelated: []\n---\n');
  for(const actor of ['claude','grok'])fs.writeFileSync(path.join(pdir,'.ai/tasks',actor+'.md'),'---\nid: '+actor+'\ntitle: Synthetic approval regression\nowner: '+(actor==='claude'?'claude-code':'grok')+'\nmodel: '+(actor==='claude'?'Sonnet':'Grok 4.6')+'\neffort: 中\nworkspaceMode: direct\nstate: 未着手\n---\n');
  const empty=path.join(root,'empty-git-config'),templates=path.join(root,'empty-git-template');fs.writeFileSync(empty,'');fs.mkdirSync(templates);
  const git=require('../lib/cli-platform').find('git'),gitEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('GIT_')));Object.assign(gitEnv,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty,GIT_CONFIG_COUNT:'0'});
  for(const args of [['init','--template='+templates],['add','.'],['-c','user.name=Synthetic','-c','user.email=synthetic@invalid','commit','-m','synthetic baseline']])execFileSync(git,args,{cwd:pdir,env:gitEnv,windowsHide:true,stdio:'ignore'});
  const port=await new Promise(r=>{const s=http.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const secret=crypto.randomBytes(32).toString('base64url'),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('HUB_'))delete env[k];
  Object.assign(env,{HUB_ROOT:root,HUB_TRASH:path.join(root,'trash'),HUB_AI_HOME:path.join(root,'empty-home'),HUB_PORT:String(port),HUB_LOCAL_TOKEN:secret,HUB_DRY_RUN:'0'});
  // Actual non-DRY HTTP composition, Git and workspace helpers; inventory is
  // explicitly synthetic. The worker host, external egress and auth reads are
  // hard denied before import. This is never a live-model acceptance rerun.
  const boot="const fs=require('node:fs'),p=require('node:path'),base=p.dirname(process.argv[1]),read=fs.readFileSync;fs.readFileSync=function(f,...a){const name=typeof f==='string'?f.split(String.fromCharCode(92)).join('/').toLowerCase():'';if(name.endsWith('/.claude/.credentials.json')||name.endsWith('/.claude.json')||name.endsWith('/.grok/auth.json'))throw Error('PROVIDER_AUTH_READ_FORBIDDEN');return read.call(this,f,...a)};require(p.join(base,'lib/provider-native-host')).launch=()=>{throw Error('PROVIDER_SPAWN_FORBIDDEN')};require(p.join(base,'lib/provider-egress')).create=()=>{throw Error('PROVIDER_NETWORK_FORBIDDEN')};require(p.join(base,'test/helpers/owned-native-fixture')).freshInventory();require(process.argv[1]).server.listen(Number(process.env.HUB_PORT),'127.0.0.1',()=>console.log('HUB_LISTENING'));";
  child=spawn(process.execPath,['-e',boot,path.join(__dirname,'../server.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stderr.on('data',b=>diagnostic+=b);
  const base='http://127.0.0.1:'+port,post=async(route,body,headers={})=>{
    const started=Date.now();
    try{return await fetch(base+route,{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
    finally{if(Date.now()-started>=1000)t.diagnostic('Synthetic route '+route+' elapsedMs='+(Date.now()-started));}
  };
  await waitForHub(base,child,()=>diagnostic);
  const invalid={actor:'codex',project:'synthetic',task:'task',model:'Sonnet',effort:'中'};
  assert.equal((await post('/api/native-provider/preview',invalid)).status,409);
  const login=await post('/api/local/login',{token:secret});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const bearer='Bearer '+'B'.repeat(43),browser={};
  for(const route of ['/api/native-provider/preview','/api/native-provider/approve','/api/native-provider/revoke','/api/workspace-destination/preview','/api/workspace-destination/approve']){
    assert.equal((await post(route,{}, {Authorization:bearer})).status,403);
    assert.equal((await post(route,{}, {...browser,Authorization:bearer})).status,403);
    assert.equal((await post(route,{}, {...browser,'X-Forwarded-For':'127.0.0.1'})).status,403);
    assert.equal((await post(route,{}, {...browser,Origin:'https://foreign.invalid'})).status,403);
  }
  const response=await post('/api/native-provider/preview',invalid,browser);assert.equal(response.status,409);const invalidData=await response.json();assert.equal(invalidData.error.includes(secret),false);assert.equal(invalidData.code,'NATIVE_APPROVAL_INVALID');
  for(const actor of ['claude','grok'])for(const privateField of ['runtimeBase','runtimeBaseFingerprint','ownerHome','providerFile','profile']){
    const scope={actor,project:'synthetic',task:actor,model:actor==='claude'?'Sonnet':'Grok 4.6',effort:'中'};
    const injected=await post('/api/native-provider/preview',{...scope,[privateField]:'synthetic-caller-override'},browser);
    assert.equal(injected.status,409);const rejected=await injected.json();assert.equal(rejected.code,'NATIVE_APPROVAL_INVALID');
    assert.equal(rejected.error.includes('synthetic-caller-override'),false);assert.equal(rejected.error.includes(secret),false);
  }
  for(const actor of ['claude','grok']){
    const scope={project:'synthetic',task:actor,actor},body={project:scope.project,task:scope.task,ai:actor,model:actor==='claude'?'Sonnet':'Grok 4.6',effort:'中',text:'Synthetic request; model execution is hard disabled.'};
    const first=await post('/api/chat/send',body,browser);assert.equal(first.status,409);assert.equal((await first.json()).code,'WORKSPACE_REQUIRED');
    const preview=await post('/api/task/workspace/preview',{...scope,secrets:[]},browser);assert.equal(preview.status,200,await preview.clone().text());
    const prepared=await post('/api/task/workspace/prepare',{...scope,token:(await preview.json()).token,confirm:true,ackReadLimits:true,ackNetworkLimits:true,skipHooks:false},browser);assert.equal(prepared.status,200,await prepared.clone().text());
    try{
      const challenged=await post('/api/chat/send',{...body,workspacePermit:(await prepared.json()).permit},browser);assert.equal(challenged.status,409);const challenge=await challenged.json();assert.equal(challenge.code,'NATIVE_PROVIDER_APPROVAL_REQUIRED',challenge.error);assert.equal(challenge.actor,actor);assert.equal(challenge.notStarted,true);
      const meta=path.join(pdir,'.ai/chat',actor+'.jsonl');assert.equal(fs.existsSync(meta),false,'No model prompt/history accepted before owner grant');
    }finally{const close=await post('/api/task/workspace/close',{project:scope.project,task:scope.task,confirm:true},browser);assert.equal(close.status,200,await close.clone().text());}
  }
  assert.equal(child.exitCode,null);assert.equal(diagnostic.includes('PROVIDER_AUTH_READ_FORBIDDEN'),false);assert.equal(diagnostic.includes('PROVIDER_SPAWN_FORBIDDEN'),false);assert.equal(diagnostic.includes(secret),false);
});
