# CLR native-entry 診斷候選（僅離線驗證）

此目錄是可審查候選，尚未執行真 CLR API、LPAC profile 或 runtime snapshot，沒有取代原 W0 的 12 個測項。Fake backend 的成功只驗證控制流程；不代表 CLR、LPAC、Claude、Grok 或 provider 已可用。

設計依據為 [`2026-10-17-clr-native-entry-diagnostic-design.md`](../../../docs/superpowers/specs/2026-10-17-clr-native-entry-diagnostic-design.md)。固定 runtime 為既有 Codex bundled **CPython 3.12.14 final、Windows AMD64**。PATH Python 3.14.0 是另一個 runtime，不繼承此候選的身分。

## 操作與授權邊界

- import、無參數與 `--describe` 都不讀 stdin、不構造 native backend、不載入 CLR DLL；Python 自身與標準 module 可能已含 native 元件，這不宣稱 process 完全零 DLL。
- `--run-native-diagnostic` 只表示選擇固定操作；不是人類授權、隔離 grant 或 profile 核准。後續真執行仍需獨立審查、精確 source/runtime manifest、controller 的環境／Job／時間／記憶體／輸出預算與清理配置。本輪不執行此模式。
- stdin 限 **1,024 UTF-8 bytes**，先以 1,025-byte 有界讀取拒絕超限，再解碼 JSON。只接受 `schemaVersion`、固定 `kind`、64 個小寫十六進位且非全零的 `nonce`、固定 `runtimeVersion=v4.0.30319`。拒重複／未知欄位、無效 UTF-8、surrogate、非固定 runtime 與型別混用；不能提供 DLL、GUID、assembly、method、環境或檔案路徑。
- nonce 只綁 request/result。同一 `Runner` 只允許一次有效執行，包括 backend 載入失敗；不同 Runner／不同 process 沒有持久防重放紀錄。沒有 expiry 或持久 grant，不能把 nonce 當授權 token。
- native 模式在 request、明確 flag、runtime 身分與 `-I -S` flags 驗證後才構造 backend。AMD64 判斷使用 CPython build tag 與 pointer size，不呼叫 `platform.machine()`／WMI；這是 process metadata 檢查，不能替代未來對 Python PE／DLL／stdlib 的 FileID、大小與 SHA 綁定。
- 本版拒絕所有 `COMPLUS_*`、`COR_*`、`CORECLR_*`、`DOTNET_*` 及 `DEVPATH` ambient 覆寫，不輸出其值。**本版不能直接套用 run-07 的固定 COMPLUS InstallRoot/Version 環境**。後續若需要固定 pair，須由可信 WindowsDirectory API 取得根路徑並獨立審查；不能信任 ambient SystemRoot。controller 仍須建立完整 clean allowlist；本工具不宣稱能阻止 registry profiler 設定或達成 sandbox。

## 固定 native 呼叫

`ctypes` 只在 backend 建構時匯入。從 OS KnownDLL `kernel32.dll` 的 `GetSystemDirectoryW` 取得 System32，組合固定 `mscoree.dll` 絕對路徑，以 `LOAD_LIBRARY_SEARCH_SYSTEM32=0x800` 載入，再於取 export 前用 `GetModuleFileNameW` 核對實際路徑；拒空值、截斷、非標準絕對路徑及不符路徑，沒有 request 可控的 DLL 名稱／路徑，也不讀 ambient Windows 目錄值。單用 basename 加 search flag 無法排除同名已載入模組的重用，因此不能省略路徑核對。

只使用公開 hosting 介面，x64 HRESULT 固定 `c_int32`，GUID 由固定公開常數以 `struct.pack('<IHH8B', ...)` 建立 16 bytes，沒有 uuid／MAC discovery 依賴；COM methods 使用 `WINFUNCTYPE`。路徑核對不是 DLL FileID／SHA attestation，後續 runtime snapshot 仍須有獨立綁定。

| 階段 | 固定 API | HRESULT 與取得的物件 |
|---|---|---|
| create_instance | `CLRCreateInstance(CLSID_CLRMetaHost, IID_ICLRMetaHost)` | HRESULT、MetaHost |
| get_runtime | `ICLRMetaHost::GetRuntime(L"v4.0.30319", IID_ICLRRuntimeInfo)` | HRESULT、RuntimeInfo |
| get_interface | `ICLRRuntimeInfo::GetInterface(CLSID_CLRRuntimeHost, IID_ICLRRuntimeHost)` | HRESULT、公開 RuntimeHost |
| start | `ICLRRuntimeHost::Start()` | HRESULT |
| stop | `ICLRRuntimeHost::Stop()` | 僅 Start 的 HRESULT 成功後呼叫 |
| finally | `IUnknown::Release()` | host → runtime → meta，僅取得的介面 |

任何階段失敗都停止下一個診斷 API。失敗 HRESULT 若伴隨非空 output interface，僅釋放，不再呼叫該介面。Start 失敗不呼叫 Stop；Stop 或 Release 失敗不回報完成，Release 失敗仍繼續釋放其餘介面。`interfacesReleased=true` 僅代表取得的介面各自 Release 呼叫正常返回，不是 refcount 歸零、CLR 卸載、Job 為空或 profile 清理的證據。

`GetInterface` 的公開契約區分載入與初始化，`Start` 是獨立初始化步驟。任何非負 HRESULT 均按 `SUCCEEDED` 處理；`0x80004005 (E_FAIL)` 分類為 `unknown_failure`，其他失敗僅分類 `hresult_failure`，不猜底層原因。只輸出固定 stage、32-bit HRESULT、分類、呼叫與釋放摘要；沒有指標、refcount、raw exception、環境、檔案或登入資料。`providerExecuted` 與 `lpacVerified` 永遠為 false。

## Schema、例子與離線測試

`clr-host-diagnostic.schema.json` 以 `oneOf` 定義 closed request、result、description、refusal。Schema 是結構契約，不是 API 執行或來源可信度證明；跨階段控制流程由 runner 與 fake tests 驗證。

`examples.json` 的 `fakeSuccess`／`fakeStartFailure` 明確標記 `evidenceKind=fake-backend`，只供格式審閱。request 的固定 nonce 是合成例子，不能重用為後續真執行授權。

僅跑離線測試的命令（不會呼叫真 CLR）：

```powershell
$env:PYTHONPATH = 'src'
& '<reviewed-python>' -I -S -m unittest discover -s tests -p test_clr_host_diagnostic.py -v
```

測試涵蓋每階段 HRESULT／exception、Stop 條件、反序釋放與釋放失敗、output privacy、型別／Unicode／大小／未知欄位、平台／版本／isolation gate、單 Runner 重複執行，以及 schema/example 的選定結構與 keyword 一致性。這不是完整 JSON Schema validator，也不測真 Windows COM ABI；後者須於新 runtime 配置審查後取得獨立證據。

## 公開契約依據

固定官方 SDK source 為 Microsoft `win32metadata` commit `0f012441d654d3bb7de898fdc664b5fcad52bdcc`。`public-hosting-source-pins.json` 記完整來源 URL、byte count、SHA-256、宣告行、GUID 與 vtable slot；hash 對完整取得的 ASCII/LF source bytes，沒有換行正規化。這是來源審閱證據，沒有把 headers 加為執行時依賴，也不是本機 CLR 實測。

| 固定 source | bytes | SHA-256 |
|---|---:|---|
| [metahost.h](https://github.com/microsoft/win32metadata/blob/0f012441d654d3bb7de898fdc664b5fcad52bdcc/generation/WinSDK/RecompiledIdlHeaders/um/metahost.h) | 80,113 | `0a1b1a6f98eab20c3439b3b68437c7a215594dd8af753fc55017855f18003af9` |
| [mscoree.h](https://github.com/microsoft/win32metadata/blob/0f012441d654d3bb7de898fdc664b5fcad52bdcc/generation/WinSDK/RecompiledIdlHeaders/um/mscoree.h) | 292,182 | `6c4710c5cde0809360c0094f390c2c53e251c99486f3d35f26339af4590f284c` |

依固定 header，`IUnknown::Release` 為零起算 slot 2，`ICLRMetaHost::GetRuntime` 為 3，`ICLRRuntimeInfo::GetInterface` 為 9，公開 `ICLRRuntimeHost::Start/Stop` 為 3/4。GUID 與簽章均使用公開 RuntimeHost，沒有採用 activation log 的 internal host GUID。

- [CLRCreateInstance](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/clrcreateinstance-function)：公開入口與固定 MetaHost 配對。
- [GetRuntime](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrmetahost-getruntime-method)：固定 runtime version 與 IID。
- [GetInterface](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrruntimeinfo-getinterface-method)：載入 CLR，與初始化分開。
- [Start](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrruntimehost-start-method)、[Stop](https://learn.microsoft.com/en-us/dotnet/framework/unmanaged-api/hosting/iclrruntimehost-stop-method)：公開 runtime lifecycle 契約。
- [LoadLibraryExW](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw)：System32-only search flag。
- [GetSystemDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemdirectoryw)、[GetModuleFileNameW](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-getmodulefilenamew)：可信 System32 來源、模組實際路徑與截斷拒絕。
- [Python 3.12 ctypes](https://docs.python.org/3.12/library/ctypes.html)：WinDLL、winmode、Windows call convention 與明確 argtypes/restype。
