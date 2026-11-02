'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGrokCredentialAcl,runIcacls,readCurrentUserSid}=require('../lib/grok-credential-acl');
test('R20 real Windows ACL propagation, owner preservation, deny preservation and idempotence',{skip:process.platform!=='win32'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'real-')),home=path.join(root,'home'),dir=path.join(home,'.grok'),bin=path.join(dir,'bin');
  const auth=path.join(dir,'auth.json'),lock=path.join(dir,'auth.json.lock'),tool=path.join(bin,'tool.exe');
  const systemRoot=process.env.SystemRoot||'C:\\Windows',icacls=path.join(systemRoot,'System32','icacls.exe');
  function inside(file){const relative=path.relative(root,path.resolve(file));assert.ok(relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative)));}
  async function call(file,...args){inside(file);const result=await runIcacls(icacls,[file,...args,'/Q'],{timeoutMs:120000});assert.deepEqual(result,{status:0,timedOut:false},'temporary ACL command failed: '+args[0]);}
  async function sddl(file){inside(file);const saved=path.join(root,'snapshot.txt');await call(file,'/save',saved);const text=fs.readFileSync(saved,'utf16le').split(/\r?\n/)[1];fs.unlinkSync(saved);return text;}
  t.after(async()=>{
    inside(root);assert.equal(path.dirname(root),os.tmpdir());
    // Test-only reset is confined to this newly created tree, never a real home.
    await runIcacls(icacls,[root,'/reset','/T','/Q'],{timeoutMs:120000});fs.rmSync(root,{recursive:true,force:true});
  });
  fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(auth,'dummy auth');fs.writeFileSync(lock,'dummy lock');fs.writeFileSync(tool,Buffer.from([0,1,2]));
  const owner=await readCurrentUserSid(systemRoot);
  const guests='S-1-5-32-546';
  await call(auth,'/inheritance:r');await call(auth,'/grant:r','*'+owner+':(F)','*'+guests+':(RX)');
  await call(dir,'/grant','*'+guests+':(OI)(CI)(M)');await call(bin,'/deny','*'+guests+':(W)');
  // The real lock also has an explicit grant; ensure all three removal paths run.
  await call(lock,'/grant','*'+guests+':(M)');
  const before={dir:await sddl(dir),auth:await sddl(auth),lock:await sddl(lock),bin:await sddl(bin),tool:await sddl(tool)};
  assert.match(before.tool,/\(A;[^;]*ID;[^)]*;;;(?:BG|S-1-5-32-546)\)/);
  const records=[],acl=createGrokCredentialAcl({home,systemRoot,run:runIcacls,record:(...args)=>records.push(args)});
  const first=await acl.revoke('startup');
  t.diagnostic('icacls /save includes owner O: = '+/(?:^|\))O:/.test(before.auth)+'; outcomes = '+first.results.map(r=>r.outcome).join(','));
  const after={dir:await sddl(dir),auth:await sddl(auth),lock:await sddl(lock),bin:await sddl(bin),tool:await sddl(tool)};
  // Test-only evidence from this fresh dummy tree; never sent to runtime records.
  for(const target of ['dir','auth','lock']){
    t.diagnostic(target+' before: '+before[target]);t.diagnostic(target+' after: '+after[target]);
  }
  await t.test('all three targets revoked',()=>assert.deepEqual(first.results.map(r=>r.outcome),['revoked','revoked','revoked']));
  await t.test('directory explicit Guests grant gone',()=>assert.doesNotMatch(after.dir,/\(A;[^;]*;[^)]*;;;(?:BG|S-1-5-32-546)\)/));
  await t.test('tool inherited Guests grant gone by Windows propagation',()=>assert.doesNotMatch(after.tool,/\(A;[^;]*ID;[^)]*;;;(?:BG|S-1-5-32-546)\)/));
  await t.test('auth keeps only owner',()=>{
    const aces=after.auth.match(/\([^()]*\)/g)||[];assert.equal(aces.length,1);assert.ok(aces[0].endsWith(';;;'+owner+')'));assert.match(aces[0],/^\(A;;FA;/);
  });
  await t.test('bin deny remains',()=>assert.match(after.bin,/\(D;[^;]*;[^)]*;;;(?:BG|S-1-5-32-546)\)/));
  await t.test('second revoke is clean everywhere',async()=>assert.deepEqual((await acl.revoke('turn-end')).results.map(r=>r.outcome),['clean','clean','clean']));
  assert.doesNotMatch(JSON.stringify(records),/\\|S-1-|D:/);
});
