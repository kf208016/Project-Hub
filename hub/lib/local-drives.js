'use strict';
// No safe-path import: safe-path can call this before its first filesystem read.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const LETTERS=Array.from({length:26},(_,n)=>String.fromCharCode(65+n));
let binary;
function ownedPath(value,{missing=false}={}) {
  const systemRoot=process.env.SystemRoot||'C:\\Windows',boot=path.parse(systemRoot).root.toLowerCase();
  if(typeof value!=='string'||!path.isAbsolute(value)||!/^([a-z]):[\\/]/i.test(value)||value.slice(2).includes(':')||value.includes('\0')||path.parse(value).root.toLowerCase()!==boot)throw Error('Drive helper package and compiler must be on the trusted system drive');
  let current=path.parse(value).root;
  for(const part of path.resolve(value).slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);let st;
    try{st=fs.lstatSync(current);}catch(e){if(missing&&e.code==='ENOENT')return value;throw e;}
    if(st.isSymbolicLink())throw Error('Drive helper package path contains a reparse point');
  }
  return value;
}
function ensureHelper() {
  if(binary)return ownedPath(binary);
  const source=ownedPath(path.join(__dirname,'../windows/local-drives.cs'));
  const digest=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const runtime=ownedPath(path.join(__dirname,'../.runtime'),{missing:true});fs.mkdirSync(runtime,{recursive:true});
  const file=ownedPath(path.join(runtime,'local-drives-'+digest+'.exe'),{missing:true});
  if(!fs.existsSync(file)) {
    const systemRoot=process.env.SystemRoot||'C:\\Windows';
    const compiler=ownedPath(path.join(systemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'));
    const temp=path.join(runtime,'local-drives-'+randomUUID()+'.exe');
    try{execFileSync(compiler,['/nologo','/target:exe','/optimize+','/reference:System.Web.Extensions.dll','/out:'+temp,source],{windowsHide:true,timeout:30000,stdio:'pipe'});fs.renameSync(temp,file);}
    catch{try{fs.unlinkSync(temp);}catch{}throw Error('Local drive classification helper is unavailable');}
  }
  return(binary=file);
}
function parseTypes(raw) {
  const map=typeof raw==='string'?JSON.parse(raw):raw;
  if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).sort().join('')!==LETTERS.join('')||LETTERS.some(letter=>!Number.isInteger(map[letter])||map[letter]<0||map[letter]>6))throw Error('Local drive classification is invalid');
  return Object.freeze({...map});
}
function queryTypes() {
  const systemRoot=process.env.SystemRoot||'C:\\Windows';
  let raw;try{raw=execFileSync(ensureHelper(),[],{encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:4096,env:{SystemRoot:systemRoot,WINDIR:systemRoot}});}catch{throw Error('Local drive classification is unavailable');}
  return parseTypes(raw);
}
function createChecker({query=queryTypes,now=()=>Date.now(),platform=process.platform}={}) {
  let cached=null,at=0;
  return function assertLocalDrive(value) {
    if(platform!=='win32')return;
    if(typeof value!=='string'||!/^([a-z]):[\\/]/i.test(value)||value.slice(2).includes(':')||/[\0\r\n]/.test(value))throw Error('Local drive path is invalid');
    const time=now();if(!Number.isSafeInteger(time)||time<0)throw Error('Local drive classification time is invalid');
    // A short OS snapshot avoids a helper per lstat. This does not attest that
    // an administrator cannot remount a volume or alter the package itself.
    if(!cached||time-at>=1000||time<at){cached=parseTypes(query());at=time;}
    const type=cached[value[0].toUpperCase()];
    if(![2,3,5,6].includes(type))throw Error('Unknown, absent or remote drives are not accepted');
  };
}
module.exports={assertLocalDrive:createChecker(),createChecker,parseTypes};
