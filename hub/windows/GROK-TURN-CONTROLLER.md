# Grok 有界單次回合控制器

`lib/providers/grok-turn-controller.js` 在既有離線 ACP codec 上提供真實 Node streams 的單回合傳輸、backpressure、人工單次核准、逾時與收尾狀態。它**不 spawn binary、不登入、不做 initialize/session new/load/model selection、不讀 auth、不呼叫模型、不提供 OS 隔離或 HTTP 核准**。Registry 仍為 `PROVIDER_ADAPTER_UNVERIFIED`，沒有新增任何 server/UI 執行入口。

舊 `chat.buildTurn` planner 先用 registry 驗證 canonical CLI actor；`claude-code` 使用 Claude 的規劃分支，未知／網頁 actor 明確拒絕。Grok 尚未接入此 planner，即使提供自訂 `perm` 或 `noEffort`，仍回 `409 PROVIDER_ADAPTER_UNVERIFIED`、`notStarted:true`，不產生 Codex argv。這個 guard 不變更既有 Codex／Claude／Agy defaults、registry readiness 或 public Schema，也不代表新 turn controller 已接入 Hub。

## 可信上層契約

上層執行 backend 必須先完成版本／binary 身分、provider/task/run/model permit、設定／登入與 whole-process 隔離 admission，然後提供已驗證 session 的**專用、不可共用** endpoint。沒有這個 backend，本模組沒有啟動 CLI 的方法；不能以 full-user child 取代 admission。

```javascript
const {createTurnController}=require('./lib/providers/grok-turn-controller');
const turn=createTurnController({
  sessionId, runId, promptRequestId, prompt,
  ownerAuthority, backendAuthority,
  endpoint:{backendId,stdin,stdout,stderr,requestStop},
  onEvent, // 同步、有界且回傳 undefined 的可信內部 callback；內容仍為不可信資料
});
turn.start();
const finalState=await turn.completion;
```

以上 identifiers、streams、callback 與兩個不同的 opaque authority object 由可信呼叫端提供。它們不是 JSON credentials、OS 身分證明、browser authentication 或使用者核准；持有另一個新建 object 不會通過 `===` 檢查，但這項檢查也不能隔離同一 Node 程序內的惡意程式碼。尚未有產品 backend 建立此端點。

backend 必須獨占 endpoint，先完成 handshake 才交接；已由其他 reader 消耗的 bytes 無法復原。不要交付設定過文字 encoding 或仍有其他 data consumer 的 streams。stdin 為空閒 Writable，不得含 buffered bytes、cork 或尚待 drain 的 backpressure；stdout/stderr 為不同 Readable，接受 raw Buffer。

所有 constructor 驗證成功後、註冊 listener 前，本模組以 WeakSet claim 三個 streams；即使尚未 `start()`，另一個 Grok controller 也不能以不同 read streams 重用同一 stdin。驗證失敗不會預佔健康 streams。此檢查只涵蓋本模組 controller 的同程序 object ownership，不是 OS 身分、browser authentication、所有 provider 共用的鎖，亦無法阻擋持有同一 stream reference 的其他惡意程式碼。backend 仍須獨占實際端點。完成後本控制器銷毀這三個專用 streams，不能用於另一回合。持續 ACP session／resume 需要未來 backend 的獨立設計，並非本模組已提供。

## 方法、訊息與順序

- `start()`：一次送出 `session/prompt`，僅一個原文 text block，不改寫 Unicode；`promptSHA256` 是原文 UTF-8 hash。格式依固定 ACP schema `0.11.4` 的 `agent.rs:2912–2940`；這不是 Windows Grok 1.0.34 的實機相容證據。
- `pending()`：回 codec 的 deep copies。必須讓 owner 檢視原工具／rawInput／選項與 digest；工具事件是自述，不能當 OS 核准或執行證明。
- `decide(ownerAuthority, decision)`：沿用 session/run/request/digest/confirm 綁定，只准原 request 的精確 `allow-once` 或 `reject-once`。MCP、模型文字及 RPC ID 不取得此權限。
- `cancel(ownerAuthority,{sessionId,runId,confirm:true})`：先撤回尚未交給 `stdin.write` 的所有 queued frames（包含先前決定的 allow），再依序排入 `session/cancel`、pending requests 的 cancelled responses，立即撤 pending 並要求 backend Stop。已交給 transport 的 current bytes 無法撤回；保留該 write 的計量與 backpressure。訊息可能因 Stop 或傳輸錯誤未送達；不把 queued bytes 當送達收據。
- `reportExit(backendAuthority,receipt)`：只接收同 backend/session/run 的**一次最終觀測**，包含 `rootExited:true`、`ownedTreeEmpty`、`cleanupVerified`、exitCode/signal。根程序退出不等於所有後代退出；false/unknown cleanup 不能後補覆蓋成本次成功。backend 仍負責獨立收尾／復原未知殘留。
- `snapshot()`／`completion`：固定結構，不包含原 prompt、authority、非法輸入、原生 exception message 或 vendor stderr 原文。`onEvent` 會收到 codec 的已驗 events、stderr-observed、pending-cleared、finished；stderr-observed 僅在 EOF 後提供累計 bytes，不保存或轉發 stderr 文字。本批沒有新增 private raw log。stdout 的文字／rawInput／metadata 仍是不可信且可能私有的資料，上層須採既有存取、展示與持久化邊界；本模組不聲稱將 CLI stdout 全文去識別。

`requestStop({backendId,sessionId,runId,reasonCode})` 由 backend 執行真正 Stop。`GROK_TURN_TERMINAL` 是**正常終態後的 graceful EOF／有界等待**：控制器先在已排寫入完成後 end stdin，backend 不應立即 kill 正常程序。到期才按 admission 執行強制 Stop。非零 exit（例如 kill 後 125）或 signal 不會被當成正常 reply-complete。owner cancel／fatal error 可立即停止；JSON-RPC cancel 不是程序樹 Stop 證據。

stdout result 只結束所綁 prompt，之後多餘 bytes 仍拒絕。兩個 read streams 必須 EOF，且 backend 的 root/tree/cleanup 最終觀測全部為 true，控制器才可正常 finished。取消時可能因強制 Stop 收不到最後 cancelled RPC：僅允許 `GROK_EOF_INCOMPLETE` 成為明示 `cancelled`，仍要求完整 cleanup，`replyComplete:false`／`protocolTerminal:false`；破損 UTF-8／殘行／矛盾結果不能被取消掩蓋。

## 上限與終態

constructor `limits` 只可降低下列預設；未知欄位拒絕：

| 項目 | 預設上限 |
|---|---|
| 整回合 wall／無活動 idle | 15 分鐘／60 秒 |
| 單次 write/backpressure／Stop 等待 | 10 秒／5 秒 |
| 人工 permission TTL | 10 分鐘，另受整回合 wall 上限 |
| 原文 prompt／stderr | 各 64 KiB |
| 排隊＋in-flight outbound | 1 MiB／32 frames |

原文 prompt 與 JSON escape 後完整 wire frame 皆檢查；frame 最多 256 KiB，包含本控制器送出的 LF。stdout 的 8 MiB、frame/event/JSON/文字工作量與 strict UTF-8 邊界沿用 codec。idle 在等待人工 permission 期間不計，但 wall 與 permission 雙時鐘 TTL 持續生效。stderr 是獨立 strict streaming UTF-8、拒 NUL、有 bytes cap，僅產生一次 bytes 觀測；stderr 活動不延長 idle。寫入一律依序等待 callback 及 backpressure drain，不允許無界 queue。

這些是 Node 控制器限制，不是 CLI 的 OS CPU／磁碟／網路／費用硬限制。注入的 clocks/scheduler 只供可信測試；真實 backend 還須有獨立 watchdog，不能依靠 JavaScript 在 blocked event loop 中即時執行。

`phase` 為 created/running/stopping/finished；`completionKind` 為 reply-complete/incomplete/cancelled/failed/cleanup-unknown。`replyComplete` 是 codec 的協定事實，即使後續 cleanup unknown 也可能為 true；不能單獨用它判斷作業成功。**所有狀態 `taskSuccess:null`**。Stop deadline 到期仍未取得最終 cleanup 事實，回 cleanup-unknown；不宣稱程序已退出，也不授權下一個 run。已 finished 的狀態不會被遲到 callback 或新 receipt 改寫。

Schema：`grok-turn-controller.schema.json` 明列 state、owner decision/cancel、backend receipt、prompt wire 與 callback event shape。Schema 不代替 runtime 的 state／digest／UTF-8 bytes／authority object 檢查，也不能驗證 receipt 的 OS 真實性。

## 驗證與剩餘工作

```powershell
node --test hub/test/provider-grok-turn-controller.test.js hub/test/provider-grok-protocol.test.js
```

測試使用明示 synthetic Node streams、fake clocks 及 fake backend receipts，覆蓋成功、backpressure／queue、wrong owner／scope／digest、未知與 persistent option、取消、EOF／額外 bytes、stderr 隱私、TTL／wall／idle／write／Stop 逾時及 cleanup 拒絕。另以獨立 test-only Schema keyword evaluator 比對實際訊息／事件／狀態與 closed Schema；這不是完整通用 JSON Schema validator。沒有執行 Grok 或模型，不能提升 provider readiness。

尚需安全 execution backend、精確 Windows binary/live ACP、initialize/auth/session/model、真正 browser owner 核准接線、queue/resume/PTY/transcript/usage/MCP、artifact reviewed merge 與安裝驗收。現有 OS 邊界與帳號政策仍須個別實測，不能以新增 controller 當作已完成整合。
