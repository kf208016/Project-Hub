'use strict' ;
// Run only after the release source is committed and the source gate has passed.
const fs = require ( 'node:fs' ) , path = require ( 'node:path' ) , crypto = require ( 'node:crypto' ) ;
const install = require ( './native-install.cjs' ) ;
const policy = require ( '../lib/git-policy' ) ;
function reject ( message ) {
  throw Error ( message ) ;
} function git ( source , args ) {
  return policy . raw ( source , args , {
    skipHooks : true
  } ) . trim ( ) ;
} function files ( root , prefix ) {
  const result = [ ] , pending = [ prefix ] ;
  while ( pending . length ) {
    const relative = pending . pop ( ) , absolute = path . join ( root , relative ) , stat = fs . lstatSync ( absolute ) ;
    if ( stat . isSymbolicLink ( ) || ! stat . isFile ( ) && ! stat . isDirectory ( ) ) reject ( 'Package source contains a link/special object' ) ;
    if ( stat . isDirectory ( ) ) {
      for ( const name of fs . readdirSync ( absolute ) . sort ( ) . reverse ( ) ) pending . push ( path . join ( relative , name ) ) ;
    } else result . push ( relative . split ( path . sep ) . join ( '/' ) ) ;
    if ( pending . length + result . length > 20000 ) reject ( 'Package exceeds 20000 files' ) ;
  } return result ;
} function inventory ( source , paths ) {
  return paths . sort ( ) . map ( relative => ( {
    path : relative , ... install . fileHash ( path . join ( source , relative ) )
  } ) ) ;
} function committedFiles ( source , revision ) {
  const rows = git ( source , [ 'ls-tree' , '-r' , '-z' , revision ] ) . split ( '\0' ) . filter ( Boolean ) . map ( row => {
    const m = row . match ( /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s ) ; if ( ! m ) reject ( 'Commit contains a non-regular tracked object' ) ; return {
      oid : m [ 2 ] , path : m [ 3 ]
    } ;
  } ) . filter ( x => x . path === 'LICENSE' || x . path . startsWith ( 'hub/' ) && ! x . path . startsWith ( 'hub/test/' ) && ! x . path . startsWith ( 'hub/.runtime/' ) && ! x . path . startsWith ( 'hub/node_modules/' ) || x . path . startsWith ( 'docs/project-hub/templates/' ) ) ;
  if ( ! rows . length || rows . length > 20000 ) reject ( 'Committed source file count is invalid' ) ;
  const batch = policy . raw ( source , [ 'cat-file' , '--batch' ] , {
    skipHooks : true , encoding : null , input : rows . map ( x => x . oid ) . join ( '\n' ) + '\n'
  } ) ;
  let at = 0 ;
  return rows . map ( row => {
    const end = batch . indexOf ( 10 , at ) ; if ( end < at ) reject ( 'Commit blob response is truncated' ) ; const m = batch . subarray ( at , end ) . toString ( 'ascii' ) . match ( /^([a-f0-9]{40}) blob ([0-9]+)$/ ) ; if ( ! m || m [ 1 ] !== row . oid || Number ( m [ 2 ] ) > 4 * 1024 * 1024 ) reject ( 'Commit blob response is invalid or exceeds the reviewed 4MiB bound' ) ; const size = Number ( m [ 2 ] ) , bytes = Buffer . from ( batch . subarray ( end + 1 , end + 1 + size ) ) ; at = end + 1 + size + 1 ; if ( bytes . length !== size || batch [ at - 1 ] !== 10 || crypto . createHash ( 'sha1' ) . update ( Buffer . from ( 'blob ' + size + '\0' ) ) . update ( bytes ) . digest ( 'hex' ) !== row . oid ) reject ( 'Commit blob identity changed' ) ; return {
      path : row . path , bytes : size , sha256 : install . digest ( bytes ) , base64 : bytes . toString ( 'base64' )
    } ;
  } ) ;
} function metadata ( revision , sourceFiles , lockfileHash ) {
  return {
    version : 1 , releaseId : '4.68.2-windows-codex-' + revision . slice ( 0 , 12 ) , source : {
      repository : 'https://github.com/kieiken/project-hub' , tag : 'v4.68.2' , revision
    } , platform : 'win32-x64' , dependencies : {
      npm : {
        lockfileSha256 : lockfileHash , installation : 'npm ci --ignore-scripts; reviewed node-pty 1.1.0 Windows prebuild'
      } , ffmpeg : {
        ... install . FFMPEG , license : 'GPLv3' , source : 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b' , publisher : 'https://www.gyan.dev/ffmpeg/builds/' , archiveSha256 : '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
      }
    } , files : sourceFiles
  } ;
} function build ( {
  source , destination , revision , ffmpegRoot
} ) {
  if ( ! /^[a-f0-9]{40}$/ . test ( revision ) ) reject ( 'An exact reviewed commit is required' ) ;
  const assertSource = ( ) => {
    policy . assertIndexVisible ( source ) ;
    if ( git ( source , [ 'rev-parse' , 'HEAD' ] ) !== revision || git ( source , [ 'status' , '--porcelain' , '--untracked-files=all' ] ) ) reject ( 'Source revision changed or source is not clean; no release manifest is produced' ) ;
  } ;
  assertSource ( ) ;
  const committed = committedFiles ( source , revision ) , sourceFiles = committed . map ( ( {
    path , bytes , sha256
  } ) => ( {
    path , bytes , sha256
  } ) ) ;
  const staging = path . join ( path . dirname ( destination ) , '.package-input-' + crypto . randomUUID ( ) ) , stageId = install . native ( {
    mode : 'identity' , root : staging , create : true
  } ) ;
  let chunk = [ ] , chunkBytes = 0 ;
  const flush = ( ) => {
    if ( chunk . length ) install . native ( {
      mode : 'materialize' , root : staging , rootFingerprint : stageId . rootFingerprint , files : chunk
    } ) ;
    chunk = [ ] ;
    chunkBytes = 0 ;
  } ;
  for ( const file of committed ) {
    const size = Buffer . byteLength ( JSON . stringify ( file ) ) ;
    if ( chunkBytes + size > 6 * 1024 * 1024 ) flush ( ) ;
    chunk . push ( file ) ;
    chunkBytes += size ;
  } flush ( ) ;
  const parentId = install . native ( {
    mode : 'identity' , root : path . dirname ( destination ) , create : true
  } ) ;
  const copied = install . native ( {
    mode : 'copy' , source : staging , sourceFingerprint : stageId . rootFingerprint , destination , destinationParentFingerprint : parentId . rootFingerprint , files : sourceFiles
  } ) ;
  const npmRoot = path . join ( source , 'hub/node_modules' ) , npmFiles = inventory ( npmRoot , files ( npmRoot , '.' ) . map ( x => x . replace ( /^\.\// , '' ) ) ) , npmId = install . native ( {
    mode : 'identity' , root : npmRoot
  } ) , npmParent = install . native ( {
    mode : 'identity' , root : path . join ( destination , 'hub' )
  } ) ;
  install . native ( {
    mode : 'copy' , source : npmRoot , sourceFingerprint : npmId . rootFingerprint , destination : path . join ( destination , 'hub/node_modules' ) , destinationParentFingerprint : npmParent . rootFingerprint , files : npmFiles
  } ) ;
  sourceFiles . push ( ... npmFiles . map ( f => ( {
    ... f , path : 'hub/node_modules/' + f . path
  } ) ) ) ;
  const decoderFiles = inventory ( ffmpegRoot , [ 'bin/ffmpeg.exe' , 'LICENSE' , 'README.txt' ] ) ;
  if ( decoderFiles . find ( f => f . path === 'bin/ffmpeg.exe' ) . sha256 !== install . FFMPEG . sha256 ) reject ( 'Reviewed FFmpeg bytes do not match' ) ;
  const ffmpegDest = path . join ( destination , 'dependencies/ffmpeg-9.0.2' ) , decoderId = install . native ( {
    mode : 'identity' , root : ffmpegRoot
  } ) , decoderParent = install . native ( {
    mode : 'identity' , root : path . dirname ( ffmpegDest ) , create : true
  } ) ;
  install . native ( {
    mode : 'copy' , source : ffmpegRoot , sourceFingerprint : decoderId . rootFingerprint , destination : ffmpegDest , destinationParentFingerprint : decoderParent . rootFingerprint , files : decoderFiles
  } ) ;
  const dependencyMetadata = install . json ( {
    version : install . FFMPEG . version , sha256 : install . FFMPEG . sha256 , license : 'GPLv3' , source : 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b' , publisher : 'https://www.gyan.dev/ffmpeg/builds/' , archiveSha256 : '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba' , use : 'Private local installation dependency; excluded from source-only archive. Source URL metadata is not a reproducible-build attestation.'
  } ) ;
  install . native ( {
    mode : 'write' , root : destination , rootFingerprint : copied . rootFingerprint , path : 'dependencies/ffmpeg-9.0.2/source-metadata.json' , text : dependencyMetadata , expectedHash : 'missing'
  } ) ;
  const all = [ ... sourceFiles , ... decoderFiles . map ( f => ( {
    ... f , path : 'dependencies/ffmpeg-9.0.2/' + f . path
  } ) ) , {
    path : 'dependencies/ffmpeg-9.0.2/source-metadata.json' , sha256 : install . digest ( Buffer . from ( dependencyMetadata ) ) , bytes : Buffer . byteLength ( dependencyMetadata )
  } ] . sort ( ( a , b ) => a . path . localeCompare ( b . path , 'en' ) ) ;
  const lock = all . find ( f => f . path === 'hub/package-lock.json' ) , value = install . manifest ( metadata ( revision , all , lock . sha256 ) ) ;
  install . verifyFiles ( destination , value , copied . rootFingerprint ) ;
  assertSource ( ) ;
  const manifestBytes = install . json ( value ) , sha256 = install . digest ( Buffer . from ( manifestBytes ) ) ;
  install . native ( {
    mode : 'write' , root : destination , rootFingerprint : copied . rootFingerprint , path : 'package-manifest.json' , text : manifestBytes , expectedHash : 'missing'
  } ) ;
  return {
    ok : true , destination , sourceStaging : staging , releaseId : value . releaseId , manifestSha256 : sha256 , files : all . length , bytes : all . reduce ( ( n , f ) => n + f . bytes , 0 )
  } ;
} module . exports = {
  build , metadata , inventory , files , committedFiles
} ;
if ( require . main === module ) {
  try {
    process . stdout . write ( install . json ( build ( install . parseRequest ( fs . readFileSync ( 0 ) ) ) ) ) ;
  } catch ( error ) {
    process . stderr . write ( install . json ( {
      ok : false , message : error . message
    } ) ) ;
    process . exitCode = 1 ;
  }
}
