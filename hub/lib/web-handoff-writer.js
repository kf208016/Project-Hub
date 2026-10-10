'use strict';

// Internal controller broker. This module is not exposed to MCP or public grants.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const managed = require('./managed-process');
const LIMITS = Object.freeze({ 'raw-result': 256 * 1024, row: 2 * 1024 * 1024, task: 4 * 1024 * 1024, metadata: 1024 * 1024, log: 64 * 1024 * 1024 });
// An interrupted child may leave one of these private temporary files. Its
// filename carries no receipt authority: inspect only, never adopt or remove
// an unknown file as part of receipt recovery.
const PENDING_TEMP_PATTERN = '^\\.hub-web-[a-f0-9]{32}\\.tmp$';
const isPendingTempName = name => typeof name === 'string' && new RegExp(PENDING_TEMP_PATTERN, 'i').test(name);
const WIRE_LIMIT = 400 * 1024 * 1024;
let binary, activeCount = 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function failure(code, status = 409) { return Object.assign(new Error('Windows web handoff writer: ' + code), { code, status }); }
function environment() {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|CREDENTIAL|COOKIE|HUB_PROCESS_SPEC/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}
function checkPath(root, relative) {
  if (typeof root !== 'string' || !/^[a-z]:[\\/]/i.test(root) || typeof relative !== 'string' || root.length > 32768 || relative.length > 32768 || root.includes('\0') || relative.includes('\0')) throw failure('INVALID_PATH', 403);
}
function validText(text, max) {
  if (typeof text !== 'string' || text.includes('\0')) throw failure('INVALID_CONTENT', 400);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure('ENCODING_REJECTED', 415); }
    else if (c >= 0xdc00 && c <= 0xdfff) throw failure('ENCODING_REJECTED', 415);
  }
  if (Buffer.byteLength(text, 'utf8') > max) throw failure('CONTENT_TOO_LARGE', 413);
}
function ensure() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || os.release() !== '10.0.26200') throw failure('UNSUPPORTED_PLATFORM');
  if (binary) return binary;
  const source = path.join(__dirname, '../windows/web-handoff-writer.cs');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const runtime = path.join(__dirname, '../.runtime'); fs.mkdirSync(runtime, { recursive: true });
  const target = path.join(runtime, 'web-handoff-writer-' + hash + '.exe');
  if (!fs.existsSync(target)) {
    const temp = path.join(runtime, 'web-handoff-writer-' + crypto.randomUUID() + '.exe');
    try {
      const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + temp, source], { env: environment(), timeout: 30000, maxBuffer: 64 * 1024, windowsHide: true, stdio: 'pipe' });
      fs.renameSync(temp, target);
    } catch { fs.rmSync(temp, { force: true }); throw failure('COMPILATION_FAILED'); }
  }
  return (binary = target);
}
function invoke(request, mutating = false) {
  return new Promise((resolve, reject) => {
    if (activeCount >= 2) return reject(failure('BROKER_BUSY'));
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > WIRE_LIMIT) return reject(failure('REQUEST_TOO_LARGE', 413));
    let child;
    try { child = managed.spawn(ensure(), [], { cwd: path.join(__dirname, '..'), env: environment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { return reject(error); }
    activeCount++;
    const chunks = []; let bytes = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > WIRE_LIMIT) { failed = true; child.kill(); } else chunks.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {}); child.on('error', () => { failed = true; });
    child.once('close', code => {
      activeCount--; clearTimeout(timer);
      const interrupted = () => Object.assign(failure('BROKER_INTERRUPTED'), mutating ? { partial: true, recoveryRequired: true, ...(request.recordId ? { recordId: request.recordId } : {}) } : {});
      if (failed || code !== 0) return reject(interrupted());
      let result; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { return reject(Object.assign(failure('INVALID_RESPONSE'), mutating ? { partial: true, recoveryRequired: true } : {})); }
      if (!result || result.ok !== true) {
        const error = failure(typeof result?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : 'BROKER_REJECTED', [400, 403, 404, 409, 413, 415, 507].includes(result?.status) ? result.status : 409);
        if (result?.partial === true) Object.assign(error, { partial: true, recoveryRequired: true, ...(typeof result.recordId === 'string' && /^[a-f0-9]{32}$/.test(result.recordId) ? { recordId: result.recordId } : {}) });
        return reject(error);
      }
      resolve(result);
    });
    child.stdin.end(input);
  });
}
async function identity(root, options = {}) {
  checkPath(root, '');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['create', 'parentRoot', 'parentFingerprint'].includes(k)) || (options.create !== undefined && typeof options.create !== 'boolean')) throw failure('INVALID_OPTIONS', 400);
  const request = { mode: 'identity', root, create: options.create === true };
  if (options.parentRoot !== undefined || options.parentFingerprint !== undefined) {
    checkPath(options.parentRoot, ''); if (!digest(options.parentFingerprint)) throw failure('INVALID_ROOT_IDENTITY', 403);
    Object.assign(request, { parentRoot: options.parentRoot, parentFingerprint: options.parentFingerprint });
  }
  return invoke(request);
}
async function pin(root, fingerprint) {
  const result = fingerprint === undefined ? (await identity(root)).rootFingerprint : fingerprint;
  if (!digest(result)) throw failure('INVALID_ROOT_IDENTITY', 403);
  return result;
}
async function inspect(root, relative, options = {}) {
  checkPath(root, relative);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['text', 'maxBytes', 'rootFingerprint'].includes(k)) || (options.text !== undefined && typeof options.text !== 'boolean')) throw failure('INVALID_OPTIONS', 400);
  const maxBytes = options.maxBytes === undefined ? LIMITS.metadata : options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > LIMITS.log) throw failure('INVALID_SIZE_LIMIT', 400);
  return invoke({ mode: 'inspect', root, path: relative, text: options.text === true, maxBytes, rootFingerprint: await pin(root, options.rootFingerprint) });
}
async function capacity(root, options = {}) {
  checkPath(root, '');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => k !== 'rootFingerprint')) throw failure('INVALID_OPTIONS', 400);
  return invoke({ mode: 'capacity', root, rootFingerprint: await pin(root, options.rootFingerprint) });
}
async function create(root, relative, text, rootFingerprint, options = {}) {
  checkPath(root, relative);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => k !== 'kind')) throw failure('INVALID_OPTIONS', 400);
  const kind = options.kind === undefined ? 'metadata' : options.kind;
  if (!Object.hasOwn(LIMITS, kind)) throw failure('INVALID_KIND', 400);
  validText(text, LIMITS[kind]);
  return invoke({ mode: 'create', root, path: relative, text, kind, rootFingerprint: await pin(root, rootFingerprint) }, true);
}
// Immutable receipt revision creation. The native helper writes and flushes a
// private same-parent temp before noReplace rename, then verifies the held
// final handle. A rejected/interrupted call must be reconciled read-only.
async function atomicCreate(root, relative, text, rootFingerprint) {
  return create(root, relative, text, rootFingerprint, { kind: 'metadata' });
}
async function mutate(mode, root, relative, text, before, journal) {
  checkPath(root, relative); validText(text, mode === 'append' ? LIMITS.row : LIMITS.task);
  const missing = mode === 'append' && before?.missing === true && before.sha256 === 'missing' && before.fileFingerprint === 'missing';
  if (!before || typeof before !== 'object' || Array.isArray(before) || !digest(before.rootFingerprint) || (!missing && (!digest(before.sha256) || !digest(before.fileFingerprint)))) throw failure('INVALID_BEFORE_IDENTITY', 400);
  if (!journal || typeof journal !== 'object' || Array.isArray(journal) || !digest(journal.rootFingerprint)) throw failure('JOURNAL_AUTHORITY_REQUIRED', 403);
  checkPath(journal.root, '');
  const recordId = journal.recordId === undefined ? crypto.randomUUID().replaceAll('-', '') : journal.recordId;
  if (typeof recordId !== 'string' || !/^[a-f0-9]{32}$/.test(recordId)) throw failure('INVALID_RECORD', 400);
  return invoke({ mode, root, path: relative, text, expectedHash: before.sha256, expectedFingerprint: before.fileFingerprint, rootFingerprint: before.rootFingerprint, journalRoot: journal.root, journalRootFingerprint: journal.rootFingerprint, recordId }, true);
}
async function recover(root, relative, current, journal) {
  checkPath(root, relative);
  if (!current || !digest(current.rootFingerprint) || !digest(current.sha256) || !digest(current.fileFingerprint)) throw failure('INVALID_BEFORE_IDENTITY', 400);
  if (!journal || !digest(journal.rootFingerprint) || typeof journal.recordId !== 'string' || !/^[a-f0-9]{32}$/.test(journal.recordId)) throw failure('INVALID_RECOVERY', 400);
  checkPath(journal.root, '');
  return invoke({ mode: 'recover', root, path: relative, expectedHash: current.sha256, expectedFingerprint: current.fileFingerprint, rootFingerprint: current.rootFingerprint, journalRoot: journal.root, journalRootFingerprint: journal.rootFingerprint, recordId: journal.recordId }, true);
}
module.exports = { LIMITS, PENDING_TEMP_PATTERN, isPendingTempName, identity, inspect, capacity, create, atomicCreate, overwrite: (root, relative, text, before, journal) => mutate('overwrite', root, relative, text, before, journal), append: (root, relative, text, before, journal) => mutate('append', root, relative, text, before, journal), recover, active: () => activeCount };
