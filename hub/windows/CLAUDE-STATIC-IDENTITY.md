# Claude 固定檔案的靜態身分核對

## 範圍與相容修正

這個工具落實 W0 §5 的既有「固定 Claude 靜態身分」量測。`nlink=2` 本身不代表內容不可信；固定 vendor 檔案的純讀取改用同時持有的 Windows HANDLE 保護量測期間。W0 §4.1 新建 synthetic roots、fixture、可寫與可清理檔案仍使用既有 `nlink=1` 規則，沒有修改 LPAC controller 或 `HeldFile`。

產品程式只接受一個完整參數 `--inspect-fixed-claude`。沒有任意路徑、stdin request、環境路徑 override 或執行模式。當前 Windows token 的 profile directory 由 Windows API 取得，只讀固定 `AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\package.json` 與 `bin\claude.exe`。不碰 `.claude`、auth、全域 alias、ACL、profile 或網路；不執行 vendor。

固定值：

| 項目 | 固定值 |
|---|---|
| 版本 | `2.1.252` |
| exe bytes | `217406624` |
| exe SHA-256 | `fe688ecde90d65fff0b2dd097597439774116077d80a3c1e131a7e47db307b1a` |
| manifest SHA-256 | `8ea9f25853a8ef115de2cfe4621e02184daeada5e46de7f23cf8b230682f1f2b` |

## 核對方法與邊界

沿用 `pinned-root.cs` 的 AMD64／Windows build 26200／本機 NTFS 限制，pin 固定路徑的每層祖先；拒絕 reparse、跨 namespace 與非普通檔案。檔案使用 `GENERIC_READ`、`FILE_SHARE_READ`、`OPEN_EXISTING`、`FILE_FLAG_OPEN_REPARSE_POINT`，不繼承 HANDLE。固定路徑不接受 ADS，另由 `FileStreamInfo` 拒絕實際附加 stream。

共用 pin 在釋放、空 handles 或 handles／names 數量不一致時，`Verify`／`CurrentFingerprint` 於 native query 前以固定 `IOException` 拒絕；重複 `Dispose` 不重複關閉，並清除兩份清單。9 項純 managed 生命週期檢查與原有 native pin 回歸另驗，不建立 profile。

manifest 與 exe 同時持有 HANDLE。先記錄 handle 的 volume、FileID、size、link count、attributes、creation／write time；兩次完整 SHA 及 manifest 版本必須符合固定值，結束時再核對 metadata、固定 final path 及全部祖先。link count 可大於 1，但量測前後改變就拒絕。share 衝突、查詢失敗、型別未知或內容改變都輸出失敗，不降級回 Node 路徑快照。

**限制只適用持有期間的固定路徑與 unnamed data bytes。** 其他 hardlink 的 DELETE-only open 或刪除可能成功；它們的名字沒有被全數凍結。實測別名刪除不改變持有內容，但 link count 變動使 `Verify` 拒絕。別名 rename 若不改變固定 source 身分、bytes 或計量欄位，不屬於此快照的不一致。attributes／EA 不受 sharing mode 全面封鎖；本工具核對明列欄位，並不宣稱所有 metadata 不可修改、沒有 ABA、或最後一個 HANDLE 關閉後仍固定。

Windows 來源：[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[Hard Links](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)、[GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle)。一般 sharing 契約不能推論所有 alias 名稱都不能刪改；以本機合成測試記錄實際差異。

## 結果與執行方式

結果遵循 `claude-static-identity-result.schema.json`。成功只表示固定 bytes 的身分快照一致，exit 0；失敗只輸出固定錯誤碼及 Win32 數字，exit 1，不回傳原始 exception、manifest 或路徑。`providerReady`、`vendorExecuted`、`authRead` 永遠為 false。它不是供應商簽章、離線版本執行、協定、登入、模型、whole-process 隔離或整批 W0 成功證據。原先 `STATIC_HARDLINK_REJECTED` 歷史結果保留。

使用既有 C# compiler 與 `mscorlib.dll`、`System.dll`、`System.Web.Extensions.dll` 編譯 `claude-static-identity.cs`、`pinned-root.cs`，沒有新依賴。人工核准範圍內的固定量測命令：

```powershell
& .\claude-static-identity.exe --inspect-fixed-claude
```

合成測試明確 opt-in；它只新建並清理 own temp，production entry 只測拒絕 switch，**不會讀 vendor**：

```powershell
# repository root
$env:HUB_RUN_STATIC_IDENTITY_NATIVE_TEST = '1'
node --test hub/test/claude-static-identity-native.test.js
```

測試保留兩個 aliases、實際 write/delete/rename、既有 writer、writer HANDLE 關閉後仍活著的 writable mapping/view、釋放後正對照、實際 link count 變動、metadata 變動、query 失敗及 ADS 拒絕。測試程式是另外指定 Main 編譯的 fixture，產品入口無法呼叫這些動作。只刪精確 owned 葉節點與空 root，不遞迴清除未知檔案。

## 2026-10-17 驗證

- `outputs/claude-static-identity-native-run09.json`：41 項檢查、closed result schema 及拒絕入口通過，cleanup 成功；較早失敗證據保留，包含 sandbox token 建立 hardlink 回 Win32 5，以及過廣 alias 推論被實測否定。
- `outputs/claude-static-identity-fixed-run01.json`：固定 vendor 純讀取成功，manifest links=1、exe links=2，固定兩份 SHA／版本／bytes 相符。這是一次 snapshot，沒有執行 CLI。
- `outputs/claude-static-identity-fixed-run02.json`：共用 pin 生命週期修正後，另編譯新版 helper 再做一次固定唯讀量測，成功；同名 `-manifest.json` 綁定 core／pin／compiler／reference DLL／exe／執行收據 SHA，未改寫 run01。
- 上述證據位於 repository 外層 workspace 的 `outputs`；每次新驗證使用 create-only 新檔名，不改寫歷史。
- 曾在錯誤的 `hub/` 工作目錄嘗試 Python discovery，回 `Start directory is not importable: 'tests'`；這是執行位置錯誤，不是 repository 缺少 Python tests。正確命令須在 repository root 設定 `PYTHONPATH=src` 後執行 `python -m unittest discover -s tests -v`，結果由整合驗證記錄另列，不能將錯誤目錄的失敗當通過或專案能力限制。
