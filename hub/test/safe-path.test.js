'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {localPath}=require('../lib/safe-path');
test('local path validates ancestors and refuses junctions including a missing child',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-safe-path-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const actual=path.join(dir,'real');fs.mkdirSync(actual);assert.equal(localPath(actual),actual);
 const file=path.join(actual,'new.txt');assert.equal(localPath(file,{allowMissing:true}),file);assert.throws(()=>localPath(file));
 const link=path.join(dir,'link');fs.symlinkSync(actual,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>localPath(path.join(link,'new.txt'),{allowMissing:true}),/symlink|junction/);
 assert.throws(()=>localPath('relative'));assert.throws(()=>localPath(actual+'\0bad'));
});
test('Windows local path rejects UNC, device, ADS and ambiguous names',{skip:process.platform!=='win32'},()=>{
 for(const value of ['\\\\host\\share\\file','\\\\?\\C:\\file','C:\\file:stream','C:\\CON.txt','C:\\x.','C:\\x ','C:\\..\\x'])assert.throws(()=>localPath(value,{allowMissing:true}),value);
});
