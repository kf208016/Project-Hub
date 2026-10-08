'use strict';
window.hubAuthReady = (async () => {
  const prefix = '#auth=';
  const token = location.hash.startsWith(prefix) ? location.hash.slice(prefix.length) : '';
  if (token) {
    history.replaceState(null, '', location.pathname + location.search);
    const response = await fetch('/api/local/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub': '1' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) throw new Error('Windows 本機登入失敗，請重新執行啟動器');
  }
  const response = await fetch('/api/state');
  if (response.status === 401) throw new Error('請由 Windows 啟動器開啟 Project Hub');
  if (!response.ok) throw new Error('Project Hub 無法讀取狀態');
})();
window.hubAuthReady.catch(error => {
  document.body.textContent = error.message;
});
