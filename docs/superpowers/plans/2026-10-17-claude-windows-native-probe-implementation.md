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

## 4. 本批實際狀態

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
