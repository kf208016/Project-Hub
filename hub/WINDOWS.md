# Windows 原生移植進度

日期：2026-10-08。以 v4.68.2 為基礎；仍是開發分支，**未完成正式安裝或完整功能／資安驗收**。使用者要求保留原版功能，以下未完成項目仍屬交付範圍。

## 已實作及驗證

| 項目 | 證據與界線 |
|---|---|
| 原生 Codex 會話 | CLI 0.154.0、本機 stdio app-server；真實 `gpt-6-astra` 回覆固定合成文字，沒有呼叫工具。模型從帳號實際列表確認，不以過期標籤猜測或替換付費模型 |
| 沙箱 | 明確要求 Windows elevated、workspace-write、on-request、使用者審批；確認 server 回報設定。本機 command/exec 合成探針確認專用沙箱帳號、工作目錄可寫、相鄰範圍外寫入 EPERM |
| 網路限制 | `networkAccess=false` 仍可連線本機 loopback；不能標示完全離線。尚未完成外部目的地與敏感檔案讀取測試 |
| 審批 UI | 綁定 thread／turn／item、一次性 token、到期、拒絕／取消、檔案狀態指紋、問題回答。要求瀏覽器登入與操作標頭；先寫核准意圖記錄，失敗即不傳送決定。fixture 與 HTTP 測試通過；尚未以真實工具提權回合測試所有分支 |
| 程序所有權 | 先暫停啟動、指定 Windows Job、再執行；私有 pipe 綁定 Hub 生存期。父子孫程序取消／擁有者崩潰均已實測，不以 PID 清單終止無關程序 |
| ConPTY | node-pty 1.1.0 原生元件載入、Unicode／特殊字元、resize、取消與擁有者崩潰測試通過；真實 Codex TUI 啟動並正常退出，未送模型回合。PTY 是終端機與生命週期管理，沒有額外沙箱能力 |
| 啟動器 | 背景啟動、相同实例重新開啟、明確停止、埠衝突、junction 與破損紀錄拒絕；自動測試使用 `-NoBrowser`。實際 Edge 專用視窗仍需人工／UI 驗收 |
| 程序監測 | Windows CIM 查詢、PID＋建立時間識別；失敗顯示未知。外部 AI 的 cwd 尚不能可靠歸屬，因此未歸屬作業會阻擋整理、還原與驗證操作 |
| 路徑與 Git | 拒絕 UNC／裝置／ADS／模糊名稱與 symlink／junction；驗證既有 worktree 的 common dir 與登錄。真實合成 Git 及拒絕路徑通過 |
| 整理與還原 | 原版選擇／確認／指紋重新檢查、保留來源與不覆蓋還原；新增搬移／還原中断復原。Windows API 需最新且可歸屬的程序狀態；未知不是零程序 |

## 環境與試跑

前置：Windows、Node.js 22 以上、Git、已登入的 Codex CLI，以及 .NET Framework C# 編譯器（生命週期 helper 由已審閱原始碼建置）。ConPTY 使用 lockfile 固定的 node-pty 1.1.0。

只能先在非敏感的測試工作區執行：

```powershell
$env:HUB_ROOT = 'C:\path\to\isolated\AI-Workspace'
& .\hub\start-windows.ps1
# 等 AI 作業結束後停止
& .\hub\start-windows.ps1 -Stop
```

啟動器會建立 `_hub`、`Product`、`Work`，既有 roles.yaml 不覆蓋。關閉介面會保留背景服務；再次執行啟動器可回到同一服務。`-NoBrowser` 供無視窗驗證。`-Stop` 透過已驗證的服務呼叫停止 API，活動作業存在時不強制結束。

若 PowerShell 的有效執行原則阻擋腳本，先檢查政策來源。本次測試只對測試行程指定 RemoteSigned，沒有修改登錄、群組原則或使用者永久設定。尚未提供正式簽章的安裝入口。

### 本機控制資料

- `_hub/desktop-state.json` v1 保存工作區、版本目錄、PID、建立時間、埠與 DPAPI CurrentUser 加密 token。重開時先比對程序身分，再以隨機 challenge 驗證 HMAC，驗證前不送登入 token。
- HTTP 只綁定 loopback，cookie 為 HttpOnly／SameSite=Strict，Host／Origin 檢查保持生效。登入 token 從 AI 子程序環境移除。
- 瀏覽器登入片段會短暫包含 token；同一使用者的其他程序仍可能觀察命令列。DPAPI 不隔離同一登入使用者。
- `_hub/approvals.jsonl` 是本機審批意圖記錄，不包含回答或命令內容；不是不可變更的外部稽核證明。
- 整理記錄增量加入 `moving`、`restoring`；舊格式可讀。恢復只在來源／目的地狀態與既有指紋相符時更新紀錄。損壞記錄會報錯，不當作空歷史。

資料契約見 `windows/desktop-state.schema.json` 與 `windows/cleanup-record.schema.json`。Schema 描述序列化格式；程序、檔案與授權的動態檢查由執行程式負責。

### 已核准測試腳本的權限

「執行專案測試」會在確認 package.json 雜湊與具體命令後執行 npm，關閉 npm 的 pre/post hooks。這是以目前 Windows 使用者權限執行的專案程式，可存取主機檔案與網路，**沒有自動套用 Codex 沙箱**；確認畫面會說明此界線。managed Job 只負責逾時與子程序清理。只執行已信任的程式。

## 尚未完成的原版功能

- Claude／Agy 的 Windows 隔離與真實互動驗證；不能從 Codex 的結果推論它們安全。
- 另開終端機、全部跨 AI 交接、长提示 TUI、各種暫停／恢復及視窗互動。
- 非 Git／首次提交／direct mode 的預覽與授權、短期選擇供應機密檔案。
- Git 合併的最新快照與一次性授權、成果移轉／整合、批次空專案清理；仍保持拒絕分支。
- MCP／委派憑證分離、遠端 TLS／登入與真實端點驗證。
- CLI 更新、Hub 內重啟、完整圖片格式轉換、資料升級／回復與正式安裝包。
- 所有原版回歸測試；仍有 POSIX 夾具、尚未恢復的 Windows 成功路徑及逾時失敗。不得以大量 skip 視為通過。

## 依賴與驗證方式

node-pty 以 `npm ci --ignore-scripts` 取得並檢查安裝腳本與原生產物，未執行套件安裝脚本；現成 Windows prebuild 已實際載入。本次 npm 官方弱點 API 對 lockfile 回報 0 筆已知弱點，不等於原生二進位可追溯建置或整體無風險。

Windows PTY 使用 `useConptyDll=true` 的 handle 關閉路徑；node-pty 1.1.0 自然退出會保留 output worker 引用，adapter 會 dispose 該 worker。這依賴固定版本的內部欄位，升級時必須重新檢查與測試，不能只改版號。

目前 Windows 變更的指定整合回歸為 **199 通過、0 失敗、0 跳過**。完整套件另行以 66 個測試檔執行，3 分鐘內已記錄 135 個失敗項目且未跑完，已停止該測試程序樹；不能將 199 項指定測試當成完整套件通過。

單元／整合测试：`npm --prefix hub test`。完整 Windows 測試尚未全過；本機驗證紀錄應保留實際成功／失敗／逾時。使用者指定的 Python unittest 命令已執行，但本專案是 Node，沒有 `tests` Python 目錄，回報 ImportError；不列為通過。

未安裝 WSL、未改動全域 Codex 設定、未改防火牆／系統帳號。實作順序與完整驗收範圍見 [已核准計畫](../docs/superpowers/plans/2026-10-08-windows-feature-parity-implementation.md)。
