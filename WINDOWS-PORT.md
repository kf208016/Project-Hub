# Project Hub Windows 移植版

## 日本語の概要

このブランチは、kieiken 氏による Project Hub v4.68.2（MIT）を土台にした Windows 11 向けの移植版です。Windows 上で Codex・Claude Code・Grok の CLI を**隔離して**実行し、ブラウザーから操作します。上流の 4.125.x には独自の Windows ウィンドウ・自動更新・利用権の層がありますが、上流は Windows での隔離実行を「未対応」としています。この移植版はそれとは別系統で、上流の正式な Windows 対応ではありません。

主な追加点：

- 版ごとのインストール先（version slot）、manifest の SHA-256 照合、ロールバック。FFmpeg 依存の参照は選択中の版に自動で追従します。
- レビュー付き作業領域：プレビュー → 承認 → 準備。本体と作業コピーを FileID で固定し、ターンの間は最長 10 分だけリースを保温します。再入時は安全確認を毎回やり直し、変化があれば解放して再承認を求めます。
- ネイティブ実行基盤：Job オブジェクト、承認ゲート、通信先の制限、セッション結合、1 ターン 30 分・無入力 10 分の上限。Codex は審査済みの 0.154.0 と 0.164.0 だけを Hub 専用スロットで使います。
- 背景プロセスの監視（CIM による所有権の確認）、FileID を確認するネイティブの原子的ファイル書き込み、MCP 登録と scoped な資格情報、Web チャットへの手動引き継ぎ、リモート用ブラウザーログイン、繁体字中国語 UI（日本語に切替可）。

実機確認は Windows 11 Pro x64 の 1 台で行いました。テストの実行方法、既知の失敗 14 件（理由付き）、未実行の項目は [docs/testing-status-windows.md](docs/testing-status-windows.md) にあります。Windows CI はまだありません。

---

## 這是什麼

這是 **Project Hub v4.68.2 的 Windows 11 移植分支**。原作者是 kieiken，原始專案採 MIT 授權。此分支讓 Codex／Claude Code／Grok CLI 能在 Windows 上**隔離執行**，並以瀏覽器操作。

上游在 4.125.x 推出了自己的 Windows 視窗、自動更新與授權層，但註明「Windows 隔離執行尚未支援」。本分支是以 v4.68.2 為基底的獨立路線，不是上游的正式 Windows 支援，也沒有移植 4.125.x 的新功能。

## 新增內容

| 功能 | 說明 | 文件 |
|---|---|---|
| 版本槽安裝器 | manifest SHA-256 核對、`current/previous` 可回滾、不改全域 PATH 與 Codex 設定；FFmpeg 依賴指標跟著所選版本；在 MSIX 虛擬化行程內拒絕執行 | [INSTALL.md](hub/windows/INSTALL.md) |
| 受審工作區 | 預覽 → 核准 → 準備；本體與工作複本以 FileID 釘住；回合之間保留 lease 最多 10 分鐘，重入時所有安全檢查重跑一次，任何變化就釋放並要求重新核准 | [reviewed-workspace.md](hub/windows/reviewed-workspace.md) |
| 原生 provider runtime | Job object、核准閘、出口限制、session 綁定、回合上限（30 分鐘／閒置 10 分鐘）；Codex 只接受審閱過的 0.154.0／0.164.0，放在 Hub 私有槽 | [NATIVE-PROVIDER-INTEGRATION.md](hub/windows/NATIVE-PROVIDER-INTEGRATION.md)、[PROVIDER-RUNTIME.md](hub/windows/PROVIDER-RUNTIME.md)、[CHAT-CONTINUITY.md](hub/windows/CHAT-CONTINUITY.md) |
| 程序監看 | 用 CIM 掃描背景 AI 程序、依工作目錄歸屬到專案；有未歸屬的 AI 時拒絕送出 | [COMMANDS-FILES.md](hub/windows/COMMANDS-FILES.md)、[UPDATE-RESTART.md](hub/windows/UPDATE-RESTART.md) |
| 原子檔案 broker | 原生 HANDLE、root fingerprint、SHA-256 與 FileID 比對的寫入與搬移 | [ROOTED-MOVE.md](hub/windows/ROOTED-MOVE.md) |
| MCP 註冊與憑證 | 作用域憑證、DPAPI 保存 | [MCP-REGISTRATION.md](hub/windows/MCP-REGISTRATION.md) |
| Web 聊天手動交接 | 預覽、確認、貼回 | [WEB-CHAT.md](hub/windows/WEB-CHAT.md) |
| 遠端瀏覽器登入 | 遠端 HTTPS 入口的一次性登入 | [BROWSER-LOGIN.md](hub/windows/BROWSER-LOGIN.md) |
| 繁體中文介面 | 預設台灣繁體中文，可切換日文 | [LANGUAGE.md](hub/windows/LANGUAGE.md) |

## 安全模型（摘要）

- **同機不需登入。** 服務綁定 loopback，保留 Host／Origin／X-Hub 檢查，和上游一致。這不隔離同一台電腦上的其他程式。
- **遠端要通關密語與 TLS。** 遠端 HTTPS 預設關閉；MCP Bearer 不等於 owner 權限。
- **AI 子程序在 Job object 下執行並經核准閘。** 程序歸屬以 PID、建立時間與 CIM 證據判定，不確定時拒絕。Job object 管理生命週期，provider 自己的沙箱與出口政策另行生效；這不是完整的沙箱保證。
- **檔案寫入走原生 broker 並釘住 FileID。** 拒絕換檔、重解析點與未知狀態；跨檔案的寫入不保證整體原子性。
- **不自動更新全域環境。** 安裝與版本切換不改全域 CLI、PATH、防火牆或執行原則。
- **Codex 版本採允許清單。** 只接受 0.154.0／0.164.0 與各自精確的 binary／vendor 雜湊；0.164.0 的實機沙箱驗收尚未完成。

## 環境需求與安裝

Windows 11 x64、本機 NTFS、Node.js 22 以上（本分支以 24.15.0 驗證）、Git for Windows、Windows 內建 .NET Framework 的 `csc`，以及已登入的 Codex CLI 0.154.0 或 0.164.0。Claude Code／Grok 的前提見原生整合文件。

安裝步驟見 [hub/windows/INSTALL.md](hub/windows/INSTALL.md)：以審閱過的套件與 manifest SHA-256 操作，不要從原始碼樹直接啟動正式環境。

## 在 Windows 上跑測試

在 `hub/` 執行：

```
npm run test:serial
```

或 `node --test --test-concurrency=1 test/*.test.js`。一定要串行執行；並行會互相干擾原生 helper 與程序生命週期測試。會開視窗或啟動真實 Hub 的測試（`browser-login-native*`、`browser-login-launcher*`、`launcher*`、`hub-e2e*`、`windows-launcher.test.js`）要另外在有人看管時執行。執行結果、兩條 lane 的分法、14 項既有失敗與原因都在 [docs/testing-status-windows.md](docs/testing-status-windows.md)。

## 已知限制

- 第一次送出要完整準備工作區（約數十秒）；只有符合保溫條件的重入會縮到約 16 秒。
- GitHub 鎖定且 `.ai/tasks` 帳本被追蹤時，排隊中的訊息會停在完整來源檢查，要手動重送。
- Windows 上只開放 Codex 的互動終端機；Claude／Grok 走對話與 CLI 執行，不開終端機。
- ChatGPT 的手動貼上流程維持 v4.68.2 的方式。
- 尚無 Windows CI；實機結果目前只來自一台 Windows 11 Pro x64。
- 上游 4.125.x 的專用視窗、自動更新、授權與多帳號功能都不在此分支。

## 作者與授權

原作者：kieiken（[kieiken/project-hub](https://github.com/kieiken/project-hub)）。Windows 移植：kf208016，開發過程使用 Codex、Claude Code、Grok 與 Cursor 等 AI 工具協助，並經人工審閱與實機驗證。本分支沿用 [MIT 授權](LICENSE)。
