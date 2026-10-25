# Windows 測試狀態

適用於 Windows 移植分支（基底 v4.68.2）。數字來自 2026-10-24 至 25 在同一台 Windows 11 Pro x64 上的兩次完整執行；沒有 Windows CI。

## 執行方式

從 `hub/` 執行，一律 `--test-concurrency=1`（`npm run test:serial`）。並行執行會讓原生 helper 編譯、檔案鎖與程序生命週期測試互相干擾，產生假失敗。

測試分成兩條 lane 依序跑：

- **重型 lane（19 檔）**：會啟動模擬 Hub、跑真實 Git 或編譯原生 helper 的檔案：`reviewed-workspace*`、`windows-merge-api`、`windows-warm-lease-http`、`app-ui`、`start`、`hub`、`native-installer`、`capability-auth`、保溫與聊天紀錄排除相關測試等。
- **輕型 lane（216 檔）**：其餘全部。

不自動執行的測試（會開視窗或啟動真實 Hub，要有人看管）：`browser-login-native*`、`browser-login-launcher*`、`launcher*`、`hub-e2e*`、`browser-login-hub-e2e.test.js`、`windows-launcher.test.js`。另有 `native-installer-state-contract.test.js` 裡「a dead launcher pid is archived」一案會探測固定的 4545 埠，在有真實 Hub 的機器上要以 `--test-skip-pattern` 跳過。

## 最近兩次完整執行

| 執行 | 重型 lane | 輕型 lane | 備註 |
|---|---|---|---|
| A（2026-10-24，開發機） | 405 項：383 通過、19 失敗、3 跳過 | 2379 項：2321 通過、16 失敗、42 跳過 | 重型 19 項失敗中 9 項是 hub.test.js 既有失敗、其餘為當時尚未套用的修正；輕型 16 項＝14 項既有＋2 項重跑即通過的不穩定測試（`managed-pty` ConPTY 崩潰案、`task-integrate` 一案的暫存檔 EPERM） |
| B（2026-10-24～25，獨立執行器，同一台機器） | 406 項：400 通過、3 失敗、3 跳過 | 2379 項：2314 通過、23 失敗、42 跳過 | 重型 3 項失敗＝hub.test.js 379／1104／1117；輕型 23 項＝14 項既有＋9 項環境造成（執行期間機器上有一個使用者手動開啟、未歸屬任何專案的 Grok CLI，程序監看依設計回 `PROCWATCH_UNASSIGNED_AI`，使 `legacy-integration-http`×6、`native-mcp-registration-http`×2、`unread`×1 的整合／交接路由回 409） |

| C（2026-10-25，本分支正規化為 LF 之後，同一執行器） | 414 項：408 通過、3 失敗、3 跳過 | 2379 項：2314 通過、23 失敗、42 跳過 | 失敗項目與執行 B 完全相同：換行正規化沒有改變任何結果 |

執行 B、C 中 hub.test.js 的 554 與其連鎖失敗沒有重現，支持它是測試框架的競態而非產品問題。

## 既有失敗（14 項）

| # | 測試檔 | 測試 | 判定 |
|---|---|---|---|
| 1 | `guidance.test.js` | 停止が必要な時の場所とボタンは実画面の切替とAI欄に一致する | 過期測試：比對的 UI 原始碼片段已改版 |
| 2 | `instruction-run.test.js` | 実行からmetaを保存し5番ごと・圧縮後・失敗後・全文変更時に復元、usageも保存 | Windows 拒絕未經原生授權的 Claude（「此 CLI 的執行與隔離尚未驗證，未啟動」），舊 fixture 取不到預期輸出 |
| 3–8 | `limit-integration.test.js` | 旧direct/preflight印の{no-evidence, unknown-reset, restored, save-failed, expired, confirmed}境界も共通の証拠判定だけで開始 | 同上 |
| 9 | `limit-integration.test.js` | 失敗した事前交代の再開は期限を再判定し、旧user行の印でAstraを選ばない | 同上 |
| 10–11 | `limit-integration.test.js` | 事前Astra起動失敗を修復後、{expired, manual-clear}でFableへ再送しても正式上限で1回交代する | 同上 |
| 12 | `web-chat-admission.test.js` | actual delivered 058 package has no web data capability and refuses the new Root at the managed gate | 需要實際交付的 058 套件，來源樹沒有 |
| 13–14 | `native-provider-message-contract.test.js` | messageFor(GROK／CLAUDE_NATIVE_WALL_TIMEOUT) is the spec sentence plus the code suffix | 過期測試：仍預期 4 分鐘回合上限，現行為 30 分鐘 |

沒有為了讓這些轉綠而修改斷言或產品的拒絕規則。

## `hub.test.js` 的既有失敗（最多 9 項）

| 行號 | 測試 | 判定 |
|---|---|---|
| 379 | 作業画面: 本物の端末を開き、入力と出力が通る | 過期測試：Windows 只允許 Codex 終端機，測試仍嘗試開 Claude 終端機 |
| 554 | 本体に取り込む | 測試框架競態：測試與 Hub 同行程，同步 Git 超過 6 秒時舊的 keep-alive 連線被重置（Node 24）；執行 B 未重現 |
| 689／921／989／1139／1180 | 版本、專案完成、關閉守衛、子作業移交、direct 工作區 | 554 失敗後留下終端機 session 造成的連鎖；執行 B 未重現 |
| 1104 | ChatGPT：貼る文に作業の中身を入れ | Windows 不適用：舊的 ChatGPT 貼上入口要求先預覽再確認 |
| 1117 | 空の作業を片付ける | 依賴 1104 寫入的對話，連鎖失敗 |

## 真機驗收（非自動測試）

在同一台機器上以安裝版實際操作過：安裝與回滾（候選 08 → 15）、Codex／Claude Code／Grok 的對話與續接、保溫 lease 的重入、FFmpeg 指標自動重綁。Codex 0.164.0 的沙箱實機驗收尚未完成；其他機器、其他 Windows 版本與所有 provider 工具版本都未驗證。
