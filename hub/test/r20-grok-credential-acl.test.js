'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGrokCredentialAcl,parseWhoamiUserSid,REMOVE_SCRIPT}=require('../lib/grok-credential-acl');
const {createPlan}=require('../lib/provider-native-plan');
const safe=require('../lib/safe-path');
const owner='S-1-5-21-100-200-300-1001',foreign='S-1-5-21-100-200-300-1002',cap='S-1-15-3-100';
const clean=`D:P(A;;FA;;;${owner})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;CO)(A;;FA;;;OW)`;
const dirty=clean+`(A;OICI;0x1301bf;;;${foreign})(A;;FW;;;${cap})`;
function fixture(t,options={}){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'acl-')),dir=path.join(home,'.grok');fs.mkdirSync(dir);
  for(const file of ['auth.json','auth.json.lock'])fs.writeFileSync(path.join(dir,file),'dummy');
  const calls=[],records=[],saved=[],counts=new Map();
  const run=async(file,args,settings)=>{
    calls.push({file,args,settings});
    if(options.run)return options.run(file,args,settings);
    if(args[1]==='/save'){
      saved.push(args[2]);const n=counts.get(args[0])||0;counts.set(args[0],n+1);
      const sddl=options.sddl??(n===0?dirty:clean);
      fs.writeFileSync(args[2],'\uFEFF'+path.basename(args[0])+'\r\n'+sddl+'\r\n','utf16le');
    }
    return {status:0,timedOut:false};
  };
  t.mock.method(require('../lib/local-drives'),'assertLocalDrive',()=>{});
  const acl=createGrokCredentialAcl({home,systemRoot:'C:\\SyntheticWindows',run,record:(...args)=>records.push(args),platform:'win32',tmpdir:os.tmpdir(),currentUserSid:async()=>owner,...options.factory});
  t.after(()=>{assert.equal(path.dirname(home),os.tmpdir());fs.rmSync(home,{recursive:true,force:true});});
  return {home,dir,calls,records,saved,acl};
}
test('R20 exact argv, all targets, timeout budgets, deduplication, verification and sanitized records',async t=>{
  const f=fixture(t),result=await f.acl.revoke('startup');
  assert.deepEqual(result,{reason:'startup',results:['dir','auth','lock'].map(target=>({target,outcome:'revoked',removed:2}))});
  assert.equal(f.calls.length,9);
  const targets=[f.dir,path.join(f.dir,'auth.json'),path.join(f.dir,'auth.json.lock')];
  for(let i=0;i<3;i++){
    const calls=f.calls.slice(i*3,i*3+3);
    for(const call of [calls[0],calls[2]]){assert.equal(call.file,'C:\\SyntheticWindows\\System32\\icacls.exe');assert.deepEqual(call.settings,{timeoutMs:i===0?120000:30000});assert.equal(call.args[0],targets[i]);}
    assert.equal(calls[1].file,'C:\\SyntheticWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(calls[1].args,['-NoProfile','-NonInteractive','-Command',REMOVE_SCRIPT]);
    assert.deepEqual(calls[1].settings,{timeoutMs:i===0?120000:30000,env:{...process.env,HUB_GROK_ACL_TARGET:targets[i],HUB_GROK_ACL_SIDS:foreign+','+cap,HUB_GROK_ACL_DIR:i===0?'1':'0'}});
    for(const call of [calls[0],calls[2]]){assert.equal(call.args[1],'/save');assert.equal(call.args[3],'/Q');assert.equal(path.dirname(path.dirname(call.args[2])),os.tmpdir());}
  }
  assert.equal(new Set(f.saved.map(p=>path.dirname(p))).size,6);
  for(const p of f.saved)assert.equal(fs.existsSync(path.dirname(p)),false);
  for(const {args}of f.calls)assert.ok(!args.some(a=>/^\/(T|C|reset|grant|deny|setowner|inheritance|restore)(:|$)/i.test(a)));
  assert.deepEqual(f.records,[['grok-credential-acl',result]]);assert.doesNotMatch(JSON.stringify(f.records),/\\|S-1-|D:/);
});
test('R20 keeps owner aliases, SYSTEM, Administrators, inherited, deny, audit and object ACEs',async t=>{
  const sddl=clean+`(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;OICIID;FR;;;${foreign})(D;;FW;;;${foreign})(AU;SA;FA;;;WD)(OA;;FR;01234567-89ab-cdef-0123-456789abcdef;;${foreign})`+'S:(AU;SA;FA;;;WD)';
  const f=fixture(t,{sddl}),result=await f.acl.revoke('turn-end');
  assert.ok(result.results.every(r=>r.outcome==='clean'));assert.equal(f.calls.length,3);
});
for(const [ownerAlias,ownerSid]of [['SY','S-1-5-18'],['BA','S-1-5-32-544']])test('R20 normalizes protected owner '+ownerAlias,async t=>{
  const f=fixture(t,{sddl:`O:${ownerAlias}D:(A;;FA;;;${ownerSid})`});assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='clean'));
});
test('R20 other aliases are foreign and repeated ACEs yield one SID argument',async t=>{
  const f=fixture(t,{sddl:clean+'(A;;FR;;;WD)(A;;FW;;;WD)(A;;FR;;;BU)(A;;FR;;;AU)'});
  const result=await f.acl.revoke('startup');
  for(const call of f.calls.filter(c=>c.args[0]==='-NoProfile'))assert.equal(call.settings.env.HUB_GROK_ACL_SIDS,'S-1-1-0,S-1-5-32-545,S-1-5-11');
  assert.ok(result.results.every(r=>r.outcome==='failed'&&r.removed===0));
});
for(const [label,sddl]of Object.entries({badOwner:'O:?D:',missingDacl:`O:${owner}`,unclosed:clean+'(A;;FR;;;WD',junk:clean+'junk',fields:clean+'(A;FR;;;WD)',flags:clean+'(A;XX;FR;;;WD)',rights:clean+'(A;;xyz;;;WD)',sid:clean+'(A;;FR;;;*bad)',duplicate:clean+'D:',empty:'',object:clean+'(A;;FR;bad;;WD)'}))test('R20 malformed SDDL fails without removal: '+label,async t=>{
  const f=fixture(t,{sddl});assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='failed'));
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.args[1]==='/save'));for(const p of f.saved)assert.equal(fs.existsSync(path.dirname(p)),false);
});
for(const [label,result]of [['status',{status:5,timedOut:false}],['timeout',{status:0,timedOut:true}],['throw',null]])test('R20 process '+label+' fails and removes temporary folders',async t=>{
  const files=[];const f=fixture(t,{run:async(_file,args)=>{files.push(args[2]);if(!result)throw Error('S-1-SECRET D: C:\\secret');return result;}});
  assert.ok((await f.acl.revoke('turn-end')).results.every(r=>r.outcome==='failed'));assert.equal(f.calls.length,3);
  for(const file of files)assert.equal(fs.existsSync(path.dirname(file)),false);assert.doesNotMatch(JSON.stringify(f.records),/SECRET|\\|S-1-|D:/);
});
test('R20 remove failure and failed post-inspection never report revoked',async t=>{
  for(const failure of ['remove','verify']){
    let calls=0;const f=fixture(t,{run:async(_file,args)=>{calls++;if(args[1]==='/save')fs.writeFileSync(args[2],'target\r\n'+dirty+'\r\n','utf16le');return {status:(failure==='remove'&&args[0]==='-NoProfile')||(failure==='verify'&&calls%3===0)?1:0,timedOut:false};}});
    assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='failed'));
  }
});
test('R20 missing targets never invoke icacls',async t=>{
  const f=fixture(t);fs.rmSync(f.dir,{recursive:true});assert.deepEqual((await f.acl.revoke('startup')).results.map(r=>r.outcome),['missing','missing','missing']);assert.equal(f.calls.length,0);
});
test('R20 wrong kinds and reparse metadata are skipped',async t=>{
  const f=fixture(t);fs.rmSync(f.dir,{recursive:true});fs.writeFileSync(f.dir,'not a directory');
  assert.equal((await f.acl.revoke('startup')).results[0].outcome,'skipped-kind');assert.equal(f.calls.length,0);
  fs.unlinkSync(f.dir);fs.mkdirSync(f.dir);fs.mkdirSync(path.join(f.dir,'auth.json'));fs.mkdirSync(path.join(f.dir,'auth.json.lock'));
  const result=await f.acl.revoke('startup');assert.ok(result.results.slice(1).every(r=>r.outcome==='skipped-kind'));
  t.mock.method(fs,'lstatSync',()=>({isSymbolicLink:()=>false,isDirectory:()=>true,isFile:()=>true,fileAttributes:0x400}));f.calls.length=0;
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='skipped-kind'));assert.equal(f.calls.length,0);
});
test('R20 junction or symlink targets and redirected ancestors are skipped',async t=>{
  const f=fixture(t),other=path.join(f.home,'other');fs.mkdirSync(other);fs.rmSync(f.dir,{recursive:true});fs.symlinkSync(other,f.dir,process.platform==='win32'?'junction':'dir');
  assert.equal((await f.acl.revoke('startup')).results[0].outcome,'skipped-kind');assert.equal(f.calls.length,0);
  fs.writeFileSync(path.join(other,'auth.json'),'dummy');fs.writeFileSync(path.join(other,'auth.json.lock'),'dummy');
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='skipped-kind'));assert.equal(f.calls.length,0);
});
test('R20 non-Windows has no metadata, process, temp or record effects',async t=>{
  const f=fixture(t,{factory:{platform:'linux'}});t.mock.method(fs,'lstatSync',()=>assert.fail('lstat'));t.mock.method(fs,'mkdtempSync',()=>assert.fail('mkdtemp'));
  assert.deepEqual(await f.acl.revoke('startup'),{reason:'startup',results:[]});assert.equal(f.calls.length,0);assert.equal(f.records.length,0);
});
test('R20 never opens, reads, streams, copies or hashes any credential-tree content',async t=>{
  const f=fixture(t);let attempts=0;
  for(const name of ['openSync','readFileSync','createReadStream','copyFileSync']){
    const original=fs[name];t.mock.method(fs,name,function(p,...args){if(path.resolve(String(p)).toLowerCase().startsWith(f.dir.toLowerCase()+path.sep)){attempts++;throw Error('credential read');}return original.call(this,p,...args);});
  }
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='revoked'));assert.equal(attempts,0);
});
test('R20 cleanup retains owner credential targets after R25 moves turn credentials',async t=>{
  const home='C:\\Users\\SyntheticOwner',seen=[];
  const plan=createPlan({actor:'grok',ownerHome:home,runtimeBase:home+'\\AppData\\Local\\ProjectHub',cwd:'C:\\Synthetic\\Work',rootFingerprint:'a'.repeat(64),providerFile:'C:\\Synthetic\\grok.exe',codexFile:'C:\\Synthetic\\codex.exe',codexSHA256:'b'.repeat(64),nodeFile:'C:\\Synthetic\\node.exe',gitDirectory:'C:\\Synthetic\\git',hubLibDirectory:'C:\\Synthetic\\lib',providerArgs:[],proxyUrl:'http://hub:'+'c'.repeat(64)+'@127.0.0.1:12345',systemRoot:'C:\\Windows'});
  t.mock.method(fs,'lstatSync',file=>{seen.push(file);throw Object.assign(Error(),{code:'ENOENT'});});
  await createGrokCredentialAcl({home,systemRoot:'C:\\Windows',run:()=>assert.fail('run'),record:()=>{},platform:'win32'}).revoke('startup');
  assert.deepEqual(seen.slice(1).map(p=>path.win32.normalize(p).toLowerCase()),[home+'\\.grok\\auth.json',home+'\\.grok\\auth.json.lock'].map(p=>p.toLowerCase()));
  assert.ok(plan.credentialFiles[0].startsWith(plan.providerHome));
});
test('R20 repeated foreign ACEs count as ACE removals but only one trustee argument',async t=>{
  let inspected=0;const f=fixture(t,{run:async(_file,args)=>{
    if(args[1]==='/save'){const sddl=inspected++%2===0?clean+`(A;;FR;;;${foreign})(A;;FW;;;${foreign})`:clean;fs.writeFileSync(args[2],'target\r\n'+sddl+'\r\n','utf16le');}
    return {status:0,timedOut:false};
  }});
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='revoked'&&r.removed===2));
  for(const call of f.calls.filter(c=>c.args[1]==='/remove:g'))assert.deepEqual(call.args.slice(2),['*'+foreign,'/Q']);
});
test('R20a absent O: keeps current user, CO/OW and numeric equivalents',async t=>{
  const f=fixture(t,{sddl:clean+'(A;;FA;;;S-1-3-0)(A;;FA;;;S-1-3-4)'});
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='clean'));
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.args[1]==='/save'));
});
test('R20a optional SDDL owner is kept in addition to the current user',async t=>{
  for(const sddl of [`O:${foreign}`+clean+`(A;;FA;;;${foreign})`,'O:WDD:(A;;FA;;;WD)']){
    const f=fixture(t,{sddl});assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='clean'));
    assert.equal(f.calls.length,3);
  }
});
test('R20a all foreign aliases resolve before deduplication and removal',async t=>{
  const entries=[['WD','S-1-1-0'],['BU','S-1-5-32-545'],['BG','S-1-5-32-546'],['AU','S-1-5-11'],
    ['IU','S-1-5-4'],['NU','S-1-5-2'],['LS','S-1-5-19'],['NS','S-1-5-20'],['AC','S-1-15-2-1'],['PU','S-1-5-32-547'],['RD','S-1-5-32-555']];
  let inspected=0;const f=fixture(t,{run:async(_file,args)=>{
    if(args[1]==='/save'){
      const sddl=inspected++%2===0?clean+entries.map(([alias])=>`(A;;FR;;;${alias})`).join('')+'(A;;FW;;;S-1-1-0)':clean;
      fs.writeFileSync(args[2],'target\r\n'+sddl+'\r\n','utf16le');
    }
    return {status:0,timedOut:false};
  }});
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='revoked'&&r.removed===12));
  const removes=f.calls.filter(c=>c.args[0]==='-NoProfile');assert.equal(removes.length,3);
  for(const call of removes)assert.equal(call.settings.env.HUB_GROK_ACL_SIDS,entries.map(([,sid])=>sid).join(','));
});
test('R20a unknown explicit allow alias fails target before any removal',async t=>{
  const f=fixture(t,{sddl:clean+'(A;;FR;;;WD)(A;;FR;;;ZZ)'});
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='failed'&&r.removed===0));
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(c=>c.args[1]==='/save'));
});
test('R20a unknown alias on inherited or non-allow ACEs stays untouched',async t=>{
  const f=fixture(t,{sddl:clean+'(A;ID;FR;;;ZZ)(D;;FW;;;ZZ)(AU;SA;FR;;;ZZ)(OA;;FR;;;ZZ)'});
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='clean'));
});
for(const [label,currentUserSid]of [
  ['rejects',async()=>{throw Error('private S-1-SECRET C:\\private');}],
  ['throws',()=>{throw Error('private');}],
  ['timeout',async()=>{throw Object.assign(Error('private'),{killed:true});}],
  ...['garbage','S-1-5-18',owner+'\n',null,{},123].map(value=>['invalid '+JSON.stringify(value),async()=>value])
])test('R20a currentUserSid '+label+' fails all inspectable targets without icacls',async t=>{
  let count=0;const f=fixture(t,{factory:{currentUserSid:()=>{count++;return currentUserSid();}}});
  assert.deepEqual((await f.acl.revoke('startup')).results.map(r=>r.outcome),['failed','failed','failed']);
  assert.equal(count,1);assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(f.records),/private|\\|S-1-|D:/);
});
test('R20a user lookup is cached within each revoke, not across revokes',async t=>{
  let count=0;const f=fixture(t,{factory:{currentUserSid:async()=>{count++;return owner;}}});
  assert.ok((await f.acl.revoke('startup')).results.every(r=>r.outcome==='revoked'));assert.equal(count,1);
  assert.ok((await f.acl.revoke('turn-end')).results.every(r=>r.outcome==='clean'));assert.equal(count,2);
});
test('R20a user lookup never runs when all targets are missing or skipped, or on non-Windows',async t=>{
  for(const mode of ['missing','skipped','mixed','non-Windows']){
    let count=0;const f=fixture(t,{factory:{currentUserSid:async()=>{count++;throw Error('must not run');},...(mode==='non-Windows'?{platform:'linux'}:{})}});
    if(mode==='missing')fs.rmSync(f.dir,{recursive:true});
    if(mode==='mixed'){
      fs.unlinkSync(path.join(f.dir,'auth.json'));fs.unlinkSync(path.join(f.dir,'auth.json.lock'));
      const original=fs.lstatSync;t.mock.method(fs,'lstatSync',function(file,...args){const st=original.call(this,file,...args);if(file===f.dir)st.fileAttributes=0x400;return st;});
    }
    if(mode==='skipped')t.mock.method(fs,'lstatSync',()=>({isSymbolicLink:()=>true}));
    await f.acl.revoke('startup');assert.equal(count,0);assert.equal(f.calls.length,0);t.mock.restoreAll();
  }
});
test('R20a SID lookup failure preserves missing and skipped-kind outcomes',async t=>{
  let count=0;const f=fixture(t,{factory:{currentUserSid:async()=>{count++;throw Error('private');}}});
  fs.unlinkSync(path.join(f.dir,'auth.json'));fs.unlinkSync(path.join(f.dir,'auth.json.lock'));fs.mkdirSync(path.join(f.dir,'auth.json.lock'));
  assert.deepEqual((await f.acl.revoke('startup')).results.map(r=>r.outcome),['failed','missing','skipped-kind']);assert.equal(count,1);assert.equal(f.calls.length,0);
});
test('R20a whoami parser accepts recorded CSV and extracts only its last quoted field',()=>{
  const sample='"desktop-x\\user","S-1-5-21-1-2-3-1001"';
  for(const suffix of ['','\n','\r\n'])assert.equal(parseWhoamiUserSid(sample+suffix),'S-1-5-21-1-2-3-1001');
  assert.equal(parseWhoamiUserSid('"desktop-x\\a,""b","'+owner+'"'),owner);
});
test('R20a whoami parser rejects malformed, multiline, unquoted and invalid SID output',()=>{
  for(const value of [null,Buffer.from('bad'),'','"user","bad"','"user","S-1-5-18"',
    '"user",'+owner,'user,"'+owner+'"','"'+owner+'"','"user","'+owner+'"junk',
    '"user","'+owner+'"\n\n','"user","'+owner+'"\n"other","'+owner+'"','"user\nname","'+owner+'"',
    '"user","'+owner+'\n"','"user","'+owner+'-2"','"user","S-1-5-21-1-2-3"'])assert.throws(()=>parseWhoamiUserSid(value),/ACL_USER_UNAVAILABLE/);
});
test('R20a production whoami uses bounded execFile and rejects errors, timeout and malformed output',async()=>{
  const vm=require('node:vm'),{createRequire}=require('node:module');
  const filename=path.join(__dirname,'../lib/grok-credential-acl.js'),actual=createRequire(filename),module={exports:{}},calls=[];
  let error=null,stdout='"desktop-x\\user","S-1-5-21-1-2-3-1001"\r\n';
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process,require:name=>name==='node:child_process'?{
    execFile:(file,args,options,callback)=>{calls.push({file,args,options});callback(error,stdout);}
  }:actual(name)});
  assert.equal(await module.exports.readCurrentUserSid('C:\\SyntheticWindows'),'S-1-5-21-1-2-3-1001');
  for(const e of [{code:1},{killed:true,code:null},{code:'ENOENT'},null]){
    error=e;stdout=e?'"user","'+owner+'"':'malformed private output';
    await assert.rejects(module.exports.readCurrentUserSid('C:\\SyntheticWindows'),{message:'ACL_USER_UNAVAILABLE'});
  }
  assert.equal(calls.length,5);
  for(const call of calls){
    assert.equal(call.file,'C:\\SyntheticWindows\\System32\\whoami.exe');assert.deepEqual(Array.from(call.args),['/user','/fo','csv','/nh']);
    assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.options.timeout,10000);
    assert.equal(call.options.maxBuffer,64*1024);assert.equal(call.options.encoding,'utf8');assert.equal(call.options.stdio,undefined);
  }
});
