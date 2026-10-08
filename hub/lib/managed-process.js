'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

let binary;
function ensureRunner() {
  if (binary) return binary;
  const source = path.join(__dirname, '../windows/job-runner.cs');
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const dir = path.join(__dirname, '../.runtime');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `job-runner-${hash}.exe`);
  if (!fs.existsSync(file)) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const temp = path.join(dir, `job-runner-${randomUUID()}.exe`);
    try {
      execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + temp, source], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
      fs.renameSync(temp, file);
    } catch (e) {
      fs.rmSync(temp, { force: true });
      const error = new Error('Windows 程序管理元件無法編譯；未啟動 CLI。');
      error.cause = e; throw error;
    }
  }
  return (binary = file);
}

// ChildProcess-shaped adapter. A Job is assigned while the CLI is suspended.
// A private owner pipe kills the Job when this Node process exits or crashes.
function managedSpawn(file, args, options = {}) {
  if (process.platform !== 'win32') return spawn(file, args, options);
  if (!path.isAbsolute(file) || /[\0]/.test(file) || !Array.isArray(args) || args.some(x => typeof x !== 'string' || x.includes('\0'))) throw new Error('Invalid managed process invocation');
  const runner = ensureRunner();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.pid = undefined;
  let real, owner, ended = false, ready = false, killed = false, pending = '';
  const pipe = 'project-hub-' + randomUUID(), nonce = randomUUID();
  const spec = JSON.stringify({ file, args, cwd: options.cwd || process.cwd(), pipe, nonce });
  if (spec.length > 24000) throw new Error('Windows CLI arguments exceed the managed process limit');
  const server = net.createServer(socket => {
    let hello = '';
    socket.setTimeout(10000, () => socket.destroy());
    const accept = data => {
      hello += data.toString('utf8');
      if (hello.length > 128) return socket.destroy();
      if (!hello.endsWith('\n')) return;
      if (hello !== nonce + '\n' || owner) return socket.destroy();
      owner = socket; socket.setTimeout(0); socket.removeListener('data', accept); server.close();
    };
    socket.on('data', accept); socket.on('error', () => {});
  });
  const finish = (code, signal) => {
    if (ended) return; ended = true; clearTimeout(timer);
    owner?.destroy(); server.close(); child.stdin.destroy(); child.stdout.end(); child.stderr.end();
    child.exitCode = code; child.signalCode = signal;
    if (!ready && !killed) child.emit('error', new Error('Windows 程序管理元件啟動失敗；CLI 未確認啟動。'));
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => { killed = true; owner?.destroy(); if (real) return real.kill(signal); finish(null, signal); return true; };
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { child.emit('error', new Error('Windows 程序啟動逾時')); child.kill(); }, 15000);
  server.on('error', e => { if (!ended) { child.emit('error', e); child.kill(); } });
  server.listen('\\\\.\\pipe\\' + pipe, () => {
    if (ended) return server.close();
    real = spawn(runner, [], { cwd: options.cwd, env: { ...(options.env || process.env), HUB_PROCESS_SPEC: spec }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.pid = real.pid;
    child.stdin.pipe(real.stdin); real.stdin.on('error', () => {});
    real.stdout.pipe(child.stdout, { end: false });
    real.stderr.setEncoding('utf8');
    real.stderr.on('data', data => {
      if (ready) return child.stderr.write(data);
      pending += data;
      if (pending.length > 8192) { child.stderr.write('Windows process supervisor output exceeded its limit'); return child.kill(); }
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        const match = line.trim().match(new RegExp('^HUB_JOB_READY:' + nonce + ':(\\d+)$'));
        if (match && !ready) { ready = true; child.commandPid = Number(match[1]); clearTimeout(timer); child.emit('spawn'); }
        else child.stderr.write(line + '\n');
      }
    });
    real.on('error', e => { child.emit('error', e); });
    real.on('close', (code, signal) => { if (pending) child.stderr.write(pending); finish(code, signal); });
  });
  return child;
}
module.exports = { spawn: managedSpawn, ensureRunner };
