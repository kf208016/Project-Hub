'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PROVIDER_HASHES = Object.freeze({
  claude: 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a',
  grok: '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94'
});

const PROFILE_NAME = 'project-hub-worker';
const REQUIRED_WIN_BUILD = '26200';
const MAX_PATH_LEN = 32760;
const MAX_ARG_LEN = 32760;
const MAX_ARGS = 1024;

const HEX64 = /^[0-9a-f]{64}$/;

class SandboxError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SandboxError';
    this.code = code;
  }
}

function fail(code) {
  throw new SandboxError(code);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
}

function hasNul(s) {
  return s.indexOf('\u0000') !== -1;
}

function hasTraversalSegment(p) {
  return p.split(/[\\/]+/).some((seg) => seg === '..');
}

function isUncOrDevice(p) {
  return /^\\\\/.test(p) || /^\\\\\?\\/.test(p) || /^\\\\\.\\/.test(p);
}

function isDriveOrProfileRoot(normalized) {
  const root = path.win32.parse(normalized).root;
  const trimmed = normalized.replace(/\\+$/, '');
  if (trimmed.toLowerCase() === root.replace(/\\+$/, '').toLowerCase()) return true;
  if (/^[a-zA-Z]:\\Users$/i.test(trimmed)) return true;
  if (/^[a-zA-Z]:\\Users\\[^\\]+$/i.test(trimmed)) return true;
  return false;
}

function checkSafePath(p, code) {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LEN) fail(code);
  if(!p.isWellFormed())fail(code);
  if (hasNul(p)) fail(code);
  if (hasTraversalSegment(p)) fail(code);
  if (isUncOrDevice(p)) fail(code);
  if (!/^[A-Za-z]:[\\/]/.test(p) || p.slice(2).includes(':')) fail(code);
  if(p.slice(3).split(/[\\/]+/).some(s=>s==='.'||/[. ]$|[<>"|?*\x00-\x1f]/.test(s)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s))) fail(code);
  if (!path.win32.isAbsolute(p)) fail(code);
  const normalized = path.win32.normalize(p);
  if (isDriveOrProfileRoot(normalized)) fail(code);
  return normalized;
}

function checkArgs(args) {
  if (!Array.isArray(args)) fail('ERR_INVALID_ARGS');
  if (args.length > MAX_ARGS) fail('ERR_INVALID_ARGS');
  for (const a of args) {
    if (typeof a !== 'string') fail('ERR_INVALID_ARGS');
    if (hasNul(a)) fail('ERR_INVALID_ARGS');
    if(!a.isWellFormed())fail('ERR_INVALID_ARGS');
    if (a.length > MAX_ARG_LEN) fail('ERR_INVALID_ARGS');
  }
  if(args.reduce((n,a)=>n+a.length,0)>12000)fail('ERR_INVALID_ARGS');
  return args.slice();
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.getOwnPropertyNames(obj).forEach((k) => deepFreeze(obj[k]));
    Object.freeze(obj);
  }
  return obj;
}

const RUNTIME_ENV_WHITELIST = [
  'SystemRoot', 'WINDIR', 'SystemDrive', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ComSpec',
  'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
];

function buildRuntimeEnv(cwd, tmpDir) {
  const out = {};
  for (const key of RUNTIME_ENV_WHITELIST) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) out[key] = v;
  }
  const programFiles = out.ProgramFiles || 'C:\\Program Files';
  const systemRoot = out.SystemRoot || 'C:\\Windows';
  const pathEntries = [
    path.win32.join(systemRoot, 'System32'),
    path.win32.join(programFiles, 'Git', 'cmd'),
    path.win32.join(programFiles, 'Git', 'bin'),
    path.win32.join(programFiles, 'nodejs')
  ];
  out.PATH = pathEntries.join(';');
  out.TEMP = tmpDir;
  out.TMP = tmpDir;
  out.CLAUDE_CODE_TMPDIR = tmpDir;
  return out;
}

function buildFilesystemToml(cwd) {
  const gitDir = path.win32.join(cwd, '.git');
  const agentsDir = path.win32.join(cwd, '.agents');
  const codexDir = path.win32.join(cwd, '.codex');
  const awsDir = path.win32.join(cwd, '.aws');
  const entries = [
    '":minimal"="read"',
    JSON.stringify(cwd) + '="write"',
    JSON.stringify(gitDir) + '="read"',
    JSON.stringify(agentsDir) + '="read"',
    JSON.stringify(codexDir) + '="read"',
    JSON.stringify(awsDir) + '="read"'
  ];
  return 'permissions.' + PROFILE_NAME + '.filesystem={' + entries.join(',') + '}';
}

function createPlan(options) {
  if (!isPlainObject(options)) fail('ERR_INVALID_OPTIONS');
  const {
    provider, providerFile, providerArgs, codexFile, cwd,
    rootFingerprint, codexSHA256, networkAccess = false,
    stateRoots = [], env = {}
  } = options;

  if (provider !== 'claude' && provider !== 'grok') fail('ERR_INVALID_PROVIDER');
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_HASHES, provider)) fail('ERR_INVALID_PROVIDER');

  const safeProviderFile = checkSafePath(providerFile, 'ERR_INVALID_PATH');
  const safeCodexFile = checkSafePath(codexFile, 'ERR_INVALID_PATH');
  const safeCwd = checkSafePath(cwd, 'ERR_INVALID_CWD');
  const safeArgs = checkArgs(providerArgs);

  if (typeof rootFingerprint !== 'string' || !HEX64.test(rootFingerprint)) {
    fail('ERR_INVALID_FINGERPRINT');
  }
  if (typeof codexSHA256 !== 'string' || !HEX64.test(codexSHA256)) {
    fail('ERR_INVALID_HASH_FORMAT');
  }
  if (typeof networkAccess !== 'boolean') fail('ERR_INVALID_OPTIONS');
  if (!Array.isArray(stateRoots)) fail('ERR_INVALID_STATE_ROOT');
  const safeStateRoots = stateRoots.map((r) => {
    const safe = checkSafePath(r, 'ERR_INVALID_STATE_ROOT');
    const cwdPrefix = safeCwd.toLowerCase().replace(/\\+$/, '') + '\\';
    if (safe.toLowerCase() === safeCwd.toLowerCase()) fail('ERR_INVALID_STATE_ROOT');
    if (!safe.toLowerCase().startsWith(cwdPrefix)) fail('ERR_INVALID_STATE_ROOT');
    return safe;
  });
  if (!isPlainObject(env)) fail('ERR_INVALID_ENV');
  for (const k of Object.keys(env)) {
    if (typeof env[k] !== 'string' || hasNul(env[k]) || hasNul(k)) fail('ERR_INVALID_ENV');
  }

  const tmpDir = path.win32.join(safeCwd, '.hub-runtime', 'tmp');
  const filesystemToml = buildFilesystemToml(safeCwd);
  const networkFlag = 'permissions.' + PROFILE_NAME + '.network.enabled=' + (networkAccess ? 'true' : 'false');

  const args = [
    'sandbox',
    '-C', safeCwd,
    '-P', PROFILE_NAME,
    '--include-managed-config',
    '-c', filesystemToml,
    '-c', networkFlag,
    '-c', 'windows.sandbox="elevated"',
    '--',
    safeProviderFile,
    ...safeArgs
  ];

  const runtimeEnv = buildRuntimeEnv(safeCwd, tmpDir);

  const plan = {
    file: safeCodexFile,
    args,
    cwd: safeCwd,
    env: runtimeEnv,
    dirPin: { root: safeCwd, rootFingerprint },
    provider,
    providerFile: safeProviderFile,
    codexSHA256,
    stateRoots: safeStateRoots,
    networkAccess,
    tmpDir
  };

  return deepFreeze(plan);
}

function checkNoSymlinkAncestors(fullPath) {
  try { require('./safe-path').localPath(fullPath,{allowMissing:true}); } catch { fail('ERR_INVALID_PATH'); }
  const parsed = path.win32.parse(fullPath);
  const root = parsed.root;
  const rel = fullPath.slice(root.length);
  const segments = rel.split(/\\+/).filter(Boolean);
  let current = root;
  for (const seg of segments) {
    current = path.win32.join(current, seg);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      fail('ERR_NOT_FOUND');
    }
    if (st.isSymbolicLink()) fail('ERR_SYMLINK_DETECTED');
  }
}

function sha256File(filePath) {
  try {
    const stat=fs.lstatSync(filePath);
    if(!stat.isFile()||stat.size>512*1024*1024)fail('ERR_INVALID_BINARY');
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch(e) { if(e instanceof SandboxError)throw e;fail('ERR_BINARY_READ'); }
}

function assertRealFile(filePath) {
  checkNoSymlinkAncestors(filePath);
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (e) {
    fail('ERR_NOT_FOUND');
  }
  if (st.isSymbolicLink()) fail('ERR_SYMLINK_DETECTED');
  if (!st.isFile()) fail('ERR_NOT_FOUND');
}

function assertRealDirectory(dirPath) {
  checkNoSymlinkAncestors(dirPath);
  let st;
  try {
    st = fs.lstatSync(dirPath);
  } catch (e) {
    fail('ERR_NOT_DIRECTORY');
  }
  if (st.isSymbolicLink()) fail('ERR_SYMLINK_DETECTED');
  if (!st.isDirectory()) fail('ERR_NOT_DIRECTORY');
}

function assertPlatform() {
  if (process.platform !== 'win32') fail('ERR_PLATFORM_UNSUPPORTED');
  if (process.arch !== 'x64') fail('ERR_PLATFORM_UNSUPPORTED');
  const release = os.release() || '';
  const parts = release.split('.');
  const build = parts[2] || '';
  if (build !== REQUIRED_WIN_BUILD) fail('ERR_PLATFORM_UNSUPPORTED');
}

function ensureTmpDir(cwd, tmpDir) {
  const hubDir = path.win32.join(cwd, '.hub-runtime');
  for (const p of [hubDir, tmpDir]) {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) fail('ERR_SYMLINK_DETECTED');
    } catch (e) {
      if (e instanceof SandboxError) throw e;
    }
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const finalSt = fs.lstatSync(tmpDir);
  if (finalSt.isSymbolicLink()) fail('ERR_SYMLINK_DETECTED');
  if (!finalSt.isDirectory()) fail('ERR_NOT_DIRECTORY');
  return tmpDir;
}

function launch(options, supervisedSpawn) {
  if (typeof supervisedSpawn !== 'function') fail('ERR_SPAWN_INVALID');

  const plan = createPlan(options);

  assertPlatform();

  assertRealDirectory(plan.cwd);

  assertRealFile(plan.providerFile);
  const providerHash = sha256File(plan.providerFile);
  if (providerHash !== PROVIDER_HASHES[plan.provider]) fail('ERR_HASH_MISMATCH');

  assertRealFile(plan.file);
  const codexHash = sha256File(plan.file);
  if (codexHash !== plan.codexSHA256) fail('ERR_HASH_MISMATCH');

  for (const root of plan.stateRoots) {
    try {
      assertRealDirectory(root);
    } catch (e) {
      if (e instanceof SandboxError && e.code === 'ERR_NOT_DIRECTORY') continue;
      throw e;
    }
  }

  try {ensureTmpDir(plan.cwd, plan.tmpDir);}catch(e){if(e instanceof SandboxError)throw e;fail('ERR_TEMP_DIRECTORY');}

  const backendId = crypto.randomUUID();

  const child = supervisedSpawn(plan.file, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    dirPin: plan.dirPin
  });

  Object.defineProperty(child, 'backendId', { value: backendId, enumerable: true });

  return child;
}

module.exports = {
  createPlan,
  launch,
  SandboxError,
  PROVIDER_HASHES
};
