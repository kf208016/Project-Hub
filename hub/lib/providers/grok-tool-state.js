'use strict';

// ACP v1 tool-state reducer (generic, protocol-only; no IO, no execution authority).

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const STATUSES = ['pending', 'in_progress', 'completed', 'failed'];
const TERMINAL = new Set(['completed', 'failed']);

const MAX_DEPTH = 24;
const MAX_NODES = 32768;

function makeError(code) {
  const err = new Error('tool state error');
  err.code = code;
  return err;
}

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validateString(s) {
  if (s.indexOf('\u0000') !== -1) throw makeError('GROK_NATIVE_INVALID_JSON');
  if (!s.isWellFormed()) throw makeError('GROK_NATIVE_INVALID_JSON');
}

function assertValidJson(root) {
  let count = 0;
  const stack = [];

  function walk(v, depth) {
    if (depth > MAX_DEPTH) throw makeError('GROK_NATIVE_INVALID_JSON');
    count += 1;
    if (count > MAX_NODES) throw makeError('GROK_NATIVE_INVALID_JSON');

    if (v === null) return;
    const t = typeof v;
    if (t === 'boolean') return;
    if (t === 'number') {
      if (!Number.isFinite(v) || Math.abs(v)>Number.MAX_SAFE_INTEGER) throw makeError('GROK_NATIVE_INVALID_JSON');
      return;
    }
    if (t === 'string') {
      validateString(v);
      return;
    }
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v)!==Array.prototype || Object.getOwnPropertySymbols(v).length || Object.getOwnPropertyNames(v).length!==v.length+1) throw makeError('GROK_NATIVE_INVALID_JSON');
      if (stack.indexOf(v) !== -1) throw makeError('GROK_NATIVE_INVALID_JSON');
      stack.push(v);
      for (let i = 0; i < v.length; i += 1) {
        const descriptor=Object.getOwnPropertyDescriptor(v,String(i));
        if(!descriptor||!Object.hasOwn(descriptor,'value'))throw makeError('GROK_NATIVE_INVALID_JSON');
        walk(descriptor.value, depth + 1);
      }
      stack.pop();
      return;
    }
    if (t === 'object') {
      if (!isPlainObject(v)) throw makeError('GROK_NATIVE_INVALID_JSON');
      if (Object.getOwnPropertySymbols(v).length) throw makeError('GROK_NATIVE_INVALID_JSON');
      if (stack.indexOf(v) !== -1) throw makeError('GROK_NATIVE_INVALID_JSON');
      stack.push(v);
      const keys = Object.keys(v);
      if (Object.getOwnPropertyNames(v).length!==keys.length) throw makeError('GROK_NATIVE_INVALID_JSON');
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        validateString(key);
        const descriptor=Object.getOwnPropertyDescriptor(v,key);
        if (!descriptor || !Object.hasOwn(descriptor,'value')) throw makeError('GROK_NATIVE_INVALID_JSON');
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw makeError('GROK_NATIVE_INVALID_JSON');
        }
        const val = v[key];
        if (val === undefined) throw makeError('GROK_NATIVE_INVALID_JSON');
        walk(val, depth + 1);
      }
      stack.pop();
      return;
    }
    throw makeError('GROK_NATIVE_INVALID_JSON');
  }

  walk(root, 0);
}

function cloneJson(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneJson);
  const out = {};
  const keys = Object.keys(v);
  for (let i = 0; i < keys.length; i += 1) out[keys[i]] = cloneJson(v[keys[i]]);
  return out;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }
  return a === b;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

const RESERVED_KEYS = new Set([
  'toolCallId',
  'status',
  'title',
  'kind',
  'name',
  'rawInput',
  'rawOutput',
  'content',
  'locations',
  'requested',
  'locked',
]);

function nextToolState(previous, update, options) {
  const opts = options===undefined?{}:options;
  if(!isPlainObject(opts))throw makeError('GROK_NATIVE_TOOL_OPTIONS');
  assertValidJson(opts);
  if(Object.keys(opts).some(k=>!['initial','permission','locked'].includes(k)||typeof opts[k]!=='boolean'))throw makeError('GROK_NATIVE_TOOL_OPTIONS');
  const isInitial = opts.initial === true;
  const isPermission = opts.permission === true;
  const isLocked = opts.locked === true;

  if (!isPlainObject(update)) throw makeError('GROK_NATIVE_INVALID_JSON');
  assertValidJson(update);

  const toolCallId = update.toolCallId;
  if (typeof toolCallId !== 'string' || !ID_RE.test(toolCallId)) {
    throw makeError('GROK_NATIVE_INVALID_ID');
  }

  let prev = null;
  if (previous !== null && previous !== undefined) {
    if (!isPlainObject(previous)) throw makeError('GROK_NATIVE_INVALID_JSON');
    assertValidJson(previous);
    if (typeof previous.toolCallId !== 'string' || !ID_RE.test(previous.toolCallId)) {
      throw makeError('GROK_NATIVE_INVALID_ID');
    }
    prev = previous;
    if(!STATUSES.includes(prev.status))throw makeError('GROK_NATIVE_INVALID_FIELD');
  }

  if (isInitial && prev !== null) {
    throw makeError('GROK_NATIVE_INVALID_FIELD');
  }

  if (!isInitial && prev === null && !isPermission) {
    throw makeError('GROK_NATIVE_NO_PREVIOUS');
  }

  if (prev !== null && prev.toolCallId !== toolCallId) {
    throw makeError('GROK_NATIVE_ID_MISMATCH');
  }

  if (isPermission && isLocked) {
    throw makeError('GROK_NATIVE_PERMISSION_INVALID');
  }

  const base = prev
    ? {
        toolCallId: prev.toolCallId,
        status: prev.status,
        title: 'title' in prev ? prev.title : undefined,
        kind: 'kind' in prev ? prev.kind : undefined,
        name: 'name' in prev ? prev.name : undefined,
        rawInput: 'rawInput' in prev ? cloneJson(prev.rawInput) : undefined,
        rawOutput: 'rawOutput' in prev ? cloneJson(prev.rawOutput) : undefined,
        content: 'content' in prev ? cloneJson(prev.content) : undefined,
        locations: 'locations' in prev ? cloneJson(prev.locations) : undefined,
        extra: {},
      }
    : {
        toolCallId,
        status: 'pending',
        title: undefined,
        kind: undefined,
        name: undefined,
        rawInput: undefined,
        rawOutput: undefined,
        content: undefined,
        locations: undefined,
        extra: {},
      };

  if (prev) {
    const keys = Object.keys(prev);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (!RESERVED_KEYS.has(k)) base.extra[k] = cloneJson(prev[k]);
    }
  }

  // status
  let newStatus = base.status;
  if (update.status !== undefined) {
    if (typeof update.status !== 'string' || STATUSES.indexOf(update.status) === -1) {
      throw makeError('GROK_NATIVE_INVALID_FIELD');
    }
    newStatus = update.status;
  }
  if (TERMINAL.has(base.status) && newStatus !== base.status) {
    throw makeError('GROK_NATIVE_STATUS_REGRESSION');
  }
  if (base.status === 'in_progress' && newStatus === 'pending') {
    throw makeError('GROK_NATIVE_STATUS_REGRESSION');
  }

  // title
  let newTitle = base.title;
  if (update.title !== undefined) {
    if (!isNonEmptyString(update.title)) throw makeError('GROK_NATIVE_INVALID_FIELD');
    newTitle = update.title;
  }

  // kind
  let newKind = base.kind;
  if (update.kind !== undefined) {
    if (!isNonEmptyString(update.kind)) throw makeError('GROK_NATIVE_INVALID_FIELD');
    if (isLocked && base.kind !== undefined && update.kind !== base.kind) {
      throw makeError('GROK_NATIVE_TOOL_CHANGED');
    }
    newKind = update.kind;
  }

  // name: null or absent => retain
  let newName = base.name;
  if (update.name !== undefined && update.name !== null) {
    if (!isNonEmptyString(update.name)) throw makeError('GROK_NATIVE_INVALID_FIELD');
    if (isLocked && base.name !== undefined && update.name !== base.name) {
      throw makeError('GROK_NATIVE_TOOL_CHANGED');
    }
    newName = update.name;
  }

  // rawInput: null or absent => retain
  let newRawInput = base.rawInput;
  if (update.rawInput !== undefined && update.rawInput !== null) {
    if (isLocked && base.rawInput !== undefined && !deepEqual(base.rawInput, update.rawInput)) {
      throw makeError('GROK_NATIVE_TOOL_CHANGED');
    }
    newRawInput = cloneJson(update.rawInput);
  }

  // rawOutput: null or absent => retain
  let newRawOutput = base.rawOutput;
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    newRawOutput = cloneJson(update.rawOutput);
  }

  // content
  let newContent = base.content;
  if (update.content !== undefined) {
    if (!Array.isArray(update.content)) throw makeError('GROK_NATIVE_INVALID_FIELD');
    newContent = cloneJson(update.content);
  }

  // locations
  let newLocations = base.locations;
  if (update.locations !== undefined) {
    if (!Array.isArray(update.locations)) throw makeError('GROK_NATIVE_INVALID_FIELD');
    newLocations = cloneJson(update.locations);
  }

  // inert extension fields (skip reserved and requested/locked explicitly)
  const extra = {};
  const extraKeys = Object.keys(base.extra);
  for (let i = 0; i < extraKeys.length; i += 1) extra[extraKeys[i]] = base.extra[extraKeys[i]];
  const updateKeys = Object.keys(update);
  for (let i = 0; i < updateKeys.length; i += 1) {
    const k = updateKeys[i];
    if (RESERVED_KEYS.has(k)) continue;
    extra[k] = cloneJson(update[k]);
  }

  if (isPermission) {
    if (newStatus !== 'pending' && newStatus !== 'in_progress') {
      throw makeError('GROK_NATIVE_PERMISSION_INVALID');
    }
    if (!isNonEmptyString(newTitle)) throw makeError('GROK_NATIVE_PERMISSION_INVALID');
    if (!isNonEmptyString(newKind)) throw makeError('GROK_NATIVE_PERMISSION_INVALID');
    if (!isPlainObject(newRawInput)) throw makeError('GROK_NATIVE_PERMISSION_INVALID');
  }

  const result = {
    toolCallId,
    status: newStatus,
  };
  if (newTitle !== undefined) result.title = newTitle;
  if (newKind !== undefined) result.kind = newKind;
  if (newName !== undefined) result.name = newName;
  if (newRawInput !== undefined) result.rawInput = cloneJson(newRawInput);
  if (newRawOutput !== undefined) result.rawOutput = cloneJson(newRawOutput);
  if (newContent !== undefined) result.content = cloneJson(newContent);
  if (newLocations !== undefined) result.locations = cloneJson(newLocations);

  const extraOutKeys = Object.keys(extra);
  for (let i = 0; i < extraOutKeys.length; i += 1) {
    result[extraOutKeys[i]] = cloneJson(extra[extraOutKeys[i]]);
  }

  return result;
}

module.exports = { nextToolState };
