# Claude 有界 turn controller

本元件接續已核准協定計畫，只組合既有 `claude-protocol.js` 與可信 backend 提供的專用 Node streams。它不建立程序、不讀 profile／登入、不連模型／網路、不產生 HTTP 或 MCP 核准權限，也不改 registry readiness。合成測試不是本機 Claude 的實機相容或隔離驗收。

## 固定來源及 Claude 差異

官方 Python SDK 固定 commit `615d88b9baebfe155263fbdd2ca22cecc1da3430`，其 bundled CLI version 是 `2.1.252`。新增的 user envelope 依 [`client.py:248–269`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/client.py#L248)；原檔 SHA-256 為 `70740865b70711cdd6b9b06ef5553a6b0026f020aea5ed38a75bdf9d547331ea`，25,157 bytes。輸出是 UTF-8 JSONL，保留原 prompt Unicode：

```json
{"type":"user","message":{"role":"user","content":"合成提問"},"parent_tool_use_id":null,"session_id":"synthetic-session"}
```

此格式沒有 ACP 的 `jsonrpc`、`session/prompt` 或 `promptRequestId`。run 與 prompt SHA 是 controller 的內部 binding，不另塞入 vendor wire。fixture 為 source-derived，沒有執行下載的 SDK／CLI 或 live 模型。

Claude 官方 [`query.py:684–686`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/_internal/query.py#L684) 的 interrupt 是另一個 control request；需對應 control_response 狀態，而既有 closed codec 不支援該握手。本 controller 不送 Grok `session/cancel`、不虛構 Claude interrupt acknowledgement。owner cancel 直接撤回本 controller 的決定入口與未送出的 queue，再要求 backend Stop 精確 owned run。

## 可信 backend 契約

上層必須先完成精確 version／model／session／binary／profile、provider/task/run permit 與 whole-process 隔離 admission，以及所需的 SDK initialize control 握手。**本 controller 沒有實作或 live 驗證 initialize、登入與模型核對。** backend 交接時不能吞掉本 turn 的 `system/init`；codec 仍要求第一個入站事件是與 constructor 預綁 session 完全相同的 init。缺失／跨 session／未知 control 會拒絕，沒有 init mode 或權限 fallback。

```javascript
const {createTurnController}=require('./lib/providers/claude-turn-controller');
const turn=createTurnController({
  sessionId,runId,prompt,ownerAuthority,backendAuthority,
  endpoint:{backendId,stdin,stdout,stderr,requestStop},
  onEvent,
});
turn.start();
const state=await turn.completion;
```

兩個 authority 必須是不同的 opaque object，分別由可信 owner 路由與 execution backend 保管；這是同程序 reference capability，不是 browser session、OS 身分或使用者已核准的證明。沒有產品 backend 時不能拿 full-user child 代替 admission。

stdin 是空閒 Writable；stdout／stderr 是不同且未設 encoding、未被消費的 raw Readable。三者必須由此 controller 獨占，交接後不重用。constructor 以 WeakSet 拒絕另一個本模組 controller 重複持有相同 stream，也拒絕明顯已佔用的端點；但無法復原別人已讀走的 bytes，亦不能隔離同 Node 程序內的惡意程式碼。完成後會 destroy 專用 streams；持續 session／resume transport 尚待另外設計。

## 操作及收尾

- `start()` 一次送 user message；人工工具核准不會由 prompt 或 assistant `tool_use` 自動產生。
- `pending()` 回 codec 的深拷貝；`decide(ownerAuthority,{sessionId,runId,requestId,requestSHA256,decision:'allow'或'deny',confirm:true})` 保留完整原 request digest、owner 與期限 binding。allow 只送原 input，不能修改 input 或升成永久權限。
- `cancel(ownerAuthority,{sessionId,runId,confirm:true})` 撤 pending 展示／操作入口，丟棄尚未交給 `stdin.write` 的 frames，再要求 backend Stop。**已交給 transport 的 in-flight bytes 無法撤回**；不能把取消當作撤銷已送出的 allow。後續 vendor bytes 仍需通過 codec，破損 UTF-8／殘行／矛盾結果不能被取消掩蓋。僅取消後缺少 result 的 `CLAUDE_EOF_INCOMPLETE` 可明示為 cancelled。
- `reportExit(backendAuthority,receipt)` 只收一次同 backend/session/run 的最終觀測：`rootExited:true`、`ownedTreeEmpty`、`cleanupVerified`、`exitCode`、`signal`。false／unknown 不能靠後送收據覆蓋成本次成功；backend 仍須自行處理殘留與復原。
- `snapshot()`／`completion` 不含 prompt、authority、非法 payload、exception message 或原始 stderr。`onEvent` 僅允同步、有界且回傳 undefined；非同步／拋錯會明確失敗。它仍會收到 codec 已驗但不可信的 stdout 文字及工具 input，不是去識別輸出。

`requestStop({backendId,sessionId,runId,reasonCode})` 由 backend 執行真正 Stop。`CLAUDE_TURN_TERMINAL` 表示先等已排寫入、關閉 stdin 並有界等待自然退出；backend 不應立即 kill 正常結果。取消／fatal error 可立即停止。Stop 要求或 JSON result 都不是程序樹退出的證據。

兩個 Readable 必須 EOF，且 backend 的 root/tree/cleanup 全部已驗 true，才可能正常 finished。result 的 `isError` 或錯誤 subtype 為 failed；正常 process exit 加不完整／拒絕／截斷 result 為 incomplete。非零 exit／signal 不能成 reply-complete。所有狀態的 **`taskSuccess:null`**；不得依結果或事件自行 mark task complete、釋放 lease 或認定 artifact 已驗收。`completion` 是最終結果；事件在 callback／後續 transport 或 cleanup 失敗前均不是成功承諾。

## 上限與隱私

constructor 只可降低以下預設值，未知欄位拒絕：

| 項目 | 預設上限 |
|---|---|
| wall／idle | 15 分鐘／60 秒 |
| write／backpressure／Stop 等待 | 10 秒／5 秒 |
| permission TTL | 10 分鐘，另受 wall 限制 |
| 原文 prompt／stderr | 各 64 KiB |
| queued＋in-flight outbound | 1 MiB／32 frames |

escape 後 user frame 含 LF 最多 256 KiB；stdout 的 8 MiB／frame／JSON／文字限制沿既有 codec。寫入依序等待 callback 與必要 drain。等待人工決定時不計 idle，但 wall 與 permission 雙時計 TTL 不停止；stderr 不刷新 idle。stderr 用 strict streaming UTF-8 驗 NUL、殘字與 bytes cap，EOF 後只發一次 `{type:'stderr-observed',bytes}`，不保存／轉送文字。計數在 fatal 前觀測，不能當全程序 OS I/O 計量。

取消或錯誤後不能再核准；Stop 期限後仍無完整清理事實會 finished／cleanup-unknown，不能默認下次 run 可用。晚到 callbacks 或收據不能改寫 finished。這些是 Node 限制，不是 OS CPU／磁碟／網路／費用硬限制；blocked event loop 需要 backend 的獨立 watchdog。

## 驗證與限制

```powershell
node --test hub/test/provider-claude-turn-controller.test.js hub/test/provider-claude-protocol.test.js
```

測試只用合成 streams、fake clocks／scheduler 與 fake owned receipts；個案有時間上限。closed Schema 為 `claude-turn-controller.schema.json`，測試使用獨立 test-only keyword subset 比對真實 wire/events/states，不宣稱完整通用 Schema validator。Schema 無法驗 authority reference、實際人員核准、OS 收尾或 UTF-8 byte 數。

尚缺安全 execution backend、精確本機 binary/live stream、auth/model/init/session/resume、所有工具政策、browser approval、Hub queue/transcript/PTY、artifact reviewed merge 與安裝回復。既有 codec 的 callback 不涵蓋所有工具，這個 controller 同樣不能作完整工具攔截證明，也不解除 Windows Claude blocked。
