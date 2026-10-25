'use strict';
// Internal transaction API. No ordinary MCP tool receives these operations.
const {privateInvoke}=require('./scoped-file');
function inspect({root,rootFingerprint,path}) {return privateInvoke({mode:'private-inspect',root,rootFingerprint,path});}
function copy({sourceRoot,sourceRootFingerprint,sourcePath,sourceHash,sourceFingerprint,root,rootFingerprint,path}) {return privateInvoke({mode:'private-copy',sourceRoot,sourceRootFingerprint,sourcePath,sourceHash,...(sourceFingerprint===undefined?{}:{sourceFingerprint}),root,rootFingerprint,path});}
function remove({root,rootFingerprint,path,expectedHash,expectedFingerprint}) {return privateInvoke({mode:'private-remove',root,rootFingerprint,path,expectedHash,expectedFingerprint});}
module.exports={inspect,copy,remove};
