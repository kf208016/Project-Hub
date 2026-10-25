'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {codeOf}=require('../lib/native-provider-diagnostic');
test('native public diagnostics retain fixed startup categories without provider text or arbitrary strings',()=>{
  for(const code of ['NATIVE_CODEX_VERSION_UNREVIEWED','NATIVE_BINARY_UNAVAILABLE','NATIVE_PROFILE_UNAVAILABLE','GROK_NATIVE_INIT_TIMEOUT','GROK_NATIVE_MODEL_MISMATCH','CLAUDE_NATIVE_INIT_FAILED','CLAUDE_NATIVE_SUBAGENT_SCOPE'])assert.equal(codeOf({code,message:'private synthetic text'}),code);
  for(const error of [null,{},'NATIVE_BINARY_UNAVAILABLE',{code:'NATIVE_PRIVATE_SYNTHETIC_TOKEN'},{code:'NATIVE_BINARY_UNAVAILABLE\nprivate'},{code:123},{message:'GROK_NATIVE_INIT_TIMEOUT'}])assert.equal(codeOf(error),null);
});
test('diagnostic extraction does not invoke accessors or inherited fields',()=>{
  let touched=0;const value=Object.defineProperty({},'code',{get(){touched++;throw Error('getter');}});
  assert.equal(codeOf(value),null);assert.equal(touched,0);assert.equal(codeOf(Object.create({code:'NATIVE_BINARY_UNAVAILABLE'})),null);
});

test('Claude stream shape diagnostics admit only the fixed stage enum',()=>{
  const codes=['CLAUDE_NATIVE_FRAME_INVALID','CLAUDE_NATIVE_SYSTEM_METADATA_INVALID','CLAUDE_NATIVE_RATE_LIMIT_STATE',
    'CLAUDE_NATIVE_ASSISTANT_ENVELOPE','CLAUDE_NATIVE_ASSISTANT_BLOCK','CLAUDE_NATIVE_ASSISTANT_TEXT','CLAUDE_NATIVE_ASSISTANT_TOOL_USE',
    'CLAUDE_NATIVE_USER_ENVELOPE','CLAUDE_NATIVE_TOOL_RESULT_INVALID','CLAUDE_NATIVE_TOOL_RESULT_CONTENT','CLAUDE_NATIVE_TOOL_RESULT_ERROR',
    'CLAUDE_NATIVE_OUTPUT_CHUNK_INVALID'];
  for(const code of codes){
    assert.equal(codeOf({code,message:'PRIVATE_SYNTHETIC_PROVIDER_CONTENT'}),code);
    assert.equal(codeOf({code:code+'_PRIVATE_SYNTHETIC'}),null);
    assert.equal(codeOf({code:code+'\nPRIVATE_SYNTHETIC'}),null);
  }
});

test('native setup diagnostics admit exactly the five fixed failure stages',()=>{
  for(const stage of ['RESOLVE','AUTHORIZE','BROKER','REBIND','PUBLISH']){
    const code='NATIVE_SETUP_'+stage+'_FAILED';assert.equal(codeOf({code,message:'PRIVATE_SYNTHETIC_CALLBACK'}),code);
    assert.equal(codeOf({code:code+'_PRIVATE_SYNTHETIC'}),null);
    assert.equal(codeOf(Object.create({code})),null);
    let touched=0;const accessor=Object.defineProperty({},'code',{get(){touched++;return code;}});
    assert.equal(codeOf(accessor),null);assert.equal(touched,0);
  }
  for(const code of ['NATIVE_SETUP_OTHER_FAILED','NATIVE_SETUP_RESOLVE_FAILED\nPRIVATE_SYNTHETIC','NATIVE_SETUP_resolve_FAILED'])assert.equal(codeOf({code}),null);
});


test('public codes survive nativeWorkspaceError and remain a fixed enum',()=>{
  const codes='SESSION_SCOPE_CHANGED SESSION_BINDING_REQUIRED SESSION_BINDING_CORRUPT SESSION_SCOPE_INVALID SESSION_REPLACEMENT_REQUIRED CHAT_META_CORRUPT CHAT_META_CORRUPT CHAT_META_WRITE_FAILED GROK_NATIVE_RESUME_FAILED CLAUDE_NATIVE_RESUME_FAILED WORKSPACE_CLEANUP_REQUIRED WORKSPACE_RECORD_WRITE_FAILED WORKSPACE_REENTRY_BUSY PROCWATCH_SPAWN_FAILED PROCWATCH_TIMEOUT PROCWATCH_EXIT_FAILED PROCWATCH_OUTPUT_LIMIT PROCWATCH_OUTPUT_INVALID PROCWATCH_EMPTY PROCWATCH_INTERNAL PROCWATCH_STALE PROCWATCH_UNASSIGNED_AI PROCWATCH_NOT_READY'.split(' ');
  for(const code of codes){assert.equal(codeOf({code}),code);assert.equal(codeOf({code:code+'_PRIVATE'}),null);}
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const fn=source.match(/^function nativeWorkspaceError[^\n]+/m)[0],context=vm.createContext({require:name=>name==='./lib/native-provider-diagnostic'?{codeOf}:require(name)});vm.runInContext(fn,context);
  const response=context.nativeWorkspaceError(Object.assign(Error('安全訊息'),{code:'WORKSPACE_RECORD_WRITE_FAILED',cause:'PRIVATE'}));assert.equal(response.code,'WORKSPACE_RECORD_WRITE_FAILED');assert.equal(JSON.stringify(response).includes('PRIVATE'),false);
  assert.match(source,/r\.freshSession\?\{freshSession:r\.freshSession\}/);assert.match(source,/onFailure: d => record\('procwatch', \{\}, \{code: d.code, detail: d\}\)/);
});


test('idle codes remain public diagnostics without retiring resumed sessions',()=>{
  for(const actor of ['CLAUDE','GROK']){
    const code=actor+'_NATIVE_IDLE_TIMEOUT';assert.equal(codeOf({code}),code);assert.equal(codeOf({code:code+'_PRIVATE'}),null);
  }
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../lib/chat.js'),'utf8');
  const list=source.match(/\[([^\]]+)\]\.includes\(resumeCode\)/)[1];
  assert.equal(list.includes('IDLE_TIMEOUT'),false);
});
