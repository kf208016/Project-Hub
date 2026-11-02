'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {createPlan}=require('../lib/provider-native-plan');
const {createGrokHydrator}=require('../lib/grok-hydrate');
const options={actor:'grok',cwd:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),ownerHome:'C:\\Users\\synthetic',runtimeBase:'C:\\Users\\synthetic\\AppData\\Local\\ProjectHub',providerFile:'C:\\Tools\\grok.exe',codexFile:'C:\\Sandbox\\codex.exe',codexSHA256:'b'.repeat(64),nodeFile:'C:\\Node\\node.exe',gitDirectory:'C:\\Git',hubLibDirectory:'C:\\Synthetic Hub\\lib',providerArgs:[],proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:8080',systemRoot:'C:\\Windows'};

test('both provider commands are bare cmd file names even when Hub lib contains spaces',async t=>{
  const runtimeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'r26-command-'));
  t.after(()=>{
    assert.equal(path.dirname(runtimeDirectory),os.tmpdir());
    fs.rmSync(runtimeDirectory,{recursive:true,force:true});
  });
  const providerHome=path.join(runtimeDirectory,'grok'),authPath=path.join(providerHome,'auth.json'),lockPath=authPath+'.lock';
  const child=Object.assign(new EventEmitter(),{pid:12345}),calls=[];
  const hydrator=createGrokHydrator({resolveGrok:async()=>options.providerFile,
    systemRoot:options.systemRoot,restoreInheritance:async()=>true,
    spawn:(...args)=>{calls.push(args);return child;},nodeFile:options.nodeFile,hubLibDirectory:options.hubLibDirectory,
    env:{Path:'C:\\Parent\\bin',USERPROFILE:options.ownerHome},kill:()=>{},setTimeout:()=>1,clearTimeout:()=>{}});
  t.after(()=>hydrator.dispose());
  const pending=hydrator.hydrate({runtimeDirectory,providerHome,authPath,lockPath});
  await Promise.resolve();await Promise.resolve();
  assert.equal(calls.length,1);
  const ownerEnv=calls[0][2].env,sandboxEnv=createPlan(options).env;
  for(const command of [ownerEnv.GROK_AUTH_PROVIDER_COMMAND,sandboxEnv.GROK_AUTH_PROVIDER_COMMAND]){
    assert.match(command,/^[a-z0-9-]+\.cmd$/);
    assert.doesNotMatch(command,/["%\\/ ]/);
  }
  assert.equal(ownerEnv.GROK_AUTH_PROVIDER_COMMAND,'grok-auth-helper-owner.cmd');
  assert.equal(sandboxEnv.GROK_AUTH_PROVIDER_COMMAND,'grok-auth-helper-sandbox.cmd');
  assert.equal(ownerEnv.PATH.split(';')[0],options.hubLibDirectory);
  assert.equal(sandboxEnv.PATH.split(';').at(-1),options.hubLibDirectory);
  fs.writeFileSync(authPath,'synthetic');child.emit('exit',0);
  assert.equal((await pending).outcome,'hydrated');
});

test('both cmd helpers exist with CRLF and invoke their own script using HUB_NODE',()=>{
  for(const name of ['grok-auth-helper-owner','grok-auth-helper-sandbox']){
    const file=path.join(__dirname,'../lib',name+'.cmd');
    assert.ok(fs.existsSync(file));
    const source=fs.readFileSync(file,'utf8');
    assert.ok(source.includes('\r\n'));
    assert.doesNotMatch(source.replace(/\r\n/g,''),/[\r\n]/);
    const secondLine=source.split('\r\n')[1];
    assert.ok(secondLine.includes('%~dp0'+name+'.js'));
    assert.ok(secondLine.includes('%HUB_NODE%'));
  }
});

test('Claude has no Grok provider command or Hub lib PATH entry',()=>{
  const plan=createPlan({...options,actor:'claude'});
  assert.equal(Object.hasOwn(plan.env,'GROK_AUTH_PROVIDER_COMMAND'),false);
  assert.ok(!plan.env.PATH.includes(options.hubLibDirectory));
});
