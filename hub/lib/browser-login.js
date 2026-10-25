'use strict';
const crypto = require('node:crypto');

const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_PENDING = 8;
const EXPIRY_MS = 60000;
const ID_BYTES = 16; // 32 hex chars
const NONCE_BYTES = 32; // 64 hex chars

function isValidId(v) {
  return typeof v === 'string' && HEX32_RE.test(v);
}
function isValidNonce(v) {
  return typeof v === 'string' && HEX64_RE.test(v);
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

/**
 * BrowserLoginFSM: pending-approval state machine for owner-controller-approved
 * browser session bootstrap. No HTTP, no secrets. Pure in-memory FSM.
 *
 * Public response contract (returned by methods, never thrown for expected
 * control flow):
 *   { ok: true, ... }
 *   { ok: false, error: 'NOT_FOUND' | 'EXPIRED' | 'INVALID_INPUT' | 'ALREADY_APPROVED' | 'NOT_APPROVED' | 'TABLE_FULL' | 'INTERNAL_FAILURE' }
 *
 * NOT_FOUND is used both for truly unknown IDs and for expired/consumed
 * entries that have been cleaned up, to avoid leaking existence/timing
 * information to untrusted callers. EXPIRED is returned only in the narrow
 * case where the entry is still physically present in the table at the time
 * of the call and found to be past its expiry threshold (>=60000ms) during
 * that same operation's cleanup pass, prior to removal within that call,
 * for operations that want to distinguish (createPending polling path).
 * This is intentional per contract; see review.md.
 */
class BrowserLoginFSM {
  /**
   * @param {object} [opts]
   * @param {() => Buffer} [opts.randomBytesFn] - must return Buffer only; default crypto.randomBytes
   * @param {() => number} [opts.now] - must return a finite nonnegative safe integer; default Date.now
   */
  constructor(opts) {
    opts = opts || {};
    this._randomBytesFn = opts.randomBytesFn || ((n) => crypto.randomBytes(n));
    this._now = opts.now || (() => Date.now());
    this._pending = new Map(); // id -> { nonceHex, createdAt, approved }
    this._lastTime = 0;
  }

  _captureTime() {
    let t;
    try {
      t = this._now();
    } catch (e) {
      this._pending.clear();
      return { ok: false };
    }

    if (
      typeof t !== 'number' ||
      Number.isNaN(t) ||
      !Number.isFinite(t) ||
      t < 0 ||
      !Number.isSafeInteger(t)
    ) {
      this._pending.clear();
      return { ok: false };
    }

    if (t < this._lastTime) {
      this._pending.clear();
      this._lastTime = t;
      return { ok: false };
    }

    this._lastTime = t;
    return { ok: true, time: t };
  }

  _cleanupExpired(nowTime) {
    for (const [id, entry] of this._pending.entries()) {
      if (nowTime - entry.createdAt >= EXPIRY_MS) {
        this._pending.delete(id);
      }
    }
  }

  _genId() {
    for (let attempt = 0; attempt < 5; attempt++) {
      let buf;
      try {
        buf = this._randomBytesFn(ID_BYTES);
      } catch (e) {
        return null;
      }
      if (!Buffer.isBuffer(buf) || buf.length !== ID_BYTES) return null;
      const hex = buf.toString('hex');
      if (!this._pending.has(hex)) return hex;
      // collision: retry
    }
    return null;
  }

  _genNonce() {
    let buf;
    try {
      buf = this._randomBytesFn(NONCE_BYTES);
    } catch (e) {
      return null;
    }
    if (!Buffer.isBuffer(buf) || buf.length !== NONCE_BYTES) return null;
    return buf.toString('hex');
  }

  /**
   * Create a new pending request. Called by the controller's HTTP handler
   * after same-origin/X-Hub checks pass, for a normal browser tab visit.
   * Returns the public id and the pending nonce (to be set as HttpOnly
   * SameSite=Strict cookie by the caller; never logged/reflected in DOM).
   */
  createPending() {
    const tr = this._captureTime();
    if (!tr.ok) return { ok: false, error: 'INTERNAL_FAILURE' };
    const now = tr.time;
    this._cleanupExpired(now);

    if (this._pending.size >= MAX_PENDING) {
      return { ok: false, error: 'TABLE_FULL' };
    }

    const id = this._genId();
    if (id === null) return { ok: false, error: 'INTERNAL_FAILURE' };
    const nonce = this._genNonce();
    if (nonce === null) return { ok: false, error: 'INTERNAL_FAILURE' };

    this._pending.set(id, { nonceHex: nonce, createdAt: now, approved: false });
    return { ok: true, id, nonce };
  }

  /**
   * Called by existing owner-authenticated controller (behind existing
   * owner session cookie guard) with ONLY the public id as observed/typed
   * by the operator. Never callable with the pending cookie, never from
   * MCP/bearer/remote/untrusted origin -- that enforcement is the caller's
   * responsibility (see review.md). This method performs no such check
   * itself; it is the pure state transition.
   */
  approve(id) {
    if (!isValidId(id)) return { ok: false, error: 'INVALID_INPUT' };
    const tr = this._captureTime();
    if (!tr.ok) return { ok: false, error: 'INTERNAL_FAILURE' };
    const now = tr.time;
    this._cleanupExpired(now);

    const entry = this._pending.get(id);
    if (!entry) return { ok: false, error: 'NOT_FOUND' };
    if (now - entry.createdAt >= EXPIRY_MS) {
      this._pending.delete(id);
      return { ok: false, error: 'NOT_FOUND' };
    }
    if (entry.approved) return { ok: false, error: 'ALREADY_APPROVED' };

    entry.approved = true;
    return { ok: true };
  }

  /**
   * Polled by the browser tab holding the exact pending HttpOnly cookie
   * (id + nonce). Succeeds exactly once after approval; consumes the
   * pending entry. On success, the caller (HTTP layer) is responsible for
   * setting the existing owner session cookie and clearing the pending
   * cookie. This method never produces or returns the owner secret/session
   * token; that remains entirely the controller's concern.
   */
  pollAndConsume(id, nonce) {
    if (!isValidId(id) || !isValidNonce(nonce)) {
      return { ok: false, error: 'INVALID_INPUT' };
    }
    const tr = this._captureTime();
    if (!tr.ok) return { ok: false, error: 'INTERNAL_FAILURE' };
    const now = tr.time;
    this._cleanupExpired(now);

    const entry = this._pending.get(id);
    if (!entry) return { ok: false, error: 'NOT_FOUND' };

    if (now - entry.createdAt >= EXPIRY_MS) {
      this._pending.delete(id);
      return { ok: false, error: 'NOT_FOUND' };
    }

    const nonceOk = constantTimeEqualHex(entry.nonceHex, nonce);
    if (!nonceOk) {
      return { ok: false, error: 'NOT_FOUND' };
    }

    if (!entry.approved) {
      return { ok: false, error: 'NOT_APPROVED' };
    }

    // one-use: consume now, regardless of outcome beyond this point
    this._pending.delete(id);
    return { ok: true };
  }

  /** Testing/introspection only: number of currently pending entries (no cleanup side effect). */
  _size() {
    return this._pending.size;
  }
}

module.exports = { BrowserLoginFSM, EXPIRY_MS, MAX_PENDING, ID_BYTES, NONCE_BYTES };
