'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),providers=require('../lib/provider-registry'),{forChat}=require('../lib/native-chat-permission');
test('approved native Chat cannot enter the raw command resolver or obtain a PTY grant',()=>{
  for(const actor of ['claude','grok']){
    const nativeAuthorities={[actor]:providers.createNativeAuthority(actor,['chat'],()=>true)};
    assert.equal(forChat(actor,{platform:'win32',nativeAuthorities,legacy:()=>{throw Error('RAW_COMMAND_MUST_NOT_RUN');}}),'hub-native-chat:'+actor);
    assert.throws(()=>providers.assertCapability(actor,'spawn',{platform:'win32',nativeAuthorities}),{code:'ACTOR_CAPABILITY_UNAVAILABLE'});
  }
});
test('forged, wrong actor, stale and spawn-only references cannot authorize native Chat',()=>{
  const spawnOnly=providers.createNativeAuthority('claude',['spawn'],()=>true),wrong=providers.createNativeAuthority('grok',['chat'],()=>true),stale=providers.createNativeAuthority('claude',['chat'],()=>false);
  for(const ref of [{},spawnOnly,wrong,stale])assert.throws(()=>forChat('claude',{platform:'win32',nativeAuthorities:{claude:ref},legacy:()=>{throw Error('NO_LEGACY_FALLBACK');}}),e=>['WINDOWS_PROVIDER_ISOLATION_UNVERIFIED','ACTOR_CAPABILITY_UNAVAILABLE'].includes(e.code));
});
test('existing Codex and non-Windows Chat use the existing resolver; web actors cannot execute',()=>{
  const seen=[],legacy=a=>{seen.push(a);return a+' original settings';};
  assert.equal(forChat('codex',{platform:'win32',legacy}),'codex original settings');
  assert.equal(forChat('claude-code',{platform:'darwin',legacy}),'claude original settings');
  assert.deepEqual(seen,['codex','claude']);assert.throws(()=>forChat('chatgpt',{platform:'win32',legacy}),{code:'CLI_ACTOR_REQUIRED'});
});
