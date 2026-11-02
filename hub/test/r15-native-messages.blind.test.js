'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// R15 / M1 blind acceptance: readable native stop messages and messageOrFallback.
const NEW_TEXTS = Object.freeze({
  GROK_NATIVE_INCOMPLETE: 'Grok 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。',
  CLAUDE_NATIVE_INCOMPLETE: 'Claude 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。',
  GROK_NATIVE_CANCELLED: 'Grok 這一回合已停止。',
  CLAUDE_NATIVE_CANCELLED: 'Claude 這一回合已停止。',
  GROK_NATIVE_CLEANUP_UNVERIFIED: 'Grok 結束後，Hub 無法確認它啟動的程式都已關閉，所以這一回合判為失敗。請確認沒有殘留的 Grok 程式後再送一次。',
  CLAUDE_NATIVE_CLEANUP_UNVERIFIED: 'Claude 結束後，Hub 無法確認它啟動的程式都已關閉，所以這一回合判為失敗。請確認沒有殘留的 Claude 程式後再送一次。',
  GROK_NATIVE_EXIT_UNSUCCESSFUL: 'Grok 程式異常結束，這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_EXIT_UNSUCCESSFUL: 'Claude 程式異常結束，這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_NATIVE_INIT_TIMEOUT: 'Grok 沒有在時限內完成啟動，這一回合已停止。請稍後再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_INIT_TIMEOUT: 'Claude 沒有在時限內完成啟動，這一回合已停止。請稍後再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_NATIVE_INIT_FAILED: 'Grok 啟動失敗，這一回合沒有開始。請先在一般終端機開啟 Grok 確認可以使用，再送一次。',
  CLAUDE_NATIVE_INIT_FAILED: 'Claude 啟動失敗，這一回合沒有開始。請先在一般終端機開啟 Claude Code 確認可以使用，再送一次。',
  GROK_NATIVE_TRUNCATED_OUTPUT: 'Grok 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_TRUNCATED_OUTPUT: 'Claude 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_NATIVE_REMOTE_ERROR: 'Grok 服務端回報錯誤，這一回合已停止。請稍後再試。'
});
// Exact text of three existing entries in candidate 16 (must stay unchanged).
const EXISTING = Object.freeze({
  GROK_NATIVE_RATE_LIMITED: 'Grok 回報已達用量上限，請稍後再試，或確認方案額度。',
  GROK_NATIVE_IDLE_TIMEOUT: 'Grok 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，最常見的原因是登入已過期，請先在一般終端機開啟 Grok 確認登入。',
  WORKSPACE_RECORD_WRITE_FAILED: '工作區紀錄暫時無法寫入（常見原因是防毒軟體正在掃描）；已自動重試仍失敗，請稍後再送一次。'
});
const CODEX_UNREVIEWED_0154 = 'Hub 使用的 Codex 版本未經審核（目前 0.154.0）。請到「設定 → AI 的更新」安裝 Hub 專用的已審核版本（0.154.0 或 0.164.0）。';
const GROK_FALLBACK = code => 'Grok 這一回合因 Hub 的安全檢查而停止。可以再送一次；若一再發生，請把代碼告訴維護者。（代碼：' + code + '）';
const CLAUDE_FALLBACK = code => 'Claude 這一回合因 Hub 的安全檢查而停止。可以再送一次；若一再發生，請把代碼告訴維護者。（代碼：' + code + '）';

function api() { return require('../lib/native-provider-messages'); }
function messageFor(code, version) { return api().messageFor(code, version); }
function messageOrFallback(code, version) {
  assert.equal(typeof api().messageOrFallback, 'function');
  return api().messageOrFallback(code, version);
}
function failed(ai, message, type = 'turn.failed') {
  const { parse } = require('../lib/chat');
  const events = parse(ai, type === 'turn.failed' ? { type, error: { message } } : { type, message });
  const done = events.filter(e => e.kind === 'done');
  assert.equal(done.length, 1);
  return done[0];
}

test('M1 the module exports exactly messageFor and messageOrFallback', () => {
  // R16 adds toolDeclinedText (SPEC-R16 T3); the two R15 exports are unchanged.
  assert.deepEqual(Object.keys(api()).sort(), ['messageFor', 'messageOrFallback', 'toolDeclinedText']);
  assert.equal(typeof api().messageFor, 'function');
  assert.equal(typeof api().messageOrFallback, 'function');
});

test('M1 the table under test has the fifteen new codes', () => {
  assert.equal(Object.keys(NEW_TEXTS).length, 15);
});

for (const [code, text] of Object.entries(NEW_TEXTS)) {
  test(`M1 messageFor(${code}) is the spec sentence plus the code suffix`, () => {
    assert.equal(messageFor(code), `${text}（代碼：${code}）`);
  });
}

test('M1 existing entries keep their exact text', () => {
  for (const [code, text] of Object.entries(EXISTING)) assert.equal(messageFor(code), `${text}（代碼：${code}）`, code);
  assert.equal(messageFor('NATIVE_CODEX_VERSION_UNREVIEWED', '0.154.0'), CODEX_UNREVIEWED_0154);
});

test('M1 messageFor still returns null for codes it does not know', () => {
  for (const value of ['GROK_NATIVE_PROTOCOL', 'CLAUDE_NATIVE_PROTOCOL', 'GROK_NATIVE_SYNTHETIC_R15', 'CLAUDE_NATIVE_SESSION_MISMATCH', 'NOT_A_NATIVE_CODE', 'PROCWATCH_STALE', '', 'grok_native_incomplete', 'toString', '__proto__', 'hasOwnProperty', undefined, null, 42]) {
    assert.equal(messageFor(value), null, String(value));
  }
});

test('M1 messageOrFallback returns messageFor for every known code, native or not', () => {
  for (const code of [...Object.keys(NEW_TEXTS), ...Object.keys(EXISTING), 'SESSION_SCOPE_CHANGED', 'GROK_NATIVE_MODEL_UNAVAILABLE', 'CLAUDE_NATIVE_WALL_TIMEOUT']) {
    const known = messageFor(code);
    assert.equal(typeof known, 'string', code);
    assert.equal(messageOrFallback(code), known, code);
  }
  assert.equal(messageOrFallback('GROK_NATIVE_INCOMPLETE'), `${NEW_TEXTS.GROK_NATIVE_INCOMPLETE}（代碼：GROK_NATIVE_INCOMPLETE）`);
});

test('M1 messageOrFallback passes the version through to messageFor', () => {
  assert.equal(messageOrFallback('NATIVE_CODEX_VERSION_UNREVIEWED', '0.154.0'), CODEX_UNREVIEWED_0154);
  const detail = { override: '9.9.9' };
  assert.equal(messageOrFallback('NATIVE_GROK_VERSION_UNREVIEWED', detail), messageFor('NATIVE_GROK_VERSION_UNREVIEWED', detail));
  assert.match(messageOrFallback('NATIVE_GROK_VERSION_UNREVIEWED', detail), /PROJECT_HUB_GROK_VERSION=9\.9\.9/);
});

test('M1 an unknown GROK_NATIVE_* code gets the Grok fallback sentence with the code', () => {
  for (const code of ['GROK_NATIVE_PROTOCOL', 'GROK_NATIVE_SYNTHETIC_R15', 'GROK_NATIVE_AB', 'GROK_NATIVE_A1_2', 'GROK_NATIVE_' + 'Z'.repeat(60)]) {
    assert.equal(messageOrFallback(code), GROK_FALLBACK(code), code);
  }
});

test('M1 an unknown CLAUDE_NATIVE_* code gets the Claude fallback sentence with the code', () => {
  for (const code of ['CLAUDE_NATIVE_PROTOCOL', 'CLAUDE_NATIVE_SESSION_MISMATCH', 'CLAUDE_NATIVE_9X', 'CLAUDE_NATIVE_' + '9'.repeat(60)]) {
    assert.equal(messageOrFallback(code), CLAUDE_FALLBACK(code), code);
  }
});

test('M1 messageOrFallback returns null for a non-native code it does not know', () => {
  for (const code of ['NOT_A_NATIVE_CODE', 'PROCWATCH_STALE', 'NATIVE_GROK_SOMETHING', 'XGROK_NATIVE_ABC', 'CODEX_NATIVE_INCOMPLETE', 'GROK_INCOMPLETE', 'NATIVE_PROVIDER_APPROVAL_REQUIRED']) {
    assert.equal(messageOrFallback(code), null, code);
  }
});

test('M1 messageOrFallback returns null for malformed input', () => {
  const malformed = [
    null, undefined, 42, 0, true, {}, '',
    'grok_native_incomplete', 'GROK_NATIVE_abc', 'Grok_NATIVE_ABC',
    'GROK_NATIVE_A', 'GROK_NATIVE_', 'GROK_NATIVE_' + 'A'.repeat(61), 'CLAUDE_NATIVE_' + 'A'.repeat(61),
    'GROK_NATIVE_ABC\n', ' GROK_NATIVE_ABC', 'GROK_NATIVE_ABC ', 'GROK_NATIVE_ABC-D', 'GROK_NATIVE_ＡＢＣ', 'GROK_NATIVE_ABC（代碼：X）'
  ];
  for (const value of malformed) assert.equal(messageOrFallback(value), null, JSON.stringify(value) ?? String(value));
});

test('M1 a turn.failed GROK_NATIVE_INCOMPLETE becomes the Chinese row error and keeps its code', () => {
  for (const ai of ['codex', 'grok']) {
    const done = failed(ai, 'GROK_NATIVE_INCOMPLETE');
    assert.equal(done.error, `${NEW_TEXTS.GROK_NATIVE_INCOMPLETE}（代碼：GROK_NATIVE_INCOMPLETE）`);
    assert.equal(done.code, 'GROK_NATIVE_INCOMPLETE');
  }
  const viaError = failed('codex', 'GROK_NATIVE_INCOMPLETE', 'error');
  assert.equal(viaError.error, `${NEW_TEXTS.GROK_NATIVE_INCOMPLETE}（代碼：GROK_NATIVE_INCOMPLETE）`);
  assert.equal(viaError.code, 'GROK_NATIVE_INCOMPLETE');
});

test('M1 native Claude codes on the normalized path render their text or the fallback, code kept', () => {
  const incomplete = failed('codex', 'CLAUDE_NATIVE_INCOMPLETE');
  assert.equal(incomplete.error, `${NEW_TEXTS.CLAUDE_NATIVE_INCOMPLETE}（代碼：CLAUDE_NATIVE_INCOMPLETE）`);
  assert.equal(incomplete.code, 'CLAUDE_NATIVE_INCOMPLETE');
  const unknown = failed('codex', 'CLAUDE_NATIVE_SESSION_MISMATCH');
  assert.equal(unknown.error, CLAUDE_FALLBACK('CLAUDE_NATIVE_SESSION_MISMATCH'));
  assert.equal(unknown.code, 'CLAUDE_NATIVE_SESSION_MISMATCH');
  const grokUnknown = failed('codex', 'GROK_NATIVE_PROTOCOL');
  assert.equal(grokUnknown.error, GROK_FALLBACK('GROK_NATIVE_PROTOCOL'));
  assert.equal(grokUnknown.code, 'GROK_NATIVE_PROTOCOL');
});

test('M1 non-native turn errors render as before', () => {
  const plain = failed('codex', 'PROCWATCH_STALE');
  assert.equal(plain.error, 'PROCWATCH_STALE');
  assert.equal(plain.code, 'PROCWATCH_STALE');
  const known = failed('codex', 'SESSION_SCOPE_CHANGED');
  assert.equal(known.error, messageFor('SESSION_SCOPE_CHANGED'));
  assert.equal(known.code, 'SESSION_SCOPE_CHANGED');
  const prose = failed('codex', 'ordinary failure');
  assert.equal(prose.error, 'ordinary failure');
  assert.equal(prose.code, undefined);
});
