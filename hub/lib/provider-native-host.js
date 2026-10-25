'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {Readable,Writable}=require('node:stream');
const claimed=new WeakSet();

const { createPlan } = require('./provider-native-plan');
const { localPath } = require('./safe-path');

const PROVIDER_HASHES = Object.freeze({
  claude: 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a',
  grok: '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94'
});

const GROK_CONFIG = [
  '[memory]',
  'enabled = false',
  '[memory_v2]',
  'enabled = false',
  '',
  '[session]',
  'load_envrc = false',
  '',
  '[compat.claude]',
  'agents = false',
  'hooks = false',
  'mcps = false',
  'rules = false',
  'skills = false',
  '',
  '[compat.codex]',
  'hooks = false',
  'skills = false',
  '',
  '[compat.cursor]',
  'agents = false',
  'hooks = false',
  'mcps = false',
  'rules = false',
  'skills = false',
  ''
].join('\n');

const MIN_BIN_SIZE = 1;
const MAX_BIN_SIZE = 512 * 1024 * 1024;
const MAX_CRED_SIZE = 4 * 1024 * 1024;
const MAX_CONFIG_SIZE = 16384;
const REQUIRED_BUILD = '26200';

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function checkPlatform() {
  if (process.platform !== 'win32') fail('NATIVE_PLATFORM_UNSUPPORTED');
  if (process.arch !== 'x64') fail('NATIVE_PLATFORM_UNSUPPORTED');
  const release = os.release() || '';
  const parts = release.split('.');
  const build = parts[2] || '';
  if (build !== REQUIRED_BUILD) fail('NATIVE_PLATFORM_UNSUPPORTED');
}

function lstatSafe(p, allowMissing) {
  const resolved = localPath(p, { allowMissing });
  try {
    return { resolved, stat: fs.lstatSync(resolved) };
  } catch (e) {
    if (allowMissing && e && e.code === 'ENOENT') return { resolved, stat: null };
    fail('NATIVE_PATH_INVALID');
  }
}

function verifyRegularFile(p, { minSize, maxSize, requireNlink1 } = {}) {
  const { resolved, stat } = lstatSafe(p, false);
  if (!stat || !stat.isFile()) fail('NATIVE_FILE_KIND_INVALID');
  if (stat.isSymbolicLink && stat.isSymbolicLink()) fail('NATIVE_FILE_KIND_INVALID');
  if (requireNlink1 && stat.nlink !== 1) fail('NATIVE_FILE_KIND_INVALID');
  if (typeof minSize === 'number' && stat.size < minSize) fail('NATIVE_FILE_SIZE_INVALID');
  if (typeof maxSize === 'number' && stat.size > maxSize) fail('NATIVE_FILE_SIZE_INVALID');
  return resolved;
}

function verifyRegularDir(p) {
  const { resolved, stat } = lstatSafe(p, false);
  if (!stat || !stat.isDirectory()) fail('NATIVE_DIR_KIND_INVALID');
  return resolved;
}

function hashFile(resolvedPath) {
  const fd=fs.openSync(resolvedPath,'r'),hash=crypto.createHash('sha256'),buf=Buffer.alloc(128*1024);
  try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null))>0)hash.update(buf.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}
}

function verifyBinaryHash(resolvedPath, expectedHash) {
  const actual = hashFile(resolvedPath);
  if (actual !== expectedHash) fail('NATIVE_HASH_MISMATCH');
}

function verifyNodeFile(nodeFile) {
  const resolved = localPath(nodeFile, { allowMissing: false });
  const normalizedExpected = path.normalize(process.execPath).toLowerCase();
  const normalizedActual = path.normalize(resolved).toLowerCase();
  if (normalizedActual !== normalizedExpected) fail('NATIVE_NODE_INVALID');
  verifyRegularFile(resolved, { minSize: 1 });
}

function verifyCredentialOrLockFile(p) {
  try {
  const { resolved, stat } = lstatSafe(p, false);
  if (!stat) fail('NATIVE_AUTH_UNAVAILABLE');
  if (!stat.isFile()) fail('NATIVE_AUTH_UNAVAILABLE');
  if (stat.isSymbolicLink && stat.isSymbolicLink()) fail('NATIVE_AUTH_UNAVAILABLE');
  if (stat.nlink !== 1) fail('NATIVE_AUTH_UNAVAILABLE');
  if (stat.size > MAX_CRED_SIZE) fail('NATIVE_AUTH_UNAVAILABLE');
  return resolved;
  } catch { fail('NATIVE_AUTH_UNAVAILABLE'); }
}

function ensureStateDir(dirPath) {
  localPath(dirPath, { allowMissing: true });
  fs.mkdirSync(dirPath, { recursive: true });
  const resolved = localPath(dirPath, { allowMissing: false });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory()) fail('NATIVE_DIR_KIND_INVALID');
  if (stat.isSymbolicLink && stat.isSymbolicLink()) fail('NATIVE_DIR_KIND_INVALID');
  return resolved;
}

function writeGrokConfigIfNeeded(providerHome) {
  const configPath = path.join(providerHome, 'config.toml');
  localPath(configPath, { allowMissing: true });
  const buf = Buffer.from(GROK_CONFIG, 'utf8');
  let fd;
  try {
    fd = fs.openSync(configPath, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      verifyExistingGrokConfig(configPath, buf);
      return;
    }
    fail('NATIVE_CONFIG_WRITE_FAILED');
  }
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  verifyExistingGrokConfig(configPath, buf);
}

function verifyExistingGrokConfig(configPath, expectedBuf) {
  const resolved = localPath(configPath, { allowMissing: false });
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) fail('NATIVE_CONFIG_CHANGED');
  if (stat.isSymbolicLink && stat.isSymbolicLink()) fail('NATIVE_CONFIG_CHANGED');
  if (stat.nlink !== 1) fail('NATIVE_CONFIG_CHANGED');
  if (stat.size > MAX_CONFIG_SIZE) fail('NATIVE_CONFIG_CHANGED');
  const actual = fs.readFileSync(resolved);
  if (!actual.equals(expectedBuf)) fail('NATIVE_CONFIG_CHANGED');
}

function validateChild(child) {
  if (!child) fail('NATIVE_ENDPOINT_INVALID');
  const hasStreams = child.stdin instanceof Writable && child.stdout instanceof Readable && child.stderr instanceof Readable;
  const hasEvents = typeof child.on === 'function' && typeof child.once === 'function';
  const hasKill = typeof child.kill === 'function';
  if (!hasStreams || !hasEvents || !hasKill) {
    if (child && typeof child.kill === 'function') {
      try { child.kill(); } catch (_e) { /* best effort invalid-object cleanup */ }
    }
    fail('NATIVE_ENDPOINT_INVALID');
  }
}

function launch(options, supervisedSpawn) {
  let child;
  try {
  checkPlatform();

  if (typeof supervisedSpawn !== 'function') fail('NATIVE_ENDPOINT_INVALID');

  const plan = createPlan(options);

  const actor = plan.actor;
  const expectedHash = PROVIDER_HASHES[actor];
  if (!expectedHash) fail('NATIVE_PROVIDER_UNSUPPORTED');

  const providerResolved = verifyRegularFile(plan.providerFile, {
    minSize: MIN_BIN_SIZE,
    maxSize: MAX_BIN_SIZE,
    requireNlink1: true
  });

  const codexResolved = verifyRegularFile(plan.file, {
    minSize: MIN_BIN_SIZE,
    maxSize: MAX_BIN_SIZE,
    requireNlink1: true
  });

  verifyNodeFile(plan.nodeFile);

  verifyRegularDir(plan.gitDirectory);
  verifyRegularDir(plan.hubLibDirectory);

  const credentialFiles = plan.credentialFiles || [];
  for (const credPath of credentialFiles) {
    verifyCredentialOrLockFile(credPath);
  }
  if (plan.lockFile) {
    verifyCredentialOrLockFile(plan.lockFile);
  }

  // Hub-owned directories/config only; these writes precede pre-spawn hash verification.
  ensureStateDir(plan.runtimeDirectory);
  ensureStateDir(plan.tempDirectory);
  ensureStateDir(plan.stateDirectory);

  if (actor === 'grok') {
    if (!plan.providerHome) fail('NATIVE_CONFIG_WRITE_FAILED');
    ensureStateDir(plan.providerHome);
    writeGrokConfigIfNeeded(plan.providerHome);
  }

  // Immediate pre-spawn recheck of binary hashes.
  verifyBinaryHash(providerResolved, expectedHash);
  verifyBinaryHash(codexResolved, plan.codexSHA256);

  child = supervisedSpawn(plan.file, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    dirPin: plan.dirPin
  });

  validateChild(child);
  if(claimed.has(child))fail('NATIVE_ENDPOINT_INVALID');
  claimed.add(child);

  const backendId = crypto.randomUUID();
  Object.defineProperty(child, 'backendId', {
    value: backendId,
    writable: false,
    configurable: false,
    enumerable: true
  });

  return child;
  } catch(error) {
    if(child&&typeof child.kill==='function')try{child.kill();}catch{}
    if(typeof error?.code==='string'&&/^NATIVE_[A-Z_]+$/.test(error.code))throw error;
    fail('NATIVE_LAUNCH_FAILED');
  }
}

module.exports = { launch, PROVIDER_HASHES, GROK_CONFIG };
