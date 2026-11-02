'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFile}=require('node:child_process');
const safe=require('./safe-path');

// icacls /remove:g exits 1332 for any SID without an account, and the sandbox's capability SIDs have none.
const REMOVE_SCRIPT="$ErrorActionPreference='Stop';$t=$env:HUB_GROK_ACL_TARGET;$s=$env:HUB_GROK_ACL_SIDS -split ',';$d=$env:HUB_GROK_ACL_DIR -eq '1';$a=if($d){[IO.Directory]::GetAccessControl($t,'Access')}else{[IO.File]::GetAccessControl($t,'Access')};foreach($r in @($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){if($r.AccessControlType -eq 'Allow' -and $s -contains $r.IdentityReference.Value){[void]$a.RemoveAccessRuleSpecific($r)}};if($d){[IO.Directory]::SetAccessControl($t,$a)}else{[IO.File]::SetAccessControl($t,$a)}";

// No shell, inherited streams, or process output in diagnostics.
function runIcacls(file,args,{timeoutMs,env}){
  return new Promise(resolve=>{
    execFile(file,args,{shell:false,windowsHide:true,timeout:timeoutMs,encoding:'buffer',maxBuffer:1024*1024,...(env===undefined?{}:{env})},error=>{
      resolve({status:error?(Number.isInteger(error.code)?error.code:-1):0,timedOut:Boolean(error?.killed)});
    });
  });
}
const aliases=Object.freeze({SY:'S-1-5-18',BA:'S-1-5-32-544',BU:'S-1-5-32-545',BG:'S-1-5-32-546',
  WD:'S-1-1-0',AU:'S-1-5-11',IU:'S-1-5-4',NU:'S-1-5-2',LS:'S-1-5-19',NS:'S-1-5-20',
  CO:'S-1-3-0',OW:'S-1-3-4',AC:'S-1-15-2-1',PU:'S-1-5-32-547',RD:'S-1-5-32-555'});
const principal=s=>Object.hasOwn(aliases,s)?aliases[s]:s;
const userSidPattern=/^S-1-5-21(-\d+){4}$/;
function parseWhoamiUserSid(output){
  if(typeof output!=='string')throw Error('ACL_USER_UNAVAILABLE');
  // One CSV record only; quoted names may contain commas or escaped quotes.
  const line=output.replace(/\r?\n$/,'');
  if(!/^"(?:[^"\r\n\0]|"")*"(?:,"(?:[^"\r\n\0]|"")*")+$/.test(line))throw Error('ACL_USER_UNAVAILABLE');
  const sid=line.match(/,"([^"\r\n]*)"$/)?.[1];
  if(!userSidPattern.test(sid||''))throw Error('ACL_USER_UNAVAILABLE');
  return sid;
}
function readCurrentUserSid(systemRoot){
  return new Promise((resolve,reject)=>{
    execFile(path.win32.join(systemRoot,'System32','whoami.exe'),['/user','/fo','csv','/nh'],
      {shell:false,windowsHide:true,timeout:10000,maxBuffer:64*1024,encoding:'utf8'},(error,stdout)=>{
        if(error){const failure=Error('ACL_USER_UNAVAILABLE');if(Number.isInteger(error.code))failure.status=error.code;reject(failure);return;}
        try{resolve(parseWhoamiUserSid(stdout));}catch{reject(Error('ACL_USER_UNAVAILABLE'));}
      });
  });
}
const sidPattern=/^(?:S-1-(?:\d+-)*\d+|[A-Z]{2})$/;
function foreignAces(sddl,currentUser){
  if(typeof sddl!=='string'||/[\r\n\0]/.test(sddl))throw Error('ACL_INVALID');
  // Sections are recognized only outside ACEs; never interpret SACL ACEs as DACLs.
  const sections={};let offset=0;
  while(offset<sddl.length){
    const key=sddl[offset];
    if(!'OGDS'.includes(key)||sddl[offset+1]!==':'||Object.hasOwn(sections,key))throw Error('ACL_INVALID');
    const start=offset+=2;let depth=0;
    while(offset<sddl.length){
      const ch=sddl[offset];
      if(!depth&&'OGDS'.includes(ch)&&sddl[offset+1]===':')break;
      if(ch==='(')depth++;
      if(ch===')'&&--depth<0)throw Error('ACL_INVALID');
      offset++;
    }
    if(depth)throw Error('ACL_INVALID');
    sections[key]=sddl.slice(start,offset);
  }
  // Real icacls /save emits D: only; an optional O: grants an extra exemption.
  if((sections.O!==undefined&&!sidPattern.test(sections.O))||!Object.hasOwn(sections,'D'))throw Error('ACL_INVALID');
  if(sections.G!==undefined&&!sidPattern.test(sections.G))throw Error('ACL_INVALID');
  const dacl=sections.D,first=dacl.indexOf('('),flags=first<0?dacl:dacl.slice(0,first);
  if(!/^(?:P|AI|AR)*$/.test(flags))throw Error('ACL_INVALID');
  const body=first<0?'':dacl.slice(first),aces=body.match(/\([^()]*\)/g)||[];
  if(aces.join('')!==body)throw Error('ACL_INVALID');
  const foreign=[],kept=new Set([currentUser,principal(sections.O),'S-1-5-18','S-1-5-32-544','S-1-3-0','S-1-3-4']);
  for(const ace of aces){
    const fields=ace.slice(1,-1).split(';');
    if(fields.length!==6)throw Error('ACL_INVALID');
    const [type,flags,rights,object,inheritObject,sid]=fields;
    if(!/^(?:A|D|OA|OD|AU|AL|OU|OL|ML|RA|SP|TL|FL)$/.test(type)||
       !/^(?:OI|CI|NP|IO|ID|SA|FA|TP|CR)*$/.test(flags)||
       !/^(?:0x[0-9a-fA-F]+|(?:GA|GR|GW|GX|RC|SD|WD|WO|RP|WP|CC|DC|LC|SW|LO|DT|CR|FA|FR|FW|FX|KA|KR|KW|KX|NR|NW|NX)+)$/.test(rights)||
       !sidPattern.test(sid))throw Error('ACL_INVALID');
    for(const guid of [object,inheritObject])if(guid&&!/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(guid))throw Error('ACL_INVALID');
    if(!['OA','OD','OU','OL'].includes(type)&&(object||inheritObject))throw Error('ACL_INVALID');
    const normalized=principal(sid);
    if(type==='A'&&!flags.includes('ID')){
      if(/^[A-Z]{2}$/.test(normalized))throw Error('ACL_ALIAS_UNAVAILABLE');
      if(!kept.has(normalized))foreign.push(normalized);
    }
  }
  return foreign;
}

function createGrokCredentialAcl({home,systemRoot,run,record,platform=process.platform,tmpdir=os.tmpdir(),currentUserSid=()=>readCurrentUserSid(systemRoot)}){
  const targets=[['dir',path.join(home,'.grok'),120000],['auth',path.join(home,'.grok','auth.json'),30000],['lock',path.join(home,'.grok','auth.json.lock'),30000]];
  const executable=path.win32.join(systemRoot,'System32','icacls.exe');
  const powershell=path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const invoke=async(file,args,options)=>{
    const result=await run(file,args,options);
    if(!result||result.status!==0||result.timedOut){
      const error=Error('ACL_PROCESS_FAILED');
      if(Number.isInteger(result?.status))error.status=result.status;
      throw error;
    }
  };
  async function inspect(target,timeoutMs,currentUser,setStage){
    setStage('save');
    const folder=fs.mkdtempSync(path.join(tmpdir,'grok-acl-'));
    try{
      const saved=path.join(folder,'acl.txt');
      await invoke(executable,[target,'/save',saved,'/Q'],{timeoutMs});
      setStage('parse');
      const bytes=fs.readFileSync(saved);
      if(bytes.length%2)throw Error('ACL_INVALID');
      const lines=bytes.toString('utf16le').replace(/^\uFEFF/,'').split(/\r?\n/);
      if(!lines[0]||!lines[1]||lines.slice(2).some(line=>line!==''))throw Error('ACL_INVALID');
      return foreignAces(lines[1],currentUser);
    }finally{fs.rmSync(folder,{recursive:true,force:true});}
  }
  async function revoke(reason){
    if(!['startup','turn-end'].includes(reason))throw Error('ACL_REASON_INVALID');
    const result={reason,results:[]};
    if(platform!=='win32')return result;
    let userPromise;
    const user=()=>userPromise??=Promise.resolve().then(currentUserSid).then(sid=>{
      if(typeof sid!=='string'||/[\r\n]/.test(sid)||!userSidPattern.test(sid))throw Error('ACL_USER_UNAVAILABLE');
      return sid;
    });
    for(const [name,target,timeoutMs]of targets){
      const row={target:name,outcome:'failed',removed:0};result.results.push(row);
      let stage='save';
      const setStage=value=>{stage=value;};
      try{
        let st;
        try{st=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT'){row.outcome='missing';continue;}throw error;}
        if(st.isSymbolicLink()||(st.fileAttributes&0x400)||(name==='dir'?!st.isDirectory():!st.isFile())){row.outcome='skipped-kind';continue;}
        try{safe.localPath(target);}catch{row.outcome='skipped-kind';continue;}
        stage='user';
        const currentUser=await user();
        const foreign=await inspect(target,timeoutMs,currentUser,setStage);
        if(!foreign.length){row.outcome='clean';continue;}
        stage='remove';
        await invoke(powershell,['-NoProfile','-NonInteractive','-Command',REMOVE_SCRIPT],{timeoutMs,env:{...process.env,HUB_GROK_ACL_TARGET:target,HUB_GROK_ACL_SIDS:[...new Set(foreign)].join(','),HUB_GROK_ACL_DIR:name==='dir'?'1':'0'}});
        if((await inspect(target,timeoutMs,currentUser,setStage)).length){row.stage='verify';continue;}
        row.outcome='revoked';row.removed=foreign.length;
      }catch(error){row.stage=stage;if(Number.isInteger(error?.status))row.status=error.status;/* Never log paths, SDDL or process output. */}
    }
    try{record('grok-credential-acl',result);}catch{}
    return result;
  }
  return {revoke};
}
module.exports={createGrokCredentialAcl,runIcacls,parseWhoamiUserSid,readCurrentUserSid,REMOVE_SCRIPT};
