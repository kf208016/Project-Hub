# SSH 免重輸維護與固定 R2：實作計畫

依據：已於 2026-10-15 核准的 `../specs/2026-10-14-ssh-vault-maintenance-design.md`。使用者核准依目前聊天方式執行；不重新要求相同方案核准。此環境沒有 writing-plans skill，依已核准方式在本聊天維護此計畫。

## 執行順序

1. 保留 frozen 五個 native sources、既有 descriptor、receipt 與 broker bytes；記錄正式登錄原 SHA，先不取用正式 credential。
2. 獨立新增 native maintenance／destination broker，沿用已審閱的 transport 與 pinned-root primitives。封閉 manifest、目的 metadata、pending receipt、activation pointer、create-only journal；只有固定管理／R2 operation。

   Windows 實測顯示原目錄 pin 阻擋 child rename。指標專用末層改為持有 NT handle、允許 write sharing 但禁止 delete sharing；祖先與來源／目的登錄維持原 pin。既有指標以持 handle 驗 bytes、create-only 移至固定 backup，再 no-replace 發布新指標，保留未知資料及中斷恢復；不宣稱單檔切換原子性。
3. 完成 native-only copy、雙 fresh process validation capability、鎖交接、exact activation／retirement及同 ID recovery。不允許普通 destination 操作越過 pending gate；期限或未知狀態拒絕。
4. 獨立新增固定 R2 Python supervisor 與 bootstrap catalog。使用現有純 policy；驗 boot／UID、runtime identity、namespace、核心配額與完整子程序收尾。只執行合成程式，無 provider、無模型；不因 gate 失敗縮減限制。
5. 增加 JS 非秘密 build／manifest／controller glue、封閉 Schema、範例與文件。編譯兩個明確 native entry，catalog bytes 固定於 build manifest；命令或 source 不由呼叫者自由提供。
6. 使用全新 synthetic targets 與 localhost SSH 驗正常／拒絕／fault recovery；每個 persistence 邊界中斷、兩筆共存、exact ownership、重放／期限／其他 target 保留。任何未驗證狀態不能進入正式遷移。
7. 獨立原始碼審閱，執行相關 Node/native tests 與使用者指定 Python discovery，保留真實結果。外層工具沙箱不相容時只在相同測試已授權的正常 Windows 環境重跑，不削弱斷言。
8. 固定正式 source/destination/helper/broker/catalog manifest，確認原 host/account/pin/SID/UID；執行一次正式遷移、兩次新程序 probe、切換後精確退役及 status 驗證。失敗進入具證據的同 ID 恢復，不重開密碼視窗。
9. 經新通道執行固定 R2 合成驗收；保存成功與拒絕結果。隔離、生命週期、CLI/provider 與安裝各別判定；本批不將 staging 或 pure policy 當 provider readiness。

## 分工與檔案邊界

- Native：新增 `hub/windows/ssh-maintenance-*.cs`、native fixture；不修改 frozen source files。
- R2：新增 `hub/worker/r2_*.py`、對應 Python tests、獨立 `hub/lib/worker-r2-bootstrap.js`；不修改 stage loader 或 private-stage bytes。
- Controller／整合：新增 JS maintenance build／controller、Schema/example、task-private operator與驗證報告。
- Review：另由唯讀審閱者檢查信任與狀態機，再由執行者修正；不以審閱代替實際測試。

## 完成證據

按階段明列 source commit、build/catalog SHA、測試數、真實遷移結果、兩次 UID probe、來源退役，以及 Linux gate 結果。公開產品檔案不嵌入真實目標、帳號、SID、TargetName 或密碼相關資料。只有最後各步實際成功才標記完成；未知保留 unknown 與可恢復狀態。
