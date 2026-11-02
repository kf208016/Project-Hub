'use strict';
const messages=Object.freeze({
  GROK_LOGIN_HYDRATE_FAILED:'Hub 無法在回合前把 Grok 登入交給沙箱（灌入失敗），這則訊息沒有送出。請按「更新 Grok 登入」，若還是不行請按「登入 Grok」，完成後再送一次。',
  GROK_LOGIN_AUTO_REFRESH_FAILED:'Grok 登入即將到期或已過期，Hub 剛才自動更新沒有成功，這則訊息沒有送出。請按「更新 Grok 登入」再試一次；如果還是不行，請按「登入 Grok」重新登入，完成後再送一次。',
  GROK_LOGIN_AUTO_REFRESH_UNCHANGED:'Grok 登入已過期，而且 Hub 自動更新時 Grok 沒有取得新的登入（更新用的憑證可能已失效），這則訊息沒有送出。請按「登入 Grok」（會開瀏覽器）或「用裝置碼登入」重新登入，完成後再送一次。',
  GROK_LOGIN_AUTO_REFRESHING:'Hub 正在自動更新 Grok 登入（通常幾秒鐘）；請稍後再按一次。',
  GROK_LOGIN_EXPIRING:'Grok 登入即將到期，為避免回合做到一半中斷，這則訊息沒有送出。請按「更新 Grok 登入」（幾秒鐘、不需要瀏覽器），完成後再送一次。',
  GROK_LOGIN_EXPIRED:'Grok 登入已過期（登入檔超過約 6 小時沒有更新），這則訊息沒有送出。請按「更新 Grok 登入」，完成後再送一次。',
  GROK_LOGIN_MISSING:'找不到 Grok 登入檔，這則訊息沒有送出。請按「登入 Grok」，完成後再送一次。',
  GROK_LOGIN_WINDOW_OPEN:'Grok 登入視窗已經開著；請在那個視窗完成或關閉它。',
  GROK_LOGIN_TURN_ACTIVE:'Grok 正在執行回合；請等它結束或按［止める］後再更新登入。',
  GROK_LOGIN_UNAVAILABLE:'Hub 無法開啟 Grok 登入視窗（找不到已審核的 Grok 或路徑不安全）。請在一般終端機執行 grok login。',

  GROK_NATIVE_INCOMPLETE:'Grok 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。',
  CLAUDE_NATIVE_INCOMPLETE:'Claude 這一回合沒有正常結束（例如回覆被截斷、達到工具呼叫次數上限，或結束時仍有工具操作未完成）。可以請它接著做，或調整需求後再送一次。',
  GROK_NATIVE_CANCELLED:'Grok 這一回合已停止。',
  CLAUDE_NATIVE_CANCELLED:'Claude 這一回合已停止。',
  GROK_NATIVE_CLEANUP_UNVERIFIED:'Grok 結束後，Hub 無法確認它啟動的程式都已關閉，所以這一回合判為失敗。請確認沒有殘留的 Grok 程式後再送一次。',
  CLAUDE_NATIVE_CLEANUP_UNVERIFIED:'Claude 結束後，Hub 無法確認它啟動的程式都已關閉，所以這一回合判為失敗。請確認沒有殘留的 Claude 程式後再送一次。',
  GROK_NATIVE_EXIT_UNSUCCESSFUL:'Grok 程式異常結束，這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_EXIT_UNSUCCESSFUL:'Claude 程式異常結束，這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_NATIVE_INIT_TIMEOUT:'Grok 沒有在時限內完成啟動，這一回合已停止。請稍後再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_INIT_TIMEOUT:'Claude 沒有在時限內完成啟動，這一回合已停止。請稍後再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_NATIVE_INIT_FAILED:'Grok 啟動失敗，這一回合沒有開始。請先在一般終端機開啟 Grok 確認可以使用，再送一次。',
  CLAUDE_NATIVE_INIT_FAILED:'Claude 啟動失敗，這一回合沒有開始。請先在一般終端機開啟 Claude Code 確認可以使用，再送一次。',
  GROK_NATIVE_TRUNCATED_OUTPUT:'Grok 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_TRUNCATED_OUTPUT:'Claude 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_NATIVE_REMOTE_ERROR:'Grok 服務端回報錯誤，這一回合已停止。請稍後再試。',

  SESSION_SCOPE_CHANGED:'舊對話是在不同的登入、執行環境或工作區建立的，無法安全接續；已改開新對話，並附上先前的文字紀錄。',
  SESSION_BINDING_REQUIRED:'舊對話來自較早的版本，無法安全接續；已改開新對話，並附上先前的文字紀錄。',
  GROK_NATIVE_RESUME_UNAVAILABLE:'Grok 無法載入舊對話；下一則訊息會改開新對話，並附上先前的文字紀錄。',
  GROK_NATIVE_RESUME_FAILED:'Grok 無法載入舊對話；下一則訊息會改開新對話，並附上先前的文字紀錄。',
  CLAUDE_NATIVE_RESUME_FAILED:'Claude 無法載入舊對話；下一則訊息會改開新對話，並附上先前的文字紀錄。',
  WORKSPACE_RECORD_WRITE_FAILED:'工作區紀錄暫時無法寫入（常見原因是防毒軟體正在掃描）；已自動重試仍失敗，請稍後再送一次。',
  GROK_NATIVE_AUTH_UNAVAILABLE:'Grok 回報登入無效或已過期，這一回合沒有完成。請按「更新 Grok 登入」（或在一般終端機執行 grok login），完成後再送一次。',
  GROK_NATIVE_RATE_LIMITED:'Grok 回報已達用量上限，請稍後再試，或確認方案額度。',
  GROK_NATIVE_RETRY_EXHAUSTED:'Grok 多次重試仍失敗，這一回合已停止。請稍後再試；若一再發生，請重新登入 Grok。',
  GROK_NATIVE_WALL_TIMEOUT:'Grok 這一回合已執行 30 分鐘，達到單回合上限，已自動停止。可以再送一則訊息請它接著做。',
  GROK_NATIVE_IDLE_TIMEOUT:'Grok 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，最常見的原因是登入已過期，請先在一般終端機開啟 Grok 確認登入。',
  CLAUDE_NATIVE_WALL_TIMEOUT:'Claude 這一回合已執行 30 分鐘，達到單回合上限，已自動停止。可以再送一則訊息請它接著做。',
  CLAUDE_NATIVE_IDLE_TIMEOUT:'Claude 超過 10 分鐘沒有任何進度，已自動停止。若一直沒有回應，請先在一般終端機開啟 Claude Code 確認登入。',
  GROK_NATIVE_MODEL_UNAVAILABLE:'這個 Grok 帳號目前不提供所選模型，請在模型選單改選。'
});
function messageFor(code,version){if(code==='GROK_STOPPED_AFTER_DECLINE')return 'Grok 在工具操作被 Hub 拒絕後，依它自己的設計停下了這一回合。要它接著做，可以再送一則訊息。';
if(code==='NATIVE_CODEX_VERSION_UNREVIEWED')return `Hub 使用的 Codex 版本未經審核（目前 ${typeof version==='string'&&version.length<=64&&/^\d+\.\d+\.\d+$/.test(version)?version:'未知'}）。請到「設定 → AI 的更新」安裝 Hub 專用的已審核版本（0.154.0 或 0.164.0）。`;
if(code==='NATIVE_GROK_VERSION_UNREVIEWED'){
  const detail=version&&typeof version==='object'?version:{},versions=require('./grok-versions').PREFERRED.join('、');
  const override=typeof detail.override==='string'&&detail.override.length>0&&detail.override.length<=64&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(detail.override)?detail.override:null;
  const hashPrefix=typeof detail.hashPrefix==='string'&&/^[0-9a-f]{12}$/.test(detail.hashPrefix)?detail.hashPrefix:null;
  if(override!==null)return `Hub 設定的 Grok 版本（PROJECT_HUB_GROK_VERSION=${override}）不在已審核清單（${versions}）；未啟動。請改回清單內的版本或移除此設定。（代碼：NATIVE_GROK_VERSION_UNREVIEWED）`;
  if(hashPrefix)return `Hub 找不到已審核的 Grok CLI（已審核版本：${versions}）。目前安裝的 grok.exe 雜湊 ${hashPrefix}… 尚未審核；請勿回滾，等待 Hub 更新納入新版本，並保留 ~/.grok/downloads 內的已審核發行檔。（代碼：NATIVE_GROK_VERSION_UNREVIEWED）`;
  return `Hub 找不到已審核的 Grok CLI（已審核版本：${versions}），而且讀不到目前安裝的 grok.exe。請在一般終端機確認 Grok 已安裝，或保留 ~/.grok/downloads 內的已審核發行檔。（代碼：NATIVE_GROK_VERSION_UNREVIEWED）`;
}
return typeof code==='string'&&Object.hasOwn(messages,code)?`${messages[code]}（代碼：${code}）`:null;}
function messageOrFallback(code,version){
  const message=messageFor(code,version);
  if(message!==null)return message;
  if(typeof code==='string'&&/^(GROK|CLAUDE)_NATIVE_[A-Z0-9_]{2,60}$/.test(code))return `${code.startsWith('GROK')?'Grok':'Claude'} 這一回合因 Hub 的安全檢查而停止。可以再送一次；若一再發生，請把代碼告訴維護者。（代碼：${code}）`;
  return null;
}
function toolDeclinedText(reason,title){
  const prefix={declined:'工具操作被 Hub 拒絕，已略過（沒有執行）：',expired:'工具操作等待核准逾時，已略過（沒有執行）：',cancelled:'工具操作已取消（沒有執行）：'};
  return prefix[reason]+title;
}
module.exports = { messageFor, messageOrFallback, toolDeclinedText };
