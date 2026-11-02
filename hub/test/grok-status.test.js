'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {status}=require('../lib/grok-status'),versions=require('../lib/grok-versions');
function home(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-r14-status-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(dir).startsWith('hub-r14-status-'));fs.rmSync(dir,{recursive:true,force:true});});return dir;}
test('metadata only: absent, auth, lock, private slot, frozen and no path disclosure',t=>{
 const dir=home(t);let s=status(dir,{version:''});assert.deepEqual(s.auth,{present:false,bytes:null,mtime:null,lockPresent:false,lockMtime:null});assert.equal(s.runtime.slotPresent,false);
 const auth=path.join(dir,'.grok','auth.json'),lock=auth+'.lock',slot=path.join(dir,'AppData/Local/ProjectHub/runtime-binaries/grok',versions.REVIEWED['1.0.70'].binaryHash,'grok.exe');
 fs.mkdirSync(path.dirname(auth));fs.writeFileSync(auth,'SYNTHETIC_SECRET');fs.writeFileSync(lock,'');fs.utimesSync(auth,1000,1000);fs.utimesSync(lock,2000,2000);fs.mkdirSync(path.dirname(slot),{recursive:true});fs.writeFileSync(slot,'SYNTHETIC_NOT_EXECUTABLE');
 for(const name of ['readFileSync','openSync','createReadStream'])t.mock.method(fs,name,()=>assert.fail('content read forbidden'));
 s=status(dir,{version:null});assert.deepEqual(s.auth,{present:true,bytes:16,mtime:new Date(1000000).toISOString(),lockPresent:true,lockMtime:new Date(2000000).toISOString()});assert.equal(s.runtime.slotPresent,true);
 assert.equal(s.runtime.version,'1.0.70');assert.equal(s.runtime.hashPrefix,'1e03c16cf2bd');for(const value of [s,s.auth,s.runtime])assert.ok(Object.isFrozen(value));assert.equal(JSON.stringify(s).includes(dir),false);assert.doesNotMatch(JSON.stringify(s),/SYNTHETIC|auth.json|AppData/);
});
test('overrides and invalid homes stay bounded without throwing',t=>{
 const dir=home(t);
 for(const version of ['1.0.34','1.0.70','bad','',null,3]){const s=status(dir,{version});assert.equal(s.runtime.override,typeof version==='string'&&version?version:null);assert.equal(s.runtime.overrideInvalid,version==='bad');assert.equal(s.runtime.version,version==='1.0.34'?'1.0.34':'1.0.70');}
 assert.equal(status(dir,{version:'x'.repeat(100)}).runtime.override.length,64);
 for(const value of [null,42,{},[]]){const s=status(value);assert.equal(s.auth.present,false);assert.equal(s.runtime.slotPresent,false);}
 fs.mkdirSync(path.join(dir,'.grok/auth.json'),{recursive:true});assert.equal(status(dir).auth.present,false);
 t.mock.method(fs,'lstatSync',()=>{throw Error('synthetic access denied');});assert.equal(status(dir).auth.present,false);
});
