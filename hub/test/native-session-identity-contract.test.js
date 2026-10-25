'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {NativeProviderService}=require('../lib/native-provider-service');
const artifacts=require('../lib/native-cli-update'),safe=require('../lib/safe-path');
const host=require('../lib/provider-native-host'),egress=require('../lib/provider-egress');
const scoped=require('../lib/scoped-file');
const scope={actor:'grok',project:'synthetic',task:'t',model:'Grok 4.6',effort:'中'};
const binding={project:scope.project,task:scope.task,dir:'C:\\Synthetic\\workspace',rootFingerprint:'a'.repeat(64),run:'workspace-run'};
function fixture(t,callbacks={}){
  let inode=1n,size=123n,mtimeNs=10n,dev=1n,network=0,closed=0,disposed=0,reads=0,spawned=0,runtimeFingerprint='b'.repeat(64);
  const settings={ownerHome:'C:\\Users\\fixture',runtimeBase:'C:\\Users\\fixture\\AppData\\Local\\ProjectHub',providerFile:'C:\\Tools\\provider\\grok.exe',codexFile:'C:\\Tools\\codex\\codex.exe',codexSHA256:artifacts.KNOWN,
    nodeFile:process.execPath,gitDirectory:'C:\\Tools\\git',hubLibDirectory:'C:\\Tools\\hub\\lib',systemRoot:'C:\\Windows'};
  t.mock.method(scoped,'identity',async file=>{assert.equal(file,settings.runtimeBase);assert.ok(file.startsWith('C:\\Users\\')&&file.includes('\\AppData\\Local\\'));return {rootFingerprint:runtimeFingerprint};});
  t.mock.method(artifacts,'digestFile',file=>file.endsWith('codex.exe')?artifacts.KNOWN:file.toLowerCase().endsWith('claude.exe')?host.PROVIDER_HASHES.claude:host.PROVIDER_HASHES.grok);
  t.mock.method(safe,'localPath',file=>file);
  t.mock.method(fs,'lstatSync',(_file,opts)=>({isFile:()=>true,nlink:opts?.bigint?1n:1,size:opts?.bigint?size:Number(size),ino:inode,dev,mtimeNs}));
  t.mock.method(fs,'readFileSync',()=>{reads++;throw Error('CREDENTIAL_CONTENT_READ_FORBIDDEN');});
  t.mock.method(egress,'create',async()=>{network++;return {proxyUrl:'http://hub:'+'f'.repeat(64)+'@127.0.0.1:12345',snapshot:()=>({}),close:async()=>{closed++;}};});
  const service=new NativeProviderService({resolveWorkspace:async()=>binding,
    profile:()=>({...settings}),
    modelFlag:(_a,m)=>m==='Grok 4.6'?'grok-4.6':m==='Sonnet'?'sonnet':'',effortFlag:()=>'medium',
    supervisedSpawn:()=>{spawned++;throw Error('NO_CHILD_EXPECTED');},dispose:async()=>{disposed++;},...callbacks
  });
  return {service,settings,counts:()=>({network,closed,disposed,reads,spawned}),
    rewriteCredential:()=>{size+=50n;mtimeNs+=1000n;},
    replaceCredentialFile:()=>{inode++;size+=50n;mtimeNs+=1000n;}};
}
const claudeScope={actor:'claude',project:scope.project,task:scope.task,model:'Sonnet',effort:scope.effort};
function asClaude(f){f.settings.providerFile='C:\\Tools\\provider\\claude.exe';}

test('rewriting the same Grok credential file keeps accountProfileId',async t=>{
  const f=fixture(t),first=await f.service.preview(scope);
  f.rewriteCredential();
  const second=await f.service.preview(scope);
  assert.equal(second.review.accountProfileId,first.review.accountProfileId);
  assert.deepEqual(second.review.authenticationRead,first.review.authenticationRead);
  assert.equal(f.counts().reads,0);
});

test('replacing the Claude credential file (new inode, bytes, mtime) keeps accountProfileId',async t=>{
  const f=fixture(t);asClaude(f);
  const first=await f.service.preview(claudeScope);
  f.replaceCredentialFile();
  const second=await f.service.preview(claudeScope);
  assert.equal(second.review.accountProfileId,first.review.accountProfileId);
  assert.deepEqual(second.review.authenticationRead,first.review.authenticationRead);
  assert.ok(String(first.review.authenticationRead).toLowerCase().includes('.credentials.json'));
  assert.equal(f.counts().reads,0);
});

test('a credential at a different path changes accountProfileId',async t=>{
  const f=fixture(t),first=await f.service.preview(scope);
  f.settings.ownerHome='C:\\Users\\other';
  f.settings.runtimeBase='C:\\Users\\other\\AppData\\Local\\ProjectHub';
  const second=await f.service.preview(scope);
  assert.notEqual(second.review.accountProfileId,first.review.accountProfileId);
  assert.notDeepEqual(second.review.authenticationRead,first.review.authenticationRead);
  assert.equal(f.counts().reads,0);
});

test('changing only install-slot paths keeps runtimeProfileId',async t=>{
  const f=fixture(t),first=await f.service.preview(scope);
  f.settings.providerFile='C:\\Tools\\provider-v2\\grok.exe';
  f.settings.codexFile='C:\\Tools\\codex-v2\\codex.exe';
  f.settings.nodeFile='C:\\Tools\\node-v2\\node.exe';
  f.settings.gitDirectory='C:\\Tools\\git-v2';
  f.settings.hubLibDirectory='C:\\Tools\\hub-v2\\lib';
  f.settings.systemRoot='D:\\Windows';
  const second=await f.service.preview(scope);
  assert.equal(second.review.runtimeProfileId,first.review.runtimeProfileId);
  assert.equal(second.review.accountProfileId,first.review.accountProfileId);
  assert.equal(f.counts().reads,0);
  // Binary hashes cannot be varied: digestFile is checked against PROVIDER_HASHES /
  // KNOWN at preview, so a different digest is refused before identity is returned.
});

test('changing the state directory changes runtimeProfileId',async t=>{
  const f=fixture(t),first=await f.service.preview(scope);
  // stateDirectory is derived from runtimeBase; the plan API has no independent setter.
  f.settings.runtimeBase='C:\\Users\\fixture\\AppData\\Local\\Packages\\SyntheticFamily_456\\LocalCache\\Local\\ProjectHub';
  const second=await f.service.preview(scope);
  assert.notEqual(second.review.sessionWrite,first.review.sessionWrite);
  assert.notEqual(second.review.runtimeProfileId,first.review.runtimeProfileId);
  assert.equal(second.review.accountProfileId,first.review.accountProfileId);
  assert.equal(f.counts().reads,0);
});

test('changing the tool profile changes runtimeProfileId',async t=>{
  const f=fixture(t),grok=await f.service.preview(scope);
  asClaude(f);
  const claude=await f.service.preview(claudeScope);
  // GROK_PROFILE and Claude TOOLS are frozen module exports; preview has no
  // tool-list injection. Switching actor is the closest way to vary tools.
  assert.notEqual(claude.review.runtimeProfileId,grok.review.runtimeProfileId);
  assert.equal(f.counts().reads,0);
});
