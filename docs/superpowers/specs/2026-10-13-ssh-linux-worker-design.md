# Project Hub：獨立 Linux／SSH worker 設計補充

日期：2026-10-13（Asia/Taipei）

狀態：**2026-10-13 使用者核准「同意，繼續 Claude／Grok（保留 Grok 來源限制）」；沿原已核准執行方式推進。核准不代表 Linux CLI 已安裝、worker 已實作或 provider 已就緒。**

基準：`windows-browser-mvp`，產品 commit `dbabda4b4f22bb63d5da8ab598b89e59e50083ba`。本補充延續已核准的 `2026-10-09-multi-provider-cli-web-chat-design.md` 與 `2026-10-10-multi-provider-cli-web-chat-implementation.md`；差異限於使用者提供的獨立 Linux、SSH 通道、既有主機資源與私有 native CLI 部署。原規格的能力、授權、隔離、秘密、成果回收及驗收門檻繼續適用。

## 1. 目標與選擇

Windows Hub 保留原生 Codex、繁體中文及 ChatGPT／Claude Chat 手動交接；Claude Code／Grok 改由指定 Linux worker 執行。使用者已提供 SSH 主機、帳號，並確認在主機端核對 SSH 指紋一致；本補充不推定其他主機、sudo、全域套件、登入或模型傳輸的授權。Agy 仍維持後續逐 provider 驗收，沒有以另一個 CLI 代替。

| 路線 | 成本與限制 | 決定 |
|---|---|---|
| 指定獨立 Linux＋SSH＋強制隔離 | 使用既有 Python／Git／bubblewrap／systemd；新增 SSH 通道、profile、broker 與 Linux 更新維護。現有 NIC／Linux kernel 仍須納入邊界 | 採用使用者指定方向 |
| 原 Hyper-V VM＋Hyper-V socket | 需 Windows 管理功能、privileged helper、映像及額外資源 | 保留為歷史候選；本路線不執行其系統變更 |
| 直接 SSH 執行 CLI | 最少元件，但 CLI 可取得 SSH 使用者的主機檔案與網路權限 | 不符合原 whole-process 要求，不採用 |

目標為完整 Hub 流程的可驗證交付；僅安裝 `claude`／`grok`、能印版號或一筆模型回答，均不是整合完成。

## 2. 已量測與未量測

本次 task 的私有 `outputs` 保存完整目標／SSH pin／時間／原始量測；實際位址與帳號不放入可隨套件散布的規格。

| 項目 | 本次證據 | 限制 |
|---|---|---|
| SSH | 已用指定帳號登入；strict host pin；密碼由 OpenSSH 遮蔽視窗輸入 | 未建立永久 key、agent forwarding 或全域 SSH 設定 |
| OS | Ubuntu 26.04 LTS、x86_64、kernel 7.0.0-30-generic；系統回報 VMware | 不代表所有共享、hypervisor 設定或 OS 弱點均已稽核 |
| 資源 | 2 logical CPU；約 15.10 GiB RAM；當時 available 約 13.65 GiB；root disk available 約 68.60 GiB | 每次 admission 必須重查；不是持續資源保證 |
| 既有工具 | Python 3.14.3、Git 2.53.0、bubblewrap 0.11.1、systemd 259.5 | 本地 package checksum 比對不等於獨立供應商 attestation |
| 缺少工具 | Claude、Grok、Node、socat 未在 PATH；使用者另確認未安裝 | 不以 PATH 檢查宣稱全機檔案不存在 |
| 最小隔離探針 | user／mount／PID／network namespaces 改變；零 capabilities、NoNewPrivs；只有 loopback；看不到 home／root；OS runtime 唯讀 | 未測真實 CLI、hooks／MCP、nested sandbox、允許與拒絕 egress |
| 資源探針 | 已準備 transient user service 與 double-fork／setsid 探針；本次 SSH 控制程序逾期未回傳，已依 PID／建立時間／腳本核對後停止 | **CPU／memory／pids enforcement、remote transient unit cleanup 未驗證**，不得作 readiness 依據 |

本次 preflight 是一次性診斷程式，保留在 task 的 `work`，不打包為 Hub worker。逾期診斷控制程序不得重用為正式控制通道。

### 2026-10-14 後續證據（保留上表的原始量測狀態）

- `linux-worker-resource-ssh-preflight-v3-2026-10-13.json` 後續確認了縮小測試配額的 kernel 值、double-fork／setsid 子程序退出及 unit／cgroup 移除；這是獨立 resource primitive，尚非完整 R2 執行路徑。
- `ssh-vault-enroll-2026-10-14T14-51-10-218Z.json` 與 `ssh-vault-check-2026-10-14T14-51-29-363Z.json` 確認已核准 Windows 認證管理員保存及兩次免提示新連線。此授權與保管方式由 `2026-10-14-ssh-password-vault-design.md` 補充 §5 的初始每次詢問方式；不涉及 SSH key 或全域設定。
- `linux-cli-private-stage-2026-10-14T14-51-52-819Z-7de0eb9e.json` 確認六個固定檔案與 receipt 完成 private stage、SSH exit 0；`providerReady=false`、`binariesExecuted=false`、`providerAuthRead=false`、`modelsInvoked=false`。原 R2／C1／C2 門檻仍未通過。

## 3. 固定 CLI 與依賴

| 元件 | 候選與檢查 | 部署規則 |
|---|---|---|
| Claude | 2.1.295 linux-x64；官方 GPG manifest 簽章與公布 fingerprint 吻合；binary SHA-256 `4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358` | 私有、版本化唯讀 binary；禁自更新；第一條指令前套外部隔離 |
| Grok | 1.0.50 linux-x86_64；兩個官方 HTTPS 分發入口內容一致；SHA-256 `c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5` | 私有、版本化唯讀 binary；`--no-auto-update`；**未取得獨立發行者簽章或 source-build 對應證明** |
| socat | Claude 官方 Linux shell sandbox 需要 bubblewrap＋socat | 從 Ubuntu 官方 signed repository metadata 鎖定版本／deb digest；user 私有解包，不執行 maintainer scripts，不改系統 apt sources／PATH |
| Node | Claude native 不呼叫外部 Node；本次 Grok ELF 沒有 interpreter／DT_NEEDED | 不列為兩個 native CLI 的初始依賴；MCP 若指定 Node server，另列精確 runtime／程式／來源並驗收 |

Claude ELF interpreter 為 `/lib64/ld-linux-x86-64.so.2`，列出 glibc 相關 libraries，最高觀測需求 GLIBC_2.17；Grok 本次 ELF 未列動態依賴。這是靜態 metadata，不證明任意執行路徑或 optional dependencies 均相容。

Grok 的下載一致性只支持已觀測 bytes／官方分發路徑，不當作簽章、可重現建置或安全結論。使用者審閱此補充時可選擇先完成 Claude、暫緩 Grok；若兩者繼續，Grok 證據限制持續顯示於 deployment manifest／驗收報告。套件撤回、版本／來源改變需重驗及更新 manifest。

若 socat 或其必要 library 無法從 signed Ubuntu metadata 建立固定來源／完整依賴，該步驟拒絕；不私自加 repository、sudo 安裝、compiler 或 npm。第三方 license／notices 隨私有 deployment manifest 保存。

官方依據：[Claude setup](https://code.claude.com/docs/en/setup)、[Claude sandbox](https://code.claude.com/docs/en/sandboxing)、[Grok source](https://github.com/xai-org/grok-build)、[Grok installer](https://x.ai/cli/install.sh)。不執行供應商 `curl | shell` installer。

## 4. 私有部署範圍

Linux 以 SSH 帳號的已核對 home 解析 `~/.local/share/project-hub-worker/`，部署前固定 held-FD root identity、owner／mode、manifest 和 free space。根或子物件已存在而無本產品所有權證據時拒絕覆寫。

- `releases/<content-id>/`：Python supervisor／固定 sandbox／broker 程式、CLI、已核對 socat；發布後對 run 唯讀。
- `profiles/claude/`、`profiles/grok/`：互不掛入對方 run 的專用登入／session；不複製 Windows auth。可信設定與可變登入資料分開。
- `state/`：run intents、leases、boot／process／cgroup identities、回收紀錄；CLI 無法讀寫。
- `staging/`、`results/`：controller create-only 存取，固定長度／digest／quota；既有產物不覆寫。

不新增 Windows Hyper-V、LocalSystem service、guest 映像、全域 Linux CLI link 或開機 daemon。首批離線執行只允許新 profile、合成檔案及固定 `--version`／`--help`／protocol probes。登入與模型測試另有確切目的地、內容、額度及時間窗，沿用原計畫的逐 provider 核准。

## 5. SSH 通道、身分與停止

Windows owner controller 啟動一條既有 OpenSSH stdio 連線；固定 target 登錄、已核對 host key、user、port 及 private remote worker entrypoint。`StrictHostKeyChecking=yes`、禁自動更新 host key、禁 agent／X11／任意 port forwarding、禁 local command。私有 known_hosts 不改使用者全域設定。

初期每次 worker 連線由既有遮蔽 askpass 視窗登入，控制程式不讀取／保存密碼。持久 SSH key／agent delegation 不屬於本補充預設；若操作頻率需要它，先提出 key 的範圍、forced command、撤回與保管方式。

SSH 提供 transport authentication／加密，不替代 run permit、whole-process sandbox 或 supervisor 身分核對。Windows 比對固定 worker code SHA、Linux boot ID、UID、run nonce、supervisor／unit invocation／PID start identities。CLI 不取得 SSH 控制 FD／socket、user systemd bus 或管理檔案。

應用通道只接受版本化 typed frame，max frame 1 MiB；bind run／sequence／nonce／permit，拒絕 malformed／duplicate／out-of-order／過期／未知 operation。Upload／download 只使用 manifest 所允許 root-relative objects，不接受 arbitrary shell／absolute path／owner approval／全域更新 RPC。每個 blob 另有固定總量／exact bytes SHA。

連線斷線、Windows Hub crash、Linux reboot 或 deadline 立即撤 run egress／tools；remote supervisor 與 systemd 各自有期限，不能只靠 Windows SSH child 是否退出。Stop 僅針對確認擁有的 unit／cgroup；驗 populated=0／退出，再清秘密和回收。失聯／身分未知保留 lease=`unknown`，恢復連線後核對再收尾；不關機、重開機或終止整台 Linux。

本次診斷已發現只等待 Node child `close` 不能作可靠 deadline。正式 controller 必須 deadline 自行終結請求並記錄 remote unknown，且以 owned process containment／worker deadline 處理實際退出；stdio EOF 或計時經過不能當 cleanup 成功。

## 6. Whole-process、網路與持久資料

外部 bubblewrap 在 CLI 首條指令前生效：user／mount／PID／IPC／UTS／network namespaces、capabilities drop、NoNewPrivs、readonly root／精確 runtime、私有 proc／dev，僅所選 task 與 provider profile。實際 CLI 的 file tools、shell、hooks、MCP、plugins／Git helpers 及 descendants 全部在同一邊界。

Worker 存在既有網卡；不能套用原計畫「無 vNIC」推論。CLI net namespace 不接該 NIC。可信 per-run relay 只轉此次核准的 HTTPS destinations，保留供應商 TLS 驗證；每次 connect 重新驗證 hostname、DNS、IP、port、expiry，拒絕 LAN／loopback／link-local／未允許目的地，精確核准的 namespace 內 proxy 例外另行固定。登入／軟體 bootstrap grant 與模型 run grant 分開。不監看加密 HTTP 內容，不承諾允許 tunnel 內的 path／內容 DLP。

Relay 掛載與 FD 不連接 supervisor 管理通道；CLI 忽略 proxy、redirect 到新 host、Unix socket／其他 interface 繞過、MCP 新目的地均須拒絕並可量測。Claude 自身 sandbox、Grok Landlock 是加強層，未涵蓋全 CLI 的範圍繼續由外部邊界承擔。nested sandbox／socat 相容性未過不得關掉邊界取成功。

不將 persistent ext4 profiles／task root 直接可寫掛入 CLI。初始 run 用有上限的私有 tmpfs：task 2 GiB、provider home 256 MiB、tmp 512 MiB；input 超限明確拒絕，不截斷。可信 controller 於執行前持有 root FDs 並綁 boot／mount／inode 身分，在 owned tree 全退出後依已核對 FD 回收內容，collector 單獨驗 length／type／names／digest／總額。tmpfs／held-FD 回收與 memory accounting 必須實測，不以設計視為已可用。

Profile 設定／hooks／plugins／MCP code 只由可信 manifest 明列並唯讀供應；可變 auth/session 不得承載下次自動執行設定。回收前後皆驗配置，異動需 owner 審閱，不熱載入擴權。單 CLI 同程序可讀自身 provider auth 的殘餘風險必須實測並呈現；唯讀 auth 不宣稱對同程序 file tools 保密。

## 7. 資源及成果契約

初始值：最多一個活動 run；memory 6 GiB、swap 0、CPUQuota 150%（上限約 1.5 logical CPU）、TasksMax 256、單 run 30 分鐘。Synthetic model probes 沿原計畫更短的逐回合／總時間上限。admission 要求 Linux available memory 至少 10 GiB、disk available 至少 20 GiB；private persistent deployment／profiles／staging／results 總額 8 GiB，事前預留最壞回收及 journal 額度；監測其他主機程序導致的餘裕下降，不宣稱能限制其他程式消耗磁碟。

systemd cgroup controllers 必須核對實際 kernel limits 及 descendants 退出。sandbox 看不到 writable cgroup、manager bus 或遷移管道。OOM、tmpfs full、CPU／pids／wall timeout 及 Stop race 均回 failure／partial；未知清理保留 lease／資料。不能因 user manager bus 存在就宣稱 cgroup enforcement 成功。

Guest task Git 與 Windows `.git` 分離；copy-in 不帶 Windows worktree 的指標／auth。回收以最新 host HEAD、Root/FileID、SHA 重新檢查，再走既有 reviewed merge；拒 symlink／hardlink／特殊檔、Windows 保留字、case／Unicode 碰撞、ADS、出 root 與控制資料。既有 direct 功能走明示 host broker，不能 live mount Windows 專案。SecretSupply 維持原 10 分鐘 TTL、baseline／held-FD 身分、清理前後檢查與 unknown recovery 契約。

## 8. 驗收及交付順序

1. R0 差異確認：本補充及相應 execution manifest；固定工具、來源、目標、paths、rollback，不把版本候選當已安裝。
2. R1：修正 bounded SSH controller；重跑 resource／owned process／斷線／unit identity 探針；signed socat metadata／依賴核對；私有 staged 部署與 exact digest。不登入、不送模型。
3. R2：typed channel／replay拒絕、tmpfs／profiles／FD／秘密、隔離 egress 與繞過、所有 descendants／cancel／Hub crash／Linux reboot、Git／非 Git／圖片／host broker 回收與 quota failures。
4. C1：Claude 固定版 offline version／help／stream-json／逐次 permission；後續正常官方登入與精確 synthetic model 批次。完整原 M 矩陣方可 ready。
5. C2：Grok 固定版 offline version／help／ACP／逐次 permission；另行 provider 登入／模型批次，同樣全 M 矩陣。
6. D1：同步 Schema／tests／操作文件／license／固定版 deployment manifest，重新封裝並安裝 Windows Hub；驗兩個入口實際成功與拒絕流程，保留 Codex／manual Chat 回歸證據。

任何階段失敗只保留相應未就緒狀態與具體原因；不可改 registry 的 hardcoded ready 取代 runtime identity／protocol／isolation evidence。更新為 staged activation，不改 run 中 binary；回復固定 code／policy，但不覆寫／刪除 provider auth 或使用者成果。

## 9. 審閱邊界

請審閱：採指定 Linux／SSH、user 私有 native binaries 與 signed Ubuntu socat；Grok 未簽章的供應來源限制；新的 tmpfs／資源額度與未知停止處理。此審閱只更新既有架構方向，不授權讀取密碼／Windows auth、第三方傳輸私人專案、sudo／全域系統變更或模型呼叫。

核准後由目前 Codex 在同一聊天／分支更新既有 implementation plan 的 R0–R2 差異，再按照既有已核准執行方式推進。具體 runtime manifest 與新增範圍若超過本補充，先呈現差異；登入／模型批次仍在送出前列明 exact provider、目的地、合成內容與額度限制。
