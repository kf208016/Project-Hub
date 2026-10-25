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
module.exports={materialize,claudeFile};
