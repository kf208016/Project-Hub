# 網頁 Chat 手動交接

此功能在 Windows Hub 增加 **ChatGPT Chat** 與 **Claude Chat**，使用者自行登入、貼上及送出；Hub 建立預覽、核准一次交接，並保存人貼回的回答。此流程不使用模型 API，不要求 API key，不讀取瀏覽器 cookie，不自動傳訊，也不啟動 CLI、執行工具或完成作業。

## 操作

1. 在同一作業選擇 ChatGPT Chat 或 Claude Chat，輸入需求並預覽。
2. 核對目的地、實際 prompt、來源檔案完整摘要／FileID，以及明列的擷取與截斷。確認後複製內容，開啟固定網站：`https://chatgpt.com/` 或 `https://claude.ai/`。
3. 自行貼上並送出。複製或開站成功不代表訊息已送出；網站帳號／方案與費用由各供應商決定。
   若剪貼簿拒絕，或 5 秒內無法核對 API 完成，介面恢復操作並保留完整 prompt 供手動複製；未確認不當成複製成功，也不表示已送出。
4. 將回答原文貼回 Hub。成功須同時保存會話與作業記事，並提交交易收據；來源固定顯示 **「使用者貼上，未驗證網頁或模型來源」**。
5. CLI 繼續作業需另選 CLI、模型與工作區並取得新的 permit。網頁回覆不授權執行，也不會自動排隊、委派或變更作業 owner／完成狀態。

Windows 預設請求台灣繁體中文，可沿用日文切換（`responseLanguage: zh-TW`／`ja`）。使用者內容與貼回答案原樣保存，不以翻譯、Unicode replacement 或截短回覆取得成功。模型是否遵循語言請求仍由網站回覆決定。

原文完整保存在會話與 raw-result blob；task 記事採確定性的每行 `> ` 引用編碼，保留原換行。回覆中的 `## 手順`、`- [x]`、frontmatter 等不會被 task parser 當成作業步驟、owner 或完成狀態。

交易標記 `taskNoteEncoding: web-task-blockquote-preserve-newlines-v1`。已知、flush 完成且 FileID 未變的 preplanned blobs，只允許同一 process 精確重試同組 bytes；未確認的 orphan 或 Hub 重啟後未接受結果需新預覽，不採用未知 blobs。所需 blobs、native before／after 及 metadata／復原空間按保守上界，在 `planned` 前兩次查 private／target volume 餘量；這不是硬性空間保留，其他程式仍可消耗磁碟。實际寫入或 flush 失敗仍保留部分狀態。

## 資料範圍與上限

來源僅包括指定作業 `.ai/tasks/<task>.md`、該專案 `PROJECT.md` 的 frontmatter 後記事，以及該作業 `.ai/chat/<task>.jsonl` 中近期 human／assistant 文字；不自動讀取 repo、`.env`、登入配置或其他作業。完整來源仍會重新雜湊並驗證 Root／FileID，包含未顯示的截斷部分；不以 mtime cache 取代 bytes。

| 項目 | UTF-8 bytes 上限 |
|---|---:|
| 使用者需求 | 48 KiB |
| 完整生成 prompt | 128 KiB |
| 原始貼回回答 | 256 KiB |
| 序列化單筆 chat row | 2 MiB |
| task before／after 各檔 | 4 MiB |
| 交易 metadata | 1 MiB |
| 完整既有會話新交易 admission | 64 MiB |

作業取合法 UTF-8 prefix 最多 24 KiB；專案記事 prefix 最多 12 KiB；最近最多 6 筆 human／assistant 文字合計最多 24 KiB。64 MiB 的整份 log 先驗完整 UTF-8／SHA／FileID；逐行 cursor 解析所有 row，只保留有界近期選段，不 split 或收集所有 parsed rows。此仍有整檔 64 MiB buffer 的記憶體界線，不是無限 streaming。預覽的 `sourceManifest` 明列 full-source SHA-256、Root／FileID、byte range／row indexes 與是否截斷。較大的既有資料、損毀或未完成 JSONL、無效 UTF-8、NUL、孤立 surrogate 均明確拒絕，不略過後宣稱完整讀取。

`taskHashAlgorithm: hub-completion-crlf-to-lf-v1` 表示既有 Completion 的 CRLF→LF 摘要；`rawTaskSHA256` 是 task 原始 bytes 摘要。prompt／result SHA-256 固定精確 UTF-8 bytes，兩者不能混稱。

## 授權與跨檔交易

Owner 身分由已驗證 Hub 登入在 server 內綁定，HTTP body 不接受自行指定 owner。MCP／worker／provider token 不能核准網頁交接或查 owner 收據。

- Preview token 為一次性 CSPRNG，期限 5 分鐘；Confirm 驗 fresh 完整來源與 prompt 後取得一次性、60 分鐘貼回 token。
- token 綁 owner、actor、project/task、receipt 與用途；wall／monotonic 任一到期或倒退均拒絕。原值不入 journal、URL 或 localStorage；Hub 重啟後不接受先前未 durable 接受的新結果。
- 同 `requestId`／digest 只能重試同一 owner／actor／task／receipt；不同內容或跨入口拒絕。相同已接受交易可查當前狀態；不再次 append。
- 活動 CLI、queue、工作區 lease 或其他持久交易時，首次保存拒絕，草稿保留供使用者處理。所有 task writer 共用 controller 鎖；native writer 另以完整 SHA、Root／FileID 及 held HANDLE 做 compare-and-write。

初始預覽收據位於 `<DataRoot>\_hub\web-chat-receipts\<receiptId>\receipt.json`，永遠不覆寫；後續狀態為不可變 `metadata-000001-<SHA256>.json` 等修訂。每份以 held parent 私有 temp 完整 write／flush，再 create-only no-replace rename 發布；previous revision 的相對名稱／full SHA／FileID 綁定形成嚴格修訂鏈。縮短 committed 狀態不會以 inplace write 留下舊 JSON 尾 bytes。精確內容為 create-only 私有 blobs；target native before／after／intent journals 位於同層 `native`。此位置由 controller 管理，不授予 MCP／worker 寫入。它仍可受主機 owner／admin 修改；本地 hash、DPAPI 或 FileID 不是外部簽章、WORM、供應商來源證明或完整防竄改保證。

交易順序為 `planned → chat_saved → task_note_saved → committed`。兩個目標及 terminal journal flush／核對完成後才 emit／回完整成功。部分失敗回 `partial/chatSaved/taskNoteSaved/recoveryRequired`；保留已存回答、private blobs 與 journal。重啟後只有 owner 能精確復原先前 durable 接受的同筆 bytes，不重新授權對外傳輸。未知目標身分、外部修改、損毀 metadata 或不能證明寫入狀態時保留待人工覆核，不補假成功或刪回答。

`durableStage` 是已保存收據階段；`actualTargets` 另以唯讀 SHA／FileID 對帳為 before／saved／changed／missing／unknown。native 目標已 flush、JS 階段保存失敗時，兩者可能不同。`chatSaved`／`taskNoteSaved` 無法確認時回 `null`，不將未知當成「尚未寫入」；最初缺 log 且 created FileID 未 durable 綁定的窗口維持 unknown，精確 native journal retry 才能確認。

首次 `planned` 發布前建立持久 project hold；未知接受／partial 保留 hold，Hub 重啟後普通 writer 仍不可穿過。只有 committed 與兩個實檔完整 SHA／FileID 核對後解除。同 process 已知而未核准的 preview metadata 建立失敗，可在 prompt／private Root／native Root pins 相符時補完全相同初始記錄，再進行新預覽；不創造核准或外送事件。跨重啟未知 orphan、損毀 chain 或 pending temp 保留在原處，僅已驗 same-release／Root 的 owner 救援入口提供唯讀 inspection，不採用未知 temp 為 accepted revision、不刪來源。已驗最新 preview／approved、transaction:null 且無未知 native intent／active writer 的未接受 hold，owner 可先 atomic 持久 revoked，再解除自己的 hold；到期／catch 不直接解除。

target 中途 WriteFile 可能留下部分 bytes。`recoverPreview` 顯示確切相對檔、current FileID／SHA、已接受 after SHA 與 native journal ID；復原需 owner 再確認，使用用途獨立且 5 分鐘一次性的 recoveryToken／previewSHA256。送出前重驗 metadata／兩個 target tuple；更換 FileID、外部修改或 journal before／after blob 不符均拒絕。只有持久已接受、尚未 complete 的 native intent 可由 `writer.recover` 滾進原 after bytes，然後對帳兩檔與 committed；已完成 intent 被外部改寫不能藉此覆寫。這項核准不啟動 CLI 或新增外送權限。

## HTTP 與相容性

`POST /api/web-chat/preview|confirm|result|recover/preview|recover|revoke` 與 owner 限定 status 保留 Host／Origin／CSRF／登入及遠端 TLS gate。`recover` 非 terminal 缺 confirm／recoveryToken／expectedRecoverySHA256 回 `RECOVERY_PREVIEW_REQUIRED`。Strict request／receipt／immutable revision schemas 與合成範例位於 `windows/web-chat-*.schema.json`／`web-chat-examples.json`；runtime 另驗 byte 上限、clock、Root／FileID、完整 source／blob cross-reference。Schema 結構檢查不等於完整 JSON Schema conformance。

舊 `/api/chatgpt/prompt`／`result` 由同一手動交接 service 處理；缺 preview／Confirm、receipt／token／requestId 的舊請求回 `409 HANDOFF_PREVIEW_REQUIRED`，不替舊 client 自動核准。新 DataRoot format／release-capability gate 由版本化 installer／launcher 管理；058 舊 binary 不具此 gate，不直接讓舊版寫新 Root。

## 驗證界線

`web-chat*.test.js` 包含 fixture 與明示的 real NTFS private writer 案例。故障注入、API／UI、安裝／回復及真實網站互動是不同證據：fixture／開站不能證明模型連通，貼回文字不能證明實際網頁或模型來源。Claude／Agy／Grok CLI 的隔離與模型協定另驗；本功能不因 Grok Bot 合成探針而將三個 CLI 標示為已就緒。
