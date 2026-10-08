(function (global) {
  'use strict';
  class TerminalView {
    constructor({ api, project, task, ai, onState = () => {}, onError = () => {}, interval = (...args) => global.setInterval(...args), clear = (...args) => global.clearInterval(...args) }) {
      this.api = api; this.scope = { project, task, ai }; this.onState = onState; this.onError = onError;
      this.interval = interval; this.clear = clear; this.session = null; this.timer = null; this.closed = false; this.inputs = Promise.resolve();
    }
    credentials() { return this.session && !this.closed ? { viewId: this.session.viewId, lease: this.session.lease } : {}; }
    owner() { return !this.closed && this.session?.role === 'owner' && !this.session.readonly; }
    update(result) {
      if (!result || !['owner','watcher'].includes(result.role) || typeof result.readonly !== 'boolean' || !Number.isSafeInteger(result.epoch) || typeof result.viewId !== 'string' || this.session && result.viewId !== this.session.viewId) throw Error('終端機視窗狀態無效');
      if (this.closed || this.session && result.epoch < this.session.epoch) return result;
      this.session = { ...this.session, ...result }; const { lease: unused, ...publicState } = result; this.onState(publicState); return result;
    }
    async connect() {
      if (this.session || this.closed) throw Error('請建立新的終端機視窗連線');
      const result = await this.api('/api/term/view/register', this.scope);
      if (typeof result?.lease !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.lease) || !/^[A-Za-z0-9_-]{32}$/.test(result.viewId || '')) throw Error('終端機視窗租約無效');
      if (this.closed) { await this.api('/api/term/view/disconnect', { ...this.scope, viewId: result.viewId, lease: result.lease }); return; }
      this.update(result);
      this.timer = this.interval(() => this.refresh().catch(error => this.lost(error)), 10000);
      return result;
    }
    async refresh() {
      if (!this.session || this.closed) throw Error('終端機視窗尚未連線或已中斷');
      return this.update(await this.api('/api/term/view/heartbeat', { ...this.scope, ...this.credentials() }));
    }
    async claim(confirm) {
      if (confirm !== true) return false;
      await this.refresh();
      this.update(await this.api('/api/term/view/claim', { ...this.scope, ...this.credentials(), expectedEpoch: this.session.epoch, takeover: true }));
      return this.owner();
    }
    write(data) {
      const queued = this.inputs.then(async () => {
        if (!this.owner()) throw Error('此視窗僅能觀看；請先明確接管輸入');
        if (typeof data !== 'string') throw Error('終端機輸入必須是文字');
        return this.api('/api/term/input', { ...this.scope, ...this.credentials(), data });
      });
      this.inputs = queued.catch(() => {}); return queued;
    }
    async resize(cols, rows) {
      if (!this.owner()) return false;
      if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) throw Error('終端機尺寸無效');
      return this.api('/api/term/resize', { ...this.scope, ...this.credentials(), cols: Math.min(500, Math.max(20, cols)), rows: Math.min(300, Math.max(5, rows)) });
    }
    lost(error) { this.closed = true; if (this.timer !== null) this.clear(this.timer); this.timer = null; this.onError(error); this.onState({ role: 'watcher', readonly: true, disconnected: true }); }
    async close() {
      const credentials = this.credentials(); this.closed = true; if (this.timer !== null) this.clear(this.timer); this.timer = null;
      if (credentials.viewId) await this.api('/api/term/view/disconnect', { ...this.scope, ...credentials }).catch(() => {});
      this.session = null;
    }
  }
  if (typeof module === 'object' && module.exports) module.exports = TerminalView;
  else global.HubTerminalView = TerminalView;
})(typeof window === 'object' ? window : globalThis);
