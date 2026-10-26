# Phase 4 報告

2026-10-27（日本時間）。Phase 4 のみ実施。Phase 5 以降は未着手。

## 報告

- 実施内容：ブラウザ内の秒×価格の約定集計、価格ライン、約定バブル、現在値の点線・ラベルを実装。約定描画を板のラスタから分離した。指定された仕様書2件を無変換で配置した。
- 変更ファイル：下表参照。追加依存は **なし**。サーバーのコード・配信形式・保存形式、Run・デプロイ設定、App Storage、DB、`scripts/src/` は変更していない。
- 確認手順：Run でサーバーを起動後、`/?mode=replay&from=1793022000&speed=1&debug=1` を開く。Loading 終了後にバブル・価格ラインを見る。熱マップのドラッグ、ホイール、価格軸のドラッグ、ダブルクリックで確認する。`&bubbleMin=5` / `20` / `bad` を付けて比較する。現在値が価格表示範囲内にある場面では、白い点線が空の現在板領域まで延び、価格軸の白地・黒字ラベルと整列する。
- 実行した確認：画面42テスト、サーバー64テスト、両方の型検査、画面の本番ビルドが成功。実保存データの1倍リプレイを実ブラウザで操作・撮影。詳細・数値・画像IDは下記。SIGTERM 後の上流切断とプロセス終了まで確認した。
- 仕様との差分：実装上の差分なし。ユーザーが指定した仕様にない値は、下記の一覧に記録し、仕様書へは追記していない。
- 未解決・懸念：価格ズーム時の最大34.3msは33msの目安を一部超えた。実機 iPad/Safari・高DPR・2時間表示の性能保証はしていない。確認時は新規ライブ約定が来ておらず、ライブでの価格移動は未確認。下流送信失敗の累積2件は原因未特定。スクリーンショットの元PNGは取得できず、会話内の画像IDで記録している。
- 次の候補：Phase 5 の現在板。別途、実機 iPad/Safari で約定描画・操作・長時間表示を確認する。今回は実装しない。

## 配置・削除

| 元の添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_(11)_1793047779529.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(5)_1793047808841.md` | `docs/UI_SPEC_HEATMAP.md` |

無変換でコピーし、期待値との一致後に上記の添付2件だけを削除した。添付の作業指示や、それ以外の名前のファイルは削除していない。

`sha256sum docs/SPEC.md docs/UI_SPEC_HEATMAP.md` の結果：

```text
1bfd54cdd0bc25ae12fce5dd0f10a75ab60db30d39398de3c93416dedfb6431f  docs/SPEC.md
34021e9b07b4e312b46560c68ecc1f59e8a3c6630bd5525b443a31a3dc5b311a  docs/UI_SPEC_HEATMAP.md
```

## ファイルと役割

すべて `artifacts/heatmap/` 以下（仕様書・replit.mdを除く）。

| ファイル | 主な関数・役割 |
| --- | --- |
| `src/data/trade-aggregate.ts` | `TradeAggregator`：共通集計。`CurrentTradeState`：表示範囲・保持範囲から独立した現在値 |
| `src/data/cache.ts` | `ColumnCache.tradeAggregation`、`addTrades()`、`trim()`：列と同じ2時間の保持範囲を適用 |
| `src/data/socket.ts` | `RealtimeClient.handleJson()`：liveを追加し、rangeを一時保持、検査済みrangeDoneで置換確定。中断・切断時は一時保持を破棄 |
| `src/chart/trade-geometry.ts` | `tradeGeometry()`：閾値判定→物理画素ごとの結合、半径・色、価格ラインのmin/max/last。`parseBubbleMin()`：URL検査 |
| `src/chart/trade-overlay.ts` | `TradeOverlayRenderer.draw()`：独立した透明Canvasで価格ライン→バブル→現在値。現在板列の点線と価格軸ラベルも別Canvas |
| `src/main.ts` | `scheduleDraw(redrawDepth)`：約定だけの更新は板を描き直さない。初回履歴の現在値はrangeDoneで確定し、その後の履歴rangeは現在値を動かさない。debugへ個数・時間・現在値等を追加 |
| `src/index.css` | 独立Canvasを重ね、`pointer-events: none`で既存の操作を維持 |
| `test/trade-aggregate.test.ts` | 集計、同一内容の別約定、時刻逆行、置換・同時live、中断、2時間保持、再生時刻、現在値 |
| `test/trade-geometry.test.ts` | 閾値9/10、3色、半径、DPR、秒ごとの閾値適用後の結合、min/max、先頭の非描画、URL値 |
| `test/trade-overlay.test.ts` | 描画順、太さ・不透明度・点線・ラベル、独立描画 |
| `test/socket.test.ts` | 既存の範囲テストのダミー約定を要求範囲内へ修正。同一配信IDを2回含む有効なrange応答で、重複配信は1件となることを確認 |
| `PHASE4_REPORT.md` | この報告 |
| `docs/SPEC.md`、`docs/UI_SPEC_HEATMAP.md` | 許可された添付への差し替えだけ |
| `replit.md` | Current Statusだけを更新 |
| `.agents/memory/MEMORY.md`、`.agents/memory/screenshot-evidence.md` | 検証画像IDと保存済み画像ファイルの違いを記録 |

ヒートマップの `renderer.ts` / `aggregate.ts` / `tiles.ts` は変更していない。

## 共通集計の使い方（Phase 7・8向け）

入力は正規化済みの `Trade`。時刻は整数マイクロ秒、価格は0.25で割ったtick整数。境界は秒境界の半開区間 `[fromUs, toUs)` を渡す。

```ts
const aggregation = new TradeAggregator();
aggregation.retain(cacheFromUs, cacheToUs); // 最大7200秒。ColumnCacheでは自動適用
aggregation.appendLive(trades);

aggregation.beginRange(reqId, fromUs, toUs);
aggregation.appendRangeChunk(reqId, chunk);
aggregation.commitRange(reqId); // rangeDoneの全件数・chunk数検査が通った後だけ
// 中断した場合は aggregation.abortRange(reqId)

const cells = aggregation.cells(fromUs, toUs);
// [{ secondUs, price, buy, sell }]。値は枚数。結果は内部状態とは別のオブジェクト
const prices = aggregation.lastPrices(fromUs, toUs);
// [{ secondUs, price }]。同秒は受信順の最後。既知価格前は空、以降は無約定秒をcarry
const trade = aggregation.latestAt(cutoffUs);
// 指定時刻以前の最後の秒の約定（同秒では受信順）。なければnull
```

`cells()` / `lastPrices()` の第3引数には任意の `cutoffUs` を渡せる。同秒の未来約定も除く。画面ではリプレイの受信済み再生位置を使う。

内容（時刻・価格・枚数・side）による重複削除はしない。同一の `recvUs:seq` という配信IDだけを重複として扱う。range再取得は範囲の古い状態を入れ替え、取得中に来たliveも残す。現在値には、初回履歴の確定値と、その後の `trades` だけを使う。後の `rangeTrades` は現在値を変更しない。

## テスト・ビルド

変更前は画面29件、サーバー64件が成功。変更後の最終実行：

| 実行コマンド | 結果 |
| --- | --- |
| `pnpm --filter @workspace/heatmap test` | 42/42成功 |
| `pnpm --filter @workspace/heatmap typecheck` | 成功 |
| `pnpm --filter @workspace/heatmap build` | 成功（Vite 7.3.7、19 modules） |
| `pnpm --filter @workspace/receiver test` | 64/64成功 |
| `pnpm --filter @workspace/receiver typecheck` | 成功 |
| `git diff --check` | 指摘なし |

開発途中では、範囲外だった既存のダミー入力、URL内の`+`のエンコード漏れ、Nodeのstrip-only実行で使えないTypeScript parameter propertyを検出した。それぞれ入力の整合・URLエンコード・通常の明示的フィールド宣言へ直した。最終テストではすべて成功している。依存・実行コマンド・ランタイム設定は変更していない。

## 実データと画面確認

### 選択した範囲

保存済み約定ファイル（2026-10-26 UTC 12〜20時台）を秒ごとに数え、3600秒の移動合計で最多を選んだ。

- 最多1時間：UTC **13:29:48〜14:29:48**（JST **22:29:48〜23:29:48**）、**131,596約定**。
- その中の選択10分：UTC **13:30:00〜13:40:00**（JST **22:30:00〜22:40:00**）、**32,974約定**、買い17,402枚・売り17,395枚、集計セル10,811件。
- 同10分の保存列は599件。欠けた1秒の板を補完していない。
- 比較URLの開始位置は `from=1793022000`（UTC 13:40）、`speed=1`。

各撮影では `traffic.initialComplete=true` かつ `loadingRanges=0` を待った。会話内の画像ID：

| 画像 | ID | 観測値 |
| --- | --- | --- |
| 10分 | `2u2bwu` | UTC 13:30:35.671〜13:40:35.671、73 bubbles |
| 約2分 | `fhybgk` | UTC 13:39:26.436〜13:41:26.428、119.99255秒、13 bubbles |
| 約1時間 | `acfaji` | UTC 12:40:33.389〜13:40:36.056、3602.666898秒、93 bubbles、downsampled=true、priceBinCount=657 |
| 過去へpan | `r7dxns` | BROWSEのまま現在値が更新 |
| 価格軸zoom | `9wfr2h` | priceSpanTicks=238.69195 |
| ダブルクリックreset | `9e6cel` | 600秒・160ticks・FOLLOWへ復帰。現在値の破線・ラベルを確認 |
| bubbleMin=5 | `w2xv9j` | 386 bubbles |
| bubbleMin=20 | `2afkbd` | 12 bubbles |
| bubbleMin=bad | `vx9lhs` | 10に戻り「bubbleMin 無効」を表示 |
| 約定だけの更新 | `7e4h55` | 下記の隣接観測 |

画面は1280×800、DPR1。リプレイを止めずに操作したため、各画像は同じ開始位置からの寄り付き場面だが、撮影時刻は一致しない。上記10分画像の数値採取時の表示区間には32,002約定がある。32,974件は固定の選択10分の件数であり、撮影時区間と区別する。閾値5/20の表示開始位置にも約6.4秒の差がある。

スクリーンショット元PNGのワークスペースへの保存は取得手段がなく未了。画像は会話内で表示した。`data/phase4-checks/preview.jpg` は別の初回ロード中の撮影なので、完了画像として採用していない。

### 同一入力での閾値比較

撮影時刻の差とは別に、上記の**固定10分の同一実約定**を共通集計へ入れ、同一の表示範囲・サイズで `tradeGeometry()` を実行した。657×579 CSS px、DPR1、中心117240ticks、価格幅160ticks：

| bubbleMin | バブル数 | 買い優勢 | 売り優勢 | 同数 |
| --- | ---: | ---: | ---: | ---: |
| 5 | 377 | 185 | 167 | 25 |
| 10 | 62 | 34 | 24 | 4 |
| 20 | 13 | 3 | 10 | 0 |

これは固定入力の幾何計算の比較であり、画面撮影時の386/12とは混同しない。

### 現在値と独立描画

- 過去へpan後の表示範囲は UTC 12:36:09.779〜13:36:12.446 に固定。replay headが13:41:37→13:41:48へ進み、現在値が117056→117053ticksへ更新した。表示末尾の価格には戻らなかった。
- 隣接した約定だけの観測で、同じhead `1793022017000000`、cachedTrades **42527→42536**、currentPrice **117026→117024**。`depthDrawCount` は **44のまま**、両方 `rasterRebuilt=false`。板ラスタを作り直さず約定描画だけ更新している。
- 既知価格前の非描画、同秒の時刻逆行、再生時刻より未来の同秒約定の除外は単体テストでも確認した。
- 確認時のライブ最新約定は UTC20:59:59（JST05:59:59）、その後の新規約定は受信していない。ライブで新約定による点線の移動を確認したとは記載しない。

### Phase 3との描画時間比較

debugの観測値、平均 / 最大 ms。Phase 3は同報告書の修正後実操作値。入力・操作タイミングが異なるため、厳密な同一入力A/Bではない。

| 操作・状態 | Phase 3修正後 | Phase 4今回 |
| --- | ---: | ---: |
| 過去panとrange待ち | 7.18 / 18.9 | 5.16 / 19.80（画像`r7dxns`のdebug表示） |
| 時間zoom | 2.29 / 11.1 | 約2分画像で1.24 / 2.90 |
| 価格zoom | 4.22 / 17.6 | 6.483 / **34.3** |
| 約1時間へzoom | 4.61 / 79.1（3701秒） | 8.33 / 29.60（3602.67秒） |
| reset後 | 比較値なし | 3.06 / 11.8 |

reset時のoverlay内訳は幾何計算1.4ms・ライン0.1ms・バブル0.1ms。debugのline/bubbleは描画時間で、幾何計算は `overlay.geometryMs` に分離した。Phase 3の広域79.1msが一般に解消したとの保証はしていない。Phase 4の価格zoomは33ms目安を0.3ms超えており、全条件の達成とはしない。

## 仕様にない値として決めた値

今回ユーザーが指定・承認した値。今回の仕様書への追記は行っていない。

| 項目 | 値・扱い |
| --- | --- |
| 現在値の点線 | 白 `#ffffff`、1 CSS px、4pxの線・4pxの隙間 |
| バブルの濃い縁 | 買い `#2a9a5c`、売り `#7436b3`、同数 `#989898`、1 CSS px |
| 不正なbubbleMin | 非整数・1未満・数値でない入力は10を使い、debugへ「bubbleMin 無効」。上限なし |
| 価格ラインの先頭 | 最初の既知価格より前は描かない |

## 終了・ログ・設定

既存のAPIサーバー1プロセスを使用し、別の受信プロセスは起動していない。画面workflowだけをコード変更一式の後に1回再起動した。

停止前 `/api/status` は上流open、再接続0、acceptedBook=5330、acceptedTrade=3491。warning/feed/error/ticksLaggedはいずれも0。下流はconnected=0、slowClosed=0、sendErrors=2、invalidRequests=0（この起動セッション全体の累積）。

下流sendErrors2件の個別発生元はログだけでは特定していない。peer26/27のsteady接続はUTC21:14:34.856にclose1006、他の検査接続はclose1001等を記録している。別の初回撮影peer24はrangeDone前に閉じられ、初回rangeが中断された。これを正常に撮影完了した検査と混ぜていない。

**JST 06:17:50.312** にPID16368へSIGTERM。ログ：

```json
{"recvUs":1793049470312000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793049470312000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793049470572000,"event":"upstream_network_error","details":{"state":"closing"}}
{"recvUs":1793049470573000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793049470573000}}
{"recvUs":1793049470573000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793049470573000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

実際のcloseは1006であり、正常close1000とはしていない。06:17:50.573にsocketClosed=true、HTTP終了。`ps -p 16368` は対象なし、API workflowはFINISHED。

根拠は既存のGit・デプロイ除外領域 `data/phase4-checks/` に保存：`selection.json`、`data-reference.json`、`fixed-thresholds.json`、`phase4-summary.json`、`status-before-stop.json`、`shutdown-and-errors.jsonl`。実データを検証に使用したが、永続化方式や保存データを変更していない。

`replit.md` の Current Statusには、Phase 4の実装、64+42テスト・型検査・ビルド、最多時間帯と件数、独立描画、価格zoom34.3ms、ライブ移動未確認、sendErrors2、上記停止時刻とclose1006、この報告書への参照を追記した。
