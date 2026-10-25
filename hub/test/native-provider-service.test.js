'use strict';
// Production composition with metadata, broker and child fixtures only. No
// existing credentials, native executable, model or network are accessed.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const path=require('node:path'),crypto=require('node:crypto');
const {NativeProviderService}=require('../lib/native-provider-service');
const {createPlan}=require('../lib/provider-native-plan'),{canonical}=require('../lib/providers/claude-protocol');
const sessionBindings=require('../lib/provider-session-binding');
const artifacts=require('../lib/native-cli-update'),safe=require('../lib/safe-path');
const host=require('../lib/provider-native-host'),egress=require('../lib/provider-egress');
const scoped=require('../lib/scoped-file');
const scope={actor:'grok',project:'synthetic',task:'t',model:'Grok 4.6',effort:'中'};
const binding={project:scope.project,task:scope.task,dir:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),run:'workspace-run'};
test('only explicit Claude CLI default may resolve to an empty model flag',async t=>{
 const f=fixture(t,{modelFlag:()=>''});f.settings.providerFile='C:\\Tools\\provider\\claude.exe';
 t.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?artifacts.KNOWN:host.PROVIDER_HASHES.claude);
 for(const request of [{...scope,actor:'claude',model:'unknown'},{...scope,model:'unknown'}])await assert.rejects(f.service.preview(request),{code:'NATIVE_PROFILE_UNAVAILABLE'});
 await assert.rejects(f.service.preview({...scope,actor:'claude',model:''}),{code:'NATIVE_APPROVAL_INVALID'});
 const request={...scope,actor:'claude',model:'CLI預設'},preview=await f.service.preview(request);assert.equal(preview.review.modelFlag,'');
 await f.service.approve({token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
 const plan=await f.service.prepareTurn({...f.options,ai:'claude',model:'CLI預設'});assert.equal(plan.modelFlag,'');assert.equal(plan.effortFlag,'medium');
 await f.service.cancel({actor:'claude',project:scope.project,task:scope.task});assert.equal(f.counts().reads,0);assert.equal(f.spawned(),0);
});
function fixture(t,callbacks={}){
  let inode=1n,network=0,closed=0,disposed=0,reads=0,spawned=0,identityCalls=0,runtimeFingerprint='b'.repeat(64),identityFailure=false;
  const settings={ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',providerFile:'C:\\Tools\\provider\\grok.exe',codexFile:'C:\\Tools\\codex\\codex.exe',codexSHA256:artifacts.KNOWN,
    nodeFile:process.execPath,gitDirectory:'C:\\Tools\\git',hubLibDirectory:'C:\\Tools\\hub\\lib',systemRoot:'C:\\Windows'};
  t.mock.method(scoped,'identity',async file=>{identityCalls++;assert.equal(file,settings.runtimeBase);assert.ok(file.startsWith('C:\\Users\\fixture\\AppData\\Local\\'));if(identityFailure)throw Error('synthetic private identity unavailable');return {rootFingerprint:runtimeFingerprint};});
  t.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?artifacts.KNOWN:host.PROVIDER_HASHES.grok);
  t.mock.method(safe,'localPath',file=>file);
  t.mock.method(fs,'lstatSync',(_file,opts)=>({isFile:()=>true,nlink:opts?.bigint?1n:1,size:opts?.bigint?123n:123,ino:inode,dev:1n,mtimeNs:10n}));
  t.mock.method(fs,'readFileSync',()=>{reads++;throw Error('CREDENTIAL_CONTENT_READ_FORBIDDEN');});
  t.mock.method(egress,'create',async()=>{network++;return {proxyUrl:'http://hub:'+'f'.repeat(64)+'@127.0.0.1:12345',snapshot:()=>({}),close:async()=>{closed++;}};});
  const service=new NativeProviderService({resolveWorkspace:async()=>binding,
    profile:()=>({...settings}),
    modelFlag:(_a,m)=>m==='Grok 4.6'?'grok-4.6':'',effortFlag:()=> 'medium',
    supervisedSpawn:()=>{spawned++;throw Error('NO_CHILD_EXPECTED');},dispose:async()=>{disposed++;},...callbacks
  });
  const options={ai:scope.actor,project:scope.project,task:scope.task,model:scope.model,effort:scope.effort,dir:binding.dir,nativeRootPin:{root:binding.dir,rootFingerprint:binding.rootFingerprint}};
  return {service,options,settings,changeIdentity:()=>{inode++;},changeRuntimeIdentity:()=>{runtimeFingerprint='c'.repeat(64);},failRuntimeIdentity:()=>{identityFailure=true;},identityCalls:()=>identityCalls,spawned:()=>spawned,counts:()=>({network,closed,disposed,reads})};
}
test('native service inspects only credential metadata, requires owner grant and prepares the real private factory',async t=>{
  const f=fixture(t);
  await assert.rejects(()=>f.service.prepareTurn(f.options),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
  assert.equal(f.counts().network,0);
  const preview=await f.service.preview(scope);
  assert.equal(preview.review.runtimeBase,f.settings.runtimeBase);
  assert.equal(preview.review.runtimeBaseFingerprint,'b'.repeat(64));
  assert.deepEqual(preview.review.authenticationRead,['C:\\Users\\fixture\\.grok\\auth.json']);
  assert.equal(preview.review.credentialContentVisibleToOwnCliTools,true);
  await f.service.approve({token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
  const plan=await f.service.prepareTurn(f.options);
  assert.equal(plan.modelFlag,'grok-4.6');assert.equal(plan.effortFlag,'medium');assert.equal(plan.maxWallMs,1800000);
  assert.deepEqual(plan.validatedAgentProfile.tools,['read_file','grep','search_replace','write','run_terminal_cmd','task','search_tool','use_tool']);
  assert.equal(f.counts().reads,0);assert.equal(f.counts().network,1);
  await f.service.cancel({actor:scope.actor,project:scope.project,task:scope.task});
  assert.equal(f.service.active(),0);assert.equal(f.counts().closed,1);
});
test('private runtimeBase is required before broker, credential content or endpoint creation',async t=>{
  const f=fixture(t);delete f.settings.runtimeBase;
  await assert.rejects(()=>f.service.preview(scope),{code:'NATIVE_PLAN_INVALID'});
  assert.equal(f.identityCalls(),0);assert.equal(f.spawned(),0);assert.equal(f.service.active(),0);
  assert.deepEqual(f.counts(),{network:0,closed:0,disposed:0,reads:0});
});
test('Claude runtime profile pins explicit restricted development tools and rejects the old default preset session',async t=>{
  const request={...scope,actor:'claude',model:'Sonnet'};
  const f=fixture(t,{modelFlag:(_actor,model)=>model==='Sonnet'?'sonnet':''});
  f.settings.providerFile='C:\\Tools\\provider\\claude.exe';
  t.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?artifacts.KNOWN:host.PROVIDER_HASHES.claude);
  const preview=await f.service.preview(request);
  const plan=createPlan({...f.settings,actor:request.actor,cwd:binding.dir,rootFingerprint:binding.rootFingerprint,maxWallMs:1800000,providerArgs:[],proxyUrl:'http://hub:'+'0'.repeat(64)+'@127.0.0.1:1'});
  const fixed={actor:request.actor,policyVersion:4,
    runtimeBase:plan.runtimeBase,runtimeBaseFingerprint:'b'.repeat(64),userProfileMode:'owner-home',stateDirectory:plan.stateDirectory,mcp:'controller-registered-only'};
  const hash=value=>'runtime-'+crypto.createHash('sha256').update(canonical(value)).digest('hex');
  const currentId=hash({...fixed,tools:require('../lib/claude-subagent-context').TOOLS});
  const previousId=hash({...fixed,tools:'native-default'});
  assert.equal(preview.review.runtimeProfileId,currentId);assert.notEqual(currentId,previousId);
  const oldScope={project:request.project,task:request.task,actor:request.actor,accountProfileId:preview.review.accountProfileId,rootFingerprint:binding.rootFingerprint,runtimeProfileId:previousId};
  const meta=sessionBindings.bind({},oldScope,'synthetic-session'),original=JSON.stringify(meta);
  assert.throws(()=>sessionBindings.resolve(meta,{...oldScope,runtimeProfileId:currentId}),{code:'SESSION_SCOPE_CHANGED'});
  assert.equal(JSON.stringify(meta),original);assert.equal(f.counts().reads,0);assert.equal(f.counts().network,0);
});
test('physical runtime identity failure rejects preview without reading auth or reserving a broker',async t=>{
  const f=fixture(t);f.failRuntimeIdentity();
  await assert.rejects(()=>f.service.preview(scope),{code:'NATIVE_PROFILE_UNAVAILABLE'});
  assert.equal(f.identityCalls(),1);assert.equal(f.spawned(),0);assert.equal(f.service.active(),0);
  assert.deepEqual(f.counts(),{network:0,closed:0,disposed:0,reads:0});
});
test('runtime identity fingerprint must be an own data lowercase hash without executing a getter',async t=>{
  let getterCalls=0;
  const cases={accessor:()=>Object.defineProperty({},'rootFingerprint',{enumerable:true,get(){getterCalls++;throw Error('synthetic-secret-marker');}}),inherited:()=>Object.create({rootFingerprint:'b'.repeat(64)}),uppercase:()=>({rootFingerprint:'B'.repeat(64)})};
  for(const [name,make]of Object.entries(cases))await t.test(name,async sub=>{
    const f=fixture(sub);sub.mock.method(scoped,'identity',async file=>{assert.equal(file,f.settings.runtimeBase);return make();});
    await assert.rejects(()=>f.service.preview(scope),error=>error.code==='NATIVE_PROFILE_UNAVAILABLE'&&!error.message.includes('synthetic-secret-marker'));
    assert.equal(f.spawned(),0);assert.equal(f.counts().network,0);assert.equal(f.counts().reads,0);
  });
  assert.equal(getterCalls,0);
});
test('current Grok shell and child-routing scope rejects both prior session profiles without replacing metadata',async t=>{
  const f=fixture(t),preview=await f.service.preview(scope),plan=createPlan({...f.settings,actor:scope.actor,cwd:binding.dir,rootFingerprint:binding.rootFingerprint,maxWallMs:1800000,providerArgs:[],proxyUrl:'http://hub:'+'0'.repeat(64)+'@127.0.0.1:1'});
  const fixed={actor:scope.actor,providerHash:host.PROVIDER_HASHES.grok,codexHash:plan.codexSHA256,provider:plan.providerFile,node:plan.nodeFile,git:plan.gitDirectory,hub:plan.hubLibDirectory};
  const common={tools:require('../lib/native-provider-service').GROK_PROFILE,mcp:'controller-registered-only'},hash=value=>'runtime-'+crypto.createHash('sha256').update(canonical(value)).digest('hex');
  const legacyId=hash({...fixed,policyVersion:3,...common});
  const previous={...fixed,policyVersion:4,runtimeBase:plan.runtimeBase,runtimeBaseFingerprint:'b'.repeat(64),userProfileMode:'owner-home',runtimeDirectory:plan.runtimeDirectory,stateDirectory:plan.stateDirectory,tempDirectory:plan.tempDirectory,mcpDirectory:plan.mcpDirectory,...common};
  const currentId=hash({actor:scope.actor,policyVersion:4,runtimeBase:plan.runtimeBase,runtimeBaseFingerprint:'b'.repeat(64),userProfileMode:'owner-home',stateDirectory:plan.stateDirectory,...common,subagentRouting:'runtime-parent-prompt-v2'});
  assert.equal(preview.review.runtimeProfileId,currentId);assert.notEqual(currentId,legacyId);
  const currentScope={actor:scope.actor,project:scope.project,task:scope.task,runtimeProfileId:currentId,accountProfileId:preview.review.accountProfileId,rootFingerprint:binding.rootFingerprint},legacyScope={...currentScope,runtimeProfileId:legacyId};
  const meta=sessionBindings.bind({sessions:{codex:'synthetic-codex-session'},preserved:'original'},legacyScope,'synthetic-grok-session'),before=JSON.stringify(meta);
  assert.equal(sessionBindings.resolve(meta,legacyScope).resume,true);
  assert.throws(()=>sessionBindings.resolve(meta,currentScope),{code:'SESSION_SCOPE_CHANGED'});
  assert.equal(JSON.stringify(meta),before);assert.equal(f.spawned(),0);assert.equal(f.counts().network,0);assert.equal(f.counts().reads,0);
  const previousScope={...currentScope,runtimeProfileId:hash(previous)},previousMeta=sessionBindings.bind({preserved:'original'},previousScope,'synthetic-previous-grok-session'),previousBytes=JSON.stringify(previousMeta);
  assert.equal(sessionBindings.resolve(previousMeta,previousScope).resume,true);
  assert.throws(()=>sessionBindings.resolve(previousMeta,currentScope),{code:'SESSION_SCOPE_CHANGED'});
  assert.equal(JSON.stringify(previousMeta),previousBytes);
  const previousRoutingScope={...currentScope,runtimeProfileId:hash({...previous,subagentRouting:'runtime-parent-prompt-v1',shellSearch:plan.env.PATH})};
  const routingMeta=sessionBindings.bind({},previousRoutingScope,'synthetic-old-child-route');
  assert.throws(()=>sessionBindings.resolve(routingMeta,currentScope),{code:'SESSION_SCOPE_CHANGED'});
});
test('runtime base path or physical identity changes invalidate an unused owner preview',async t=>{
  for(const change of ['path','identity'])await t.test(change,async sub=>{
    const f=fixture(sub),preview=await f.service.preview(scope);
    if(change==='path')f.settings.runtimeBase='C:\\Users\\fixture\\AppData\\Local\\Packages\\SyntheticFamily_456\\LocalCache\\Local\\ProjectHub';else f.changeRuntimeIdentity();
    const current=await f.service.preview(scope);
    assert.notEqual(current.review.runtimeProfileId,preview.review.runtimeProfileId);
    assert.equal(current.review.accountProfileId,preview.review.accountProfileId,'Only runtime scope changed');
    await assert.rejects(()=>f.service.approve({token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true}),{code:'NATIVE_APPROVAL_CHANGED'});
    assert.equal(f.spawned(),0);assert.equal(f.service.active(),0);assert.equal(f.counts().network,0);assert.equal(f.counts().reads,0);
  });
});
test('runtime base path or physical identity changes invalidate an existing grant before broker or endpoint creation',async t=>{
  for(const change of ['path','identity'])await t.test(change,async sub=>{
    const f=fixture(sub),preview=await f.service.preview(scope);
    await f.service.approve({token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
    if(change==='path')f.settings.runtimeBase='C:\\Users\\fixture\\AppData\\Local\\Packages\\SyntheticFamily_456\\LocalCache\\Local\\ProjectHub';else f.changeRuntimeIdentity();
    await assert.rejects(()=>f.service.prepareTurn(f.options),{code:'NATIVE_APPROVAL_CHANGED'});
    assert.equal(f.spawned(),0);assert.equal(f.service.active(),0);assert.equal(f.counts().network,0);assert.equal(f.counts().reads,0);
  });
});
test('credential refresh preserves account profile and owner grant without reading credential bytes',async t=>{
  const f=fixture(t),p=await f.service.preview(scope);
  await f.service.approve({token:p.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
  f.changeIdentity();const refreshed=await f.service.preview(scope);assert.equal(refreshed.review.accountProfileId,p.review.accountProfileId);
  await f.service.prepareTurn(f.options);assert.equal(f.counts().network,1);assert.equal(f.counts().reads,0);
  await f.service.cancel({actor:scope.actor,project:scope.project,task:scope.task});
});

test('hardlinked provider or sandbox is refused during preview before broker, auth content or endpoint creation',async t=>{
  for(const binary of ['grok.exe','codex.exe']){
    await t.test(binary,async sub=>{
      const f=fixture(sub),stat=fs.lstatSync;
      sub.mock.method(fs,'lstatSync',(file,opts)=>({...stat(file,opts),...(file.endsWith(binary)?{nlink:opts?.bigint?2n:2}:{})}));
      await assert.rejects(()=>f.service.preview(scope),{code:'NATIVE_PROFILE_UNAVAILABLE'});
      assert.deepEqual(f.counts(),{network:0,closed:0,disposed:0,reads:0});assert.equal(f.service.active(),0);
    });
  }
});

test('automatic scope decisions are recorded before respond, reentrant exactly once, cross-run remains pending',t=>{
  const context={actor:'claude',project:scope.project,task:scope.task,runId:'run-synthetic',dir:binding.dir,modelFlag:'sonnet'},events=[];
  const f=fixture(t,{toolPolicyFor:()=>({root:binding.dir,modelFlag:'sonnet',commandsApproved:true,subagentsApproved:true,mcpTools:['mcp__hub__hub_get_task']}),recordDecision:(_context,row,decision)=>events.push([row.token,decision])});
  const make=(token,runId,toolName,input)=>({...context,runId,token,detail:JSON.stringify({toolName,input})});
  const pending=[make('command',context.runId,'Bash',{command:'node --version'}),make('mcp',context.runId,'mcp__hub__hub_get_task',{}),make('unknown',context.runId,'FutureTool',{}),make('foreign','other','Bash',{command:'node --version'})];
  let handler,killed=0;const responses=[];
  const child={listApprovals:()=>pending.slice(),kill:()=>{killed++;},respond:(token,answer)=>{assert.equal(events.at(-1)[0],token);responses.push([token,answer]);pending.splice(pending.findIndex(r=>r.token===token),1);handler(child,context,pending.slice());}};
  handler=f.service.handlers().claude.onApprovals;handler(child,context,pending.slice());
  assert.deepEqual(responses,[['command','accept'],['mcp','accept']]);assert.equal(killed,0);assert.deepEqual(pending.map(r=>r.token),['unknown','foreign']);
});

test('CLI default auto-approval uses the validated reported model and rejects an invalid report',t=>{
 const context={actor:'claude',project:scope.project,task:scope.task,runId:'run',dir:binding.dir,modelFlag:''};let captured,killed=0;
 const f=fixture(t,{toolPolicyFor:c=>{captured=c;return {root:binding.dir,modelFlag:c.modelFlag,commandsApproved:true,subagentsApproved:true,mcpTools:[]};}});
 const rows=[{...context,token:'command',detail:JSON.stringify({toolName:'Bash',input:{command:'node --version'}})}],responses=[];
 const child={reportedModel:'claude-fable-5-1',listApprovals:()=>rows,kill:()=>killed++,respond:(...args)=>responses.push(args)};
 f.service.handlers().claude.onApprovals(child,context,rows);
 assert.equal(captured.modelFlag,'claude-fable-5-1');assert.equal(context.modelFlag,'');assert.deepEqual(responses,[['command','accept']]);
 child.reportedModel='grok-4.6';f.service.handlers().claude.onApprovals(child,context,rows);assert.equal(killed,1);assert.equal(responses.length,1);
});

test('audit failure kills before any tool permission is accepted',t=>{
  let killed=0,accepted=0;
  const f=fixture(t,{toolPolicyFor:()=>({root:binding.dir,modelFlag:'sonnet',commandsApproved:true,subagentsApproved:true,mcpTools:[]}),recordDecision:()=>{throw Error('synthetic audit failure');}});
  const context={actor:'claude',project:scope.project,task:scope.task,runId:'run'},row={...context,token:'test',detail:JSON.stringify({toolName:'Bash',input:{command:'node --version'}})};
  f.service.handlers().claude.onApprovals({listApprovals:()=>[row],kill:()=>{killed++;},respond:()=>{accepted++;}},context,[row]);
  assert.equal(killed,1);assert.equal(accepted,0);
});


test('identity ignores refresh metadata and installation slots but retains credential location and volume',async t=>{
  for(const actor of ['claude','grok'])await t.test(actor,async sub=>{
    const f=fixture(sub,{modelFlag:()=>actor==='claude'?'sonnet':'grok-4.6'}),request={...scope,actor};
    sub.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?artifacts.KNOWN:host.PROVIDER_HASHES[actor]);
    f.settings.providerFile='C:\\Tools\\slot1\\'+actor+'.exe';
    const first=(await f.service.preview(request)).review,stat=fs.lstatSync;
    sub.mock.method(fs,'lstatSync',(file,opts)=>({...stat(file,opts),ino:999n,size:opts?.bigint?456n:456,mtimeNs:99999n}));
    f.settings.providerFile='C:\\Tools\\slot2\\'+actor+'.exe';f.settings.codexFile='C:\\Tools\\slot2\\codex.exe';
    f.settings.nodeFile='C:\\Tools\\slot2\\node.exe';f.settings.gitDirectory='C:\\Tools\\slot2\\git';f.settings.hubLibDirectory='C:\\Tools\\slot2\\hub\\lib';
    const next=(await f.service.preview(request)).review;
    assert.equal(next.accountProfileId,first.accountProfileId);assert.equal(next.runtimeProfileId,first.runtimeProfileId);
    if(process.platform==='win32'){f.settings.ownerHome='C:\\Users\\FIXTURE';assert.equal((await f.service.preview(request)).review.accountProfileId,first.accountProfileId);}
    sub.mock.method(scoped,'identity',async()=>({rootFingerprint:'b'.repeat(64)}));
    const originalBase=f.settings.runtimeBase;f.settings.runtimeBase=originalBase.replace('fixture','other');
    f.settings.ownerHome='C:\\Users\\other';assert.notEqual((await f.service.preview(request)).review.accountProfileId,first.accountProfileId);
    f.settings.runtimeBase=originalBase;f.settings.ownerHome='C:\\Users\\fixture';sub.mock.method(fs,'lstatSync',(file,opts)=>({...stat(file,opts),dev:2n}));
    assert.notEqual((await f.service.preview(request)).review.accountProfileId,first.accountProfileId);assert.equal(f.counts().reads,0);
    sub.mock.method(artifacts,'digestFile',()=> '0'.repeat(64));await assert.rejects(f.service.preview(request),{code:'NATIVE_PROFILE_UNAVAILABLE'});
    assert.equal(f.counts().network,0);assert.equal(f.spawned(),0);
  });
});
test('credential and lock metadata checks still fail closed',async t=>{
  for(const kind of ['not-file','hardlink','oversize','lock'])await t.test(kind,async sub=>{
    const f=fixture(sub),stat=fs.lstatSync;
    sub.mock.method(fs,'lstatSync',(file,opts)=>{
      const value=stat(file,opts);if(kind==='lock'&&!opts?.bigint)return {...value,nlink:2};
      if(!file.endsWith('auth.json'))return value;
      return {...value,...(kind==='not-file'?{isFile:()=>false}:kind==='hardlink'?{nlink:2n}:kind==='oversize'?{size:4n*1024n*1024n+1n}:{})};
    });
    await assert.rejects(f.service.preview(scope),{code:'NATIVE_PROFILE_UNAVAILABLE'});assert.equal(f.counts().reads,0);assert.equal(f.counts().network,0);
  });
});

test('explicit Grok CLI default passes approval and runtime with an empty flag; unknown stays refused',async t=>{
 const f=fixture(t,{modelFlag:()=>''}),request={...scope,model:'CLI預設'};
 await assert.rejects(f.service.prepareTurn({...f.options,model:'CLI預設'}),{code:'NATIVE_PROVIDER_APPROVAL_REQUIRED'});
 const preview=await f.service.preview(request);assert.equal(preview.review.modelFlag,'');
 await f.service.approve({token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
 const plan=await f.service.prepareTurn({...f.options,model:'CLI預設'});assert.equal(plan.modelFlag,'');assert.equal(plan.effortFlag,'medium');
 await f.service.cancel({actor:'grok',project:scope.project,task:scope.task});assert.equal(f.counts().reads,0);assert.equal(f.spawned(),0);
 await assert.rejects(f.service.preview({...scope,model:'unknown'}),{code:'NATIVE_PROFILE_UNAVAILABLE'});
});

test('Grok CLI default policy uses the reported model and rejects missing or malformed model reports',t=>{
 const context={actor:'grok',project:scope.project,task:scope.task,runId:'run',dir:binding.dir,modelFlag:''};let captured,killed=0;
 const f=fixture(t,{toolPolicyFor:c=>{captured=c;return null;}}),child={reportedModel:'Grok-4.7:fast',kill:()=>killed++};
 const rows=[{...context,token:'command',detail:'{}'}];
 f.service.handlers().grok.onApprovals(child,context,rows);assert.equal(captured.modelFlag,'Grok-4.7:fast');assert.equal(context.modelFlag,'');
 for(const model of [undefined,'','grok space','bad/model','x'.repeat(257)]){child.reportedModel=model;captured=null;f.service.handlers().grok.onApprovals(child,context,rows);assert.equal(captured,null);}
 assert.equal(killed,5);
});

test('CLI default ignores the empty approval list a failing bridge publishes and never re-enters kill',t=>{
 for(const actor of ['claude','grok']){
  const context={actor,project:scope.project,task:scope.task,runId:'run',dir:binding.dir,modelFlag:''};let kills=0,policies=0;
  const f=fixture(t,{toolPolicyFor:()=>{policies++;return null;}}),handler=f.service.handlers()[actor].onApprovals;
  // A bridge's kill() fails the turn, clears pending approvals and synchronously publishes [] again.
  const child={reportedModel:undefined,listApprovals:()=>[],kill:()=>{kills++;if(kills<50)handler(child,context,[]);}};
  handler(child,context,[]);assert.equal(kills,0);assert.equal(policies,0);
  handler(child,context,[{...context,token:'pending',detail:'{}'}]);assert.equal(kills,1,actor+' kills once for a real request without a reported model');
 }
});

test('native describe binds the 0.164.0 helper hash without changing provider pins',async t=>{
 const f=fixture(t),hash=require('../lib/codex-versions').reviewed('0.164.0').binaryHash;f.settings.codexSHA256=hash;
 t.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?hash:host.PROVIDER_HASHES.grok);
 const preview=await f.service.preview(scope);assert.equal(preview.review.codexSHA256,hash);assert.equal(preview.review.providerSHA256,host.PROVIDER_HASHES.grok);assert.equal(f.spawned(),0);
});

test('one authorize reuses resolved binding and runtime identity; final rebind remains fresh',async t=>{
 let resolves=0;const f=fixture(t,{resolveWorkspace:async()=>{resolves++;return binding;}});
 const p=await f.service.preview(scope);await f.service.approve({token:p.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
 const before=resolves,identities=f.identityCalls();await f.service.prepareTurn(f.options);assert.equal(resolves-before,2);assert.equal(f.identityCalls()-identities,1);await f.service.cancel({actor:scope.actor,project:scope.project,task:scope.task});
});
