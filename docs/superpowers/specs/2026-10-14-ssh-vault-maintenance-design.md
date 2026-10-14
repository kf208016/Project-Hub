# Project Hub：SSH 密碼登錄維護與固定 R2 通道

日期：2026-10-14（Asia/Taipei）

狀態：**使用者於 2026-10-15 核准依目前聊天方式實作、測試、正式遷移及固定 R2 合成驗證。** 核准時尚未實作或對正式認證執行；實際結果另存驗證報告。本文件不表示已有遷移能力，也不表示 Claude／Grok 已就緒。

## 1. 目的與現有界線

使用者要求繼續 Claude／Grok 整合，並明確要求不要反覆輸入 SSH 密碼。既有 Linux 補充已涵蓋私有 worker、隔離及離線驗收；本補充只處理如何讓保存的 SSH 認證供**經審閱的新 native broker 與固定 R2 合成通道**使用。

目前正式登錄的完整 descriptor 同時綁定 host、port、user、host key、Windows SID、private root identity、SSH binary、broker binary 與固定 private-stage command。舊 broker 沒有 maintenance／migration 介面。舊 bootstrap 另固定 stdin 壓縮程式及解壓程式的長度、SHA；不可沿用舊 command 換成新的 stdin 程式。

現有規格要求 source／root／pin 改變時拒絕取用，不能自動重新綁定。增加新可信程式會改變能取用此筆認證的程式集合，必須明確審閱此差異；原 R2 及 provider 驗收門檻保持適用。

### 選擇

| 方式 | 取捨 | 決定 |
|---|---|---|
| 重新錄入密碼 | 流程簡單，但違反本次免重輸的目的 | 不採用 |
| 修改舊 descriptor／放寬 code hash／借 stage stdin 執行新程式 | 破壞原 binding，無法誠實延續既有驗證 | 拒絕 |
| 明確 native 遷移，建立獨立新登錄，驗證後切換及退役舊筆 | 需維護有限狀態與 crash recovery；可保留原證據及免重輸 | 已核准方案 |

## 2. 本批範圍

允許設計的操作：

- 在同一台 Windows、同一 SID，從一筆已核對的產品來源登錄遷移至一筆全新產品目的登錄。
- 新建 owner-only 目的 root、descriptor、receipt、非秘密 migration evidence；不改來源 immutable descriptor／registration receipt／舊 broker bytes。
- 在原指定 SSH 主機、帳號及 host pin 執行固定 identity probes，接著執行已審閱的固定 R2 合成驗證。
- 經新登錄驗證及明確切換後，精確移除來源 credential，寫入相容的退役 tomb，查證來源不可再自動登入。

不含 provider 登入、模型呼叫、sudo、全域設定、持久 SSH key、其他主機或帳號、真實專案傳輸、任意 shell、通用密碼匯出／匯入、讀取或枚舉其他 vault 項目。首次 R2 通道只允許合成程式及私有測試資料；不因本補充讓 CLI 直接以 SSH 使用者權限執行。

實際目標、帳號、descriptor、binary、root 及 manifest 都以 **task 私有檔案 references** 保存。公開規格、產品範例與套件不嵌入真實位址、帳號、TargetName 或本機 SID。

## 3. 元件與信任

### 3.1 保留來源，另建目的

來源登錄繼續使用原 frozen broker；目的登錄使用新的版本化 broker 與新 registration ID、private root、TargetName。兩個 root 都須通過 NTFS identity pin、owner-only ACL、單一 owner SID、非 reparse／非 hardlink 及 bounded path 檢查。目錄名稱不同不等於身分已確認。

遷移程式是獨立的 native entry。一般 `probe`／`run-fixed` 不得順便遷移；缺 receipt、code 不符、認證拒絕不能觸發遷移、CredUI 或 key fallback。JavaScript／PowerShell 只提供非秘密 references 與接收固定狀態事件。

新 native code 要經人工原始碼審閱、固定 source/build manifest、編譯產物 SHA 檢查、合成 credential 與 loopback SSH 測試。**SHA 是身分與改動偵測，並非發行者簽章、可信建置 attestation 或抵抗同 SID 惡意程式的保證。** 不以「新程式自己宣告舊 hash」取得取用權。

### 3.2 明確授權清單

一次核對的封閉 migration manifest 至少包含：

- `schemaVersion`、隨機 `migrationId`、有效起訖時間、固定 operation 與本次審閱記錄 reference。
- 來源 descriptor SHA／canonical binding、registration ID、exact target、root identity、receipt bytes SHA、已登錄 UID、已核對舊 broker 路徑與 SHA。
- 目的 descriptor SHA／canonical binding、全新 registration ID／exact target／root identity、新 broker 路徑與 SHA、版本化 receipt 格式。
- 不變的 host／port／user／完整 host key／fingerprint／SID／SSH binary 路徑及 SHA；來源與目的必須完全一致。
- 遷移 helper 本身的 source/build reference 與 exact binary SHA；兩個 broker、SSH 及 helper 的 bytes 都須持有開啟 handle 再驗證。
- 新固定 command catalog 的 ID／SHA、R2 operation ID、payload 長度／SHA、允許的資料 objects／總量／deadline；沒有自由文字 command 或任意 executable 參數。
- task active-registration pointer 的 pinned root、固定相對路徑、預期舊內容或已證明的不存在狀態，以及預定新內容 SHA。

manifest 使用 canonical encoding、精確欄位與型別，拒絕重複／未知欄位、超限、替代 path、不同 SID／pin／UID、來源等於目的、重用目的 target 或已消耗的 migration ID。審閱的是 manifest 的實際內容與新程式；不可只審一個未解析的 hash。

### 3.3 秘密與同步

遷移 helper 先取本次獨佔 transaction lock，再按固定 root 排序取得來源與目的的 registration locks；採不等待的獨佔取得，busy 即失敗並釋放已取 locks，搬移前必須全部取得。來源舊 broker 使用相同來源 lock，搬移及目的驗證期間持續保留此鎖。目的新 broker 的驗證程序自行取目的 registration lock，因此啟動它之前 helper 必須釋放目的鎖；不能持同一鎖等待子程序。未知活動程序或未收束 operation 時拒絕，不能依程序名稱批次終止。

目的 receipt 初始為 `pending-migration`，普通 probe／run 一律拒絕。只有 migration helper 透過 owner-only native pipe 發給精確新 broker 程序的一次 validation capability 可執行固定 probe；綁 migration ID、manifest SHA、probe ordinal／nonce、PID／建立時間／binary／SID 及 30 秒期限，供應前驗 native peer、同 owned Job 與 helper 持有的 transaction lock。capability 不經公開 HTTP／Node 任意參數、不寫入 log，不能用於 run 或一般認證取用。驗證完成後重新取得目的鎖並重驗，才可切換。獨立 activation receipt 與 exact 新 pointer 均成立後才解除 pending；不覆寫原目的 receipt。每次普通 probe／run 均須在目的 registration lock 內重新讀驗這兩項，不快取或永久提升 active 狀態；pointer 回復至舊登錄、缺失或不符時，目的普通模式立即拒絕。唯讀 status 可回報這些狀態，但不得連線。

密碼只由 native 精確讀來源 target、保留 byte buffer、精確寫入目的 target並 native readback 比較；所有退出路徑清零與釋放。不得輸出密碼或密碼 hash，不經 Node／PS、argv、env、檔案、console、clipboard、一般 pipe 或 journal。SSH 仍使用既有 owned Job／private ASKPASS pipe／peer 身分／一次 nonce。

Windows Generic credentials 仍屬同 SID 信任域。產品 lock 不能讓 `CredWrite` 成為 OS 級 create-only，也不能鎖住其他同 SID 程式的 credential writes。本設計不宣稱跨不合作程式的 compare-and-swap；偵測到異動即停止，不把異動內容覆寫或刪掉。

## 4. Durable intent 與精確 ownership

目的 root 準備好、雙方鎖及全部檢查通過後，先用 create-only 寫入 migration intent、manifest snapshot、預期 pointer 狀態與來源 receipt reference，flush、關閉並重新開啟驗證。**這一步成功前禁止 CredWrite。**

每個狀態證據使用遞增序號、前筆 digest、migration ID、manifest SHA、固定 event、必要的非秘密 exact identities。create-only 寫入並重新讀驗；不可回寫舊事件。DPAPI 可綁同一使用者的 receipt，仍不是防篡改儲存、WORM 或外部 attestation。檔案 flush 不代表所有硬體／斷電情境都已驗證耐久。

目的 credential 使用明確的新 metadata 格式，除了 exact product target／user／persist／comment，還包含非秘密 migration ID、manifest SHA 及目的 binding。新 store 驗 exact metadata；舊 store 不放寬成接受此格式。這些欄位用來精確識別本次項目，不包含秘密、密碼 hash 或可執行內容。

建立前須精確確認目的 target 不存在，寫入後立即 native readback 檢查 metadata 及 bytes。若目的 target 已存在，**不論看似相同與否，都不得再 CredWrite**；進入同 ID recovery。credential metadata 及 intent 不能單獨證明所有權，還要匹配目的 root／descriptor／receipt 狀態，且來源尚存在時以 native byte 比較確認內容一致。

精確刪除僅允許：持有鎖、符合本次 manifest 的 exact target、metadata 及可證明的預期內容，且刪除對象是狀態機允許清理的筆。未知既有 target、metadata／內容改變、來源缺失而無足夠完成證據時，回報 `recovery-required`，不能猜測刪除。不存在與存取失敗必須分開。

## 5. 執行順序與啟用

1. **Prepare**：驗 manifest、有效期、全部 native code／root／SID／host pin／receipt／pointer、來源 active 且未 forgotten；先用 frozen broker 做固定來源 probe，這時 helper 不持 registration lock。建立目的 owner-only root；固定 references 後取 transaction lock 及雙方 registration locks，重新核對來源 receipt／UID，不把事前 probe 當鎖內檢查的替代品。
2. **Intent**：確認目的 credential／receipt／tomb 不存在；先持久化意圖與已核對的不存在狀態。寫入失敗停止。
3. **Copy**：native 讀來源、驗 metadata、建立目的 credential、readback 比較，再 create-only 寫 `pending-migration` 目的 receipt。receipt 綁 migration、目的 binding、來源 UID；重新開啟驗證後才回報 `destination-stored`。
4. **Validate**：只釋放目的 registration lock，保留 transaction／來源鎖；對兩個獨立新 broker 程序分別發一次 validation capability，讓它們各自取得目的鎖並做固定 nonce／UID probe，不開 UI。每次均驗 SSH pin／binary／root／receipt／metadata，回傳 UID 必須等於來源已登錄 UID。任一失敗都不切換或刪來源；helper 退出亦使 capability 無效。
5. **Recheck**：兩個 probe 程序都確認收尾後，helper 重新取得目的鎖；重驗全部 identities、兩次 probe evidence、新舊 credential metadata 與 native bytes 相等、pointer 未異動。若失敗，釋放鎖後來源仍可用，目的保持 pending。
6. **Activate**：先記 activation intent，使用產品專用且已 pin 的 pointer 路徑切換至目的 descriptor／binding、重新開啟查證，再 create-only 寫 activation receipt並讀驗；兩者都符合才回報 `destination-active`。pointer 單檔 replace 語意須實測；不得稱作 Credential Manager 與檔案系統的原子交易。來源 credential 保留至本步成功。
7. **Retire source**：持久化來源退役意圖後，重新讀驗來源 metadata／bytes，再 exact CredDelete，exact CredRead 確認 NOT_FOUND；create-only 寫與 frozen broker 相容的 `forgotten.bin`，包含來源 binding／target／state。來源 descriptor、原 registration receipt、舊 executable 保留。已存在 tomb 必須完全符合本次來源，否則停止。
8. **Complete**：鎖內確認 pointer／目的 activation receipt／credential、來源 target 不存在及 tomb 有效；釋放雙方 registration locks、保留 transaction lock，再用 frozen broker 的唯讀 status 驗其明確拒絕，避免自己鎖住 status。各項證據齊全才記 `completed`。不再發起來源 SSH；來源 credential 缺失／tomb 即應在本機阻止登入。

新 broker 兩次 probe 成功只證明 SSH 認證與固定 UID；新 R2 執行、隔離、CLI、provider readiness 仍分別驗收。來源 credential 刪除只撤除本產品此筆保存，不改 Linux 密碼或其他登入方式。

## 6. 失敗及恢復狀態表

Credential Manager 與檔案系統無共同交易。本表是可恢復的多步程序，**不承諾 all-or-nothing、exactly-once 或原子兩筆切換**。

| 已確認狀態／中斷點 | 來源／目的狀態 | 允許的精確恢復 | 不可宣稱 |
|---|---|---|---|
| `prepared`，尚無 durable intent | 來源保留；目的 credential 未建立 | 核對本次 create-only 目錄，清理或重新準備 | 已開始認證遷移 |
| `intent-recorded`，尚未／不確定 CredWrite | 來源保留；目的可能不存在或 orphan | 先查 exact 目的；不存在才依同 ID 繼續；存在則驗 metadata／native equality，禁止覆寫 | 未看到 receipt 就代表未寫入 |
| `destination-stored`，probe 未完成 | 兩筆可能都存在；來源仍為 active pointer | 驗 receipt／identity 後補做尚未完成的固定 probe，或精確清理目的 | 新連線已可用 |
| `destination-validated`，切 pointer 前 | 兩筆存在；來源仍啟用 | 重驗 pointer／雙筆後明確切換；或保留來源、精確撤目的 | 來源已撤回 |
| `activation-intent`，pointer／activation receipt 結果未知 | pointer 可能是舊／新／不完整，目的仍可能 pending | 讀 pinned pointer；exact 舊則不退役來源；exact 新且完整驗證證據成立才補 activation receipt；二者都通過才續退役；其他 bytes 停止 | timeout 等於未切換或新筆已 active |
| `destination-active`，來源未刪 | 新筆啟用；兩筆仍存在 | 在同 manifest 下精確續做來源退役，或明確回復 pointer 至舊且再驗 | 已完全遷移／舊權限已撤除 |
| `source-delete-intent`，刪除結果未知 | 來源可能存在或已不存在 | exact 讀驗；仍為預期舊筆才刪，NOT_FOUND 才補 tomb；不符則停止 | 已撤回或可安全覆寫 |
| 來源已不存在，tomb／終態未完成 | 目的已驗證；來源不能自動登入 | 查證新筆／pointer，再補 exact tomb 與完成證據 | 已完成全部收尾 |
| `completed` | pointer 指新；舊 target 不在；tomb 有效 | 同 ID 查詢只回現況，無 CredWrite／SSH／切換；固定新通道依自己的 permit 執行 | 再次套用遷移有必要 |
| 任一步 identity／metadata／內容異動 | ownership 或結果不確定 | `recovery-required`，保存非秘密 evidence；禁止修改／刪除未知物件 | clean rollback／安全完成 |

### Pointer 回復與舊筆退役後

- pointer 切換失敗且仍是 exact 舊值：來源保持可用，目的不自動重寫。恢復可續切換或撤除已證明屬本次的目的。
- pointer 指新但來源退役失敗：保持已驗證的新筆，報告 `destination-active / source-retirement-pending`；不可把來源刪除失敗當新認證失效而要求重輸。
- 來源已刪除後 pointer 遺失／損壞：不自動回落舊 descriptor。核對 durable manifest、目的 receipt／credential 後，僅恢復同一目的 pointer；未知變更需明確恢復決策。
- 來源已退役後要求回復舊版本：需另一筆明確 native reverse migration，不能只移除 tomb、改 pointer 或悄悄重建來源 credential。本批不自動執行反向遷移。
- 任何時點都不刪來源 immutable receipt 或覆寫使用者 provider auth、成果及非本次物件。

## 7. 重放、恢復與期限

`migrationId` 與 immutable manifest SHA 一對一綁定，來源與目的 roots 的 create-only 意圖共同記錄它。不同 manifest 重用同 ID、不同 ID 指相同目的、跳序、重複終態 mutation、completed 後再次 copy 均拒絕。取得同 ID 的既有記錄只能進入 `status` 或明確 `resume`，不能當成全新請求。

`resume` 先依實際 credential／receipt／pointer 判讀狀態，再執行唯一允許的下一步；不得只相信最後一條 log。native mutation 驗 transaction 及雙方 registration locks；validation probe 按 §3.3 的鎖交接與 capability 執行。所有步驟重驗 exact identities、bytes 及有效期。原授權期過後只可唯讀判讀；繼續寫入、刪除或 SSH 需明確 recovery grant，綁同一 migration ID、原 manifest SHA、已觀測狀態及新短期限，不能擴大目標／程式／command。

每次 SSH probe 使用新 nonce，期限 30 秒；migration controller 有獨立總期限及停止記錄。停止、controller crash 或期限屆滿不自動重試、不開密碼視窗；未確認的 native／remote 收尾誠實標示 unknown。durable evidence／nonce／序號不抵抗同 SID 攻擊者刪檔或回復整個目錄；不將此稱為硬體 anti-rollback。

## 8. 新固定 R2 通道與後續維護

目的 broker 的第一版只提供一種執行 operation：固定 `run-r2-synthetic-v1`。另外保留唯讀 `status`、固定 identity `probe`、具一次 capability 的 migration validation 三種受限管理模式；管理模式不能變成執行入口。broker code 內固定 command catalog SHA；manifest 選擇精確 operation ID，不能提供原始 shell、路徑、Python source、任意 argv、stdin program 或替代 digest。初次 R2 code／payload 的 exact bytes 經本次審閱與測試後納入 catalog。

單次 run manifest 可重用同一已驗證 catalog，而不每次改 vault binding；它只帶 nonce／sequence／有效期、固定合成 case ID、明列的 quota／deadline、exact payload SHA 和 create-only artifact IDs。只允許 catalog 內的合成 case 與有界數值，不允許模板字串插入 command。payload 長度／SHA 不符、未知 case、額外 path 或超額時在執行新程式前拒絕。

遠端入口亦驗 exact worker bytes／boot ID／UID／private roots；R2 先驗 whole-process sandbox、resource limits 與 controlled cleanup，再執行合成程式。provider binary、auth、模型目的地和真實專案都不在首版 catalog。不得用合成 permit 變成通用 worker／CLI 執行授權。

新增 catalog operation、code／payload SHA、broker／SSH binary、host／SID／root 等超出目前 binding 的變更仍走明確維護審閱；不能以 manifest 可以填 hash 為理由允許任意新程式。可接受的長期成本是固定版本升級需測試與遷移；不在本批加入簽章更新服務、憑證代理或通用 RPC。

## 9. 實作與驗證要求

書面方案核准後才制定並落實 implementation plan。本批預期新增獨立 native migration entry、封閉 migration／destination receipt／pointer／run-manifest schemas、controller glue 與操作文件；不把新模式塞入 frozen broker 後原地取代已保存的來源。

在接觸正式 credential 前，使用全新產品 synthetic targets 驗證：

1. 正常 native-only copy、兩次新程序 probe、pointer 切換、來源退役與新筆可用；不開 CredUI、不讀現有使用者 credentials。
2. 每個 durable intent／CredWrite／receipt／probe／pointer replace／CredDelete／tomb 邊界的中斷及重啟；精確對照上表，不虛構全域交易。
3. 目的預先存在、來源缺失、錯 metadata／digest／SID／root／ACL／pin／UID、檔案換置、兩個 controller、錯序／重放／expired／異常 JSON 的拒絕；異常筆不得被覆寫或誤刪。
4. 空白／繁中／emoji 的 byte-preserving copy；秘密不進 controller／logs／artifact；所有正常與失敗 native buffers 收尾。
5. 來源 retired 後 frozen broker 本機拒絕；pointer 失敗／遺失恢復、雙筆並存與 orphan 狀態均有真實回報；其他 synthetic credential 保留。
6. 固定 R2 command／payload 錯 digest、未知 case、任意 source／shell 注入拒絕；loopback fixture 不等於 Linux R2 實測。

執行相關 Node／native tests，並跑使用者指定的 `$env:PYTHONPATH='src'; python -m unittest discover -s tests -v`。正式遷移、SSH probe、Linux R2、provider 功能與安裝各自保留證據，不合併為「Claude／Grok 已可用」。

## 10. 審閱決策

請審閱的具體差異是：信任一個經審閱及合成測試的新 native migration helper，以無 UI、無重輸密碼方式建立第二筆產品 credential；驗證後切換 task pointer、精確退役舊筆，並把新 broker 限制為固定 R2 合成通道。承認兩筆 credential 可能在部分失敗時同時存在，採精確恢復而不宣稱原子交易。

使用者於 2026-10-15 回覆「同意，實作並驗證此升級方案（建議）」。核准不等於實作／正式遷移已完成，也不授權 provider 登入、模型呼叫或任意命令。
