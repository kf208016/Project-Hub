'use strict';
// Grok implementation, reviewed and integrated by Codex. Reading never repairs files.
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const sessionBinding = require('./provider-session-binding');

function fail(code, status, message) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.notStarted = true;
  return err;
}

function load(file, code, message) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw fail(code, 503, message);
  }
}

function decode(buf, code, message) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    // A BOM is not an empty history row; do not hide it as whitespace.
    if (text.startsWith('\ufeff')) throw Error();
    return text;
  } catch {
    throw fail(code, 409, message);
  }
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function goodStr(v, nonempty) {
  return typeof v === 'string' && (!nonempty || v.length > 0) && !v.includes('\0') && v.isWellFormed();
}

function readHistory(file) {
  const io = '讀取對話歷史失敗，工作尚未開始。';
  const bad = '對話歷史格式無效，工作尚未開始。';
  const buf = load(file, 'CHAT_HISTORY_READ_FAILED', io);
  if (buf === null || buf.length === 0) return [];
  const text = decode(buf, 'CHAT_HISTORY_CORRUPT', bad);
  const rows = [];
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (/^\s*$/.test(line)) {
      if (line.includes('\ufeff')) throw fail('CHAT_HISTORY_CORRUPT', 409, bad);
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw fail('CHAT_HISTORY_CORRUPT', 409, bad);
    }
    if (!isObj(row)) throw fail('CHAT_HISTORY_CORRUPT', 409, bad);
    rows.push(row);
  }
  return rows;
}

function readMeta(file) {
  const io = '讀取工作階段資料失敗，工作尚未開始。';
  const bad = '工作階段資料格式無效，工作尚未開始。';
  const buf = load(file, 'CHAT_META_READ_FAILED', io);
  if (buf === null) return { sessions: {}, models: {} };
  const text = decode(buf, 'CHAT_META_CORRUPT', bad);
  if (/^\s*$/.test(text)) throw fail('CHAT_META_CORRUPT', 409, bad);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail('CHAT_META_CORRUPT', 409, bad);
  }
  if (!isObj(data)) throw fail('CHAT_META_CORRUPT', 409, bad);
  const own = Object.prototype.hasOwnProperty;
  if (own.call(data, 'sessions')) {
    const sessions = data.sessions;
    if (!isObj(sessions) || !Object.keys(sessions).every((k) => goodStr(sessions[k], true))) {
      throw fail('CHAT_META_CORRUPT', 409, bad);
    }
  }
  if (own.call(data, 'models')) {
    const models = data.models;
    if (!isObj(models) || !Object.keys(models).every((k) => goodStr(models[k], false))) {
      throw fail('CHAT_META_CORRUPT', 409, bad);
    }
  }
  if (own.call(data, 'providerBindings')) {
    try { sessionBinding.validate(data); }
    catch { throw fail('CHAT_META_CORRUPT', 409, bad); }
  }
  return data;
}

function readQueue(file) {
  const io = '讀取待辦指示失敗，工作尚未開始。';
  const bad = '待辦指示格式無效，工作尚未開始。';
  const buf = load(file, 'CHAT_QUEUE_READ_FAILED', io);
  if (buf === null) return [];
  const text = decode(buf, 'CHAT_QUEUE_CORRUPT', bad);
  let data;
  try { data = JSON.parse(text); }
  catch { throw fail('CHAT_QUEUE_CORRUPT', 409, bad); }
  if (!Array.isArray(data) || !data.every(isObj)) throw fail('CHAT_QUEUE_CORRUPT', 409, bad);
  return data;
}

module.exports = { readHistory, readMeta, readQueue };
