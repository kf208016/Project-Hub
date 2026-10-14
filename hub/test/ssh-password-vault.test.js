'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const vault=require('../lib/ssh-password-vault');
const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/ssh-password-vault.schema.json'),'utf8'));
const examples=JSON.parse(fs.readFileSync(path.join(__dirname,'../windows/ssh-password-vault-examples.json'),'utf8'));
const fixture=()=>structuredClone(examples.validDescriptor);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function rejected(change,code) {const d=fixture();change(d);assert.throws(()=>vault.validate(d),e=>e.code===code,code);}

test('vault descriptor example and closed schema agree without a credential or live endpoint',()=>{
  const d=fixture();assert.equal(vault.validate(d),d);
  assert.match(examples.validationScope,/Synthetic/);assert.equal(d.host,'192.0.2.25');
  assert.equal(schema.type,'object');assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required.slice().sort(),Object.keys(d).sort());
  assert.deepEqual(Object.keys(schema.properties).sort(),Object.keys(d).sort());
  for(const [key,value] of Object.entries(d)) {
    let property=schema.properties[key];if(property.$ref)property=schema.$defs[property.$ref.split('/').at(-1)];
    if(property.pattern){assert.match(value,new RegExp(property.pattern),key);assert.doesNotMatch(value+'\n',new RegExp(property.pattern),key+' final newline');}
    if(property.const!==undefined)assert.equal(value,property.const,key);
    if(property.type==='integer')assert.equal(Number.isInteger(value),true,key);
    if(property.type==='string')assert.equal(typeof value,'string',key);
    if(property.minimum!==undefined)assert.ok(value>=property.minimum,key);
    if(property.maximum!==undefined)assert.ok(value<=property.maximum,key);
    if(property.minLength!==undefined)assert.ok(value.length>=property.minLength,key);
    if(property.maxLength!==undefined)assert.ok(value.length<=property.maxLength,key);
  }
  assert.match(schema.$comment,/not proof/);assert.match(schema.properties.stageCommand.description,/UTF-8 bytes/);
});

test('vault rejects extra secrets, missing fields, arrays and non-plain descriptors',()=>{
  for(const key of ['password','secret','token','credential'])rejected(d=>{d[key]='synthetic-do-not-send';},'FIELDS_REJECTED');
  for(const key of schema.required)rejected(d=>{delete d[key];},'FIELDS_REJECTED');
  for(const d of [null,[],Object.create(fixture()),Object.assign(Object.create(null),fixture())])assert.throws(()=>vault.validate(d),{code:'FIELDS_REJECTED'});
});

test('vault identity and owner fields reject coercion, non-v4 IDs and changed digest types',()=>{
  for(const value of [0,'1',null])rejected(d=>{d.version=value;},'ID_REJECTED');
  for(const value of [[fixture().registrationId],{toString:()=>fixture().registrationId},fixture().registrationId+'\n',fixture().registrationId.toUpperCase(),fixture().registrationId.replace('-4b31-','-1b31-')])rejected(d=>{d.registrationId=value;},'ID_REJECTED');
  for(const value of [[fixture().ownerSid],{toString:()=>fixture().ownerSid},fixture().ownerSid+'\n','S-2-5-21-1','S-1-A-1'])rejected(d=>{d.ownerSid=value;},'OWNER_REJECTED');
  for(const key of ['rootFingerprint','sshSHA256','brokerSHA256','stageCommandSHA256'])for(const value of ['a'.repeat(63),'A'.repeat(64),'a'.repeat(64)+'\n',['a'.repeat(64)],null])rejected(d=>{d[key]=value;},'DIGEST_REJECTED');
});

test('vault rejects path normalization changes, UNC, alternate streams and traversal',()=>{
  for(const key of ['root','ssh'])for(const value of ['relative','C:/hub/worker','\\\\server\\share\\worker','C:\\hub\\..\\worker','C:\\hub\\.\\worker','C:\\hub\\worker\\','C:\\hub\\worker:stream','C:\\hub\\trailing.','C:\\hub\\trailing ','C:\\hub\\bad\npath','C:\\hub\\'+ 'a'.repeat(240)])rejected(d=>{d[key]=value;},'PATH_REJECTED');
});

test('vault limits fixed host, port and Linux user syntax',()=>{
  for(const value of ['host.example','127.0.0.1:22','256.1.1.1','192.00.2.25','192.0.2.25\n','::1',null])rejected(d=>{d.host=value;},'HOST_REJECTED');
  for(const value of [0,65536,22.5,'22',Infinity])rejected(d=>{d.port=value;},'ACCOUNT_REJECTED');
  for(const value of ['root;id','user name','user\n','-user','user@host','u'.repeat(33),null])rejected(d=>{d.user=value;},'ACCOUNT_REJECTED');
  for(const port of [1,65535]){const d=fixture();d.port=port;assert.equal(vault.validate(d),d);}
});

test('vault binds canonical Ed25519 wire bytes to the independently computed host fingerprint',()=>{
  for(const value of [fixture().hostKey+'=',fixture().hostKey+'\n',Buffer.alloc(51).toString('base64'),Buffer.alloc(50).toString('base64'),null])rejected(d=>{d.hostKey=value;},'HOST_KEY_REJECTED');
  const bytes=Buffer.from(fixture().hostKey,'base64');bytes[50]^=1;
  rejected(d=>{d.hostKey=bytes.toString('base64');},'HOST_PIN_CHANGED');
  rejected(d=>{d.hostFingerprint='SHA256:'+ 'a'.repeat(43);},'HOST_PIN_CHANGED');
  const d=fixture();d.hostKey=bytes.toString('base64');d.hostFingerprint='SHA256:'+crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/,'');
  assert.equal(vault.validate(d),d);
});

test('vault binds exact command bytes and refuses malformed Unicode, newline and oversized UTF-8',()=>{
  rejected(d=>{d.stageCommand+=' modified';},'STAGE_COMMAND_REJECTED');
  for(const value of ['', '\0', 'line\rbreak','line\nbreak','\ud800','a'.repeat(1025),'字'.repeat(342)])rejected(d=>{d.stageCommand=value;d.stageCommandSHA256=digest(Buffer.from(value));},'STAGE_COMMAND_REJECTED');
  for(const command of ['a'.repeat(1024),'字'.repeat(341),'  繁體中文 😀  ']){const d=fixture();d.stageCommand=command;d.stageCommandSHA256=digest(Buffer.from(command));assert.equal(vault.validate(d),d);}
});

test('vault request canonicalization has deterministic key ordering and rejects unsupported values',()=>{
  assert.equal(vault.canonical({z:2,a:{q:'繁體',b:true},n:null}),'{'+'"a":{"b":true,"q":"繁體"},"n":null,"z":2}');
  assert.equal(vault.canonical({b:1,a:2}),vault.canonical({a:2,b:1}));
  for(const value of [[],NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,undefined,()=>{}])assert.throws(()=>vault.canonical({x:value}),{code:'JSON_TYPE_REJECTED'});
});

const native=process.platform==='win32'&&process.arch==='x64'?test:test.skip;
native('native vault store rejects secret and target boundary failures without UI or vault access',{timeout:45000},t=>{
  const tempRoot=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tempRoot,'hub-vault-validation-'));
  t.after(()=>{assert.equal(path.dirname(dir),tempRoot);assert.match(path.basename(dir),/^hub-vault-validation-/);fs.rmSync(dir,{recursive:true,force:true});});
  const source=path.join(dir,'validation.cs'),exe=path.join(dir,'validation.exe');
  fs.writeFileSync(source,String.raw`
using System;
using System.Reflection;
using System.Text;
class VaultValidationHarness {
  static int checks;
  static void Reject(Action action,string code) {try {action();throw new Exception("ACCEPTED_INVALID");}catch(InvalidOperationException e){if(e.Message!=code)throw;checks++;}}
  static void CheckPrivate(string method,string value) {
    try {typeof(HubSshVaultStore).GetMethod(method,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{value});}
    catch(TargetInvocationException e){throw e.InnerException;}
  }
  static int Main() {
    try {
      var utf8=new UTF8Encoding(false,true);
      foreach(string value in new[]{" 前後空白 繁體😀 "," \t "}) {HubSshVaultStore.Validate(utf8.GetBytes(value));checks++;}
      byte[] max=new byte[2560];for(int i=0;i<max.Length;i++)max[i]=65;HubSshVaultStore.Validate(max);checks++;
      byte[][] invalid={null,new byte[0],new byte[]{0},new byte[]{10},new byte[]{13},new byte[]{0xC0,0xAF},new byte[]{0xED,0xA0,0x80},new byte[]{0xF4,0x90,0x80,0x80},new byte[]{0xE2,0x82},new byte[2561]};
      foreach(var item in invalid){var value=item;Reject(()=>HubSshVaultStore.Validate(value),"SSH_VAULT_SECRET_INVALID");}
      string prefix="ProjectHub.WorkerSshPassword.v1/",valid=prefix+"12345678-1234-4234-8234-123456789abc/"+new string('a',64);
      CheckPrivate("ValidateTarget",valid);checks++;
      foreach(string item in new[]{"anything",prefix+"00000000-0000-0000-0000-000000000000/"+new string('a',64),valid+"/",valid.Replace("789abc","789ABC"),valid.Substring(0,valid.Length-1),valid.Substring(0,valid.Length-1)+"G"}){var value=item;Reject(()=>CheckPrivate("ValidateTarget",value),"SSH_VAULT_TARGET_INVALID");}
      CheckPrivate("ValidateUser","user");checks++;
      foreach(string item in new[]{" user","user ","user\\domain","user/name","user\n", "\ud800"}){var value=item;Reject(()=>CheckPrivate("ValidateUser",value),"SSH_VAULT_USER_INVALID");}
      CheckPrivate("ValidateDisplay","user@192.0.2.25:22");checks++;
      foreach(string item in new[]{"", "host\nspoof",new string('a',257),"\u202ehost"}){var value=item;Reject(()=>CheckPrivate("ValidateDisplay",value),"SSH_VAULT_DISPLAY_INVALID");}
      Console.WriteLine("{\"checks\":"+checks+",\"promptCalls\":0,\"vaultCalls\":0}");return 0;
    } catch(Exception) {Console.Error.WriteLine("VAULT_VALIDATION_HARNESS_FAILED");return 1;}
  }
}
`);
  const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  cp.execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/out:'+exe,source,path.join(__dirname,'../windows/ssh-vault-store.cs')],{windowsHide:true,timeout:30000,stdio:'pipe'});
  const result=JSON.parse(cp.execFileSync(exe,[],{windowsHide:true,timeout:10000,encoding:'utf8'}));
  assert.deepEqual(result,{checks:32,promptCalls:0,vaultCalls:0});
});
