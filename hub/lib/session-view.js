'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

function failure(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Browser views share one existing terminal. This is controller coordination,
// not authentication: the HTTP entry points must still require their normal
// browser session and Origin/CSRF checks. No method owns or stops a process.
class SessionViews {
  constructor({ leaseMs = 30000, maxViews = 32, clock = () => performance.now(), wallClock = Date.now, randomBytes = crypto.randomBytes } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000 ||
        !Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 32 ||
        typeof clock !== 'function' || typeof wallClock !== 'function' || typeof randomBytes !== 'function') {
      throw failure(400, 'VIEW_OPTIONS', '終端機視窗設定無效');
    }
    this.leaseMs = leaseMs;
    this.maxViews = maxViews;
    this.clock = clock;
    this.wallClock = wallClock;
    this.randomBytes = randomBytes;
    this.generation = this._random(16);
    this.views = new Map();
    this.owner = null;
    this.epoch = 0;
    this.lastTick = null;
    this.closed = false;
    this.broken = false;
    this.readonly = false;
  }

  _random(size) {
    let bytes;
    try { bytes = this.randomBytes(size); } catch (_) { /* fail closed below */ }
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw failure(503, 'VIEW_RANDOM', '無法建立終端機視窗識別');
    return bytes.toString('base64url');
  }

  _tick() {
    if (this.closed) throw failure(409, 'VIEW_CLOSED', '此終端機會話已結束，請重新連線');
    if (this.broken) throw failure(503, 'VIEW_CLOCK', '終端機視窗租約時鐘失效，請重新建立會話');
    let tick, wall;
    try { tick = this.clock(); wall = this.wallClock(); } catch (_) { /* fail closed below */ }
    if (!Number.isFinite(tick) || tick < 0 || !Number.isFinite(wall) ||
        (this.lastTick !== null && tick < this.lastTick)) {
      this.broken = true;
      this.views.clear();
      if (this.owner !== null) this.epoch++;
      this.owner = null;
      throw failure(503, 'VIEW_CLOCK', '終端機視窗租約時鐘失效，請重新建立會話');
    }
    this.lastTick = tick;
    for (const [id, view] of this.views) {
      if (tick >= view.until) {
        this.views.delete(id);
        if (this.owner === id) { this.owner = null; this.epoch++; }
      }
    }
    return { tick, wall };
  }

  _credentials(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.viewId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.viewId) ||
        typeof value.lease !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.lease)) {
      throw failure(400, 'VIEW_CREDENTIALS', '需要有效的終端機 viewId 與 lease');
    }
  }

  _get(value) {
    this._credentials(value);
    const view = this.views.get(value.viewId);
    const actual = Buffer.from(view ? view.lease : '0'.repeat(43));
    const candidate = Buffer.from(value.lease);
    const equal = crypto.timingSafeEqual(actual, candidate);
    if (!view || !equal) throw failure(403, 'VIEW_UNKNOWN', '終端機視窗租約無效或已過期，請重新連線');
    return view;
  }

  _result(view, time, includeLease = false) {
    return Object.freeze({
      generation: this.generation, viewId: view.id,
      ...(includeLease ? { lease: view.lease } : {}),
      role: this.owner === view.id ? 'owner' : 'watcher',
      epoch: this.epoch, expiresAt: time.wall + Math.max(0, view.until - time.tick),
      ownerViewId: this.owner, leaseMs: this.leaseMs, readonly: this.readonly,
    });
  }

  register() {
    const time = this._tick();
    if (this.views.size >= this.maxViews) throw failure(429, 'VIEW_LIMIT', '此終端機的視窗數已達上限，請關閉未使用的視窗');
    let id;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = this._random(24);
      if (!this.views.has(candidate)) { id = candidate; break; }
    }
    if (!id) throw failure(503, 'VIEW_RANDOM', '無法建立唯一的終端機視窗識別');
    const view = { id, lease: this._random(32), until: time.tick + this.leaseMs };
    this.views.set(id, view);
    if (this.owner === null && !this.readonly) { this.owner = id; this.epoch++; }
    return this._result(view, time, true);
  }

  heartbeat(credentials) {
    const time = this._tick(), view = this._get(credentials);
    view.until = time.tick + this.leaseMs;
    return this._result(view, time);
  }

  assertOwner(credentials) {
    const time = this._tick(), view = this._get(credentials);
    if (this.readonly) throw failure(409, 'VIEW_READONLY', '此終端機會話已結束或正在停止，僅能觀看輸出');
    if (this.owner !== view.id) throw failure(409, 'VIEW_NOT_OWNER', '此視窗僅供觀看；請明確接管後再輸入或調整尺寸');
    view.until = time.tick + this.leaseMs;
    return this._result(view, time);
  }

  claim(credentials) {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
        !Number.isSafeInteger(credentials.expectedEpoch) || credentials.expectedEpoch < 0 ||
        typeof credentials.takeover !== 'boolean') {
      throw failure(400, 'VIEW_CLAIM', '接管需要 expectedEpoch 整數與 takeover boolean');
    }
    const time = this._tick(), view = this._get(credentials);
    if (this.readonly) throw failure(409, 'VIEW_READONLY', '此終端機會話已結束或正在停止，僅能觀看輸出');
    if (credentials.expectedEpoch !== this.epoch) throw failure(409, 'VIEW_CHANGED', '終端機控制者已變更；請更新視窗狀態後再確認接管');
    if (this.owner !== view.id) {
      // A watcher never becomes the controller because a heartbeat, page fit,
      // or another view's disconnection happened to leave the controller empty.
      if (credentials.takeover !== true) throw failure(409, 'VIEW_CONFIRM', '請明確確認接管終端機控制');
      this.owner = view.id;
      this.epoch++;
    }
    view.until = time.tick + this.leaseMs;
    return this._result(view, time);
  }

  disconnect(credentials) {
    const time = this._tick(), view = this._get(credentials);
    this.views.delete(view.id);
    if (this.owner === view.id) { this.owner = null; this.epoch++; }
    return Object.freeze({ ok: true, generation: this.generation, epoch: this.epoch, ownerViewId: this.owner });
  }

  state() {
    if (!this.closed) this._tick();
    return Object.freeze({
      generation: this.generation, epoch: this.epoch, ownerViewId: this.owner, leaseMs: this.leaseMs,
      readonly: this.readonly || this.closed, closed: this.closed,
      views: Object.freeze([...this.views.values()].map(view => Object.freeze({ viewId: view.id, role: this.owner === view.id ? 'owner' : 'watcher' }))),
    });
  }

  finish() {
    this.readonly = true;
    if (this.owner !== null) { this.owner = null; this.epoch++; }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.views.clear();
      if (this.owner !== null) this.epoch++;
      this.owner = null;
    }
  }
}

module.exports = { SessionViews };
