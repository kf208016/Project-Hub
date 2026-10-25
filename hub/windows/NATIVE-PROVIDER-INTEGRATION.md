# Windows 原生 Claude／Grok 正式接線

更新2026-10-19：Windows 原生 Claude／Sonnet 與 Grok 4.6 的來源版本已各完成本機合成三回合正式驗收，涵蓋自主改檔、一般 Node 命令實際結果、原生子代理、固定 Hub MCP、Hub 排隊委派、同 session 對話續接、越界寫入拒絕與程序樹清理。validation-23 指定離線回歸為861項 Node／103項 Python，測試前後586個來源檔案一致。Claude 正式17／Grok 正式15 的220份程式來源清單逐 SHA-256 綁定相同凍結來源。原 Codex 與繁中介面保留，Agy 延後；上游 v4.90.0 Beta 仍有獨立待移植項目。安裝版需另經 manifest bytes 核對及啟動／停止 smoke，本段不表示已安裝。早期失敗結果完整保留，不能轉為成功證據。

## 使用流程

2026-10-23 模型選單：Windows 只讀取 tools home 下 `.claude/cache/model-catalog/*.json` 中修改時間最新的 CLI 模型目錄；啟動（含 dry run）、狀態及 Claude 送出前更新，後兩者最多每 30 秒檢查一次，mtime 未變時不重讀。設定中的重新取得也只讀此目錄，不啟動 Claude、不讀認證內容。缺漏或格式錯誤保留先前目錄；首次沒有目錄時顯示 `CLI預設`、`Sonnet`。

有目錄時選單為 `CLI預設` 加目錄模型；舊 `Sonnet`、`Opus 5.5`、`Fable 5.1` 選擇仍可解析，未知名稱拒絕。指定模型的思考強度須符合該列 `thinking.effort_options`，不自動降級。例如目錄只提供 `low`、`high` 時選擇 `Ultra` 會在啟動前拒絕。

`CLI預設` 以明確標籤綁定原授權，原生 argv 省略 `--model` 與模型覆寫設定，保留 `--effort`；init 必須回報有效 `claude-*` 模型。原工具審批規則以此回報模型判斷同模型子代理，沒有放寬工具或網路權限。控制器發行的 Claude MCP 委派可綁定字面值 `CLI預設`，仍限原 task/run、一次使用與精確相同選擇；Codex／Grok 及瀏覽器授權不接受此新增值。此模式下 CLI 預設模型由 CLI 自行決定，跨回合可能隨 CLI 設定改變。

Fable 5.1 原生回合與其他模型使用同一啟動流程；本輪未新增 Fable → Astra 額度接手，額度錯誤仍顯示失敗。此段描述來源實作與離線測試範圍，不代表真實 CLI／帳號已完成新模型驗收。

1. Chat 選擇 Claude／Sonnet 或 Grok／Grok 4.6，指定模型與思考等級。保留 Codex、繁中及既有專案功能。
2. 預覽本次工作區與可選供應檔案，核准精確模型目的地。工作複本／本體及既有機密供應流程沿用現有控制器。
3. 本機已登入 owner 核對 CLI／sandbox 固定版本雜湊、認證唯讀路徑、Grok 既有鎖檔、session／暫存路徑、出口與命令風險，四項確認後建立程序內一小時授權。預覽十分鐘失效、一次使用；重啟撤銷。
4. 核准範圍內的檔案工具、一般命令、同模型 CLI 子代理及明列 Hub MCP 可自主執行；未知工具、不同模型或明顯認證讀取命令留給 owner。純命令分類器無法理解任意程式碼，OS 限制仍是執行邊界。
5. Hub `hub_delegate` 僅能使用控制器發行的同作業 actor／model，每回合一次；在原對話排隊。MCP 參數不能自選 actor 或擴權。既有省略 actor 的 Codex grant 保持原行為。
6. 下一回合核對原生 session 與工作區、帳號 profile、runtime profile。變更或保存失敗拒絕啟動，不靜默建立新對話。切換至未核准的 OpenAI 目的地時另行確認，沿用同一有效工作流程。
7. 停止／撤銷先撤 task/run MCP，停止 owned 程序與 broker；只有收到真實程序樹退出收據才釋放工作區。缺收據或清理失敗保留 busy 及紀錄。

Claude／Grok 這批接線提供對話畫面的自主 CLI 工具；互動 PTY 終端機尚未接線，保留明確封鎖，不能把 Chat adapter ready 當作該入口也可用。Codex 原終端機保留。

`native-chat-permission.js` 將原生 Chat 的權限解析與 legacy raw command 分開：必須持有controller註冊的私有authority，非執行命令的 sentinel 只交給native handler。Chat／queue／同task委派走此入口；偽造或過期authority拒絕，raw PTY／spawn沒有一併放行。無模型的正式HTTP回歸已確認兩provider能抵達owner授權提示；測試強制阻止provider啟動、vendor出口及認證內容讀取。

Claude 保留 `--restricted`，以固定具名開發工具清單恢復 Bash／PowerShell 與原生 Agent；不使用 `default`／preset 混合，也不設定 bypass。具名清單綁入 runtime profile，舊 preset 的授權與 session 拒絕沿用。所有工具仍走原權限回呼、OS 限制與 owned Job，列名不代表自動授權。

原生 Agent 的首筆 child user 提示只在本回合已知 Agent／Task parent 下當作惰性資料接收；它不能產生核准、session 綁定、回答或完成狀態。子工具結果須對應同一 parent 下已登錄的工具，未知 parent、跨 sibling 結果、重複提示及結果重放拒絕。此機制與原工作區／帳號／runtime session 續接綁定分別檢查。

固定版 Claude 的 `task_started`、`task_progress`、`task_notification`、`task_updated`、`background_tasks_changed`、`task_summary` 只當作任務通知忽略；payload 不建立工具 ownership、核准、回答或完成狀態。原先 session、UUID replay、bounded decoder 與 result 檢查仍先執行；其他未知 system subtype 拒絕。細分診斷只輸出固定 code，不保存原始 frame 或識別碼。

Grok 正式 permission 使用 canonical `variant`，顯示 title 可能是檔名或子代理描述。分類器精確核對 variant／ACP kind，再沿原有檔案別名、保護路徑、命令、同模型子代理與 MCP validator 判定；未知 variant 保持人工核准，錯誤 kind 或相互矛盾的既知 title 拒絕。`SearchReplace`、`Write`、`Task` 的呈現名稱不再造成無限等待 owner，但這項相容修正不增加 CLI tool filter、OS grant 或網路出口。`TaskOutput`／`WaitTasks`／`KillTask` 仍未自動放行。

Grok 只接受固定 runtime 的 `_x.ai/session_notification` 子代理公告：父 session、可信 parent prompt、已觀測 Task quota、指定模型與一次性 child／attempt 必須相符。一般工具通知保持精確 owner；子代理沿用父層 permission transport，因此反向 permission 僅可依「普通初始 ToolCall 已登記的工具 owner＋該 owner 已登記的 ancestor」路由。permission 不能建立 owner、prompt 或 Task quota；先到的 request 只在原期限內有界等待初始通知，重播／越界／到期均拒絕，queue 與待核准項目合計最多16筆。子對話內容不當成 root 回答，停止會清空待處理狀態。此協定相容不新增工具、OS grant 或出口。

## 資安邊界

- 原生 CLI 只能唯讀使用自身登入檔；控制器只看 metadata，不讀取、複製或雜湊登入內容。Grok 只有既有 `auth.json.lock` 可寫；不建立或更新登入檔。
- **具備一般命令的 CLI 也能讀取自身唯讀登入檔。** 此架構無法承諾同程序認證對命令工具不可見；目的地授權明示此限制。網域白名單不等於已解密或檢查供應商 TLS 內容。
- Windows Codex sandbox 關閉直接網路，固定 provider broker 僅允許已列 Anthropic／xAI 主機；不提供 Linux／Hyper-V 或 computer use。
- Hub MCP 經同一認證 proxy 的有限 HTTP 轉送，只允許精確 loopback port 的 `/api/mcp/tools` 和 `/api/mcp/call`；另核對回合 token／run／POST nonce、2 MiB 上限，不允許其他本機服務、管理端點或任意 CONNECT。
- 暫存、Grok 私有狀態與 scoped MCP token 從 controller 核對的實體 `runtimeBase` 衍生，置於 `runtime/<rootFingerprint>/<actor>/`，不寫進 Git 工作成果。token 不出現在 CLI 命令列。Claude 原生 session 仍位於該 CLI 專用 projects 子目錄。
- MCP token file 僅 worker 唯讀、短期 task/run scope、最多200 calls／四分鐘，回合結束撤銷再核對並刪除。這不是 provider 登入檔，也不是 Hub owner 登入 token。
- `.git`、`.agents`、`.codex`、`.aws`、`.ai/chat`、`.ai/web-chat` 及固定 runtime 受保護；一般程式不能藉 legacy raw launch 繞過私有 native handler。
- hooks、外部技能自動發現、全域 MCP、記憶載入及網頁工具停用；只接受控制器明列註冊。模型須明確選取（含 `CLI預設`）；Hub 不自動改選另一模型。

## 固定執行檔與工具契約

Claude在本機owner預覽時使用 `<runtimeBase>\runtime-binaries\claude\<固定SHA256>\claude.exe` 私有單一link副本，保留原npm執行檔。`runtimeBase` 與其他原生狀態使用同一個已核對實體根。controller透過現有scoped-file HANDLE broker核對來源hash後create-only發布；不下載、不執行安裝腳本、不複製認證、不覆寫未知cache。只有private-binary-copy來源可為多link；執行與cache檔仍需單一link。新512MiB上限僅限controller私有binary模式，其他file／artifact／MCP門檻不變。

`runtimeBase` 只由 controller 私有 profile 提供，不接受 HTTP／MCP caller 注入。resolver 從既有 `ownerHome\AppData\Local\ProjectHub` 經 `fs.realpathSync.native` 取得實體路徑，只接受原路徑或同一 owner 下符合固定 `Packages/<package-family>/LocalCache/Local/ProjectHub` 結構的 MSIX 路徑；仍由 strict HANDLE identity 核對，不放寬 reparse、final path 或祖先 pin。缺少、越界或無法核對時拒絕，不建立替代根或回退。

兩個 provider 的 `USERPROFILE` 都固定為 `ownerHome`。Grok 的 `HOME`、`APPDATA`、`LOCALAPPDATA`、`GROK_HOME` 仍指向私有 Grok 狀態目錄。這避免 Windows sandbox 將等於 `USERPROFILE` 的 write root 展開為當時既有子項而無法新建 session；不增加 grant 或關閉 profile 保護。

service在建立broker／adapter前檢查binary metadata，host仍在spawn前即時核對。runtime profile policy v4 綁定 provider 路徑、實體 runtime base 路徑與 root fingerprint，並固定 `userProfileMode: owner-home`；base 路徑或實體身分改變時舊預覽、授權與 session 綁定失效，保留原資料並拒絕續接。Grok固定filter使用canonical `run_terminal_cmd`／`task`，不是ACP呈現名稱；完整8個ID固定在service與測試中。Grok 的 `subagentRouting: runtime-parent-prompt-v2` 與固定命令搜尋路徑納入 runtime profile，舊 routing 的授權與 session 拒絕沿用。此次正式驗收覆蓋短原生子代理的公告、工具 owner、祖先 permission transport 與 typed terminal completion；未知工具及未自動放行的背景管理工具仍維持人工邊界。

HTTP只回傳固定白名單的native診斷code，未知code不自動外露。原有schema／example的請求欄位不變；沒有新HTTP／MCP私有copy入口。工作證據見工作證據目錄的 `FORMAL-HUB-ACCEPTANCE-20261019-FINAL.md`。

## API 與驗證

`/api/native-provider/preview|approve|revoke`：僅限本機 cookie owner，拒絕 remote／bearer／MCP caller。請求契約見相鄰 schema／example。`/api/workspace-destination/preview|approve` 處理存活流程的跨目的地確認。

實際驗證須區分純 fixture、真實 loopback helper、OS sandbox、真實模型與安裝版。前兩者不證明後三者。正式合成驗收程式放在工作證據目錄：Claude 使用 `run_hub_native_acceptance_17.cjs`，Grok 使用 `run_hub_native_acceptance_15.cjs`；每 provider 最多三回合／每回合四分鐘。單次驗收失敗即停止並保留結果，修正後另立批次驗證，不擴權；未通過不安裝。

Grok 固定來源只有官方 HTTPS 與雜湊一致性，尚無發行者簽章；此既有來源限制保留。

正式結果、requested／observed model、三回合 session 與委派證據、成功斷言、cleanup 收據及 Hub exit code，見 `FORMAL-HUB-ACCEPTANCE-20261019-FINAL.md`。先前啟動、認證、協定及驗收觀察的未通過結果保留為歷史證據。CLI ready／模型核對不等於登入可用；匹配 RPC 的數字 `-32000` 映射固定 `GROK_NATIVE_AUTH_UNAVAILABLE`，不讀取 error.message/data，沿原清理路徑停止；沒有 ACP error 的靜默認證重試仍可能到 wall timeout。controller 不更新憑證，認證失效須由使用者完成官方 CLI 登入。正式來源驗收成功與正式安裝／安裝後 smoke 分別報告。


## Windows Grok CLI 模型目錄

Grok 模型選單取自 `<home>/.grok/models_cache.json`，只投影 `models[*].info` 的 `id`、`name`、`hidden`、`supports_reasoning_effort`、`reasoning_efforts`（僅取各項 `value` 或 `id`）。不取用同檔的秘密／帳戶欄位、不讀取 `auth.json`，也不啟動 CLI 取得模型。啟動時（含 dry run）載入，在 state 與送出前最多每 30 秒檢查一次 mtime；設定的重新取得動作可立即讀取。缺檔／格式錯誤保留上一份目錄，手動重新取得回報 502。

選單為 `CLI預設` 加上可見模型名稱；無目錄時為 `CLI預設`、`Grok 4.6`。已保存的 `Grok 4.6` 仍對應 `grok-4.6`，未知名稱在啟動前拒絕。`極高` 對應 `xhigh`；有目錄的明確模型不支援所選強度時拒絕，不降級。CLI 預設或無對應目錄的舊模型略過目錄強度檢查。

例如選擇 CLI 預設與高強度時，原生 bridge 的 provider 參數為 `agent --no-leader --effort high stdio`。握手接受符合既有 ID 規則的 `currentModelId`，不傳 `--model` 或呼叫 `session/set_model`；回報模型綁定子代理 scope 與工具政策，後續模型變更仍拒絕。明確模型保留原有選取流程。Claude／Grok 的同作業委派可由 issuer 明確授權 `CLI預設`，其 actor、task、run 與一次使用限制維持；ChatGPT Chat／Claude Chat 不新增模型選擇。

模型目錄驗證使用合成快取、HTTP loopback 與模擬原生協定，包含秘密欄位 getter 陷阱及 JSON 輸出檢查；不代表真實帳戶、模型服務或已安裝版本的 live 驗收。

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
