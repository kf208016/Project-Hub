'use strict';
// Real Windows Job/process/pipe capability checks, no vault entry and no SSH.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const enabled=process.platform==='win32'&&process.env.HUB_RUN_MAINTENANCE_PROCESS_TEST==='1';
const native=enabled?test:test.skip;
const windows=path.resolve(__dirname,'../windows'),runtime=path.resolve(__dirname,'../.runtime');
let binary;
function compile(){
  if(binary)return binary;
  const sourceNames=['ssh-maintenance-common.cs','ssh-maintenance-store.cs','ssh-maintenance-process.cs','ssh-maintenance-state.cs','ssh-maintenance-recovery.cs','ssh-maintenance-pointer.cs','ssh-maintenance-entry.cs','ssh-maintenance-transport.cs','ssh-vault-store.cs','ssh-vault-transport.cs','pinned-root.cs'];
  const sources=sourceNames.map(n=>path.join(windows,n)).concat(path.join(__dirname,'helpers/ssh-maintenance-process-fixture.cs'));
  const catalog='public static class HubSshMaintenanceCatalog {public const string Command="fixture-never-executed",PayloadSHA256="'+ 'a'.repeat(64)+'",CatalogSHA256="'+'b'.repeat(64)+'",Operation="run-r2-synthetic-v1",PayloadBase64="YQ==";public const int PayloadLength=1,RunDeadlineMs=180000;}';
  const hash=crypto.createHash('sha256').update(catalog);for(const file of sources)hash.update(fs.readFileSync(file));const digest=hash.digest('hex');
  fs.mkdirSync(runtime,{recursive:true});binary=path.join(runtime,'maintenance-process-fixture-'+digest+'.exe');
  const generated=path.join(runtime,'maintenance-process-fixture-'+digest+'.cs');
  if(!fs.existsSync(generated))fs.writeFileSync(generated,catalog,{flag:'wx'});assert.equal(fs.readFileSync(generated,'utf8'),catalog);
  if(!fs.existsSync(binary))cp.execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',['/nologo','/platform:x64','/target:exe','/define:HUB_SSH_MAINTENANCE_PROCESS_TEST','/main:HubSshMaintenanceProcessFixture','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/out:'+binary,...sources,generated],{windowsHide:true,timeout:30000});
  return binary;
}
for(const scenario of ['pointer-rename','valid','missing-pipe','wrong-manifest','wrong-ordinal','pid','created','expired','helper-pid','helper-created','nonowned','replay'])native('native capability '+scenario,{timeout:45000},()=>{
  const result=cp.spawnSync(compile(),[scenario],{windowsHide:true,encoding:'utf8',timeout:35000,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:path.join(process.env.SystemRoot,'System32')}});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr+' '+result.stdout);
  const body=JSON.parse(result.stdout);assert.equal(body.ok,true);assert.equal(body.scenario,scenario);assert.equal(body.rejected,scenario!=='valid'&&scenario!=='pointer-rename');
  assert.doesNotMatch(result.stdout+result.stderr,/Hub fixture|PROMPT_|ENROLLMENT_|ASKPASS_SUPPLIED/);
});
