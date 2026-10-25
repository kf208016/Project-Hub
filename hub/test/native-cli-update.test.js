'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {NativeCliUpdater,extract,metadata,inventory}=require('../lib/native-cli-update');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),sri=bytes=>'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64');
const validProbe=(version='0.154.0')=>({version,modelCalled:false,insideWrite:true,outsideWriteDenied:true,readBoundary:'broader-than-task',networkBoundary:'incomplete',lifetimeProfile:'native-command-lifetime-0.154.0'});
function tar(entries){const parts=[];for(const [name,data,type='0']of entries){const bytes=Buffer.isBuffer(data)?data:Buffer.from(data),header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write(String(bytes.length.toString(8)).padStart(11,'0')+'\0',124);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);const checksum=header.reduce((a,b)=>a+b,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);parts.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));}parts.push(Buffer.alloc(1024));return zlib.gzipSync(Buffer.concat(parts));}
function setup(t,{version='0.154.0',badBytes=false}={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cli-slot-')),vendor=path.join(root,'expected/vendor'),relative='x86_64-pc-windows-msvc/bin/codex.exe',binary=Buffer.from('synthetic fixture executable');fs.mkdirSync(path.dirname(path.join(vendor,relative)),{recursive:true});fs.writeFileSync(path.join(vendor,relative),binary);const knownHash=sha(binary),knownVendorHash=inventory(vendor),beforePath=process.env.PATH;t.after(()=>{process.env.PATH=beforePath;fs.rmSync(root,{recursive:true,force:true});});
 const mainPackage={name:'@openai/codex',version,optionalDependencies:{'@openai/codex-win32-x64':'npm:@openai/codex@'+version+'-win32-x64'},scripts:{postinstall:'node should-not-run.cjs'}},nativePackage={name:'@openai/codex',version:version+'-win32-x64',os:['win32'],cpu:['x64']},main=tar([['package/package.json',JSON.stringify(mainPackage)],['package/should-not-run.cjs','require("fs").writeFileSync("INSTALL_SCRIPT_RAN","bad")']]),native=tar([['package/package.json',JSON.stringify(nativePackage)],['package/vendor/'+relative,binary]]);
 const meta=(asset,exact)=>Buffer.from(JSON.stringify({name:'@openai/codex',version:exact,dist:{integrity:sri(asset),tarball:'https://registry.npmjs.org/@openai/codex/-/codex-'+exact+'.tgz'},...(exact===version?{optionalDependencies:mainPackage.optionalDependencies}:{os:['win32'],cpu:['x64']})}));
 const data=new Map([['https://registry.npmjs.org/%40openai%2Fcodex/'+version,meta(main,version)],['https://registry.npmjs.org/%40openai%2Fcodex/'+version+'-win32-x64',meta(native,version+'-win32-x64')],['https://registry.npmjs.org/@openai/codex/-/codex-'+version+'.tgz',main],['https://registry.npmjs.org/@openai/codex/-/codex-'+version+'-win32-x64.tgz',badBytes?Buffer.from('wrong payload'):native]]);
 let probes=0;const updater=new NativeCliUpdater({root,knownHash,knownVendorHash,reviewedVersions:Object.fromEntries(Object.entries(require('../lib/codex-versions').REVIEWED).map(([key,value])=>[key,{...value,binaryHash:knownHash,vendorHash:knownVendorHash}])),read:async url=>{assert.ok(data.has(url),url);return data.get(url);},probe:async(_binary,_slot,actual)=>{probes++;return validProbe(actual);}});return{root,updater,data,version,probes:()=>probes,knownHash,knownVendorHash};}
test('Native CLI exact source/SRI preview stages without package scripts and activates only Hub process PATH',async t=>{
 const f=setup(t),before=process.env.PATH,preview=await f.updater.preview(f.version);assert.equal(preview.ignoreScripts,true);assert.equal(preview.scope,'Hub-private-slot');const result=await f.updater.apply({version:f.version,token:preview.token,confirm:true});assert.equal(result.ok,true);assert.equal(result.globalCliChanged,false);assert.equal(f.probes(),2);assert.notEqual(process.env.PATH,before);assert.equal(f.updater.active().version,f.version);assert.equal(fs.existsSync(path.join(f.root,'INSTALL_SCRIPT_RAN')),false);await assert.rejects(f.updater.apply({version:f.version,token:preview.token,confirm:true}),{code:'PREVIEW_EXPIRED'});
});
test('An unknown Codex protocol version is staged but never executed or activated',async t=>{
 const f=setup(t,{version:'0.155.0'}),before=process.env.PATH,preview=await f.updater.preview(f.version);assert.equal(preview.compatible,false);const result=await f.updater.apply({version:f.version,token:preview.token,confirm:true});assert.equal(result.phase,'blocked');assert.equal(result.blocker,'UNVERIFIED_CODEX_PROTOCOL_VERSION');assert.equal(result.oldVersionRetained,true);assert.equal(f.probes(),0);assert.equal(process.env.PATH,before);assert.equal(f.updater.active(),null);assert.deepEqual(fs.readdirSync(path.join(f.root,'_hub/cli/slots')),[]);
});
test('SRI mismatch and changed metadata reject a candidate while keeping prior executable selection',async t=>{
 const f=setup(t,{badBytes:true}),before=process.env.PATH,preview=await f.updater.preview(f.version);await assert.rejects(f.updater.apply({version:f.version,token:preview.token,confirm:true}),{code:'SRI_MISMATCH'});assert.equal(process.env.PATH,before);assert.equal(f.updater.active(),null);
 const changed=await f.updater.preview(f.version),url='https://registry.npmjs.org/%40openai%2Fcodex/'+f.version,meta=JSON.parse(f.data.get(url));meta.dist.integrity=sri(Buffer.from('different'));f.data.set(url,Buffer.from(JSON.stringify(meta)));await assert.rejects(f.updater.apply({version:f.version,token:changed.token,confirm:true}),{code:'SOURCE_CHANGED'});assert.equal(f.probes(),0);
});
test('Failed postactivation probe rolls the temporary process PATH back and preserves old persistent pointer',async t=>{
 const f=setup(t),first=await f.updater.preview(f.version);await f.updater.apply({version:f.version,token:first.token,confirm:true});const pointer=fs.readFileSync(path.join(f.root,'_hub/cli/active.json'),'utf8'),before=process.env.PATH,next=await f.updater.preview(f.version);let calls=0;f.updater.probe=async()=>{if(++calls===2)throw Object.assign(Error('synthetic health failure'),{code:'PROBE_REJECTED',status:409});return validProbe();};await assert.rejects(f.updater.apply({version:f.version,token:next.token,confirm:true}),{code:'PROBE_REJECTED'});assert.equal(process.env.PATH,before);assert.equal(fs.readFileSync(path.join(f.root,'_hub/cli/active.json'),'utf8'),pointer);
});
test('Incomplete or overstated probe receipts never activate a candidate',async t=>{const f=setup(t),before=process.env.PATH;for(const observed of [{modelCalled:false},{...validProbe(),outsideWriteDenied:false},{...validProbe(),readBoundary:'task-only'}]){const preview=await f.updater.preview(f.version);f.updater.probe=async()=>observed;await assert.rejects(f.updater.apply({version:f.version,token:preview.token,confirm:true}),{code:'PROBE_REJECTED'});assert.equal(process.env.PATH,before);assert.equal(f.updater.active(),null);}});
test('Approval expires on monotonic time and invalid clocks revoke prior previews',async t=>{const f=setup(t);let wall=1000000,mono=1000;f.updater.now=()=>wall;f.updater.monotonic=()=>mono;const old=await f.updater.preview(f.version);mono+=600001;await assert.rejects(f.updater.apply({version:f.version,token:old.token,confirm:true}),{code:'PREVIEW_EXPIRED'});const fresh=await f.updater.preview(f.version);wall=NaN;await assert.rejects(f.updater.apply({version:f.version,token:fresh.token,confirm:true}),{code:'CLOCK_REJECTED'});wall=1000001;await assert.rejects(f.updater.apply({version:f.version,token:fresh.token,confirm:true}),{code:'PREVIEW_EXPIRED'});assert.equal(f.probes(),0);});
test('Active vendor changes reject startup and an explicit rollback restores the previous process selection',async t=>{const f=setup(t),before=process.env.PATH,preview=await f.updater.preview(f.version),result=await f.updater.apply({version:f.version,token:preview.token,confirm:true}),binary=f.updater.active().file;fs.writeFileSync(binary,'changed fixture');assert.throws(()=>f.updater.active(),{code:'ACTIVE_BINARY_CHANGED'});assert.equal(f.updater.rollback(result.slot).phase,'rolled-back');assert.equal(process.env.PATH,before);assert.equal(f.updater.active(),null);});
test('Native package metadata rejects a foreign source, wrong version and wrong platform',()=>{
 const base={name:'@openai/codex',version:'0.154.0-win32-x64',os:['win32'],cpu:['x64'],dist:{integrity:sri(Buffer.from('fixture')),tarball:'https://registry.npmjs.org/@openai/codex/-/codex-0.154.0-win32-x64.tgz'}};assert.throws(()=>metadata(JSON.stringify({...base,dist:{...base.dist,tarball:'https://example.com/payload.tgz'}}),'0.154.0',true),{code:'SOURCE_REJECTED'});assert.throws(()=>metadata(JSON.stringify({...base,version:'0.155.0-win32-x64'}),'0.154.0',true),{code:'METADATA_REJECTED'});assert.throws(()=>metadata(JSON.stringify({...base,cpu:['arm64']}),'0.154.0',true),{code:'PLATFORM_PACKAGE_MISMATCH'});
});
test('Archive parser rejects traversal, case collisions, links and checksum corruption before activating',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-cli-tar-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));for(const [label,archive,code]of[['escape',tar([['package/../outside.txt','bad']]),'ARCHIVE_PATH'],['case',tar([['package/Foo.txt','one'],['package/foo.txt','two']]),'ARCHIVE_COLLISION'],['link',tar([['package/link','outside','2']]),'ARCHIVE_LINK_OR_TYPE']])assert.throws(()=>extract(archive,path.join(root,label)),{code});const bytes=zlib.gunzipSync(tar([['package/foo.txt','safe']]));bytes[0]=88;assert.throws(()=>extract(zlib.gzipSync(bytes),path.join(root,'checksum')),{code:'ARCHIVE_CHECKSUM'});assert.equal(fs.existsSync(path.join(root,'outside.txt')),false);
});

test('both reviewed pointers load and 0.164.0 rolls back to the preserved 0.154.0 slot',async t=>{
 const old=setup(t),next=setup(t,{version:'0.164.0'});
 const install=async version=>{const p=await old.updater.preview(version);return old.updater.apply({version,token:p.token,confirm:true});};
 const first=await install('0.154.0'),pointerFile=path.join(old.root,'_hub/cli/active.json'),before=fs.readFileSync(pointerFile);
 assert.equal(old.updater.active().version,'0.154.0');for(const [key,value]of next.data)old.data.set(key,value);
 const second=await install('0.164.0');assert.equal(old.updater.active().version,'0.164.0');assert.deepEqual(old.updater.active().previous,{slot:first.slot,version:'0.154.0'});
 const record=JSON.parse(fs.readFileSync(path.join(old.root,'_hub/cli/slots',second.slot,'record.json')));assert.equal(record.probe.version,'0.164.0');assert.equal(record.health.version,'0.164.0');
 old.updater.cleanupCandidate(path.join(old.root,'_hub/cli/slots',first.slot),first.slot);old.updater.cleanupCandidate(path.join(old.root,'_hub/cli/slots',second.slot),second.slot);
 assert.ok(fs.existsSync(path.join(old.root,'_hub/cli/slots',first.slot)));assert.ok(fs.existsSync(path.join(old.root,'_hub/cli/slots',second.slot)));
 assert.equal(old.updater.rollback(second.slot).phase,'rolled-back');assert.equal(old.updater.active().version,'0.154.0');assert.deepEqual(fs.readFileSync(pointerFile),before);
});
test('wrong-version probe and reviewed version with wrong vendor fail closed and remove candidate',async t=>{
 const f=setup(t,{version:'0.164.0'});f.updater.probe=async()=>validProbe();let p=await f.updater.preview(f.version);
 await assert.rejects(f.updater.apply({version:f.version,token:p.token,confirm:true}),{code:'PROBE_REJECTED'});assert.deepEqual(fs.readdirSync(path.join(f.root,'_hub/cli/slots')),[]);
 f.updater.reviewedVersions=Object.freeze({'0.164.0':{...require('../lib/codex-versions').REVIEWED['0.164.0'],binaryHash:f.knownHash}});p=await f.updater.preview(f.version);
 const result=await f.updater.apply({version:f.version,token:p.token,confirm:true});assert.equal(result.blocker,'VENDOR_NOT_REVIEWED');assert.deepEqual(fs.readdirSync(path.join(f.root,'_hub/cli/slots')),[]);
});
test('allow-list is deeply frozen, exact, and excludes inherited keys',()=>{
 const {REVIEWED,reviewed,versionForHash}=require('../lib/codex-versions');assert.deepEqual(Object.keys(REVIEWED),['0.154.0','0.164.0']);assert.ok(Object.isFrozen(REVIEWED));
 for(const version of Object.keys(REVIEWED)){assert.ok(Object.isFrozen(reviewed(version)));assert.equal(versionForHash(reviewed(version).binaryHash),version);}
 for(const version of ['0.153.0','0.165.0','__proto__',null])assert.equal(reviewed(version),null);
 assert.equal(require('../lib/native-cli-update').KNOWN,REVIEWED['0.154.0'].binaryHash);
});
test('45-file vendor inventory fits the 1 GiB total; per-file cap remains 512 MiB',t=>{
 const f=setup(t),folder=path.join(f.root,'45-files');fs.mkdirSync(folder);for(let i=0;i<45;i++)fs.writeFileSync(path.join(folder,'voice-'+String(i).padStart(2,'0')+'.dll'),'synthetic-'+i);
 assert.match(inventory(folder),/^[a-f0-9]{64}$/);assert.equal(require('../lib/native-cli-update').UNPACKED_LIMIT,1024*1024*1024);
 const large=path.join(folder,'oversize.dll'),fd=fs.openSync(large,'w');fs.ftruncateSync(fd,512*1024*1024+1);fs.closeSync(fd);assert.throws(()=>inventory(folder),{code:'FILE_REJECTED'});
});
test('digest cache reuses unchanged files and invalidates changed metadata and inode',t=>{
 const f=setup(t),file=path.join(f.root,'digest.exe'),{digestFile}=require('../lib/native-cli-update');fs.writeFileSync(file,'one');const read=fs.readSync;let reads=0;t.mock.method(fs,'readSync',(...args)=>{reads++;return read(...args);});
 const first=digestFile(file),count=reads;assert.equal(digestFile(file),first);assert.equal(reads,count);
 fs.writeFileSync(file,'different size');assert.notEqual(digestFile(file),first);assert.ok(reads>count);const second=reads;
 fs.utimesSync(file,1,1);digestFile(file);assert.ok(reads>second);const third=reads;
 fs.renameSync(file,file+'.old');fs.writeFileSync(file,'replacement');digestFile(file);assert.ok(reads>third);
});

test('default sandbox probe passes and records each actually observed version without executing a CLI',async t=>{
 const f=setup(t),files=require('../lib/scoped-file'),commands=require('../lib/codex-commands'),{defaultProbe,probeResult}=require('../lib/native-cli-update');
 t.mock.method(files,'identity',async()=>({rootFingerprint:'a'.repeat(64)}));
 t.mock.method(commands,'run',(_file,options)=>{fs.writeFileSync(path.join(options.cwd,'inside.txt'),'HUB_UPDATE_PROBE');return {promise:Promise.resolve({exitCode:0,codexVersion:options.expectedVersion,stdout:JSON.stringify({dedicated:true,outsideWriteCode:'EPERM'})})};});
 for(const version of ['0.154.0','0.164.0']){const slot=path.join(f.root,version);fs.mkdirSync(slot);const result=await defaultProbe(process.execPath,slot,version);assert.equal(result.version,version);assert.equal(probeResult(result,version,require('../lib/codex-versions').reviewed(version)).version,version);}
});
test('unknown candidate cleanup retains the active and previous reviewed slots',async t=>{
 const f=setup(t),unknown=setup(t,{version:'0.165.0'}),install=async version=>{const p=await f.updater.preview(version);return f.updater.apply({version,token:p.token,confirm:true});};
 const first=await install('0.154.0'),second=await install('0.154.0'),before=process.env.PATH;for(const [key,value]of unknown.data)f.data.set(key,value);
 const result=await install('0.165.0');assert.equal(result.phase,'blocked');assert.deepEqual(fs.readdirSync(path.join(f.root,'_hub/cli/slots')).sort(),[first.slot,second.slot].sort());assert.equal(process.env.PATH,before);assert.equal(f.updater.active().slot,second.slot);
});
test('inventory admits a synthetic 540 MiB 45-file total but rejects totals above 1 GiB',t=>{
 const f=setup(t),folder=path.join(f.root,'inventory-budget');fs.mkdirSync(folder);for(let i=0;i<45;i++)fs.writeFileSync(path.join(folder,'resource-'+i+'.dll'),'synthetic');
 const stat=fs.statSync;let size=12*1024*1024;t.mock.method(fs,'statSync',(file,options)=>{const result=stat(file,options);if(!options&&path.dirname(file)===folder)return {...result,size};return result;});
 assert.match(inventory(folder),/^[a-f0-9]{64}$/);size=24*1024*1024;assert.throws(()=>inventory(folder),{code:'VENDOR_LIMIT'});
});
test('public downloads retain stall protection with a 600-second total deadline',async t=>{
 const https=require('node:https'),{EventEmitter}=require('node:events'),{publicRead}=require('../lib/native-cli-update');let total,stall;const req=new EventEmitter();req.setTimeout=ms=>{stall=ms;};
 t.mock.method(global,'setTimeout',(_fn,ms)=>{total=ms;return 123;});t.mock.method(global,'clearTimeout',()=>{});
 t.mock.method(https,'get',(_target,_options,callback)=>{const res=new EventEmitter();res.statusCode=200;queueMicrotask(()=>{callback(res);res.emit('data',Buffer.from('synthetic'));res.emit('end');req.emit('close');});return req;});
 assert.equal((await publicRead('https://registry.npmjs.org/fixture')).toString(),'synthetic');assert.equal(total,600000);assert.equal(stall,15000);
});

test('updater archives stale or malformed lock and refuses a live exact owner',async t=>{
 const native=require('../windows/native-install.cjs');
 // Synthetic CAS adapter isolates lock policy from the native HANDLE integration suite.
 t.mock.method(native,'native',q=>{const file=path.join(q.root,q.path||q.source);if(q.mode==='inspect')return {text:fs.readFileSync(file,'utf8'),sha256:sha(fs.readFileSync(file)),fileFingerprint:String(fs.statSync(file).ino)};assert.equal(q.mode,'rename');assert.equal(sha(fs.readFileSync(file)),q.expectedHash);assert.equal(String(fs.statSync(file).ino),q.fileFingerprint);fs.renameSync(file,path.join(q.root,q.destination));return {ok:true};});
 const f=setup(t),lock=path.join(f.updater.dir,'update.lock');fs.mkdirSync(f.updater.dir,{recursive:true});let alive=false;
 f.updater.processIdentity={self:()=>({pid:process.pid,created:123}),isAlive:owner=>alive&&owner.pid===12345&&owner.created===456};
 const apply=async()=>{const p=await f.updater.preview(f.version);return f.updater.apply({version:f.version,token:p.token,confirm:true});};
 for(const value of ['{broken',JSON.stringify({version:1,pid:12345,created:455,at:1})]){fs.writeFileSync(lock,value);assert.equal((await apply()).ok,true);assert.equal(fs.existsSync(lock),false);}
 assert.equal(fs.readdirSync(f.updater.dir).filter(x=>/^update.lock.stale-.*\.json$/.test(x)).length,2);
 const live=JSON.stringify({version:1,pid:12345,created:456,at:1});fs.writeFileSync(lock,live);alive=true;
 await assert.rejects(apply(),e=>e.code==='UPDATE_IN_PROGRESS'&&e.status===409&&e.message==='另一個 Codex CLI 更新正在進行中，請等它完成後再試。');assert.equal(fs.readFileSync(lock,'utf8'),live);
});
