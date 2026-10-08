'use strict';
const fs=require('node:fs'),path=require('node:path'),{localPath}=require('./safe-path');
const VERSION='9.0.2-essentials_build-www.gyan.dev';
const SHA256='3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec';
const fail=()=>{throw Error('原生圖片依賴設定無效，請核對 _hub/native-dependencies.json 與已審查的 FFmpeg 9.0.2');};
function load(root){
  const file=localPath(path.join(root,'_hub','native-dependencies.json'),{allowMissing:true});
  let raw;try{const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||st.size>16384)fail();raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;fail();}
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='heicDecoder,version'||raw.version!==1)fail();
  const decoder=raw.heicDecoder;
  if(!decoder||typeof decoder!=='object'||Array.isArray(decoder)||Object.keys(decoder).sort().join(',')!=='path,sha256,version'||typeof decoder.path!=='string'||!path.isAbsolute(decoder.path)||decoder.sha256!==SHA256||decoder.version!==VERSION)fail();
  let binary;try{binary=localPath(decoder.path);const st=fs.lstatSync(binary);if(!st.isFile()||st.nlink!==1||st.size<256||st.size>512*1024*1024)fail();}catch{fail();}
  // The native codec verifies this digest while holding the actual executable
  // and its ancestor handles on every conversion. No PATH search is used.
  return Object.freeze({path:binary,sha256:SHA256,version:VERSION});
}
function apply(root,env=process.env){const decoder=load(root);if(decoder)Object.assign(env,{HUB_FFMPEG_PATH:decoder.path,HUB_FFMPEG_SHA256:decoder.sha256,HUB_FFMPEG_VERSION:decoder.version});return decoder;}
module.exports={load,apply,VERSION,SHA256};
