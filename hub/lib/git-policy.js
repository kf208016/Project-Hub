'use strict';
// Hub commands never delegate unreviewed repository programs to the host. This
// is per invocation: normal user Git configuration remains untouched.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { localPath } = require('./safe-path');
const { assertLocalMetadata } = require('./git-metadata');
const hash = x => createHash('sha256').update(x).digest('hex');
const HOOKS = new Set(('applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit post-index-change pre-rebase post-checkout post-merge pre-push pre-receive update post-receive post-update push-to-checkout pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman reference-transaction proc-receive').split(' '));
const MUTATIONS = new Set(['add','commit','merge','checkout','switch','worktree','branch','reset','read-tree','update-ref','apply','clean','rm','init','restore']);
let disabledHooks;
function environment() {
  const env = { ...process.env };
  const autocrlf = [];
  for (let n = 0; n < Math.min(Number(env.GIT_CONFIG_COUNT)||0, 100); n++) {
    if (env['GIT_CONFIG_KEY_'+n] === 'core.autocrlf' && /^(true|false|input)$/.test(env['GIT_CONFIG_VALUE_'+n]||'')) autocrlf.push(env['GIT_CONFIG_VALUE_'+n]);
  }
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k) && !/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(k)) delete env[k];
  if (autocrlf.length) Object.assign(env, { GIT_CONFIG_COUNT:'1', GIT_CONFIG_KEY_0:'core.autocrlf', GIT_CONFIG_VALUE_0:autocrlf.at(-1) });
  return Object.assign(env, { GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0', GIT_NO_REPLACE_OBJECTS:'1', GIT_NO_LAZY_FETCH:'1' });
}
function emptyHooks() {
  if (!disabledHooks) {
    disabledHooks = path.join(fs.realpathSync(os.tmpdir()), 'hub-git-no-hooks-'+randomUUID());
    fs.mkdirSync(disabledHooks);
    process.once('exit',()=>{try{if(fs.existsSync(disabledHooks)&&!fs.readdirSync(disabledHooks).length)fs.rmdirSync(disabledHooks);}catch{/* A nonempty or replaced directory is retained. */}});
  }
  localPath(disabledHooks);
  if (fs.readdirSync(disabledHooks).length) throw Error('Git 的暫時 hook 隔離目錄已改變');
  return disabledHooks;
}
function raw(dir, args, { encoding='utf8', identity=false, skipHooks=false, input }={}) {
  if(process.platform!=='win32')dir=fs.realpathSync(dir);
  localPath(dir);
  const metadata=assertLocalMetadata(dir);
  const env=environment();
  if(identity && ['commit','merge','commit-tree'].includes(args[0]) && !String(config(dir,'user.email')||'').trim()) Object.assign(env,{GIT_AUTHOR_NAME:'Project Hub',GIT_AUTHOR_EMAIL:'hub@localhost',GIT_COMMITTER_NAME:'Project Hub',GIT_COMMITTER_EMAIL:'hub@localhost'});
  const fixed=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','submodule.recurse=false','-c','diff.external='];
  if(skipHooks)fixed.push('-c','core.hooksPath='+emptyHooks());
  const actual=args[0]==='diff'?['diff','--no-ext-diff','--no-textconv',...args.slice(1)]:args;
  return execFileSync(metadata.gitExe,[...fixed,'-C',dir,...actual],{env,encoding,input,maxBuffer:256*1024*1024,timeout:30000,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
}
function config(dir,key) { try {return raw(dir,['config','--get',key]).trim();}catch(e){if(e.status===1)return '';throw e;} }
const fresh=new WeakMap(),key=d=>process.platform==='win32'?path.resolve(d).toLowerCase():path.resolve(d);
function validateIndex(data) {
  const entries=data.toString('utf8').split('\0');if(entries.at(-1)!=='')throw Error('Git index 記錄不完整');entries.pop();
  if(entries.length>20000||data.length>8*1024*1024)throw Error('Git index 超過審查上限');
  for(const entry of entries){
    // -v emits lower-case tags for assume-unchanged; S/s denotes
    // skip-worktree. Both can hide real working bytes from status/add.
    if(!/^[HSMRCKU?hsmrcku] [0-7]{6} [a-f0-9]{40,64} [0-3]\t.+$/s.test(entry))throw Error('Git index 記錄格式無效');
    if(/[a-z]/.test(entry[0])||entry[0]==='S')throw Error('Git index 含 assume-unchanged／skip-worktree；可能隱藏實際修改，需先以人工可信 Git 流程處理：'+JSON.stringify(entry.slice(entry.indexOf('\t')+1)).slice(0,300));
  }
}
function indexSnapshot(dir) {
  const data=raw(dir,['ls-files','--stage','-v','-z'],{encoding:null});validateIndex(data);fresh.set(data,key(dir));queueMicrotask(()=>fresh.delete(data));return data;
}
function assertIndexVisible(dir,index) {
  // hash-object may apply attributes. Admit helpers before invoking it; never
  // pass -w, clear flags, refresh the index, or alter the user's Git settings.
  assertExecution(dir,{mutating:false,index});index=index||indexSnapshot(dir);
  const records=index.toString('utf8').split('\0').filter(Boolean).map(x=>{const m=x.match(/^. ([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/s);if(!m)throw Error('Git index 記錄格式無效');return {mode:m[1],oid:m[2],stage:m[3],name:m[4]};}).filter(x=>x.stage==='0');
  const files=[],changed=[],localPath=require('./safe-path').localPathPass();let bytes=0;
  for(const record of records){
    const file=path.resolve(dir,record.name),rel=path.relative(dir,file);if(!rel||path.isAbsolute(rel)||rel.startsWith('..'+path.sep)||rel==='..')throw Error('Git index path 超出工作區');localPath(file,{allowMissing:true});
    if(!fs.existsSync(file)){changed.push(record.name);continue;}const st=fs.lstatSync(file);if(!st.isFile()||!['100644','100755'].includes(record.mode))throw Error('Git tracked 路徑不是允許的一般檔案');if((bytes+=st.size)>256*1024*1024)throw Error('Git tracked bytes 超過確認上限');files.push(record);
  }
  if(files.length){
    const input=files.map(x=>JSON.stringify(x.name)).join('\n')+'\n';if(Buffer.byteLength(input)>8*1024*1024)throw Error('Git tracked path 列表超過確認上限');
    let output;try{output=raw(dir,['hash-object','--stdin-paths'],{input,skipHooks:true});}catch{throw Error('無法重新雜湊 Git tracked bytes，未繼續保存或清理');}
    const ids=output.trim().split(/\r?\n/);if(ids.length!==files.length||ids.some(x=>!/^[a-f0-9]{40,64}$/.test(x)))throw Error('Git tracked bytes 雜湊回應無效');for(let n=0;n<files.length;n++)if(ids[n]!==files[n].oid)changed.push(files[n].name);
  }
  if(changed.length){const visible=new Set(raw(dir,['diff-files','--no-ext-diff','--no-textconv','--name-only','-z']).split('\0').filter(Boolean)),hidden=changed.filter(x=>!visible.has(x));if(hidden.length)throw Error('Git index cache 隱藏實際 tracked 修改；請先人工重新保存並重新預覽：'+hidden.slice(0,10).map(x=>JSON.stringify(x)).join(' / '));}
}
function execution(dir,{index}={}) {
  localPath(dir);
  let rows=[];
  try { rows=raw(dir,['config','--null','--get-regexp','^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|merge\\.default|merge\\.verifysignatures|commit\\.gpgsign|core\\.hookspath|core\\.fsmonitor|core\\.attributesfile|diff\\..*\\.textconv)$']).split('\0').filter(Boolean).map(x=>{const n=x.indexOf('\n'),key=x.slice(0,n),first=key.indexOf('.'),last=key.lastIndexOf('.');return [key.slice(0,first).toLowerCase()+key.slice(first,last)+key.slice(last).toLowerCase(),x.slice(n+1)];}); }
  catch(e){if(e.status!==1)throw e;}
  // Scalar Git settings use the last value, across system/global/local/include
  // files. Subsection names remain case sensitive.
  rows=[...new Map(rows).entries()];
  const blockers=[];
  // Reuse bytes only within the same synchronous snapshot that just read them.
  if(process.platform==='win32')try{const own=Buffer.isBuffer(index)&&fresh.get(index)===key(dir)?index:undefined;if(own)validateIndex(own);else indexSnapshot(dir);}catch(e){blockers.push(e.message);}
  const activeFilters=new Set(),activeDrivers=new Set();let attributesHash='';
  const helpers=rows.filter(([k,v])=>v&&/^(filter\..*\.(clean|smudge|process)|merge\..*\.driver)$/.test(k));
  if(helpers.length)try{
    const files=new Set(raw(dir,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean));
    let hasHead=false;try{raw(dir,['rev-parse','--verify','HEAD']);hasHead=true;}catch(e){if(e.status!==128&&e.status!==1)throw e;}
    if(hasHead)for(const f of raw(dir,['ls-tree','-rz','--name-only','HEAD']).split('\0').filter(Boolean))files.add(f);
    if(files.size>20000)throw Error('Git 屬性檔案列表超過審查上限');
    const input=[...files].sort().join('\0')+'\0';if(input.length>8*1024*1024)throw Error('Git 屬性列表過大');
    const answers=[];
    if(files.size)for(const flags of [[],['--cached'],...(hasHead?[['--source=HEAD']]:[])]) {
      const out=raw(dir,['check-attr','-z',...flags,'--stdin','filter','merge'],{input});answers.push(out);
      const parts=out.split('\0');for(let n=0;n+2<parts.length;n+=3){const attr=parts[n+1],value=parts[n+2];if(attr==='filter')activeFilters.add(value);if(attr==='merge')activeDrivers.add(value);if(attr==='merge'&&value==='unspecified'){const def=rows.find(x=>x[0]==='merge.default')?.[1];if(def)activeDrivers.add(def);}}
    }
    attributesHash=hash(JSON.stringify(answers));
  }catch(e){blockers.push('無法確認 Git 外部 helper 的有效屬性；未放行：'+String(e.stderr||e.message).slice(0,1000));}
  for(const [k,v]of rows){
    const filter=k.match(/^filter\.(.*)\.(clean|smudge|process)$/),driver=k.match(/^merge\.(.*)\.driver$/);
    if(v&&((filter&&activeFilters.has(filter[1]))||(driver&&activeDrivers.has(driver[1]))))blockers.push('有效屬性使用 '+k+' 外部程式；請先用人工可信 Git 流程處理');
    if(/^(commit\.gpgsign|merge\.verifysignatures)$/.test(k)&&!/^(false|no|off|0)$/i.test(v))blockers.push('設定 '+k+' 要求可信簽章；Hub 不會略過此要求，請用人工可信 Git 流程處理');
  }
  let common;
  try{common=raw(dir,['rev-parse','--path-format=absolute','--git-common-dir']).trim();}catch{common=path.join(dir,'.git');}
  const configured=rows.find(x=>x[0]==='core.hookspath')?.[1]||rows.find(x=>x[0]==='core.hooksPath')?.[1];
  const hooksDir=configured?path.resolve(dir,configured.startsWith('~/')?path.join(os.homedir(),configured.slice(2)):configured):path.join(common,'hooks');
  const hooks=[];
  try {
    localPath(hooksDir,{allowMissing:true});
    for(const name of fs.existsSync(hooksDir)?fs.readdirSync(hooksDir).sort():[]) {
      if(!HOOKS.has(name))continue;
      const file=path.join(hooksDir,name);localPath(file);
      const st=fs.lstatSync(file);
      if(!st.isFile() || (process.platform!=='win32' && !(st.mode&0o111)))continue;
      if(st.size>4*1024*1024)throw Error('Git hook 超過審查大小限制');
      hooks.push({path:file,sha256:hash(fs.readFileSync(file))});
    }
  }catch(e){blockers.push('無法安全確認 Git hooks：'+e.message);}
  return {hooks,requiresSkipHooksConfirmation:hooks.length>0,skippedHooks:false,blockers,externalHelpers:helpers.map(([key])=>({key,kind:key.startsWith('filter.')?'filter':'merge',name:key.replace(/^[^.]+\./,'').replace(/\.(clean|smudge|process|driver)$/,'')})),configHash:hash(JSON.stringify({rows,attributesHash})),configRowsHash:hash(JSON.stringify(rows)),attributesHash,fsmonitorSuppressed:true,externalDiffAndTextconvSuppressed:true};
}
function assertMergeExecution(source,target) {
  const reviews=[execution(source),execution(target)],helpers=reviews.flatMap(x=>x.externalHelpers),definitions=new Map();
  if(!helpers.length)return;
  const parse=text=>{for(const rawLine of text.split(/\r?\n/)){
    const line=rawLine.trimStart();if(line.startsWith('#'))continue;
    if(line.startsWith('"')&&/^"(?:[^"\\]|\\.)*\\/.test(line))throw Error('Git 屬性含跳脫引用 pattern，無法可靠審查宏，請用人工可信 Git 流程處理');
    const m=line.match(/^(?:"\[attr\]([^"\s]+)"|\[attr\]([^\s]+))\s+(.*)$/);
    if(m){const name=m[1]||m[2],old=definitions.get(name)||[];definitions.set(name,[...old,...m[3].split(/\s+/)]);}
  }};
  const parseFile=file=>{localPath(file,{allowMissing:true});if(fs.existsSync(file)){const st=fs.statSync(file);if(!st.isFile()||st.size>4*1024*1024)throw Error('Git 屬性檔大小／型別無效');parse(fs.readFileSync(file,'utf8'));}};
  for(const dir of [source,target]) {
    for(const file of assertLocalMetadata(dir).attributeFiles)parseFile(file);
    const files=raw(dir,['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(x=>path.posix.basename(x)==='.gitattributes');
    if(files.length>1000)throw Error('Git 屬性宏審查超過上限');
    for(const f of files)parseFile(path.join(dir,f));
    const heads=raw(dir,['ls-tree','-rz','--name-only','HEAD']).split('\0').filter(x=>path.posix.basename(x)==='.gitattributes');
    if(heads.length>1000)throw Error('Git HEAD 屬性宏審查超過上限');
    for(const f of heads){const size=Number(raw(dir,['cat-file','-s','HEAD:'+f]).trim());if(!Number.isSafeInteger(size)||size<0||size>4*1024*1024)throw Error('Git HEAD 屬性檔過大或格式無效');parse(raw(dir,['cat-file','blob','HEAD:'+f]));}
    const common=raw(dir,['rev-parse','--path-format=absolute','--git-common-dir']).trim(),info=path.join(common,'info','attributes');
    parseFile(info);
    const external=config(dir,'core.attributesfile');if(external)parseFile(path.resolve(dir,external.startsWith('~/')?path.join(os.homedir(),external.slice(2)):external));
  }
  const visit=(name,seen=new Set())=>{
    if(seen.has(name))return false;if(seen.size>1000)throw Error('Git 屬性宏展開超過上限');seen.add(name);
    return (definitions.get(name)||[]).some(spec=>{
      const direct=spec.match(/^([-!]?)(filter|merge)(?:=(.*))?$/);
      if(direct){const value=direct[3]??(direct[1]==='-'?'unset':direct[1]==='!'?'unspecified':'set');if(helpers.some(x=>x.kind===direct[2]&&x.name===value))return true;}
      return definitions.has(spec)&&visit(spec,new Set(seen));
    });
  };
  for(const name of definitions.keys())if(visit(name))throw Error('Git 屬性宏 '+name+' 包含外部 helper；合併後的屬性組合尚未驗證，請用人工可信 Git 流程處理');
}
function assertExecution(dir,{skipHooks=false,mutating=true,index}={}) {
  const review=execution(dir,{index});
  if(review.blockers.length)throw Error(review.blockers.join(' / '));
  if(mutating&&review.hooks.length&&!skipHooks)throw Error('Git 有有效 hooks；請先由人工可信 Git 流程操作，或在合併預覽明確核准本次 skipHooks');
  return review;
}
function initializationExecution(dir) {
  // No project mutation is permitted for this preflight. Without a Git index,
  // active attribute resolution is ambiguous; reject helper-bearing attributes
  // conservatively and let the normal review run again immediately after init.
  const metadata=assertLocalMetadata(dir),blockers=[],hooks=[];let rows=[];
  try{rows=raw(dir,['config','--null','--get-regexp','^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|merge\\.default|merge\\.verifysignatures|commit\\.gpgsign|core\\.hookspath|core\\.attributesfile|init\\.templatedir)$']).split('\0').filter(Boolean).map(x=>{const n=x.indexOf('\n');return [x.slice(0,n),x.slice(n+1)];});}catch(e){if(e.status!==1)throw e;}
  rows=[...new Map(rows).entries()];
  const attributes=[];let count=0;
  const walk=current=>{localPath(current);for(const n of fs.readdirSync(current).sort()){if(n==='.git')continue;if(++count>20000)throw Error('首次保存檔案數超過審查上限');const f=path.join(current,n);localPath(f);const st=fs.lstatSync(f);if(st.isDirectory())walk(f);else if(n==='.gitattributes')attributes.push(f);}};walk(dir);
  const attrValues=[];for(const file of new Set([...attributes,...metadata.attributeFiles])){localPath(file);const st=fs.statSync(file);if(!st.isFile()||st.size>4*1024*1024)throw Error('首次保存屬性檔無效');const text=fs.readFileSync(file,'utf8');attrValues.push([file,hash(text)]);if(rows.some(([k,v])=>v&&/^(filter\..*\.(clean|smudge|process)|merge\..*\.driver)$/.test(k))&&/(?:^|\s)[-!]?(?:filter|merge)(?:=|\s|$)/m.test(text))blockers.push('首次保存含外部 helper 屬性；需先由人工可信 Git 流程確認');}
  for(const [key,value]of rows)if(/^(commit\.gpgsign|merge\.verifysignatures)$/i.test(key)&&!/^(false|no|off|0)$/i.test(value))blockers.push('設定 '+key+' 要求可信簽章；Hub 不會略過此要求');
  const configured=rows.filter(([k])=>k.toLowerCase()==='core.hookspath').at(-1)?.[1];
  if(configured){const folder=path.resolve(dir,configured.startsWith('~/')?path.join(os.homedir(),configured.slice(2)):configured);localPath(folder,{allowMissing:true});for(const name of fs.existsSync(folder)?fs.readdirSync(folder).sort():[]){if(!HOOKS.has(name))continue;const file=path.join(folder,name);localPath(file);const st=fs.statSync(file);if(!st.isFile()||(process.platform!=='win32'&&!(st.mode&0o111)))continue;if(st.size>4*1024*1024)throw Error('首次保存 hook 過大');hooks.push({path:file,sha256:hash(fs.readFileSync(file))});}}
  return {hooks,requiresSkipHooksConfirmation:hooks.length>0,skippedHooks:false,blockers,configHash:hash(JSON.stringify({rows,attrValues})),fsmonitorSuppressed:true,externalDiffAndTextconvSuppressed:true,emptyTemplate:true};
}
function initialize(dir,{skipHooks=false}={}){
  const review=initializationExecution(dir);if(review.blockers.length)throw Error(review.blockers.join(' / '));if(review.hooks.length&&!skipHooks)throw Error('Git 有有效 hooks，需另行明確確認本次不執行');
  // Do not copy or activate a configured init template's executable programs.
  return raw(dir,['init','-q','--template='+emptyHooks()],{skipHooks:true});
}
function run(dir,args,{skipHooks=false,identity=true,encoding='utf8',check=true}={}) {
  const mutating=MUTATIONS.has(args[0]) && !(args[0]==='worktree'&&args[1]==='list') && !(args[0]==='branch'&&args.includes('--list'));
  // Every mutation, status, diff and merge-tree re-reads; never pass index bytes here.
  if(check && (mutating||['status','diff','merge-tree'].includes(args[0])))assertExecution(dir,{skipHooks,mutating});
  return raw(dir,args,{skipHooks:true,identity,encoding});
}
module.exports={run,raw,execution,assertExecution,assertMergeExecution,environment,initializationExecution,initialize,indexSnapshot,assertIndexVisible};
