'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {materialize,claudeFile}=require('../lib/native-provider-binary'),scoped=require('../lib/scoped-file');
const {PROVIDER_HASHES}=require('../lib/provider-native-host');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-binary-copy-'));t.after(()=>{
    const absolute=fs.realpathSync(root);assert.equal(path.dirname(absolute).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(absolute).startsWith('hub-binary-copy-'));fs.rmSync(absolute,{recursive:true,force:true});
  });
  const bytes=Buffer.from('Synthetic fixed binary bytes; never executed.\n'),source=path.join(root,'source.exe'),destination=path.join(root,'private','sha','worker.exe');fs.writeFileSync(source,bytes);
  return {root,source,destination,expectedHash:hash(bytes),bytes};
}
test('Claude cache follows the resolved physical base through the same native HANDLE broker',async t=>{
  const ownerHome='C:\\Users\\fixture',runtimeBase=ownerHome+'\\AppData\\Local\\Packages\\Synthetic.Package\\LocalCache\\Local\\ProjectHub';
  const destination=path.join(runtimeBase,'runtime-binaries','claude',PROVIDER_HASHES.claude,'claude.exe');
  const calls=[];let inspected=false;
  t.mock.method(scoped,'identity',async root=>{assert.equal(root,ownerHome);return {rootFingerprint:'a'.repeat(64)};});
  t.mock.method(scoped,'privateInvoke',async request=>{
    calls.push(request);
    if(request.mode==='private-binary-inspect'){
      if(!inspected){inspected=true;throw Object.assign(Error('synthetic missing'),{code:'NOT_FOUND'});}
      return {sha256:PROVIDER_HASHES.claude,bytes:32};
    }
    assert.equal(request.mode,'private-binary-copy');
    return {created:true,sha256:PROVIDER_HASHES.claude};
  });
  assert.equal(await claudeFile(ownerHome,runtimeBase),destination);
  assert.deepEqual(calls.map(call=>call.mode),['private-binary-inspect','private-binary-copy','private-binary-inspect']);
  const copy=calls[1];
  assert.equal(copy.root,ownerHome);assert.equal(copy.sourceRoot,ownerHome);
  assert.equal(copy.path,path.relative(ownerHome,destination));
  assert.equal(copy.sourcePath,path.join('AppData','Roaming','npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe'));
  assert.equal(copy.sourceHash,PROVIDER_HASHES.claude);
});
test('Claude cache refuses missing or unrelated runtime bases before native IO',t=>{
  let touched=false;t.mock.method(scoped,'identity',async()=>{touched=true;throw Error('must not run');});
  for(const runtimeBase of [undefined,null,'C:\\Users\\fixture','C:\\Users\\fixture\\AppData\\Local\\Other',
    'C:\\Users\\other\\AppData\\Local\\ProjectHub','C:\\Users\\fixture\\AppData\\Local\\..\\ProjectHub',
    '\\\\server\\share\\ProjectHub']){
    assert.throws(()=>claudeFile('C:\\Users\\fixture',runtimeBase),{code:'NATIVE_BINARY_UNAVAILABLE'});
  }
  assert.equal(touched,false);
});
test('native HANDLE broker copies linked synthetic source to independent pinned bytes and reuses cache',async t=>{
  const f=fixture(t),alias=path.join(f.root,'source-alias.exe');fs.linkSync(f.source,alias);assert.equal(fs.statSync(f.source).nlink,2);
  assert.equal(await materialize(f),f.destination);const original=fs.statSync(f.source),copy=fs.statSync(f.destination);
  assert.notEqual(copy.ino,original.ino);assert.equal(copy.nlink,1);assert.equal(original.nlink,2);assert.deepEqual(fs.readFileSync(f.destination),f.bytes);
  await materialize(f);assert.equal(fs.statSync(f.destination).ino,copy.ino);
  fs.writeFileSync(alias,'changed upstream');assert.deepEqual(fs.readFileSync(f.destination),f.bytes);
  // A verified fixed private cache survives an upstream auto-update.
  assert.equal(await materialize(f),f.destination);
});
test('unmatched source hash publishes no destination',async t=>{
  const f=fixture(t);await assert.rejects(()=>materialize({...f,expectedHash:'0'.repeat(64)}),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(fs.existsSync(f.destination),false);
});
test('existing modified destination is refused without overwrite',async t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(f.destination),{recursive:true});fs.writeFileSync(f.destination,'foreign bytes');
  await assert.rejects(()=>materialize(f),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(fs.readFileSync(f.destination,'utf8'),'foreign bytes');
});
test('destination directory is refused without changing contents',async t=>{
  const f=fixture(t);fs.mkdirSync(f.destination,{recursive:true});fs.writeFileSync(path.join(f.destination,'keep.txt'),'keep');
  await assert.rejects(()=>materialize(f),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(fs.readFileSync(path.join(f.destination,'keep.txt'),'utf8'),'keep');
});
test('native broker refuses junction destination parent without writing through it',async t=>{
  const f=fixture(t),target=path.join(f.root,'unrelated');fs.mkdirSync(target);fs.symlinkSync(target,path.join(f.root,'private'),'junction');
  await assert.rejects(()=>materialize(f),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.deepEqual(fs.readdirSync(target),[]);
});
test('hardlinked cached destination is refused with aliases preserved',async t=>{
  const f=fixture(t);await materialize(f);const alias=path.join(f.root,'private-alias.exe');fs.linkSync(f.destination,alias);
  await assert.rejects(()=>materialize(f),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(fs.statSync(f.destination).nlink,2);assert.deepEqual(fs.readFileSync(alias),f.bytes);
});
test('ordinary private copy still refuses a multi-link source',async t=>{
  const f=fixture(t);fs.linkSync(f.source,path.join(f.root,'alias'));const rootFingerprint=(await scoped.identity(f.root)).rootFingerprint;
  await assert.rejects(()=>scoped.privateInvoke({mode:'private-copy',root:f.root,rootFingerprint,path:'not-created.bin',sourceRoot:f.root,sourceRootFingerprint:rootFingerprint,sourcePath:'source.exe',sourceHash:f.expectedHash}),{code:'MULTIPLE_LINKS_REJECTED'});
  assert.equal(fs.existsSync(path.join(f.root,'not-created.bin')),false);
});
test('root substitution between identity and native open is rejected without publication',async t=>{
  const f=fixture(t),other=fs.mkdtempSync(path.join(os.tmpdir(),'hub-binary-copy-'));
  t.after(()=>{const absolute=fs.realpathSync(other);assert.equal(path.dirname(absolute).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(absolute).startsWith('hub-binary-copy-'));fs.rmSync(absolute,{recursive:true,force:true});});
  const identity=scoped.identity;t.mock.method(scoped,'identity',async()=>identity(other));
  await assert.rejects(()=>materialize(f),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(fs.existsSync(f.destination),false);
});
test('create-only collision adopts only pinned bytes after native reinspection',async t=>{
  const f=fixture(t),invoke=scoped.privateInvoke;let raced=false;
  t.mock.method(scoped,'privateInvoke',async request=>{
    if(request.mode==='private-binary-copy'&&!raced){raced=true;fs.mkdirSync(path.dirname(f.destination),{recursive:true});fs.writeFileSync(f.destination,f.bytes,{flag:'wx'});}
    return invoke(request);
  });assert.equal(await materialize(f),f.destination);assert.equal(raced,true);
});
test('create-only collision cannot replace or adopt unrelated bytes',async t=>{
  const f=fixture(t),invoke=scoped.privateInvoke;let raced=false;
  t.mock.method(scoped,'privateInvoke',async request=>{
    if(request.mode==='private-binary-copy'&&!raced){raced=true;fs.mkdirSync(path.dirname(f.destination),{recursive:true});fs.writeFileSync(f.destination,'racing foreign bytes',{flag:'wx'});}
    return invoke(request);
  });await assert.rejects(()=>materialize(f),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(fs.readFileSync(f.destination,'utf8'),'racing foreign bytes');
});
test('binary broker handles data above artifact limit without changing the artifact grant',async t=>{
  const f=fixture(t),bytes=Buffer.alloc(65*1024*1024,0x53);fs.writeFileSync(f.source,bytes);f.expectedHash=hash(bytes);
  assert.equal(await materialize(f),f.destination);assert.equal(fs.statSync(f.destination).size,bytes.length);
  const rootFingerprint=(await scoped.identity(f.root)).rootFingerprint;
  await assert.rejects(()=>scoped.privateInvoke({mode:'private-artifact-inspect',root:f.root,rootFingerprint,path:path.relative(f.root,f.destination)}),{code:'FILE_SIZE_REJECTED'});
});

const {grokFile,grokSources,grokSlot}=require('../lib/native-provider-binary'),grokVersions=require('../lib/grok-versions');
function grokFixture(t,{succeedAt=0,existing=false}={}){
 const f=fixture(t),runtime=path.join(f.root,'AppData/Local/ProjectHub'),calls=[],copies=[];let ready=existing;
 t.mock.method(scoped,'identity',async root=>{assert.equal(root,f.root);return {rootFingerprint:'a'.repeat(64)};});
 t.mock.method(scoped,'privateInvoke',async r=>{calls.push(r);const hash=path.basename(path.dirname(r.path));
  if(r.mode==='private-binary-inspect'){if(!ready)throw Object.assign(Error('synthetic absent'),{code:'NOT_FOUND'});return {sha256:hash,bytes:32};}
  copies.push(r);if(copies.length!==succeedAt)throw Object.assign(Error('synthetic rejected'),{code:'SOURCE_CHANGED'});ready=true;return {created:true,sha256:r.sourceHash};
 });return {...f,runtime,calls,copies};
}
test('Grok source and slot paths have fixed order and reject invalid inputs',()=>{
 const home='C:\\Users\\fixture',base=home+'\\AppData\\Local\\ProjectHub';
 assert.deepEqual(grokSources(home,'1.0.70'),[home+'\\.grok\\downloads\\grok-1.0.70-windows-x86_64',home+'\\.grok\\bin\\grok.exe',home+'\\.grok\\bin\\grok.exe.old']);assert.ok(Object.isFrozen(grokSources(home,'1.0.70')));
 assert.equal(grokSlot(base,'1.0.34'),base+'\\runtime-binaries\\grok\\'+grokVersions.REVIEWED['1.0.34'].binaryHash+'\\grok.exe');
 for(const fn of [grokSources,grokSlot])for(const [root,v] of [['relative','1.0.70'],[null,'1.0.70'],[home,'toString'],[home,{}]])assert.throws(()=>fn(root,v),{code:'NATIVE_BINARY_UNAVAILABLE'});
});
test('Grok existing slot uses inspect only even when all source paths are absent',async t=>{
 const f=grokFixture(t,{existing:true});assert.equal(await grokFile(f.root,f.runtime,{version:null}),grokSlot(f.runtime,'1.0.70'));assert.deepEqual(f.calls.map(x=>x.mode),['private-binary-inspect']);assert.equal(f.copies.length,0);
});
for(const n of [1,3,4])test('Grok deterministic materialization succeeds on candidate source '+n,async t=>{
 const f=grokFixture(t,{succeedAt:n}),version=n===4?'1.0.34':'1.0.70';assert.equal(await grokFile(f.root,f.runtime,{version:''}),grokSlot(f.runtime,version));
 const ordered=grokVersions.PREFERRED.flatMap(v=>grokSources(f.root,v).map(source=>path.relative(f.root,source)));assert.deepEqual(f.copies.map(x=>x.sourcePath),ordered.slice(0,n));
 assert.equal(f.copies.at(-1).sourceHash,grokVersions.REVIEWED[version].binaryHash);
});
for(const exists of [true,false])test('Grok exhausted candidates report bounded synthetic live digest: '+exists,async t=>{
 const f=grokFixture(t),live=path.join(f.root,'.grok/bin/grok.exe');if(exists){fs.mkdirSync(path.dirname(live),{recursive:true});fs.writeFileSync(live,'synthetic unreviewed bytes');}
 await assert.rejects(grokFile(f.root,f.runtime,{version:null}),e=>e.code==='NATIVE_GROK_VERSION_UNREVIEWED'&&e.status===409&&e.notStarted&&e.hashPrefix===(exists?hash(Buffer.from('synthetic unreviewed bytes')).slice(0,12):null));assert.equal(f.copies.length,6);
});
test('Grok reviewed live install that cannot be materialized fails as NATIVE_BINARY_UNAVAILABLE, not unreviewed',async t=>{
 const f=grokFixture(t),live=path.join(f.root,'.grok/bin/grok.exe');fs.mkdirSync(path.dirname(live),{recursive:true});fs.writeFileSync(live,'synthetic reviewed bytes');
 const artifacts=require('../lib/native-cli-update');t.mock.method(artifacts,'digestFile',file=>String(file).replace(/\\/g,'/')===live.replace(/\\/g,'/')?grokVersions.REVIEWED['1.0.70'].binaryHash:hash(fs.readFileSync(file)));
 await assert.rejects(grokFile(f.root,f.runtime,{version:null}),e=>e.code==='NATIVE_BINARY_UNAVAILABLE'&&e.status===409&&e.notStarted===true);assert.equal(f.copies.length,6);
});
test('Grok invalid override and runtime fail before broker; valid override limits selection',async t=>{
 const f=grokFixture(t,{succeedAt:1});for(const version of ['toString','1.0.71',{},1])await assert.rejects(grokFile(f.root,f.runtime,{version}),{code:'NATIVE_GROK_VERSION_UNREVIEWED'});
 await assert.rejects(grokFile('relative',f.runtime),{code:'NATIVE_BINARY_UNAVAILABLE'});await assert.rejects(grokFile(f.root,path.dirname(f.runtime)),{code:'NATIVE_BINARY_UNAVAILABLE'});assert.equal(f.calls.length,0);
 assert.equal(await grokFile(f.root,f.runtime,{version:'1.0.34'}),grokSlot(f.runtime,'1.0.34'));assert.match(f.copies[0].sourcePath,/grok-1.0.34-windows-x86_64$/);
});
