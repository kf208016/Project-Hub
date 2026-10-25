'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextToolState } = require('../lib/providers/grok-tool-state');

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code);
    return true;
  });
}

test('inert extension named extra preserves its original shape across updates',()=>{
  const first=nextToolState(null,{toolCallId:'tool-1',extra:{a:1},_meta:{marker:'synthetic'}},{initial:true});
  const second=nextToolState(first,{toolCallId:'tool-1',status:'in_progress'},{});
  assert.deepEqual(second.extra,{a:1});assert.deepEqual(second._meta,{marker:'synthetic'});
});

test('malformed keys, symbols, accessors and options cannot enter JSON state',()=>{
  for(const update of [{toolCallId:'tool-1',['\ud800']:1},{toolCallId:'tool-1',[Symbol('hidden')]:1},
    {toolCallId:'tool-1',rawInput:9007199254740992}]){
    expectCode(()=>nextToolState(null,update,{initial:true}),'GROK_NATIVE_INVALID_JSON');
  }
  let called=false;const getter={toolCallId:'tool-1'};
  Object.defineProperty(getter,'rawInput',{enumerable:true,get(){called=true;return {};}});
  expectCode(()=>nextToolState(null,getter,{initial:true}),'GROK_NATIVE_INVALID_JSON');assert.equal(called,false);
  const array=[1];Object.defineProperty(array,'0',{get(){called=true;return 1;}});
  expectCode(()=>nextToolState(null,{toolCallId:'tool-1',rawInput:array},{initial:true}),'GROK_NATIVE_INVALID_JSON');assert.equal(called,false);
  expectCode(()=>nextToolState(null,{toolCallId:'tool-1'},{initial:true,locked:'false'}),'GROK_NATIVE_TOOL_OPTIONS');
});

test('initial state defaults to pending with no previous', () => {
  const state = nextToolState(null, { toolCallId: 'tool-1', title: 'Read file' }, { initial: true });
  assert.equal(state.status, 'pending');
  assert.equal(state.toolCallId, 'tool-1');
  assert.equal(state.title, 'Read file');
});

test('streamed input: null/empty/string/final object before lock', () => {
  let state = nextToolState(null, { toolCallId: 'tool-1' }, { initial: true });
  state = nextToolState(state, { toolCallId: 'tool-1', rawInput: null }, {});
  assert.equal(state.rawInput, undefined);
  state = nextToolState(state, { toolCallId: 'tool-1', rawInput: {} }, {});
  assert.deepEqual(state.rawInput, {});
  state = nextToolState(state, { toolCallId: 'tool-1', rawInput: 'partial-chunk' }, {});
  assert.equal(state.rawInput, 'partial-chunk');
  state = nextToolState(
    state,
    { toolCallId: 'tool-1', rawInput: { path: 'file.txt' } },
    {},
  );
  assert.deepEqual(state.rawInput, { path: 'file.txt' });
});

test('null/omission retains earlier rawInput/rawOutput/name', () => {
  let state = nextToolState(null, { toolCallId: 'tool-1', rawInput: { path: 'file.txt' } }, { initial: true });
  state = nextToolState(state, { toolCallId: 'tool-1', rawInput: null, name: null }, {});
  assert.deepEqual(state.rawInput, { path: 'file.txt' });
  assert.equal(state.name, undefined);
  state = nextToolState(state, { toolCallId: 'tool-1' }, {});
  assert.deepEqual(state.rawInput, { path: 'file.txt' });
});

test('permission=true publishes immutable owner preview; attacker requested/locked ignored', () => {
  let state = nextToolState(
    null,
    {
      toolCallId: 'tool-1',
      title: 'Read file.txt',
      kind: 'read',
      rawInput: { path: 'file.txt' },
      requested: false,
      locked: false,
    },
    { permission: true },
  );
  assert.equal(state.title, 'Read file.txt');
  assert.equal(state.kind, 'read');
  assert.equal(state.requested, undefined);
  assert.equal(state.locked, undefined);

  // caller sets its private lock; subsequent update tries attacker-supplied requested:false, locked:false
  const locked = nextToolState(
    state,
    { toolCallId: 'tool-1', status: 'in_progress', requested: false, locked: false },
    { locked: true },
  );
  assert.equal(locked.status, 'in_progress');
  assert.equal(locked.requested, undefined);
  assert.equal(locked.locked, undefined);
  assert.deepEqual(locked.rawInput, { path: 'file.txt' });
});

test('deterministic structural equality ignores key insertion order', () => {
  let state = nextToolState(
    null,
    { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: { a: 1, b: 2 } },
    { permission: true },
  );
  // same object but different key order must NOT be treated as a change under lock
  const updated = nextToolState(
    state,
    { toolCallId: 'tool-1', rawInput: { b: 2, a: 1 } },
    { locked: true },
  );
  assert.deepEqual(updated.rawInput, { a: 1, b: 2 });
});

test('changing known kind after lock throws GROK_NATIVE_TOOL_CHANGED', () => {
  const state = nextToolState(
    null,
    { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: {} },
    { permission: true },
  );
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', kind: 'write' }, { locked: true }),
    'GROK_NATIVE_TOOL_CHANGED',
  );
});

test('changing known name after lock throws GROK_NATIVE_TOOL_CHANGED', () => {
  let state = nextToolState(
    null,
    { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: {}, name: 'read_file' },
    { permission: true },
  );
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', name: 'other_tool' }, { locked: true }),
    'GROK_NATIVE_TOOL_CHANGED',
  );
});

test('changing rawInput after lock throws GROK_NATIVE_TOOL_CHANGED', () => {
  const state = nextToolState(
    null,
    { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: { path: 'file.txt' } },
    { permission: true },
  );
  expectCode(
    () =>
      nextToolState(
        state,
        { toolCallId: 'tool-1', rawInput: { path: 'other.txt' } },
        { locked: true },
      ),
    'GROK_NATIVE_TOOL_CHANGED',
  );
});

test('filling previously-absent name/kind after lock is harmless', () => {
  const state = nextToolState(
    null,
    { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: {} },
    { permission: true },
  );
  const updated = nextToolState(state, { toolCallId: 'tool-1', name: 'read_file' }, { locked: true });
  assert.equal(updated.name, 'read_file');
});

test('harmless output/content updates do not require unlocking', () => {
  const state = nextToolState(
    null,
    { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: {} },
    { permission: true },
  );
  const updated = nextToolState(
    state,
    {
      toolCallId: 'tool-1',
      status: 'in_progress',
      rawOutput: { bytes: 10 },
      content: [{ type: 'text', text: 'partial' }],
      title: 'Reading file.txt',
    },
    { locked: true },
  );
  assert.deepEqual(updated.rawOutput, { bytes: 10 });
  assert.deepEqual(updated.content, [{ type: 'text', text: 'partial' }]);
  assert.equal(updated.title, 'Reading file.txt');
});

test('in_progress status does not by itself lock input (no private preview yet)', () => {
  let state = nextToolState(null, { toolCallId: 'tool-1', status: 'in_progress' }, { initial: true });
  state = nextToolState(state, { toolCallId: 'tool-1', rawInput: { path: 'a.txt' } }, {});
  state = nextToolState(state, { toolCallId: 'tool-1', rawInput: { path: 'b.txt' } }, {});
  assert.deepEqual(state.rawInput, { path: 'b.txt' });
});

test('permission requires plain-object rawInput', () => {
  expectCode(
    () =>
      nextToolState(
        null,
        { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: 'not-an-object' },
        { permission: true },
      ),
    'GROK_NATIVE_PERMISSION_INVALID',
  );
  expectCode(
    () =>
      nextToolState(
        null,
        { toolCallId: 'tool-1', title: 'Read', kind: 'read', rawInput: null },
        { permission: true },
      ),
    'GROK_NATIVE_PERMISSION_INVALID',
  );
});

test('permission requires nonempty title and kind', () => {
  expectCode(
    () => nextToolState(null, { toolCallId: 'tool-1', title: '', kind: 'read', rawInput: {} }, { permission: true }),
    'GROK_NATIVE_INVALID_FIELD',
  );
});

test('non-initial update without previous and without permission is rejected (unknown id)', () => {
  expectCode(
    () => nextToolState(null, { toolCallId: 'tool-unknown', status: 'in_progress' }, {}),
    'GROK_NATIVE_NO_PREVIOUS',
  );
});

test('replay with mismatched toolCallId is rejected', () => {
  const state = nextToolState(null, { toolCallId: 'tool-1' }, { initial: true });
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-2', status: 'in_progress' }, {}),
    'GROK_NATIVE_ID_MISMATCH',
  );
});

test('initial state cannot be supplied with a previous state', () => {
  const state = nextToolState(null, { toolCallId: 'tool-1' }, { initial: true });
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1' }, { initial: true }),
    'GROK_NATIVE_INVALID_FIELD',
  );
});

test('terminal status cannot be changed', () => {
  let state = nextToolState(null, { toolCallId: 'tool-1' }, { initial: true });
  state = nextToolState(state, { toolCallId: 'tool-1', status: 'completed' }, {});
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', status: 'failed' }, {}),
    'GROK_NATIVE_STATUS_REGRESSION',
  );
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', status: 'in_progress' }, {}),
    'GROK_NATIVE_STATUS_REGRESSION',
  );
});

test('in_progress cannot regress to pending', () => {
  let state = nextToolState(null, { toolCallId: 'tool-1' }, { initial: true });
  state = nextToolState(state, { toolCallId: 'tool-1', status: 'in_progress' }, {});
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', status: 'pending' }, {}),
    'GROK_NATIVE_STATUS_REGRESSION',
  );
});

test('caller objects are never mutated, including on failure', () => {
  const previous = nextToolState(null, { toolCallId: 'tool-1', rawInput: { path: 'file.txt' } }, { initial: true });
  const previousSnapshot = JSON.parse(JSON.stringify(previous));
  const update = { toolCallId: 'tool-1', status: 'completed' };
  const updateSnapshot = JSON.parse(JSON.stringify(update));

  const result = nextToolState(previous, update, {});
  assert.deepEqual(previous, previousSnapshot);
  assert.deepEqual(update, updateSnapshot);
  result.rawInput.path = 'mutated.txt';
  assert.deepEqual(previous, previousSnapshot);

  const badUpdate = { toolCallId: 'tool-1', status: 'pending' };
  const badSnapshot = JSON.parse(JSON.stringify(badUpdate));
  expectCode(() => nextToolState(result, badUpdate, {}), 'GROK_NATIVE_STATUS_REGRESSION');
  assert.deepEqual(badUpdate, badSnapshot);
  assert.deepEqual(result, { toolCallId: 'tool-1', status: 'completed', rawInput: { path: 'mutated.txt' } });
});

test('rejects magic prototype keys', () => {
  const malicious = JSON.parse('{"toolCallId":"tool-1","__proto__":{"polluted":true}}');
  expectCode(() => nextToolState(null, malicious, { initial: true }), 'GROK_NATIVE_INVALID_JSON');
});

test('rejects cyclic structures', () => {
  const update = { toolCallId: 'tool-1', rawInput: {} };
  update.rawInput.self = update.rawInput;
  expectCode(() => nextToolState(null, update, { initial: true }), 'GROK_NATIVE_INVALID_JSON');
});

test('rejects malformed unicode (lone surrogate) and NUL in strings', () => {
  expectCode(
    () => nextToolState(null, { toolCallId: 'tool-1', title: 'bad\uD800title' }, { initial: true }),
    'GROK_NATIVE_INVALID_JSON',
  );
  expectCode(
    () => nextToolState(null, { toolCallId: 'tool-1', title: 'bad\u0000title' }, { initial: true }),
    'GROK_NATIVE_INVALID_JSON',
  );
});

test('rejects non-finite numbers and undefined values in JSON domain', () => {
  expectCode(
    () => nextToolState(null, { toolCallId: 'tool-1', rawOutput: { n: NaN } }, { initial: true }),
    'GROK_NATIVE_INVALID_JSON',
  );
  expectCode(
    () => nextToolState(null, { toolCallId: 'tool-1', rawOutput: { n: undefined } }, { initial: true }),
    'GROK_NATIVE_INVALID_JSON',
  );
});

test('rejects invalid toolCallId format', () => {
  expectCode(
    () => nextToolState(null, { toolCallId: '' }, { initial: true }),
    'GROK_NATIVE_INVALID_ID',
  );
  expectCode(
    () => nextToolState(null, { toolCallId: '!bad-id' }, { initial: true }),
    'GROK_NATIVE_INVALID_ID',
  );
});

test('content and locations must be arrays when provided', () => {
  const state = nextToolState(null, { toolCallId: 'tool-1' }, { initial: true });
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', content: 'not-array' }, {}),
    'GROK_NATIVE_INVALID_FIELD',
  );
  expectCode(
    () => nextToolState(state, { toolCallId: 'tool-1', locations: 'not-array' }, {}),
    'GROK_NATIVE_INVALID_FIELD',
  );
});
