'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Local dependency fixtures exercise the real managedSpawn stderr listener.
// They do not create a native Job, SSH connection, password prompt or process.
function fixture(t) {
  const filename = path.join(__dirname, '../lib/managed-process.js');
  const runner = new EventEmitter();
  runner.pid = 5001;
  runner.stdin = new PassThrough();
  runner.stdout = new PassThrough();
  runner.stderr = new PassThrough();
  runner.kill = () => true;
  let nonce, serverClosed = false;
  const server = new EventEmitter();
  server.listen = (_name, callback) => callback();
  server.close = () => { serverClosed = true; };
  const dependencies = {
    'node:fs': { readFileSync: () => Buffer.from('fixture source'), mkdirSync() {}, existsSync: () => true },
    'node:path': path.win32,
    'node:net': { createServer: listener => { server.connectionListener=listener;return server; } },
    'node:child_process': {
      spawn(_file, _args, options) {
        nonce = JSON.parse(options.env.HUB_PROCESS_SPEC).nonce;
        return runner;
      },
      execFileSync() { throw Error('Fixture must not compile or execute native code'); },
    },
  };
  const localRequire = name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name);
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', {
    Buffer,
    process: { platform: 'win32', env: {}, cwd: () => 'C:\\fixture' },
    setTimeout,
    clearTimeout,
  }, { filename })(localRequire, module, module.exports, 'C:\\fixture\\hub\\lib');
  const child = module.exports.spawn('C:\\fixture\\command.exe', []);
  let output = '', spawned = 0, closed = false;
  const errors = [];
  child.stderr.on('data', value => { output += value.toString(); });
  child.on('spawn', () => { spawned++; });
  child.on('error', error => { errors.push(error); });
  child.on('close', () => { closed = true; });
  const close = () => { if (!closed) runner.emit('close', 0, null); };
  t.after(close);
  return {
    child,
    connect() {
      const socket=new EventEmitter();socket.destroyed=false;socket.writes=[];
      socket.setTimeout=()=>{};socket.write=value=>socket.writes.push(value);
      socket.destroy=()=>{socket.destroyed=true;socket.emit('close');};
      server.connectionListener(socket);
      return {socket,hello:nonce+'\n',receipt:JSON.stringify({nonce,rootExited:true,ownedTreeEmpty:true,cleanupVerified:true,exitCode:0})+'\n'};
    },
    marker: 'HUB_JOB_READY:' + nonce + ':6001\n',
    write(value) { runner.stderr.write(value); },
    output: () => output,
    spawned: () => spawned,
    close,
    verifyClosed(expectedErrors = 0) {
      assert.equal(closed, true);
      assert.equal(serverClosed, true);
      assert.equal(errors.length, expectedErrors);
    },
  };
}

test('fixture managed stderr delivers ready-chunk partial tail before later chunks', t => {
  const run = fixture(t);
  run.write(run.marker + 'Authenticated to ');
  assert.equal(run.spawned(), 1);
  assert.equal(run.child.commandPid, 6001);
  assert.equal(run.output(), 'Authenticated to ');
  run.write('fixture using "password".\nnext diagnostic\n');
  const expected = 'Authenticated to fixture using "password".\nnext diagnostic\n';
  assert.equal(run.output(), expected);
  run.close();
  assert.equal(run.output(), expected);
  run.verifyClosed();
});

test('cleanup receipt is accepted only after complete authenticated channel EOF', t=>{
  const run=fixture(t);run.write(run.marker);
  const {socket,hello,receipt}=run.connect();
  socket.emit('data',Buffer.from(hello+receipt));
  assert.equal(run.child.cleanupReceipt,null);
  socket.emit('end');
  assert.equal(run.child.cleanupReceipt?.cleanupVerified,true);
  run.close();run.verifyClosed();
});

test('duplicate or trailing cleanup channel data never verifies cleanup', t=>{
  for(const tail of ['extra', '\n']) {
    const run=fixture(t);run.write(run.marker);
    const {socket,hello,receipt}=run.connect();
    socket.emit('data',Buffer.from(hello));socket.emit('data',Buffer.from(receipt));
    socket.emit('data',Buffer.from(tail));socket.emit('end');
    assert.equal(run.child.cleanupReceipt,null);
    run.close();run.verifyClosed();
  }
});

test('fixture managed stderr preserves diagnostics around a split ready marker', t => {
  const run = fixture(t);
  const split = Math.floor(run.marker.length / 2);
  run.write('earlier diagnostic\n' + run.marker.slice(0, split));
  assert.equal(run.output(), 'earlier diagnostic\n');
  assert.equal(run.spawned(), 0);
  run.write(run.marker.slice(split) + 'complete diagnostic\npartial');
  assert.equal(run.output(), 'earlier diagnostic\ncomplete diagnostic\npartial');
  run.write(' tail\n');
  assert.equal(run.output(), 'earlier diagnostic\ncomplete diagnostic\npartial tail\n');
  assert.equal(run.spawned(), 1);
  run.close();
  run.verifyClosed();
});

test('fixture managed stderr keeps byte order at every ready/diagnostic split boundary', t => {
  const probe = fixture(t);
  const markerLength = probe.marker.length;
  probe.write(probe.marker);
  probe.close();
  probe.verifyClosed();
  const diagnostic = 'first line\nlast partial line';
  for (let split = 0; split <= markerLength + diagnostic.length; split++) {
    const run = fixture(t);
    const wire = run.marker + diagnostic;
    run.write(wire.slice(0, split));
    run.write(wire.slice(split));
    assert.equal(run.spawned(), 1, 'split ' + split);
    assert.equal(run.output(), diagnostic, 'split ' + split);
    run.close();
    assert.equal(run.output(), diagnostic, 'closed split ' + split);
    run.verifyClosed();
  }
});

test('fixture managed stderr preserves unfinished diagnostics when readiness is never received', t => {
  const run = fixture(t);
  run.write('startup error\nunterminated diagnostic');
  assert.equal(run.output(), 'startup error\n');
  // The existing refusal reports an error when the supervisor never announces ready.
  run.close();
  assert.equal(run.output(), 'startup error\nunterminated diagnostic');
  assert.equal(run.spawned(), 0);
  run.verifyClosed(1);
});
