// Sonnet implementation, locally reviewed against fixed Grok source and an offline native watcher reproduction.
'use strict';

// Pure, bounded classifier for the two exact documented passive watcher ACK
// shapes produced by xai-org/grok-build's internal skills/workflows reload
// notices. See module-level requirements in the task description for the
// exact wire contract. This function proves nothing about identity, auth,
// session binding, model choice, or RPC completion; it only recognizes two
// inert ACK shapes so a caller may discard them.

function isDataOwnKeysOnly(obj, maxKeys) {
  // obj must be a non-null object already confirmed to have Object.prototype
  // or null prototype. Bounds property enumeration work.
  if (Object.getOwnPropertySymbols(obj).length !== 0) return null;
  const keys = Object.keys(obj);
  if (keys.length > maxKeys) return null;
  const descs = Object.getOwnPropertyDescriptors(obj);
  const ownNames = Object.getOwnPropertyNames(obj);
  if (ownNames.length !== keys.length) return null; // no hidden non-enum own props beyond enumerated
  for (const k of keys) {
    const d = descs[k];
    if (!d) return null;
    if (!(Object.hasOwn(d, 'value'))) return null; // reject accessor get/set
    if (d.enumerable !== true) return null;
  }
  return keys;
}

function isPlainRecord(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return true;
}

function getRecordValue(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d || !(Object.hasOwn(d, 'value'))) return { ok: false };
  return { ok: true, value: d.value };
}

function isSafeNonNegativeInteger(n) {
  if (typeof n !== 'number') return false;
  if (!Number.isInteger(n)) return false;
  if (!Number.isSafeInteger(n)) return false;
  if (n < 0) return false;
  if (Object.is(n, -0)) return false;
  return true;
}

function classifyWatcherAck(frame) {
  if (!isPlainRecord(frame)) return null;
  const topKeys = isDataOwnKeysOnly(frame, 3);
  if (!topKeys) return null;
  if (topKeys.length !== 3) return null;
  const topSet = new Set(topKeys);
  if (!topSet.has('jsonrpc') || !topSet.has('id') || !topSet.has('result')) return null;

  const jr = getRecordValue(frame, 'jsonrpc');
  if (!jr.ok || jr.value !== '2.0') return null;

  const idv = getRecordValue(frame, 'id');
  if (!idv.ok) return null;
  let kind;
  if (idv.value === 'skills-reload') kind = 'skills';
  else if (idv.value === 'workflows-reload') kind = 'workflows';
  else return null;

  const resv = getRecordValue(frame, 'result');
  if (!resv.ok) return null;
  const outer = resv.value;
  if (!isPlainRecord(outer)) return null;
  const outerKeys = isDataOwnKeysOnly(outer, 1);
  if (!outerKeys || outerKeys.length !== 1 || outerKeys[0] !== 'result') return null;

  const innerv = getRecordValue(outer, 'result');
  if (!innerv.ok) return null;
  const inner = innerv.value;
  if (!isPlainRecord(inner)) return null;
  const innerKeys = isDataOwnKeysOnly(inner, 1);
  if (!innerKeys || innerKeys.length !== 1 || innerKeys[0] !== 'reloaded') return null;

  const reloadedv = getRecordValue(inner, 'reloaded');
  if (!reloadedv.ok) return null;
  if (!isSafeNonNegativeInteger(reloadedv.value)) return null;

  return kind;
}

module.exports = { classifyWatcherAck };
