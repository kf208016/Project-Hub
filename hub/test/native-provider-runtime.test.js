'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeProviderRuntime, NativeRuntimeError } = require('../lib/native-provider-runtime');

function makeBinding(overrides = {}) {
  return {
    project: 'proj1',
    task: 'task1',
    dir: 'C:\\Synthetic\\workspace',
    rootFingerprint: 'a'.repeat(64),
    workspaceRun: 'run-1',
    ...overrides
  };
}

function makeDescriptor(actor, overrides = {}) {
  const scope = {
    project: 'proj1',
    task: 'task1',
    actor,
    runtimeProfileId: 'rp1',
    accountProfileId: 'ap1',
    rootFingerprint: 'a'.repeat(64)
  };
  const base = {
    scope,
    modelFlag: 'model-x1',
    effortFlag: 'medium',
    launchOptions: {
      actor,
      cwd: 'C:\\Synthetic\\workspace',
      rootFingerprint: 'a'.repeat(64),
      ownerHome:'C:\\Users\\fixture',providerFile:'C:\\Tools\\provider\\provider.exe',
      runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',
      codexFile:'C:\\Tools\\codex\\codex.exe',codexSHA256:'b'.repeat(64),
      nodeFile:'C:\\Tools\\node\\node.exe',gitDirectory:'C:\\Tools\\git',
      hubLibDirectory:'C:\\Tools\\hublib',systemRoot:'C:\\Windows',
      maxWallMs: 5000
    },
    maxWallMs: 5000
  };
  if (actor === 'claude') {
    base.validatedMcpConfig = { mcpServers: {} };
  } else {
    base.validatedMcpServers = [];
  }
  return { ...base, ...overrides };
}

function makeBroker() {
  let closed = false;
  return {
    proxyUrl: 'http://127.0.0.1:0',
    close: async () => { closed = true; },
    snapshot: async () => ({}),
    isClosed: () => closed
  };
}

function makeNativeChild(backendId = 'backend-1') {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.backendId = backendId;
  child.pid = 1234;
  child.commandPid = 1234;
  child.cleanupReceipt = undefined;
  child.killed = false;
  child.kill = (...a) => { child.killed = true; child.emit('__killed', a); };
  return child;
}

function baseRequest(actor, overrides = {}) {
  return {
    actor,
    project: 'proj1',
    task: 'task1',
    dir: 'C:\\Synthetic\\workspace',
    model: 'model-x1',
    effort: 'medium',
    rootFingerprint: 'a'.repeat(64),
    ...overrides
  };
}

function makeRuntime(opts = {}) {
  const binding = opts.binding || makeBinding();
  const brokers = [];
  const children = [];
  const runtime = new NativeProviderRuntime({
    resolve: opts.resolve || (async () => binding),
    authorize: opts.authorize || (async (req) => makeDescriptor(req.actor)),
    createBroker: opts.createBroker || (async () => { const b = makeBroker(); brokers.push(b); return b; }),
    launch: opts.launch || ((options) => { const c = makeNativeChild(); c.__launchOptions = options; children.push(c); return c; }),
    dispose:opts.dispose||async function(){}
  });
  return { runtime, brokers, children, binding };
}

test('empty descriptor model is reserved for explicit native CLI default before broker creation',async()=>{
 for(const [actor,model,allowed]of [['claude','CLI預設',true],['claude','unknown',false],['grok','CLI預設',true],['grok','unknown',false]]){
  const {runtime,brokers}=makeRuntime({authorize:async()=>makeDescriptor(actor,{modelFlag:''})});
  const request=baseRequest(actor,{model});
  if(allowed){const plan=await runtime.prepareTurn(request);assert.equal(plan.modelFlag,'');await runtime.cancel({actor,project:request.project,task:request.task});assert.equal(brokers[0].isClosed(),true);}
  else{await assert.rejects(runtime.prepareTurn(request),{code:'NATIVE_RUNTIME_INVALID'});assert.equal(brokers.length,0);}
 }
});

test('claude full prepare/open/cleanup/reopen cycle', async () => {
  const { runtime, children } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  assert.equal(plan.modelFlag, 'model-x1');
  assert.equal(plan.effortFlag, 'medium');
  assert.ok(plan.validatedMcpConfig);
  const prepared = handlers.claude.prepare(req);
  assert.deepEqual(prepared, plan);

  const wrapper = handlers.claude.openEndpoint({
    actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId,
    dir: 'C:\\Synthetic\\workspace', scope: plan.scope, args: ['--flag', 'value']
  });
  assert.equal(wrapper.backendId, 'backend-1');
  assert.equal(wrapper.pid, 1234);
  const child = children[0];
  assert.deepEqual(child.__launchOptions.providerArgs, ['--flag', 'value']);
  assert.equal(child.__launchOptions.runtimeBase,'C:\\Users\\fixture\\AppData\\Local\\ProjectHub');
  assert.equal(Object.hasOwn(plan,'runtimeBase'),false);

  const closeEvent = new Promise((resolve) => wrapper.on('close', (code, sig) => resolve({ code, sig })));
  child.cleanupReceipt = { cleanupVerified: true, rootExited: true, ownedTreeEmpty: true, exitCode: 0 };
  child.emit('close', 0, null);
  const result = await closeEvent;
  assert.equal(result.code, 0);
  assert.deepEqual(wrapper.cleanupReceipt, child.cleanupReceipt);
  assert.equal(runtime.active(), 0);

  // reopen allowed after cleanup released key
  const plan2 = await runtime.prepareTurn(req);
  assert.ok(plan2);
});

test('grok prepare with optional agent profile', async () => {
  const { runtime } = makeRuntime({
    authorize: async (req) => makeDescriptor('grok', { validatedAgentProfile: { tag: 'x' } })
  });
  const req = baseRequest('grok');
  const plan = await runtime.prepareTurn(req);
  assert.deepEqual(plan.validatedMcpServers, []);
  assert.deepEqual(plan.validatedAgentProfile, { tag: 'x' });
});

test('cannot openEndpoint before prepareTurn completes', async () => {
  const { runtime } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  assert.throws(() => handlers.claude.prepare(req), /NativeRuntimeError/);
  try {
    handlers.claude.openEndpoint({ actor: 'claude', project: 'proj1', task: 'task1', runId: 'not-prepared', dir: 'C:\\Synthetic\\workspace', scope: {}, args: [] });
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.code, 'NATIVE_RUNTIME_REQUIRED');
  }
});

test('caller JSON cannot forge grant: unexpected descriptor fields rejected', async () => {
  const { runtime } = makeRuntime({
    authorize: async (req) => ({ ...makeDescriptor(req.actor), extraAuthorityField: true })
  });
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude')), (e) => e.code === 'NATIVE_RUNTIME_INVALID');
});

test('extra launch authority fields rejected (providerArgs/proxyUrl not allowed)', async () => {
  const { runtime } = makeRuntime({
    authorize: async (req) => {
      const d = makeDescriptor(req.actor);
      d.launchOptions.proxyUrl = 'http://evil';
      return d;
    }
  });
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude')), (e) => e.code === 'NATIVE_RUNTIME_INVALID');
});

test('workspace change detected after broker creation triggers scope mismatch and cleans up broker', async () => {
  let callCount = 0;
  const binding1 = makeBinding();
  const binding2 = makeBinding({ workspaceRun: 'run-DIFFERENT' });
  const { runtime, brokers } = makeRuntime({
    resolve: async () => { callCount++; return callCount === 1 ? binding1 : binding2; }
  });
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude')), (e) => e.code === 'NATIVE_SCOPE_MISMATCH');
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].isClosed(), true);
  assert.equal(runtime.active(), 0);
});

test('concurrent prepareTurn for same key rejected as busy', async () => {
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  const { runtime } = makeRuntime({
    resolve: async () => { await gate; return makeBinding(); }
  });
  const req = baseRequest('claude');
  const p1 = runtime.prepareTurn(req);
  await assert.rejects(() => runtime.prepareTurn(req), (e) => e.code === 'NATIVE_RUNTIME_BUSY');
  resolveGate();
  await p1;
});

test('cancel during setup prevents launch from taking effect', async () => {
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  const { runtime, brokers } = makeRuntime({
    createBroker: async () => { await gate; const b = makeBroker(); brokers.push(b); return b; }
  });
  const req = baseRequest('claude');
  const p1 = runtime.prepareTurn(req);
  // Wait until the delayed broker creation is entered; cancellation before
  // authorization finishes should correctly create no broker at all.
  await new Promise(resolve=>setImmediate(resolve));
  await runtime.cancel({ actor: 'claude', project: 'proj1', task: 'task1' });
  resolveGate();
  await assert.rejects(() => p1, (e) => e.code === 'NATIVE_RUNTIME_CANCELLED');
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].isClosed(), true);
  assert.equal(runtime.active(), 0);
});

test('cancel of active endpoint kills owned child only', async () => {
  const { runtime, children } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  const wrapper = handlers.claude.openEndpoint({
    actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId, dir: 'C:\\Synthetic\\workspace', scope: plan.scope, args: []
  });
  await runtime.cancel({ actor: 'claude', project: 'proj1', task: 'task1' });
  assert.equal(children[0].killed, true);
});

test('endpoint can only be opened once', async () => {
  const { runtime } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  const ctx = { actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId, dir: 'C:\\Synthetic\\workspace', scope: plan.scope, args: [] };
  handlers.claude.openEndpoint(ctx);
  assert.throws(() => handlers.claude.openEndpoint(ctx), (e) => e.code === 'NATIVE_RUNTIME_INVALID');
});

test('mutation isolation: mutating returned plan does not affect stored state', async () => {
  const { runtime } = makeRuntime();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  assert.throws(() => { plan.modelFlag = 'hacked'; });
  assert.equal(plan.modelFlag, 'model-x1');
});

test('accessor getters are never invoked during deep copy validation', async () => {
  let touched = false;
  const binding = makeBinding();
  const evilDescriptor = makeDescriptor('claude');
  Object.defineProperty(evilDescriptor, 'poison', {
    enumerable: true,
    get() { touched = true; return 'x'; }
  });
  const { runtime } = makeRuntime({
    binding,
    authorize: async () => evilDescriptor
  });
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude')));
  assert.equal(touched, false);
});

test('malformed descriptor (missing mcp field) rejected', async () => {
  const { runtime } = makeRuntime({
    authorize: async (req) => { const d = makeDescriptor(req.actor); delete d.validatedMcpConfig; return d; }
  });
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude')), (e) => e.code === 'NATIVE_RUNTIME_INVALID');
});

test('missing cleanup receipt retains busy key for owner recovery', async () => {
  const { runtime, children } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  const wrapper = handlers.claude.openEndpoint({
    actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId, dir: 'C:\\Synthetic\\workspace', scope: plan.scope, args: []
  });
  const child = children[0];
  const closeEvent = new Promise((resolve) => wrapper.on('close', (code) => resolve(code)));
  child.cleanupReceipt = undefined;
  child.emit('close', 1, null);
  await closeEvent;
  assert.equal(wrapper.cleanupReceipt, null);
  assert.equal(runtime.active(), 1);
});

test('mismatched cleanup receipt exitCode retains busy', async () => {
  const { runtime, children } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  const wrapper = handlers.claude.openEndpoint({
    actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId, dir: 'C:\\Synthetic\\workspace', scope: plan.scope, args: []
  });
  const child = children[0];
  const closeEvent = new Promise((resolve) => wrapper.on('close', (code) => resolve(code)));
  child.cleanupReceipt = { cleanupVerified: true, rootExited: true, ownedTreeEmpty: true, exitCode: 99 };
  child.emit('close', 0, null);
  await closeEvent;
  assert.equal(wrapper.cleanupReceipt, null);
  assert.equal(runtime.active(), 1);
});

test('broker close failure retains busy key', async () => {
  const brokerCloseFail = {
    proxyUrl: 'http://127.0.0.1:0',
    close: async () => { throw new Error('boom'); },
    snapshot: async () => ({})
  };
  const { runtime,children } = makeRuntime({ createBroker: async () => brokerCloseFail });
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  const wrapper = handlers.claude.openEndpoint({
    actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId, dir: 'C:\\Synthetic\\workspace', scope: plan.scope, args: []
  });
  const closeEvent = new Promise((resolve) => wrapper.on('close', (code) => resolve(code)));
  children[0].cleanupReceipt={cleanupVerified:true,rootExited:true,ownedTreeEmpty:true,exitCode:0};
  children[0].emit('close',0,null);
  await closeEvent;
  assert.equal(wrapper.cleanupReceipt,null);
  assert.equal(runtime.active(),1);
});

test('exact scope match required at openEndpoint, mismatch rejected', async () => {
  const { runtime } = makeRuntime();
  const handlers = runtime.handlers();
  const req = baseRequest('claude');
  const plan = await runtime.prepareTurn(req);
  const tamperedScope = { ...plan.scope, actor: 'grok' };
  assert.throws(() => handlers.claude.openEndpoint({
    actor: 'claude', project: 'proj1', task: 'task1', runId: plan.runId, dir: 'C:\\Synthetic\\workspace', scope: tamperedScope, args: []
  }), (e) => e.code === 'NATIVE_SCOPE_MISMATCH');
});

test('request with extra fields rejected', async () => {
  const { runtime } = makeRuntime();
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude', { extra: 'nope' })), (e) => e.code === 'NATIVE_RUNTIME_INVALID');
});

test('request cannot replace the controller private runtime base', async () => {
  const {runtime}=makeRuntime();
  await assert.rejects(()=>runtime.prepareTurn(baseRequest('grok',{runtimeBase:'C:\\attacker\\ProjectHub'})),{code:'NATIVE_RUNTIME_INVALID'});
});

test('missing or malformed private runtime base is refused before creating a broker', async () => {
  for(const runtimeBase of [undefined,'C:\\Users\\fixture','C:\\Users\\other\\AppData\\Local\\ProjectHub']){
    const {runtime,brokers}=makeRuntime({authorize:async req=>{
      const descriptor=makeDescriptor(req.actor);
      if(runtimeBase===undefined)delete descriptor.launchOptions.runtimeBase;
      else descriptor.launchOptions.runtimeBase=runtimeBase;
      return descriptor;
    }});
    await assert.rejects(()=>runtime.prepareTurn(baseRequest('grok')),{code:'NATIVE_RUNTIME_INVALID'});
    assert.equal(brokers.length,0);assert.equal(runtime.active(),0);
  }
});

test('oversized snapshot rejected', async () => {
  const bigString = 'x'.repeat(200000);
  const { runtime } = makeRuntime({
    authorize: async (req) => ({ ...makeDescriptor(req.actor), validatedMcpConfig: { mcpServers: { a: bigString } } })
  });
  await assert.rejects(() => runtime.prepareTurn(baseRequest('claude')), (e) => e.code === 'NATIVE_RUNTIME_INVALID');
});

test('unknown setup callback errors retain only a fixed stage and still clean reservations',async()=>{
  for(const stage of ['resolve','authorize','broker','rebind']){
    let resolves=0,disposed=0,closed=0,launched=0;
    const source=Object.assign(Error('PRIVATE_SYNTHETIC_CALLBACK_PAYLOAD'),{privatePayload:'PRIVATE_SYNTHETIC_CALLBACK_PAYLOAD'});
    const runtime=new NativeProviderRuntime({
      resolve:async()=>{if(stage==='resolve'||stage==='rebind'&&++resolves===2)throw source;return makeBinding();},
      authorize:async req=>{if(stage==='authorize')throw source;return makeDescriptor(req.actor);},
      createBroker:async()=>{if(stage==='broker')throw source;return {...makeBroker(),close:async()=>{closed++;}};},
      launch:()=>{launched++;throw Error('LAUNCH_MUST_NOT_OCCUR');},dispose:async()=>{disposed++;}
    });
    await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),error=>{
      assert.ok(error instanceof NativeRuntimeError);assert.notEqual(error,source);
      assert.equal(error.code,'NATIVE_SETUP_'+stage.toUpperCase()+'_FAILED');assert.equal(error.message,error.code);
      assert.equal(JSON.stringify(error).includes('PRIVATE_SYNTHETIC'),false);return true;
    });
    assert.equal(disposed,1);assert.equal(closed,stage==='rebind'?1:0);assert.equal(launched,0);assert.equal(runtime.active(),0);
  }
});

test('publication errors use the fixed publish category and close the prepared broker',async t=>{
  let closed=0,disposed=0;
  const {runtime}=makeRuntime({createBroker:async()=>({...makeBroker(),close:async()=>{closed++;}}),dispose:async()=>{disposed++;}});
  const timer=t.mock.method(global,'setTimeout',()=>{throw Error('PRIVATE_SYNTHETIC_TIMER_PAYLOAD');});
  try{await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),{code:'NATIVE_SETUP_PUBLISH_FAILED',message:'NATIVE_SETUP_PUBLISH_FAILED'});}
  finally{timer.mock.restore();}
  assert.equal(closed,1);assert.equal(disposed,1);assert.equal(runtime.active(),0);
});

test('setup preserves only known own-data codes and rebuilds errors without their payloads',async()=>{
  for(const code of ['NATIVE_PROFILE_UNAVAILABLE','NATIVE_APPROVAL_CHANGED','NATIVE_APPROVAL_CLOCK','NATIVE_PROVIDER_APPROVAL_REQUIRED']){
    let touched=0;
    const source={code,privatePayload:'PRIVATE_SYNTHETIC_SOURCE_PAYLOAD',get message(){touched++;throw Error('message getter');},
      get toJSON(){touched++;throw Error('toJSON getter');}};
    const {runtime}=makeRuntime({authorize:async()=>{throw source;}});
    await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),error=>{
      assert.ok(error instanceof NativeRuntimeError);assert.notEqual(error,source);assert.equal(error.code,code);
      assert.equal(JSON.stringify(error).includes('PRIVATE_SYNTHETIC'),false);
      if(code==='NATIVE_PROVIDER_APPROVAL_REQUIRED')assert.deepEqual({project:error.project,task:error.task,actor:error.actor,model:error.model,effort:error.effort,status:error.status,notStarted:error.notStarted},
        {project:'proj1',task:'task1',actor:'claude',model:'model-x1',effort:'medium',status:409,notStarted:true});
      else assert.equal(error.message,code);
      return true;
    });
    assert.equal(touched,0);assert.equal(runtime.active(),0);
  }
  const source=new NativeRuntimeError('NATIVE_SCOPE_MISMATCH','PRIVATE_SYNTHETIC_NATIVE_ERROR');
  const {runtime}=makeRuntime({authorize:async()=>{throw source;}});
  await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),error=>{
    assert.notEqual(error,source);assert.equal(error.code,'NATIVE_SCOPE_MISMATCH');assert.equal(error.message,error.code);return true;
  });
});

test('unknown and inherited setup codes never read getters, prototypes or source serialization',async()=>{
  let touched=0;
  const accessor=Object.defineProperties({},Object.fromEntries(['code','message','prototype','toJSON'].map(key=>[key,{get(){touched++;throw Error('PRIVATE_SYNTHETIC_GETTER');}}])));
  const inherited=Object.create({get code(){touched++;throw Error('PRIVATE_SYNTHETIC_INHERITED');}});
  const proxy=new Proxy({},{get(){touched++;throw Error('PRIVATE_SYNTHETIC_PROPERTY');},getPrototypeOf(){touched++;throw Error('PRIVATE_SYNTHETIC_PROTOTYPE');},getOwnPropertyDescriptor(){return undefined;}});
  for(const source of [accessor,inherited,proxy,{code:'NATIVE_PRIVATE_SYNTHETIC_CODE'},null,'PRIVATE_SYNTHETIC_THROWN_STRING']){
    const {runtime}=makeRuntime({authorize:async()=>{throw source;}});
    await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),{code:'NATIVE_SETUP_AUTHORIZE_FAILED',message:'NATIVE_SETUP_AUTHORIZE_FAILED'});
    assert.equal(runtime.active(),0);
  }
  assert.equal(touched,0);
});

test('cleanup failures override fixed setup diagnostics and retain the busy key',async()=>{
  for(const failure of ['dispose','broker']){
    let touched=0;
    const source={get code(){touched++;throw Error('PRIVATE_SYNTHETIC_ORIGINAL_GETTER');}};
    const runtime=new NativeProviderRuntime({
      resolve:(()=>{let count=0;return async()=>{if(failure==='broker'&&++count===2)throw source;if(failure==='dispose')throw source;return makeBinding();};})(),
      authorize:async req=>makeDescriptor(req.actor),
      createBroker:async()=>({...makeBroker(),close:async()=>{throw Error('PRIVATE_SYNTHETIC_CLEANUP');}}),
      launch:()=>{throw Error('LAUNCH_MUST_NOT_OCCUR');},dispose:async()=>{if(failure==='dispose')throw Error('PRIVATE_SYNTHETIC_DISPOSE');}
    });
    await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),{code:'NATIVE_CLEANUP_REQUIRED',message:'NATIVE_CLEANUP_REQUIRED'});
    assert.equal(touched,0);assert.equal(runtime.active(),1);
    await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),{code:'NATIVE_RUNTIME_BUSY'});
  }
  const {runtime}=makeRuntime({authorize:async()=>{throw {code:'NATIVE_APPROVAL_CHANGED',message:'PRIVATE_SYNTHETIC_SOURCE'};},
    dispose:async()=>{throw Error('PRIVATE_SYNTHETIC_DISPOSE');}});
  await assert.rejects(()=>runtime.prepareTurn(baseRequest('claude')),{code:'NATIVE_CLEANUP_REQUIRED',message:'NATIVE_CLEANUP_REQUIRED'});
  assert.equal(runtime.active(),1);
});


test('runtime passes the full turn wall to broker and launch, rejecting excess before egress',async()=>{
  for(const actor of ['claude','grok'])for(const maxWallMs of [1800000,1800001]){
    let brokerOptions;
    const descriptor=makeDescriptor(actor);descriptor.maxWallMs=maxWallMs;descriptor.launchOptions.maxWallMs=maxWallMs;
    const {runtime,children}=makeRuntime({authorize:async()=>descriptor,createBroker:async o=>{brokerOptions=o;return makeBroker();}});
    const req=baseRequest(actor);
    if(maxWallMs>1800000){await assert.rejects(runtime.prepareTurn(req),{code:'NATIVE_RUNTIME_INVALID'});assert.equal(brokerOptions,undefined);continue;}
    const plan=await runtime.prepareTurn(req);assert.equal(plan.maxWallMs,1800000);assert.ok(brokerOptions.maxWallMs>=plan.maxWallMs);
    const endpoint=runtime.handlers()[actor].openEndpoint({actor,project:req.project,task:req.task,runId:plan.runId,dir:req.dir,scope:plan.scope,args:[]});
    assert.equal(children[0].__launchOptions.maxWallMs,1800000);
    const closed=new Promise(resolve=>endpoint.once('close',resolve));
    children[0].cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0};children[0].emit('close',0,null);await closed;
    assert.equal(runtime.active(),0);
  }
});
