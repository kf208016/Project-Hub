'use strict' ;
// Local owner-operated installation tool. This module is not loaded by server.js.
const fs = require ( 'node:fs' ) , path = require ( 'node:path' ) , os = require ( 'node:os' ) , crypto = require ( 'node:crypto' ) ;
const {
  execFileSync
} = require ( 'node:child_process' ) ;
const {
  localPath
} = require ( '../lib/safe-path' ) ;
const admission = require ( '../lib/web-chat-admission' ) ;
const HEX = /^[a-f0-9]{64}$/ , RELEASE = /^4\.68\.2-windows-codex-[a-f0-9]{12}$/ ;
const FFMPEG = {
  version : '9.0.2-essentials_build-www.gyan.dev' , sha256 : '3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec'
} ;
const digest = b => crypto . createHash ( 'sha256' ) . update ( b ) . digest ( 'hex' ) ;
const text = b => new TextDecoder ( 'utf-8' , {
  fatal : true
} ) . decode ( b ) ;
const json = value => JSON . stringify ( value , null , 2 ) + '\n' ;
const fail = ( code ) => {
  throw Object . assign ( Error ( 'Windows 安裝拒絕：' + code ) , {
    code
  } ) ;
} ;
function exact ( value , keys ) {
  if ( ! value || typeof value !== 'object' || Array . isArray ( value ) || Object . keys ( value ) . sort ( ) . join ( ',' ) !== keys . slice ( ) . sort ( ) . join ( ',' ) ) fail ( 'SCHEMA_REJECTED' ) ;
} function relative ( value ) {
  if ( typeof value !== 'string' || value . length > 32768 || ! value || value . includes ( '\\' ) || path . isAbsolute ( value ) || value . includes ( ':' ) || value . split ( '/' ) . some ( x => ! x || x === '.' || x === '..' ) ) fail ( 'PATH_REJECTED' ) ;
  return value ;
} function local ( value , missing = false ) {
  return localPath ( value , {
    allowMissing : missing
  } ) ;
} function read ( file , max = 8 * 1024 * 1024 ) {
  const checked = local ( file ) , st = fs . lstatSync ( checked ) ;
  if ( ! st . isFile ( ) || st . nlink !== 1 || st . size > max ) fail ( 'FILE_REJECTED' ) ;
  return fs . readFileSync ( checked ) ;
} function fileHash ( file ) {
  const checked = local ( file ) , st = fs . lstatSync ( checked ) ;
  if ( ! st . isFile ( ) || st . nlink !== 1 || st . size > 512 * 1024 * 1024 ) fail ( 'FILE_REJECTED' ) ;
  const fd = fs . openSync ( checked , 'r' ) , h = crypto . createHash ( 'sha256' ) , buffer = Buffer . alloc ( 1024 * 1024 ) ;
  try {
    let n ;
    while ( ( n = fs . readSync ( fd , buffer , 0 , buffer . length , null ) ) > 0 ) h . update ( buffer . subarray ( 0 , n ) ) ;
    return {
      sha256 : h . digest ( 'hex' ) , bytes : st . size
    } ;
  } finally {
    fs . closeSync ( fd ) ;
  }
} function secureEnv ( extra = {
} ) {
  const env = {
    ... process . env , ... extra
  } ;
  for ( const key of [ 'HUB_LOCAL_TOKEN' , 'HUB_MCP_TOKEN' , 'HUB_MCP_RUN_ID' , 'OPENAI_API_KEY' , 'ANTHROPIC_API_KEY' , 'ANTHROPIC_AUTH_TOKEN' , 'GOOGLE_API_KEY' , 'GEMINI_API_KEY' ] ) delete env [ key ] ;
  return env ;
} let helper , helperHash ;
function actionOptions(action,value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('OPTIONS_REJECTED');
  if(['preview','install'].includes(action)){exact(value,['packageRoot','manifestSha256']);return value;}
  if(action==='recover-current'){exact(value,['backup','expectedHash']);return value;}
  if(action==='start'){
    if(Object.keys(value).some(key=>!['noBrowser','recoveryOnly'].includes(key))||Object.values(value).some(item=>typeof item!=='boolean'))fail('OPTIONS_REJECTED');
    return value;
  }
  if(['stop','rollback','status'].includes(action)){exact(value,[]);return value;}
  fail('ACTION_REJECTED');
}
function native ( request ) {
  if ( process . platform !== 'win32' || process . arch !== 'x64' ) fail ( 'WINDOWS_X64_REQUIRED' ) ;
  if ( ! helper ) {
    const runtime = local ( path . join ( __dirname , '../.runtime' ) , true ) ;
    fs . mkdirSync ( runtime , {
      recursive : true
    } ) ;
    helper = local ( path . join ( runtime , 'install-files-' + crypto . randomUUID ( ) + '.exe' ) , true ) ;
    const compiler = local ( path . join ( process . env . SystemRoot || 'C:\\Windows' , 'Microsoft.NET/Framework64/v4.0.30319/csc.exe' ) ) ;
    execFileSync ( compiler , [ '/nologo' , '/target:exe' , '/platform:x64' , '/optimize+' , '/reference:System.Web.Extensions.dll' , '/out:' + helper , local ( path . join ( __dirname , 'install-files.cs' ) ) ] , {
      windowsHide : true , env : secureEnv ( ) , timeout : 30000 , maxBuffer : 128 * 1024
    } ) ;
    helperHash = fileHash ( helper ) . sha256 ;
  } if ( fileHash ( helper ) . sha256 !== helperHash ) fail ( 'INSTALL_HELPER_CHANGED' ) ;
  const input = JSON . stringify ( request ) ;
  if ( Buffer . byteLength ( input ) > 8 * 1024 * 1024 ) fail ( 'REQUEST_TOO_LARGE' ) ;
  let raw ;
  try {
    raw = execFileSync ( helper , [ ] , {
      input , windowsHide : true , env : secureEnv ( ) , timeout : 120000 , maxBuffer : 9 * 1024 * 1024
    } ) ;
  } catch ( error ) {
    if ( error . stdout ) {
      try {
        const result = JSON . parse ( text ( error . stdout ) ) ;
        if ( result . ok === false && /^[A-Z_]{1,80}$/ . test ( result . code ) ) fail ( result . code ) ;
      } catch ( parseError ) {
        if ( parseError . code ) throw parseError ;
      }
    } fail ( 'INSTALL_OPERATION_UNKNOWN' ) ;
  } const result = JSON . parse ( text ( raw ) ) ;
  if ( result ?. ok !== true ) fail ( result ?. code || 'INVALID_RESPONSE' ) ;
  return result ;
} function manifest ( value ) {
  exact ( value , [ 'version' , 'releaseId' , 'source' , 'platform' , 'dependencies' , 'files' ] ) ;
  if ( value . version !== 1 || ! RELEASE . test ( value . releaseId ) || value . platform !== 'win32-x64' ) fail ( 'PACKAGE_REJECTED' ) ;
  exact ( value . source , [ 'repository' , 'tag' , 'revision' ] ) ;
  if ( value . source . repository !== 'https://github.com/kieiken/project-hub' || value . source . tag !== 'v4.68.2' || ! /^[a-f0-9]{40}$/ . test ( value . source . revision ) || ! value . releaseId . endsWith ( value . source . revision . slice ( 0 , 12 ) ) ) fail ( 'SOURCE_REJECTED' ) ;
  exact ( value . dependencies , [ 'npm' , 'ffmpeg' ] ) ;
  exact ( value . dependencies . npm , [ 'lockfileSha256' , 'installation' ] ) ;
  if ( ! HEX . test ( value . dependencies . npm . lockfileSha256 ) || value . dependencies . npm . installation !== 'npm ci --ignore-scripts; reviewed node-pty 1.1.0 Windows prebuild' ) fail ( 'DEPENDENCY_REJECTED' ) ;
  exact ( value . dependencies . ffmpeg , [ 'version' , 'sha256' , 'license' , 'source' , 'publisher' , 'archiveSha256' ] ) ;
  if ( value . dependencies . ffmpeg . version !== FFMPEG . version || value . dependencies . ffmpeg . sha256 !== FFMPEG . sha256 || value . dependencies . ffmpeg . license !== 'GPLv3' || value . dependencies . ffmpeg . source !== 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b' || value . dependencies . ffmpeg . publisher !== 'https://www.gyan.dev/ffmpeg/builds/' || value . dependencies . ffmpeg . archiveSha256 !== '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba' ) fail ( 'DEPENDENCY_REJECTED' ) ;
  if ( ! Array . isArray ( value . files ) || ! value . files . length || value . files . length > 20000 ) fail ( 'FILES_REJECTED' ) ;
  const names = new Set ( ) ;
  let size = 0 ;
  for ( const file of value . files ) {
    exact ( file , [ 'path' , 'sha256' , 'bytes' ] ) ;
    relative ( file . path ) ;
    if ( ! HEX . test ( file . sha256 ) || ! Number . isSafeInteger ( file . bytes ) || file . bytes < 0 || file . bytes > 512 * 1024 * 1024 || ( size += file . bytes ) > 2 * 1024 * 1024 * 1024 || names . has ( file . path . toLowerCase ( ) ) || file . path . startsWith ( 'hub/.runtime/' ) || file . path . startsWith ( '.git/' ) ) fail ( 'FILES_REJECTED' ) ;
    names . add ( file . path . toLowerCase ( ) ) ;
  } for ( const required of [ 'hub/server.js' , 'hub/start-windows.ps1' , 'hub/windows/roles.yaml' , 'hub/windows/native-install.cjs' , 'hub/windows/install-files.cs' , 'hub/package-lock.json' , 'hub/node_modules/node-pty/prebuilds/win32-x64/conpty.node' , 'dependencies/ffmpeg-9.0.2/bin/ffmpeg.exe' , 'dependencies/ffmpeg-9.0.2/LICENSE' , 'dependencies/ffmpeg-9.0.2/README.txt' , 'dependencies/ffmpeg-9.0.2/source-metadata.json' ] ) if ( ! names . has ( required . toLowerCase ( ) ) ) fail ( 'PACKAGE_FILE_MISSING' ) ;
  return value ;
} function packageInfo ( packageRoot , expected ) {
  if ( ! HEX . test ( expected || '' ) ) fail ( 'PACKAGE_HASH_REQUIRED' ) ;
  const root = local ( packageRoot ) , result = native ( {
    mode : 'inspect' , root , path : 'package-manifest.json' , text : true
  } ) ;
  if ( result . sha256 !== expected ) fail ( 'PACKAGE_MANIFEST_CHANGED' ) ;
  const value = manifest ( JSON . parse ( result . text ) ) ;
  return {
    root , rootFingerprint : result . rootFingerprint , manifest : value , sha256 : expected , manifestBytes : Buffer . from ( result . text , 'utf8' )
  } ;
} function verifyFiles ( root , value , rootFingerprint ) {
  return native ( {
    mode : 'verify' , root , files : value . files , ... ( rootFingerprint ? {
      rootFingerprint
    } : {
    } )
  } ) ;
} function dataPath ( root , base ) {
  root = local ( root , true ) ;
  base = local ( base , true ) ;
  if ( path . basename ( base ) . toLowerCase ( ) !== 'projecthub' || root . toLowerCase ( ) === base . toLowerCase ( ) || root . toLowerCase ( ) . startsWith ( base . toLowerCase ( ) + path . sep ) || base . toLowerCase ( ) . startsWith ( root . toLowerCase ( ) + path . sep ) ) fail ( 'INSTALL_SCOPE_REJECTED' ) ;
  for ( let ancestor = root ; ; ancestor = path . dirname ( ancestor ) ) {
    if ( path . basename ( ancestor ) . toLowerCase ( ) === 'codex' || fs . existsSync ( path . join ( ancestor , '.git' ) ) ) fail ( 'DATA_ROOT_GIT_ANCESTOR' ) ;
    if ( path . dirname ( ancestor ) === ancestor ) break ;
  } return root ;
} function current ( value , base ) {
  exact ( value , [ 'version' , 'installBase' , 'dataRoot' , 'port' , 'release' , 'previous' ] ) ;
  if ( value . version !== 1 || value . installBase !== base || ! Number . isInteger ( value . port ) || value . port < 1024 || value . port > 65535 ) fail ( 'CURRENT_UNKNOWN' ) ;
  dataPath ( value . dataRoot , base ) ;
  for ( const slot of [ value . release , value . previous ] ) if ( slot !== null ) {
    exact ( slot , [ 'id' , 'manifestSha256' ] ) ;
    if ( ! RELEASE . test ( slot . id ) || ! HEX . test ( slot . manifestSha256 ) ) fail ( 'CURRENT_UNKNOWN' ) ;
  } if ( ! value . release ) fail ( 'CURRENT_UNKNOWN' ) ;
  return value ;
} class Installer {
  constructor ( {
    installBase , dataRoot , port = 4545 , environment = {
    }
  } ) {
    this . base = local ( installBase , true ) ;
    this . root = dataPath ( dataRoot , this . base ) ;
    if ( ! Number . isInteger ( port ) || port < 1024 || port > 65535 ) fail ( 'PORT_REJECTED' ) ;
    this . port = port ;
    this . environment = environment ;
  } snapshot ( ) {
    const file = path . join ( this . base , 'current.json' ) ;
    if ( ! fs . existsSync ( file ) ) return null ;
    const value = native ( {
      mode : 'inspect' , root : this . base , path : 'current.json' , text : true
    } ) ;
    let parsed ;
    try {
      parsed = current ( JSON . parse ( value . text ) , this . base ) ;
    } catch {
      fail ( 'CURRENT_UNKNOWN' ) ;
    } if ( parsed . dataRoot !== this . root || parsed . port !== this . port ) fail ( 'CURRENT_BINDING_CHANGED' ) ;
    return {
      ... value , value : parsed
    } ;
  } slot ( ref ) {
    return path . join ( this . base , 'versions' , ref . id ) ;
  } selected ( snapshot = this . snapshot ( ) ) {
    if ( ! snapshot ) fail ( 'NOT_INSTALLED' ) ;
    const slot = this . slot ( snapshot . value . release ) , info = packageInfo ( slot , snapshot . value . release . manifestSha256 ) ;
    verifyFiles ( slot , info . manifest , info . rootFingerprint ) ;
    return {
      slot , info , snapshot
    } ;
  } assertStopped ( ) {
    if ( fs . existsSync ( path . join ( this . root , '_hub/desktop-state.json' ) ) ) fail ( 'STOP_CURRENT_INSTANCE_FIRST' ) ;
    native ( { mode : 'port-check' , port : this . port } ) ;
  } dependencies ( ) {
    const file = path . join ( this . root , '_hub/native-dependencies.json' ) ;
    if ( ! fs . existsSync ( file ) ) return null ;
    const result = native ( {
      mode : 'inspect' , root : this . root , path : '_hub/native-dependencies.json' , text : true
    } ) ;
    const value = JSON . parse ( result . text ) ;
    exact ( value , [ 'version' , 'heicDecoder' ] ) ;
    exact ( value . heicDecoder , [ 'path' , 'sha256' , 'version' ] ) ;
    if ( value . version !== 1 || value . heicDecoder . sha256 !== FFMPEG . sha256 || value . heicDecoder . version !== FFMPEG . version ) fail ( 'EXISTING_DEPENDENCY_UNKNOWN' ) ;
    const exe = local ( value . heicDecoder . path ) , actual = native ( {
      mode : 'inspect' , root : path . dirname ( exe ) , path : path . basename ( exe )
    } ) ;
    if ( actual . sha256 !== FFMPEG . sha256 ) fail ( 'EXISTING_DEPENDENCY_CHANGED' ) ;
    return result ;
  } preview ( {
    packageRoot , manifestSha256
  } ) {
    const source = packageInfo ( packageRoot , manifestSha256 ) , previous = this . snapshot ( ) ;
    this . assertStopped ( ) ;
    this . dependencies ( ) ;
    admission.check(this.root,{hubDir:path.join(source.root,'hub'),switching:true});
    const destination = this . slot ( {
      id : source . manifest . releaseId
    } ) ;
    if ( fs . existsSync ( destination ) ) fail ( 'VERSION_ALREADY_EXISTS' ) ;
    return {
      version : 1 , releaseId : source . manifest . releaseId , manifestSha256 , source : source . root , destination , dataRoot : this . root , port : this . port , previous : previous ?. value . release || null , files : source . manifest . files . length , bytes : source . manifest . files . reduce ( ( n , f ) => n + f . bytes , 0 ) , scope : 'Create a new create-only version slot and select it. Existing project, roles, credentials and data files are preserved. No global PATH or Codex configuration changes.'
    } ;
  } install ( options ) {
    const plan = this . preview ( options ) , previous = this . snapshot ( ) , source = packageInfo ( options . packageRoot , options . manifestSha256 ) ;
    const baseIdentity = native ( {
      mode : 'identity' , root : this . base , create : true
    } ) , parentIdentity = native ( {
      mode : 'identity' , root : path . dirname ( plan . destination ) , create : true
    } ) ;
    const copied = native ( {
      mode : 'copy' , source : source . root , sourceFingerprint : source . rootFingerprint , destination : plan . destination , destinationParentFingerprint : parentIdentity . rootFingerprint , files : [ ... source . manifest . files , {
        path : 'package-manifest.json' , sha256 : source . sha256 , bytes : source . manifestBytes . length
      } ]
    } ) ;
    const installed = packageInfo ( plan . destination , source . sha256 ) ;
    if ( installed . rootFingerprint !== copied . rootFingerprint ) fail ( 'ROOT_CHANGED' ) ;
    verifyFiles ( plan . destination , installed . manifest , copied . rootFingerprint ) ;
    const dataIdentity = native ( {
      mode : 'init' , root : this . root
    } ) ;
    const role = path . join ( this . root , '_hub/roles.yaml' ) ;
    if ( ! fs . existsSync ( role ) ) {
      const bytes = read ( path . join ( plan . destination , 'hub/windows/roles.yaml' ) , 200 * 1024 ) , expected = installed . manifest . files . find ( f => f . path === 'hub/windows/roles.yaml' ) ;
      if ( digest ( bytes ) !== expected . sha256 ) fail ( 'PACKAGE_FILE_CHANGED' ) ;
      native ( {
        mode : 'write' , root : this . root , rootFingerprint : dataIdentity . rootFingerprint , path : '_hub/roles.yaml' , text : text ( bytes ) , expectedHash : 'missing'
      } ) ;
    } if ( ! this . dependencies ( ) ) native ( {
      mode : 'write' , root : this . root , rootFingerprint : dataIdentity . rootFingerprint , path : '_hub/native-dependencies.json' , text : json ( {
        version : 1 , heicDecoder : {
          path : path . join ( plan . destination , 'dependencies/ffmpeg-9.0.2/bin/ffmpeg.exe' ) , ... FFMPEG
        }
      } ) , expectedHash : 'missing'
    } ) ;
    this . assertStopped ( ) ;
    admission.check(this.root,{hubDir:path.join(plan.destination,'hub'),switching:true});
    const value = {
      version : 1 , installBase : this . base , dataRoot : this . root , port : this . port , release : {
        id : plan . releaseId , manifestSha256 : source . sha256
      } , previous : previous ?. value . release || null
    } ;
    const saved = native ( {
      mode : 'write' , root : this . base , rootFingerprint : previous ?. rootFingerprint || baseIdentity . rootFingerprint , path : 'current.json' , text : json ( value ) , expectedHash : previous ?. sha256 || 'missing' , ... ( previous ? {
        fileFingerprint : previous . fileFingerprint
      } : {
      } )
    } ) ;
    return {
      ok : true , releaseId : plan . releaseId , currentSha256 : saved . sha256 , slotFingerprint : copied . rootFingerprint , backup : saved . backup || null , started : false
    } ;
  } launch ( stop = false , noBrowser = false , recoveryOnly = false ) {
    const selected = this . selected ( ) ;
    if(typeof recoveryOnly!=='boolean'||stop&&recoveryOnly)fail('RECOVERY_INPUT_REJECTED');
    if(!stop)admission.check(this.root,{hubDir:path.join(selected.slot,'hub'),recoveryOnly});
    let priorState = null ;
    if ( stop && fs . existsSync ( path . join ( this . root , '_hub/desktop-state.json' ) ) ) {
      const state = native ( {
        mode : 'inspect' , root : this . root , path : '_hub/desktop-state.json' , text : true
      } ) , value = JSON . parse ( state . text ) ;
      if ( value . version !== 1 || value . root !== this . root || value . hubDir !== path . join ( selected . slot , 'hub' ) ) fail ( 'LAUNCHER_STATE_BINDING_CHANGED' ) ;
      priorState = state ;
    } const ps = local ( path . join ( process . env . SystemRoot || 'C:\\Windows' , 'System32/WindowsPowerShell/v1.0/powershell.exe' ) ) , args = [ '-NoProfile' , '-NonInteractive' , '-File' , path . join ( selected . slot , 'hub/start-windows.ps1' ) , ... ( stop ? [ '-Stop' ] : [ ] ) , ... ( noBrowser ? [ '-NoBrowser' ] : [ ] ), ...(recoveryOnly?['-RecoveryOnly']:[]) ] ;
    const output = execFileSync ( ps , args , {
      windowsHide : true , env : secureEnv ( {
        ... this . environment , HUB_ROOT : this . root , HUB_PORT : String ( this . port ), HUB_RECOVERY_ONLY:recoveryOnly?'1':'0'
      } ) , timeout : 45000 , stdio : 'ignore'
    } ) || '' ;
    if ( stop && fs . existsSync ( path . join ( this . root , '_hub/desktop-state.json' ) ) ) {
      const state = native ( {
        mode : 'inspect' , root : this . root , path : '_hub/desktop-state.json' , text : true
      } ) , value = JSON . parse ( state . text ) ;
      if ( value . root !== this . root || value . hubDir !== path . join ( selected . slot , 'hub' ) || ! priorState || state . sha256 !== priorState . sha256 || state . fileFingerprint !== priorState . fileFingerprint ) fail ( 'STOP_NOT_CONFIRMED' ) ;
      native ( {
        mode : 'remove' , root : this . root , path : '_hub/desktop-state.json' , expectedHash : state . sha256 , fileFingerprint : state . fileFingerprint
      } ) ;
    }
    if ( stop ) native ( { mode : 'port-check' , port : this . port } ) ;
    return {
      ok : true , action : stop ? 'stop' : 'start' , releaseId : selected . info . manifest . releaseId , recoveryOnly, stopped : stop && priorState !== null , alreadyStopped : stop && priorState === null , output : stop ? '已完成停止入口且服務埠空閒' : recoveryOnly?'已完成同版資料恢復專用入口':'已完成已驗證版本的啟動入口'
    } ;
  } rollback ( ) {
    const before = this . snapshot ( ) ;
    if ( ! before ?. value . previous ) fail ( 'NO_PREVIOUS_VERSION' ) ;
    this . assertStopped ( ) ;
    const info = packageInfo ( this . slot ( before . value . previous ) , before . value . previous . manifestSha256 ) ;
    verifyFiles ( info . root , info . manifest , info . rootFingerprint ) ;
    admission.check(this.root,{hubDir:path.join(info.root,'hub'),switching:true});
    const value = {
      ... before . value , release : before . value . previous , previous : before . value . release
    } ;
    const result = native ( {
      mode : 'write' , root : this . base , rootFingerprint : before . rootFingerprint , path : 'current.json' , text : json ( value ) , expectedHash : before . sha256 , fileFingerprint : before . fileFingerprint
    } ) ;
    return {
      ok : true , releaseId : value . release . id , currentSha256 : result . sha256 , backup : result . backup , started : false , dataUnchanged : true
    } ;
  } restorePointer ( {
    backup , expectedHash
  } ) {
    if ( ! /^history\/current-[a-f0-9]{32}\.json$/ . test ( backup ) || ! HEX . test ( expectedHash || '' ) ) fail ( 'RECOVERY_INPUT_REJECTED' ) ;
    this . assertStopped ( ) ;
    const old = native ( {
      mode : 'inspect' , root : this . base , path : backup , text : true
    } ) , value = current ( JSON . parse ( old . text ) , this . base ) ;
    if ( value . dataRoot !== this . root || value . port !== this . port ) fail ( 'CURRENT_BINDING_CHANGED' ) ;
    const info = packageInfo ( this . slot ( value . release ) , value . release . manifestSha256 ) ;
    verifyFiles ( info . root , info . manifest , info . rootFingerprint ) ;
    admission.check(this.root,{hubDir:path.join(info.root,'hub'),switching:true});
    const journal = native ( {
      mode : 'inspect' , root : this . base , path : backup . replace ( 'current-' , 'change-' ) , text : true
    } ) , receipt = JSON . parse ( journal . text ) ;
    exact ( receipt , [ 'version' , 'path' , 'backup' , 'beforeHash' , 'afterHash' , 'fileFingerprint' ] ) ;
    if ( receipt . version !== 1 || receipt . path !== 'current.json' || receipt . backup !== backup || receipt . beforeHash !== old . sha256 || ! HEX . test ( receipt . afterHash ) || ! HEX . test ( receipt . fileFingerprint ) ) fail ( 'RECOVERY_JOURNAL_CHANGED' ) ;
    const now = native ( {
      mode : 'inspect' , root : this . base , path : 'current.json'
    } ) ;
    if ( now . sha256 !== expectedHash || now . fileFingerprint !== receipt . fileFingerprint || now . rootFingerprint !== old . rootFingerprint || journal . rootFingerprint !== old . rootFingerprint ) fail ( 'CURRENT_CHANGED' ) ;
    const saved = native ( {
      mode : 'write' , root : this . base , rootFingerprint : now . rootFingerprint , path : 'current.json' , text : old . text , expectedHash : now . sha256 , fileFingerprint : now . fileFingerprint
    } ) ;
    return {
      ok : true , releaseId : value . release . id , currentSha256 : saved . sha256 , started : false , dataUnchanged : true
    } ;
  }
} module . exports = {
  Installer , native , manifest , packageInfo , verifyFiles , fileHash , digest , FFMPEG , json, actionOptions
} ;
if ( require . main === module ) {
  try {
    const input = JSON . parse ( fs . readFileSync ( 0 , 'utf8' ) ) ;
    exact ( input , [ 'action' , 'installBase' , 'dataRoot' , 'port' , 'options' ] ) ;
    actionOptions(input.action,input.options);
    const install = new Installer ( input ) ;
    let result ;
    switch ( input . action ) {
      case 'preview' : result = install . preview ( input . options ) ;
      break ;
      case 'install' : result = install . install ( input . options ) ;
      break ;
      case 'start' : result = install . launch ( false , input . options . noBrowser === true, input.options.recoveryOnly===true ) ;
      break ;
      case 'stop' : result = install . launch ( true , true ) ;
      break ;
      case 'rollback' : result = install . rollback ( ) ;
      break ;
      case 'recover-current' : result = install . restorePointer ( input . options ) ;
      break ;
      case 'status' : result = install . snapshot ( ) ?. value || {
        installed : false
      } ;
      break ;
      default : fail ( 'ACTION_REJECTED' ) ;
    } process . stdout . write ( json ( result ) ) ;
  } catch ( error ) {
    process . stderr . write ( json ( {
      ok : false , code : error . code || 'INSTALL_OPERATION_UNKNOWN' , message : error . message
    } ) ) ;
    process . exitCode = 1 ;
  }
}
