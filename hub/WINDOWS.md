# Windows 原生 Codex／Claude／Grok 分支

2026-10-19：產品範圍為 **Chat／CLI 開發與同任務對話續接**，不包含 computer use。Claude／Sonnet 與 Grok 4.6 已各完成本機合成三回合正式驗收，涵蓋一般命令、原生子代理、Hub MCP／委派、原生 session 續接、越界寫入拒絕與 owned 程序清理。這是核准範圍內的實測，不代表所有模型、工具或任意專案均已驗收。Linux／Hyper-V 不是此前提；正式安裝與安裝後 smoke 結果另列交付報告。見 [原生 CLI 整合](windows/NATIVE-PROVIDER-INTEGRATION.md)、[目前範圍與續接契約](../docs/superpowers/specs/2026-10-18-chat-cli-task-continuity-design.md) 及 [對話狀態讀取修正](windows/CHAT-CONTINUITY.md)。

接續移植的上游規格已改以v4.90.0 Beta為對照，原碼第一批加入Markdown表格；來源版本／安裝版並未因此自動升級。逐項狀態見 [版本差異與進度](../docs/superpowers/specs/2026-10-18-upstream-4.90.0-windows-parity.md)。

基底：Project Hub v4.68.2；2026-10-19 擴充 Claude／Grok 原生 Chat／CLI。Codex 既有流程保留；Agy 與 Claude／Grok 互動 PTY 入口仍延後。上游 v4.90.0 Beta 的待移植項目保留獨立對照，不從本次結果推論整套上游規格已完成。

下表描述本分支的實作及已驗證路徑，不代表所有平台、所有模型工具或每份 checkout 都已完成正式安裝。確切 source commit、套件 manifest SHA-256、各測試成功／失敗／跳過／逾時、正式安裝位置及實際啟停結果，以隨交付提供的驗證／安裝報告為準。

2026-10-11 的桌面／手機介面與人工交接流程改版，見 [介面與人工交接說明](windows/WEB-CHAT.md)。該前端修訂需另行封裝及部署，不能由原安裝版號推論已套用。

完整分支介紹、安裝前提與測試限制見 [Windows 移植說明](../WINDOWS-PORT.md)。

## 功能與驗證範圍

| 項目 | 實作與已測界線 |
|---|---|
| 原生 Codex 會話與模型 | CLI 0.154.0／0.164.0 白名單 stdio app-server（0.164.0 真機驗收待辦）、模型清單分頁與失敗保留、指定模型、同作業委派、待執行指示、取消／追加／恢復。真實模型只測固定合成回覆且未呼叫工具；其他流程使用明示 provider fixture，不當成全部模型工具驗收 |
| 原生 Claude／Grok Chat／CLI | 固定 CLI 與指定模型、核准範圍內的檔案與一般命令、原生子代理、已註冊 Hub MCP、同作業排隊委派及同一原生 session 續接。三回合合成驗收含命令實際結果、越界寫入拒絕與 owned Job 清理；互動 PTY、Agy、其他工具／模型及任意真實專案不在此成功宣稱內 |
| 終端機 | node-pty 1.1.0 ConPTY、內嵌／獨立視窗、輸入／resize、Unicode、觀看／控制租約、明確接管與停止。實際 managed PTY 及 Codex TUI 啟停已測；TUI 啟動測試未送模型回合，PTY 本身不是額外沙箱 |
| 審批與命令 | 綁定 thread／turn／item 或 capability run、task hash、argv／cwd、root FileID，一次性核准、到期、拒絕／取消、問題回答及重放拒絕。瀏覽器核准前保存意圖；實際 command/exec 可在零模型呼叫下驗證，不代表所有模型提權分支皆已實測 |
| 工作區與機密供應 | 非 Git／首次提交、registered isolated worktree、direct 基線與互斥鎖；每次開始須人工預覽及私有 permit。逐檔選取秘密、10 分鐘 lease、原目的 baseline 備份／復原；hash 或 FileID 改變則保留待覆核。已追蹤 HEAD 秘密與 Git 歷史可讀範圍須明確核准，不宣稱偵測所有歷史秘密 |
| Git／成果移交與整合 | 最新 HEAD／index／全檔 bytes 快照、一次性 ticket、同 repo worker 鎖、共用引用檢查、native 成果 copy、階層收據鏈與可恢復 cleanup。拒絕 assume-unchanged／skip-worktree 及 Git stat cache 隱藏差異；不清除使用者 flags 或修改 Git 設定。合成 repo 成功與拒絕路徑已測，未對真實專案 push |
| 整理／還原／空白項目 | 預覽及逐項選取、native FileID／tree hash 計畫、durable planned／complete／partial 收據、同名不覆蓋還原與 legacy 重新確認。實測 NTFS 搬移／復原及拒絕；目錄 rename 前後重驗不能稱為整棵內容原子凍結 |
| MCP／同作業委派 | Browser 與 capability credential 分離、DPAPI sealed transport、scope／run／TTL／call budget、控制路徑拒絕、200 KiB UTF-8 檔案 broker、逐次命令核准與指定模型的一次委派。註冊須預覽具體設定 patch，AI token 不能當人工核准 |
| 遠端入口 | Windows HTTPS／本機 TLS 證書、登入／撤銷、Host／Origin 與來源入口檢查。使用本機 TLS fixture 驗證；不代表公網、DNS、防火牆、第三方憑證或手機外網連線已驗收 |
| 圖片 | 原生圖片檢查、常用格式及 HEIC／HEIF 轉換；私有 FFmpeg bytes 與來源 metadata 固定。成功及破損／超限／來源改變拒絕使用合成檔案驗證，未上傳真實使用者圖片 |
| 啟動／更新／回復 | DPAPI launcher state、PID＋建立時間＋HMAC 實例核對、背景啟動／重開／明確停止、Hub 重啟；Codex 私有 CLI slot 預覽／下載／探針／回復與版本化安裝器。未知狀態／埠占用／活動作業拒絕；安裝器的合成資料驗證不等同本機正式安裝完成 |
| 台灣繁體中文 | Windows 預設繁中，設定可切換日文並保存偏好；翻譯保留 API／狀態原值及使用者內容。renderer／綁定測試及實際瀏覽器切換已測；CLI 輸出與自訂資料不改寫 |

詳細介面與限制見 [工作區與機密供應](windows/reviewed-workspace.md)、[命令／檔案](windows/COMMANDS-FILES.md)、[MCP 註冊](windows/MCP-REGISTRATION.md)、[原生搬移](windows/ROOTED-MOVE.md)、[整理](windows/MAINTENANCE.md)、[空白清理](windows/EMPTY-CLEANUP.md)、[更新／重啟](windows/UPDATE-RESTART.md)、[語言](windows/LANGUAGE.md)與 [安裝／回復](windows/INSTALL.md)。

## Codex 沙箱與資料邊界

- 要求 Windows elevated、workspace-write、on-request 並核對 app-server 回報。合成探針確認專用沙箱帳號、工作目錄可寫、相鄰範圍外寫入被拒絕；失敗不得改成 bypass。
- **讀取不限於 task 目錄**：已實測合成 sibling 範圍外標記可讀。工作複本及 MCP 安全檔案 broker 不等於 Codex 自身只能讀該範圍。
- **`networkAccess=false` 不是完整斷網**：已實測本機 loopback 仍可連線；未宣稱涵蓋所有主機讀取或外部網路目的地。每次工作區／命令確認均揭露這兩項限制。
- 所選秘密與一般工作內容可能由 Codex 傳至 OpenAI 模型服務；逐檔核准列出檔名與目的地，不顯示秘密值。TTL 清理不代表抹除來源原檔、Git 歷史、既有 baseline 或所有副本。
- 程序監測使用 Windows CIM 與 PID／建立時間，原生 cwd 查詢仍有平台／程序權限限制；未知或不可歸屬狀態保守阻擋，不當成零程序。
- managed Job／ancestor HANDLE 負責 owned 程序樹退出與路徑身分，不能延伸為 Hub、npm 專案測試或任意 CLI 的 OS 沙箱。

## 環境與操作

Claude／Grok 使用各自固定的 Windows sandbox plan、供應商出口 broker 與回合 scope。**同一 CLI 程序內的一般命令仍能讀取自身唯讀登入檔**，controller 不讀取或複製其內容；網域白名單不等於檢查 TLS 內容。未知工具、未核准模型及 TaskOutput／WaitTasks／KillTask 不自動放行；細節見 [原生 CLI 資安邊界](windows/NATIVE-PROVIDER-INTEGRATION.md#資安邊界)。

前置：Windows AMD64、本機 NTFS、Node.js 22 以上、Git、已登入且白名單中的 Codex CLI 0.154.0 或 0.164.0（精確版本雜湊），以及 Windows .NET Framework C# 編譯器。原生 helper 從本分支原始碼建置。未驗證的版本、架構、檔案系統或 vendor inventory 不會靜默替換已核准環境。

版本化安裝使用 [INSTALL.md](windows/INSTALL.md) 的已審閱套件與 manifest SHA-256。開發／測試 checkout 可明確指定資料 Root：

```powershell
$env:HUB_ROOT = 'C:\path\to\AI-Workspace'
& .\hub\start-windows.ps1
# 等 owned 作業結束後停止
& .\hub\start-windows.ps1 -Stop
```

啟動器建立缺少的 `_hub`、`Product`、`Work`；既有 roles.yaml 不覆蓋。關閉瀏覽器保留背景服務，再次啟動可重開同一服務。啟動器只開乾淨網址（不含 token），不再開啟本機登入確認視窗。同機使用與原版 Project Hub 一樣不需登入；任何本機程式只要通過 Host／Origin／X-Hub 檢查，都能操作 Hub，包括核准命令與讀寫檔案。能連到此入口的 AI 命令也能自行核准。`-NoBrowser` 供無視窗驗證，不開瀏覽器也不開確認視窗；`-Stop` 透過已核對服務呼叫停止 API，活動作業存在時不強制終止。PowerShell 政策受管控時先檢查有效來源；本分支不永久修改執行原則，也沒有宣稱提供正式程式簽章。

本機控制服務只綁 `127.0.0.1`，不要求登入 cookie；Host／Origin 檢查、X-Hub 操作標頭及中繼標頭拒絕保持生效。遠端 HTTPS 預設關閉，仍須另行核准並以通關密語登入；MCP Bearer 不能操作 owner-only API。AI 子程序不繼承 Hub 登入、MCP 或 owner 控制環境。launcher token 以 DPAPI CurrentUser 保存，重開先核對 PID、建立時間與 HMAC；啟動器 token、實例 proof 與相容登入 API 保留供停止／重啟使用；DPAPI 與本機 journal 不隔離同一登入使用者，也不是簽章、WORM 或外部 attestation。

清理失敗保留紀錄及互斥鎖，即使 chat idle 也有［重試停止／清理工作區］。冷啟動沒有當前 controller owned flow 時，不能由 metadata 重建 permit；舊 secret lease 無程序退出證據仍需人工覆核，未知／存活 PID 不自動解鎖或刪除。

「執行專案測試」只在 package.json hash／具體命令核准後執行 npm，停用 pre/post hooks。專案程式以目前 Windows 使用者權限執行，可讀主機與存取網路，**沒有自動套用 Codex 沙箱**；managed Job 只管逾時與程序樹清理。

## 依賴與驗證

2026-10-19 validation-23 指定離線回歸：Node 861／861、Python 103／103，586 個來源檔案在測試前後一致。另有 Claude 正式17、Grok 正式15 各三回合的本機真實模型合成驗收，兩份程式來源清單皆逐 SHA-256 綁定相同凍結來源。正式來源驗收與正式安裝／安裝後 smoke 分別報告；不能由 fixture、CLI ready 或模型清單推論登入可用或安裝完成。

node-pty 固定 1.1.0，使用 `npm ci --ignore-scripts` 與已審閱 Windows prebuild；未執行套件安裝 hooks。2026-10-08 官方 npm lockfile 弱點查詢為 0 筆已知弱點，這不等於應用或原生二進位無風險。PTY adapter 的 worker disposal 依賴該固定版本內部欄位，升級需重驗。

FFmpeg 9.0.2 為固定 SHA-256 的私有 GPLv3 依賴，版本化套件保留 LICENSE、README 與來源 metadata；source-only archive 不包含二進位。Codex 更新使用 0.154.0／0.164.0 已審核版本清單，各自核對 binary 與完整 vendor inventory；未知版本禁止啟用，失敗或封鎖候選會清除，作用中及上一個槽位保留。0.164.0 尚待真機驗收，0.154.0 保留回滾用途。

Node 測試入口為 `npm --prefix hub test`。正式交付報告逐組列出成功、拒絕、失敗修復與重跑證據；不能把合成 fixture、分組重跑或平台 skip 合稱所有平台單次完整套件通過。早期尚無Python tests時曾有ImportError；目前已有`tests/`，2026-10-18依`$env:PYTHONPATH="src"; python -m unittest discover -s tests -v`執行103項通過。這些是既有離線worker／契約測試，不代表provider live驗收。

模型清單查詢不送推論提示，帳號可用模型仍會變動；Hub 不因重新整理清單自行替換使用者所選模型。未安裝 WSL、未改全域 Codex 設定或防火牆；原生沙箱依 Codex 自身的 Windows 設定，其專用沙箱帳號不是 Hub 自建身分隔離保證。歷史設計與實作範圍見 [已核准計畫](../docs/superpowers/plans/2026-10-08-windows-feature-parity-implementation.md)。

## Codex 雙版本審核邊界

Codex helper 只接受 `lib/codex-versions.js` 的 0.154.0／0.164.0 與各自精確
SHA-256；原生沙箱使用作用中槽位的雜湊，沒有槽位時仍須核對解析到的全域檔案。
未知版本回報 `NATIVE_CODEX_VERSION_UNREVIEWED`，引導至「設定 → AI 的更新」。

0.164.0 將 elevated 稱為 legacy。此分支固定 `windows.sandbox="elevated"`，
另外使用 `-c features.windows_sandbox_service=false`、`-c windows.allow_mxc=false`、
`-c features.prefer_mxc=false`，不使用舊版不接受的 `--disable`。
Windows Codex 終端機一律加上 `-c features.daemon_auto_start=false`，僅作用中
槽位為 0.164.0 時再加 `--no-daemon`。CODEX_HOME 仍共用，分離決策尚未執行。

這是程式與離線 fixture 的相容支援，不代表 0.164.0 沙箱已通過真機驗收。
仍須檢查首次 UAC／佈建、service 與登錄狀態、檔案／網路隔離、Job 清空、
取消／EOF、daemon、舊對話續接與 MCP 實際工具握手，並演練回滾 0.154.0。

重型測試（reviewed-workspace、windows-merge-api、app-ui、start）必須以 `--test-concurrency=1` 依序執行；完整序列入口為 `npm run test:serial`。
