'use strict';

// Pure bounded storage for controller-validated permission requests. Retrieval
// neither approves a request nor changes its original deadline or opaque body.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

function isValidId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && ID_PATTERN.test(value);
}

function isNonNullObject(value) {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function dpFail(code, message) {
  const e = new Error(message);
  e.code = code;
  return Object.freeze(e);
}

function createDeferredPermissions(limit = 16) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
    throw dpFail('E_LIMIT', 'invalid limit');
  }

  const byRequestKey = new Map();
  const byToolCallId = new Map();
  const order = [];

  function add(requestKey, toolCallId, record, expiresAt) {
    if (!isValidId(requestKey)) throw dpFail('E_REQUEST_KEY', 'invalid request key');
    if (!isValidId(toolCallId)) throw dpFail('E_TOOL_ID', 'invalid tool call id');
    if (!isNonNullObject(record)) throw dpFail('E_RECORD', 'invalid record');
    if (!isNonNegativeSafeInteger(expiresAt)) throw dpFail('E_EXPIRES', 'invalid expiresAt');
    if (byRequestKey.has(requestKey)) throw dpFail('E_DUPLICATE_REQUEST', 'duplicate pending request key');
    if (byToolCallId.has(toolCallId)) throw dpFail('E_DUPLICATE_TOOL', 'duplicate pending tool id');
    if (order.length >= limit) throw dpFail('E_CAPACITY', 'capacity exceeded');

    const entry = Object.freeze({ requestKey, toolCallId, record, expiresAt });
    byRequestKey.set(requestKey, entry);
    byToolCallId.set(toolCallId, entry);
    order.push(entry);
  }

  function takeForTool(toolCallId) {
    if (!isValidId(toolCallId)) throw dpFail('E_TOOL_ID', 'invalid tool call id');
    const entry = byToolCallId.get(toolCallId);
    if (!entry) return Object.freeze([]);
    byToolCallId.delete(toolCallId);
    byRequestKey.delete(entry.requestKey);
    const idx = order.indexOf(entry);
    if (idx >= 0) order.splice(idx, 1);
    return Object.freeze([entry]);
  }

  function clear() {
    const all = order.slice();
    order.length = 0;
    byRequestKey.clear();
    byToolCallId.clear();
    return Object.freeze(all);
  }

  function size() {
    return order.length;
  }

  return Object.freeze({ add, takeForTool, clear, size });
}

module.exports = Object.freeze({ createDeferredPermissions });
