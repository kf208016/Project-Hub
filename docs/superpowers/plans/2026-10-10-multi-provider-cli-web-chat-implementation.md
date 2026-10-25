# Project Hub 多 CLI／網頁 Chat 實作計畫

> 2026-10-13 核准補充：使用者提供獨立 Linux，核准 `2026-10-13-ssh-linux-worker-design.md` 及保留 Grok 未簽章來源限制，在同一分支依原執行方式繼續。下方 Hyper-V 專屬 R0–R2 條目保留歷史；本次執行以 §15 差異為準。模型／provider 登入、sudo 與全域系統變更未包含於本次核准。

日期：2026-10-10（Asia/Taipei）｜狀態：**計畫待審閱；本輪未寫產品程式、安裝系統功能或呼叫模型。**

## 1. 核准範圍、來源與執行方式

書面設計 `docs/superpowers/specs/2026-10-09-multi-provider-cli-web-chat-design.md` 已獲使用者核准；2026-10-10 使用者另同意由 Codex 直接撰寫計畫，替代未安裝的 `writing-plans` 技能。本計畫依該核准規格與現有實作編排，不假稱使用了缺少的技能。保留開發前的計畫審閱與執行方式選擇。

設計來源 commit：`7bbcee150ea54f3227da1d42d62c88ed4e9ce951`；設計原始檔 SHA-256：`ba76ddcf03433bef1ebeccb3250460ff05a38f9951aa66bfbaf8a133c2737317`。已交付產品基線為 `0583184ee534f2e08a0b037858a99bce63ad9fce`。原生 Codex 安裝報告是 2026-10-09 的交付證據，不當成本輪服務仍運作的即時確認。

範圍：保留原生 Codex 全部已交付功能與繁體中文，增加 Claude／Agy／Grok CLI，以及 ChatGPT／Claude 網頁 Chat。網頁 Chat 不接模型 API，採人工送出及貼回；CLI 連線則走各自官方登入及模型服務。保留舊 actor／roles／歷史與日文切換。

建議執行方式：**目前 Codex 在同一聊天、同一分支依階段執行**；代理按明確檔案所有權分工，Root 整合與驗收，不新增其他聊天、不推送 Git。每階段形成可回復 commit；先讀取工作樹並保留使用者變更。系統管理與資料供應僅執行已列明且通過門檻的操作，AI 不取得通用管理權。

## 2. 本輪規劃證據與尚待預檢事項

| 項目 | 唯讀觀測／證據 | 計畫處理 |
|---|---|---|
| OS | `EditionID=Professional`、`25H2`、build `26200.9457`、AMD64 | 使用 edition/build；registry 的舊 ProductName 不作世代判斷 |
| RAM／CPU | 63.92 GiB、16 logical CPU；本次瞬間可用 RAM 20.73 GiB | 啟動前重查，瞬間數值不當未來保證 |
| C: | 總量 429.90 GiB、可用 115.14 GiB | guest、更新及回復檔案有總額上限，防止堆積耗盡 |
| Hyper-V／韌體 | CIM 與 optional-feature 查詢未取得所需存取；SLAT／韌體虛擬化／hypervisor／功能狀態未知 | R0 取得管理員唯讀預檢；未知即不安裝、不啟用 |
| 本機 CLI | 2026-10-09 盤點：Claude manifest `2.1.252`、Grok embedded hint `1.0.34`；指定範圍未發現 Agy | 不執行或更新全域入口；新版本另行 stage／驗證 |
| 原生測試／安裝 | 既有交付報告列分組 gates；歷史全套未單次全綠 | 建立新 baseline，保留既有失敗／未量測，不借用舊結果宣稱新功能通過 |

本機盤點 JSON SHA-256：`b5d8e89c72df6a6fcae8c1c0de7b8d10f84c7ea8e48b1c6bf0d7caf02dad11a4`。本輪唯讀查詢未執行 provider CLI／模型、讀取 auth、下載產物或變更系統。

Hyper-V 還需實際符合 SLAT、VM Monitor Mode、韌體虛擬化等條件；僅有 Professional edition 與 RAM 不算已就緒。[Microsoft requirements](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements)

## 3. 交付批次與依賴

| 批次 | 工作 | 完成門檻／可交付成果 |
|---|---|---|
| I：共用與網頁 Chat | A0→A1→A2→A3→A4 | Codex 回歸＋兩個 web-manual 真實成功／拒絕路徑；獨立可安裝版本，明列三個 CLI 尚未就緒 |
| II：worker 可行性 | R0→R1→R2 | 來源、主機條件、受限控制／egress、whole-process、退出／清理與回收均有證據 |
| III：逐 CLI | R2→C1／C2／C3 | 每 provider 固定版協定與設計 M 矩陣；未通過者保持未就緒 |
| IV：完整整合 | A4＋所有 C gates→D1 | 六入口全部適用 M、Codex 基線回歸、版本套件與安裝／回復驗收 |

網頁批次可與唯讀 R0 調查並行；同一檔案的 mutation、Schema、授權接線與套件產生由 Root 依序整合。CLI 的協定探針必須在已驗證隔離中執行，不先在 Windows 擁有者權限下試跑未知 binary。Agy 的互動限制先驗證，避免先投入完整 adapter 才發現無法保留原功能。

每個可安裝批次發布前都要執行 D1 適用的 source／package／install／rollback gates；第 IV 批才要求全部 worker／provider gates。批次 I 尚未交付的 CLI／worker 項目列待驗，不能因 D1 位於文件後段就免除第一批安裝與回復驗收。

本階段無已量測的完整工期；進度以以上 gates 報告。R0／R2 的實際相容性與協定結果取得後，再細化各 CLI 工時與交付日期；不能把「已列計畫」當已交付。模型費用依 provider 帳號／方案與明示測試內容判斷，網頁 Chat 不新增 API 費用。

## 4. A0：基線、fixture 與資料相容

1. 核對 exact HEAD、乾淨／既有變更、Node/Git、native helper；建立本次 evidence index，記錄 commit、測試類別、命令、exit、log SHA 與未量測項目。
2. 查驗現有 fixtures 只使用 owned 暫存資料與假 CLI，PATH 不落入真 provider。測試 root 使用經驗證的 `%TEMP%` 私有目錄，避開 Documents/ExampleWorkspace 的 Git 祖先；清理前核對絕對路徑、Root FileID 與 owned 程序建立時間。
3. 保留有效 legacy roles、會話、queue、meta；新版 strict admission 拒絕破損 JSON／JSONL、未知版本與跨檔引用。不能靠舊 `chat.read` 忽略壞 row，或 meta／queue fallback，讓新交易看似有效。
4. 遷移採版本化、可驗證快照與失敗不啟用；不改已安裝指標、不匯入 seed 或改寫私人設定。

驗收：有效 legacy round-trip、未知 actor／版本／型別、同 bytes 換 FileID、被隱藏的 Git index flags、fixture 路徑包含與自身程序清理。基線失敗單列，後續回歸與其比較。

## 5. A1：actor registry、模型與授權

新增（待實作）：`hub/lib/provider-registry.js`、`hub/windows/provider-registry.schema.json`、`hub/test/provider-registry.test.js`。

修改：`launch.js`、`roles.js`、`model-view.js`、`cli-platform.js`、`workspace-runtime.js`、`reviewed-workspace.js`、`public/model-order.js`、`public/app.js`、server 的 state／model／owner admission。

- Registry 精確列 `codex/claude/agy/grok/chatgpt/claude-chat`，保留 `claude-code` alias。CLI readiness 與可選角色分開，顯示入口不等於允許 spawn。
- CLI 的具體模型、binary／protocol version、runtime/profile 與目的地必須解析後綁 permit；web-manual 不要求可驗證的網頁模型。取消 regex／未知 actor→Claude fallback，未知值 fail closed。
- 角色、queue、instructions、session、stop／procwatch／transcript／usage／update、MCP 都按同一 registry 判斷；不能留某條 Windows 路徑硬編碼 Codex 或將 `claude-chat` 送進 CLI。
- Provider 切換撤銷舊執行資格，但保留來源內容；只有原 owned 子樹退出、秘密清理與私有回收完成後才允許新 run。跨 provider／model／profile／目的地須新預覽。

Gate：新 registry tests，及 `model-order*.test.js`、`windows-defaults.test.js`、`cli-platform.test.js`、`workspace-runtime.test.js`。保留排序、手機／隱藏模型、未儲存角色、同時更新 409 等成功斷言。

## 6. A2：web handoff 契約與 durable 交易

新增（待實作）：`hub/lib/web-chat.js`、`web-chat-receipts.js`、`hub/windows/web-handoff-writer.cs`；preview／confirm／result／receipt 的 draft2020-12 schemas 與合法／拒絕範例；`web-chat.test.js`、`web-chat-schema.test.js`、`web-chat-receipts.test.js`。

### A2.1 來源與 token

沿核准規格的 48／128／256 KiB UTF-8 上限、5 分鐘 preview、60 分鐘貼回 token。wire UTF-8 與 JSON 解碼後 Unicode scalar validation 分別驗證，拒絕 NUL／孤立 surrogate，不 replacement。模型／使用者內容保持原文。

hash 同時保留 CRLF→LF 的 `hub-completion-crlf-to-lf-v1` 與 raw bytes SHA／FileID；prompt／result 用精確 UTF-8 SHA。來源 manifest 記完整來源 hash、實際擷取與截斷，限定指定作業／專案記事／近期會話；不自動收集 repo／auth／`.env`。

token 用 CSPRNG／用途與 owner/task/actor 綁定；原值不入記錄／URL／localStorage。有限且有效時鐘、wall＋monotonic 到期與倒退拒絕；重啟失去可信期限時不接受新結果。Confirm 一次性、同 requestId＋digest 重試可對帳，不跨 task/provider 續用；owner 只能精確復原已 durable 接受的交易。

### A2.2 原生私有 writer 與所有 writer 互斥

現有公開 `scoped-file` 上限 200 KiB，不能容納 256 KiB 回覆及最壞 JSON escaping。新增僅 controller 可呼叫的 writer，**不提高一般 MCP／public grant 上限**。設計限制：raw result256 KiB、序列化單 row2 MiB、task before／after 各 4 MiB、交易 metadata1 MiB；確切 write bytes 存 create-only 私有 blobs，逐一 SHA／FileID 綁定，避免把全部內容塞進現有 1 MiB journal。

既有會話採嚴格串流解析與累計大小限制，初始新交易 admission 上限 64 MiB；超限明確拒絕新 handoff、不修改舊記錄。限額／disk budget 不足在 `planned` 前拒絕，不能以截斷結果或忽略壞 row 取得成功。以上新 private 上限與操作文件同步，超大舊資料不稱已覆蓋。

同 task lock 涵蓋 handoff、一般 chat append、task metadata、owner 變更及 active workspace admission，不能只鎖新 service 而讓其他 writer 穿過。一般 native metadata flow 的 approvedTaskHash 連續收據維持原契約；web 記事更新透過同一個 controller 驗證的連續收據。active CLI／workspace lease 時首次 web 結果保存拒絕並保留人工草稿；不使用 appendSection 繞過工作授權。

先 durable `planned`，再 `chat_saved → task_note_saved → committed`；綁唯一 row ID、來源檔身分、before／after、完整 blobs，flush／核對後才 emit／回完整成功。中途失敗回 partial 與兩檔狀態，未知／壞 journal／外部改寫保留待覆核；不刪已保存回答、不重複 append、不補假成功。

Gate：每一寫入／flush／重啟位置故障注入，disk full、rename／FileID 變更、壞 JSONL、token expiry、重放／異 digest、結果大小與最壞 escaping、與其他 writers 競爭。沿用 `scoped-overwrite.test.js`、`native-task-metadata-http.test.js`；補原生 NTFS 成功與拒絕實測。

## 7. A3：HTTP、共用網頁 UI 與繁體中文

新增（待實作）：`hub/public/web-chat.js`、`locales/zh-TW-web-chat.json`、`web-chat-http.test.js`、`web-chat-ui.test.js`。修改 `server.js` 的共用 routes／legacy adapters、app 的 gpt helpers、ACTION、i18n catalog 載入及 index script。

- `POST /api/web-chat/preview|confirm|result`、owner 限定 status。明列撤銷入口與 receipt state；未知欄位／型別／actor 拒絕。legacy `/api/chatgpt/prompt` 作固定 ChatGPT Confirm adapter，缺 previewToken／expectedTaskHash／expectedPromptSHA256／confirm:true 回 409；legacy result 缺 receipt/token/requestId 亦 409。
- 保留 owner 登入、Origin／CSRF／Host 及遠端 TLS 限制；MCP／worker 不能核准、存取 owner receipt 或調整此契約。MCP registration 原 routes 保持，普通網頁 Chat 沒有本機 MCP 能力。
- 先審閱 actual prompt／截斷，再複製／開固定 `chatgpt.com`或`claude.ai`，noopener、URL 無 prompt/token；不自動登入／貼入／送出／擷取聊天。
- 現有 gptAsk 的「先 preview 後改 owner」會讓 taskHash 立即 stale：本計畫採**web handoff 不改 owner**，另外明確 owner 修改完成後才可新 preview。貼回僅記事／會話，不 spawn／queue／mark complete；回 CLI 另做新 permit。
- 草稿依 actor/project/task/receipt 隔離，clipboard 失敗、雙擊、reload、過期／partial 均能看見實際狀態與保留內容；不得默送到另一入口。系統 prompt／gptback 預設台灣繁中，保留日文及使用者原文。

Gate：真 HTTP 合成 server `HUB_PORT=0`，無 cookie／錯 Origin／CSRF／MCP token／跨 task／stale／split UTF-8／escaped surrogate／超限拒絕；固定 URL、clipboard failures、XSS、TC／JA catalog 非同步載入、Window timer receiver 及真瀏覽器互動。

## 8. A4：原功能回歸與網頁批次交付

更新 `instructions.js`、`guidance.js`、必要 queue/meta 的新版 strict admission、`hub/WINDOWS.md`與新 `hub/windows/WEB-CHAT.md`。Schema 為明確 required/enum/$defs、`additionalProperties:false`；沿用執行期明確 validators 並測合法／拒絕與共享 constants 的一致性，不把 schema 結構檢查當完整 JSONSchema conformance。

驗收保持 queue 持久化／精確模型、排隊後 fresh permit、三種作業中指示、session／規則版本變化、第五回合／壓縮／失敗復原、上限交接、transcript／委派／整合、終端機模型切換與 owned 停止。Web 回覆是不可信背景，不能擴權或自動執行。

回歸：`instruction-run.test.js`、`instruction-size.test.js`、`delegate.test.js`、`answer-sync.test.js`、`ask-answer.test.js`、`windows-chat.test.js`、`workspace-runtime.test.js`、`hub.test.js`、`app-ui.test.js`、`i18n*.test.js`、native MCP／installer tests。

批次 I 只在自己範圍門檻成立後產生版本；功能表明列三個 CLI 未就緒。真實網頁驗收由人送出已明示的合成測試文字並貼回，未做則標示待驗證，mock／開站不算真模型連通。

## 9. R0：固定來源、主機預檢與 OS 變更範圍

### R0.1 候選固定版本——均未下載／執行／驗收

| CLI | 本計畫候選 | 協定／來源門檻 |
|---|---|---|
| Claude | `2.1.295` Linux x64 | 指定平台 signed manifest、GPG key fingerprint、exact binary SHA／實際版號；stream-json 與 permission bridge 驗證 |
| Agy | **Antigravity CLI `1.3.1`**，不取 IDE 版號 | 先取得可版本化官方產物與可信驗證方式；只有 unversioned installer 則不啟用；PTY／官方互動核准可行性 |
| Grok | `1.0.50` Linux x64 | 官方 package `@xai-official/grok`／release provenance、exact SHA／版號；固定 ACP protocol 及 capabilities；不由本機 1.0.34 hint 推定 |

版本依據：[Claude changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)、[Agy CLI changelog](https://antigravity.google/docs/changelog/)、[Grok changelog](https://x.ai/changelog/build)。這是 2026-10-10 規劃時選定候選，執行前重新確認仍可取得、來源／弱點／撤回狀態；版本變更需更新版本化 stage manifest，不自動追 latest。

Claude 核對官方 signed manifest／GPG fingerprint 及適用 publisher；Grok 官方已公開 source `xai-org/grok-build`，但 source revision／release／本機 exe 對應仍須另外證明；Agy 固定版來源未建立時維持未就緒。禁止下載後立即 pipe 到 shell。[Claude 完整性文件](https://code.claude.com/docs/en/setup)、[Grok 官方 source 公告](https://x.ai/news/grok-build-open-source)、[Agy 安裝文件](https://antigravity.google/docs/cli/install/)

### R0.2 精確主機變更候選

先取得管理員**唯讀**edition／SLAT／韌體虛擬化／hypervisor、optional features、pending reboot、現有虛擬化相容性與資源。既有狀態寫入 baseline；查詢未知／不符合不啟用、不改 BIOS／BCD／其他虛擬化軟體。

| 變更 | 必要性、範圍與回復 |
|---|---|
| Hyper-V | 如原本缺少，僅所需 Hypervisor／Services／Management-PowerShell 及已列明前置 features；管理員權限，可能需重開機。既有 features 不重設；不順便啟用 WSL/VMP 或自動重開機 |
| host helper／通道註冊 | 新增 `ProjectHubWorkerManager` Windows service（Manual，按需要啟動；LocalSystem 身分只管理本產品登錄的 VM ID）與 Hyper-V socket service GUID 註冊，需要管理員安裝。程式放 `%ProgramFiles%\ProjectHubWorker` 的 admin-owned 版本目錄；named-pipe 僅允許已登錄 owner controller，固定 VM ID／artifact roots／操作與一次請求 nonce。guest channel 不接 privileged helper，檔案／egress broker 保持 owner 權限；不把 Hub owner 加入通用 Hyper-V 管理群組 |
| worker 資料 | 管理資料／guest 映像置於 `%ProgramData%\ProjectHubWorker` 的專用 ACL 目錄；Hub receipt／專案資料仍沿用目前 DataRoot。guest auth／disk 不進 outputs、Git 或一般成果包 |
| host 網路 | 優先無 vNIC＋Hyper-V socket，不新增廣泛防火牆、NAT、bridge 或公開 TCP listener；若 relay 相容性失敗則停止，其他拓樸先形成具體更新計畫 |
| guest 依賴 | Ubuntu24.04 LTS x64 官方 signed 映像候選；版本/ISO SHA 固定。guest 中的 systemd/cgroup2、Python3 supervisor、bubblewrap、Git 及必要 broker/runtime 依賴明列來源與版本；compiler 等建置工具不默留執行 image |
| Node／CLI | 共用/web 流程不新增 Node 正式依賴；newnative helper 與 Linux worker 是新增需維護元件。CLI 只放私有 stage／guest，不改 Windows 全域 PATH、CLI、auth、PowerShell 永久原則或現有 Hub 服務 |

本次計畫核准後仍先完成 R0 唯讀 baseline 與精確變更 manifest；若實際所需系統範圍超出此表，先呈現差異再執行。重開機有可見中斷，另確認時點。安裝/撤回只動此次新增且可辨識的物件，不停用被其他軟體使用的既有 Hyper-V/VMP/WSL。

## 10. R1：獨立 Linux VM 與受限通道可行性

**初始設計值，未實測**：Generation2，4vCPU、固定 8GiB RAM、32GiB dynamic task VHDX；最多 1 個活動 worker/run，其他 run 排隊。選定 provider 的專用登入 profile disk 才 attach，其他 profile 不接入 guest；在無 profile 的乾淨 base 做可信 bootstrap，驗 TLS 來源與更新包。

所有 worker 映像、選定 profile disks、保留版本／回復檔及暫存合計上限 72GiB，C:保留至少 40GiB；每次建置、更新、啟動與 checkpoint 前重查，磁碟／RAM 不足拒絕並保留既有版本。不得配置無限 checkpoint；實際 freeRAM 須覆蓋 8GiB guest 及 8GiB host 餘裕，否則暫停。初始 run memory6GiB、process256，另訂 CPU、輸出／磁碟與 wall-time 限額；量測後調整 manifest，不作效能承諾。

admission 按 task／各 provider profile VHDX 的最大增長、保留映像及建置暫存上界預留，不只看目前 sparse 檔案大小；三個 profile 全計入總額。所有配額上界總和須在 72GiB 內，不足不建立。執行中持續量測總額與 C:餘裕，新增寫入超出配額或觸及 40GiB 閾值時撤銷 grant、受控停止並保留 partial／lease；停止前所需日誌／收據空間也預先保留。這是 worker 管理上限，不保證能阻止其他主機程式消耗磁碟。

這個資源預算接近本輪磁碟餘裕，不能保證三 provider 映像／專案任意大小皆可放入。R0 實測映像大小與 profile 保留需求，按 72GiB 總額核算；不足時明確提出新增儲存或縮減保留方案，不默占其他磁碟。Secure Boot 使用已驗證 Linux 映像適用 template，不因開機失敗靜默關閉。[Generation2 security](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features)

新增（待實作）：`hub/lib/worker-controller.js`、`worker-channel.js`、`hub/windows/worker-manager.cs`／`worker-channel.cs`、worker manifest／run／channel schemas；Linux 側 `hub/worker/` supervisor／sandbox／broker；`worker-controller.test.js`／`worker-channel.test.js`。第 9 節 service／GUID 需確認未被占用，既有同名物件無所有權證據時拒絕覆寫。安裝前變更 manifest 固定程式 SHA、owner 身分、VM／GUID、ACL／服務權限與移除步驟；不以 service 身分執行專案命令或 guest 請求的 host 檔案操作。

Hyper-V socket 候選需證明 Windows 服務 GUID／VM ID 與 Linux kernel 支援；不依賴 TCP/IP 不等於自帶授權。Host privileged helper 只處理特定 VM 生命週期；檔案／egress broker 以 owner 權限，guest RPC 無任意 command／path／核准／更新能力。Frame 有 version、run／nonce、size／timeout、順序及已核准 scope；CLI 不能直接存取 supervisor 控制 channel。[Hyper-V sockets](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service)

privileged named-pipe 用 OS 提供的 peer PID、建立時間、SID／logon session 及登錄 controller instance／程式身分核對，不相信 client 自報身分。nonce 只防重放，不單獨構成認證；請求綁服務核發 challenge 與確切 operation。VM／磁碟／路徑／允許操作由 admin-owned manifest 解析，client 不能傳任意目標。guest token、普通同 SID 程序、PID 重用、錯 controller binary 或錯 ACL 均須拒絕。

無 vNIC guest 透過可信 relay 取得此次允許的 HTTPS CONNECT／登入目的地，保留端到端 TLS 驗證。每次新 CONNECT／連線重新核對精確目的地及 DNS／IPv4/IPv6 解析，拒 host/LAN 與未允許目的地；跨目的地 redirect 會因新連線受檢查。relay 不檢視加密 HTTP 內容，不宣稱限制已允許 TLS tunnel 內的 URL path／內容。CLI 只接 per-run relay endpoint，其他 Unix／VSOCK／控制 endpoints 由強制 sandbox 拒絕，無 vNIC 本身不證明不可達。Bootstrap 軟體來源 grant 與模型/run grant 分開；忽略 proxy 或需要新目的地時 fail closed，不默加網卡。

Gate：無 CLI／模型的 guest echo/frame、範圍拒絕、host file/control 資料不可見、relay approved 目的地與繞過、壞 profile／channel／resource failure；模型 proxy 相容性另在 C 階段限量驗證。若此方案不成立，提出 private-switch 專用 gateway 等替代的資源／管理範圍，經審閱才改拓樸，不把 WSL 或 NAT 稱等效 host 邊界。

## 11. R2：whole-process、秘密、退出與 Git 回收

新增／修改（待實作）：Linux sandbox 與 supervisor、`worker-secret-supply.js`、`worker-artifacts.js`、`workspace-runtime.js`、reviewed workspace／merge／Git service、worker schemas 與 `worker-runtime.test.js`、`worker-secrets.test.js`、`worker-artifacts.test.js`。

1. Trusted supervisor 在 CLI 首指令前套 whole-process namespace／限制並加入不可自遷移 cgroup；built-in files、shell、MCP/hooks/plugins/Git helpers 全涵蓋。CLI 無 root/sudo/capabilities、可寫 cgroup 或管理 socket。
2. 每 run 只看 task copy 及此次 provider profile；禁止 Windows 本體/auth、其他 provider profile、SSH/Docker、host／其他 provider／共享 keyring 與 Hub owner token。自身 provider 專用 guest keyring 或官方等效登入，先明列依賴、IPC、身分與範圍並驗證；沒有可用方式則未就緒。專用登入由人完成，不複製 Windows auth；自身憑證對 tools 的可見度如實量測。

   profile 分為 controller 固定的可信唯讀配置／程式，與可變 auth/session。後者不得承載自動載入 MCP、hooks、plugins 或其他程式；禁止 run 中以 profile 寫入後熱載入或污染下一 run。每次登入／啟動驗證實際寫入範圍、目錄外 credential 與設定優先序，配置改變需新預覽，不只設定 CLAUDE_CONFIG_DIR 就認為所有 auth 均在指定目錄。
3. Guest SecretSupply 沿固定 10 分鐘 TTL，Windows Root/FileID 與 guest held-FD 身分分開，create-only、baseline、SHA／monotonic／cold unknown；owned 樹退出後復原前再驗 baseline，改變／清理失敗保留 partial。
4. `running→stopping→cleaning→collecting→closed`；先撤 egress/tools、停止 cgroup、證明 populated=0，再清秘密、排除控制資料並私有回收，最後解除 lease。前端 EOF、Save／Pause／checkpoint 不是退出證據；Hub crash／VM reboot／PID/cgroup 重用不發舊 permit。
5. Guest `.git`獨立，不 copy Windows worktree 絕對指標；成果排除 guest Git/auth/MCP 控制/秘密 baseline/journal；普通檔案 type 不是授權。Windows create-only staging 後驗名稱／碰撞／SHA／最新 host HEAD/FileID，再走 reviewed merge。Git commits／執行設定另有版本化匯入與 owner 預覽契約。
6. 原 lease 下 controller 可私有回收，HTTP/MCP 不可傳豁免。外部 merge、其他 run 與本體 mutations 仍受互斥；direct 需求走 controller 明示 host 變更，不 live mount／允許 guest 任意改本體。排除控制資料不是完整 DLP。

Gate：核准設計§8.3 全部適用案例、cgroup double-fork／setsid／MCP 背景 child／cancel 競爭／Hub crash、VM 重啟孤兒、同 bytes 換 FileID、secret／baseline 改變、CRLF/LF/UTF-8／Git flags、symlink/hardlink/ADS/保留字／case/Unicode 碰撞、host 基線改變、OOM／quota／timeout／清理失敗，保留無關 VM／程序。

常態 Stop 只處理 ownedrun／VM；若不能確認完整退出，lease 保留 unknown，正常 guest shutdown 只對核對所有權的 VM。Force TurnOff 相當斷電，可能損失未保存資料，僅作精確目標的最後手段並明列 partial；不能當正常 cleanup 完成。[Stop-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/stop-vm)

## 12. C1／C2／C3：逐 provider 可行性與 adapter

新增（待實作）：`hub/lib/providers/claude.js`、`grok.js`、`agy.js`與固定 protocol schemas／fixtures、`provider-claude.test.js`、`provider-grok.test.js`、`provider-agy.test.js`；接入 chat／sessions／instructions／launch／procwatch／transcript／MCP／usage／updates。

| provider | 隔離後的 argv／控制候選（未執行） | 在完整 adapter 前須證明 |
|---|---|---|
| Claude | `claude -p --input-format stream-json --output-format stream-json --verbose`；permission-prompt-tool 候選 | 精確 model/session/resume、events／terminal 與取消；owner 批准橋不可由模型自核准，shell sandbox 不代替 whole-process |
| Grok | `grok --no-auto-update agent stdio` | initialize 版本/capabilities、固定 ACP schema、session load、approval／cancel／錯誤；exit0 或 ACP 名稱不算功能證明 |
| Agy | `agy --input-format stream-json --output-format stream-json`；需另驗 PTY 或官方互動控制 | headless soft-deny 可能 exit0，stdin 不支援 control_request/response 及/model；必須建立逐次 owner 核准和終端機模型切換，不能用 skip-permissions 補成功 |

參考：[Claude CLI](https://code.claude.com/docs/en/cli-reference)、[Grok headless](https://docs.x.ai/build/cli/headless-scripting)、[Agy headless](https://antigravity.google/docs/cli/headless/)。若某固定版不提供必要能力，該 CLI 停在未就緒，提出證據與替代版本／transport；不自行刪 M 要求或換成 Gemini CLI。

先跑合成 protocol、隔離內 offline 版號／help／handshake，無網路時不容許 installer／auto-update。登入與模型 smoke 在功能畫面呈現 provider、目的地、合成 prompt／files、可能費用及有效期限後取得一次工作授權；不傳私有專案。核准一個 provider 不允許其他 vendor，登入失敗不改用未核准 API key 或解除政策。

首次模型 probe 每 provider 最多 6 次 controller 起始回合（重試也計入）、單回合 90 秒、合計 8 分鐘；不自動開未核准 subagent／重試／新增目的地。達回合／時間／拒絕門檻即撤 egress 並停止 owned run，後續 M 驗收另給明確測試批次。送出前顯示實際訂閱額度或計費方式、可控制的停止條件；若供應商內部重試／處理或費用不能硬封頂，直接顯示此限制，controller 上限不是帳單保證。

每 CLI 逐項通過設計 M 矩陣：繁中／角色／歷史、會話/續聊/queue 及三指示、工具 allow/deny/timeout/cancel/replay、終端機 input/resize/model/owned Stop、上限／transcript／委派整合、Git/非 Git/host broker direct/配置圖片/MCP、usage 不可取得的真實狀態、固定版更新及回復。用量資訊缺少呈未取得，不填零；錯誤/permission soft-deny/缺 finish 事件不當成功。

## 13. D1：測試命令、套件、安裝與回復

以下是實作後使用的命令，**本輪文件工作未執行**；新增 test 檔要實作完成才執行。新 fixture 須通過 A0 包含／程序隔離檢查。

```powershell
# repo root
$env:HUB_SKIP_NPM = '1'
node --test --test-force-exit hub/test/provider-registry.test.js hub/test/web-chat.test.js hub/test/web-chat-schema.test.js hub/test/web-chat-receipts.test.js hub/test/web-chat-http.test.js hub/test/web-chat-ui.test.js

# 每個階段必要既有回歸，再跑完整現有套件
npm.cmd --prefix hub test

# 使用者指定的程式變更後檢查
$env:PYTHONPATH = 'src'
python -m unittest discover -s tests -v
```

`--test-force-exit`不是 owned 程序清理證明；另有 R2/native lifecycle gates。本 Node 專案若仍無 Python tests 或 python 入口，記錄實際 exit／原因及未驗證，不造 dummy test、不列 pass。完整套件的既有 POSIX fixture 或歷史失敗保留明細，修必要回歸而非刪斷言／增加 skip 取全綠；不得宣稱完整歷史單次全過。

1. Source gate：exact 乾淨 commit、JS 語法、native 編譯、schema 與 validator／範例一致、局部＋必要回歸＋完整測試結果、依賴 audit 與固定產物來源，provider/profile 獨立證據。每項分已實作／已驗證／fixture/live／未量測，不合併重複 case 成假總數。
2. `hub/windows/package-windows.cjs`及 installer 的 manifest／version 槽做相容測試。Hub、privileged helper 與 guest 映像分開驗來源與 ACL；不把大型 VM 或 guest 登入塞進原 Hub ZIP，不更名／覆寫舊 version 槽。新增原生/guest 依賴與授權資訊寫清楚。
3. 新 Hub create-only version slot，既有 data／roles／auth 先確定性快照。先合成 DataRoot 實測 Install→Start→Stop→rollback→forward 及 migration 中途失敗，再按既有安裝授權啟用正式版本；活動 run／未知 lease 拒切換。
4. Worker 映像／CLI 更新只有 staged 版本，不在 run 中自更新。回復到驗過的 image／isolation policy/runtime manifest／binary，撤舊 grant 並保留資料與事故證據；這裡的 profile 不含可變 provider 登入 disk，不自動回復、覆寫或刪除 auth。舊 binary/policy 不相容登入資料時拒啟用，另走已核准遷移。

   Hub launcher／installer 新增 DataRoot format／release capability gate，目的 release 不支援目前 Schema 或有非終態 receipt 時拒絕版本切換及一般 Start。同版／Schema／Root 身分已驗證時提供 recovery-only Start：僅 owner 登入、查狀態及精確復原已 durable 接受的交易，禁止新 handoff、CLI、queue 與一般 mutations；未知 owned children／journal 身分不能以復原為由放行執行。現有 058 舊 binary 不具新 admission，不能宣稱它會自動唯讀或拒寫新版 Root。需回復舊版時，預覽列明目的 Root 與已驗證相容快照／副本；保留目前新 Root 及其成果，取得此具體復原授權後才啟動相容 Root。唯讀使用支援該格式的 reader，不讓舊版直接寫新版 Root，不修改舊 version 槽。Gate 包含真舊版＋新版資料拒啟動、nonterminal receipt 拒切換、同版 recovery-only 可對帳且拒新執行，以及相容副本回復；managed gate 不宣稱舊 binary 本身能防止人繞過管理入口執行。
5. 移除只停止／解除此次 owned worker VM、service GUID 與新增 helper；驗實際目標包含／FileID。provider 登入與使用者成果保留；OS 功能只有 baseline 證明本次新增且無其他使用者依賴才考慮撤回，系統重開另確認。
6. 交付 source commit、package SHA 與 manifest、可開啟入口、操作／停止／回復文件、六 actor 能力表、test/evidence index 與剩餘限制。批次 I 或某 CLI 未通過 M 僅稱部分整合；全部適用 M 及 Codex 回歸通過才稱此新增範圍完成。

## 14. 計畫審閱與第一個可執行批次

建議核准的執行方式為「依 A0–A4、R0–R2、逐 CLI 及 D1 推進，以原生 Codex＋兩個網頁 Chat 作第一交付批次」。初始工作是 source/fixture baseline 與 registry/handoff，不需要先裝 WSL、VM 或第三方模型 API。

VM 部分採獨立 Hyper-V Linux worker 候選、無 vNIC＋受限 socket/relay、單活動 run、provider 專用 profile；系統條件、來源、通道／proxy 或 Agy 互動未通過即保留未就緒並提出具體修正，不影響已驗證批次繼續。使用者需審閱本計畫與執行方式；核准前不寫產品程式、不安裝 OS 元件、不執行新 CLI／模型。

本輪完成定義是這份實作計畫與一致性審查，不是新增功能已可使用；本機硬體唯讀結果與官方文件能力皆與產品端到端驗收分開。

## 15. 2026-10-13：已核准獨立 Linux／SSH 差異及執行批次

### 15.1 核准與範圍

依已核准 SSH 補充，沿用原完整 M 矩陣及原 Codex／manual Chat 回歸；不再執行此路線的 Windows Hyper-V 預檢／啟用、LocalSystem helper、VHDX、service GUID 或 socket 註冊。指定主機／user／已確認 pin 僅保存在 task 私有登錄／evidence，不寫入可散布規格或產品預設值。未知 provider 仍拒絕，Agy 後續獨立驗收。

### 15.2 第一個批次：來源與無模型 worker 部署

1. 保留上一資源探針失敗紀錄；以 v2 bounded SSH capture 重跑 kernel cgroup limits、owned double-fork／setsid 退出及 unit 收尾。逾時不等待 `close` 作成功；失聯標記 remote unknown。讀取 glibc／systemd／工具版本及實際 user root 身分；不 sudo、不裝系統 package。
2. 從 Ubuntu 官方 HTTPS 分發的 signed InRelease／Packages 固定 socat deb 及所有缺少的必要 libraries，核對 archive key fingerprint、signature、index SHA／package exact SHA／length／dependencies／license。只取 amd64 相容產物；取不到固定可信鏈即拒絕，不執行 maintainer scripts、apt source 變更或 installer。
3. 新增 `hub/worker/` Python stdlib 的 typed channel／private deployment／sandbox supervisor，schemas 與 offline tests；Windows 新增 `hub/lib/worker-channel.js`／`worker-controller.js` 的固定目標 SSH transport。部署工具先核對 task 已量測 source digests、private root owner／held-FD identity，create-only 寫入 `~/.local/share/project-hub-worker/`；既有無所有權 root／path 不覆寫。
4. 私有 release manifest 固定 Claude 2.1.295、Grok 1.0.50、socat／libs／worker bytes；收尾 fsync／重算 digest 後才 stage-complete。CLI 暫無 runtime readiness；Grok trust limit 如實保存。部署回應只傳固定 evidence fields，不傳 auth／私有設定；來源或既有物件異動拒絕 activation。
5. 無網路／無 auth 的 whole-process 內做 `--version`／`--help` 與本機協定探針；先驗 namespace、mount、caps、NoNewPrivs、manager／cgroup／控制 channel 不可見、resource limits／owned tree 全退出。任何 gate 未通過不執行新 CLI；未提供真實能力的介面不得冒充完成。

### 15.3 後續實作檔案與 gates

- R1／R2：`hub/worker/protocol.py`、`deployment.py`、`sandbox.py`、`supervisor.py`、`egress.py`、`artifacts.py`；`hub/windows/worker-*.schema.json`；`hub/test/worker-*.test.js` 與 Linux worker stdlib unittest。typed messages 最多 1 MiB，unknown type／sequence／nonce／permit／root 皆 fail closed；沒有任意 shell RPC。
- 資源／FD：task 2 GiB、provider home 256 MiB、tmp 512 MiB 的 bounded tmpfs；整個 run memory 6 GiB、swap0、CPUQuota150%、TasksMax256、30分鐘；admission RAM10GiB／disk20GiB／persistent8GiB。先驗 held root-FDs 收尾與 accounting、OOM／quota／pids／cancel／crash／reboot unknown；不能僅看 package 存在或 manager bus 取成功。
- Profile／網路：controller state、其他 profile／Windows auth／SSH agent／manager IPC 不掛進 CLI；只選定 provider 的經驗配置與可變登入資料。允許的 per-run TLS destinations 與 UDS relay 分離管理 channel；驗 DNS／IP／LAN／redirect／ignore-proxy／socket bypass。bootstrap grant、登入 grant、模型 permit 各自綁定，不擴大來源或 vendor。
- C1／C2：沿 §12 逐 provider offline protocol → 精確官方登入 → 合成模型工作核准 → 原 M 矩陣；新增 Claude／Grok adapters 接入真正 worker，resume／工具核准／queue／terminal／transcript／usage／MCP／Git 回收均有成功與拒絕證據。能力／版本不足保留未就緒，不能更改 ready boolean 取代驗收。
- D1：原 §13 的 package／source／rollback／資料相容 gates 保留；worker 私有 artifacts 與 provider 登入不打進 Windows ZIP。正式 package 增加 worker code／schemas／文件／license；核对目前 source／installation state 後安裝，再驗實際 UI 成功與失敗路徑。

### 15.4 驗證、復原與報告

每批執行相關 Node tests／Linux stdlib tests，程式變更後亦跑使用者要求的 Python discovery；若 repo 無 `tests` directory，保存實際 exit1，不建立 dummy tests。mock／offline protocol／--help 不算模型或 Hub 完整驗收。

本次已新增實際 worker protocol 的 Python 測試於 repo `tests/`，以使用者指定的 discovery 指令驗證；舊批次缺目錄的失敗紀錄保留，不套用為目前測試狀態。

每批記錄 exact source SHA、SSH／worker／boot／unit identities、scope／command、exit／log SHA、產品能力與未量測項目。停止只對確認擁有的 run／unit，失聯保留 unknown lease；不 shutdown 整台 Linux。撤回僅本次 create-only 且身分／內容未變的物件，登入／使用者成果保留；任何修復需超出核准 root／sudo／全域系統範圍時先提出精確差異。

本節按使用者已核准的 SSH 書面補充與既有 execution method 編排；不重啟相同範圍的審閱輪次。真正登入／模型送出仍使用原精確批次核准。

## 16. 2026-10-14：已核准 Windows 密碼保管補充

使用者審閱 `2026-10-14-ssh-password-vault-design.md` 後回覆「好」，沿目前聊天的原執行方式繼續。依既有直接編排計畫授權，以下將已核准規格落成工作批次；不新增 OS 服務、外部依賴、Linux policy 或 provider 登入授權。

1. **V1 native store**：新增 `hub/windows/ssh-vault-store.cs`，只允許 exact 產品 TargetName；CredUI 原生錄入、嚴格 UTF-8、清零、驗證後才 CredWrite、readback／精確刪除。不使用 Credential enumeration。
2. **V2 native transport**：新增 `ssh-vault-transport.cs`；SSH suspended → Job → resume，私人 pipe 的 owner ACL／remote 拒絕、peer PID／SID／建立時間／image／Job／已量測 ancestry、一次 nonce。固定 SSH options／host key pin，錯誤與逾時收束 owned tree。
3. **V3 broker/controller**：新增 `ssh-vault-broker.cs` 與 `hub/lib/ssh-password-vault.js`，封閉 descriptor／Schema／收據與例子。收據只含非秘密 binding，登錄持有鎖並驗 root／source／SID；enroll 的唯讀 identity probe 驗 nonce／UID 才保存。一般 connect 不開 UI；更新及忘記只能明確執行。
4. **V4 本機驗證**：編譯及拒絕測試；本機 loopback SSH fixture 實際驗 Git/MSYS ancestry、UTF-8、一次供應／重放拒絕、錯誤／timeout／owner crash。使用全新產品 synthetic target 驗存取／刪除，不枚舉或讀既有 vault。Node 範圍回歸及根目錄 Python discover。
5. **V5 一次正式錄入**：前述 gates 過後，顯示一次明確目標的 CredUI；候選密碼只留 native buffer，連線固定 readonly probe 成功才保存。取消或錯誤即停止，不能重彈。新 controller 兩次 cached probe 均無 UI，再將已核准 stage operator 改接 broker。正式 Linux staging／provider readiness 另記錄，不能以 vault 成功代替。

每批只在相稱證據存在時標記通過。native fixture、正式 SSH、套件安裝及模型流程各自報告；此補充尚未通過正式 SSH／vault／安裝驗收。

V5 操作修正：前一次 CredUI 錄入逾時，不能由空事件推論使用者未輸入。新版本先顯示有工作列入口的原生「SSH 連線設定」，使用者按一次開始才開啟 owner 綁定的 CredUI；開始前 15 分鐘，開始後 300 秒，取消／錯誤不重試。錄入前拒絕已存在或破損的 receipt／forgotten 路徑。來源更新僅可在舊 exact credential 與 receipt 均確認不存在後準備新 binding，不能靜默遷移已保存密碼。正常連線仍不開 UI。
