# 網頁交接資料相容與恢復入口

本文件只說明本機管理入口的資料相容檢查；不代表三個新 CLI 已通過執行或隔離驗收。

## 資料啟用

第一個新的網頁交接預覽前，controller 使用原生 create-only／SHA／FileID CAS 寫入 `_hub/data-format.json`。格式為 `web-manual-v2`，綁定實際 DataRoot FileID、當次版本的完整 package manifest 摘要及 capability file 摘要。開發來源模式明列 `source`，使用實際 controller 檔案摘要；它不是發布簽章。

`release-capabilities.json` 由原有 package manifest 逐檔 hash，只有精確已知格式可使用新版資料。缺少 capability file 的版本視為 legacy。舊版 058 不認識新資料，新的 managed installer／launcher 會拒絕把此 Root 指向它；不修改舊 version slot，也不宣稱舊 binary 自己能防止人繞過管理入口啟動。

正常 Install／Rollback／恢復版本指標前都檢查相容性。來源與目的版本可讀同一格式且没有未完成交易時，才允許切換。要回到舊版，需要另行準備與驗證相容的舊資料副本，保留目前資料並核准精確目標；此入口不自動把新版 Root 轉成舊版。

## 交易未完成

交接交易的 `planned`、`chat_saved`、`task_note_saved` 是非終態。正常 Start 和版本切換會拒絕。`preview`／`approved` 是草稿，重新啟動後 token 失效；它們不會當成已接受的寫入交易。

同一個已驗證版本可以使用恢復專用入口：

```powershell
.\windows\install-windows.ps1 -Action Start -RecoveryOnly -NoBrowser
```

此例使用 installer 既定 InstallBase／DataRoot。使用其他安裝位置時，傳入原本明確核准的 `-InstallBase` 和 `-DataRoot`，不得猜測或改用另一個 Root。

恢復專用模式保留本機 owner 登入、狀態檢查、已 durable 接受的精確收據恢復及停止入口；新預覽、貼回、CLI、queue、MCP 及一般 metadata mutation 均拒絕。不能把已運作的普通程序視為恢復程序；須先停止已驗證的原程序，再以同版本／模式啟動。

此入口使用獨立的最小 HTTP server，不建構普通 Store／Completion ledger、CLI runner、模型更新器或遠端 listener。背景 CLI 依實際專案「本體」與已接受 task-before 工作路徑歸屬，活動或未知程序拒絕復原。啟動時交易數明列 `transactionsAtStartup`；inspection 每頁 100 個啟動時紀錄範圍，提供 offset／上一頁／下一頁，並排除目前已 committed／revoked 的交易，不把快照數量當成即時未完成數。

收據使用不可變 metadata revision chain，原始 `receipt.json` 保持初始預覽；每一修訂綁定前一個修訂的相對路徑、SHA 與 FileID。未完成原子寫入的暫存檔不能當修訂或接受的交易。

Root、blob 或 native journal 的 FileID／內容不一致會保留資料並拒絕啟動或復原。破損 metadata／孤兒目錄／未完成原子 metadata 暫存檔，正常 Start 拒絕；同版恢復模式只能呈現只讀隔離條目，`repairable:false`，不採信、轉成 accepted 或自動刪除未知內容。雜湊及本機 FileID 用於交易對帳，不是外部 attestation、可信簽章或完整防竄改證明。

## 驗證範圍

`web-chat-admission.test.js` 驗證精確格式、舊版拒絕、Root／blob 身分替換、非終態 normal／switch 拒絕與同版恢復。`native-installer.test.js` 的 owned fixtures 驗證 Install／Rollback／Forward、RecoveryOnly Start／Stop 與原 version slot 保留；fixture HTTP 服務不是模型呼叫或正式 Hub 部署證據。
