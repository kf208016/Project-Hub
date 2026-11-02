'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const plans=require('../lib/provider-native-plan'),realHost=require('../lib/provider-native-host');
const options={ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',
  providerFile:'C:\\Tools\\provider\\grok.exe',codexFile:'C:\\Tools\\codex\\codex.exe',nodeFile:process.execPath,
  codexSHA256:'a'.repeat(64),rootFingerprint:'b'.repeat(64),systemRoot:'C:\\Windows',proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:12345'};
function load(file,overrides,globals={}){
  const filename=path.join(__dirname,'../lib',file),actual=createRequire(filename),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,process,
    require:name=>Object.hasOwn(overrides,name)?overrides[name]:actual(name),...globals},{filename});return module.exports;
}
function hostFixture(mode){
  let reads=0,spawns=0,hashes=0;const opened=[],dirs=[],p=plans.createGrokAuthRefreshPlan(options),handles=new Map();
  const f={lstatSync:file=>{
    if(mode==='node'&&file===options.nodeFile)throw Error('PRIVATE');
    const credential=p.credentialFiles.includes(file)||file===p.lockFile;
    return {isFile:()=>!(credential&&mode==='credential'),isDirectory:()=>true,isSymbolicLink:()=>false,nlink:credential&&mode==='hardlink'?2:1,
      size:credential&&mode==='oversize'?4*1024*1024+1:100};
  },mkdirSync:file=>dirs.push(file),openSync:(file,flag)=>{
    opened.push(file);assert.ok(!p.credentialFiles.includes(file)&&file!==p.lockFile);
    if(flag==='wx')throw Object.assign(Error('exists'),{code:'EEXIST'});
    handles.set(file,false);return file;
  },readSync:(fd,b)=>{if(handles.get(fd))return 0;handles.set(fd,true);const s=fd===options.providerFile?'provider':'codex';b.write(s);return s.length;},closeSync:()=>{},
    readFileSync:file=>{reads++;assert.ok(file.endsWith('config.toml'));return Buffer.from(realHost.GROK_CONFIG);}};
  const crypto={createHash:()=>{let data='';return {update:b=>{data+=b.toString();},digest:()=>mode==='hash'||(mode==='recheck'&&++hashes>=3)?'f'.repeat(64):data==='provider'?realHost.PROVIDER_HASHES.grok:options.codexSHA256};}};
  const host=load('provider-native-host.js',{'fs':f,'crypto':crypto,'os':{release:()=> '10.0.26200'},'./safe-path':{localPath:file=>{
    if(mode==='lock'&&file===p.lockFile)throw Error('PRIVATE');return file;
  }}},{process:{platform:'win32',arch:'x64',execPath:process.execPath,pid:process.pid}});
  const spawn=(file,args,settings)=>{spawns++;assert.equal(file,p.file);assert.deepEqual(args,p.args);assert.equal(settings.cwd,p.cwd);
    assert.deepEqual(settings.env,p.env);assert.equal(settings.windowsHide,true);assert.equal(JSON.stringify(settings.stdio),'["pipe","pipe","pipe"]');
    assert.deepEqual(settings.dirPin,p.dirPin);const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};return c;};
  return {run:()=>host.launchGrokAuthRefresh(options,spawn),counts:()=>({reads,spawns,opened,dirs})};
}
test('R17 refresh host checks binaries twice and spawns only the reviewed plan without auth reads',()=>{
  const f=hostFixture(),c=f.run(),counts=f.counts();assert.equal(counts.spawns,1);assert.equal(counts.reads,1);
  assert.equal(counts.opened.filter(p=>p===options.providerFile).length,2);assert.equal(counts.opened.filter(p=>p===options.codexFile).length,2);
  assert.equal(counts.dirs.length,4);for(const s of [c.stdin,c.stdout,c.stderr])s.destroy();
});
for(const [mode,code] of [['hash','NATIVE_HASH_MISMATCH'],['recheck','NATIVE_HASH_MISMATCH'],['node','NATIVE_PATH_INVALID'],['credential','NATIVE_AUTH_UNAVAILABLE'],['lock','NATIVE_AUTH_UNAVAILABLE'],['hardlink','NATIVE_AUTH_UNAVAILABLE'],['oversize','NATIVE_AUTH_UNAVAILABLE']])
  test('R17 refresh host rejects '+mode+' without spawning or leaking the original error',()=>{
    const f=hostFixture(mode);assert.throws(f.run,e=>e.code===code&&e.message===code);assert.equal(f.counts().spawns,0);
  });
test('R17 service waits for Grok freshness first; failed or thrown refresh never blocks preparation; Claude skips it',async()=>{
  for(const [ai,result] of [['grok','fresh'],['grok','failed'],['grok','throw'],['claude','fresh']]){
    const order=[];
    class Runtime{constructor(){}active(){return 0;}async prepareTurn(r){order.push('prepare');return r;}}
    const {NativeProviderService}=load('native-provider-service.js',{'./native-provider-runtime':{NativeProviderRuntime:Runtime},
      './provider-registry':{createNativeAuthority:()=>({})}});
    const service=new NativeProviderService({resolveWorkspace:async()=>{},profile:async()=>{},modelFlag:()=>'',effortFlag:()=>'',supervisedSpawn:()=>{},
      refresher:{ensureFresh:async()=>{order.push('refresh');await Promise.resolve();if(result==='throw')throw Error('PRIVATE');return result;}}});
    const value=await service.prepareTurn({ai,project:'p',task:'t',dir:'C:\\Work',model:'model'});assert.equal(value.actor,ai);
    assert.deepEqual(order,ai==='grok'?['refresh','prepare']:['prepare']);
  }
});
