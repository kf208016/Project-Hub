'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const { classifyWatcherAck } = require('../lib/providers/grok-internal-notice');

function freeze(x) { return Object.freeze(x); }

test('exact skills-reload ACK classifies as skills', () => {
  const frame = freeze({ jsonrpc: '2.0', id: 'skills-reload', result: freeze({ result: freeze({ reloaded: 0 }) }) });
  assert.equal(classifyWatcherAck(frame), 'skills');
});

test('exact workflows-reload ACK classifies as workflows', () => {
  const frame = { jsonrpc: '2.0', id: 'workflows-reload', result: { result: { reloaded: 3 } } };
  assert.equal(classifyWatcherAck(frame), 'workflows');
});

test('null prototype records are accepted', () => {
  const inner = Object.create(null);
  inner.reloaded = 1;
  const outer = Object.create(null);
  outer.result = inner;
  const frame = Object.create(null);
  frame.jsonrpc = '2.0';
  frame.id = 'skills-reload';
  frame.result = outer;
  assert.equal(classifyWatcherAck(frame), 'skills');
});

test('input is not mutated', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: 5 } } };
  const clone = JSON.parse(JSON.stringify(frame));
  classifyWatcherAck(frame);
  assert.deepEqual(frame, clone);
});

test('null input rejected', () => {
  assert.equal(classifyWatcherAck(null), null);
});

test('array input rejected', () => {
  assert.equal(classifyWatcherAck([1, 2, 3]), null);
});

test('malformed missing key rejected', () => {
  assert.equal(classifyWatcherAck({ jsonrpc: '2.0', id: 'skills-reload' }), null);
});

test('oversized reloaded count structurally fine but non-integer rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: Number.MAX_SAFE_INTEGER + 10 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('error field rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', error: { code: -1, message: 'x' } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('nested error instead of result rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { error: { code: -1 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('partial result missing reloaded rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: {} } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('bool count rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: true } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('negative zero rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: -0 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('negative integer rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'workflows-reload', result: { result: { reloaded: -1 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('status text instead of result rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { status: 'ok' } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('stopReason field makes extra key reject even with forged matching id', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: 0 } }, stopReason: 'end_turn' };
  assert.equal(classifyWatcherAck(frame), null);
});

test('tool instruction payload rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: 0, tool: 'exec' } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('sessionId extra field rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', sessionId: 'abc', result: { result: { reloaded: 0 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('model field rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', model: 'grok-5', result: { result: { reloaded: 0 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('extra _meta field rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: { reloaded: 0 }, _meta: {} } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('numeric id rejected', () => {
  const frame = { jsonrpc: '2.0', id: 1, result: { result: { reloaded: 0 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('id suffix variation rejected', () => {
  const frame = { jsonrpc: '2.0', id: 'skills-reload-2', result: { result: { reloaded: 0 } } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('constructor/prototype magic key rejected', () => {
  const frame = JSON.parse('{"jsonrpc":"2.0","id":"skills-reload","result":{"result":{"reloaded":0}},"__proto__":{}}');
  // JSON.parse __proto__ becomes an own enumerable key, not prototype poisoning
  assert.equal(classifyWatcherAck(frame), null);
});

test('accessor getter that throws is never invoked and is rejected', () => {
  const inner = {};
  Object.defineProperty(inner, 'reloaded', {
    enumerable: true,
    configurable: true,
    get() { throw new Error('must not be invoked'); }
  });
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: inner } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('toJSON hook present is ignored and record still validated structurally', () => {
  const inner = { reloaded: 2, toJSON() { throw new Error('must not be invoked'); } };
  const frame = { jsonrpc: '2.0', id: 'workflows-reload', result: { result: inner } };
  // toJSON adds an extra own key, so key-count check rejects it
  assert.equal(classifyWatcherAck(frame), null);
});

test('exotic prototype rejected', () => {
  class Weird {}
  const inner = new Weird();
  inner.reloaded = 1;
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: inner } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('non-enumerable own property rejected', () => {
  const inner = {};
  Object.defineProperty(inner, 'reloaded', { value: 0, enumerable: false, configurable: true, writable: true });
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: inner } };
  assert.equal(classifyWatcherAck(frame), null);
});

test('symbol-keyed property rejected', () => {
  const sym = Symbol('x');
  const inner = { reloaded: 0 };
  inner[sym] = 'hidden';
  const frame = { jsonrpc: '2.0', id: 'skills-reload', result: { result: inner } };
  assert.equal(classifyWatcherAck(frame), null);
});
