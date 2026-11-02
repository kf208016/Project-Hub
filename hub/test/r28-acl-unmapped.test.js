'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createGrokCredentialAcl,runIcacls,REMOVE_SCRIPT}=require('../lib/grok-credential-acl');
const win=process.platform==='win32'?test:test.skip;
const SID='S-1-5-21-1346218364-3067795892-3989299697-2838505621',SID2='S-1-5-21-1346218364-3067795892-3989299697-2838505622';
function fixture(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'r28-acl-')),dir=path.join(home,'.grok');fs.mkdirSync(dir);
  for(const file of ['auth.json','auth.json.lock'])fs.writeFileSync(path.join(dir,file),'synthetic');
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  return {home,dir};
}
win('R28 real unmapped SIDs: icacls 1332, .NET revoke, inheritance, deny and protection',async t=>{
  const {home,dir}=fixture(t),systemRoot=process.env.SystemRoot;
  const powershell=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const env={...process.env,HUB_GROK_ACL_TARGET:dir,HUB_GROK_ACL_SIDS:SID+','+SID2};
  const ps=script=>execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',script],{env,windowsHide:true,shell:false,timeout:30000,encoding:'utf8'}).trim();
  const setup="$ErrorActionPreference='Stop';$d=$env:HUB_GROK_ACL_TARGET;$s=$env:HUB_GROK_ACL_SIDS -split ',';$sid=[Security.Principal.SecurityIdentifier]::new($s[0]);$a=[IO.Directory]::GetAccessControl($d,'Access');$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow'));$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadData','Deny'));[IO.Directory]::SetAccessControl($d,$a);$lock=[IO.Path]::Combine($d,'auth.json.lock');$a=[IO.File]::GetAccessControl($lock,'Access');foreach($v in $s){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($v),'Modify','Allow'))};[IO.File]::SetAccessControl($lock,$a);$auth=[IO.Path]::Combine($d,'auth.json');$a=[Security.AccessControl.FileSecurity]::new();$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','Allow'));[IO.File]::SetAccessControl($auth,$a);[IO.File]::WriteAllText([IO.Path]::Combine($d,'child.txt'),'synthetic')";
  ps(setup);
  const inspect="$ErrorActionPreference='Stop';$d=$env:HUB_GROK_ACL_TARGET;$s=($env:HUB_GROK_ACL_SIDS -split ',')[0];$a=[IO.Directory]::GetAccessControl($d,'Access');$child=[IO.File]::GetAccessControl([IO.Path]::Combine($d,'child.txt'),'Access');$auth=[IO.File]::GetAccessControl([IO.Path]::Combine($d,'auth.json'),'Access');@{inherited=@($child.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq $s -and $_.IsInherited -and $_.AccessControlType -eq 'Allow'}).Count;deny=@($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq $s -and $_.AccessControlType -eq 'Deny'}).Count;protected=$auth.AreAccessRulesProtected}|ConvertTo-Json -Compress";
  assert.ok(JSON.parse(ps(inspect)).inherited>0);
  const raw=await runIcacls(path.win32.join(systemRoot,'System32','icacls.exe'),[dir,'/remove:g','*'+SID,'/Q'],{timeoutMs:30000});
  assert.equal(raw.status,1332);assert.equal(raw.timedOut,false);
  const records=[],result=await createGrokCredentialAcl({home,systemRoot,run:runIcacls,record:(...args)=>records.push(args)}).revoke('startup');
  assert.deepEqual(result.results.map(({target,outcome})=>({target,outcome})),[{target:'dir',outcome:'revoked'},{target:'auth',outcome:'clean'},{target:'lock',outcome:'revoked'}],JSON.stringify(result));
  assert.deepEqual(JSON.parse(ps(inspect)),{inherited:0,deny:1,protected:true});
  assert.deepEqual(records,[['grok-credential-acl',result]]);assert.doesNotMatch(JSON.stringify(result),/S-1-|\\|auth\.json|SDDL/);
});
for(const mode of ['user','save','parse','remove','verify'])test('R28 sanitized failure diagnostics: '+mode,async t=>{
  const {home}=fixture(t),owner='S-1-5-21-1-2-3-1001';
  t.mock.method(require('../lib/local-drives'),'assertLocalDrive',()=>{});
  const records=[],run=async(file,args,options)=>{
    if(args[1]==='/save'){
      if(mode==='save')return {status:5};
      fs.writeFileSync(args[2],'target\r\n'+(mode==='parse'?'invalid':`D:(A;;FA;;;${owner})(A;;FR;;;${SID})`)+'\r\n','utf16le');
    }else{
      assert.equal(file,path.win32.join('C:\\SyntheticWindows','System32','WindowsPowerShell','v1.0','powershell.exe'));
      assert.deepEqual(args,['-NoProfile','-NonInteractive','-Command',REMOVE_SCRIPT]);
      assert.equal(options.env.HUB_GROK_ACL_SIDS,SID);
      if(mode==='remove')return {status:1332};
    }
    return {status:0};
  };
  const result=await createGrokCredentialAcl({home,systemRoot:'C:\\SyntheticWindows',run,record:(...args)=>records.push(args),platform:'win32',currentUserSid:()=>{if(mode==='user')throw Object.assign(Error('private'),{status:7});return owner;}}).revoke('startup');
  const status={user:7,save:5,remove:1332}[mode];
  assert.deepEqual(result.results,['dir','auth','lock'].map(target=>({target,outcome:'failed',removed:0,stage:mode,...(status?{status}:{})})));
  assert.doesNotMatch(JSON.stringify(records),/private|S-1-|\\|auth\.json|SDDL/);
});
test('R28 runIcacls forwards environment only when given, without shell or output diagnostics',async()=>{
  const vm=require('node:vm'),{createRequire}=require('node:module'),file=path.join(__dirname,'../lib/grok-credential-acl.js'),actual=createRequire(file),module={exports:{}},calls=[];
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,process,require:name=>name==='node:child_process'?{execFile:(file,args,opts,cb)=>{calls.push(opts);cb({code:1332},'private output');}}:actual(name)});
  const env={HUB_GROK_ACL_TARGET:'synthetic'};
  for(const options of [{timeoutMs:100},{timeoutMs:100,env}])assert.equal((await module.exports.runIcacls('synthetic',[],options)).status,1332);
  assert.equal(Object.hasOwn(calls[0],'env'),false);assert.equal(calls[1].env,env);
  for(const opts of calls){assert.equal(opts.shell,false);assert.equal(opts.windowsHide,true);assert.equal(opts.timeout,100);}
});
