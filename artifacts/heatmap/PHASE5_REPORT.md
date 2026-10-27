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
