# 專案搬移更新 — 2026-10-20

目前開發專案：`D:\@專案\project-hub-v4.68.2-WIN`。

C 槽完整回復備份：`C:\Users\user\Documents\Codex\2026-10-08\https-github-com-kieiken-project-hub\work\project-hub-v4.68.2`。Windows 拒絕備份改名（EPERM），因此原位置保留為備份；後續開發請使用 D 槽。

歷史驗收證據及 helper 保留在原 Codex 工作證據目錄。舊 helper 的 REPO 常數與相對路徑必須重綁至新專案，並核對來源後再執行。

搬移驗證：3,035 個既有檔案 SHA-256 一致，Git HEAD 與原未提交變更保留；新位置 28 項 Node、103 項 Python 測試通過。新加的本接手文件是搬移後唯一額外檔案。

本次沒有變更安裝版、既有 DataRoot、登入資料或模型授權；一次性瀏覽器登入的正式接線、重新安裝及安裝版畫面／模型驗收仍待完成。

---

# Claude／Sonnet 接手：Windows Project Hub 一次性登入與安裝版驗收

更新：2026-10-20，台灣時間。使用者最新指示：**「完成這階段寫下進度給 Claude，你的額度快沒了。」**

## 先讀結論

**本階段完成的是獨立登入元件、拒絕測試與接手資料。整項 Windows 安裝版 UI／模型驗收尚未完成。**

- 一次性登入狀態機及 HTTP handler 已加入開發來源，28項 Node 測試通過（21項狀態機、7項真實 loopback HTTP 測試）。
- Python 回歸103項通過；JSON Schema／範例、JavaScript語法及 `git diff --check` 通過。
- 開始本階段前的586個來源檔案逐 SHA-256 保持原樣；本階段只新增8份來源／測試／契約文件。原有使用者、Cursor及先前移植變更均保留，沒有 commit、stash、reset 或覆蓋。
- HTTP handler **尚未掛到真實 server**，新登入 UI **尚未啟用**，原生確認控制器 **尚未通過**；沒有建新套件、沒有安裝新版本、沒有執行安裝版 Claude／Grok 模型回合。
- 4546合成Hub已用原生啟動器正常停止；原正式4545及其資料本輪未啟停或修改。所有本輪 Sonnet 程序與 broker 均有退出清理收據。

請直接接續以下工作，不要把這份文件當成整項任務通過，也不要重做已通過的歷史探針。

## 目標與既有授權

原目標：一般瀏覽器分頁操作**實際安裝版**，使用新建合成專案逐一驗收 Claude／Sonnet 及 Grok 4.6 的自主改檔、一般命令、原生子代理、Hub MCP／同作業委派、原生 session 對話續接、越界拒絕與停止清理；有問題交 Sonnet 修正。

使用者已明確選擇並核准：**「採 Sonnet 的一次性核准登入修正，避免 owner token 進入網址／程序參數。」** 這項方案不再等待重新選擇。額外擴權、不同目的地／真實私人資料、認證更新或自動審查明確拒絕的動作，仍須依既有邊界處理。

產品是 Chat／CLI 多模型開發與同任務續接，**不是 computer use 產品**。畫面自動化只用於此次驗收，不可因此把 computer use 整合進 Hub。Canva也只是先前設計工具，不能加入產品依賴。Windows原生是目前方向，不能再改回 Linux／Hyper-V 或持續增加探針。

## 主要位置

任務根：`C:\Users\user\Documents\Codex\2026-10-08\https-github-com-kieiken-project-hub`

開發來源（大量既有未提交變更，務必保留）：
`D:\@專案\project-hub-v4.68.2-WIN`

來源Git HEAD：`9b5ba54c6f73c8a72290e6901b498891b970cb9e`；branch `windows-browser-mvp`。任務根本身不是Git repo，Git命令必須指定正確工作目錄。

既有凍結候選（不要修改）：
`C:\Users\user\Documents\Codex\2026-10-08\https-github-com-kieiken-project-hub\work\project-hub-native-release-04`

凍結commit：`0a16530d542e2052c625ed411d76a9dfa62abc0a`。

工作證據根：
`C:\Users\user\Documents\Codex\2026-10-08\https-github-com-kieiken-project-hub\work\claude-grok-native-20261018`

本階段證據：其下 `browser-login-integration-20261020\summary.json`，含來源清單、雜湊、測試範圍、清理與尚未完成的旗標。

## 安裝版與歷史證據：請分開看

- 安裝名義根：`C:\Users\user\AppData\Local\ProjectHub`；不要替換成其他 InstallBase。
- 實體 MSIX 根：`C:\Users\user\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\ProjectHub`。
- 目前選中版本：`4.68.2-windows-codex-0a16530d542e`，634檔。
- Manifest SHA-256：`9ce09c33722fc5a0fffc5de8662092181714de53b38a554feed0ed2563e375bf`。
- 本次停止合成Hub前再次經固定的 `Installer.selected()` 完整核對安裝檔；未改 current pointer 或安裝內容。
- 正式 DataRoot：`C:\Users\user\Documents\AI-Workspace`，port4545。包含私人專案；不能用來送合成模型驗收。
- 既有桌面入口：`D:\USER\桌面\Project Hub.lnk`。其舊slot wrapper會解析current再啟動選中版本，先前已驗證；不要因wrapper路徑較舊就擅自重寫。

歷史來源模型驗收：Claude formal17、Grok formal15，各3回合通過；源碼與validation23綁定。歷史離線861 Node／103 Python、候選24 native測試、安裝bytes與啟停smoke均有報告。**這些不是安裝版 UI 點擊／模型驗收。**

參考：`FORMAL-HUB-ACCEPTANCE-20261019-FINAL.md`、`WINDOWS-NATIVE-DELIVERY-20261019-04.md`、`installation-04\delivery-summary.json`。不要重新解釋那些歷史失敗為成功，也不要把10/19「服務留運行」當作目前4545現況。

## 本階段新增的8份來源

相對開發來源根：

1. `hub/lib/browser-login.js`
2. `hub/lib/browser-login-http.js`
3. `hub/test/browser-login-core.test.js`
4. `hub/test/browser-login-clock.test.js`
5. `hub/test/browser-login-http.test.js`
6. `hub/windows/BROWSER-LOGIN.md`
7. `hub/windows/browser-login.schema.json`
8. `hub/windows/browser-login.example.json`

`summary.json` 保存每份 bytes／SHA-256。`primary-baseline.json` 保存開始時586份來源的完整摘要。

曾整合的瀏覽器草案已保存至：
`browser-login-integration-20261020\proposed-local-auth.js`。

**它沒有啟用。** 開發來源的 `hub/public/local-auth.js` 已回到本階段開始前逐位元相同的狀態，因為 server／launcher尚未完成接線，不能留下啟動即損壞的半套UI。其餘原有586份來源同樣逐位元保留。

## 一次性登入已測契約

- `BrowserLoginFSM`：`createPending()`、`approve(id)`、`pollAndConsume(id,nonce)`；最多8筆、60秒、單次核准與消耗；時鐘無效或倒退會撤銷待核准狀態。ID32小寫hex，nonce64小寫hex。
- HTTP module `create({auth,port,readBody,send,fsm})` 回傳 `{handle}`。`readBody` **回傳已解析JSON物件**，不是原始字串。
- 只處理三條POST：`/api/local/browser/begin`、`/poll`、`/approve`。其他路由回false。
- Begin／poll：精確Host／Origin、X-Hub、loopback、無Bearer／forwarded；HttpOnly pending cookie保留nonce，JSON只回public requestId。
- Approve：必須既有owner cookie；native controller可不帶Origin，但若有必須與Host精確相符；沒有owner cookie不能讀取body、更不能核准。
- Poll只有原pending cookie＋對應ID，在owner批准後可單次取得既有owner session cookie；未批准202，過期／錯誤／重放409。
- Cookie不隔離TCP port。帶port的pending cookie名稱只是避免覆寫，不可宣稱port隔離。

測試假Cookie與隨機pending只在隔離HTTP fixture中有作用，沒有接觸供應商或實際登入檔。

## 本輪已執行的驗證

在開發來源的 `hub` 目錄執行：

```powershell
& 'C:\Program Files\nodejs\node.exe' --test test/browser-login-core.test.js test/browser-login-clock.test.js test/browser-login-http.test.js
```

結果：28通過、0失敗／跳過。log為本階段 `node.stdout`、`node.stderr`。預設外層沙箱會使loopback連線EACCES；最後是在核准的主機環境跑真實本機HTTP，**沒有降低斷言**。測試原先用fetch驗錯誤Host，但fetch會改寫Host；已改用原生`http.request`保留故意錯誤的Host，拒絕路徑通過。

在開發來源根執行：

```powershell
$env:PYTHONPATH='src'
& 'C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -X utf8 -m unittest discover -s tests -v
```

結果103通過，log為 `python.stdout`、`python.stderr`。另完成Node語法、Schema／範例與diff檢查。**尚未跑整個既有Node套件、原生新登入控制器、真實server掛接、瀏覽器新UI或新安裝版模型。**

## Sonnet已做什麼、哪些初稿不能直接用

本輪實際CLI觀測模型均為 `claude-sonnet-5`，工具／MCP／保存停用，使用通用契約，不上傳私人專案內容；每次上限4分鐘／US$1。四次合計CLI回報費用US$0.45324，非帳單保證。執行與清理metadata位於：

- `sonnet-browser-login-integration-04\sonnet-execution.json`
- `sonnet-browser-native-controller-05\sonnet-execution.json`
- `sonnet-browser-http-repair-06\sonnet-execution.json`
- `sonnet-browser-native-controller-07\sonnet-execution.json`

狀態機基底是前輪 `sonnet-browser-login-repair-03\combined`，已經獨立修正時鐘撤權回歸。

**不要盲用初稿：**

- HTTP04原稿把parsed JSON當字串、錯認FSM pending回應，且測試檔只有註解。開發來源handler已整合Sonnet06的reader修正、正確NOT_APPROVED分支、null-prototype cookie map及owner前的Cookie檢查；真實HTTP測試由Codex補齊。
- UI06錯把`hubAuthReady`設true、使用不存在的session路由及錯誤`X-Hub1`標頭。不要整份複製。採另存的 `proposed-local-auth.js` 作接線基礎；它目前只做過語法檢查，還需UI／Promise／超時／重試驗證。
- Native05使用PS5.1不支援的ArgumentList、錯誤JS argv索引、把JSONproof當裸hex、錯誤標頭等，**拒絕使用**。
- Native07雖改為重用canonical launcher，但仍有明確錯誤：LauncherPath指到windows子目錄（正確為hub/start-windows.ps1）、StatePath缺 `_hub`、listener只找任一合格項而非拒絕全部其他項、部分大小寫／base64／邊界檢查不足、WinForms事件結果作用域須修。未放進產品來源、未執行。
- Dot-source launcher會在同函數scope寫 `$stateFile`、`$statePath`、`$hubDir`、`$root`、`$port`、`$token` 等名稱；新控制器持有的state FileStream應使用獨有變數名，例如 `$approvalStateStream`，避免被覆蓋而失去鎖／Dispose。可重用既有launcher的PID／DPAPI／HMAC驗證，但先驗既有運行instance，不能失敗時擅自啟動新服務。

這些初稿失敗保留為證據；原生controller必須修正並通過後才可接入或安裝。

## 自動審查拒絕與清理

先前 `start_installed_ui_01.ps1` 想沿用舊fragment bootstrap交給Chrome；自動審查因owner token進argv拒絕。**從未執行該helper／交接，不能再用間接方式繞過，也不應向使用者重新推銷該方式。使用者已選更安全的一次性方案。**

安全service-only替代 `start_installed_ui_service_01.ps1` 曾用已安裝04版啟動全新合成Root、port4546。Chrome一般分頁已真實顯示「請由Windows啟動器開啟」，未登入；沒有Hub模型回合。

合成Root：`C:\Users\user\AppData\Local\Temp\ProjectHubUiAcceptance-R038-73bda8ff96114880b71f508b5715a7b7`。

本階段結束以相同helper `-Stop` 通過owner檢查後正常停止，收據為本階段 `synthetic-stop.stdout/stderr`。合成檔案仍保留；不得因此推論其他歷史程序均清理。本次沒有活動Sonnet程序；四份execution metadata均為cleanupVerified／brokerClosed=true。

既有Chrome登入前截圖：`installed-ui-acceptance-01\01-browser-login-required.jpg`。這不是新登入功能或模型成功證據。

## Claude接下來按此順序做

1. 讀新元件／契約與本文件；核對summary中的來源hash。不要重建原生CLI／OS沙箱架構。
2. 修好並驗證native controller：精確DataRoot／hubDir／port、state regular file與上限、PID／建立時間／完整listener、HMAC；owner secret只在此程序記憶體。保留HTTP Cookie owner guard，token不得進URL／argv／env／檔案／clipboard／模型prompt。
3. 掛上Normal server handler；RecoveryOnly也要支援同樣三條路由及靜態local-auth.js，但不能因此啟動normal Store／CLI或放寬復原API。檢查 `web-chat-admission.restrictRoutes` 與復原頁舊fragment程式。
4. 合併另存的UI草案，保留 `window.hubAuthReady` Promise；launcher只開乾淨URL。原生確認視窗獨立子程序開啟、只傳公開Root／port，避免阻塞installer目前45秒launcher等待；`-NoBrowser`不可開瀏覽器／表單。
5. 真實HTTP掛接、nativecontroller成功與拒絕、瀏覽器Promise／過期／重試及RecoveryOnly測試，並跑受影響既有測試與Python103。保持README／契約／範例一致，不能把元件測試宣稱端到端通過。
6. 凍結新候選、依既有版本化packager／manifest建置，保留回復版本；通過才安裝。不可直接改installed檔案或current pointer。沿用已核准安裝器與名義InstallBase，保留桌面入口。
7. 用新合成DataRoot啟動**實際安裝bytes**（不能混入正式AI-Workspace）。一般Chrome分頁點擊begin，讀公開requestId，透過nativecontroller核准精確ID；再做新專案／作業／模型／工作區核准的真實點擊。
8. Claude及Grok各獨立task，最多3個Hub回合（包含一次Hub排隊委派）、每回合4分鐘；同模型短前景原生子代理、一般Node命令、固定MCP、一次hub_delegate、最後同native session回想未存檔marker並再次改檔測試；越界寫入應被拒絕。
9. 必須等真實provider terminal result、owned close與Hub idle；中途MCP回報不算完成。驗證程序／MCP／queue／workspace清理，保存實際畫面與檔案結果，最後才報安裝版驗收狀態。

UI既有文案缺陷也要在驗收時修：設定卡仍說Claude／Grok未驗證、空對話只說Codex可執行、人工核准標題硬寫Codex。不要把錯文案誤認backend不可用。

## 不可放寬的安全界線

- Claude自身既有 `.claude/.credentials.json`、`.claude.json` 唯讀；Grok `.grok/auth.json`唯讀、僅既有auth.json.lock可寫。控制器不讀／複製／雜湊provider登入內容。需要更新登入則停止，不自行改憑證。
- 一般命令與CLI同程序，因此可能讀到其自身唯讀登入檔；核准畫面必須誠實揭露，不能宣稱憑證對命令不可見。
- OS直接網路false；broker僅Claude的`api.anthropic.com`／`claude.ai`，Grok的`api.x.ai`／`cli-chat-proxy.grok.com`，以及原回合精確本機MCP路徑。不得擴大出口、關驗證或改bypass。
- 固定CLI／sandbox雜湊、實體runtimeBase、root fingerprint／FileID、同模型／session binding、owned Job退出證據均維持。
- Hooks、全域MCP、外部技能／記憶自動載入、網頁工具停用。未知工具保持人工邊界；TaskOutput／WaitTasks／KillTask不得整批自動放行。
- 僅合成資料送Anthropic／xAI；不可把正式工作區或其他私人專案帶入。Grok來源仍只有官方HTTPS及hash一致，沒有發行者簽章。
- 原Codex功能與繁中保留；Agy、Claude／Grok互動PTY、完整上游4.90Beta parity仍各有未完成項目，不能宣稱全部完成。

## 建議接手第一句

「先核對本文件及 browser-login-integration-20261020/summary.json，接續已核准的一次性登入接線；修正native controller並驗證後再安裝，最後完成安裝版Claude／Grok的真實UI、自主執行與續接。保留既有變更與全部資安限制，不把本階段28項元件測試當端到端成功。」
