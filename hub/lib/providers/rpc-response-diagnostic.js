// Sonnet implementation, locally reviewed; diagnostics never grant execution authority.
'use strict';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const ALLOWED_RELATIONS = ['pending', 'already-replied', 'server-request'];
const ALLOWED_METHODS = ['initialize', 'session/new', 'session/load', 'session/set_model', 'session/prompt'];
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

function isPlainObjectLike(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  let proto;
  try {
    proto = Object.getPrototypeOf(v);
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj, key) {
  if (!isPlainObjectLike(obj)) return false;
  try {
    return Object.prototype.hasOwnProperty.call(obj, key);
  } catch {
    return false;
  }
}

function getOwnDataValue(obj, key) {
  if (!hasOwn(obj, key)) return { present: false, value: undefined };
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return { present: false, value: undefined };
  }
  if (!desc || !(Object.hasOwn(desc, 'value'))) return { present: false, value: undefined };
  return { present: true, value: desc.value };
}

function isSafeNonNegInt(n) {
  if (typeof n !== 'number') return false;
  if (!Number.isSafeInteger(n)) return false;
  if (n < 0) return false;
  if (n === 0 && Object.is(n, -0)) return false;
  return true;
}

function computeIdType(frame) {
  const idField = getOwnDataValue(frame, 'id');
  if (!idField.present) return 'invalid';
  const v = idField.value;
  if (typeof v === 'string' && ID_RE.test(v)) return 'string';
  if (typeof v === 'number' && isSafeNonNegInt(v)) return 'number';
  return 'invalid';
}

function computeIdRelation(context) {
  const rel = getOwnDataValue(context, 'idRelation');
  if (rel.present && typeof rel.value === 'string' && ALLOWED_RELATIONS.includes(rel.value)) {
    return rel.value;
  }
  return 'unknown';
}

function computePendingMethods(context) {
  const field = getOwnDataValue(context, 'pendingMethods');
  const out = new Set();
  if (!field.present) return Object.freeze([]);
  const arr = field.value;
  if (!Array.isArray(arr)) return Object.freeze([]);
  let proto;
  try {
    proto = Object.getPrototypeOf(arr);
  } catch {
    return Object.freeze([]);
  }
  if (proto !== Array.prototype) return Object.freeze([]);
  const limit = Math.min(64, arr.length >>> 0 === arr.length ? arr.length : 64);
  for (let i = 0; i < limit; i++) {
    let present;
    try {
      present = Object.prototype.hasOwnProperty.call(arr, i);
    } catch {
      continue;
    }
    if (!present) continue;
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(arr, i);
    } catch {
      continue;
    }
    if (!desc || !(Object.hasOwn(desc, 'value'))) continue;
    const v = desc.value;
    if (typeof v === 'string' && ALLOWED_METHODS.includes(v)) {
      out.add(v);
    }
  }
  return Object.freeze(Array.from(out).sort());
}

function matchMcpInitialize(r) {
  const pv = getOwnDataValue(r, 'protocolVersion');
  const cap = getOwnDataValue(r, 'capabilities');
  const si = getOwnDataValue(r, 'serverInfo');
  const hasAgentCap = hasOwn(r, 'agentCapabilities');
  return (
    pv.present && typeof pv.value === 'string' &&
    cap.present && isPlainObjectLike(cap.value) &&
    si.present && isPlainObjectLike(si.value) &&
    !hasAgentCap
  );
}

function matchAcpInitialize(r) {
  const pv = getOwnDataValue(r, 'protocolVersion');
  const ac = getOwnDataValue(r, 'agentCapabilities');
  return pv.present && Number.isSafeInteger(pv.value) && ac.present && isPlainObjectLike(ac.value);
}

function matchAcpSession(r) {
  const sid = getOwnDataValue(r, 'sessionId');
  return sid.present && typeof sid.value === 'string' && ID_RE.test(sid.value);
}

function matchAcpStop(r) {
  const sr = getOwnDataValue(r, 'stopReason');
  return sr.present && typeof sr.value === 'string' && STOP_REASONS.has(sr.value);
}

function computeResultShape(resultValue) {
  if (!isPlainObjectLike(resultValue)) return 'other';
  const matches = [];
  if (matchMcpInitialize(resultValue)) matches.push('mcp-initialize');
  if (matchAcpInitialize(resultValue)) matches.push('acp-initialize');
  if (matchAcpSession(resultValue)) matches.push('acp-session');
  if (matchAcpStop(resultValue)) matches.push('acp-stop');
  if (matches.length === 1) return matches[0];
  return 'other';
}

function computeResponseKind(frame) {
  const hasResult = hasOwn(frame, 'result');
  const hasError = hasOwn(frame, 'error');
  const count = (hasResult ? 1 : 0) + (hasError ? 1 : 0);
  if (count !== 1) return { kind: 'invalid', value: undefined };
  if (hasResult) {
    const rv = getOwnDataValue(frame, 'result');
    if (!rv.present) return { kind: 'invalid', value: undefined };
    return { kind: 'result', value: rv.value };
  }
  const ev = getOwnDataValue(frame, 'error');
  if (!ev.present) return { kind: 'invalid', value: undefined };
  return { kind: 'error', value: ev.value };
}

function computeErrorCode(errorValue) {
  if (!isPlainObjectLike(errorValue)) return null;
  const code = getOwnDataValue(errorValue, 'code');
  if (code.present && Number.isSafeInteger(code.value)) return code.value;
  return null;
}

function describeResponse(frame, context) {
  const isFrameObject = isPlainObjectLike(frame);

  let idType = 'invalid';
  let responseKind = 'invalid';
  let resultShape = 'none';
  let errorCode = null;

  if (isFrameObject) {
    idType = computeIdType(frame);
    const rk = computeResponseKind(frame);
    responseKind = rk.kind;
    if (responseKind === 'result') {
      resultShape = computeResultShape(rk.value);
    } else if (responseKind === 'error') {
      resultShape = 'none';
      errorCode = computeErrorCode(rk.value);
    } else {
      resultShape = 'none';
    }
  }

  const idRelation = computeIdRelation(context);
  const pendingMethods = computePendingMethods(context);

  const out = {
    version: 1,
    idType,
    idRelation,
    responseKind,
    resultShape,
    errorCode,
    pendingMethods,
  };

  return Object.freeze(out);
}

module.exports = { describeResponse };
