# Windows 網頁 Chat 安裝批次

本批次沿用 Windows 原生 Codex，新增 ChatGPT Chat 與 Claude Chat 的人工交接。兩個網頁入口不使用模型 API；使用者在固定官方網站自行登入、貼上、送出，再把回答貼回 Hub。Hub 不判定回答確實來自哪個網站或模型。

| 入口 | 本批次能力 | 執行狀態 |
|---|---|---|
| Codex | 保留既有對話、ConPTY 終端機、工作區審批與 Hub 流程 | 原生路徑；本批次執行合成回歸，不代表新的真模型驗收 |
| ChatGPT Chat | 獨立預覽、確認、複製、貼回保存、狀態及復原 | 人工交接 |
| Claude Chat | 獨立預覽、確認、複製、貼回保存、狀態及復原 | 人工交接 |
| Claude CLI | 精確身分、角色及設定保留；Windows 執行入口拒絕 | 隔離與 adapter 待驗證 |
| Agy CLI | 精確身分、角色及設定保留；Windows 執行入口拒絕 | 隔離與 adapter 待驗證 |
| Grok CLI | 精確身分及設定；Windows 執行入口拒絕 | 隔離與 adapter 待驗證 |

Grok Bot 的獨立合成程式測試不能替代本機 Hub、Windows CLI 或隔離驗收。這個套件不安裝 VM、Windows 系統功能或另外三個 CLI，也不改動它們的登入資料。

## 使用與語言

作業頁有兩個「手動交接」按鈕，也可從對話或快速開始選擇 ChatGPT Chat／Claude Chat。預設台灣繁體中文，日文選項沿用。完整文字、來源及截斷在確認前可檢查；複製失敗時保留預覽供手動複製，保存失敗保留回答及收據供明確重試／復原。

貼回的回答在會話中標示「使用者貼上／來源未驗證」。作業記事的每一行加引用前綴，避免 Markdown 標題、核取步驟或 frontmatter 變更作業解析結果。原始回答保留於會話及 private blob。此操作不自動完成作業、變更原 owner 或啟動 Codex。

## 安裝與資料相容

使用版本化 `windows/install-windows.ps1`，新版本槽 create-only；舊版本、原作業、角色與登入資料保留。精確 source commit、套件及 manifest 摘要、測試紀錄與本機啟動結果由本次交付報告提供。

首次建立網頁預覽或新網頁作業會建立 `web-manual-v2` 的 DataRoot 格式標記。058 舊版本不支援此格式；新管理入口會拒絕讓舊版本寫入新 Root。Rollback 是版本指標切換，不是資料降版；需要返回舊版時，要使用另行核對並核准的相容資料副本，保留新版資料。

未完成已接受交易時，一般啟動及切換版本拒絕。同一精確版本提供 `-Action Start -RecoveryOnly`，只查詢／復原持久已接受的交易。未知 orphan、破損 metadata 或原子暫存檔僅供只讀檢視，不自動採用或刪除。查詢清單提供每頁 100 筆及上一頁／下一頁；啟動時紀錄數量不冒充目前未完成數量。

## 驗證與限制

測試分為 controller／UI 合成 fixture、真 loopback HTTP、真 NTFS 檔案交易、來源／套件與安裝驗收。故障注入不等於實際斷電、磁碟耗盡或完整防竄改；FileID／SHA／本機 journal 不是可信簽章或外部 attestation。網頁手動傳送與模型回答須由使用者完成，沒有自動發送或第三方帳號連通的保證。

詳細契約、限制、資料 Schema 與復原流程見 [WEB-CHAT.md](WEB-CHAT.md) 及 [WEB-CHAT-ADMISSION.md](WEB-CHAT-ADMISSION.md)。
