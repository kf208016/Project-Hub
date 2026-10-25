'use strict';

/*
 * Pure per-run Claude CLI stream lineage helper.
 * No filesystem, process, environment, auth, network, timer, spawn or
 * execution authority of any kind. Providing a tool name NEVER grants
 * permission; this module only tracks lineage bookkeeping for a single
 * scope instance.
 */

const TOOLS = Object.freeze([
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
]);

const FIXED_MESSAGE = 'Claude native subagent scope violation';
const FIXED_CODE = 'CLAUDE_NATIVE_SUBAGENT_SCOPE';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

const MAX_TOOLS = 4096;
const MAX_ARRAY = 4096;
const MAX_NAME_LEN = 256;
const MAX_PROMPT_BYTES = 65536;
const MAX_DEPTH = 24;

class InternalFail extends Error {}

function fail() {
  throw new InternalFail();
}

function makeScopeError() {
  const e = new Error(FIXED_MESSAGE);
  e.code = FIXED_CODE;
  return e;
}

function isPrimitiveString(v) {
  return typeof v === 'string';
}

function isValidId(v) {
  return isPrimitiveString(v) && ID_RE.test(v);
}

function isWellFormedUnicode(s) {
  if (typeof s !== 'string') return false;
  if (typeof s.isWellFormed === 'function') {
    return s.isWellFormed();
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasNameForbiddenControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0 && c <= 31) || c === 127) return true;
  }
  return false;
}

function hasPromptForbiddenControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c >= 1 && c <= 31 && c !== 9 && c !== 10 && c !== 13) return true;
    if (c === 127) return true;
  }
  return false;
}

function byteLenUtf8(s) {
  return Buffer.byteLength(s, 'utf8');
}

function validateToolName(name) {
  if (!isPrimitiveString(name)) fail();
  if (name.length < 1 || name.length > MAX_NAME_LEN) fail();
  if (!isWellFormedUnicode(name)) fail();
  if (hasNameForbiddenControl(name)) fail();
}

function validatePromptText(s, allowLarge) {
  if (!isPrimitiveString(s)) fail();
  if (s.length === 0) fail();
  if (!isWellFormedUnicode(s)) fail();
  if (hasPromptForbiddenControl(s)) fail();
  const bytes = byteLenUtf8(s);
  if (bytes > MAX_PROMPT_BYTES) fail();
  return bytes;
}

function getOwnDataString(obj, key) {
  if (obj === null || typeof obj !== 'object') fail();
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) fail();
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) fail();
  if (!('value' in desc)) fail();
  const v = desc.value;
  if (typeof v !== 'string') fail();
  return v;
}

function assertPlainObjectNoSymbols(obj) {
  if (obj === null || typeof obj !== 'object') fail();
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) fail();
  const syms = Object.getOwnPropertySymbols(obj);
  if (syms.length) fail();
}

function ownKeysExact(obj, allowed) {
  assertPlainObjectNoSymbols(obj);
  const keys = Object.getOwnPropertyNames(obj);
  if (keys.length !== allowed.length) fail();
  for (const k of keys) {
    if (!allowed.includes(k)) fail();
  }
}

function safeArrayCopy(value) {
  if (!Array.isArray(value)) fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Array.prototype) fail();
  const syms = Object.getOwnPropertySymbols(value);
  if (syms.length) fail();
  const lenDesc = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lenDesc || !('value' in lenDesc)) fail();
  const len = lenDesc.value;
  if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > MAX_ARRAY) fail();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== len + 1) fail();
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    const key = String(i);
    if (!names.includes(key)) fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d) fail();
    if (!('value' in d)) fail();
    result[i] = d.value;
  }
  return result;
}

function createScopeInner() {
  const tools = new Map(); // id -> { name, parent, depth }
  const resultsConsumed = new Set(); // tool_use ids consumed
  const childPromptConsumed = new Set(); // parentId -> consumed first prompt
  const childPromptBlocked = new Set(); // parentId -> a result arrived first

  function assertParentCore(parentId) {
    if (parentId === null) return null;
    if (!isValidId(parentId)) fail();
    const entry = tools.get(parentId);
    if (!entry) fail();
    if (entry.name !== 'Agent' && entry.name !== 'Task') fail();
    return parentId;
  }

  function assertParent(parentId) {
    return assertParentCore(parentId);
  }

  function registerTool(id, name, parentId) {
    if (!isValidId(id)) fail();
    if (tools.has(id)) fail();
    if (tools.size >= MAX_TOOLS) fail();
    validateToolName(name);

    let depth;
    if (parentId === null) {
      depth = 0;
    } else {
      const validParent = assertParentCore(parentId);
      const parentEntry = tools.get(validParent);
      depth = parentEntry.depth + 1;
      if (depth > MAX_DEPTH) fail();
    }

    tools.set(id, { name, parent: parentId, depth });
    return undefined;
  }

  function consumeTextArrayPrompt(parentId, arr) {
    if (parentId === null) fail(); // root cannot consume a text-block array
    if (childPromptConsumed.has(parentId)) fail();
    if (childPromptBlocked.has(parentId)) fail();

    let totalBytes = 0;
    for (const el of arr) {
      ownKeysExact(el, ['type', 'text']);
      const type = getOwnDataString(el, 'type');
      if (type !== 'text') fail();
      const text = getOwnDataString(el, 'text');
      if (text.length === 0) fail();
      if (!isWellFormedUnicode(text)) fail();
      if (hasPromptForbiddenControl(text)) fail();
      totalBytes += byteLenUtf8(text);
      if (totalBytes > MAX_PROMPT_BYTES) fail();
    }

    childPromptConsumed.add(parentId);
    return 'prompt';
  }

  function consumeResultArray(parentId, arr) {
    const seen = new Set();
    const ids = [];
    for (const el of arr) {
      assertPlainObjectNoSymbols(el);
      const type = getOwnDataString(el, 'type');
      if (type !== 'tool_result') fail();
      const toolUseId = getOwnDataString(el, 'tool_use_id');
      if (!isValidId(toolUseId)) fail();
      if (seen.has(toolUseId)) fail();
      seen.add(toolUseId);

      const entry = tools.get(toolUseId);
      if (!entry) fail();
      if (entry.parent !== parentId) fail();
      if (resultsConsumed.has(toolUseId)) fail();
      ids.push(toolUseId);
    }

    // Atomic commit only after full batch validated.
    for (const id of ids) {
      resultsConsumed.add(id);
    }
    if (parentId !== null) {
      childPromptBlocked.add(parentId);
    }
    return 'results';
  }

  function consumeUser(parentId, content) {
    const validParent = assertParentCore(parentId);

    if (isPrimitiveString(content)) {
      if (validParent === null) {
        validatePromptText(content, true);
        return 'prompt';
      }
      validatePromptText(content, false);
      if (childPromptConsumed.has(validParent)) fail();
      if (childPromptBlocked.has(validParent)) fail();
      childPromptConsumed.add(validParent);
      return 'prompt';
    }

    if (Array.isArray(content)) {
      const arr = safeArrayCopy(content);
      if (arr.length === 0) fail();

      let allText = true;
      let allResult = true;
      for (const el of arr) {
        if (el === null || typeof el !== 'object') {
          allText = false;
          allResult = false;
          break;
        }
        const typeDesc = Object.getOwnPropertyDescriptor(el, 'type');
        if (!typeDesc || !('value' in typeDesc) || typeof typeDesc.value !== 'string') {
          allText = false;
          allResult = false;
          break;
        }
        if (typeDesc.value === 'text') {
          allResult = false;
        } else if (typeDesc.value === 'tool_result') {
          allText = false;
        } else {
          allText = false;
          allResult = false;
          break;
        }
      }

      if (allText && !allResult) {
        return consumeTextArrayPrompt(validParent, arr);
      }
      if (allResult && !allText) {
        return consumeResultArray(validParent, arr);
      }
      fail();
    }

    fail();
  }

  return { assertParent, registerTool, consumeUser };
}

function wrapMethod(fn) {
  return function wrapped(...args) {
    try {
      return fn(...args);
    } catch (_e) {
      throw makeScopeError();
    }
  };
}

function createScope() {
  const inner = createScopeInner();
  const scope = {
    assertParent: wrapMethod(inner.assertParent),
    registerTool: wrapMethod(inner.registerTool),
    consumeUser: wrapMethod(inner.consumeUser)
  };
  return Object.freeze(scope);
}

module.exports = Object.freeze({
  TOOLS,
  createScope
});
