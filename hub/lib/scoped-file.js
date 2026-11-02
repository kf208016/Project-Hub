'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const managed = require('./managed-process');
const MAX = 200 * 1024;
let binary;
let activeCount=0;
const failure = (code, status = 409) => { const error = Error('Windows scoped file broker: ' + code); error.code = code; error.status = status; return error; };
const env = () => { const value = { ...process.env }; for (const key of ['HUB_LOCAL_TOKEN', 'HUB_MCP_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) delete value[key]; return value; };
function ensure() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || os.release() !== '10.0.26200') throw failure('UNSUPPORTED_PLATFORM');
  if (binary) return binary;
  const source = path.join(__dirname, '../windows/scoped-file.cs'), hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const runtime = path.join(__dirname, '../.runtime'); fs.mkdirSync(runtime, { recursive: true });
  const target = path.join(runtime, 'scoped-file-' + hash + '.exe');
  if (!fs.existsSync(target)) {
    const temp = path.join(runtime, 'scoped-file-' + crypto.randomUUID() + '.exe');
    try {
      const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/reference:System.Security.dll', '/out:' + temp, source], { env: env(), timeout: 30000, maxBuffer: 64 * 1024, windowsHide: true, stdio: 'pipe' });
      fs.renameSync(temp, target);
    } catch { fs.rmSync(temp, { force: true }); throw failure('COMPILATION_FAILED'); }
  }
  return (binary = target);
}
function invoke(request) {
  return new Promise((resolve, reject) => {
    if(activeCount>=8){reject(failure('BROKER_BUSY'));return;}
    const input=JSON.stringify(request);if(Buffer.byteLength(input)>2*1024*1024){reject(failure('REQUEST_TOO_LARGE',400));return;}
    let child;
    try { child = managed.spawn(ensure(), [], { cwd: path.join(__dirname, '..'), env: env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (error) { reject(error); return; }
    activeCount++;
    let stdout = '', failed = false;
    child.stdout.setEncoding('utf8');
    const timer = setTimeout(() => { failed = true; child.kill(); }, 15000);
    child.stdout.on('data', data => { if (Buffer.byteLength(stdout) + Buffer.byteLength(data) > 2 * 1024 * 1024) { failed = true; child.kill(); } else stdout += data; });
    child.stderr.resume(); child.stdin.on('error', () => {}); child.on('error', () => { failed = true; });
    child.once('close', code => { activeCount--;clearTimeout(timer); if (failed || code !== 0) return reject(failure('BROKER_INTERRUPTED'));
      let result; try { result = JSON.parse(stdout); } catch { return reject(failure('INVALID_RESPONSE')); }
      if (!result || result.ok !== true) {
        const recovery=typeof result?.code==='string'&&result.code.match(/^RECOVERY_REQUIRED_([a-f0-9]{32})$/);
        if(recovery)return reject(Object.assign(failure('RECOVERY_REQUIRED'),{partial:true,recordId:recovery[1]}));
        return reject(failure(typeof result?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : 'BROKER_REJECTED', Number.isSafeInteger(result?.status) && [400,403,404,409,415].includes(result.status) ? result.status : 409));
      }
      resolve(result);
    });
    child.stdin.end(input);
  });
}
function check(root, relative) {
  if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root) || typeof relative !== 'string' || relative.length > 32768 || root.length > 32768 || root.includes('\0') || relative.includes('\0')) throw failure('INVALID_PATH', 403);
}
async function probe() { return invoke({ mode: 'probe' }); }
async function identity(root) { check(root,'');return invoke({ mode:'identity', root }); }
async function pinOf(root, rootFingerprint) { const pin = rootFingerprint === undefined ? (await identity(root)).rootFingerprint : rootFingerprint; if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw failure('INVALID_ROOT_IDENTITY',403);return pin; }
async function read(root, relative, rootFingerprint) { check(root, relative);const pin=await pinOf(root,rootFingerprint);return invoke({ mode: 'read', root, path: relative, rootFingerprint:pin }); }
async function create(root, relative, text, expectedHash = 'missing', rootFingerprint) {
  check(root, relative); if (typeof text !== 'string' || Buffer.byteLength(text) > MAX || expectedHash !== 'missing') throw failure('OVERWRITE_NOT_SUPPORTED');
  const pin=await pinOf(root,rootFingerprint);
  return invoke({ mode: 'create', root, path: relative, text, expectedHash, rootFingerprint:pin });
}
async function overwrite(root,relative,text,expectedHash,rootFingerprint,journal) {
  check(root,relative);if(typeof text!=='string'||Buffer.byteLength(text)>MAX||!/^[a-f0-9]{64}$/.test(expectedHash||''))throw failure('INVALID_OVERWRITE',400);
  if(!journal||typeof journal.root!=='string'||!/^[a-f0-9]{64}$/.test(journal.rootFingerprint||''))throw failure('JOURNAL_AUTHORITY_REQUIRED',403);
  try{return await invoke({mode:'overwrite',root,path:relative,text,expectedHash,rootFingerprint:await pinOf(root,rootFingerprint),journalRoot:journal.root,journalRootFingerprint:journal.rootFingerprint});}catch(error){if(error.code==='BROKER_INTERRUPTED'||error.code==='INVALID_RESPONSE')Object.assign(error,{partial:true,recoveryRequired:true});throw error;}
}
async function recover(root,relative,recordId,expectedHash,rootFingerprint,journal) {
  check(root,relative);if(!/^[a-f0-9]{32}$/.test(recordId||'')||!/^[a-f0-9]{64}$/.test(expectedHash||'')||!journal||typeof journal.root!=='string'||!/^[a-f0-9]{64}$/.test(journal.rootFingerprint||''))throw failure('INVALID_RECOVERY',400);
  try{return await invoke({mode:'recover',root,path:relative,recordId,expectedHash,rootFingerprint:await pinOf(root,rootFingerprint),journalRoot:journal.root,journalRootFingerprint:journal.rootFingerprint});}catch(error){if(error.code==='BROKER_INTERRUPTED'||error.code==='INVALID_RESPONSE')Object.assign(error,{partial:true,recoveryRequired:true,recordId});throw error;}
}
function privateInvoke(request) {if(!['private-copy','private-inspect','private-remove','private-artifact-copy','private-artifact-inspect','private-artifact-remove','private-binary-copy','private-binary-inspect','private-config-write','private-config-recover','private-credential-create'].includes(request?.mode))throw failure('INVALID_PRIVATE_OPERATION');return invoke(request);}
module.exports = { probe, read, create, overwrite, recover, identity, active:()=>activeCount, privateInvoke };
