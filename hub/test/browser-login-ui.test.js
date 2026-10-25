'use strict';
/*
 * UI contract tests for the one-time browser login.
 *
 *  - hub/public/local-auth.js is loaded with node:vm into a fresh context per test.
 *  - Everything the page touches is a hand-written fake: DOM, fetch, timers, Date,
 *    AbortController, location, history, navigator.clipboard, storage, console.
 *  - hub/public/web-chat-recovery.html is text-checked and its inline script is run
 *    against the same fakes.
 *
 * Section 0 of this file ("[harness]") tests the fakes themselves and does not need
 * local-auth.js. Everything else is derived from the SPEC only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// HUB_UI_TEST_HUB_DIR (optional) points the test at another copy's hub/ directory.
const HUB_DIR = process.env.HUB_UI_TEST_HUB_DIR ? path.resolve(process.env.HUB_UI_TEST_HUB_DIR) : path.resolve(__dirname, '..');
const LOCAL_AUTH_PATH = path.join(HUB_DIR, 'public', 'local-auth.js');
const RECOVERY_PATH = path.join(HUB_DIR, 'public', 'web-chat-recovery.html');

// Unhandled rejections raised while a test runs are collected so that a test can
// assert that nothing was left unhandled (SPEC 4.1 item 3).
const unhandledRejections = [];
process.on('unhandledRejection', reason => { unhandledRejections.push(reason); });

// ---------------------------------------------------------------------------
// Constants taken verbatim from the SPEC
// ---------------------------------------------------------------------------
const MSG = Object.freeze({
  legacyDisabled: '此啟動連結已停用，請重新執行啟動器。',
  authUnconfirmed: '無法確認本機登入，請重新開啟啟動器。',
  title: 'Project Hub 本機登入',
  explanation: '按下「產生一次性登入代碼」後，將下方代碼貼到 Windows 啟動器的「Project Hub 本機登入確認」視窗，再按「核准登入」。',
  label: '待核准代碼',
  initialStatus: '代碼有效 60 秒；瀏覽器不會取得啟動器的登入憑證。',
  begin: '產生一次性登入代碼',
  copy: '複製代碼',
  copied: '已複製代碼。',
  copyFailed: '無法自動複製，請手動選取代碼。',
  generating: '正在產生待核准代碼…',
  tooMany: '待核准的要求過多，請稍候再產生。',
  beginFailed: '無法產生登入代碼，請重新嘗試。',
  shown: '請在 Windows 的「Project Hub 本機登入確認」視窗貼上此代碼並按「核准登入」。',
  approved: '核准完成，正在開啟 Hub…',
  pollInvalid: '代碼已失效或未核准，請重新產生。',
  pollError: '無法確認核准結果，請重新產生代碼。',
  expired: '代碼已逾時，請重新產生。',
});
const POLL_FAILURES = [MSG.pollInvalid, MSG.pollError];

const URLS = Object.freeze({
  state: '/api/state',
  begin: '/api/local/browser/begin',
  poll: '/api/local/browser/poll',
});
const DOM_IDS = Object.freeze({
  overlay: 'local-login-overlay',
  title: 'local-login-title',
  input: 'local-login-request',
  status: 'local-login-status',
  begin: 'local-login-begin',
  copy: 'local-login-copy',
});

const ID1 = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba98765432100123456789abcdef';
// 43 characters from [A-Za-z0-9_-], like HUB_LOCAL_TOKEN.
const TOKEN = 'Zq3-tK9_vWx7LmN2sR5cD8fG1hJ4kB6wE0yU3iOaTp9';

// ---------------------------------------------------------------------------
// Scripted fetch replies
// ---------------------------------------------------------------------------
const json = (status, value, extra = {}) => ({ kind: 'response', status, text: JSON.stringify(value), ...extra });
const rawReply = (status, text, extra = {}) => ({ kind: 'response', status, text, ...extra });
const networkError = (message = 'Failed to fetch') => ({ kind: 'reject', error: new TypeError(message) });
const HANG = Object.freeze({ kind: 'hang' });
const beginOk = (id = ID1) => json(200, { ok: true, requestId: id, expiresInSeconds: 60 });
const POLL_PENDING = json(202, { ok: false, pending: true });
const POLL_APPROVED = json(200, { ok: true });
const STATE_401 = json(401, { ok: false, error: 'unauthorized' });
const STATE_200 = json(200, { ok: true });

function utf8Length(text) { return Buffer.byteLength(text, 'utf8'); }
/** JSON text padded with trailing spaces to exactly `bytes` UTF-8 bytes (valid JSON). */
function paddedJson(value, bytes) {
  const text = JSON.stringify(value);
  const missing = bytes - utf8Length(text);
  assert.ok(missing >= 0, 'padding target too small');
  return text + ' '.repeat(missing);
}

// ---------------------------------------------------------------------------
// Fake CSS style object
// ---------------------------------------------------------------------------
const kebab = name => name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

function createStyle() {
  const props = new Map();
  const api = {
    getPropertyValue(name) { return props.has(String(name).toLowerCase()) ? props.get(String(name).toLowerCase()) : ''; },
    setProperty(name, value) {
      const key = String(name).toLowerCase();
      if (value === '' || value === null || value === undefined) props.delete(key); else props.set(key, String(value));
    },
    removeProperty(name) { const key = String(name).toLowerCase(); const old = props.get(key) || ''; props.delete(key); return old; },
  };
  return new Proxy(api, {
    get(target, prop) {
      if (prop === 'cssText') return [...props].map(([k, v]) => `${k}: ${v};`).join(' ');
      if (prop === '__props') return props;
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      return props.has(kebab(prop)) ? props.get(kebab(prop)) : '';
    },
    set(target, prop, value) {
      if (prop === 'cssText') {
        props.clear();
        for (const declaration of String(value).split(';')) {
          const at = declaration.indexOf(':');
          if (at < 1) continue;
          const name = declaration.slice(0, at).trim().toLowerCase();
          const val = declaration.slice(at + 1).trim();
          if (name && val) props.set(name, val);
        }
        return true;
      }
      if (typeof prop !== 'string') return true;
      if (value === '' || value === null || value === undefined) props.delete(kebab(prop)); else props.set(kebab(prop), String(value));
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = true;
    this.cancelable = true;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.isTrusted = false;
    this.eventPhase = 0;
    this._stop = false;
    this._stopImmediate = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopImmediate = true; }
}

function fireListeners(target, event, phase) {
  const self = target._self || target;
  event.currentTarget = self;
  for (const entry of target._listeners.slice()) {
    if (entry.type !== event.type) continue;
    if (phase === 'capture' && !entry.capture) continue;
    if (phase === 'bubble' && entry.capture) continue;
    if (entry.once) target.removeEventListener(entry.type, entry.listener, entry.capture);
    try {
      if (typeof entry.listener === 'function') entry.listener.call(self, event);
      else entry.listener.handleEvent(event);
    } catch (error) { target._env.errors.push(error); }
    if (event._stopImmediate) return;
  }
  if (phase !== 'capture') {
    const handler = self['on' + event.type];
    if (typeof handler === 'function') {
      try { handler.call(self, event); } catch (error) { target._env.errors.push(error); }
    }
  }
}

function dispatchEvent(target, event) {
  event.target = target._self || target;
  const chain = [];
  for (let node = target.parentNode; node; node = node.parentNode) chain.push(node);
  if (chain.length && chain[chain.length - 1].nodeType === 9) chain.push(target._env.windowTarget);
  event.eventPhase = 1;
  for (let i = chain.length - 1; i >= 0 && !event._stop; i -= 1) fireListeners(chain[i], event, 'capture');
  event.eventPhase = 2;
  if (!event._stop) fireListeners(target, event, 'target');
  if (event.bubbles) {
    event.eventPhase = 3;
    for (const node of chain) { if (event._stop) break; fireListeners(node, event, 'bubble'); }
  }
  event.eventPhase = 0;
  event.currentTarget = null;
  return !event.defaultPrevented;
}

class EventTargetBase {
  constructor(env) { this._env = env; this._listeners = []; }
  addEventListener(type, listener, options) {
    if (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function')) return;
    const capture = options === true || !!(options && typeof options === 'object' && options.capture);
    const once = !!(options && typeof options === 'object' && options.once);
    if (this._listeners.some(l => l.type === type && l.listener === listener && l.capture === capture)) return;
    this._listeners.push({ type, listener, capture, once });
  }
  removeEventListener(type, listener, options) {
    const capture = options === true || !!(options && typeof options === 'object' && options.capture);
    this._listeners = this._listeners.filter(l => !(l.type === type && l.listener === listener && l.capture === capture));
  }
  dispatchEvent(event) { return dispatchEvent(this, event); }
}

class FakeText extends EventTargetBase {
  constructor(doc, data) {
    super(doc._env);
    this.ownerDocument = doc;
    this.nodeType = 3;
    this.parentNode = null;
    this.data = String(data);
  }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  get nodeValue() { return this.data; }
  get isConnected() { return isConnected(this); }
}

function isConnected(node) {
  for (let n = node; n; n = n.parentNode) if (n.nodeType === 9) return true;
  return false;
}

const BOOLEAN_PROPS = { disabled: 'disabled', readOnly: 'readonly', hidden: 'hidden', required: 'required', autofocus: 'autofocus' };
const STRING_PROPS = {
  id: 'id', className: 'class', title: 'title', placeholder: 'placeholder', htmlFor: 'for', name: 'name', lang: 'lang',
  role: 'role', ariaModal: 'aria-modal', ariaLive: 'aria-live', ariaLabel: 'aria-label', ariaHidden: 'aria-hidden', ariaDisabled: 'aria-disabled',
};
const NULLABLE_PROPS = new Set(['role', 'ariaModal', 'ariaLive', 'ariaLabel', 'ariaHidden', 'ariaDisabled']);
const NATIVELY_FOCUSABLE = new Set(['button', 'input', 'select', 'textarea']);

class FakeElement extends EventTargetBase {
  constructor(doc, tag) {
    super(doc._env);
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.style = createStyle();
    this._attrs = new Map();
    this._value = '';
    this._dirty = false;
    this.selectCalls = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.focusCalls = 0;
    this._isFragment = false;
  }

  // ---- attributes ----
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const text = String(value);
    if (key === 'style') { this.style.cssText = text; return; }
    this._attrs.set(key, text);
    if (key === 'value' && !this._dirty) this._value = text;
    this.ownerDocument._fixupFocus();
  }
  getAttribute(name) {
    const key = String(name).toLowerCase();
    if (key === 'style') { const css = this.style.cssText; return css ? css : null; }
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()) || (String(name).toLowerCase() === 'style' && !!this.style.cssText); }
  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); this.ownerDocument._fixupFocus(); }
  toggleAttribute(name, force) {
    const has = this.hasAttribute(name);
    const want = force === undefined ? !has : !!force;
    if (want) this.setAttribute(name, ''); else this.removeAttribute(name);
    return want;
  }

  // ---- reflected properties (defined below on the prototype) ----
  get type() {
    if (this._attrs.has('type')) return this._attrs.get('type');
    if (this.localName === 'button') return 'submit';
    if (this.localName === 'input') return 'text';
    return '';
  }
  set type(value) { this.setAttribute('type', value); }
  get value() { return this._value; }
  set value(value) { this._value = value === null || value === undefined ? '' : String(value); this._dirty = true; this.selectionStart = this._value.length; this.selectionEnd = this._value.length; }
  get defaultValue() { return this._attrs.get('value') || ''; }
  get tabIndex() {
    if (this._attrs.has('tabindex')) { const n = parseInt(this._attrs.get('tabindex'), 10); return Number.isNaN(n) ? -1 : n; }
    return NATIVELY_FOCUSABLE.has(this.localName) ? 0 : -1;
  }
  set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add(...names) { el.className = [...new Set([...list(), ...names])].join(' '); },
      remove(...names) { el.className = list().filter(n => !names.includes(n)).join(' '); },
      contains(name) { return list().includes(name); },
      toggle(name) { if (list().includes(name)) { this.remove(name); return false; } this.add(name); return true; },
    };
  }

  // ---- tree ----
  get isConnected() { return isConnected(this); }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  _detach(node) {
    if (node.parentNode) {
      const siblings = node.parentNode.childNodes;
      const at = siblings.indexOf(node);
      if (at >= 0) siblings.splice(at, 1);
      node.parentNode = null;
    }
  }
  _coerce(item) { return typeof item === 'string' || typeof item === 'number' ? this.ownerDocument.createTextNode(String(item)) : item; }
  appendChild(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 3)) throw new TypeError('fake DOM: appendChild needs a node');
    if (node._isFragment) { for (const child of node.childNodes.slice()) this.appendChild(child); return node; }
    this._detach(node);
    node.parentNode = this;
    this.childNodes.push(node);
    this.ownerDocument._fixupFocus();
    return node;
  }
  append(...items) { for (const item of items) this.appendChild(this._coerce(item)); }
  prepend(...items) { const nodes = items.map(i => this._coerce(i)); for (const node of nodes.reverse()) this.insertBefore(node, this.childNodes[0] || null); }
  insertBefore(node, reference) {
    if (reference === null || reference === undefined) return this.appendChild(node);
    if (node._isFragment) { for (const child of node.childNodes.slice()) this.insertBefore(child, reference); return node; }
    this._detach(node);
    const at = this.childNodes.indexOf(reference);
    if (at < 0) throw new Error('fake DOM: insertBefore reference is not a child');
    node.parentNode = this;
    this.childNodes.splice(at, 0, node);
    this.ownerDocument._fixupFocus();
    return node;
  }
  removeChild(node) {
    if (node.parentNode !== this) throw new Error('fake DOM: removeChild of a non-child');
    this._detach(node);
    this.ownerDocument._fixupFocus();
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...items) {
    for (const child of this.childNodes.slice()) this._detach(child);
    for (const item of items) this.appendChild(this._coerce(item));
    this.ownerDocument._fixupFocus();
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(value) {
    for (const child of this.childNodes.slice()) this._detach(child);
    const text = value === null || value === undefined ? '' : String(value);
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(text));
    this.ownerDocument._fixupFocus();
  }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  get innerHTML() { return ''; }
  set innerHTML(value) {
    if (String(value) !== '') throw new Error('fake DOM: innerHTML parsing is not supported; only innerHTML = "" is');
    this.textContent = '';
  }

  // ---- selectors ----
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, selector)) return n; return null; }
  querySelectorAll(selector) { return queryAll(this, selector); }
  querySelector(selector) { return queryAll(this, selector)[0] || null; }

  // ---- behaviour ----
  focus() {
    this.focusCalls += 1;
    if (!this.isConnected || !isFocusable(this) || !isVisible(this)) return;
    this.ownerDocument._setActive(this);
  }
  blur() { if (this.ownerDocument._active === this) { this.ownerDocument._blurActive(); } }
  click() { if (!this.disabled) dispatchEvent(this, new FakeEvent('click')); }
  select() { this.selectCalls += 1; this.selectionStart = 0; this.selectionEnd = this._value.length; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

for (const [prop, attr] of Object.entries(BOOLEAN_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this._attrs.has(attr); },
    set(value) { if (value) this._attrs.set(attr, ''); else this._attrs.delete(attr); this.ownerDocument._fixupFocus(); },
  });
}
for (const [prop, attr] of Object.entries(STRING_PROPS)) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this._attrs.has(attr) ? this._attrs.get(attr) : (NULLABLE_PROPS.has(prop) ? null : ''); },
    set(value) { if (value === null && NULLABLE_PROPS.has(prop)) this._attrs.delete(attr); else this._attrs.set(attr, String(value)); },
  });
}

function isVisible(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (n.hasAttribute('hidden')) return false;
    if (n.style.getPropertyValue('display').trim() === 'none') return false;
    if (n.style.getPropertyValue('visibility').trim() === 'hidden') return false;
  }
  return true;
}
function isFocusable(el) {
  if (el.nodeType !== 1) return false;
  if (el.disabled && NATIVELY_FOCUSABLE.has(el.localName)) return false;
  if (NATIVELY_FOCUSABLE.has(el.localName)) return !(el.localName === 'input' && el.type === 'hidden');
  if (el.localName === 'a' && el.hasAttribute('href')) return true;
  return el.hasAttribute('tabindex') && !Number.isNaN(parseInt(el.getAttribute('tabindex'), 10));
}
function isTabbable(el) { return isFocusable(el) && el.tabIndex >= 0; }

function collect(root) {
  const out = [];
  (function walk(node) {
    if (node.nodeType !== 1) return;
    out.push(node);
    for (const child of node.childNodes) walk(child);
  })(root);
  return out;
}

// --- selectors: comma lists, descendant combinator, tag/#id/.class/[attr]/[attr=v]/:not()/:disabled/:enabled
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0; let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && (separator === ' ' ? /\s/.test(ch) : ch === separator)) { if (current) parts.push(current); current = ''; } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}
function matchesCompound(el, compound) {
  let rest = compound;
  const tag = /^(?:[a-zA-Z][a-zA-Z0-9-]*|\*)/.exec(rest);
  if (tag) { if (tag[0] !== '*' && el.localName !== tag[0].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { if (el.id !== m[1]) return false; }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { if (!el.className.split(/\s+/).includes(m[1])) return false; }
    else if ((m = /^\[([\w-]+)(?:(=)"?([^\]"]*)"?)?\]/.exec(rest))) {
      if (!el.hasAttribute(m[1])) return false;
      if (m[2] && el.getAttribute(m[1]) !== m[3]) return false;
    }
    else if ((m = /^:not\(([^)]*)\)/.exec(rest))) { if (matchesSelector(el, m[1])) return false; }
    else if ((m = /^:disabled/.exec(rest))) { if (!el.disabled) return false; }
    else if ((m = /^:enabled/.exec(rest))) { if (el.disabled) return false; }
    else throw new Error('fake DOM: unsupported selector "' + compound + '"');
    rest = rest.slice(m[0].length);
  }
  return true;
}
function matchesSelector(el, selector) {
  return splitTopLevel(String(selector), ',').some(part => {
    const compounds = splitTopLevel(part.trim(), ' ');
    if (compounds.some(c => c === '>' || c === '+' || c === '~')) throw new Error('fake DOM: unsupported combinator in "' + selector + '"');
    if (!matchesCompound(el, compounds[compounds.length - 1])) return false;
    let at = compounds.length - 2;
    for (let anc = el.parentNode; anc && at >= 0; anc = anc.parentNode) {
      if (anc.nodeType === 1 && matchesCompound(anc, compounds[at])) at -= 1;
    }
    return at < 0;
  });
}
function queryAll(root, selector) {
  const out = [];
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (matchesSelector(child, selector)) out.push(child);
      walk(child);
    }
  })(root);
  return out;
}

class FakeDocument extends EventTargetBase {
  constructor(env) {
    super(env);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.parentNode = null;
    this.readyState = 'complete';
    this.title = '';
    this._active = null;
    this.cookieWrites = [];
    this.execCommandCalls = [];
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.documentElement.parentNode = this;
    this.childNodes = [this.documentElement];
  }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  getElementById(id) {
    let found = null;
    (function walk(node) {
      if (found) return;
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child._attrs.get('id') === String(id)) { found = child; return; }
        walk(child);
        if (found) return;
      }
    })(this.documentElement);
    return found;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(this, text); }
  createDocumentFragment() { const fragment = new FakeElement(this, '#fragment'); fragment._isFragment = true; return fragment; }
  querySelectorAll(selector) { return queryAll(this, selector); }
  querySelector(selector) { return queryAll(this, selector)[0] || null; }
  get cookie() { return ''; }
  set cookie(value) { this.cookieWrites.push(String(value)); }
  execCommand(command) { this.execCommandCalls.push(command); return false; }
  hasFocus() { return true; }
  _setActive(el) {
    const previous = this._active && this._active.isConnected ? this._active : null;
    if (previous === el) return;
    this._active = el;
    if (previous) {
      dispatchEvent(previous, new FakeEvent('blur', { bubbles: false }));
      dispatchEvent(previous, new FakeEvent('focusout'));
    }
    dispatchEvent(el, new FakeEvent('focus', { bubbles: false }));
    dispatchEvent(el, new FakeEvent('focusin'));
  }
  _blurActive() { const previous = this._active; this._active = null; if (previous) { dispatchEvent(previous, new FakeEvent('blur', { bubbles: false })); dispatchEvent(previous, new FakeEvent('focusout')); } }
  // HTML "focus fixup": a focused element that is removed/disabled/hidden stops being the active element.
  _fixupFocus() {
    const active = this._active;
    if (active && (!active.isConnected || !isFocusable(active) || !isVisible(active))) this._active = null;
  }
}

// The browser's own default Tab behaviour, applied when no listener called preventDefault().
function tabbables(doc) { return collect(doc.documentElement).filter(el => isTabbable(el) && isVisible(el)); }
function nativeTabMove(doc, shift) {
  const list = tabbables(doc);
  if (!list.length) return;
  const active = doc._active && doc._active.isConnected ? doc._active : null;
  const at = active ? list.indexOf(active) : -1;
  const next = at === -1 ? (shift ? list[list.length - 1] : list[0]) : list[(at + (shift ? -1 : 1) + list.length) % list.length];
  next.focus();
}

// ---------------------------------------------------------------------------
// Fake fetch Response / Headers
// ---------------------------------------------------------------------------
class FakeHeaders {
  constructor() { this._map = new Map(); }
  set(name, value) { this._map.set(String(name).toLowerCase(), String(value)); }
  delete(name) { this._map.delete(String(name).toLowerCase()); }
  get(name) { const v = this._map.get(String(name).toLowerCase()); return v === undefined ? null : v; }
  has(name) { return this._map.has(String(name).toLowerCase()); }
  forEach(callback) { for (const [k, v] of this._map) callback(v, k, this); }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
  [Symbol.iterator]() { return this._map.entries(); }
}

class FakeResponse {
  constructor(status, text, headers) {
    this.status = status;
    this.ok = status >= 200 && status <= 299;
    this.statusText = '';
    this.headers = headers;
    this.type = 'basic';
    this.redirected = false;
    this.url = '';
    this.bodyUsed = false;
    this._text = text;
  }
  text() { this.bodyUsed = true; return Promise.resolve(this._text); }
  json() { this.bodyUsed = true; return Promise.resolve().then(() => JSON.parse(this._text)); }
  arrayBuffer() { this.bodyUsed = true; const b = Buffer.from(this._text, 'utf8'); return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  blob() { this.bodyUsed = true; return Promise.resolve(new Blob([this._text])); }
  clone() { return new FakeResponse(this.status, this._text, this.headers); }
  get body() {
    const bytes = new Uint8Array(Buffer.from(this._text, 'utf8'));
    let done = false;
    return {
      getReader() {
        return {
          read() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: bytes }); },
          cancel() { done = true; return Promise.resolve(); },
          releaseLock() {},
        };
      },
    };
  }
}

function buildResponse(reply) {
  const headers = new FakeHeaders();
  headers.set('content-type', 'application/json');
  if (!reply.noContentLength) headers.set('content-length', String(utf8Length(reply.text)));
  for (const [name, value] of Object.entries(reply.headers || {})) { if (value === null) headers.delete(name); else headers.set(name, value); }
  return new FakeResponse(reply.status, reply.text, headers);
}

function plainClone(value) {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (value instanceof Headers) return Object.fromEntries([...value.entries()]);
  if (Array.isArray(value)) return value.map(plainClone);
  const out = {};
  for (const key of Object.keys(value)) out[key] = plainClone(value[key]);
  return out;
}
function normalizeHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries([...headers.entries()]);
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

// ---------------------------------------------------------------------------
// Environment: one per test, a fresh vm context
// ---------------------------------------------------------------------------
function createEnv(options = {}) {
  unhandledRejections.length = 0;
  const env = {
    errors: [],
    consoleLines: [],
    calls: [],
    unscripted: [],
    storageWrites: [],
    messages: [],
    beacons: [],
    locationWrites: [],
    reloads: [],
    historyCalls: [],
    clipboardWrites: [],
    clipboardMode: options.clipboard || 'ok',
  };

  // ---- clock / timers / Date ----
  const clock = { now: 0, wall: 1700000000000, seq: 0, timers: new Map() };
  env.clock = clock;
  function moveTo(time) { const delta = time - clock.now; clock.now = time; clock.wall += delta; }
  const addTimer = (fn, ms, args, interval) => {
    const delay = Math.max(0, Number(ms) || 0);
    clock.seq += 1;
    clock.timers.set(clock.seq, { id: clock.seq, seq: clock.seq, time: clock.now + delay, fn, args, interval: interval ? Math.max(1, delay) : null });
    return clock.seq;
  };
  const fakeSetTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
  const fakeSetInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
  const fakeClear = id => { clock.timers.delete(id); };
  env.flush = async function flush() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
  env.advance = async function advance(ms) {
    const target = clock.now + ms;
    await env.flush();
    for (let guard = 0; guard < 200000; guard += 1) {
      let next = null;
      for (const t of clock.timers.values()) {
        if (t.time <= target && (!next || t.time < next.time || (t.time === next.time && t.seq < next.seq))) next = t;
      }
      if (!next) break;
      moveTo(next.time);
      if (next.interval !== null) { next.time += next.interval; clock.seq += 1; next.seq = clock.seq; } else clock.timers.delete(next.id);
      try { next.fn(...next.args); } catch (error) { env.errors.push(error); }
      await env.flush();
    }
    moveTo(target);
    await env.flush();
  };
  env.pendingTimers = () => clock.timers.size;

  const RealDate = Date;
  function FakeDate(...args) {
    if (!new.target) return new RealDate(clock.wall).toString();
    return args.length === 0 ? new RealDate(clock.wall) : new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => clock.wall;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;

  // ---- AbortController / AbortSignal ----
  function abortError() { const e = new Error('This operation was aborted'); e.name = 'AbortError'; e.code = 20; return e; }
  function timeoutError() { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; e.code = 23; return e; }
  class FakeAbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; this._listeners = []; }
    addEventListener(type, callback, options) { if (type === 'abort' && typeof callback === 'function') this._listeners.push({ callback, once: !!(options && options.once) }); }
    removeEventListener(type, callback) { this._listeners = this._listeners.filter(l => l.callback !== callback); }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static timeout(ms) { const signal = new FakeAbortSignal(); fakeSetTimeout(() => doAbort(signal, timeoutError()), ms); return signal; }
    static abort(reason) { const signal = new FakeAbortSignal(); doAbort(signal, reason); return signal; }
  }
  function doAbort(signal, reason) {
    if (signal.aborted) return;
    signal.aborted = true;
    signal.reason = reason === undefined ? abortError() : reason;
    const event = { type: 'abort', target: signal };
    for (const entry of signal._listeners.slice()) {
      if (entry.once) signal.removeEventListener('abort', entry.callback);
      try { entry.callback.call(signal, event); } catch (error) { env.errors.push(error); }
    }
    if (typeof signal.onabort === 'function') { try { signal.onabort(event); } catch (error) { env.errors.push(error); } }
  }
  class FakeAbortController {
    constructor() { this.signal = new FakeAbortSignal(); }
    abort(reason) { doAbort(this.signal, reason); }
  }

  // ---- DOM, location, history, navigator ----
  const document = new FakeDocument(env);
  env.document = document;
  const windowTarget = new EventTargetBase(env);
  env.windowTarget = windowTarget;
  const bgBefore = document.createElement('button'); bgBefore.setAttribute('id', 'bg-before'); bgBefore.textContent = 'background before';
  const bgAfter = document.createElement('button'); bgAfter.setAttribute('id', 'bg-after'); bgAfter.textContent = 'background after';
  document.body.append(bgBefore, bgAfter);
  env.bgBefore = bgBefore;
  env.bgAfter = bgAfter;

  const locState = { pathname: options.pathname || '/', search: options.search || '', hash: options.hash || '' };
  env.locState = locState;
  const location = {
    get pathname() { return locState.pathname; },
    set pathname(v) { env.locationWrites.push(['pathname', v]); },
    get search() { return locState.search; },
    set search(v) { env.locationWrites.push(['search', v]); },
    get hash() { return locState.hash; },
    set hash(v) { env.locationWrites.push(['hash', v]); },
    get href() { return 'http://127.0.0.1:4680' + locState.pathname + locState.search + locState.hash; },
    set href(v) { env.locationWrites.push(['href', v]); },
    get origin() { return 'http://127.0.0.1:4680'; },
    host: '127.0.0.1:4680', hostname: '127.0.0.1', port: '4680', protocol: 'http:',
    assign(v) { env.locationWrites.push(['assign', v]); },
    replace(v) { env.locationWrites.push(['replace', v]); },
    reload(...args) {
      const statusEl = document.getElementById(DOM_IDS.status);
      env.reloads.push({ args, status: statusEl ? statusEl.textContent : null });
    },
    toString() { return this.href; },
  };
  env.location = location;
  const history = {
    state: null,
    replaceState(...args) {
      env.historyCalls.push({ method: 'replaceState', args });
      const url = args[2];
      if (typeof url === 'string') {
        const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
        if (m) { if (m[1]) locState.pathname = m[1]; locState.search = m[2] || ''; locState.hash = m[3] || ''; }
      }
    },
    pushState(...args) { env.historyCalls.push({ method: 'pushState', args }); },
  };
  const navigator = {
    userAgent: 'FakeBrowser/1.0',
    sendBeacon(...args) { env.beacons.push(args); return true; },
    get clipboard() {
      if (env.clipboardMode === 'missing') return undefined;
      if (env.clipboardMode === 'nowrite') return {};
      return {
        writeText(text) {
          env.clipboardWrites.push(text);
          return env.clipboardMode === 'reject' ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
        },
      };
    },
  };

  // ---- storage / console recorders ----
  const makeStorage = name => new Proxy({}, {
    set(target, key, value) { env.storageWrites.push([name, 'set', String(key), String(value)]); return true; },
    deleteProperty(target, key) { env.storageWrites.push([name, 'delete', String(key)]); return true; },
    get(target, key) {
      if (key === 'setItem') return (k, v) => { env.storageWrites.push([name, 'setItem', String(k), String(v)]); };
      if (key === 'removeItem') return k => { env.storageWrites.push([name, 'removeItem', String(k)]); };
      if (key === 'clear') return () => { env.storageWrites.push([name, 'clear']); };
      if (key === 'getItem') return () => null;
      if (key === 'key') return () => null;
      if (key === 'length') return 0;
      return undefined;
    },
  });
  const consoleObject = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'group', 'groupEnd']) {
    consoleObject[method] = (...args) => {
      env.consoleLines.push(args.map(a => { if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch { return String(a); } }).join(' '));
    };
  }

  // ---- fetch ----
  const routes = new Map();
  const routeCounts = new Map();
  env.route = (url, spec) => { routes.set(url, spec); routeCounts.set(url, 0); };
  env.callsTo = url => env.calls.filter(c => c.url === url);
  env.deferred = () => {
    const d = { kind: 'deferred' };
    d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
    return d;
  };
  function abortable(signal, promise) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason !== undefined ? signal.reason : abortError());
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
      promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
        error => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
  }
  function settleReply(reply) {
    if (!reply || typeof reply !== 'object') throw new Error('fake fetch: bad scripted reply');
    switch (reply.kind) {
      case 'response': return buildResponse(reply);
      case 'reject': throw reply.error;
      case 'hang': return new Promise(() => {});
      case 'deferred': return reply.promise.then(settleReply);
      default: throw new Error('fake fetch: unknown reply kind ' + reply.kind);
    }
  }
  function fakeFetch(input, init) {
    const url = typeof input === 'string' ? input : String(input && input.url !== undefined ? input.url : input);
    const index = routeCounts.get(url) || 0;
    routeCounts.set(url, index + 1);
    const signal = init && init.signal;
    const initCopy = init ? plainClone(Object.fromEntries(Object.keys(init).filter(k => k !== 'signal').map(k => [k, init[k]]))) : {};
    const call = {
      url,
      init: initCopy,
      signal,
      headers: normalizeHeaders(init && init.headers),
      headerNamesAsWritten: init && init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers) ? Object.keys(init.headers) : null,
      at: clock.now,
      wall: clock.wall,
      index,
      reply: null,
      abortedAtCall: signal ? signal.aborted : null,
    };
    env.calls.push(call);
    const route = routes.get(url);
    if (route === undefined) {
      env.unscripted.push(call);
      return Promise.reject(new TypeError('fake fetch: no route scripted for ' + url));
    }
    let reply;
    try { reply = typeof route === 'function' ? route(call, index) : Array.isArray(route) ? route[Math.min(index, route.length - 1)] : route; } catch (error) { return Promise.reject(error); }
    call.reply = reply;
    return abortable(signal, Promise.resolve(reply).then(settleReply));
  }

  // ---- window / sandbox ----
  const sandbox = {
    document, location, history, navigator,
    fetch: fakeFetch,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClear, setInterval: fakeSetInterval, clearInterval: fakeClear,
    requestAnimationFrame: fn => addTimer(fn, 16, [clock.now + 16], false), cancelAnimationFrame: fakeClear,
    queueMicrotask,
    AbortController: FakeAbortController, AbortSignal: FakeAbortSignal,
    Date: FakeDate,
    performance: { now: () => clock.wall - 1700000000000 },
    console: consoleObject,
    TextEncoder, TextDecoder, URL, URLSearchParams, Headers, Blob, Event: FakeEvent,
    localStorage: makeStorage('localStorage'), sessionStorage: makeStorage('sessionStorage'),
    postMessage: (...args) => { env.messages.push(args); },
    addEventListener: (...a) => windowTarget.addEventListener(...a),
    removeEventListener: (...a) => windowTarget.removeEventListener(...a),
    dispatchEvent: e => windowTarget.dispatchEvent(e),
    innerWidth: 320, innerHeight: 640,
    confirm: () => false,
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox; sandbox.parent = sandbox;
  document.defaultView = sandbox;
  windowTarget._self = sandbox;
  env.window = sandbox;
  const context = vm.createContext(sandbox);
  env.context = context;

  env.run = (code, filename = 'inline.js') => vm.runInContext(code, context, { filename });
  env.load = (source) => {
    const code = source === undefined ? fs.readFileSync(LOCAL_AUTH_PATH, 'utf8') : source;
    env.globalKeysBefore = Object.keys(sandbox);
    new vm.Script(code, { filename: 'public/local-auth.js' }).runInContext(context);
    env.globalKeysAfter = Object.keys(sandbox);
    return sandbox.hubAuthReady;
  };

  // ---- interaction helpers ----
  env.el = id => document.getElementById(id);
  env.fire = (el, type, init = {}) => { const event = new FakeEvent(type, init); dispatchEvent(el, event); return event; };
  /** A real click: disabled controls never receive it (like a browser). */
  env.click = el => (el.disabled ? null : env.fire(el, 'click'));
  /** Dispatch a click even to a disabled control (races, synthetic events). */
  env.forceClick = el => env.fire(el, 'click');
  env.key = (target, key, extra = {}) => {
    const codes = { Tab: 9, Enter: 13, Escape: 27, ' ': 32 };
    return env.fire(target, 'keydown', { key, code: key, keyCode: codes[key], which: codes[key], shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
  };
  /** Tab / Shift+Tab: dispatch keydown on the active element, then apply the browser default unless prevented. */
  env.pressTab = (shift = false) => {
    const event = env.key(document.activeElement, 'Tab', { shiftKey: shift });
    if (!event.defaultPrevented) nativeTabMove(document, shift);
    return event;
  };
  env.activeId = () => document.activeElement.id;
  env.assertClean = () => {
    assert.deepEqual(env.errors.map(String), [], 'exceptions thrown inside listeners/timers');
    assert.deepEqual(unhandledRejections.map(String), [], 'unhandled promise rejections');
  };
  return env;
}

/** Attach observers to a promise (call AFTER a flush so a missing .catch is still detected). */
function observe(promise) {
  const result = { state: 'pending' };
  promise.then(value => { result.state = 'resolved'; result.value = value; }, error => { result.state = 'rejected'; result.error = error; });
  return result;
}
/** observe() + a flush, so the returned state is the settled one. */
async function settled(env, promise) {
  const result = observe(promise);
  await env.flush();
  return result;
}
function assertRejectedWith(result, message) {
  assert.equal(result.state, 'rejected', 'hubAuthReady should be rejected, state=' + result.state);
  assert.equal(Object.prototype.toString.call(result.error), '[object Error]', 'rejection must be an Error');
  assert.equal(result.error.message, message);
}

// ---------------------------------------------------------------------------
// Page-level helpers
// ---------------------------------------------------------------------------
function ui(env) {
  const get = id => { const el = env.el(id); assert.ok(el, 'missing element #' + id); return el; };
  return {
    overlay: get(DOM_IDS.overlay), title: get(DOM_IDS.title), input: get(DOM_IDS.input),
    status: get(DOM_IDS.status), begin: get(DOM_IDS.begin), copy: get(DOM_IDS.copy),
  };
}
const statusText = env => ui(env).status.textContent;

/** State check answers 401 -> login overlay is shown. */
async function bootOverlay(env) {
  env.route(URLS.state, STATE_401);
  env.load();
  await env.advance(50);
  ui(env);
  // NOTE: never `return` env.window.hubAuthReady from an async helper: it stays pending
  // on purpose and the helper would never settle.
}
/** Click "begin" and let the (already scripted) begin response arrive. */
async function clickBegin(env) {
  env.click(ui(env).begin);
  await env.flush();
}
/** Overlay shown, begin answered with `id`, polling script installed. Returns virtual time when the id was shown. */
async function startAttempt(env, { id = ID1, poll = POLL_PENDING } = {}) {
  await bootOverlay(env);
  env.route(URLS.begin, beginOk(id));
  env.route(URLS.poll, poll);
  const shownAt = env.clock.now;
  await clickBegin(env);
  return shownAt;
}

// ===========================================================================
// 0. HARNESS SELF-TESTS (do not need local-auth.js)
// ===========================================================================
test('[harness] constants: TOKEN looks like HUB_LOCAL_TOKEN, ids look like request ids', () => {
  assert.match(TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.match(ID1, /^[0-9a-f]{32}$/);
  assert.match(ID2, /^[0-9a-f]{32}$/);
});

test('[harness] fake fetch records requests, answers scripted replies and rejects with AbortError on abort', async () => {
  const env = createEnv();
  env.route('/x', json(200, { a: 1 }));
  env.route('/hang', HANG);
  const out = env.run(`(async () => {
    const r = await fetch('/x', { method: 'POST', headers: { 'X-Hub': '1' }, body: '{"k":1}', credentials: 'same-origin' });
    const body = await r.text();
    const c = new AbortController();
    setTimeout(() => c.abort(), 5000);
    let name = null;
    try { await fetch('/hang', { signal: c.signal }); } catch (e) { name = e.name; }
    let unscripted = null;
    try { await fetch('/nope'); } catch (e) { unscripted = e.name; }
    return { status: r.status, ok: r.ok, body, len: r.headers.get('Content-Length'), name, unscripted };
  })()`);
  const state = observe(out);
  await env.advance(4999);
  assert.equal(state.state, 'pending');
  await env.advance(1);
  assert.equal(state.state, 'resolved');
  assert.equal(state.value.status, 200);
  assert.equal(state.value.ok, true);
  assert.equal(state.value.body, '{"a":1}');
  assert.equal(state.value.len, '7');
  assert.equal(state.value.name, 'AbortError');
  assert.equal(state.value.unscripted, 'TypeError');
  assert.equal(env.calls.length, 3);
  assert.equal(env.calls[0].url, '/x');
  assert.equal(env.calls[0].init.method, 'POST');
  assert.equal(env.calls[0].init.body, '{"k":1}');
  assert.deepEqual(env.calls[0].headers, { 'x-hub': '1' });
  assert.deepEqual(env.calls[0].init.headers, { 'X-Hub': '1' });
  assert.equal(env.calls[1].signal.aborted, true);
  assert.equal(env.unscripted.length, 1);
});

test('[harness] fake clock: timers run in order, Date follows the wall clock, wall can be set to NaN/backwards', async () => {
  const env = createEnv();
  const log = env.run(`(() => {
    const log = []; const t0 = Date.now();
    setTimeout(() => log.push(['a', Date.now() - t0]), 300);
    const h = setTimeout(() => log.push('cancelled'), 100); clearTimeout(h);
    setTimeout(() => log.push(['b', Date.now() - t0]), 200);
    const iv = setInterval(() => log.push('i'), 250); setTimeout(() => clearInterval(iv), 800);
    return log;
  })()`);
  await env.advance(1000);
  assert.equal(JSON.stringify(log), JSON.stringify([['b', 200], 'i', ['a', 300], 'i', 'i']));
  assert.equal(env.pendingTimers(), 0);
  env.clock.wall = 1000;
  assert.equal(env.run('Date.now()'), 1000);
  assert.equal(env.run('new Date().getTime()'), 1000);
  env.clock.wall = NaN;
  assert.ok(Number.isNaN(env.run('Date.now()')));
  assert.ok(Number.isNaN(env.run('new Date().getTime()')));
  env.clock.wall = 5;
  await env.advance(10);
  assert.equal(env.run('Date.now()'), 15);
  env.clock.wall -= 100;
  assert.equal(env.run('Date.now()'), -85);
  // AbortSignal.timeout uses the fake timers
  const signal = env.run('AbortSignal.timeout(5000)');
  await env.advance(4999);
  assert.equal(signal.aborted, false);
  await env.advance(1);
  assert.equal(signal.aborted, true);
});

test('[harness] fake DOM: tree, attributes, properties, style, disabled and focus rules', () => {
  const env = createEnv();
  const d = env.document;
  const box = d.createElement('div');
  box.setAttribute('id', 'box');
  const b = d.createElement('button');
  b.id = 'b'; b.type = 'button'; b.textContent = '按我';
  const i = d.createElement('input');
  i.setAttribute('type', 'text'); i.readOnly = true; i.setAttribute('aria-describedby', 'box');
  box.append(b, i, '尾');
  assert.equal(d.getElementById('b'), null, 'detached elements are not found');
  d.body.appendChild(box);
  assert.equal(d.getElementById('b'), b);
  assert.equal(b.getAttribute('id'), 'b');
  assert.equal(b.getAttribute('type'), 'button');
  assert.equal(i.getAttribute('readonly'), '');
  assert.equal(i.readOnly, true);
  assert.equal(i.type, 'text');
  assert.equal(d.createElement('button').type, 'submit');
  assert.equal(box.textContent, '按我尾');
  assert.equal(b.getAttribute('role'), null);
  b.setAttribute('role', 'status'); assert.equal(b.role, 'status');
  // value semantic
  i.value = 'abc'; assert.equal(i.value, 'abc'); i.value = ''; assert.equal(i.value, '');
  // style: properties and cssText agree
  b.style.position = 'fixed'; b.style.zIndex = '2147483647'; b.style.fontFamily = 'monospace';
  assert.equal(b.style.getPropertyValue('z-index'), '2147483647');
  assert.ok(/position: fixed;/.test(b.style.cssText));
  b.style.cssText = 'color: #fff; font-size: 16px';
  assert.equal(b.style.getPropertyValue('font-size'), '16px');
  assert.equal(b.style.position, '');
  b.style.setProperty('inset', '0'); assert.equal(b.style.inset, '0');
  // focus rules
  const loose = d.createElement('button');
  loose.focus(); assert.equal(d.activeElement, d.body, 'detached element cannot take focus');
  b.focus(); assert.equal(d.activeElement, b);
  b.disabled = true; assert.equal(d.activeElement, d.body, 'focus fix-up when the active element becomes disabled');
  b.focus(); assert.equal(d.activeElement, d.body, 'disabled element cannot take focus');
  b.disabled = false; b.focus(); assert.equal(d.activeElement, b);
  box.remove(); assert.equal(d.activeElement, d.body);
  // innerHTML guard
  assert.throws(() => { box.innerHTML = '<b>x</b>'; }, /innerHTML/);
  // selectors
  d.body.appendChild(box);
  assert.equal(d.querySelector('#box button').id, 'b');
  assert.equal(d.querySelectorAll('button:not([disabled]), input').length >= 3, true);
  assert.equal(box.querySelectorAll('[type="text"]').length, 1);
  assert.equal(b.closest('div'), box);
  env.assertClean();
});

test('[harness] fake events: capture/bubble order to window, stopPropagation, on* handlers, disabled clicks, errors are collected', () => {
  const env = createEnv();
  const d = env.document;
  const outer = d.createElement('div'); const inner = d.createElement('button');
  outer.appendChild(inner); d.body.appendChild(outer);
  const order = [];
  env.window.addEventListener('keydown', () => order.push('win-bubble'));
  env.window.addEventListener('keydown', () => order.push('win-capture'), true);
  d.addEventListener('keydown', () => order.push('doc'));
  outer.addEventListener('keydown', () => order.push('outer'));
  inner.addEventListener('keydown', e => { order.push('inner:' + e.key + ':' + e.keyCode + ':' + (e.target === inner)); });
  inner.onkeydown = () => order.push('inner-on');
  env.key(inner, 'Tab', { shiftKey: true });
  assert.deepEqual(order, ['win-capture', 'inner:Tab:9:true', 'inner-on', 'outer', 'doc', 'win-bubble']);
  // stopPropagation
  order.length = 0;
  outer.addEventListener('click', e => { order.push('outer-click'); e.stopPropagation(); });
  d.addEventListener('click', () => order.push('doc-click'));
  env.click(inner);
  assert.deepEqual(order, ['outer-click']);
  // disabled buttons receive no click through env.click, but do through forceClick
  let clicks = 0; inner.addEventListener('click', () => { clicks += 1; });
  inner.disabled = true;
  assert.equal(env.click(inner), null); assert.equal(clicks, 0);
  env.forceClick(inner); assert.equal(clicks, 1);
  // listener exceptions are collected, other listeners still run
  inner.addEventListener('click', () => { throw new Error('boom'); });
  inner.addEventListener('click', () => { clicks += 10; });
  env.forceClick(inner);
  assert.equal(clicks, 12);
  assert.equal(env.errors.length, 1);
  assert.throws(() => env.assertClean(), /listeners/);
});

test('[harness] Tab simulation: without a trap focus escapes the dialog, with a generic trap it cannot', () => {
  const build = withTrap => {
    const env = createEnv();
    env.run(`(() => {
      const box = document.createElement('div'); box.id = 'box';
      const a = document.createElement('button'); a.id = 'a';
      const c = document.createElement('button'); c.id = 'c'; c.disabled = true;
      const i = document.createElement('input'); i.id = 'i';
      box.append(a, c, i); document.body.appendChild(box); a.focus();
      if (${withTrap}) box.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const f = [a, c, i].filter(x => !x.disabled);
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
    })()`);
    return env;
  };
  const free = build(false);
  assert.equal(free.activeId(), 'a');
  free.pressTab(); assert.equal(free.activeId(), 'i', 'disabled button is skipped by the browser default');
  free.pressTab(); assert.equal(free.activeId(), 'bg-before', 'escapes to the page behind (wraps to the first tabbable element)');
  const trapped = build(true);
  const seen = [];
  for (let n = 0; n < 6; n += 1) { trapped.pressTab(); seen.push(trapped.activeId()); }
  assert.deepEqual(seen, ['i', 'a', 'i', 'a', 'i', 'a']);
  const back = [];
  for (let n = 0; n < 3; n += 1) { trapped.pressTab(true); back.push(trapped.activeId()); }
  assert.deepEqual(back, ['i', 'a', 'i']);
  trapped.assertClean();
});

test('[harness] global object: injected names shadow the built-ins, Web APIs exist, nothing but injected keys is visible', () => {
  const env = createEnv();
  assert.equal(env.run('typeof window.hubAuthReady'), 'undefined');
  assert.equal(env.run('window === self && typeof document + typeof fetch + typeof TextEncoder + typeof Blob + typeof Headers'), 'objectfunctionfunctionfunctionfunction');
  env.run('console.log("hello", 1); localStorage.setItem("k", "v"); document.cookie = "a=b"; postMessage("m"); location.hash = "#x";');
  assert.deepEqual(env.consoleLines, ['hello 1']);
  assert.deepEqual(env.storageWrites, [['localStorage', 'setItem', 'k', 'v']]);
  assert.deepEqual(env.document.cookieWrites, ['a=b']);
  assert.equal(env.messages.length, 1);
  assert.deepEqual(env.locationWrites, [['hash', '#x']]);
  env.run("history.replaceState(null, '', '/p?q=1')");
  assert.equal(env.location.hash, '');
  assert.equal(env.location.pathname, '/p');
  assert.equal(env.location.search, '?q=1');
  env.run('location.reload()');
  assert.equal(env.reloads.length, 1);
  env.run('(0, eval)("var leaked = 1")');
  assert.ok(Object.keys(env.window).includes('leaked'));
});

test('[harness] alternative-but-standard idioms work: AbortSignal.timeout with fetch, setInterval, on* handlers, ARIA property reflection, Object.assign on style, replaceChildren, requestAnimationFrame', async () => {
  const env = createEnv();
  env.route('/hang', HANG);
  const out = env.run(`(async () => {
    let name = null;
    try { await fetch('/hang', { signal: AbortSignal.timeout(5000) }); } catch (e) { name = e.name; }
    return name;
  })()`);
  const result = observe(out);
  await env.advance(4999);
  assert.equal(result.state, 'pending');
  await env.advance(1);
  assert.equal(result.state, 'resolved');
  assert.equal(result.value, 'TimeoutError');

  const ticks = env.run('(() => { const t = []; const iv = setInterval(() => t.push(Date.now()), 500); setTimeout(() => clearInterval(iv), 1600); return t; })()');
  const start = env.clock.wall;
  await env.advance(2000);
  assert.deepEqual(Array.from(ticks, x => x - start), [500, 1000, 1500]); // Array.from: ticks belongs to the vm realm

  env.run(`(() => {
    const d = document.createElement('div'); d.id = 'dlg'; d.role = 'dialog'; d.ariaModal = 'true';
    Object.assign(d.style, { position: 'fixed', zIndex: '99999' });
    const b = document.createElement('button'); b.textContent = 'x'; b.onclick = () => { b.textContent = 'clicked'; };
    d.replaceChildren(b); document.body.appendChild(d);
    window.__frame = null; requestAnimationFrame((ts) => { window.__frame = typeof ts; });
  })()`);
  const dlg = env.el('dlg');
  assert.equal(dlg.getAttribute('role'), 'dialog');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  assert.equal(dlg.style.getPropertyValue('z-index'), '99999');
  env.click(dlg.children[0]);
  assert.equal(dlg.textContent, 'clicked');
  await env.advance(20);
  assert.equal(env.window.__frame, 'number');
  env.assertClean();
});

// ===========================================================================
// Static checks of local-auth.js (SPEC 4.1 header, item 7)
// ===========================================================================
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test('[4.1] local-auth.js is a plain strict-mode script (no modules, no libraries)', () => {
  const source = fs.readFileSync(LOCAL_AUTH_PATH, 'utf8');
  assert.match(source, /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(['"])use strict\1/, "'use strict' must be the first statement");
  const code = stripComments(source);
  assert.doesNotMatch(code, /^\s*(?:import|export)\s/m, 'no ES module syntax');
  assert.doesNotMatch(code, /\brequire\s*\(|\bmodule\.exports\b/, 'no CommonJS');
  assert.doesNotMatch(code, /\bimportScripts\b|\bimport\s*\(/, 'no dynamic imports');
});

test('[4.1.6] local-auth.js never touches web storage, JS-set cookies, postMessage or the old /api/local/login endpoint', () => {
  const code = stripComments(fs.readFileSync(LOCAL_AUTH_PATH, 'utf8'));
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'postMessage', 'BroadcastChannel', 'sendBeacon', '/api/local/login']) {
    assert.ok(!code.includes(forbidden), 'local-auth.js must not reference ' + forbidden);
  }
});

test('[4.1] local-auth.js defines window.hubAuthReady (a Promise) and nothing else global, even when executed twice in one context', async () => {
  const env = createEnv();
  env.route(URLS.state, STATE_200);
  const ready = env.load();
  assert.equal(Object.prototype.toString.call(ready), '[object Promise]');
  assert.equal(typeof ready.then, 'function');
  assert.deepEqual(env.globalKeysAfter.filter(k => !env.globalKeysBefore.includes(k)), ['hubAuthReady']);
  await env.flush();
  // A top-level const/let/class would make the second run throw "already been declared".
  assert.doesNotThrow(() => env.load());
  assert.deepEqual(env.globalKeysAfter.filter(k => !env.globalKeysBefore.includes(k)), []);
  await env.flush();
  env.assertClean();
});

// ===========================================================================
// 4.1 (1) "#auth=" fragment
// ===========================================================================
test('[4.1.1] "#auth=" fragment: replaceState runs synchronously, nothing is sent, hubAuthReady rejects with the fixed message, message is shown in body', async () => {
  const env = createEnv({ pathname: '/', search: '', hash: '#auth=' + TOKEN });
  const ready = env.load();
  assert.deepEqual(env.historyCalls, [{ method: 'replaceState', args: [null, '', '/'] }], 'replaceState(null, "", pathname + search) must run immediately');
  assert.equal(env.location.hash, '');
  await env.flush();
  env.assertClean();
  await env.advance(10000);
  assert.equal(env.calls.length, 0, 'no request at all for a legacy #auth= link: ' + JSON.stringify(env.calls.map(c => c.url)));
  assert.equal(env.document.body.textContent, MSG.legacyDisabled);
  assert.equal(env.el(DOM_IDS.overlay), null, 'no login overlay for a legacy link');
  assertRejectedWith(await settled(env, ready), MSG.legacyDisabled);
  env.assertClean();
});

for (const [label, init, expectedUrl] of [
  ['path with a query string', { pathname: '/terminal.html', search: '?task=7&x=%20', hash: '#auth=' + TOKEN }, '/terminal.html?task=7&x=%20'],
  ['empty token after the prefix', { pathname: '/', search: '', hash: '#auth=' }, '/'],
  ['token followed by more fragment text', { pathname: '/index.html', search: '', hash: '#auth=' + TOKEN + '&more=1' }, '/index.html'],
]) {
  test(`[4.1.1] "#auth=" fragment (${label}): replaceState target, no fetch, fixed message`, async () => {
    const env = createEnv(init);
    const ready = env.load();
    assert.deepEqual(env.historyCalls, [{ method: 'replaceState', args: [null, '', expectedUrl] }]);
    await env.flush();
    await env.advance(2000);
    assert.equal(env.calls.length, 0);
    assert.equal(env.document.body.textContent, MSG.legacyDisabled);
    assertRejectedWith(await settled(env, ready), MSG.legacyDisabled);
    env.assertClean();
  });
}

test('[4.1.1/4.1.6] the token-like text never leaves the page: no request, storage, cookie, postMessage, console, location or body text', async () => {
  const env = createEnv({ hash: '#auth=' + TOKEN });
  env.load();
  await env.advance(3000);
  const everything = JSON.stringify([env.calls, env.consoleLines, env.storageWrites, env.document.cookieWrites, env.messages, env.locationWrites, env.beacons, env.historyCalls, env.document.body.textContent]);
  assert.ok(!everything.includes(TOKEN), 'token text leaked: ' + everything);
  assert.ok(!JSON.stringify(env.calls).includes('Authorization'));
});

for (const hash of ['#AUTH=' + TOKEN, '#auth', '#section-2']) {
  test(`[4.1.1] fragment "${hash.slice(0, 12)}..." does not start with "#auth=": normal state check, one GET /api/state`, async () => {
    const env = createEnv({ hash });
    env.route(URLS.state, STATE_200);
    const ready = env.load();
    await env.flush();
    assert.deepEqual(env.calls.map(c => c.url), [URLS.state]);
    assert.equal((await settled(env, ready)).state, 'resolved');
    env.assertClean();
  });
}

// ===========================================================================
// 4.1 (2) + (3) state check
// ===========================================================================
test('[4.1.2] /api/state 200 resolves hubAuthReady, with the exact GET request and no overlay', async () => {
  const env = createEnv();
  env.route(URLS.state, STATE_200);
  const ready = env.load();
  await env.flush();
  const result = observe(ready);
  await env.flush();
  assert.equal(result.state, 'resolved');
  assert.equal(env.calls.length, 1);
  const call = env.calls[0];
  assert.equal(call.url, '/api/state');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.cache, 'no-store');
  assert.ok(call.init.method === undefined || call.init.method === 'GET', 'state check is a GET: ' + call.init.method);
  assert.equal(call.init.body, undefined);
  assert.equal(env.el(DOM_IDS.overlay), null);
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

test('[4.1.2] /api/state 401 shows the login overlay and hubAuthReady stays pending', async () => {
  const env = createEnv();
  env.route(URLS.state, STATE_401);
  const ready = env.load();
  await env.advance(50);
  const parts = ui(env);
  assert.ok(parts.overlay.isConnected, 'overlay must be attached to the document');
  await env.advance(30000);
  const result = observe(ready);
  await env.flush();
  assert.equal(result.state, 'pending', 'hubAuthReady must stay pending while the overlay is shown');
  assert.deepEqual(env.calls.map(c => c.url), [URLS.state], 'nothing is sent until the user presses the button');
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

for (const status of [201, 204, 400, 403, 404, 500, 503]) {
  test(`[4.1.2/4.1.3] /api/state ${status} rejects with the fixed message and shows it in the body`, async () => {
    const env = createEnv();
    env.route(URLS.state, status === 204 ? rawReply(204, '') : json(status, { ok: false, error: 'x' }));
    const ready = env.load();
    await env.flush();
    env.assertClean();
    assert.equal(env.document.body.textContent, MSG.authUnconfirmed);
    assert.equal(env.el(DOM_IDS.overlay), null);
    assertRejectedWith(await settled(env, ready), MSG.authUnconfirmed);
    assert.deepEqual(env.calls.map(c => c.url), [URLS.state]);
  });
}

test('[4.1.2/4.1.3] /api/state network error rejects with the fixed message and shows it in the body', async () => {
  const env = createEnv();
  env.route(URLS.state, networkError());
  const ready = env.load();
  await env.flush();
  env.assertClean();
  assert.equal(env.document.body.textContent, MSG.authUnconfirmed);
  assertRejectedWith(await settled(env, ready), MSG.authUnconfirmed);
});

// ===========================================================================
// 4.1 (5) overlay DOM contract
// ===========================================================================
test('[4.1.5] overlay: ids, dialog ARIA attributes and the exact Traditional Chinese texts', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const { overlay, title, input, status, begin, copy } = ui(env);
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(overlay.getAttribute('aria-labelledby'), DOM_IDS.title);
  for (const el of [title, input, status, begin, copy]) assert.ok(overlay.contains(el), '#' + el.id + ' must be inside the overlay');

  assert.equal(title.tagName, 'H2');
  assert.equal(title.textContent, MSG.title);

  const explanation = collect(overlay).filter(el => el.textContent === MSG.explanation);
  assert.ok(explanation.length >= 1, 'explanation text not found as the full text of one element');
  assert.ok(explanation.some(el => el.tagName === 'P'), 'explanation must be a <p>');

  const labels = collect(overlay).filter(el => el.tagName === 'LABEL');
  assert.equal(labels.length, 1);
  assert.equal(labels[0].getAttribute('for'), DOM_IDS.input);
  assert.equal(labels[0].textContent, MSG.label);

  assert.equal(input.tagName, 'INPUT');
  assert.equal(input.type, 'text');
  assert.equal(input.readOnly, true);
  assert.equal(input.hasAttribute('readonly'), true);
  assert.equal(input.getAttribute('aria-describedby'), DOM_IDS.status);
  assert.equal(input.value, '');

  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, MSG.initialStatus);

  assert.equal(begin.tagName, 'BUTTON');
  assert.equal(begin.type, 'button');
  assert.equal(begin.getAttribute('type'), 'button');
  assert.equal(begin.textContent, MSG.begin);
  assert.equal(begin.disabled, false);

  assert.equal(copy.tagName, 'BUTTON');
  assert.equal(copy.type, 'button');
  assert.equal(copy.getAttribute('type'), 'button');
  assert.equal(copy.textContent, MSG.copy);
  assert.equal(copy.disabled, true, 'copy is disabled until a code exists');
  env.assertClean();
});

test('[4.1.5] overlay: initial focus is on #local-login-begin', async () => {
  const env = createEnv();
  await bootOverlay(env);
  assert.equal(env.document.activeElement, ui(env).begin);
});

test('[4.1.5/4.1.7] overlay styling is inline: fixed full-screen, highest z-index, no <style>/<link> elements', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const { overlay } = ui(env);
  const style = name => overlay.style.getPropertyValue(name).trim();
  assert.equal(style('position'), 'fixed');
  const zero = v => /^0(?:px|%)?$/.test(v);
  const coversByInset = zero(style('inset'));
  const coversByEdges = ['top', 'left', 'right', 'bottom'].every(side => zero(style(side)));
  const full = v => /^(?:100%|100vw|100vh|100dvh|100svh|100lvh)$/.test(v);
  const coversBySize = zero(style('top')) && zero(style('left')) && full(style('width')) && full(style('height'));
  assert.ok(coversByInset || coversByEdges || coversBySize, 'overlay must cover the viewport; cssText=' + overlay.style.cssText);
  const z = Number(style('z-index'));
  assert.ok(Number.isInteger(z) && z >= 10000, 'z-index must be very high (>= 10000), got ' + style('z-index'));
  const tags = collect(env.document.documentElement).map(el => el.tagName);
  assert.ok(!tags.includes('STYLE') && !tags.includes('LINK'), 'styling must be inline via element.style');
  assert.ok(overlay.style.cssText.length > 0);
});

test('[4.1.5/4.1.7] overlay styling: monospace input, 16px base font, nothing wider than 320px, readable contrast', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const { overlay, title, input, status, begin, copy } = ui(env);
  assert.match(input.style.getPropertyValue('font-family'), /monospace/i, 'the code input is monospace');

  // 16px base font: some ancestor-or-self of all controls (inside the overlay) declares 16px.
  const bases = [];
  for (let n = begin; n && n.nodeType === 1; n = n.parentNode) {
    if (!overlay.contains(n)) break;
    if ([title, input, status, copy].every(el => n.contains(el))) bases.push(n);
  }
  assert.ok(bases.some(n => /(?:^|\s)16px(?:\/|\s|$)/.test(n.style.getPropertyValue('font-size')) || /(?:^|\s)16px(?:\/|\s)/.test(n.style.getPropertyValue('font') + ' ')),
    'a container of the dialog content should declare a 16px base font; found ' + bases.map(n => n.style.cssText).join(' | '));

  // works at 320px width: no declared px width/min-width above 320
  for (const el of collect(overlay)) {
    for (const prop of ['width', 'min-width']) {
      const m = /^(\d+(?:\.\d+)?)px$/.exec(el.style.getPropertyValue(prop).trim());
      if (m) assert.ok(Number(m[1]) <= 320, `${el.tagName}#${el.id} ${prop} ${m[1]}px does not fit a 320px viewport`);
    }
  }

  // readable contrast (WCAG AA 4.5:1) for every element whose inline color and background can be resolved
  const pairs = contrastPairs(overlay);
  assert.ok(pairs.length >= 1, 'no inline color/background pair could be evaluated (set color and an opaque background inline)');
  for (const pair of pairs) assert.ok(pair.ratio >= 4.5, `${pair.label}: contrast ${pair.ratio.toFixed(2)} < 4.5`);
});

// ---- tiny colour maths for the contrast check ----
const NAMED_COLORS = {
  white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  navy: [0, 0, 128], blue: [0, 0, 255], green: [0, 128, 0], yellow: [255, 255, 0], orange: [255, 165, 0], maroon: [128, 0, 0], purple: [128, 0, 128],
};
function parseColor(text) {
  const s = String(text || '').trim().toLowerCase();
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = p => (p.endsWith('%') ? Math.round(parseFloat(p) * 2.55) : parseFloat(p));
    const alpha = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
    const out = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
    return Object.values(out).every(Number.isFinite) ? out : null;
  }
  if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = (parseFloat(parts[0]) % 360 + 360) % 360 / 360; const sat = parseFloat(parts[1]) / 100; const light = parseFloat(parts[2]) / 100;
    const alpha = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat; const p = 2 * light - q;
    const hue = t => { let x = t; if (x < 0) x += 1; if (x > 1) x -= 1; if (x < 1 / 6) return p + (q - p) * 6 * x; if (x < 1 / 2) return q; if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6; return p; };
    const out = { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255), a: alpha };
    return Object.values(out).every(Number.isFinite) ? out : null;
  }
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED_COLORS[s]) return { r: NAMED_COLORS[s][0], g: NAMED_COLORS[s][1], b: NAMED_COLORS[s][2], a: 1 };
  return null;
}
function extractColor(value) {
  const tokens = String(value || '').match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+/g) || [];
  for (const token of tokens) { const color = parseColor(token); if (color) return color; }
  return null;
}
function luminance({ r, g, b }) {
  const lin = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(a, b) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); }
function contrastPairs(root) {
  const pairs = [];
  for (const el of collect(root)) {
    const fg = extractColor(el.style.getPropertyValue('color'));
    if (!fg || fg.a < 1) continue;
    let bg = null; let unknown = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      const own = extractColor(n.style.getPropertyValue('background-color') || n.style.getPropertyValue('background'));
      if (own && own.a === 1) { bg = own; break; }
      if (own && own.a > 0) { unknown = true; break; }
      if (n === el && (el.localName === 'button' || el.localName === 'input')) { bg = el.localName === 'input' ? { r: 255, g: 255, b: 255, a: 1 } : { r: 239, g: 239, b: 239, a: 1 }; break; }
      if (n === root) break;
    }
    if (!bg || unknown) continue;
    pairs.push({ label: `${el.tagName}#${el.id || ''}`, ratio: contrastRatio(fg, bg) });
  }
  return pairs;
}

// ===========================================================================
// 4.1 (6) begin flow
// ===========================================================================
test('[4.1.6] begin click: exact POST request {} with same-origin, no-store, exact headers and an abort signal', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, beginOk());
  env.route(URLS.poll, POLL_PENDING);
  await clickBegin(env);
  const calls = env.callsTo(URLS.begin);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, '/api/local/browser/begin');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'same-origin');
  assert.equal(call.init.cache, 'no-store');
  assert.deepEqual(call.headers, { 'content-type': 'application/json', 'x-hub': '1' });
  assert.equal(call.init.body, '{}');
  assert.ok(call.signal && call.abortedAtCall === false, 'request must carry a live AbortSignal');
  env.assertClean();
});

test('[4.1.6] begin click: immediately disables begin and copy, clears the input and shows the progress text', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, env.deferred());
  env.click(ui(env).begin);
  await env.flush();
  const { begin, copy, input, status } = ui(env);
  assert.equal(begin.disabled, true);
  assert.equal(copy.disabled, true);
  assert.equal(input.value, '');
  assert.equal(status.textContent, MSG.generating);
  assert.equal(env.callsTo(URLS.begin).length, 1);
});

test('[4.1.6] a second begin click while the request is in flight is ignored (immediately and after a flush)', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const pending = env.deferred();
  env.route(URLS.begin, pending);
  env.route(URLS.poll, POLL_PENDING);
  const { begin } = ui(env);
  env.click(begin);
  env.forceClick(begin);
  await env.flush();
  env.forceClick(begin);
  await env.flush();
  assert.equal(env.callsTo(URLS.begin).length, 1, 'only one begin request may be sent');
  pending.resolve(beginOk());
  await env.flush();
  assert.equal(env.callsTo(URLS.begin).length, 1);
  assert.equal(ui(env).input.value, ID1);
  env.assertClean();
});

test('[4.1.6] valid begin answer: id shown in the input, copy enabled, status text, begin stays DISABLED while the attempt is live', async () => {
  const env = createEnv();
  await startAttempt(env);
  const { begin, copy, input, status } = ui(env);
  assert.equal(input.value, ID1);
  assert.equal(copy.disabled, false);
  assert.equal(status.textContent, MSG.shown);
  assert.equal(begin.disabled, true);
  await env.advance(20000);
  assert.equal(ui(env).begin.disabled, true, 'begin stays disabled for the whole live attempt');
  env.forceClick(ui(env).begin);
  await env.flush();
  assert.equal(env.callsTo(URLS.begin).length, 1, 'a click during a live attempt does nothing');
  assert.equal(ui(env).input.value, ID1);
  env.assertClean();
});

test('[4.1.6] begin answer: key order in the JSON object does not matter', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, rawReply(200, JSON.stringify({ expiresInSeconds: 60, requestId: ID1, ok: true })));
  env.route(URLS.poll, POLL_PENDING);
  await clickBegin(env);
  assert.equal(ui(env).input.value, ID1);
  assert.equal(ui(env).status.textContent, MSG.shown);
});

const BEGIN_REJECTED = [
  ['extra key', 200, { ok: true, requestId: ID1, expiresInSeconds: 60, extra: 1 }],
  ['missing expiresInSeconds', 200, { ok: true, requestId: ID1 }],
  ['missing ok', 200, { requestId: ID1, expiresInSeconds: 60 }],
  ['missing requestId', 200, { ok: true, expiresInSeconds: 60 }],
  ['ok is false', 200, { ok: false, requestId: ID1, expiresInSeconds: 60 }],
  ['ok is the string "true"', 200, { ok: 'true', requestId: ID1, expiresInSeconds: 60 }],
  ['ok is 1', 200, { ok: 1, requestId: ID1, expiresInSeconds: 60 }],
  ['expiresInSeconds 59', 200, { ok: true, requestId: ID1, expiresInSeconds: 59 }],
  ['expiresInSeconds 61', 200, { ok: true, requestId: ID1, expiresInSeconds: 61 }],
  ['expiresInSeconds "60" (string)', 200, { ok: true, requestId: ID1, expiresInSeconds: '60' }],
  ['expiresInSeconds 60.5', 200, { ok: true, requestId: ID1, expiresInSeconds: 60.5 }],
  ['requestId upper-case hex', 200, { ok: true, requestId: ID1.toUpperCase().replace(/^0/, 'A'), expiresInSeconds: 60 }],
  ['requestId 31 chars', 200, { ok: true, requestId: ID1.slice(1), expiresInSeconds: 60 }],
  ['requestId 33 chars', 200, { ok: true, requestId: ID1 + '0', expiresInSeconds: 60 }],
  ['requestId with a non-hex letter', 200, { ok: true, requestId: 'g' + ID1.slice(1), expiresInSeconds: 60 }],
  ['requestId with trailing newline', 200, { ok: true, requestId: ID1 + '\n', expiresInSeconds: 60 }],
  ['requestId with a space', 200, { ok: true, requestId: ID1.slice(0, 31) + ' ', expiresInSeconds: 60 }],
  ['requestId is a number', 200, { ok: true, requestId: 12345, expiresInSeconds: 60 }],
  ['requestId is null', 200, { ok: true, requestId: null, expiresInSeconds: 60 }],
  ['valid body but HTTP 201', 201, { ok: true, requestId: ID1, expiresInSeconds: 60 }],
  ['valid body but HTTP 202', 202, { ok: true, requestId: ID1, expiresInSeconds: 60 }],
  ['valid body but HTTP 500', 500, { ok: true, requestId: ID1, expiresInSeconds: 60 }],
  ['HTTP 403', 403, { ok: false, error: 'forbidden' }],
  ['HTTP 401', 401, { ok: false, error: 'unauthorized' }],
  ['HTTP 500 error body', 500, { ok: false, error: 'boom' }],
];
for (const [label, status, body] of BEGIN_REJECTED) {
  test(`[4.1.6] begin answer rejected (${label}): failure text, begin re-enabled, input empty, copy disabled, no polling`, async () => {
    const env = createEnv();
    await bootOverlay(env);
    env.route(URLS.begin, json(status, body));
    env.route(URLS.poll, POLL_PENDING);
    await clickBegin(env);
    const { begin, copy, input, status: statusEl } = ui(env);
    assert.equal(statusEl.textContent, MSG.beginFailed);
    assert.equal(begin.disabled, false);
    assert.equal(copy.disabled, true);
    assert.equal(input.value, '');
    await env.advance(3000);
    assert.equal(env.callsTo(URLS.poll).length, 0, 'no polling after a rejected begin answer');
    assert.equal(env.reloads.length, 0);
    env.assertClean();
  });
}

test('[4.1.6] begin HTTP 409: "too many pending" text, begin re-enabled, nothing polled', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, json(409, { ok: false, error: 'conflict' }));
  env.route(URLS.poll, POLL_PENDING);
  await clickBegin(env);
  const { begin, copy, input, status } = ui(env);
  assert.equal(status.textContent, MSG.tooMany);
  assert.equal(begin.disabled, false);
  assert.equal(copy.disabled, true);
  assert.equal(input.value, '');
  await env.advance(2000);
  assert.equal(env.callsTo(URLS.poll).length, 0);
  env.assertClean();
});

test('[4.1.6] begin network error: failure text and begin re-enabled', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, networkError());
  await clickBegin(env);
  assert.equal(statusText(env), MSG.beginFailed);
  assert.equal(ui(env).begin.disabled, false);
  assert.equal(ui(env).copy.disabled, true);
  env.assertClean();
});

test('[4.1.6] after a failed begin the user can try again and succeed', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, [json(500, { ok: false }), beginOk(ID2)]);
  env.route(URLS.poll, POLL_PENDING);
  await clickBegin(env);
  assert.equal(statusText(env), MSG.beginFailed);
  await clickBegin(env);
  assert.equal(env.callsTo(URLS.begin).length, 2);
  assert.equal(ui(env).input.value, ID2);
  assert.equal(statusText(env), MSG.shown);
  assert.equal(ui(env).begin.disabled, true);
  env.assertClean();
});

// ===========================================================================
// 4.1 (4) response reading limits
// ===========================================================================
for (const [bytes, withHeader, accepted] of [[4096, true, true], [4096, false, true], [4097, true, false], [4097, false, false]]) {
  test(`[4.1.4] begin: a ${bytes}-byte JSON body ${withHeader ? 'with' : 'without'} Content-Length is ${accepted ? 'accepted' : 'rejected'} (limit 4096 UTF-8 bytes)`, async () => {
    const env = createEnv();
    await bootOverlay(env);
    const text = paddedJson({ ok: true, requestId: ID1, expiresInSeconds: 60 }, bytes);
    env.route(URLS.begin, rawReply(200, text, { noContentLength: !withHeader }));
    env.route(URLS.poll, POLL_PENDING);
    assert.equal(env.callsTo(URLS.begin).length, 0);
    await clickBegin(env);
    const call = env.callsTo(URLS.begin)[0];
    assert.ok(call.reply.noContentLength === !withHeader);
    if (accepted) {
      assert.equal(ui(env).input.value, ID1, `${bytes}-byte body must be accepted`);
      assert.equal(statusText(env), MSG.shown);
    } else {
      assert.equal(ui(env).input.value, '', `${bytes}-byte body must be rejected`);
      assert.equal(statusText(env), MSG.beginFailed);
      assert.equal(ui(env).begin.disabled, false);
      await env.advance(1500);
      assert.equal(env.callsTo(URLS.poll).length, 0);
    }
    env.assertClean();
  });
}

test('[4.1.4] begin: oversized body made of multi-byte characters (short in characters, > 4096 in UTF-8) is rejected', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const text = JSON.stringify({ ok: true, requestId: ID1, expiresInSeconds: 60, note: '登'.repeat(1500) });
  assert.ok(text.length < 4096 && utf8Length(text) > 4096);
  env.route(URLS.begin, rawReply(200, text));
  env.route(URLS.poll, POLL_PENDING);
  await clickBegin(env);
  assert.equal(statusText(env), MSG.beginFailed);
  assert.equal(ui(env).begin.disabled, false);
  assert.equal(env.callsTo(URLS.poll).length, 0);
});

for (const value of ['abc', '-1', '1e3', '12.5', '+12', '0x10', '4097', '99999999999999999999']) {
  test(`[4.1.4] begin: Content-Length "${value}" (not ^\\d+$ or > 4096) is rejected even though the body is valid`, async () => {
    const env = createEnv();
    await bootOverlay(env);
    env.route(URLS.begin, { ...beginOk(), headers: { 'content-length': value } });
    env.route(URLS.poll, POLL_PENDING);
    await clickBegin(env);
    assert.equal(statusText(env), MSG.beginFailed);
    assert.equal(ui(env).input.value, '');
    assert.equal(ui(env).begin.disabled, false);
    await env.advance(1500);
    assert.equal(env.callsTo(URLS.poll).length, 0);
    env.assertClean();
  });
}

test('[4.1.4] begin: Content-Length 4096 together with a 4096-byte body is accepted', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const text = paddedJson({ ok: true, requestId: ID1, expiresInSeconds: 60 }, 4096);
  env.route(URLS.begin, rawReply(200, text, { headers: { 'Content-Length': '4096' } }));
  env.route(URLS.poll, POLL_PENDING);
  await clickBegin(env);
  assert.equal(ui(env).input.value, ID1);
});

for (const [label, text] of [
  ['empty body', ''],
  ['not JSON', 'definitely not json'],
  ['truncated JSON', '{"ok":true,"requestId":"' + ID1 + '","expiresInSeconds":60'],
  ['JSON array', '[]'],
  ['JSON null', 'null'],
  ['JSON string', JSON.stringify('hello')],
  ['JSON number', '123'],
  ['array that looks like the object', JSON.stringify([{ ok: true, requestId: ID1, expiresInSeconds: 60 }])],
]) {
  test(`[4.1.4] begin: response body must be a plain JSON object (${label})`, async () => {
    const env = createEnv();
    await bootOverlay(env);
    env.route(URLS.begin, rawReply(200, text));
    env.route(URLS.poll, POLL_PENDING);
    await clickBegin(env);
    assert.equal(statusText(env), MSG.beginFailed);
    assert.equal(ui(env).begin.disabled, false);
    assert.equal(ui(env).input.value, '');
    env.assertClean();
  });
}

test('[4.1.4] the size limit applies to every answer: a 409 whose body is 4500 UTF-8 bytes (1500 characters) is "other result", not "too many"', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const text = JSON.stringify({ ok: false, error: 'conflict', note: '登'.repeat(1500) });
  assert.ok(text.length < 4096 && utf8Length(text) > 4096);
  env.route(URLS.begin, rawReply(409, text, { noContentLength: true })); // no header: only the body-size check can reject it
  await clickBegin(env);
  assert.equal(statusText(env), MSG.beginFailed);
  assert.equal(ui(env).begin.disabled, false);
  env.assertClean();
});

test('[4.1.4] begin: the request is aborted after exactly 5 s without an answer', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, HANG);
  env.route(URLS.poll, POLL_PENDING);
  env.click(ui(env).begin);
  await env.advance(4999);
  const call = env.callsTo(URLS.begin)[0];
  assert.equal(call.signal.aborted, false, 'not aborted at 4999 ms');
  assert.equal(statusText(env), MSG.generating);
  assert.equal(ui(env).begin.disabled, true);
  await env.advance(1);
  assert.equal(call.signal.aborted, true, 'aborted at 5000 ms');
  assert.equal(statusText(env), MSG.beginFailed);
  assert.equal(ui(env).begin.disabled, false);
  assert.equal(ui(env).copy.disabled, true);
  await env.advance(3000);
  assert.equal(env.callsTo(URLS.poll).length, 0);
  env.assertClean();
});

// ===========================================================================
// 4.1 (6) polling
// ===========================================================================
test('[4.1.6] polling: first poll after 500 ms, then every 500 ms, exact request; 202 x3 then 200 gives status + exactly one reload', async () => {
  const env = createEnv();
  const poll = (call, index) => (index < 3 ? POLL_PENDING : POLL_APPROVED);
  const shownAt = await startAttempt(env, { poll });
  await env.advance(499);
  assert.equal(env.callsTo(URLS.poll).length, 0, 'no poll before 500 ms');
  await env.advance(1);
  assert.equal(env.callsTo(URLS.poll).length, 1, 'first poll at 500 ms');
  await env.advance(500);
  await env.advance(500);
  assert.equal(env.reloads.length, 0, 'still waiting for the fourth answer');
  await env.advance(500);
  const calls = env.callsTo(URLS.poll);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(c => c.at - shownAt), [500, 1000, 1500, 2000]);
  for (const call of calls) {
    assert.equal(call.url, '/api/local/browser/poll');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.deepEqual(call.headers, { 'content-type': 'application/json', 'x-hub': '1' });
    assert.equal(call.init.body, '{"requestId":"' + ID1 + '"}');
    assert.ok(call.signal && typeof call.signal.aborted === 'boolean');
  }
  assert.equal(env.reloads.length, 1, 'exactly one location.reload()');
  assert.equal(env.reloads[0].status, MSG.approved, 'status text is set before reload');
  await env.advance(10000);
  assert.equal(env.callsTo(URLS.poll).length, 4, 'polling stops after approval');
  assert.equal(env.reloads.length, 1, 'still exactly one reload');
  const ready = env.window.hubAuthReady;
  const result = observe(ready);
  await env.flush();
  assert.equal(result.state, 'pending', 'hubAuthReady stays pending after the reload call');
  assert.equal(env.locationWrites.length, 0);
  env.assertClean();
});

test('[4.1.6] polling: 200 on the very first poll reloads once', async () => {
  const env = createEnv();
  await startAttempt(env, { poll: POLL_APPROVED });
  await env.advance(500);
  assert.equal(statusText(env), MSG.approved);
  assert.equal(env.reloads.length, 1);
  await env.advance(5000);
  assert.equal(env.reloads.length, 1);
  assert.equal(env.callsTo(URLS.poll).length, 1);
  env.assertClean();
});

const POLL_INVALID_CASES = [
  ['202 ok:false,pending:false', 202, { ok: false, pending: false }],
  ['202 ok:true,pending:true', 202, { ok: true, pending: true }],
  ['202 without pending', 202, { ok: false }],
  ['202 with an extra key', 202, { ok: false, pending: true, extra: 1 }],
  ['202 pending is the string "true"', 202, { ok: false, pending: 'true' }],
  ['200 ok:false', 200, { ok: false }],
  ['200 empty object', 200, {}],
  ['200 with an extra key', 200, { ok: true, extra: 1 }],
  ['200 ok is the string "true"', 200, { ok: 'true' }],
  ['200 ok is 1', 200, { ok: 1 }],
  ['200 ok:true with pending key', 200, { ok: true, pending: false }],
  ['201 ok:true', 201, { ok: true }],
  ['409 conflict', 409, { ok: false, error: 'conflict' }],
  ['403 forbidden', 403, { ok: false, error: 'forbidden' }],
  ['401 unauthorized', 401, { ok: false, error: 'unauthorized' }],
  ['500 error', 500, { ok: false, error: 'boom' }],
];
for (const [label, status, body] of POLL_INVALID_CASES) {
  test(`[4.1.6] poll answer (${label}): "invalid or not approved" text, begin re-enabled, polling stops, no reload`, async () => {
    const env = createEnv();
    await startAttempt(env, { poll: json(status, body) });
    await env.advance(500);
    const { begin, status: statusEl } = ui(env);
    assert.equal(statusEl.textContent, MSG.pollInvalid);
    assert.equal(begin.disabled, false);
    const count = env.callsTo(URLS.poll).length;
    assert.equal(count, 1);
    await env.advance(5000);
    assert.equal(env.callsTo(URLS.poll).length, count, 'no more polls after the attempt failed');
    assert.equal(env.reloads.length, 0);
    assert.equal((await settled(env, env.window.hubAuthReady)).state, 'pending', 'hubAuthReady stays pending while the dialog is open');
    env.assertClean();
  });
}

test('[4.1.6] poll 202 x2 and then a wrong shape: the attempt fails on that answer, not before', async () => {
  const env = createEnv();
  await startAttempt(env, { poll: (call, index) => (index < 2 ? POLL_PENDING : json(409, { ok: false, error: 'conflict' })) });
  await env.advance(1000);
  assert.equal(ui(env).begin.disabled, true);
  assert.notEqual(statusText(env), MSG.pollInvalid);
  await env.advance(500);
  assert.equal(statusText(env), MSG.pollInvalid);
  assert.equal(ui(env).begin.disabled, false);
  assert.equal(env.callsTo(URLS.poll).length, 3);
});

test('[4.1.6] poll thrown error: "cannot confirm approval" text, begin re-enabled, polling stops', async () => {
  const env = createEnv();
  await startAttempt(env, { poll: networkError() });
  await env.advance(500);
  assert.equal(statusText(env), MSG.pollError);
  assert.equal(ui(env).begin.disabled, false);
  await env.advance(5000);
  assert.equal(env.callsTo(URLS.poll).length, 1);
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

test('[4.1.4/4.1.6] poll request aborted after exactly 5 s: "cannot confirm approval" text, begin re-enabled, polling stops', async () => {
  const env = createEnv();
  await startAttempt(env, { poll: HANG });
  await env.advance(500);
  const call = env.callsTo(URLS.poll)[0];
  assert.ok(call, 'first poll sent at 500 ms');
  await env.advance(4999);
  assert.equal(call.signal.aborted, false, 'not aborted 4999 ms after the poll started');
  assert.equal(ui(env).begin.disabled, true);
  await env.advance(1);
  assert.equal(call.signal.aborted, true, 'aborted 5000 ms after the poll started');
  assert.equal(statusText(env), MSG.pollError);
  assert.equal(ui(env).begin.disabled, false);
  await env.advance(5000);
  assert.equal(env.callsTo(URLS.poll).length, 1);
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

for (const [label, reply] of [
  ['oversized body (4097 bytes, no Content-Length)', rawReply(202, paddedJson({ ok: false, pending: true }, 4097), { noContentLength: true })],
  ['oversized body (4097 bytes, with Content-Length)', rawReply(202, paddedJson({ ok: false, pending: true }, 4097))],
  ['bad Content-Length header', { ...POLL_PENDING, headers: { 'content-length': '1e3' } }],
  ['oversized Content-Length header', { ...POLL_PENDING, headers: { 'content-length': '4097' } }],
  ['body is not JSON', rawReply(202, 'nope')],
  ['body is a JSON array', rawReply(202, '[]')],
]) {
  test(`[4.1.4/4.1.6] poll answer unreadable (${label}): attempt fails with a poll failure text, begin re-enabled, polling stops`, async () => {
    const env = createEnv();
    await startAttempt(env, { poll: reply });
    await env.advance(500);
    assert.ok(POLL_FAILURES.includes(statusText(env)), 'status must be one of the poll failure texts, got: ' + statusText(env));
    assert.equal(ui(env).begin.disabled, false);
    await env.advance(5000);
    assert.equal(env.callsTo(URLS.poll).length, 1);
    assert.equal(env.reloads.length, 0);
    env.assertClean();
  });
}

for (const withHeader of [true, false]) {
  test(`[4.1.4/4.1.6] poll: a body of exactly 4096 bytes ${withHeader ? 'with' : 'without'} Content-Length is still accepted (padded 202 keeps polling)`, async () => {
    const env = createEnv();
    await startAttempt(env, { poll: rawReply(202, paddedJson({ ok: false, pending: true }, 4096), { noContentLength: !withHeader }) });
    await env.advance(2000);
    assert.equal(env.callsTo(URLS.poll).length, 4);
    assert.equal(ui(env).begin.disabled, true);
    env.assertClean();
  });
}

// ===========================================================================
// 4.1 (6) 60 s limit, clock tampering, generations
// ===========================================================================
test('[4.1.6] gives up after 60 s of wall-clock: still live at 59 s, "timed out" text by 61 s, begin re-enabled, polling stops', async () => {
  const env = createEnv();
  await startAttempt(env);
  await env.advance(59000);
  assert.equal(ui(env).begin.disabled, true, 'still live at 59 s');
  assert.notEqual(statusText(env), MSG.expired);
  assert.ok(env.callsTo(URLS.poll).length >= 100, 'keeps polling every 500 ms (' + env.callsTo(URLS.poll).length + ' polls so far)');
  await env.advance(2000);
  assert.equal(statusText(env), MSG.expired);
  assert.equal(ui(env).begin.disabled, false);
  const count = env.callsTo(URLS.poll).length;
  await env.advance(5000);
  assert.equal(env.callsTo(URLS.poll).length, count, 'no polls after giving up');
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

test('[4.1.6] the 60 s limit follows the wall clock, not the poll count: a clock jump of 61 s ends the attempt at the next tick', async () => {
  const env = createEnv();
  await startAttempt(env);
  await env.advance(2000);
  assert.equal(ui(env).begin.disabled, true);
  env.clock.wall += 61000;
  await env.advance(500);
  assert.equal(statusText(env), MSG.expired);
  assert.equal(ui(env).begin.disabled, false);
  const count = env.callsTo(URLS.poll).length;
  await env.advance(3000);
  assert.equal(env.callsTo(URLS.poll).length, count);
  env.assertClean();
});

test('[4.1.6] clock runs backwards (earlier than the moment the id was shown): "timed out" text, begin re-enabled, polling stops', async () => {
  const env = createEnv();
  await startAttempt(env);
  await env.advance(1000);
  env.clock.wall -= 10000;
  await env.advance(500);
  assert.equal(statusText(env), MSG.expired);
  assert.equal(ui(env).begin.disabled, false);
  const count = env.callsTo(URLS.poll).length;
  await env.advance(3000);
  assert.equal(env.callsTo(URLS.poll).length, count);
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

// "Runs backwards" means: the wall clock reads EARLIER than the moment the code was shown.
// A smaller step back that still stays after that moment is NOT an expiry (decided by the coordinator).
test('[4.1.6] clock steps back by less than the elapsed time (still later than the moment shown): the attempt keeps polling and still ends at 60 s of wall clock', async () => {
  const env = createEnv();
  const shownAt = await startAttempt(env);
  const wallAtShown = env.clock.wall;
  await env.advance(3000);
  assert.equal(ui(env).begin.disabled, true);
  const pollsBefore = env.callsTo(URLS.poll).length;
  env.clock.wall -= 1500; // wall elapsed since shown: 1500 ms instead of 3000 ms; still after the moment shown
  await env.advance(500);
  assert.notEqual(statusText(env), MSG.expired, 'a small step back that stays after the moment shown is not an expiry');
  assert.equal(ui(env).begin.disabled, true, 'attempt still live');
  assert.ok(env.callsTo(URLS.poll).length > pollsBefore, 'polling continues');
  // The deadline is 60 s of WALL clock from the moment shown: timer elapsed 61 s == wall elapsed 59.5 s -> still live ...
  await env.advance(57500); // timer elapsed 61000
  assert.equal(env.clock.now - shownAt, 61000);
  assert.equal(env.clock.wall - wallAtShown, 59500, 'harness sanity: wall elapsed since shown');
  assert.equal(ui(env).begin.disabled, true, 'wall elapsed 59.5 s: still live');
  assert.notEqual(statusText(env), MSG.expired);
  // ... and expired once more than 60 s of wall clock have passed (timer elapsed 63 s == wall elapsed 61.5 s)
  await env.advance(2000);
  assert.equal(statusText(env), MSG.expired);
  assert.equal(ui(env).begin.disabled, false);
  const count = env.callsTo(URLS.poll).length;
  await env.advance(3000);
  assert.equal(env.callsTo(URLS.poll).length, count, 'no polls after giving up');
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

for (const bad of [NaN, Infinity, -Infinity]) {
  test(`[4.1.6] clock becomes non-finite (${bad}) during an attempt: "timed out" text, begin re-enabled, polling stops`, async () => {
    const env = createEnv();
    await startAttempt(env);
    await env.advance(1000);
    env.clock.wall = bad;
    await env.advance(500);
    assert.equal(statusText(env), MSG.expired);
    assert.equal(ui(env).begin.disabled, false);
    const count = env.callsTo(URLS.poll).length;
    await env.advance(3000);
    assert.equal(env.callsTo(URLS.poll).length, count);
    assert.equal(env.reloads.length, 0);
    env.assertClean();
  });
}

test('[4.1.6] clock is already NaN when the id arrives: the attempt still ends (begin re-enabled, polling stops, no reload)', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, beginOk());
  env.route(URLS.poll, POLL_PENDING);
  env.clock.wall = NaN;
  await clickBegin(env);
  await env.advance(3000);
  assert.equal(ui(env).begin.disabled, false, 'a NaN clock must not leave the dialog stuck');
  const count = env.callsTo(URLS.poll).length;
  await env.advance(3000);
  assert.equal(env.callsTo(URLS.poll).length, count);
  assert.equal(env.reloads.length, 0);
  env.assertClean();
});

test('[4.1.6] a new attempt after a failed one: begin click clears the old code and starts clean (generation handling)', async () => {
  const env = createEnv();
  await bootOverlay(env);
  env.route(URLS.begin, [beginOk(ID1), env.deferred()]);
  env.route(URLS.poll, json(409, { ok: false, error: 'conflict' }));
  await clickBegin(env);
  assert.equal(ui(env).input.value, ID1);
  await env.advance(500);
  assert.equal(statusText(env), MSG.pollInvalid);
  assert.equal(ui(env).begin.disabled, false);
  env.click(ui(env).begin);
  await env.flush();
  const { begin, copy, input, status } = ui(env);
  assert.equal(input.value, '', 'old code is cleared');
  assert.equal(copy.disabled, true);
  assert.equal(begin.disabled, true);
  assert.equal(status.textContent, MSG.generating);
  assert.equal(env.callsTo(URLS.begin).length, 2);
});

test('[4.1.6] a superseded attempt leaves nothing behind: its 60 s limit must not end the next attempt, and only the new id is polled', async () => {
  const env = createEnv();
  await bootOverlay(env);
  const t0 = env.clock.now;
  env.route(URLS.begin, [beginOk(ID1), beginOk(ID2)]);
  env.route(URLS.poll, (call) => (JSON.parse(call.init.body).requestId === ID1 ? json(409, { ok: false, error: 'conflict' }) : POLL_PENDING));
  await clickBegin(env);
  await env.advance(500); // attempt 1 fails on its first poll
  assert.equal(statusText(env), MSG.pollInvalid);
  await env.advance(500); // t0 + 1000
  await clickBegin(env);
  const attempt2Start = env.clock.now;
  assert.equal(attempt2Start - t0, 1000);
  assert.equal(ui(env).input.value, ID2);
  // attempt 1's own 60 s deadline would be t0 + 60000; attempt 2's is t0 + 61000
  await env.advance(59500); // t0 + 60500
  assert.equal(ui(env).begin.disabled, true, 'attempt 2 is still live');
  assert.notEqual(statusText(env), MSG.expired, 'a stale deadline of attempt 1 must not end attempt 2');
  assert.notEqual(statusText(env), MSG.pollInvalid);
  const polls = env.callsTo(URLS.poll);
  const ids = polls.map(c => JSON.parse(c.init.body).requestId);
  assert.equal(ids.filter(id => id === ID1).length, 1, 'attempt 1 is polled exactly once');
  assert.equal(ids[0], ID1);
  const later = polls.filter(c => c.at > t0 + 500);
  assert.ok(later.length > 100 && later.every(c => JSON.parse(c.init.body).requestId === ID2), 'after attempt 2 started only its id is polled');
  const gaps = later.slice(1).map((c, i) => c.at - later[i].at);
  assert.ok(gaps.every(g => g === 500), 'exactly one polling loop, 500 ms apart: ' + [...new Set(gaps)]);
  await env.advance(1500); // t0 + 62000
  assert.equal(statusText(env), MSG.expired);
  assert.equal(ui(env).begin.disabled, false);
  env.assertClean();
});

// ===========================================================================
// 4.1 (5) copy button
// ===========================================================================
test('[4.1.5] copy button: clipboard success writes exactly the code and shows the success text', async () => {
  const env = createEnv({ clipboard: 'ok' });
  await startAttempt(env);
  env.click(ui(env).copy);
  await env.flush();
  assert.deepEqual(env.clipboardWrites, [ID1]);
  assert.equal(statusText(env), MSG.copied);
  await env.advance(2000);
  assert.equal(ui(env).begin.disabled, true, 'copying does not disturb the live attempt');
  assert.ok(env.callsTo(URLS.poll).length >= 4, 'polling continues after copying');
  env.assertClean();
});

test('[4.1.5] copy button: clipboard rejection selects the input text and shows the manual-copy text', async () => {
  const env = createEnv({ clipboard: 'reject' });
  await startAttempt(env);
  env.click(ui(env).copy);
  await env.flush();
  assert.deepEqual(env.clipboardWrites, [ID1]);
  assert.equal(statusText(env), MSG.copyFailed);
  assertSelected(ui(env).input);
  assert.equal(ui(env).input.value, ID1, 'the code stays in the input');
  env.assertClean();
});

for (const mode of ['missing', 'nowrite']) {
  test(`[4.1.5] copy button: clipboard unavailable (${mode === 'missing' ? 'navigator.clipboard undefined' : 'no writeText'}) selects the input text and shows the manual-copy text`, async () => {
    const env = createEnv({ clipboard: mode });
    await startAttempt(env);
    env.click(ui(env).copy);
    await env.flush();
    assert.equal(statusText(env), MSG.copyFailed);
    assertSelected(ui(env).input);
    assert.equal(ui(env).input.value, ID1);
    env.assertClean();
  });
}

function assertSelected(input) {
  const selected = input.selectCalls > 0 || (input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length);
  assert.ok(selected, 'the input text must be selected (select() or setSelectionRange(0, length))');
}

test('[4.1.5] copy button is disabled before a code exists: clicking it does nothing', async () => {
  const env = createEnv();
  await bootOverlay(env);
  assert.equal(ui(env).copy.disabled, true);
  env.click(ui(env).copy);
  await env.flush();
  assert.deepEqual(env.clipboardWrites, []);
  assert.equal(statusText(env), MSG.initialStatus);
});

test('[4.1.5] copy button works again for a second code after the first attempt failed', async () => {
  const env = createEnv({ clipboard: 'ok' });
  await bootOverlay(env);
  env.route(URLS.begin, [beginOk(ID1), beginOk(ID2)]);
  env.route(URLS.poll, (call) => (JSON.parse(call.init.body).requestId === ID1 ? json(409, { ok: false }) : POLL_PENDING));
  await clickBegin(env);
  await env.advance(500);
  await clickBegin(env);
  assert.equal(ui(env).input.value, ID2);
  env.click(ui(env).copy);
  await env.flush();
  assert.deepEqual(env.clipboardWrites, [ID2]);
  assert.equal(statusText(env), MSG.copied);
});

// ===========================================================================
// 4.1 (5) focus trap
// ===========================================================================
const idsOf = (env, steps) => steps.map(shift => { env.pressTab(shift); return env.activeId(); });

/**
 * With `expected` (ids of the currently enabled controls) and focus on one of them:
 * k Tab presses must visit every expected control exactly once and come back to the start,
 * Shift+Tab must walk the same cycle in reverse, and focus must never leave the dialog.
 * The cycle ORDER is taken from the first lap (it depends on the DOM order); see the
 * separate literal-order test for the order written in the SPEC.
 */
function assertTrapCycle(env, expected) {
  const overlay = ui(env).overlay;
  const start = env.activeId();
  assert.ok(expected.includes(start), 'focus must start on one of the enabled controls, got #' + start);
  const forward = idsOf(env, expected.map(() => false));
  for (const id of forward) assert.ok(expected.includes(id), 'Tab moved focus to #' + id + ', which is not an enabled dialog control');
  assert.deepEqual([...forward].sort(), [...expected].sort(), 'one lap of Tab must visit each enabled control exactly once: ' + forward.join(' > '));
  assert.equal(forward[forward.length - 1], start, 'one lap of Tab returns to the starting control');
  assert.ok(overlay.contains(env.document.activeElement));
  const lap = [start, ...forward.slice(0, -1)];
  const backward = idsOf(env, expected.map(() => true));
  assert.deepEqual(backward, [...lap].reverse(), 'Shift+Tab walks the cycle in reverse: ' + backward.join(' > '));
  return lap;
}

test('[4.1.5] focus trap, initial state (copy disabled): Tab and Shift+Tab cycle between begin and the input only', async () => {
  const env = createEnv();
  await bootOverlay(env);
  assert.equal(env.activeId(), DOM_IDS.begin);
  assertTrapCycle(env, [DOM_IDS.begin, DOM_IDS.input]);
  env.assertClean();
});

test('[4.1.5] focus trap, live attempt (begin disabled, copy enabled): Tab and Shift+Tab cycle between copy and the input', async () => {
  const env = createEnv();
  await startAttempt(env);
  ui(env).copy.focus();
  assert.equal(env.activeId(), DOM_IDS.copy);
  assertTrapCycle(env, [DOM_IDS.copy, DOM_IDS.input]);
  env.assertClean();
});

test('[4.1.5] focus trap, all three controls enabled: Tab cycles through begin, copy and input, Shift+Tab goes backwards', async () => {
  const env = createEnv();
  await startAttempt(env);
  ui(env).begin.disabled = false; // force the three-control state the SPEC describes
  ui(env).begin.focus();
  assert.equal(env.activeId(), DOM_IDS.begin);
  assertTrapCycle(env, [DOM_IDS.begin, DOM_IDS.copy, DOM_IDS.input]);
  env.assertClean();
});

test('[4.1.5] focus trap, literal order of the SPEC ("cycle through begin, copy, input"): Tab goes begin > copy > input > begin', async () => {
  const env = createEnv();
  await startAttempt(env);
  ui(env).begin.disabled = false;
  ui(env).begin.focus();
  assert.deepEqual(idsOf(env, [false, false, false, false]), [DOM_IDS.copy, DOM_IDS.input, DOM_IDS.begin, DOM_IDS.copy]);
  ui(env).begin.focus();
  assert.deepEqual(idsOf(env, [true, true, true]), [DOM_IDS.input, DOM_IDS.copy, DOM_IDS.begin]);
  env.assertClean();
});

test('[4.1.5] focus trap: focus never reaches the page behind the dialog during 40 Tab / Shift+Tab presses', async () => {
  const env = createEnv();
  await startAttempt(env);
  const overlay = ui(env).overlay;
  const pattern = [false, false, true, false, true, true, false, false, false, true];
  ui(env).copy.focus();
  for (let n = 0; n < 40; n += 1) {
    env.pressTab(pattern[n % pattern.length]);
    assert.ok(overlay.contains(env.document.activeElement) && env.document.activeElement !== overlay, `focus left the dialog at press ${n}: #${env.activeId()}`);
  }
  env.assertClean();
});

// ===========================================================================
// 4.1 (6) hygiene: nothing in location / storage / cookies / postMessage / logs
// ===========================================================================
test('[4.1.6] full successful login: the id appears only in the input and in the poll bodies', async () => {
  const env = createEnv({ clipboard: 'ok' });
  await startAttempt(env, { poll: (call, index) => (index < 2 ? POLL_PENDING : POLL_APPROVED) });
  env.click(ui(env).copy);
  await env.advance(2000);
  assert.equal(env.reloads.length, 1);
  assert.deepEqual(env.calls.map(c => c.url), [URLS.state, URLS.begin, URLS.poll, URLS.poll, URLS.poll]);
  for (const call of env.calls) {
    assert.ok(!call.url.includes(ID1), 'the id must not be part of a URL');
    assert.ok(!('authorization' in call.headers), 'no Authorization header');
    if (call.url !== URLS.state) assert.equal(call.headers['x-hub'], '1');
  }
  assert.deepEqual(env.storageWrites, [], 'no localStorage/sessionStorage writes');
  assert.deepEqual(env.document.cookieWrites, [], 'no cookies set from JS');
  assert.deepEqual(env.messages, [], 'no postMessage');
  assert.deepEqual(env.beacons, [], 'no sendBeacon');
  assert.deepEqual(env.locationWrites, [], 'no writes to location');
  assert.ok(!JSON.stringify(env.historyCalls).includes(ID1), 'the id is not put into history');
  assert.equal(env.historyCalls.filter(c => c.method === 'pushState').length, 0);
  assert.ok(!env.consoleLines.join('\n').includes(ID1), 'the id is never logged');
  assert.ok(!env.consoleLines.join('\n').includes(TOKEN));
  env.assertClean();
});

test('[4.1.6] failure paths never log or store the id either', async () => {
  const env = createEnv({ clipboard: 'reject' });
  await startAttempt(env, { poll: networkError() });
  env.click(ui(env).copy);
  await env.advance(3000);
  assert.ok(!env.consoleLines.join('\n').includes(ID1));
  assert.deepEqual(env.storageWrites, []);
  assert.deepEqual(env.document.cookieWrites, []);
  assert.deepEqual(env.messages, []);
  assert.deepEqual(env.locationWrites, []);
});

// ===========================================================================
// 4.2 web-chat-recovery.html : text checks
// ===========================================================================
const BASELINE_RECOVERY_HTML = "<!doctype html>\n<html lang=\"zh-Hant\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Project Hub 交接復原</title><style>body{font:16px system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 20px}button{padding:8px 12px;margin:6px}pre{white-space:pre-wrap;word-break:break-word}.receipt{border:1px solid #888;padding:16px;margin:16px 0}#status{white-space:pre-wrap}</style></head>\n<body><h1>Project Hub 交接復原</h1><p>目前僅開放查詢與復原已接受的保存。一般作業、CLI、佇列與新交接均未啟動。</p><p>未知或未綁定的控制資料只供檢視；不會自動採用或刪除。復原只寫回先前已接受的內容，須先核對目前檔案身分與摘要。</p><button id=\"refresh\">重新查詢</button><div id=\"records\"></div><pre id=\"inspection\"></pre><p id=\"status\" role=\"status\"></p>\n<script>\n'use strict';\nconst $=id=>document.getElementById(id),status=message=>{$('status').textContent=message;};\nasync function api(route,input){const response=await fetch(route,input?{method:'POST',headers:{'X-Hub':'1','Content-Type':'application/json'},body:JSON.stringify(input)}:{}),value=await response.json();if(!response.ok)throw Error((value.code||'')+' '+(value.error||'復原失敗'));return value;}\nfunction describe(value){const labels={saved:'已核對保存',before:'保存前',changed:'已變更',missing:'不存在',unknown:'未確認'};return '歷史收據：'+value.state+'\\n目前會話：'+(labels[value.actualTargets?.chat]||'未確認')+'\\n目前作業記事：'+(labels[value.actualTargets?.task]||'未確認');}\nlet pageOffset=0;\nasync function load(){const value=await api('/api/web-chat/inspection?offset='+pageOffset);$('records').replaceChildren();$('inspection').textContent=value.inspection.length?'未能綁定的控制資料（只讀）：\\n'+JSON.stringify(value.inspection,null,2):'';\n for(const record of value.records){const section=document.createElement('section');section.className='receipt';const heading=document.createElement('h2');heading.textContent=[record.actor,record.project,record.task].filter(Boolean).join(' / ')||record.receiptId;section.appendChild(heading);const output=document.createElement('pre');output.textContent='交易：'+record.receiptId+'\\n狀態：'+(record.state||record.reasonCode);section.appendChild(output);\n if(record.repairable!==false){const scope={receiptId:record.receiptId,actor:record.actor,project:record.project,task:record.task},check=document.createElement('button');check.textContent='查詢實際狀態';check.onclick=async()=>{try{output.textContent=describe(await api('/api/web-chat/status',scope));}catch(error){status(error.message);}};section.appendChild(check);\n const recover=document.createElement('button');recover.textContent='預覽並復原此筆已接受保存';recover.onclick=async()=>{recover.disabled=true;try{const preview=await api('/api/web-chat/recover/preview',scope),details=(preview.actions||[]).map(action=>[action.target+': '+action.relative,'FileID: '+(action.currentFileFingerprint||'missing'),'目前 SHA-256: '+(action.currentSHA256||'missing'),'已接受內容 SHA-256: '+action.acceptedAfterSHA256,action.willOverwrite?'會覆寫上述目前目標。':'只對帳已接受內容。'].join('\\n')).join('\\n\\n');output.textContent=details;if(!confirm('確認復原這筆先前已接受的保存？\\n\\n'+details)){status('已取消復原；內容與紀錄保留。');return;}const value=await api('/api/web-chat/recover',{...scope,confirm:true,recoveryToken:preview.recoveryToken,expectedRecoverySHA256:preview.previewSHA256});output.textContent=describe(value);status(value.state==='committed'&&value.actualTargets?.chat==='saved'&&value.actualTargets?.task==='saved'?'此筆保存已核對完成；請停止復原模式，再用一般啟動器開啟。':'仍待覆核；資料與紀錄保留。');}catch(error){status(error.message);}finally{recover.disabled=false;}};section.appendChild(recover);}\n $('records').appendChild(section);}\n for(const [offset,label]of [[value.previousOffset,'上一頁'],[value.nextOffset,'下一頁']])if(offset!==null){const button=document.createElement('button');button.textContent=label;button.onclick=()=>{pageOffset=offset;load().catch(error=>status(error.message));};$('records').appendChild(button);}\n status('目前顯示第 '+(pageOffset+1)+' 至 '+(pageOffset+100)+' 個啟動時紀錄範圍；已提交或撤銷的交易不再列出。'+(value.truncated?'請用下一頁覆核其他資料。':''));}\nasync function start(){const token=location.hash.startsWith('#auth=')?location.hash.slice(6):'';history.replaceState(null,'',location.pathname);if(token)await api('/api/local/login',{token});await load();}\n$('refresh').onclick=()=>load().catch(error=>status(error.message));start().catch(error=>status(error.message));\n</script></body></html>\n";

function readRecovery() { return fs.readFileSync(RECOVERY_PATH, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); }
function scriptTags(html) { return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({ attrs: m[1], body: m[2], index: m.index })); }
function extractFunction(source, name) {
  const at = source.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  if (at < 0) return null;
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') { depth -= 1; if (depth === 0) return { text: source.slice(at, i + 1), body: source.slice(open + 1, i), start: at, end: i + 1 }; }
  }
  return null;
}

test('[4.2] recovery page: exactly one <script src="/local-auth.js"></script>, immediately before the existing inline <script>', () => {
  const html = readRecovery();
  const tag = '<script src="/local-auth.js"></script>';
  assert.equal(html.split(tag).length - 1, 1, 'the local-auth.js script tag must appear exactly once');
  const scripts = scriptTags(html);
  assert.equal(scripts.length, 2, 'exactly two script elements: local-auth.js and the inline script');
  assert.match(scripts[0].attrs, /src="\/local-auth\.js"/);
  assert.equal(scripts[0].body, '');
  assert.doesNotMatch(scripts[1].attrs, /src=/, 'the second script is the inline one');
  assert.match(html, /<script src="\/local-auth\.js"><\/script>\s*<script>/, 'the tag sits immediately before the inline <script>');
});

test('[4.2] recovery page: contains no "#auth=" and no /api/local/login call', () => {
  const html = readRecovery();
  assert.ok(!html.includes('#auth='), 'the page must not contain "#auth="');
  assert.ok(!html.includes('/api/local/login'), 'the login call must be removed');
  assert.ok(!/location\.hash/.test(html), 'the fragment handling must be removed completely');
});

test('[4.2] recovery page: start() awaits window.hubAuthReady and then load(), without token handling', () => {
  const html = readRecovery();
  const inline = scriptTags(html).filter(s => !/src=/.test(s.attrs)).pop();
  assert.ok(inline, 'inline script not found');
  const start = extractFunction(inline.body, 'start');
  assert.ok(start, 'function start() not found');
  const ready = start.body.search(/await\s+window\.hubAuthReady\s*;/);
  const load = start.body.search(/await\s+load\(\)\s*;?/);
  assert.ok(ready >= 0, 'start() must contain "await window.hubAuthReady;"');
  assert.ok(load >= 0, 'start() must contain "await load();"');
  assert.ok(ready < load, 'hubAuthReady is awaited before load()');
  assert.ok(!/token/i.test(start.body), 'no token handling left in start()');
  assert.ok(!/replaceState|location/.test(start.body), 'no fragment/location handling left in start()');
  assert.ok(!/api\(/.test(start.body.replace(/await\s+load\(\)/, '')), 'start() makes no api() call of its own');
});

/**
 * The `start().catch(<handler>)` call of the inline script, found by balancing parentheses
 * (string literals are skipped). Returns { text, start, end, handler } or null.
 */
function extractStartCatch(source) {
  const head = /\bstart\(\)\s*\.catch\s*\(/.exec(source);
  if (!head) return null;
  const open = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      for (i += 1; i < source.length && source[i] !== ch; i += 1) if (source[i] === '\\') i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(head.index, i + 1), start: head.index, end: i + 1, handler: source.slice(open + 1, i) };
    }
  }
  return null;
}

test('[4.2] recovery page: a rejection of start() is still shown in #status via the existing status() helper (an `if` guard on the #status element is allowed)', () => {
  const html = readRecovery();
  const inline = scriptTags(html).filter(s => !/src=/.test(s.attrs)).pop();
  assert.ok(inline, 'inline script not found');
  const call = extractStartCatch(inline.body);
  assert.ok(call, 'start().catch(...) not found in the inline script');
  const param = /^\s*(?:async\s*)?(?:\(\s*(\w+)\s*\)|(\w+))\s*=>/.exec(call.handler) || /^\s*(?:async\s*)?function\s*\w*\s*\(\s*(\w+)\s*\)/.exec(call.handler);
  assert.ok(param, 'the catch handler must take the error as its parameter: ' + call.handler);
  const name = param[1] || param[2];
  assert.match(call.handler, new RegExp('\\bstatus\\(\\s*' + name + '\\.message\\s*\\)'), 'the handler must call status(' + name + '.message): ' + call.handler);
  // Both the unguarded form and a guarded form (e.g. `if ($('status')) status(error.message)`) are fine here;
  // that it does not throw when #status is missing is checked by the behavioural test below.
  assert.ok(!/\bthrow\b/.test(call.handler), 'the handler must not throw');
  assert.match(html, /<p id="status" role="status"><\/p>/);
  assert.match(html, /status=message=>\{\$\('status'\)\.textContent=message;\}/);
});

test('[4.2] recovery page: nothing else changed (identical to the baseline apart from the script tag, start() and the start().catch(...) call)', () => {
  const normalise = html => {
    let text = html.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    text = text.replace('<script src="/local-auth.js"></script>', '');
    const start = extractFunction(text, 'start');
    assert.ok(start, 'start() not found');
    text = text.slice(0, start.start) + '/*START*/' + text.slice(start.end);
    const call = extractStartCatch(text);
    assert.ok(call, 'start().catch(...) not found');
    text = text.slice(0, call.start) + '/*START-CATCH*/' + text.slice(call.end);
    return text.replace(/\s*<script/g, '<script').replace(/\s+$/, '');
  };
  assert.equal(normalise(readRecovery()), normalise(BASELINE_RECOVERY_HTML));
});

// ===========================================================================
// 4.2 web-chat-recovery.html : run the inline script against the fakes
// ===========================================================================
const INSPECTION_URL = '/api/web-chat/inspection?offset=0';
const INSPECTION_OK = json(200, { inspection: [], records: [], previousOffset: null, nextOffset: null, truncated: false });

function recoveryEnv({ hash = '', hubAuthReady }) {
  const env = createEnv({ hash });
  for (const [tag, id] of [['button', 'refresh'], ['div', 'records'], ['pre', 'inspection'], ['p', 'status']]) {
    const el = env.document.createElement(tag);
    el.setAttribute('id', id);
    env.document.body.appendChild(el);
  }
  env.window.hubAuthReady = hubAuthReady;
  env.route(INSPECTION_URL, INSPECTION_OK);
  env.route('/api/local/login', json(200, { ok: true }));
  const inline = scriptTags(readRecovery()).filter(s => !/src=/.test(s.attrs)).pop();
  assert.ok(inline, 'inline script not found');
  env.runPage = () => env.run(inline.body, 'web-chat-recovery.html');
  return env;
}

test('[4.2] recovery page behaviour: nothing is requested until hubAuthReady resolves, then exactly one inspection GET and no login call', async () => {
  let resolve;
  const hubAuthReady = new Promise(r => { resolve = r; });
  const env = recoveryEnv({ hubAuthReady });
  env.runPage();
  await env.advance(1000);
  assert.deepEqual(env.calls.map(c => c.url), [], 'no request before hubAuthReady resolves');
  resolve();
  await env.flush();
  assert.deepEqual(env.calls.map(c => c.url), [INSPECTION_URL]);
  assert.equal(env.calls[0].init.method, undefined);
  assert.match(env.el('status').textContent, /^目前顯示第 1 至 100 個啟動時紀錄範圍/);
  env.assertClean();
});

test('[4.2] recovery page behaviour: when hubAuthReady rejects the message is shown in #status and nothing is requested', async () => {
  const error = new Error(MSG.authUnconfirmed);
  const hubAuthReady = Promise.reject(error);
  hubAuthReady.catch(() => {});
  const env = recoveryEnv({ hubAuthReady });
  env.runPage();
  await env.advance(1000);
  assert.equal(env.el('status').textContent, MSG.authUnconfirmed);
  assert.deepEqual(env.calls.map(c => c.url), []);
  env.assertClean();
});

test('[4.2] recovery page behaviour: when hubAuthReady rejects after local-auth.js replaced the body text (#status is gone) the handler does not throw', async () => {
  let reject;
  const hubAuthReady = new Promise((_, r) => { reject = r; });
  hubAuthReady.catch(() => {});
  const env = recoveryEnv({ hubAuthReady });
  env.runPage();
  await env.advance(500);
  assert.deepEqual(env.calls.map(c => c.url), [], 'no request before hubAuthReady settles');
  // what local-auth.js does on a terminal failure: document.body.textContent = error.message
  env.document.body.textContent = MSG.authUnconfirmed;
  assert.equal(env.el('status'), null, 'harness sanity: #status no longer exists');
  reject(new Error(MSG.authUnconfirmed));
  await env.advance(1000);
  env.assertClean(); // no exception in the handler, no unhandled rejection
  assert.equal(env.document.body.textContent, MSG.authUnconfirmed, 'the message local-auth.js put in the body is left alone');
  assert.deepEqual(env.calls.map(c => c.url), [], 'nothing is requested after the rejection');
});

test('[4.2] recovery page behaviour: a stale "#auth=" fragment is never sent anywhere by the page itself', async () => {
  const env = recoveryEnv({ hash: '#auth=' + TOKEN, hubAuthReady: Promise.resolve() });
  env.runPage();
  await env.advance(1000);
  assert.ok(!env.calls.some(c => c.url === '/api/local/login'), 'no login call');
  assert.ok(!JSON.stringify(env.calls).includes(TOKEN), 'the token text is never sent');
  assert.deepEqual(env.calls.map(c => c.url), [INSPECTION_URL]);
  env.assertClean();
});
