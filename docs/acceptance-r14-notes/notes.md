# R14 真機驗收筆記（進行中）

## 2026-10-25 13:17 §七 #5 已釐清：1.0.70 改寫的 models_cache.json 仍可被 Hub 解析
- 1.0.70 CLI 一啟動（盲測派工）就改寫 `~/.grok/models_cache.json`（9267→9617 bytes）。
- 頂層鍵：fetched_at, renewed_at, grok_version, auth_method, origin, identity, etag, models（新增 fetched_at／renewed_at／grok_version／origin；只看鍵名，未讀值）。
- models 仍為物件，每項 `{info, api_key, env_key, api_base_url}`，info 含 id／name／hidden／supports_reasoning_effort／reasoning_efforts，與 R9 fixture 形狀相同。
- 用 Hub 自己的 `grokModels()`（ai-tools.js:135）解析：4 個模型 grok-4.7、grok-4.7-build-fast（R9 時期 id 為 grok-4.7-fast，標籤同為 Grok 4.7 Fast）、grok-4.6、grok-4.5；efforts 正常。Hub 模型選單預期正常。
- 待真機驗收時再確認 Hub 介面實際顯示。

## 2026-10-25 15:20 離線驗收結果
- 驗收樹 `dispatch14\work\accept`（Codex c14 + Grok 盲測 + 4 項修正）；44 檔 747 題：741 pass、6 fail。
- 6 fail 皆為候選 15 既有：`r2-native-messages.blind.test.js` 2 題（R8 把 WALL_TIMEOUT 文案改成 30 分鐘，舊盲測仍釘 4 分鐘；在未改動的 g14 同樣失敗）；`hub.test.js` 4 題。
- `hub.test.js` 同環境對照：未改動候選 15 失敗 9 題（與 Cursor 候選 15 回歸的 9 題一致），驗收樹失敗 4 題，其中 3 題在基線內；1 題「取り込み対象から外す・戻す」不在基線內，錯誤是 `fetch failed: ECONNRESET`（HTTP 連線被重設，harness 競態，與 R14 改動無關的型態）。待 Cursor heavy lane 的 hub.test.js 第二次結果判定是否為偶發。
- 候選 16：commit d4d6c0554a55，套件 4.68.2-windows-codex-d4d6c0554a55（650 檔，manifest f3bf06804cfa…），verify_package 全部通過。

## 2026-10-25 16:06 Cursor 回歸 heavy lane（19 檔）
- 406 題：394 pass、9 fail、3 skip。9 題失敗全部來自 `hub.test.js`，名稱集合與「今天同環境跑未改動候選 15」的 9 題完全相同（與 10-24 Cursor 跑候選 15 時的 3 題不同，差異是環境日間狀態，不是 R14）。
- 先前驗收樹單跑出現的「取り込み対象から外す・戻す」ECONNRESET 在本次未再出現 → 偶發競態。

## 2026-10-25 16:41–17:40 Cursor 回歸 light lane 無效＋C: 槽滿事件
- light lane（222 檔）在 16:05–16:41 跑完時 C: 已滿，`full_light.txt` 196 KB 無總結行 → 結果無效，需重跑。
- 根因：diff 審查工作流程驗證代理的 `perl -ne 'BEGIN{$/=undef} $_=<>; …'` 無限迴圈，背景輸出 `tasks\bryiavm7g.output` 寫到 92 GB；代理 TaskStop 未殺掉 perl.exe（PID 80320，14:50 啟動），17:3x 手動 Stop-Process 後停止增長。檔案已刪但句柄仍被 Claude 主程式持有，需重啟桌面程式釋放。
- 已清掉：第 11／12 輪過期工作副本、cursor-cli 的 c15／fork 副本、c14 樹（報告與 .r14 證據搬到 `dispatch14\codex-evidence\`）、g14 樹（盲測已在 accept 與候選 16）、舊回合的工作流程紀錄。C: 剩約 330 MB。
- 候選 16 套件在事件前已建好並驗證（`verify_package` 全過）。
