# Project Hub：記住 SSH 連線與受限金鑰補充

日期：2026-10-14（Asia/Taipei）。

狀態：**供使用者審閱，尚未核准此書面補充、尚未建立金鑰。** 使用者詢問是否可記憶連線，並在專用受限金鑰建議後指示繼續；本文件把該方向具體化。既有 Linux 私有部署依原已核准範圍繼續。

本補充延續 `2026-10-13-ssh-linux-worker-design.md` §5；改變限於連線登錄與持久 SSH 認證。原隔離、來源、資源、run permit、停止、模型送出及 R2／M readiness 門檻繼續適用。未公開的主機／帳號／來源位址只存於 controller 私有登錄與 task evidence，不成為產品預設值。

## 1. 使用目的與現況

目的：重新啟動 Project Hub 後能使用同一台已核對 Linux worker，減少密碼視窗與失效提示混淆；同時限制專用金鑰的用途，保留既有登入方式與可驗證的撤回程序。

已量測：先前 SSH 密碼登入、資源探針，以及之後一次唯讀 UTF-8 回傳成功。另一次密碼認證遭拒絕，未看伺服器日誌，不能認定輸入錯誤。CLI 部署與 worker／provider readiness 是分開的驗收。

現有 pin 保存在 task 私有 known_hosts，主機／帳號存在 task 操作檔；正式 Hub 尚沒有持久 SSH connection/key UI。現有 DPAPI helpers 可參考，但 MCP entropy 不可冒用為 SSH domain；現有 private file API 未提供專用 DACL 證據。

## 2. 方案與取捨

| 方案 | 成本與限制 | 選擇 |
|---|---|---|
| 記住主機／帳號／pin，每次由 askpass 輸入密碼 | 最少新增程式；每條新 SSH 連線仍需互動 | 保留作初始部署與人工復原方式 |
| 專用 Ed25519 key＋Windows DPAPI＋Linux forced command | 需 native ACL／暫存清理、key 登錄撤回與拒絕測試；免密僅限固定 worker | 建議採用 |

不新增系統 ssh-agent service、全域 SSH config、ControlMaster／ControlPersist 或 agent forwarding。SSH key 本身不授予 sudo、模型登入／送出或一般 shell。

## 3. Linux 金鑰能力與入口

先透過現有密碼通道 create-only 部署可驗證、持久的固定 Python entrypoint；entrypoint bytes／modules／manifest 以 held-FD／exact digest 綁定。動態 shell source bootstrap 不可成為金鑰 forced command。

新 authorized_keys 列使用 `restrict,command="固定 entrypoint",expiry-time="固定 UTC 到期時刻"`。`restrict` 禁止 PTY、agent／port／X11 forwarding 及 user rc。Entry 僅接受精確固定的原始 command marker 與 bounded typed protocol；其他 command、shell、SFTP／SCP、未知 operation、code upload、任意路徑及 owner approval 一律拒絕。[OpenSSH authorized_keys](https://man.openbsd.org/sshd.8)

首個金鑰有效期為登錄時起 90 天，controller 與 server 各自檢查；不得自動續期或於到期後退回其他 identity。登錄前測 server 對限制／expiry options 的實際接受與拒絕。來源 `from=` 限制只在已確認固定 Windows 來源位址時追加；未核對穩定來源時不宣稱限制來源 IP。

第一個 entrypoint 只允許固定已核對 artifact staging／唯讀身分與狀態。正式 run 仍需原 permit 與隔離門檻，不能因 key 可登入就啟用 Claude／Grok。Worker code 升級不由 connection key 上傳任意程式；重新審阅 source identity 後走 owner 部署流程。

只在核對 home／.ssh／authorized_keys owner、mode、無 symlink／hardlink、held parent／file identity 與加入前 SHA 後追加本產品列；保留全部既有 bytes／keys。並發異動、未知狀態或不支援限制時停止，不以覆寫或刪除舊 key 修復。收據綁定本產品公鑰 fingerprint、登錄 ID、exact line SHA、原／新檔 SHA／inode 與期限，不記錄其他 key 內容。

Forced command 仍由登入 shell 啟動，須核對 shell startup／系統 sshrc／user environment 的前置信任。此設計信任 Linux owner／root；私有 entrypoint 不防同一 owner 改檔。

## 4. Windows 保管與使用

連線登錄綁定 target ID、host pin、port、user、remote entrypoint／manifest digest、public-key fingerprint、期限及 vault root identity。Ciphertext 使用 DPAPI CurrentUser 與獨立 `ProjectHub.WorkerSshKey.v1` domain；metadata／payload 交叉核對，禁止任意更改目標後沿用舊 key。[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

Ciphertext 存於 controller 私有 NTFS vault，隔離於專案／Git／套件／MCP／普通檔案工具與診斷輸出。建立時即使用 protected DACL，只允許當前 owner SID；不先寫私鑰再修 ACL。新增 vault 與 native helper 要沿既有 Root／FileID／no-reparse／nlink=1／create-only／receipt 慣例，錯 owner／ACL／ciphertext／domain／root 皆拒絕。[Windows file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)

每次啟動固定 SSH binary 時，native owner helper 解密到隨機 operation directory 的 create-only 暫存 key，驗 owner／DACL／FileID／SHA／no reparse／nlink。保持 held parent／key identity，拒絕替換與寫入；私鑰 bytes 不進 argv、env、console、journal、backup 或 task output。SSH 對此檔只讀。

認證成功後立即按 owned identity 刪除暫存 key；失敗、取消、deadline、Hub crash 由 native guard 收尾並驗 exact absence。禁止僅以預期刪除或 child close 宣稱清理成功。`FILE_FLAG_DELETE_ON_CLOSE` 只有在 Git/MSYS SSH 真實讀取與 sharing 相容性測試通過後可採用；否則使用驗證過的 guard／identity cleanup，未知狀態禁止再解密。[CreateFileW sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

SSH 使用 private known_hosts、strict pin、固定 target／binary、`IdentityAgent=none`、`IdentitiesOnly=yes`、`BatchMode=yes`、publickey-only；禁讀預設 key、全域 config 與 forwarding。重啟 Hub 後須重新證明該登錄仍有效。[SSH config](https://man.openbsd.org/ssh_config.5)

DPAPI／DACL 不保護相同 Windows 帳號的惡意程序或 administrator；檔案刪除不等於磁碟安全抹除。設計降低持久暴露與錯用範圍，不宣稱憑證不可取得。

## 5. 撤回、復原與 UI

設定畫面以繁體中文呈現：連線身分、pin／key fingerprint、到期、登入狀態、原 provider readiness、建立金鑰與撤回。不得顯示私鑰或把 key 登錄成功包裝成 provider 可用。

撤回先停本產品 owned run／SSH，再核對並移除本產品 exact key 列，重讀／驗證且測新 publickey 認證拒絕，最後清理 ciphertext／暫存物件。保留其他列與使用者成果。移除 key 列只擋新認證，不終止既有 session；未驗 owned connection 退出不能標示完整撤回。

失聯時只能標示「本機停用，遠端撤回未驗證」；保留非秘密公鑰／收據用於之後精確對帳。遠端 key 移除／維護仍可用使用者手動密碼通道；不得在背景儲存密碼、自動降級或擴大 sudo 範圍。

## 6. 實作交付與驗收

新增獨立 SSH credential/schema、native ACL／guard／owned cleanup、server forced entry與 key 登錄／撤回收據；接入已核准 worker controller。不得把 task 操作腳本視為正式 Hub UI。實作前沿既有 execution method 編排必要計畫；此書面補充審阅尚未完成，不在本輪先建立 key。

| Gate | 必須實測 |
|---|---|
| 重啟與正常使用 | Hub 重啟後 publickey-only、無密碼視窗、typed hello／identity／expiry 驗證 |
| Server 越權 | arbitrary shell／command／SFTP／SCP／PTY／local、remote、agent、X11 forwarding 拒絕 |
| Protocol | unknown op／nonce／sequence／replay／過期 permit／越界路徑／entry bytes 變更拒絕 |
| Windows key | wrong owner／root／target／DPAPI domain／損壞 ciphertext／ACL 變寬／link／替換拒絕 |
| Cleanup | auth 成功、拒絕、取消、timeout、Hub crash；owned key exact absence／owned process 終止 |
| 登錄與撤回 | 原 authorized_keys 保留、並發改變拒絕；撤回後新連線拒絕、既有 owned 連線已退出 |
| 期限與失聯 | 雙邊 expiry 拒絕、不自動續期；遠端不明如實標示，不留成功狀態 |

程式變更後跑相关 Node/native/worker tests，以及 `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v`。原 R2／M／Windows package 与正式安裝驗收繼續適用；金鑰測試不代替 CLI、模型或完整 Hub 功能驗收。
