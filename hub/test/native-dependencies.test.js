'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dependency=require('../lib/native-dependencies');
test('Native dependency configuration is optional, exact and never selects a PATH executable',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-dependency-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(dependency.load(root),null);const dir=path.join(root,'_hub');fs.mkdirSync(dir);const file=path.join(dir,'native-dependencies.json'),binary=path.join(root,'fixed.exe');fs.writeFileSync(binary,Buffer.alloc(512));
  const valid={version:1,heicDecoder:{path:binary,sha256:dependency.SHA256,version:dependency.VERSION}};
  fs.writeFileSync(file,JSON.stringify(valid));const env={PATH:'unchanged'};assert.deepEqual(dependency.apply(root,env),valid.heicDecoder);assert.equal(env.PATH,'unchanged');assert.equal(env.HUB_FFMPEG_SHA256,dependency.SHA256);
  for(const raw of [{...valid,extra:true},{version:'1',heicDecoder:valid.heicDecoder},{...valid,heicDecoder:{...valid.heicDecoder,sha256:'0'.repeat(64)}},{...valid,heicDecoder:{...valid.heicDecoder,version:'9.0.1'}},{...valid,heicDecoder:{...valid.heicDecoder,path:'ffmpeg.exe'}},{...valid,heicDecoder:{...valid.heicDecoder,extra:true}},null]){fs.writeFileSync(file,JSON.stringify(raw));assert.throws(()=>dependency.load(root),/依賴設定無效/);}
  fs.writeFileSync(file,'broken');assert.throws(()=>dependency.load(root));
});
