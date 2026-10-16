# Claude 離線 control／stream codec

本元件完成已核准多 provider 計畫 §12 的一部分：可重用的 **純記憶體協定解析、狀態與人工 permission response 編碼**。它不啟動程序、不讀取檔案／profile／auth、不連線、不呼叫模型、不修改 registry。Windows Claude 仍為 blocked。這不是完整 Claude adapter，也不是 OS 隔離、所有工具攔截或資安驗收證明。

## 來源與證據界線

官方來源固定為 `anthropics/claude-agent-sdk-python` commit **`615d88b9baebfe155263fbdd2ca22cecc1da3430`**。此 commit 的 [`_cli_version.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/_cli_version.py#L1) 記載 bundled CLI `2.1.252`。

- [`_internal/query.py:469–596`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/_internal/query.py#L469)：`can_use_tool`、`updatedInput`、deny 及 response envelope。
- [`types.py:2367–2466`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/types.py#L2367)：control request／response 欄位。
- [`_internal/message_parser.py:151–350`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/_internal/message_parser.py#L151)：assistant、result 與 stream envelope。
- [`query.py:340–345、582–584`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/_internal/query.py#L340)：cancel 後不再回應該 request。

下載時 SHA-256、路徑與來源行號列於 [`../test/fixtures/claude-protocol/source.json`](../test/fixtures/claude-protocol/source.json)。**fixtures 為 generated-from-contract，未執行 SDK 或本機 Claude 的 live stream/control 測試。** 原碼 pin 與 bundled version 相同，仍不能推導本機相容性。

SDK 的 nested `StreamEvent.event` 是一般 dictionary；以下 text/tool-use 狀態機是 Hub 自訂 closed subset，不是宣稱官方 SDK 已定義完整 nested JSON Schema。SDK parser 對未知 message 採略過；本元件刻意拒絕。

本次僅比較既有本機 CLI `output-format=json` 證據的 **key names**，未複製其回覆或用量到 repo。該證據含 `fast_mode_disabled_reason`、`fast_mode_state`、`queued_turn_count`、`subagent_stats`、`time_to_request_ms`、`ttft_ms`、`ttft_stream_ms` 等本 schema 未接受欄位。這些欄位出現會 fail closed；該 JSON 證據不是 stream golden，也不能據此宣稱 `2.1.252` 完整支援。

## 最小 API

```javascript
const {createProtocol}=require('../lib/providers/claude-protocol');
const ownerAuthority=Object.freeze({}); // 只留在可信 controller，不交給 child/UI JSON。
const protocol=createProtocol({
  sessionId:'session-fixture', runId:'run-fixture', ownerAuthority,
  now:Date.now,
  monotonic:()=>Number(process.hrtime.bigint()/1000000n),
});
```

| 方法 | 語意 |
|---|---|
| `push(Buffer)` | 接收 UTF-8 JSONL bytes，允許跨 chunk 的 Unicode／CRLF；回傳本批已驗 normalized events。任一 frame 失敗則整批不回 events，session 永久 failed。只接受非空 Buffer。 |
| `pending()` | 檢查期限後回傳待核准 request 的深拷貝：session/run/request/tool/input/hash/expiry；修改它不會修改核准內容。 |
| `decide(ownerAuthority, decision)` | 只接受 constructor 注入的同一 object reference。decision 精確為 `{sessionId,runId,requestId,requestSHA256,decision:'allow'或'deny',confirm:true}`；回傳帶 LF 的 `control_response` Buffer，不自行寫 transport。 |
| `tick()` | 顯式檢查 wall／monotonic 時鐘與 pending TTL；到期（含恰好截止）或時間倒退立即 failed 並清空 pending。 |
| `end()` | EOF 時必須沒有殘行／未關閉 stream／待核准，且已收到 terminal result；回傳 `{terminal,ok,responseComplete,...}`。錯誤或不完整 result 的 `ok/responseComplete` 保持 false。第二次 end 拒絕。 |
| `state()` | 回傳 phase、scope、計量與固定 errorCode；不授權、不讀時鐘、不包含 authority 或非法 payload。 |

`ownerAuthority` **只是同程序內部 capability，不是 browser authentication**。可信 controller 必須先完成既有 browser session、Origin／CSRF、作業與人員授權核對，才可呼叫 `decide()`；不能把模型文字、MCP token 或收到的 control_response 當人工核准。同程序惡意程式若持有 authority 不受本元件隔離。

codec 不建立 timer 或 microtask。controller 必須持續排程 `tick()`，並在 fatal 後停止 transport／owned run、清除 UI 舊 pending；`push/decide/pending/end` 也會先檢查 TTL。沒有新輸入且 controller 不 tick 時，不會自行發送 deny 或終止程序。

## 狀態與 binding

正常路徑為 `awaiting-init → active → result-success/result-error → ended`。任何 malformed／未知／過大／重放／過期／scope 不符會轉為永久 `failed`，清空 pending 與殘行，之後不能再 allow。錯誤只有固定 `CLAUDE_*` code/message，不附 raw payload、解析器錯誤、cause 或不可信欄位。

只接受預先綁定 session 的 `system/init`，不從 child 回報自動採用另一 session。system 的工具／模型／permissionMode 只是 child 自述，不能當外部隔離或 provider-ready 證明。init 中 bypass／acceptEdits／auto mode 不接受。

wire 的 `control_request` 本身沒有 session/run 欄位。`requestSHA256` 是下式的 UTF-8 SHA-256：

```text
canonical({sessionId, runId, request:完整已驗 control_request})
```

canonical 以 object key 的 JavaScript 字串排序遞迴序列化，array 保序，不正規化 Unicode，有限數字用 JSON 序列化。raw parser 先拒絕 duplicate key、孤立 surrogate、NUL、`__proto__/constructor/prototype`、非有限／超安全量級及會在 canonical decimal 表示中失真的數值；不同物件 key 順序不改 digest。不同 run／session／request／tool/input 或已顯示 metadata 均改 digest。

request ID 全 run 不重用；tool-use ID 不可被另一 request 重用。assistant 的 `tool_use` **只是描述，不是核准**。若已見該 tool 的內容，permission input／tool name 必須相同。stream 與 final assistant 若使用同一 message ID，model／content digest 必須相同；重複 snapshot／stream 重啟拒絕。

allow 僅回原 input 的 `updatedInput`；不接受修改 input、updatedPermissions、非空 permission suggestions 或自動 allow。deny 回 `{behavior:'deny',message:'Denied by Hub owner'}`。`control_cancel_request` 清除 pending，不能對該 ID 再回 allow 或 deny。

## 接受的 closed subset

- 入站：一次 `system/init`；`assistant` 的 text／tool_use blocks；`control_request/can_use_tool`；`control_cancel_request`；text/tool-input 的 `stream_event`；一次 `result`。
- `stream_event`：`message_start → (content_block_start → content_block_delta* → content_block_stop)* → message_delta → message_stop`。block index 必須由 0 連續；text 初值必須為空，tool input 初值為空 object；tool partial JSON 在 block stop 時再嚴格解析。
- 出站：人工決定後的 permission success response（其中 behavior 是 allow／deny）。入站 control_response 不作核准，也不提供 initialize handshake。
- 拒絕：未知 envelope／已知 envelope 的未知控制欄位、user echo/tool-result、thinking/redacted blocks、hook/MCP callback、subagent/parent-tool、background task、origin、deferred tool、structured output、其他 stream subtype。新增支援須同步 codec／schema／fixture／測試。
- tool input 與 usage/modelUsage 是明列的 bounded JSON payload dictionaries，不解讀為權限；它們可含 vendor keys，但仍受保留 key、Unicode、數值、深度與節點限制。其他 control/message envelopes 封閉。

`result.subtype === 'success'` 不足以成功。`is_error:true`、非 success subtype、abort/未知 terminal reason、非空 errors／permission_denials、owner deny／cancel，皆為 `ok:false`。assistant／stream／result 的 stop reason 持續保存；`max_tokens/refusal/stop_sequence/pause_turn/未知字串` 任一曾出現均使回覆不完整，後續 `end_turn` 不抹除該證據。`tool_use` 是容許的中途停止，若後續沒有正常 `end_turn` 便不能標完整。HTTP error status 與 `is_error:false` 矛盾會拒絕；`api_error_status:null` 明確接受。仍有 pending/open stream 時 result 拒絕。

normalized result 保留 `stopReasons`、`lastStopReason`、`permissionDenied`、provider `permissionDenials` 數量、`permissionCanceled` 與固定 `incompleteReasons`。`terminal:true` 僅表示已收到協定 result；`responseComplete/ok:true` 需要 result success、無上述錯誤／拒絕／取消／截斷標記，以及沒有未完成 stream／核准。這仍不是作業目標已完成的證明；作業完成與 artifact 驗收須由上層另判。

**result 只代表此 subset 的 turn 終態，不代表 process-tree exited、Stop、秘密清理、成果保存或 lease 已釋放。** SDK 可在 result 後仍有背景任務；本 subset 不支援這些任務，不可用來跳過上層生命週期驗證。

`responseComplete` 只表示已觀測的回覆終態沒有拒絕／截斷等不完整標記；不證明每個描述性 `tool_use` 都出現 ask callback，也不證明工具已執行或已獲人工核准。allow rules 可能略過 callback，完整 adapter 仍須另驗工具政策及路由。result 後額外 frame／bytes 一律使本次解析 failed；同一 push 不會先發布成功再忽略尾端錯誤。顯式提供非 function 的時鐘參數會拒絕，不靜默改用預設時鐘。

## 邊界

| 上限 | 預設；constructor 只可調低 |
|---|---|
| 單 frame（不含 CRLF）／總 run bytes | 256 KiB／8 MiB |
| frame 數／每次 push 回傳 event 數 | 4096／256 |
| 同時 pending／permission TTL | 16／10 分鐘 |
| 單字串／累計回覆文字 bytes | 128 KiB／2 MiB |
| JSON 深度／節點 | 16／16384 |

累計回覆文字計入每份 assistant snapshot 的 text、每個 text delta 及 result text；同內容在 stream、snapshot、result 重複傳送亦重複計量，這是傳入文字限制，不是 token 或唯一字數統計。非空 stream block 初始 text 直接拒絕。tool input 另受 frame／字串／節點／總 run 限制。CRLF 多出的 CR 僅為 delimiter；剛好達上限且在 CR/LF 之間切 chunk 仍接受。

這些上限限制單一 codec 的記憶體與工作量，不限制 CLI 的程序、磁碟、網路或供應商內部重試／帳單。

## 不可由此推導的能力

官方 [`types.py:2110–2125`](https://github.com/anthropics/claude-agent-sdk-python/blob/615d88b9baebfe155263fbdd2ca22cecc1da3430/src/claude_agent_sdk/types.py#L2110) 明載：`can_use_tool` 只處理 permission rules 落入 ask 的呼叫；allowed_tools、acceptEdits／bypassPermissions、settings allow 及 PreToolUse allow 均可能略過 callback。**本 codec 不是所有工具必經的攔截證明。**

未交付的部分包括 CLI spawn／handshake／user input、精確 live protocol相容性、登入 profile、whole-process 檔案／網路隔離、真工具與核准 UI、session/resume transport、PTY、模型核對、Stop／cleanup／artifact、安裝與回復。不能只因本組離線測試通過而解開 Windows Claude blocked。

## 驗證

```powershell
# cwd: hub
node --test test/provider-claude-protocol.test.js
```

測試只讀本地合成 fixtures，沒有 spawn、CLI、模型、profile、auth 或網路。涵蓋原 input allow／deny、owner identity、取消／TTL／重放、cross-session/run、raw parsing、字節邊界、stream binding、錯誤 result、EOF、schema 與重要上限。完整專案回歸和 live CLI／產品驗收另列，不能由這組測試替代。
