# Windows 本機瀏覽器版（實驗性）

此分支提供 Windows 上的本機瀏覽器入口，供單人使用 Codex 會話與專案看板。這是 v4.68.2 的移植試作，尚未完成正式安裝或全面資安驗收。不要把它當作可公開連線的服務。

## 前置條件

- Windows 10/11、PowerShell、Node.js 22 以上、Git，以及已安裝並登入的 Codex CLI。
- 專案本體必須是已有至少一筆提交的 Git 儲存庫。Hub 在 Windows 不會自動初始化 Git，也不會讓 AI 直接修改本體。
- 目前只支援 Codex。瀏覽器會話不需要 `node-pty`；內嵌終端機需要該原生依賴，本移植尚未驗證，因此不列入可用功能。

## 在隔離目錄試跑

在已取得且審查過的原始碼根目錄執行：

```powershell
$env:HUB_ROOT = 'C:\path\to\isolated\AI-Workspace'
& .\hub\start-windows.ps1
```

不設定 `HUB_ROOT` 時，啟動器使用「文件」中的 `AI-Workspace`。它會建立 `_hub`、`Product`、`Work`，必要時新增 `_hub\roles.yaml`，並在 `_hub` 寫入伺服器日誌；既有 `roles.yaml` 不覆蓋。啟動器產生一次性的本機登入憑證，啟動只綁定 `127.0.0.1` 的服務，並開啟預設瀏覽器。**保留 PowerShell 視窗**，使用後在該視窗按 `Ctrl+C` 並檢查對應埠已關閉。瀏覽器網址片段會短暫含有憑證，頁面登入後立即從網址移除；同一使用者的本機程序仍可能觀察到啟動時的命令列或環境。

如需停止，在啟動器視窗按 `Ctrl+C`。不要只關閉視窗，因為由 `Start-Process` 啟動的子程序可能繼續執行。不要直接執行 `node hub/server.js`：Windows 伺服器要求啟動器提供本機憑證。

## 安全與功能邊界

- Windows 只接受 Codex CLI；Hub 對互動與 `exec` 會話指定 `workspace-write`，`exec` 另指定 `-a never`。CLI 與 Windows 沙箱的實際隔離效果仍須用真實會話驗證；不要用敏感專案作首次試跑。
- AI 工作目錄必須是 `Work/<專案>/<作業>` 下、指向該專案本體的 Git worktree。Windows 不複製本體未追蹤的 `.env`、`.npmrc` 等本機設定；不略過 Git hooks。
- Windows 不支援 Claude、Agy、另開終端機、遠端存取、ChatGPT MCP、Hub 內更新 CLI、Hub 內重新啟動、背景程序監測、自動合併、成果移轉、自動清理與驗證腳本。請在 Hub 外人工檢查程序、差異與 Git 狀態後，再自行合併。
- 圖片目前只接受 PNG/JPG/JPEG。會話、操作日誌與附件以一般檔案保存，未加密；分享前檢查內容。
- 2026-10-08 的 `npm audit --package-lock-only --omit=dev --json` 已完成，lockfile 的已知弱點為 0；Windows 原生依賴與端到端 Codex 工作階段仍未驗證。任何測試通過都不等於對來源、依賴或執行環境的完整安全保證。

## 後續驗證進度（2026-10-08）

現有 Windows／Git 範圍測試再次通過 22/22。另以本機 Codex CLI 0.154.0 的 `codex sandbox -P :workspace --include-managed-config` 執行無模型的合成檔案測試：工作目錄內寫入成功、相鄰未授權目錄寫入被 `EPERM` 拒絕；測試檔已清除。該命令的 help 描述為 restricted-token 診斷，不能單憑本機 `elevated` 設定將結果宣稱為 Hub 真實 Agent、elevated 執行路徑或網路隔離驗收通過。未安裝 WSL 或變更全域 Codex 設定。

使用者要求保留完整原版功能；本頁所列限制仍是目前程式的實際狀態，不能作為最終交付。後續實作計畫見 [Windows 完整功能實作計畫](../docs/superpowers/plans/2026-10-08-windows-feature-parity-implementation.md)。

## 維護者驗證

在 `hub` 目錄執行：

```powershell
node --test test\cli-platform.test.js test\local-auth.test.js test\windows-git.test.js test\windows-http.test.js test\windows-chat.test.js test\windows-workflow.test.js test\git.test.js
```

`start-windows.ps1` 的啟動與關閉、真實 Codex 隔離工作階段、Git 人工合併，以及套件弱點資料庫檢查，需另行驗證並記錄結果後才可考慮正式安裝。
