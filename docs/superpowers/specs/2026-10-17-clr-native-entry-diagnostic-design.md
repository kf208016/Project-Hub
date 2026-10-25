# Windows CLR native-entry 診斷候選

日期：2026-10-17。狀態：離線準備與本地審查；尚未核可或執行新的 LPAC runtime 配置，沒有取代 W0 測項或啟用 provider。

## 目的與必要性

W0 run-07 已有真實 LPAC token、CLR DLL loading 與精確清理證據，但 fixture 握手未成功。activation log 未提供初始化的 HRESULT。單純加 config、重換 nonce 或增加 capability 沒有足夠根因依據。需要從 native entry 呼叫公開 hosting API，分開觀察載入與初始化。

目前未找到 native C/C++ 工具鏈。先用既有 Codex bundled CPython 的 ctypes 做可信診斷候選；這會增加測試工具 runtime 的依賴與維護面，因此不靜默替換 C# fixture。診斷須使用已審閱的 Python 執行檔（以下以 `<reviewed-python>` 表示），本次實際核對為 CPython 3.12.14、Windows AMD64。PATH 上其他 Python 不繼承此身分。

## 固定流程

- 預設與 describe 不啟 CLR；僅明確診斷 flag 加有界、嚴格 stdin request 才可執行。
- 只按固定順序呼叫 `CLRCreateInstance → ICLRMetaHost.GetRuntime(v4.0.30319) → ICLRRuntimeInfo.GetInterface(public ICLRRuntimeHost) → Start`，成功啟動後呼叫 Stop 並釋放取得的 COM interfaces。
- 每一步回固定 stage、32-bit HRESULT 與分類，不輸出指標、任意 exception、環境、檔案內容或登入資料。不使用 internal GUID／未公開 vtable，不接任意 CLSID／runtime／assembly／method 或 DLL 路徑。
- 用 System32-only DLL search 載入 mscoree，不讀 ambient profiler／startup hook 或 user site。執行時由上層建立乾淨 allowlist 環境。
- 不執行 managed assembly、provider、模型、SSH、外部網路或專案程式。`Start` 成功只證本次 CLR 初始化，不代表 W0 cases、Claude 或 Grok 可用。
- Start 可能只回 E_FAIL；若沒有精確底因，保留 unknown，不承諾此工具一定能解決相容性。

## 先交付的離線範圍

新增固定診斷 source、closed request/result Schema、例子與 fake-native 測試，覆蓋每步 HRESULT 失敗、釋放順序、Stop 失敗、不符版本／平台／request、未知欄位、同一 runner 重入與輸出隱私。nonce 只綁定回應；沒有跨程序的 grant 儲存，不能宣稱持久防重放。實際 public GUID 與 vtable 順序先對照固定官方 source。不得把 fake-native 成功描述為 CLR 或 LPAC 實測。

下一階段才能準備私有 runtime snapshot：固定 Python exe／DLL／必要標準庫與 source 的完整 SHA、大小、來源／FileID、唯一相對路徑，拒 reparse／ADS／hardlink 或未知依賴；無 site-packages／user imports／hooks。私有 root 只讀，`-I -S -B -u` 與 cwd／env 由可信 controller 固定；`-B` 明確禁止 bytecode 寫入，不能在 `-I` 下依賴 `PYTHONDONTWRITEBYTECODE`。snapshot 上限為 256 檔／32 MiB，精確 manifest 須在新請求前確定，禁止從未知原始碼下載依賴。

### 已完成的離線準備與審查

診斷候選 source SHA 為 `3769560e98d63c9513f1922536c9ae0ea10db0c6e6e2cbcbad7b111d967f285a`；Schema、例子、公開來源 pin 與拒絕測試已同步。Python discovery 共 103 項通過，其中 33 項新增測試使用 fake backend；獨立本地唯讀審查未發現 actionable finding，並非真 CLR 或 Windows COM ABI 驗證。審查者沒有 header 原檔，未獨立重算官方 header 雜湊。

外層 workspace `outputs/project-hub-context-resume-20261017/clr-runtime-prepare-03/` 已完成 runtime-only 私有 snapshot：163 檔、9,470,713 bytes，包含精確 6-byte `python312._pth`（`.\nLib\n`），逐檔來源／目的 FileID、大小／SHA 及 protected RX DACL readback 成立；10 項 owned NTFS 合成控制通過。manifest SHA `e48c595564735c703c9ca14b9d566dafe5de71ed7ca9fd46c5258d9dab303858`。這份 manifest 不含診斷 source、未授權 LPAC SID、未啟動候選 Python／CLR／profile，不能當作可執行配置或新的執行 grant。最初版本資源判斷及兩次 ACL 工具判斷失敗的 partial 證據均保留。

## 新隔離執行的差異與限制

原 W0 核可的是固定 C# fixture；Python native-entry 是新的測試 runtime。它需要具體、有界的獨立執行配置與審查，不由本文件或模型意見自動核發權限。仍只允許 fresh per-user profile、空 capabilities、owned Job、明列 handles、固定合成 request、原有時間／程序／記憶體／輸出上限與精確清理。不得借用消耗過的一次性 grant、混用 source manifest、合併成功狀態或修改全域 OS 設定。

這個候選不新增正式環境依賴、不安裝全域 Python、不改 Windows 功能／服務／防火牆；沒有新的 provider auth、runtime readiness 或 Hub 接線。採用它的成本是多一組標準庫／DLL hash 與相容性測試；若 Windows 初始化仍不可用，應以實際證據決定後續方向，避免把診斷工具開發當成完整功能交付。

## 官方依據

- [ICLRRuntimeInfo::GetInterface](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrruntimeinfo-getinterface-method#remarks)：載入和初始化是不同階段。
- [ICLRRuntimeHost::Start](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrruntimehost-start-method)：初始化有獨立 HRESULT 契約。
- [CLRCreateInstance](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/clrcreateinstance-function)：公開 hosting 入口。

完整 Windows Claude／Grok 仍依原功能與資安驗收；此候選沒有更改其完成定義。
