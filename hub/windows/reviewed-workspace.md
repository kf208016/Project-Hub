# Windows Git 工作區與機密供應介面

原生 controller 必須維持瀏覽器登入、Origin/CSRF、最新程序取得狀態及同 repo 活動 gate。下列模組沒有提供網路入口，也不把 AI capability token 當成使用者核准。

## Git 合併 worker

`ReviewedGitService({root,resolve,busy,verifyStore:true})`：`preview`、`apply`、`receipt` 為 Promise；`reader.receipt`、`recovery` 是既有同步讀取。`active()`、`pending(dir)`、`locked(dir)` 包括 pending repo 的 canonical common-dir，不能只比較 task cwd。HTTP 在 worker 執行期間可讀取狀態；同 repo 的新 AI、Git、清理及控制資料變更必須拒絕。停止服務前要求 `active()===0`。

每個要求經私有 stdio 送到 Hub 擁有的 Windows Job 子程序，重新執行完整 Git metadata／helper／hook 與內容檢查；不快取跨 mutation 的 trust。Browser token 留在 controller，10分鐘到期且只消耗一次；worker 不繼承 Hub 登入/MCP token 或 `NODE_OPTIONS`。`verifyStore:true` 會在作業解析與 host mutation 前重讀 task hash、title、workdir、base及Work關係。不可把這些本機快照、journal或PID鎖稱為OS owner不能竄改的證據。

Windows 每次 Git 執行審查與 semantic index 快照使用 `ls-files --stage -v -z`，拒絕 `assume-unchanged`／`skip-worktree`，包含合併後才出現的旗標。這些旗標可讓 `status`／`add` 隱藏實際工作檔變更；不能把空 status 當成已保存全部修改。Hub 不會自動清除使用者的旗標；請在人工可信 Git 流程處理後重新預覽。索引快照保留 flags、blob、mode、stage、path 與全工作目錄 bytes，拒絕壞格式或超出 20,000 records／8 MiB 的索引輸出。Git 對 flags 的定義見 [git-ls-files 官方文件](https://git-scm.com/docs/git-ls-files)。

Git 的 stat cache 也可能把 same-size／恢復 mtime 的工作 bytes 當成未變，尤其 `core.trustctime=false` 搭配 `core.checkStat=minimal`。Windows Git／工作區快照及保存邊界先審查 external helpers，再用單次 `hash-object --stdin-paths`（沒有 `-w`）重算所有 stage0 一般 tracked 檔案的 Git normalized blob，與 index 及 fresh `diff-files` 比對。未被 Git 顯示的實際差異會拒絕，來源及設定保留，需先人工重新保存；正常可見的修改與 builtin EOL normalization 仍可用。此檢查不以 raw bytes SHA 冒充 Git blob SHA，不清除 flags、不刷新 index、不改使用者設定，也不執行未核准的 external filters。tracked scope 有同樣 256 MiB 上限；[hash-object 官方文件](https://git-scm.com/docs/git-hash-object) 說明純 hash 與 normalization 語義。

## 首次保存與直接作業

`ReviewedWorkspace` 留在 controller，以便保留直接作業期間的 repo lock。`resolve(project,task)` 回傳 `{project,task,title,taskHash,base,workRoot,forbiddenRoots?}`；`workRoot` 必須是 `ROOT/Work/project`。Source、Work範圍不得覆蓋實際 Hub 執行碼或 `ROOT/_hub`。

1. `await preview(project,task,{direct,secrets:[relativePath]})`；完整顯示 action、SHA、Git保存／排除範圍及機密檔名，不顯示值。
2. 使用者確認後 `await apply({project,task,token,confirm:true,skipHooks})`；hooks須另外核准此次不執行。非Git及unborn在產品內首筆安全保存，再建立task工作複本；direct保存Git基線，舊 `hub.mode=direct` 不形成新授權。
3. 若所選秘密非空，先 `await supply({project,task,permit,runId})`。畫面須指明所選檔案交給此次Codex run，可能傳給OpenAI模型服務；沒有這項明確選擇／確認不得供應。
4. `await consumeRun({project,task,permit})` 必須在controller自行更新task workdir前執行，保持已核准completionHash綁定。然後再更新task、啟動AI，並把run與管理程序對應。
5. `WorkspaceRuntime` 保留 controller 私有 flow，把 chat child 的實際 `close`、PTY `finishedP` 和 MCP 命令退出綁定到 run；queue 同一流程沿用 lease。Hub擁有的完整程序樹已退出後 `await releaseRun(run)`；direct repo lock只有成功保存close記錄與lease清理後解除。`active()`必須納入quit/restart gate。重啟只讀到 `workspaceStarted` 或 direct metadata 不形成 run 授權。

Terminal tracking 只接受 `Sessions.get(project,task,actor)` 的同一 session 物件、canonical CLI actor、相同工作目錄與真實 `finishedP` Promise，私下保存 session／actor 對應。Stop 使用這個對應停止本 flow 的全部活動終端機，不預設 Codex、不改用其他 actor，也不停止未追蹤的 session；目前 Sessions entry 被替換時拒絕並保留 lease。Promise 拒絕不算程序樹退出。這項生命週期修正不啟動 CLI、不變更 registry readiness，也不提供 provider 執行／隔離 admission；既有 public lifecycle Schema 不增加欄位。

Browser 使用 `/api/task/workspace/discover` 選取實際檔名，再 `/preview` 取得內容、Git HEAD/index、既有工作複本與 NTFS root FileID 綁定。`/prepare` 需要 `confirm:true`、`ackReadLimits:true`、`ackNetworkLimits:true`，hooks 有獨立確認；成功回傳一次性 permit 給 start/chat/terminal route。`/close` 要等完整 owned 程序樹退出與清理完成才成功。UI 僅在 typed `WORKSPACE_REQUIRED` 回應時重試同 request/task 一次，不以一般錯誤字串發起核准。

`/api/term/start` 與 `/api/term/handoff` 在判定重用既有終端機之前仍檢查 controller 交易互斥：Transfer／Integrate 全域 metadata freeze、同範圍 Maintenance、Rooted move／其他工作區交易忙碌時回 409。重用當前流程僅豁免其自身 direct lease，不豁免這些交易；拒絕前不寫 task 或 handoff packet，也不停止既有 owned terminal。唯讀狀態入口保留可用，交易解除後可重新開啟原終端機。

`GET /api/state` 每個 Windows task 的 `workspaceLifecycle` 僅由當前 controller 的 private flow 產生：`kind/state/ownedChildren/retryClose/errorCode`，Schema 見 `workspace-lifecycle.schema.json`。它不含 flow/run/permit、秘密檔名或 raw error，也不形成新的授權。自然結束或 TTL 後若停止／清理失敗，保留 `cleanup-failed`、原檔、收據與互斥鎖；即使 chat 已 idle，作業畫面仍顯示獨立的［重試停止／清理工作區］。使用者確認停止 owned tree、取消待執行指示及撤銷 MCP 後，送 `/api/task/workspace/close` `{project,task,confirm:true}`；重複點擊受限，partial／未驗證完成不顯示成功，僅明確 `ok:true` 且 summary 為 null 後重載。這不恢復 permit 或重建 metadata authority。

Composer 保持焦點或有未送出草稿時，state polling／SSE refresh 僅更新獨立 lifecycle 元件，不重建主要畫面或移除草稿。啟動失敗、尚未 consumeRun 但已有部分供應 lease 時，cleanup 回傳 `ok:false` 也必須保留 private flow／byTask，不能以沒有 workspace run 為由回報 finish 成功；失敗訊息在 summary 僅為固定 `WORKSPACE_CLEANUP_REQUIRED`。

冷啟動後沒有此 controller 擁有的 flow 時 summary 為 null；close duplicate 只表示沒有當前 owned flow，不能當成已清除磁碟上的舊機密供應或鎖。已知同 record 的 dead-PID 鎖仍需新人工 preview/apply 與明確 ESRCH 證據，存活／未知 PID 和遺留 recovery claim 保留；舊 secret lease 的 runId 無退出證據時須人工覆核，不自動解鎖或刪除。

每次 provider 工作區確認都顯示已測 Codex CLI 限制：`workspace-write` 擋工作區外寫入，但合成 sibling outside read 成功；工作複本不是 task-only read boundary。`networkAccess=false` 不是完整斷網。所選檔案及一般工作區內容可能由 Codex 傳至 OpenAI 模型服務。

初次保存只排除依已知檔名辨識的新可能機密；沒有保證偵測全部秘密。已追蹤秘密變更不自動提交。Git基線可回復所提交檔案；ignored/未提交秘密原檔沒有被稱為完整可還原備份。

來源／工作複本全檔快照包含 ignored 和未追蹤檔案，限 20,000 entries、256 MiB；既有工作複本的 HEAD、branch、semantic index、實際 bytes 與 root FileID 在 preview→apply→consumeRun 重驗。大量 ignored dependencies 超出界線會明確拒絕，需要整理工作區，不能跳過檢查後宣稱等效確認。Workspace first-save 目前在 controller 執行同步 Git preflight；大的來源會暫時延遲 HTTP response，並未宣稱這一段已搬到 background worker。

已預核准的 isolated 工作複本可在 GitHub create lock 期間 consume private permit：仍重驗實際registered worktree、兩側 root FileID、工作複本快照與 ready 時的來源 `baseSnapshot`。preview/apply 與 direct 沒有這項例外，不依 `workspaceMode` 文字或舊journal自行授權。同repo跨ledger相同taskId的新Windows工作複本若branch基名已存在，採canonical WorkRoot hash／計數的新branch從當前HEAD建立；既有工作複本維持原branch，不盲目重用舊ref。Known敏感HEAD路徑包含base與既有工作複本；缺少可選取的來源檔仍須人工處理，不把當前HEAD檢查稱為完整history秘密偵測。

GitHub lock 期間重用既有流程啟動新CLI也要求 private `verifiedBinding(project,task,{verifySource:true})`：isolated、registered common/root FileID、來源ready baseline與目前task hash全部重驗。Controller自己的metadata寫入僅能用 private `advanceTaskMetadata` exact before→實際after receipt延續 ephemeral hash（最多128次），不能以任意目前stored hash重新授權；原user-confirmed記錄不修改。缺少鏈或來源變更會拒並保留流程供Stop／重新驗證；一般MCP的合法metadata更新不套來源全檔hash限制。以上private選項及receipt不是HTTP/MCP輸入。

只讀 `/api/state` 為每project／task送 `gitReadState:known|unknown`、`gitReadError`；無法admit壞的ancestor Git時project保留 `githubHasOrigin:null`，project／task remote均為null，UI可顯示其他資料，但create／merge不因此啟用。這個read summary不改Git mutation的fail-closed guard，也不修復或忽略坏 `.git`。

## 私有機密lease

`SecretSupply({root,stopRun})` 的 `stopRun(runId)` 必須等該次Hub管理程序樹退出，回傳 `{stopped:true,treeExited:true}`。假值、仍存在、未知狀態均不清理。`issue`／`verify`／`cleanup` 是 controller 私有介面，不列入MCP工具。

lease固定10分鐘。AMD64本機NTFS broker持有來源／目的root與檔案handles，二進位檔8MiB以下，create-only，拒reparse、hardlink與跨root。目的FileID或SHA變更時保留檔案並顯示失敗；不能刪除碰撞檔。重開後從 `recoveries()` 列出未完成journal，由具最新停止證據的controller續清理。

供應、private baseline backup／復原與成果copy都把確認時的來源 `sourceFingerprint` 送進native copy，在實際held source handle上核對FileID；先inspect後被換成相同bytes的另一個來源物件也拒絕，不只比較digest。

已追蹤HEAD秘密必須核准完整檔名與Git歷史可讀範圍。供應前先用 private native create-only copy 保存既有目的檔的原始bytes到 `ROOT/_hub/secret-baselines/<lease>/<digest>.key`，以獨立root/hash/FileID記錄 copying→ready intent；ready紀錄成功後才可移除或替換目的檔。到期先停run，驗供應目的與baseline未變，再從此目的原始baseline恢復（不能把目前來源檔當成原目的baseline），重驗復原後才hash/FileID清理private backup。edited目的／baseline被換FileID會保留檔案和backup待覆核，`trackedBaselineRetained`不會在失敗時為true；legacy沒有baseline證據的記錄不會自動宣稱已恢復。

來源原檔、Git歷史與復原的目的baseline仍留在主機。Private backup 不在 MCP scope，值不寫入journal/stdout，但原生Codex已知wider-read限制仍適用；不能稱其完全不可被同OS-owner程序讀取。這些lease不構成阻斷所有主機讀取的OS沙箱，不宣稱到期抹除全部副本。

## Windows 成果引渡し

使用 `TaskTransfer.previewAsync`／`offerPreviewAsync`，搭配 `applyAsync`／`offerAsync`／`receiveIntegratedAsync`；一般同步方法保留macOS相容流程，Windows HTTP不能以它們取代native companions。

Native public artifactcopy維持原來500檔／64MiB總量，單檔不超过64MiB；secret仍8MiB，MCP權限不因此扩大。來源root/FileID/SHA與目的root綁定，create-only，成功副本寫入durable收據後才通知或清理。`nativeActive`／`nativeBusy`必須加入controller gates；跨作業、過期、倒退時鐘、重放及same-ID journal改變都需新預覽。整合cleanup hook會被await。

Native metadata cleanup 必須在人工預覽前取得 Removal `native-tree-v1` 計畫，接著通知／收據持久保存後才執行 rooted endpoint rename。`receiveIntegratedAsync` 要求外層階層確認已綁定的 `nativeCleanup`，不能在合併後新建未覆核計畫。`restoreAsync` 驗證原生收據再還原。NTFS 不允持有所有 descendant handles 直接 rename目錄，必要釋放 descendants，前後重新 hash；race 檢出會留下 partial/quarantine，不宣稱完整tree凍結。

移交使用 private Removal `beforeEntry` callback，在每個實際move前重驗專用task允許路徑、復原／原位置新內容及跨Product共享引用。resume新增引用必須拒絕並保留原始bytes；completed duplicate仍查已移走來源是否重新出現，不靠complete flag隱藏新的管理內容。Controller全Product metadata變更需在此cleanup期間序列化；此callback不是允許HTTP/MCP傳入的任意函式，也不是同OS-owner不可競態的保證。

ReviewedMerge 的 Windows `previewAsync` 在 token 前保存相同 native cleanup plan；`applyAsync` 保存合併收據後持同 repo lock 到 native 清理完成。私有 `deferCleanup:true` 供階層整合延後清理，`cleanupAsync` 僅使用已合併收據和原核准計畫。私有 `advanceTarget(token,previousRecordId)` 只沿前一筆核准合併的精確 targetOriginal→targetMerged 鏈更新剩餘token，來源／清理計畫不變；不提供 HTTP/MCP 工具。conflict/未合併狀態可在新人工 preview 中綁定已解決的來源快照；merged 或 cleanup 狀態不得靜默更換 native計畫。所有journal是本機可恢復記錄，不是簽章、WORM或外部attestation。

階層連續合併合法新增檔名可能改變 Git `check-attr` evidence。`advanceTarget` 只在上述receipt鏈成立、source完整execution不變、target設定rows hash與externalHelpers/hooks不變且無effective blockers時，更新授權變更導致的target attributesHash。Git worktree repair後另保存nativeRepaired版本快照（原objectId、新postrepairtreeHash）；`receiptAsync`重驗該版本，沒有把原plannedtreeHash當成修復後hash。
