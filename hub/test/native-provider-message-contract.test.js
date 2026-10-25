'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const TEXTS = Object.freeze({
  GROK_NATIVE_AUTH_UNAVAILABLE: 'Grok 的登入已過期或無法驗證，Hub 不會在沙箱內替你更新登入。請在一般終端機執行 grok 並完成登入（或開啟 Grok 一次），再重新送出。',
  GROK_NATIVE_RATE_LIMITED: 'Grok 回報已達用量上限，請稍後再試，或確認方案額度。',
  GROK_NATIVE_RETRY_EXHAUSTED: 'Grok 多次重試仍失敗，這一回合已停止。請稍後再試；若一再發生，請重新登入 Grok。',
  GROK_NATIVE_WALL_TIMEOUT: 'Grok 在 4 分鐘內沒有完成這一回合，已自動停止。若剛才一直沒有回應，最常見的原因是登入已過期，請先在一般終端機開啟 Grok 確認登入。',
  CLAUDE_NATIVE_WALL_TIMEOUT: 'Claude 在 4 分鐘內沒有完成這一回合，已自動停止。若剛才一直沒有回應，請先在一般終端機開啟 Claude Code 確認登入。',
  GROK_NATIVE_MODEL_UNAVAILABLE: '這個 Grok 帳號目前不提供所選模型，請在模型選單改選。',
});

function messageFor(code) {
  const mod = require('../lib/native-provider-messages');
  assert.equal(typeof mod.messageFor, 'function');
  return mod.messageFor(code);
}

for (const [code, text] of Object.entries(TEXTS)) {
  test(`messageFor(${code}) is the spec sentence plus the code suffix`, () => {
    assert.equal(messageFor(code), `${text}（代碼：${code}）`);
  });
}

test('messageFor returns null for unknown codes and arbitrary text', () => {
  for (const value of ['', 'NOT_A_NATIVE_CODE', 'GROK_NATIVE_PROTOCOL', '請重新登入', 'Unauthorized (401)']) {
    assert.equal(messageFor(value), null);
  }
});
