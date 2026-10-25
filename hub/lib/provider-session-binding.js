'use strict';

/**
 * Pure CommonJS session binding module for Claude/Grok chat continuity.
 * No IO, no network, no process access. Deterministic, side-effect free.
 */

const ACTORS = ['claude', 'grok'];

const RECORD_KEYS = [
  'version', 'project', 'task', 'actor',
  'runtimeProfileId', 'accountProfileId', 'rootFingerprint', 'providerSessionId'
];

const SCOPE_KEYS = [
  'project', 'task', 'actor', 'runtimeProfileId', 'accountProfileId', 'rootFingerprint'
];

const SHA256_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;


function fail(code) {
  const e = new Error(code);
  e.code = code;
  throw e;
}

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isWellformedString(s, min, max) {
  if (typeof s !== 'string') return false;
  if (s.length < min || s.length > max) return false;
  if (s.indexOf('\u0000') !== -1) return false;
  if (!s.isWellFormed()) return false;
  return true;
}

function hasForbiddenKey(obj) {
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
  }
  return false;
}

function validateRecordShape(rec, expectedActorKey, codeOnFail) {
  if (!isPlainObject(rec)) fail(codeOnFail);
  if (hasForbiddenKey(rec)) fail(codeOnFail);
  const keys = Object.keys(rec);
  if (keys.length !== RECORD_KEYS.length) fail(codeOnFail);
  for (const k of RECORD_KEYS) {
    if (!Object.hasOwn(rec, k)) fail(codeOnFail);
  }
  for (const k of keys) {
    if (!RECORD_KEYS.includes(k)) fail(codeOnFail);
  }
  if (rec.version !== 1) fail(codeOnFail);
  if (!isWellformedString(rec.project, 1, 256)) fail(codeOnFail);
  if (!isWellformedString(rec.task, 1, 256)) fail(codeOnFail);
  if (!ACTORS.includes(rec.actor)) fail(codeOnFail);
  if (rec.actor !== expectedActorKey) fail(codeOnFail);
  if (!isWellformedString(rec.runtimeProfileId, 1, 256)) fail(codeOnFail);
  if (!isWellformedString(rec.accountProfileId, 1, 256)) fail(codeOnFail);
  if (typeof rec.rootFingerprint !== 'string' || !SHA256_RE.test(rec.rootFingerprint)) fail(codeOnFail);
  if (typeof rec.providerSessionId !== 'string' ||
      rec.providerSessionId.length < 1 || rec.providerSessionId.length > 256 ||
      !SID_RE.test(rec.providerSessionId)) fail(codeOnFail);
  return true;
}

function cloneRecord(rec) {
  const out = {
    version: 1,
    project: rec.project,
    task: rec.task,
    actor: rec.actor,
    runtimeProfileId: rec.runtimeProfileId,
    accountProfileId: rec.accountProfileId,
    rootFingerprint: rec.rootFingerprint,
    providerSessionId: rec.providerSessionId
  };
  return Object.freeze(out);
}

function validate(meta) {
  if (!isPlainObject(meta)) fail('SESSION_BINDING_CORRUPT');
  if (hasForbiddenKey(meta)) fail('SESSION_BINDING_CORRUPT');

  let sessions;
  if (Object.hasOwn(meta, 'sessions')) {
    sessions = meta.sessions;
    if (!isPlainObject(sessions)) fail('SESSION_BINDING_CORRUPT');
    if (hasForbiddenKey(sessions)) fail('SESSION_BINDING_CORRUPT');
    for (const k of Object.keys(sessions)) {
      const v = sessions[k];
      if (!isWellformedString(v, 1, 256)) fail('SESSION_BINDING_CORRUPT');
    }
  }

  let bindings;
  if (Object.hasOwn(meta, 'providerBindings')) {
    bindings = meta.providerBindings;
    if (!isPlainObject(bindings)) fail('SESSION_BINDING_CORRUPT');
    if (hasForbiddenKey(bindings)) fail('SESSION_BINDING_CORRUPT');
    const bKeys = Object.keys(bindings);
    for (const k of bKeys) {
      if (!ACTORS.includes(k)) fail('SESSION_BINDING_CORRUPT');
    }
    for (const actor of bKeys) {
      validateRecordShape(bindings[actor], actor, 'SESSION_BINDING_CORRUPT');
    }
    // cross-actor sid collision
    if (bKeys.length === 2) {
      const [a, b] = bKeys;
      if (bindings[a].providerSessionId === bindings[b].providerSessionId) {
        fail('SESSION_BINDING_CORRUPT');
      }
    }
    // Every binding must agree with an owned native session entry.
    for (const actor of bKeys) {
      if (!sessions || !Object.hasOwn(sessions, actor) ||
          sessions[actor] !== bindings[actor].providerSessionId) {
        fail('SESSION_BINDING_CORRUPT');
      }
    }
  }

  return true;
}

function validateScope(scope) {
  if (!isPlainObject(scope)) fail('SESSION_SCOPE_INVALID');
  if (hasForbiddenKey(scope)) fail('SESSION_SCOPE_INVALID');
  const keys = Object.keys(scope);
  if (keys.length !== SCOPE_KEYS.length) fail('SESSION_SCOPE_INVALID');
  for (const k of SCOPE_KEYS) {
    if (!Object.hasOwn(scope, k)) fail('SESSION_SCOPE_INVALID');
  }
  for (const k of keys) {
    if (!SCOPE_KEYS.includes(k)) fail('SESSION_SCOPE_INVALID');
  }
  if (!ACTORS.includes(scope.actor)) fail('SESSION_SCOPE_INVALID');
  if (!isWellformedString(scope.project, 1, 256)) fail('SESSION_SCOPE_INVALID');
  if (!isWellformedString(scope.task, 1, 256)) fail('SESSION_SCOPE_INVALID');
  if (!isWellformedString(scope.runtimeProfileId, 1, 256)) fail('SESSION_SCOPE_INVALID');
  if (!isWellformedString(scope.accountProfileId, 1, 256)) fail('SESSION_SCOPE_INVALID');
  if (typeof scope.rootFingerprint !== 'string' || !SHA256_RE.test(scope.rootFingerprint)) {
    fail('SESSION_SCOPE_INVALID');
  }
  return true;
}

function scopeMatchesRecord(scope, rec) {
  return scope.project === rec.project &&
    scope.task === rec.task &&
    scope.runtimeProfileId === rec.runtimeProfileId &&
    scope.accountProfileId === rec.accountProfileId &&
    scope.rootFingerprint === rec.rootFingerprint;
}

function resolve(meta, scope) {
  validate(meta);
  validateScope(scope);

  const actor = scope.actor;
  const bindings = Object.hasOwn(meta, 'providerBindings') ? meta.providerBindings : undefined;
  const sessions = Object.hasOwn(meta, 'sessions') ? meta.sessions : undefined;

  const binding = bindings && Object.hasOwn(bindings, actor) ? bindings[actor] : undefined;
  const legacy = sessions && Object.hasOwn(sessions, actor);

  if (!binding && !legacy) {
    return Object.freeze({ resume: false, sessionId: null, binding: null });
  }

  if (!binding && legacy) {
    fail('SESSION_BINDING_REQUIRED');
  }

  if (!scopeMatchesRecord(scope, binding)) {
    fail('SESSION_SCOPE_CHANGED');
  }

  const clonedRecord = cloneRecord(binding);
  return Object.freeze({
    resume: true,
    sessionId: clonedRecord.providerSessionId,
    binding: clonedRecord
  });
}

function bind(meta, scope, providerSessionId) {
  validate(meta);
  validateScope(scope);

  if (typeof providerSessionId !== 'string' ||
      providerSessionId.length < 1 || providerSessionId.length > 256 ||
      !SID_RE.test(providerSessionId)) {
    fail('SESSION_SCOPE_INVALID');
  }

  const actor = scope.actor;
  const bindings = Object.hasOwn(meta, 'providerBindings') ? meta.providerBindings : undefined;
  const sessions = Object.hasOwn(meta, 'sessions') ? meta.sessions : undefined;

  const existingBinding = bindings && Object.hasOwn(bindings, actor) ? bindings[actor] : undefined;
  const legacy = sessions && Object.hasOwn(sessions, actor);

  if (!existingBinding && legacy) {
    fail('SESSION_BINDING_REQUIRED');
  }

  if (existingBinding) {
    if (!scopeMatchesRecord(scope, existingBinding)) {
      fail('SESSION_SCOPE_CHANGED');
    }
    if (existingBinding.providerSessionId !== providerSessionId) {
      fail('SESSION_REPLACEMENT_REQUIRED');
    }
  }

  // cross-actor sid collision check against the OTHER actor
  const otherActor = actor === 'claude' ? 'grok' : 'claude';
  if (bindings && Object.hasOwn(bindings, otherActor)) {
    if (bindings[otherActor].providerSessionId === providerSessionId) {
      fail('SESSION_BINDING_CORRUPT');
    }
  }

  for (const [key, value] of Object.entries(sessions || {})) {
    if (key !== actor && value === providerSessionId) fail('SESSION_BINDING_CORRUPT');
  }

  const newRecord = cloneRecord({
    version: 1,
    project: scope.project,
    task: scope.task,
    actor,
    runtimeProfileId: scope.runtimeProfileId,
    accountProfileId: scope.accountProfileId,
    rootFingerprint: scope.rootFingerprint,
    providerSessionId
  });

  const newSessions = Object.assign({}, sessions || {});
  newSessions[actor] = providerSessionId;
  Object.freeze(newSessions);

  const newBindings = Object.assign({}, bindings || {});
  newBindings[actor] = newRecord;
  Object.freeze(newBindings);

  const newMeta = Object.assign({}, meta);
  newMeta.sessions = newSessions;
  newMeta.providerBindings = newBindings;

  return newMeta;
}

function retire(meta, actor, info) {
  if (!ACTORS.includes(actor)) fail('SESSION_SCOPE_INVALID');
  if (!isPlainObject(meta)) fail('SESSION_BINDING_CORRUPT');
  if (!isPlainObject(info) || typeof info.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(info.code) ||
      typeof info.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(info.at) ||
      !Number.isFinite(Date.parse(info.at)) || new Date(info.at).toISOString() !== info.at.replace(/(?:\.(\d{1,3}))?Z$/, (_, ms) => '.' + (ms || '').padEnd(3, '0') + 'Z')) fail('SESSION_SCOPE_INVALID');
  const next = { ...meta };
  for (const key of ['providerBindings', 'sessions', 'models', 'rulesSent']) {
    if (Object.hasOwn(meta, key) && (!isPlainObject(meta[key]) || hasForbiddenKey(meta[key]))) fail('SESSION_BINDING_CORRUPT');
    next[key] = { ...(meta[key] || {}) };
    delete next[key][actor];
  }
  if (Object.hasOwn(meta, 'retiredBindings') && !Array.isArray(meta.retiredBindings)) fail('SESSION_BINDING_CORRUPT');
  const providerSessionId = meta.providerBindings?.[actor]?.providerSessionId ?? meta.sessions?.[actor] ?? null;
  next.retiredBindings = [...(meta.retiredBindings || []), { actor, providerSessionId, code: info.code, at: info.at }].slice(-8);
  validate(next);
  return next;
}

module.exports = { validate, resolve, bind, retire };
