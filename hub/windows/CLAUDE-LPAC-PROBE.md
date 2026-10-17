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

controller 建立此次 per-user profile 及私有 temp 前後留下 durable journal，綁 owner／SID／nonce／root identity。新 runtime 只讀；task/tmp 只對本次 SID 給必要存取及 Low IL。啟動時只繼承明列的資料 handles，env 採 allowlist；AppContainer capabilities 為空，使用 LPAC opt-out policy。

私有 ACL 核對比較 owner、protected DACL 及完整 ACE binary；只允許 Windows 自動加入的 `DiscretionaryAclAutoInherited` bookkeeping 差異。新增／移除 ACE、權限、SID、順序、繼承／傳播及其他 control flag 差異均拒絕，不因 SDDL 的 `D:P`／`D:PAI` 表示差異而誤判。

case 根程序先 suspended，controller 從 OS 查驗本次 AppContainer SID、class 46 LPAC、Low IL、capability 清單與 Job membership 後才 resume。child 的文字不是 token 或隔離證明；後代驗證及開始握手須與實際 PID／handle／Job 相符。

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

事後 `TokenData` 修正只將 API sizing 的結果分類精確化：first call 必須是 FALSE、`ERROR_INSUFFICIENT_BUFFER` 且長度 1..65536；其他錯誤保留 class／Win32 code，不使用未定義長度。原先 class 46 LPAC 非零 gate 仍保留。自有目前程序 token 在受限及 host 兩個 context 的唯讀對照皆見 class 46 回 Win32 87／Native `STATUS_INVALID_INFO_CLASS`，不能由此將所有 LPAC 判成不可行；`run-02` 原始記錄未保留 class，因此不追溯把當時主錯誤改名。

指定 vendor 的靜態核對新增 [`CLAUDE-STATIC-IDENTITY.md`](CLAUDE-STATIC-IDENTITY.md) 所述持有式唯讀快照與 owned native 拒絕測試；exe links=2 但固定內容／身分／前後量測一致的快照已通過。此修正只適用 §5 的 static-only 核對，保留 synthetic root 的 hardlink 拒絕，沒有將靜態通過當成執行或隔離通過。

### 接續批次的診斷與回歸

`token-query-validation.cs` 對 sizing／returned-length 守衛做純記憶體拒絕測試；`token-api-readonly.cs` 只查目前程序的固定 token classes，僅輸出 API 狀態／錯誤／長度，沒有 token payload 或其他程序介面。最終本機 harness 包含 123 項 token checks，不能替代 suspended LPAC child 的核對。

`access-check-readonly.cs` 是另外編譯的診斷 fixture，僅對目前程序 token 的 Identification duplicate 與記憶體 descriptor 做 `AccessCheck`，不修改主 gate。descriptor 與零 generic mapping 取自固定 Chromium `5c210565c3fa181730df37778d22af487a0d5e40` 的 `CheckLpacToken`；目前兩個 caller context 均為 mask 3，尚無 LPAC mask 2 陽性對照。因此它不是已驗證的 class 46 替代方案。

接續批次的最終指定回歸為 Node **86/86**、Python **70/70**，exit 0，無 Node skip／cancel。涵蓋 Claude／Grok 純離線 codec、registry／拒絕／繁中 readiness UI、native inert／token 診斷、41 項 owned 靜態 sharing checks、9 項 pin 生命週期檢查及原有 3 項 native ancestor pins 測試。沒有新增 profile，也沒有將離線通過提升為 provider readiness。
