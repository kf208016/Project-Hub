# Windows Claude／Grok 執行接線狀態

更新2026-10-19。本頁區分產品程式、離線測試與實際模型驗證；目前 **安裝版Claude／Grok仍未啟用，這批未安裝**。來源候選流程已接通私有runtime與owner授權，正式模型驗收仍未通過。

## 最新正式接線（2026-10-19，第2批後）

第2批正式重跑亦未通過，未重試或安裝：Claude原CLI的nlink=2在spawn前拒絕；Grok初始化未ready、exit125且程序樹清理有效，確切根因未保存。修正後validation-14的653項Node／103項Python離線回歸通過；不代表真實自主流程或安裝版通過。

Claude固定私有副本已在來源改走現有原生HANDLE broker；Grok工具ID與native固定錯誤碼也已修正。這些修正只經離線fixture／真實檔案helper／loopback驗證，沒有再用既有登入執行CLI，亦沒有建立真實provider副本。最新契約見 [NATIVE-PROVIDER-INTEGRATION.md](NATIVE-PROVIDER-INTEGRATION.md)。

兩個一次重跑額度均已使用；完整命令、原生子代理、Hub委派、續接、拒絕及停止仍待正式模型與安裝版驗收。背景子代理生命週期的實際ACP與owner綁定仍未知；raw PTY未接線。缺收據仍保留busy，不偽造清理證據。

### 實體 runtime 根與 profile v4

候選啟動設定以必填的 controller 私有 `runtimeBase` 衍生 `runtime/<rootFingerprint>/<actor>/` 下的 temp、MCP 及 Grok 狀態，Claude 固定 hash 副本也從同一 base 的 `runtime-binaries/claude/` 衍生。`runtimeBase` 由既有 owner 的 ProjectHub 根經 native realpath 及 HANDLE identity 核對；僅接受原路徑或同 owner 的固定 MSIX LocalCache 結構，不從 HTTP／MCP 或環境變數直接接受任意根，也不建立缺失根或放寬原生 path gate。

`USERPROFILE=ownerHome` 適用兩個 provider；Grok 的其他 home／AppData 變數維持私有狀態目錄。這保留原 filesystem grant，避開 Windows sandbox 對等於 profile 的 write root 所做既有子項展開。runtime profile policy v4 綁定實體 base 路徑、root fingerprint 與固定 `owner-home` 模式；路徑或實體目錄身分改變時，舊預覽、授權及對話 session 綁定拒絕沿用，不清空原資料或靜默建立新 session。這些路徑與 profile 契約不代表正式模型或安裝版驗收已通過。

## 先前收窄驗收履歷

以下保留各開發階段的範圍與證據；提及當時「未接入server」或早期420項計數均是歷史，不代表最新來源仍停在該階段。

### 當時已落入原碼

- `lib/provider-sandbox.js`：Sonnet 產生的通道程式經本機修正，建立固定參數陣列呼叫官方 `codex sandbox`，使用目前工作區的原生 root pin 與既有 Job supervisor；沒有直接、無沙箱的 fallback。
- 指定 Claude／Grok 執行檔 SHA-256，以及 admission 提供的 Codex 預期雜湊。Windows x64、build 26200；不是其他 Windows 版本已通過的聲明。
- 工作區可寫，`.git`、`.agents`、`.codex`、`.aws` 保持唯讀；讀取基線為 `:minimal`，不加入 `:root` 廣泛讀取。此版本不接受工作區外的 `stateRoots`，因此尚不能據此聲稱原生 session 保存可用。
- 清除環境中的 API key、proxy、preload 與 Hub 設定，TMP 在本工作區；沒有讀取或複製 provider 憑證。`networkAccess` 預設 false；明確 true 代表允許網路，不是目的地 allowlist。
- `managed-process.js`／`job-runner.cs`：取消訊號保留專用 owner pipe，待 Job 清空、root 結束後回傳一次 nonce 綁定回報；父程序僅於通道完整 EOF 後接受。沒有回報／額外資料／破損回報均不宣稱清理已驗證。此回報是本機程序監督結果，不是外部簽章或 attestation。
- `lib/claude-native-bridge.js`：Sonnet 草稿經本機修正的雙向 stdio adapter，包含 initialize、原生 session、工具核准與固定失敗狀態。端點由 controller 提供，沒有直接 spawn／無沙箱 fallback；成功事件須等原生結果、退出碼 0 與 owned-tree 回報。
- `lib/grok-native-bridge.js`：Sonnet ACP 草稿經本機修正，包含 initialize、new/load、指定模型、工具狀態及一次性 owner 核准。未知自訂通知僅作無權限的資料忽略；目前 session 的無憑證 401 重試通知則以固定 `GROK_NATIVE_AUTH_UNAVAILABLE` 停止，不暴露原始原因文字、不授權更新憑證。反向檔案／終端要求拒絕。端點仍由 controller 供應；這不是已接入安裝版的聲明。
- `windows/provider-native-bridge.schema.json`：記錄兩個 adapter 的完成／核准資料契約。完成必須包含有效的 owned-tree 回報，且回報退出碼與實際 child close 相同；Schema 本身不證明程序、帳號或任務結果。
- `lib/provider-egress.js`：僅綁 loopback 的有認證 CONNECT broker，限定 provider 主機、443 與相同 TLS SNI；拒絕私有／混合 DNS、ECH、一般 HTTP、超限及逾時。不解密 TLS、不安裝憑證。必須搭配 OS 直接網路拒絕；proxy 設定本身可被繞過，不能單獨當隔離。
- `lib/provider-test-tools.js`：僅供合成驗收的固定算術 MCP。先拒絕非白名單原碼，再執行固定可信斷言；不 eval／require 模型原碼，也不是正式通用命令工具。
- `lib/provider-session-binding.js` 與 metadata reader：選填綁定的範圍／原生 ID 不一致即拒絕。舊 session 不自動採用。詳見 `CHAT-CONTINUITY.md`。
- `lib/providers/grok-tool-state.js`：Sonnet 產出後經本機審查修正的純 ACP tool-state reducer。允許 owner 預覽前的串流輸入更新；一旦產生核准預覽，原生輸入／名稱／種類固定，不能由 wire 的 requested／locked 欄位解除。null／省略保留原值，輸出進度不授予權限。
- `lib/providers/rpc-response-diagnostic.js`：Sonnet 產出後經本機審查的內部脫敏診斷。無法對應的回應只記 ID 類型／既有關係、回應種類、形狀分類、數字錯誤碼與固定待回方法；不保存原始 ID、內容、帳號、錯誤文字或 `_meta`。形狀不證明來源，未知／重複回應仍拒絕。
- `lib/providers/grok-internal-notice.js`：Sonnet依固定官方來源實作並經本機修正，僅辨識skills-reload／workflows-reload與精確巢狀成功計數格式。官方stdio會將內部watcher請求寫入同一ACP stream；這些ACK沒有Hub pending call，僅丟棄並累計固定種類，不核准、不重載、不改session／模型、不完成回合。每endpoint合計上限64；其他未知、錯誤、額外欄位與重複client回應仍拒絕。
- `ChatRunner`：控制端私有 handler、原生 planner、session 綁定發布、queue／unknown 清理保留已接入內部流程。綁定先原子保存再送 prompt；沒有 handler 或能力核准即拒絕。server 尚未供應正式 handler，不會因此解除 registry gate。細節與限制見 `CHAT-CONTINUITY.md`。

## 已驗證的範圍

- 官方 `codex sandbox` 在本機能轉送 stdin／stdout／stderr，退出碼 0。此版 `-P` 為必要參數，僅傳舊 `sandbox_mode` 會被 CLI 拒絕。
- 一次獨立合成 Claude／Sonnet 回合：Read、Write、Bash 實際建立 `add.js` 並通過 Node 加法斷言。該驗證使用較寬的舊讀取設定；**不證明這個收窄後的產品啟動設定、原生 session 保存或安裝版 Hub 可用**。
- 主機端受影響測試最近一批為 **420/420，無 skip**（`validation-08`）。包含 Job 正常退出／取消／owner crash、root pin、Codex bridge／chat、provider registry 仍拒絕未驗證 provider、協定／controller、新啟動計畫、出口與續接資料拒絕路徑、串流工具輸入、ChatRunner 原生接線、工作區清理保留、RPC診斷，以及精確watcher ACK、偽完成拒絕與通知上限。首次編譯使用atomic hard link create，保留已執行runner。原子rename測試須在主機執行；受限環境EPERM不作產品通過證據。
- 真正官方 Windows sandbox 內的 Node 父子程序停止驗收：Hub Job/root pin 包住 sandbox launcher，Stop 後 30 ms 觀察到測試內層父子 PID 均已消失，外層 Job 清空回報有效。該次沒有模型、憑證或網路；不代表任意第三方 CLI 的背景服務與外部 MCP 都已受同等驗證。
- Python unittest 103/103。這些計數不包含真實 Claude／Grok 完整 agent、MCP、委派或對話續接驗收。
- 實際 OS 網路驗收：在 `network.enabled=false` 內，合成程序可到自建 loopback，對 Anthropic 443 的直接連線失敗；經限定 CONNECT broker 則成功完成 Anthropic TLS 憑證驗證與無認證 GET。未呼叫模型或讀憑證；不推論全部協定／目的地或主機服務都被封鎖。
- 依使用者具體授權，固定版 Claude 唯讀使用自己的兩個登入檔；測試腳本不讀／複製憑證內容。限制為 Read／Write／固定算術 MCP，禁止一般 Bash、PowerShell、委派與網路工具。OS 直接網路拒絕、出口限定 Anthropic。兩個獨立 endpoint 使用相同原生 session，第二回合正確回憶第一回合標記、修改 `add.js` 並取得 stage 2 MCP 實際回覆；兩次程序退出碼 0、owned-tree 回報有效。
- 上項已分別經 CLI 直接啟動與新的雙向 adapter 實測；後者記錄 `claude-duplex-continuity-02`。首輪測試有 safe-mode 停用 MCP、漏答標記與缺少 backendId 的失敗紀錄，保留原始結果，不回寫為成功。這些是固定合成專案驗收，未證明通用命令、完整委派、已安裝 Hub 或 Grok 可用。
- 真實 owner 工具核准回路：移除 Write 的預先允許，兩回合各收到一筆 CLI 的 Write 請求；測試 controller 只接受本合成根內 `add.js` 的對應固定算術內容。核准綁定 project／task／session 後，CLI 繼續完成 MCP 驗證與續接，兩次 owned-tree 回報有效（`claude-duplex-approval-01`）。這不是對通用命令的 blanket approval。
- Grok 限定 bootstrap 已完成 initialize／session/new 與 `grok-4.6` 選擇。controller 隨即取消，退出碼 125、owned-tree 清空；沒有 prompt。**建立本機 session 不證明服務端帳號認證有效**，也不是成功的模型回合。
- Grok 合成續接第一次（`grok-narrow-continuity-01`）未通過：首回合 110 秒逾時、程序樹已清空，無工具操作／標記回憶／MCP 成功。CLI 紀錄顯示 `auth.json.lock` 無法開啟，請求未帶憑證而重試 401；沒有把登入檔改成可寫或擴大出口。
- 該失敗回合也將本機全域技能名稱／摘要載入待送的模型上下文，不符合「僅合成資料」邊界；TLS 沒有解密，不能逐項證明服務端收到哪些內容。不讀取或複製憑證的測試腳本，不能防止 CLI 自己的設定探索。
- 第二次（`grok-narrow-continuity-02/owner-stop-summary.json`）依使用者授權僅增加既有 `auth.json.lock` 讀寫，登入檔仍唯讀，鎖定已實際取得。獨立 HOME、相容探索關閉與明確 agent profile 後，原生保存的工具定義恰為 `read_file`、`search_replace`、`search_tool`、`use_tool`；保存的合成對話未找到先前的全域技能標頭及私人 Claude skill 路徑標記。這是限定標記檢查，不證明任意檔案或全部 TLS 內容均未外傳。
- 第二次 CLI 隨後回報 `disk token expired`、OIDC 更新失敗及無憑證 401。依「需要更新憑證就停止」中斷 owner harness；已由主機程序查詢確認辨識到的 Grok PID 不存在。中斷造成完整 owned-tree 回報未取得，**不宣稱程序樹清理已驗證**。沒有工具／MCP 或兩回合續接通過。當時保留的第3次，已在使用者更新登入後執行；未擴大出口、未讀取或複製登入檔內容。
- 使用者回覆已登入後，第三次（`grok-narrow-continuity-03/summary.json`）已執行。初始化期間以 `GROK_NATIVE_SESSION_MISMATCH` 拒絕，session 尚未綁定、沒有模型任務或工具操作；CLI 保存的 native session 為 0 則訊息。程序退出碼125、rootExited／ownedTreeEmpty／cleanupVerified 均成立，broker 已關閉。登入更新不因此視為服務端認證或模型任務通過；初始化檔顯示 catalogue 預設 `grok-4.7`，沒有改用這個預設來完成指定的 `grok-4.6` 任務。
- 已修正 ready 前過度拒絕通知的協定處理：新 session 先到達的 metadata 待 response ID 核對；選模 ACK 前不送 prompt；`session/load` 的歷史回放只作既有資料消費，不顯示為新答案、不重建待核准操作、不執行舊工具。異 session／過早的工具核准仍拒絕；選模後若收到不同 model 狀態則停止。離線測試通過，第4次實測已通過這段初始化並到達模型工具請求。參照 [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup) 與固定 Grok revision 的 `session_setup.rs`／`acp_agent.rs`。
- 使用者另核准的第4次（`grok-narrow-continuity-04/summary.json`）已使用：實際回報 `grok-4.6`，到達第一個 pending `read_file`，隨後橋接器把 owner 預覽前的串流 rawInput 更新誤判為 `GROK_NATIVE_TOOL_CHANGED` 而停止。沒有工具核准、合成改檔、MCP 或兩回合通過；退出碼125、完整 owned-tree 回報有效、broker已關閉。通過的入口僅為原核准2個主機，沒有因35次拒絕而擴權。
- 已依 [ACP v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) 修正上述串流狀態，並保留預覽後不可變與一次核准防重放。第5次實測已實際跨過串流工具處理，尚未完成整個開發回合。
- 使用者另核准的第5次（`grok-narrow-continuity-05/summary.json`）已使用：grok-4.6 實際讀取 seed.txt／add.js 並搜尋到指定 MCP 定義，之後以 `GROK_NATIVE_RESPONSE_UNKNOWN` 拒絕；沒有改檔、MCP執行或第二回合。退出碼125、完整owned-tree回報有效、broker關閉。原生保存的3筆tool_result確認2個合成檔案內容及MCP定義，工具清單仍為指定4項；限定標記檢查不是完整出口證明（`derived-audit.json`）。
- 第6次（`grok-narrow-continuity-06`）已依本輪最多2次授權執行，仍以未知RPC回應停止；分類為字串ID、非待回／非已回覆ID、result形狀other。未保存原始ID，不能據此確定原始來源。完整owned-tree回報有效，broker已關閉。
- 固定官方 `agent/app.rs`、`extensions/session_admin.rs`、`session/result.rs` 顯示內部watcher會產生額外RPC成功回覆。`grok-offline-watcher-02` 在未建立session、未提供既有auth、未送prompt、無broker及OS直接網路設定false時重現skills-reload回覆；`-03`另以新parser核對實際精確格式，均有完整owned-tree清理。`-01`的無認證session/new被拒，保留失敗，不作成功證據。這是原生協定重現，未使用模型或既有帳號額度。
- 修正後第7次（`grok-narrow-continuity-07`）已實際丟棄1個精確skills ACK，無未知RPC錯誤；Grok在一次owner核准後改好了add.js。接著固定MCP請求被owner測試核准器拒絕，回合未完成；原生exit0、bridge回報失敗、完整owned-tree回報有效，沒有第二回合。第5／6次的原始ID未保存，不能回溯證明是同一ACK；第7次確認此相容性修正有效。
- 第7次拒絕根因是測試核准器只接受兩個MCP參數欄位，未接受官方另附的variant=UseTool。新測試政策只增加精確tag與既有tool_name／stage組合，未知tag、額外命令、其他server／tool、錯stage仍拒絕，4項政策回歸通過。用第7次實際檔案呼叫固定MCP，stage1成功且原檔不變，錯用stage2明確拒絕（`grok-07-offline-mcp.json`）；這是owner端離線MCP驗證，**不是Grok已成功呼叫MCP或兩回合通過**。
- 使用者另追加1次的第8次（`grok-narrow-continuity-08/derived-audit.json`）已通過：指定grok-4.6，兩個獨占endpoint使用同一非空原生session，第二回合實際session/load並回憶首輪標記；兩回合均改檔正確並實際取得固定MCP成功回覆，每回合一次改檔與一次MCP owner核准。最終產物雜湊與第二回合MCP回應一致，兩次exit0／完整owned-tree回報有效，broker關閉。登入檔唯讀、僅既有鎖檔可寫，未要求更新憑證；載入工具恰為指定4項。148次連線被拒，接受的上游只在原2個主機內，未因此擴權。有限私人技能標記檢查通過，不等於TLS內容全部可見。
- 第8次使用了本次明確追加的唯一一次模型額度，沒有剩餘重跑授權；未安裝。收窄的合成續接成功不表示通用命令、完整委派或正式Hub接線已通過。

## 安裝版仍未啟用的原因

1. 來源已接通正式server與owner授權，但兩批正式模型嘗試均未通過；無模型回歸不能代替一般命令／子代理／委派驗收。
2. 先前收窄Claude／Grok兩回合與固定MCP通過，不表示現行完整工具政策已經真實驗證。
3. 本輪一次額度均已使用，依授權不重試、不安裝。先保留精確原始結果與修正後離線證據；後續模型及安裝版驗收仍是必要閘門。
4. 互動PTY尚未接線，來源Chat自主CLI候選與該入口分別呈現；Codex原終端機保留。

## CLI 啟動設定的修正

固定版 Claude `--help` 明示 `--safe-mode` 會關閉 MCP，因此與明確 MCP 驗收不相容。新的 adapter 使用 `--restricted`、空 `--setting-sources`、`disableAllHooks`、`autoMemoryEnabled=false` 與 `--strict-mcp-config`；測試端另外固定工具名單。原生 CLI 的控制回應 ID 位於 `response.request_id`，不是外層 request_id；已用真實雙向回合核對。正式功能仍須完成完整工具與已核准 MCP／委派驗收，沒有把測試名單當產品降級交付。

## 安裝前必要驗收

Claude、Grok 各自須通過：同 Hub task 第一回合讀寫／命令／已核准 MCP；第二個獨占 endpoint 續接同 provider session；越界／未註冊 MCP 拒絕；Stop 整棵樹清空及歷史保留；不盲目重送已接受指示；跨 provider 建新 session；最後版本封裝、安裝及安裝版驗收。安裝版在通過前不啟用這批功能；來源的預設registry仍拒絕沒有controller私有authority的Claude／Grok。不改成patch-only，也不以mock代替這些條件。

## Codex 雙版本審核邊界（R10）

Codex helper 只接受 `lib/codex-versions.js` 的 0.154.0／0.164.0 與各自精確
SHA-256；原生沙箱使用作用中槽位的雜湊，沒有槽位時仍須核對解析到的全域檔案。
未知版本回報 `NATIVE_CODEX_VERSION_UNREVIEWED`，引導至「設定 → AI 的更新」。

0.164.0 將 elevated 稱為 legacy。本輪仍固定 `windows.sandbox="elevated"`，
另外使用 `-c features.windows_sandbox_service=false`、`-c windows.allow_mxc=false`、
`-c features.prefer_mxc=false`，不使用舊版不接受的 `--disable`。
Windows Codex 終端機一律加上 `-c features.daemon_auto_start=false`，僅作用中
槽位為 0.164.0 時再加 `--no-daemon`。CODEX_HOME 仍共用，分離決策尚未執行。

這是程式與離線 fixture 的相容支援，不代表 0.164.0 沙箱已通過真機驗收。
仍須檢查首次 UAC／佈建、service 與登錄狀態、檔案／網路隔離、Job 清空、
取消／EOF、daemon、舊對話續接與 MCP 實際工具握手，並演練回滾 0.154.0。

## Grok 版本允許清單與 Hub 私有槽（R14，待真機驗收）

`lib/grok-versions.js` 記錄兩個已審核發行檔；符合雜湊只證明 bytes 相符，不代表真機驗收。

| 版本 | SHA-256 | bytes | version string |
|---|---|---|---|
| 1.0.34 | `021d8f7f6bdf9db48b6c87e799cd99130a76c463e6e6a3161510839aed016d94` | 151293256 | `grok 1.0.34 (3736acbc8658)` |
| 1.0.70 | `1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326` | 176011920 | `grok 1.0.70 (f50904eaee6c)` |

1.0.70 的 helper 雜湊僅供驗收交叉核對，不是啟動關卡；Hub 不執行這些 helper：

- `agent.exe`：`1e03c16cf2bd4626a79d6b1ea1430f88c38e0c8ec75edd283a60de11296ba326`
- `grove.exe`：`aa11dd2e214fef7f49ebe6509a3e8dd88b597344a5fc77857c7bf03ce0d8d7a7`
- `grove-credential.exe`：`772355911d4deee3c3b36439e850c4be6ceb3f7604086f74140f797a3a55e4c6`
- `grove-fsmonitor.exe`：`df4f522f115cf7246d9449cd905ff61e0c2e8c0c1f9939d12326209f22009480`

私有槽固定為 `<runtimeBase>\runtime-binaries\grok\<binaryHash>\grok.exe`。依 1.0.70、1.0.34 的順序，對每個版本依序嘗試下列既有來源：

1. `<ownerHome>\.grok\downloads\grok-<version>-windows-x86_64`
2. `<ownerHome>\.grok\bin\grok.exe`
3. `<ownerHome>\.grok\bin\grok.exe.old`

每次先由 private broker 檢查目的槽；正確槽存在即沿用，來源消失也不重複複製。來源與目的雜湊都由既有 broker 核對，不下載、不建立 active.json、不執行 CLI 查版本。Hub process 的 `PROJECT_HUB_GROK_VERSION` 可指定清單內版本；空值採偏好順序，未知 override 在 I/O 前拒絕。所有來源失敗以 `NATIVE_GROK_VERSION_UNREVIEWED`／HTTP 409／notStarted 拒絕，至多顯示 live 安裝雜湊前 12 字元；請勿回滾，保留 downloads 已審核發行檔並等待清單更新。啟動前再次核對失敗仍是 `NATIVE_HASH_MISMATCH`，sandbox 模組仍是 `ERR_HASH_MISMATCH`。若 live 安裝的雜湊本身在清單內、只是私有副本建立失敗（broker 或複製錯誤），則以 `NATIVE_BINARY_UNAVAILABLE` 拒絕，不會把已審核版本誤報為未審核。

Grok env 新增 `GROK_DISABLE_AUTOUPDATER=1`、`GROK_DISABLE_EXPERIMENTS=1`、`GROK_WORKTREE_TYPE=copy`、`GROK_CLONE=0`、`DISABLE_TELEMETRY=1`、`DISABLE_ERROR_REPORTING=1`；保留 `GROK_MEMORY=0`、`DO_NOT_TRACK=1`、`OTEL_TRACES_EXPORTER=none`。私有設定 `[cli]` 新增 `auto_update = false` 與 `grove_worktree = false`，避免自動更新、實驗、grove worktree 及額外遙測。刻意不設定 `GROK_AGENT_HOST_BACKEND`（不改 agent host backend），不使用不存在於此契約的 `grove = false` 或隱藏 `--no-auto-update` argv。

舊 config.toml 只有完全等於 `GROK_CONFIG_PREVIOUS` 時才遷移：沿用 regular file／非 symlink／nlink=1／大小限制，以同目錄 `config.toml.<pid>.tmp`、wx、0600、fsync 後 rename 原子替換並重新核對。外來內容回報 `NATIVE_CONFIG_CHANGED`；rename 失敗保留舊檔、清除本次暫存檔並回報 `NATIVE_CONFIG_WRITE_FAILED`。

`/api/state.grokStatus` 僅使用 `lstat` 中繼資料：登入檔／鎖檔是否存在、bytes、mtime，以及所選版本與邏輯私有槽是否存在。不讀取憑證內容、不回傳路徑、不代表登入有效或該槽雜湊已核對。顯示版本依 override／偏好決定；若實際 materialize 回退至 1.0.34，精確執行版本以 preview 的 `review.providerVersion` 為準。`policyVersion:4`、runtimeProfileId 輸入與 descriptor.scope 保持不變。

以下由 owner 在真機另行驗收，本輪未執行：

- [ ] 記錄 `~/.grok/bin` 雜湊與 mtime、`auth.json`／`auth.json.lock`／`models_cache.json` 大小與 mtime（不讀內容）、`active_sessions.json`，確認沒有從 `~/.grok/bin` 執行的程序。
- [ ] 本輪離線測試全部通過（既有失敗另記於候選 16 的回歸紀錄）。
- [ ] 透過 Hub 執行 Grok-only bootstrap：preview 200、providerSHA256 為 `1e03c16c…`、providerVersion 為 1.0.70；私有槽只建立一次且為 176,011,920 bytes；initialize／session/new 成功；私有 `GROK_HOME/logs/unified.jsonl` 顯示私有 home 與 ver 1.0.70；退出後 ownedTreeEmpty，無 grove*.exe／agent.exe，除了鎖檔之外 `~/.grok` 不變、bin 雜湊不變。
- [ ] 完整一回合包含讀取、允許的寫入、越界寫入拒絕、一個已核准命令、一個 `.ps1`、一個 Task 子代理；之後私有 session 的 tool_definitions.json 是 8-tool GROK_PROFILE 的子集合，models_cache.json 形狀不變。
- [ ] 以 1.0.70 載入 1.0.34 時期對話：session/load 成功或透過 GROK_NATIVE_RESUME_FAILED 回退，不得掛住。
- [ ] 版本切換演練：以 PROJECT_HUB_GROK_VERSION=1.0.34 啟動 Hub，一回合確實從 1.0.34 私有槽執行；移除 override 後恢復 1.0.70。
- [ ] 持續觀察：使用者 TUI 自動更新超過 1.0.70 後，Hub 仍從私有槽執行 1.0.70；只有嘗試 preview 且無可用已審核副本時，顯示 live 安裝未審核的診斷。中繼資料狀態列本身不雜湊 live 安裝，不能獨立判斷未審核版本。

## 程序工具清單與對話顯示（R15，待真機驗收）

Grok 現在以 `--tools <GROK_PROCESS_TOOLS> agent --no-leader ... stdio` 啟動。
`--tools` 是 CLI 頂層選項，必須放在 `agent` 前；放在子命令後會被拒絕。
清單固定為 `read_file,grep,search_replace,write,run_terminal_cmd,task,search_tool,use_tool,get_task_output,wait_tasks,kill_task`。
前八項沿用 GROK_PROFILE 的工具順序，後三項是 Task companions。session/new 的
agentProfile 不會傳給 Task 子代理，因此加入程序層清單；是否確實限制子代理仍待真機驗收。
GROK_PROFILE、runtime profile hash 輸入、既有雜湊清單、設定與 env 不變。
native plan 保留四個 bypass flags 的全 argv 拒絕；舊 sandbox 路徑也拒絕同樣四個旗標。

新增 15 個 Grok／Claude 原生停止代碼的繁體中文訊息；未知但符合限定格式的
原生代碼使用安全檢查停止的中文 fallback，保留原 code。非原生代碼行為不變。
狀態列移除「登入檔鎖存在／未正常結束」推論，API 的 lockPresent／lockMtime 保留。

對話以 project/task 保存最多 20 個任務、每個最新 2000 列的記憶體快取。
重繪先顯示快取；尚未收到歷史資料時顯示「正在讀取對話…」，收到空 rows 才顯示空白提示。
舊串流事件被忽略；rows 渲染失敗保留原畫面並僅警告一次。CLOSED 錯誤在 2000 ms
後重連，首個 rows 在 8000 ms 未到達則重開；關閉、切換或 restart pause 都清除計時器。
同一任務最多一條串流；workspaceLifecycle 單獨變動不重建工作畫面。

以下由 owner 在真機另行驗收，本輪未執行；此清單取代 R14 的八工具子集合檢查：

- [ ] 合成專案執行一個 Grok 回合，產生一個 Task 子代理；主／子 session 的 tool_definitions.json
  將顯示名稱映回 ID 後，均為 GROK_PROCESS_TOOLS 的子集合。對照：run_terminal_command → run_terminal_cmd、
  spawn_subagent → task、get_command_or_subagent_output → get_task_output、
  wait_commands_or_subagents → wait_tasks、kill_command_or_subagent → kill_task。
  不得有 list_dir、todo_write、web_fetch、image_*、scheduler_*、monitor、workflow。
  若子代理仍有額外工具，表示清單未傳至子代理；下一輪另行評估 `--no-subagents` 並從 profile 移除 task，本輪不實施。
- [ ] 回合進行時對話區不顯示空白提示；結束後無須重新整理即可看到紀錄。
- [ ] 拒絕工作區外寫入時顯示中文 INCOMPLETE 訊息。
- [ ] Grok 狀態列不再提及鎖檔。

## 工具拒絕通知與原生回報（R16，待真機驗收）

原生 Grok／Claude 的 MCP 授權固定包含讀取、hub_report、hub_ask_owner、hub_mark_step。
work 開關只控制額外的檔案寫入、命令要求與委派授權；回報／提問使用 capability 的 actor
標示 Grok／Claude Code，未提供 actor 的既有呼叫維持 ChatGPT。profile/runtime hash 輸入不變。
未列在授權中的 Grok UseTool／Claude mcp__ 工具立即拒絕，不留下無效的待核准卡片。

拒絕、逾時、取消均保留原有 CLI 拒絕回覆，且每個要求只輸出一次 hub.tool_declined。
工具不會因拒絕而取得執行許可；對話以 NATIVE_TOOL_DECLINED 的 notice 列保存與顯示，
不需展開細節。標題移除控制字元並限制 300 字；核准卡片標示實際 AI。
已拒絕工具不再單獨使回合失敗；結束時仍待核准／未完成的操作、異常停止及清理失敗仍失敗。
Grok cancel 仍回傳 cancelled；若 CLI 以 cancelled 結束，仍為 INCOMPLETE。
未知工具的延後權限仍拒絕為 GROK_NATIVE_PERMISSION_STATE；Claude permission_denials 仍驗證陣列。
INCOMPLETE 訊息改為說明回合未正常結束，不再將所有工具拒絕描述為回合失敗。

Windows 聊天在作業副本中僅要求讀取台帳，以 hub_mark_step 標示步驟、hub_report 回報；
工具不可用時寫入回覆。直接模式、終端機與非 Windows 的提示文字維持原行為。
本輪驗證使用合成端點與暫存資料，不代表已通過真實 CLI 或 OS sandbox 驗收。

以下由 owner 安裝後在真機另行驗收，本輪不執行：

- [ ] 在 R14-grok-accept 同一個 Grok 回合，要求以 hub_mark_step 完成步驟 1、
  hub_report 回報一行，再嘗試寫入工作區外檔案。
- [ ] 步驟已勾選，台帳「## やったこと」出現「Grok：」，對話也顯示 Grok 回報列。
- [ ] 出現一則可見的「工具操作被 Hub 拒絕，已略過（沒有執行）：…」通知；
  工作區外沒有檔案被寫入，沒有待核准卡片殘留。
- [ ] Grok 回覆正常結束，沒有 INCOMPLETE。

## 自動更新 Grok 登入與單次重送（R17，待真機驗收）

Windows 在每次 Grok 回合準備前，以 auth.json 的 lstat metadata 判斷是否過期；預設門檻為 5 小時（實測 Grok 1.0.70 只在 token 過期時更新，壽命約 6 小時）。
檔案不存在時不啟動更新；新鮮時直接準備回合。更新失敗也繼續既有回合準備與授權檢查。
同一個 refresher 的並行要求共用一次更新，不會讀取或雜湊 auth.json 的內容。

登入更新使用與回合相同的已審核私有 Grok 槽、Codex launcher 與雜湊檢查，但有獨立的 sandbox。
固定命令為 agent --no-leader stdio；stdin 保持開啟且不寫入初始化訊息、prompt 或工具要求。
唯一網路目的地是 auth.x.ai:443（grok-auth provider）；原本 grok 與 claude 回合網路清單不變。
工作目錄、暫存與 GROK_HOME 位於 runtime/grok-auth-refresh 下；PATH 只包含 System32。
不授權工作區、Git、Hub lib、MCP 或 .claude。自動更新、實驗與遙測關閉。

為支援原子替換登入檔，更新程序取得 owner .grok 目錄寫入權限；bin 與 downloads 有巢狀唯讀限制。
這不是僅允許兩個檔名寫入的 OS 保證：執行前後比對 .grok 的直接項目名稱、型別與 metadata，
除了 auth.json、auth.json.lock 外，任何新增、移除或變更都記錄 integrity:changed 與名稱清單。
此檢查只涵蓋直接項目，不讀取檔案內容，也不宣稱遞迴內容防竄改。
stdout/stderr 只排空丟棄，有總量限制；不保存或輸出 CLI 的原始錯誤。
每 200 ms 檢查登入 metadata，變更穩定 1500 ms 或達 20000 ms 後終止程序，
等待 close 與 rootExited、ownedTreeEmpty、cleanupVerified 及相同 exitCode 的清理 receipt，再關閉 broker。
清理等待與 broker 關閉各限 5 秒；失敗記錄固定代碼，結果為 failed。
啟動後 10000 ms 內 broker 沒有接受過 auth.x.ai 連線、登入檔也未變，表示 token 仍有效：立即終止並記錄 quiet:true，
之後 15 分鐘內回合前不再檢查（期間若過期，由回合 auth-failure 重送路徑處理）。broker 的 onAudit 只觀察，不改變放行判斷。
紀錄 action 為 grok-auth-refresh，包含 trigger、refreshed/unchanged/failed、ms、integrity、changed（quiet 時另有 quiet:true）。

原生 Grok 回合遇到 GROK_NATIVE_AUTH_UNAVAILABLE 時，若未停止且尚未重試，保持 busy，
顯示不受詳細資料開關影響的 GROK_AUTH_REFRESHING 通知。更新成功後重新執行完整回合準備，
重新保留 endpoint、檢查工作區與 session 綁定、approval grant、MCP capability，再重送同一訊息一次。
不新增使用者列；成功重送不保存首次 auth 錯誤列。更新失敗或更新中停止則保留原 auth 錯誤與 grok login 提示。
第二次 auth 失敗不再重送；清理未確認時不進入重送。Claude、Codex 與其他錯誤不受影響。

PROJECT_HUB_GROK_AUTH_STALE_MS 僅在 server 啟動時讀取一次；十進位整數字串 60000 至 21600000
覆寫預設門檻，其他值忽略。此參數供 owner 驗收，不放寬回合授權或逾時限制。
本輪以假啟動器、broker、時鐘、檔案 metadata 與聊天端點驗證；未執行真實 CLI 或登入更新。

以下由 owner 安裝後在真機另行驗收，本輪不執行：

- [ ] 以 PROJECT_HUB_GROK_AUTH_STALE_MS=60000 啟動 Hub，距最後登入檔變更一分鐘後，
  在 R14-grok-accept 送出 Grok 回合；紀錄為 grok-auth-refresh refreshed/ok，auth.json 建立時間更新，
  owner .grok 的其他項目不變，回合正常回覆（token 仍有效時應為 unchanged＋quiet:true，約 10 秒內結束）。
- [ ] 移除 override，讓 token 自然過期後送出一個回合，確認回合前更新且正常回覆。
- [ ] 可重現回合中 AUTH 失敗時，確認顯示更新通知，重送一次後正常回覆；更新途中停止不再重送。

## Round 18 / F1

Grok CLI 在權限遭拒後會自行取消整個回合。若本回合已有 Hub 拒絕的工具、沒有待核准或延後的權限要求，
且所有工具均已結束或遭拒、owner 未停止回合，Hub 將此 cancelled 視為完成，並顯示 GROK_STOPPED_AFTER_DECLINE 通知。
工具拒絕與 NATIVE_TOOL_DECLINED 通知仍保留；owner 停止、未完成工具、其他異常停止與清理檢查的失敗行為不變。
此行為取代 R16 對 CLI cancelled 一律視為 INCOMPLETE 的說明；本輪僅以假程序驗證，未啟動真實 CLI 或 Hub。

## Round 18 / F2

For Grok operations classified as file, kind edit/delete/move accepts a path outside the workspace
only when at least one path alias is present, every alias has valid syntax, and all aliases resolve
to the same absolute path (case-insensitive). Sensitive extra fields still require manual review.
UseTool still accepts granted names; an ungranted name matching /^hub__[a-z][a-z0-9_]{0,63}$/ with
plain-object tool_input also accepts. The Hub capability check enforces the tool/project/task grant.
Owner-supplied probe evidence dated 2026-10-28 used the elevated codex sandbox with turn-shaped grants:
only the granted cwd was writable; a sibling on D:, D:\ root, C:\ root, C:\Users\Public,
C:\ProgramData, owner Documents, owner %TEMP%, and the read-only cwd\.git all refused writes with
UnauthorizedAccessException. This construction run did not repeat the live probe.
Outside-root reads, protected directories within the root, invalid paths, contradictory aliases,
non-string paths and ungranted non-Hub MCP tools still decline. Missing paths stay manual;
malformed MCP input stays declined. Reads are not confined to the workspace by the OS sandbox.
The OS sandbox and Hub capability check are the enforcing layers, returning ordinary tool errors
so Grok can continue instead of cancelling on Hub permission rejection. Claude, other operations,
the classifier and F1 are unchanged. The current classifier does not map delete/move kinds to file;
these conditional branches are tested with isolated classifier injection, without adding a mapping.

### Round 18: Grok login refresher disabled by default

A real-machine trial showed that a refresh inside the elevated Codex sandbox writes `%USERPROFILE%\.grok\auth.json` with Grok's owner-only ACL for the *sandbox* account, so the owner's own `grok` can no longer open its login. The round-17 refresher is therefore created only when `PROJECT_HUB_GROK_AUTH_REFRESH=1`. Without it, an expired login ends the turn with GROK_NATIVE_AUTH_UNAVAILABLE and the owner runs `grok` (or `grok login`) in an ordinary terminal, as before round 17.

## Round 19: Grok login gate and owner login window

Windows 原生 Grok 回合在 optional refresher 之後、runtime.prepareTurn 之前檢查 ownerHome
（與回合設定相同的 os.homedir()，不採 HUB_AI_HOME）的 .grok/auth.json metadata。
僅使用 lstat，不開啟、讀取、複製或雜湊登入檔內容；狀態與到期時間都是估計，不能證明 token 有效。
預設 TTL 為 21480000 ms（6 小時減 2 分鐘）；PROJECT_HUB_GROK_LOGIN_TTL_MS
只接受 600000 到 86400000 的十進位整數字串。缺檔／過期以 409、notStarted 拒絕回合；
metadata 不可讀或時間超前超過五分鐘屬 unknown，交給既有 credential 檢查繼續處理。Claude 不受影響。

本機 owner 可透過 POST /api/grok/login-window 開啟三種模式：refresh 執行 models，
login 執行 login，device 執行 login --device-auth。GET 查詢 metadata（不含即時年齡）與執行狀態。
POST 僅限本機 owner；遠端瀏覽器拒絕，DRY 不啟動程序。與回合相同的 Hub 私有 Grok 副本
由既有 grokFile 及 reviewedProvider 審核；home 必須與 USERPROFILE 相符。
隱藏 cmd 使用 start /wait 開啟可見 console，以 owner 身分執行，無 codex sandbox、
無 Hub proxy、無輸出擷取，且移除 Hub、GROK_HOME 與 proxy 環境變數。
refresh 最長 120 秒，login/device 最長 15 分鐘；逾時與 Hub 關閉時終止整棵程序樹。
同時只允許一個視窗；chats.running 的 ai 欄位判斷 Grok 回合是否執行中，
因 nativeProviderService.active() 只提供跨 provider 總數。

mtime 變新（含缺檔變為存在）顯示 refreshed；結束代碼 0 且 mtime 相同顯示 unchanged；
其他情況或逾時顯示 failed。refreshed 僅表示 metadata 更新，不是登入有效性的證明。
2026-10-28 真機：登入已自然過期時，owner 身分執行已審核 Grok 1.0.70 的 models 於 2 秒內以結束代碼 0 換新登入，
不開瀏覽器；auth.json 擁有者仍是 owner、DACL 只剩 owner FullControl、owner 可開啟。
更新權杖失效時 models 不會換新（顯示 unchanged），再改用登入 Grok／裝置碼。
UI 每 2 秒查詢、最多 16 分鐘；缺檔／過期提示保留在原 project/task 輸入框旁，
成功送出或 refreshed 才清除，永不自動重送訊息。
Round 17 refresher 保持預設關閉，PROJECT_HUB_GROK_AUTH_REFRESH=1 的既有開關與重試路徑不變。
接近到期才啟動的回合仍可能中途過期；原有失敗訊息會顯示同一組登入按鈕。
自動測試只用假程序及合成登入檔；可見視窗、taskkill 與按鈕流程仍待真機驗收。

## Round 20: remove sandbox grants from the Grok login files between turns

On 2026-10-28 the elevated codex 0.154.0 sandbox setup re-added a read ACE to
owner .grok/auth.json at 17:09:53, two minutes after the owner's own models
command had replaced it with an owner-only protected DACL. Read grants use
CodexSandboxUsers; write grants also include a per-workspace capability SID.
Codex does not remove these grants. Other codex-sandboxed processes, including
unrelated repositories, share CodexSandboxUsers and can read the refresh token.
The round-17 refresher experiment also left explicit inheritable Modify grants
on .grok, inherited by files such as bin/grok.exe on the owner's PATH.

The revoker considers exactly ownerHome/.grok, .grok/auth.json and
.grok/auth.json.lock in that order. ownerHome is os.homedir(), as in the turn
plan. It never walks the tree or reads credential contents. Missing targets
are reported missing; wrong kinds, symlinks, junctions and redirected paths
are skipped. icacls /save writes UTF-16LE ACL metadata to a fresh temporary
folder, which is removed after inspection. Only explicit DACL allow ACEs
whose resolved trustee is not the current process user, an optional SDDL O:
owner, SYSTEM (S-1-5-18), Administrators (S-1-5-32-544), CREATOR OWNER
(S-1-3-0), or OWNER RIGHTS (S-1-3-4) are foreign. Missing O: is normal:
real icacls /save emits D: only. Inherited, deny, audit and object ACEs are
left alone. Malformed SDDL fails closed.

currentUserSid is injectable. Its production default calls
<systemRoot>/System32/whoami.exe with ['/user','/fo','csv','/nh'] using
execFile, shell:false, windowsHide:true, a 10,000 ms timeout and a 64 KiB
maxBuffer. It parses the last double-quoted CSV field of a single output
line and requires /^S-1-5-21(-\d+){4}$/. Lookup runs at most once per revoke,
only after a target passes metadata checks. An error, timeout or invalid
SID fails every target needing inspection without any /remove call;
missing/skipped targets retain their outcomes. The SID is never recorded.

Aliases resolve before comparison, deduplication and removal:
SY=S-1-5-18, BA=S-1-5-32-544, BU=S-1-5-32-545, BG=S-1-5-32-546,
WD=S-1-1-0, AU=S-1-5-11, IU=S-1-5-4, NU=S-1-5-2, LS=S-1-5-19,
NS=S-1-5-20, CO=S-1-3-0, OW=S-1-3-4, AC=S-1-15-2-1,
PU=S-1-5-32-547, RD=S-1-5-32-555. An unknown two-letter alias in an
explicit allow ACE fails that target before removal. /remove:g receives
only *S-1-... trustees, never aliases. One /remove:g call removes all foreign
trustees, followed by another /save verification. Directory propagation is performed by Windows, not a Hub
recursive traversal. Directory calls allow 120 seconds; file calls 30 seconds.
Diagnostics contain only reason, target label, outcome and removed ACE count.

Windows startup requests this asynchronously after listening, once. Turn-end
requests run only after cleanup releases a Grok reservation, with no other
active or pending Grok preparation. Uncertain-child or failed cleanup retains
its reservation and therefore prevents revocation. A single service promise
chain serializes revokes; Grok preparation increments its pending count before
waiting for this chain, then runs the optional refresher, R19 gate and runtime
preparation. Auth-failure refreshes use the same pending boundary. Claude never
triggers revocation. Failures are recorded and never fail a turn. Shutdown does
not wait. PROJECT_HUB_GROK_ACL_REVOKE exactly 0 disables the feature; otherwise
it is enabled on Windows. The R19 owner login window is independent, and the
round-17 refresher remains disabled by default and otherwise unchanged.

The first startup removes the round-17 explicit directory grants and Windows
removes their inherited grants below .grok. The next sandbox setup re-adds the turn's unchanged read/write grants.
A Grok turn still exposes its login to CodexSandboxUsers while running: this
is a codex sandbox design limit, not isolation between sandboxed tasks.

## Round 21: refresh before expiry and the expiring gate

Grok CLI 1.0.70 的 login model 使用 GROK_AUTH_EARLY_INVALIDATION_SECS，預設
300 秒，提早將 token 視為過期。Hub 回合沒有設定此變數，且 auth.x.ai 維持封鎖，
因此回合中無法刷新；owner 一般執行 models 也只會在原到期前五分鐘內刷新。
依本輪施工單提供的 2026-10-28 真機紀錄，owner 於 21:57 設定此變數為 21600
後執行 models：登入檔已約 4 小時 50 分，尚有約 70 分鐘才到期，仍於 2 秒內更新；
mtime 由 17:07:15 變為 21:57:31、大小由 1824 變為 1827 bytes，exit code 0，
DACL 保持 owner-only，無需瀏覽器。此為既有實機證據，本輪自動測試不重跑 provider。

Round 21 取代 Round 19 的時間門檻：PROJECT_HUB_GROK_LOGIN_TTL_MS 預設
21300000 ms（6 小時減 5 分鐘），仍只接受 600000 到 86400000 的十進位整數字串。
PROJECT_HUB_GROK_LOGIN_MARGIN_MS 預設 2100000 ms（35 分鐘＝MAX_WALL_MS＋5 分鐘），只接受
0 到 10800000 且嚴格小於有效 TTL 的十進位整數字串；無效值回到預設，若預設
不小於 TTL 則回到 0。fresh 為 age < TTL - margin；expiring 為
TTL - margin <= age < TTL；expired 為 age >= TTL。expiring 回傳
GROK_LOGIN_EXPIRING、409、notStarted，避免接近到期才開新回合。unknown 仍放行。
refreshAt = mtime + TTL - margin；UI 顯示「即將到期」與「建議更新時間」。
狀態 API 不輸出 ageMs；metadata 估計不保證 token 有效，也不保證長回合永不中斷。

只有 owner 登入視窗的 refresh 模式，在原環境清除完成後強制設定
GROK_AUTH_EARLY_INVALIDATION_SECS='21600'；login/device 保留繼承值。
回合的 sandbox 計畫、grants、env、egress、工具政策及 Round 17 refresher 不變。
視窗仍使用已審核 binary、隱藏 cmd 的 start "Grok login" /wait，無 sandbox、
無輸出擷取；single flight、活動回合拒絕、deadline 與 outcome 判斷保持不變。

ACL revoker 僅在 require.main === module、win32、非 DRY 且
PROJECT_HUB_GROK_ACL_REVOKE 不等於 '0' 時建立。正式 node server.js 入口保持啟用；
require() 載入（包括 node -e boot）取得 null，不更動 Round 20 撤權規則與序列化。
所有非 DRY 測試伺服器的 env 必須明確設定 PROJECT_HUB_GROK_ACL_REVOKE:'0'
以及合成 USERPROFILE。owner-gates 在自己的 temp root 建立 owner-home，寫入全新
.grok/auth.json、.grok/auth.json.lock、.claude/.credentials.json、.claude.json；
USERPROFILE、HOME、HOMEDRIVE/HOMEPATH 與 HUB_AI_HOME 指向合成 home，boot 在
import server 前驗證 os.homedir()，並繼續拒絕 credential reads、provider launch 與 egress。
掃描 guard 檢查 hub/test/**/*.js 的常見 spawn/env 寫法；它是 lexical guard，無法追蹤
跨檔 helper、動態檔名或事後 env 變更，不能取代實際 fixture 的隔離設計。

## Round 22: automatic refresh before a Grok turn

依 SPEC-R22 提供的真機紀錄：2026-10-28 17:07，owner 執行 grok models
於 2 秒內更新已過期登入，exit 0，無需瀏覽器。21:57 設定
GROK_AUTH_EARLY_INVALIDATION_SECS=21600，尚有約 70 分鐘效期的登入也於
2 秒內更新，auth.json mtime 前進且 DACL 保持 owner-only。2026-10-29
06:43 使用全新假 home、空 stdin 隱藏執行 models，3 秒結束，未開啟瀏覽器
或等待輸入；stdout 顯示 You are not authenticated. 與預設模型列表，卻仍
exit 0。CLI log 為 silent refresh → Failed(ManualLogin)，不會升級成互動登入。
以上為施工單提供的既有真機證據，本輪測試只使用合成 home 與假的 provider。

新的 grok-turn-gate 在建立時解析 TTL/margin，先做 metadata freshness 檢查：
fresh/unknown 直接放行；missing 保留 GROK_LOGIN_MISSING，不嘗試更新。
expiring/expired 若停用自動更新，或 otherGrokTurns > 0，保留原錯誤。
otherGrokTurns = runtime.active('grok') + max(0, pending - 1)，排除目前準備
作業，仍計入其他預約與準備中的回合，以免 owner 更新將 auth.json 改回
owner-only 而干擾其他回合。原 R18 refresher 仍在 gate 前，預設停用。

失敗後冷卻 600000 ms（10 分鐘），期間回傳 GROK_LOGIN_AUTO_REFRESH_FAILED，
不再啟動程序；界線到達可重試。更新回傳 busy 表示手動視窗開啟，保留原錯誤，
不啟動冷卻。其餘結果皆重新取得 now 並檢查 metadata；通過才放行並清除冷卻，
仍失敗或更新拋錯則重設冷卻。每次決策記錄 from/outcome/timedOut/skipped/
durationMs，不含路徑或憑證。所有 gate 拒絕保留 code、409、notStarted。

正式 Windows 入口預設啟用：require.main === module、platform === 'win32'
且 PROJECT_HUB_GROK_AUTO_REFRESH !== '0' 時才注入更新 callback；設為 '0'
停用，require() 匯入則停用。callback 延後取得 grokLoginWindow，避開 TDZ。
非 DRY 測試伺服器明確設 PROJECT_HUB_GROK_AUTO_REFRESH:'0'，並沿用合成
owner home 與 PROJECT_HUB_GROK_ACL_REVOKE:'0' 的隔離規則。

autoRefresh 與手動視窗共用 single flight、last/state/finish/dispose；並行自動
呼叫取得同一個 promise，手動 start 收到 GROK_LOGIN_AUTO_REFRESHING。
auto 不是路由 mode；start('auto') 仍為 400，手動 refresh/login/device 不變。
更新仍核對 owner home、已審核 binary 與路徑規則，清除 Hub/Grok home/proxy
環境，強制 GROK_AUTH_EARLY_INVALIDATION_SECS='21600'，直接執行
spawn(file, ['models'], {windowsHide:true, stdio:'ignore', cwd:home, env:cleanEnv})。
不經 cmd/start、不使用 windowsVerbatimArguments、不讀 stdin、不擷取輸出。
60 秒 deadline 以注入的 kill 終止 child tree，回傳 failed、timedOut:true。
dispose/error/forced stop 都是 failed；mtime 前進才是 refreshed，exit 0 且
mtime 不變僅是 unchanged，其他為 failed。exit code 本身不能證明登入成功。
只讀取 lstat metadata，不開啟或讀取憑證內容；mtime freshness 仍只是效期估計。
回合 sandbox plan、grants、env、egress、工具政策、Claude 路徑、F1/F2 與
R20 ACL 規則均不變；回合本身不加入 GROK_AUTH_EARLY_INVALIDATION_SECS。

## Round 23: the Grok status line follows the login

SPEC-R23 records a real-machine turn on 2026-10-29 at 13:16:54: the turn gate
refreshed an expired Grok login (grok-login-auto-refresh, from: expired,
outcome: refreshed, durationMs: 4352), then the turn answered OK. Both
state.grokStatus and GET /api/state were fresh, with auth.mtime 05:16:54Z,
but the work view still showed the expired login and 10/28 21:57 timestamp.
These are supplied observations, not a provider or installed-app test in R23.

The block was only built by chatHtml() through renderWork(); mainKey() did not
include login status, and editing or open details also prevented main rendering.
refreshGrokStatus() now runs immediately after refreshWorkspaceLifecycle() in
pollState() and refreshTree(), independently of editing and open details.
renderWork() computes the HTML once, passes it to chatHtml(), and saves the same
value as renderedGrokStatusHtml. Unchanged HTML, non-work views, and missing
blocks/projects/tasks cause no writes. If box.contains?.(document.activeElement)
is true, writing is deferred without changing the cache, so a later call retries
when focus leaves the login button. mainKey() remains unchanged to avoid
rebuilding the composer or messages when login status changes.
acceptGrokLoginWindow() calls refreshTree() once, fire-and-forget, only when
running is falsy and outcome is refreshed. This fetches state immediately after
a successful manual window instead of waiting for the unchanged 15-second poll.

## Round 24: six small Grok fixes

登入 margin 預設為 MAX_WALL_MS + 300000，即 2100000 ms（35 分鐘）。
最長回合之外保留五分鐘，涵蓋工作區準備與憑證 mtime 晚於核發時間的落差。

自動更新後只接受 outcome=refreshed、timedOut 不為 true，且 metadata 明確為 fresh。
unknown、更新失敗或逾時皆拒絕並進入冷卻；更新前 unknown 的既有行為不變。

更新程序成功結束但登入檔未變時，回傳 GROK_LOGIN_AUTO_REFRESH_UNCHANGED。
介面引導瀏覽器或裝置碼重新登入；保留 409/notStarted 與三個登入按鈕。

nativeAuthRetryAvailable 反映目前是否有可用的 grokAuthRefresher。
不可重試時不顯示自動更新並重送通知，也不呼叫 retry；未提供此選項維持原行為。

串流使用 hub.agent_delta，成功或失敗結束前最多輸出一次完整 hub.agent_snapshot。
回覆文字只計入預算一次；每則回覆上限 1 MiB、每回合 2 MiB、最多 65536 frames，
另保留輸入總量 16 MiB；ChatRunner 累加 delta，最後以同 id 快照取代，避免重複。

Grok 與 Claude 的 TRUNCATED_OUTPUT 表示程序結束時輸出尚未完整接收。
訊息說明串流中斷或末行不完整，並提供重送及一般終端機檢查指引。

## Round 25: External Auth Provider — the sandbox never reads ~/.grok

The owner probe dated 2026-10-30 used Grok CLI 1.0.70 (internal ver 1.0.34).
These are supplied probe observations, not a new live-provider test by this change:

1. Agent stdio and headless prompts do not invoke an external auth provider when no credential file exists. The file must be hydrated before a turn.
2. Owner-side `grok login --device-auth` with a private `GROK_HOME`, `GROK_AUTH_PATH` and `GROK_AUTH_PROVIDER_COMMAND` invokes the helper without a network call, exits in about one second, and lets the CLI write the auth file and its lock. The entry contains the access token, exact ISO expiry and `auth_mode: "external"`, with no refresh token.
3. Hydrated agent stdio completes prompts without re-running the provider while the token is valid.
4. A rejected token minted more than 120 seconds ago invokes the provider with `GROK_AUTH_EXPIRED=1`; the old token is not passed back. A successful refresh can complete without a retry_state notification. Within 120 seconds, the CLI's fresh-mint guard skips refresh, retries four times (three retrying notifications), then reports an auth failure.
5. A token inside the CLI early-invalidation window proactively invokes the external provider during initialization.
6. Windows invokes the provider using cmd /C. The environment includes auth path, provider command, HTTP_PROXY and, on re-mint, GROK_AUTH_EXPIRED=1; first-party credentials are stripped. The CLI escapes every quote when it builds the cmd /C command line, so a quoted path never reaches cmd and the CLI falls back to browser sign-in. The Hub therefore passes a bare file name (grok-auth-helper-owner.cmd / grok-auth-helper-sandbox.cmd) and puts hub/lib on the child's PATH (first entry for the owner hydrator, last entry for the sandbox turn). cmd /C searches the current directory before PATH: the hydrator's cwd is the Hub-owned hydrate directory, while a sandbox turn's cwd is the task workspace. A workspace file with the helper's name would run instead of the helper, inside the same sandbox and with the same capabilities the agent's own shell already has; it gains nothing beyond the existing trust boundary. This behavior is documented, not mitigated.

Before each Grok turn the owner process checks exact expires_at (mtime remains the fallback when exact expiry cannot be read), then hydrates the private provider home. The owner helper reads a bounded, regular, single-link owner auth file in memory and prints only access_token and expires_in. It never logs, persists or returns refresh_token or the parsed owner object. The token lifetime subtracts a 60-second margin and is clamped to at least one second.

The hydrator uses the reviewed executable and a separate runtime/grok-hydrate directory, outside the sandbox's provider home. It removes only regular single-link stale auth/lock files, strips inherited Hub/auth/proxy environment variables, and runs login --device-auth hidden with ignored stdio. Its deadline is 20 seconds; failure, timeout or disposal refuses the turn with GROK_LOGIN_HYDRATE_FAILED before the provider turn starts. Success requires exit 0 and a fresh nonempty regular auth.json, then ensures auth.json.lock exists. Calls for one provider home share a single in-flight hydration.

The turn's GROK_AUTH_PATH and auth.json.lock are inside its writable provider home. The sandbox has no grant under the owner's ~/.grok. Broader executable/runtime read trees that would expose owner .grok are also refused. Claude launch plans retain their previous bytes. Runtime policyVersion is now 5, with Grok credentialMode provider-home-hydrated. **Every Grok task needs one new owner approval after this upgrade.** The shared policy-version bump also invalidates earlier Claude runtime approvals; its launch grants are unchanged. The Grok accountProfileId continues to identify the original owner credential location/device, not the hydrated copy.

Each run receives a separate random bearer route capability in hub-grok-auth.json (exclusive creation, mode 0600). The sandbox helper reads only this bounded route file and calls POST /api/native/grok-token through the already authenticated loopback broker. Proxy-Authorization authenticates the broker; Host, X-Hub: 1, bearer Authorization, X-Hub-Grok-Run and a lowercase UUID-v4 X-Hub-Grok-Nonce bind the token route. Duplicate/forwarded/cookie/transfer-encoding headers are rejected. Content-Type is application/json (optional UTF-8 charset), Content-Length is 1–256 bytes, and the body contains exactly one boolean expired field. The route retains the latest 64 nonces, rejects replay, and limits each run to a bucket of three requests refilling one request every 20 seconds. Replies use Cache-Control: no-store. Records contain outcome, runId, expired and expiry duration, never tokens.

The sandbox helper makes one request with a five-second deadline and accepts at most 4 KiB of strict UTF-8 JSON. Only valid token JSON reaches stdout; all failures produce one fixed diagnostic line on stderr and exit 1. HUB_* and HTTP_PROXY are deleted from the helper's own environment after capture. The owner mint callback attempts automatic renewal after rejection or when fewer than five minutes remain; a busy/failed renewal still returns the current token. Route disposal closes the capability and deletes only the matching regular, single-link, bounded route file with its original SHA-256.

A token revoked within 120 seconds of hydration can therefore end the turn with GROK_NATIVE_AUTH_UNAVAILABLE because of the CLI fresh-mint guard. This is not proof that the login is valid or that a prompt succeeded. Exact expiry is displayed in the status line when available; missing exact expiry preserves the existing status fallback.

R17 auth-refresh and R20 credential-ACL modules remain unchanged. R17 remains opt-in/disabled by default; the nativeAuthRetry block is unchanged. Because ordinary turns no longer grant owner ~/.grok, R20 now finds nothing new to revoke from those turns (historical grants can still be cleaned up).

R25 validation uses synthetic homes/tokens, fake processes and clocks, and ephemeral loopback HTTP servers only. No provider executable or real owner credentials are used. The new flow is implemented and provider-free tested; live-provider acceptance remains separate.

## Round 26: provider-command hotfix

Candidate 26's hydration timed out after 20 seconds on the real machine because the quoted provider command was escaped by the CLI and fell back to browser sign-in (owner observation, 2026-10-30). GROK_AUTH_PROVIDER_COMMAND now contains only the helper's bare file name. PATH now includes hub/lib first for the owner hydrator, followed by the inherited owner PATH with exactly one canonical PATH key, and last for the Grok sandbox turn. Claude and the login-window environment are unchanged.

## Round 27: hydrated credential inherits the provider-home ACL

Owner observations from 2026-10-31 09:00 on installed candidate 27: login refresh
completed in 4.2 seconds and hydration succeeded in 2132 ms (2074 ms after task
re-approval). The hydrated auth.json had auth_mode external, the exact expires_at,
and no refresh token, but the sandbox turn failed with GROK_NATIVE_AUTH_UNAVAILABLE.
Its unified log reported an auth.json read error (os error 5) and no credentials.
The provider home already had inheritable modify ACEs for the sandbox identities.
The CLI wrote auth.json with a protected, owner-only DACL (D:PAI), disabling
inheritance; auth.json.lock created by the hydrator inherited the directory ACL.
These are supplied owner observations, not a new live-provider validation.

After a successful login and validation of fresh regular single-link files, the
hydrator sequentially runs icacls /inheritance:e on auth.json and auth.json.lock.
This re-enables DACL inheritance so the provider home's existing sandbox ACEs
apply. No new principal is granted and nothing outside the provider home is
touched. Both operations must succeed before hydration is reported as successful.

The grok-hydrate record contains outcome, timedOut, exitCode, durationMs, and acl,
in that order. acl is inherited when both operations succeed, failed when the ACL
step fails, and null when it is not reached or timeout/disposal wins while it is
pending. Late ACL completions cannot change a settled result. A failed ACL step
refuses the turn with GROK_LOGIN_HYDRATE_FAILED exactly like a failed login.

## Round 28: native completion, CLI defaults and credential cleanup

The credential revoker previously used icacls /remove:g. Windows returns 1332
(ERROR_NONE_MAPPED) when a sandbox capability SID has no account mapping, so
directory and lock-file grants remained. Inspection still uses icacls /save;
removal now uses a hidden, shell-free PowerShell/.NET child with target and SIDs
passed through environment variables. GetAccessControl('Access'),
RemoveAccessRuleSpecific and SetAccessControl remove explicit foreign allow ACEs
by SID and write only the DACL. Deny ACEs and protected children remain intact;
removal of directory inheritance propagates to unprotected children.
Failed grok-credential-acl rows now include stage (user, save, parse, remove or
verify) and a numeric child-process status when available. verify means foreign
ACEs remained after successful removal. Records never include paths, SDDL or
process output; successful/non-failed rows retain target, outcome and removed.

On Windows, hub_report done=true during an active Grok/Claude native turn still
saves the report, chat row and unread notification, but holds the completion
state change. Its log includes held:true and its result explains the hold.
Only a held, clean native finish applies completion and records native-report-done;
errors, stops and questions clear the hold without completing. A task already
waiting for an owner reply remains unchanged. Each new native MCP resource also
clears any leftover hold. Subagents are instructed to return results to their
parent instead of calling hub_report, hub_ask_owner or hub_mark_step.

Before exclusive creation of hub-grok-auth.json, an unowned stale route file is
removed and grok-route-stale is recorded. Only regular, single-link files of at
most 1024 bytes qualify. Live or undisposed resources retain ownership, so their
files are left for collision detection/review, including failed disposal cases.

Windows Claude/Grok tasks with neither an explicit model nor a role-slot model
use CLI預設. Explicit stale models still fail admission; role slots keep priority,
and Codex/Agy behavior is unchanged. Credential command hints now include
grok-auth-helper, grok_auth_ and hub-grok-auth. They route to manual review and
remain a speed bump only, not a guarantee of secret isolation.

## Round 29: finished turns and isolated launcher tests

Grok and Claude now wait up to 15 seconds for the CLI to exit after its result.
After a complete result, a slow exit is stopped and its cleanup receipt verified;
verified cleanup counts as a finished turn. Incomplete results, failed cleanup
verification and owner cancellation still fail the turn. native-exit-wait is
recorded when the exit wait is forced or reaches 2 seconds.
A CLI killed this way may skip its exit flush, so the next resume can fall back
to a new session. GROK_NATIVE_EXIT_TIMEOUT now means no exit after an incomplete
result; its diagnostic message is unchanged.

Tests starting Hub through start-windows.ps1 must set the same three environment
values as tests spawning server.js: PROJECT_HUB_GROK_ACL_REVOKE='0',
PROJECT_HUB_GROK_AUTO_REFRESH='0', and an explicit synthetic USERPROFILE.
The isolation scan now checks literal launcher path.join identifiers passed
directly after -File as well as direct server spawns; text-only reads are excluded.
