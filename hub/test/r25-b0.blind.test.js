'use strict';
// Round 25 blind acceptance, written from SPEC-R25 before reading the implementation.
// Expected: fails on candidate 25 (8a74509), passes on candidate 26. Provider-free, synthetic paths only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {EventEmitter}=require('node:events');
const hex64='a'.repeat(64),stamp=1800000000000;
const tmpHome=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r25-blind-'));t.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});return dir;};
function writeAuth(home,{scope='https://auth.x.ai::synthetic-client',key='synthetic.access.token-'+'x'.repeat(20),expiresAt=new Date(stamp+6*3600*1000).toISOString(),extra={}}={}){
  fs.mkdirSync(path.join(home,'.grok'),{recursive:true});
  fs.writeFileSync(path.join(home,'.grok','auth.json'),JSON.stringify({[scope]:{key,expires_at:expiresAt,refresh_token:'synthetic-refresh',...extra}}));
}

test('B1 owner token module reads key and exact expiry, prefers the OIDC scope, never throws from expiryOf',t=>{
  const owner=require('../lib/grok-owner-token');
  const home=tmpHome(t);writeAuth(home);
  const v=owner.readOwnerToken({home,now:stamp});
  assert.equal(v.key,'synthetic.access.token-'+'x'.repeat(20));assert.equal(v.expiresAt,stamp+6*3600*1000);assert.ok(Object.isFrozen(v));
  assert.deepEqual(owner.expiryOf({home,now:stamp}),{expiresAt:stamp+6*3600*1000,code:null});
  const minted=JSON.parse(owner.mintJson({home,now:stamp}));
  assert.deepEqual(minted,{access_token:v.key,expires_in:6*3600-60});
  const empty=tmpHome(t);
  assert.throws(()=>owner.readOwnerToken({home:empty}),{code:'GROK_OWNER_TOKEN_MISSING'});
  assert.equal(owner.expiryOf({home:empty}).expiresAt,null);
  const legacy=tmpHome(t);writeAuth(legacy,{scope:'https://accounts.x.ai/sign-in',key:'legacy-token-'+'y'.repeat(20)});
  assert.equal(owner.readOwnerToken({home:legacy,now:stamp}).key,'legacy-token-'+'y'.repeat(20));
});

const planOptions=()=>({actor:'grok',cwd:'D:\\Synthetic\\work',rootFingerprint:hex64,ownerHome:'C:\\Synthetic\\Users\\owner',
  runtimeBase:'C:\\Synthetic\\Users\\owner\\AppData\\Local\\ProjectHub',providerFile:'C:\\Synthetic\\Runtime\\grok\\grok.exe',
  codexFile:'C:\\Synthetic\\Runtime\\codex\\codex.exe',codexSHA256:hex64,nodeFile:'C:\\Synthetic\\Node\\node.exe',
  gitDirectory:'C:\\Synthetic\\Git',hubLibDirectory:'C:\\Synthetic\\Hub\\lib',providerArgs:[],
  proxyUrl:'http://hub:'+'0'.repeat(64)+'@127.0.0.1:1',systemRoot:'C:\\Windows'});
test('B2 the Grok launch plan keeps the credential inside the provider home and grants nothing under ~/.grok',()=>{
  const {createPlan}=require('../lib/provider-native-plan');
  const plan=createPlan(planOptions());
  assert.equal(plan.credentialFiles[0],plan.providerHome+'\\auth.json');
  assert.equal(plan.lockFile,plan.providerHome+'\\auth.json.lock');
  assert.equal(plan.env.GROK_AUTH_PATH,plan.credentialFiles[0]);
  assert.equal(plan.env.GROK_AUTH_PROVIDER_COMMAND,'grok-auth-helper-sandbox.cmd');assert.equal(plan.env.PATH.split(';').at(-1),'C:\\Synthetic\\Hub\\lib');
  assert.equal(plan.env.HUB_NODE,'C:\\Synthetic\\Node\\node.exe');
  const toml=plan.args.find(a=>a.startsWith('permissions.hub-native.filesystem='));
  assert.ok(toml);assert.doesNotMatch(toml,/\\\\\.grok\\\\auth\.json/,'no grant on the owner credential');assert.doesNotMatch(toml,/Users\\\\owner\\\\\.grok/);
});

test('B3 hydrator runs grok login --device-auth as the owner with the provider helper and reports hydrated',async t=>{
  const {createGrokHydrator}=require('../lib/grok-hydrate');
  const base=tmpHome(t),runtimeDirectory=path.join(base,'runtime'),providerHome=path.join(runtimeDirectory,'grok');
  const authPath=providerHome+'\\auth.json',lockPath=authPath+'.lock';
  const calls=[],records=[];let child;
  const h=createGrokHydrator({resolveGrok:async()=>'C:\\Synthetic\\Runtime\\grok\\grok.exe',nodeFile:'C:\\Synthetic\\Node\\node.exe',hubLibDirectory:'C:\\Synthetic\\Hub\\lib',
    restoreInheritance:async()=>true,
    env:{USERPROFILE:'C:\\Synthetic\\Users\\owner',PATH:'synthetic',HUB_LOCAL_TOKEN:'private',PROJECT_HUB_X:'private',HTTP_PROXY:'private',GROK_AUTH_EARLY_INVALIDATION_SECS:'9',GROK_HOME:'private'},
    record:(...a)=>records.push(a),now:()=>Date.now(),kill:()=>{}, // real clock: the hydrator compares the file mtime with its start time
    spawn:(file,args,options)=>{child=new EventEmitter();child.pid=321;calls.push({file,args,options});return child;}});
  const pending=h.hydrate({providerHome,authPath,lockPath,runtimeDirectory});
  await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);
  assert.equal(calls[0].file,'C:\\Synthetic\\Runtime\\grok\\grok.exe');assert.deepEqual(calls[0].args,['login','--device-auth']);
  const env=calls[0].options.env;
  assert.equal(env.GROK_HOME,path.win32.join(runtimeDirectory,'grok-hydrate'));assert.equal(env.GROK_AUTH_PATH,authPath);
  assert.equal(env.GROK_AUTH_PROVIDER_COMMAND,'grok-auth-helper-owner.cmd');assert.ok(env.PATH.startsWith('C:\\Synthetic\\Hub\\lib'));assert.equal(env.HUB_NODE,'C:\\Synthetic\\Node\\node.exe');
  for(const k of ['HUB_LOCAL_TOKEN','PROJECT_HUB_X','HTTP_PROXY','GROK_AUTH_EARLY_INVALIDATION_SECS'])assert.equal(k in env,false,k+' must not leak');
  assert.equal(calls[0].options.cwd,env.GROK_HOME);assert.equal(calls[0].options.stdio,'ignore');
  fs.mkdirSync(providerHome,{recursive:true});fs.writeFileSync(authPath,'{"synthetic":true}');
  child.emit('exit',0);
  const result=await pending;
  assert.equal(result.outcome,'hydrated');assert.equal(result.timedOut,false);assert.equal(fs.existsSync(lockPath),true,'lock is ensured');
  assert.ok(records.some(r=>r[0]==='grok-hydrate'&&r[1].outcome==='hydrated'));
  assert.doesNotMatch(JSON.stringify(records),/Synthetic|auth\.json|private/);
});

test('B4 token route answers only a fully authenticated POST and hands back exactly the minted JSON',async t=>{
  const {create}=require('../lib/grok-auth-route');
  const token='T'.repeat(43),runId='run-synthetic-0001';let minted=[];
  const route=create({port:4546,runId,token,mint:async o=>{minted.push(o);return {access_token:'synthetic.minted.'+'z'.repeat(30),expires_in:1234};},record:()=>{}});
  const server=http.createServer((req,res)=>route.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{route.close();server.close();});
  const port=server.address().port;
  const send=(headers,body='{"expired":true}')=>new Promise((resolve,reject)=>{const data=Buffer.from(body);const rq=http.request({host:'127.0.0.1',port,method:'POST',path:'http://127.0.0.1:4546/api/native/grok-token',agent:false,
    headers:{Host:'127.0.0.1:4546','X-Hub':'1','Content-Type':'application/json','Content-Length':data.length,'X-Hub-Grok-Run':runId,'X-Hub-Grok-Nonce':require('node:crypto').randomUUID(),...headers}},res=>{const c=[];res.on('data',d=>c.push(d));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(c).toString()}));});rq.on('error',reject);rq.end(data);});
  const ok=await send({Authorization:'Bearer '+token});
  assert.equal(ok.status,200);assert.deepEqual(JSON.parse(ok.body),{access_token:'synthetic.minted.'+'z'.repeat(30),expires_in:1234});assert.deepEqual(minted,[{expired:true}]);
  const bad=await send({Authorization:'Bearer '+'U'.repeat(43)});assert.equal(bad.status,403);assert.equal(minted.length,1);
  const noAuth=await send({});assert.equal(noAuth.status,403);
  const wrongRun=await send({Authorization:'Bearer '+token,'X-Hub-Grok-Run':'other-run-0000000'});assert.equal(wrongRun.status,403);
  route.close();const gone=await send({Authorization:'Bearer '+token});assert.equal(gone.status,410);
});

test('B5 the turn gate prefers the exact expiry over the mtime estimate',async t=>{
  const {createGrokTurnGate}=require('../lib/grok-turn-gate');
  const home=tmpHome(t);writeAuth(home);fs.utimesSync(path.join(home,'.grok','auth.json'),stamp/1000,stamp/1000); // mtime says fresh
  let expiresAt=stamp+10*60*1000;let calls=0;
  const gate=createGrokTurnGate({home,env:{},now:()=>stamp,record:()=>{},expiry:()=>({expiresAt}),autoRefresh:async()=>{calls++;expiresAt=stamp+6*3600*1000;return {outcome:'refreshed',timedOut:false};}});
  await gate();assert.equal(calls,1,'ten minutes left is expiring under the exact expiry, so a refresh ran');
  const blocked=createGrokTurnGate({home,env:{},now:()=>stamp,record:()=>{},expiry:()=>({expiresAt:stamp-1}),autoRefresh:null});
  await assert.rejects(blocked(),{code:'GROK_LOGIN_EXPIRED'});
});

test('B6 new codes, messages and the sandbox helper files exist',()=>{
  const {codeOf}=require('../lib/native-provider-diagnostic'),{messageFor}=require('../lib/native-provider-messages');
  assert.equal(codeOf({code:'GROK_LOGIN_HYDRATE_FAILED'}),'GROK_LOGIN_HYDRATE_FAILED');
  assert.match(messageFor('GROK_LOGIN_HYDRATE_FAILED'),/（代碼：GROK_LOGIN_HYDRATE_FAILED）$/);
  const lib=path.join(__dirname,'..','lib');
  for(const f of ['grok-auth-helper-sandbox.js','grok-auth-helper-sandbox.cmd','grok-auth-helper-owner.js','grok-auth-helper-owner.cmd'])assert.ok(fs.existsSync(path.join(lib,f)),f);
  const cmd=fs.readFileSync(path.join(lib,'grok-auth-helper-sandbox.cmd'),'utf8');
  assert.match(cmd,/%HUB_NODE%/);assert.match(cmd,/%~dp0grok-auth-helper-sandbox\.js/);assert.ok(cmd.includes('\r\n'),'cmd is CRLF');
});
