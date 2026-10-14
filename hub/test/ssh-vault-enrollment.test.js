'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const native=process.platform==='win32'&&process.arch==='x64'?test:test.skip;
let fixture;

function executable(){
  if(fixture)return fixture;
  const sources=[path.join(__dirname,'../windows/ssh-vault-enrollment.cs'),path.join(__dirname,'../windows/ssh-vault-store.cs'),path.join(__dirname,'helpers/ssh-vault-enrollment-fixture.cs')];
  const digest=crypto.createHash('sha256');for(const source of sources)digest.update(fs.readFileSync(source));
  const folder=path.join(__dirname,'../.runtime');fs.mkdirSync(folder,{recursive:true});
  fixture=path.join(folder,'ssh-vault-enrollment-test-'+digest.digest('hex')+'.exe');
  if(!fs.existsSync(fixture))cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/main:HubVaultEnrollmentFixture','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/out:'+fixture,...sources],{windowsHide:true,timeout:30000,stdio:'pipe'});
  return fixture;
}
function run(mode){
  const result=JSON.parse(cp.execFileSync(executable(),[mode],{windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(result.ok,true);
  for(const key of ['visibleWindows','nativeCredUiCalls','vaultCalls','sshCalls'])assert.equal(result[key],0,key);
  return result;
}
native('native enrollment construction and HWND creation never start a credential prompt',{timeout:45000},()=>{
  const result=run('construction');assert.equal(result.syntheticPromptCalls,0);assert.equal(result.requestedEvents,0);
});
native('native enrollment cancel before Start exits without a credential prompt',{timeout:45000},()=>{
  const result=run('cancel');assert.equal(result.syntheticPromptCalls,0);assert.equal(result.requestedEvents,0);
});
native('native enrollment explicit Start supplies a valid parent HWND and cannot prompt twice',{timeout:45000},()=>{
  const result=run('success');assert.equal(result.syntheticPromptCalls,1);assert.equal(result.requestedEvents,1);assert.equal(result.ownerHandleVerified,true);
});
native('native enrollment prompt failure remains failed and cannot retry automatically',{timeout:45000},()=>{
  const result=run('failure');assert.equal(result.syntheticPromptCalls,1);assert.equal(result.requestedEvents,1);assert.equal(result.ownerHandleVerified,true);
});
native('native enrollment diagnostic callback failure prevents prompting and automatic retry',{timeout:45000},()=>{
  const result=run('event-failure');assert.equal(result.syntheticPromptCalls,0);assert.equal(result.requestedEvents,1);
});
