'use strict';
// Read the account's picker catalog without starting a thread or a model turn.
const { StringDecoder } = require('node:string_decoder');
const cli = require('./cli-platform');
const managed = require('./managed-process');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const MAX_OUTPUT = 5 * 1024 * 1024;

function listModels(file, options = {}) {
  return new Promise((resolve, reject) => {
    const command = cli.invocation(file, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false']);
    const env = { ...(options.env || process.env) };
    for (const key of Object.keys(env)) if (/^HUB_LOCAL_TOKEN$/i.test(key)) delete env[key];
    const child = managed.spawn(command.file, command.args, { cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8'), models = new Map(), cursors = new Set();
    let buffer = '', bytes = 0, sequence = 0, pending, pages = 0, completed = false, failure;
    const stop = message => {
      if (failure || completed) return;
      failure = new Error(message);
      child.kill();
    };
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const request = (method, params) => {
      pending = { id: ++sequence, method };
      send({ ...pending, params });
    };
    const page = cursor => {
      pages++;
      request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    };
    const receive = message => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Codex 模型協定格式無效');
      if (message.method) {
        // Discovery never grants an approval or starts work in response to a server request.
        if (message.id !== undefined) throw Error('Codex 模型查詢收到非預期的執行要求');
        return;
      }
      if (!pending || message.id !== pending.id) throw Error('Codex 模型查詢回應識別不符');
      if (message.error || !message.result || typeof message.result !== 'object' || Array.isArray(message.result)) throw Error('Codex 模型查詢失敗');
      const method = pending.method; pending = null;
      if (method === 'initialize') { send({ method: 'initialized', params: {} }); return page(); }
      const result = message.result;
      if (!Array.isArray(result.data) || result.data.length > 100 || (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096))) throw Error('Codex 模型列表格式無效');
      for (const row of result.data) {
        if (!row || typeof row.model !== 'string' || !ID.test(row.model) || typeof row.displayName !== 'string' || !row.displayName || row.displayName.length > 80 || /[\x00-\x1f\x7f]/.test(row.displayName) || typeof row.hidden !== 'boolean') throw Error('Codex 模型項目格式無效');
        if (row.hidden) continue;
        if (models.has(row.model) && models.get(row.model).label !== row.displayName) throw Error('Codex 模型列表含有矛盾的重複項目');
        models.set(row.model, { id: row.model, label: row.displayName });
      }
      if (result.nextCursor != null) {
        if (cursors.has(result.nextCursor) || pages >= 10) throw Error('Codex 模型列表分頁無效或超過上限');
        cursors.add(result.nextCursor);
        return page(result.nextCursor);
      }
      if (!models.size) throw Error('Codex 沒有回報可選模型；原設定保持不變');
      completed = true;
      // The managed owner waits for the entire discovery process tree to exit.
      child.kill();
    };
    const timer = setTimeout(() => stop('Codex 模型查詢逾時'), options.timeout || 15000);
    child.stdin.on('error', () => stop('Codex 模型查詢通道中斷'));
    child.on('spawn', () => { try { request('initialize', { clientInfo: { name: 'project_hub_models', version: '1.0.0' } }); } catch { stop('Codex 模型查詢通道中斷'); } });
    child.stdout.on('data', chunk => {
      if (failure || completed) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) return stop('Codex 模型回應超過上限');
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n'); buffer = lines.pop();
      try { for (const line of lines) { if (line.trim()) receive(JSON.parse(line)); if (failure || completed) break; } }
      catch (e) { stop(e instanceof SyntaxError ? 'Codex 模型回應不是有效的 JSON' : e.message); }
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop('Codex 模型回應超過上限'); });
    child.on('error', () => stop('Codex 模型查詢無法啟動'));
    child.on('close', () => {
      clearTimeout(timer);
      if (failure || !completed) reject(failure || Error('Codex 模型查詢在完成前中斷'));
      else resolve([...models.values()]);
    });
  });
}
module.exports = { listModels };
