'use strict';
// Fixture counterpart of hub/setup.sh's seed/template stage. This deliberately
// omits npm, shell scripts, desktop integration and all real user paths.
const fs=require('node:fs'),path=require('node:path');
function within(root,target){const r=path.relative(root,target);return !path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);}
function plain(file){const st=fs.lstatSync(file);if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile()))throw Error('Fixture bootstrap rejects links and special files');return st;}
function collect(root,dir=root,items=new Map()){
 plain(dir);for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name),st=plain(file);if(!within(root,file))throw Error('Fixture source escapes');if(st.isDirectory())collect(root,file,items);else if(name!=='.gitkeep')items.set(path.relative(root,file),fs.readFileSync(file));}return items;
}
function bootstrap({ownedRoot,root,hub,template}){
 ownedRoot=fs.realpathSync(ownedRoot);root=path.resolve(root);if(!within(ownedRoot,root)||root===ownedRoot)throw Error('Fixture root must be beneath the owned temporary directory');
 function directory(dir){if(!within(root,dir))throw Error('Fixture destination escapes');const rel=path.relative(ownedRoot,dir);let current=ownedRoot;for(const bit of rel.split(path.sep)){current=path.join(current,bit);if(fs.existsSync(current)){if(!plain(current).isDirectory())throw Error('Fixture directory is occupied');}else fs.mkdirSync(current);}return dir;}
 directory(root);directory(path.join(root,'_hub'));directory(path.join(root,'Product'));directory(path.join(root,'Work'));let out='';
 const roles=path.join(root,'_hub/roles.yaml');if(!fs.existsSync(roles)){fs.writeFileSync(roles,fs.readFileSync(path.join(template,'_hub/roles.yaml')),{flag:'wx'});out+='作成: _hub/roles.yaml\n';}else if(!plain(roles).isFile())throw Error('Fixture roles are not a file');
 for(const name of fs.readdirSync(path.join(hub,'seed')).sort()){
  const source=path.join(hub,'seed',name);if(!plain(source).isDirectory())continue;const dest=path.join(root,'Product',name),manifest=path.join(dest,'PROJECT.md');
  if(fs.existsSync(manifest)){if(!plain(manifest).isFile())throw Error('Fixture manifest is not a file');out+='そのまま: '+name+'（台帳あり）\n';continue;}
  const files=collect(path.join(template,'project'));for(const [relative,bytes]of collect(source))files.set(relative,bytes);
  // Validate the full destination before writing; existing seed content is
  // never replaced even if a prior interrupted fixture left no PROJECT.md.
  directory(dest);for(const relative of files.keys()){const target=path.resolve(dest,relative);if(!within(dest,target))throw Error('Fixture template escapes');if(fs.existsSync(target))throw Error('Fixture destination already exists');}
  for(const [relative,bytes]of files){const target=path.join(dest,relative);directory(path.dirname(target));fs.writeFileSync(target,bytes,{flag:'wx'});}out+='作成: '+name+'\n';
 }
 return out;
}
module.exports={bootstrap};
