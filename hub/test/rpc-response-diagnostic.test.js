'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const { describeResponse } = require('../lib/providers/rpc-response-diagnostic');

test('mcp-initialize classification', () => {
  const frame = {
    id: 1,
    result: {
      protocolVersion: '2024-01-01',
      capabilities: {},
      serverInfo: { name: 'x' },
    },
  };
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'mcp-initialize');
  assert.equal(out.responseKind, 'result');
  assert.equal(out.idType, 'number');
  assert.equal(out.version, 1);
});

test('acp-initialize classification', () => {
  const frame = {
    id: 'abc123',
    result: { protocolVersion: 3, agentCapabilities: {} },
  };
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'acp-initialize');
  assert.equal(out.idType, 'string');
});

test('acp-session classification', () => {
  const frame = { id: 1, result: { sessionId: 'sess-1.valid' } };
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'acp-session');
});

test('acp-stop classification valid enum', () => {
  const frame = { id: 1, result: { stopReason: 'end_turn' } };
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'acp-stop');
});

test('acp-stop rejects unknown enum value', () => {
  const frame = { id: 1, result: { stopReason: 'something_else' } };
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'other');
});

test('multiple shape matches resolve to other', () => {
  const frame = {
    id: 1,
    result: {
      protocolVersion: 3,
      agentCapabilities: {},
      sessionId: 'sess-abc',
    },
  };
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'other');
});

test('error responseKind and errorCode extraction', () => {
  const frame = { id: 1, error: { code: -32600, message: 'secret detail' } };
  const out = describeResponse(frame, {});
  assert.equal(out.responseKind, 'error');
  assert.equal(out.errorCode, -32600);
  assert.equal(out.resultShape, 'none');
  assert.equal(JSON.stringify(out).includes('secret detail'), false);
});

test('both result and error present is invalid', () => {
  const frame = { id: 1, result: {}, error: { code: 1 } };
  const out = describeResponse(frame, {});
  assert.equal(out.responseKind, 'invalid');
  assert.equal(out.resultShape, 'none');
  assert.equal(out.errorCode, null);
});

test('neither result nor error present is invalid', () => {
  const frame = { id: 1 };
  const out = describeResponse(frame, {});
  assert.equal(out.responseKind, 'invalid');
});

test('null and array frame are handled without throwing', () => {
  assert.doesNotThrow(() => describeResponse(null, {}));
  assert.doesNotThrow(() => describeResponse([1, 2, 3], {}));
  const outNull = describeResponse(null, {});
  assert.equal(outNull.responseKind, 'invalid');
  assert.equal(outNull.idType, 'invalid');
  const outArr = describeResponse([1, 2, 3], {});
  assert.equal(outArr.responseKind, 'invalid');
});

test('malformed id values classified invalid', () => {
  assert.equal(describeResponse({ id: null, result: {} }, {}).idType, 'invalid');
  assert.equal(describeResponse({ id: {}, result: {} }, {}).idType, 'invalid');
  assert.equal(describeResponse({ id: -0, result: {} }, {}).idType, 'invalid');
  assert.equal(describeResponse({ id: -1, result: {} }, {}).idType, 'invalid');
  assert.equal(describeResponse({ id: 1.5, result: {} }, {}).idType, 'invalid');
  assert.equal(describeResponse({ id: '', result: {} }, {}).idType, 'invalid');
  assert.equal(describeResponse({ result: {} }, {}).idType, 'invalid');
});

test('private sentinel style strings never copied into id-dependent output', () => {
  const privateSentinel = '__PRIVATE_SECRET_TOKEN__';
  const frame = { id: privateSentinel, result: {} };
  const out = describeResponse(frame, {});
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes(privateSentinel), false);
  assert.equal(out.idType, 'invalid');
});

test('unknown idRelation falls back to unknown', () => {
  const out = describeResponse({ id: 1, result: {} }, { idRelation: 'bogus-value' });
  assert.equal(out.idRelation, 'unknown');
});

test('duplicate idRelation-like entries still bounded to allowed set', () => {
  const out1 = describeResponse({ id: 1, result: {} }, { idRelation: 'pending' });
  const out2 = describeResponse({ id: 1, result: {} }, { idRelation: 'pending' });
  assert.equal(out1.idRelation, 'pending');
  assert.equal(out2.idRelation, 'pending');
});

test('accessor fields on frame are never invoked or treated as data', () => {
  let invoked = false;
  const frame = {
    id: 1,
    get result() {
      invoked = true;
      throw new Error('should not be called');
    },
  };
  const out = describeResponse(frame, {});
  assert.equal(invoked, false);
  assert.equal(out.responseKind, 'invalid');
});

test('accessor fields on result sub-object are ignored for shape detection', () => {
  let invoked = false;
  const resultObj = {
    get protocolVersion() {
      invoked = true;
      return 'x';
    },
    capabilities: {},
    serverInfo: {},
  };
  const frame = { id: 1, result: resultObj };
  const out = describeResponse(frame, {});
  assert.equal(invoked, false);
  assert.equal(out.resultShape, 'other');
});

test('inherited getters on prototype are not own data and are ignored', () => {
  function Base() {}
  Object.defineProperty(Base.prototype, 'protocolVersion', {
    get() {
      throw new Error('must not invoke inherited getter');
    },
  });
  const resultObj = Object.create(Base.prototype);
  resultObj.capabilities = {};
  resultObj.serverInfo = {};
  const frame = { id: 1, result: resultObj };
  assert.doesNotThrow(() => describeResponse(frame, {}));
  const out = describeResponse(frame, {});
  assert.equal(out.resultShape, 'other');
});

test('toJSON hooks are never invoked', () => {
  let invoked = false;
  const resultObj = {
    protocolVersion: '1.0',
    capabilities: {},
    serverInfo: {},
    toJSON() {
      invoked = true;
      return {};
    },
  };
  const frame = { id: 1, result: resultObj };
  const out = describeResponse(frame, {});
  assert.equal(invoked, false);
  assert.equal(out.resultShape, 'mcp-initialize');
});

test('pendingMethods allowlist, sorted, unique, ignores unknown and holes', () => {
  const arr = ['session/prompt', 'initialize', 'session/prompt', 'unknown/method'];
  arr[10] = 'session/new'; // creates a hole between index 4 and 10
  const out = describeResponse({ id: 1, result: {} }, { pendingMethods: arr });
  assert.deepEqual(out.pendingMethods, ['initialize', 'session/new', 'session/prompt']);
});

test('pendingMethods bounded to first 64 elements', () => {
  const arr = [];
  for (let i = 0; i < 100; i++) arr.push('unknown/method');
  arr[63] = 'initialize';
  arr[64] = 'session/new'; // beyond the 64 bound, should be ignored
  const out = describeResponse({ id: 1, result: {} }, { pendingMethods: arr });
  assert.deepEqual(out.pendingMethods, ['initialize']);
});

test('pendingMethods array with huge length still bounded, no hang', () => {
  const arr = [];
  arr.length = 5000;
  arr[0] = 'initialize';
  const out = describeResponse({ id: 1, result: {} }, { pendingMethods: arr });
  assert.deepEqual(out.pendingMethods, ['initialize']);
});

test('pendingMethods array with accessor elements are ignored', () => {
  const arr = ['initialize'];
  Object.defineProperty(arr, 1, {
    get() {
      throw new Error('must not be invoked');
    },
    enumerable: true,
  });
  assert.doesNotThrow(() => describeResponse({ id: 1, result: {} }, { pendingMethods: arr }));
  const out = describeResponse({ id: 1, result: {} }, { pendingMethods: arr });
  assert.deepEqual(out.pendingMethods, ['initialize']);
});

test('non-array pendingMethods and non-normal-prototype arrays are ignored', () => {
  const out1 = describeResponse({ id: 1, result: {} }, { pendingMethods: 'not-an-array' });
  assert.deepEqual(out1.pendingMethods, []);

  class FakeArray extends Array {}
  const fake = FakeArray.from(['initialize']);
  const out2 = describeResponse({ id: 1, result: {} }, { pendingMethods: fake });
  assert.deepEqual(out2.pendingMethods, []);
});

test('output object and pendingMethods array are frozen', () => {
  const out = describeResponse({ id: 1, result: {} }, { pendingMethods: ['initialize'] });
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.pendingMethods), true);
  assert.throws(() => {
    out.idType = 'number';
  });
});

test('deterministic for identical inputs', () => {
  const frame = { id: 1, result: { sessionId: 'sess-1' } };
  const context = { idRelation: 'pending', pendingMethods: ['initialize'] };
  const out1 = describeResponse(frame, context);
  const out2 = describeResponse(frame, context);
  assert.deepEqual(out1, out2);
});

test('input frame and context are not mutated', () => {
  const frame = { id: 1, result: { sessionId: 'sess-1' } };
  const context = { idRelation: 'pending', pendingMethods: ['initialize'] };
  const frameSnapshot = JSON.stringify(frame);
  const contextSnapshot = JSON.stringify(context);
  describeResponse(frame, context);
  assert.equal(JSON.stringify(frame), frameSnapshot);
  assert.equal(JSON.stringify(context), contextSnapshot);
});

test('forged magic prototype keys do not leak or throw', () => {
  const evil = Object.create(null);
  evil.id = 1;
  evil.result = Object.create(null);
  evil.result.protocolVersion = '1.0';
  evil.result.capabilities = Object.create(null);
  evil.result.serverInfo = Object.create(null);
  evil.__proto__ = { malicious: true }; // own data property named __proto__
  assert.doesNotThrow(() => describeResponse(evil, {}));
});

test('version field is always 1 and numeric', () => {
  const out = describeResponse({ id: 1, result: {} }, {});
  assert.equal(out.version, 1);
  assert.equal(typeof out.version, 'number');
});
