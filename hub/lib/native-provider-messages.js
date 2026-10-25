'use strict';
const messages=Object.freeze({
  SESSION_SCOPE_CHANGED:'舊對話是在不同的登入、執行環境或工作區建立的，無法安全接續；已改開新對話，並附上先前的文字紀錄。',
  SESSION_BINDING_REQUIRED:'舊對話來自較早的版本，無法安全接續；已改開新對話，並附上先前的文字紀錄。',
  GROK_NATIVE_RESUME_UNAVAILABLE:'Grok 無法載入舊對話；下一則訊息會改開新對話，並附上先前的文字紀錄。',
  GROK_NATIVE_RESUME_FAILED:'Grok 無法載入舊對話；下一則訊息會改開新對話，並附上先前的文字紀錄。',
  CLAUDE_NATIVE_RESUME_FAILED:'Claude 無法載入舊對話；下一則訊息會改開新對話，並附上先前的文字紀錄。',
  WORKSPACE_RECORD_WRITE_FAILED:'工作區紀錄暫時無法寫入（常見原因是防毒軟體正在掃描）；已自動重試仍失敗，請稍後再送一次。',
  GROK_NATIVE_AUTH_UNAVAILABLE:'Grok 的登入已過期或無法驗證，Hub 不會在沙箱內替你更新登入。請在一般終端機執行 grok 並完成登入（或開啟 Grok 一次），再重新送出。',
  GROK_NATIVE_RATE_LIMITED:'Grok 回報已達用量上限，請稍後再試，或確認方案額度。',
  GROK_NATIVE_RETRY_EXHAUSTED:'Grok 多次重試仍失敗，這一回合已停止。請稍後再試；若一再發生，請重新登入 Grok。',
  GROK_NATIVE_WALL_TIMEOUT:'Grok 這一回合已執行 30 分鐘，達到單回合上限，已自動停止。可以再送一則訊息請它接著做。',
  GROK_NATIVE_IDLE_TIMEOUT:'Grok 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，最常見的原因是登入已過期，請先在一般終端機開啟 Grok 確認登入。',
  CLAUDE_NATIVE_WALL_TIMEOUT:'Claude 這一回合已執行 30 分鐘，達到單回合上限，已自動停止。可以再送一則訊息請它接著做。',
  CLAUDE_NATIVE_IDLE_TIMEOUT:'Claude 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，請先在一般終端機開啟 Claude Code 確認登入。',
  GROK_NATIVE_MODEL_UNAVAILABLE:'這個 Grok 帳號目前不提供所選模型，請在模型選單改選。'
});
function messageFor(code,version){if(code==='NATIVE_CODEX_VERSION_UNREVIEWED')return `Hub 使用的 Codex 版本未經審核（目前 ${typeof version==='string'&&version.length<=64&&/^\d+\.\d+\.\d+$/.test(version)?version:'未知'}）。請到「設定 → AI 的更新」安裝 Hub 專用的已審核版本（0.154.0 或 0.164.0）。`;return typeof code==='string'&&Object.hasOwn(messages,code)?`${messages[code]}（代碼：${code}）`:null;}
module.exports={messageFor};
