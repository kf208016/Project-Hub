'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {messageFor}=require('../lib/native-provider-messages'),{codeOf}=require('../lib/native-provider-diagnostic');
const expected={
  GROK_LOGIN_AUTO_REFRESH_UNCHANGED:'Grok 登入已過期，而且 Hub 自動更新時 Grok 沒有取得新的登入（更新用的憑證可能已失效），這則訊息沒有送出。請按「登入 Grok」（會開瀏覽器）或「用裝置碼登入」重新登入，完成後再送一次。',
  GROK_NATIVE_TRUNCATED_OUTPUT:'Grok 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Grok 確認可以使用。',
  CLAUDE_NATIVE_TRUNCATED_OUTPUT:'Claude 程式結束時，Hub 還沒有收完它的輸出（串流中斷或最後一行不完整），這一回合沒有完成。可以再送一次；若一再發生，請先在一般終端機開啟 Claude Code 確認可以使用。',
  GROK_LOGIN_AUTO_REFRESH_FAILED:'Grok 登入即將到期或已過期，Hub 剛才自動更新沒有成功，這則訊息沒有送出。請按「更新 Grok 登入」再試一次；如果還是不行，請按「登入 Grok」重新登入，完成後再送一次。',
};
for(const [code,text]of Object.entries(expected))test('R24 exact message and diagnostic '+code,()=>{
  assert.equal(messageFor(code),text+'（代碼：'+code+'）');assert.equal(codeOf({code}),code);
});
