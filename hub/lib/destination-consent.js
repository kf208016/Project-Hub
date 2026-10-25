'use strict';

const { randomUUID } = require('crypto');
let performanceNow;
try {
  performanceNow = require('perf_hooks').performance.now.bind(require('perf_hooks').performance);
} catch (e) {
  performanceNow = () => Date.now();
}

const ACTORS = new Set(['codex', 'claude', 'grok']);
const MAX_PENDING = 64;
const TTL_MS = 10 * 60 * 1000;
const MAX_DEPTH = 24;
const MAX_BUDGET = 32768;
const MAGIC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function makeErr(code, status, extra) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function isPlainStrict(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (Object.getPrototypeOf(obj) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(obj).length) return false;
  const names = Object.getOwnPropertyNames(obj);
  const keys = Object.keys(obj);
  if (names.length !== keys.length) return false;
  const descs = Object.getOwnPropertyDescriptors(obj);
  for (const k of keys) {
    if (MAGIC_KEYS.has(k)) return false;
    const d = descs[k];
    if (!d || !('value' in d) || d.get || d.set || !d.enumerable) return false;
  }
  return true;
}

// Deep-clones a value while enforcing a strict "own-data JSON" shape.
// Never invokes getters: only properties whose descriptor has a plain
// 'value' (no get/set) are ever read.
function cloneStrictJSON(root, errFn) {
  const seen = new Set();
  const budget = { chars: 0 };

  function checkBudget() {
    if (budget.chars > MAX_BUDGET) throw errFn('JSON_BUDGET_EXCEEDED', 400);
  }

  function checkDescriptors(obj, keys) {
    const names = Object.getOwnPropertyNames(obj);
    if (names.length !== keys.length + (Array.isArray(obj)?1:0)) throw errFn('JSON_NONENUMERABLE', 400);
    const descs = Object.getOwnPropertyDescriptors(obj);
    for (const k of keys) {
      const d = descs[k];
      if (!d || !('value' in d) || d.get || d.set) throw errFn('JSON_ACCESSOR', 400);
      if (!d.enumerable) throw errFn('JSON_NONENUMERABLE', 400);
    }
  }

  function clone(v, depth) {
    budget.chars++;checkBudget();
    if (depth > MAX_DEPTH) throw errFn('JSON_TOO_DEEP', 400);
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') {
      if(!v.isWellFormed()||v.includes('\0'))throw errFn('JSON_INVALID_STRING',400);
      budget.chars += v.length + 2;
      checkBudget();
      return v;
    }
    if (t === 'number') {
      if (!Number.isFinite(v)) throw errFn('JSON_NONFINITE', 400);
      budget.chars += 24;
      checkBudget();
      return v;
    }
    if (t === 'boolean') {
      budget.chars += 5;
      checkBudget();
      return v;
    }
    if (t === 'object') {
      if (seen.has(v)) throw errFn('JSON_CYCLE', 400);
      seen.add(v);
      try {
        if (Array.isArray(v)) {
          if (Object.getPrototypeOf(v) !== Array.prototype) throw errFn('JSON_NONPLAIN', 400);
          if (Object.getOwnPropertySymbols(v).length) throw errFn('JSON_SYMBOL_KEY', 400);
          const keys = Object.keys(v);
          const len = v.length;
          for (let i = 0; i < keys.length; i++) {
            if (String(i) !== keys[i]) throw errFn('JSON_ARRAY_EXTRA', 400);
          }
          if (keys.length !== len) throw errFn('JSON_ARRAY_EXTRA', 400);
          checkDescriptors(v, keys);
          const out = [];
          for (let i = 0; i < len; i++) out.push(clone(v[i], depth + 1));
          return out;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) throw errFn('JSON_NONPLAIN', 400);
        if (Object.getOwnPropertySymbols(v).length) throw errFn('JSON_SYMBOL_KEY', 400);
        const keys = Object.keys(v);
        checkDescriptors(v, keys);
        const out = {};
        for (const k of keys) {
          if (MAGIC_KEYS.has(k)) throw errFn('JSON_MAGIC_KEY', 400);
          budget.chars += k.length + 2;
          checkBudget();
          out[k] = clone(v[k], depth + 1);
        }
        return out;
      } finally {
        seen.delete(v);
      }
    }
    // undefined, function, symbol, bigint -> invalid
    throw errFn('JSON_INVALID_TYPE', 400);
  }

  return clone(root, 0);
}

function deepEqualStrict(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualStrict(a[i], b[i])) return false;
    }
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualStrict(a[k], b[k])) return false;
  }
  return true;
}

function checkIdentifier(s, errFn) {
  if (typeof s !== 'string' || s.length === 0 || s.length>200 || /[\x00-\x1f\x7f]/.test(s) || !s.isWellFormed() || s.includes('/') || s.includes('\\')) {
    throw errFn('INVALID_IDENTIFIER', 400);
  }
}

function validateBinding(binding, errFn) {
  if (binding === null || typeof binding !== 'object') throw errFn('INVALID_BINDING', 502);
  const clone = cloneStrictJSON(binding, errFn);
  const required = ['project', 'task', 'run', 'rootFingerprint', 'dir'];
  const keys = Object.keys(clone);
  if (keys.length !== required.length) throw errFn('INVALID_BINDING', 502);
  for (const k of required) {
    if (!(k in clone) || typeof clone[k] !== 'string' || clone[k].length === 0) {
      throw errFn('INVALID_BINDING', 502);
    }
  }
  checkIdentifier(clone.project, errFn);
  checkIdentifier(clone.task, errFn);
  return clone;
}

class DestinationConsent {
  #resolve;#now;#monotonic;#marks;#pending;#lastNow;#lastMono=-Infinity;
  constructor(opts) {
    opts = opts || {};
    const { resolve, now, monotonic } = opts;
    if (typeof resolve !== 'function') {
      throw new TypeError('resolve function is required');
    }
    this.#resolve = resolve;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#monotonic = typeof monotonic === 'function' ? monotonic : performanceNow;
    this.#marks = new WeakMap();
    this.#pending = new Map();
    this.#lastNow = -Infinity;
  }

  _err(code, status, extra) {
    return makeErr(code, status, extra);
  }

  _safeNow() {
    const t = this.#now();
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t<0 || t>Number.MAX_SAFE_INTEGER-TTL_MS) {
      throw this._err('CLOCK_INVALID', 500);
    }
    if (t < this.#lastNow) {
      throw this._err('CLOCK_ROLLBACK', 500);
    }
    const mono=this.#monotonic();
    if(!Number.isFinite(mono)||mono<0||mono<this.#lastMono)throw this._err('CLOCK_ROLLBACK',500);
    this.#lastMono=mono;
    this.#lastNow = t;
    return t;
  }

  _checkActor(actor) {
    if (typeof actor !== 'string' || !ACTORS.has(actor)) {
      throw this._err('INVALID_ACTOR', 400);
    }
  }

  _checkRequestShape(obj, allowedKeys) {
    if (!isPlainStrict(obj)) throw this._err('INVALID_REQUEST', 400);
    const keys = Object.keys(obj);
    for (const k of keys) {
      if (!allowedKeys.includes(k)) throw this._err('UNKNOWN_KEY', 400);
    }
    for (const k of allowedKeys) {
      if (!(k in obj)) throw this._err('MISSING_KEY', 400);
    }
  }

  mark(flow, actor) {
    this._checkActor(actor);
    if (flow === null || typeof flow !== 'object') throw this._err('INVALID_FLOW', 400);
    let set = this.#marks.get(flow);
    if (!set) {
      set = new Set();
      this.#marks.set(flow, set);
    }
    set.add(actor);
  }

  assert(flow, actor) {
    this._checkActor(actor);
    const set = flow !== null && typeof flow === 'object' ? this.#marks.get(flow) : undefined;
    if (!set || !set.has(actor)) {
      throw this._err('WORKSPACE_DESTINATION_REQUIRED', 409, { notStarted: true });
    }
  }

  revokeAll(flow) {
    if (flow !== null && typeof flow === 'object') {
      this.#marks.delete(flow);
    }
  }

  _prune(now) {
    for (const [tok, rec] of this.#pending) {
      if (rec.expiresAt <= now || this.#lastMono-rec.insertedMono>=TTL_MS) this.#pending.delete(tok);
    }
  }

  _pruneOldest() {
    let oldestTok = null;
    let oldestT = Infinity;
    for (const [tok, rec] of this.#pending) {
      if (rec.insertedNow < oldestT) {
        oldestT = rec.insertedNow;
        oldestTok = tok;
      }
    }
    if (oldestTok !== null) this.#pending.delete(oldestTok);
  }

  async preview(req) {
    this._checkRequestShape(req, ['project', 'task', 'actor']);
    const { project, task, actor } = req;
    checkIdentifier(project, this._err.bind(this));
    checkIdentifier(task, this._err.bind(this));
    this._checkActor(actor);

    let result;
    try {
      result = await this.#resolve(project, task);
    } catch (e) {
      throw this._err('RESOLUTION_FAILED', 502);
    }
    if (result === null || typeof result !== 'object') throw this._err('RESOLUTION_FAILED', 502);
    const { flow, binding, review } = result;
    if (flow === null || typeof flow !== 'object') throw this._err('RESOLUTION_FAILED', 502);

    const boundBinding = validateBinding(binding, this._err.bind(this));
    if(boundBinding.project!==project||boundBinding.task!==task)throw this._err('INVALID_BINDING',502);
    const boundReview = cloneStrictJSON(review, this._err.bind(this));

    const insertedNow = this._safeNow();
    const insertedMono = this.#monotonic();

    this._prune(insertedNow);
    if (this.#pending.size >= MAX_PENDING) {
      throw this._err('TOO_MANY_PENDING', 429);
    }

    const token = randomUUID();
    const expiresAt = insertedNow + TTL_MS;

    this.#pending.set(token, {
      flow,
      binding: boundBinding,
      review: boundReview,
      actor,
      insertedNow,
      insertedMono,
      expiresAt,
    });

    return {
      token,
      review: cloneStrictJSON(boundReview, this._err.bind(this)),
      destination: {codex:'OpenAI',claude:'Anthropic',grok:'xAI'}[actor],project,task,actor,
      expiresAt,
    };
  }

  async approve(req) {
    this._checkRequestShape(req, ['token', 'confirm', 'ackDestination', 'ackReadLimits']);
    const { token, confirm, ackDestination, ackReadLimits } = req;
    if (typeof token !== 'string' || token.length === 0) throw this._err('INVALID_REQUEST', 400);
    if (confirm !== true || ackDestination !== true || ackReadLimits !== true) {
      throw this._err('ACK_REQUIRED', 400);
    }

    // Consume the token exactly once, before any await, so concurrent
    // or repeated approve() calls cannot both succeed.
    const record = this.#pending.get(token);
    this.#pending.delete(token);
    if (!record) throw this._err('TOKEN_INVALID', 409);

    const nowAtApprove = this._safeNow();
    const monoAtApprove = this.#monotonic();

    if (monoAtApprove < record.insertedMono) throw this._err('CLOCK_ROLLBACK', 500);
    if (nowAtApprove >= record.expiresAt) throw this._err('CONSENT_EXPIRED', 409);
    if (monoAtApprove - record.insertedMono >= TTL_MS) throw this._err('CONSENT_EXPIRED', 409);

    let fresh;
    try {
      fresh = await this.#resolve(record.binding.project, record.binding.task);
    } catch (e) {
      throw this._err('RESOLUTION_FAILED', 502);
    }
    if (fresh === null || typeof fresh !== 'object' || fresh.flow !== record.flow) {
      throw this._err('DESTINATION_CHANGED', 409);
    }

    const freshBinding = validateBinding(fresh.binding, this._err.bind(this));
    const freshReview = cloneStrictJSON(fresh.review, this._err.bind(this));

    if (!deepEqualStrict(freshBinding, record.binding)) throw this._err('DESTINATION_CHANGED', 409);
    if (!deepEqualStrict(freshReview, record.review)) throw this._err('DESTINATION_CHANGED', 409);

    const checked=this._safeNow();
    if(checked>=record.expiresAt||this.#lastMono-record.insertedMono>=TTL_MS)throw this._err('CONSENT_EXPIRED',409);
    this.mark(record.flow, record.actor);

    return { approved: true, actor: record.actor };
  }
}

module.exports = DestinationConsent;
