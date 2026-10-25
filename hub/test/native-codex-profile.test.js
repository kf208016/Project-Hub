'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const profile=require('../lib/native-codex-profile'),artifacts=require('../lib/native-cli-update'),{REVIEWED}=require('../lib/codex-versions');
test('active and fallback helper selection bind each exact reviewed binary hash',t=>{
 for(const [version,review]of Object.entries(REVIEWED)){
  const active={file:process.execPath,version,binaryHash:review.binaryHash};assert.deepEqual(profile.resolve({updater:{active:()=>active}}),active);
  t.mock.method(artifacts,'digestFile',()=>review.binaryHash);assert.deepEqual(profile.resolve({file:process.execPath}),{file:process.execPath,version,binaryHash:review.binaryHash});
 }
 // A stale startup/poll error flag no longer blocks: every resolve re-checks the slot and the helper hash.
 assert.equal(profile.resolve({error:'ACTIVE_STATE_REJECTED',file:process.execPath}).version,'0.164.0');
 assert.throws(()=>profile.resolve({updater:{active:()=>{throw Error('PRIVATE');}}}),e=>e.code==='NATIVE_CODEX_VERSION_UNREVIEWED'&&!e.message.includes('PRIVATE'));
 assert.throws(()=>profile.resolve({updater:{active:()=>({file:process.execPath,version:'0.164.0',binaryHash:REVIEWED['0.154.0'].binaryHash})}}),{code:'NATIVE_CODEX_VERSION_UNREVIEWED'});
});
test('unknown npm helper hash reports a bounded package version and never executes it',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'unreviewed-')),pkg=path.join(root,'node_modules/@openai/codex');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(pkg,{recursive:true});
 t.mock.method(artifacts,'digestFile',()=> '0'.repeat(64));
 for(const version of ['0.165.0','PRIVATE_TOKEN']){fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version}));assert.throws(()=>profile.resolve({file:path.join(root,'codex.cmd')}),e=>e.code==='NATIVE_CODEX_VERSION_UNREVIEWED'&&e.notStarted===true&&e.message.includes(version==='0.165.0'?'目前 0.165.0':'目前 未知')&&!e.message.includes('PRIVATE_TOKEN'));}
});
