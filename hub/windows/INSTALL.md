# Windows 版本化安裝與回復

此文件說明 Windows 版本化安裝、啟動、停止與回復機制。程式採 create-only 版本槽，使用者資料獨立保存；本機是否已安裝、目前版本及實測範圍，請以隨套件提供的 Windows 交付報告與對應安裝紀錄為準。

## 位置與影響

- 程式：`%LOCALAPPDATA%\ProjectHub\versions\4.68.2-windows-codex-<commit前12碼>`。
- 當前版本：`%LOCALAPPDATA%\ProjectHub\current.json`；切換前保留 `history` 備份與變更紀錄。
- 資料：使用者 Documents 下的 `AI-Workspace`。拒絕 Codex 目錄及存在 `.git` 的祖先，避免把 Codex 的空 Git 祖先當成專案 repo。
- 僅建立缺少的 `_hub`、`Product`、`Work`、`_hub/roles.yaml` ；私有圖片依賴設定會在安裝、回復、恢復指標與停止狀態的啟動時綁至選定版本，更新前保留 `_hub/history`；既有 roles.yaml、roles.json、專案、對話、憑證與其他資料不覆蓋，不匯入範例專案。
- 不改 PATH、全域 Codex 設定、WSL、防火牆、排程或永久 PowerShell 執行原則。

同機使用與原版 Project Hub 一樣不需登入；啟動器只開瀏覽器網址，不再開本機登入確認視窗。任何通過 Host／Origin／X-Hub 檢查的本機程式都能操作 Hub，包括核准命令與讀寫檔案；能連到此入口的 AI 命令也能自行核准。服務仍綁 `127.0.0.1` 並拒絕中繼標頭；遠端 HTTPS 預設關閉，通關密語登入與 MCP Bearer 限制不變。啟動器 token、HMAC proof 與相容登入 API 繼續用於停止／重啟的實例核對。

## 套件來源門檻

`package-windows.cjs` 僅接受明確、乾淨且已提交的來源 commit；檢查 assume-unchanged、skip-worktree 與會隱藏修改的 index cache，並在複製後再次確認來源。tracked 程式取自 exact commit 的 Git blob，驗證 blob 身分再產 raw SHA-256；不把 CRLF working tree 與 LF blob 混稱為相同 bytes。npm 依賴另取已審閱的實際安裝 bytes。正式產物需由最終 source/test gate 後的 Root 產生，不能使用正在修改的工作樹。

套件清單包含每個來源與 npm 依賴的 SHA-256／大小。npm 已使用 lockfile 的 `npm ci --ignore-scripts`，Windows 使用已審閱 node-pty 1.1.0 prebuild，不執行安裝 hooks。`.runtime` 編譯快取與 `.git` 不打包。Git blob staging 保留在套件同層 `.package-input-<UUID>` 供來源核對，沒有使用者資料；單一 tracked blob 上限 4 MiB、套件上限 20,000 files／2 GiB，超限需另審閱，不默默略過。

FFmpeg 9.0.2 私有執行檔的 SHA-256 是 `3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`。私有安裝套件附原 `LICENSE`、`README.txt` 與固定來源 metadata；source-only ZIP 不包含此 GPLv3 二進位。雜湊只固定位元組，不是弱點不存在或可重現建置證明。

## 檢閱與操作

PowerShell 入口是 `hub\windows\install-windows.ps1`。`ManifestSha256` 必須取自已審閱套件清單；不得使用來路不明 package 自稱的校驗碼作為授權證據。

```powershell
& .\hub\windows\install-windows.ps1 -Action Preview -PackageRoot 'C:\reviewed\package' -ManifestSha256 '<已審閱 SHA-256>'
& .\hub\windows\install-windows.ps1 -Action Install -PackageRoot 'C:\reviewed\package' -ManifestSha256 '<相同 SHA-256>'
& .\hub\windows\install-windows.ps1 -Action Start
& .\hub\windows\install-windows.ps1 -Action Stop
& .\hub\windows\install-windows.ps1 -Action Rollback
& .\hub\windows\install-windows.ps1 -Action Start
```

既有版本槽即使不完整也拒絕覆蓋；保留內容供檢查。同一登入使用者仍能修改這些檔案，create-only 不是 immutable 儲存。未知／破損 `current.json` 拒絕，不能猜測當前版本。切換前拒絕保存的 launcher state 及已占用的服務埠，包含沒有保存 state 的手動／不可信服務。啟動前驗證套件檔案；停止使用原生 launcher 的 PID、建立時間與 HMAC 實例驗證及 `/api/quit` gate，活動作業存在時拒絕，不以全域 PID kill。wrapper 不等背景服務繼承的 stdout pipe EOF，診斷見資料 Root `_hub/server.stdout.log`／`server.stderr.log`。未知執行結果保留紀錄，不自動重試。

回復僅切換至已記錄並重新驗證的前一版，保留全部資料與版本槽。它不是資料格式降版或備份還原；若後續版本引入不相容資料格式，需另訂經審閱的資料遷移方案。

原生私有 helper 在每次複製／讀寫內持有祖先 HANDLE，拒絕重解析點與多硬連結；目標檔案以 create-only 開啟。當前 pointer 更新使用獨占 HANDLE、FileID 與 expected SHA-256，比對後先 durable 備份／journal，再寫同一檔案。跨檔案批次不是原子交易；失敗可能留下未選取的版本槽或新建缺少的設定，不能回報完成。

若 pointer 寫入中斷，先人工確認 history、目前檔案 SHA-256 與同一 FileID，再使用 `Recover-Current -Backup 'history/current-<id>.json' -ExpectedHash '<目前 SHA-256>'`。僅接受對應 journal、已知備份與同一 pointer FileID，未知 hash／換檔不能自動復原。這會再保留當前內容，不刪任何使用者資料。

正式執行本機安裝需由工具的 `auto_review` 對精確 LocalAppData／Documents 路徑核准 `require_escalated`。使用者已授權安裝；此為環境寫入門檻，不重新要求產品範圍核准。

## Windows 安裝安全限制

- `InstallBase` 必須位於 Windows 系統碟；`DataRoot` 仍可位於其他已接受的本機 NTFS 磁碟。
- 請從一般 PowerShell 視窗執行安裝。若任一安裝控制路徑被重新導向，或封裝（MSIX）行程操作位於使用者 AppData 且不在暫存區的安裝位置，Preview、Install、Start、Stop、Rollback 與 Recover-Current 均以 `INSTALL_BASE_VIRTUALIZED` 拒絕。Status 僅回報封裝環境與不可信警告。
- PowerShell wrapper 會把 UTF-8（無 BOM）請求寫入 `%TEMP%` 的隨機檔案，交給 Node 讀取後在 `finally` 刪除，不再透過文字管線傳送 JSON。
- 已失效的 `desktop-state.json` 會先封存為同目錄的 `desktop-state.stale-*.json`；仍存活且身分吻合的執行個體仍會阻擋切換版本。
- 安裝或回復版本成功後，安裝根目錄會產生 `Start-Project-Hub.cmd` 與 `Stop-Project-Hub.cmd`。安裝器只會更新帶有產生器標記的檔案，不會覆寫使用者自建的同名檔案。
