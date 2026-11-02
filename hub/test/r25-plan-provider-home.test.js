'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const {createPlan}=require('../lib/provider-native-plan');
const options={actor:'grok',cwd:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),ownerHome:'C:\\Users\\synthetic',runtimeBase:'C:\\Users\\synthetic\\AppData\\Local\\ProjectHub',providerFile:'C:\\Tools\\grok.exe',codexFile:'C:\\Sandbox\\codex.exe',codexSHA256:'b'.repeat(64),nodeFile:'C:\\Node\\node.exe',gitDirectory:'C:\\Git',hubLibDirectory:'C:\\Hub\\lib',providerArgs:[],proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:8080',systemRoot:'C:\\Windows'};
test('Grok auth and lock are confined to provider home, helper command is a bare file name on PATH',()=>{
  const p=createPlan(options),toml=p.args.find(x=>x.startsWith('permissions.hub-native.filesystem='));
  assert.equal(p.credentialFiles[0],p.providerHome+'\\auth.json');assert.equal(p.lockFile,p.credentialFiles[0]+'.lock');
  assert.ok(!toml.includes('.grok'));assert.equal(p.env.GROK_AUTH_PATH,p.credentialFiles[0]);
  assert.equal(p.env.GROK_AUTH_PROVIDER_COMMAND,'grok-auth-helper-sandbox.cmd');
  assert.equal(p.env.PATH.split(';').at(-1),options.hubLibDirectory);assert.equal(p.env.HUB_NODE,options.nodeFile);
  assert.equal(p.providerHome,path.win32.join(options.runtimeBase,'runtime',options.rootFingerprint,'grok','grok'));
});
test('Claude plan is byte-identical to the untouched candidate 25 implementation',()=>{
  const filename=path.resolve(__dirname,'../lib/provider-native-plan.js');
  const source=execFileSync('git',['show','HEAD:hub/lib/provider-native-plan.js'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'});
  const oldModule={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source+'\n})',{filename})(createRequire(filename),oldModule,oldModule.exports);
  const o={...options,actor:'claude'};assert.ok(!createPlan(o).env.PATH.includes(options.hubLibDirectory));assert.equal(JSON.stringify(createPlan(o)),JSON.stringify(oldModule.exports.createPlan(o)));
});
