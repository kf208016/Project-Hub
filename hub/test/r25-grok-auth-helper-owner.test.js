'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('owner helper prints only token JSON and one fixed error line on failure',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r25-owner-helper-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const preload=path.join(home,'preload.js');
  fs.writeFileSync(preload,"require('node:os').homedir=()=>process.env.R25_HOME;Date.now=()=>100000;");
  const env={...process.env,HOME:home,USERPROFILE:home,R25_HOME:home};
  const run=()=>spawnSync(process.execPath,['--require',preload,path.resolve(__dirname,'../lib/grok-auth-helper-owner.js')],{env,encoding:'utf8'});
  let r=run();assert.ifError(r.error);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr,'grok-auth-helper-owner: GROK_OWNER_TOKEN_MISSING\n');
  fs.mkdirSync(path.join(home,'.grok'));fs.writeFileSync(path.join(home,'.grok/auth.json'),JSON.stringify({'https://auth.x.ai::test':{key:'synthetic',expires_at:new Date(220000).toISOString()}}));
  r=run();assert.equal(r.status,0);assert.equal(r.stdout,'{"access_token":"synthetic","expires_in":60}');assert.equal(r.stderr,'');
});
test('owner cmd has exactly three ASCII CRLF lines',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../lib/grok-auth-helper-owner.cmd'),'utf8');
  assert.equal(s,'@echo off\r\n"%HUB_NODE%" "%~dp0grok-auth-helper-owner.js"\r\nexit /b %ERRORLEVEL%\r\n');
});
