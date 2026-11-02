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
  const pinSource = path.join(__dirname, '../windows/pinned-root.cs');
  const hash = createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(pinSource)).digest('hex');
  const dir = path.join(__dirname, '../.runtime');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `job-runner-${hash}.exe`);
  if (!fs.existsSync(file)) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const temp = path.join(dir, `job-runner-${randomUUID()}.exe`);
    try {
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', '/out:' + temp, source, pinSource], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
      // Publish once atomically. Concurrent Hub/test processes may compile the
      // same source; Windows cannot replace a runner that is already executing.
      try { fs.linkSync(temp, file); }
      catch(e) { if(e.code!=='EEXIST')throw e; }
      fs.rmSync(temp, { force: true });
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
  if(options.dirPin && (typeof options.dirPin.root!=='string'||!path.isAbsolute(options.dirPin.root)||options.dirPin.root.includes('\0')||!/^[a-f0-9]{64}$/.test(options.dirPin.rootFingerprint||'')||Object.keys(options.dirPin).some(k=>!['root','rootFingerprint'].includes(k))))throw new Error('Invalid directory pin');
  const runner = ensureRunner();
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.pid = undefined;
  child.cleanupReceipt = null;
  let real, owner, ended = false, ready = false, killed = false, pending = '';
  let ownerEnded=false, cleanupBuffer='', cleanupInvalid=false, candidateReceipt=null, deferredFinish=null, receiptTimer;
  const pipe = 'project-hub-' + randomUUID(), nonce = randomUUID();
  const spec = JSON.stringify({ file, args, cwd: options.cwd || process.cwd(), pipe, nonce, ...(options.dirPin?{dirPin:options.dirPin}:{}) });
  if (spec.length > 24000) throw new Error('Windows CLI arguments exceed the managed process limit');
  const server = net.createServer(socket => {
    let hello = '';
    socket.setTimeout(10000, () => socket.destroy());
    const accept = data => {
      hello += data.toString('utf8');
      if (hello.length > 1100 || !hello.includes('\n') && hello.length>64) return socket.destroy();
      if (!hello.includes('\n')) return;
      const split=hello.indexOf('\n'), tail=hello.slice(split+1);
      if (hello.slice(0,split) !== nonce || owner) return socket.destroy();
      owner = socket; socket.setTimeout(0); socket.removeListener('data', accept); server.close();
      const receiptData=data=>{
        if(cleanupInvalid)return;
        cleanupBuffer+=data.toString('utf8');
        if(Buffer.byteLength(cleanupBuffer)>1024){cleanupInvalid=true;child.cleanupReceipt=null;return;}
        if(!cleanupBuffer.includes('\n'))return;
        try {
          if(candidateReceipt||cleanupBuffer.indexOf('\n')!==cleanupBuffer.length-1)throw Error();
          const row=JSON.parse(cleanupBuffer.slice(0,-1));
          if(Object.keys(row).sort().join(',')!=='cleanupVerified,exitCode,nonce,ownedTreeEmpty,rootExited'||row.nonce!==nonce||row.rootExited!==true||row.ownedTreeEmpty!==true||row.cleanupVerified!==true||!Number.isInteger(row.exitCode)||row.exitCode<0||row.exitCode>4294967295)throw Error();
          candidateReceipt=Object.freeze({rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:row.exitCode});
        }catch{cleanupInvalid=true;child.cleanupReceipt=null;}
      };
      socket.on('data',receiptData);
      socket.once('end',()=>{ownerEnded=true;if(!ended&&!cleanupInvalid&&candidateReceipt){child.cleanupReceipt=candidateReceipt;child.emit('cleanup',child.cleanupReceipt);}if(deferredFinish)finish(...deferredFinish);});
      socket.once('close',()=>{ownerEnded=true;if(deferredFinish)finish(...deferredFinish);});
      if(tail)receiptData(Buffer.from(tail));
      if(killed)socket.write('STOP\n');
    };
    socket.on('data', accept); socket.on('error', () => {});
  });
  const finish = (code, signal) => {
    if (ended) return;
    // Pipe bytes can reach Node after the runner exit event. Drain this private
    // channel before publishing close; an absent receipt remains unknown.
    if(owner&&!ownerEnded&&!owner.destroyed&&!deferredFinish){deferredFinish=[code,signal];receiptTimer=setTimeout(()=>finish(code,signal),250);return;}
    ended = true; clearTimeout(timer); clearTimeout(receiptTimer);
    owner?.destroy(); server.close(); child.stdin.destroy(); child.stdout.end(); child.stderr.end();
    child.exitCode = code; child.signalCode = signal;
    if (!ready && !killed) child.emit('error', new Error('Windows 程序管理元件啟動失敗；CLI 未確認啟動。'));
    child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  child.kill = (signal = 'SIGTERM') => { killed = true; if(owner&&!owner.destroyed){owner.write('STOP\n');return true;} if (real) {if(options.dirPin)return true;return real.kill(signal);} if(options.dirPin)return true;finish(null, signal);return true; };
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
      // After readiness, stderr is a stream; send this chunk's unfinished tail
      // before the next chunk instead of holding it until the runner closes.
      if (ready && pending) { const tail = pending; pending = ''; child.stderr.write(tail); }
    });
    real.on('error', e => { child.emit('error', e); });
    real.on('close', (code, signal) => { if (pending) child.stderr.write(pending); finish(code, signal); });
  });
  return child;
}
module.exports = { spawn: managedSpawn, ensureRunner };
