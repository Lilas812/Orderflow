# Orderflow Lab — Electron診断の構造調査

調査日：2026-10-25 JST（取得資料のUTC時刻は2026-10-24）。

調査深度：Deep。採用した外部参照資料：31件。ローカル根拠はソースのパス/行番号、保存済み正式証跡、`local-findings.json`を併記する。

対象：`main` / `2c6508edfd7db374949e8de268381d6c571c723e`。開始時の作業ツリーはclean。製品・テスト・診断driver・設定・依存は変更していない。新規保存は本ディレクトリの調査成果物のみ。**Gate B-2B HOLDを維持する。**

## 1. Executive summary

### 結論

**次に必要なのは計算エンジンの再実装や性能最適化ではなく、Electron診断の終了プロトコル・証跡保存・シナリオ別品質契約を一度に整える限定修正である。今回、その修正自体は行っていない。**

1. **`RUNNING_RSS_UNKNOWN`の元試行の直接原因はUNKNOWN。** 現行A4監視経路では`process.mjs:12`にthrow定義があるが、元の失敗時の対象PID・プロセス状態・読み取り順序・stackが保存されていない。Linux終了競合を確定原因としてはいけない。
2. **監視の構造的な問題はコードで確認できる。** RSS取得を所有権確認に結合している。さらに主try/finallyの後に終了監視・profile回収があり、その例外でStage結果保存が飛ぶ。親集約は`String(error)`だけになり、`group()`が付加した対象PID等を失う。
3. **Linuxには「まだZに見えないがRSS欄を出せない」状態を説明できる実装経路がある。** upstream v6.18では`exit_mm()`がmmを外した後に`exit_notify()`が`EXIT_ZOMBIE`を設定する。`proc_pid_status()`はmmが得られなければ`task_mem()`、したがってVmRSS出力を省略する。ただしこれは可能な機序の説明であって、元試行の原因証明ではない。現在のホストは6.18.58、元試行のkernel buildは未保存で、upstream v6.18と同一とは保証しない。[[1]](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/array.c) [[2]](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/task_mmu.c) [[3]](https://raw.githubusercontent.com/torvalds/linux/v6.18/kernel/exit.c)
4. **`NO_REAL_DELTA_DATA`はStage 1の品質契約と検証条件の不一致で説明できる。** 実binは存在し、212件のbin行観測はすべてNO DATA。B83/S64/U57、Vraw204、Delta=nullは固定referenceと一致する。2秒バケットに対して品質保証は1.33秒までで、UNKNOWN分類もある。数値Deltaの存在を全Stageに要求する`verify.ts:90`は、この入力の正しい結果を拒否する。
5. **Stage 1 native PASSはStage 1全体のPASSではない。** 親RSS監視・終了所有権・profile回収・親verifierまで成立して初めてStage PASSになる。元のFAILを後付けでPASSへ変更してはならない。
6. **Windowsは別adapterと実機受入れが必要。** POSIXの`detached`/PGID、Linux RSS、SwiftShaderの結果をWindows Job Object・working set・物理GPUへ読み替えない。

### 今回確認した既存結果

| 項目 | 既存証跡の結果 | 今回の実行 |
|---|---|---|
| A4 Stage 0 | PASS、128入力/受理、最終revision128 | 0回 |
| A4 Stage 1 | native PASS、256入力/受理・revision256。親監視FAIL | 0回 |
| A4 Stage 2 | NOT_RUN | 0回 |
| オフラインテスト | A4報告は1,920 PASS。root/storage全体PASSとは別 | 0回 |
| ブラウザ/Electron/スクリーンショット | 保存済み証跡のみ分析 | 起動0回 |
| profile削除 | Stage 1残留を維持 | 0回 |

Stage 0最終意味状態hash：
`43381470710c96324277770fbbd7bb8e13c896dbbc7faa4a649b0af36211dbf2`

Stage 1保存frame最終hash：
`9cbb07c3c30844482ca76e6871bc584578006192cdbbe07e1603d62031a38763`

後者は保存frameの整合を示すが、親監視・cleanupの欠落を補わない。

### 性能について読み取れる範囲

`.local/diagnostics/task30-a4/report.md:144–185`の正式期間集計を再利用する。native-resultの初期化込み集計と混ぜない。

| 既存観測値 | Stage 0 | Stage 1（FAIL試行の参考値） |
|---|---:|---:|
| frame MISS n | 109 | 214 |
| MISS平均/中央値 ms | 0.551/0.500 | 13.070/14.350 |
| MISS p95/最大 ms | 0.700/1.500 | 21.000/25.700 |
| 即時HIT平均 ms | 0.042 | 0.050 |
| 正式React平均 ms | 0.713 | 0.731 |
| 正式Heatmap/Bubble draw | 109/109 | 214/214 |
| 初期化込みrAF予約/callback/取消 | 228/228/0 | 438/438/0 |
| GL error | 0 | 0 |
| 親tree標本RSS最大 | 698.832MiB | UNKNOWN |
| 最終renderer JS heap used | 10,798,408 bytes | 35,643,576 bytes |

このbuildのstack分類は`other`となるため、Canvas別callback数はUNKNOWN。buffer削除や最終heapは最大メモリの証明ではない。Stage間では履歴・入力内容が違い、各1試行なので、差を特定処理の性能回帰と断定しない。入力は300ms周期の有限試験で、最大処理events/sの実証でもない。今回新たな性能測定は行っていない。

## 2. 現行アーキテクチャと観測境界

```text
Node親 run.mjs
 ├─ 固定人工input / reference / SHA / 予算確認
 ├─ Electronをdetachedでspawn
 │    └─ native.cjs（診断用main、既存built製品mainを利用）
 │         ├─ BrowserWindow / sandbox / contextIsolation / local protocol
 │         ├─ CDP binding・外部observer・layout monitor
 │         └─ React診断entry
 │              ├─ finite MOCK session → AnalysisHub.ingest（逐次）
 │              ├─ publicationPump（250ms通知、最終反映を待つ）
 │              └─ immutableな単一frame / 同一global revision
 │                   ├─ Heatmap → WebGL2 / rAF scheduler
 │                   ├─ Bubble  → WebGL2 / rAF scheduler
 │                   ├─ Delta   → Canvas2D effect + bin表
 │                   └─ VP      → SVG / bigint文字列表現
 ├─ /proc group inventory → identity + RSS + CPU tick
 ├─ native結果 / lossless blocks / 実Canvas操作を照合
 ├─ verifyFrames → 同prefix/query / frozen最終reference / revision / 品質
 └─ group終了確認 → profile安全回収 → Stage結果 → 集約manifest
```

### 主なコード位置

| 責務 | 現在の根拠 |
|---|---|
| spawn・資源サンプル・終了待機 | `apps/desktop/diagnostics/run.mjs:39–142` |
| 固定Stage順、集約とmanifest | 同`:145–210` |
| identity/RSS読取、group列挙 | `apps/web/src/diagnostics/load29-browser/process.mjs:4–47` |
| 所有権、終了中の分類 | 同`:48–78`、`baseline13-driver.mjs:758–795` |
| Electron実UIとnative証跡 | `apps/desktop/diagnostics/native.cjs:34–268` |
| 逐次受理・派生結果atomic publish | `packages/core/src/analysisHub.ts:350–444` |
| read時の単一frame/cache | 同`:516–566` |
| 4Hz通知 | 同`:480–486,507–514`、`publicationPump.ts:24–47` |
| 実DOM/実Canvasと公開revisionの反映確認 | `load29-browser/entry.tsx:69–117` |
| 実API観測 | `load29-browser/observer.mjs:29–97` |
| layout generation | `apps/desktop/diagnostics/layout.mjs:5–75` |

### 数値の意味を混ぜない

- **ingest完了**：ハブに受理された。React/Canvas反映ではない。
- **frame公開**：同一global revisionの派生結果をReactへ渡した。
- **React Profiler actualDuration**：対象subtreeのrender CPU時間。画面提示時刻ではない。commitTimeもGPU完了時刻ではない。[[4]](https://react.dev/reference/react/Profiler)
- **rAF callback**：repaint前のcallback実行。実drawや表示完了と同一ではない。[[5]](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- **draw API観測**：当該Canvas/contextが命令を発行した。GPU完了やディスプレイscan-outを証明しない。
- **buffer create/delete一致**：APIハンドル解放の証拠。GPU driver内の物理メモリ即時回収を証明しない。[[6]](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- **native PASS**：native側ゲートまで。親verifier/資源/cleanupは別。
- **CLI exit0**：全必須Stage・cleanup・証跡がPASSの場合に限る。子exit0だけでは不足。

## 3. 根本原因・過去HOLDの整理

### 3.1 RUNNING_RSS_UNKNOWN：全呼出し経路

現行A4監視のthrow定義は共有`process.mjs:12`。`parseProcess()`はZ/X以外でVmRSSがないとthrowする。別の旧Node計測器`apps/web/src/diagnostics/load29/replay-bench.ts:244`にも同名reasonがあるため、文字列だけで全実行経路の起源を一意に決めない。今回のA4呼出し経路の分析は、runがimportする共有process helperを対象とする。

`identity()`はstat→statusを別々に読み、parse失敗時にstatを再読し、Z/Xになっていれば例外を回避する。しかし、その再読時にも非Z/Xなら再throwする。最初のstat/status読み自体のENOENTも別経路になる。

`group()`は候補を列挙して`identity()`を呼び、ENOENT/ESRCHだけ無視する。他の例外に`targetPid`と部分snapshotを付ける。

| 呼出し位置 | RSS例外が起きた場合 | 構造上の問題 |
|---|---|---|
| `run.mjs:81` 初回leader identity | 主catch→stop | 所有権を確立できなければシグナル不可 |
| `:85` 初回/interval group sample | stopを呼ぶ | stop自体もidentityにRSSを要求 |
| `:63` stop時identity再確認 | stopRefusedに記録 | RSS不明が安全停止の実行まで妨げ得る |
| `:108` 終了後drain group | 主try/finally外から上へthrow | Stage結果・RAM内samples/lifecycleが未保存になる |
| `:109` 最終group | 同上 | group空を確認できずprofile回収にも進めない |

このほか`profile`検証、削除、native結果読取、result保存も例外になり得るが、現在すべてを「先に初期Stage結果を保存し、後から追記する」構造ではない。

親`main()`はStageの戻り値を受けて初めて`summary.stages.push()`する。Stage内の未捕捉例外では、そのStageが集約配列から消え、外側には`String(e)`だけが残る（`:196–205`）。**失敗を隠してはいないが、原因特定に必要な構造化情報を失う。**

### 3.2 元試行について断定できること／できないこと

| 区分 | 判断 |
|---|---|
| 確認済み | Stage 1保存native結果PASS。親集約errorはRUNNING_RSS_UNKNOWN。Stage 1親resultがない |
| 確認済み | 上記の例外脱出経路と、RSS・所有権の結合がある |
| 確認済み | upstream v6.18にはmm消失後、zombie化前の経路がある |
| 有力仮説 | 終了処理中のmm解放とproc読取の競合が、非Z/X・VmRSS欠測を起こした |
| 未確認 | 元のthrowが`:108`、`:109`、interval、stopのどこで起きたか |
| UNKNOWN | 当該PID/種類、raw stat/status、startTicks、読取時刻、元kernel、PID再利用、権限エラー、GC/CPU競合の関与 |
| 否定すべき推論 | 「RSS欠測だから0」「後で消えたから監視PASS」「exit0だからcleanupPASS」 |

LinuxのRSS計数は非同期で精度に限界があるが、これは**欄の欠落の説明とは別**。maps/smapsの競合説明をstatusのVmRSSへ流用しない。[[7]](https://www.kernel.org/doc/html/v6.1/filesystems/proc.html)

### 3.3 NO_REAL_DELTA_DATA

`verify.ts:90`は`delta.some(x => x.validBins > 0)`を全Stageに要求する。

一方、保存済みStage 1は次のとおり。

| 項目 | 値 |
|---|---|
| input / accepted / global revision | 256 / 256 / 256 |
| query | `[1767225600000000000,1767225601330000000)` |
| Delta epoch bin | `[1767225600000000000,1767225602000000000)` |
| 明示Trade品質区間 | queryと同じ1.33秒、2秒bin末尾まで届かない |
| B / S / U / Vraw | 83 / 64 / 57 / 204 |
| Delta / V | null / null |
| issues | NO_TRADE_COVERAGE、INCOMPLETE_CLASSIFICATION |
| quality / temporal status | NO DATA / INCOMPLETE |
| 実bin行観測 | NO DATA 212件。empty placeholderではない |

`deltaTimeline.ts:40–83`はbin全体のcoverageと分類を検証し、NO DATAをINCOMPLETEより優先する。UNKNOWNがあるだけでも数値Deltaを出さない。`DeltaPanel.tsx:74–84`はこの結果を非数値のamber帯として描く。

したがって**現状の数値Delta必須条件は不適合。ただし単純削除も不適切**。次節のscenario別quality gateに置き換え、実bin・数量・null・描画・referenceをより厳しく検証する必要がある。

Stage 1のTRADESチャンネル最終状態がVALIDでも、bin coverageと分類が完全とは限らない。L2 SnapshotでL2が復旧してもTRADESのUNKNOWNやcoverage不足は解消しない（`analysisHub.ts:350–406`）。

### 3.4 過去の停止と共通パターン

| 過去の問題 | コード/保存報告で確認できる説明 | 正式起動前に置くべき試験 |
|---|---|---|
| 空payload/出力固定先 | 入出力契約・一回限りの出力先管理。現在も`run.mjs:148`はA4固定先 | required payload・exclusive新規output・再使用拒否のCLI試験 |
| placeholderをbin扱い | `delta-row-empty`と実binの混同。A2で分離済み | placeholderに数量/revision等があれば拒否 |
| 初期647→632px | A2で15px縮小。A3の人工overflowで二重scrollbar経路を再現 | 実Canvas settle、overflow、ResizeObserver epoch |
| IDLE sessionへの事前read | 空状態と正式入力セッションの生命周期混同。A3で専用空session化 | IDLE拒否と空start/read/disposeの独立試験 |
| 最終revision127で終了 | A3で入力128、公開127。250ms待ち中のcompleteがtimer停止 | 人工clockでINPUT_COMPLETE後も最終公開/全consumer反映まで待つ |
| revision0で異なる寸法 | pre-input/formal layoutをdata revisionだけで識別 | `(phase,layout generation,canvas/context identity,revision)`を照合 |
| 実draw検出 | DOM値/背景/軸だけでは実bin描画を証明しない | Canvas API・数量/品質/座標・negative draw assertion |
| RSS例外後の記録消失 | 終了処理が結果保存より前、catchで構造化情報消失 | 全await/cleanupのfault injection、必ずStage FAIL receipt |
| Stage横断のvalid Delta必須 | 数値のあるシナリオと正しいwithheldシナリオを混同 | Stage 0/1/2全部のscenario契約を起動前に照合 |

A3の人工scrollbar再現は、過去A2時点に同一DOM状態があった直接証拠ではない。旧HOLDは保持する。既に直ったpublicationPump/placeholder/layoutの再実装も不要。

## 4. 監視・cleanupの推奨設計

### 4.1 分離する3つの契約

1. **Identity**：所有しているどのプロセスか。RSSを要求しない。
2. **Liveness**：そのidentityが生存中/終了確認済み/遷移中/観測不能か。
3. **Resource observation**：その観測時のRSS/CPUを取得できたか。取得不能を0にしない。

Linux案：

```text
identity = {pid, ppid, pgid, sid, uid, startTicks}
liveness = RUNNING | EXIT_TRANSITION | EXIT_CONFIRMED | UNKNOWN
memory = MEASURED(bytes) | NOT_APPLICABLE_EXITED | UNKNOWN(reason)
```

stat/statusを別readするため、観測はatomic snapshotではない。前後のstartTicks・PGID/SID等の整合をチェックし、候補列挙後にも現在のmembershipを確認する。PID再利用・不整合・権限拒否を別reasonで残す。read-check-signalにはなお競合があるため、PID/startTicksだけでpidfdと同じ保証を宣言しない。pidfdは将来の別承認対象。[[8]](https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html) [[9]](https://nodejs.org/download/release/v24.22.1/docs/api/child_process.html)

### 4.2 状態遷移

```text
CREATED
  → SPAWNING → OWNED_RUNNING
  → STOP_REQUESTED / INPUT_COMPLETE
  → RENDERER_DISPOSING → NATIVE_EVIDENCE_SAVED
  → MAIN_QUIT_REQUESTED
  → LEADER_EXITED + STDIO_CLOSED
  → GROUP_DRAINING → GROUP_EMPTY_CONFIRMED
  → PROFILE_RECLAIMED → SEALED

どの状態でも primaryFault は一度設定したら消さない。
cleanupFaults / evidenceFaults は別配列へ追加する。
```

**親exit・stdio close・group empty・profile削除は別条件。** Nodeの`exit`時にはstdioが開いていることがあり、`close`はprocess終了とstdio closureの後。closeだけでも子孫消滅は保証しない。spawn/error/exit/closeリスナーはspawn直後、最初のawaitより前に登録する。[[9]](https://nodejs.org/download/release/v24.22.1/docs/api/child_process.html)

欠測時の扱い：

| 状況 | 推奨判断 |
|---|---|
| 計測中の既知生存プロセスでRSS不明 | sticky FAIL。新規入力を止め、所有済み正常終了経路を要求。後で消えてもFAILを戻さない |
| 既知Z/Xまたは保持した終了証拠と同一identity | RSSはNOT_APPLICABLE_EXITED。架空の0byteとして加算しない |
| 終了要求後・identity一致だが非Z/X、RSS欠測 | EXIT_TRANSITION候補として構造化保存。既存wall内の有限確認が必要。要求/markerだけで終了認定しない |
| 終了を確認できない/identity不一致 | UNKNOWN/FAIL、HOLD。シグナルやprofile削除を拒否 |
| 権限拒否/parse不正/対象不明 | 退出競合へ丸めず、独立した観測失敗 |

EXIT_TRANSITIONの取り扱いは次工程で明示承認する契約である。**未確認のRUNNING欠測を自動免除する提案ではない。** 終了証明が得られなければFAIL。元A4は情報不足のため遡及分類しない。100ms標本の合計RSSは連続的な瞬間上限証明でもない。

### 4.3 例外・証跡・回収を分けた疑似コード

```text
create exclusive output; persist plan + profile inode/dev/uid + trial identity
attach spawn/error/exit/close listeners immediately
persist bounded lifecycle receipt
try:
    establish owned identity without requiring RSS
    monitor strict resources while finite input runs
    await native result and final publication
catch fault:
    latch primaryFault with phase/targetPid/read ordering/cause/stack
finally:
    stop input/monitor timers idempotently
    persist pending failure receipt BEFORE recovery
    try:
        request owned native graceful shutdown once
        await disposal + native evidence + process exit + stdio close
        inspect owned group independently of RSS parser
        remove exact profile ONLY after empty + owner/inode/path checks
    catch cleanupFault:
        append cleanupFault; never replace primaryFault
    finally:
        save stage outcome even when cleanup fails
        save receipts + manifest; evidence failure implies nonzero CLI
```

既存writerはexclusive・fsync・checksum付きであり再利用する。初期receipt、失敗receipt、final receiptは別の有限ファイルにし、既存の8MiB/file・32MiB合計等を増やさない。無制限な追記・大量raw proc保存はしない。共有の`cmdline`/environ/URL/tokenは採取しない。

必要な最小証跡：単調時刻、phase、PID/startTicks/PGID/SID/uid、stat状態、RSS fieldの有無・read error code・read順序、exit/close/cleanup ack、対象シグナルとownership verdict、profile receipt、元例外stack。完全cmdlineや環境変数は不要。

### 4.4 正常終了を先にする

現行nativeは明示dispose後、`A2_CLEANUP`を書き、直ちに`app.exit(code)`する。これはElectronの通常quit lifecycleとは同じではない。`app.exit()`はbefore-quit/will-quitを経ず即時終了する。`app.quit()`は全windowを閉じようとし、beforeunload等で取消され得る。[[10]](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) [[11]](https://raw.githubusercontent.com/electron/electron/v45.0.0/docs/api/browser-window.md)

推奨は診断専用のidempotent shutdown coordinator：

1. 既知の親子間制御経路でSTOPを一度だけ受理する。固定message型・trial identity・容量制限を持たせる。
2. pump停止、React unmount、session dispose、observer/layout解放を有限にawaitする。
3. native結果を永続化し、親がreceiptを読める状態にする。
4. `app.quit()`とclose/will-quit経路を観測する。任意のasync listenerをElectronが自動awaitすると仮定しない。
5. 退出コードのために`app.exit(code)`が必要なら、dispose/証跡確定とwindow終了後のterminal処理に限り、その事実を区別して記録する。
6. 親はexitだけでなくstdio closeと所有group空を確認する。

signal handler・wall handler・正常完了の3入口が同じshutdownを共有し、多重dispose/多重保存しないことを試験する。Nodeのexit listenerではasync cleanupを待てない。`process.exit()`もstdoutを切り詰め得る。markerは永続結果やcloseの代わりにしない。[[12]](https://nodejs.org/download/release/v24.17.0/docs/api/process.html) [[13]](https://nodejs.org/download/release/v24.17.0/docs/api/stream.html)

強制回収は今回実行しない。次工程も既存の所有権・graceful-firstを弱めず、所有者不明には送信しない。仮に別途承認された強制終了が発動しても試行FAILのまま後続停止する。negative PIDへのsignalはPOSIX group対象で、Windowsには移植しない。[[14]](https://man7.org/linux/man-pages/man2/kill.2.html)

### 4.5 Windows adapter

| 対象 | Windowsでの提案 | 制約 |
|---|---|---|
| 所有 | 専用Job + 保持process handle + creation time | Node detachedはJobではない |
| 起動 | rootをCREATE_SUSPENDED→Job assign成功→ResumeThread | assign失敗ならresumeしない。既存Job/nestingを検証 |
| 子孫 | Job membership + 具体的なElectron子プロセス実測 | breakaway/WMI等の例外あり。全子孫包含を事前断定しない |
| 生存 | process handle wait、exit結果、creation timeとの対応 | wait中にhandleをcloseしない |
| group終了 | Job queryのactive count等を独立確認 | completion port通知だけでPASSにしない |
| メモリ | WorkingSetSize、PrivateUsage、必要なjob countersを別名で測る | Linux RSSと同一指標にしない |
| 最終保護 | KILL_ON_JOB_CLOSEを使うならlast-handle管理を設計 | normal close失敗時の強制終了はFAIL。handle漏れ/早期close双方が危険 |

MicrosoftはJobの子継承・breakaway・nested jobsの制約を明示し、completion port通知は一部を除いて保証されない。Windows 11はnested jobsを支えるが、既存の親Jobとの組合せは実機で検証する。[[15]](https://raw.githubusercontent.com/MicrosoftDocs/win32/docs/desktop-src/ProcThread/job-objects.md) [[16]](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) [[17]](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)

process handleのwaitとcreation timeはPIDだけより強い根拠。`WaitForSingleObject`中のhandle closeは未定義動作。[[18]](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) [[19]](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)

Working setは共有/私有resident pageを含み、PrivateUsageはprivate commit charge。両者もtree単純合計も同じ「RAM」ではない。[[20]](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set) [[21]](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)

これは将来のnative helper/adapterの設計であり、現行JSに既にWindows Job handleがあるという意味ではない。新依存やnative実装には別承認が必要。

## 5. 品質に応じたDelta検証契約

### 5.1 数値・時刻・revision

- B/S/U/Vrawは正確なbigint。Vraw=B+S+U。
- 観測B−Sを計算できても、それを確定Deltaとして表示しない。
- qualityがVALIDの場合のみV=B+S、Delta=B−S。UNKNOWN分類・欠測・不明alignmentは数値を保留する。
- qualityとtemporal status（PROVISIONAL/FINAL/REVISED/INCOMPLETE）は別。VALIDなPROVISIONAL値をFINALと呼ばない。
- binは整数UTC nsのepoch境界、`[start,end)`。nsをNumberへ変換しない。
- frame/global revision、binの訂正revision、layout generation、Canvas/context identityを別々に検証する。bin revision0とframe revision256は矛盾ではない。
- L1/L2/TRADESは独立。L2 Snapshotの成功でTrade品質をVALIDへ上書きしない。
- Deltaは表示用フィルター、VP、バブル密度で変えない。

### 5.2 scenario別の必須assertion

| 状態 | 数量/品質 | 実描画で要求するもの | 禁止する偽装 |
|---|---|---|---|
| 完全なBUY/SELL bin | referenceどおり、U=0、full coverage、VALID | 方向・高さ・色・alpha・時間x座標が合うbar | DOM値だけでdraw PASS |
| 完全なknown-zero bin | Delta=0、VALID、coverage根拠あり | 既存の2px ZERO線と「0」 | 軸/背景をzero barと認定 |
| UNKNOWNを含む | B/S/U/Vraw維持、Delta/V=null、INCOMPLETE等 | amberの非数値表現、正しい表/tooltip | B−Sや0を数値bar化 |
| NO DATA/GAP/coverage不足 | Delta/V=null、issue集合一致 | 当該実binのwithheld表示 | 未観測をゼロ埋め |
| bin自体なし | empty placeholderのみ | 背景/NO DATA表示、bin欄なし | placeholderをbinに数える |

現行`deltaDrawingGate()`は数量・品質・局所revision・座標・API命令を既に照合する（`contracts.ts:27–80`）。再実装せず、**withheld領域に余計な数値barがないnegative assertion**、scenarioで必要なカテゴリが実際に観測されたかを追加するのが最小。

Stage別：

- **Stage 0**：完全分類・明示coverageの既存128入力。保存描画ではUP57、ZERO52。最終B31/S31/U0、Delta0、V62。数値Deltaとknown-zeroの契約を維持する。
- **Stage 1**：既存256入力。上記NO DATAを正として、実withheld binの存在、B83/S64/U57/Vraw204、Delta/V null、issue集合、fixed hashを要求する。「validBins>0」は要求しないが、placeholderだけで通過させない。
- **Stage 2**：既存500入力のinput/referenceはあるが、Electron実行はNOT_RUN。prefix251/252のGAP/RESYNCINGは**L2_MBP**に対する人工condition。TradeのUNKNOWN/coverageは独立のまま、各prefix/queryのreferenceを照合する。最終L2 VALIDだけでTrade Deltaを数値化しない。Stage 2実描画を今回PASSとは報告しない。

期待カテゴリは固定input・既存独立reference・明示契約から先に宣言し、実測値を見て期待値を書き換えない。同じ製品coreを再生する照合はprefix同期の検証には有効だが、独立oracleそのものではない。固定独立最終hash・既存単体テストの具体値・描画negative assertionを併用する。

### 5.3 必須テスト

1. valid positive/negative/zero、UNKNOWN qty0/positive、coverage不足、GAP、empty。
2. bigint大数量、ns境界−1/exact/+1、異なるscope/sessionを混ぜない。
3. global/bin/layout revisionの取り違え拒否。
4. placeholderの偽数量・重複/欠落bin・余分なbarを拒否。
5. Stage 1の正しいnullをPASS、不正な0/+19をFAIL。
6. Stage 2のL2復旧でTRADES品質が勝手に回復しない。
7. saved evidenceの非損失復元・receipt/hash一致。旧FAIL記録は変更しない。

## 6. 診断アーキテクチャとテストピラミッド

### 6.1 分離の単位

大規模framework化は不要。既存writer/layout/publicationPump/observer/independent referenceを再利用し、**process monitor、shutdown orchestration、scenario policy**を注入可能な小さい単位にする。

```text
多数：pure contract tests
  identity / RSS状態 / Delta品質 / geometry-generation / fixed scenario
   ↓
多数：fake OS + fake ChildProcess + fake clock のorchestration
  spawn失敗、early exit、exit前close禁止、RSS欠測、writer失敗、cleanup拒否
   ↓
少数：専用一時領域の実Node子プロセス試験
  owner identity、stdio遅延、exit/close、残留検出、専用profile保護
   ↓
少数：独立Electron smoke
  実security・実Canvas寸法・実描画・quit/dispose
   ↓
最少：固定Stage 0 → 1 → 2、FAIL即停止、一度限り
```

実Node/Electron試験も今回は未実施。次承認後の試験計画である。

### 6.2 正式試験前の契約チェック

- Stage全条件に対して、期待する数値/withheld/emptyカテゴリを事前検証。
- 空状態prepareと正式入力セッションを分離。
- 実測Canvas/layout settleを採用し、Viewport式は変更しない。
- input complete後に最終global revisionと全consumer反映を待つ既存pumpを維持。
- frame/draw照合キーは`trial+phase+layout generation+canvas/context identity+global revision`。bin訂正revisionは別検証。
- monotonic timeで入力/通知/render/cleanupを分け、250ms契約と待ち時間をCPU時間へ混ぜない。
- resultは最初から存在し、未到達StageはNOT_RUN、進行中はINCOMPLETEと明示。未保存=不存在にしない。
- 出力先は新規専用directoryを事前指定・exclusive作成。A4固定先を再使用しない。
- failure receiptを先に確保し、primary errorをcleanup errorで上書きしない。

### 6.3 現行テストで不足するところ

`load29-browser/runner.test.ts`にはZ/非ZのRSS・ownershipの人工試験があるが、desktopの`stageRun()`全体の終了/例外順序を通していない。`createMonitorLifecycle()`も存在するがdesktop runnerの実経路に接続されていない。source文字列検査だけでその順序を保証したことにしない。

`entry.tsx:172–177`のdispose戻り値には`timers:0`というリテラルがある。これ自体を「実測timer残留0」の独立証拠にせず、dispose後の実session/pump statusや実observer pendingとの一致を取る。現時点でtimer漏れを観測したという意味ではない。

observerの`getError`・stack採取・配列copy・100ms CDP snapshotは診断負荷を持つ。`getError`等は同期stallの可能性があり、計測条件を途中で変えれば過去性能と比較不能になる。今回それを最適化しない。[[6]](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)

### 6.4 証明範囲

実context loss/restoreは実WebGL contextで別smokeとして行い、正式性能へ介入を混ぜない。JS API呼出しやrAFだけでGPU完了/画面提示を証明しない。useLayoutEffectはrepaint前の順序を与えるが、GPU/presentation fenceではない。ResizeObserver/device-pixel boxとdrawingBuffer寸法もgeometryの証拠である。[[22]](https://react.dev/reference/react/useLayoutEffect) [[23]](https://web.dev/articles/device-pixel-content-box) [[24]](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth)

Playwright Electronはexperimental。採用するならsecurity設定、closeの実装・所有権・stderr/終了証跡を別途確認する。導入するだけで現行monitor/cleanup問題が解消するとはしない。今回新依存・driver移行は推奨の最小範囲に含めない。[[25]](https://www.electronjs.org/docs/latest/tutorial/automated-testing) [[26]](https://playwright.dev/docs/api/class-electron)

## 7. 優先修正一覧

規模は設計上の相対分類（S=局所、M=小モジュール＋呼出し配線）。工数や性能向上の実測値ではない。

| 優先/重大度 | 修正対象と確度 | 実ファイル/予定ファイル | 規模 | 受入れ/リスク/Done |
|---|---|---|---|---|
| P0・高 | 全経路でStage結果/原例外を保存。構造欠陥は確定 | `apps/desktop/diagnostics/run.mjs`、新`processMonitor.mjs`/`.test.ts` | M | early exit/RSS/cleanup/writer faultすべてFAIL receipt。旧証跡不変。writer自身の失敗は非zeroで明記 |
| P0・高 | identityとRSS分離、所有権付き終了state machine。元race原因は未確定 | 同上、`native.cjs` | M | 生存RSS不明FAIL、退出証拠を0偽装しない。未知processへsignalなし |
| P0・高 | scenario別Delta品質ゲート。Stage 1不一致は確定 | `verify.ts`、新`deltaQuality.test.ts`、既存`tests/diagnostics.test.ts` | S/M | Stage 1正しいnull/withheldは受理、偽0/+19/placeholderは拒否。Stage 0数値必須を維持 |
| P1・中 | graceful-first/idempotent native shutdownとstdio drain | `native.cjs`、`run.mjs`、上記monitor tests | M | dispose/保存/quit/exit/close/group/profileを個別に確認。異常を正常cleanupでPASSへ戻さない |
| P1・中 | scenario入力から最終consumer反映までの既存pump回帰を維持 | 既存pump・layout・observerは原則read-only | S | 全Stageで最終revision、phase/layout識別、8MiB等の元予算を維持 |
| P2・中 | Windows Job/handle/resource adapter | 将来の別新規adapter/helper/test | 別承認 | 実機Win11、sandbox保持、nested job/working set/異常退出実測 |
| P2・中 | GPU/presentation/GCの深い観測 | 将来の別診断 | 別承認 | WPR/ETW等で別枠検証。既存CPU値をGPU時間と呼ばない |

最初の4項目は、次工程1件で**診断限定の小修正**として扱うのが合理的。製品core、React/Canvas計算、保存形式、依存を含めない。Windows adapterや性能改善まで同時に広げない。

## 8. 最短のStage 1 → Stage 2再開計画

### 今すぐ行わなくてよいこと

- TWA/バブル/Delta/VPの再実装や追加最適化。
- 新しい市場fixture/期待値/品質区間の創作。
- スクロール寸法や最終publicationの再設計。
- Electron/Chromium/Nodeの更新、Playwright全面移行。
- 既存storage timeout調査の再実行。
- 残留profileの推測に基づく自動削除。

### 次の承認単位

1. **診断7ファイルの実装＋オフライン回帰だけ**を承認対象とする。詳細は別添の実装指示。
2. fake OS/child/clockで終了順序・RSS欠測・profile保護・証跡保存を先に通す。
3. 既存固定input/referenceを使ったscenario契約を全Stage分確認。Stage 1の意味状態を変更せず、品質に合う実描画検証へ接続する。
4. 対象診断・desktop/web/core/renderの既存回帰、typecheck/build/diffを確認。root/storage未実施ならその範囲を明記する。timeout等は変更しない。
5. ここで停止。**新しいElectron smoke・正式Stage再実行・旧profile回収は別途承認**する。
6. 次承認時は、所有者不明process/旧profileを明示して安全に扱い、新しいexclusive証跡先でsmoke→Stage 0→1→2。各Stage FAILなら後続停止。最終Stageだけを単独で成功扱いしない。

正式Stage 2の最小Done：

- 入力500/受理500、6部門のglobal revision一致、固定input/reference SHA一致。
- L2 GAP→RESYNCING→Snapshot復旧を実証し、復旧前の板をVALIDと扱わない。
- Trade UNKNOWN/coverage/Delta nullを独立に維持し、数量/VPの正確性を変えない。
- 全prefix/queryと実Canvas/DOM/GL証跡が照合でき、layout generation・DPR・座標整合が成立。
- RSS/CPU観測範囲・欠測・退出確認が分類済み。JS heap、GC、GPU時間、presentation latency未測定はUNKNOWN。
- 独立退出/close/group空/profile回収/manifestが全て成立。強制終了・timeout・証跡失敗ならFAIL。

**今回の調査をもってStage 1/2のPASS、本番接続許可、HOLD解除はしない。**

## 9. Windows 11製品への推奨

### 維持するもの

既存React/WebGL2/AnalysisHub/整数tick/UTC ns/bigint/品質契約は共有する。sandbox、contextIsolation、nodeIntegration無効、local protocol、ネットワーク/permission制約を維持する。診断のために`--no-sandbox`や任意IPC/任意ファイルAPIを導入しない。Electronのsecurity指針にも一致する。[[27]](https://www.electronjs.org/docs/latest/tutorial/security)

### Windowsで改めて確認するもの

1. **process ownership**：Jobに入れたrootと実際のrenderer/GPU/utilityのmembership、nested jobsとbreakaway、helperの署名/配布/アーキテクチャ。
2. **shutdown**：通常window close、app.quit、renderer crash、GPU/utility crash、OS shutdown/logout。Electronの`child-process-gone`はrendererを含まないため、`render-process-gone`も別に記録する。Windows shutdownで一部quitイベントが来ない点を設計へ反映する。[[10]](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) [[28]](https://raw.githubusercontent.com/electron/electron/v45.0.0/docs/api/web-contents.md)
3. **metrics**：app.getAppMetricsはアプリ関連processのsnapshot/intervalで、親の所有Job全体や最大RSSの代用品ではない。複数呼出しでCPU計測区間を共有する。utilityProcessのserviceNameは識別補助になるが、退出・包含の保証ではない。[[10]](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) [[29]](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md)
4. **geometry**：100/125/150/200% DPI、複数monitor移動、native frame/scrollbar、resize/minimize/restore。647×324や403×324は診断条件であり、製品固定サイズにしない。
5. **GPU**：実GPU/driverとSwiftShaderを別に記録。context loss/restore、DPR変更、資源解放を実contextで確認する。物理GPU性能は現時点UNKNOWN。
6. **配布**：Windows artifactの実起動、権限、code signing/SmartScreen、upgrade/uninstall、native module rebuild。Linux起動だけで配布PASSとしない。
7. **性能観測**：WPR/ETW/WPAを候補に、CPU/IO/GC/GPU/presentationを必要なprovider/profileで別途測る。WPR利用だけでこれらが全部取得できるとはしない。[[30]](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder)

Electron45.0.0とChromium156.0.8078.48/Node24.22.0の組合せは公式releaseページと保存native証跡が一致する。親Nodeのchild-process説明にはv24.22.1文書、一般的なexit/stream説明にはv24.17.0文書も使用した。patch差分を無検証で同一実装と断定しない。[[31]](https://releases.electronjs.org/release/v45.0.0) [[9]](https://nodejs.org/download/release/v24.22.1/docs/api/child_process.html)

## 10. 次エージェントへの実装指示・承認事項

**推奨する次タスクは1件：『Electron診断の終了・資源監視・scenario品質契約の限定修正とオフライン回帰』。**

完全な次工程用指示は同梱の`implementation-prompt.md`に記載した。これは今回の実装承認ではない。

予定変更は7ファイル：

1. `apps/desktop/diagnostics/run.mjs`
2. `apps/desktop/diagnostics/native.cjs`
3. `apps/desktop/diagnostics/verify.ts`
4. `apps/desktop/diagnostics/processMonitor.mjs`（新規）
5. `apps/desktop/tests/processMonitor.test.ts`（新規）
6. `apps/desktop/tests/deltaQuality.test.ts`（新規）
7. `apps/desktop/tests/diagnostics.test.ts`

既存の共有browser process helper、formal driver、writer/layout/publicationPump/observer、fixture/reference、製品main/preload/Canvas/coreは変更しない構成を優先する。共通helperや追加ファイルの変更が必要なら停止して承認を求める。

### 最終UNKNOWN

- 元RSS例外の対象PID/正確な発生phase/stack/status、元kernel。
- 元Stage 1の親process群RSS/CPU/退出所有権、削除時点の完全な所有証明。
- Stage 2の実Electron描画/性能/終了。
- Windows実機・物理GPU・GPU完了/presentation・GC詳細。
- Node/OS read-check-signal競合を完全に消すためのpidfd/native handle実装。

### 調査の完全性

開始時に記録したGit管理対象439ファイル、既存証跡223ファイルを終了時に再照合する。調査ノートをLibrary提示した結果、`.agents/agent_assets_metadata.toml`に新規調査assetの管理登録差分が発生した。これは製品・測定条件の変更ではなく、手動修正/復元はしない。その他の元ファイルと旧証跡は不変確認の対象である。

今回の新規テスト・性能試験・Node子プロセス試験・Electron・ブラウザ・Screenshot起動はすべて0。既存profileへの操作はlstatによる所有者/mode/inode等の読み取りのみ。中身の取得・削除・復元は行っていない。

### 参照資料の扱い

本報告の外部参照は公式API/固定tagの実装/標準技術資料を優先した。Electron45はversion-pinned、Linuxの詳細コードはupstream v6.18でありホストstable patchそのものではない。React/MDN/Playwright/一部Microsoft資料はmutable文書で、取得時点を台帳へ記録した。検索snippetしかない項目や失敗fetchは完全取得の証拠にせず、必要なkernel/Windows契約は別の公式sourceで補完した。

公式releaseの検索snippetにはOct20、取得本文にはOct21という日付差がある。バージョン組合せは一致するが、release日付の差を勝手に統一せず台帳へ残す。最新API資料を過去試行時の実装証明としては使わない。

2020/2022/2024年のWindows/geometry資料等は18か月より古い。これらは公開APIの意味・歴史的制約の根拠として使い、2026年の対象実機での動作確認の代わりにはしない。一般的なAPI文書と対象version固定sourceを区別し、未取得の仕様の細部を推測で補完していない。

## 参考文献

1. [Linux v6.18 proc status implementation](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/array.c) — upstream v6.18。取得：2026-10-24T19:34:57.546Z。適用制限：固定tag。ホスト6.18.58/元試行kernelの一致は未確認。 保存：sources/gap-kernel/linux-v6.18-fs-proc-array.c

2. [Linux v6.18 task_mem implementation](https://raw.githubusercontent.com/torvalds/linux/v6.18/fs/proc/task_mmu.c) — upstream v6.18。取得：2026-10-24T19:35:11.162Z。適用制限：statusのVmRSS出力に使用。mapsの競合と混同しない。 保存：sources/gap-kernel/linux-v6.18-fs-proc-task_mmu.c

3. [Linux v6.18 exit_mm and exit_notify](https://raw.githubusercontent.com/torvalds/linux/v6.18/kernel/exit.c) — upstream v6.18。取得：2026-10-24T19:35:03.569Z。適用制限：実装上可能な順序。元試行で起きた証拠ではない。 保存：sources/gap-kernel/linux-v6.18-kernel-exit.c

4. [React Profiler](https://react.dev/reference/react/Profiler) — mutable; 文書日/version UNKNOWN。取得：2026-10-24T19:32:43.760Z。適用制限：actualDurationはrender CPU、presentationではない。 保存：sources/react-webgl/01-react-profiler.md

5. [Window requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) — MDN; last modified2026-08-21。取得：2026-10-24T19:32:49.615Z。適用制限：技術リファレンス。特定Chromium build保証ではない。 保存：sources/react-webgl/03-request-animation-frame.md

6. [WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) — MDN; last modified2026-10-07。取得：2026-10-24T19:33:30.918Z。適用制限：技術リファレンス。GPU driver実測の代替ではない。 保存：sources/react-webgl/07-webgl-best-practices.md

7. [The proc filesystem](https://www.kernel.org/doc/html/v6.1/filesystems/proc.html) — Linux v6.1 documentation。取得：2026-10-24T19:33:06.806Z。適用制限：RSS精度と欄の有無を区別。 保存：sources/linux-proc/01-kernel-proc-v6.1.md

8. [pidfd_open(2)](https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html) — man-pages 6.19; page date2026-02-08。取得：2026-10-24T19:33:34.088Z。適用制限：取得時のPID race/条件に注意。Node組込APIの存在を保証しない。 保存：sources/linux-proc/03-man-pidfd-open.md

9. [Child process](https://nodejs.org/download/release/v24.22.1/docs/api/child_process.html) — Node.js v24.22.1。取得：2026-10-24T19:34:45.173Z。適用制限：親向け文書。Electron内Node24.22.0とpatchが異なる。 保存：sources/exact-node24-child.md

10. [Electron app API](https://github.com/electron/electron/blob/v45.0.0/docs/api/app.md) — v45.0.0 tag; 文書日UNKNOWN。取得：2026-10-24T19:33:02.506Z。適用制限：quit/exit、process metrics/eventsのversion固定資料。 保存：sources/electron-lifecycle/01-electron-45-app.md

11. [Electron BrowserWindow API](https://raw.githubusercontent.com/electron/electron/v45.0.0/docs/api/browser-window.md) — v45.0.0 tag; 文書日UNKNOWN。取得：2026-10-24T19:33:40.864Z。適用制限：close/destroyの違い。 保存：sources/electron-lifecycle/06-electron-45-browser-window-raw.md

12. [Process](https://nodejs.org/download/release/v24.17.0/docs/api/process.html) — Node.js v24.17.0。取得：2026-10-24T19:33:04.104Z。適用制限：同majorの公式資料。対象patchと同一実装の保証ではない。 保存：sources/node-lifecycle/02-node-v24-process.md

13. [Stream](https://nodejs.org/download/release/v24.17.0/docs/api/stream.html) — Node.js v24.17.0。取得：2026-10-24T19:33:43.822Z。適用制限：取得がtruncated。close等の確認済み抜粋のみ使用。 保存：sources/node-lifecycle/05-node-v24-streams.md

14. [kill(2)](https://man7.org/linux/man-pages/man2/kill.2.html) — man-pages6.19; page date2026-06-05。取得：2026-10-24T19:33:18.965Z。適用制限：Linux/POSIX group。Windowsへ流用不可。 保存：sources/node-lifecycle/04-linux-kill-manpage.md

15. [Windows Job Objects](https://raw.githubusercontent.com/MicrosoftDocs/win32/docs/desktop-src/ProcThread/job-objects.md) — MicrosoftDocs mutable docs branch; ms.date2025-07-14。取得：2026-10-24T19:35:01.904Z。適用制限：default inheritance/breakaway/nesting/通知非保証/last handleを確認。 保存：sources/gap-windows/01-job-objects.md

16. [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) — Windows API; 文書日UNKNOWN。取得：2026-10-24T19:32:29.902Z。適用制限：実際のWindows Electronでassign成功は未検証。 保存：sources/windows-monitor/01-assign-process-to-job-object.md

17. [Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags) — Windows API; page date2025-07-14。取得：2026-10-24T19:35:33.159Z。適用制限：CREATE_SUSPENDEDはprimary threadがResumeThreadまで実行しない。 保存：sources/gap-windows/04-process-creation-flags.md

18. [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) — Windows API; updated2022-10-31。取得：2026-10-24T19:32:53.088Z。適用制限：creation timestamp。running時のexit time未定義。 保存：sources/windows-monitor/08-get-process-times.md

19. [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject) — Windows API; 文書日UNKNOWN。取得：2026-10-24T19:32:59.657Z。適用制限：handle wait。並行close不可。 保存：sources/windows-monitor/09-wait-for-single-object.md

20. [Process Working Set](https://learn.microsoft.com/en-us/windows/win32/procthread/process-working-set) — Windows docs; updated2025-07-14。取得：2026-10-24T19:32:42.152Z。適用制限：共有/私有resident page。private commitと異なる。 保存：sources/windows-monitor/07-process-working-set.md

21. [PROCESS_MEMORY_COUNTERS_EX](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex) — Windows API; updated2024-02-22。取得：2026-10-24T19:35:06.347Z。適用制限：WorkingSetSize/PrivateUsageの区別。 保存：sources/gap-windows/02-process-memory-counters.md

22. [React useLayoutEffect](https://react.dev/reference/react/useLayoutEffect) — mutable; 文書日/version UNKNOWN。取得：2026-10-24T19:32:46.912Z。適用制限：DOM commit後/repaint前。GPU完了保証ではない。 保存：sources/react-webgl/02-react-use-layout-effect.md

23. [Pixel-perfect rendering with devicePixelContentBox](https://web.dev/articles/device-pixel-content-box) — Google technical article;2020-07-07。取得：2026-10-24T19:33:37.785Z。適用制限：Chrome84の記述は歴史的support情報。 保存：sources/react-webgl/08-device-pixel-content-box.md

24. [WebGL drawingBufferWidth](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawingBufferWidth) — MDN; last modified2024-09-28。取得：2026-10-24T19:33:43.452Z。適用制限：actual buffer dimension。presentationではない。 保存：sources/react-webgl/09-webgl-drawing-buffer.md

25. [Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing) — latest; example Playwright1.52.0。取得：2026-10-24T19:33:23.295Z。適用制限：実験的連携。導入だけで所有権が成立するとはしない。 保存：sources/electron-lifecycle/04-electron-automated-testing.md

26. [Playwright Electron API](https://playwright.dev/docs/api/class-electron) — latest; 文書日UNKNOWN。取得：2026-10-24T19:33:45.928Z。適用制限：experimental。closeの内部Electron API呼出しは未確認。 保存：sources/electron-lifecycle/07-playwright-electron-api.md

27. [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) — latest; 文書日UNKNOWN。取得：2026-10-24T19:33:27.295Z。適用制限：mutable guidance。固定v45 sourceとは区別。 保存：sources/electron-lifecycle/05-electron-security.md

28. [Electron webContents API](https://raw.githubusercontent.com/electron/electron/v45.0.0/docs/api/web-contents.md) — v45.0.0 tag; 文書日UNKNOWN。取得：2026-10-24T19:33:57.935Z。適用制限：render-process-gone。自動再起動の保証ではない。 保存：sources/electron-lifecycle/08-electron-45-web-contents.md

29. [Electron utilityProcess API](https://github.com/electron/electron/blob/v45.0.0/docs/api/utility-process.md) — v45.0.0 tag; capture reported2026-10-13。取得：2026-10-24T19:33:18.169Z。適用制限：serviceNameは識別補助、所有/終了証明ではない。 保存：sources/electron-lifecycle/03-electron-45-utility-process.md

30. [Windows Performance Recorder introduction](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/windows-performance-recorder) — Windows ADK/WPT; updated2022-04-21。取得：2026-10-24T19:35:10.335Z。適用制限：ETW-based。各provider/profileの取得項目は別検証。 保存：sources/gap-windows/03-wpr-etw.md

31. [Electron v45.0.0 release](https://releases.electronjs.org/release/v45.0.0) — Electron45.0.0; Chromium156.0.8078.48; Node24.22.0。取得：2026-10-24T19:34:51.192Z。適用制限：検索snippet Oct20 / 取得本文 Oct21の日付差。version組合せは一致。 保存：sources/exact-electron45-release.md
