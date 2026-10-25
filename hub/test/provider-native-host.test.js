'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');
const {PassThrough}=require('node:stream');

// This test suite mocks module resolution for the two trusted local
// dependencies (./provider-native-plan and ./safe-path) so that the
// host module under test can be exercised deterministically without
// touching any real filesystem, auth, or provider binaries.
//
// All "fixtures" below are explicitly synthetic/mocked and are only
// used inside this test file; the production module
// (provider-native-host.js) contains no test-only bypasses.

const HOST_PATH = require.resolve('../lib/provider-native-host');
// Capture the module before mocking readFileSync. Returning fixture binary
// buffers to Node's source loader would test the loader, not host admission.
const HOST_SOURCE = require('node:fs').readFileSync(HOST_PATH,'utf8');

function makePlanFixture(overrides) {
  const base = {
    file: 'C:/fake/codex.exe',
    args: ['--sandbox', 'run'],
    cwd: 'C:/fake/cwd',
    env: { PATH: 'C:/fake/bin', USERPROFILE:'C:/fake/ownerhome', HOME:'C:/fake/providerhome', APPDATA:'C:/fake/providerhome', LOCALAPPDATA:'C:/fake/providerhome', NATIVE_CONNECT_URL: 'http://127.0.0.1:0/ephemeral' },
    dirPin: 'C:/fake/cwd',
    actor: 'claude',
    codexSHA256: 'codexhash-fixture-0000000000000000000000000000000000000000',
    providerFile: 'C:/fake/claude.exe',
    nodeFile: process.execPath,
    gitDirectory: 'C:/fake/cwd/.git',
    hubLibDirectory: 'C:/fake/hublib',
    stateDirectory: 'C:/fake/state',
    runtimeDirectory:'C:/fake/state/runtime',
    runtimeBase:'C:/fake/state/runtime-base',
    tempDirectory: 'C:/fake/temp',
    providerHome: 'C:/fake/providerhome',
    credentialFiles: ['C:/fake/auth/claude.json'],
    lockFile: null,
    maxWallMs: 30000
  };
  const plan=Object.assign({},base,overrides);
  // Fixture digest only: crypto is mocked in positive admission cases. The
  // separate mismatch case uses actual SHA-256 and must refuse before spawn.
  plan.codexSHA256=plan.actor==='grok'?'021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94':CLAUDE_HASH;
  return Object.freeze(plan);
}

function withMockedDeps(t, { plan, fsOverrides, cryptoOverrides, osOverrides, safePathImpl }) {
  const fs = require('fs');
  const os = require('os');
  const crypto = require('crypto');

  // Mock provider-native-plan and safe-path via Module._load interception
  const planPath = require.resolve('../lib/provider-native-plan');
  const safePathPath = require.resolve('../lib/safe-path');

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === HOST_PATH) {
      if (request === './provider-native-plan') {
        return { createPlan: () => plan };
      }
      if (request === './safe-path') {
        return { localPath: safePathImpl || ((p) => p) };
      }
    }
    return originalLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = originalLoad; });

  delete require.cache[HOST_PATH];
  delete require.cache[planPath];
  delete require.cache[safePathPath];

  if (fsOverrides) {
    // Native hashFile now reads bounded chunks through a descriptor.
    let next=0;const handles=new Map();
    t.mock.method(fs,'openSync',file=>{const fd=++next;handles.set(fd,{bytes:fsOverrides.readFileSync?.(file)||Buffer.from('fixture'),at:0});return fd;});
    t.mock.method(fs,'readSync',(fd,buffer,offset,length)=>{assert.equal(length,128*1024);const row=handles.get(fd),n=Math.min(length,row.bytes.length-row.at);row.bytes.copy(buffer,offset,row.at,row.at+n);row.at+=n;return n;});
    t.mock.method(fs,'closeSync',fd=>handles.delete(fd));
    for (const [fn, impl] of Object.entries(fsOverrides)) {
      t.mock.method(fs, fn, impl);
    }
  }
  if (cryptoOverrides) {
    for (const [fn, impl] of Object.entries(cryptoOverrides)) {
      t.mock.method(crypto, fn, impl);
    }
  }
  if (osOverrides) {
    for (const [fn, impl] of Object.entries(osOverrides)) {
      t.mock.method(os, fn, impl);
    }
  }

  const loaded=new Module(HOST_PATH,module);
  loaded.filename=HOST_PATH;
  loaded.paths=Module._nodeModulePaths(path.dirname(HOST_PATH));
  loaded._compile(HOST_SOURCE,HOST_PATH);
  return loaded.exports;
}

function fakeStat({ isFile = true, isDir = false, isSymlink = false, nlink = 1, size = 1024 }) {
  return {
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    nlink,
    size
  };
}

const CLAUDE_HASH = 'fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a';

test('exports PROVIDER_HASHES and GROK_CONFIG exact content', () => {
  const mod = require('../lib/provider-native-host');
  assert.equal(mod.PROVIDER_HASHES.claude, CLAUDE_HASH);
  assert.equal(mod.PROVIDER_HASHES.grok, '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94');
  assert.match(mod.GROK_CONFIG, /\[memory\]\nenabled = false/);
  assert.match(mod.GROK_CONFIG, /\[memory_v2\]\nenabled = false/);
  assert.match(mod.GROK_CONFIG, /\[compat\.claude\]/);
  assert.match(mod.GROK_CONFIG, /load_envrc = false/);
});

test('rejects when supervisedSpawn is not a function (no spawn before checks)', (t) => {
  const plan = makePlanFixture({});
  const fs = require('fs');
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: () => fakeStat({ isFile: true, nlink: 1, size: 1024 }),
      readFileSync: () => Buffer.alloc(1024),
      mkdirSync: () => {}
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, null), (err) => err.code === 'NATIVE_ENDPOINT_INVALID' || err.code === 'NATIVE_PLATFORM_UNSUPPORTED');
});

test('rejects on provider hash mismatch (synthetic fixture binary)', { skip: process.platform !== 'win32' ? 'platform check requires win32' : false }, (t) => {
  const plan = makePlanFixture({});
  let callCount = 0;
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: p => fakeStat({ isFile: ![plan.gitDirectory,plan.hubLibDirectory,plan.runtimeDirectory,plan.tempDirectory,plan.stateDirectory].includes(p), isDir: [plan.gitDirectory,plan.hubLibDirectory,plan.runtimeDirectory,plan.tempDirectory,plan.stateDirectory].includes(p), nlink: 1, size: 2048 }),
      // Synthetic fixture buffer whose sha256 will never equal the fixed provider hash.
      readFileSync: () => { callCount++; return Buffer.from('synthetic-fixture-binary-' + callCount); },
      mkdirSync: () => {}
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, () => {}), (err) => err.code === 'NATIVE_HASH_MISMATCH');
});

test('rejects when provider file is not a regular file (e.g. reparse/symlink fixture)', (t) => {
  const plan = makePlanFixture({});
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: () => fakeStat({ isFile: true, isSymlink: true, nlink: 1, size: 1024 }),
      readFileSync: () => Buffer.from('x'),
      mkdirSync: () => {}
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, () => {}), (err) => err.code === 'NATIVE_FILE_KIND_INVALID');
});

test('rejects when provider file has nlink != 1 (hardlink fixture)', (t) => {
  const plan = makePlanFixture({});
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: () => fakeStat({ isFile: true, nlink: 2, size: 1024 }),
      readFileSync: () => Buffer.from('x'),
      mkdirSync: () => {}
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, () => {}), (err) => err.code === 'NATIVE_FILE_KIND_INVALID');
});

test('rejects on wrong Node executable (not matching process.execPath)', (t) => {
  const plan = makePlanFixture({ nodeFile: 'C:/some/other/node.exe' });
  const crypto = require('crypto');
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: () => fakeStat({ isFile: true, nlink: 1, size: 1024 }),
      readFileSync: () => Buffer.from('fixture'),
      mkdirSync: () => {}
    },
    cryptoOverrides: {
      createHash: () => ({
        update() { return this; },
        digest: () => CLAUDE_HASH
      })
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, () => {}), (err) => err.code === 'NATIVE_NODE_INVALID');
});

test('rejects when credential file is missing (NATIVE_AUTH_UNAVAILABLE)', (t) => {
  const plan = makePlanFixture({});
  let lstatCalls = 0;
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: (p) => {
        lstatCalls++;
        if (String(p).includes('auth')) {
          const e = new Error('missing fixture');
          e.code = 'ENOENT';
          throw e;
        }
        return fakeStat({ isFile: true, isDir: String(p).includes('Directory') || String(p).includes('hublib') || String(p).includes('.git'), nlink: 1, size: 1024 });
      },
      readFileSync: () => Buffer.from('fixture'),
      mkdirSync: () => {}
    },
    cryptoOverrides: {
      createHash: () => ({ update() { return this; }, digest: () => CLAUDE_HASH })
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, () => {}), (err) => err.code === 'NATIVE_AUTH_UNAVAILABLE');
});

test('rejects when existing Grok config.toml content mismatches fixed fixture', (t) => {
  const plan = makePlanFixture({
    actor: 'grok',
    providerFile: 'C:/fake/grok.exe'
  });
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: (p) => {
        if (String(p).includes('config.toml')) {
          return fakeStat({ isFile: true, nlink: 1, size: 20 });
        }
        return fakeStat({ isFile: true, isDir: String(p).includes('Directory') || String(p).includes('hublib') || String(p).includes('.git') || String(p).includes('state') || String(p).includes('temp') || String(p).includes('providerhome') || String(p).includes('.hub-runtime'), nlink: 1, size: 1024 });
      },
      readFileSync: (p) => {
        if (String(p).includes('config.toml')) return Buffer.from('completely-different-synthetic-content');
        return Buffer.from('fixture-binary');
      },
      mkdirSync: () => {},
      openSync: () => { const e = new Error('exists fixture'); e.code = 'EEXIST'; throw e; }
    },
    cryptoOverrides: {
      createHash: () => ({ update() { return this; }, digest: () => '021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94' })
    },
    safePathImpl: (p) => p
  });
  assert.throws(() => hostModule.launch({}, () => {}), (err) => err.code === 'NATIVE_CONFIG_CHANGED');
});

test('rejects when supervisedSpawn returns invalid endpoint object missing stdio/kill', (t) => {
  const plan = makePlanFixture({});
  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: (p) => fakeStat({ isFile: true, isDir: String(p).includes('Directory') || String(p).includes('hublib') || String(p).includes('.git') || String(p).includes('state') || String(p).includes('temp') || String(p).includes('.hub-runtime'), nlink: 1, size: 1024 }),
      readFileSync: () => Buffer.from('fixture'),
      mkdirSync: () => {}
    },
    cryptoOverrides: {
      createHash: () => ({ update() { return this; }, digest: () => CLAUDE_HASH }),
      randomUUID: () => '00000000-0000-0000-0000-000000000000'
    },
    safePathImpl: (p) => p
  });
  assert.throws(
    () => hostModule.launch({}, () => ({ notAChild: true })),
    (err) => err.code === 'NATIVE_ENDPOINT_INVALID'
  );
});

test('positive mocked launch passes through exact unchanged argv/env/dirPin and assigns backendId without inventing cleanup', (t) => {
  const plan = makePlanFixture({});
  let capturedArgs = null;

  function FakeChild() {
    EventEmitter.call(this);
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.cleanupReceipt = null; // native manager owns this; host must not fabricate it.
  }
  FakeChild.prototype = Object.create(EventEmitter.prototype);
  FakeChild.prototype.kill = function () { this.killed = true; return true; };

  const fakeSupervisedSpawn = (file, args, spawnOpts) => {
    capturedArgs = { file, args, spawnOpts };
    return new FakeChild();
  };

  const hostModule = withMockedDeps(t, {
    plan,
    fsOverrides: {
      lstatSync: (p) => fakeStat({ isFile: true, isDir: String(p).includes('Directory') || String(p).includes('hublib') || String(p).includes('.git') || String(p).includes('state') || String(p).includes('temp') || String(p).includes('.hub-runtime'), nlink: 1, size: 1024 }),
      readFileSync: () => Buffer.from('fixture'),
      mkdirSync: () => {}
    },
    cryptoOverrides: {
      createHash: () => ({ update() { return this; }, digest: () => CLAUDE_HASH }),
      randomUUID: () => '11111111-1111-1111-1111-111111111111'
    },
    safePathImpl: (p) => p
  });

  const child = hostModule.launch({}, fakeSupervisedSpawn);

  assert.equal(capturedArgs.file, plan.file);
  assert.deepEqual(capturedArgs.args, plan.args);
  assert.deepEqual(capturedArgs.spawnOpts.env, plan.env);
  assert.equal(capturedArgs.spawnOpts.env.USERPROFILE,'C:/fake/ownerhome');
  assert.notEqual(capturedArgs.spawnOpts.env.USERPROFILE,plan.providerHome);
  assert.equal(capturedArgs.spawnOpts.env.HOME,plan.providerHome);
  assert.equal(capturedArgs.spawnOpts.env.APPDATA,plan.providerHome);
  assert.equal(capturedArgs.spawnOpts.env.LOCALAPPDATA,plan.providerHome);
  assert.equal(capturedArgs.spawnOpts.cwd, plan.cwd);
  assert.equal(capturedArgs.spawnOpts.dirPin, plan.dirPin);
  assert.equal(capturedArgs.spawnOpts.windowsHide, true);
  assert.deepEqual(capturedArgs.spawnOpts.stdio, ['pipe', 'pipe', 'pipe']);

  assert.equal(child.backendId, '11111111-1111-1111-1111-111111111111');
  assert.equal(child.cleanupReceipt, null); // untouched/not fabricated by host.
  assert.ok(child.stdin && child.stdout && child.stderr);
  assert.equal(typeof child.kill, 'function');

  assert.throws(() => { child.backendId = 'changed'; }, /Cannot assign/);
  assert.throws(()=>hostModule.launch({},()=>child),{code:'NATIVE_ENDPOINT_INVALID'});
  assert.equal(child.killed,true);
});
