'use strict';
const {MAX_WALL_MS}=require('./native-turn-limits');

const path = require('path');

const ERR = {
  INVALID: 'NATIVE_PLAN_INVALID',
  PATH: 'NATIVE_PATH_INVALID',
  ARGS: 'NATIVE_ARGS_INVALID',
  PROXY: 'NATIVE_PROXY_INVALID',
};

function fail(code, msg) {
  const e = new Error(msg);
  e.code = code;
  throw e;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function checkOwnDataProps(obj, allowedKeys) {
  if (!isPlainObject(obj)) fail(ERR.INVALID, 'invalid options');
  const symKeys = Object.getOwnPropertySymbols(obj);
  if (symKeys.length) fail(ERR.INVALID, 'invalid keys');
  const descs = Object.getOwnPropertyDescriptors(obj);
  const keys = Object.keys(descs);
  for (const k of keys) {
    const d = descs[k];
    if (!Object.hasOwn(d, 'value')) fail(ERR.INVALID, 'invalid descriptor');
    if (!d.enumerable) fail(ERR.INVALID, 'invalid descriptor');
    if (!allowedKeys.includes(k)) fail(ERR.INVALID, 'unknown field');
  }
  return keys;
}

function hasBadChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c >= 1 && c <= 8) return true;
    if (c >= 0x0e && c <= 0x1f) return true;
    if (c === 0x7f) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function checkStringArray(arr, maxLen, maxItem, maxTotal) {
  if (!Array.isArray(arr)) fail(ERR.ARGS, 'invalid args');
  const symKeys = Object.getOwnPropertySymbols(arr);
  if (symKeys.length) fail(ERR.ARGS, 'invalid args');
  const descs = Object.getOwnPropertyDescriptors(arr);
  const keys = Object.keys(descs);
  for (const k of keys) {
    const d = descs[k];
    if (k === 'length') {
      if (d.enumerable) fail(ERR.ARGS, 'invalid args');
      continue;
    }
    if (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= arr.length) fail(ERR.ARGS, 'invalid args');
    if (!Object.hasOwn(d, 'value')) fail(ERR.ARGS, 'invalid args');
    if (!d.enumerable) fail(ERR.ARGS, 'invalid args');
  }
  if (arr.length > maxLen) fail(ERR.ARGS, 'too many args');
  let total = 0;
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (!Object.hasOwn(descs, String(i))) fail(ERR.ARGS, 'sparse args');
    const v = descs[String(i)].value;
    if (typeof v !== 'string') fail(ERR.ARGS, 'invalid arg type');
    if (v.length > maxItem) fail(ERR.ARGS, 'arg too long');
    if (hasBadChars(v)) fail(ERR.ARGS, 'invalid arg content');
    total += v.length;
    out.push(v);
  }
  if (total > maxTotal) fail(ERR.ARGS, 'args too large');
  return out;
}

function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

const PROXY_RE = /^http:\/\/hub:[0-9a-f]{64}@127\.0\.0\.1:(\d{1,5})$/;
function validateProxyUrl(s) {
  if (typeof s !== 'string') fail(ERR.PROXY, 'invalid proxy');
  const m = PROXY_RE.exec(s);
  if (!m) fail(ERR.PROXY, 'invalid proxy');
  const port = parseInt(m[1], 10);
  if (!(port >= 1 && port <= 65535)) fail(ERR.PROXY, 'invalid proxy');
  return s;
}

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const INVALID_FILENAME_CHARS = /[<>:"|?*]/;

function validateWindowsAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 32760) fail(ERR.PATH, 'invalid path');
  if (hasBadChars(p) || /[\x00-\x1f]/.test(p)) fail(ERR.PATH, 'invalid path');
  p = p.replace(/\//g, '\\');
  if (p.startsWith('\\\\') || p.startsWith('//')) fail(ERR.PATH, 'invalid path');
  if (!/^[A-Za-z]:\\/.test(p)) fail(ERR.PATH, 'invalid path');
  if (/\\$/.test(p) && p.length > 3) fail(ERR.PATH, 'invalid path');
  const drive = p.slice(0, 2);
  const rest = p.slice(3);
  const segments = rest.length ? rest.split('\\') : [];
  for (const seg of segments) {
    if (seg === '') fail(ERR.PATH, 'invalid path');
    if (seg === '.' || seg === '..') fail(ERR.PATH, 'invalid path');
    if (seg.endsWith(' ') || seg.endsWith('.')) fail(ERR.PATH, 'invalid path');
    if (seg.includes(':')) fail(ERR.PATH, 'invalid path');
    if (INVALID_FILENAME_CHARS.test(seg)) fail(ERR.PATH, 'invalid path');
    const base = seg.split('.')[0];
    if (RESERVED.test(base)) fail(ERR.PATH, 'invalid path');
  }
  const normalized = path.win32.normalize(p);
  if (normalized.replace(/\\+$/, '').toLowerCase() !== p.replace(/\\+$/, '').toLowerCase()) {
    fail(ERR.PATH, 'invalid path');
  }
  return drive[0].toUpperCase() + ':\\' + segments.join('\\');
}

function segCount(p) {
  const rest = p.slice(3);
  return rest.length ? rest.split('\\').length : 0;
}

function eq(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function contains(parent, child) {
  const pl = parent.toLowerCase();
  const cl = child.toLowerCase();
  return cl === pl || cl.startsWith(pl + '\\');
}

function dirnameOf(p) {
  return path.win32.dirname(p);
}

// The controller resolves the physical private directory. This check stays
// pure so an untrusted launch descriptor cannot substitute a broader root.
function validateRuntimeBase(value, owner) {
  const runtimeBase = validateWindowsAbsolutePath(value);
  const ownerHome = validateWindowsAbsolutePath(owner);
  const local = path.win32.join(ownerHome, 'AppData', 'Local');
  if (segCount(ownerHome) === 0 || !contains(local, runtimeBase) ||
      eq(local, runtimeBase) || !eq(path.win32.basename(runtimeBase), 'ProjectHub')) {
    fail(ERR.PATH, 'invalid runtime base');
  }
  return runtimeBase;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--always-approve',
  '--yolo',
]);

function createPlan(options) {
  const allowedKeys = [
    'actor', 'cwd', 'rootFingerprint', 'ownerHome', 'runtimeBase', 'providerFile', 'codexFile',
    'codexSHA256', 'nodeFile', 'gitDirectory', 'hubLibDirectory', 'providerArgs',
    'proxyUrl', 'systemRoot', 'maxWallMs',
  ];
  const keys = checkOwnDataProps(options, allowedKeys);

  const required = [
    'actor', 'cwd', 'rootFingerprint', 'ownerHome', 'runtimeBase', 'providerFile', 'codexFile',
    'codexSHA256', 'nodeFile', 'gitDirectory', 'hubLibDirectory', 'providerArgs',
    'proxyUrl', 'systemRoot',
  ];
  for (const r of required) {
    if (!keys.includes(r)) fail(ERR.INVALID, 'missing field');
  }

  const actor = options.actor;
  if (actor !== 'claude' && actor !== 'grok') fail(ERR.INVALID, 'invalid actor');

  if (!isHex64(options.rootFingerprint)) fail(ERR.INVALID, 'invalid fingerprint');
  if (!isHex64(options.codexSHA256)) fail(ERR.INVALID, 'invalid hash');

  let maxWallMs = MAX_WALL_MS;
  if (keys.includes('maxWallMs')) {
    const m = options.maxWallMs;
    if (!Number.isInteger(m) || m < 1 || m > MAX_WALL_MS) fail(ERR.INVALID, 'invalid maxWallMs');
    maxWallMs = m;
  }

  const cwd = validateWindowsAbsolutePath(options.cwd);
  const ownerHome = validateWindowsAbsolutePath(options.ownerHome);
  const runtimeBase = validateRuntimeBase(options.runtimeBase, ownerHome);
  const systemRoot = validateWindowsAbsolutePath(options.systemRoot);
  const providerFile = validateWindowsAbsolutePath(options.providerFile);
  const codexFile = validateWindowsAbsolutePath(options.codexFile);
  const nodeFile = validateWindowsAbsolutePath(options.nodeFile);
  const gitDirectory = validateWindowsAbsolutePath(options.gitDirectory);
  const hubLibDirectory = validateWindowsAbsolutePath(options.hubLibDirectory);

  if (segCount(cwd) === 0) fail(ERR.PATH, 'invalid path');
  if (segCount(ownerHome) === 0) fail(ERR.PATH, 'invalid path');

  if (eq(cwd, ownerHome) || contains(cwd, ownerHome) || /^[A-Za-z]:\\Users$/i.test(cwd)) fail(ERR.PATH, 'invalid path');
  if (eq(cwd, systemRoot) || contains(systemRoot, cwd) || contains(cwd, systemRoot)) fail(ERR.PATH, 'invalid path');

  for (const f of [providerFile, codexFile, nodeFile]) {
    if (eq(cwd, f) || contains(cwd, f) || contains(f, cwd)) fail(ERR.PATH, 'invalid path');
  }
  for (const d of [gitDirectory, hubLibDirectory]) {
    if (eq(cwd, d) || contains(cwd, d) || contains(d, cwd)) fail(ERR.PATH, 'invalid path');
  }

  const claudeTree = ownerHome + '\\.claude';
  const grokTree = ownerHome + '\\.grok';
  if (contains(claudeTree, cwd) || eq(claudeTree, cwd)) fail(ERR.PATH, 'invalid path');
  if (contains(grokTree, cwd) || eq(grokTree, cwd)) fail(ERR.PATH, 'invalid path');
  if (contains(cwd, runtimeBase)) fail(ERR.PATH, 'invalid runtime base');
  for (const tree of [systemRoot, claudeTree, grokTree]) {
    if (contains(tree, runtimeBase) || contains(runtimeBase, tree)) fail(ERR.PATH, 'invalid runtime base');
  }

  const providerArgs = checkStringArray(options.providerArgs, 1024, 32760, 32760);
  for (const a of providerArgs) {
    if (BYPASS_FLAGS.has(a)) fail(ERR.ARGS, 'disallowed flag');
  }

  const proxyUrl = validateProxyUrl(options.proxyUrl);

  const runtimeDirectory = path.win32.join(runtimeBase,'runtime',options.rootFingerprint,actor);
  const tempDirectory = path.win32.join(runtimeDirectory,'tmp');
  const grokHome = path.win32.join(runtimeDirectory,'grok');
  const mcpDirectory=path.win32.join(runtimeDirectory,'mcp');
  if (contains(cwd, runtimeDirectory) || contains(runtimeDirectory, cwd)) fail(ERR.PATH, 'invalid runtime tree');

  let providerHome;
  let credentialFiles;
  let lockFile;
  let stateDirectory;

  if (actor === 'claude') {
    providerHome = ownerHome;
    const credsPath = ownerHome + '\\.claude\\.credentials.json';
    const claudeJson = ownerHome + '\\.claude.json';
    credentialFiles = Object.freeze([credsPath, claudeJson]);
    lockFile = null;
    const sanitized = cwd.replace(/[^A-Za-z0-9]/g, '-');
    stateDirectory = ownerHome + '\\.claude\\projects\\' + sanitized;
  } else {
    providerHome = grokHome;
    const authPath = ownerHome + '\\.grok\\auth.json';
    credentialFiles = Object.freeze([authPath]);
    lockFile = authPath + '.lock';
    stateDirectory = grokHome;
  }

  const execPaths = [providerFile, codexFile, nodeFile];
  for (const ex of execPaths) {
    if (contains(stateDirectory, ex) || eq(stateDirectory, ex)) fail(ERR.PATH, 'invalid path');
    if (contains(runtimeDirectory, ex) || contains(ex, runtimeDirectory)) fail(ERR.PATH, 'invalid runtime tree');
    for (const c of credentialFiles) {
      if (eq(c, ex)) fail(ERR.PATH, 'invalid path');
    }
  }

  const reads = new Set();
  const writes = new Set();
  reads.add(dirnameOf(providerFile));
  reads.add(dirnameOf(nodeFile));
  reads.add(gitDirectory);
  reads.add(hubLibDirectory);
  reads.add(cwd + '\\.git');
  reads.add(cwd + '\\.agents');
  reads.add(cwd + '\\.codex');
  reads.add(cwd + '\\.aws');
  reads.add(cwd + '\\.ai\\chat');
  reads.add(cwd + '\\.ai\\web-chat');
  reads.add(path.win32.join(path.win32.dirname(hubLibDirectory), 'mcp.js'));
  reads.add(path.win32.join(path.win32.dirname(hubLibDirectory), 'package.json'));
  reads.add(mcpDirectory);
  if (actor === 'grok') reads.add(grokHome + '\\config.toml');
  writes.add(cwd);
  writes.add(tempDirectory);
  if(actor==='grok')writes.add(grokHome);

  if (actor === 'claude') {
    reads.add(ownerHome + '\\.claude\\.credentials.json');
    reads.add(ownerHome + '\\.claude.json');
    writes.add(stateDirectory);
  } else {
    reads.add(ownerHome + '\\.grok\\auth.json');
    writes.add(lockFile);
  }

  for (const w of writes) {
    for (const ex of execPaths) {
      if (contains(w, ex) || eq(w, ex)) fail(ERR.PATH, 'invalid path');
    }
  }

  // Controller supplies exact runtime trees. A tree ancestor of credentials or
  // writable native state would turn an exact grant into broad home access.
  const runtimeTrees = [dirnameOf(providerFile), dirnameOf(nodeFile), gitDirectory, hubLibDirectory];
  for (const tree of runtimeTrees) {
    if (segCount(tree) === 0 || credentialFiles.some(file => contains(tree, file)) ||
        contains(tree, stateDirectory) || contains(stateDirectory, tree)) fail(ERR.PATH, 'invalid runtime tree');
    for (const privateTree of [runtimeDirectory, tempDirectory, grokHome, mcpDirectory]) {
      if (contains(tree, privateTree) || contains(privateTree, tree)) fail(ERR.PATH, 'invalid runtime tree');
    }
  }
  const grants = new Map();
  const add = (key, mode) => {
    const folded = key.toLowerCase();
    const previous = grants.get(folded);
    if (previous && previous.mode !== mode) fail(ERR.PATH, 'conflicting grants');
    if (!previous) grants.set(folded, { key, mode });
  };
  add(':minimal', 'read');
  for (const key of reads) add(key, 'read');
  for (const key of writes) add(key, 'write');
  const sorted = [...grants.values()].sort((a, b) => a.key.toLowerCase() < b.key.toLowerCase() ? -1 : a.key.toLowerCase() > b.key.toLowerCase() ? 1 : 0);
  const filesystemToml = 'permissions.hub-native.filesystem={' + sorted.map(({key, mode}) => JSON.stringify(key) + '=' + JSON.stringify(mode)).join(',') + '}';

  const args = [
    'sandbox', '-C', cwd, '-P', 'hub-native', '--include-managed-config',
    '-c', filesystemToml,
    '-c', 'permissions.hub-native.network.enabled=false',
    '-c', 'shell_environment_policy.inherit="all"',
    '-c', 'windows.sandbox="elevated"',
    '-c', 'features.windows_sandbox_service=false',
    '-c', 'windows.allow_mxc=false',
    '-c', 'features.prefer_mxc=false',
    '--', providerFile, ...providerArgs,
  ];

  const drive = systemRoot.slice(0, 2);
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: drive,
    USERPROFILE: ownerHome,
    HOME: providerHome,
    APPDATA: providerHome,
    LOCALAPPDATA: providerHome,
    ComSpec: systemRoot + '\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    // Grok detects the built-in PowerShell by absolute path but launches its
    // bare name. Keep lookup inside the already trusted Windows runtime.
    PATH: [systemRoot + '\\System32', ...(actor==='grok'?[systemRoot + '\\System32\\WindowsPowerShell\\v1.0']:[]), gitDirectory + '\\cmd', gitDirectory + '\\bin', dirnameOf(nodeFile)].join(';'),
    TEMP: tempDirectory,
    TMP: tempDirectory,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: '',
  };

  if (actor === 'claude') {
    env.CLAUDE_CODE_TMPDIR = tempDirectory;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
  } else {
    env.GROK_HOME = providerHome;
    env.GROK_AUTH_PATH = credentialFiles[0];
    env.GROK_MEMORY = '0';
    env.DO_NOT_TRACK = '1';
    env.OTEL_TRACES_EXPORTER = 'none';
  }

  const plan = {
    file: codexFile,
    args: Object.freeze(args.slice()),
    cwd,
    env: Object.freeze(Object.assign({}, env)),
    dirPin: Object.freeze({ root: cwd, rootFingerprint: options.rootFingerprint }),
    actor,
    codexSHA256: options.codexSHA256,
    providerFile,
    nodeFile,
    gitDirectory,
    hubLibDirectory,
    stateDirectory,
    runtimeBase,
    runtimeDirectory,
    mcpDirectory,
    tempDirectory,
    providerHome,
    credentialFiles,
    lockFile,
    maxWallMs,
  };

  return deepFreeze(plan);
}

module.exports = { createPlan, validateRuntimeBase };
