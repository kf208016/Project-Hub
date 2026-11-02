'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const BS = String.fromCharCode(92);

// Load module under test BEFORE mocking anything.
const modPath = require.resolve('../lib/native-runtime-base');
delete require.cache[modPath];

// Mock dependency modules via Module._load interception, applied only for
// specific module ids used by native-runtime-base, loaded fresh each test.
function loadWithMocks(mocks) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (mocks[request]) return mocks[request];
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[modPath];
  // also clear cached safe-path/scoped-file resolved ids so re-require picks mocks
  let m;
  try {
    m = require('../lib/native-runtime-base');
  } finally {
    Module._load = originalLoad;
  }
  return m;
}

function mkStat(isDir, isSym) {
  return {
    isDirectory: () => isDir,
    isSymbolicLink: () => isSym
  };
}

function buildBasicMocks({ ownerHome, logicalBase, physicalBase, fingerprint, lstatMap, realpathNative, identityImpl }) {
  const fsMock = {
    lstatSync: (p) => {
      const key = p.toLowerCase();
      if (lstatMap[key]) return lstatMap[key]();
      throw new Error('ENOENT mock');
    },
    realpathSync: {
      native: realpathNative
    }
  };
  const safePathMock = {
    localPath: (p) => p
  };
  const scopedFileMock = {
    identity: identityImpl
  };
  return {
    'fs': fsMock,
    './safe-path': safePathMock,
    './scoped-file': scopedFileMock
  };
}

test('rejects doubled-backslash regression: separators are single backslash', () => {
  const ownerHome = path.win32.join('C:' + BS, 'Users', 'alice');
  // explicit assertion separators are single backslash chars
  for (let i = 0; i < ownerHome.length; i++) {
    if (ownerHome[i] === BS) {
      assert.notStrictEqual(ownerHome[i + 1], BS);
    }
  }
  assert.ok(!ownerHome.includes(BS + BS));
});

test('direct base success', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'alice';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const fingerprint = 'a'.repeat(64);
  let getterCalls = 0;
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({
    lstatMap,
    realpathNative: (p) => logicalBase,
    identityImpl: async () => ({ rootFingerprint: fingerprint })
  });
  const mod = loadWithMocks(mocks);
  const result = await mod.resolve(ownerHome);
  assert.strictEqual(result.logicalBase, logicalBase);
  assert.strictEqual(result.physicalBase, logicalBase);
  assert.strictEqual(result.rootFingerprint, fingerprint);
  assert.ok(Object.isFrozen(result));
  assert.strictEqual(getterCalls, 0);
});

test('package-redirect success without hardcoded package family', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'bob';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const pkgFamily = 'Contoso.App_9xyzrandom123';
  const physicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'Packages', pkgFamily, 'LocalCache', 'Local', 'ProjectHub');
  const fingerprint = 'b'.repeat(64);
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  lstatMap[physicalBase.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({
    lstatMap,
    realpathNative: (p) => physicalBase,
    identityImpl: async () => ({ rootFingerprint: fingerprint })
  });
  const mod = loadWithMocks(mocks);
  const result = await mod.resolve(ownerHome);
  assert.strictEqual(result.physicalBase, physicalBase);
  assert.strictEqual(result.rootFingerprint, fingerprint);
});

test('rejects invalid input shapes', async () => {
  const mocks = buildBasicMocks({ lstatMap: {}, realpathNative: () => { throw new Error('x'); }, identityImpl: async () => ({}) });
  const mod = loadWithMocks(mocks);
  const bads = [null, undefined, 123, {}, [], '', 'C:' + BS, 'C:' + BS + 'Users',
    '\\\\server\\share', 'C:' + BS + 'Users' + BS + 'a' + BS + '..' + BS + 'b',
    'C:' + BS + 'Users' + BS + 'a' + BS + '.',
    'C:' + BS + BS + 'Users' + BS + 'a',
    'C:' + BS + 'Users' + BS + 'a' + BS,
    'C:' + BS + 'Users' + BS + 'a ',
    'C:' + BS + 'Users' + BS + 'a.',
    'C:' + BS + 'Users' + BS + 'CON',
    'C:' + BS + 'Users' + BS + 'COM1',
    'C:' + BS + 'Users' + BS + 'a' + String.fromCharCode(0) + 'b',
    'C:' + BS + 'Users' + BS + 'a<b',
    '//server/share'
  ];
  for (const b of bads) {
    await assert.rejects(() => mod.resolve(b), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
  }
});

test('missing metadata fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'carol';
  const mocks = buildBasicMocks({ lstatMap: {}, realpathNative: () => { throw new Error('nope'); }, identityImpl: async () => ({ rootFingerprint: 'c'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('different-kind (file not dir) fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'dave';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(false, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => logicalBase, identityImpl: async () => ({ rootFingerprint: 'd'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('symlink/reparse metadata fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'eve';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, true);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => logicalBase, identityImpl: async () => ({ rootFingerprint: 'e'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('unexpected physical redirection (other user) fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'frank';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const otherPhysical = 'C:' + BS + 'Users' + BS + 'mallory' + BS + 'AppData' + BS + 'Local' + BS + 'ProjectHub';
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  lstatMap[otherPhysical.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => otherPhysical, identityImpl: async () => ({ rootFingerprint: 'f'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('other drive redirection fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'gina';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const otherDrive = 'D:' + BS + 'Users' + BS + 'gina' + BS + 'AppData' + BS + 'Local' + BS + 'ProjectHub';
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  lstatMap[otherDrive.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => otherDrive, identityImpl: async () => ({ rootFingerprint: '1'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('sibling target (not under Packages LocalCache) fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'hank';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const sibling = path.win32.join(ownerHome, 'AppData', 'Local', 'OtherHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  lstatMap[sibling.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => sibling, identityImpl: async () => ({ rootFingerprint: '2'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('malformed fingerprint fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'ian';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => logicalBase, identityImpl: async () => ({ rootFingerprint: 'NOTHEX' }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('identity getter is never invoked; descriptor read via getOwnPropertyDescriptor only', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'jill';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  let counter = 0;
  const obj = {};
  Object.defineProperty(obj, 'rootFingerprint', {
    get() { counter++; return '3'.repeat(64); },
    enumerable: true,
    configurable: true
  });
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => logicalBase, identityImpl: async () => obj });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
  assert.strictEqual(counter, 0);
});

test('Proxy trap throw on identity object fails closed, no counter increments', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'kyle';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  const proxy = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('trap'); }
  });
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => logicalBase, identityImpl: async () => proxy });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('native realpath failure fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'liam';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => { throw new Error('native fail'); }, identityImpl: async () => ({ rootFingerprint: '4'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('localPath rejection fails closed', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'mike';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  const mocks = buildBasicMocks({ lstatMap, realpathNative: () => logicalBase, identityImpl: async () => ({ rootFingerprint: '5'.repeat(64) }) });
  mocks['./safe-path'] = { localPath: () => { throw new Error('reject symlink'); } };
  const mod = loadWithMocks(mocks);
  await assert.rejects(() => mod.resolve(ownerHome), (e) => e.code === 'NATIVE_PROFILE_UNAVAILABLE');
});

test('no mkdir/readFile/provider/network calls are invoked', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'nina';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const fingerprint = '6'.repeat(64);
  const lstatMap = {};
  lstatMap[ownerHome.toLowerCase()] = () => mkStat(true, false);
  lstatMap[logicalBase.toLowerCase()] = () => mkStat(true, false);
  let mkdirCalled = false;
  let readFileCalled = false;
  const fsMock = {
    lstatSync: (p) => {
      const key = p.toLowerCase();
      if (lstatMap[key]) return lstatMap[key]();
      throw new Error('ENOENT');
    },
    realpathSync: { native: () => logicalBase },
    mkdirSync: () => { mkdirCalled = true; },
    readFileSync: () => { readFileCalled = true; return 'x'; }
  };
  const mocks = {
    'fs': fsMock,
    './safe-path': { localPath: (p) => p },
    './scoped-file': { identity: async () => ({ rootFingerprint: fingerprint }) }
  };
  const mod = loadWithMocks(mocks);
  const result = await mod.resolve(ownerHome);
  assert.strictEqual(result.rootFingerprint, fingerprint);
  assert.strictEqual(mkdirCalled, false);
  assert.strictEqual(readFileCalled, false);
});

test('error message and code contain no raw secret markers', async () => {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'olga';
  const mocks = buildBasicMocks({ lstatMap: {}, realpathNative: () => { throw new Error('SECRET_TOKEN_abc123'); }, identityImpl: async () => ({ rootFingerprint: '7'.repeat(64) }) });
  const mod = loadWithMocks(mocks);
  try {
    await mod.resolve(ownerHome);
    assert.fail('should have thrown');
  } catch (e) {
    assert.strictEqual(e.code, 'NATIVE_PROFILE_UNAVAILABLE');
    assert.ok(!e.message.includes('SECRET_TOKEN_abc123'));
    assert.ok(!e.message.includes(ownerHome));
    assert.strictEqual(e.cause, undefined);
  }
});

// Every path in this fixture has valid metadata by default. A rejection must
// therefore come from the intended validation branch, not a missing mock row.
function instrumentedFixture(options = {}) {
  const ownerHome = 'C:' + BS + 'Users' + BS + 'review-owner';
  const logicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'ProjectHub');
  const physicalBase = path.win32.join(ownerHome, 'AppData', 'Local', 'Packages', 'Review.Family_42', 'LocalCache', 'Local', 'ProjectHub');
  const calls = { local: [], lstat: [], native: [], identity: [], forbidden: [] };
  const forbidden = name => () => { calls.forbidden.push(name); throw Error('forbidden synthetic operation'); };
  const mocks = {
    fs: {
      lstatSync(p) { calls.lstat.push(p); return options.lstat ? options.lstat(p) : mkStat(true, false); },
      realpathSync: { native(p) { calls.native.push(p); return options.native ? options.native(p) : physicalBase; } },
      mkdirSync: forbidden('mkdir'), readFileSync: forbidden('readFile'), readdirSync: forbidden('readdir'), openSync: forbidden('open'),
    },
    './safe-path': { localPath(p) { calls.local.push(p); return options.local ? options.local(p) : p; } },
    './scoped-file': { async identity(p) { calls.identity.push(p); return options.identity ? options.identity(p) : { rootFingerprint: 'a'.repeat(64) }; } },
  };
  return { ownerHome, logicalBase, physicalBase, calls, mod: loadWithMocks(mocks) };
}

function assertPublicFailure(error, source) {
  assert.ok(error instanceof Error);
  assert.notStrictEqual(error, source);
  assert.strictEqual(error.code, 'NATIVE_PROFILE_UNAVAILABLE');
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
  assert.strictEqual(error.cause, undefined);
  assert.ok(!error.message.includes('dependency-secret-marker'));
  assert.ok(!error.stack.includes('source-secret-stack-marker'));
  assert.deepStrictEqual(Object.keys(error), ['code']);
  return true;
}

test('permissive valid metadata reaches native identity and returns exact frozen output', async () => {
  const f = instrumentedFixture();
  const result = await f.mod.resolve(f.ownerHome);
  assert.deepStrictEqual(result, { logicalBase: f.logicalBase, physicalBase: f.physicalBase, rootFingerprint: 'a'.repeat(64) });
  assert.ok(Object.isFrozen(result));
  assert.deepStrictEqual(f.calls.local, [f.ownerHome, f.logicalBase, f.physicalBase]);
  assert.deepStrictEqual(f.calls.lstat, [f.ownerHome, f.logicalBase, f.physicalBase]);
  assert.deepStrictEqual(f.calls.native, [f.logicalBase]);
  assert.deepStrictEqual(f.calls.identity, [f.physicalBase]);
  assert.deepStrictEqual(f.calls.forbidden, []);
});

test('lexical path rejection happens before any metadata even when all paths have valid synthetic metadata', async t => {
  const prefix = 'C:' + BS + 'Users' + BS;
  const cases = [
    ['DEL', prefix + 'a' + String.fromCharCode(127) + 'b'],
    ['COM superscript', prefix + 'COM\u00b9.txt'],
    ['LPT superscript', prefix + 'LPT\u00b3'],
    ['lone high surrogate', prefix + 'a\ud800b'],
    ['lone low surrogate', prefix + 'a\udc00b'],
    ['component over 255', prefix + 'a'.repeat(256)],
    ['path over 32760', 'C:' + BS + Array(140).fill('a'.repeat(255)).join(BS)],
    ['ADS', prefix + 'owner:stream'],
    ['device namespace', BS + BS + '?' + BS + 'C:' + BS + 'Users' + BS + 'owner'],
    ['forward slash', 'C:/Users/owner'],
    ['dot segment', prefix + 'owner' + BS + '.' + BS + 'child'],
    ['trailing space', prefix + 'owner '],
    ['trailing dot', prefix + 'owner.'],
    ...['<', '>', '"', '|', '?', '*'].map(char => ['metachar ' + char, prefix + 'a' + char + 'b']),
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    const f = instrumentedFixture();
    await assert.rejects(() => f.mod.resolve(value), assertPublicFailure);
    assert.deepStrictEqual(f.calls, { local: [], lstat: [], native: [], identity: [], forbidden: [] });
  });
});

test('valid 255-character component and valid surrogate pair are accepted by the same permissive fixture', async t => {
  for (const [name, component] of [['255 chars', 'a'.repeat(255)], ['paired unicode', 'review-\ud83d\ude00']]) await t.test(name, async () => {
    const owner = 'C:' + BS + 'Users' + BS + component, logical = path.win32.join(owner, 'AppData', 'Local', 'ProjectHub');
    const f = instrumentedFixture({ native: () => logical });
    const result = await f.mod.resolve(owner);
    assert.strictEqual(result.logicalBase, logical); assert.strictEqual(result.physicalBase, logical);
    assert.deepStrictEqual(f.calls.identity, [logical]); assert.deepStrictEqual(f.calls.forbidden, []);
  });
});

test('derived logical base length limit rejects after a valid owner metadata check', async () => {
  // Build a canonical owner shorter than the path cap whose derived base is too long.
  const prefix = 'C:' + BS + Array(127).fill('a'.repeat(255)).join(BS) + BS;
  const owner = prefix + 'b'.repeat(32750 - prefix.length);
  assert.strictEqual(owner.length, 32750);
  const f = instrumentedFixture();
  await assert.rejects(() => f.mod.resolve(owner), assertPublicFailure);
  assert.deepStrictEqual(f.calls.local, [owner]); assert.deepStrictEqual(f.calls.lstat, [owner]);
  assert.deepStrictEqual(f.calls.native, []); assert.deepStrictEqual(f.calls.identity, []);
});

test('invalid physical path is rejected after native resolution before physical metadata or identity', async t => {
  const prefix = 'C:' + BS + 'Users' + BS + 'review-owner' + BS + 'AppData' + BS + 'Local' + BS + 'Packages' + BS;
  const suffix = BS + 'LocalCache' + BS + 'Local' + BS + 'ProjectHub';
  const cases = [
    ['DEL family', prefix + 'family' + String.fromCharCode(127) + suffix],
    ['reserved superscript family', prefix + 'LPT\u00b2' + suffix],
    ['metachar family', prefix + 'bad|family' + suffix],
    ['lone surrogate family', prefix + '\ud800' + suffix],
    ['oversize family', prefix + 'x'.repeat(256) + suffix],
    ['trailing separator', prefix + 'family' + suffix + BS],
    ['non primitive', new String(prefix + 'family' + suffix)],
  ];
  for (const [name, physical] of cases) await t.test(name, async () => {
    const f = instrumentedFixture({ native: () => physical });
    await assert.rejects(() => f.mod.resolve(f.ownerHome), assertPublicFailure);
    assert.deepStrictEqual(f.calls.local, [f.ownerHome, f.logicalBase]);
    assert.deepStrictEqual(f.calls.lstat, [f.ownerHome, f.logicalBase]);
    assert.deepStrictEqual(f.calls.native, [f.logicalBase]); assert.deepStrictEqual(f.calls.identity, []);
  });
});

test('metadata failures are reached separately at owner, logical and physical stages', async t => {
  for (const stage of ['ownerHome', 'logicalBase', 'physicalBase']) for (const kind of ['missing', 'file', 'reparse', 'malformed']) await t.test(stage + '/' + kind, async () => {
    let target;
    const f = instrumentedFixture({ lstat: p => {
      if (p !== target) return mkStat(true, false);
      if (kind === 'missing') throw Error('dependency-secret-marker');
      if (kind === 'file') return mkStat(false, false);
      if (kind === 'reparse') return mkStat(true, true);
      return {};
    } });
    target = f[stage];
    await assert.rejects(() => f.mod.resolve(f.ownerHome), assertPublicFailure);
    assert.strictEqual(f.calls.lstat.at(-1), target);
    assert.strictEqual(f.calls.lstat.length, ['ownerHome', 'logicalBase', 'physicalBase'].indexOf(stage) + 1);
    assert.strictEqual(f.calls.native.length, stage === 'physicalBase' ? 1 : 0);
    assert.deepStrictEqual(f.calls.identity, []); assert.deepStrictEqual(f.calls.forbidden, []);
  });
});

test('unexpected localPath rewrite is rejected at each stage without querying identity', async t => {
  for (const stage of ['ownerHome', 'logicalBase', 'physicalBase']) await t.test(stage, async () => {
    let target;
    const f = instrumentedFixture({ local: p => p === target ? p + '-rewritten' : p });
    target = f[stage];
    await assert.rejects(() => f.mod.resolve(f.ownerHome), assertPublicFailure);
    assert.strictEqual(f.calls.local.at(-1), target);
    assert.strictEqual(f.calls.lstat.length, ['ownerHome', 'logicalBase', 'physicalBase'].indexOf(stage));
    assert.deepStrictEqual(f.calls.identity, []);
  });
});

test('case-only canonical path response is accepted', async () => {
  const f = instrumentedFixture({ local: p => p.toUpperCase() });
  const result = await f.mod.resolve(f.ownerHome);
  assert.strictEqual(result.physicalBase, f.physicalBase);
  assert.deepStrictEqual(f.calls.identity, [f.physicalBase]);
});

test('throwing dependency code getters are never inspected and matching errors are replaced with fresh errors', async t => {
  for (const stage of ['local', 'lstat', 'native', 'identity', 'descriptor']) await t.test(stage, async () => {
    let codeReads = 0, traps = 0;
    const source = new Error('dependency-secret-marker'); source.stack = 'source-secret-stack-marker';
    Object.defineProperty(source, 'code', { get() { codeReads++; throw Error('dependency-secret-marker'); } });
    let f;
    const options = stage === 'local' ? { local: () => { throw source; } } :
      stage === 'lstat' ? { lstat: () => { throw source; } } :
      stage === 'native' ? { native: () => { throw source; } } :
      stage === 'identity' ? { identity: () => { throw source; } } :
      { identity: () => new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw source; } }) };
    f = instrumentedFixture(options);
    await assert.rejects(() => f.mod.resolve(f.ownerHome), error => assertPublicFailure(error, source));
    assert.strictEqual(codeReads, 0); assert.strictEqual(traps, stage === 'descriptor' ? 1 : 0);
    assert.strictEqual(f.calls.identity.length, stage === 'identity' || stage === 'descriptor' ? 1 : 0);
  });
  const source = Object.assign(new Error('dependency-secret-marker'), { code: 'NATIVE_PROFILE_UNAVAILABLE', cause: 'dependency-secret-marker' });
  source.stack = 'source-secret-stack-marker';
  const f = instrumentedFixture({ identity: () => { throw source; } });
  await assert.rejects(() => f.mod.resolve(f.ownerHome), error => assertPublicFailure(error, source));
});

test('inherited fingerprint and inherited getter fail at identity without invoking the getter', async t => {
  let getterCalls = 0;
  const inheritedData = Object.create({ rootFingerprint: 'a'.repeat(64) });
  const prototype = Object.defineProperty({}, 'rootFingerprint', { get() { getterCalls++; throw Error('dependency-secret-marker'); } });
  for (const [name, result] of [['data', inheritedData], ['getter', Object.create(prototype)]]) await t.test(name, async () => {
    const f = instrumentedFixture({ identity: () => result });
    await assert.rejects(() => f.mod.resolve(f.ownerHome), assertPublicFailure);
    assert.deepStrictEqual(f.calls.identity, [f.physicalBase]); assert.strictEqual(getterCalls, 0);
  });
});
