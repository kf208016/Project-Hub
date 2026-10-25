# Chat／CLI 對話任務續接

本產品透過對話與 CLI 協作開發模組，不提供 computer use。完整用途與驗收見 [目前規格](../../docs/superpowers/specs/2026-10-18-chat-cli-task-continuity-design.md)。本頁的資料讀取修正已接入原碼；未因此啟用 Claude／Grok 或更新本機安裝版。

## 既有資料格式與讀取修正

每個 task 的歷史保存在 `.ai/chat/<task>.jsonl`，session／模型資訊在 `<task>.json`。沿用既有檔名；新增選填的本機 `providerBindings`，不遷移或重寫舊資料。request 格式保持不變；在 `/api/chat/send` 成功 response 新增選填 `freshSession: {code}`，說明本次改開新的原生 session。

以下為合成資料格式例；各 provider ID 互相獨立，不代表目前可執行：

```json
{
  "sessions": {"codex": "codex-session", "claude": "claude-session", "grok": "grok-session"},
  "models": {"codex": "原Codex模型", "claude": "原Claude模型", "grok": "原Grok模型"}
}
```

- 只有檔案不存在（ENOENT）時，才使用空歷史或新的空 sessions／models。
- 零 bytes／空白 JSONL 歷史可讀為空；已存在但空白的 session JSON 是格式錯誤。
- 歷史每個非空白行均須為合法 JSON object；其中一行破損、截斷或型別錯誤，整次讀取失敗，不靜默丟棄該行或傳出部分歷史。
- UTF-8 必須有效；不移除 BOM 或以替代字元修復。有效歷史的 Unicode、重複但 request 不同的指示、既有事件物件皆保留。
- session JSON 必須為 object；既有欄位保留，缺省 sessions／models 不自動補入檔案。若這兩個 map 存在，值須為字串；session ID 不可為空，兩者皆不可含 NUL／孤立 surrogate。模型空字串保留舊格式相容性。
- 歷史錯誤回 `CHAT_HISTORY_CORRUPT`／409，session 錯誤回 `CHAT_META_CORRUPT`／409。其他檔案讀取失敗回對應 `*_READ_FAILED`／503；訊息不帶原始內容、檔名或 OS 錯誤。
- 待辦指示 .queue.json 僅在 ENOENT 時視為新空佇列；既有檔案必須是 UTF-8 JSON array，且每項為 object。格式錯誤回 CHAT_QUEUE_CORRUPT／409，其他讀取失敗回 CHAT_QUEUE_READ_FAILED／503；拒絕時不快取空值、不改寫原檔。有效項目欄位與順序原樣保留。
- 送出流程在讀到破損歷史／session 後停止，不新增本回合 user row 或啟動 CLI。原檔保持原樣，需核對原始備份與已接受的指示後恢復，不能以刪檔／新 session 掩蓋。

session metadata 寫入現採同目錄獨占暫存檔、fsync／close 與 rename；發布失敗保留原檔並拒絕送出原生 prompt。這不是跨程序交易、完整 row Schema、JSON duplicate-key 檢查或 exactly-once 保證；一般非 requireSave queue 寫入與跨程序持久性不在本次保證範圍。

## 原生 session 綁定

`lib/provider-session-binding.js` 由 Sonnet 產出，經本機審查修正。`validate`／`resolve`／`bind`／`retire` 只處理資料，沒有 IO、認證或啟動權限。`providerBindings` 一旦存在，metadata reader 必須驗證；不一致回 `CHAT_META_CORRUPT`，原檔保留。

每筆綁定包含 project、task、actor、runtimeProfileId、accountProfileId、rootFingerprint 與原生 session ID；Schema 見 `provider-session-binding.schema.json`。範例為合成資料：

```json
{
  "sessions": {"claude": "synthetic-session-1"},
  "providerBindings": {"claude": {
    "version": 1, "project": "example-project", "task": "example-task", "actor": "claude",
    "runtimeProfileId": "example-runtime-v1", "accountProfileId": "example-local-profile",
    "rootFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "providerSessionId": "synthetic-session-1"
  }}
}
```

綁定必須與 `sessions[actor]` 相等，各 actor 不共用同一原生 ID。範圍改變或舊 session 缺少綁定時，`resolve` 仍拒絕續接舊 ID。ChatRunner 對 `SESSION_SCOPE_CHANGED`／`SESSION_BINDING_REQUIRED` 先保存退役紀錄，清除該 actor 的 binding、session、model、rulesSent，再以新 session 啟動；其他 actor 與未知欄位保留。其他損毀或企圖直接替換 ID 仍拒絕。`accountProfileId` 是 owner 提供的不透明設定檔識別，不是 Email，也不證明目前登入帳號；正式 runtime 仍須完成身分核對。

runtime profile policy v4 將 controller 私有 `runtimeBase` 的實體路徑、HANDLE root fingerprint 與固定 `userProfileMode: owner-home` 納入綁定。base 只接受既有 owner 的 ProjectHub 根，或經核對的同 owner MSIX LocalCache 實體根；不由 HTTP／MCP caller 指定。路徑或實體目錄身分改變，或舊 profile 與 v4 不一致時，原生續接拒絕載入舊 ID；改以新 ID 開始，保留原歷史並附上文字交接，不遷移舊 session。

原生暫存、MCP 及 Grok 狀態從該實體 base 的 `runtime/<rootFingerprint>/<actor>/` 衍生，不寫入 Git 工作成果；Claude 的原生 session 仍使用自己的專用 projects 目錄。兩個 provider 都保留 `USERPROFILE=ownerHome`，Grok 其他 home／AppData 變數仍使用私有狀態路徑；這不增加工具、認證或網路權限。

## ChatRunner 內部接線與目前限制

`ChatRunner` 建構時可由控制端注入 Claude／Grok 的 `nativeProviders`，每個 handler 提供同步 `prepare` 與獨占 `openEndpoint`。handler 存於模組私有 WeakMap，HTTP request／既存 turn 資料不能建立或取代它；registry 的能力檢查仍先執行。缺少 handler、root pin、精確範圍或模型設定時，在歷史追加與端點建立前拒絕。尚未驗證的圖片明確拒絕，不靜默丟棄。

經核准的內部計畫使用原生雙向 adapter。adapter 的同步 `onSession` 重新讀取 metadata、核對範圍並保存綁定。新 session 與 Grok 續接仍在 prompt 前保存；Claude 續接以匹配範圍的舊 ID 進行握手，等有效 system/init 確認後才回呼綁定及公布 ready（CLI 可能在接收 user frame 後才送 init）。保存失敗、非同步 callback、異 session 事件均停止。Claude 的 system/init 先到也不能提前公布 session／ready。續接維持各 provider 的 ID；切換 provider 只交接既有文字脈絡，不共用原生 ID。

未完整結束或協定失敗時不自動啟動下一筆 queue；缺少有效 owned-tree 清理回報時，ChatRunner 保留 busy 與工作區 lease。僅有 close 事件不足以釋放所有權。原生回合不沿用舊的無保護 spawn、effort 重跑或跨 provider fallback。

以上內部接線已由假 stdio 端點的離線測試驗證。**server 尚未提供正式 native runtime handler／認證供應與各目的地核准，registry 仍 blocked，未安裝**。不能將建構參數或 fixture 當成可用的正式 runtime。

## 驗證

UI 重連或網路重試重用同一 request 時，僅在該筆已接受 user row **之後**有成功回覆時回傳既有結果。沒有回覆、回合失敗或中斷時回 `CHAT_REQUEST_ALREADY_ACCEPTED`／409，不重跑可能已執行的工具；同 request 改換內容回 `CHAT_REQUEST_CONFLICT`。保留原生 session 與歷史，後續使用新 request 續接。此為單一 Hub 的歷史判斷，尚不宣稱跨程序交易或 exactly-once 工具執行。

```powershell
node --test hub/test/chat-state-reader.test.js hub/test/chat-build-turn-actors.test.js
node --test hub/test/windows-chat.test.js
node --test hub/test/native-provider-chat.test.js hub/test/workspace-runtime.test.js
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

讀取／planner 測試不呼叫模型；Windows chat 測試使用明示的合成 Codex server。native-provider-chat 測試僅在 fixture 中替代 readiness、使用假原生端點，核對 durable binding、兩次獨立端點續接、跨 provider ID 分離、保存失敗、queue 與 unknown 清理保留；這些不是 Claude／Grok live agent 或正式安裝驗收。Windows 主機受影響批次 `validation-08` 為420項Node、103項Python通過，Node無skip。

獨立於上述fixture，Claude的`claude-duplex-continuity-02`／`claude-duplex-approval-01`及Grok的`grok-narrow-continuity-08`已在明確限定授權下通過真實兩回合原生session續接、合成改檔、固定MCP與owner核准。Grok第8次另從保存的原生工具結果核對stage1／2成功及最終產物雜湊。這些是adapter層的限定驗證；尚未包含正式server runtime供應、通用命令、完整委派或已安裝Hub。

## 退役與診斷契約

`retire` 回傳新物件，不修改傳入 metadata。`retiredBindings` 是本機紀錄陣列，最多保留最新 8 筆 `{actor, providerSessionId, code, at}`；舊 ID 優先取 binding，否則取 legacy sessions，無則 null。這不是可信簽章或外部 attestation。資料形狀見 [退役紀錄 Schema](retired-bindings.schema.json)。例如：

```json
{"sessions":{},"models":{},"rulesSent":{},"providerBindings":{},"retiredBindings":[{"actor":"grok","providerSessionId":"synthetic-old-session","code":"SESSION_SCOPE_CHANGED","at":"2026-10-22T00:00:00.000Z"}]}
```

啟動前 fallback 只呼叫一次 handler.prepare；保存成功後，在 user row 前追加並廣播 `role:event, freshSession:true, code, text`。完整文字交接仍受既有 contextPacket 長度上限限制，固定規則重新送出。保存失敗回 `CHAT_META_WRITE_FAILED`，不追加新回合或建立端點。排隊指示沿用相同流程。

已開始的 resume 若尚未經 onSession 確認、未由使用者停止，且收到 `GROK_NATIVE_RESUME_UNAVAILABLE`、`GROK_NATIVE_RESUME_FAILED`、`CLAUDE_NATIVE_RESUME_FAILED`，或確認前的 provider `*_SESSION_MISMATCH`，保存退役紀錄及「下一則訊息改開新對話」事件；本回合失敗 assistant row 仍保留，不重送本回合。已確認的 session、登入／額度／逾時錯誤都不退役。

Grok 原有缺少 loadSession capability 的專用代碼保留；session/load 的一般 RPC 錯誤由 REMOTE_ERROR 細分為 RESUME_FAILED，AUTH_UNAVAILABLE 仍優先。Claude 原有 EXIT_UNSUCCESSFUL／BEFORE_INIT 不足以辨識未知 session；只在未確認續接的 stderr 或結構化 error result 明確表示 session 不存在時標記 RESUME_FAILED，不公開該文字。

metadata 與 requireSave queue 的 rename 遇 EPERM／EACCES／EBUSY 會重試最多 8 次（25、50、100、200、300、400、500 ms），最終失敗移除暫存檔並保留原檔。這不增加跨程序交易保證。
