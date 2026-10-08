# 原生整理與復原

Windows HTTP 入口使用 `NativeMaintenance`。POSIX 的同步介面與舊紀錄仍保留；Windows 寫入採 async 原生 FileID 搬移。

- `/api/maintenance/preview` 核對舊的一時檔、Git 追蹤及引用，於使用者確認前建立每個來源／目標根目錄、FileID、整體內容 SHA-256 與 journal 的原生計畫。
- `/api/maintenance/apply` 僅接受私有一次 ticket 內的選取 ID、明確確認與未到期的 wall／monotonic 時計。引用或內容改變需重做預覽。
- 移動前保存控制紀錄；原生 helper 保存 planned／complete／partial 收據。控制紀錄寫入失敗不回報完成。history 根據原生收據重新核對；部分變更保留待人工處理。
- `/api/maintenance/restore/preview` 先顯示確切移動與 FileID。`/api/maintenance/restore` 需要此一次 ticket；來源、目標或紀錄改變即拒絕。同名目標不覆蓋。
- 舊紀錄先備份於私有 journal。使用者重新確認現有退避檔的內容與 FileID，才增量加上 native baseline；這不能證明歷史原始 FileID。未搬出的既有來源留在原位。

候選沿用原產品範圍：一時物 7 日、過去版／已完成對話 30 日；原資料、成果物、台帳與 Git 留存。引用掃描不完整、Git metadata 損壞、連結／ADS／硬連結及不可確認的背景程序均拒絕。

原生目錄 rename 無法與整棵內容雜湊形成單一原子交易；共享 mmap 或其他程序變更可能造成 partial。檔案、內容與本機收據不能當作不可變更儲存或外部 attestation。資源上限與 recovery 狀態見 `ROOTED-MOVE.md`。

驗證使用 `node --test --test-force-exit test/native-maintenance.test.js`。目前有 real NTFS 搬移／復原、過期／改內容／替換 FileID／目標碰撞拒絕、控制 journal 故障與 legacy 恢復案例；控制 journal 故障為明示注入，不能當作真實磁碟損壞實測。

2026-10-08 的 post-audit 合成 NTFS 測試 9/9 通過，包含偽造 historical flags／reverse proof 拒絕、chat 根目錄搬移且 task metadata 保留、Hub 控制來源拒絕與 mixed legacy 恢復。介面已顯示清理及還原的完整 from/to、FileID 和 tree hash；預覽錯誤會保留原畫面並顯示原因。此紀錄不代表真實使用者資料已清理，也不是完整 Hub 安裝驗收。
