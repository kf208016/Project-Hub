'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlan } = require('../lib/provider-native-plan');

function baseOptions(overrides) {
  const opts = {
    actor: 'claude',
    cwd: 'C:\\Workspaces\\project',
    rootFingerprint: 'a'.repeat(64),
    ownerHome: 'C:\\Users\\example-user',
    runtimeBase: 'C:\\Users\\example-user\\AppData\\Local\\ProjectHub',
    providerFile: 'C:\\Tools\\provider\\provider.exe',
    codexFile: 'C:\\Tools\\codex\\codex.exe',
    codexSHA256: 'b'.repeat(64),
    nodeFile: 'C:\\Tools\\node\\node.exe',
    gitDirectory: 'C:\\Tools\\git',
    hubLibDirectory: 'C:\\Tools\\hublib',
    providerArgs: ['--flag', 'value'],
    proxyUrl: 'http://hub:' + 'c'.repeat(64) + '@127.0.0.1:8080',
    systemRoot: 'C:\\Windows',
  };
  return Object.assign(opts, overrides || {});
}

test('claude plan builds successfully with correct credential mapping', () => {
  const plan = createPlan(baseOptions());
  assert.equal(plan.actor, 'claude');
  assert.equal(plan.lockFile, null);
  assert.equal(plan.credentialFiles.length, 2);
  assert.ok(plan.credentialFiles[0].toLowerCase().includes('.claude\\.credentials.json'));
  assert.ok(plan.credentialFiles[1].toLowerCase().endsWith('.claude.json'));
  assert.ok(plan.stateDirectory.toLowerCase().includes('.claude\\projects\\'));
  assert.equal(plan.providerHome.toLowerCase(), 'c:\\users\\example-user');
  assert.equal(plan.env.HOME.toLowerCase(), 'c:\\users\\example-user');
  assert.ok(!('HUB_API_KEY' in plan.env));
});

test('grok plan builds successfully with lock file and private home', () => {
  const plan = createPlan(baseOptions({ actor: 'grok' }));
  assert.equal(plan.actor, 'grok');
  assert.ok(plan.lockFile.toLowerCase().endsWith('auth.json.lock'));
  assert.equal(plan.credentialFiles.length, 1);
  assert.ok(plan.credentialFiles[0].toLowerCase().endsWith('.grok\\auth.json'));
  assert.ok(plan.stateDirectory.toLowerCase().includes('appdata\\local\\projecthub\\runtime'));
  assert.equal(plan.stateDirectory.startsWith(plan.cwd+'\\'),false);
  assert.equal(plan.providerHome, plan.stateDirectory);
  assert.equal(plan.env.USERPROFILE, 'C:\\Users\\example-user');
  assert.equal(plan.env.HOME, plan.providerHome);
  assert.equal(plan.env.APPDATA, plan.providerHome);
  assert.equal(plan.env.LOCALAPPDATA, plan.providerHome);
  assert.equal(plan.env.GROK_HOME, plan.providerHome);
  assert.notEqual(plan.env.USERPROFILE, plan.providerHome);
  assert.equal(plan.env.GROK_AUTH_PATH, plan.credentialFiles[0]);
  assert.equal(plan.credentialFiles[0], 'C:\\Users\\example-user\\.grok\\auth.json');
  assert.equal(plan.lockFile, 'C:\\Users\\example-user\\.grok\\auth.json.lock');
});

test('Grok bare PowerShell lookup uses only the controller Windows runtime path without new grants',()=>{
  for(const systemRoot of ['C:\\Windows','D:\\Windows']){
    const plan=createPlan(baseOptions({actor:'grok',systemRoot}));
    assert.deepEqual(plan.env.PATH.split(';'),[
      systemRoot+'\\System32',systemRoot+'\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Tools\\git\\cmd','C:\\Tools\\git\\bin','C:\\Tools\\node'
    ]);
    assert.equal(plan.env.ComSpec,systemRoot+'\\System32\\cmd.exe');
    assert.equal(plan.args.some(value=>value.includes('WindowsPowerShell')),false);
    assert.ok(plan.args.includes('permissions.hub-native.network.enabled=false'));
  }
  assert.deepEqual(createPlan(baseOptions()).env.PATH.split(';'),[
    'C:\\Windows\\System32','C:\\Tools\\git\\cmd','C:\\Tools\\git\\bin','C:\\Tools\\node'
  ]);
});

test('runtime directories follow the controller physical base without changing auth grants', () => {
  const runtimeBase='C:\\Users\\example-user\\AppData\\Local\\Packages\\Synthetic.Package\\LocalCache\\Local\\ProjectHub';
  for(const actor of ['claude','grok']){
    const plan=createPlan(baseOptions({actor,runtimeBase}));
    assert.equal(plan.runtimeBase,runtimeBase);
    assert.equal(plan.runtimeDirectory,runtimeBase+'\\runtime\\'+'a'.repeat(64)+'\\'+actor);
    assert.equal(plan.tempDirectory,plan.runtimeDirectory+'\\tmp');
    assert.equal(plan.mcpDirectory,plan.runtimeDirectory+'\\mcp');
    if(actor==='grok')assert.equal(plan.providerHome,plan.runtimeDirectory+'\\grok');
    assert.ok(plan.credentialFiles.every(file=>file.startsWith('C:\\Users\\example-user\\.')));
    const policy=plan.args.find(value=>value.startsWith('permissions.hub-native.filesystem='));
    assert.ok(!policy.includes(JSON.stringify(runtimeBase)+'='));
    assert.ok(!policy.includes(JSON.stringify(plan.env.USERPROFILE)+'='));
    assert.ok(policy.includes(JSON.stringify(plan.tempDirectory)+'="write"'));
  }
});

test('runtime base is required and confined to a canonical private LocalAppData ProjectHub directory', () => {
  const missing=baseOptions();delete missing.runtimeBase;
  assert.throws(()=>createPlan(missing),{code:'NATIVE_PLAN_INVALID'});
  for(const runtimeBase of [undefined,null,'C:\\','C:\\Users\\example-user','C:\\Users\\example-user\\AppData\\Local',
    'C:\\Users\\example-user\\AppData\\Local\\Other','C:\\Users\\other\\AppData\\Local\\ProjectHub',
    'C:\\Users\\example-user\\Documents\\ProjectHub','C:\\Users\\example-user\\AppData\\Local\\..\\ProjectHub',
    'C:\\Users\\example-user\\AppData\\Local\\ProjectHub:stream','\\\\server\\share\\ProjectHub',
    'C:\\Users\\example-user\\AppData\\Local\\ProjectHub.','C:\\Users\\example-user\\AppData\\Local\\ProjectHub\\']){
    assert.throws(()=>createPlan(baseOptions({runtimeBase})),{code:'NATIVE_PATH_INVALID'});
  }
});

test('runtime base rejects a workspace ancestor and system or credential tree overlap', () => {
  const runtimeBase=baseOptions().runtimeBase;
  for(const change of [{cwd:runtimeBase},
    {cwd:'C:\\Users\\example-user\\AppData\\Local'},{systemRoot:runtimeBase},
    {systemRoot:runtimeBase+'\\Windows'},
    {runtimeBase:'C:\\Users\\example-user\\.grok\\AppData\\Local\\ProjectHub'}]){
    assert.throws(()=>createPlan(baseOptions({...change,actor:'grok'})),{code:'NATIVE_PATH_INVALID'});
  }
});

test('a sibling worktree inside the private base remains supported without runtime or binary overlap', () => {
  const runtimeBase=baseOptions().runtimeBase,cwd=runtimeBase+'\\worktrees\\synthetic';
  for(const actor of ['claude','grok']){
    assert.equal(createPlan(baseOptions({actor,cwd})).cwd,cwd);
    const runtimeDirectory=runtimeBase+'\\runtime\\'+'a'.repeat(64)+'\\'+actor;
    for(const unsafe of [runtimeDirectory,runtimeDirectory+'\\workspace',runtimeBase+'\\runtime']){
      assert.throws(()=>createPlan(baseOptions({actor,cwd:unsafe})),{code:'NATIVE_PATH_INVALID'});
    }
    assert.throws(()=>createPlan(baseOptions({actor,cwd,providerFile:cwd+'\\provider.exe'})),{code:'NATIVE_PATH_INVALID'});
  }
});

test('private runtime leaves reject executable and read-tree overlaps but permit a sibling pinned cache', () => {
  const runtimeDirectory=baseOptions().runtimeBase+'\\runtime\\'+'a'.repeat(64)+'\\grok';
  for(const change of [{providerFile:runtimeDirectory+'\\provider.exe'},
    {codexFile:runtimeDirectory+'\\mcp\\codex.exe'},
    {nodeFile:runtimeDirectory+'\\tmp\\node.exe'},
    {hubLibDirectory:runtimeDirectory+'\\mcp\\lib'},
    {gitDirectory:baseOptions().runtimeBase}]){
    assert.throws(()=>createPlan(baseOptions({...change,actor:'grok'})),{code:'NATIVE_PATH_INVALID'});
  }
  const providerFile=baseOptions().runtimeBase+'\\runtime-binaries\\claude\\'+'d'.repeat(64)+'\\claude.exe';
  assert.equal(createPlan(baseOptions({providerFile})).providerFile,providerFile);
});

test('sandbox filesystem contract uses exact keyed inline TOML, not an unused read/write list', () => {
  for (const actor of ['claude', 'grok']) {
    const plan=createPlan(baseOptions({actor}));
    const policy=plan.args.find(x=>x.startsWith('permissions.hub-native.filesystem='));
    assert.ok(policy);
    assert.ok(policy.startsWith('permissions.hub-native.filesystem={'));
    assert.ok(policy.endsWith('}'));
    assert.ok(policy.includes('\":minimal\"=\"read\"'));
    assert.ok(policy.includes(JSON.stringify(plan.cwd)+'="write"'));
    for(const credential of plan.credentialFiles){
      assert.ok(policy.includes(JSON.stringify(credential)+'="read"'));
      assert.ok(!policy.includes(JSON.stringify(credential)+'="write"'));
    }
    assert.ok(!policy.includes('\":root\"'));
    assert.ok(!policy.includes(JSON.stringify(baseOptions().ownerHome)+'='));
    assert.ok(!policy.includes('mode="minimal"'));
    if(actor==='grok')assert.ok(policy.includes(JSON.stringify(plan.providerHome+'\\config.toml')+'="read"'));
  }
});

test('normal Windows Documents workspaces inside the owner profile are permitted', () => {
  const cwd='C:\\Users\\example-user\\Documents\\synthetic-workspace';
  assert.equal(createPlan(baseOptions({cwd})).cwd,cwd);
  assert.equal(createPlan(baseOptions({cwd:cwd.replaceAll('\\','/')})).cwd,cwd);
  assert.throws(()=>createPlan(baseOptions({cwd:'C:\\Users'})),{code:'NATIVE_PATH_INVALID'});
});

test('runtime directories cannot broaden exact credential or session-state grants', () => {
  for(const change of [{hubLibDirectory:'C:\\Users\\example-user'}, {gitDirectory:'C:\\Users'},
    {nodeFile:'C:\\node.exe'}, {providerFile:'C:\\Users\\example-user\\.grok\\grok.exe'}]){
    assert.throws(()=>createPlan(baseOptions({...change,actor:'grok'})),{code:'NATIVE_PATH_INVALID'});
  }
});

test('argument arrays reject holes, inherited getters and noncanonical numeric properties', () => {
  let invoked=0;
  const args=new Array(1),prototype=Object.create(Array.prototype);
  Object.defineProperty(prototype,'0',{get(){invoked++;return 'synthetic';}});
  Object.setPrototypeOf(args,prototype);
  assert.throws(()=>createPlan(baseOptions({providerArgs:args})),{code:'NATIVE_ARGS_INVALID'});
  assert.equal(invoked,0);
  const alias=['synthetic'];alias['01']='not-an-index';
  assert.throws(()=>createPlan(baseOptions({providerArgs:alias})),{code:'NATIVE_ARGS_INVALID'});
});

test('Windows path controls, oversized paths and superscript device names are rejected', () => {
  for(const cwd of ['C:\\Workspaces\\bad\tname','C:\\Workspaces\\COM¹.txt','C:\\Workspaces\\'+'a'.repeat(32760)]){
    assert.throws(()=>createPlan(baseOptions({cwd})),{code:'NATIVE_PATH_INVALID'});
  }
});

test('network is always disabled in generated args', () => {
  const plan = createPlan(baseOptions());
  assert.ok(plan.args.includes('permissions.hub-native.network.enabled=false'));
});

test('plan is deterministic for same inputs', () => {
  const a = createPlan(baseOptions());
  const b = createPlan(baseOptions());
  assert.deepEqual(a.args, b.args);
  assert.deepEqual(a.env, b.env);
});

test('paths are normalized and case preserved sensibly', () => {
  const plan = createPlan(baseOptions({ cwd: 'c:\\Workspaces\\project' }));
  assert.equal(plan.cwd.toLowerCase(), 'c:\\workspaces\\project');
});

test('provider args bytes are preserved in order', () => {
  const plan = createPlan(baseOptions({ providerArgs: ['--a', 'b c', 'd\u00e9'] }));
  const tail = plan.args.slice(plan.args.indexOf('--') + 1);
  assert.deepEqual(tail.slice(1), ['--a', 'b c', 'd\u00e9']);
});

test('returned plan and nested structures are deeply frozen', () => {
  const plan = createPlan(baseOptions());
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.args));
  assert.ok(Object.isFrozen(plan.env));
  assert.ok(Object.isFrozen(plan.dirPin));
  assert.throws(() => { plan.cwd = 'x'; });
});

test('mutating input options after call does not affect returned plan', () => {
  const opts = baseOptions();
  const plan = createPlan(opts);
  opts.cwd = 'C:\\Other\\Dir';
  opts.providerArgs.push('--mutated');
  assert.notEqual(plan.cwd, opts.cwd);
  assert.ok(!plan.args.includes('--mutated'));
});

test('rejects UNC paths', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: '\\\\server\\share\\dir' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects device paths', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: '\\\\.\\C:\\dir' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects dot-dot traversal segments', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Workspaces\\..\\project' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects NTFS alternate data stream paths', () => {
  assert.throws(() => createPlan(baseOptions({ providerFile: 'C:\\Tools\\provider\\provider.exe:stream' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects reserved device names', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Workspaces\\CON' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects trailing dot/space components', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Workspaces\\project. ' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects drive root as cwd', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects profile root as ownerHome alias of drive root', () => {
  assert.throws(() => createPlan(baseOptions({ ownerHome: 'C:\\' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects cwd equal to ownerHome', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Users\\example-user' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects cwd inside systemRoot', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Windows\\Temp' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects cwd inside owner .claude tree', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Users\\example-user\\.claude\\sub' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects cwd containing provider binary tree', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Tools' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects cwd that is ancestor making binary writable', () => {
  assert.throws(() => createPlan(baseOptions({ cwd: 'C:\\Tools\\provider' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects unknown top-level fields', () => {
  assert.throws(() => createPlan(baseOptions({ networkAccess: true })), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects missing required field', () => {
  const opts = baseOptions();
  delete opts.gitDirectory;
  assert.throws(() => createPlan(opts), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects accessor properties without ever invoking the getter', () => {
  let invoked = false;
  const opts = baseOptions();
  Object.defineProperty(opts, 'cwd', {
    enumerable: true,
    configurable: true,
    get() { invoked = true; return 'C:\\Workspaces\\project'; },
  });
  assert.throws(() => createPlan(opts), { code: 'NATIVE_PLAN_INVALID' });
  assert.equal(invoked, false);
});

test('rejects symbol-keyed properties on options', () => {
  const opts = baseOptions();
  opts[Symbol('x')] = 1;
  assert.throws(() => createPlan(opts), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects non-enumerable properties on options', () => {
  const opts = baseOptions();
  Object.defineProperty(opts, 'extra', { value: 1, enumerable: false });
  assert.throws(() => createPlan(opts), { code: 'NATIVE_PLAN_INVALID' });
});

test('handles cyclic options object by rejecting safely (no crash)', () => {
  const opts = baseOptions();
  opts.self = opts;
  assert.throws(() => createPlan(opts), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects non-plain object options such as class instances', () => {
  class Foo {}
  const opts = new Foo();
  Object.assign(opts, baseOptions());
  assert.throws(() => createPlan(opts), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects providerArgs array with extra named property', () => {
  const opts = baseOptions();
  opts.providerArgs = ['--a'];
  opts.providerArgs.extra = 'x';
  assert.throws(() => createPlan(opts), { code: 'NATIVE_ARGS_INVALID' });
});

test('rejects providerArgs with bad unicode (unpaired surrogate)', () => {
  const opts = baseOptions();
  opts.providerArgs = ['--a', '\uD800'];
  assert.throws(() => createPlan(opts), { code: 'NATIVE_ARGS_INVALID' });
});

test('rejects providerArgs exceeding count limit', () => {
  const opts = baseOptions();
  opts.providerArgs = new Array(1025).fill('x');
  assert.throws(() => createPlan(opts), { code: 'NATIVE_ARGS_INVALID' });
});

test('rejects standalone bypass flags', () => {
  for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--always-approve', '--yolo']) {
    assert.throws(() => createPlan(baseOptions({ providerArgs: [flag] })), { code: 'NATIVE_ARGS_INVALID' });
  }
});

test('does not reject bypass-like text embedded inside a JSON string argument', () => {
  const plan = createPlan(baseOptions({ providerArgs: ['--config', '{"note":"--dangerously-skip-permissions"}'] }));
  assert.ok(plan.args.includes('{"note":"--dangerously-skip-permissions"}'));
});

test('rejects malformed proxy url missing credential', () => {
  assert.throws(() => createPlan(baseOptions({ proxyUrl: 'http://hub@127.0.0.1:8080' })), { code: 'NATIVE_PROXY_INVALID' });
});

test('rejects proxy url with non-loopback host', () => {
  assert.throws(() => createPlan(baseOptions({ proxyUrl: 'http://hub:' + 'd'.repeat(64) + '@10.0.0.1:8080' })), { code: 'NATIVE_PROXY_INVALID' });
});

test('rejects proxy url with out-of-range port', () => {
  assert.throws(() => createPlan(baseOptions({ proxyUrl: 'http://hub:' + 'd'.repeat(64) + '@127.0.0.1:70000' })), { code: 'NATIVE_PROXY_INVALID' });
});

test('rejects invalid rootFingerprint format', () => {
  assert.throws(() => createPlan(baseOptions({ rootFingerprint: 'ZZ' })), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects invalid codexSHA256 format', () => {
  assert.throws(() => createPlan(baseOptions({ codexSHA256: '123' })), { code: 'NATIVE_PLAN_INVALID' });
});

test('rejects out-of-range maxWallMs', () => {
  assert.throws(() => createPlan(baseOptions({ maxWallMs: 0 })), { code: 'NATIVE_PLAN_INVALID' });
  assert.throws(() => createPlan(baseOptions({ maxWallMs: 1800001 })), { code: 'NATIVE_PLAN_INVALID' });
  assert.throws(() => createPlan(baseOptions({ maxWallMs: 1.5 })), { code: 'NATIVE_PLAN_INVALID' });
});

test('accepts custom valid maxWallMs', () => {
  const plan = createPlan(baseOptions({ maxWallMs: 1000 }));
  assert.equal(plan.maxWallMs, 1000);
});

test('rejects state directory overlapping an executable grant (codex under cwd state tree)', () => {
  const opts = baseOptions();
  opts.codexFile = opts.cwd + '\\.hub-runtime\\grok\\.grok\\codex.exe';
  assert.throws(() => createPlan(Object.assign(opts, { actor: 'grok' })), { code: 'NATIVE_PATH_INVALID' });
});

test('rejects cwd that is inside owner auth/.grok home', () => {
  assert.throws(() => createPlan(baseOptions({ actor: 'grok', cwd: 'C:\\Users\\example-user\\.grok\\work' })), { code: 'NATIVE_PATH_INVALID' });
});

test('does not expose arbitrary network/env configuration options', () => {
  const plan = createPlan(baseOptions());
  assert.ok(!('NODE_OPTIONS' in plan.env));
  assert.ok(!('HUB_SECRET' in plan.env));
  assert.equal(plan.env.NO_PROXY, '');
});


test('frozen turn limits and plan default share the thirty-minute boundary',()=>{
  const limits=require('../lib/native-turn-limits');
  assert.equal(Object.isFrozen(limits),true);assert.deepEqual(limits,{MAX_WALL_MS:1800000,IDLE_MS:600000});
  for(const actor of ['claude','grok']){
    assert.equal(createPlan(baseOptions({actor})).maxWallMs,limits.MAX_WALL_MS);
    assert.equal(createPlan(baseOptions({actor,maxWallMs:1800000})).maxWallMs,1800000);
    assert.throws(()=>createPlan(baseOptions({actor,maxWallMs:1800001})),{code:'NATIVE_PLAN_INVALID'});
  }
});

test('both native providers pin legacy elevated sandbox and disable service and MXC',()=>{
 for(const actor of ['claude','grok']){const plan=createPlan(baseOptions({actor}));for(const pin of ['windows.sandbox="elevated"','features.windows_sandbox_service=false','windows.allow_mxc=false','features.prefer_mxc=false']){const i=plan.args.indexOf(pin);assert.ok(i>0);assert.equal(plan.args[i-1],'-c');assert.ok(i<plan.args.indexOf('--'));}assert.equal(plan.args.includes('--disable'),false);}
});
