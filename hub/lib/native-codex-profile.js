'use strict';
// Read-only artifact selection. Never execute an unreviewed helper to learn its version.
const fs=require('node:fs'),path=require('node:path');
const versions=require('./codex-versions'),artifacts=require('./native-cli-update');
function unreviewed(version){return Object.assign(Error(require('./native-provider-messages').messageFor('NATIVE_CODEX_VERSION_UNREVIEWED',version)),{code:'NATIVE_CODEX_VERSION_UNREVIEWED',status:409,notStarted:true,version});}
function resolve({updater,file}){
  let active;try{active=updater?.active();}catch{throw unreviewed();}
  if(active){if(versions.reviewed(active.version)?.binaryHash!==active.binaryHash)throw unreviewed(active.version);return active;}
  let binary=file,version;
  try{
    if(/\.cmd$/i.test(file)){
      const pkg=path.join(path.dirname(file),'node_modules','@openai','codex');
      const manifest=require('./safe-path').localPath(path.join(pkg,'package.json')),stat=fs.statSync(manifest);
      if(!stat.isFile()||stat.size>2*1024*1024)throw unreviewed();
      const metadata=JSON.parse(fs.readFileSync(manifest,'utf8'));
      if(metadata.name==='@openai/codex'&&typeof metadata.version==='string'&&metadata.version.length<=64&&/^\d+\.\d+\.\d+$/.test(metadata.version))version=metadata.version;
      binary=path.join(pkg,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
    }
    const binaryHash=artifacts.digestFile(binary),actual=versions.versionForHash(binaryHash);
    if(!actual)throw unreviewed(version);
    return {file:binary,version:actual,binaryHash};
  }catch(e){if(e.code==='NATIVE_CODEX_VERSION_UNREVIEWED')throw e;throw unreviewed(version);}
}
module.exports={resolve,unreviewed};
