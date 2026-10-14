# SSH 密碼保存與免提示連線

此元件使用 Windows 認證管理員，完整 Linux 帳號密碼保留原本的登入權限。同一 Windows 帳號內的程式及系統管理員仍在信任範圍內。只處理 exact `ProjectHub.WorkerSshPassword.v1/<registration-id>/<binding>`，不枚舉認證。

`hub/lib/ssh-password-vault.js` 控制 `prepare`、`enroll`、`probe`、`status`、`forget`、`stage`。`enroll` 先顯示原生「SSH 連線設定」視窗；只有使用者按「開始一次錄入」，才開啟以該視窗為 owner 的 CredUI。設定窗沒有密碼欄，出現時不會啟動 SSH。先輸入、再連線固定 SSH 主機與驗證指紋；唯讀 nonce／UID probe 成功後才保存。其餘模式不開提示，缺少密碼、來源／SID／Root 改變或認證被拒絕均停止。取消後不自動重試。

`operation(mode, descriptor, {onEvent})` 的同步 callback 僅收到固定 allowlist 事件；不傳 raw stderr。`ENROLLMENT_READY` 代表設定窗的 Shown 事件，不證明使用者看見或視窗在前景；`ENROLLMENT_REQUESTED` 代表單次開始按鈕被觸發。`PROMPT_REQUESTED` 代表將呼叫 CredUI API，不證明視窗可見或在前景；`PROMPT_RETURNED`／`PROMPT_CANCELLED` 代表 API 返回；`PROMPT_UNPACKED`／`SUBMITTED` 代表解析與驗證完成。真正保存仍須 `STORED` 與成功結果。Callback 失敗停止本次操作，不重試；async callback 不受支援。

controller 在開始按鈕之前有 15 分鐘等待期限，回報 `VAULT_ENROLLMENT_IDLE_TIMEOUT`；第一次有效 `ENROLLMENT_REQUESTED` 才啟動 300 秒錄入／驗證／保存期限，回報 `VAULT_OPERATION_TIMEOUT`。重複或亂序的設定窗事件拒絕，不延長期限。設定窗取消回報 `SSH_VAULT_ENROLLMENT_CANCELLED`；CredUI 取消回報 `SSH_VAULT_PROMPT_CANCELLED`。停止後最多等待 5 秒，未收到 close 時 `childCloseObserved=false`；收到 close 也不代表 OS 代管 CredUI 或整個 Job 已確認消失。不得依名稱終止共用 `CredentialUIBroker`。逾時後若缺少 receipt，仍應精確檢查此次 target，以排除寫入成功與 receipt 寫入之間中斷的情形。

descriptor 格式見 `ssh-password-vault.schema.json`，合成資料見 `ssh-password-vault-examples.json`。其中 SSH 路徑、Ed25519 host key、固定 stage command 與來源 hash 必須來自已驗證的 operator。沒有任意指令參數或公開 HTTP 路由。真實主機與登錄只留在 task 私有目錄，不放入產品範例。

原生 helper 持有候選與保存的秘密 byte buffers；Node／PowerShell 收到固定狀態事件。C#／Node request 使用相同 canonical JSON；拒絕重複欄位、非規定型別及非標準序列化。根目錄以 NTFS identity pin、owner-only DACL、獨佔登錄鎖保護。DPAPI 登錄收據不含密碼，綁定 SID／Root／主機／程式身分。编譯缓存的 source 與 binary 收據用於偵測改動，不宣稱是發行者簽章或防禦同帳號的惡意程式。

每次 SSH 先 suspended，再加入 kill-on-close Job。ASKPASS private pipe 拒絕遠端 client，驗 owner SID、native peer PID／建立時間、image hash、同一 Job、最多四層同一 SSH image 的祖先鏈與一次 nonce。秘密只送至該 SSH 建立的 password pipe，helper 用完清零；不宣稱排除 OS 記憶體副本或 crash dump。

`forget` 先取消此 controller 擁有的同筆連線並等待收束，再精確刪除／查證不存在，寫入不可變 forgotten 收據。另一 controller 正持有登錄鎖時會拒絕；不猜測 PID 或終止其他程序。應先停止該 controller 再明確執行忘記。忘記不更改 Linux 密碼。程式／來源更新造成 binding 改變時拒絕取用，需另作明確遷移，不能靜默重新綁定。

測試分成三層：

```powershell
node --test hub/test/ssh-password-vault.test.js hub/test/ssh-vault-transport.test.js hub/test/ssh-vault-enrollment.test.js hub/test/ssh-vault-invocation.test.js
$env:HUB_RUN_VAULT_NATIVE_TEST = '1'
node --test hub/test/ssh-password-vault-native.test.js
$env:PYTHONPATH = 'src'
python -m unittest discover -s tests -v
```

第二層需要已安裝 Python `cryptography` 的測試環境。它只啟動 `127.0.0.1` SSH fixture，建立全新產品合成認證，驗保存、兩次新程序免提示重連、改動拒絕及精確忘記；不開真實 CredUI、不讀既有認證。fixture entry 僅在測試編譯旗標下存在，正式 broker 無此模式。測試失敗留下的私有收據用於精確恢復，不以模糊 prefix 刪除 vault。

正式 CredUI／遠端 SSH 實測、私有 CLI staging、provider 隔離／完整 Hub 能力及模型驗收分別紀錄。密碼保存或 SSH probe 成功不代表 Claude／Grok 已可執行。
