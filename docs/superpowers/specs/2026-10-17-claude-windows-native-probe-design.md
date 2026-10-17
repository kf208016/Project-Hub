# Claude Windows 原生後端：第一批離線隔離驗證

日期：2026-10-17（Asia/Taipei）。狀態：**run-05 至 run-07 已在實際 suspended child 驗過 LPAC token 與原 SID／Low IL／空 capabilities／Job；run-07 的有界診斷確認 CLR runtime 已載入，但 fixture 握手仍失敗、13 項 combined cases 未量測。各次精確收尾已驗，原 run-01 的 registry cleanup unknown 保留。W0 未通過，provider 維持 blocked。重測規則及其來源更正見 §9，不將 Codex 提出的限制歸為使用者原話。**

## 1. 目的、既有授權與本次差異

使用者要求 Windows Project Hub 保留原功能與資安，增加 Claude／Grok／Agy，並在兩輪 Claude 架構討論後指示繼續。目標是 Claude 在 Hub 內的實際流程，而不是只讓使用者另開 CLI。Windows 為產品主要入口；Linux 為選配執行環境，不作已交付 Codex／人工 Chat 的前置。

沿用已核准的 `2026-10-09-multi-provider-cli-web-chat-design.md` §7、§8.2–8.3，以及 `2026-10-10-multi-provider-cli-web-chat-implementation.md` §12 的 adapter／協定／拒絕測試與原執行方式。這些工作不重新審核功能方向；10/13 的 Linux／SSH 補充也沒有取消原生 Windows 候選。

新差異是將 Windows 候選落成 **LPAC＋owned Job** 的具體、無模型離線探針。`CreateAppContainerProfile` 會建立目前 Windows 使用者的 app 專用資料夾及 registry storage；這超出僅讀原碼與離線 JSON fixture，須先審閱本範圍。此補充只涵蓋 W0 及 §9 的同範圍有界重測，沒有授權完整原生 Claude 自動執行、登入、模型呼叫或較弱 C 模式。

## 2. 現況與不能繼承的證據

2026-10-17 唯讀核對：Windows AMD64／OS build 26200、既有 .NET Framework64 C# 編譯器存在；本機 Claude package manifest `2.1.252`、exe `217406624` bytes、SHA-256 `fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a`。本次未執行該 CLI。

- 現有 `job-runner.cs` 能先 suspended、加 Job、禁止 breakaway，再 resume，並等待 owned 程序退出；沒有 AppContainer／LPAC 或檔案／網路隔離。
- Codex 的既有 Windows sandbox、app-server、核准格式及已測讀取／網路限制，不能套用到 Claude。ConPTY 也不是額外沙箱。
- 現有 workspace permit 尚未綁定完整 actor／model／binary／runtime／profile，不能直接授權 Claude；HOME 繼承也不構成 provider profile 分離。
- 10/16 的兩輪無工具 Claude 討論成功，只證明該次訂閱 CLI 呼叫，沒有驗證本後端。
- 新協定元件的 fixture 測試可以依既有計畫繼續，但不改 registry readiness、不啟用外部執行。

## 3. 路線選擇

| 路線 | 取捨 | 本批處理 |
|---|---|---|
| LPAC＋owned Job | Windows 原生 OS 機制；profile、CLR／CLI、後代與管線相容性未知 | 選定作 W0；失敗保留證據，不自動改普通 AppContainer 或 full-user |
| restricted token＋Job | 仍須另設資源 ACL、IPC 與網路控制，沒有現成實作 | 不同步建第二套；W0 失敗後才依證據重新比較 |
| Linux worker／Windows Sandbox | 另有主機或 OS feature、登入與受控通道維護成本 | 保留既有 Linux 證據；本批不連 SSH、不新增 OS 功能或 VM |

W0 是候選可行性量測，不是宣稱 LPAC 已足以承載完整 Claude。必要網路出口與不可信 CLI 的磁碟限制尚無可用實作，未納入本批成功宣稱。

## 4. W0 精確操作與權限範圍

### 4.1 一個專用身分與新建根

1. 本批最多建立一個 `ProjectHub.ClaudeProbe.<GUID>` profile（ASCII 名稱、總長度不超過 64）。**先** create-only／durable 保存 `creation-intended`，綁名稱、預期衍生 SID、目前 owner SID、nonce、owned temp 身分及預期不存在狀態，再呼叫建立 API。遇到已存在一律拒絕，不接管或刪除舊 profile；API 結果未知也不自動再建第二個。
2. 透過 Windows API 建立 per-user AppContainer profile，再核對 SID 並記錄實際 profile 資料夾及該 SID 的精確 registry storage 身分。只接受目前使用者及此次 SID 的新 profile；建立成功收據 durable 後才繼續。它可能位於 workspace 之外的 Windows app 專用儲存區，禁止改用任意路徑或碰既有 provider profile。當機落在 API 與成功收據之間時標示 `unknown`，不能只憑同名或目錄存在推定所有權。
3. 合成測試根位於經核對的本機 NTFS 私有 temp，分 `controller`、`runtime`、`task`、`tmp`、`outside-canary`。root 身分／FileID／owner 與實際絕對路徑先固定；所有目標拒絕 reparse、hardlink、ADS 及跨根引用。

   此處 hardlink 拒絕保護新建、可寫與可清理的合成目標，維持 fixture `HeldFile` 的 nlink=1。指定既有 vendor 的靜態只讀核對可使用獨立持有式快照：同時持有 manifest／exe 的唯讀、share-read-only HANDLE 及 namespace pins，固定 handle 身分／大小／內容 SHA，前後 link count 必須一致。它不執行 vendor、不修改既有 aliases；只保證持有期間的固定路徑與 unnamed data bytes，不宣稱凍結全部 alias 名稱、metadata 或提供後續執行證明。
4. ACL 只調整此次新建的 root／fixture／runtime：controller 與 outside-canary 不給 probe SID；runtime 給 read/execute；task／tmp 給必要 read/write。可寫子根加明確 Low Integrity mandatory label，僅限新建子根；不改 owner HOME、全域程式、既有專案或系統檔案 ACL。
5. provider auth 仍為空。本批不讀取、複製、搬移或重新登入既有 `.claude`、其他 provider、SSH、Docker 或瀏覽器資料；僅用合成同類 marker 驗拒絕路徑。

### 4.2 固定啟動配置

- 使用 `STARTUPINFOEX` 的 AppContainer SID、**空 capabilities**，以及 `PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT` 的 LPAC 配置；不給 `internetClient`、private network、COM 或 registryRead capability。
- 新程序 suspended 建立；controller 在 resume 前獨立核對 token 的 AppContainer SID、LPAC／restricted 屬性、Low IL、capability 清單及 owned Job。任何欄位未知或不符就不 resume；不只相信 child 自報。
- Job 不允許 breakaway，採 kill-on-close；初始上限：同時 8 個 owned 程序、Job 記憶體 512 MiB、每 case wall time 20 秒及 CPU time 5 秒。設定 API 失敗即停止，不沿用無限制程序。
- 每個 case 最多 64 KiB stdout、64 KiB stderr；controller 主動讀取並在超限時停止 Job，不靠 child 自律。輸入最多 16 KiB，只有 nonce、case、合成範圍及 owned listener；不可傳 Hub owner credential。
- stdin／stdout／stderr 僅繼承本次明列的資料 HANDLE。管理 channel、其他 pipe、SSH agent、Hub auth、MCP token 不繼承；空工具配置不能替代這些 OS 限制。
- `USERPROFILE`／HOME、APPDATA、LOCALAPPDATA、TEMP／TMP、`CLAUDE_CONFIG_DIR` 全指向此次新根／profile；PATH 僅為核對的 runtime／必要 Windows 系統路徑。採 env allowlist，不承接任意 credential、proxy、Node preload、plugin／hook 設定。
- 本批使用既有 C# 編譯器建可信、固定 fixture，無新增套件或 lifecycle scripts。若空 capability 的 LPAC 無法啟動 fixture／CLR，記錄相容性失敗即停止；不自動加 registry／COM capability。

### 4.3 網路與資源的測量界線

本批不給網路 capability。僅嘗試連接 controller 自建的 loopback IPv4／IPv6 測試 listener，不掃 LAN、DNS、外部 IP 或第三方服務。成功的對照連線由 controller 發出，LPAC 主程序與後代的連線都應被拒絕。listener 僅接受 nonce／固定短合成 bytes，不接受 command RPC。

此測試不能代替將來的 provider egress：模型、OAuth、web／MCP 網路若要放行，必須另外落成不繞過的受控出口並驗證整個 CLI。一般 network capability 或環境 proxy 都不能當作 domain allowlist。

本批僅執行可信 fixture，不執行 Claude 或其他 vendor CLI。fixture 固定寫入合計不超過 4 MiB 合成檔；新 temp **及 profile** 的 admission 軟預算為 128 MiB，開始前留足收尾空間，執行中超預算即停止。量測與逾限停止不是強制磁碟配額，不能承諾最高實際寫入量，也不能用來通過不可信 CLI 的 worker 資源 gate。

固定 case manifest 定義所有起始及重試：每批最多 6 分鐘、controller 啟動的 case 根程序最多 12 次，包含後代與無關對照的成功程序起始合計最多 32 次，所有成功／失敗起始嘗試合計最多 48 次；不在同一 attempt 內隱含重放，修正後的獨立有界重測依 §9。每 case 使用新的 owned Job，同時最多 8 程序；無關對照在另一個精確管理的 Job 中。建立前先預留該 case 的最壞嘗試數，不足就列未量測，不執行半個 case 後補成功。temp／profile 清理不明也不宣稱已回收磁碟。

## 5. 固定探針與成功／拒絕條件

| Case | 成功證據 | 拒絕／停止條件 |
|---|---|---|
| 啟動身分 | controller 在第一指令前驗 SID／LPAC／capabilities／Job；受測 child 的獨立觀測相符 | 身分或 profile 不符、無法套限制時不 resume |
| task 與 runtime | task 內合成讀寫成功；runtime 可讀不可改 | task 可用性失敗，或 runtime 可寫，均不通過 |
| 範圍外 marker | 主程序及後代對 controller／outside／其他 task／假 auth marker 讀寫被拒絕 | 任一越界成功即停止；不探讀真實秘密 |
| 網路 | controller 能連自己 listener；LPAC 主程序及後代均無法連 | 任一 LPAC 連線成功、對照無法成立或 IPv6 未量測，列明未通過 |
| 後代與 Stop | 同 SID 的三層 owned fixture；breakaway／外部程序代建嘗試受拒；cancel 與 controller EOF 後 owned Job 為空，無關對照程序仍存活 | 只看到 root exit、Job 狀態未知或對照被誤殺，保留失敗及收尾狀態 |
| 配額／輸出 | 合成記憶體、process／CPU／wall／stdout 超限各回有界錯誤，沒有成功收據 | 設限失敗、無上限輸出、cleanup 失敗或 identity 改變 |
| 固定 Claude 靜態身分 | 只讀核對指定 package manifest、exe 普通檔案型別／身分／大小及完整 SHA；不執行、不複製 auth | bytes、檔案身分或 manifest 改變就失效；這不是離線版號／協定執行證據 |

每個拒絕目標必須有正對照：controller 先核對 marker 確實存在、bytes／身分正確且可讀寫，再證明 LPAC 實際執行到該操作而得到存取拒絕。FileNotFound、fixture 未開始、CLR 啟動失敗或一般 timeout 都不能算安全拒絕。IPv4／IPv6 分別綁 `127.0.0.1`／`::1`，不能只靠雙堆疊映射當成兩項已測。quota case 須有進入預定負載及 OS 限額證據，不能以任意非零退出碼充數。

COM／WMI／外部 broker 的拒絕不以 Job 禁止 breakaway 一項推論；若無法驗證必要途徑，列為未量測，不能稱完整子樹隔離。上述合成 cases 是有範圍的證據，不是所有 Windows 逃逸方式的證明。CLR 啟動失敗只代表此次 fixture／CLR／LPAC 配置不相容，後續 cases 為未量測，不能推論 Windows 或 Claude 的所有隔離方案不可能。

狀態依序 `prepared → profile-created → boundary-verified → probing → stopping → cleaning → closed`；任一失敗保存精確 stage／受測配置／錯誤類別。case manifest 的上述必測項分別標 `pass / fail / not-measured`，不提供自動 N/A。只有每個必測項皆 pass、靜態身分未變及 cleanup 已核對，才回 `probePassed:true`。所有回應固定 `providerReady:false`，不修改全域 readiness。

## 6. 收尾與可回復性

先停止 owned Job 並由 OS 核對空集合，再停止自己的 listener／對照程序；禁止依程序名稱廣泛終止。重用 PID、child 不明或 Job 查詢失敗均保留未知狀態，不刪根或 profile。

只撤回此次有成功建立收據且 SID／路徑／owner／建立身分仍相符的新 profile。先關閉 probe／controller 持有的 profile、registry、pin 等 HANDLE，再透過 `DeleteAppContainerProfile` 處理其資料與 registry storage；成功後還須核對此前記錄的精確資料夾及該 SID registry storage 已不存在。API 對不存在 profile 也可成功，故 API 成功碼與仍可衍生 SID 都不能單獨判定清理。若 API 或後置核對失敗，保留收據與精確殘留位置，不手動廣泛刪 `%LOCALAPPDATA%`／registry，也不接管同名物件。

最後才清理已核對的 owned temp。不可安全刪除時留下有界失敗紀錄；未完成的收尾不寫 closed。此為本機恢復及一致性紀錄，不是 WORM、可信簽章或同使用者不可竄改保證。

Linux 的原 unknown lease／cleanup 證據保留。本批使用不共享的合成根，不匯入或合併任何舊作業；不能因此清除舊鎖。將來按資源衝突處理仍需正式實作與驗證。

## 7. 與 Claude Hub 交付的銜接

既有計畫允許先完成假 CLI 協定與失敗測試。本輪可交付精確 Claude 2.1.252 官方協定來源對照、UTF-8 JSONL／session／result、人工核准 codec、Schema 與合成範例；不新增依賴、不啟 CLI、不換使用者 auth、不接 full-user fallback。

W0 通過後也不直接啟用或執行 Claude。下一個可執行 profile 仍須證明：受控模型出口、包含磁碟的完整資源限制、專用 provider 登入與可信設定、真實控制協定，以及 provider/model/binary/profile/runtime 綁定的 preview／permit。真實 CLI 的離線 `--version`／help 也須在其執行前 gate 成立後才做。原本的自有 auth 可見程度如實量測，不另要求 CLI 完全讀不到自己必須使用的憑證。

接線沿既有 `/api/chat/send → nativeStartDir → ChatRunner`、browser-only approval、queue／transcript、WorkspaceRuntime、reviewed merge 與安裝回復；不新建通用管理平台。逐項啟用必須有功能及拒絕證據，不將人工網頁 Chat 或 standalone CLI 成功當成完整 adapter。

若 W0 失敗，記錄受測配置、失敗操作及尚未提供的能力，停止該候選的本次執行，再依 §9 繼續根因定位與受控修正重測；依證據決定修正 Windows 配置或採既有 Linux 選配，不自動增加權限或換 backend。

## 8. 本次審閱事項與文件依據

需要決定的只有 W0 新增的 **一個 per-user LPAC profile、其 Windows 管理的專用儲存、合成 temp ACL／Low IL、owned Job 與零模型離線探針**。沿既有同聊天方式推進，保留原安全及功能門檻。

不包含新增 Windows feature、帳號、service、driver、全域防火牆／WFP 規則、loopback exemption、全域 CLI 更新、現有 profile ACL、OAuth／模型呼叫、私人專案傳輸或受信任 C 模式。若實際需要其中任一項，先形成具體差異再審閱；不能為通過探針默默擴大範圍。

官方文件於 2026-10-17 核對：

- [AppContainer／LPAC 啟動與 capabilities](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)：提供候選 OS 機制，不證明 Claude 相容。
- [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)：本批會建立 per-user app 資料夾與 registry storage。
- [DeleteAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deleteappcontainerprofile)：API 成功碼不能單獨作為 storage 已清理證據。
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：程序／資源管理與後代例外，不能代替檔案／網路隔離。
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)、[Claude shell sandbox 範圍](https://code.claude.com/docs/en/sandboxing)：實際固定版本協定仍須離線與後續真實驗證。

## 9. 重測限制來源與執行更正

原先「不自動重試」由 **Codex 提出並寫入方案**，不是使用者直接說過的要求。使用者曾核准整體 W0 方案；不能因此把 Codex 的措辭說成使用者原話，也不能將它擴大成每次修正後都要等待使用者再說「繼續」。本節依使用者既有高自主執行指示及本輪對來源的糾正，修正該解讀；不新增或偽造任何歷史核准。

在既有可信 fixture／零模型／不增權的 W0 範圍內，採以下工程重測規則：

- 有已確認的根因修正或新證據時，先記錄修正來源、重測目的及有限預算；完成相稱的離線驗證後，可以接續新的獨立 attempt。無需讓使用者逐次催促。
- 前一受測 attempt 的 Job、profile folder、registry storage 與 owned temp 必須已確認清理，才可接續該資源的重測。歷史獨立 unknown 原樣保留，不接管、不回填成功；接續前須核對新 attempt 與其無資源交集或衝突，不能只貼上「歷史」標籤便忽略。
- 每個 attempt 使用自己的 nonce／journal／結果，每批仍最多一個 profile、6 分鐘及原程序／記憶體／CPU／輸出預算。同一 nonce 的既有 root／journal 仍拒絕；換 nonce 不得掩蓋清理未知或繞過資源上限。
- 相同配置、相同錯誤且沒有新證據時，不做無限盲重跑；停止該嘗試並繼續根因定位或其他已授權工作。只有明確超出現有授權的系統變更或對外行為，才提出具體差異。
- 不增加 capability、不改普通 AppContainer／full-user、不跳過身分 gate、不自行啟動 vendor／登入／模型。重測不等於放寬通過條件。

Linux R2 的一次性 grant 仍按其獨立合約消耗，不能重放已使用的 grant；此規則不推成所有 Windows 修正後重測都須重新取得使用者核准。以上執行保護須標明為工程規則，不歸因為使用者曾說「禁止自動重跑」。

## 10. 接續修正：LPAC 的 OS 存取檢查

使用者以 `$context-guard` 要求接續完整 Windows Claude／Grok 整合。這一批先修正 W0 的身分判定：本機唯讀診斷已觀察 `GetTokenInformation(46)` 回 Win32 87、native query 回 invalid-info-class。Microsoft enum 有名稱，不代表此受測系統的該查詢可用；不能由這個 API 失敗推論 suspended child 不是 LPAC。

採固定 Chromium revision `5c210565c3fa181730df37778d22af487a0d5e40` 的 `CheckLpacToken`，在第一指令前對**實際 suspended child token** 執行 OS `AccessCheck`。固定記憶體 descriptor 授予 World mask 3、AllApplicationPackages mask 1、AllRestrictedApplicationPackages mask 2，使用 MAXIMUM_ALLOWED 與零 generic mapping。必須同時有 API 成功、access status 成功、granted mask **恰為 2**；目前 owner token 的獨立負對照必須恰為 3。失敗、未知、其他 mask 或無效 privilege-set 長度／內容一律拒絕。不得以 child 自報、純記憶體測試或 owner 對照代替真正 child 的陽性量測。

既有 owner／primary／AppContainer SID／Low IL／空 capabilities／owned Job 查驗全部保留。class 46 作補充交叉檢查：查詢成功時必須恰為 1；只有明確不支援的 Win32 87 可記 unavailable，其他 API／長度／值錯誤仍停止。這不是 class 46 失敗即通過的 fallback；每次都必須取得獨立 OS AccessCheck 的精確 LPAC 陽性結果。

這個更正不增加 capabilities、網路出口、profile 數量或執行身分；不改普通 AppContainer／full-user，不啟 vendor／auth／模型。按既有 §9 先完成拒絕回歸與獨立本地原碼審查，再執行同範圍的新獨立有界 attempt，保留來源／編譯／清理及每一 case 原始結果。另請 Claude CLI 審閱具體差異；本次指定原碼外傳遭自動核准審查拒絕，已請求該批外傳的明確同意，在取得同意前不外傳、不宣稱 Claude 已核可。這不新增「Claude 外傳完成」作為既有本地 W0 授權的條件，不因此停止不受影響的已授權工作。所有舊 attempt 的失敗或 unknown 原樣保留。後續 provider readiness 門檻仍依 §7，不能由 W0 或離線 transport 成功代替。

依據：[Microsoft TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)、[固定 Chromium CheckLpacToken](https://chromium.googlesource.com/chromium/src/+/5c210565c3fa181730df37778d22af487a0d5e40/sandbox/win/src/app_container_test.cc#109)。

### 10.1 本機 ABI 與可信 fixture 的 CLR 修正

run-04 在 class 21 的長度檢查停止。本機 owner primary 與 Identification duplicate 的唯讀量測均回傳一個 byte，因此只對此欄採嚴格 `BOOLEAN-1`（長度 1、值 0 或 1），其他 scalar 繼續要求四個 bytes。結果記錄 `measured-host-abi-v1`，不將本機結果宣稱為所有 Windows 的 ABI，也不以 hasRestrictions 代替 LPAC 存取檢查。

run-05 已在實際 suspended child 取得 LPAC mask 2、owner 對照 mask 3、零 privileges，並驗過原 SID／Low IL／空 capabilities／owned Job。resume 後 fixture 尚未輸出握手便以 `0x80131702`（CLR shim install root 未定義）退出。這不證明具體 registry ACL 根因；fixture 身分及後續合成 cases 仍未量測。此次 Job、profile folder、精確 registry storage、owned temp 均已核對清理，原始結果保留。

下一個同範圍 attempt 僅在可信 AMD64 fixture 的共同 child environment block 加固定 `COMPLUS_InstallRoot=<SpecialFolder.Windows>\Microsoft.NET\Framework64\` 與 `COMPLUS_Version=v4.0.30319`，後代繼承同一配置。不接受 request 或呼叫者環境指定這兩值，不修改全域環境、registry、ACL、capabilities，也不加 CLR log 讀寫流程。固定官方 WPF consumer 原碼及五次無 profile 對照提供相容性候選依據；它們尚未證明 LPAC 下 CLR 可啟動，必須由新 attempt 實測。離線環境區塊解碼、污染輸入拒絕及原 token／AccessCheck 拒絕測試先通過，再依 §9 核對前次清理並以新 nonce 執行。失敗保留精確狀態，不加權限以換取成功。

依據：[固定 WPF consumer](https://github.com/dotnet/wpf/blob/65d15adece1df9a73e3d1abc11f8bbf99e9fc7a9/src/Microsoft.DotNet.Wpf/src/Shared/cpp/Utils.cxx#L71-L101)、[官方 CLR 錯誤定義](https://github.com/dotnet/coreclr/blob/release/1.0.0/src/inc/corerror.xml#L4072-L4076)。

### 10.2 run-06 後的有界 CLR 啟動診斷

run-06 使用上述固定配置後，實際 token 檢查再次成立，fixture 改以 `0xFFFFFFFF` 退出且 stdout／stderr 皆 0 bytes，握手仍未完成；Job、profile folder、精確 registry storage、owned temp 清理皆已驗。此退出碼變化不等於已確定根因，原始失敗及 13 項 not-measured 保留。

後續診斷只在 Identity fixture 的 child environment 加 `COMPLUS_CLRLoadLogDir` 指向原有 owned tmp，不從 request／ambient env 取值；不為其他 case 開啟 logging。依官方 CLR activation log 命名規則，只收本 fixture 的固定 basename。先由 OS 驗證 Job 已空，再核對原 root／tmp identity，透過 no-link、不可改名／寫入的持有檔案 HANDLE 讀取，核對前後 FileID／大小，並以 SHA 綁定已讀 bytes；最多 2 檔、單檔 64 KiB、合計 128 KiB。超出或型別／身分不符為明示診斷失敗，不以任意路徑或遞迴檔案收集替代。

診斷僅在 closed result 的封閉欄位保存 basename、FileID、byte count、SHA 與有界 rawBase64，沿原 host create-only result writer 寫入本機 evidence，不新增任意輸出位置、不對外傳送。缺 log 或收集錯誤不能當作成功、根因或安全拒絕；原 fixture 錯誤與原清理結果分別保存。不安全檔案仍須讓既有清理 fail closed，不因診斷錯誤跳過殘留核對。收集上限不是硬磁碟配額。本步不改能力、全域環境／registry／ACL／服務，仍為原可信、零模型 W0 範圍；實作／Schema／拒絕測試與獨立本地 review 後才執行新 nonce。

依據：[Microsoft CLR activation debugging](https://learn.microsoft.com/en-us/dotnet/framework/deployment/how-to-debug-clr-activation-issues)。

### 10.3 run-07 的實際診斷與剩餘缺口

run-07 已實際執行，source probe SHA `6f574da0591d97e3973206c5c798856e858b432d36f8e13b111c4fa631fdfe5a`。fixture 仍退出 `0xFFFFFFFF`、stdout／stderr 均 0 bytes。取得一份 5538-byte UTF-16LE activation log，raw Base64 canonical、decoded size 與 SHA `cd9820aa888e5e670da286bd472dc7e67a7d4f32928fd3a4d10d38b65c5fb7ea` 已由 parent 重算一致。

log 明記 runtime `v4.0.30319` 已載入，後有兩次 internal runtime-host `GetInterface` 呼叫與 DLL detach。log 沒有這兩次呼叫的 HRESULT，因此不能宣稱其失敗、COM registry 拒絕或確定底層根因；缺少 exe.config 也不能單獨當作根因，owner 同 fixture 的無 config 正對照已成功。後續須區分 DLL 載入、managed runtime 初始化與真正 fixture 握手，不再把它們統稱為「CLR 無法載入」。

run-07 的 Job 空、profile folder／精確 registry storage／owned temp 消失皆核對成立。原始 result、journal、execution 與獨立 reconciled manifest 保存於外層 workspace `outputs/claude-lpac-w0-20261017/run-07/`；13 項 combined cases 仍 not-measured、`probePassed:false / providerReady:false`。未執行 vendor／auth／模型；不得盲重試、增加 capability 或用此診斷取代完整 provider 驗收。
