# R2 一次性只讀診斷補充

日期：2026-10-15（Asia/Taipei）

狀態：**使用者於 2026-10-15 回覆「好」，核准依目前聊天方式實作、合成驗證及一次正式唯讀診斷。** 核准時尚未實作或執行；結果另存驗證報告，不由本規格宣稱完成。

## 1. 已完成與實際阻礙

SSH 免重輸遷移已完成，新登錄啟用、舊認證退役，切換後兩次獨立重連通過。固定 R2 實機測試已被接受，但回傳 `R2_UNIT_IDENTITY_CHANGED`，`cleanupVerified=false`，unknown lease 保留。

現有 broker 只支援本機 status、UID／boot probe 及固定 R2 run，不能讀回該次 run 的診斷文件。重跑會被 unknown lease 擋住，不能藉改 payload、通用 SSH command 或清除 lease 繞過。

systemd v259 在 `SERVICE_EXITED` 會 prune cgroup；`RemainAfterExit=yes` 不保證保留 `ControlGroup`。目前 controller 在終態前仍要求原路徑，是已確認的生命週期設計缺陷。此次實機是否成功完成 measurement，或先有其他 service 錯誤，尚缺證據。[官方 service.c](https://raw.githubusercontent.com/systemd/systemd/v259/src/core/service.c)、[官方 cgroup.c](https://raw.githubusercontent.com/systemd/systemd/v259/src/core/cgroup.c)。

## 2. 建議：一次性原生只讀 helper

新增一個獨立、有時限的 native 診斷程式，沿用目前已保存的**單筆 v2 認證**，執行唯一固定 operation `inspect-r2-run-v1`。本次不建立第三筆 credential、不修改現有 broker/catalog/descriptor/activation/pointer、不復活已退役 v1。

新 helper 也是能取得本筆密碼的新可信程式。原維護規格 §8 明定新程式／operation／catalog 超出原 binding 要明確審閱；本補充不是用「唯讀」迴避這項要求。

### 封閉 grant

只允許：schema version、隨機 grant ID、起訖時間（最多 10 分鐘）、固定 operation、審閱文件 reference 與 SHA、目前 immutable migration manifest 的固定 reference 與 SHA、destination binding SHA、原 registration／activation／pointer bytes SHA、原 run receipt／canonical run permit SHA、原 R2 catalog SHA、helper binary/source-set SHA、固定診斷 catalog/payload SHA 及長度、原 R2 失敗 evidence SHA、exact run nonce／UID／boot identity、owner-only grant root identity、固定輸出／時間上限及 `maxSessions=1`。

主機、帳號、host pin、Windows SID、SSH runtime、credential exact target、目前 broker 與 roots 全部從已驗證的原 manifest 推導，不提供另一份可自由替換的值。不得有任意 command、source、path、argv、環境變數或 provider 欄位。實際值留在 task 私有檔案。

這次 helper build 同時固定 manifest、destination binding、run nonce、原 catalog 與診斷 catalog；grant 必須逐項一致，不能改成另一登錄或 run。拒絕未知／重複欄位、隱式型別轉換、布林冒充整數、全零 nonce、非 canonical UUID。審閱 reference、hash 與 grant 是本機綁定證據，並非數位簽章或抵抗同 SID 惡意程式的授權證明。

### 本機前置檢查

- 固定 helper/source/build 身分，持有並驗 native／SSH code handles、原登錄 roots 與 ACL。
- 依既有鎖順序開啟已存在的 transaction／registration locks；不以 OpenOrCreate 補回原 v2 檔案。核對原 manifest、雙方 intent、完整 journal、來源退役 tomb、v2 pending receipt、activation receipt、exact pointer、無目的 rollback／forgotten 狀態。
- 確認 grant 未到期、未消耗，run receipt／permit／nonce／boot／catalog／UID 與既有失敗 evidence 一致；在獨立診斷 root 以 create-only 記錄並讀回消耗狀態，才可讀取認證。成功或失敗都不重試同一 grant。
- 僅 native 精確 CredRead 一筆保存認證；不枚舉、不 CredWrite／CredDelete、不 CredUI。秘密 buffer 清零；Node、PowerShell、環境、argv、檔案、console 不接收密碼。
- 沿用 owned Job、原 host pin、private ASKPASS peer 身分、一次 nonce、短期限；拒絕失敗不換 credential、不提示密碼、不重試。

原 migration 期限只用來判讀歷史證據；此次操作依新的診斷 grant，不借用 recoveryGrant。新增獨立只讀 admission validator，不修改既有維護程式的 self-image 驗證來容納新 helper。

## 3. 遠端只讀範圍

固定 Python 程式只對**本次失敗 run**取證：

1. 驗 Linux 非 root、UID／boot、既有 worker/R2 ownership receipts、owner-only 目錄與 directory-FD 身分。
2. 核對 run intent 與 retained lease 的 exact nonce／catalog／identity。
3. 只讀固定檔名：`intent.json`、`runtime.json`、`unit.json`、`service-kernel.json`、`execution-gate.json`、`service-error.json`、`measurement.json`、`result.json`、`closed.json`，以及 R2 root 的 `active.json`。檔案須 regular、單一 link、同 UID、無 symlink、大小受限；不存在與拒絕／損壞分開呈現。
4. 固定 `/usr/bin/systemctl --user --no-pager show`，unit 名稱只能由 exact nonce 推導；只取 LoadState、ActiveState、SubState、InvocationID、MainPID、ControlGroup、ExecMainCode、ExecMainStatus、Result。執行檔須 root-owned、固定 runtime pin 並持有 executable FD；不得讀任意 journal／stdout／provider 日誌。
5. 如仍有與已保存 unit identity 一致的 cgroup，只讀其 inode、`cgroup.events`、`memory.max`、`memory.swap.max`、`pids.max`、`cpu.max`。路徑只從已驗證 service-kernel 記錄推導，核對 unit 記錄的 path SHA／inode；unit／cgroup 消失或不符時回報 unknown，不跟隨替代 cgroup、不搜尋其他程序。

每個檔案最多 32 KiB，10 個固定 JSON 檔案合計最多 320 KiB，僅輸出經封閉格式與原 run bindings 驗證的必要欄位，總 stdout 最多 128 KiB，完整操作最多 45 秒。未知 JSON 欄位、任意文字／路徑、原始 stderr 不原樣外送；原始資料保留在原 Linux 私有目錄。讀取期間內容／held identity 改變須分別標示，不把多個時間點的讀值當原子快照。

不主動寫 Linux R2 狀態檔案、不建立新 service／sandbox、不 kill／stop、不刪 lease、不改密碼／SSH 設定，不讀 provider auth、不執行 Claude/Grok、不呼叫模型。SSH／作業系統仍可能記錄登入或存取時間。不得呼叫既有 supervisor main／cleanup 或 `PrivateState(controller=True)`，因為它們會建立狀態或控制 unit。

## 4. 驗證與失敗界線

核准後在目前聊天實作獨立 helper／固定診斷 catalog，先跑合成 v2 登錄與 loopback 驗證：有效 grant、過期／重播、code/manifest/pointer/metadata 改變、錯 run／UID／boot、路徑與額外欄位注入、檔案缺失／損壞／超量、秘密不進輸出、零 credential mutation、未主動修改遠端 R2 狀態檔案。

通過後固定 exact build/manifest，只執行本次正式只讀診斷。Windows 可以新增 owner-only 的非秘密 grant 與結果；現有正式認證與程式保留。

讀到 measurement 成功不等於補回歷史 `populated=0` 證據。診斷後仍缺原 cgroup 清理證據，歷史 cleanup 維持 unknown。任何清 lease、終止程序、修正版 R2 catalog 或 v2→新 broker 遷移，均以實際診斷證據提出下一個具體維護差異；本補充不預先授權它們。

## 5. 本次決定

是否同意依上述封閉範圍實作、合成測試，再讓獨立 native helper 沿用目前已存密碼，執行一次固定只讀診斷？不需重輸密碼；無 credential 遷移，也不主動修改遠端 R2 狀態。

使用者已回覆「好」。核准限上述一次性診斷；原 R2 清理未知、provider 未就緒等驗收狀態不因核准改變。
