# Project Hub 多 CLI 與網頁 Chat 整合設計

2026-10-18 範圍修正：產品為 Chat／CLI 多模型／多模組開發與對話任務續接，不包含 computer use。Claude／Grok 在核准範圍內的完整自主開發需求仍保留；Linux 不列為必要前提。後續實作以 [Chat／CLI 任務續接修正](2026-10-18-chat-cli-task-continuity-design.md) 的目前範圍為準；下文保留歷史設計與當時證據。

日期：2026-10-09（Asia/Taipei）｜狀態：**書面設計待使用者審閱；本文件不代表新功能已實作或可執行。**

基準：上游 v4.68.2；Windows 分支 `windows-browser-mvp`，產品來源 commit `0583184ee534f2e08a0b037858a99bce63ad9fce`。本次不變更已安裝版本，也不新增 Windows 功能、虛擬機、CLI 套件或登入資料。

## 1. 目標、授權與完成條件

使用者要求維持原有 Hub 功能與資安，介面具有台灣繁體中文，增加 Claude／Agy／Grok CLI，以及不透過 API 的 ChatGPT／Claude Chat。現有原生 Windows Codex 為基線；先前「其他 AI 留待後續」的範圍限制，僅在本新增需求內由本規格擴充。

六種入口共用專案、作業、角色、會話與成果流程，但每種入口保留真實能力與獨立授權。CLI 要能執行、權限核准、取消、續聊、委派與交回成果；網頁 Chat 採使用者帳號的手動交接。網頁 Chat 不具有 CLI／MCP／本機檔案工具能力，不能將這些未提供的能力標示為可用。

「不要使用 API」套用於 ChatGPT／Claude **網頁 Chat 整合**：不新增模型 API client、不要求 API key、不抓取網頁登入 cookie、不自動送出。既有及新 CLI 仍需以各自官方支援方式連線模型服務；CLI 的訂閱、費用及資料目的地須另行顯示，不能宣稱網頁帳號或 CLI 一定免費。

本次「好」核准的是整理此設計方向。新增 OS 元件的精確範圍、權限、資源與重開機影響，須在實作計畫中形成可審閱項目；沒有從此次回覆推定全域安裝或第三方資料傳輸授權。

最終交付須包括實際程式、Schema、遷移、操作文件、範例、版本化套件與驗收證據。入口未通過真實協定、隔離與主要功能驗收時，標示「尚未就緒」及原因；固定拒絕或僅有 mock 不算完成該 CLI 整合。

## 2. 現況與已查核證據

| 項目 | 本次可確認的事實 | 尚未證明的事項 |
|---|---|---|
| Codex | 基準分支已有原生 Windows Hub 功能及繁體中文，另有交付報告 | 本規格不重新宣稱目前服務正在執行；既有驗收不能套用到新 provider |
| Claude | 本機 npm 與 native package manifest 均為 `2.1.252`；實際 `claude.exe` 已唯讀雜湊 | 未執行本機版本命令、模型或新隔離 profile；官方最新設定不等於此版一定支援 |
| Agy | PATH、常見安裝位置與指定 installed-app metadata 未發現 | 不是全機不存在證明；需確認實際官方產品、CLI 入口及版本 |
| Grok | `.grok/bin/grok.exe` 存在；embedded build hint `1.0.34`，`agent.exe` 同 SHA-256 | hint 不是實際執行版本；公開 source／publisher 簽章、ACP 與 Windows 隔離未驗證 |
| 網頁 Chat | 已有 ChatGPT 複製 prompt、開站與貼回流程 | 現有 prompt 固定要求日文；貼回記事失敗被吞掉，不符合新交易成功條件 |

唯讀盤點：`work/installed-provider-cli-readonly-result.json`，時間 `2026-10-09T01:20:09.037Z`；SHA-256 `b5d8e89c72df6a6fcae8c1c0de7b8d10f84c7ea8e48b1c6bf0d7caf02dad11a4`。零 CLI 執行、零模型呼叫、未讀取 auth／私有設定、未改全域安裝。

本機 binary SHA-256：Claude `fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a`；Grok `021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94`。雜湊辨識同一產物，不是供應商簽章或安全保證。

### 2.1 必須修正的隔離前提

Microsoft 明確指出 WSL 不是執行不可信程式的安全沙箱，同使用者 distro 不構成 Windows host 或其他 distro 的安全邊界；關閉 automount／interop 也不能改變這個結論。**WSL2 只能列為 Linux 相容環境，不能單獨承擔新 CLI 的主機隔離。** 若需要抵抗不可信 CLI／工具對 Windows 主機的存取，應使用有受限存取的獨立管理 VM 等適當邊界。[Microsoft WSL security model](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/security.md)

Claude 官方 shell sandbox 不涵蓋內建 file tools、MCP 與 hooks，原生 Windows shell 命令亦不受該 sandbox 隔離。因此僅設定 Claude 的 shell sandbox 不足以滿足本規格的整個 CLI 隔離。[Claude sandbox](https://code.claude.com/docs/en/sandboxing)

Grok 官方 sandbox 描述 Linux Landlock／macOS Seatbelt；預設關閉，`strict` 的子程序網路限制不等於 CLI 本體所有模型／web 網路均被限制。[Grok sandbox](https://docs.x.ai/build/features/sandbox)

Agy 官方文件描述 terminal sandbox 與 Windows 支援；不能從 terminal 能力推定整個 CLI、file tools、MCP、hooks 均受相同保護。需按實際版本與入口驗證。[Antigravity terminal sandbox](https://antigravity.google/docs/sandbox?tab=cli)

## 3. 架構選擇與成本取捨

| 方案 | 能完成的用途 | 邊界與維護影響 | 本規格決定 |
|---|---|---|---|
| 原生 Codex＋網頁手動交接 | 保留已交付 Codex；新增兩個網頁 Chat，不依賴新的 OS 元件 | 網頁結果由人貼回，來源無外部認證；不代替其他 CLI 執行能力 | 優先交付，之後仍須完成新 CLI |
| WSL2＋外部 whole-process sandbox | Linux 相容 CLI；額外限制檔案、網路與子程序 | 須維護 Linux supervisor、sandbox、egress、登入；WSL 本身不是主機邊界，殘餘風險不可隱藏 | 只列候選，不以其存在滿足主機隔離驗收 |
| 獨立管理 Linux VM＋受限 broker | 在獨立 guest 中執行支援 Linux 的 CLI，輸出受控回收 | 增加虛擬化、guest 更新、映像、資源／磁碟與登入維護；禁止 host drive、剪貼簿與控制 socket 的任意共享 | 新 CLI 需要主機隔離時的建議方向；實際 VM 技術／資源待實作計畫列明 |
| 原生 Windows 每 provider 的 whole-process 隔離 | 可避免 Linux 相容性問題 | 需證明完整程序、工具、auth、網路及退出控制；目前未證明 Claude／Agy／Grok 各版符合 | 驗收同等要求後才可選用，不能刪拒絕分支直接放行 |

推薦交付順序：先做共用 actor 與網頁交接，再驗證獨立 worker 的邊界及 CLI 協定，逐一啟用 Claude、Grok、Agy。這是交付順序，不把後三者取消或當作已完成。Agy 不直接以 Gemini CLI 替代，需官方入口對應證據。

本階段尚無可依據的工期／費用估算。時程的關鍵依賴是實際 provider 版本協定與 worker 端到端探針；取得結果後，實作計畫再估每階段資源與工時。VM 與多 CLI 維護成本高於單一 Codex，須維護每組 binary／profile／模型能力和相容矩陣。

## 4. 精確 actor／transport registry

| actor ID | 種類／transport | 角色相容鍵 | 能力 |
|---|---|---|---|
| `codex` | CLI／native Windows adapter | `codex` | 現有 Codex 全部已交付流程 |
| `claude` | CLI／經驗收的 provider adapter | `claude-code` | Claude CLI 會話、工具、核准、續聊與成果 |
| `agy` | CLI／經驗收的 provider adapter | `agy` | 實際 Agy CLI 支援的同類流程 |
| `grok` | CLI／經驗收的 provider adapter | `grok` | 實際 Grok CLI 支援的同類流程 |
| `chatgpt` | external chat／`web-manual` | `chatgpt` | 預覽、複製、開站、人工貼回 |
| `claude-chat` | external chat／`web-manual` | `claude-chat` | 預覽、複製、開站、人工貼回 |

Registry 為伺服器唯一權威，明列 kind、transport、owner key、已驗證 binary identity、模型目錄、能力、isolation profile、固定網頁 URL。前端不能以 `/claude|codex|agy/`、名稱包含或未知 actor fallback 辨識 CLI；`claude-chat` 絕不能送進 Claude CLI。未知值或不可用 capability 明確拒絕，不自動換 provider 或模型。可執行 CLI 必須解析並驗證具體 model；web-manual 不要求或假造可驗證的網頁 model，只驗證 actor、固定目的地及 receipt，模型備註維持未驗證性質。

角色、續聊、委派、終端機、stop、procwatch、transcript、模型／用量、MCP、更新及工作授權都使用同一 registry。模型 ID 與角色資料保持原值，不因 UI 翻譯變動；不能把同名模型跨 provider 視為同一授權。CLI session ID 按 actor／runtime 隔離，不能跨 provider resume。

沿用舊 `chatgpt`、`claude-code` 角色與既有歷史。新增可版本化資料欄位；未知新版資料在舊程式明確拒絕或以唯讀方式展示，不覆寫。部署前建立已驗證快照，遷移失敗不啟用新版本。破損 JSON／JSONL、跨檔引用、未知 state 均須報錯，不能靜默忽略後宣稱完整讀取。

## 5. 授權、登入與資料目的地

CLI 執行 permit 必須綁定 `provider + actor + transport + model + runtime/profile + binary identity + project/task/run + source identities + data destination + expiry`。provider、模型、profile、來源或目的地變動時重新預覽；原本 Codex／OpenAI 許可不授權 Anthropic、Google 或 xAI。網頁手動交接使用第 6 節 receipt，不套用 CLI 的 model／binary 欄位，也不繼承執行 permit。

CLI、MCP、worker 的 token 不具有 owner／核准／管理／全域更新權限。AI 無法核准自己。Hub owner token、Windows auth home、瀏覽器 cookie、SSH／Docker／GUI agent socket 不傳進 worker。保留既有遠端 TLS、Host／Origin、CSRF 與登入限制，回傳錯誤不帶憑證或私人內容。

新 CLI 以 guest 專用 provider profile 登入；禁止複製 Windows `.codex`／`.claude`／`.grok` auth 取得便利性。登入方式與必要網路目的地先查明，尊重現有 provider／組織政策；不能因失敗改用未核准 API key 或解除政策鎖。

若 CLI 本體同時需要登入憑證與 file tool 存取，read-only auth mount 不會使憑證對同程序 tools 保密。必須量測實際可讀範圍；需要隔離到 tools 無法讀取時，另有受驗證的 provider credential mediation。做不到則記錄明確殘餘風險並保留未通過狀態，不宣稱秘密不可讀。

單次 run 的配置／專案機密供應與長期 provider 登入分開管理。前者沿用 `hub/lib/secret-supply.js` 的固定 10 分鐘契約，新 guest 供應須分別綁 Windows 來源 Root／FileID／SHA 與 guest runtime／根目錄／held-FD 物件身分／SHA，不能將 NTFS FileID 混稱 Linux inode。create-only 複製；需要替換既有目的時先保存獨立 baseline 與 durable intent。可信 supervisor 在 owned 子樹全退出後清理；目的身分或內容改變時保留目的、baseline 與紀錄，不覆寫、不假稱清理完成。復原前重新核對獨立 baseline 的根目錄、物件身分與 SHA；baseline 改變或證據不完整時保留目的與紀錄，不復原、不刪除、不宣稱完成。TTL 同受 wall／monotonic 時鐘約束，到期停止 run，續用需新核准；冷啟動時鐘或物件身分未知則保留待覆核。長期 provider 登入不因這項 TTL 自動登出或刪除，仍遵守跨 provider 與 auth 可見限制。

網頁 Chat 的登入由使用者在瀏覽器完成，Hub 不讀取／儲存帳號登入資料。開站只用 `https://chatgpt.com/`、`https://claude.ai/`，不從結果文字或任意 URL 導航，也不把 prompt／token 放入 URL；新視窗使用 `noopener`。本機或遠端操作均使用使用者當前瀏覽器的剪貼簿，非 server 主機剪貼簿。

## 6. 網頁 Chat 手動交接契約

### 6.1 使用流程與繁體中文

1. 選 ChatGPT Chat 或 Claude Chat、指定作業，開啟「預覽交接內容」。畫面顯示此次目的地、實際 prompt、來源檔案／會話清單及每個截斷區段。
2. 使用者確認並複製，再開指定網站；由使用者自行貼上及送出。複製失敗可重試，不宣稱已送出；開站成功也不是訊息已傳送證據。
3. 使用者將回答貼回同一作業，Hub 顯示來源為「使用者貼上，未驗證網頁或模型來源」，儲存會話與作業記事。
4. 需要 CLI 繼續時，另行顯示目標 CLI、模型、工作區與實際傳出內容，經此次 provider 的授權後執行；貼回不自動執行或完成作業。

介面、系統生成的 prompt 與繼續作業提示預設台灣繁體中文，保留日文切換。`responseLanguage` 僅接受已支援語言；未知值拒絕。使用者文字與模型 ID 不翻譯或改寫。對模型要求繁體中文是請求，不保證回答語言；不自動翻譯改動原始回覆。

網頁 Chat 不使用 iframe／繞過登入、瀏覽器注入、hidden send、cookie session extraction 或自動抓聊天。此整合的自動部分限於建立待審 prompt、複製、開站與儲存人貼回內容。

### 6.2 v2 handoff 欄位與狀態

以下為新契約設計，實作階段需同步 JSON Schema 與範例；不是已存在端點。共用 routes 為 `POST /api/web-chat/preview`、`POST /api/web-chat/confirm`、`POST /api/web-chat/result` 與 owner 限定的 `GET /api/web-chat/status`。沿用 owner session／CSRF／Origin 檢查；status 只查此次 receipt，不把 token 放入 query string。

- Preview request：`actor/project/task/text/responseLanguage`；actor 僅允許 `chatgpt`／`claude-chat`，transport 由伺服器固定為 `web-manual`。使用者 text 上限 48 KiB UTF-8，結果上限 256 KiB UTF-8；拒絕 NUL、無效編碼與超限，不偷偷裁掉人工結果。除 wire UTF-8 外，JSON 解碼後所有文字也須為合法 Unicode scalar sequence：摘要與寫入前驗證 `isWellFormed()`，拒絕孤立 surrogate，不能用 `toWellFormed()` 或 UTF-8 replacement 悄悄更改內容。
- Preview response：實際 prompt、`sourceManifest`、明列的 truncation、`receiptId`、task 與來源 file identity、task hashes、`promptSHA256`、隨機 `previewToken`、到期時間。來源僅取指定作業、專案記事與此作業近期會話，不自動收集 repo、`.env` 或登入設定；動態內容照原 bytes／明示擷取規則呈現。生成的完整 prompt 上限 128 KiB UTF-8；超預算必須列出擷取範圍及截斷規則，無法建立有效預覽則拒絕。
- Confirm：preview 在 5 分鐘內，來源完整 tuple 未變時，一次性核准此 prompt 與目的地，取得僅限貼回的 60 分鐘 token。伺服器儲存 token hash，記錄與 URL 不儲存原值。核准代表準許本次人為交接，不代表實際已送出。
- Result request：`receiptId/actor/project/task/taskHash/promptSHA256/requestId/resultSHA256/text/token`。伺服器重算結果 digest，交叉驗證 receipt 全部綁定；`requestId` 首次接受後固定。
- 同 `requestId`＋相同 digest 重試回傳既有交易狀態；同 ID 不同內容拒絕。作業或來源改變，首次新寫入拒絕，需重新預覽及新 receipt，不挪到其他作業。
- 過期或撤銷 token 不可接受新結果；先前已 durable 接受的同筆交易，可在當前 owner 驗證後查狀態／精確復原，不重新授權外部傳輸。草稿仍保留給人審閱，不由過期 token 獲得讀取其他資料的權限。
- 記錄 provenance 為 `user-pasted/unattested`。使用者填寫的 model／來源網址只作未驗證備註，不當供應商證明；回覆視為不可信文字，渲染不得執行指令碼／命令。

既有 `completion.hash` 正規化 CRLF→LF，欄位必須標記 `taskHashAlgorithm: hub-completion-crlf-to-lf-v1`；另加 task 原始 bytes 的 `rawTaskSHA256` 與 Root／FileID。prompt 與結果使用精確 UTF-8 bytes SHA-256，不能把正規化 completion hash 混稱為 raw 檔案 hash。來源檢查包含被截斷前完整來源 bytes，不能只 hash 可見片段或依 mtime 快取。

### 6.3 跨檔儲存與當機復原

狀態為 `preview → approved → planned → chat_saved → task_note_saved → committed`。`approved` 的撤銷／到期阻止新接受；已進 `planned` 的交易只允許完成同一組已接受 bytes 或明列復原失敗。

在 project/task 專用鎖下，先驗證 fresh identities／hash，再 durable 儲存 `planned`，其中綁定唯一 chat row ID、request／結果 digest、作業檔案 expected-before/after、將寫入的精確內容及順序。寫入會話後 flush／核對，再用保留 FileID 與預期內容的受控作業更新；兩項儲存與 terminal journal durable 後才回完整成功／emit 更新。

部分寫入失敗回 `{partial:true, chatSaved, taskNoteSaved, recoveryRequired}`，保留已儲存回答；不可重複 append、吞掉記事錯誤、刪除回答或將失敗標成 committed。重啟時以嚴格 JSONL parser、已知 row ID／digest、file identity 與 journal 對帳。檔案被外部改動、journal 壞掉或不能判定是否寫入時保留未知狀態，人工處理；不能從未知狀態補一個成功事件。

worker／AI 不可改 receipt journal，journal 使用原生 controller 管理的受限目錄。不可避免的 host owner／admin 修改不在本地 journal 完整性保證內。hash 與本地記錄僅支援重試對帳，不是可信簽章、外部 attestation 或 WORM。

### 6.4 舊介面相容界線

保留 `/api/chatgpt/prompt` 與 `/api/chatgpt/result` routes、actor ID 和舊會話；內部委派同一 handoff service，prompt 回應保留 `text`。legacy prompt 固定 actor=`chatgpt`，作為 Confirm adapter，必須提供 `previewToken/expectedTaskHash/expectedPromptSHA256/confirm:true` 並核對完整來源 receipt，不能接受舊三欄後直接提供可複製 prompt。新增預覽／確認與 receipt 是**必要的行為及 API 契約變更**：legacy prompt 缺預覽／確認，或 legacy result 的 `{project,task,text}` 缺 receipt/token/requestId，均回 `409 HANDOFF_PREVIEW_REQUIRED`，不自動替舊 client 核准。第一方 UI 與 tests 同時升級。

現有 MCP registration routes 不遷入 web-manual。ChatGPT／Claude 普通網頁 Chat 不因 MCP 已寫入 Codex config 就取得本機工具，也不要求為完成此手動流程而額外設定網頁 connector。

## 7. CLI adapter 與 worker 信任邊界

每個 adapter 實作已驗證版本的 handshake、session／resume、model selection、stream events、tool approval、terminal input／resize、取消與退出；輸入／輸出有長度、時間、事件型別與狀態限制。無法取得用量或供應商不支援能力時明列「不可取得／不支援」，不生成零值或假成功。未知 binary／protocol version 不自動啟用，也不使用全域 always-approve、YOLO 或 skip-permissions。

Windows `.cmd` 僅作入口定位，不用 prompt 經 `cmd.exe` 拼接執行。binary path、package source、SHA、version 與 sandbox profile 必須被 controller 固定；更新下載先進 staged 版本，驗證後 activation，失敗保留目前版本；不自動更新使用者全域 CLI。

### 7.1 Whole-process 控制

- 外部強制隔離在 CLI 第一個指令前生效，涵蓋內建 read/write、shell、MCP、hooks、plugins、Git helpers 及所有 descendants。CLI 自身 shell sandbox 僅為其中一層，不替代此邊界。
- VM 無任意 host disk、剪貼簿、agent socket、Hub 管理 socket 共享。只接受結構化 run 請求及受限 file broker；身分與 permit 各自綁定，guest 不能自行擴大 controller 工作根。
- WSL 候選額外檢查實際 mounts、UID／capabilities、FDs／sockets、Windows interop、環境、kernel 與 sandbox profile。CLI 不具 sudo／capabilities／可寫 cgroup 或 supervisor 控制 socket。這些限制與探針不把 WSL 改稱主機安全邊界。
- 不默改影響所有 distro 的 `.wslconfig`。關閉 automount 與 fstab、Windows PATH／interop 只降暴露；配置檔存在不是已生效證據。[Microsoft WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- worker 的網路 namespace／egress broker 只允許此次 provider／登入的已審核目的地；IPv4／IPv6、literal IP、DNS、DoH、redirect、CONNECT、proxy、host／LAN／其他 run 均檢查。NAT 或 mirrored 不是網路隔離。[Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)
- 模型 API 的 CLI 本體網路與 shell／MCP 子程序網路分別量測；核准一個 provider 不允許任意 web destination。需放行專案網路時重新預覽精確目的地，不能因工具報錯把整台主機或網路解禁。

### 7.2 工作鏡像、Git 與成果回收

controller 建立已綁定作業 raw bytes／FileID、repo HEAD／工作狀態／共享 refs 的 guest task copy；不 live 掛載 Windows Product／Work／`_hub` 或 auth home。`.git` 中的 Windows worktree 絕對指標不直接帶入 Linux，guest Git metadata 必須獨立且經過驗證。容許的 source files 與可執行設定（hooks／MCP／filters）各自審核，不能從專案核准推定所有設定可執行。

guest 成果先進入 create-only host staging，經 Windows 驗證普通檔案類型、名稱、內容 SHA、允許範圍及當前 base，再進既有 reviewed merge。拒絕 symlink／reparse／hardlink／special file、ADS、裝置／保留名稱、case／Unicode collision。CRLF／LF、Git modes／filters、未追蹤檔均明確顯示；不偷偷轉換後認為內容相同。禁止自動 push。

一般成果回收排除 guest `.git`、Git hooks／config／objects、provider auth／profile、MCP 控制資料、秘密供應副本／baseline 與 worker journal；普通檔案型別不代表可匯入。Git commits 或可執行設定需走獨立且版本化的 owner 預覽／匯入契約。流程先在 owned 子樹退出後清理秘密，再形成排除控制資料的成果快照及回收收據；清理失敗或不能辨認控制資料則保留 partial，不宣稱已回收乾淨成果。

排除已知控制／供應資料不代表一般成果內容沒有機密；成果仍須人工預覽審查，不把這個機制描述成完整自動去敏能力。

作業檔與 repo 變動、Root FileID 改變或共享 refs 不一致時拒絕 import／merge 並保留成果。外部 import／merge 在 active lease 下仍拒絕；原 run 的 controller 私有回收僅依第 7.3 節的 collecting 契約執行，不視為外部 import／merge。來源、目的身分或其他 run 衝突時仍拒絕並保留成果。現有 direct mode 對新 provider 不默許 guest 改 host 本體；需要真實 host 操作時經 controller 顯示具體變更、preview 與一次性授權。此 broker 流程驗收成功後才可稱新 CLI 已保留該功能。

### 7.3 程序生命週期與復原

Windows Job／目錄 pin 負責現有 Windows 生命週期及身分，**不是通用 AppContainer／restricted-token 證明**。Windows Job 管 `wsl.exe` 前端也不證明 Linux daemon 已退出。

Linux runtime 使用可信 supervisor，在第一個 CLI 指令前加入不可自遷移的 per-run cgroup v2；run 綁定 boot ID／supervisor identity／cgroup。取消須終止整棵 owned 子樹，並驗證 `cgroup.events populated=0`，不是只看主程序退出或 pipe EOF。[Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

同 task／base repo 的 lease 在 owned children 全退出、成果回收狀態儲存、run secrets 清理成功前保留；不能切 provider 後留下舊 MCP／hook daemon。CLI 聲稱完成但 child 仍活著仍為 busy。CPU／memory／process 數、磁碟／輸出、wall time 有明確上限，超限／OOM／清理失敗回 partial。

正常 run 狀態依序為 `running → stopping → cleaning → collecting → closed`，任一階段失敗保留該階段及明確錯誤，不前進到 closed。程序樹已確認退出後，controller 可在原 lease 下做同 run 的私有清理／回收，綁原 actor／profile／來源及目的身分；HTTP／MCP 不能傳入豁免參數。此操作不是外部 reviewed merge，不授權改本體；其他 run、外部 import／merge 與 metadata mutation 仍受互斥限制。回收收據及秘密清理均成功才解除 lease，本體合併另需最新預覽與一次性核准。

Hub 重啟、PID 重用、guest boot 變化、journal 壞掉時不自動重新發 permit。只能在精確身分與實際程序證據成立時復原；無法辨認則保留鎖與證據供人工處理。不以全域 `wsl --shutdown` 當單 task cancel，不終止無關 distro／程序。停止獨占 VM 也只能在核對所有權後使用。

## 8. 實作覆蓋範圍與驗收

所有檢查記錄 provider、OS/kernel、CLI binary/version/hash、profile、fixture 或 live 類別、時間、命令、exit、證據及未量測項目。每個 provider 獨立作結論，不借用 Codex 測試當新 CLI 通過。

### 8.1 共用與網頁流程

| 範圍 | 必要成功與拒絕路徑 |
|---|---|
| 繁體中文 | 預設 TC、日文切換、彈窗／錯誤／gptback／空會話、保留使用者原文；prompt 語言一致 |
| Registry／遷移 | 六 actor 精確識別、舊 roles/history 可讀、未知 actor/model 拒絕、`claude-chat`不 spawnCLI、破損/跨檔引用拒絕 |
| Preview／資料 | 兩個網站、實際內容與截斷、UTF-8 邊界、來源變更拒絕、目的地不可由輸入改寫、無網路送 prompt／無 auth 讀取 |
| receipt | owner 與 task/provider 綁定、到期／撤銷／重放／跨 task／digest 偽造拒絕、確認前不接受結果、token 不獲 CLI/MCP 權 |
| 儲存／復原 | 正常兩檔 committed；分別在 journal/chat/task/terminal-flush 注入故障；同筆不重複、外部改寫未知、partial 不假成功 |
| 渲染／安全 | HTML/script 注入不執行、過大/NUL/破損編碼／JSON escaped 孤立 surrogate 拒絕、敏感 token 不進 URL／記錄、CSRF/Origin/遠端權限沿用 |
| 交回 CLI | 不自動執行/mark complete；選確切 provider/model 後的新核准；舊 receipt 不能替新 CLI 授權 |

自動 tests 使用非敏感 fixture，不冒充真實網站互動。真實網頁驗收由使用者以已登入網頁手動送出明示的合成測試文字並貼回；未執行時標為待驗證，不宣稱已端到端連通。

### 8.2 每個新 CLI 的功能門檻

會話／續聊／角色模型、工具核准與拒絕／逾時、終端機 Unicode／resize／stop、並行互斥、委派／整合、Git 差異／reviewed merge、非 Git／首次提交、配置供應、圖片格式、MCP 工具範圍、用量／更新／錯誤、整理還原與安裝回復。供應商明確不支援的項單列真實能力差異；關鍵原功能未提供時不稱完整復原。

先用假 CLI 測協議及失敗，再用精確已驗證 binary 執行合成離線隔離探針；模型連線仍需明示目的地、合成 prompt、可能費用及使用者授權。不能上傳現有私有專案作為方便的 smoke test。

以下矩陣是驗收要求，**不是目前能力實測表**。`M` 為必須提供並驗證，`N` 為此 transport 不適用；不得將 `N` 說成通過，也不得因未實作將 `M` 改成可選。

| 能力 | Codex | Claude CLI | Agy CLI | Grok CLI | ChatGPT Chat | Claude Chat |
|---|---|---|---|---|---|---|
| 繁體中文、作業／角色／歷史精確綁定 | M | M | M | M | M | M |
| 訊息、串流、續聊、佇列及作業中取消／追加說明／下一指示 | M | M | M | M | N | N |
| 工具核准／拒絕／逾時與受控檔案／命令執行 | M | M | M | M | N | N |
| 終端機輸入／resize／停止與模型切換 | M | M | M | M | N | N |
| 上限交接、transcript 交接、委派／整合 | M | M | M | M | N | N |
| Git／非 Git、差異／成果回收／核准合併、配置／圖片、MCP | M | M | M | M | N | N |
| 網頁預覽／確認／複製／開站／人工貼回交易 | N | N | N | N | M | M |
| 用量／更新／整理還原／啟停的真實狀態與失敗處理 | M | M | M | M | M（適用 Hub 部分） | M（適用 Hub 部分） |

保留原功能不等於假造供應商能力。供應商不提供用量等資料時須呈現不可取得；對上列必要工作流程若無官方能力或無法建立實際等效流程，該 provider 未就緒。需調整需求時由使用者決定，不能只列限制後把完整整合標成完成。三個新 CLI 及兩個網頁入口全部通過各自 M，且 Codex 回歸符合基線，才達成此新增整合範圍；任何入口未通過只能交付明列範圍的部分版本。

### 8.3 整個 CLI 的最低隔離門檻

平台機制按實際 runtime 套用；共同必須證明整個 CLI 的檔案／網路限制、host 控制資料不可見、完整 owned 子樹退出及不影響無關程序。

| runtime | 程序退出／主機整合證據 |
|---|---|
| Linux VM | per-run cgroup／supervisor／boot ID；驗 VM 的受限 host 共享及 broker；沒有 DrvFs／interop 時證明其不存在，不以跳過當隔離通過 |
| WSL2 候選 | Linux cgroup 證據，另驗 DrvFs／interop／Windows 程序；仍不稱 host 安全邊界 |
| 原生 Windows 候選 | 首指令前受限 token／AppContainer 或等效強制隔離、owned Job／禁止 breakaway／全部子樹退出證據；Job 不代替檔案／網路隔離，不要求不存在的 Linux cgroup |

以下 Linux／WSL 專屬案例依此表轉為相應平台的繞過與生命週期測試，不能全部跳過而套用其他 provider 的結果。

1. built-in read/write、shell、MCP、hooks 分別對合成 host／其他 task marker 嘗試存取，受範圍限制。
2. sandbox 失效、profile 變化、未知 kernel/binary：CLI 沒有執行、無自動降級。
3. manual DrvFs mount／Windows 絕對路徑／interop socket 無法繞過；Windows 程序啟動受拒。
4. IPv4/IPv6 host／loopback／LAN／其他 run 及 TCP/UDP/Unix socket 測量；IP/DNS/DoH/redirect/CONNECT/proxy 繞過受拒，核准 provider 連線成功。
5. Hub owner token、其他 provider auth、SSH/Docker 不可見；自身 auth 可見程度如實呈現，不把 read-only 稱保密。
6. provider/model/destination 變化 invalidate 原 grants/secrets，guest 無法核准或換 profile。
7. symlink/hardlink/special/ADS/Windows 保留字／case 與 Unicode 碰撞拒絕，CRLF/LF／Git flags/filters 不默轉。
8. host HEAD/task/Root FileID/shared refs 變化：import/merge 拒絕且保留產物。
9. double-fork、setsid、背景 MCP/hook 仍在 run cgroup；concurrent fork/cancel/Hub crash/前端 EOF 後 owned 子樹確實退出。
10. CLI 退出但 child 活著時仍 busy、不清秘密、不解鎖；無關 Linux 程序與 distro 存活、無全域 shutdown。
11. cold orphan、壞 journal、PID/cgroup 重用拒絕假復原；resource/cleanup failure 呈 partial。

WSL 通過這些功能探針，仍不產生 Microsoft 未承諾的 Windows-host 邊界。獨立 VM／原生方案也需逐項測量實際配置，不因產品名稱宣稱安全。

## 9. 交付階段與審閱事項

1. **本文件階段**：正式設計、來源與現況證據、介面及驗收邊界；未新增能力。
2. **計畫階段**：書面規格核准後先形成含有限可行性驗證的實作計畫，列具體 runtime 候選、binary／版本來源、OS 安裝範圍、資源／權限／重開機影響、合成探針與停止門檻；使用者審閱並選擇執行方法後才執行。探針結果用於細化工程工時、Schema／遷移／測試與各 provider 的交付安排；若改變已核准 runtime／系統範圍則先更新可審閱計畫，不逕自擴大安裝。
3. **共用／網頁交付**：TC registry、兩網頁 handoff、durable receipts 與相容遷移，獨立形成可安裝版本。
4. **worker 及逐 provider 交付**：先隔離／生命週期驗證，再協議與功能；每個 CLI 獨立報告已實作／已驗證／限制。
5. **完整交付**：現有 Codex 回歸、多 provider 成功與重要拒絕路徑、所有相關 Schema/文件/範例、版本套件與回復驗證；保留不成功事項，不用零 finding 宣稱整體安全。

需要審閱的架構決定：推薦保留原生 Codex，兩個網頁 Chat 手動交接；新 CLI 的 host 隔離優先評估獨立管理 VM，不以 WSL2 單獨作為保證。VM 產品、是否需系統功能／重開機及資源尚未確定，列為計畫階段必須解決的具體門檻；不默默安裝。如果僅選 WSL2 相容 runtime，需承認其邊界限制，不能按同等 host 隔離標準宣稱已完成。

本規格由 `brainstorming` architectural 流程要求先審閱書面規格，再形成並審閱實作計畫。此處的待審閱是設計階段門檻，不是要求再次核准已有 Codex 功能或泛化授予外部操作。

## 10. 對應現有程式碼與後續同步

目標變更集中在 `hub/lib/launch.js`、`roles.js`、`cli-platform.js`、`chat.js`、`workspace-runtime.js`、reviewed-workspace 授權、procwatch/transcript/update、`hub/server.js` 的 web handoff 及`hub/public/app.js`/TC catalogs；增加專門 registry/handoff/worker modules，避免在大檔案堆 provider 分支。舊 `local-journal.js` 可重用 durable 寫入原語，但不是跨檔 receipt 交易完整實作。

實作時必須同時提交版本化 Schema、合法及拒絕範例、遷移／操作／回復說明與針對行為的測試。保持既有原生 Codex 狀態、上游歷史文件及使用者變更。現有 2026-10-08 規格保留歷史狀態；涉及本新增範圍的架構判斷以本規格與後續核准計畫為準。

本次僅修改設計文件；驗證涵蓋格式、來源摘要與規格一致性。尚未進行本新增功能的程式碼測試、Python unittest 或真實 provider 驗收。
