# 一次性 R2 唯讀診斷實作計畫

依已核准的 [診斷規格](../specs/2026-10-15-r2-readonly-diagnostic-design.md)，在目前聊天由主代理與分工代理實作、驗證及執行。既有 v2 source list、broker/catalog、正式登錄不可修改。

1. 新增 `hub/worker/r2_inspect.py`，封閉 typed request、10 個既定 JSON 檔案的 FD 讀取與 sanitizer、exact unit show、已驗證 cgroup 讀值。既有模組只讀重用；禁止 controller main、cleanup、create、刪除或 service 控制。新增 Python fixture 測試缺失、破損、換置、超量與拒絕輸入。
2. 新增 `hub/lib/worker-r2-inspect-bootstrap.js`，固定 source bundle、bounded loader、code/payload/catalog digests；無 caller source/command。驗證 digest 拒絕與 loader 邊界。
3. 新增獨立 `hub/windows/ssh-r2-diagnostic-*.cs`，編入本次固定 trust capsule；既有共用/native transport/pinned-root 原始碼只讀編譯。獨立 v2 admission 驗 manifest/journal/tomb/receipt/activation/pointer/run、code/root/ACL、一次 grant 消耗，再精確讀單筆 credential，以 owned Job/private ASKPASS 執行固定 payload。
4. 新增 `hub/lib/ssh-r2-diagnostic.js`，非秘密 grant/build/request 與 output validator；新增封閉 schemas、合成 examples、runbook。task-private operator 只提供固定 evidence/manifest references，不能取得密碼或自由改 command。
5. 在 synthetic targets/loopback 跑 native 成功與重要拒絕案例，精確查證 credential bytes/metadata 未變、其他 synthetic credential保留、沒有未授權 SSH；跑 Node contract/bootstrap 與指定 Python discovery。與 frozen v2 manifest 的原 bytes/hash 比較，證明原程式及登錄未被新 build 改寫。
6. 固定通過驗證的 source/build/capsule/grant，僅執行一次正式診斷，記錄 bounded closed output 與 native close。拒絕或失敗不自動重試。保留原 unknown lease與歷史 cleanup unknown，依讀到的證據回報實際根因及下一步。

正式執行前必須完成第 5 步；測試通過不是 Linux readiness。成功診斷只表示有效證據已取得，不表示 R2 通過、已清理或 Claude/Grok 可用。
