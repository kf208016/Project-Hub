'use strict';
// Preflight local metadata BEFORE Git discovers the repository or loads config.
// The parser receives bytes on stdin in an isolated, trusted bare repository;
// it never opens an untrusted include or an untrusted config pathname itself.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {createHash,randomUUID}=require('node:crypto');
const {localPath}=require('./safe-path');
const {assertLocalDrive}=require('./local-drives');
const MAX_BYTES=4*1024*1024,MAX_TOTAL=16*1024*1024,MAX_FILES=128,MAX_TREE=20000;
const fail=message=>{throw Error('Git 本機中繼資料未通過檢查：'+message);};
const canonical=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
let parserRoot;
let pathFrame=null;

function lexical(value) {
  if(typeof value!=='string'||!value||value.includes('\0')||/[\r\n]/.test(value)||!path.isAbsolute(value))fail('需要本機絕對路徑');
  if(process.platform==='win32'&&(!/^[a-z]:[\\/]/i.test(value)||value.slice(2).includes(':')))fail('不接受網路、裝置、ADS 或 drive-relative 路徑');
  if(process.platform==='win32')for(const part of value.slice(3).split(/[\\/]/).filter(Boolean))if(/[. ]$|[<>"|?*\x00-\x1f\x7f]/.test(part)||/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))fail('路徑含有不允許的 Windows 名稱');
  assertLocalDrive(value);
  return value;
}
function checked(value,{missing=false}={}) {
  lexical(value);const resolved=path.resolve(value);
  if(!pathFrame)return localPath(resolved,{allowMissing:missing});
  let current=path.parse(resolved).root;
  for(const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);const identity=canonical(current);
    if(current!==resolved&&pathFrame.has(identity))continue;
    let st;try{st=fs.lstatSync(current);}catch(e){if(missing&&e.code==='ENOENT')return resolved;throw e;}
    if(st.isSymbolicLink())fail('路徑含 symlink 或 junction');
    if(canonical(fs.realpathSync(current))!==identity)fail('路徑的實際位置不符');
    if(st.isDirectory())pathFrame.add(identity);
  }
  return resolved;
}
function statLocal(file,{missing=true}={}) {
  checked(file,{missing});
  try {return fs.lstatSync(file);}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
}
function bytesLocal(file,{missing=true,max=MAX_BYTES}={}) {
  const st=statLocal(file,{missing});if(!st)return null;
  if(!st.isFile()||st.size>max)fail('控制檔的型別或大小無效');
  const value=fs.readFileSync(file);if(value.length>max)fail('控制檔超過大小上限');
  if(value.includes(0))fail('控制檔含 NUL');
  return value;
}
function textLocal(file,options) {
  const value=bytesLocal(file,options);if(value===null)return null;
  try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{fail('控制檔不是有效 UTF-8');}
}
function resolveReference(raw,base,home,prefix) {
  if(typeof raw!=='string'||!raw||raw.includes('\0')||/[\r\n]/.test(raw))fail('控制檔參照無效');
  if(process.platform==='win32'&&(/^(?:[\\/]{2}|[a-z]:(?:$|[^\\/]))/i.test(raw)||/^(?:file|https?|ssh):/i.test(raw)))fail('控制檔參照是網路、裝置或非本機位置');
  let value=raw;
  if(value==='~')value=home;
  else if(/^~[\\/]/.test(value))value=path.join(home,value.slice(2));
  else if(value.startsWith('~'))fail('未支援其他帳號的 tilde 參照');
  else if(value.includes('%('))fail('Git prefix 插值尚未驗證，請使用明確本機路徑');
  const result=path.isAbsolute(value)?value:path.resolve(base,value);
  return checked(result,{missing:true});
}
function trustedGit() {
  if(process.platform!=='win32') {
    for(const file of ['/usr/bin/git','/usr/local/bin/git','/opt/homebrew/bin/git'])try{const resolved=fs.realpathSync(file);if(fs.statSync(resolved).isFile())return checked(resolved);}catch{}
    fail('找不到已知本機 Git 執行檔');
  }
  const bases=[process.env.ProgramFiles||'C:\\Program Files',process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)'];
  for(const base of bases) {
    checked(base,{missing:true});
    const file=path.join(base,'Git','cmd','git.exe'),st=statLocal(file);if(!st)continue;
    if(!st.isFile()||st.size<64)fail('Git 執行檔無效');
    const fd=fs.openSync(file,'r'),header=Buffer.alloc(2);try{fs.readSync(fd,header,0,2,0);}finally{fs.closeSync(fd);}
    if(header.toString('ascii')!=='MZ')fail('Git 執行檔不是本機 PE');
    return checked(file);
  }
  fail('找不到標準安裝位置的 Git；不會透過 PATH 執行未知 shim');
}
function parserContents(dir) {
  checked(dir);const names=fs.readdirSync(dir).sort();
  if(JSON.stringify(names)!==JSON.stringify(['HEAD','config','empty.config','objects','owner.json','refs']))fail('隔離解析器內容已改變');
  for(const name of names)checked(path.join(dir,name));
  if(fs.readdirSync(path.join(dir,'objects')).length||JSON.stringify(fs.readdirSync(path.join(dir,'refs')))!=='["heads"]')fail('隔離解析器內容已改變');
  checked(path.join(dir,'refs/heads'));if(fs.readdirSync(path.join(dir,'refs/heads')).length)fail('隔離解析器內容已改變');
}
function removeParser(dir) {
  parserContents(dir);
  for(const name of ['HEAD','config','empty.config','owner.json'])fs.unlinkSync(path.join(dir,name));
  for(const name of ['refs/heads','refs','objects'])fs.rmdirSync(path.join(dir,name));
  fs.rmdirSync(dir);
}
function isolatedParserRoot() {
  if(parserRoot){parserContents(parserRoot);return checked(parserRoot);}
  const runtime=checked(path.join(__dirname,'../.runtime'),{missing:true});fs.mkdirSync(runtime,{recursive:true});
  // Per-process parser: no metadata result is shared or retained across Git calls.
  // A reused PID conservatively retains the old directory; never kill its owner.
  for(const name of fs.readdirSync(runtime))if(/^gmp-[1-9][0-9]*-[a-f0-9]{8}$/.test(name))try{
    const dir=path.join(runtime,name),owner=JSON.parse(textLocal(path.join(dir,'owner.json'),{missing:false}));
    if(owner.pid!==Number(name.split('-')[1]))continue;
    try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')removeParser(dir);}
  }catch{ /* Unknown or altered directories are retained, never swept. */ }
  const dir=path.join(runtime,'gmp-'+process.pid+'-'+randomUUID().slice(0,8));fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir,'objects'));fs.mkdirSync(path.join(dir,'refs'));fs.mkdirSync(path.join(dir,'refs','heads'));
  fs.writeFileSync(path.join(dir,'HEAD'),'ref: refs/heads/main\n',{flag:'wx'});
  fs.writeFileSync(path.join(dir,'config'),'[core]\n\tbare = true\n',{flag:'wx'});
  fs.writeFileSync(path.join(dir,'empty.config'),'',{flag:'wx'});
  fs.writeFileSync(path.join(dir,'owner.json'),JSON.stringify({pid:process.pid}),{flag:'wx'});
  parserRoot=checked(dir);process.once('exit',()=>{try{removeParser(dir);}catch{}});return parserRoot;
}
function parseConfig(gitExe,value) {
  const dir=isolatedParserRoot(),empty=path.join(dir,'empty.config');
  if(textLocal(path.join(dir,'config'),{missing:false})!=='[core]\n\tbare = true\n'||textLocal(path.join(dir,'HEAD'),{missing:false})!=='ref: refs/heads/main\n'||bytesLocal(empty,{missing:false}).length)fail('隔離解析器中繼資料已改變');
  const env={SystemRoot:process.env.SystemRoot||'C:\\Windows',WINDIR:process.env.WINDIR||'C:\\Windows',HOME:dir,USERPROFILE:dir,XDG_CONFIG_HOME:dir,
    GIT_DIR:dir,GIT_COMMON_DIR:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:empty,GIT_CONFIG_GLOBAL:empty,GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'};
  let output;
  try{output=execFileSync(gitExe,['--no-optional-locks','config','--no-includes','--file','-','--null','--list'],{cwd:dir,env,input:value,encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe']});}
  catch{fail('無法用隔離解析器確認 Git 設定');}
  return output.split('\0').filter(Boolean).map(row=>{const n=row.indexOf('\n');if(n===0)fail('Git 設定解析結果無效');return n<0?[row,'']:[row.slice(0,n),row.slice(n+1)];});
}
function createGuard(options={}) {
  const cache=new Map();
  return function assertLocalMetadata(input) {
    const previousFrame=pathFrame;pathFrame=new Set();
    try {
    const dir=checked(process.platform==='win32'?input:fs.realpathSync(input));
    const home=checked(options.home||process.env.HOME||process.env.USERPROFILE||os.homedir(),{missing:true});
    const xdg=checked(options.xdg||process.env.XDG_CONFIG_HOME||path.join(home,'.config'),{missing:true});
    const gitExe=options.gitExe?checked(options.gitExe):trustedGit();
    const prefix=process.platform==='win32'?path.dirname(path.dirname(gitExe)):path.dirname(path.dirname(gitExe));
    const roots=options.globalConfigs||[path.join(xdg,'git','config'),path.join(home,'.gitconfig')];
    const system=options.systemConfigs||[path.join(prefix,'etc','gitconfig'),...(process.platform==='win32'?[path.join(prefix,'mingw64','etc','gitconfig'),path.join(checked(process.env.ProgramData||'C:\\ProgramData',{missing:true}),'Git','config')]:[])];
    const attributes=new Set(options.defaultAttributes||[path.join(xdg,'git','attributes'),path.join(prefix,'etc','gitattributes'),...(process.platform==='win32'?[path.join(prefix,'mingw64','etc','gitattributes')]:[])]);
    const ignores=new Set([path.join(xdg,'git','ignore')]);
    let source='',gitdir='',common='',count=0,total=0;const configs=[],visited=new Set(),active=new Set(),treeSeen=new Set();
    const verifyTree=root=>{
      // Validate the root ancestry once in this preflight. Every tree entry
      // still has a fresh lstat + canonical path check; nothing is trusted
      // across raw Git invocations. This is not an OS-owner race attestation.
      checked(root);
      const pending=[root];
      while(pending.length) {
        const current=pending.pop(),identity=canonical(current);if(treeSeen.has(identity))continue;treeSeen.add(identity);
        if(treeSeen.size>MAX_TREE)fail('Git 中繼資料項目超過上限');
        lexical(current);const st=fs.lstatSync(current);
        if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile()))fail('Git 中繼資料含連結或特殊檔案');
        if(canonical(fs.realpathSync(current))!==canonical(current))fail('Git 中繼資料的實際位置不符');
        if(st.isDirectory()) {
          const directory=fs.opendirSync(current);
          try{let entry;while((entry=directory.readSync())){if(treeSeen.size+pending.length>=MAX_TREE)fail('Git 中繼資料項目超過上限');pending.push(path.join(current,entry.name));}}
          finally{directory.closeSync();}
        }
      }
    };
    let parent=dir;
    for(let depth=0;;depth++) {
      if(depth>256)fail('Git 祖先搜尋超過上限');
      const candidate=path.join(parent,'.git'),st=statLocal(candidate);
      if(st) {
        source=parent;
        if(st.isDirectory())gitdir=checked(candidate);
        else if(st.isFile()) {
          const text=textLocal(candidate,{missing:false,max:8192}),match=text.trim().match(/^gitdir: ([^\r\n]+)$/);
          if(!match)fail('.gitfile 格式無效');
          gitdir=resolveReference(match[1],parent,home,prefix);
        } else fail('.git 控制位置無效');
        if(!statLocal(gitdir,{missing:false}).isDirectory())fail('Git 目錄無效');
        break;
      }
      const objects=statLocal(path.join(parent,'objects')),refs=statLocal(path.join(parent,'refs'));
      if(objects?.isDirectory()&&refs?.isDirectory()&&statLocal(path.join(parent,'HEAD'))) {source=parent;gitdir=parent;break;}
      const next=path.dirname(parent);if(next===parent)break;parent=next;
    }
    if(gitdir) {
      const reference=textLocal(path.join(gitdir,'commondir'),{max:8192});
      common=reference===null?gitdir:resolveReference(reference.trim(),gitdir,home,prefix);
      if(!statLocal(common,{missing:false}).isDirectory())fail('Git 共用目錄無效');
      // Objects and references are local files too. Never follow a reparse point
      // while Git is resolving HEAD, a loose object or a worktree registration.
      for(const root of new Set([gitdir,common]))verifyTree(root);
      for(const root of new Set([gitdir,common])) {
        const head=textLocal(path.join(root,'HEAD'),{missing:false,max:8192});
        if(!/^(?:[a-f0-9]{40,64}|ref: refs\/(?!.*(?:\.\.|[\\\x00-\x1f]))[^\r\n]+)$/i.test(head.trim()))fail('Git HEAD 參照無效');
        attributes.add(path.join(root,'info','attributes'));ignores.add(path.join(root,'info','exclude'));
        for(const control of ['info/sparse-checkout','shallow','packed-refs'])statLocal(path.join(root,control));
      }
      for(const name of ['objects','refs'])if(!statLocal(path.join(common,name),{missing:false}).isDirectory())fail('Git 共用 objects／refs 目錄無效');
      const worktrees=path.join(common,'worktrees'),worktreeStat=statLocal(worktrees);
      if(worktreeStat) {
        if(!worktreeStat.isDirectory())fail('worktrees 中繼資料無效');
        const names=fs.readdirSync(worktrees);if(names.length>1000)fail('worktree 登錄超過上限');
        for(const name of names) {
          const registration=path.join(worktrees,name),st=statLocal(registration,{missing:false});if(!st.isDirectory())fail('worktree 登錄型別無效');
          for(const file of ['gitdir','commondir']) {
            const text=textLocal(path.join(registration,file),{max:8192});
            if(text!==null)resolveReference(text.trim(),registration,home,prefix);
          }
        }
      }
      const seenObjects=new Set(),activeObjects=new Set();
      const visitObjects=objectRoot=> {
        const identity=canonical(objectRoot);if(activeObjects.has(identity))fail('object alternates 有循環');if(seenObjects.has(identity))return;seenObjects.add(identity);if(seenObjects.size>64)fail('object alternates 超過上限');
        const st=statLocal(objectRoot);if(!st)return;if(!st.isDirectory())fail('objects 控制位置無效');verifyTree(objectRoot);activeObjects.add(identity);
        const alternate=textLocal(path.join(objectRoot,'info','alternates'));
        if(alternate!==null)for(const line of alternate.split(/\r?\n/).filter(Boolean))visitObjects(resolveReference(line,objectRoot,home,prefix));
        const http=textLocal(path.join(objectRoot,'info','http-alternates'));if(http&&http.trim())fail('HTTP object alternates 需要人工可信 Git 流程');
        activeObjects.delete(identity);
      };visitObjects(path.join(common,'objects'));
    }
    const readConfig=(file,repo=false)=>{
      file=checked(file,{missing:true});const identity=canonical(file);if(active.has(identity))fail('Git include 有循環');if(visited.has(identity))return;
      const value=bytesLocal(file);if(value===null)return;
      if(++count>MAX_FILES||(total+=value.length)>MAX_TOTAL)fail('Git 設定參照超過數量或大小上限');
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{fail('Git 設定不是有效 UTF-8');}
      if(repo&&/^\s*\[\s*include(?:if)?(?=[\s\]".])/im.test(text))fail('repo-local include/includeIf 需要人工可信 Git 流程');
      const digest=createHash('sha256').update(value).digest('hex');let rows=cache.get(digest);
      if(!rows){rows=(options.parse||((bytes)=>parseConfig(gitExe,bytes)))(value,file);if(!Array.isArray(rows)||rows.some(row=>!Array.isArray(row)||row.length!==2||row.some(x=>typeof x!=='string')))fail('Git 設定解析結果無效');if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(digest,rows);}
      active.add(identity);configs.push(file);
      try {
        for(const [key,value]of rows) {
          const lower=key.toLowerCase();
          if(lower==='include.path'||/^includeif\..*\.path$/.test(lower)) {
            if(repo)fail('repo-local include/includeIf 需要人工可信 Git 流程');
            readConfig(resolveReference(value,path.dirname(file),home,prefix),false);
          }
          if(lower==='extensions.partialclone'||/^remote\..*\.promisor$/.test(lower)&&!/^(?:false|no|off|0)$/i.test(value))fail('partial clone／promisor 需要人工可信 Git 流程，不進行 lazy fetch');
          if(['core.attributesfile','core.excludesfile','core.hookspath','core.worktree','init.templatedir'].includes(lower)) {
            if(!value)fail('Git 路徑設定為空，無法確認本機位置');
            const target=resolveReference(value,source||dir,home,prefix);statLocal(target);
            if(lower==='core.attributesfile')attributes.add(target);
            if(lower==='core.excludesfile')ignores.add(target);
          }
        }
      } finally {active.delete(identity);visited.add(identity);}
    };
    // Inspect repo-local includes before any parser Git invocation, so they
    // cannot bootstrap access to an ambient or external configuration.
    if(gitdir)for(const root of new Set([common,gitdir]))for(const name of ['config','config.worktree']) {
      const file=path.join(root,name),text=textLocal(file);
      if(text!==null&&/^\s*\[\s*include(?:if)?(?=[\s\]".])/im.test(text))fail('repo-local include/includeIf 需要人工可信 Git 流程');
    }
    for(const file of [...system,...roots])readConfig(file,false);
    if(gitdir)for(const root of new Set([common,gitdir]))for(const name of ['config','config.worktree'])readConfig(path.join(root,name),true);
    for(const file of [...attributes,...ignores]){const st=statLocal(file);if(st&&(!st.isFile()||st.size>MAX_BYTES))fail('Git attributes／exclude 控制檔型別或大小無效');}
    return Object.freeze({dir,source:source||null,gitdir:gitdir||null,common:common||null,gitExe,configs:Object.freeze(configs.slice()),attributeFiles:Object.freeze([...attributes].filter(file=>Boolean(statLocal(file))))});
    } finally {pathFrame=previousFrame;}
  };
}
module.exports={assertLocalMetadata:createGuard(),createGuard,trustedGit};
