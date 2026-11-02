'use strict';
// Synthetic filesystem only. Never reads a provider login or existing account.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {load}=require('../lib/native-mcp-task-credential');
const fp='a'.repeat(64),run='12345678-1234-4234-8234-123456789abc';
const file=`C:\\Synthetic\\AppData\\Local\\ProjectHub\\runtime\\${fp}\\grok\\mcp\\${run}.json`;
const value={version:1,actor:'grok',rootFingerprint:fp,runId:run,port:4545,token:'z'.repeat(43)};
function fixture(t,raw=JSON.stringify(value),change={},expectedFile=file){
  const st={ino:1n,dev:2n,mtimeNs:3n,size:BigInt(Buffer.byteLength(raw)),nlink:1n,isFile:()=>true,isSymbolicLink:()=>false,...change};let closed=0,reads=0;
  t.mock.method(fs,'lstatSync',f=>{assert.equal(f,expectedFile);return st;});
  t.mock.method(fs,'openSync',f=>{assert.equal(f,expectedFile);return 42;});
  t.mock.method(fs,'fstatSync',()=>st);
  t.mock.method(fs,'readFileSync',fd=>{assert.equal(fd,42);reads++;return Buffer.from(raw);});
  t.mock.method(fs,'closeSync',fd=>{assert.equal(fd,42);closed++;});
  return ()=>({closed,reads});
}
test('exact scoped token file loads and closes; token never comes from provider auth',t=>{
  const counts=fixture(t);assert.deepEqual(load(file),{port:4545,token:value.token,runId:run});assert.deepEqual(counts(),{reads:1,closed:1});
});
test('physical package cache keeps exact task/run capability binding',t=>{
  const physical=file.replace('Local\\ProjectHub','Local\\Packages\\Synthetic.App_123\\LocalCache\\Local\\ProjectHub');
  const counts=fixture(t,JSON.stringify(value),{},physical);
  assert.deepEqual(load(physical),{port:4545,token:value.token,runId:run});
  assert.deepEqual(counts(),{reads:1,closed:1});
});
test('physical cache rejects nested package, wrong suffix and unsafe family before IO',t=>{
  let io=0;t.mock.method(fs,'lstatSync',()=>{io++;throw Error('IO_MUST_NOT_RUN');});
  for(const family of ['A\\B','..','A.','COM¹','A:stream','A?B']){
    const physical=file.replace('Local\\ProjectHub','Local\\Packages\\'+family+'\\LocalCache\\Local\\ProjectHub');
    assert.throws(()=>load(physical),{code:'MCP_TASK_CREDENTIAL_INVALID'});
  }
  assert.throws(()=>load(file.replace('Local\\ProjectHub','Local\\Packages\\Family\\Cache\\Local\\ProjectHub')),{code:'MCP_TASK_CREDENTIAL_INVALID'});
  assert.equal(io,0);
});
test('login/owner/traversal/other runtime path is rejected before any IO',t=>{
  t.mock.method(fs,'lstatSync',()=>{throw Error('IO_MUST_NOT_RUN');});
  for(const f of ['C:\\Users\\fixture\\.grok\\auth.json',file.replace('\\mcp\\','\\mcp\\..\\mcp\\'),file.replace('ProjectHub','Other'),file.replace(/\\/g,'/'),file+':stream'])assert.throws(()=>load(f),{code:'MCP_TASK_CREDENTIAL_INVALID'});
});
test('cross-run/cross-actor/root/extra key/duplicate JSON is refused and fd is closed',t=>{
  fixture(t,JSON.stringify({...value,actor:'claude'}));assert.throws(()=>load(file),{code:'MCP_TASK_CREDENTIAL_INVALID'});
});
test('duplicate JSON is refused',t=>{const counts=fixture(t,JSON.stringify(value).replace('"version":1','"version":1,"version":1'));assert.throws(()=>load(file),{code:'MCP_TASK_CREDENTIAL_INVALID'});assert.equal(counts().closed,1);});
test('link, multiple links and oversized file are refused before read',t=>{const counts=fixture(t,JSON.stringify(value),{nlink:2n});assert.throws(()=>load(file),{code:'MCP_TASK_CREDENTIAL_INVALID'});assert.equal(counts().reads,0);});
test('opened file identity must still match lstat identity',t=>{const counts=fixture(t);t.mock.method(fs,'fstatSync',()=>({ino:99n,dev:2n,mtimeNs:3n,size:1n,nlink:1n}));assert.throws(()=>load(file),{code:'MCP_TASK_CREDENTIAL_INVALID'});assert.equal(counts().closed,1);assert.equal(counts().reads,0);});
