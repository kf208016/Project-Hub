'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../lib/claude-subagent-context');

const { TOOLS, createScope } = mod;

const EXPECTED_TOOLS = [
  'Bash',
  'PowerShell',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode'
];

function assertScopeError(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'Claude native subagent scope violation');
    assert.equal(err.code, 'CLAUDE_NATIVE_SUBAGENT_SCOPE');
    return true;
  });
}

test('TOOLS exact explicit list and order, no bypass tools', () => {
  assert.deepEqual(TOOLS, EXPECTED_TOOLS);
  assert.ok(Object.isFrozen(TOOLS));
  const banned = ['WebFetch', 'WebSearch', 'BrowserOpen', 'ComputerUse', 'Plugin', '--dangerously-skip-permissions', 'bypassPermissions'];
  for (const b of banned) {
    assert.ok(!TOOLS.includes(b));
  }
});

test('createScope returns frozen API', () => {
  const scope = createScope();
  assert.ok(Object.isFrozen(scope));
  assert.equal(typeof scope.assertParent, 'function');
  assert.equal(typeof scope.registerTool, 'function');
  assert.equal(typeof scope.consumeUser, 'function');
  assert.throws(() => { scope.extra = 1; });
});

test('independent scopes do not share state', () => {
  const a = createScope();
  const b = createScope();
  a.registerTool('agent1', 'Agent', null);
  assertScopeError(() => b.assertParent('agent1'));
});

test('root string prompt accepted', () => {
  const scope = createScope();
  assert.equal(scope.consumeUser(null, 'hello root prompt'), 'prompt');
});

test('root text array rejected', () => {
  const scope = createScope();
  assertScopeError(() => scope.consumeUser(null, [{ type: 'text', text: 'hi' }]));
});

test('owned child text-block first prompt accepted exactly once', () => {
  const scope = createScope();
  scope.registerTool('agentA', 'Agent', null);
  const result = scope.consumeUser('agentA', [{ type: 'text', text: 'child first prompt' }]);
  assert.equal(result, 'prompt');
  assertScopeError(() => scope.consumeUser('agentA', [{ type: 'text', text: 'replay attempt' }]));
});

test('child first prompt as plain string also accepted once', () => {
  const scope = createScope();
  scope.registerTool('agentB', 'Task', null);
  assert.equal(scope.consumeUser('agentB', 'child string prompt'), 'prompt');
  assertScopeError(() => scope.consumeUser('agentB', 'second prompt'));
});

test('root tool result consumption', () => {
  const scope = createScope();
  scope.registerTool('agentRoot', 'Agent', null);
  scope.registerTool('tool1', 'Bash', null);
  const r = scope.consumeUser(null, [{ type: 'tool_result', tool_use_id: 'tool1', content: 'ok', is_error: false }]);
  assert.equal(r, 'results');
});

test('child nested tool result consumption', () => {
  const scope = createScope();
  scope.registerTool('agentC', 'Agent', null);
  scope.registerTool('bashC', 'Bash', 'agentC');
  const r = scope.consumeUser('agentC', [{ type: 'tool_result', tool_use_id: 'bashC', content: 'ok' }]);
  assert.equal(r, 'results');
});

test('nested Agent registration under Agent parent', () => {
  const scope = createScope();
  scope.registerTool('agentOuter', 'Agent', null);
  scope.registerTool('agentInner', 'Task', 'agentOuter');
  assert.equal(scope.assertParent('agentInner'), 'agentInner');
  scope.registerTool('bashInner', 'Bash', 'agentInner');
  const r = scope.consumeUser('agentInner', [{ type: 'tool_result', tool_use_id: 'bashInner', content: 'x' }]);
  assert.equal(r, 'results');
});

test('unknown/forged parent rejected', () => {
  const scope = createScope();
  assertScopeError(() => scope.assertParent('ghostParent'));
  assertScopeError(() => scope.registerTool('t1', 'Bash', 'ghostParent'));
});

test('registered Read tool as parent rejected (not Agent/Task)', () => {
  const scope = createScope();
  scope.registerTool('readA', 'Read', null);
  assertScopeError(() => scope.assertParent('readA'));
  assertScopeError(() => scope.registerTool('child1', 'Bash', 'readA'));
});

test('registered Bash tool as parent rejected', () => {
  const scope = createScope();
  scope.registerTool('bashX', 'Bash', null);
  assertScopeError(() => scope.assertParent('bashX'));
});

test('Agent and Task both qualify as valid parents (positive)', () => {
  const scope = createScope();
  scope.registerTool('agentP', 'Agent', null);
  scope.registerTool('taskP', 'Task', null);
  assert.equal(scope.assertParent('agentP'), 'agentP');
  assert.equal(scope.assertParent('taskP'), 'taskP');
});

test('wrong-parent result rejected: root cannot consume child result and vice versa', () => {
  const scope = createScope();
  scope.registerTool('agentD', 'Agent', null);
  scope.registerTool('bashD', 'Bash', 'agentD');
  assertScopeError(() => scope.consumeUser(null, [{ type: 'tool_result', tool_use_id: 'bashD', content: 'x' }]));

  scope.registerTool('bashRootD', 'Bash', null);
  assertScopeError(() => scope.consumeUser('agentD', [{ type: 'tool_result', tool_use_id: 'bashRootD', content: 'x' }]));
});

test('prompt replay rejected', () => {
  const scope = createScope();
  scope.registerTool('agentE', 'Agent', null);
  scope.consumeUser('agentE', 'first prompt');
  assertScopeError(() => scope.consumeUser('agentE', 'second prompt'));
  assertScopeError(() => scope.consumeUser('agentE', [{ type: 'text', text: 'third' }]));
});

test('duplicate results within batch and atomic batch refusal', () => {
  const scope = createScope();
  scope.registerTool('agentF', 'Agent', null);
  scope.registerTool('t1', 'Bash', 'agentF');
  scope.registerTool('t2', 'Bash', 'agentF');

  assertScopeError(() => scope.consumeUser('agentF', [
    { type: 'tool_result', tool_use_id: 't1', content: 'a' },
    { type: 'tool_result', tool_use_id: 't1', content: 'b' }
  ]));
  // neither t1 nor t2 should be marked consumed due to atomic failure
  const r = scope.consumeUser('agentF', [
    { type: 'tool_result', tool_use_id: 't1', content: 'a' },
    { type: 'tool_result', tool_use_id: 't2', content: 'b' }
  ]);
  assert.equal(r, 'results');
});

test('atomic batch refusal: one bad id prevents whole batch, prior valid ids remain usable later', () => {
  const scope = createScope();
  scope.registerTool('agentG', 'Agent', null);
  scope.registerTool('tg1', 'Bash', 'agentG');

  assertScopeError(() => scope.consumeUser('agentG', [
    { type: 'tool_result', tool_use_id: 'tg1', content: 'a' },
    { type: 'tool_result', tool_use_id: 'unknownId', content: 'b' }
  ]));

  // tg1 must still be consumable since the prior failed batch must not have partially committed
  const r = scope.consumeUser('agentG', [{ type: 'tool_result', tool_use_id: 'tg1', content: 'a' }]);
  assert.equal(r, 'results');
});

test('previously consumed result id rejected on reuse', () => {
  const scope = createScope();
  scope.registerTool('agentH', 'Agent', null);
  scope.registerTool('th1', 'Bash', 'agentH');
  scope.consumeUser('agentH', [{ type: 'tool_result', tool_use_id: 'th1', content: 'a' }]);
  assertScopeError(() => scope.consumeUser('agentH', [{ type: 'tool_result', tool_use_id: 'th1', content: 'a' }]));
});

test('results before optional prompt forbids later fake first prompt', () => {
  const scope = createScope();
  scope.registerTool('agentI', 'Agent', null);
  scope.registerTool('ti1', 'Bash', 'agentI');
  const r = scope.consumeUser('agentI', [{ type: 'tool_result', tool_use_id: 'ti1', content: 'a' }]);
  assert.equal(r, 'results');
  assertScopeError(() => scope.consumeUser('agentI', 'late fake first prompt'));
  assertScopeError(() => scope.consumeUser('agentI', [{ type: 'text', text: 'late fake first prompt array' }]));
});

test('inherited/getter/trap properties on text block rejected', () => {
  const scope = createScope();
  scope.registerTool('agentJ', 'Agent', null);

  const base = { type: 'text' };
  const child = Object.create(base);
  Object.defineProperty(child, 'text', { value: 'inherited type attempt', enumerable: true });
  assertScopeError(() => scope.consumeUser('agentJ', [child]));

  let getterCalls = 0;
  const getterObj = {};
  Object.defineProperty(getterObj, 'type', { get() { getterCalls++; return 'text'; }, enumerable: true });
  Object.defineProperty(getterObj, 'text', { value: 'x', enumerable: true });
  assertScopeError(() => scope.consumeUser('agentJ', [getterObj]));
  assert.equal(getterCalls, 0, 'getter must never be invoked');

  const throwingProxy = new Proxy({ type: 'text', text: 'x' }, {
    getOwnPropertyDescriptor() { throw new TypeError('trap boom'); }
  });
  assertScopeError(() => scope.consumeUser('agentJ', [throwingProxy]));
});

test('revoked proxy as content array element fails closed', () => {
  const scope = createScope();
  scope.registerTool('agentK', 'Agent', null);
  const { proxy, revoke } = Proxy.revocable({ type: 'text', text: 'x' }, {});
  revoke();
  assertScopeError(() => scope.consumeUser('agentK', [proxy]));
});

test('tool_result array with extra own property element rejected via symbol injection', () => {
  const scope = createScope();
  scope.registerTool('agentL', 'Agent', null);
  scope.registerTool('tl1', 'Bash', 'agentL');
  const sym = Symbol('x');
  const el = { type: 'tool_result', tool_use_id: 'tl1', content: 'a' };
  el[sym] = 'bad';
  assertScopeError(() => scope.consumeUser('agentL', [el]));
});

test('invalid primitive shapes for parentId rejected', () => {
  const scope = createScope();
  assertScopeError(() => scope.assertParent(undefined));
  assertScopeError(() => scope.assertParent(42));
  // eslint-disable-next-line no-new-wrappers
  assertScopeError(() => scope.assertParent(new String('agentX')));
  assertScopeError(() => scope.assertParent(''));
});

test('id/name validation boundary cases', () => {
  const scope = createScope();
  assertScopeError(() => scope.registerTool('', 'Bash', null));
  assertScopeError(() => scope.registerTool('bad id with space', 'Bash', null));
  assertScopeError(() => scope.registerTool('ok-id_1.2:3', '', null));
  const longName = 'x'.repeat(257);
  assertScopeError(() => scope.registerTool('ok2', longName, null));
  const maxName = 'y'.repeat(256);
  assert.equal(scope.registerTool('ok3', maxName, null), undefined);

  const maxId = 'a' + 'b'.repeat(255);
  assert.equal(maxId.length, 256);
  assert.equal(scope.registerTool(maxId, 'Bash', null), undefined);

  const tooLongId = 'a' + 'b'.repeat(256);
  assertScopeError(() => scope.registerTool(tooLongId, 'Bash', null));
});

test('duplicate tool id registration rejected', () => {
  const scope = createScope();
  scope.registerTool('dup1', 'Bash', null);
  assertScopeError(() => scope.registerTool('dup1', 'Read', null));
});

test('max tool count enforced (resource limit, not execution authority)', () => {
  const scope = createScope();
  for (let i = 0; i < 4096; i++) {
    scope.registerTool('tool' + i, 'Bash', null);
  }
  assertScopeError(() => scope.registerTool('toolOverflow', 'Bash', null));
});

test('depth bound of 24 enforced through registerTool/assertParent chain', () => {
  const scope = createScope();
  let parent = null;
  for (let d = 0; d <= 24; d++) {
    const id = 'depthAgent' + d;
    scope.registerTool(id, 'Agent', parent);
    parent = id;
  }
  // parent now at depth 24; one more level exceeds bound
  assertScopeError(() => scope.registerTool('tooDeep', 'Bash', parent));
});

test('Unicode well-formedness: lone surrogate rejected in tool name', () => {
  const scope = createScope();
  const loneHigh = '\uD800';
  const loneLow = '\uDC00';
  assertScopeError(() => scope.registerTool('un1', loneHigh, null));
  assertScopeError(() => scope.registerTool('un2', loneLow, null));
});

test('Unicode well-formedness: lone surrogate rejected in child prompt text', () => {
  const scope = createScope();
  scope.registerTool('agentM', 'Agent', null);
  assertScopeError(() => scope.consumeUser('agentM', [{ type: 'text', text: '\uD800bad' }]));
  assertScopeError(() => scope.consumeUser('agentM', '\uDC00bad'));
});

test('paired Unicode surrogate (valid emoji) accepted in name and prompt', () => {
  const scope = createScope();
  const emojiName = 'Agent\uD83D\uDE00';
  assert.doesNotThrow(() => scope.registerTool('emojiTool', emojiName, null));
  assertScopeError(() => scope.assertParent('emojiTool')); // Similar spelling is not Agent authority.
  assert.doesNotThrow(() => scope.registerTool('accentedTool', 'Bash\u00e9', null));
  scope.registerTool('agentN', 'Agent', null);
  assert.equal(scope.consumeUser('agentN', 'hello \uD83D\uDE00 world'), 'prompt');
});

test('tool name rejects tab/newline/control chars; prompt text allows tab/newline but rejects NUL', () => {
  const scope = createScope();
  assertScopeError(() => scope.registerTool('cn1', 'Bash\tTool', null));
  assertScopeError(() => scope.registerTool('cn2', 'Bash\nTool', null));
  assertScopeError(() => scope.registerTool('cn3', 'Bash\u0007Tool', null));

  scope.registerTool('agentO', 'Agent', null);
  const r = scope.consumeUser('agentO', [{ type: 'text', text: 'line1\tline2\nline3' }]);
  assert.equal(r, 'prompt');

  scope.registerTool('agentO2', 'Agent', null);
  assertScopeError(() => scope.consumeUser('agentO2', [{ type: 'text', text: 'bad\u0000null' }]));
});

test('root prompt still bounded and does not accept arbitrarily large content', () => {
  const scope = createScope();
  const huge = 'a'.repeat(70000);
  assertScopeError(() => scope.consumeUser(null, huge));
});

test('child prompt exceeding byte bound rejected', () => {
  const scope = createScope();
  scope.registerTool('agentP2', 'Agent', null);
  const huge = 'a'.repeat(70000);
  assertScopeError(() => scope.consumeUser('agentP2', huge));
});

test('empty array content rejected', () => {
  const scope = createScope();
  scope.registerTool('agentQ', 'Agent', null);
  assertScopeError(() => scope.consumeUser('agentQ', []));
});

test('mixed text/tool_result array rejected', () => {
  const scope = createScope();
  scope.registerTool('agentR', 'Agent', null);
  scope.registerTool('tr1', 'Bash', 'agentR');
  assertScopeError(() => scope.consumeUser('agentR', [
    { type: 'text', text: 'hello' },
    { type: 'tool_result', tool_use_id: 'tr1', content: 'a' }
  ]));
});

test('unknown block type in array rejected', () => {
  const scope = createScope();
  scope.registerTool('agentS', 'Agent', null);
  assertScopeError(() => scope.consumeUser('agentS', [{ type: 'image', text: 'x' }]));
});

test('array with hole (sparse array) rejected', () => {
  const scope = createScope();
  scope.registerTool('agentT', 'Agent', null);
  const sparse = [{ type: 'text', text: 'ok' }];
  sparse.length = 3; // introduces holes
  assertScopeError(() => scope.consumeUser('agentT', sparse));
});

test('array exceeding max length rejected', () => {
  const scope = createScope();
  scope.registerTool('agentU', 'Agent', null);
  const big = new Array(4097).fill(0).map(() => ({ type: 'text', text: 'a' }));
  assertScopeError(() => scope.consumeUser('agentU', big));
});

test('custom array subclass / foreign prototype rejected', () => {
  const scope = createScope();
  scope.registerTool('agentV', 'Agent', null);
  class Weird extends Array {}
  const w = Weird.from([{ type: 'text', text: 'x' }]);
  assertScopeError(() => scope.consumeUser('agentV', w));
});

test('assertParent returns validated parentId unchanged', () => {
  const scope = createScope();
  scope.registerTool('agentW', 'Task', null);
  assert.equal(scope.assertParent('agentW'), 'agentW');
  assert.equal(scope.assertParent(null), null);
});

test('no raw marker / internal values disclosed in errors', () => {
  const scope = createScope();
  try {
    scope.assertParent('secretParentIdThatShouldNotLeak');
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.message, 'Claude native subagent scope violation');
    assert.ok(!e.message.includes('secretParentIdThatShouldNotLeak'));
    assert.equal(e.stack === undefined || typeof e.stack === 'string', true);
    assert.equal(e.cause, undefined);
  }
});

test('registerTool never grants session/tool execution (pure bookkeeping, no side channel)', () => {
  const scope = createScope();
  const r = scope.registerTool('bashNeutral', 'Bash', null);
  assert.equal(r, undefined);
});

function childScope(name = 'owned-agent') {
  const scope = createScope();
  scope.registerTool(name, 'Agent', null);
  return { scope, parent: name };
}

test('exports and public scope keys are exactly frozen without state exposure', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['TOOLS', 'createScope']);
  assert.equal(Object.isFrozen(mod), true);
  const scope = createScope();
  assert.deepEqual(Object.keys(scope).sort(), ['assertParent', 'consumeUser', 'registerTool']);
  assert.throws(() => { mod.createScope = () => null; });
  assert.throws(() => { scope.consumeUser = () => 'results'; });
  assert.throws(() => { TOOLS.push('WebFetch'); });
});

test('Windows CRLF remains inert prompt text at root and in each child prompt form', () => {
  const scope = createScope();
  assert.equal(scope.consumeUser(null, 'root line one\r\nroot line two\tend'), 'prompt');
  scope.registerTool('crlf-string', 'Agent', null);
  scope.registerTool('crlf-array', 'Task', null);
  assert.equal(scope.consumeUser('crlf-string', 'child line one\r\nchild line two'), 'prompt');
  assert.equal(scope.consumeUser('crlf-array', [{ type: 'text', text: 'first\r\n' }, { type: 'text', text: 'second\tline\r\n' }]), 'prompt');
  assertScopeError(() => scope.consumeUser('crlf-array', 'cannot replay prompt'));
});

test('array index, extra property and iterator accessors are rejected without invoking them', async t => {
  const cases = {
    index: counter => Object.defineProperty([], '0', { enumerable: true, get() { counter.calls++; return { type: 'text', text: 'getter text' }; } }),
    extra: counter => Object.defineProperty([{ type: 'text', text: 'normal' }], 'unexpected', { get() { counter.calls++; return 'hidden'; } }),
    iterator: counter => Object.defineProperty([{ type: 'text', text: 'normal' }], Symbol.iterator, { get() { counter.calls++; return Array.prototype[Symbol.iterator]; } }),
  };
  for (const [name, build] of Object.entries(cases)) await t.test(name, () => {
    const { scope, parent } = childScope(), counter = { calls: 0 };
    assertScopeError(() => scope.consumeUser(parent, build(counter)));
    assert.equal(counter.calls, 0);
    assert.equal(scope.consumeUser(parent, [{ type: 'text', text: 'valid after rejected array' }]), 'prompt');
  });
});

test('a transparent array Proxy does not receive ordinary get calls for indices, length or iterator', () => {
  const { scope, parent } = childScope(); let gets = 0;
  const input = new Proxy([{ type: 'text', text: 'safe own data' }], { get() { gets++; throw Error('ordinary property read forbidden'); } });
  assert.equal(scope.consumeUser(parent, input), 'prompt');
  assert.equal(gets, 0);
});

test('throwing array reflection traps are redacted and do not consume the first prompt', async t => {
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) await t.test(trap, () => {
    const { scope, parent } = childScope(); let traps = 0, codeReads = 0;
    const source = new Error('source-secret-marker'); source.stack = 'source-stack-marker';
    Object.defineProperty(source, 'code', { get() { codeReads++; throw Error('code getter must not run'); } });
    const input = new Proxy([{ type: 'text', text: 'safe' }], { [trap]() { traps++; throw source; } });
    let received; try { scope.consumeUser(parent, input); } catch (error) { received = error; }
    assert.ok(received); assert.notEqual(received, source); assert.equal(received.message, 'Claude native subagent scope violation');
    assert.equal(received.code, 'CLAUDE_NATIVE_SUBAGENT_SCOPE'); assert.equal(received.cause, undefined);
    assert.equal(received.stack.includes('source-stack-marker'), false); assert.deepEqual(Object.keys(received), ['code']);
    assert.equal(codeReads, 0); assert.equal(traps, 1);
    assert.equal(scope.consumeUser(parent, 'valid after trap'), 'prompt');
  });
});

test('array prototype and symbol injection are rejected before user getters or iteration', () => {
  const { scope, parent } = childScope(); let gets = 0;
  const inherited = [{ type: 'text', text: 'normal' }]; Object.setPrototypeOf(inherited, null);
  assertScopeError(() => scope.consumeUser(parent, inherited));
  const symbolArray = [{ type: 'text', text: 'normal' }]; Object.defineProperty(symbolArray, Symbol.toStringTag, { get() { gets++; return 'Array'; } });
  assertScopeError(() => scope.consumeUser(parent, symbolArray));
  assert.equal(gets, 0); assert.equal(scope.consumeUser(parent, 'still available'), 'prompt');
});

test('tool_result type and ID accessors never run and failed batches preserve result ownership', async t => {
  for (const field of ['type', 'tool_use_id']) await t.test(field, () => {
    const { scope, parent } = childScope(); scope.registerTool('owned-tool', 'Bash', parent); let calls = 0;
    const block = { type: 'tool_result', tool_use_id: 'owned-tool', content: 'inert' };
    Object.defineProperty(block, field, { enumerable: true, get() { calls++; return field === 'type' ? 'tool_result' : 'owned-tool'; } });
    assertScopeError(() => scope.consumeUser(parent, [block])); assert.equal(calls, 0);
    assert.equal(scope.consumeUser(parent, [{ type: 'tool_result', tool_use_id: 'owned-tool' }]), 'results');
  });
});

test('result content and is_error are left inert for strict adapter validation', () => {
  const { scope, parent } = childScope(); scope.registerTool('inert-result', 'Bash', parent); let gets = 0;
  const block = { type: 'tool_result', tool_use_id: 'inert-result' };
  for (const key of ['content', 'is_error']) Object.defineProperty(block, key, { enumerable: true, get() { gets++; throw Error('adapter-only field'); } });
  assert.equal(scope.consumeUser(parent, [block]), 'results'); assert.equal(gets, 0);
});

test('sibling result cannot be consumed by another known parent and remains usable by the owner', () => {
  const scope = createScope();
  scope.registerTool('parent-a', 'Agent', null); scope.registerTool('parent-b', 'Task', null);
  scope.registerTool('tool-a', 'Bash', 'parent-a'); scope.registerTool('tool-b', 'Read', 'parent-b');
  assertScopeError(() => scope.consumeUser('parent-a', [{ type: 'tool_result', tool_use_id: 'tool-a' }, { type: 'tool_result', tool_use_id: 'tool-b' }]));
  assert.equal(scope.consumeUser('parent-a', 'prompt after rejected batch'), 'prompt');
  assert.equal(scope.consumeUser('parent-a', [{ type: 'tool_result', tool_use_id: 'tool-a' }]), 'results');
  assert.equal(scope.consumeUser('parent-b', [{ type: 'tool_result', tool_use_id: 'tool-b' }]), 'results');
});

test('duplicate or mixed batch rejection cannot consume a child prompt or partial tool results', () => {
  const { scope, parent } = childScope(); scope.registerTool('batch-tool', 'Bash', parent);
  assertScopeError(() => scope.consumeUser(parent, [{ type: 'text', text: 'valid prefix' }, { type: 'tool_result', tool_use_id: 'batch-tool' }]));
  assertScopeError(() => scope.consumeUser(parent, [{ type: 'tool_result', tool_use_id: 'batch-tool' }, { type: 'tool_result', tool_use_id: 'unknown' }]));
  assert.equal(scope.consumeUser(parent, [{ type: 'text', text: 'valid first prompt after both failures' }]), 'prompt');
  assert.equal(scope.consumeUser(parent, [{ type: 'tool_result', tool_use_id: 'batch-tool' }]), 'results');
  assertScopeError(() => scope.consumeUser(parent, [{ type: 'tool_result', tool_use_id: 'batch-tool' }]));
});

test('invalid final text block leaves the first child prompt available', () => {
  const { scope, parent } = childScope();
  assertScopeError(() => scope.consumeUser(parent, [{ type: 'text', text: 'valid prefix' }, { type: 'text', text: 'bad\0suffix' }]));
  assert.equal(scope.consumeUser(parent, [{ type: 'text', text: 'corrected full batch' }]), 'prompt');
});

test('UTF8 combined prompt byte limit is exact and rejected oversized batches have no state effect', () => {
  const scope = createScope(); scope.registerTool('utf8-boundary', 'Agent', null); scope.registerTool('utf8-overflow', 'Task', null);
  const half = '\uD83D\uDE00'.repeat(8192); assert.equal(Buffer.byteLength(half), 32768);
  assert.equal(scope.consumeUser('utf8-boundary', [{ type: 'text', text: half }, { type: 'text', text: half }]), 'prompt');
  assertScopeError(() => scope.consumeUser('utf8-overflow', [{ type: 'text', text: half }, { type: 'text', text: half + 'x' }]));
  assert.equal(scope.consumeUser('utf8-overflow', 'within bound after overflow'), 'prompt');
});

test('Agent root result does not close asynchronous child lineage', () => {
  const scope = createScope(); scope.registerTool('async-agent', 'Agent', null);
  assert.equal(scope.consumeUser(null, [{ type: 'tool_result', tool_use_id: 'async-agent' }]), 'results');
  assert.equal(scope.assertParent('async-agent'), 'async-agent');
  assert.equal(scope.consumeUser('async-agent', 'late optional child prompt'), 'prompt');
  scope.registerTool('late-child-tool', 'Bash', 'async-agent');
  assert.equal(scope.consumeUser('async-agent', [{ type: 'tool_result', tool_use_id: 'late-child-tool' }]), 'results');
});

test('failed tool registrations at wrong parent, invalid name and depth limit do not reserve IDs', () => {
  const scope = createScope(); scope.registerTool('read-parent', 'Read', null);
  assertScopeError(() => scope.registerTool('retry-parent-id', 'Bash', 'read-parent'));
  assert.equal(scope.registerTool('retry-parent-id', 'Bash', null), undefined);
  assertScopeError(() => scope.registerTool('retry-name-id', 'bad\tname', null));
  assert.equal(scope.registerTool('retry-name-id', 'Agent', null), undefined);
  let parent = null;
  for (let depth = 0; depth <= 24; depth++) { const id = 'bounded-' + depth; scope.registerTool(id, depth % 2 ? 'Task' : 'Agent', parent); parent = id; }
  assert.equal(scope.assertParent(parent), parent);
  assertScopeError(() => scope.registerTool('retry-depth-id', 'Agent', parent));
  assert.equal(scope.registerTool('retry-depth-id', 'Task', null), undefined);
});

test('coercion hooks are never invoked by parent, registration or prompt validation', () => {
  const scope = createScope(); let calls = 0;
  const value = { toString() { calls++; return 'Agent'; }, valueOf() { calls++; return 'Agent'; } };
  assertScopeError(() => scope.assertParent(value)); assertScopeError(() => scope.registerTool(value, 'Bash', null));
  assertScopeError(() => scope.registerTool('no-coercion', value, null)); assertScopeError(() => scope.consumeUser(null, value));
  assert.equal(calls, 0); assert.equal(scope.registerTool('no-coercion', 'Agent', null), undefined);
});

test('each failure is a fresh redacted Error even when source already has the fixed code', () => {
  const { scope, parent } = childScope();
  const source = Object.assign(new Error('source-secret-marker'), { code: 'CLAUDE_NATIVE_SUBAGENT_SCOPE', cause: 'source-secret-marker' });
  source.stack = 'source-stack-marker';
  const input = new Proxy([{ type: 'text', text: 'valid' }], { ownKeys() { throw source; } });
  const received = [];
  for (let i = 0; i < 2; i++) try { scope.consumeUser(parent, input); } catch (error) { received.push(error); }
  assert.equal(received.length, 2); assert.notEqual(received[0], received[1]);
  for (const error of received) {
    assert.notEqual(error, source); assert.equal(error.message, 'Claude native subagent scope violation');
    assert.equal(error.code, 'CLAUDE_NATIVE_SUBAGENT_SCOPE'); assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes('source-stack-marker'), false); assert.deepEqual(Object.keys(error), ['code']);
  }
  assert.equal(scope.consumeUser(parent, 'valid after repeated trap failures'), 'prompt');
});
