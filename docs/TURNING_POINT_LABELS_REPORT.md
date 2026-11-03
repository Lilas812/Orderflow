# 転換点マーク・派生特徴ZIPの実装／隔離確認

日付：2026-11-04（JST）。開始時HEAD：`e9103cc2c4dd931a8eadced2678dec20765452de`。
検証時HEAD：`85554af5bdf3f9762504337a9432ef41ca027e8d`＋本タスクの作業差分。途中のチェックポイントをresetせず保持。
本番書込・Publish・既存受信の再起動・実上流への追加接続は行わない。
この報告の「クラウド保存」の実行確認は隔離した世代付きI/Oであり、本番App Storageへの書込確認ではない。

## 実施内容

- HEATMAP／FOOTPRINT共通の手動マーク、編集・削除、NQ／GCの分離、作成時点の文脈記録を追加。
- `{prod|dev}/labels/{symbol}.json`への親プロセスによるCAS保存と、既存nice19子での保存済みデータからの派生特徴計算・ZIP書出しを追加。
- 原約定・板・既存集計の保存形式、購読、リプレイ、既存の最新表示・CVD／VWAPは保持。仕様書本文は変更していない。
- 追加依存なし。依存マニフェスト・lockfile・デプロイ設定は変更していない。

## 変更ファイルと責務

| ファイル | 主な関数・変更 |
|---|---|
| `lib/market/labels.ts` | `validDraft`、`labelContext`、`approachBefore`、共有型・上限 |
| `server/src/labels/store.ts` | `LabelsStore.get/mutate`：読取失敗を不存在と区別、世代照合・CAS・保存後の同世代再読取 |
| `server/src/labels/routes.ts` | `/api/labels`のGET／POST／PUT／DELETE、`/export`のZIP応答・中断・後始末 |
| `server/src/labels/features.ts` | `DayData`、`calculate`、`boardFeatures`、`valueArea`：セッション・数量・価格・板特徴と結果 |
| `server/src/labels/reader.ts` | `readDay`、`immutableLease`、`enrichProfiles/Boards/Divergence`：ストリーム読取と版照合 |
| `server/src/labels/export.ts` | `exportLabels`：マーク、同条件ランダム対照、ニアミス、同一CSV列と欠損理由 |
| `server/src/labels/zip.ts` | Node標準機能による3エントリー限定のストリームZIP |
| `server/src/history/process.ts` | `labelsExport`：既存の直列nice19子を共有。取消時は所有入力処理の完了を待つ |
| `server/src/history/child.ts` | `labels_export`の処理。RESTクライアント・APIキーを使わず、完了IPCは小さな結果だけ |
| `server/src/store/local.ts` | `labelHourInput`：書込キューと直列に独立コピー。未保存coverageを使わず、本文不在を既知0にしない |
| `server/src/store/app.ts` | `labelHourInput`：既存hydrateとpinを利用。読取失敗を受信writerの障害へ昇格させない |
| `server/src/status/app.ts`、`server/src/index.ts` | 任意のlabelsサービスを既存HTTPルートへ接続。旧呼出側の互換を維持 |
| `artifacts/heatmap/src/labels/ui.ts`、`labels.css`、`pure.ts` | `mountLabelsUi`：共通ボタン・ダイアログ・独立DPRオーバーレイ・保存／競合／読取失敗・ZIP |
| `artifacts/heatmap/src/main.ts`、`footprint/app.ts` | 現在の座標系・銘柄・リプレイ位置へ接続。マーク描画のために板を再集計しない |
| `artifacts/heatmap/src/data/trade-aggregate.ts`、`footprint/model.ts` | 全約定配列の複製なしで、選択時刻より前の接近方向を取り出す |
| `server/test/labels.test.ts`、`labels-cloud-fixture.ts` | 数式・境界・CAS・不確定保存・対照・中断・ZIPの隔離試験 |
| `server/test/footprint-zoom-fixture.ts` | `--labels-test`時だけfakeクラウドと実ラベルハンドラーを有効化。原本には書き込まない |
| `artifacts/heatmap/test/labels-ui.test.ts` | 未確定方向・UTC書出し範囲のUI補助ロジック |

## 確認手順

1. 対応フロントとサーバーをそろえて起動する。HEATMAPかFOOTPRINTでNQ／GCを選ぶ。
2. 左の「転換点をマーク」を押し、価格領域をクリック／タップ。天井／底／抜けた、確信度、任意メモを保存する。
3. 「抜けた」は天井のつもり／底のつもりも指定する。過去価格が不足して自動判定できない場合は明示選択が必要。
4. マークを押して編集・削除。もう一方の画面や再読込後も同じ銘柄の保存マークを確認する。
5. 「特徴データを書き出す」で銘柄とUTC開始日・終了日（両日含む）を選ぶ。CSVの空欄は`missing_reasons`、対照不足は`summary.json`を見る。
6. 設定が読めないときは保存不可。503等で保存結果が不明なときは再読込し、保存済みか確認してから再試行する。初期値で上書きしない。

## 計算・保全

- 特徴は秒`tsSec`未満だけ。結果1／5／15分と対照の選定条件で使う未来は、特徴とは分離する。
- CT17:00セッションとDST。前セッションは通常の週末を除き、確認できた空セッションだけを飛ばす。不明な取引日を飛び越えて過去の高安を前セッションと断定しない。
- 既知の無約定秒だけ直前の実価格を保持。coverage欠け、本文不在、限月混在は0埋めしない。限月不明を既知限月へ接続・0調整しない。
- N約定は数量・プロファイルへ含め、買い売り、CVD等の方向特徴から外す。正当な同内容の別約定を除重しない。
- RV＝1秒終値変化の二乗和の平方根。CVD傾き＝600秒OLS×60。速度z-score＝直近60秒を前29本の60秒件数に対して母標準偏差で評価し、標準偏差0は空欄。
- POC同量は高値、VA70%、隣接出来高同量は上優先。VWAPは全方向の数量を使用。
- 吸収らしさ＝接近側60秒数量÷（接近方向の正の終値変化＋1ティック）。推定取消は同時刻・同価格の全約定数量を引く。公表深度の外は0ではなく不明。
- 正確な極値到達順が必要なCVD乖離だけ、300秒ずつ時刻・シーケンス順へ並べる。1窓10万行超なら当該特徴を空欄とし理由を出す。他の特徴まで捨てない。
- ランダム対照は同銘柄・同CT30分枠・同RV五分位、異なるセッションから最大3個。異なるイベントの限月が違うだけで対照候補を除外せず、各イベント内部の混在を防ぐ。
- ニアミスは同セッションの新30分高値／安値。印の前後15分全レンジの半分（切上げ、最低1tick）まで15分で戻らなかった候補。15分観測が重なる候補を重複採用しない。範囲不足は不足のまま。
- 原ファイルは読取専用。親は時間ファイルを要求専用ディスクへコピーし、子がストリーム読取・ハッシュ照合。同じ時間の版が変われば混ぜずに失敗する。開始時の開いているUTC時間は同じディスクコピーをジョブ終了まで保持する。
- 一度に1書出し、子heap上限256MiB。原約定の月全体をRAMへ載せない。ただし期間全体のRV分位算出用数値は保持するため、複数月・上限件数の容量は別途確認が必要。
- APIキー・原約定列・板配列はZIPに出さない。ZIPは`events.csv`、`columns.md`、`summary.json`だけ。文字列の式先頭はCSVで無効化する。

## 仕様にない値・今回優先した決定

1. UI仕様3.1の「アイコン2個のみ／描画ツールを追加しない」に対し、今回承認のマーク／書出し操作を優先。仕様書本文は改変していない。
2. 「抜けた」は期待方向を区別。直前の異なる2つの実価格が上昇なら「天井のつもり」、下降なら「底のつもり」。選択時刻以後は参照しない。不足時に固定値で代用しない。
3. `futureSeconds`＝作成時に既に分かっていた最新市場データ時刻（リプレイは再生位置）−マーク秒、最低0。受信の壁時計や、ユーザーが以前に未来を見たかという個人の記憶ではない。
4. live＝追従かつ最新から2秒以内、blind＝リプレイ位置と同じ秒、その他hindsight。位置を巻き戻して以前見た未来を「見なかった」ことを保証する分類ではない。
5. マーク12 CSS px。天井赤`#ff7474`▽、底青`#61b5ff`△、抜けた橙`#ffc857`×。確信度初期2、メモ200 Unicode文字、銘柄当たり10,000件、同時書出し1件。
6. 書出しはUTC日単位の両端日を含む。欠け・0標準偏差・対照不足は補わない。上記のRV、CVD傾き、z-score、吸収・取消・対照・Rの定義はユーザー承認の計画を使用。

## 実行した確認

コマンド：

```sh
node --test --test-concurrency=1 server/test/*.test.ts
node --test --test-concurrency=1 server/test/labels.test.ts
pnpm --filter @workspace/heatmap test
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/heatmap run build
node server/test/footprint-zoom-fixture.ts --port=18886 --labels-test
```

- 既存を含むサーバー335/335成功。その後の追加1件と同モジュールの最小修正は、専用14/14で追試。
- フロント最終199/199、両型検査、本番用フロントビルド成功。競合確認は特定の`updatedUs`にだけ有効とし、確認後の再更新・不確定POSTの回復でも新しい版を無断上書きしない試験を追加した。
- CAS同時保存は1件だけ勝ち、不一致は409。保存後照合だけ失敗した場合は503で「結果不明」、再読込・同じID再送でも1件のまま。
- 同じ内容の正当な別約定、巻き戻り、未知方向、既知無約定と欠損、CT17と25時間DST、板の深度外を確認。
- 未来の数量・価格・限月を変更しても前特徴が不変。結果側は変化／算出不能になり、別限月を無調整で接続しない。
- 明示した4セッションの合成入力の計算試験では、ランダム対照3件が別々のセッション・同枠・同五分位で採用。適合ニアミスがない場合は0件。実保存コピーの不足をこの合成試験で「補完済み」とは扱わない。
- 実nice19子の空書出し、入力処理中の取消、取消後の次ジョブ、ZIP CRC・3エントリー・CSV全行同一列数も確認。

### 実画面・実保存コピー・CPU

入力は`data/gpu-heatmap/production-input/manifest.json`に記録された保存コピー。画面の範囲は **2026-10-29 17:42〜18:42 UTC**（翌日02:42〜03:42 JST）。書出しはUTC **10/29 00:00〜10/30 00:00の半開区間**で、要求範囲内に現存する時間コピーを読んだ。画面の1時間だけでセッション全体がそろったとは扱っていない。

- `run.json`：ブラウザの操作・期待値・結果・終了証拠。
- [NQ HEATMAPの実画面](evidence/turning-point-labels/nq-heatmap-five-labels.png)／[GC FOOTPRINTの実画面](evidence/turning-point-labels/gc-footprint-five-labels.png)。
- NQ：5件＝天井2・底2・抜けた1（HEATMAP3、FOOTPRINT2）、最終世代8。
- GC：5件＝天井2・底2・抜けた1（FOOTPRINT5）、最終世代7。GC HEATMAPはコピー範囲の板が表示できず`Loading 1 range(s)`。そこでの配置は未確認であり、作成したことにしていない。
- 信頼度・メモを付けてUIから作成、編集後のGET照合、余分な1件のUI削除、両画面でのNQ共有、再読込を確認。
- 再生位置03:25 JSTでNQ5件、03:20へ戻すと過去の1件だけ描画。未来の4件を非描画。
- 同時更新はGC世代5→6の後、初回保存で競合を表示して入力を保持。明示再試行だけで世代7になり件数5のまま。
- 読取503の注入時、既存のマーク・入力を保持し、新規配置／保存／削除は禁止。注入解除後に再読込成功。想定した503リソースエラー2件以外のアプリconsoleエラーなし。
- UIでNQ ZIPのダウンロードを確認。その後NQ／GCを実ハンドラー経由で書き出し、`unzip -t`で全3ファイルのCRC成功。
- HTTP書出しの専用一時ディレクトリが作られたことを観測してから中断。所有ディレクトリ残存0、次の書出し成功。通常終了時も残存0。
- 原本コピー**36ファイルすべて**をmanifestのSHA-256へ再照合し、一致。ファイル名・ハッシュは`evidence/turning-point-labels/input-hashes.json`。

測定コマンド：`node server/test/labels-export-benchmark.mjs`。

| 対象 | 書出し時間 | 親CPU user＋system | 親CPU平均/core | loop遅れ最大 | 親RSS 前→後 | 子RSS終了時 | ZIP |
|---|---:|---:|---:|---:|---:|---:|---:|
| NQ・5マーク | 3,587.9ms | 449.0ms | 0.125 | 12.12ms | 496.1→498.8MiB | 222.0MiB | 35,353B |
| GC・5マーク | 1,129.7ms | 733.4ms | 0.649 | 10.85ms | 499.6→496.6MiB | 275.9MiB | 32,005B |

詳細は`export-metrics.json`。子PID7151、nice19、heap上限256MiB。RSSはheapだけでなくネイティブ領域を含み、256MiB以内という意味ではない。親RSSはfixtureの原データ事前読込も含み、製品の起動RSSや機能単体のメモリ増加と混同しない。

**測定の限界：** fixtureの時計は固定で、接続したNQリプレイWSは1接続あるが測定中の更新メッセージは0件だった。従ってこれは書出し時の親CPU／loopの測定であり、同時ライブ受信・高流量時の証拠ではない。通常接続の最初の測定も`export-metrics-idle.json`に残した。50ms以上のloop遅れはこの短い測定では検出しなかったが、各callbackの全入力規模での保証ではない。GCの親CPUが相対的に多い理由は未分解。

### CSV列と出力例

62列。メタ情報18列、時間3列、値動き4列、位置8列、約定15列、板8列、結果6列。全行で同じ列順。詳しい単位・式はZIPの`columns.md`。数量／価格系列の元レコードや板配列は含まない。

以下はCSVの先頭2行をそのまま掲載。先頭4行の保存物は[NQ](evidence/turning-point-labels/NQ.events-head.csv)／[GC](evidence/turning-point-labels/GC.events-head.csv)。

#### NQ

```csv
row_type,matched_mark_id,id,label,symbol,tsSec,priceTicks,confidence,note,viewMode,screen,expectedDirection,futureSeconds,createdUs,updatedUs,contract,quality,missing_reasons,session,minutes_from_ct17,minutes_from_us_open,rv_5m,rv_30m,range_30m,direction_30m,distance_session_high,distance_session_low,distance_previous_high,distance_previous_low,distance_poc,distance_vah,distance_val,distance_round,buy_30s,sell_30s,delta_30s,buy_60s,sell_60s,delta_60s,buy_5m,sell_5m,delta_5m,cvd_slope_10m,cvd_divergence,count_z_60s,max_size_5m,sweep_seconds_5m,absorption_60s,imbalance_1,imbalance_5,imbalance_10,bid10_change_60s,ask10_change_60s,near_size,near_change_60s,estimated_pull_60s,move_1m,move_5m,move_15m,favorable_15m,adverse_15m,crossed_15m
mark,184e5116-a87e-49c8-a7fa-f5cef277fc25,184e5116-a87e-49c8-a7fa-f5cef277fc25,top,NQ,1793297980,117908,3,NQ UI mark 1: top,hindsight,heatmap,down,320,1793739921463000,1793739921463000,UNKNOWN,partial|contract_unknown,"{""rv_5m"":""coverage_contract_or_reference_price"",""rv_30m"":""coverage_contract_or_reference_price"",""range_30m"":""incomplete_tick_coverage"",""direction_30m"":""coverage_contract_or_zero_range"",""distance_session_high"":""incomplete_tick_coverage"",""distance_session_low"":""incomplete_tick_coverage"",""distance_previous_high"":""previous_session_coverage_or_contract_unknown"",""distance_previous_low"":""previous_session_coverage_or_contract_unknown"",""distance_poc"":""data_unavailable"",""distance_vah"":""data_unavailable"",""distance_val"":""data_unavailable"",""buy_5m"":""coverage_or_contract_mixed"",""sell_5m"":""coverage_or_contract_mixed"",""delta_5m"":""coverage_or_contract_mixed"",""cvd_slope_10m"":""data_unavailable"",""cvd_divergence"":""data_unavailable"",""count_z_60s"":""data_unavailable"",""max_size_5m"":""data_unavailable"",""sweep_seconds_5m"":""data_unavailable"",""estimated_pull_60s"":""unknown_published_depth_shift"",""move_1m"":""incomplete_future_or_contract_mixed"",""move_5m"":""incomplete_future_or_contract_mixed"",""move_15m"":""incomplete_future_or_contract_mixed"",""favorable_15m"":""data_unavailable"",""adverse_15m"":""data_unavailable"",""crossed_15m"":""data_unavailable""}",us_day,1219.6666666666667,289.6666666666667,,,,,,,,,,,,-92,114,136,-22,256,259,-3,,,,,,,,,36.57142857142857,0.5,0.17647058823529413,-0.21951219512195122,-8,-2,3,-11,,,,,,,
```

#### GC

```csv
row_type,matched_mark_id,id,label,symbol,tsSec,priceTicks,confidence,note,viewMode,screen,expectedDirection,futureSeconds,createdUs,updatedUs,contract,quality,missing_reasons,session,minutes_from_ct17,minutes_from_us_open,rv_5m,rv_30m,range_30m,direction_30m,distance_session_high,distance_session_low,distance_previous_high,distance_previous_low,distance_poc,distance_vah,distance_val,distance_round,buy_30s,sell_30s,delta_30s,buy_60s,sell_60s,delta_60s,buy_5m,sell_5m,delta_5m,cvd_slope_10m,cvd_divergence,count_z_60s,max_size_5m,sweep_seconds_5m,absorption_60s,imbalance_1,imbalance_5,imbalance_10,bid10_change_60s,ask10_change_60s,near_size,near_change_60s,estimated_pull_60s,move_1m,move_5m,move_15m,favorable_15m,adverse_15m,crossed_15m
mark,666d0a86-3ec7-469b-bb78-5714813b4637,666d0a86-3ec7-469b-bb78-5714813b4637,bottom,GC,1793298279,40184,3,GC user edit: preserve across CAS conflict,hindsight,footprint,up,21,1793740198114000,1793740443261000,GCZ6,partial,"{""rv_5m"":""coverage_contract_or_reference_price"",""rv_30m"":""coverage_contract_or_reference_price"",""range_30m"":""incomplete_tick_coverage"",""direction_30m"":""coverage_contract_or_zero_range"",""distance_session_high"":""incomplete_tick_coverage"",""distance_session_low"":""incomplete_tick_coverage"",""distance_previous_high"":""data_unavailable"",""distance_previous_low"":""data_unavailable"",""distance_poc"":""data_unavailable"",""distance_vah"":""data_unavailable"",""distance_val"":""data_unavailable"",""buy_30s"":""coverage_or_contract_mixed"",""sell_30s"":""coverage_or_contract_mixed"",""delta_30s"":""coverage_or_contract_mixed"",""buy_60s"":""coverage_or_contract_mixed"",""sell_60s"":""coverage_or_contract_mixed"",""delta_60s"":""coverage_or_contract_mixed"",""buy_5m"":""coverage_or_contract_mixed"",""sell_5m"":""coverage_or_contract_mixed"",""delta_5m"":""coverage_or_contract_mixed"",""cvd_slope_10m"":""data_unavailable"",""cvd_divergence"":""data_unavailable"",""count_z_60s"":""data_unavailable"",""max_size_5m"":""data_unavailable"",""sweep_seconds_5m"":""data_unavailable"",""absorption_60s"":""data_unavailable"",""estimated_pull_60s"":""incomplete_book_or_tick_coverage"",""move_1m"":""incomplete_future_or_contract_mixed"",""move_5m"":""incomplete_future_or_contract_mixed"",""move_15m"":""incomplete_future_or_contract_mixed"",""favorable_15m"":""data_unavailable"",""adverse_15m"":""data_unavailable"",""crossed_15m"":""data_unavailable""}",us_day,1224.65,294.65,,,,,,,,,,,,-16,,,,,,,,,,,,,,,,0.3333333333333333,-0.17647058823529413,0.6666666666666666,-39,-8,4,-13,,,,,,,
```

### summary.json

全文：[NQ summary.json](evidence/turning-point-labels/NQ.summary.json)、[GC summary.json](evidence/turning-point-labels/GC.summary.json)。以下は件数部分の抜粋。全文には特徴ごとの欠損数、各マークの対照不足理由、RV分位、読取入力のSHA-256もある。

```json
{"version":1,"symbol":"NQ","period":{"fromSec":1793232000,"toSec":1793318400,"halfOpen":true},"counts":{"mark":5,"random":0,"nearmiss":0},"byKind":{"top":2,"bottom":2,"failed":1},"byViewMode":{"hindsight":5},"bySymbol":{"NQ":5},"candidateCount":8477,"rawMarketDataIncluded":false}
```

```json
{"version":1,"symbol":"GC","period":{"fromSec":1793232000,"toSec":1793318400,"halfOpen":true},"counts":{"mark":5,"random":0,"nearmiss":0},"byKind":{"bottom":2,"top":2,"failed":1},"byViewMode":{"hindsight":5},"bySymbol":{"GC":5},"candidateCount":3770,"rawMarketDataIncluded":false}
```

両方とも5マーク・対照0。今回のコピーには継続coverageや十分な別セッションがなく、各マークの30分RVが未算出なので、同五分位の対照を作れない。生約定があるだけで「取得済み」に昇格せず、NQの一部短時間数量・板特徴以外には空欄が多い。結果も欠けのまま。10件ともhindsightであり、実画面でlive／blind各1件を作成した証拠ではない（分類境界は単体試験で確認）。

ZIPのSHA-256：

```text
ea88b1bfa1937a0412ee62d9f705d0a6354a78210adf7007a93c2b7155f50908  NQ.zip
5f86aa3f3b04f2b9f9b29ba2c0d414f47ff484ae03d3c43f765bb755aa3192d6  GC.zip
```

同一保存マーク・入力の再書出しでも同じSHA-256。対照不足を合成データで埋めてはいない。合成4セッションの試験は、別の隔離された数式／選定の検証である。

### 通常Previewと反映範囲

`managed-preview.jpg`も撮影した。通常Previewは新しい静的フロントを読めるが、**起動中の旧サーバーは`GET /api/labels?symbol=NQ`が404**。対応バックエンドを起動していないので、そこで新しいマーク保存を使えるとは報告しない。UIはこの読取失敗で保存を無効化する。今回既存サーバーは再起動しない。

反映時はフロント・`server/src/labels/*`・共有型・history子・storeのスナップショット処理・HTTP配線をそろえる。既存の静的ビルドだけの差し替えでは不十分。再Publishはユーザー判断で行う。

### 終了・残存確認

- ブラウザ担当：所有Playwright PID3351はclose後に残ったためSIGTERMも行い、消滅を確認。所有CDPブラウザPID6466・6624も消滅を確認。
- 通常Preview撮影後の既存サーバーも`phase2b.connected:0`、`connections:[]`。撮影ツール内部のブラウザPIDは取得できないため、そのOSプロセス消滅まで確認したとは扱わない。
- 測定WSはclose code1000、fixtureのNQ／GC接続数は両方0。
- 所有fixture PID2381へSIGTERM。`replay_stopped {peers:0,noUpstream:true}`と、所有子PID7151のSIGTERM終了を記録。
- `ps -p 2381,7151,3351,6466,6624`は該当行なし、port18886は接続不可（HTTP000）、`/tmp/turning-export-*`は残存なし。
- 既存受信プロセスに停止・再起動操作はしていない。本番書込・再Publish・追加上流接続は行っていない。

### replit.md Current Statusへの追記

転換点マーク・派生特徴ZIPを隔離実装し、NQ／GC各5件、CAS・失敗・書出しを確認。既存を含む335試験と追加を含む関連14試験、画面199試験、両型検査・ビルド成功。親loop遅れ最大NQ12.12ms／GC10.85ms（静止fixture、ライブ負荷の証拠ではない）。GC HEATMAP配置・十分な対照・公開経路は未確認。所有プロセス終了・WS0、未公開。

## 仕様との差分・未解決

- 未公開。本番App Storageの世代競合、Invite-onlyの実公開経路、実ライブ、実iPad Safariは今回未確認。既存の保護を弱める変更はない。
- 実画面は保存コピーの隔離再生。本物の市場への接続確認ではない。コピーの欠けと限月不明は残す。
- 複数月・10,000マーク上限規模は未測定。統計的な売買優位性を示す機能ではない。

## 次の候補

実保存4セッション以上で対照不足の解消を確認すること、最大規模書出しの容量・取消を確認すること。提案のみで実行しない。
