# Project Hub：Chat／CLI 開發與任務續接範圍修正

日期：2026-10-18（Asia/Taipei）。狀態：依使用者本次明確糾正更新產品範圍；本文件不是 Claude／Grok 已整合、已安裝或已通過實測的證明。

## 1. 產品用途與自主功能

使用者原話：「這是用chat、cli進行多模組開發，並無computer use功能，對話視窗接續任務作業。」

Project Hub 提供 Chat 與 CLI 的開發工作流程，支援多個模型／provider 參與同一專案的不同模組，並從對話視窗繼續既有任務。先前「Claude／Grok 也必須具備完整自主功能」繼續適用於已核准範圍內的程式開發工具、命令、已註冊 MCP 與委派；不延伸為滑鼠、鍵盤、螢幕擷取、桌面軟體操作或其他 computer use 產品能力。

Windows Hub、繁體中文、既有 Codex、Git 工作區與成果審查、人工網頁 Chat 交接、安裝與回復仍在範圍內。不得以停用 Claude／Grok 的開發工具、MCP 或委派，換取「完整整合」宣稱。

## 2. 對話續接的行為契約

1. **同一任務、同一 provider**：以 server 所保存的 project／task、actor、runtime/profile 與原生 session identity 續接；保留對話、模型設定、執行狀態及成果連結。識別不符或 session 不存在時明示原因，不假裝已恢復原生會話。
2. **切換 provider**：沿用 Hub 的任務 identity；不得把 Claude session ID 當成 Grok/Codex session ID。建立目標 provider 的原生 session，將已選取的需求、決策、完成內容、未完成工作與成果摘要作為有來源的交接內容。傳往新目的地須符合既有授權。
3. **多模組／委派**：子工作綁定父 task、provider、工作區與 run；結果回到原任務供後續對話續做。沿用互斥、隔離工作複本與人工合併，不讓不同執行者同時覆寫同一工作區。
4. **中斷與重啟**：區分 UI 重新連線、CLI 仍在執行、CLI 已退出、停止中與狀態未知。重新開啟對話不重送已接受的使用者訊息、不重跑已完成工具、不自動新建另一個任務。無法核對程序／成果時顯示未確認，保留待恢復資料。
5. **停止**：停止目前 run，撤除待核准操作並等待所屬程序樹退出；保留對話、任務和成果供下一次續接。停止不等於刪除任務、結束所有 provider 或宣告成果完成。
6. **網頁 Chat**：ChatGPT／Claude Chat 繼續採既有人工預覽、複製、開站及貼回。Hub 保存任務交接關聯，並標示人工提供的結果；不讀取 cookie、不擷取外站對話、不自動操作網頁、不自動送出，也不新增模型 API key。

## 3. 工程與資安範圍

仍須處理：Chat／CLI 原生協定、雙向工具核准、session/resume、queue、transcript、模型／用量、已註冊 MCP、委派、工作區限制、憑證與 owner 身分分離、程序樹停止、成果合併及安裝回復。

不新增：desktop agent、畫面辨識、滑鼠鍵盤控制、Windows UI 自動化、瀏覽器登入／發訊息自動化、GUI 自動化專屬的桌面或隔離服務。開啟 Hub 視窗、顯示內嵌終端或由使用者操作 UI，均不因此成為 computer use 功能。

Linux 主機不是本產品的必要條件。執行環境必須根據上述開發功能與已承諾的安全邊界選擇；新增帳號、服務、防火牆規則、系統功能或虛擬機仍須先提供精確必要性與影響。Claude 的架構建議不是人類核准，也不是該邊界已驗證的證據。

CLI 能改檔和執行命令，仍可能誤刪、越界讀寫、載入不可信 hooks/MCP 或外傳資料；移除 computer use 產品需求不會消除此類風險。沿用已揭露的 Codex 邊界與既有授權要求，不以 permission prompt 或 Job object 冒稱完整 OS 隔離，不靜默削弱既有保護。

## 4. 交付順序與驗收

1. 先完成 Chat／CLI 到原生 session 的正式接線與同任務續接，沿用現有 provider codecs/controllers；不再以新增 LPAC／CLR／PEB 探針作關鍵路徑。
2. 驗證 Claude 與 Grok 各自的真實開發回合：讀取合成專案、產生改檔、執行該專案測試，並在相同對話續接下一則指示；不把文字回覆當成工具執行成功。
3. 驗證跨 provider 交接仍是同一 Hub task，session 不混用、成果可回溯；驗證已註冊 MCP 與子工作回報；不假造未安裝 provider 的結果。
4. 驗證拒絕越界、過期／重放核准、取消、Stop、斷線與重啟後不重複執行，以及 unknown 狀態保留。
5. 同步程式、Schema、文件、範例及版本套件，再做本機安裝／回復與已安裝版本的可用流程驗收。來源、模組離線測試、安裝版與 live 功能分別報告。

截至本修正，既有 Claude／Grok readiness gates 保留。沒有以修改本文件啟用 CLI 或改動系統設定。

功能、安全控制與實際驗收的逐項對照見 [完整自主開發與資安清單](../../../hub/windows/AUTONOMY-SECURITY-CHECKLIST.md)。此對照整理既有範圍，不是新增隔離研發工作或已驗收聲明。
