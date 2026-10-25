'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {localPath}=require('./safe-path');
function fileFor(dir,{create=false}={}){
  localPath(dir,{allowMissing:true});const canonical=process.platform==='win32'?path.resolve(dir).toLowerCase():path.resolve(dir);
  const folder=path.join(fs.realpathSync(os.tmpdir()),'project-hub-reviewed-workspace-locks');localPath(folder,{allowMissing:true});if(create){fs.mkdirSync(folder,{recursive:true});localPath(folder);}
  return path.join(folder,createHash('sha256').update(canonical).digest('hex')+'.lock');
}
function locked(dir){const file=fileFor(dir);for(const f of [file,file+'.recovery-claim']){localPath(f,{allowMissing:true});try{fs.lstatSync(f);return true;}catch(e){if(e.code!=='ENOENT')throw e;}}return false;}
module.exports={fileFor,locked};
