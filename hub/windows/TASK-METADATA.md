# 原生執行中的作業顯示資料

已由 controller 持有有效 private workspace flow 的作業，可在執行中使用
`POST /api/task` 更新 `state`、`question`、`memo`。此例外只接受
`project`、`task` 與上述三個欄位，全部必須是字串；至少提供一個更新欄位。
`task-display-request.schema.json` 描述此例外的輸入形狀，不取代停止狀態下
原有 `/api/task` 的完整介面。

```json
{"project":"p","task":"t","state":"返事待ち","question":"請確認此步驟","memo":"使用者補充"}
```

作業內部狀態識別值維持既有值；繁體中文介面由本地化層顯示。
移到「完成」仍須使用既有人工完成確認介面。

此例外不允許另一個 task，也不允許加入 model、owner、role、workdir、
parent、kind、derivedFrom、workspaceMode、refs 或額外欄位。
在移交／階層整合、pending merge、Maintenance 或其他持久交易期間，
原有的全域引用檢查與同 repo gate 繼續拒絕寫入。

controller 的同步寫入只會在當前 task hash 等於此 private run 已保存的
`approvedTaskHash` 時，沿 exact before→actual after 更新 ephemeral receipt，
最多 128 次；達上限時在寫入前拒絕。這些 receipt 不是 HTTP 輸入。
來源 `baseSnapshot` 與原人工核准的 hash 不會被顯示資料更新取代。
此信任邊界會另外讀取實際 task bytes 並用既有 Completion 的 CRLF
正規化 hash 比對，不把一般畫面快取的 mtime／size 當成 fresh hash。
寫入後實際 bytes 若與 Store 回傳不符，會明確回報已寫入但收據未綁定，
不回傳成功或補造 receipt。一般畫面快取維持原行為。

既有 lifecycle 寫入若使 hash 鏈失效，一般未被 GitHub 鎖定的顯示更新仍
維持原操作，但不採納目前 hash 為新的已核准證據。GitHub lock 期間若
缺少連續 receipt，會在寫入前拒絕，需停止並重新核准。

相同 workdir 且已有 workspaceStarted 的 queue／重啟動 admission 不再
重寫 task 的 updated 時間。只有必要的新 workdir／workspaceStarted
控制資料才寫入，仍須先通過上述 receipt gate。CLI 失敗後的 private
cleanup 保留佇列；使用者明確按停止仍會清除待執行佇列。

`native-task-metadata-http.test.js` 使用合成台帳與 Codex RPC、真本機
private lease 和 owned child 驗證成功與拒絕路徑。GitHub／交易 fault flags
只測 admission 分支，不代表實際 GitHub 發佈或工作程序交易。
