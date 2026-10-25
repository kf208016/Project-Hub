'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {messageFor}=require('../lib/native-provider-messages'),{parse}=require('../lib/chat');
const table={
 GROK_NATIVE_AUTH_UNAVAILABLE:'Grok 的登入已過期或無法驗證，Hub 不會在沙箱內替你更新登入。請在一般終端機執行 grok 並完成登入（或開啟 Grok 一次），再重新送出。',
 GROK_NATIVE_RATE_LIMITED:'Grok 回報已達用量上限，請稍後再試，或確認方案額度。',
 GROK_NATIVE_RETRY_EXHAUSTED:'Grok 多次重試仍失敗，這一回合已停止。請稍後再試；若一再發生，請重新登入 Grok。',
 GROK_NATIVE_WALL_TIMEOUT:'Grok 這一回合已執行 30 分鐘，達到單回合上限，已自動停止。可以再送一則訊息請它接著做。',
 GROK_NATIVE_IDLE_TIMEOUT:'Grok 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，最常見的原因是登入已過期，請先在一般終端機開啟 Grok 確認登入。',
 CLAUDE_NATIVE_WALL_TIMEOUT:'Claude 這一回合已執行 30 分鐘，達到單回合上限，已自動停止。可以再送一則訊息請它接著做。',
 CLAUDE_NATIVE_IDLE_TIMEOUT:'Claude 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，請先在一般終端機開啟 Claude Code 確認登入。',
 GROK_NATIVE_MODEL_UNAVAILABLE:'這個 Grok 帳號目前不提供所選模型，請在模型選單改選。'
};
test('native provider codes have exact Traditional Chinese messages and unknown inputs stay null',()=>{
 for(const [code,text]of Object.entries(table))assert.equal(messageFor(code),`${text}（代碼：${code}）`);
 for(const value of ['UNKNOWN',null,{},42])assert.equal(messageFor(value),null);
});
test('chat completion replaces only exact known native error codes',()=>{
 for(const code of Object.keys(table))assert.equal(parse('grok',{type:'turn.failed',error:{message:code}})[0].error,messageFor(code));
 assert.equal(parse('grok',{type:'turn.failed',error:{message:'ordinary failure'}})[0].error,'ordinary failure');
});


test('fresh-session messages and parsed done codes are bounded and visible',()=>{
  for(const code of ['SESSION_SCOPE_CHANGED','SESSION_BINDING_REQUIRED','GROK_NATIVE_RESUME_UNAVAILABLE','GROK_NATIVE_RESUME_FAILED','CLAUDE_NATIVE_RESUME_FAILED','WORKSPACE_RECORD_WRITE_FAILED'])assert.ok(messageFor(code).endsWith(`（代碼：${code}）`));
  for(const code of ['GROK_NATIVE_RESUME_FAILED','SESSION_BINDING_REQUIRED','CLAUDE_NATIVE_SESSION_MISMATCH']){const done=parse('codex',{type:'turn.failed',error:{message:code}})[0];assert.equal(done.code,code);assert.equal(done.error,messageFor(code)||code);}
  for(const text of ['ordinary failure','BAD\nCODE','A','A'.repeat(65)])assert.equal(parse('codex',{type:'turn.failed',error:{message:text}})[0].code,undefined);
});

test('unreviewed Codex diagnostic provides the reviewed-slot repair path without private strings',()=>{
 assert.equal(messageFor('NATIVE_CODEX_VERSION_UNREVIEWED','0.165.0'),'Hub 使用的 Codex 版本未經審核（目前 0.165.0）。請到「設定 → AI 的更新」安裝 Hub 專用的已審核版本（0.154.0 或 0.164.0）。');
 assert.match(messageFor('NATIVE_CODEX_VERSION_UNREVIEWED','PRIVATE_SECRET'),/目前 未知/);
});
