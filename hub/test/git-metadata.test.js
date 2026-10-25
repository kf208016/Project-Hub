'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const metadata=require('../lib/git-metadata'),drives=require('../lib/local-drives');
const gitExe=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:\\Program Files','Git','cmd','git.exe'):'/usr/bin/git';
function fixture(t) {
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'hub-git-metadata-')),repo=path.join(root,'repo'),home=path.join(root,'home'),empty=path.join(root,'empty.config');fs.mkdirSync(repo);fs.mkdirSync(home);fs.writeFileSync(empty,'');
 const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];Object.assign(env,{HOME:home,USERPROFILE:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty,GIT_AUTHOR_NAME:'Synthetic',GIT_COMMITTER_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.test',GIT_COMMITTER_EMAIL:'synthetic@example.test'});
 const git=(...args)=>execFileSync(gitExe,['-c','core.autocrlf=false','-C',repo,...args],{env,encoding:'utf8',stdio:'pipe'}).trim();git('init','-q','--template=');
 fs.writeFileSync(path.join(repo,'initial.txt'),'initial\n');git('add','initial.txt');git('commit','-qm','initial');
 const guard=extra=>metadata.createGuard({gitExe,home,xdg:path.join(home,'.config'),globalConfigs:[],systemConfigs:[],defaultAttributes:[],...extra});
 t.after(()=>{assert.ok(path.resolve(root).startsWith(fs.realpathSync(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});});
 return {root,repo,home,git,guard,config:path.join(repo,'.git','config')};
}
function beforeOperation(f,guard) {
 const marker=path.join(f.root,'operation-ran');
 assert.throws(()=>{guard(f.repo);execFileSync(process.execPath,['-e','require("fs").writeFileSync(process.argv[1],"operation")',marker]);});
 assert.equal(fs.existsSync(marker),false,'Unsafe metadata rejected before the operation spawn');
}
test('metadata validates a real repository, an ancestor lookup and a registered worktree before Git',t=>{
 const f=fixture(t),guard=f.guard();const first=guard(f.repo);assert.equal(first.source,f.repo);assert.equal(first.gitdir,path.join(f.repo,'.git'));assert.equal(first.gitExe,gitExe);
 const nested=path.join(f.repo,'src');fs.mkdirSync(nested);assert.equal(guard(nested).gitdir,first.gitdir);
 const worktree=path.join(f.root,'worktree');f.git('worktree','add','-qb','synthetic',worktree);const second=guard(worktree);assert.equal(second.common,first.common);assert.notEqual(second.gitdir,first.gitdir);
});
test('metadata recognizes a real bare repository and rejects incomplete .git candidates',t=>{
 const f=fixture(t),bare=path.join(f.root,'bare');f.git('init','--bare','-q',bare);assert.equal(f.guard()(bare).gitdir,bare);
 const broken=path.join(f.root,'broken');fs.mkdirSync(broken);fs.mkdirSync(path.join(broken,'.git'));assert.throws(()=>f.guard()(broken));
});
test('repo includes and includeIf are rejected before even the isolated parser is spawned',t=>{
 const f=fixture(t),original=fs.readFileSync(f.config);let parsed=0;
 const guard=f.guard({parse:()=>{parsed++;throw Error('Parser must not run');}});
 for(const suffix of ['\n[include]\npath = "\\\\\\\\uncontacted-server\\\\share\\\\config"\n','\n[ InClUdEIf "gitdir:**" ]\npath = local.config\n']) {
  fs.writeFileSync(f.config,Buffer.concat([original,Buffer.from(suffix)]));beforeOperation(f,guard);assert.equal(parsed,0);
 }
});
test('global local includes are parsed without following them in Git and remain supported',t=>{
 const f=fixture(t),global=path.join(f.home,'.gitconfig'),included=path.join(f.home,'included.config'),attrs=path.join(f.home,'attributes');
 fs.writeFileSync(attrs,'*.txt text\n');fs.writeFileSync(global,'[include]\npath = included.config\n');fs.writeFileSync(included,'[user]\nname = Synthetic\n[core]\nattributesFile = "'+attrs.replace(/\\/g,'/')+'"\n');
 const out=f.guard({globalConfigs:[global]})(f.repo);assert.ok(out.configs.includes(global));assert.ok(out.configs.includes(included));assert.ok(out.attributeFiles.includes(attrs));
});
test('global UNC includes are rejected by snapshot parsing before the actual Git operation', {skip:process.platform!=='win32'},t=>{
 const f=fixture(t),global=path.join(f.home,'.gitconfig');fs.writeFileSync(global,'[include]\npath = "\\\\\\\\uncontacted-server\\\\share\\\\config"\n');
 beforeOperation(f,f.guard({globalConfigs:[global]}));
});
test('include cycles, malformed config and excessive input fail closed',t=>{
 const f=fixture(t),a=path.join(f.home,'a.config'),b=path.join(f.home,'b.config');fs.writeFileSync(a,'[include]\npath = b.config\n');fs.writeFileSync(b,'[include]\npath = a.config\n');assert.throws(()=>f.guard({globalConfigs:[a]})(f.repo),/循環/);
 fs.writeFileSync(a,'[invalid');assert.throws(()=>f.guard({globalConfigs:[a]})(f.repo),/解析器/);
 fs.writeFileSync(a,Buffer.alloc(4*1024*1024+1,32));assert.throws(()=>f.guard({globalConfigs:[a]})(f.repo),/大小/);
});
test('UNC .gitfile, commondir and registered worktree pointers reject before an operation', {skip:process.platform!=='win32'},t=>{
 const f=fixture(t),link=path.join(f.root,'linked');fs.mkdirSync(link);fs.writeFileSync(path.join(link,'.git'),'gitdir: \\\\uncontacted-server\\share\\repo\n');assert.throws(()=>f.guard()(link),/網路|本機/);
 const common=path.join(f.repo,'.git','commondir');fs.writeFileSync(common,'\\\\uncontacted-server\\share\\common\n');beforeOperation(f,f.guard());fs.unlinkSync(common);
 const registration=path.join(f.repo,'.git','worktrees','synthetic');fs.mkdirSync(registration,{recursive:true});fs.writeFileSync(path.join(registration,'gitdir'),'\\\\uncontacted-server\\share\\.git\n');beforeOperation(f,f.guard());
});
test('object alternates refuse UNC, HTTP, cycles and symlinks; local alternates remain valid',t=>{
 const f=fixture(t),info=path.join(f.repo,'.git','objects','info'),file=path.join(info,'alternates'),other=path.join(f.root,'other-objects');fs.mkdirSync(info,{recursive:true});fs.mkdirSync(other);fs.mkdirSync(path.join(other,'info'));
 fs.writeFileSync(file,other+'\n');assert.doesNotThrow(()=>f.guard()(f.repo));fs.writeFileSync(path.join(other,'info','alternates'),path.join(f.repo,'.git','objects')+'\n');assert.throws(()=>f.guard()(f.repo),/循環/);fs.unlinkSync(path.join(other,'info','alternates'));
 if(process.platform==='win32'){const linked=path.join(other,'linked');fs.symlinkSync(path.join(f.repo,'.git','objects'),linked,'junction');beforeOperation(f,f.guard());fs.unlinkSync(linked);}
 fs.writeFileSync(path.join(info,'http-alternates'),'https://uncontacted.invalid/objects\n');beforeOperation(f,f.guard());fs.unlinkSync(path.join(info,'http-alternates'));
 if(process.platform==='win32'){fs.writeFileSync(file,'\\\\uncontacted-server\\share\\objects\n');beforeOperation(f,f.guard());}
});
test('network attributes, excludes, worktree roots, templates and unknown prefix interpolation reject before an operation',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t),original=fs.readFileSync(f.config);
 for(const [section,key]of [['core','attributesFile'],['core','excludesFile'],['core','worktree'],['core','hooksPath'],['init','templateDir']]) {
  fs.writeFileSync(f.config,Buffer.concat([original,Buffer.from('\n['+section+']\n'+key+' = "\\\\\\\\uncontacted-server\\\\share\\\\input"\n')]));beforeOperation(f,f.guard());
 }
 fs.writeFileSync(f.config,Buffer.concat([original,Buffer.from('\n[core]\nattributesFile = %(prefix)/etc/attributes\n')]));assert.throws(()=>f.guard()(f.repo),/prefix/);
});
test('partial clone and promisor config reject without fetching missing objects',t=>{
 const f=fixture(t),original=fs.readFileSync(f.config);
 for(const suffix of ['\n[extensions]\npartialClone = origin\n','\n[remote "origin"]\npromisor = true\n','\n[remote "origin"]\npromisor\n']){fs.writeFileSync(f.config,Buffer.concat([original,Buffer.from(suffix)]));beforeOperation(f,f.guard());}
});
test('metadata rejects junctions in control trees and unsafe ambient roots before filesystem access',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.repo,'.git','linked'),'junction');beforeOperation(f,f.guard());fs.unlinkSync(path.join(f.repo,'.git','linked'));
 assert.throws(()=>f.guard({home:'\\\\uncontacted-server\\share'})(f.repo),/本機|網路/);
 assert.throws(()=>f.guard({defaultAttributes:['\\\\uncontacted-server\\share\\attrs']})(f.repo),/本機|網路/);
});
test('drive classification rejects remote/unknown roots, malformed maps and stale classification',()=>{
 const map=Object.fromEntries(Array.from({length:26},(_,n)=>[String.fromCharCode(65+n),1]));map.C=3;map.D=4;let time=1000,calls=0;
 const check=drives.createChecker({platform:'win32',now:()=>time,query:()=>{calls++;return {...map};}});
 assert.doesNotThrow(()=>check('C:\\local'));assert.equal(calls,1);assert.throws(()=>check('D:\\remote'),/remote/);assert.throws(()=>check('Z:\\absent'),/remote/);assert.equal(calls,3,'a rejected letter is re-queried instead of trusting the snapshot');
 time+=4999;map.C=4;assert.doesNotThrow(()=>check('C:\\still-cached'));assert.equal(calls,3);time+=1;assert.throws(()=>check('C:\\now-remote'),/remote/);assert.equal(calls,4);assert.throws(()=>check('\\\\uncontacted-server\\share'),/invalid/);assert.throws(()=>drives.parseTypes({C:3}),/invalid/);
});
