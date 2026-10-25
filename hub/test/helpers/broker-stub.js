'use strict';
// Git/state-machine fixture only. This does not prove native broker FileID semantics.
const fs=require('node:fs'),{createHash}=require('node:crypto');
function install({inspect=false}={}){const files=require('../../lib/scoped-file'),secret=require('../../lib/scoped-secret'),identity=files.identity,oldInspect=secret.inspect;files.identity=async root=>{const st=fs.statSync(root,{bigint:true});return {rootFingerprint:createHash('sha256').update(String(st.dev)+':'+String(st.ino)).digest('hex')};};if(inspect)secret.inspect=async({root,path:relative})=>{const file=require('node:path').join(root,relative),data=fs.readFileSync(file),st=fs.statSync(file,{bigint:true});return {bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),fileFingerprint:createHash('sha256').update(String(st.dev)+':'+String(st.ino)).digest('hex')};};return()=>{files.identity=identity;secret.inspect=oldInspect;};}
module.exports={install};
