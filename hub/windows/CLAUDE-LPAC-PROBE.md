# Claude Windows LPAC W0 探針

本工具是使用者已核准的可信合成可行性探針，依 `docs/superpowers/specs/2026-10-17-claude-windows-native-probe-design.md` 與同日 implementation plan 執行。它不接入 Hub 的 provider registry，不讀 auth，不執行 Claude／Grok／Agy，不呼叫模型、不連 SSH、不修改全域網路或 OS 功能。

## 組成與明確執行

- `claude-lpac-probe.cs`：Windows AMD64 controller，與固定 cases 的 `claude-lpac-cases.cs`、既有 `pinned-root.cs` 一起用本機 Framework64 C# compiler 編譯。無參數／`--describe` 為 inert contract；只有 `--execute-approved-w0-gate` 才讀取明確 W0 request。編譯本身不建立 profile。
- `claude-lpac-fixture.cs`：只依既有 .NET Framework 的可信固定測試程式。沒有任意 shell／命令／path／外網目的地介面；identity、合成檔案、固定 loopback、程序及負載 verbs 只能按固定協定進入。
- `claude-lpac-probe-request.schema.json`：closed stdin request shape。raw UTF-8 最多 16 KiB；重複鍵、未知欄位、非法字元／路徑、來源 digest 或身分不符必須在建立 profile 前拒絕。
- `../test/claude-lpac-probe-native.test.js`：編譯及 inert／rejected request 測試，不提交可被接受的 profile 建立請求。它不能代替真正 LPAC 測量。
- `../test/fixtures/claude-lpac/result-faults.cs`：只對空 state 做最終收據 flush 故障注入與退出碼檢查，23 項斷言；不建立 profile、不變更 ACL、不呼叫程序 API。
- `../test/fixtures/claude-lpac/acl-equivalence.cs`、`registry-identity.cs`：分別 46 項純記憶體描述元／token 值及路徑拒絕斷言；不讀寫實際 ACL／registry、不建立 profile，不能替代實機隔離測量。

request 的六個欄位是 `schemaVersion:1`、`operation:'claude-lpac-bootstrap-gate'`、32 lowercase hex `runNonce`、已存在且 owner 相符的 NTFS `rootParent`、固定檔名 `claude-lpac-fixture.exe` 的 `fixturePath` 與其完整 `fixtureSHA256`。SHA 是本批本機編譯產物綁定，不是發行者簽章或外部 attestation。

同一 nonce 的 root／journal 已存在就拒絕；不能以換 nonce 隱藏清理未知或繞過預算。根因已修正、前次相關資源清理已確認且仍在既有授權範圍內時，可依設計規格 §9 接續新的獨立有界 attempt，不需使用者逐次說「繼續」。原「不自動重跑」是 Codex 的方案措辭，不是使用者直接提出的禁止。執行入口保留 bootstrap 名稱以固定 request contract，實際結果仍須逐 case 判讀，不能把 bootstrap 成功當 W0 全部通過。

## 首指令前與後代

controller 建立此次 per-user profile 及私有 temp 前後留下 durable journal，綁 owner／SID／nonce／root identity。新 runtime 只讀；task/tmp 只對本次 SID 給必要存取及 Low IL。啟動時只繼承明列的資料 handles，env 採 allowlist；AppContainer capabilities 為空，使用 LPAC opt-out policy。可信 AMD64 fixture 的固定 CLR child 環境相容性候選見下節，不提供可由 request 改寫的 env 介面。

私有 ACL 核對比較 owner、protected DACL 及完整 ACE binary；只允許 Windows 自動加入的 `DiscretionaryAclAutoInherited` bookkeeping 差異。新增／移除 ACE、權限、SID、順序、繼承／傳播及其他 control flag 差異均拒絕，不因 SDDL 的 `D:P`／`D:PAI` 表示差異而誤判。

case 根程序先 suspended，controller 從 OS 查驗本次 owner／AppContainer SID、primary token、Low IL、空 capability 清單、restrictions 觀測及 Job membership 後才 resume。LPAC 主判定是下述固定 AccessCheck，不以 child 文字、單純 AppContainer 或 class 46 的未知結果充當證明；後代驗證及開始握手須與實際 PID／handle／Job 相符。

### 首指令前 LPAC 判定更正

`VerifyToken` 對該 suspended process 的 primary token 做 SecurityIdentification／TokenImpersonation duplicate，只給 TOKEN_QUERY；核對 duplicate 的 owner／AppContainer 身分，再對固定記憶體 descriptor 呼叫 AccessCheck，沒有 thread impersonation 或實體 ACL 變更。descriptor 為 `O:SYG:SYD:(A;;0x3;;;WD)(A;;0x1;;;S-1-15-2-1)(A;;0x2;;;S-1-15-2-2)`；MAXIMUM_ALLOWED、全零 generic mapping 沿用固定 Chromium `CheckLpacToken`。

同一 descriptor 的目前 owner 負對照必須 API 成功、AccessStatus=true、granted mask **恰為3**；受測 token 必須相同條件且 mask **恰為2**。固定 descriptor 僅授予私有0x1／0x2權限，不需要 privilege；原生守衛與 Schema 均要求 privilegeCount恰0。任何 API 失敗、其他 mask、descriptor／duplicate 身分／privilege buffer 邊界異常或非零 privilege 均拒絕。主證據命名 `chromium-access-check-v1`，不是 Microsoft 保證的跨版本 LPAC detector；必須在此 OS／固定配置的真 suspended LPAC token 取得陽性對照，才能通過身分 case。

class 46 僅補充診斷，固定 `GetTokenInformation`／4-byte query；成功必須回4 bytes且值恰1。僅該 API 明確回87時可記 `queryUnavailable:true`，其 payload／returned length 為 null，不讀取未定義輸出；其他錯誤、長度或值不符仍拒絕。unknown 絕不作為主判定通過。這個更正不加 capability、不改普通 AppContainer／full-user，原本 SID／Low IL／空 capabilities／Job 等 gate 保留。

新 `lpacTokenProof` 是 closed Schema，保存原 token 檢查、owner mask3、LPAC mask2、方法／固定參考 revision及補充 class46 結果。`hasRestrictionsQuery` 固定記錄 `GetTokenInformation`／class21／returnedBytes=1／`BOOLEAN-1`／`measured-host-abi-v1` 與 canonical boolean；其 value 必須和 `hasRestrictions` 相同。bootstrap 成功必須附 proof；既有 bootstrap 失敗歷史仍可按原 envelope讀取。每個後代亦走相同 `VerifyToken`，不得只驗最初根程序。

規格上限為整批 6 分鐘、12 case 根、32 次成功起始／48 次總嘗試；每 case fresh Job、8 程序、512 MiB、5 秒 Job user CPU time／20 秒 wall、各 64 KiB stdout/stderr。可信 fixture 合成寫入總額不超過 4 MiB。temp＋新 profile 的 128 MiB 是 admission／軟預算，**不是不可信 CLI 的強制磁碟配額**。資料夾一般檔案大小可以量測；Windows 共用 registry hive 的物理配置不能歸屬單一 profile，不填零、不宣稱已完整計量。啟動前至少預留 192 MiB（128 MiB 軟預算＋64 MiB 收尾空間），執行中低於 64 MiB 或量測未知即停止。

## 測量與收尾

只測 owned `127.0.0.1`／`::1` listener，不測 LAN、DNS 或第三方。marker 與 listener 必須有 owner 正對照；不存在、程式未開始、連線 refused／timeout、CLR 不相容或任意非零 exit 都不能當成功拒絕。broker 未知結果不能由 Job no-breakaway 推成通過。

停止只處理 owned Job／精確程序。清理必須先確認 Job 空、關閉 profile／registry／pin handles，再 DeleteAppContainerProfile，並確認此前記錄的精確 folder 與 registry storage 不存在。Delete API 成功碼或可衍生 SID 都不足以證明清理。建立結果／所有權／收尾未知時保留 journal 與精確殘留，不能廣泛刪 AppData 或 registry。

Registry storage 身分只能由已核對 owner／本次 AppContainer SID 的 token impersonation、`GetAppContainerRegistryLocation` 回傳 HKEY 與 `NtQueryKey` 實際名稱取得。官方未承諾實體路徑包含 AppContainer SID，不以 SID 文字出現與否代替 token 綁定；僅接受完整 owner hive 邊界，拒絕其他 owner、前綴碰撞與破損路徑。request 不接受 registry path。建立後尚未取得此身分即失敗時，不能以猜測的候選 key 不存在回填 `cleanupVerified:true`。

單獨出現 `closed` journal row 也不能當完成證明；仍須最終結果成功 code、全部 gate、無 cleanup error、收據 durable 完成與 OS 後置核對。當機或 flush 結果未知時不能靠最後一行自行恢復成成功。

每項 required case 使用 `pass / fail / not-measured`。前置失敗後的項目為未量測，不是安全通過。native controller 的 `probePassed` 固定為 `false`；`syntheticSuiteComplete` 只表示合成 cases 完成。整體 W0 結論由獨立 combined manifest 核對全部 required gates、獨立 Claude 靜態身分及清理證據後判定，不改寫原 native 結果；`providerReady` 始終為 `false`。即使 W0 通過，也不能替代受控模型出口、磁碟硬限制、provider auth／設定分離、live protocol、產品接線及安裝驗收。

## 無 profile 的測試

```powershell
# repo root；測試使用新建的合成暫存根，不進行實際 LPAC profile 建立
node --test hub/test/claude-lpac-probe-native.test.js
```

真正的 approved W0 執行與來源／產物／log SHA 應另存 dated evidence；本文件不把尚未量測的 case 宣稱已通過。

## 2026-10-17 實測紀錄

`run-01` 的單一 profile 批次以 `ab2d65a` 來源編譯，成功建立 profile 後在 fixture 啟動前因上述 SDDL bookkeeping 比較停止，`ACL_VERIFY_FAILED`。Delete API 返回成功，精確 profile folder 及其 package parent 事後查無；registry storage 未先捕捉，因此 `cleanupVerified:false / PROFILE_REGISTRY_CLEANUP_UNKNOWN`，保留新合成根與 journal。12 個 native cases 均未量測，沒有執行 fixture、模型或 auth 流程，該 attempt 沒有重試或建立第二個 profile。

獨立 Claude 靜態快照的版本／bytes／SHA 與固定值一致、前後快照相同；執行檔有兩個 NTFS hard links，不符合此批 nlink=1 條件，靜態 gate 失敗。這個條件失敗本身不是已知漏洞的證明。本批整體 `probePassed:false / providerReady:false`；後續純記憶體回歸修正不改寫這次原始失敗結果，也不代表修後配置已實機重驗。

## 使用者要求接續後的驗證

獨立 `run-02` 以 `08cd0a7` 編譯並執行，越過 ACL 與 fixture 準備，已取得實際 registry storage 身分。在 resume fixture 前的完整 token gate 因 `TOKEN_SIZE_INVALID` 停止；本批 profile folder、精確 registry storage 與 owned temp 均驗證已移除，Job 空及 durable closed 收據成立，`cleanupVerified:true`。這不回填 `run-01` 的歷史 unknown，也不表示 LPAC 已通過。

事後 `TokenData` 修正只將 API sizing 的結果分類精確化：first call 必須是 FALSE、`ERROR_INSUFFICIENT_BUFFER` 且長度 1..65536；其他錯誤保留 class／Win32 code，不使用未定義長度。該階段仍保留原先 class 46 LPAC 非零 gate；其後的主判定更正見上節，不改寫此歷史。自有目前程序 token 在受限及 host 兩個 context 的唯讀對照皆見 class 46 回 Win32 87／Native `STATUS_INVALID_INFO_CLASS`，不能由此將所有 LPAC 判成不可行；`run-02` 原始記錄未保留 class，因此不追溯把當時主錯誤改名。

指定 vendor 的靜態核對新增 [`CLAUDE-STATIC-IDENTITY.md`](CLAUDE-STATIC-IDENTITY.md) 所述持有式唯讀快照與 owned native 拒絕測試；exe links=2 但固定內容／身分／前後量測一致的快照已通過。此修正只適用 §5 的 static-only 核對，保留 synthetic root 的 hardlink 拒絕，沒有將靜態通過當成執行或隔離通過。

### 接續批次的診斷與回歸

`token-query-validation.cs` 對 sizing／returned-length 守衛做純記憶體拒絕測試；`token-api-readonly.cs` 只查目前程序的固定 token classes，僅輸出 API 狀態／錯誤／長度，沒有 token payload 或其他程序介面。該階段本機 harness 包含 123 項 token checks，不能替代 suspended LPAC child 的核對；後續 class21 修正的 193 項檢查另列於下節。

`access-check-readonly.cs` 是另外編譯的診斷 fixture，僅對目前程序 token 的 Identification duplicate 與記憶體 descriptor 做 `AccessCheck`，不修改主 gate。descriptor 與零 generic mapping 取自固定 Chromium `5c210565c3fa181730df37778d22af487a0d5e40` 的 `CheckLpacToken`；該階段兩個 caller context 均為 mask 3，當時尚無 LPAC mask 2 陽性對照。因此單靠此診斷不能將主判定宣稱已實機驗證；後來 run-05 的陽性證據另列於下節。

本次實作更正新增 `access-check-validation.cs`（入口 `ProbeLpacAccessSelfTest`）：220 項守衛／固定 descriptor／目前程序負對照總斷言，包含生產 `LpacOwnerControl` 的真 API mask3核對；輸出明列 `profileCreated:false / lpacPositiveMeasured:false`。Node harness記錄 compiler／執行檔與編譯前後來源 SHA，Schema例子驗證 mask、零privilege及class46交叉欄位。未提交可接受的 W0 request、未建立新 profile，也沒有以記憶體模擬的 mask2輸入宣稱量到 LPAC；修正後真陽性及12個 cases仍待受控獨立 attempt。

接續批次的最終指定回歸為 Node **86/86**、Python **70/70**，exit 0，無 Node skip／cancel。涵蓋 Claude／Grok 純離線 codec、registry／拒絕／繁中 readiness UI、native inert／token 診斷、41 項 owned 靜態 sharing checks、9 項 pin 生命週期檢查及原有 3 項 native ancestor pins 測試。沒有新增 profile，也沒有將離線通過提升為 provider readiness。

### run-04 的 class21 根因與固定 ABI 修正

`run-03` 僅完成準備，沒有執行。獨立 `run-04` 在 resume fixture 前以 `TOKEN_SCALAR_INVALID` 停止，`bootstrapPassed:false / cleanupVerified:true`；原始結果保留，不追溯改寫成較精確的新錯誤碼。

`token-shape-readonly.cs` 僅開啟自身 primary token 並建立 SecurityIdentification duplicate，對 class8／9／21／29 做固定長度查詢；另以 `NtQueryInformationToken` 查 class21 作唯讀對照。它不建立 profile、不切換 thread token、不讀取其他程序，只有 class21 的 canonical boolean 會輸出，其他 token payload 不序列化。此機 Windows build26200 的受限與 host context 使用相同執行檔，兩份 40-row 結果 bytes／SHA 相同：class21 sizing 回 FALSE／122／required1，capacity1／4／16 均成功且 returnedBytes=1、值為 true；native API 對照亦相同。這兩個 context 沒有量到 false，false 僅由純記憶體守衛例子驗證。

依此固定本機觀測，class21 改由專用 `QueryRestrictions` 讀取，仍用原 `GetTokenInformation`，僅接受 returnedBytes 恰1、byte 值恰0或1；沒有改成 `IsTokenRestricted` 或另一種限制語義。通用 `Scalar` 仍只接受 DWORD4，拒絕碼帶 class 及實際長度，例如 `TOKEN_CLASS_21_SCALAR_SIZE_INVALID_1`。此為 `measured-host-abi-v1` 的 build-bound 觀測及嚴格相容處理，不宣稱 Microsoft 的 DWORD 文件普遍錯誤，也不保證其他 Windows build；任何其他長度或非 canonical 值仍拒絕。

修正後窄 Node gate **2/2**，沒有 skip／cancel；native token-query harness 為 **193** 項，涵蓋 class／長度歸因、0／1 值、錯誤 class／長度／值拒絕，並將生產讀取器與獨立自身 token API 結果核對。既有 AccessCheck harness 保持 **220** 項，真 owner 負對照仍為 mask3／privilegeCount0；Schema 另拒絕 query 與 hasRestrictions 不一致、錯誤 API／class／encoding／長度及非 boolean。此輪沒有新增 profile，不能宣稱已通過 suspended LPAC 陽性或 W0 cases；86／70 的既有整批證據也不當成此次新 snapshot 的整批回歸。

### run-05 的 CLR activation 與固定 child 環境候選

獨立 `run-05` 已在首指令前取得真 suspended LPAC token 陽性：child AccessCheck mask2／owner mask3、privilegeCount0、空 capabilities、SID／Low IL／primary token／Job 查驗均成立。fixture 隨後 resume，但沒有協定輸出，以 `2148734722`（`0x80131702`）退出，故原結果仍為 `FIXTURE_BOOTSTRAP_INCOMPATIBLE / bootstrapPassed:false / cleanupVerified:true`，cases 未完成。這不是 W0 或 provider readiness 通過，也不改寫 run-04。

官方歷史 [`corerror.xml`](https://github.com/dotnet/coreclr/blob/release/1.0.0/src/inc/corerror.xml#L4072-L4076) 將 `0x80131702` 定義為 `CLR_E_SHIM_INSTALLROOT`；可定位到 install-root 取得失敗，不能由此單獨宣稱 registry ACL 已被證實為根因。固定官方 [WPF consumer 來源](https://github.com/dotnet/wpf/blob/65d15adece1df9a73e3d1abc11f8bbf99e9fc7a9/src/Microsoft.DotNet.Wpf/src/Shared/cpp/Utils.cxx#L71-L101) 描述並讀取 `COMPLUS_InstallRoot`／`COMPLUS_Version` 的 private CLR 路徑。這是來源佐證，不是目前 mscoree 的跨版本保證。

同一 held fixture、固定 identity verb 的五個無 profile 控制中，baseline 與正確 pair 均 exit0／精確 ready；錯誤 Root＋錯誤 Version、錯誤 Root＋正確 Version 均為 `0x80131700`；正確 Root＋錯誤 Version 在 5 秒界線終止。控制程序沒有進入 `BindLayout` 或 auth／模型／網路流程，只改各 child 的環境；沒有改全域 env／registry／ACL，也沒有建立新 profile。它們證明環境值會影響此機啟動，不能直接證明 LPAC 下可免 registry discovery。

基於上述固定來源與控制，`EnvironmentBlock` 的 12-key closed allowlist 對所有可信 fixture case 根程序固定加入 `COMPLUS_InstallRoot=<Environment.SpecialFolder.Windows>\Microsoft.NET\Framework64\` 及 `COMPLUS_Version=v4.0.30319`；fixture 後代沿用該 child 環境。這兩個值不能由 request 或 caller env 改寫，不繼承其他 ambient `COMPLUS_*`／profiler／startup-hook 值，沒有新增 logging env 或 log-copy I/O。此變更僅為待實測的相容性候選，不是已驗證的 LPAC CLR bootstrap 修復。

新增 `environment-block-validation.cs` 以合成路徑字串在記憶體解碼生產 Unicode 環境 block，74 項斷言核對 double-NUL／有界解碼、排序與大小寫不敏感唯一 key、全部 12 個精確值，以及 12 個 caller 污染 marker 不會滲入或被 builder 修改；測試自身的 process-local marker 在 finally 還原。沒有啟動 fixture／profile，也沒有新增權限。原 193 項 token 與 220 項 AccessCheck 檢查保留；實際 LPAC 內的 CLR bootstrap 與完整 cases 仍待獨立有界 attempt。

### run-06 後的 identity-only activation 診斷候選

獨立 `run-06` 的原始 fixture 結果為 `4294967295`（`0xFFFFFFFF`）、stdout／stderr 均0，仍為 `FIXTURE_BOOTSTRAP_INCOMPATIBLE / bootstrapPassed:false / cleanupVerified:true`。固定 CLR env 改變了退出結果，沒有完成 bootstrap；不從新 exit code 猜測底層原因，不改寫 run-05 或 run-06。

依 [Microsoft Framework activation logging 文件](https://learn.microsoft.com/en-us/dotnet/framework/deployment/how-to-debug-clr-activation-issues)，只有 identity child 的 `IdentityEnvironmentBlock` 再加入 `COMPLUS_CLRLoadLogDir=<本次 root>\tmp`，目錄沿用既有 owned tmp；共同 builder／其他 case roots 保持12個 key，identity 為13個。沒有 request 路徑／任意 env 參數，不改全域 env／registry／ACL／capability，不新增外部 destination 或 log-copy writer。此設定已在 run-07 實測，結果如下節；有記錄不等於 bootstrap 成功。

固定檔名依官方 [dotnet/skills log-format](https://github.com/dotnet/skills/blob/main/plugins/dotnet-diag/skills/clr-activation-debugging/references/log-format.md#L10-L18) 的 `{ProcessName}.CLRLoad{NN}.log`（EXE 名稱、NN為00–99），只接受本 fixture 的 `claude-lpac-fixture.exe.CLRLoadNN.log`。Microsoft 未保證完整 log 格式；collector 不擴大搜尋其他資料夾或猜測其他名稱，沒有吻合檔案只記 absent。

只有 identity 啟動後、原有 OS Job 空／程序等待／stdout-stderr join 查驗完成，才於 temp cleanup 前收集。collector 核對同一 root FileID 與全部 pins 的前後身分，對固定 owned tmp 重新持有祖先 pin；最多2個檔、每檔64KiB／合計128KiB。每個來源以同一 `HeldFile` handle 讀取、拒絕 reparse／directory／多重 hardlink，禁止 ADS、跨 root 及非固定 basename，前後核對 FileID／大小／最終路徑。上限是收集界線，**不是 shim 的硬寫入 quota**；檔案寫量仍計入原軟預算。

closed result 的 `clrActivationLogs` 僅有 `captured / absent / error`。成功收集的每筆記錄保存 source basename、FileID、bytes、SHA256、rawBase64，由既有 host create-only native-result evidence writer 保存；不新增 native 寫入路徑。缺檔或任何收集失敗都不替換原 fixture code／exit code，也不當作根因或通過。任何檔案／root／上限查驗失敗即不發布 raw；原 cleanup 仍獨立執行，unsafe file 的 cleanup 拒絕／unknown 不會被吞掉。consumer 讀 raw 前須嚴格解 Base64 並重新核對 bytes／SHA；Schema 的 shape 檢查不證明三者相等。記錄只保留本機私有證據，不對外送出；本探針不讀 auth，raw 仍不可當作可信指令或公開報告內容。

`clr-log-validation.cs` 使用 owned 合成檔案，61項斷言包含實際雙檔128KiB讀取、第三檔／超限／空Job假值／root身分錯誤拒絕、ADS／cross-root／reparse純守衛、實際hardlink拒絕及既有 cleanup 的 `CLEANUP_IDENTITY_CHANGED`。host Node窄 gate **2/2**、無 skip／cancel；Node另解碼所有合成 raw、重算 bytes／SHA、核對唯一FileID與Schema。環境記憶體檢查增至102項（共同12keys／identity13keys，污染marker仍12個），token193／AccessCheck220均保留。受限 context 的 ancestor pin 拒絕、早期 fixture 準備錯誤另留失敗 log；沒有把它們當通過。這一輪離線守衛未建立 profile、未啟動 vendor／模型或新增外部流量；之後的獨立實測另列如下。

### run-07：已量測的 activation log

run-07 使用凍結 source probe `6f574da0591d97e3973206c5c798856e858b432d36f8e13b111c4fa631fdfe5a`，實際 suspended child 的 token gates 成立。取得一份5538-byte UTF-16LE log，parent 已嚴格檢查 canonical Base64／decoded bytes／SHA `cd9820aa888e5e670da286bd472dc7e67a7d4f32928fd3a4d10d38b65c5fb7ea`。runtime v4.0.30319 已載入，但 fixture 仍退出FFFFFFFF、0stdout/stderr、未完成握手。

兩次 internal runtime-host GetInterface 呼叫沒有HRESULT，不證明該呼叫失敗；官方 [GetInterface 說明](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrruntimeinfo-getinterface-method#remarks) 區分載入與初始化。當前沒有managed runtime初始化成功的證據，精確根因仍unknown。缺config也不能單獨解釋失敗，owner無config正對照成功。沒有增加capability或退回普通AppContainer／full-user。

Job空、profile folder／精確registry storage／owned temp消失皆核對成立；13項combined cases仍not-measured。原始result／journal／execution及獨立reconciled manifest位於外層workspace `outputs/claude-lpac-w0-20261017/run-07/`。W0及provider仍未通過，沒有執行vendor／auth／模型或安裝新CLI功能。
