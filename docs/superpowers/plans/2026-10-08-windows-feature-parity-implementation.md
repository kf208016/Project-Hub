# Project Hub Windows 實作計畫

日期：2026-10-08。狀態：使用者已核准，正在實作；目前完成原生 Codex、程序所有權、ConPTY、背景啟動器及部分路徑／整理保護。完整原版功能與正式安裝尚未完成。最新實測與限制見 `hub/WINDOWS.md`。

## 目標與基線

在原生 Windows 使用 Codex，保留 Project Hub v4.68.2 原版功能並修正已查出的資安問題。使用者於本輪明確選擇「完成原生 Codex 的全部 Hub 功能；其他 AI 保留待後續處理」。Claude／Agy 改列後續範圍，不以其未完成項目宣稱已驗收，也不刪除既有資料或設定。WSL2 不列入本輪安裝。

基線為本機 `windows-browser-mvp` 分支，程式試作 commit `7349b2d`，修正後規格 commit `0cdb909`。既有 ZIP 與 patch 僅對應試作，不包含本計畫的新實作。以 `project-hub-windows-full-function-security-design.md` 的功能矩陣作為完整驗收範圍。

執行方式：由目前 Codex 在同一分支依序修改、測試與建立可回復 commit，分工處理有明確檔案所有權的子任務；不新增外部服務。開始前檢查工作樹，保留後續使用者變更。只有達成各階段驗收才能將該項標示完成。

## 本次先行驗證

1. 已重跑現有 Windows／Git 範圍測試：22 通過、0 失敗、0 跳過；耗時約 32 秒。仍包含假 CLI，不能視為真實模型會話通過。
2. 本機 Codex CLI 0.154.0 的設定為 `workspace-write`、`on-request`、Windows `elevated`。只讀取這些設定行，未改寫全域設定。
3. 使用 `codex sandbox -P :workspace --include-managed-config`，在本工作區的合成測試目錄執行 Node 檔案探針：指定工作目錄寫入成功、旁邊未授權目錄寫入回報 `EPERM`。未加內層沙箱的同一探針兩處均可寫，排除探針本身或目錄不存在造成假拒絕。
4. 首次在外層工具沙箱內執行，得到 `CreateRestrictedToken failed: 87`；經工具核准，在外層沙箱之外執行相同的 Codex 沙箱命令後才得到上述成功／拒絕結果。這支持巢狀執行影響診斷的推論，不構成一般 Windows 不支援的證據。
5. `codex sandbox --help` 描述的是 restricted-token 診斷命令。即使本機設定為 `elevated`，本次結果也不能單獨證明 Hub 的真實 Agent 會使用 elevated 模式。尚未驗證網路隔離、敏感檔案讀取、CLI 會話與模型回覆。

以上為核准前的先行驗證紀錄。核准後已補做本機 app-server 的 elevated 帳號與寫入拒絕實測，以及一次合成文字的真實模型回覆；未送出實際專案內容、未修改系統帳號／防火牆／WSL。網路設定仍允許 loopback，不能宣稱完全離線。

## 1. Codex 原生啟動、權限與錯誤回報

主要檔案：`hub/lib/cli-platform.js`、`hub/lib/launch.js`、`hub/lib/chat.js`、`hub/lib/ai-tools.js`、`hub/lib/usage.js`、`hub/start-windows.ps1`。

- 統一所有 Codex 呼叫使用 shell-free argv，不讓用量查詢、初始化、模型查詢另外走 `.cmd` 字串。
- 對照本機 CLI 支援的旗標與事件；清楚區分互動 PTY、非互動會話、需要人回覆的權限請求。
- 確認 `exec --json` 能否提供所需審批互動；若不具該協定，改接本機 Codex app-server 的正式審批事件，保留原本 UI 工作流程，固定本機程序通道。先以本機協定 fixture 驗證，再做非敏感真實會話測試。
- 沙箱啟動、權限或協定失敗須顯示具體原因；不得退回 bypass，也不得以固定 `never` 拒絕所有需授權操作來冒充功能完整。
- 採用何種沙箱模式由可觀測的實際執行證據確認，不能只看全域設定。需要初始化 Windows 安全元件時，先列出精確系統變更。

驗收：空白及 Unicode 路徑、含 shell 特殊字元提示、缺少 CLI、失敗 exit、事件破損、缺少完成事件、審批允許／拒絕／取消／逾時、沙箱不可用。Hub 啟動到真實 Codex 的工作目錄內成功與範圍外拒絕需另外實測。

## 2. 程序生命週期與背景監測

主要檔案：`hub/lib/chat.js`、`hub/lib/sessions.js`、`hub/lib/procwatch.js`、`hub/server.js`、`hub/start-windows.ps1`；新增集中處理 Windows 程序生命週期的模組及測試。

- 程序記錄綁定 run ID、PID、建立時間、專案、作業與工作目錄。
- 終止及重啟需處理 Node wrapper、CLI 及其衍生程序；優先使用能綁定程序生命週期的 OS 機制。任何依 PID 終止的實作都必須先驗證建立時間，不能誤殺 PID 已重用的程序。
- Windows 程序列舉失敗顯示「未知／查詢失敗」，保留安全阻擋，不回報零程序。
- 外部 CLI 無法確定工作目錄時保留未歸屬狀態，不能憑命令列猜測後刪除專案或工作複本。
- 待整個程序樹退出後才解除合併／清理的活動鎖；崩潰與重開應能辨識未結束的 run。

驗收：本機合成父／子／孫程序樹正常終止、取消、Hub 崩潰、查詢失敗、PID 重用 fixture、非 Hub 程序保留、關窗／重新連線的原版背景持續行為。測試只能終止自身建立且可辨識的程序。

## 3. 原生終端機與視窗生命週期

主要檔案：`hub/lib/sessions.js`、`hub/lib/launch.js`、`hub/server.js`、`hub/public/app.js`、`hub/WINDOWS.md`，以及 Windows 宿主與啟動器。

- 審查 lockfile 固定的 `node-pty` 套件與原生產物；先以不執行安裝腳本方式取得供檢查，再執行已審查的必要步驟。npm audit 零筆不能代替原生依賴驗證。
- ConPTY 實測輸入、resize、Unicode、結束及同時會話；PTY 不承擔安全隔離宣稱。
- 恢復另開終端機與交接，明確區分人操作的一般終端機與 AI 的沙箱權限。
- Windows 視窗關閉後的背景執行、再次開啟與明確停止，對齊原版用途；不可只用「保留 PowerShell 視窗」作為完整桌面功能交付。

驗收：原生依賴真正載入、終端機往返與尺寸變化、停止整個程序樹、重複啟動、埠衝突、重新開啟既有會話。

## 4. Git、非 Git 專案與可回復整理

主要檔案：`hub/lib/git.js`、`hub/lib/maintenance.js`、`hub/server.js`、相關 store／hierarchy／trash 模組與 UI。

- 在背景監測可信且程序鎖生效後恢復合併、成果移轉、清理及還原。
- 首次 Git 初始化、未提交專案與 direct mode 先顯示保存／變更範圍；授權綁定本次預覽與檔案狀態。
- 合併預覽綁定來源 HEAD、目標 HEAD、未提交狀態與作業；狀態變化需重做預覽。衝突或記錄失敗不得先刪來源。
- 敏感檔案採明確選擇與短期供應；不列印值、不自動提交，不把已追蹤秘密誤認為已排除。
- 防止 Windows junction、symlink、UNC、ADS 與裝置路徑繞過目錄限制；所有移動／刪除先驗證實際目標，再作可回復操作。

驗收：乾淨合併、衝突、活動程序、未知程序狀態、未追蹤檔、過期預覽、磁碟／權限失敗、還原碰撞、路徑繞過與中斷後恢復。既有 Git 成功斷言需保留。

## 5. MCP、委派、遠端與控制端授權

主要檔案：`hub/lib/local-auth.js`、`hub/mcp.js`、`hub/lib/chatgpt.js`、`hub/lib/remote.js`、`hub/server.js` 及相關 UI。

- 瀏覽器 session、AI 作業與 MCP 使用不同憑證；AI 只取得指定專案／run 的必要能力。
- 修正 Windows TOML 路徑編碼；新設定可撤銷、到期，註冊失敗不留下成功狀態。
- 恢復 AI 委派時提供受限的呼叫通道；目前上游 curl 範例無法通過新增本機登入，必須同步修改，不能把登入 token 交給 AI。
- 審批 API 僅接受使用者身分，AI 不能自批；申請綁定動作、路徑、參數、雜湊及到期時間。
- 遠端入口限定可信代理並維持 TLS／登入，不能只靠 forwarded／Tailscale 標頭宣稱可信。

驗收：跨專案、重放、撤銷、錯誤 Host／Origin、偽造代理標頭、權限不足、自我核准、破損 TOML、MCP 中斷；真實手機／遠端端點另列必要實測，不以本機 fixture 代替。

## 6. 其他 CLI、更新、圖片與資料相容

主要檔案：`hub/lib/cli-platform.js`、`hub/lib/ai-tools.js`、`hub/lib/usage.js`、`hub/lib/chat.js` 的圖片處理、`hub/server.js` 的附件 API、`hub/public/` 與模型／角色設定。

- Claude／Agy 各自辨識實際安裝入口、權限協定與隔離能力；不從 Codex 的測試外推它們安全。缺少實測環境時保留未驗證標記，完整驗收不因此放寬。
- CLI 更新預覽固定供應來源與版本，驗證下載／安裝結果，處理活動會話、失敗與回復。未知安裝方式不執行猜測命令。
- 恢復 WebP／GIF／HEIC 等原版圖片用途；選擇可審查的 Windows 轉換實作，保留原檔並限制真實格式、大小與解碼像素。
- 保留現有專案、角色、階段、任務、通知、續聊、交接及模型設定，增量遷移可回復。

驗收：每個 CLI 的正反路徑、真實圖片格式與破損輸入、更新來源／版本不符、既有資料讀寫與復原。若需新正式依賴，先列出必要性、授權、來源、體積與維護影響。

## 7. 安裝與交付門檻

- 把上游 POSIX fixture 改成跨平台測試夾具，不刪除斷言、不以大量 skip 取得全綠；完整套件測試需有確定的結束與清理。
- 程式變更後執行所影響的 Node 測試與完整測試。依使用者要求另執行 `$env:PYTHONPATH = "src"; python -m unittest discover -s tests -v`；本專案若仍無 Python `tests` 目錄，誠實記錄不適用／失敗，不算通過。
- 真實 CLI 測試只使用合成專案，呼叫模型前列明送出內容與服務；目前本機無模型的診斷不包含推論費用。
- 完成功能矩陣的成功與重要拒絕路徑、依賴檢查、安裝／升級／回復測試後，再執行原先授權的正式安裝。
- 安裝於可回復的版本目錄，保留資料與前一版；資料格式與憑證遷移需備份且失敗時不留下成功狀態。系統帳號、防火牆或全域 CLI 設定變更需列明精確影響。
- 交付可執行入口、安裝與停止／移除方法、雜湊、版本來源、測試結果、功能矩陣及剩餘限制。存在未完成／只有 mock 的原版功能時，不標示完整移植完成。

## 執行順序與審閱點

先完成第 1、2 階段的真實成功／拒絕驗證，再接第 3～6 階段，最後第 7 階段安裝。合併與清理依賴可靠程序狀態；MCP／委派依賴權限分離；因此不先解除 Windows 拒絕分支。

目前所用 brainstorming 技能要求架構規格後再審閱書面實作計畫與執行方式。它指定的 writing-plans 技能在本機 skills／plugins 中未找到；本文件直接依既有程式與核准方向整理，未假稱已使用該缺少的技能。

本計畫與「由目前 Codex 在同一分支依序執行」方式已獲使用者核准。未列明的系統變更仍不包含在本次授權內；不需重複詢問既有計畫的核准。
