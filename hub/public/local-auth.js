'use strict';
// One-time browser login. The public request id may be shown; nothing else is stored.
(function () {
  const STATE_FAILURE = '無法確認本機登入，請重新開啟啟動器。';
  const LINK_RETIRED = '此啟動連結已停用，請重新執行啟動器。';
  const READY_MS = 60000;
  const POLL_MS = 500;
  const ABORT_MS = 5000;
  const MAX_BYTES = 4096;

  const ready = new Promise(function (resolve, reject) {
    if (location.hash.startsWith('#auth=')) {
      history.replaceState(null, '', location.pathname + location.search);
      reject(new Error(LINK_RETIRED));
      return;
    }
    fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      if (response.status === 200) {
        resolve();
        return;
      }
      if (response.status === 401) {
        showLogin();
        return;
      }
      throw new Error('STATE');
    }).catch(function () {
      reject(new Error(STATE_FAILURE));
    });
  });

  window.hubAuthReady = ready;
  ready.catch(function (error) {
    document.body.textContent = error.message;
  });

  function showLogin() {
    const overlay = node('div', {
      id: 'local-login-overlay',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'local-login-title'
    });
    paint(overlay, {
      position: 'fixed',
      top: '0',
      right: '0',
      bottom: '0',
      left: '0',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      // Centre with margin:auto on the card, not align-items on this scroll container: when the card is taller than the
      // viewport (high zoom, small window) align-items would cut off the top, which can never be scrolled to.
      display: 'flex',
      padding: '12px',
      overflow: 'auto',
      background: 'rgba(15, 23, 32, 0.72)',
      color: '#17202a',
      fontSize: '16px',
      fontFamily: 'system-ui, sans-serif'
    });

    const card = node('div');
    paint(card, {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '520px',
      margin: 'auto',
      background: '#ffffff',
      color: '#17202a',
      padding: '20px',
      borderRadius: '12px',
      fontSize: '16px',
      lineHeight: '1.5',
      fontFamily: 'system-ui, sans-serif'
    });

    const title = node('h2', { id: 'local-login-title' }, 'Project Hub 本機登入');
    paint(title, { margin: '0 0 8px', fontSize: '20px', lineHeight: '1.3', color: '#17202a' });

    const explanation = node('p', {}, '按下「產生一次性登入代碼」後，將下方代碼貼到 Windows 啟動器的「Project Hub 本機登入確認」視窗，再按「核准登入」。');
    paint(explanation, { margin: '0 0 16px', color: '#17202a' });

    const label = node('label', { for: 'local-login-request' }, '待核准代碼');
    paint(label, { display: 'block', margin: '0 0 6px', fontWeight: '600', color: '#17202a' });

    const input = node('input', {
      id: 'local-login-request',
      type: 'text',
      readonly: 'readonly',
      'aria-describedby': 'local-login-status'
    });
    input.type = 'text';
    input.readOnly = true;
    paint(input, {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      margin: '0 0 12px',
      padding: '10px',
      fontSize: '16px',
      fontFamily: 'ui-monospace, Consolas, monospace',
      color: '#17202a',
      background: '#f4f7fb',
      border: '1px solid #5c6b7a',
      borderRadius: '6px'
    });

    const status = node('p', { id: 'local-login-status', role: 'status' }, '代碼有效 60 秒；瀏覽器不會取得啟動器的登入憑證。');
    paint(status, { margin: '0 0 16px', minHeight: '3em', color: '#17202a' });

    const begin = node('button', { id: 'local-login-begin', type: 'button' }, '產生一次性登入代碼');
    begin.type = 'button';
    paint(begin, buttonStyle('#ffffff', '#174ea6', '0'));

    const copy = node('button', { id: 'local-login-copy', type: 'button' }, '複製代碼');
    copy.type = 'button';
    setDisabled(copy, true);
    paint(copy, buttonStyle('#174ea6', '#ffffff', '1px solid #174ea6'));

    const actions = node('div');
    paint(actions, { display: 'flex', flexWrap: 'wrap', gap: '8px' });
    actions.append(begin, copy);
    card.append(title, explanation, label, input, status, actions);
    overlay.append(card);
    document.body.appendChild(overlay);
    begin.focus();

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const ring = [begin, copy, input].filter(function (element) { return !element.disabled; });
      event.preventDefault();
      if (ring.length === 0) return;
      const current = ring.indexOf(document.activeElement);
      const forward = !event.shiftKey;
      const next = current === -1
        ? ring[forward ? 0 : ring.length - 1]
        : ring[(current + (forward ? 1 : -1) + ring.length) % ring.length];
      next.focus();
    }, true);

    let generation = 0;
    let live = false;
    let watchdog = 0;
    let reloading = false;

    copy.addEventListener('click', function () {
      const code = input.value;
      const seen = generation;
      if (copy.disabled || !code) return;
      let write;
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('NO_CLIPBOARD');
        write = clipboard.writeText(code);
      } catch (error) {
        showManualCopy(seen);
        return;
      }
      Promise.resolve(write).then(function () {
        if (seen !== generation) return;
        status.textContent = '已複製代碼。';
      }, function () {
        showManualCopy(seen);
      });
    });

    begin.addEventListener('click', function () {
      if (live) return;
      live = true;
      const mine = ++generation;
      setDisabled(begin, true);
      input.value = '';
      setDisabled(copy, true);
      status.textContent = '正在產生待核准代碼…';
      startAttempt(mine);
    });

    function showManualCopy(seen) {
      if (seen !== generation) return;
      input.focus();
      if (typeof input.select === 'function') input.select();
      status.textContent = '無法自動複製，請手動選取代碼。';
    }

    function stop(mine, message) {
      if (mine !== generation) return;
      generation += 1;
      live = false;
      clearTimeout(watchdog);
      setDisabled(begin, false);
      status.textContent = message;
    }

    function startAttempt(mine) {
      post('/api/local/browser/begin', {}).then(function (result) {
        if (mine !== generation) return;
        if (result.status === 409) {
          stop(mine, '待核准的要求過多，請稍候再產生。');
          return;
        }
        const value = result.value;
        const requestId = value.requestId;
        const valid = result.status === 200
          && exactKeys(value, ['expiresInSeconds', 'ok', 'requestId'])
          && value.ok === true
          && value.expiresInSeconds === 60
          && typeof requestId === 'string'
          && /^[0-9a-f]{32}$/.test(requestId);
        if (!valid) {
          stop(mine, '無法產生登入代碼，請重新嘗試。');
          return;
        }
        input.value = requestId;
        setDisabled(copy, false);
        setDisabled(begin, true);
        status.textContent = '請在 Windows 的「Project Hub 本機登入確認」視窗貼上此代碼並按「核准登入」。';
        const shownAt = Date.now();
        // Wall clock only: 60s from the moment the id is shown, or a non-finite / backwards clock.
        if (expired(Date.now(), shownAt)) {
          stop(mine, '代碼已逾時，請重新產生。');
          return;
        }
        clearTimeout(watchdog);
        watchdog = setTimeout(function () {
          if (mine !== generation) return;
          if (!expired(Date.now(), shownAt)) return;
          stop(mine, '代碼已逾時，請重新產生。');
        }, READY_MS);
        schedulePoll(mine, requestId, shownAt, POLL_MS);
      }).catch(function () {
        stop(mine, '無法產生登入代碼，請重新嘗試。');
      });
    }

    function schedulePoll(mine, requestId, shownAt, delay) {
      setTimeout(function () {
        pollOnce(mine, requestId, shownAt).catch(function () {
          if (mine !== generation) return;
          if (expired(Date.now(), shownAt)) {
            stop(mine, '代碼已逾時，請重新產生。');
            return;
          }
          stop(mine, '無法確認核准結果，請重新產生代碼。');
        });
      }, delay);
    }

    function pollOnce(mine, requestId, shownAt) {
      if (mine !== generation) return Promise.resolve();
      if (expired(Date.now(), shownAt)) {
        stop(mine, '代碼已逾時，請重新產生。');
        return Promise.resolve();
      }
      return post('/api/local/browser/poll', { requestId: requestId }).then(function (result) {
        if (mine !== generation) return;
        if (expired(Date.now(), shownAt)) {
          stop(mine, '代碼已逾時，請重新產生。');
          return;
        }
        const value = result.value;
        if (result.status === 202 && exactKeys(value, ['ok', 'pending']) && value.ok === false && value.pending === true) {
          schedulePoll(mine, requestId, shownAt, POLL_MS);
          return;
        }
        if (result.status === 200 && exactKeys(value, ['ok']) && value.ok === true) {
          if (mine !== generation || reloading) return;
          reloading = true;
          generation += 1;
          clearTimeout(watchdog);
          status.textContent = '核准完成，正在開啟 Hub…';
          location.reload();
          return;
        }
        stop(mine, '代碼已失效或未核准，請重新產生。');
      }).catch(function () {
        if (mine !== generation) return;
        if (expired(Date.now(), shownAt)) {
          stop(mine, '代碼已逾時，請重新產生。');
          return;
        }
        stop(mine, '無法確認核准結果，請重新產生代碼。');
      });
    }
  }

  function post(route, body) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, ABORT_MS);
    return Promise.resolve().then(function () {
      return fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Hub': '1' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    }).then(function (response) {
      return readBoundedJson(response);
    }).finally(function () {
      clearTimeout(timer);
    });
  }

  function readBoundedJson(response) {
    const declared = contentLength(response);
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
      throw new Error('RESPONSE_BOUND');
    }
    return Promise.resolve(response.text()).then(function (text) {
      if (typeof text !== 'string') throw new Error('RESPONSE_INVALID');
      if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('RESPONSE_BOUND');
      let value;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new Error('RESPONSE_INVALID');
      }
      if (!isPlainObject(value)) throw new Error('RESPONSE_INVALID');
      return { status: response.status, value: value };
    });
  }

  function contentLength(response) {
    const headers = response && response.headers;
    if (!headers || typeof headers.get !== 'function') return null;
    const names = ['content-length', 'Content-Length'];
    for (let i = 0; i < names.length; i += 1) {
      let value;
      try {
        value = headers.get(names[i]);
      } catch (error) {
        value = undefined;
      }
      if (value !== null && value !== undefined) return String(value);
    }
    return null;
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = keys.slice().sort();
    if (actual.length !== expected.length) return false;
    for (let i = 0; i < actual.length; i += 1) {
      if (actual[i] !== expected[i]) return false;
    }
    return true;
  }

  function expired(now, shownAt) {
    if (!Number.isFinite(now) || !Number.isFinite(shownAt)) return true;
    if (now < shownAt) return true;
    return now - shownAt >= READY_MS;
  }

  function setDisabled(element, disabled) {
    element.disabled = !!disabled;
    if (disabled) element.setAttribute('disabled', '');
    else if (typeof element.removeAttribute === 'function') element.removeAttribute('disabled');
  }

  function buttonStyle(color, background, border) {
    return {
      flex: '1 1 180px',
      maxWidth: '100%',
      margin: '0',
      padding: '10px 14px',
      fontSize: '16px',
      fontFamily: 'inherit',
      lineHeight: '1.4',
      color: color,
      background: background,
      border: border,
      borderRadius: '6px',
      cursor: 'pointer'
    };
  }

  function node(tag, attributes, text) {
    const element = document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        element.setAttribute(key, attributes[key]);
        if (key === 'id') element.id = attributes[key];
      });
    }
    if (typeof text === 'string') element.textContent = text;
    return element;
  }

  function paint(element, styles) {
    Object.keys(styles).forEach(function (key) {
      element.style[key] = styles[key];
    });
  }
})();
