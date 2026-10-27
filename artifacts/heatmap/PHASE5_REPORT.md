# Phase 5 報告

2026-10-27（日本時間）。Phase 5のみ。Phase 6以降は未実装。

## 報告

- 実施内容：`latestBook`を共通価格軸上の右端基点の横棒で表示。現在板専用Canvasと層別更新を追加し、板だけの更新ではヒートマップ・約定・現在値層を描き直さない。debugに現在板の描画時間（平均・最大）と各層の描画回数を追加。
- 変更ファイル：下表参照。追加依存なし。サーバー、配信・保存形式、仕様書、Run・デプロイ設定、App Storage、DBは変更していない。
- 確認手順：APIサーバーをRunで再開後、`/?debug=1` または `/?mode=replay&from=1793022000&speed=1&debug=1` を開く。Loading終了後、Current Bookの紫の横棒、最良気配のグレー帯、棒の手前の白い現在値点線と価格軸ラベルを見る。時間panでも現在板は最新のまま。価格軸の上下ドラッグで同じ価格の高さが各列でそろう。debugの `book 平均 / 最大 ms` と `book / depth / overlay draws` を見る。
- 実行した確認：画面49/49・サーバー64/64テスト、両方の型検査、本番ビルド成功。実保存データの1倍リプレイ・ライブをChromiumで確認。板だけの描画22回を観測。上流停止・HTTP終了・プロセス終了を確認。
- 仕様との差分：なし。推定・案だった表示値は着手前のユーザー承認に従い、下記に記録。正本仕様書は変更していない。
- 未解決・懸念：価格zoomの全体描画最大41.9ms（Phase 4報告34.3ms）。同一入力A/Bではなく原因・悪化率は未判定。実機iPad/Safari・高DPR・長時間性能は未確認。
- 次の候補：Phase 6の大口板列。別途、同一条件で価格zoomの描画負荷を切り分ける。今回は実装しない。既存のiPad/Safari確認候補と重ねて新規提案はしない。

## 変更ファイルと関数

| ファイル | 内容 |
| --- | --- |
| `src/chart/current-book.ts` | `currentBookRows()`：ティックセルを物理行へ投影し最大枚数を保持。`CurrentBookRenderer.draw()`：透明Canvasを消去→帯→紫の棒、共通P99、直近30描画の時間統計 |
| `src/chart/layer-scheduler.ts` | `LayerScheduler.request()`：全層・約定・現在板のdirtyを独立管理。同一フレームはまとめ、ヒートマップ→現在板→約定の順に実行 |
| `src/main.ts` | Current Book専用Canvas、`onLatestBook`の専用更新、層別スケジュール、debugの時間・回数・使用P99・板時刻。既存の現在値overlayは別Canvasのまま |
| `src/index.css` | `.book-canvas`：領域全体、操作を遮らない |
| `test/current-book.test.ts` | 空・欠け・領域外・両側・最大値縮小・共通座標・DPR・P99・頭打ち・帯・色・右端基点・全量置換・時間pan/価格zoom |
| `test/layer-scheduler.test.ts` | 板単独4回、約定単独、全層、同時更新、P99更新順序の分離 |
| `PHASE5_REPORT.md` | 本報告 |
| `replit.md` | Current Statusのみ |
| `.agents/memory/heatmap-rendering-decisions.md` | ユーザー指定の更新分離・時間表示ルールを記録 |

`renderer.ts`、`trade-overlay.ts`、`trade-geometry.ts`、データ受信・保存コードは変更していない。検証専用スクリプト・画像・JSONは既存のGit/デプロイ除外領域 `data/phase5-checks/` に置いた。アプリに一時ログは追加していない。

## 承認された表示値と更新規則

- 買い・売りとも `#8a3cff`、不透明。右端から左へ `min(size / P99, 1) × 幅`。
- P99はヒートマップの使用中の値をそのまま参照。現在板から別の基準を計算しない。ヒートマップが基準を再計算した描画では、その後に現在板を描く。
- 縦の各セルは価格±0.5ティック。同じ物理行へ入る枚数は合計せず最大値。時間位置には依存しない。丸め方は既存ヒートマップと同じ。
- 最良売りセル上端〜最良買いセル下端を `#808080`、不透明度0.2で背景に描く。片側がなければ帯は描かない。
- 板未受信なら棒・帯なし。最新の全量で置換し、過去表示中も最新受信板を表示する。リプレイは既存kind 3の再生位置の板を使用する。履歴列を現在板の代わりにしない。
- 点線・価格ラベルは既存の約定層。現在板Canvasの上にあり、棒の更新では消去しない。
- 既存の初回価格センタリングだけは価格viewport自体が変わるため全層更新。センタリング済みの板更新は現在板だけ。列・価格/時間viewport・resize・P99再描画は全層、約定だけなら約定層のみ。同じフレームで別の更新も発生した場合は必要な層だけを各1回描く。
- debugの現在板平均/最大は直近30回の現在板描画。`getBoundingClientRect`・サイズ調整・消去・行集計・帯/棒描画を含む。既存の全体描画平均/最大には板単独フレームを混ぜず、安い板単独描画の追加でPhase 4との比較値を人工的に下げない。

## テストと描画根拠

実行コマンド：

```text
pnpm --filter @workspace/heatmap test       49/49成功
pnpm --filter @workspace/heatmap typecheck 成功
pnpm --filter @workspace/heatmap build     成功（Vite 7.3.7、21 modules）
pnpm --filter @workspace/receiver test     64/64成功
pnpm --filter @workspace/receiver typecheck 成功
git diff --check                         指摘なし
node data/phase5-checks/check.mjs          完走、pageerrorなし
```

初回追加テストの2件は、境界行の浮動小数丸めを無視した期待値と、帯の高さを浮動小数で厳密比較した期待値が失敗した。セル内の行・許容誤差による比較に直し、最終全件成功。実装の丸めをテスト都合で変えていない。物理高さ1/3/200/400の行配列を既存`computePixelMax()`と照合するテストも成功。

### 実データ

1280×800、DPR1、Chromium。保存済みのUTC13:40から1倍リプレイ。初回rangeDone、loadingRanges=0、現在板の描画行ありを待って採取した。

- リプレイ10分の使用板は `1793022007000000` µs、買い400段・売り400段。画面P99=11、現在板P99=11。
- 元の保存列を `server/src/store/binary.ts` の `decodeColumns()` で読戻し、例として価格117168ticks・3枚は全幅の3/11、117169ticks・1枚は1/11、117174ticks・2枚は2/11となることを記録。`data-reference.json`。
- この時点のdebugは543物理行を描画。Canvasの物理寸法を同時採取していないため、543行そのものを実データで独立照合したとはしない。共通座標・最大値投影の厳密一致は単体テストによる。
- 実ブラウザで、現在板の回数だけが増えdepth/overlayが不変の隣接観測が22回。例：book **8→9**、depth **8→8**、overlay **12→12**、P99は両層14。続くbook **9→10→11**でもdepth8・overlay12のまま。`browser.json` の `isolation`。
- ライブの保存画像では白い現在値点線が現在板の手前を通り、価格軸ラベル **29475.75** と整列。バブル・価格ラインも従来どおり別層に表示。ライブのスナップショットはP99が両層14。

### 保存画像

| ファイル（`data/phase5-checks/`以下） | 内容 |
| --- | --- |
| `replay-10min.png` | 600秒、ロード完了後の棒・ヒートマップ・debug |
| `replay-1hour.png` | **実際は886.631683秒（約14.8分）**。検証スクリプトの名前の付け方が誤り。ホイールの1イベントあたり倍率上限が適用され、1時間になっていない。1時間の確認証拠には使わない |
| `price-zoom.png` | 約14.8分の表示で価格幅258.57ticksへ変更後 |
| `live.png` | ロード完了後のライブ・白い点線・ラベル・板 |
| `preview.jpg` | 初回ロード中の画面。完成描画の証拠には使わない |

画像はワークスペースのファイルとして保存済み。データと画像は個人用であり外部公開していない。

## Phase 4との描画時間比較

単位ms、平均 / 最大。Phase 4は `PHASE4_REPORT.md` の値。Phase 5の全体は既存debugの直近30描画、現在板は専用の直近30描画。操作間で窓が重なり、前の操作のサンプルも含む。入力・操作・取得タイミングが異なるため、厳密な同一入力A/Bではない。

| 状態 | Phase 4 全体 | Phase 5 全体 | Phase 5 現在板のみ |
| --- | --- | --- | --- |
| 10分リプレイ | 同条件の値なし | 2.57 / 6.90 | 0.16 / 0.40 |
| 約2分 | 1.24 / 2.90 | 2.56 / 11.20 | 0.19 / 0.50 |
| 過去pan | 5.16 / 19.80 | 8.61 / 14.60（約14.8分表示） | 0.17 / 2.10 |
| 価格zoom | 6.483 / 34.3 | 12.45 / **41.90** | 0.25 / 2.10 |
| reset直後 | 3.06 / 11.8 | 12.72 / 38.20（直前zoomを含む窓） | 0.28 / 2.10 |
| ライブ | 比較値なし | 6.91 / **50.10**（初回ロードを含む短い窓） | 0.49 / 1.20 |

Phase 4では現在板が空だったため、専用板描画時間の直接の比較値はない。現在板自体の観測値は小さいが、全体の滑らかさが改善・維持されたと断定しない。特に価格zoomは33ms目安を超える観測が残る。性能改善を理由に今回の範囲外のラスタ処理を変更していない。1時間・高DPR・長時間の追加測定はしていない。

## 起動・終了

既存APIサーバー（PID404）を利用し、別の受信プロセスは起動していない。画面workflowだけをコード一式の変更後に1回再起動し、ログでViteの起動・ブラウザエラーなしを確認。

停止前status：上流open、再接続0、採用板1340件・採用約定376件、warning/feed/error/ticksLaggedすべて0。下流はslowClosed=0、sendErrors=0、invalidRequests=0。`status-before-stop.json`。

初回のプレビュー撮影はrangeDone前に終了し、peer4がcode1001で閉じて初回rangeを中断した。その画像を完成証拠にしない。完了した実ブラウザ検証とは区別する。

JST **11:22:04.878** にSIGTERM、以下を記録：

```json
{"recvUs":1793067724878000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793067724879000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793067725140000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793067725140000}}
{"recvUs":1793067725140000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793067725481000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

JST **11:22:05.140** 上流停止、**11:22:05.481** HTTP終了。`ps -p 404` は対象なし、`curl http://localhost:8080/api/status` は接続不能（exit7）、API workflowはFINISHED。実際のcloseは1006であり正常close1000とはしない。`shutdown-and-errors.jsonl` に保存。画面workflowは起動を維持しているが、データ確認にはAPIの再起動が必要。

---

## 置き方の変更（2026-10-27 以降）

2026-10-27 JST。以下が現在の配置。上の独立12%枠・帯・単色の説明は旧実装の記録であり、再適用しない。

### 報告

- 実施内容：現在板の独立枠を廃止し、本体・デルタ空枠・時間軸を66%へ拡張。現在板は本体右端から左向き、最大20%・alpha0.7、売り紫・買い薄灰で重ねる。最新確定列を80%へ置いて追尾し、リセット・追尾中の時間zoom・ピンチ・resizeでも維持。価格軸5%・大口10%・VP19%は同じ位置。
- 変更ファイル：下表。指定された正本3件を添付と同じバイト列へ置換し、ハッシュ確認後に許可された添付コピー11件を削除。依存、サーバー本体、配信・保存形式、Run・デプロイ設定、App Storage、DB、`scripts/src/` は変更していない。
- 確認手順：APIを既存Run設定で起動し、`/?mode=replay&from=1793022000&speed=1&debug=1` を開く。Loading完了後、最新列の右に20%の空白と現在板の棒、全幅の現在値点線があることを確認。棒上から右へドラッグして過去へ移動すると、棒の下に過去ヒートマップが透ける。価格軸を上下ドラッグして価格zoom、棒上でピンチ、ダブルタップ/ダブルクリックで追尾へ戻す。`/?debug=1` はライブ。今回APIは停止済み。
- 実行した確認：画面71/71・サーバー79/79テスト、両型検査、本番ビルド成功。実保存データの1倍リプレイ4状態・ライブを実HTTP配信経由で確認。Chromiumの模擬2タッチとマウスで操作し、ピンチ600→300秒、ダブルタップで600秒へ復帰。現在板Canvasの実画素・入力先・描画順序と、独立更新の単体テストを確認。最終ブラウザ残存0・WS0・上流停止・HTTP終了・API PID消滅を確認。
- 仕様との差分：表示機能の未実装差分なし。縮小時の売買混在行の扱いだけを今回のユーザー指定として下記に記録し、仕様書の本文へは追記していない。性能目標は一部未達。
- 未解決・懸念：同位置比較の価格拡大10.34/33.20ms・時間拡縮9.89/28.80ms（平均/最大）は平均8ms/最大33ms目標を一部満たさない。実機iPad/Safari、高DPR、長時間、公開2GiB環境は未検証。停止時の実close1006は正常close1000ではなく、原因は未解決。
- 次の候補：未達の描画性能、停止時close1006の切り分け。提案のみ。Phase 7以降の実装や、前回の30分・5場面の再測定は行っていない。

### 変更ファイル・関数

以下の `src/`・`test/` は `artifacts/heatmap/` 配下。

| ファイル | 変更内容 |
| --- | --- |
| `src/main.ts` | 現在板Canvasを本体内へ移設、独立枠・下枠・別の現在値線Canvasを除去。`alignFollowToPhysicalPixel()`・`setViewport()`・`resetView()`・`pointerMove()`・resize処理で80%追尾と操作を調整。約定層の既知時間上限を渡し、未来余白へ価格ラインを延ばさない |
| `src/index.css` | `66fr 5fr 10fr 19fr`、下枠の列番号、現在板z-index1・約定z-index2、入力透過。右側3列は移動しない |
| `src/chart/coordinates.ts` | `BOOK_OVERLAY_FRACTION`・`followStartUs()`：20%余白と物理画素に整列した80%アンカー |
| `src/chart/current-book.ts` | `currentBookRows()`：最大段と売買側を選択、同数売り。`CurrentBookRenderer.draw()`：帯を廃止、共通P99、20%以内の長さ、売買色、alpha0.7 |
| `src/chart/trade-geometry.ts` | `tradeGeometry()`：既知価格をデータ先頭側へ補わず、横延長・末端のセル中心を既知時間上限で止める。現在値点線はこの上限で切らない |
| `src/chart/trade-overlay.ts` | `TradeOverlayRenderer`：別枠用Canvasを除去。価格ライン→バブル→全幅の現在値点線の順を維持 |
| `test/current-book.test.ts` | 20%上限、色、alpha、帯なし、DPR、最大段・同数売り・合算しないこと |
| `test/trade-overlay.test.ts` | 全幅点線と既存の線・バブル・ラベル |
| `test/trade-geometry.test.ts` | 既知価格の横延長が80%のデータ位置までで、未来領域や最初の未知価格へ延びないこと |
| `test/book-layout.test.ts` | 追尾・時間zoom・resize/DPRのアンカー、66%共有幅、余分な枠なし、層順・入力透過 |
| `server/tools/perf/phase5-revise-check.ts` | 今回専用の実通信・画面・操作・実画素・RSS採取、ブラウザ/接続終了、SIGTERMとPID終了の確認。サーバーの実行処理は変更しない |
| `server/tools/perf/render-benchmark.ts` | 比較専用の左端時刻引数を追加。実際のpanで前回位置へ合わせ、差を記録。ダミー明示と従来の操作条件は維持 |
| `docs/SPEC.md`・`docs/UI_SPEC_HEATMAP.md`・`docs/AGENT_RULES.md` | ユーザーが配置を許可した添付の完全コピー。配置後の本文編集なし |
| `replit.md` | Current Statusに今回の結果だけを追記 |
| `.agents/memory/MEMORY.md`・`heatmap-rendering-decisions.md` | 古い54%固定の記憶を失効させ、今回の混在行に関するユーザー指定を記録 |
| `artifacts/heatmap/PHASE5_REPORT.md` | この節を追記。過去の記録は変更しない |

### 仕様にない値として決めた値

| 項目 | 決定内容 | 決定者 |
| --- | --- | --- |
| 縮小して同じ1画素行に売買両方が入る場合 | 枚数が最大の**1段**を採用。その段の売買側の色、その段の枚数による長さとする。合算しない。同数なら**売り（紫）** | 今回のユーザー指定 |

それ以外の新しい色・閾値・依存・データ形式は決めていない。80%位置は従来と同様に物理画素格子へ整列するため、丸め誤差は概ね1物理画素以内。ピンチは追尾中の80%アンカーを維持し、1本指/マウスの時間panで閲覧へ移る。

### 実行した確認と証拠

コマンドと結果：

```text
pnpm --filter @workspace/heatmap test       71/71 PASS
pnpm --filter @workspace/receiver test      79/79 PASS
pnpm --filter @workspace/heatmap typecheck   PASS
pnpm --filter @workspace/receiver typecheck  PASS
pnpm --filter @workspace/heatmap build       PASS
node --check server/tools/perf/phase5-revise-check.ts  PASS
node server/tools/perf/phase5-revise-check.ts          PASS（実通信・操作）
node server/tools/perf/render-benchmark.ts phase5-revise-verified artifacts/heatmap/dist/public
node server/tools/perf/render-benchmark.ts phase5-revise-matched artifacts/heatmap/dist/public 1793021400000000
```

ログは `data/phase5-revise/{frontend-checks.log,server-checks.log,browser-checks.json,server-events.json,final-verification.json,performance-comparison.json}`。最初の確認スクリプトはAPI起動前の待機60秒でtimeoutし、ブラウザ未起動。APIが応答した後に同じ実通信確認を実施し成功した。APIを二重起動していない。

最終差分検査の `python3` コマンド実行後に、補助環境が `.replit` へ `python-base-3.13` を自動追加していた。今回追加されたこの1項目だけを専用のランタイム除去操作で取り消し、元のNode24のみの設定へ戻した。Run・デプロイ設定を最終差分に残していない。副作用の注意を `.agents/memory/verification-config-side-effects.md` へ更新した。

実保存データ・実WebSocketのリプレイ速度は**1倍**。1280×800、DPR1。次の4画像は初期受信完了かつ追加range要求0を待って撮影したもので、ダミー接続ではない。

| 状態 | 画像（`data/phase5-revise/`） | 確認内容 |
| --- | --- | --- |
| 追尾 | `replay-follow.png` | 最新確定列79.98%付近、右の未来余白へ現在板、価格ライン・バブルはデータ位置まで |
| 過去へpan | `replay-browse.png` | 棒上の入力先がheatmap。追尾解除、棒の下に過去データ、現在板は再生位置のまま |
| 拡大 | `replay-zoom-in.png` | 価格幅160→44.49tick、同一価格の高さが一致 |
| 縮小 | `replay-zoom-out.png` | 約160tickへ復帰、半透明の棒と下の履歴が共存 |

`live-follow.png` は本物のライブ表示。採取時、受信は板300件・約定217件、warning/feed/error/ticksLaggedは0、受信中の切断0、sendErrors/slowClosed/droppedBoardsは0。履歴バックフィルは実行中で空白が残り、完了済みの完全な3時間表示とはしていない。

実Canvas読取：幅801物理px、塗りが始まる最左列714（今回の板では上限まで届かない）。灰784画素・紫18,396画素、最大alpha179/255。最大長20%の頭打ちは単体テストで確認。大口板のrebuildCountは追尾・pan・両価格zoomで全て1、過去panで再構築しない。

板単独更新の分離は `layer-scheduler.test.ts` と描画テストで確認。実リプレイの4秒観測では、列更新と同時になるため独立更新を0回観測しており、実リプレイで独立更新を観測したとはしない。ライブ画面の描画回数はbook27/depth12/overlay16。現在板の独立Canvasとdirty更新は維持している。

画面ツールの `tool-preview.jpg` は初期読み込み途中のため、完成画面の根拠には使わない。上記5画像を完成状態の確認に使った。

### 前回最終結果との性能比較

**ダミー接続・実保存データの固定再生**。画面とconsoleにこの表示を出し、実通信検証とは分離。元データは `data/perf-memory/render-fixture/` の5689列・71,245約定、1793014800〜1793022000秒。前回は `isolated-final`、今回の同位置比較は `phase5-revise-matched`、新しい通常追尾状態は `phase5-revise-verified` の各 `render-static/` に保存。

1280×800 CSS、DPR1、時間幅600秒、中心117244.5tick・価格幅160tick。価格軸-160pxを60段階/35ms、逆方向で戻し、時間panは本体幅55%を60段階/35ms、時間wheelはdeltaY30を40回/35ms。APIと画面dev workflowを止め、同じ操作スクリプトで測定した。

新しい80%追尾では左端が前回より約120秒新しくなるため、それを同位置比較と偽らない。同位置比較では最初に実panし、前回左端1793021400000000usに対し実際1793021400067801us、差67.801ms＝**0.0905 CSS px**へ合わせた。今回の同位置比較は閲覧モード、前回初期は追尾モード。画面幅そのものの変更は今回の要件であり、同じピクセル画像ではない。

| 操作 | 前回 平均/最大ms | 今回同位置 平均/最大ms | 今回frame数 | 現在板単体 平均/最大ms |
| --- | ---: | ---: | ---: | ---: |
| 価格拡大 | 10.73 / 44.40 | 10.34 / 33.20 | 62 | 0.174 / 1.50 |
| 価格戻し | 7.92 / 16.40 | 9.97 / 21.60 | 62 | 0.100 / 0.20 |
| 時間pan | 7.05 / 23.40 | 7.06 / 24.10 | 123 | 0.111 / 1.10 |
| 時間拡縮 | 8.16 / 29.60 | 9.89 / 28.80 | 87 | 0.132 / 0.70 |

固定状態のsteadyは再描画0回で、平均0msとはしない。新しい通常80%追尾条件では価格拡大8.76/36.50ms、時間拡縮9.37/25.30msだが、前回と可視範囲が違うため参考値。価格戻し・時間拡縮の平均は同位置比較で悪化しており、全体性能の改善完了とはしない。平均8ms・最大33msの目標は一部未達。今回、範囲外の性能改善を追加していない。

実APIの `/api/status` 採取RSS：追尾463,015,936B、pan491,208,704B、拡大491,245,568B、縮小494,260,224B。サーバー5秒周期ログと状態採取の範囲での最大は**495,280,128B（472.34MiB）**、512MB(decimal)未満。重い操作の1GiB上限も採取範囲では未超過。ただし長時間・全履歴取得完了後・公開2GiBの保証ではない。ダミー接続の数値をAPIメモリとはしていない。

### 配置した正本と添付整理

| 元の添付 | 配置先 |
| --- | --- |
| `SPEC_(13)_1793100248903.md` | `docs/SPEC.md` |
| `UI_SPEC_HEATMAP_(7)_1793100248301.md` | `docs/UI_SPEC_HEATMAP.md` |
| `AGENT_RULES_(1)_1793100247675.md` | `docs/AGENT_RULES.md` |

配置時・作業後とも一致：

```text
bd41906b272151b5eaff271a93945dea980639e1396854c3821af33ff80eedb2  docs/SPEC.md
033c41379027e73cd632aa269d9fe4131c793739741c2a3edbab8ccb610e2e9d  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

削除したのは `attached_assets/` の以下11件だけ。配置元・削除記録は `data/phase5-revise/spec-placement.json`。その他の添付、保存データ、過去の報告書は削除していない。

```text
AGENT_RULES_(1)_1793100225713.md
AGENT_RULES_(1)_1793100247675.md
SPEC_(12)_1793089387711.md
SPEC_(13)_1793100226901.md
SPEC_(13)_1793100241958.md
SPEC_(13)_1793100248903.md
UI_SPEC_HEATMAP_(6)_1793089348584.md
UI_SPEC_HEATMAP_(6)_1793089385835.md
UI_SPEC_HEATMAP_(7)_1793100226329.md
UI_SPEC_HEATMAP_(7)_1793100241111.md
UI_SPEC_HEATMAP_(7)_1793100248301.md
```

### ブラウザ・接続・停止の確認

- 実リプレイChrome PID24253、ライブPID24401は、それぞれ確認終了時にBrowser.close、PID終了・debug port閉鎖を確認。`browser-checks.json` に `exited:true, portClosed:true`。
- 画面ツールが残したローカルChrome PID24621をSIGTERMし、最終 `/proc` 走査でChromium本体/子プロセス0件。ツールのページWS切断だけを本体終了の証拠にしていない。
- 同位置比較Chromeの終了は `phase5-revise-matched/render-static/browser-closed.json`。80%比較および途中の候補計測も各 `browser-closed.json` で終了を確認。
- 最終実API状態は `/api/ws connected=0`、検証UAの残存0。外部からの接続制限は今回一切追加していないため、解除操作の必要もない。
- 20:47:09.866 JSTにAPI PID24207へSIGTERM。ログ上の要求時刻は09.867。20:47:10.338に実 `upstream_close code1006/wasClean:false` と `upstream_stopped socketClosed:true`、20:47:10.360に `server_stopped httpClosed:true`。PID消滅と8080接続不能を確認。close1000は要求値で、実際の正常終了コードではない。
- API起動前に他の受信サーバーなしを確認し、上流は1本のみ。API workflowはFINISHED。画面workflowは復帰させるが、データ確認にはAPI再開が必要。

### replit.md Current Status の更新内容

今回の1行を追記した。正本3件の差し替え・11添付削除、66%/20%/80%配置、同数売りルール、71/79テスト・型検査/ビルド、実リプレイ/ライブ/操作、同位置の価格拡大10.34/33.20ms・時間拡縮9.89/28.80msと性能未達、採取RSS最大495,280,128B、ブラウザ0・WS0、20:47:09.866 SIGTERM/10.338上流close1006/10.360 HTTP終了とPID消滅、Phase 7未着手を記録。Current Status以外の本文は変更していない。
