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
