(async function () {
  'use strict';
  const query = new URLSearchParams(location.search), scope = { project: query.get('project'), task: query.get('task'), ai: query.get('ai') };
  const note = document.querySelector('#note'), claim = document.querySelector('#claim'), reconnect = document.querySelector('#reconnect'), stop = document.querySelector('#stop');
  let view = null, stream = null, fit, term, observer;
  async function api(path, body, keepalive = false) {
    if(window.HubNativeRestart?.paused)throw Error('Hub 正在重新啟動，已暫停連線以保護登入憑證。');
    if (window.hubAuthReady) await window.hubAuthReady;
    if(window.HubNativeRestart?.paused)throw Error('Hub 正在重新啟動，已暫停連線以保護登入憑證。');
    const response = await fetch(path, { method: 'POST', headers: { 'X-Hub':'1', 'Content-Type':'application/json' }, body: JSON.stringify(body), keepalive });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '終端機操作失敗'); return result;
  }
  function state(s) { claim.disabled = s.readonly === true || s.disconnected === true; reconnect.disabled = !s.disconnected; term.options.disableStdin = s.role !== 'owner' || s.readonly; note.textContent = s.disconnected ? '連線已中斷；按重新連線後再確認控制者。' : s.readonly ? '此會話已結束或正在停止，僅供觀看輸出。' : s.role === 'owner' ? '此視窗控制輸入與尺寸；關閉視窗不會停止 Codex。' : '目前僅供觀看；按接管輸入會移轉此會話的控制權。'; }
  function resize() { try { fit.fit(); view?.resize(term.cols, term.rows).catch(error => { note.textContent = error.message; }); } catch (_) {} }
  async function connect() {
    if(window.HubNativeRestart?.paused)throw Error('等待 Hub 重新啟動的身分證明。');
    if (view) await view.close(); if (stream) stream.close();
    view = new window.HubTerminalView({ api, ...scope, onState: state, onError: error => { note.textContent = error.message; } });
    await view.connect(); stop.disabled = false; term.reset();
    if(window.HubNativeRestart?.paused)return;
    stream = new EventSource('/api/term/stream?' + new URLSearchParams(scope));
    stream.onmessage = event => { try { const row = JSON.parse(event.data); if (row.type === 'data') term.write(row.data); if (row.type === 'exit') { term.write('\r\n— 會話已結束 —\r\n'); stream.close(); view.refresh().catch(error => view.lost(error)); stop.disabled = true; } } catch (_) { note.textContent = '終端機輸出格式無效；請重新連線。'; } };
    resize();
  }
  try {
    if (!scope.project || !scope.task || !['codex','claude','agy'].includes(scope.ai)) throw Error('終端機專案或作業參數無效');
    document.querySelector('#title').textContent = 'Hub 終端機 · ' + scope.project + '／' + scope.task;
    term = new window.Terminal({ fontSize:13, fontFamily:'Consolas, monospace', cursorBlink:true, scrollback:5000, theme:{background:'#10131a'} });
    fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(document.querySelector('#terminal'));
    term.onData(data => view?.write(data).catch(error => { note.textContent = error.message; }));
    observer = new ResizeObserver(resize); observer.observe(document.querySelector('#terminal'));
    claim.onclick = async () => { if (!confirm('將此會話的輸入與尺寸控制移轉至此視窗？其他視窗會繼續觀看。')) return; try { await view.claim(true); resize(); term.focus(); } catch (error) { note.textContent = error.message; } };
    reconnect.onclick = () => connect().catch(error => { note.textContent = error.message; });
    stop.onclick = async () => { if (!confirm('停止此 Codex 會話及其自建子程序？')) return; try { await api('/api/term/stop', scope); await view.refresh(); stop.disabled = true; } catch (error) { note.textContent = error.message; } };
    await connect();
  } catch (error) { note.textContent = error.message; reconnect.disabled = false; }
  window.addEventListener('pagehide', () => { stream?.close(); observer?.disconnect(); if (view?.credentials().viewId) api('/api/term/view/disconnect', { ...scope, ...view.credentials() }, true).catch(() => {}); view?.close(); });
  window.addEventListener('hub-restart-pause',()=>{stream?.close();view?.lost(Error('Hub 正在重新啟動；驗證身分後會重新連線。'));claim.disabled=true;reconnect.disabled=true;stop.disabled=true;});
})();
