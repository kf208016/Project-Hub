'use strict';
// Short-lived, task/run scoped MCP capability only. This is not a provider
// login file or Hub owner credential. The controller creates it outside Git;
// the worker receives read access and the capability is revoked before cleanup.
const fs=require('node:fs'),path=require('node:path');
const {decode}=require('./providers/claude-protocol');
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const pattern=new RegExp('^[a-z]:\\\\.+\\\\AppData\\\\Local\\\\(?:Packages\\\\[^\\\\]+\\\\LocalCache\\\\Local\\\\)?ProjectHub\\\\runtime\\\\([a-f0-9]{64})\\\\(claude|grok)\\\\mcp\\\\('+UUID+')\\.json$','i');
const fail=()=>Object.assign(Error('Task MCP credential is invalid'),{code:'MCP_TASK_CREDENTIAL_INVALID'});
function load(file){
  let fd;
  try{
    if(typeof file!=='string'||file.length>32760||!file.isWellFormed()||/[\x00-\x1f]/.test(file)||file.includes('/'))throw fail();
    const match=file.match(pattern);if(!match||path.win32.normalize(file)!==file||file.slice(3).split('\\').some(p=>p==='.'||p==='..'||p.length>255||/[. ]$|[<>:"|?*\x7f]/.test(p)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)))throw fail();
    const before=fs.lstatSync(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>8192n)throw fail();
    fd=fs.openSync(file,'r');const opened=fs.fstatSync(fd,{bigint:true});
    if(opened.ino!==before.ino||opened.dev!==before.dev||opened.size!==before.size||opened.mtimeNs!==before.mtimeNs)throw fail();
    const value=decode(fs.readFileSync(fd)),after=fs.fstatSync(fd,{bigint:true});
    if(after.ino!==opened.ino||after.dev!==opened.dev||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.nlink!==1n)throw fail();
    if(Object.keys(value).sort().join(',')!=='actor,port,rootFingerprint,runId,token,version'||value.version!==1||value.rootFingerprint!==match[1]||
      value.actor!==match[2]||value.runId!==match[3]||!Number.isSafeInteger(value.port)||value.port<1024||value.port>65535||
      typeof value.token!=='string'||!/^[a-zA-Z0-9_-]{43}$/.test(value.token))throw fail();
    return Object.freeze({port:value.port,token:value.token,runId:value.runId});
  }catch{throw fail();}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
module.exports={load};
