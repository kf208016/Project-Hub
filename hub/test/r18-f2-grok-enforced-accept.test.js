'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { decide } = require('../lib/native-provider-tool-policy');
const { classifyGrokOperation } = require('../lib/grok-canonical-operation');

const ROOT = 'D:\\Test\\work\\proj';
const policy = Object.freeze({root: ROOT, modelFlag: 'grok-4.6', commandsApproved: true,
  subagentsApproved: true, mcpTools: ['hub__hub_report']});
const file = (rawInput, kind = 'edit') => ({title: kind === 'read' ? 'read_file' : 'write', kind, rawInput});
const mcp = (tool_name, tool_input = {}) => ({title: 'Use tool', kind: 'other', rawInput: {variant: 'UseTool', tool_name, tool_input}});
const outside = 'D:\\HubTest\\tmp\\x.txt';

// The unchanged classifier has no delete/move file mapping. Exercise the
// conditional file branch in isolation without changing the production export.
const isolated = {exports: {}};
vm.runInNewContext(fs.readFileSync(require.resolve('../lib/native-provider-tool-policy'), 'utf8'), {
  module: isolated, Buffer, Object, Array, Set,
  require(name) {
    if (name === './grok-canonical-operation') return {classifyGrokOperation: () => 'file'};
    if (name === './native-turn-limits') return require('../lib/native-turn-limits');
    throw new Error('Unexpected dependency');
  }
}, {timeout: 1000});
const fileBranch = isolated.exports.decide;

test('F2 Grok edit accepts valid outside paths and inside relative paths', () => {
  for (const path of [outside, 'C:\\Users\\Public\\x.txt', ROOT + '-sibling\\x.txt', 'src\\x.txt', ROOT + '\\src\\x.txt']) {
    for (const key of ['file_path', 'target_file', 'path']) {
      assert.equal(decide('grok', file({[key]: path}), policy), 'accept', key + ': ' + path);
    }
  }
});

test('F2 file branch accepts delete/move outside aliases; production classification stays unchanged', () => {
  for (const kind of ['delete', 'move']) {
    const detail = file({file_path: outside, target_file: 'd:/hubtest/tmp/x.txt', path: outside.toUpperCase()}, kind);
    assert.equal(fileBranch('grok', detail, policy), 'accept');
    assert.equal(classifyGrokOperation(detail.title, kind), 'decline');
    assert.equal(decide('grok', detail, policy), 'decline');
    for (const key of ['file_path', 'target_file', 'path']) {
      assert.equal(fileBranch('grok', file({...detail.rawInput, [key]: '.git\\x'}, kind), policy), 'decline');
    }
  }
});

test('F2 reads and other non-write kinds in the file branch still decline outside paths', () => {
  assert.equal(decide('grok', file({file_path: outside}, 'read'), policy), 'decline');
  for (const kind of ['read', 'other', 'Edit', 'DELETE', 'unknown']) {
    assert.equal(fileBranch('grok', file({file_path: outside}, kind), policy), 'decline', kind);
  }
});

test('F2 inside protected directories remain declined for every path alias', () => {
  for (const dir of ['.git', '.agents', '.codex', '.aws', '.ai\\chat', '.ai\\web-chat', '.hub-runtime']) {
    for (const key of ['file_path', 'target_file', 'path']) {
      for (const path of [dir + '\\x', ROOT + '\\' + dir + '\\x']) {
        assert.equal(decide('grok', file({[key]: path}), policy), 'decline', path);
      }
    }
  }
});

test('F2 invalid path syntax declines including Windows aliases and bad Unicode', () => {
  for (const path of ['\\\\server\\share\\x', '\\\\.\\x', '\\\\?\\D:\\x', 'D:\\x.txt:s', '..\\x',
    'D:\\tmp\\..\\x', 'CON', 'C:\\tmp\\CON.txt', 'C:\\tmp\\x\ud800', 'C:\\tmp\\x\udc00',
    'C:\\tmp\\x\u0000', 'C:\\tmp\\x\n', '', 'C:\\tmp\\x.', 'C:\\tmp\\x ', 'C:x', '\\x']) {
    for (const key of ['file_path', 'target_file', 'path']) {
      assert.equal(decide('grok', file({[key]: path}), policy), 'decline', JSON.stringify(path));
    }
  }
});

test('F2 every present alias must be a string and resolve to the same absolute path', () => {
  for (const path of [null, 42, false, {}, [], 'C:\\Users\\Public\\other.txt', 'src\\x.txt', '.git\\x']) {
    assert.equal(decide('grok', file({file_path: outside, path}), policy), 'decline');
  }
  assert.equal(decide('grok', file({file_path: outside, target_file: 'd:/hubtest/tmp/x.txt', path: outside.toUpperCase()}), policy), 'accept');
  assert.equal(decide('grok', file({file_path: 'src\\x.txt', path: ROOT + '\\SRC\\X.TXT'}), policy), 'accept');
});

test('F2 missing paths remain manual and path getters are never invoked', () => {
  assert.equal(decide('grok', file({}), policy), 'manual');
  let called = 0;
  const rawInput = {path: outside};
  Object.defineProperty(rawInput, 'file_path', {enumerable: true, get() {called++; return outside;}});
  assert.equal(decide('grok', file(rawInput), policy), 'decline');
  assert.equal(called, 0);
});

test('F2 sensitive extra fields remain manual only after valid path checks', () => {
  for (const key of ['permissionMode', 'env', 'model', 'bypass', 'mcpServers', 'command', 'COMMAND_LINE']) {
    for (const path of [outside, 'src\\x.txt']) {
      assert.equal(decide('grok', file({path, [key]: {}}), policy), 'manual', key);
    }
    for (const path of ['..\\x', '.git\\x']) {
      assert.equal(decide('grok', file({path, [key]: {}}), policy), 'decline');
    }
    assert.equal(decide('grok', file({file_path: outside, path: 'other.txt', [key]: {}}), policy), 'decline');
  }
  assert.equal(decide('grok', file({path: outside, content: 'x', description: 'inert'}), policy), 'accept');
});

test('F2 granted MCP and valid ungranted Hub names accept', () => {
  for (const name of ['hub__hub_report', 'hub__hub_write_file', 'hub__a', 'hub__' + 'a'.repeat(64)]) {
    assert.equal(decide('grok', mcp(name), policy), 'accept', name);
  }
  assert.equal(decide('grok', mcp('hub__hub_report'), {...policy, mcpTools: []}), 'accept');
  assert.equal(decide('grok', mcp('other__granted'), {...policy, mcpTools: ['other__granted']}), 'accept');
});

test('F2 non-Hub and malformed ungranted MCP names decline', () => {
  for (const name of ['other__x', 'hub__X', 'hub__', '', 'hub__' + 'a'.repeat(65), 'hub__a-b', 'hub__1x', 'hub__a.b', 'hub__a\n']) {
    assert.equal(decide('grok', mcp(name), policy), 'decline', name);
  }
});

test('F2 missing, nonplain and accessor MCP input declines without calling getters', () => {
  for (const name of ['hub__hub_report', 'hub__hub_write_file']) {
    const missing = mcp(name); delete missing.rawInput.tool_input;
    assert.equal(decide('grok', missing, policy), 'decline');
    for (const input of [null, [], 'x', 42, new Date(0)]) {
      assert.equal(decide('grok', mcp(name, input), policy), 'decline');
    }
    let called = 0;
    const getter = mcp(name);
    Object.defineProperty(getter.rawInput, 'tool_input', {enumerable: true, get() {called++; return {};}});
    assert.equal(decide('grok', getter, policy), 'decline');
    assert.equal(called, 0);
    assert.equal(decide('grok', mcp(name, Object.create(null)), policy), 'accept');
  }
});

test('F2 leaves Claude outside Write and ungranted MCP declined', () => {
  assert.equal(decide('claude', {toolName: 'Write', input: {file_path: outside}}, policy), 'decline');
  assert.equal(decide('claude', {toolName: 'mcp__hub__hub_write_file', input: {}}, policy), 'decline');
});

test('F2 does not mutate inputs or policy', () => {
  const detail = file(Object.freeze({file_path: outside, path: outside.toUpperCase()}));
  Object.freeze(detail);
  const before = JSON.stringify({detail, policy});
  assert.equal(decide('grok', detail, policy), 'accept');
  assert.equal(JSON.stringify({detail, policy}), before);
});
