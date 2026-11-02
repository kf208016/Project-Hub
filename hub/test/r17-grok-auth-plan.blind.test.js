'use strict';
// R17 / A2 blind acceptance: createGrokAuthRefreshPlan is a pure, frozen plan
// for the login-refresh process only (no workspace, git, Hub lib, MCP or
// .claude grant; args end with `agent --no-leader stdio`), and createPlan for
// turns is byte-identical to the round-16 tree. Pure path strings only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),crypto=require('node:crypto');
const planModule=require('../lib/provider-native-plan');
const {createPlan}=planModule;

const H='C:\\Users\\example-user';
const RB=H+'\\AppData\\Local\\ProjectHub';
const PROVIDER=RB+'\\runtime-binaries\\grok\\'+'d'.repeat(64)+'\\grok.exe';
const PROXY='http://hub:'+'c'.repeat(64)+'@127.0.0.1:8080';
const FP='e'.repeat(64);
const KEYS=['ownerHome','runtimeBase','providerFile','codexFile','codexSHA256','nodeFile','systemRoot','proxyUrl','rootFingerprint'];

function refreshOptions(overrides){
  return Object.assign({ownerHome:H,runtimeBase:RB,providerFile:PROVIDER,codexFile:'C:\\Tools\\codex\\codex.exe',
    codexSHA256:'b'.repeat(64),nodeFile:'C:\\Tools\\node\\node.exe',systemRoot:'C:\\Windows',proxyUrl:PROXY,rootFingerprint:FP},overrides||{});
}
function turnOptions(actor,overrides){
  return Object.assign({actor,cwd:'C:\\Workspaces\\project',rootFingerprint:'a'.repeat(64),ownerHome:H,runtimeBase:RB,
    providerFile:RB+'\\runtime-binaries\\'+actor+'\\'+'d'.repeat(64)+'\\'+actor+'.exe',codexFile:'C:\\Tools\\codex\\codex.exe',
    codexSHA256:'b'.repeat(64),nodeFile:'C:\\Tools\\node\\node.exe',gitDirectory:'C:\\Tools\\git',hubLibDirectory:'C:\\Tools\\hub\\lib',
    providerArgs:['agent','--no-leader','stdio'],proxyUrl:PROXY,systemRoot:'C:\\Windows',maxWallMs:1800000},overrides||{});
}
function refreshPlan(options){
  assert.equal(typeof planModule.createGrokAuthRefreshPlan,'function','createGrokAuthRefreshPlan is exported');
  return planModule.createGrokAuthRefreshPlan(options);
}
const FS_PREFIX='permissions.hub-native.filesystem=';
// Parse `permissions.hub-native.filesystem={"key"="mode",...}` into [key, mode] pairs (in order).
function grantsOf(plan){
  const policies=plan.args.filter(value=>value.startsWith(FS_PREFIX));
  assert.equal(policies.length,1,'exactly one filesystem policy');
  const policy=policies[0];
  assert.ok(policy.startsWith(FS_PREFIX+'{')&&policy.endsWith('}'),'inline TOML table');
  const body=policy.slice(FS_PREFIX.length+1,-1),pairs=[];
  const re=/("(?:[^"\\]|\\.)*")=("(?:[^"\\]|\\.)*")(,|$)/y;let m;
  while(re.lastIndex<body.length&&(m=re.exec(body)))pairs.push([JSON.parse(m[1]),JSON.parse(m[2])]);
  assert.equal(re.lastIndex,body.length,'whole policy parsed');
  return pairs;
}
const lower=pairs=>Object.fromEntries(pairs.map(([k,v])=>[k.toLowerCase(),v]));

const RUNTIME=RB+'\\runtime\\grok-auth-refresh';
const CWD=RUNTIME+'\\cwd',TMP=RUNTIME+'\\tmp',GROK_HOME=RUNTIME+'\\grok';
const EXPECTED_GRANTS={
  ':minimal':'read',
  [RB+'\\runtime-binaries\\grok\\'+'d'.repeat(64)]:'read',
  [CWD]:'write',[TMP]:'write',[GROK_HOME]:'write',
  [H+'\\.grok']:'write',[H+'\\.grok\\bin']:'read',[H+'\\.grok\\downloads']:'read'
};
const WRAPPER_C=['-c','permissions.hub-native.network.enabled=false','-c','shell_environment_policy.inherit="all"',
  '-c','windows.sandbox="elevated"','-c','features.windows_sandbox_service=false','-c','windows.allow_mxc=false','-c','features.prefer_mxc=false'];

test('A2 directories, file, credential and lock fields follow the spec',()=>{
  const plan=refreshPlan(refreshOptions());
  assert.equal(plan.runtimeDirectory,RUNTIME);
  assert.equal(plan.cwd,CWD);
  assert.equal(plan.tempDirectory,TMP);
  assert.equal(plan.providerHome,GROK_HOME);
  assert.equal(plan.file,'C:\\Tools\\codex\\codex.exe');
  assert.equal(plan.providerFile,PROVIDER);
  assert.deepEqual([...plan.credentialFiles],[H+'\\.grok\\auth.json']);
  assert.equal(plan.lockFile,H+'\\.grok\\auth.json.lock');
  assert.deepEqual({...plan.dirPin},{root:CWD,rootFingerprint:FP});
});

test('A2 the plan is deeply frozen',()=>{
  const plan=refreshPlan(refreshOptions());
  for(const value of [plan,plan.args,plan.env,plan.dirPin,plan.credentialFiles])assert.ok(Object.isFrozen(value));
});

test('A2 grants are exactly the eight spec entries (no workspace, git, Hub lib, node, MCP or .claude)',()=>{
  const plan=refreshPlan(refreshOptions()),pairs=grantsOf(plan);
  assert.deepEqual(lower(pairs),lower(Object.entries(EXPECTED_GRANTS)));
  assert.equal(pairs.length,8);
  for(const [key] of pairs){
    const k=key.toLowerCase();
    for(const forbidden of ['.claude','\\mcp','mcp.js','\\.git','\\git','hub\\lib','package.json','workspaces','\\tools\\node','config.toml'])
      assert.equal(k.includes(forbidden),false,key+' must not be granted');
  }
  // The credential directory is writable as a whole (temp file + rename); no per-file auth.json grant.
  assert.equal(pairs.some(([k])=>/auth\.json/i.test(k)),false);
  assert.equal(pairs.some(([k])=>k.toLowerCase()===H.toLowerCase()),false,'owner home itself is not granted');
});

test('A2 the filesystem policy is ordered like createPlan (case-insensitive key order)',()=>{
  const keys=grantsOf(refreshPlan(refreshOptions())).map(([k])=>k.toLowerCase());
  assert.deepEqual(keys,[...keys].sort((a,b)=>a<b?-1:a>b?1:0));
});

test('A2 args: the createPlan sandbox wrapper, then providerFile agent --no-leader stdio, nothing else',()=>{
  const plan=refreshPlan(refreshOptions());
  const policy=plan.args.find(value=>value.startsWith(FS_PREFIX));
  assert.deepEqual([...plan.args],['sandbox','-C',CWD,'-P','hub-native','--include-managed-config','-c',policy,...WRAPPER_C,
    '--',PROVIDER,'agent','--no-leader','stdio']);
  assert.deepEqual(plan.args.slice(-3),['agent','--no-leader','stdio']);
  for(const banned of ['--tools','-m','--model','--effort','--reasoning-effort','-p','--prompt','--always-approve','--yolo'])
    assert.equal(plan.args.includes(banned),false,banned);
  assert.ok(plan.args.includes('permissions.hub-native.network.enabled=false'));
  // Same wrapper as a Grok turn: everything before the policy and between policy and `--` matches.
  const turn=createPlan(turnOptions('grok'));
  const tIdx=turn.args.indexOf('--'),rIdx=plan.args.indexOf('--');
  assert.deepEqual(plan.args.slice(0,2),turn.args.slice(0,2));
  assert.deepEqual(plan.args.slice(3,7),turn.args.slice(3,7));
  assert.deepEqual(plan.args.slice(8,rIdx),turn.args.slice(8,tIdx));
});

test('A2 env: Grok login variables, telemetry off, proxies, PATH limited to System32',()=>{
  const env=refreshPlan(refreshOptions()).env;
  assert.equal(env.GROK_HOME,GROK_HOME);
  assert.equal(env.GROK_AUTH_PATH,H+'\\.grok\\auth.json');
  assert.equal(env.GROK_DISABLE_AUTOUPDATER,'1');
  assert.equal(env.GROK_DISABLE_EXPERIMENTS,'1');
  assert.equal(env.DISABLE_TELEMETRY,'1');
  assert.equal(env.DO_NOT_TRACK,'1');
  assert.equal(env.OTEL_TRACES_EXPORTER,'none');
  assert.equal(env.HTTP_PROXY,PROXY);assert.equal(env.HTTPS_PROXY,PROXY);assert.equal(env.NO_PROXY,'');
  assert.equal(env.PATH,'C:\\Windows\\System32');
  assert.equal(env.USERPROFILE,H);
  assert.equal(env.TEMP,TMP);assert.equal(env.TMP,TMP);
  for(const key of Object.keys(env))assert.equal(/^(ANTHROPIC|CLAUDE|HUB_|PROJECT_HUB|OPENAI|XAI)/i.test(key),false,key);
});

test('A2 env is exactly the Grok turn environment with the refresh directories and a System32-only PATH',()=>{
  const env=refreshPlan(refreshOptions()).env,turn={...createPlan(turnOptions('grok')).env};
  delete turn.GROK_AUTH_PROVIDER_COMMAND;delete turn.HUB_NODE;turn.GROK_AUTH_PATH=H+'\\.grok\\auth.json';
  assert.deepEqual({...env},{...turn,HOME:GROK_HOME,APPDATA:GROK_HOME,LOCALAPPDATA:GROK_HOME,GROK_HOME,TEMP:TMP,TMP,PATH:'C:\\Windows\\System32'});
});

test('A2 another system root and runtime base move only the derived values',()=>{
  const runtimeBase=H+'\\AppData\\Local\\Packages\\Synthetic.Package\\LocalCache\\Local\\ProjectHub';
  const plan=refreshPlan(refreshOptions({systemRoot:'D:\\Windows',runtimeBase}));
  assert.equal(plan.runtimeDirectory,runtimeBase+'\\runtime\\grok-auth-refresh');
  assert.equal(plan.cwd,runtimeBase+'\\runtime\\grok-auth-refresh\\cwd');
  assert.equal(plan.env.PATH,'D:\\Windows\\System32');
  assert.equal(plan.env.SystemRoot,'D:\\Windows');
  assert.equal(plan.env.GROK_AUTH_PATH,H+'\\.grok\\auth.json');
  const grants=lower(grantsOf(plan));
  assert.equal(grants[(runtimeBase+'\\runtime\\grok-auth-refresh\\cwd').toLowerCase()],'write');
  assert.equal(grants[(H+'\\.grok').toLowerCase()],'write');
});

test('A2 plan building is pure (no filesystem calls) and deterministic',t=>{
  const calls=[];
  for(const name of ['existsSync','statSync','lstatSync','readFileSync','writeFileSync','mkdirSync','openSync','readdirSync','realpathSync'])
    t.mock.method(fs,name,function(...args){calls.push(name);throw Error('fs used: '+name);});
  const a=refreshPlan(refreshOptions()),b=refreshPlan(refreshOptions());
  t.mock.restoreAll();
  assert.deepEqual(calls,[]);
  assert.equal(JSON.stringify(a),JSON.stringify(b));
});

test('A2 missing, extra and non-data options are rejected with NATIVE_PLAN_INVALID',()=>{
  refreshPlan(refreshOptions());
  for(const key of KEYS){const o=refreshOptions();delete o[key];assert.throws(()=>refreshPlan(o),{code:'NATIVE_PLAN_INVALID'},'missing '+key);}
  for(const extra of [{actor:'grok'},{cwd:'C:\\Workspaces\\project'},{providerArgs:[]},{maxWallMs:1000},{gitDirectory:'C:\\Tools\\git'},
    {hubLibDirectory:'C:\\Tools\\hub\\lib'},{model:'grok-4'},{effort:'low'},{tools:[]},{synthetic:1}])
    assert.throws(()=>refreshPlan(refreshOptions(extra)),{code:'NATIVE_PLAN_INVALID'},Object.keys(extra)[0]);
  for(const bad of [null,undefined,[],'options',42])assert.throws(()=>refreshPlan(bad),{code:'NATIVE_PLAN_INVALID'});
  let invoked=0;const getter=refreshOptions();delete getter.proxyUrl;
  Object.defineProperty(getter,'proxyUrl',{enumerable:true,get(){invoked++;return PROXY;}});
  assert.throws(()=>refreshPlan(getter),{code:'NATIVE_PLAN_INVALID'});assert.equal(invoked,0);
  const sym=refreshOptions();sym[Symbol('x')]=1;assert.throws(()=>refreshPlan(sym),{code:'NATIVE_PLAN_INVALID'});
  class Options{constructor(){Object.assign(this,refreshOptions());}}
  assert.throws(()=>refreshPlan(new Options()),{code:'NATIVE_PLAN_INVALID'});
});

test('A2 invalid fingerprint, hash, proxy and paths are rejected with the createPlan codes',()=>{
  for(const rootFingerprint of ['A'.repeat(64),'e'.repeat(63),'e'.repeat(65),'',42,null])
    assert.throws(()=>refreshPlan(refreshOptions({rootFingerprint})),{code:'NATIVE_PLAN_INVALID'},String(rootFingerprint));
  for(const codexSHA256 of ['B'.repeat(64),'b'.repeat(63),'',null])
    assert.throws(()=>refreshPlan(refreshOptions({codexSHA256})),{code:'NATIVE_PLAN_INVALID'},String(codexSHA256));
  for(const proxyUrl of ['http://hub:short@127.0.0.1:8080','https://hub:'+'c'.repeat(64)+'@127.0.0.1:8080',
    'http://hub:'+'c'.repeat(64)+'@localhost:8080','http://hub:'+'c'.repeat(64)+'@127.0.0.1:70000','',null])
    assert.throws(()=>refreshPlan(refreshOptions({proxyUrl})),{code:'NATIVE_PROXY_INVALID'},String(proxyUrl));
  for(const runtimeBase of ['C:\\','C:\\Users\\example-user',H+'\\AppData\\Local',H+'\\AppData\\Local\\Other',
    'C:\\Users\\other\\AppData\\Local\\ProjectHub',H+'\\Documents\\ProjectHub','\\\\server\\share\\ProjectHub',H+'\\AppData\\Local\\ProjectHub\\'])
    assert.throws(()=>refreshPlan(refreshOptions({runtimeBase})),{code:'NATIVE_PATH_INVALID'},runtimeBase);
  for(const change of [{providerFile:'grok.exe'},{providerFile:'\\\\server\\share\\grok.exe'},{codexFile:'C:\\Tools\\codex\\..\\codex.exe'},
    {nodeFile:'C:\\Tools\\node\\node.exe:stream'},{systemRoot:'Windows'},{ownerHome:'C:\\'},{ownerHome:'relative\\home'},
    {providerFile:'C:\\Tools\\bad\tname\\grok.exe'}])
    assert.throws(()=>refreshPlan(refreshOptions(change)),{code:'NATIVE_PATH_INVALID'},JSON.stringify(change));
});

// Snapshot of createPlan from the round-16 tree (candidate 17 + R16), taken
// before the R17 change with the inputs of turnOptions('grok') / ('claude').
const GROK_TURN_SNAPSHOT=String.raw`{"file":"C:\\Tools\\codex\\codex.exe","args":["sandbox","-C","C:\\Workspaces\\project","-P","hub-native","--include-managed-config","-c","permissions.hub-native.filesystem={\":minimal\"=\"read\",\"C:\\\\Tools\\\\git\"=\"read\",\"C:\\\\Tools\\\\hub\\\\lib\"=\"read\",\"C:\\\\Tools\\\\hub\\\\mcp.js\"=\"read\",\"C:\\\\Tools\\\\hub\\\\package.json\"=\"read\",\"C:\\\\Tools\\\\node\"=\"read\",\"C:\\\\Users\\\\example-user\\\\.grok\\\\auth.json\"=\"read\",\"C:\\\\Users\\\\example-user\\\\.grok\\\\auth.json.lock\"=\"write\",\"C:\\\\Users\\\\example-user\\\\AppData\\\\Local\\\\ProjectHub\\\\runtime-binaries\\\\grok\\\\dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"=\"read\",\"C:\\\\Users\\\\example-user\\\\AppData\\\\Local\\\\ProjectHub\\\\runtime\\\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\\grok\\\\grok\"=\"write\",\"C:\\\\Users\\\\example-user\\\\AppData\\\\Local\\\\ProjectHub\\\\runtime\\\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\\grok\\\\grok\\\\config.toml\"=\"read\",\"C:\\\\Users\\\\example-user\\\\AppData\\\\Local\\\\ProjectHub\\\\runtime\\\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\\grok\\\\mcp\"=\"read\",\"C:\\\\Users\\\\example-user\\\\AppData\\\\Local\\\\ProjectHub\\\\runtime\\\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\\grok\\\\tmp\"=\"write\",\"C:\\\\Workspaces\\\\project\"=\"write\",\"C:\\\\Workspaces\\\\project\\\\.agents\"=\"read\",\"C:\\\\Workspaces\\\\project\\\\.ai\\\\chat\"=\"read\",\"C:\\\\Workspaces\\\\project\\\\.ai\\\\web-chat\"=\"read\",\"C:\\\\Workspaces\\\\project\\\\.aws\"=\"read\",\"C:\\\\Workspaces\\\\project\\\\.codex\"=\"read\",\"C:\\\\Workspaces\\\\project\\\\.git\"=\"read\"}","-c","permissions.hub-native.network.enabled=false","-c","shell_environment_policy.inherit=\"all\"","-c","windows.sandbox=\"elevated\"","-c","features.windows_sandbox_service=false","-c","windows.allow_mxc=false","-c","features.prefer_mxc=false","--","C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime-binaries\\grok\\dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\\grok.exe","agent","--no-leader","stdio"],"cwd":"C:\\Workspaces\\project","env":{"SystemRoot":"C:\\Windows","WINDIR":"C:\\Windows","SystemDrive":"C:","USERPROFILE":"C:\\Users\\example-user","HOME":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\grok","APPDATA":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\grok","LOCALAPPDATA":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\grok","ComSpec":"C:\\Windows\\System32\\cmd.exe","PATHEXT":".COM;.EXE;.BAT;.CMD","PATH":"C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Tools\\git\\cmd;C:\\Tools\\git\\bin;C:\\Tools\\node","TEMP":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\tmp","TMP":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\tmp","HTTP_PROXY":"http://hub:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc@127.0.0.1:8080","HTTPS_PROXY":"http://hub:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc@127.0.0.1:8080","NO_PROXY":"","GROK_HOME":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\grok","GROK_AUTH_PATH":"C:\\Users\\example-user\\.grok\\auth.json","GROK_MEMORY":"0","GROK_DISABLE_AUTOUPDATER":"1","GROK_DISABLE_EXPERIMENTS":"1","GROK_WORKTREE_TYPE":"copy","GROK_CLONE":"0","DISABLE_TELEMETRY":"1","DISABLE_ERROR_REPORTING":"1","DO_NOT_TRACK":"1","OTEL_TRACES_EXPORTER":"none"},"dirPin":{"root":"C:\\Workspaces\\project","rootFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"actor":"grok","codexSHA256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","providerFile":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime-binaries\\grok\\dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\\grok.exe","nodeFile":"C:\\Tools\\node\\node.exe","gitDirectory":"C:\\Tools\\git","hubLibDirectory":"C:\\Tools\\hub\\lib","stateDirectory":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\grok","runtimeBase":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub","runtimeDirectory":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok","mcpDirectory":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\mcp","tempDirectory":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\tmp","providerHome":"C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\runtime\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\grok\\grok","credentialFiles":["C:\\Users\\example-user\\.grok\\auth.json"],"lockFile":"C:\\Users\\example-user\\.grok\\auth.json.lock","maxWallMs":1800000}`;
const GROK_TURN_SHA256='6fdc9b8d04a3c4519b99f031fb3420c54efa3f59296d0dea9d26954f3ca98e1e';
const CLAUDE_TURN_SHA256='a9a4d458f46601b49f2db80169bdc3793e0e60927107df7d8def0777f71139e5';
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');

test('A2 Grok turn differs from the round-16 snapshot only by R25 credential isolation and R26 provider command',()=>{
  assert.equal(sha(GROK_TURN_SNAPSHOT),GROK_TURN_SHA256,'snapshot literal intact');
  const json=JSON.stringify(createPlan(turnOptions('grok')));
  const expected=JSON.parse(GROK_TURN_SNAPSHOT);
  const oldAuth=expected.credentialFiles[0],oldLock=expected.lockFile;
  expected.credentialFiles=[expected.providerHome+'\\auth.json'];expected.lockFile=expected.credentialFiles[0]+'.lock';
  const index=expected.args.findIndex(x=>x.startsWith('permissions.hub-native.filesystem='));
  expected.args[index]=expected.args[index].replace(JSON.stringify(oldAuth)+'="read",','').replace(JSON.stringify(oldLock)+'="write",','');
  expected.env.GROK_AUTH_PATH=expected.credentialFiles[0];
  expected.env.GROK_AUTH_PROVIDER_COMMAND='grok-auth-helper-sandbox.cmd';
  expected.env.PATH=expected.env.PATH+';'+expected.hubLibDirectory;expected.env.HUB_NODE=expected.nodeFile;
  assert.deepEqual(JSON.parse(json),expected);
});

test('A2 createPlan for a Claude turn is byte-identical to the round-16 snapshot',()=>{
  assert.equal(sha(JSON.stringify(createPlan(turnOptions('claude')))),CLAUDE_TURN_SHA256);
});

test('A2 the Grok turn uses provider-home credentials and never grants owner .grok',()=>{
  const turn=createPlan(turnOptions('grok')),grants=lower(grantsOf(turn));
  assert.equal(grants[(H+'\\.grok\\auth.json').toLowerCase()],undefined);
  assert.equal(grants[(H+'\\.grok\\auth.json.lock').toLowerCase()],undefined);
  assert.equal(grants[turn.providerHome.toLowerCase()],'write');
  assert.equal(Object.hasOwn(grants,(H+'\\.grok').toLowerCase()),false);
  assert.equal(Object.hasOwn(grants,'auth.x.ai'),false);
  // createPlan does not accept the refresh option set.
  assert.throws(()=>createPlan(refreshOptions()),{code:'NATIVE_PLAN_INVALID'});
});
