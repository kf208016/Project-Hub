# Project Hub：Windows 認證管理員保存 SSH 密碼

日期：2026-10-14（Asia/Taipei）。狀態：**使用者在書面方案呈現後回覆「好」，核准本方案並沿目前聊天執行；實作中，尚未保存真實認證。**

使用者要求採其他記憶密碼工具、不要一直重複輸入，並確認先前已輸入且按確定。本补充以 Windows 內建認證管理員取代反覆 Git Tcl askpass；不採尚未核准的持久 SSH key 方案，不修改 Linux authorized_keys、sudo 或模型送出範圍。原 worker／CLI 隔離及 readiness gates 保留。

## 1. 目標、限制與目前證據

目的：只在明確的「記住登入密碼」流程錄入一次；之後由受控 native broker 供 SSH 使用。取消、失敗、逾期與錯誤不再自動重新彈窗或背景重試。密碼修改或使用者主動選擇更新時，才另外錄入。

v3 記錄沒有 authenticated，也沒有 Permission denied，不能判定使用者輸入錯誤。既有 Git askpass 沒有 submitted 回執／attempt 身分，且舊 controller 沒可靠收束 GUI 子樹。最新唯讀盤點已沒有本 task SSH／askpass／controller 或指定目標 TCP；無法找回前次輸入，亦無已認證 session 可重用。

保存完整 Linux 帳號密碼，等同保留該帳號原有 SSH／shell／檔案權限；正常 Hub broker 的限制不會降低密碼本身的權限。Windows Generic credential 屬於相同 Windows 帳號信任域，不能宣稱其他同帳號程式無法取用，也不保護 administrator。[Microsoft CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)

## 2. 一次錄入與驗證後保存

新增可信 native broker，先核對固定 SSH descriptor／host pin／binary／owner／private roots，再在建立 SSH 連線前顯示唯一 attempt 的 Windows CredUI。這讓使用者輸入時間不消耗 server authentication grace period；不把這種時序改善當作前次失敗原因已證實。

CredUI 明示 Linux 目標、帳號、保存目的與取消方式；不列舉其他認證。使用 `CredUIPromptForWindowsCredentialsW` Generic 模式及無密碼預填；憑證只在 native buffers 中收集。Generic 模式不能使用 SECURE_PROMPT，不宣稱是安全桌面或密碼只存在 OS vault。[Microsoft CredUI](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creduipromptforwindowscredentialsw)

native broker 持有候選密碼，以 owned Job 啟動固定 SSH；一次 ASKPASS 透過本次私人 pipe 供應候選，controller／JavaScript／PowerShell／agent 不接收密碼。認證成功及固定唯讀 identity probe／nonce／UID 回傳都通過後，controller 只發送非秘密 commit 訊息，native broker 才保存；取消／拒絕／timeout／identity probe 失敗不保存。

使用 `CRED_TYPE_GENERIC`、`CRED_PERSIST_LOCAL_MACHINE`，只在此電腦的同一 Windows 帳號保留，不用 Enterprise roaming。不寫密碼到腳本、argv、env、檔案、JSON、clipboard、console、hash 或 log。secret readback／比較與清零都在 native helper 內，不輸出 blob／password hash。[Microsoft CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew)

專用 exact TargetName：`ProjectHub.WorkerSshPassword.v1/<random-registration-id>/<binding-sha256>`；binding 固定 host、port、user、pin、Windows SID、SSH／broker source 身分、private root。只精確 read／write／delete 本產品該筆，不呼叫 CredEnumerate。新 ID 不覆寫既有項目；CredWrite 本身不是 create-only，owner／並發／收據不符時拒絕，保存失敗不留看似成功的狀態。

## 3. 取用、通道與程序身分

一般連線不顯示 CredUI；native helper 只讀 exact validated entry。若無有效登錄、密碼被拒絕、pin／code／owner／root 改變，回報可定位的狀態，禁止重新彈窗、讀其他認證或轉用預設 key。復原由使用者明確選擇更新／忘記，不能自動重新建立憑證。

ASKPASS 僅寫入 SSH 建立的內部密碼 pipe。供應前驗本次 registered SSH PID＋建立時間＋image digest、同 SID、同 owned Job、有限且已量測的 Git/MSYS ancestry chain、一次性 nonce 與有效 permit。只看 parent PID、env 或 prompt 字串不足。自己的 pipe 要有 owner DACL、拒遠端 client 與 native peer PID 檢查；未知 caller 不能得到密碼。[OpenSSH ASKPASS](https://man.openbsd.org/ssh.1)

固定 private known_hosts／strict pin、password-only／一次 prompt、無 global config／預設 identity／forwarding。Git/MSYS intermediary 必須真實量測；不因 parent 不吻合而放寬成任意 caller。Windows Job 在 SSH 首條指令前生效；owner crash／取消／deadline 終止 owned tree。submitted、authenticated、identity-probe、stored 是分開事件；任一缺漏不標記成功。

UTF-8 無 BOM；保留前後空白、繁體中文、符號／emoji，不 trim／normalize。NUL／CR／LF／無效 surrogate、超出 blob 上限拒絕，不截斷。native secret buffers 用完清零及釋放，但不宣稱所有系統記憶體副本或 crash dump 都不存在。

## 4. 忘記密碼与維護

忘記流程：停 owned SSH／Job → exact CredDelete → exact CredRead 確認 NOT_FOUND → 停用登錄／驗暫存 buffers 与程序收尾。保留其他 credentials。失聯／清理不明標示未完成，不標記已撤回。這只移除 Hub 的本機保存，不修改 Linux 密碼或撤銷其他登入方式。

不新增第三方 app、全域 agent、Linux SSH policy、持久 key 或新 model grant。原已核准私有 artifact 部署可在此固定密碼通道驗證成功後繼續；不以保存成功代替 CLI／隔離／完整功能驗收。

## 5. 交付與驗收

新增 native credential broker／ASKPASS entry、封閉 schema／登錄收據與 controller glue；沿既有 Windows native helper／Job／source 身分慣例。先以本產品新 synthetic credential 驗 exact create／readback／delete、錯 caller／identity／target／pin／root／code、pipe 遠端／重放拒絕，不能讀或枚舉既有使用者 vault。

實測 UI 的 submitted／cancelled／expired、UTF-8／空白與秘密不進 controller output；首次成功認證＋唯讀 identity probe 才保存；worker library／資源／部署拒絕不把有效認證刪除或觸發重輸。後續至少兩次新連線與 controller 重啟，均無密碼提示；拒絕／密碼異動停止，不自動再詢問。忘記後新自動連線明確拒絕，other entries 保留。secret leak／cleanup／artifact staging failure 均保留 truthful nonterminal／failed 狀態。

相關 Node／native tests，以及使用者指定 `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v`；fixture、原生本機、實際 SSH／CredUI、provider／model 分開報告。原 R2／M／package／正式安裝 gate 繼續適用。書面方案核准後沿目前聊天的執行方式編排 native helper、synthetic、正式一次錄入與自動連線驗收，才整合。
