# 一次性本機瀏覽器登入

2026-10-20／21：使用者核准採用一次性核准登入，避免 owner token 進入網址或瀏覽器程序參數。**原始碼已完整接線並通過測試；尚未封裝、尚未安裝，已安裝的 Hub 仍是舊版。** 安裝版的畫面與模型驗收另行進行，這份文件不代表安裝版已可用。

## 流程

1. 啟動器開**乾淨網址** `http://127.0.0.1:<port>/`（不含 fragment、token 或查詢），並以獨立的隱藏 PowerShell 程序啟動「Project Hub 本機登入確認」視窗，只傳公開的 `-DataRoot` 與 `-Port`。`-NoBrowser`、`HUB_NO_BROWSER=1`、`-Stop`、`-Restart` 都不開瀏覽器也不開視窗。
2. 網頁（`public/local-auth.js`）先查 `GET /api/state`：200 直接進入；401 顯示登入層。按「產生一次性登入代碼」呼叫 `POST /api/local/browser/begin`，取得 32 碼公開代碼與 HttpOnly 的待核准 cookie。
3. 使用者把代碼貼進原生確認視窗並按「核准登入」。視窗核對執行中的 Hub，再以只存在記憶體的 owner token 登入並核准該代碼。
4. 網頁每 0.5 秒呼叫 `poll`；核准後取得既有的 owner session cookie，**只能取一次**，隨後重新載入。

復原模式（`HUB_RECOVERY_ONLY=1`）使用同一組三條路由，並額外提供 `GET /local-auth.js`；復原頁（`web-chat-recovery.html`）改為等待 `hubAuthReady`，不再處理舊的 `#auth=` fragment。

## 元件

| 元件 | 檔案 | 說明 |
|---|---|---|
| 狀態機 | `lib/browser-login.js` | 最多 8 筆、60 秒、單次核准與消耗；時鐘無效或倒退撤銷待核准狀態 |
| HTTP handler | `lib/browser-login-http.js` | 只處理三條 POST 路由；`readBody` 須回傳已解析的 JSON |
| 請求體讀取器 | `lib/small-json-body.js` | 上限 1024 位元組、嚴格 UTF-8；超量時銷毀串流（客戶端看到連線被重設，不是 400） |
| 伺服器接線 | `server.js`、`lib/web-chat-recovery-server.js`、`lib/web-chat-admission.js` | 掛在 `/api/` 的 401 閘門之前；埠號不在 1024 到 65535 時不建立；復原模式在第一次請求時以實際埠號建立 |
| 登入畫面 | `public/local-auth.js` | `window.hubAuthReady` Promise；登入層、複製鈕、焦點循環；舊 `#auth=` 連結只會被拒絕 |
| 啟動器 | `start-windows.ps1` | 乾淨網址；`ConvertTo-WindowsArgument` 依 `CommandLineToArgvW` 規則加引號 |
| 原生核准視窗 | `windows/browser-login-approve.ps1` | 見下節 |

Handler 的要求：begin 與 poll 需精確的 Host／Origin、`X-Hub: 1`、loopback、無 Bearer 與轉送標頭；approve 必須先通過既有 owner cookie 才讀 body，可不帶 Origin，若帶則須等於 `http://<Host>`。**只檢查 Hub 自己的 cookie 名稱**（`hub_local_session`、`hub_local_pending_<port>`）：瀏覽器的 cookie 不隔離埠號，127.0.0.1 上其他程式留下的重複或超大 cookie 不會擋住登入；Hub 自己的 cookie 重複則視為不明確而拒絕。穿隧請求（`Tailscale-User-Login`、`X-Forwarded-*`）在一般與復原模式都被拒絕。

## 原生核准視窗

Windows PowerShell 5.1。參數 `-DataRoot`、`-Port`，以及可省略的 `-RequestId`。省略時開啟視窗，讓使用者貼上代碼（只容忍大小寫、空白與連字號，最後仍須剛好 32 個小寫 hex）；給定 `-RequestId` 時不開視窗，必須是剛好 32 個小寫 hex。

**它不會啟動、停止或重啟任何服務。** 故意不 dot-source `start-windows.ps1`：該 launcher 找不到執行中實例時會自行啟動新服務並搶 `desktop-launch.lock`。控制器改為獨立唯讀，只複製 launcher 已有的 DPAPI entropy、HMAC 證明與 16384 位元組 state 上限，並由測試比對兩邊常數一致。

檢查順序，任何一步失敗都在 owner 憑證離開記憶體前停止：

1. DataRoot、hubDir、port 與 state 精確相符（區分大小寫，與 launcher 相同）；路徑經 `safe-path` 檢查；state 為有上限的一般檔，開檔期間以 `FileShare.Read` 持有。
2. state 內 PID、建立時間與 `node.exe` 路徑相符，且連接埠上**每一個** listener 都屬於該 PID 並綁在 `127.0.0.1`。
3. 以 DPAPI（CurrentUser）解開憑證，須剛好 43 個 `[A-Za-z0-9_-]`。
4. 先打 `GET /api/local/proof` 並以固定時間比較 HMAC，**通過後才**送出憑證；送出前再核對一次程序與 listener。
5. `POST /api/local/login`（憑證只在 JSON body），嚴格比對回傳的 session cookie 格式（恰好一個），再以它 `POST /api/local/browser/approve` 核准該代碼。

輸出為單行固定 JSON，失敗只帶固定原因碼，不含憑證、cookie 或例外文字。

**隱藏啟動時視窗要看得見。** 以 `-WindowStyle Hidden` 啟動的程序會把「隱藏」旗標套到它的**第一次** `ShowWindow` 呼叫，確認視窗因此整個消失。控制器在建立視窗前，先對自己的主控台呼叫一次 `ShowWindow(…, 0)` 消耗掉該旗標，且**只在這個程序獨佔主控台時**才做（`GetConsoleProcessList` 回傳 1），使用者自己從終端機手動執行時不會被藏起來。P/Invoke 以 `Reflection.Emit` 在記憶體內定義，**不使用 `Add-Type`**：後者經 csc.exe 編譯並寫入 `%TEMP%`，TEMP 含非 ANSI 字元或不可寫時會失敗，隱藏的子程序就會沒有視窗。

## 已知限制

- **同一使用者的非互動模式**：`-RequestId` 讓同一 Windows 使用者的程序不必人工操作即可核准一個公開代碼。這不增加權限（同一使用者本來就能 DPAPI 解開 state 內的憑證），但表示「人工核准」只約束瀏覽器那一側。模型子程序是否也能使用，取決於 Hub 對 DataRoot 的 sandbox 限制；這一點本次沒有另外驗證。
- 啟動器每次開瀏覽器都會開確認視窗，即使瀏覽器的 session 仍有效；視窗 3 分鐘後自動關閉。
- cookie 不隔離埠號；待核准 cookie 名稱帶埠號只是避免覆寫。
- 未登入即可呼叫 begin，任何本機程序都能佔滿 8 個待核准名額 60 秒（只造成拒絕服務，無法取得權限）。
- 登入畫面只在載入時探測一次 session；視窗開著時 Hub 以新 token 重啟，需重新整理頁面。
- 一個分頁產生新代碼會覆蓋另一個分頁的待核准 cookie。
- 啟動器不檢查隱藏的確認程序是否還活著；若該程序無法啟動（例如被群組原則擋下 `-ExecutionPolicy`），網頁仍會提示貼到一個不存在的視窗，可手動執行 `windows\browser-login-approve.ps1 -DataRoot <根目錄> -Port <埠號>`。

## 測試

| 檔案 | 內容 |
|---|---|
| `browser-login-core/clock/http.test.js` | 狀態機與 handler（含其他應用程式 cookie 不阻擋登入） |
| `browser-login-native.test.js` | 控制器對合成 Hub：成功與各種拒絕路徑、原生視窗（用 Win32 訊息操作）、TEMP 含非 ANSI 字元時視窗仍出現。**會開真實視窗** |
| `browser-login-server.test.js` | 真實 `server.js` 與復原伺服器的路由、guard、`/local-auth.js`、請求體上限、穿隧標頭 |
| `browser-login-launcher.test.js` | 啟動器靜態結構、引號函式、隱藏啟動的視窗、共用主控台不被隱藏。**會開真實視窗** |
| `browser-login-ui.test.js` | 登入畫面（假 DOM），含復原頁 |
| `browser-login-pages.test.js` | 各頁面確實載入並等待 `local-auth.js` |
| `browser-login-hub-e2e.test.js` | 真實 launcher、真實 Hub、控制器非互動模式的完整流程（一般模式；復原模式需資料格式標記，另在行程內測試） |

涉及 `safe-path` 的整合測試必須在**位於系統磁碟（C:）**的原始碼樹執行：`lib/local-drives.js` 要求磁碟分類輔助程式與編譯器都在系統磁碟，否則回報「Local drive classification is unavailable」。專案放在 D: 時請把 `hub` 同步到 C: 的副本再執行（不含 `node_modules`、`.runtime`）；既有的 `windows-launcher.test.js` 在 D: 也會因此失敗，不是回歸。

## 尚未完成

封裝新候選與安裝、安裝版的真實畫面點擊、Claude／Grok 在安裝版上的自主執行與續接驗收。這些需要使用者另外核准。