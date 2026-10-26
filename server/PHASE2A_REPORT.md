# Phase 2a 報告

測定日：2026-10-26。以下、特記しない時刻は日本時間（JST）。

## 報告

- 実施内容：ライブと履歴の共通検査・1秒列集計、3時間バックフィル、ローカル保存・読戻し・7日削除を実装。取引時間中に取り込みを完了し、その後10分以上受信して保存内容を再照合した。サーバーは停止済み。
- 変更ファイル：次節に一覧。追加依存パッケージは **なし**。
- 確認手順：本報告と `data/phase2a-checks/verification.json` を開く。保存ファイルは `data/columns/NQ/1s/` と `data/trades/NQ/`。通信しない再確認はプロジェクト直下から `pnpm --filter @workspace/receiver test` と `pnpm --filter @workspace/receiver run typecheck`。サーバー停止中なので `/api/status` は応答しない。再起動すると新たに上流へ接続するため、今回の確認のために再起動しない。
- 実行した確認：単体テスト30件成功（従来17件＋追加13件）、型検査成功、ライブ受信、履歴180窓の取得、保存列の再取得照合、2分間のライブ・履歴比較、SIGTERMとcloseログの確認。詳細は下記。
- 仕様との差分：SPECでは【案】の7日削除はユーザーの明示回答で確定し実装した。仕様にない同一時刻2,400行の履歴板は2組を構造不正として拒否し、内容を推測して選ばなかった。取得したデータの欠けは補完していない。
- 未解決・懸念：履歴68秒・ライブ1秒の欠け、2,400行の扱い、APIが最新60秒を0行で返した原因、終了close 1006の原因、フィード全体の完全性。下記のとおり、観測結果と推測を区別する。
- 次の候補：2,400行の扱いをユーザーが判断すること。その後のPhase 2bは別の依頼で行う。今回は実装しない。

## 1. 事前作業と承認

- 許可された添付 `attached_assets/SPEC_(4)_1793023897380.md` を、内容を変えず `docs/SPEC.md` に配置した。
- 確認結果：

```text
487c8eae1508e682822acac21d1fa8785c2b1afaa7547219895c5456fb6207eb  docs/SPEC.md
```

- 配置後、上記添付の旧コピーを削除した。仕様の読取元は `replit.md` と `docs/` のみ。
- 7日より古いローカル保存ファイルの削除は、ユーザー回答「削除を確定事項として採用する」による。SPECの【案】表記自体は変更していない。
- 検査の共通化、保存順序、通信失敗時の扱いを含む計画は、ユーザー回答「この計画で実装する」により承認された。
- 追加パッケージ：なし。App Storage、DB、デプロイ設定、`scripts/src/`、`/ws`、リプレイ、画面は変更・実装していない。
- `.replit` の設定値は変更していない。Run操作後に末尾改行のみの差分が見られたが、今回直さなくてよいとの指示に従い手動修正していない。

## 2. 作成・変更ファイルと役割

| ファイル | 主な関数・クラスと役割 |
| --- | --- |
| `docs/SPEC.md` | 許可された新版のバイト同一配置のみ |
| `server/src/ingest/normalize.ts` | `normalizeTime`、`normalizePrice`、`normalizeBook`：時刻・価格・板検査をライブと履歴で共通化 |
| `server/src/ingest/receiver.ts` | `Receiver`：共通検査への委譲、採用済み板・約定の通知、共有seqの受け渡し。従来テスト17件を維持 |
| `server/src/aggregate/columns.ts` | `ColumnAggregator.accept/expire/finish`：その秒の最後の板、次秒またはS+3秒で確定。空秒を作らない |
| `server/src/store/binary.ts` | `encodeColumns/decodeColumns`：指定LEバイナリ形式。秒の厳密な昇順とレコード構造を検査 |
| `server/src/store/local.ts` | `Store`、`LocalStore`：列・約定の保存、UTC時間別整列、gzip、`readColumns/readTrades`、coverage、7日削除 |
| `server/src/history/decode.ts` | `historyColumns/historyTrades`：半開区間、800/1,600行組立、共通検査、同じ列集計。約定を内容で重複除去しない |
| `server/src/history/client.ts` | `HistoryClient.get`：逐次REST、limit=500000、truncated取得、429待機、30秒タイムアウト、通信/5xx失敗時60秒待機、その他4xx停止 |
| `server/src/history/backfill.ts` | `Backfill`、`missingRuns`：L前3時間を新しい60秒窓から取得。保存済みは再取得せず、truncated時は分割 |
| `server/src/pipeline.ts` | `Pipeline`：ライブ・履歴・保存の接続、最初の確定列L、欠け区間、状態、終了時flush |
| `server/src/status/app.ts` | 状態応答に `phase2a` を追加 |
| `server/src/index.ts` | Pipelineの初期化、受信通知と終了処理の接続 |
| `server/test/phase2a.test.ts` | 通信しない追加13テスト。ダミーと明示 |
| `server/tools/verify-phase2a.ts` | 停止後の読戻し、ランダム3秒再取得、2分比較。WebSocketを開始せず生板は保存しない |
| `server/PHASE2A_REPORT.md` | この報告 |
| `replit.md` | Current Status節への結果追記のみ |
| `.agents/memory/local-retention.md`、`.agents/memory/MEMORY.md` | ユーザーが確定した7日削除の判断を記録 |
| `.agents/memory/tickstream-cautions.md` | 実測で同時刻の履歴が同一内容とは限らないことを記録 |

保存順序：履歴を取り込むUTC時間のデータは保留し、対象時間の取得が済んだ段階で既存・履歴・ライブを秒の昇順に統合して保存する。同じ秒の既存列は上書きしない。I/Oは単一キューで直列化する。時間終了後の列はgzipし元のbinを削除する。現在のUTC時間は未圧縮bin。約定はgzip JSONLとする。

## 3. 実行した確認

```text
pnpm --filter @workspace/receiver run typecheck
  → tsc --noEmit 成功

pnpm --filter @workspace/receiver test
  → tests 30 / pass 30 / fail 0

node --check server/tools/verify-phase2a.ts
  → 成功（補助ツールの初稿に対して実行）

node --experimental-strip-types server/tools/verify-phase2a.ts
  → 成功。最終版ツールで実ファイル読戻し・REST再照合を実行

sha256sum docs/SPEC.md
  → 上記の指定ハッシュと一致
```

追加テストでは、同秒最後の板・次秒/S+3確定・空秒・不正板拒否・800/同一1600/異なる1600行・半開区間・約定重複保持・LE往復・逆向き履歴の昇順保存・保存済み再取得省略・7日削除・429待機・truncated分割/1秒でも切詰めの場合の停止を確認した。

`git diff --check` はGit保護による `.git/index.lock` 制限で完了できなかった。Git保護を回避していない。この失敗を型検査・テスト成功とは混同しない。

今回はAPIとファイル処理のみで、画面変更はない。ブラウザ試験・画面キャプチャは実施していない。

## 4. 受信・取り込みの時刻と件数

既存の `artifacts/api-server: API Server` を使用。起動前に他のTICK STREAM受信プロセスがないことを確認した。ライブWebSocketは1本、RESTは並列にしていない。

| 項目 | 結果 |
| --- | --- |
| 上流open | 23:26:58.671（`1793024818671000` µs） |
| 最初の確定列 L | `1793024818` = 23:26:58 |
| 履歴対象 | `[1793014018,1793024818)` = 20:26:58〜23:26:58 |
| バックフィル開始 | 23:26:59.421 |
| バックフィル終了 | 23:37:54.273 |
| 所要時間 | **654,852ms = 10分54.852秒** |
| 窓 | 180/180完了、REST 360回（板180＋約定180） |
| 取得行 | 板34,278,400行、約定179,302行（窓境界で除外する応答行を含む） |
| 再取得省略 / 0行応答 / 分割 | 0 / 2 / 0。0行は最新窓の板・約定それぞれ |
| RESTエラー / 待機 | 0 / 0 |
| 完了後受信 | 621,195ms = 10分21.195秒（停止前の状態取得まで） |
| 停止前のライブ | 板5,074件、約定32,020件 |
| 再接続 | 0回 |
| warning / feed / error / ticks_lagged | いずれも0件 |
| SIGTERM | 23:48:15.470 |
| upstream close / server stopped | 23:48:15.733 / 23:48:15.734 |

つなぎ目Lの約定は接続前部分が欠けうる。補完・捏造していない。共有seqには履歴約定も入るため、ライブseqの飛びだけでは約定欠落を意味しない。

履歴検査の主な件数：

| 事象 | 件数・扱い |
| --- | --- |
| 採用板 | 42,055スナップショット |
| 採用約定 | 176,971件 |
| 交差板 | 3件、板を拒否 |
| 約定時刻巻き戻り | 7件、約定を拒否 |
| 同一1,600行 | 51組、1回分のみ |
| 異なる1,600行 | 22組、後半を採用 |
| 2,400行 | 2組、invalidMessageとして板を拒否 |
| rejectedBook / rejectedTrade | 5 / 7 |
| サイズ0以下・並び順違反・価格重複・ティック外 | すべて0 |

2,400行のts：`1793023241740041`、`1793021528665417`。1,600行の違いは800行全体で比較しているため、状態の実例で先頭1行が同じでも他の段が異なることがある。

## 5. 読戻しと欠け

履歴3時間の10,800秒中、保存列は **10,732列**、列のない秒は **68秒**。半開区間で示す。

| 開始秒 | 終了秒 | JSTの区間 | 秒数 |
| --- | --- | --- | --- |
| 1793015025 | 1793015026 | 20:43:45〜20:43:46 | 1 |
| 1793015257 | 1793015258 | 20:47:37〜20:47:38 | 1 |
| 1793015298 | 1793015299 | 20:48:18〜20:48:19 | 1 |
| 1793015564 | 1793015565 | 20:52:44〜20:52:45 | 1 |
| 1793016757 | 1793016758 | 21:12:37〜21:12:38 | 1 |
| 1793020963 | 1793020964 | 22:22:43〜22:22:44 | 1 |
| 1793021865 | 1793021866 | 22:37:45〜22:37:46 | 1 |
| 1793023669 | 1793023670 | 23:07:49〜23:07:50 | 1 |
| 1793024758 | 1793024818 | 23:25:58〜23:26:58 | 60 |

- 最後の60秒は取得時に履歴APIが0行を返した最新窓。休場だったと判断する根拠はない。履歴反映の遅れの可能性はあるが、これは**推測**であり原因を確認したわけではない。今回は再取得・補完しなかった。
- その他8秒の原因も特定していない。休止時間で説明できるとは扱っていない。
- ライブの欠け：`[1793026075,1793026076)`（23:47:55〜23:47:56）の1秒。`no_accepted_live_book` として状態とログに記録。再接続・板検査違反はなかったが、原因を特定していない。
- 停止時の未確定秒 `1793026095`（23:48:15）は次秒到着/S+3を満たさないため列として保存していない。最後の確定保存列は `1793026094`。上記ライブ途中欠け1秒とは別。

### ランダム3秒の再取得照合

該当する60秒窓を改めてREST取得し、同じ検査と集計を通した列を保存列と全段比較した。価格はティック整数。

| 秒 | JST | 保存・再取得の最良買い（価格/枚数） | 最良売り（価格/枚数） | 全段一致 |
| --- | --- | --- | --- | --- |
| 1793016366 | 21:06:06 | 117301 / 1 | 117305 / 2 | 一致 |
| 1793017288 | 21:21:28 | 117257 / 2 | 117260 / 1 | 一致 |
| 1793015465 | 20:51:05 | 116917 / 1 | 116922 / 1 | 一致 |

### ライブ対履歴の2分比較

- 対象：`[1793025540,1793025660)` = **23:39:00〜23:41:00**。バックフィル完了後の受信区間内。
- ライブ120列、再取得履歴120列、両方にある120秒を比較。
- 最良買い/売りの価格と枚数：**120/120 = 100%一致**。
- 全段の価格と枚数：**120/120 = 100%一致**。
- 不一致例：**なし**。不一致秒がないため3例は提示できない。例を捏造していない。
- この2分で一致したことは、他区間の一致・全配信の完全性を保証しない。
- 同区間の保存約定は3,693件を読戻せた。
- 再照合RESTは合計5回、板971,200行、エラー・待機0。ライブ受信用WebSocketを再開していない。
- 詳細：`data/phase2a-checks/verification.json`。

## 6. 保存ファイル

停止・flush後、列4ファイル＋約定4ファイル＝**8ファイル、22,129,965バイト**。coverageと確認用JSONはこの合計に含めない。pendingは列・約定とも0。

| ファイル | バイト |
| --- | ---: |
| `data/columns/NQ/1s/2026-10-26/11.bin.gz` | 319516 |
| `data/columns/NQ/1s/2026-10-26/12.bin.gz` | 562424 |
| `data/columns/NQ/1s/2026-10-26/13.bin.gz` | 967442 |
| `data/columns/NQ/1s/2026-10-26/14.bin` | 18156697 |
| `data/trades/NQ/2026-10-26/11.jsonl.gz` | 106714 |
| `data/trades/NQ/2026-10-26/12.jsonl.gz` | 232181 |
| `data/trades/NQ/2026-10-26/13.jsonl.gz` | 932376 |
| `data/trades/NQ/2026-10-26/14.jsonl.gz` | 852615 |

UTC14時はまだ終わっていないため14.binは非圧縮。過去UTC時間はgzip済み。読戻しではレコード構造と昇順の検査を通った。`data/` は既存の `.gitignore` と `.replitignore` で除外されている。

## 7. 状態ページの実出力

### 取り込み中

保存元：`data/phase2a-checks/status-during.json`。23:27:19頃、6/180窓。対象UTC時間を保留中なのでファイル0・pendingありはこの時点の状態。

```json
{"upstream":{"state":"open","connectedAtUs":1793024818671000,"lastReceivedUs":1793024839431000,"reconnectCount":0,"lastClose":null,"retryDelayMs":null},"byType":{"welcome":1,"ping":2,"tick":463,"book":82},"counts":{"nonPositiveBookLevels":0,"crossedBook":0,"bookOrder":0,"duplicatePrice":0,"offTick":0,"timestampRollback":0,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":0,"unknownType":0,"rejectedBook":0,"rejectedTrade":0,"acceptedBook":82,"acceptedTrade":463,"disconnects":0,"abnormalClose":0,"watchdog":0},"examples":{},"lagIntervals":[],"book":{"tsUs":1793024839000000,"recvUs":1793024839371000,"source":"live","bestBid":{"price":117330,"size":3},"bestAsk":{"price":117333,"size":2},"bidDepth":400,"askDepth":400},"tradeCount":463,"recentTrades":[{"tsUs":1793024837000000,"recvUs":1793024837918000,"seq":6803,"price":117319,"size":1,"side":"sell"},{"tsUs":1793024838000000,"recvUs":1793024838614000,"seq":6804,"price":117329,"size":1,"side":"buy"},{"tsUs":1793024838000000,"recvUs":1793024839019000,"seq":6805,"price":117331,"size":1,"side":"sell"},{"tsUs":1793024838000000,"recvUs":1793024839032000,"seq":6806,"price":117333,"size":1,"side":"buy"},{"tsUs":1793024839000000,"recvUs":1793024839431000,"seq":8981,"price":117334,"size":1,"side":"buy"}],"units":{"time":"Unix microseconds (integer)","price":"NQ ticks (0.25)"},"phase2a":{"seamL":1793024818,"backfill":{"state":"running","startSec":1793014018,"endSec":1793024818,"totalWindows":180,"completedWindows":6,"skippedRequests":0,"emptyRequests":2,"splitRequests":0,"startedAtUs":1793024819421000,"finishedAtUs":null,"elapsedMs":20128,"lastError":null},"historyNetwork":{"requests":13,"fetchedBookRows":968000,"fetchedTradeRows":8628,"errors":0,"waits":0,"waitUntilUs":null,"lastError":null},"historyCounts":{"nonPositiveBookLevels":0,"crossedBook":0,"bookOrder":0,"duplicatePrice":0,"offTick":0,"timestampRollback":0,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":0,"unknownType":0,"rejectedBook":0,"rejectedTrade":0,"acceptedBook":1194,"acceptedTrade":8518,"disconnects":0,"abnormalClose":0,"watchdog":0},"historyExamples":{},"storage":{"files":0,"bytes":0,"latestColumnSec":null,"pendingColumns":321,"pendingTrades":8978},"storageError":null,"liveGaps":[],"unconfirmedSecond":1793024839}}
```

### 取り込み完了直後

保存元：`data/phase2a-checks/status-after-backfill.json`。23:37:54頃。出力中の件数はこの瞬間の値で、停止後の総数とは異なる。

```json
{"upstream":{"state":"open","connectedAtUs":1793024818671000,"lastReceivedUs":1793025474481000,"reconnectCount":0,"lastClose":null,"retryDelayMs":null},"byType":{"welcome":1,"ping":44,"tick":14481,"book":2608},"counts":{"nonPositiveBookLevels":0,"crossedBook":0,"bookOrder":0,"duplicatePrice":0,"offTick":0,"timestampRollback":0,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":0,"unknownType":0,"rejectedBook":0,"rejectedTrade":0,"acceptedBook":2608,"acceptedTrade":14481,"disconnects":0,"abnormalClose":0,"watchdog":0},"examples":{},"lagIntervals":[],"book":{"tsUs":1793025473000000,"recvUs":1793025474470000,"source":"live","bestBid":{"price":117376,"size":2},"bestAsk":{"price":117381,"size":2},"bidDepth":400,"askDepth":400},"tradeCount":1000,"recentTrades":[{"tsUs":1793025473000000,"recvUs":1793025474391000,"seq":191448,"price":117378,"size":1,"side":"sell"},{"tsUs":1793025473000000,"recvUs":1793025474409000,"seq":191449,"price":117375,"size":1,"side":"sell"},{"tsUs":1793025473000000,"recvUs":1793025474440000,"seq":191450,"price":117382,"size":1,"side":"buy"},{"tsUs":1793025474000000,"recvUs":1793025474477000,"seq":191451,"price":117379,"size":1,"side":"sell"},{"tsUs":1793025474000000,"recvUs":1793025474481000,"seq":191452,"price":117381,"size":1,"side":"buy"}],"units":{"time":"Unix microseconds (integer)","price":"NQ ticks (0.25)"},"phase2a":{"seamL":1793024818,"backfill":{"state":"complete","startSec":1793014018,"endSec":1793024818,"totalWindows":180,"completedWindows":180,"skippedRequests":0,"emptyRequests":2,"splitRequests":0,"startedAtUs":1793024819421000,"finishedAtUs":1793025474273000,"elapsedMs":654852,"lastError":null},"historyNetwork":{"requests":360,"fetchedBookRows":34278400,"fetchedTradeRows":179302,"errors":0,"waits":0,"waitUntilUs":null,"lastError":null},"historyCounts":{"nonPositiveBookLevels":0,"crossedBook":3,"bookOrder":0,"duplicatePrice":0,"offTick":0,"timestampRollback":7,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":2,"unknownType":0,"rejectedBook":5,"rejectedTrade":7,"acceptedBook":42055,"acceptedTrade":176971,"disconnects":0,"abnormalClose":0,"watchdog":0,"historyDoubledSame":51,"historyDoubledDifferent":22},"historyExamples":{"historyDoubledSame":[{"tsUs":1793023792915119,"first":{"ts":1793023792915119,"side":"bid","level":1,"price":29229.5,"size":1,"flag":0},"second":{"ts":1793023792915119,"side":"bid","level":1,"price":29229.5,"size":1,"flag":0}},{"tsUs":1793021402682454,"first":{"ts":1793021402682454,"side":"bid","level":1,"price":29212.5,"size":1,"flag":0},"second":{"ts":1793021402682454,"side":"bid","level":1,"price":29212.5,"size":1,"flag":0}},{"tsUs":1793020837653518,"first":{"ts":1793020837653518,"side":"bid","level":1,"price":29250.25,"size":1,"flag":0},"second":{"ts":1793020837653518,"side":"bid","level":1,"price":29250.25,"size":1,"flag":0}},{"tsUs":1793020477255191,"first":{"ts":1793020477255191,"side":"bid","level":1,"price":29281.5,"size":2,"flag":0},"second":{"ts":1793020477255191,"side":"bid","level":1,"price":29281.5,"size":2,"flag":0}},{"tsUs":1793020407267180,"first":{"ts":1793020407267180,"side":"bid","level":1,"price":29278.5,"size":1,"flag":0},"second":{"ts":1793020407267180,"side":"bid","level":1,"price":29278.5,"size":1,"flag":0}}],"invalidMessage":[{"type":"history_book","reason":"snapshot_row_count","rows":2400,"ts":1793023241740041},{"type":"history_book","reason":"snapshot_row_count","rows":2400,"ts":1793021528665417}],"historyDoubledDifferent":[{"tsUs":1793023067029167,"first":{"ts":1793023067029167,"side":"bid","level":1,"price":29217,"size":1,"flag":0},"second":{"ts":1793023067029167,"side":"bid","level":1,"price":29217,"size":1,"flag":0}},{"tsUs":1793022665318785,"first":{"ts":1793022665318785,"side":"bid","level":1,"price":29282.5,"size":1,"flag":0},"second":{"ts":1793022665318785,"side":"bid","level":1,"price":29279,"size":1,"flag":0}},{"tsUs":1793022465783882,"first":{"ts":1793022465783882,"side":"bid","level":1,"price":29226,"size":1,"flag":0},"second":{"ts":1793022465783882,"side":"bid","level":1,"price":29226,"size":1,"flag":0}},{"tsUs":1793022165280682,"first":{"ts":1793022165280682,"side":"bid","level":1,"price":29289,"size":3,"flag":0},"second":{"ts":1793022165280682,"side":"bid","level":1,"price":29288.5,"size":3,"flag":0}},{"tsUs":1793022003460045,"first":{"ts":1793022003460045,"side":"bid","level":1,"price":29301.5,"size":4,"flag":0},"second":{"ts":1793022003460045,"side":"bid","level":1,"price":29301.5,"size":4,"flag":0}}],"timestampRollback":[{"type":"history_tick","tsUs":1793022283620713,"previous":1793022283620714},{"type":"history_tick","tsUs":1793022283620713,"previous":1793022283620714},{"type":"history_tick","tsUs":1793021401117638,"previous":1793021401117670},{"type":"history_tick","tsUs":1793016560926969,"previous":1793016560926970},{"type":"history_tick","tsUs":1793015377837790,"previous":1793015377837793}],"crossedBook":[{"bestBid":116805,"bestAsk":116803,"recvUs":1793021512242562},{"bestBid":116850,"bestAsk":116843,"recvUs":1793021402442880},{"bestBid":116850,"bestAsk":116840,"recvUs":1793021416440166}]},"storage":{"files":8,"bytes":17973733,"latestColumnSec":1793025472,"pendingColumns":0,"pendingTrades":0},"storageError":null,"liveGaps":[],"unconfirmedSecond":1793025473}}
```

10分以上継続後・停止直前の全出力は `data/phase2a-checks/status-after-10min.json` に保存。保存サイズはこの状態取得時には22,123,339バイト・最新列1793026093、停止flush後には22,129,965バイト・最新列1793026094となった。

## 8. 停止ログ

```json
{"recvUs":1793026095470000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793026095471000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793026095733000,"event":"upstream_network_error","details":{"state":"closing"}}
{"recvUs":1793026095733000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793026095733000}}
{"recvUs":1793026095734000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793026095734000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

受信中の切断・再接続は0。終了要求後は1006で閉じた。これはPhase 0/1でも残っている未解決事象であり、正常close 1000が完了したとは記述しない。PID 4132の消滅も確認した。

`history_complete` ログは終了時刻を確定するfinallyより前に出るため、その1行だけでは `finishedAtUs:null`、`elapsedMs:645133` となっている。上の所要時間は、後続の完了状態応答と停止ログにある確定値654852msを使用した。ログの値を修正・隠蔽していない。

## 9. replit.md のCurrent Status追記

```text
2026-10-26：Phase 2aの列集計・履歴3時間取り込み・ローカル保存/読戻しを実装。単体テスト30件・型検査成功。履歴180窓を10分54.852秒で取得し、完了後10分21秒以上ライブ受信。保存列のランダム3秒は再取得と一致、ライブ/履歴2分は120/120秒で最良気配・全段一致。8ファイル22,129,965バイトを保存し、SIGTERM後の上流close（1006）・停止を確認。履歴68秒とライブ1秒の欠け、履歴2,400行2組の未対応、1006の原因は未解決。詳細はserver/PHASE2A_REPORT.md。Phase 2bには進んでいない。
```

Phase 2aの実装と指定の確認を終了する。欠け・未知の履歴形式を解決済みとは扱わず、ここで停止する。

## 修正（2026-10-26 以降）

実施日：2026-10-27 JST（UTCでは2026-10-26）。以下は今回の結果であり、上の初回報告は書き換えていない。

### 報告

- 実施内容：承認された4点（逆行約定保持、800行×N、通信失敗3回で欠け、直近0行の後回し再取得）を修正。旧保存データを削除後、取引時間中の3時間取り込みと保存照合を実施し、サーバーを停止した。
- 変更ファイル：下記一覧。追加依存なし。バイナリ列・Tradeの保存形式は変更していない。
- 確認手順：本節と `data/phase2a-fix-checks/verification.json`、`status-final.json`、`cleanup.json` を参照。サーバーは停止中。通信しない再確認は `pnpm --filter @workspace/receiver test` と `pnpm --filter @workspace/receiver run typecheck`。
- 実行した確認：42テスト成功、型検査成功、180窓の取り込み、列・約定の読戻し、前回実例のREST再取得照合、保護対象32ファイルのSHA-256不変確認、SIGTERM・上流close・プロセス消滅確認。
- 仕様との差分：なし。ただし、前回7件中、時刻が記録されていない2件は個別照合できない。承認どおり、記録のある5実例を照合し、今回の3時間外の実例は別の検証領域だけに保存した。
- 未解決・懸念：残存15秒の欠け、前回の未特定2件、終了close 1006の原因。実例の共有参照の一部が既存の安全化処理で `[circular]` 表記になる点と、取り込み初期ログの一部がログ保持範囲から落ちた点も下記に記載。
- 次の候補：0行ではない直近窓の末尾が部分的に欠ける場合の扱いを決めること。今回は補完・追加修正せず、Phase 2bにも進まない。

### 1. 新版SPECと修正方針

許可された添付 `attached_assets/SPEC_(5)_1793026662184.md` をバイト同一で配置し、ハッシュ確認後に添付コピーを削除した。

```text
5fe2a3d361c8f22caf4fded5a624b1cdfabb4e9224fa58c0dff0a130c54a768a  docs/SPEC.md
```

- 約定は直前に採用した約定より時刻が小さくても保持する。板は従来どおり拒否する。件数を `tradeTimestampRollback` と `bookTimestampRollback` に分けた。
- 約定のファイル書込みも時刻順への並べ替えをやめた。受信順で保存し、読戻しはseq順にする。内容による重複除去はしない。
- 同一tsの履歴を**API応答の並び順のまま800行ずつ**分ける。全組で両側level 1〜400・flag=0を検査し、最後の組を採用する。同じ/違うの件数・実例はN別とする。
- 通信/5xx/タイムアウトは初回を含む3回の失敗で、その種類・窓を `backfill.gaps` に記録する。取得済みにはせず次の窓へ進む。失敗1・2回目の後は各60秒待つ。429は従来のRetry-After規則で別扱い。その他4xx・1秒でもtruncatedは取り込みを停止する。
- 直近0行は板・約定別に `pendingEmpty` へ入れ、2分後に再取得する。**初回＋再取得3回＝最大4回**とする計画をユーザーが承認した。
- HTTP取得の合間に期限が来た後回し窓を処理する。待つだけの間は他の窓を進め、HTTP取得は同時に1本だけ。通常180窓の処理後も後回し窓があれば処理を続ける。対象時間の保存保留は後回し取得まで解放しない。

#### 800行の分け方の実データ根拠

修正前の調査で、前回の2,400行2実例をRESTから再取得した。いずれもtruncated=falseで、以下を確認した。生板は録画していない。

| ts（µs） | 同ts行数 | 応答順の800行×3組の検査 |
| --- | ---: | --- |
| 1793023241740041 | 2400 | 全3組がbid level 1〜400、ask level 1〜400を重複なく持つ |
| 1793021528665417 | 2400 | 同上 |

各組の先頭はbid level 1、末尾はask level 400だった。したがって、この実データは応答順に800行ずつ区切れる。今回の取り込みでも2,400行3組を構造検査して採用し、構造不正の組は0だった。

### 2. 変更ファイル・関数

| ファイル | 今回の変更 |
| --- | --- |
| `docs/SPEC.md` | 許可された新版の配置のみ |
| `server/src/ingest/receiver.ts` | `Receiver.rollback/trade`：逆行約定を棄却せず、板と別件数にする |
| `server/src/ingest/metrics.ts` | 板・約定の逆行件数を分離 |
| `server/src/history/decode.ts` | `historyColumns`：全800行組の検査と最後の組採用、N別件数・実例。`historyTrades`：逆行を保持 |
| `server/src/history/client.ts` | `HistoryClient.get`：失敗回数上限、60秒再試行。`WindowUnavailableError`：欠けとして継続する窓を識別。レスポンス本文読込の通信失敗も再試行対象 |
| `server/src/history/backfill.ts` | `Backfill.take/retryReady/run/snapshot`：失敗窓・データなし・後回し窓の状態、2分後の独立再取得、待ち中の他窓継続 |
| `server/src/store/local.ts` | `LocalStore.writeHour/readTrades`：約定の逆行を時刻順への並べ替えで消さず、受信順・seqを保持 |
| `server/test/receiver.test.ts` | 旧「板も約定も逆行拒否」を新仕様に変更。板の拒否・約定の保持を別々に検査 |
| `server/test/phase2a.test.ts` | N別件数名・板逆行件数名の期待値を変更。0行再取得の待機を偽時計で進めるよう変更 |
| `server/test/phase2a-fixes.test.ts` | 追加12テスト。逆行約定の実gzip順序、800×2/3の同・異、不完全組、板逆行、失敗3回、0行後回し、4xx停止 |
| `server/tools/verify-phase2a-fixes.ts` | 停止後の列・約定読戻し、旧実例照合、保護対象ファイル不変の確認。WebSocketを開始しない |
| `server/PHASE2A_REPORT.md` | 本節の末尾追記のみ |
| `replit.md` | Current Status節への追記のみ |
| `.agents/memory/` | 新仕様で古くなった「2,400行未定」「7日削除はSPEC上では案」のメモを整理し、承認された再試行回数の数え方を記録 |

`/ws`、リプレイ、画面、App Storage、DB、デプロイ設定、`scripts/src/`は変更していない。ライブの欠けを履歴で埋める処理は追加していない。

### 3. 旧保存データの削除と保護

削除したファイル：

```text
data/columns/NQ/1s/2026-10-26/11.bin.gz
data/columns/NQ/1s/2026-10-26/12.bin.gz
data/columns/NQ/1s/2026-10-26/13.bin.gz
data/columns/NQ/1s/2026-10-26/14.bin
data/trades/NQ/2026-10-26/11.jsonl.gz
data/trades/NQ/2026-10-26/12.jsonl.gz
data/trades/NQ/2026-10-26/13.jsonl.gz
data/trades/NQ/2026-10-26/14.jsonl.gz
data/coverage.json
```

`data/probe/`、`data/phase2a-checks/`、`data/phase1-soak/` の32ファイルは削除せず、削除前と最終検証時のSHA-256一致を確認した。記録は `data/phase2a-fix-checks/cleanup.json`。今回の検証記録は別ディレクトリに置き、前回記録を上書きしていない。

### 4. 単体テスト・型検査

```text
pnpm --filter @workspace/receiver run typecheck
→ tsc --noEmit 成功

pnpm --filter @workspace/receiver test
→ tests 42 / pass 42 / fail 0

node --check server/tools/verify-phase2a-fixes.ts
→ 成功

node server/tools/verify-phase2a-fixes.ts
→ 成功。停止後の実ファイル読戻し・REST照合を実行
```

既存テストの変更は新ルールに伴う期待値・時計の変更だけ。従来の板検査・接続試験は維持した。新しい0行テストは初回再取得で成功、3回目の再取得で成功、3回再取得しても0行の各場合を確認し、その間に古い窓と約定が先に進むことも確認した。通信失敗テストではネットワーク例外と503を混在させ、待機が60秒×2、3回目で欠け、次窓が保存されることを確認した。

ライブでは通信失敗が起きなかったため、「3回失敗して次へ進む」はダミー試験の確認であり、実APIの障害で実測した結果ではない。

### 5. ライブ確認の結果

| 項目 | 結果（JST） |
| --- | --- |
| 上流open | 2026-10-27 00:05:07.891 |
| L | 1793027108 = 00:05:08 |
| 対象 | `[1793016308,1793027108)` = 2026-10-26 21:05:08〜2026-10-27 00:05:08 |
| 取り込み開始 | 00:05:09.240 |
| 取り込み終了 | 00:13:23.808 |
| 所要時間 | **494,568ms = 8分14.568秒** |
| 窓 / REST | 180/180、368回（通常360＋0行再取得8） |
| API応答行 | 板34,675,200、約定227,721（半開区間で除く境界行を含む） |
| 通信エラー / 通信再試行 / 失敗上限窓 | **0 / 0 / 0** |
| 0行応答 / 0行再取得 | **8 / 8** |
| pendingEmpty / noData / gaps | 終了時すべて空 |
| 取り込み時の採用板 / 約定 | 42,584 / 224,168 |
| 停止前のライブ板 / 約定 | 1,992 / 8,833 |
| ライブの逆行板 / 逆行約定 / 再接続 | 0 / 0 / 0 |
| warning / feed / error / ticks_lagged | すべて0 |
| SIGTERM | 00:13:29.932 |
| 上流close・サーバー停止 | 00:13:30.066、close 1006 |

#### 5.1 L直前60秒と0行の再取得

L直前60秒 `[1793027048,1793027108)` は板・約定とも初回0行で後回しになった。直近4窓×板/約定＝8要求が後回しになり、すべて最初の再取得（通算2回目）で非空となった。

根拠：初期状態で後回し8要求を確認し、完了状態は0行応答8回・再取得8回・pendingEmptyなし・noDataなし。各要求を少なくとも1回再取得して解決する必要があるため、各1回で解決したと分かる。監視記録では00:08:19時点で後回し窓は解消済み。一部の初期取得ログはログ保持範囲から落ちており、各再取得の厳密な時刻を最終ログだけからは提示できない。

読戻しではL直前60秒に**60列、列のない秒0**。約定側も再取得後に取得済みとなり、データなし扱いではない。待ち中も履歴処理とライブ受信は進んだ。

#### 5.2 列のない秒

3時間10,800秒中、保存列 **10,785列**、列のない秒 **15秒**。

| 開始秒 | 終了秒 | JST（半開区間） | 秒数 |
| --- | --- | --- | ---: |
| 1793016757 | 1793016758 | 10-26 21:12:37〜21:12:38 | 1 |
| 1793020963 | 1793020964 | 10-26 22:22:43〜22:22:44 | 1 |
| 1793021865 | 1793021866 | 10-26 22:37:45〜22:37:46 | 1 |
| 1793023669 | 1793023670 | 10-26 23:07:49〜23:07:50 | 1 |
| 1793026075 | 1793026076 | 10-26 23:47:55〜23:47:56 | 1 |
| 1793026858 | 1793026868 | 10-27 00:00:58〜00:01:08 | 10 |

前回68秒に対して今回は15秒、数値差は53秒。ただし窓が移動している。前回の単発8秒のうち4秒は今回対象外、4秒は今回も欠けている。前回の末尾60秒は今回の保存列では欠けていない。今回新たに対象となった部分に1秒と10秒の欠けがある。したがって同一区間で53秒改善したとは評価しない。

最後の10秒は、初回に非空だった窓 `[1793026808,1793026868)` の末尾に当たり、「全体が0行」ではないので今回の再取得規則の対象にはならなかった。履歴反映途中の可能性はあるが**推測**。休場で説明できるとは確認していない。窓を追加再取得して補完する処理は今回の範囲外なので行っていない。

今回のライブ途中欠けは0。停止時の未確定秒1793027609は、次秒/S+3未成立のため保存していない。最新確定列は1793027608。

#### 5.3 800行×Nの件数

| N | 同じ組だけ | 違う組あり | 不完全・800倍数でない組 |
| --- | ---: | ---: | ---: |
| 2 | 27 | 18 | 0 |
| 3 | 0 | 3 | 0 |
| 4以上 | 0 | 0 | 0 |

構造不正による拒否は0。板全体の拒否3件は交差板によるもの。板の時刻巻き戻りは0。前回拒否した2,400行2実例も今回は構造を検査して採用した。

N=3の実例（価格は外部価格、各組の最良買い）：

| ts（µs） | 最初の組 | 最後の組 |
| --- | --- | --- |
| 1793026074530630 | 29480 / 2枚 | 29479.75 / 6枚 |
| 1793023241740041 | 29246 / 2枚 | 29244 / 1枚 |
| 1793021528665417 | 29177 / 1枚 | 29176.25 / 2枚 |

全実例は状態出力に残した。`difference.first/other` の一部は、外側のfirst/lastと同じオブジェクトを参照するため既存の安全化処理が `[circular]` と表示している。外側のfirst/lastの値は残っている。これを実データの循環構造や値の欠落と解釈しない。今回はログ処理の追加修正をしていない。

#### 5.4 約定の前後と保存照合

- 今回の履歴の逆行は **3回**、約定拒否 **0件**。
- 採用履歴約定224,168件と、対象3時間から読み戻した224,168件が一致した。
- 今回の逆行3実例のtsにある約定は、すべて保存されていた。
- 前回は、拒否したtsを次の比較基準にしなかった。同じ小さいtsが連続すると、同じ基準に対する逆行として複数回数えていた。今回は保持した直前約定と比較するため、同一tsの2件目は「巻き戻り」には数えない。両方の約定は保存する。さらに対象3時間も異なるため、前回7回と今回3回の件数を直接比較しない。

前回ログに残った5実例（4種類のts）の照合：

| ts（µs） | 前回の実例出現数 | 今回の保存先 | 再取得した同ts約定数 / 保存数 | 内容・件数 |
| --- | ---: | --- | --- | --- |
| 1793022283620713 | 2 | 本体保存 | 2 / 2 | 一致 |
| 1793021401117638 | 1 | 本体保存 | 1 / 1 | 一致 |
| 1793016560926969 | 1 | 本体保存 | 1 / 1 | 一致 |
| 1793015377837790 | 1 | 検証専用保存 | 3 / 3 | 一致 |

最後のtsは今回の3時間外なので、承認どおり `data/phase2a-fix-checks/old-example-store/` にだけ保存した。同じtsに3件あることを理由に重複除去していない。ts・価格・枚数・方向の列を再取得と照合したもので、取引IDで1件ずつ同定したという意味ではない。

前回の残り2実例は時刻が記録されていないため個別未確認。全7件が復元できたとは記載しない。

### 6. 保存

停止後の本体保存は列4＋約定4＝**8ファイル、10,003,996バイト**。確認用JSONと旧実例の検証専用保存は含めない。

| ファイル | バイト |
| --- | ---: |
| `data/columns/NQ/1s/2026-10-26/12.bin.gz` | 512291 |
| `data/columns/NQ/1s/2026-10-26/13.bin.gz` | 967442 |
| `data/columns/NQ/1s/2026-10-26/14.bin.gz` | 1058680 |
| `data/columns/NQ/1s/2026-10-26/15.bin` | 5120791 |
| `data/trades/NQ/2026-10-26/12.jsonl.gz` | 210290 |
| `data/trades/NQ/2026-10-26/13.jsonl.gz` | 937290 |
| `data/trades/NQ/2026-10-26/14.jsonl.gz` | 1014054 |
| `data/trades/NQ/2026-10-26/15.jsonl.gz` | 183158 |

### 7. 取り込み完了後の `/api/status`

保存元：`data/phase2a-fix-checks/status-final.json`。停止直前の実出力。停止時flush前のためサイズ10,003,903バイトであり、上記停止後のサイズとは93バイト異なる。

```json
{"upstream":{"state":"open","connectedAtUs":1793027107891000,"lastReceivedUs":1793027609791000,"reconnectCount":0,"lastClose":null,"retryDelayMs":null},"byType":{"welcome":1,"ping":34,"tick":8833,"book":1992},"counts":{"nonPositiveBookLevels":0,"crossedBook":0,"bookOrder":0,"duplicatePrice":0,"offTick":0,"bookTimestampRollback":0,"tradeTimestampRollback":0,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":0,"unknownType":0,"rejectedBook":0,"rejectedTrade":0,"acceptedBook":1992,"acceptedTrade":8833,"disconnects":0,"abnormalClose":0,"watchdog":0},"examples":{},"lagIntervals":[],"book":{"tsUs":1793027609000000,"recvUs":1793027609791000,"source":"live","bestBid":{"price":118081,"size":1},"bestAsk":{"price":118084,"size":3},"bidDepth":400,"askDepth":400},"tradeCount":1000,"recentTrades":[{"tsUs":1793027608000000,"recvUs":1793027608387000,"seq":232997,"price":118080,"size":1,"side":"buy"},{"tsUs":1793027608000000,"recvUs":1793027608736000,"seq":232998,"price":118083,"size":1,"side":"sell"},{"tsUs":1793027608000000,"recvUs":1793027609054000,"seq":232999,"price":118085,"size":1,"side":"buy"},{"tsUs":1793027608000000,"recvUs":1793027609101000,"seq":233000,"price":118082,"size":1,"side":"sell"},{"tsUs":1793027609000000,"recvUs":1793027609733000,"seq":233001,"price":118082,"size":1,"side":"sell"}],"units":{"time":"Unix microseconds (integer)","price":"NQ ticks (0.25)"},"phase2a":{"seamL":1793027108,"backfill":{"state":"complete","startSec":1793016308,"endSec":1793027108,"totalWindows":180,"completedWindows":180,"skippedRequests":0,"emptyRequests":8,"splitRequests":0,"startedAtUs":1793027109240000,"finishedAtUs":1793027603808000,"elapsedMs":494568,"lastError":null,"emptyRetries":8,"pendingEmpty":[],"noData":[],"gaps":[]},"historyNetwork":{"requests":368,"fetchedBookRows":34675200,"fetchedTradeRows":227721,"errors":0,"retries":0,"exhaustedRequests":0,"waits":0,"waitUntilUs":null,"lastError":null},"historyCounts":{"nonPositiveBookLevels":0,"crossedBook":3,"bookOrder":0,"duplicatePrice":0,"offTick":0,"bookTimestampRollback":0,"tradeTimestampRollback":3,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":0,"unknownType":0,"rejectedBook":3,"rejectedTrade":0,"acceptedBook":42584,"acceptedTrade":224168,"disconnects":0,"abnormalClose":0,"watchdog":0,"historyRepeated3Different":3,"historyRepeated2Different":18,"historyRepeated2Same":27},"historyExamples":{"historyRepeated3Different":[{"tsUs":1793026074530630,"repetitions":3,"first":{"ts":1793026074530630,"side":"bid","level":1,"price":29480,"size":2,"flag":0},"last":{"ts":1793026074530630,"side":"bid","level":1,"price":29479.75,"size":6,"flag":0},"difference":{"chunk":1,"row":0,"first":"[circular]","other":{"ts":1793026074530630,"side":"bid","level":1,"price":29479.75,"size":6,"flag":0}}},{"tsUs":1793023241740041,"repetitions":3,"first":{"ts":1793023241740041,"side":"bid","level":1,"price":29246,"size":2,"flag":0},"last":{"ts":1793023241740041,"side":"bid","level":1,"price":29244,"size":1,"flag":0},"difference":{"chunk":1,"row":0,"first":"[circular]","other":{"ts":1793023241740041,"side":"bid","level":1,"price":29244,"size":1,"flag":0}}},{"tsUs":1793021528665417,"repetitions":3,"first":{"ts":1793021528665417,"side":"bid","level":1,"price":29177,"size":1,"flag":0},"last":{"ts":1793021528665417,"side":"bid","level":1,"price":29176.25,"size":2,"flag":0},"difference":{"chunk":1,"row":0,"first":"[circular]","other":{"ts":1793021528665417,"side":"bid","level":1,"price":29176.25,"size":2,"flag":0}}}],"historyRepeated2Different":[{"tsUs":1793025473032057,"repetitions":2,"first":{"ts":1793025473032057,"side":"bid","level":1,"price":29344,"size":2,"flag":0},"last":{"ts":1793025473032057,"side":"bid","level":1,"price":29344,"size":2,"flag":0},"difference":{"chunk":1,"row":400,"first":{"ts":1793025473032057,"side":"ask","level":1,"price":29345,"size":2,"flag":0},"other":{"ts":1793025473032057,"side":"ask","level":1,"price":29345.25,"size":2,"flag":0}}},{"tsUs":1793023067029167,"repetitions":2,"first":{"ts":1793023067029167,"side":"bid","level":1,"price":29217,"size":1,"flag":0},"last":{"ts":1793023067029167,"side":"bid","level":1,"price":29217,"size":1,"flag":0},"difference":{"chunk":1,"row":400,"first":{"ts":1793023067029167,"side":"ask","level":1,"price":29217.75,"size":3,"flag":0},"other":{"ts":1793023067029167,"side":"ask","level":1,"price":29218,"size":4,"flag":0}}},{"tsUs":1793022665318785,"repetitions":2,"first":{"ts":1793022665318785,"side":"bid","level":1,"price":29282.5,"size":1,"flag":0},"last":{"ts":1793022665318785,"side":"bid","level":1,"price":29279,"size":1,"flag":0},"difference":{"chunk":1,"row":0,"first":"[circular]","other":"[circular]"}},{"tsUs":1793022465783882,"repetitions":2,"first":{"ts":1793022465783882,"side":"bid","level":1,"price":29226,"size":1,"flag":0},"last":{"ts":1793022465783882,"side":"bid","level":1,"price":29226,"size":1,"flag":0},"difference":{"chunk":1,"row":400,"first":{"ts":1793022465783882,"side":"ask","level":1,"price":29226.75,"size":1,"flag":0},"other":{"ts":1793022465783882,"side":"ask","level":1,"price":29227,"size":3,"flag":0}}},{"tsUs":1793022165280682,"repetitions":2,"first":{"ts":1793022165280682,"side":"bid","level":1,"price":29289,"size":3,"flag":0},"last":{"ts":1793022165280682,"side":"bid","level":1,"price":29288.5,"size":3,"flag":0},"difference":{"chunk":1,"row":0,"first":"[circular]","other":"[circular]"}}],"historyRepeated2Same":[{"tsUs":1793023792915119,"repetitions":2,"first":{"ts":1793023792915119,"side":"bid","level":1,"price":29229.5,"size":1,"flag":0},"last":{"ts":1793023792915119,"side":"bid","level":1,"price":29229.5,"size":1,"flag":0},"difference":null},{"tsUs":1793021402682454,"repetitions":2,"first":{"ts":1793021402682454,"side":"bid","level":1,"price":29212.5,"size":1,"flag":0},"last":{"ts":1793021402682454,"side":"bid","level":1,"price":29212.5,"size":1,"flag":0},"difference":null},{"tsUs":1793020837653518,"repetitions":2,"first":{"ts":1793020837653518,"side":"bid","level":1,"price":29250.25,"size":1,"flag":0},"last":{"ts":1793020837653518,"side":"bid","level":1,"price":29250.25,"size":1,"flag":0},"difference":null},{"tsUs":1793020477255191,"repetitions":2,"first":{"ts":1793020477255191,"side":"bid","level":1,"price":29281.5,"size":2,"flag":0},"last":{"ts":1793020477255191,"side":"bid","level":1,"price":29281.5,"size":2,"flag":0},"difference":null},{"tsUs":1793020407267180,"repetitions":2,"first":{"ts":1793020407267180,"side":"bid","level":1,"price":29278.5,"size":1,"flag":0},"last":{"ts":1793020407267180,"side":"bid","level":1,"price":29278.5,"size":1,"flag":0},"difference":null}],"tradeTimestampRollback":[{"type":"history_tick","tsUs":1793022283620713,"previous":1793022283620714},{"type":"history_tick","tsUs":1793021401117638,"previous":1793021401117670},{"type":"history_tick","tsUs":1793016560926969,"previous":1793016560926970}],"crossedBook":[{"bestBid":116805,"bestAsk":116803,"recvUs":1793021512242562},{"bestBid":116850,"bestAsk":116840,"recvUs":1793021416440166},{"bestBid":116850,"bestAsk":116843,"recvUs":1793021402442880}]},"storage":{"files":8,"bytes":10003903,"latestColumnSec":1793027608,"pendingColumns":0,"pendingTrades":0},"storageError":null,"liveGaps":[],"unconfirmedSecond":1793027609}}
```

### 8. 停止確認

```json
{"recvUs":1793027609932000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793027609933000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793027610066000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793027610066000}}
{"recvUs":1793027610066000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793027610066000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

受信中の切断0。終了時は既知の未解決1006で閉じた。PID 4985の消滅も確認した。取り込み完了ログと最終状態の所要時間はfinallyによる確定時刻の違いで1ms異なるため、ここでは最終状態の494568msを使用した。

### 9. Current Status追記

```text
2026-10-27：Phase 2aの4点を修正。逆行約定を保持し、履歴800行×Nの最後の完全な組を採用。通信失敗3回で欠けを記録、直近0行は板/約定別に後回し再取得。42テスト・型検査成功。3時間180窓を8分14.568秒で取得し、L直前60秒は最初の再取得で回復、履歴の欠け15秒。逆行約定3回を含め224,168件の履歴約定の保存を確認。旧実例5件のtsを照合、未記録2件は未確認。8ファイル10,003,996バイトを保存し、SIGTERM後close1006・停止を確認。詳細はserver/PHASE2A_REPORT.md末尾。Phase 2bは未着手。
```

4点の修正と今回の指定確認を終了し、ここで停止する。
