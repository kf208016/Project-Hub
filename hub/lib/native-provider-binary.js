'use strict';
// Controller-only fixed bytes. The existing native private broker holds every
// ancestor and the same source HANDLE through hash/read/copy. No download,
// provider execution or authentication access.
const path=require('node:path');
const scoped=require('./scoped-file');
const {PROVIDER_HASHES}=require('./provider-native-host');
const {validateRuntimeBase}=require('./provider-native-plan');
const fail=()=>Object.assign(Error('固定 CLI 私有副本不符合來源或檔案身分；未啟動。'),{code:'NATIVE_BINARY_UNAVAILABLE',status:409,notStarted:true});
function relative(root,file){
  if(typeof file!=='string'||!path.isAbsolute(file))throw fail();
  const value=path.relative(root,file);
  if(!value||path.isAbsolute(value)||value.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw fail();
  return value;
}
async function materialize({root,source,destination,expectedHash,identity=file=>scoped.identity(file)}){
  if(typeof root!=='string'||!path.isAbsolute(root)||!/^[a-f0-9]{64}$/.test(expectedHash||''))throw fail();
  const sourcePath=relative(root,source),targetPath=relative(root,destination);
  if(sourcePath.toLowerCase()===targetPath.toLowerCase())throw fail();
  try{
    const rootFingerprint=(await identity(root)).rootFingerprint,target={root,rootFingerprint,path:targetPath};
    const inspect=async()=>{
      const receipt=await scoped.privateInvoke({mode:'private-binary-inspect',...target});
      if(receipt.sha256!==expectedHash||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<1||receipt.bytes>512*1024*1024)throw fail();
    };
    try{await inspect();return destination;}
    catch(error){if(error.code!=='NOT_FOUND')throw error;}
    try{
      const receipt=await scoped.privateInvoke({mode:'private-binary-copy',...target,sourceRoot:root,sourceRootFingerprint:rootFingerprint,sourcePath,sourceHash:expectedHash});
      if(receipt.created!==true||receipt.sha256!==expectedHash)throw fail();
    }catch(error){if(error.code!=='DESTINATION_EXISTS')throw error;}
    await inspect();return destination;
  }catch{throw fail();}
}
function claudeFile(ownerHome,runtimeBase,{identity}={}){
  if(typeof ownerHome!=='string'||!path.isAbsolute(ownerHome))throw fail();
  try{runtimeBase=validateRuntimeBase(runtimeBase,ownerHome);}catch{throw fail();}
  return materialize({root:ownerHome,
    source:path.join(ownerHome,'AppData','Roaming','npm','node_modules','@anthropic-ai','claude-code','bin','claude.exe'),
    destination:path.join(runtimeBase,'runtime-binaries','claude',PROVIDER_HASHES.claude,'claude.exe'),
    expectedHash:PROVIDER_HASHES.claude,identity
  });
}
const grokVersions=require('./grok-versions'),{messageFor}=require('./native-provider-messages');
function grokSources(ownerHome,version){
  if(typeof ownerHome!=='string'||!path.win32.isAbsolute(ownerHome)||!grokVersions.reviewed(version))throw fail();
  return Object.freeze([path.win32.join(ownerHome,'.grok','downloads','grok-'+version+'-windows-x86_64'),path.win32.join(ownerHome,'.grok','bin','grok.exe'),path.win32.join(ownerHome,'.grok','bin','grok.exe.old')]);
}
function grokSlot(runtimeBase,version){
  if(typeof runtimeBase!=='string'||!path.win32.isAbsolute(runtimeBase)||!grokVersions.reviewed(version))throw fail();
  return path.win32.join(runtimeBase,'runtime-binaries','grok',grokVersions.reviewed(version).binaryHash,'grok.exe');
}
function unreviewed(detail){
  return Object.assign(Error(messageFor('NATIVE_GROK_VERSION_UNREVIEWED',detail)),{code:'NATIVE_GROK_VERSION_UNREVIEWED',status:409,notStarted:true,hashPrefix:detail.hashPrefix??null,override:detail.override??null});
}
async function grokFile(ownerHome,runtimeBase,{identity,version=process.env.PROJECT_HUB_GROK_VERSION}={}){
  if(typeof ownerHome!=='string'||!path.isAbsolute(ownerHome))throw fail();
  try{runtimeBase=validateRuntimeBase(runtimeBase,ownerHome);}catch{throw fail();}
  let candidates=grokVersions.PREFERRED;
  if(version!==''&&version!==undefined&&version!==null){
    if(!grokVersions.reviewed(version))throw unreviewed({override:String(version).slice(0,64)});
    candidates=[version];
  }
  for(const candidate of candidates){
    const destination=grokSlot(runtimeBase,candidate),expectedHash=grokVersions.reviewed(candidate).binaryHash;
    for(const source of grokSources(ownerHome,candidate)){
      try{return await materialize({root:ownerHome,source,destination,expectedHash,identity});}
      catch(error){if(error.code!=='NATIVE_BINARY_UNAVAILABLE')throw error;}
    }
  }
  // Exhausted. A reviewed live install that still could not be materialized is a copy/broker failure (NATIVE_BINARY_UNAVAILABLE),
  // not an unreviewed version; only an unknown or unreadable live digest reports NATIVE_GROK_VERSION_UNREVIEWED.
  let hashPrefix=null,liveVersion=null;
  try{const digest=require('./native-cli-update').digestFile(path.win32.join(ownerHome,'.grok','bin','grok.exe'));hashPrefix=digest.slice(0,12);liveVersion=grokVersions.versionForHash(digest);}catch{}
  if(liveVersion)throw fail();
  throw unreviewed({hashPrefix});
}
module.exports={materialize,claudeFile,grokFile,grokSources,grokSlot,unreviewed};
