'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter,once}=require('node:events'),{PassThrough}=require('node:stream');
const {TASK_COMPANIONS,GROK_PROCESS_TOOLS}=require('../lib/grok-tool-allowlist');
const {buildArgs,start}=require('../lib/grok-native-bridge');
const {NativeProviderService,GROK_PROFILE}=require('../lib/native-provider-service');
const {createPlan}=require('../lib/provider-native-plan');
const sandbox=require('../lib/provider-sandbox');
const host=require('../lib/provider-native-host'),egress=require('../lib/provider-egress');
const safe=require('../lib/safe-path'),scoped=require('../lib/scoped-file'),artifacts=require('../lib/native-cli-update');
const hostSource=fs.readFileSync(require.resolve('../lib/provider-native-host'),'utf8');
const expected=['read_file','grep','search_replace','write','run_terminal_cmd','task','search_tool','use_tool','get_task_output','wait_tasks','kill_task'];
const options=()=>({actor:'grok',cwd:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),
  ownerHome:'C:\\Users\\synthetic',runtimeBase:'C:\\Users\\synthetic\\AppData\\Local\\ProjectHub',
  providerFile:'C:\\SyntheticTools\\provider\\grok.exe',codexFile:'C:\\SyntheticTools\\codex\\codex.exe',
  codexSHA256:host.PROVIDER_HASHES.grok,nodeFile:process.execPath,gitDirectory:'C:\\SyntheticTools\\git',
  hubLibDirectory:'C:\\SyntheticTools\\hub\\lib',systemRoot:'C:\\Windows',
  providerArgs:buildArgs({model:'grok-synthetic',effort:'high'}),proxyUrl:'http://hub:'+'b'.repeat(64)+'@127.0.0.1:1'});

test('R15 frozen process allowlist order matches profile exactly without importing service',()=>{
  assert.deepEqual(GROK_PROCESS_TOOLS,expected);assert.deepEqual(GROK_PROCESS_TOOLS.slice(0,8),GROK_PROFILE.tools);
  assert.deepEqual(TASK_COMPANIONS,expected.slice(8));assert.equal(Object.isFrozen(GROK_PROCESS_TOOLS),true);assert.equal(Object.isFrozen(TASK_COMPANIONS),true);
  const source=fs.readFileSync(require.resolve('../lib/grok-tool-allowlist'),'utf8');assert.doesNotMatch(source,/require\(/);
});
test('R15 buildArgs is exact for selected and default model with top-level tools first',()=>{
  for(const model of ['grok-synthetic',''])assert.deepEqual(buildArgs({model,effort:'high'}),
    ['--tools',expected.join(','),'agent','--no-leader',...(model?['--model',model]:[]),'--effort','high','stdio']);
});
test('R15 native and legacy sandbox forward the complete argv and reject every bypass before and after agent',()=>{
  const o=options(),args=o.providerArgs;
  const legacy=providerArgs=>sandbox.createPlan({provider:'grok',providerFile:o.providerFile,providerArgs,codexFile:o.codexFile,cwd:o.cwd,rootFingerprint:o.rootFingerprint,codexSHA256:o.codexSHA256});
  for(const plan of [createPlan(o),legacy(args)])assert.deepEqual(plan.args.slice(plan.args.indexOf('--')+2),args);
  for(const flag of ['--always-approve','--yolo','--dangerously-skip-permissions','--allow-dangerously-skip-permissions']){
    for(const providerArgs of [[flag,...args],[...args.slice(0,3),flag,...args.slice(3)],[...args,flag]]){
      assert.throws(()=>createPlan({...o,providerArgs}),{code:'NATIVE_ARGS_INVALID'});
      assert.throws(()=>legacy(providerArgs),{code:'ERR_INVALID_ARGS'});
    }
  }
});

// Compile the real host with synthetic filesystem/hash/platform dependencies.
// Real createPlan and host launch checks run; no native binary or home is accessed.
function syntheticHost() {
  const o=options(),plan=createPlan(o),dirs=[plan.gitDirectory,plan.hubLibDirectory,plan.runtimeDirectory,plan.tempDirectory,plan.stateDirectory,plan.providerHome];
  let read=false;
  const fakeFs={
    lstatSync:file=>({isFile:()=>!dirs.includes(file),isDirectory:()=>dirs.includes(file),isSymbolicLink:()=>false,nlink:1,size:128}),
    mkdirSync(){},openSync(file,mode){if(mode==='wx')throw Object.assign(Error('exists'),{code:'EEXIST'});read=false;return 1;},
    readSync(fd,buffer){if(read)return 0;read=true;buffer[0]=1;return 1;},closeSync(){},readFileSync:()=>Buffer.from(host.GROK_CONFIG)
  };
  const moduleObject={exports:{}};
  const dependency=name=>{
    if(name==='fs')return fakeFs;
    if(name==='os')return {release:()=> '10.0.26200'};
    if(name==='crypto')return {randomUUID:crypto.randomUUID,createHash:()=>({update(){return this;},digest:()=>host.PROVIDER_HASHES.grok})};
    if(name==='./safe-path')return {localPath:file=>file};
    if(name.startsWith('./'))return require('../lib/'+name.slice(2));
    return require(name);
  };
  new Function('require','module','exports','process','Buffer',hostSource)(dependency,moduleObject,moduleObject.exports,{platform:'win32',arch:'x64',execPath:process.execPath,pid:123},Buffer);
  return moduleObject.exports;
}

test('R15 service approval through bridge, runtime, real plan and mocked host preserves allowlist argv',async t=>{
  const realHost=syntheticHost(),o=options(),launches=[],packets=[];
  const request={actor:'grok',project:'p',task:'t',model:'Synthetic',effort:'high'};
  const {actor,cwd,rootFingerprint,providerArgs,proxyUrl,...settings}=o;
  t.mock.method(safe,'localPath',file=>file);
  t.mock.method(scoped,'identity',async()=>({rootFingerprint:'c'.repeat(64)}));
  t.mock.method(artifacts,'digestFile',()=>host.PROVIDER_HASHES.grok);
  t.mock.method(fs,'lstatSync',(_file,opt)=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:opt?.bigint?1n:1,size:opt?.bigint?128n:128,dev:1n}));
  t.mock.method(egress,'create',async()=>({proxyUrl:o.proxyUrl,close:async()=>{},snapshot:()=>({})}));
  t.mock.method(host,'launch',(opts,spawn)=>realHost.launch(opts,spawn));
  let native;
  const service=new NativeProviderService({
    resolveWorkspace:async()=>({project:'p',task:'t',dir:cwd,rootFingerprint,run:'synthetic-run'}),
    profile:()=>settings,modelFlag:()=> 'grok-synthetic',effortFlag:()=> 'high',
    supervisedSpawn:(file,args,opts)=>{
      launches.push({file,args,opts});native=new EventEmitter();
      Object.assign(native,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true});
      let wire='';const push=value=>native.stdout.write(JSON.stringify(value)+'\n');
      native.stdin.on('data',chunk=>{
        wire+=chunk;let end;
        while((end=wire.indexOf('\n'))>=0){const packet=JSON.parse(wire.slice(0,end));wire=wire.slice(end+1);packets.push(packet);
          setImmediate(()=>{
            if(packet.method==='initialize')push({jsonrpc:'2.0',id:packet.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
            if(packet.method==='session/new')push({jsonrpc:'2.0',id:packet.id,result:{sessionId:'synthetic-session',models:{currentModelId:'grok-synthetic',availableModels:[]}}});
            if(packet.method==='session/prompt'){
              push({jsonrpc:'2.0',id:packet.id,result:{stopReason:'end_turn'}});
              native.cleanupReceipt={rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0};
              native.stdout.end();native.stderr.end();native.emit('close',0,null);
            }
          });
        }
      });
      setImmediate(()=>native.emit('spawn'));return native;
    }
  });
  t.after(()=>service.cancel({actor:'grok',project:'p',task:'t'}));
  const preview=await service.preview(request);
  await service.approve({token:preview.token,confirm:true,ackAuthenticationRead:true,ackCommandAccess:true,ackDestination:true,ackSessionWrite:true});
  const plan=await service.prepareTurn({ai:'grok',project:'p',task:'t',dir:cwd,model:'Synthetic',effort:'high',nativeRootPin:{rootFingerprint}});
  const bridge=start({project:'p',task:'t',runId:plan.runId,cwd,model:plan.modelFlag,effort:plan.effortFlag,sessionId:null,resume:false,
    validatedMcpServers:plan.validatedMcpServers,validatedAgentProfile:plan.validatedAgentProfile,
    openEndpoint:args=>service.handlers().grok.openEndpoint({actor:'grok',project:'p',task:'t',runId:plan.runId,dir:cwd,scope:plan.scope,args})});
  const closed=once(bridge,'close');bridge.stdout.resume();bridge.stderr.resume();bridge.stdin.end('synthetic instruction');
  assert.deepEqual(await closed,[0,null]);assert.equal((await bridge.completion).responseComplete,true);
  assert.equal(launches.length,1);assert.deepEqual(launches[0].args.slice(launches[0].args.indexOf('--')+2),o.providerArgs);
  assert.equal(launches[0].opts.windowsHide,true);assert.deepEqual(packets.find(p=>p.method==='session/new').params._meta.agentProfile,GROK_PROFILE);
  assert.equal(service.active(),0);
});
