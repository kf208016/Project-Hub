#!/usr/bin/env node
'use strict';
// Project Hub の MCP（ChatGPT などの AI が Hub の作業を読み、結果を書き戻すための道具）
// 使い方: node mcp.js（標準入出力で JSON-RPC 2.0。1行に1つ）。tunnel-client などから起動する
// 中身は動いている Hub（http://127.0.0.1:<HUB_MCP_PORT ?? HUB_PORT ?? 4545>）に聞くだけ。書くのは Hub だけ。記録は標準エラーへ
const http = require('http');
const crypto = require('crypto');
// The explicit UI MCP endpoint wins over a port inherited from a parent Hub.
// Do not coerce empty strings, whitespace, exponent notation or decimal ports.
const PORT_TEXT = process.env.HUB_MCP_PORT ?? process.env.HUB_PORT ?? '4545';
let PORT = /^[1-9][0-9]{0,4}$/.test(PORT_TEXT) ? Number(PORT_TEXT) : NaN;
let TOKEN = process.env.HUB_MCP_TOKEN || '', RUN_ID = process.env.HUB_MCP_RUN_ID || '';
delete process.env.HUB_MCP_TOKEN;
const CREDENTIAL_FILE=process.env.HUB_MCP_CREDENTIAL_FILE||'';
const TASK_CREDENTIAL_FILE=process.env.HUB_MCP_TASK_CREDENTIAL_FILE||'';
delete process.env.HUB_MCP_CREDENTIAL_FILE;
delete process.env.HUB_MCP_TASK_CREDENTIAL_FILE;
let protectedCredentialFailed=false;
let taskProxy=null;
const credentialReady=(async()=>{if(!CREDENTIAL_FILE&&!TASK_CREDENTIAL_FILE)return;try{if(TOKEN||RUN_ID||process.env.HUB_MCP_PORT!==undefined||CREDENTIAL_FILE&&TASK_CREDENTIAL_FILE)throw Error();const credential=TASK_CREDENTIAL_FILE?require('./lib/native-mcp-task-credential').load(TASK_CREDENTIAL_FILE):await require('./lib/mcp-credential').loadCredential(CREDENTIAL_FILE);PORT=credential.port;TOKEN=credential.token;RUN_ID=credential.runId;if(TASK_CREDENTIAL_FILE){const value=process.env.HTTP_PROXY;if(typeof value!=='string'||!/^http:\/\/hub:[a-f0-9]{64}@127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value))throw Error();taskProxy=new URL(value);if(Number(taskProxy.port)>65535)throw Error();}}catch{protectedCredentialFailed=true;TOKEN='';RUN_ID='';PORT=NaN;}})();
const MAX_MESSAGE = 2 * 1024 * 1024;
const credentialError = () => (process.platform === 'win32' || TOKEN || RUN_ID) && (!/^[A-Za-z0-9_-]{43}$/.test(TOKEN) || !/^[A-Za-z0-9_-]{16,128}$/.test(RUN_ID));
const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '0'; } })();
const PROTOCOL = '2025-06-18';
const log = (...a) => process.stderr.write(`[project-hub mcp] ${a.join(' ')}\n`);
const validMeta = meta => meta === undefined || (meta && typeof meta === 'object' && !Array.isArray(meta) && Buffer.byteLength(JSON.stringify(meta)) <= 4096 &&
  (meta.progressToken === undefined || (typeof meta.progressToken === 'string' && meta.progressToken.length <= 128) || Number.isSafeInteger(meta.progressToken)));

function hub(method, p, body) {
  return credentialReady.then(()=>new Promise((resolve, reject) => {
    if(protectedCredentialFailed)return reject(Error('MCP protected capability credential is invalid or expired'));
    if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535 || credentialError()) return reject(Error('MCP capability credential or port is invalid'));
    const data = body === undefined ? null : JSON.stringify(body);
    if (data && Buffer.byteLength(data) > MAX_MESSAGE) return reject(Error('MCP request exceeds the size limit'));
    const rq = http.request({ host: '127.0.0.1', port: taskProxy?Number(taskProxy.port):PORT, path: taskProxy?'http://127.0.0.1:'+PORT+p:p, method,agent:false, headers: { 'X-Hub': '1', Accept: 'application/json',...(taskProxy?{Host:'127.0.0.1:'+PORT,'Proxy-Authorization':'Basic '+Buffer.from(taskProxy.username+':'+taskProxy.password).toString('base64')} :{}), ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN, 'X-Hub-Mcp-Run': RUN_ID, ...(method === 'POST' ? { 'X-Hub-Mcp-Nonce': crypto.randomUUID() } : {}) } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; let size = 0; res.on('data', c => { size += c.length; if (size > MAX_MESSAGE) { res.destroy(); reject(Error('MCP response exceeds the size limit')); } else chunks.push(c); });
      res.on('end', () => { let j; try { j = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)) || '{}'); } catch { return reject(Error('Hub response is invalid JSON or UTF-8')); } resolve({ status: res.statusCode, body: j }); });
    });
    rq.setTimeout(150000, () => rq.destroy(Error('Hub の返事が来ません')));
    rq.on('error', () => reject(Object.assign(Error(`Project Hub（127.0.0.1:${PORT}）につながりません。Hub を起動してください`), { down: true })));
    if (data) rq.write(data); rq.end();
  }));
}

const send = msg => {const encoded=JSON.stringify(msg);process.stdout.write((Buffer.byteLength(encoded)<=MAX_MESSAGE?encoded:JSON.stringify({jsonrpc:'2.0',id:msg.id??null,error:{code:-32603,message:'MCP response exceeds the size limit'}}))+'\n');};
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const error = (id, code, message, data) => send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && typeof msg === 'object' && !msg.method && ('result' in msg || 'error' in msg)) return undefined; // 相手からの返事（使わない）
    return error(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  const { id, method, params = {} } = msg;
  if (!('id' in msg)) return undefined; // notifications/initialized など：返事しない
  if (!(typeof id === 'string' && id.length <= 128) && !Number.isSafeInteger(id)) return error(null, -32600, 'Invalid Request');
  try {
    if (method === 'initialize') return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'project-hub', title: 'Project Hub', version: VERSION },
      instructions: 'Project Hub（作業の管理ソフト）の道具です。まず hub_get_task で作業を読み、終わったら hub_report で結果を書き戻し、人の判断が要る時は hub_ask_owner で質問してください。' });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      let r;
      // Hub が止まっている時は、読む・報告する道具だけを見せる（呼ぶと「Hub を起動して」と返る）
      try { r = await hub('GET', '/api/mcp/tools'); } catch { log('Hub capability request failed'); if (process.platform === 'win32' || TOKEN || RUN_ID) return error(id, -32603, 'Hub MCP capability is unavailable'); return reply(id, { tools: require('./lib/chatgpt').TOOLS.filter(t => !t.work).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }); }
      if (r.status !== 200) return error(id, -32603, r.body.error || `Hub が断りました（${r.status}）`);
      return reply(id, { tools: r.body.tools });
    }
    if (method === 'tools/call') {
      // MCP reserves _meta (including progressToken) at the request level;
      // it is never forwarded as a tool argument or used as authorization.
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key)) || !validMeta(params._meta) || typeof params.name !== 'string' || params.name.length > 128) return error(id, -32602, 'name がありません');
      if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) return error(id, -32602, 'arguments はオブジェクトにしてください');
      let r;
      try { r = await hub('POST', '/api/mcp/call', { name: params.name, arguments: params.arguments || {} }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: e.message }], isError: true }); }
      if (r.body.unknown) return error(id, -32602, `Unknown tool: ${params.name}`);
      if (r.status !== 200) {
        if(r.body.partial===true||r.body.created===true||r.body.recoveryRequired===true){const partial={ok:false,status:r.status,error:r.body.error||'Operation did not fully complete',partial:r.body.partial===true,created:r.body.created===true,...(r.body.overwritten===true?{overwritten:true}:{}),...(r.body.recoveryRequired===true?{recoveryRequired:true}:{}),...(/^[a-f0-9]{32}$/.test(r.body.recordId||'')?{recordId:r.body.recordId}:{})};return reply(id,{content:[{type:'text',text:JSON.stringify(partial)}],structuredContent:partial,isError:true});}
        return reply(id, { content: [{ type: 'text', text: r.body.error || `失敗しました（${r.status}）` }], isError: true });
      }
      return reply(id, { content: [{ type: 'text', text: String(r.body.text ?? '') }] });
    }
    return error(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    log('MCP request failed');
    return error(id, -32603, 'MCP request failed');
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf,chunk]);
  if (buf.length > MAX_MESSAGE && !buf.includes(10)) { error(null, -32600, 'Request exceeds size limit'); log('MCP input exceeded limit'); process.exit(1); }
  let i;
  while ((i = buf.indexOf(10)) >= 0) {
    const raw = buf.subarray(0, i); buf = buf.subarray(i + 1);
    if (raw.length > MAX_MESSAGE) { error(null, -32600, 'Request exceeds size limit'); continue; }
    let line;try{line=new TextDecoder('utf-8',{fatal:true}).decode(raw).trim();}catch{error(null,-32700,'Invalid UTF-8');continue;}
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { error(null, -32700, 'Parse error'); continue; }
    handle(msg);
  }
  if(buf.length>MAX_MESSAGE){error(null,-32600,'Request exceeds size limit');log('MCP input exceeded limit');process.exit(1);}
});
log(`起動しました（Hub: 127.0.0.1:${PORT}）`);
