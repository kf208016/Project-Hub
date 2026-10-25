'use strict';
// A bounded, read-only native helper. Unknown results never become "unrelated".
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { localPath } = require('./safe-path');

const MAX_BATCH = 128, MAX_OUTPUT = 16 * 1024 * 1024, TIMEOUT = 5000;
const STATUSES = new Set(['ok','invalid-request','access-denied','not-found','pid-reused','unsupported-layout','read-failed','changed','invalid-path']);
let binary;
function ensureReader() {
  if (binary) return localPath(binary);
  const source = localPath(path.join(__dirname, '../windows/process-cwd.cs'));
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const dir = localPath(path.join(__dirname, '../.runtime'), {allowMissing:true});
  fs.mkdirSync(dir, {recursive:true});
  const file = localPath(path.join(dir, `process-cwd-${hash}.exe`), {allowMissing:true});
  if (!fs.existsSync(file)) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const temp = path.join(dir, `process-cwd-${randomUUID()}.exe`);
    try {
      execFileSync(compiler, ['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll','/out:'+temp,source], {windowsHide:true,timeout:30000,stdio:'pipe'});
      fs.renameSync(temp, file);
    } catch (cause) {
      fs.rmSync(temp, {force:true});
      const error = Error('Windows 工作目錄讀取元件無法編譯'); error.cause = cause; throw error;
    }
  }
  if (!fs.statSync(file).isFile()) throw Error('Windows 工作目錄讀取元件格式無效');
  return (binary = file);
}

// CIM CreationDate has six meaningful fractional digits. Retain those digits
// when comparing the handle FILETIME; Date.parse alone loses PID identity.
function normalizeSince(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6,7})Z$/);
  if (!match || Number(value.slice(0,4)) < 1601) return null;
  const ms = Date.parse(match[1]+'.'+match[2].slice(0,3)+'Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,19) !== match[1]) return null;
  return match[1]+'.'+match[2].padEnd(7,'0')+'Z';
}
function creationTicks(value) {
  const normalized = normalizeSince(value);
  if (!normalized) return null;
  return BigInt(Date.parse(normalized.slice(0,19)+'Z')) * 10000n + BigInt(normalized.slice(20,27));
}
function sameCreation(a, b) {
  const left = creationTicks(a), right = creationTicks(b);
  return left !== null && right !== null && left / 10n === right / 10n;
}
function unknown(row, status = 'helper-failed') {
  return {pid:row.pid,creationTime:'',cwd:'',status};
}
function validCwd(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 32767 || !/^[a-z]:\\/i.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid cwd');
  const canonical = localPath(value);
  if (!fs.statSync(canonical).isDirectory()) throw Error('Invalid cwd');
  return canonical;
}
function parseResults(raw, rows, validate = validCwd) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(data) || data.length !== rows.length) throw Error('Invalid cwd result');
  const wanted = new Map(rows.map(row => [row.pid,row])), result = new Map();
  for (const row of data) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'creationTime,cwd,pid,status' || !Number.isInteger(row.pid) || !wanted.has(row.pid) || result.has(row.pid) || !STATUSES.has(row.status) || typeof row.cwd !== 'string' || typeof row.creationTime !== 'string') throw Error('Invalid cwd result');
    if (row.creationTime && !normalizeSince(row.creationTime)) throw Error('Invalid creation time');
    if (row.status !== 'ok' && row.cwd !== '') throw Error('Unknown cwd must be empty');
    let next = {...row};
    if (row.status === 'ok') {
      if (!sameCreation(wanted.get(row.pid).since, row.creationTime)) next = {...row,cwd:'',status:'pid-reused'};
      else { try { next.cwd = validate(row.cwd); } catch { next = {...row,cwd:'',status:'invalid-path'}; } }
    }
    result.set(row.pid, next);
  }
  return rows.map(row => result.get(row.pid));
}
function execute(file, input, {timeout = TIMEOUT} = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [], {windowsHide:true,timeout,maxBuffer:MAX_OUTPUT,encoding:'utf8',env:{SystemRoot:process.env.SystemRoot || 'C:\\Windows',WINDIR:process.env.WINDIR || 'C:\\Windows'}}, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function create(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || execute, ensure = options.ensure || ensureReader;
  return async rows => {
    if (!Array.isArray(rows)) throw Error('Invalid process list');
    if (!rows.length) return [];
    if (platform !== 'win32' || rows.length > MAX_BATCH || rows.some(row => !row || !Number.isInteger(row.pid) || row.pid <= 0) || new Set(rows.map(row => row.pid)).size !== rows.length) return rows.map(row => unknown(row || {}, 'invalid-request'));
    const valid = rows.filter(row => normalizeSince(row.since)), missing = new Set(rows.filter(row => !normalizeSince(row.since)).map(row => row.pid));
    if (!valid.length) return rows.map(row => unknown(row, 'invalid-request'));
    let parsed;
    try {
      const input = JSON.stringify(valid.map(({pid,since}) => ({pid,since:normalizeSince(since)})));
      const raw = await run(ensure(), input, {timeout:options.timeout || TIMEOUT});
      if (typeof raw === 'string' && Buffer.byteLength(raw) > MAX_OUTPUT) throw Error('Cwd result is too large');
      parsed = parseResults(raw, valid, options.validatePath || validCwd);
    } catch { return rows.map(row => unknown(row, missing.has(row.pid) ? 'invalid-request' : 'helper-failed')); }
    const result = new Map(parsed.map(row => [row.pid,row]));
    return rows.map(row => result.get(row.pid) || unknown(row,'invalid-request'));
  };
}
module.exports = {create,query:create(),ensureReader,normalizeSince,sameCreation,parseResults};
