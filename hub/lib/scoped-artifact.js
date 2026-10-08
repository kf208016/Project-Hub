'use strict';
// Internal reviewed artifact transactions only, never an ordinary MCP grant.
// Same native root/file identity boundary as secret copy; 64 MiB file maximum.
const {privateInvoke}=require('./scoped-file');
function inspect({root,rootFingerprint,path}) {return privateInvoke({mode:'private-artifact-inspect',root,rootFingerprint,path});}
function copy({sourceRoot,sourceRootFingerprint,sourcePath,sourceHash,sourceFingerprint,root,rootFingerprint,path}) {return privateInvoke({mode:'private-artifact-copy',sourceRoot,sourceRootFingerprint,sourcePath,sourceHash,...(sourceFingerprint===undefined?{}:{sourceFingerprint}),root,rootFingerprint,path});}
function remove({root,rootFingerprint,path,expectedHash,expectedFingerprint}) {return privateInvoke({mode:'private-artifact-remove',root,rootFingerprint,path,expectedHash,expectedFingerprint});}
module.exports={inspect,copy,remove};
