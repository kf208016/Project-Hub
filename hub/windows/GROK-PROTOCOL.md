# Grok 離線 ACP turn codec

本元件是已核准多 provider 計畫 §12 的純記憶體協定切片。它可解析已綁定 prompt 的文字、描述性工具狀態、人工單次 permission response 及終態；不啟動 CLI、不讀 profile／auth、不呼叫模型或網路、不接 Hub 執行流程，也不改 Grok 的 blocked readiness。這不是完整 adapter 或隔離驗收。

## 固定來源與版本限制

官方 [開源公告](https://x.ai/news/grok-build-open-source)直接連結 `xai-org/grok-build`。本元件固定公開 commit **`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`**，其中 `SOURCE_REV` 是 monorepo revision `559751fdcec02d413e4c57c8832ab275e4f44980`。該 [Cargo.lock](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/Cargo.lock#L43) 固定 ACP `0.10.4`／schema `0.11.4`；schema archive 已按鎖檔 SHA-256 `ca68e7e55681ce56546c0cecc6bc8f20493d24b44c6d93ec46174f310730bba2` 核對，只讀原碼，沒有安裝或執行。

來源路徑／SHA／行號列於 [`source.json`](../test/fixtures/grok-protocol/source.json)。fixtures 為 **generated-from-source**。未找到公開 source revision 與 staged Grok **1.0.50 binary** 的可驗證對應；未執行任何 live ACP。固定原碼與 checksum 不是 binary 相容性、發行者簽章或外部 attestation。

主要合約：

- [`xai-acp-lib/message.rs:130–175、358–391`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/message.rs#L130)：ACP 方法的 request／response 對應。
- [`permission/prompter.rs:18–33、729–755、854–864`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/permission/prompter.rs#L18)：選項與實際 response 映射。**`enable-always-approve` 也可標成 `allow_once`**，因此不能只按 kind 自動選取。
- ACP schema `0.11.4` 的 [`client.rs:541–755`](https://docs.rs/agent-client-protocol-schema/0.11.4/src/agent_client_protocol_schema/client.rs.html#541-755)：permission、selected／cancelled outcome；`tool_call.rs:165–233` 是 partial update。
- [`acp_agent.rs:1057–1065、1114–1140`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L1057)：模型被封鎖／不可用時也可能回 `end_turn`。

## API 與責任

```javascript
const {createProtocol}=require('../lib/providers/grok-protocol');
const ownerAuthority=Object.freeze({});
const protocol=createProtocol({
  sessionId:'controller-bound-session', runId:'controller-bound-run',
  promptRequestId:17, ownerAuthority,
  now:Date.now, monotonic:()=>Number(process.hrtime.bigint()/1000000n),
});
```

`sessionId`／`runId`／`promptRequestId` 必須由可信 controller 在送 prompt 前綁定。本元件不從陌生回覆採用 session，也不負責 initialize／authenticate／session new/load、送 prompt 或模型核對。JSON-RPC ID 的數字與字串型別不同；只接受安全非負整數或有界 ASCII ID，這比 ACP 的完整型別更窄。

| 方法 | 語意 |
|---|---|
| `push(Buffer)` | 有界 UTF-8 JSONL；支援跨 chunk Unicode／CRLF。回已驗 events，批次中任一錯誤不發布本批 events，session 永久 failed、pending 清空。 |
| `pending()` | 回深拷貝，含完整 resolved tool call／選項、input SHA、request SHA、scope 及 expiry；修改不改核准原文。 |
| `decide(authority, decision)` | 精確 `{sessionId,runId,requestId,requestSHA256,optionId,confirm:true}`；authority 必須是 constructor 同一物件。只回 JSONL Buffer，不寫 transport。 |
| `cancel(authority, scope)` | 精確 `{sessionId,runId,confirm:true}`。回 Buffer 陣列：先 `session/cancel` notification，再回每個 pending request 的 `cancelled` outcome；controller 按序送出。取消後只接收有界的文字、既有工具更新及結果；建立新工具、permission 或再次 allow 皆拒絕。 |
| `tick()` | 顯式檢查雙時鐘及 pending TTL；任一到期／時鐘倒退即 failed。不建立 timer／microtask，不自行發 deny 或停止程序。 |
| `end()` | EOF 要無殘行、無 pending、已收到精確 prompt result；回終態。EOF 不代表程序樹退出／清理完成。 |
| `state()` | 計量／phase／scope／固定 errorCode，不含 authority 或 raw 非法 payload。 |

`ownerAuthority` 是同程序內部 capability，**不是 browser authentication**。上層仍須驗既有 browser session、Origin／CSRF、owner、task 與一次授權；MCP、模型文字及 child 自報不能當核准。fatal 後 controller 須撤 UI pending、停止 transport 與 owned run。`push/decide/cancel/pending/end` 也會先檢查 TTL。

## 單次 permission 綁定

只處理 `session/request_permission`，不替 child 執行任何 reverse RPC。request ID 不重用、同一 tool 只核准一次；無對應／跨 session／過期／未知 response／tool input 改變皆拒絕。permission 的 partial toolCall 只能與先前同 ID 的完整 tool 狀態合併；必須取得非空 title、object rawInput 及 pending status，缺少時 fail closed。已進行或終結的工具不能補發人工核准。

`inputSHA256` 是完整 resolved rawInput 的 canonical UTF-8 SHA-256。`requestSHA256` 綁：

```text
canonical({sessionId,runId,promptRequestId,request:完整原ACP request,resolvedToolCall})
```

canonical／raw JSON parser 沿用既有 Claude 元件，按 object key 排序、array 保序，不正規化 Unicode。重複 key、孤立 surrogate、NUL、保留 prototype keys、非有限／超安全精度數值、過深／過多節點拒絕。原選項名稱、metadata 或 rawInput 改變也會改 digest；pending 期間工具描述或輸入改變拒絕。

初始工具通知可以尚無 `rawInput`；第一次具體輸入可在 permission 前補齊，隨即固定。permission 一律綁定當時完整 resolved input，不能將欠缺輸入的通知視為已核准。決議或取消後，該工具的 title／kind／input／metadata 等已審閱識別欄位持續固定，只允許 status 與 rawOutput 更新；rawOutput 仍是未經驗證的工具自報資料。

例如既有 `tool-1` 完成人工決議後，可接受以下 `session/update.params.update`，但加入不同 `title`／`kind` 會永久拒絕；取消後若把 `sessionUpdate` 改為新建 `tool_call` 也會拒絕：

```json
{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","rawOutput":{"result":"synthetic"}}
```

可選項必須同時存在於**原 request**，且為精確 `allow-once`＋`allow_once` 或 `reject-once`＋`reject_once`。不接受任意新 option、`enable-always-approve`、persistent allow/reject 或修改 input。原 request 可包含其他 source-defined 選項以供檢視，但不授權選取。選中只產生原 option ID 的 response；不代表工具已執行、收到回覆或通過 OS 邊界。

工具通知是描述性自報，normalized `tool-state` 固定 `descriptiveOnly:true, approvalVerified:false`。看見 `completed` 不產生人工核准；`tool_call` 也不能證明每個工具都經 permission callback。

## 終態與 closed subset

- 接受 `agent_message_chunk` 的 text、`tool_call`／`tool_call_update` 的有界描述欄位、permission，以及所綁 prompt ID 的 JSON-RPC result/error。
- tool content／locations 目前只接受空陣列；不處理 tool rendered output、diff、embedded resources、圖片／reasoning、其他 session update subtype、未知控制欄位、fs／terminal／auth／extension reverse calls。合法 ACP 若超出此 subset 也會拒絕；新增支援須同步程式、Schema、fixtures 與測試。
- 明列的 `_meta`／rawOutput 為有界 JSON 資料，不解讀為控制權。RPC error 的 message/data 僅驗證、不回傳 raw 值，輸出固定 `GROK_REMOTE_ERROR` 與數字 rpcCode。
- `terminal:true` 僅代表所綁 prompt 有終態。`replyComplete:true` 僅指 `end_turn` 且未觀測拒絕／取消／工具失敗或未完成工具；模型不可用的文字亦可能符合，**不表示模型工作成功**。所有終態固定 `taskSuccess:null`，上層須另判目標、工具與 artifacts。
- `max_tokens/max_turn_requests/refusal/cancelled` 都是 incomplete；未知 stop reason 拒絕。owner cancel 後收到非 cancelled result 拒絕。result 有 pending permission、結果後額外 bytes 或 EOF 未完皆為錯誤。

## 上限與尚缺能力

| 上限 | 預設，constructor 只可調低 |
|---|---|
| frame（不含 CRLF）／總 run | 256 KiB／8 MiB |
| frame 數／每次 push events | 4096／256 |
| 同時 pending／TTL | 16／10 分鐘 |
| 單字串／累計 agent text bytes | 128 KiB／2 MiB |
| JSON 深度／節點 | 16／16384 |

這些是 codec bytes／記憶體工作量邊界，不是 CLI 程序、磁碟、網路、模型內部重試或帳單限制。Schema 只描述 wire shape，runtime 另外驗 Unicode／bytes、重複鍵、canonical 精度、狀態與跨 frame binding。

[`spawn.rs:829–835、3012–3026`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs#L829) 顯示未提供 client fs／terminal capability 會改用本機 backend，**不會停用 Grok 本體的檔案或命令能力**。同樣，[`initialize`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L130) 可能做設定、認證、同步與清理；不能把只 initialize 稱為無副作用離線探針。

尚缺執行隔離／出口／磁碟硬限制、provider 專用 auth／可信設定、精確 binary 與 live protocol、完整 transport／resume／PTY／模型、Hub 核准 UI／queue／transcript／artifacts／reviewed merge，以及套件安裝回復驗收。此元件不解除任何 readiness gate。

## 離線驗證

```powershell
# repo root；只讀合成 fixtures，無 provider、auth、模型或網路
node --test hub/test/provider-grok-protocol.test.js
```

完整回歸、Python discovery 與真實 CLI／安裝證據由整合批次另存，不由這組局部測試代替。
