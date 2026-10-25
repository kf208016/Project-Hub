'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyGrokOperation } = require('../lib/grok-canonical-operation');

test('module export is frozen', () => {
  const mod = require('../lib/grok-canonical-operation');
  assert.equal(Object.isFrozen(mod), true);
});

// --- Canonical variant mappings ---

test('canonical Read -> file', () => {
  assert.equal(classifyGrokOperation('Read `file`', 'read', 'Read'), 'file');
});

test('canonical ReadFile -> file', () => {
  assert.equal(classifyGrokOperation('ReadFile', 'read', 'ReadFile'), 'file');
});

test('canonical Edit -> file (human display title)', () => {
  assert.equal(classifyGrokOperation('Edit `add.cjs`', 'edit', 'Edit'), 'file');
});

test('canonical SearchReplace -> file, documented title', () => {
  assert.equal(classifyGrokOperation('SearchReplace', 'edit', 'SearchReplace'), 'file');
});

test('canonical SearchReplace -> file with human display title', () => {
  assert.equal(classifyGrokOperation('Edit `add.cjs`', 'edit', 'SearchReplace'), 'file');
});

test('canonical Write -> file with human title', () => {
  assert.equal(classifyGrokOperation('Write `notes.md`', 'edit', 'Write'), 'file');
});

test('canonical Bash -> command', () => {
  assert.equal(classifyGrokOperation('Bash', 'execute', 'Bash'), 'command');
});

test('canonical Grep -> search', () => {
  assert.equal(classifyGrokOperation('Grep', 'search', 'Grep'), 'search');
});

test('canonical SearchTool -> tool-search', () => {
  assert.equal(classifyGrokOperation('SearchTool', 'other', 'SearchTool'), 'tool-search');
});

test('canonical Task -> subagent, with arbitrary description title', () => {
  assert.equal(classifyGrokOperation('Investigate failing build and report back', 'other', 'Task'), 'subagent');
});

test('canonical UseTool -> mcp', () => {
  assert.equal(classifyGrokOperation('UseTool', 'other', 'UseTool'), 'mcp');
});

// --- Legacy title mappings (no variant) ---

test('legacy read_file -> file', () => {
  assert.equal(classifyGrokOperation('read_file', 'read', undefined), 'file');
});

test('legacy search_replace -> file', () => {
  assert.equal(classifyGrokOperation('search_replace', 'edit', undefined), 'file');
});

test('legacy write -> file', () => {
  assert.equal(classifyGrokOperation('write', 'edit', undefined), 'file');
});

test('legacy run_terminal_command -> command', () => {
  assert.equal(classifyGrokOperation('run_terminal_command', 'execute', undefined), 'command');
});

test('legacy grep -> search', () => {
  assert.equal(classifyGrokOperation('grep', 'search', undefined), 'search');
});

test('legacy search_tool -> tool-search', () => {
  assert.equal(classifyGrokOperation('search_tool', 'other', undefined), 'tool-search');
});

test('legacy spawn_subagent -> subagent', () => {
  assert.equal(classifyGrokOperation('spawn_subagent', 'other', undefined), 'subagent');
});

test('no implicit undefined variant works even when omitted entirely', () => {
  assert.equal(classifyGrokOperation('grep', 'search'), 'search');
});

// --- Unknown variant always manual, even with spoofed known legacy title ---

test('unknown variant TaskOutput is manual regardless of title', () => {
  assert.equal(classifyGrokOperation('TaskOutput', 'other', 'TaskOutput'), 'manual');
});

test('unknown variant WaitTasks is manual', () => {
  assert.equal(classifyGrokOperation('WaitTasks', 'other', 'WaitTasks'), 'manual');
});

test('unknown variant KillTask is manual', () => {
  assert.equal(classifyGrokOperation('KillTask', 'other', 'KillTask'), 'manual');
});

test('unknown variant WebSearch is manual', () => {
  assert.equal(classifyGrokOperation('WebSearch', 'other', 'WebSearch'), 'manual');
});

test('unknown variant Dynamic is manual', () => {
  assert.equal(classifyGrokOperation('Dynamic', 'other', 'Dynamic'), 'manual');
});

test('unknown variant MCPTool is manual, not routed to mcp operation', () => {
  assert.equal(classifyGrokOperation('MCPTool', 'other', 'MCPTool'), 'manual');
});

test('unknown variant ApplyPatch is manual', () => {
  assert.equal(classifyGrokOperation('ApplyPatch', 'edit', 'ApplyPatch'), 'manual');
});

test('negative: unknown variant with title matching known file legacy title cannot be routed to file', () => {
  // title is read_file, a known legacy 'file' title, but variant is unknown -> must stay manual
  const result = classifyGrokOperation('read_file', 'read', 'Dynamic');
  assert.equal(result, 'manual');
  assert.notEqual(result, 'file');
});

test('negative: display text pretending to be a tool title cannot grant operation without variant/legacy match', () => {
  assert.equal(classifyGrokOperation('Read `file`', 'read', undefined), 'manual');
});

// --- Strict kind mismatches (decline) ---

test('canonical variant Bash with wrong kind declines', () => {
  assert.equal(classifyGrokOperation('Bash', 'other', 'Bash'), 'decline');
});

test('canonical variant Read with wrong kind declines', () => {
  assert.equal(classifyGrokOperation('Read', 'edit', 'Read'), 'decline');
});

test('legacy title grep with wrong kind declines', () => {
  assert.equal(classifyGrokOperation('grep', 'other', undefined), 'decline');
});

test('legacy title spawn_subagent with wrong kind declines', () => {
  assert.equal(classifyGrokOperation('spawn_subagent', 'read', undefined), 'decline');
});

// --- Canonical/legacy conflicts ---

test('canonical Bash variant with legacy title grep (search/search) conflicts -> decline', () => {
  // kind must match Bash's expected kind 'execute' for this to even reach conflict check;
  // use grep title with kind execute and variant Bash: kind matches canonical but legacy map says grep expects search kind
  assert.equal(classifyGrokOperation('grep', 'execute', 'Bash'), 'decline');
});

test('canonical SearchTool variant with legacy title read_file conflicts -> decline', () => {
  assert.equal(classifyGrokOperation('read_file', 'other', 'SearchTool'), 'decline');
});

test('canonical Task variant with legacy title write (edit/file) conflicts if kind matched -> decline', () => {
  // Task expects kind 'other'; legacy write expects edit/file, mismatched kind within legacy entry triggers decline
  assert.equal(classifyGrokOperation('write', 'other', 'Task'), 'decline');
});

test('canonical UseTool variant with legacy title spawn_subagent conflicts -> decline', () => {
  // spawn_subagent expects other/subagent, UseTool expects other/mcp -> operation mismatch -> decline
  assert.equal(classifyGrokOperation('spawn_subagent', 'other', 'UseTool'), 'decline');
});

test('canonical Edit variant with legacy title run_terminal_command conflicts -> decline', () => {
  assert.equal(classifyGrokOperation('run_terminal_command', 'edit', 'Edit'), 'decline');
});

// --- Case / prefix near misses ---

test('case mismatch variant "read" (lowercase) is unknown -> manual', () => {
  assert.equal(classifyGrokOperation('read', 'read', 'read'), 'manual');
});

test('case mismatch variant "BASH" is unknown -> manual', () => {
  assert.equal(classifyGrokOperation('BASH', 'execute', 'BASH'), 'manual');
});

test('prefix near-miss variant "Reader" is unknown -> manual', () => {
  assert.equal(classifyGrokOperation('Reader', 'read', 'Reader'), 'manual');
});

test('prefix near-miss title "read_file_extra" without variant -> manual', () => {
  assert.equal(classifyGrokOperation('read_file_extra', 'read', undefined), 'manual');
});

test('case mismatch legacy title "Read_File" without variant -> manual', () => {
  assert.equal(classifyGrokOperation('Read_File', 'read', undefined), 'manual');
});

// --- Primitive validation ---

test('empty title string declines', () => {
  assert.equal(classifyGrokOperation('', 'read', 'Read'), 'decline');
});

test('empty kind string declines', () => {
  assert.equal(classifyGrokOperation('Read', '', 'Read'), 'decline');
});

test('non-string title declines', () => {
  assert.equal(classifyGrokOperation(123, 'read', 'Read'), 'decline');
});

test('non-string kind declines', () => {
  assert.equal(classifyGrokOperation('Read', 123, 'Read'), 'decline');
});

test('null title declines', () => {
  assert.equal(classifyGrokOperation(null, 'read', 'Read'), 'decline');
});

test('null kind declines', () => {
  assert.equal(classifyGrokOperation('Read', null, 'Read'), 'decline');
});

test('undefined title declines', () => {
  assert.equal(classifyGrokOperation(undefined, 'read', 'Read'), 'decline');
});

test('non-string non-empty variant declines (number)', () => {
  assert.equal(classifyGrokOperation('Read', 'read', 123), 'decline');
});

test('empty string variant declines', () => {
  assert.equal(classifyGrokOperation('Read', 'read', ''), 'decline');
});

test('object variant declines without property access/coercion triggering throw', () => {
  const trap = {
    toString() { throw new Error('should not be called'); },
    valueOf() { throw new Error('should not be called'); },
    get prop() { throw new Error('should not be called'); }
  };
  assert.equal(classifyGrokOperation('Read', 'read', trap), 'decline');
});

test('object title declines without invoking throwing methods', () => {
  const trap = {
    toString() { throw new Error('should not be called'); },
    valueOf() { throw new Error('should not be called'); }
  };
  assert.equal(classifyGrokOperation(trap, 'read', 'Read'), 'decline');
});

test('object kind declines without invoking throwing methods', () => {
  const trap = {
    toString() { throw new Error('should not be called'); },
    valueOf() { throw new Error('should not be called'); }
  };
  assert.equal(classifyGrokOperation('Read', trap, 'Read'), 'decline');
});

test('array as title declines (not a primitive string)', () => {
  assert.equal(classifyGrokOperation(['Read'], 'read', 'Read'), 'decline');
});

test('boolean as kind declines', () => {
  assert.equal(classifyGrokOperation('Read', true, 'Read'), 'decline');
});

// --- Unknown titles without variant ---

test('unknown title without variant is manual', () => {
  assert.equal(classifyGrokOperation('some_unknown_tool', 'other', undefined), 'manual');
});

test('no MCP title fallback: use_tool-like legacy title absent, UseTool canonical required', () => {
  assert.equal(classifyGrokOperation('use_tool', 'other', undefined), 'manual');
});

// --- Negative: display text cannot grant operation ---

test('negative: arbitrary descriptive task title alone (no variant) does not grant subagent', () => {
  assert.equal(classifyGrokOperation('Investigate failing build and report back', 'other', undefined), 'manual');
});

test('negative: Write human title alone (no variant) does not grant file', () => {
  assert.equal(classifyGrokOperation('Write `notes.md`', 'edit', undefined), 'manual');
});
