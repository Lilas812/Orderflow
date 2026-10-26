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
