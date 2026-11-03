# メインスレッド停止の調査・最小修正

2026-11-03。作業開始時 HEAD: `cccd0e81e459b84583443dc7c6f7ece6efc36bfb`。この報告の変更は未公開。

## 報告

- 実施内容：本番ログ・保存データの読み取り調査、区間計算と約定読取の最小修正、停止診断追加、隔離日次再構築・独立数量照合。
- 変更ファイル：下記「変更内容」。既存差分をreset・再適用していない。正本仕様・依存・Run・デプロイ構成・`scripts/src/`は変更なし。
- 確認手順：本番コピー→旧・新関数比較→隔離保存経路→元約定の独立再集計→関連試験・型検査・ビルド。
- 実行した確認：306試験中305合格・DB試験1件skip、両型検査・ビルド成功。詳細は下記。
- 仕様との差分：依頼の診断と最小修正。ユーザーの回答「しなくていい」に従い、前後各60分測定は実施していない。CT16:55の不完全保存／CT17:05の成熟後再集計は維持。
- 未解決・懸念：公開での全停止・高CPU・欠けの解消は未確認。隔離日次も欠けを残す。24時間の運用条件はまだ合格としていない。
- 次の候補：ユーザーが反映を判断した後、追加診断で公開24時間を確認する。今回は公開操作をしない。

## 1. 公開から確認できたこと

本番テレメトリーの読み取り専用調査。主な対象は11/03 12:10–13:10 UTC、再接続12:32:50–12:33:40、11/02 21:50–23:30および翌13:10まで。

| 記録 | 結果 |
|---|---|
| 11/03 12:40:33.746 | loop p99 44,253ms、親CPU 1.110 cores、otherParent 1.099、history child 0.000023、live 0.0106 |
| 12:32:54.478 | loop p99 51,771ms |
| 12:40:54.463 | receiveResumed=18、history admission待ち63回／1,610,882ms、backfill running |
| 13:09:28 | receiveResumed=47、待ち141回／3,312,420ms |
| 再接続 | 12:32:56.720 close1001、指定待ち995ms、12:33:15.699 connecting、12:33:34.683 open。close→open 37.963秒 |
| hub | 累積205に対し、この検索範囲で詳細ログ33件。30件はclosedBeforeCallback=true、readyState=2。205件全体との照合不能 |
| 11/02日次 | NQ/GCとも22:55:36 UTC（CT16:55）にrecorded_only開始、23:06:34もbuild中。その後の完了・保存はログ上確認できない |

otherParentは関数の特定ではなく、低いchild CPUから履歴が原因とも断定できない。再接続は設定38秒ではなく、接続試行とopenの両方が遅れていた。切断直前の停止と整合するが、公開の全原因確定とはしない。send失敗は「閉じ始めた後のcallback」の証拠であり、閉じたpeerへの新規送信の証拠とは別。

VM/privateの公開が存在することは確認。ビルド記録の作成12:09:07／更新12:13:44、2GiB・0.5vCPU、12:12:59–12:13:21のhealth-checkエラー27件は確認したが、記録にGit SHAがないため公開ソースの版は推定しない。cgroup throttle計測は利用不可であり、CPU quotaの影響も排除していない。

## 2. 同期処理の候補と根拠

| 関数・経路 | 起動条件／入力規模 | 判断・所要時間の根拠 |
|---|---|---|
| `trade-history.ts coverageSegments` | VP／日次の各読取窓。NQ tick coverage 21,342区間、GC 12,555区間 | 各境界で全endpointをflat/filter/spreadする二乗処理。実コピーでNQ約17.8秒、GC約12.1秒を再現。修正対象 |
| `readRecordedTradeRange`／`readTradeRange` | coverageが細かい日次・VP復元 | 境界ごとに時間ファイルを再走査。隔離再構築を一度中止して確認。900秒以下の物理窓で1回読む方式へ修正 |
| `LocalStore.recordedTickCoverage`・`AppStore`のunion/intersect・coverage保存 | 履歴保存／復元。約1.0MBの2銘柄coverage | 配列整合処理とJSON化の候補。今回の数十秒停止としては特定していない |
| `AppStore`の一覧・queue・hour復元／merge | 起動・履歴補完・時間切替 | 待ち行列とI/O、JSON処理の候補。全面変更していない |
| `LongObjects.initialize/day/save/remember` | 日次・LRU。対象日のJSON約350–527KB、gzip約75–105KB | gzipSync/gunzipSync、JSON parse/stringify、検証・bytes算出。単独100ms超は今回未特定 |
| `AppLongVp.buildRange`／`LongAggregate` | 保存約定を日次再集計 | 細分化読取を含む。修正後の実再構築はNQ約17.4秒、GC約4.6秒の**非同期処理全体**。単一同期停止時間ではない |
| `Pipeline`のVP／指標、range組立、Hub JSON化・圧縮 | ライブ・初期履歴・範囲要求 | 大きい応答／再集計は候補。保存形式・間引き・通信方式を変更していない |
| `/api/status`の状態作成／sanitize／JSON化 | 状態取得・診断 | 候補だが数十秒の再現なし。診断自体のCPU増分は下記 |
| `MemoryMonitor.saveProfile`の既存allocation sampling要約・JSON化 | 既存定期診断 | ツリー規模依存。今回の根因として未特定。ヒープスナップショットを追加していない |

上表の未測定候補を、推定だけでfork化・全面書換えしていない。`scripts/src/`や常用パスへの同期外部コマンド追加なし。

## 3. 本番コピーと短時間比較

`server/tools/perf/main-thread-snapshot.mjs`。本番App Storageはlist/exists/downloadのみ。coverage、LONGVP、設定と直近48時間の存在する約定・列を193ファイル／15,634,949 bytesコピーした。全オブジェクトが同一瞬間のtransactional snapshotとは保証しない。コピー中の取得時刻・元キー・bytes・SHA-256は`data/dev/main-thread-snapshot/manifest.json`。

| 元ファイル | SHA-256 |
|---|---|
| `prod/coverage.json` | `08b8718273650a0039699699a638a3ae49911f411507be835dd5848ec402644b` |
| `prod/instruments/GC/coverage.json` | `6d9fb80f92af01723a5391aba45f30add94be5dd88f8d85c85dd36eb3656dee5` |

`main-thread-evidence.mjs`は旧アルゴリズムを関数として保持し、同じ入力で各3回、同一結果をassert。単一関数・隔離測定であり、60分サーバー比較ではない。CPUプロファイルは同一プロセスのinspector Session、5,000µs sampling。集計は`data/dev/main-thread-evidence/*-summary.json`。測定外の結果照合もprofileには含まれるため、その比較関数のCPUを製品のCPUと扱わない。

| 入力 | 旧 wall ms（3回） | 新 wall ms（3回） | 結果 |
|---|---|---|---|
| 合成3730区間 | 1104.27 / 1157.53 / 1054.03 | 4.48 / 1.84 / 3.79 | 7460 segment一致 |
| 本番NQ 10/30 | 97.43 / 90.20 / 46.33 | 1.49 / 1.41 / 1.46 | 16 segment一致 |
| 本番NQ 11/02 | 17741.83 / 17638.86 / 17787.54 | 2.08 / 5.63 / 2.17 | 14586 segment一致 |
| 本番GC 10/30 | 172.03 / 175.21 / 178.42 | 0.27 / 0.23 / 0.26 | 250 segment一致 |
| 本番GC 11/02 | 11969.08 / 12083.45 / 11978.04 | 12.04 / 2.09 / 2.54 | 16376 segment一致 |

各runのprocess CPU、RSS、時間は`result.json`に保存。観測RSS最大343,842,816 bytesは旧・新を同一プロセスで順次実行した値で、独立した本番RSS予測ではない。

診断hookの合成20,000 Promise callback比較は、無効wall 5.37ms／CPU 5.51ms、有効wall 56.05ms／CPU 86.58ms。無視できるゼロコストではない。常用のCPU増分は未確認。resource名は最大65,536、長いcallback最新50、GC最新60秒／最大16,384イベント、summary最新3で上限を持つ。名を追えない停止はunknown扱い。名前付きasync callbackの包含時間は相互に加算しない。

## 4. 変更内容

- `server/src/vp/trade-history.ts`：`coverageSegments`をendpoint sweepへ変更。重なり・隣接・半開境界・無効範囲の旧境界出力を維持。`readRecordedTradeRange`は欠け判定と物理読取を分離。`readTradeRange`も900秒以下の窓を1回読み、採用可能区間を二分探索する。失敗区間を無条件採用せず、成功した補完と既存coverageだけを使う。読取sessionはfinallyでclose。`fileWindows`は実際の物理窓の読取回数となる。
- `server/src/diagnostics/main-thread.ts`：`process.threadCpuUsage`、process CPUとの差、ELU、GC60秒集計、heap統計、200ms以上のcallback名・開始・長さ・CPU、unknown loop stall。非対応環境はnullと利用不可表示で起動継続。
- `server/src/diagnostics/cpu-profile.ts`：10分内2回の5秒停止で同一プロセスCPU profileを180秒、5000µs sampling。1時間最大1回。self上位30／total上位20を最新3件。要約は分割してyield。gzipをprod/devの`diagnostics/cpuprofile/`へ保存、生成したprofileだけ最新5件。終了時に自分のSessionを閉じる。外部inspect port、`inspector.open`、`--inspect`、ヒープsnapshotは使わない。
- `MemoryMonitor`／`index.ts`：statusと既存5秒ログへ追加。profileの秘密値検査は実行環境内のみ。秘密値／JSON escape済み秘密値が含まれるchunkは書く前に拒否し、失敗時は一時ファイルを除去する。キー値・環境変数一覧はログ／報告しない。
- `store/objects.ts`：診断profile保持数のためだけの削除。`prod|dev/diagnostics/cpuprofile/<数字>-<数字>.cpuprofile.json.gz`以外は削除不可。市場データの期限削除は追加していない。
- `long-vp/day.ts`：CT16–17の予定休止を品質のgapsから除く。実際に休止中に存在する約定は、従来どおり終わる側の日に含む。CT17の日次境界・17:05成熟は変更なし。
- `app-service.ts`／`objects.ts`：成熟前のcheckpointはcomplete:falseを保つ。休止をfake gapとして足さず、gapsが空でも未成熟なら不完全を許容する。日次保存形式は同じ。
- `upstream/connection.ts`：ping間隔最大・ping/pong age、remote close reason、再接続の設定待ちと実際の試行待ち／timer超過／openまでを分けて記録。元の1秒±20%等のbackoffは変更なし。上流pingに確認できる時刻がない場合、時計差はnull／not_availableとし推測しない。
- `hub/hub.ts`：send失敗にpeer・phase・reqIdに加えframe種別・bytes。closed後callback失敗と新規送信を区別する。既存closed判定は維持。
- `pipeline.ts`／`store/local.ts`／`status/app.ts`／LONGVP・upstream・Hub：非同期処理の役割名を付けるだけで、単一親writer・queue・認証・プロトコルを変更していない。
- `work-cpu.ts`：threadCpuUsageのない環境で安全に継続。

## 5. LONGVPの欠け・11/02の隔離再構築

コピーした10/30の品質gapsと予定休止の重なりを確認：NQ（3730 gaps）・GC（2906 gaps）の両方に3600秒の休止が入っていた。今回の修正はこの偽の欠けだけを除き、実欠けを消さない。

`main-thread-rebuild.mjs`はコピーをimmutable sourceとし、Objects adapterの出力を`data/dev/main-thread-rebuild/objects/dev/`だけに限定。GET `/roll`の読み取り専用metadataでNQの限月開始を検証し、GCは原約定の明示限月を使用。履歴REST・実上流WSは禁止したまま。通常のAppStore／AppLongVp build／LongObjects.save・再読込を使用した。実上流への追加接続・本番の保存・修復はしていない。

| 11/02 | 件数 | 枚数（買／売／不明） | build+save | 残るgaps | 完全性 |
|---|---:|---:|---:|---:|---|
| NQZ6 | 247,447 | 267,477（131,709／135,768／0） | 17,434.6ms | 7293 | complete:false |
| GCZ6 | 66,236 | 72,030（36,549／35,481／0） | 4,625.4ms | 8188 | complete:false |

`main-thread-reconcile.mjs`で元gzipを別経路のストリームから独立に数え直し、件数・枚数・価格別数量が一致。

| 銘柄 | 元約定＝保存日次の価格別数量SHA-256 |
|---|---|
| NQ | `2848509cc74c562c3b15abc5b19504dc7d649ca6bac71370dae2b6f658a79769` |
| GC | `7720cc9e3961b510f4b3b684ef16a2559b67f37f0c6c601f96bf9016d7c013fd` |

隔離生成gzipのSHA-256：NQ `7a261c313ae9c72a87cafbfba627d3b05d31ce9efef1be1a186f8489ff133384`、GC `6091f859777e88884f1f0844e6a8e7b97391671321bbc3e55b983e30129dfc53`。

この再構築の約27秒観測：main 0.861 cores、process 1.102、auxiliary 0.241、ELU 0.874。200ms以上callback／loop stall記録0。used heap約219.4MB。**これは高CPUを解消した証拠ではない**。50ms上限・p99≤100ms・本番定常CPU≤0.3をこの結果だけで保証しない。

## 6. 確認・再現コマンド

```sh
node server/tools/perf/main-thread-snapshot.mjs
node server/tools/perf/main-thread-evidence.mjs
node server/tools/perf/main-thread-rebuild.mjs
node server/tools/perf/main-thread-reconcile.mjs
pnpm --filter @workspace/receiver run typecheck
env -u DATABASE_URL node --test --test-concurrency=1 server/test/*.test.ts
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/receiver run build
```

306試験・305合格・1 skip（外部DBを使う試験）。先行の一回は開発DBの一時テーブル試験も合格し、永続テーブルを変更していない。最終確認は接続なしに限定した。

追加試験：旧sweepとの100入力比較、3730区間、1000個のcoverage境界でも物理窓1読取、正当な同内容別約定・巻き戻る時刻・限月・例外close、CT休止・DST・17:05、不完全checkpoint、プロファイルのself/total・秘密拒否・自動起動・1時間抑制・summary3／gzip5の保持・Session終了、thread CPU非対応、callback計測。

既存LONGVP・history・VP・指標・Hub実WS・再接続・設定の関連試験を実行した。長い実ブラウザ／1台30分範囲表示・前後各60分・実ライブの再確認はしていない。今回ブラウザは起動していない。

再構築の初回は細分化再走査でCPUが継続したため自分の処理だけを中止し、窓1読取の修正後に実行し直した。既存受信は停止・再起動していない。自分のsnapshot／関数測定／再構築／照合／試験は終了し、対応プロセス・検証ブラウザの残存なし。検証用HTTP／WSサーバーは新規常駐させていない。

## 7. 公開後に確認する条件と戻し方（今回実行しない）

- 対応サーバーの反映はユーザー判断。今回フロント／通信形式変更なし。公開版のGit SHA照合は依然未成立。
- 24時間：loop p99≤100ms／max≤1000ms、watchdog判定0、200ms以上のnamed callbackは少数、通常CPU≤0.3 cores、backfill30分以内、VP waiting解消、実欠けの補完を確認する。
- 設定GET/PUT、LONGVPの連続60秒更新、最新約定の鮮度、再接続のconfigured/attempt/open、sendErrorのpeer/frame/bytesも見る。
- 未達なら保存したprofileの関数別self/totalから次の最小修正を決める。CPU quota、未追跡同期処理、診断hookの費用も除外していない。VM変更の提案で原因を代替しない。
- 戻す場合はこのサーバー差分に限定し、後続差分を巻き戻さない。市場データの移行・削除・形式変更は行っていないので、そのための逆移行は不要。隔離生成物を本番へ自動コピーする手順は追加していない。
