# Claude Windows W0 離線探針執行批次

日期：2026-10-17（Asia/Taipei）。使用者已審閱並核准 `2026-10-17-claude-windows-native-probe-design.md`，回覆「同意，實作並驗證此離線探針」。沿既有已核准的 Codex 直接編排計畫與同聊天執行方式，將該差異落成下列批次；不重新要求相同範圍的授權。

## 1. 固定範圍

只執行可信 C# fixture，每個 attempt 最多一個目前使用者的 LPAC profile、空 capabilities、新合成根 ACL／Low IL 與 owned Job。profile／CLI 角色不能混用；不接產品 provider registry、不讀 auth、不啟動 vendor CLI、不呼叫模型、不連 SSH、不變更全域規則或 OS 功能。

## 2. 實作與順序

1. **P0：離線編譯與拒絕路徑。** 新增 `hub/windows/claude-lpac-probe.cs` controller、`claude-lpac-fixture.cs` 固定測試程式，以及相應文件、closed request/result schema 與測試。無參數／describe 不建立 profile；只有明確的 W0 operation 可執行。controller 與 fixture 必須先編譯、審查來源與 SHA，才進 P1。
2. **P1：每個 attempt 的單一 profile 與首指令 gate。** create-only durable intent 記錄名稱、nonce、owner／預期 SID、根身分及預期不存在，每個 attempt 單次 CreateAppContainerProfile。固定 fixture、runtime pin、私有 ACL、空能力／LPAC、env allowlist、明列 HANDLE、Job 限制必須先設定。suspended child 的 token SID／LPAC／IL／capabilities／Job 由 controller 獨立查驗後才 resume。CLR／啟動不相容即停止該次嘗試，後續必測項為 not-measured。
3. **P2：同 profile 固定 cases。** 依規格 §5 執行檔案／正對照、主程序及後代 loopback、三層後代／breakaway／broker、Stop／EOF、各資源與輸出上限。每 case 新 Job；建立前預留最壞程序預算。所有測試清單在首次執行前固定；不得把首 gate 成功當完整 W0。
4. **P3：靜態身分與收尾。** 固定 Claude 只讀檔案身分／manifest／bytes／完整 SHA。先確認 owned Job 空，再撤本次 listener／對照／新 profile，核對精確 profile folder 與 registry storage 消失，最後撤 owned temp。所有權或結果未知時保留證據，不廣泛刪除。
5. **P4：測試與報告。** 跑 codec、registry／拒絕／繁中 UI 回歸及必要 native 拒絕測試，執行使用者指定 Python discovery；保存命令、exit、來源／產物／log SHA、逐 case pass/fail/not-measured、bootstrap/cleanup 狀態及限制。只有獨立 combined W0 manifest 核對規格全部 required gates pass 才可記整體 `probePassed:true`；native response 維持 `probePassed:false`，不改寫原始證據；`providerReady:false` 固定。

## 3. 有界執行與失敗處理

沿規格：6 分鐘整批、12 次 controller case 根、32 次總成功起始、48 次總嘗試；每 case 8 程序／512 MiB／5 秒 CPU／20 秒 wall／各 64 KiB stdout/stderr。可信 fixture 合成寫入總額不超過 4 MiB；新 temp＋profile 128 MiB 是 admission／軟預算，不是磁碟硬配額。同一 attempt 不隱含重放；根因修正、前次相關資源清理已驗證後，可依規格 §9 接續新的獨立有界重測。不得加 capability、改普通 AppContainer 或 full-user。

若前置 gate 失敗，後續未執行不是安全拒絕，也不是不相容全 Windows 的證據。報告受測配置和具體錯誤，停止該次嘗試，再繼續根因定位及已授權修正；不能將單次失敗當成整體工作的停點。完整 Claude 後端、模型出口、provider profile、磁碟硬限制、live protocol 與安裝回復仍須原計畫 gates，不能由本批替代。

## 4. 原 run-01 的實際狀態（歷史）

P0 已編譯並驗證拒絕路徑；P1 單次 profile 建立後在 fixture 啟動前因 `ACL_VERIFY_FAILED` 停止，P2 的 12 個 native cases 均未量測。P3 的精確 profile folder 已消失，但 registry 身分未先捕捉，收尾仍 unknown；獨立靜態 Claude nlink=2 亦不符條件。P4 已保存原始失敗與 combined manifest，整體 `probePassed:false / providerReady:false`。

事後修正 ACL 的 AI bookkeeping 字串誤判，以及 registry path 必須含 AppSID 的未支持假設，並以 23 項收據、46 項 ACL、46 項 registry 純記憶體斷言及 Node 50／Python 70 回歸驗證。沒有建立第二個 profile、改寫原始結果或將修後離線測試當新實機結果。

## 5. 使用者要求接續後的獨立批次

使用者在進度回報後指出「為什麼你沒有繼續執行」，接續既有已核准流程。`run-02` 為新的獨立有界批次，保留 `run-01` 原始失敗及 unknown；沿同一 W0 範圍，每批最多一個 profile、6 分鐘。此次實際沒有再建 profile 重試、增權或執行 vendor／auth／模型；這是該批歷史紀錄，不是使用者禁止後續修正重測的要求。此次來源 `08cd0a7`，不是將舊 nonce 重放。

`run-02` 已越過 ACL／fixture 準備，並在 suspended fixture 下取得實際 registry storage 身分；完整 token gate 尚未通過，`TOKEN_SIZE_INVALID`，沒有 resume fixture。此次精確 profile folder／registry storage／owned temp 皆核對不存在、Job 空、收據 durable，`cleanupVerified:true`。此結果只證明新批次收尾，不回填舊批次的缺漏，也不是 LPAC 或 provider 通過。

後續在相同授權內並行進行純離線工作：定位 token API sizing 查詢的 class／原生錯誤（只查 owned current-process token、不建立 profile）、指定 Claude 檔案的持有式唯讀身分核對，以及固定官方來源的 Grok turn codec。沒有因 worker gate 未過就將純離線工作停掉；真 CLI spawn／登入／模型仍須既有執行門檻。

已實際再次呼叫 Claude CLI 審閱指定原碼快照；核對後修正 Grok 決議後識別欄位漂移、取消後新工具，以及共用 pin 的釋放後生命週期拒絕。其餘建議按固定來源與合約逐項記錄不採納理由。Claude 是靜態審閱，沒有替代本機測試或授權任何 gate 放寬；後續差異由本機回歸核對，未聲稱已獲 Claude 再次核可。

本批最終指定 Node 回歸 86/86、Python discovery 70/70，無 Node skip／cancel。原生合成測試、來源／產物／log SHA、Claude 原回覆與採納紀錄保存於外層 workspace 的 dated outputs。W0 必測 cases 仍未量測；P2、完整 provider 接線及安裝驗收仍未完成。

## 6. 限制來源更正

使用者本輪問「我什麼時候說不自動重跑」。核對結果：該句來自 Codex 撰寫的規格，不是使用者原話。後續按規格 §9 的修正／清理／有界重測規則接續，不再把它當成每次都要等待使用者催促的理由。歷史實測收據及一次性 R2 grant 的消耗語意不改寫。

## 7. Context Guard 接續批次

依設計規格 §10 更正首指令前 LPAC 證據，保留所有 SID／IL／capability／Job gates；先以固定 descriptor 的 OS AccessCheck 判定實際 child，再以 class 46 作有明確 unavailable 分類的交叉檢查。owner 負對照、API／mask／buffer 拒絕路徑與獨立本地審查須先完成，才可執行新 attempt。Claude 指定原碼審閱的外傳另受本次自動核准攔截，待精確資產授權；不得以改指令或間接執行繞過，也不將此攔截擴張為停止原已核准本地 W0 的理由。每批仍最多一個 profile、6 分鐘；不重放舊 nonce，不調高權限，不執行 vendor／模型。

並行完成 Grok 有界 turn controller（只組合 codec 及由上層提供的 owned stream），不新增 OS spawn 入口、不改 registry readiness。其合成 transport 測試必須與實際 vendor／backend 的驗收分開列示。此單元不證明初始化、認證、模型清單、整個 CLI 隔離或 Hub 接線完成。

依規格 §10.1，在 run-05 實際 token 陽性、CLR bootstrap 失敗及完整清理後，接續固定 child CLR 環境候選。先通過共同 environment block 的完整鍵值／排序／double-NUL／caller 污染拒絕測試，維持 193 項 token guards、220 項 AccessCheck guards；再重驗 run-05 的精確資源不存在，prepare-only 產生新 run-06 source／build／request 綁定，才執行既有有界 W0 wrapper。此變更不加入 log capture、新 capability 或全域系統修改。run-06 的 fixture bootstrap、合成 cases 與 cleanup 分別記錄，任何未量測維持未量測。

Claude transport controller 沿同一既有協定交付範圍接續：只接收上層已 admission 且專用的 stream endpoint，組合既有 closed codec、人工決定、期限、backpressure、stdout／stderr 結束與綁定 backend 的 owned cleanup 收據；不建立程序或任何新授權入口。不將 Grok 的 ACP wire 複製為 Claude 協定；出站 user message 須有固定官方 SDK 來源對照。owner cancel 撤回該 controller 的可操作核准並停止精確 owned run；不假造 vendor cancel ack。result 與 root exit／子樹清空／cleanup 分開，task success 保持未知。合成 tests、Schema、文件與正式 Hub/provider 接線分開驗收。

run-06 仍在 CLR bootstrap 停止但精確收尾成立，依規格 §10.2 為下一 attempt 增加僅 Identity child 的有界 activation log。候選來源已凍結，host 窄測 2/2、collector 61／環境 102／token 193／AccessCheck 220 項守衛及獨立本地 review 已完成；先重驗 run-06 資源不存在，再 prepare-only run-07，執行仍沿同一 wrapper 與原 W0 預算。parent 讀診斷須驗 canonical Base64、decoded byte count 與 SHA，相符才可解讀；沒有 log 仍為診斷缺漏，不能補成已知根因。

run-07 已執行並獨立 reconcile：實際 token 陽性、5538-byte CLR log 綁定一致、精確清理成立；CLR runtime 已載入但握手未成功，仍有 13 項 not-measured。細節及不可推論事項見規格 §10.3。下一個執行候選須有具體新根因／診斷目的與相稱測試，不能只更換 nonce。兩個 provider 的 pure turn controllers 分別通過合成測試，不變更 readiness，也尚未安裝新 CLI 功能。
