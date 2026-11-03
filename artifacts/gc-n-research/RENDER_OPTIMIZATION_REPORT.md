# 研究チャートの描画更新の修正

## 実施内容

月間・日別の両チャートで、カーソル移動による本体の全面描画、毎回のCanvasリセット、入力イベントごとのReact更新を修正した。研究用ページのみの変更で、製品HEATMAPのWebGL実装、集計、購入原本、保存データ、本番は変更していない。WebGLへの移植は実施しておらず、Canvas 2Dである。

## 変更ファイル・関数

- `src/components/overview-chart.tsx` / `OverviewChart`：本体と透明十字カーソル層の分離。hoverは本体描画の依存から除外。
- `src/components/research-chart.tsx` / `ResearchChart`, `draw`, `drawCrosshair`：同様に分離。日別の時刻・価格ラベルとツールチップを維持。
- `src/hooks/use-frame-state.ts` / `useFrameState`：入力を次のrequestAnimationFrameにまとめる。関数型更新は未反映の最新値へ順に適用するため、同一フレームの連続操作を捨てない。unmount時に予約をキャンセル。
- `src/lib/chart-canvas.ts` / `prepareCanvas`：サイズが異なる場合だけbacking storeを設定。DPR・CSS寸法に変化がなければ再確保しない。
- `src/hooks/use-chart-dpr.ts` / `useChartDpr`：画面移動やブラウザズームによるDPR変更時に両層を再描画。DPR上限・解像度の引下げは追加していない。
- `scripts/chart-canvas.test.mjs`：再確保条件・端数寸法の試験。
- `scripts/render_perf_check.mjs`：既存実データを用いるCDP計測・描画分離の検査。

## 確認手順

`/gc-n-research/overview` と `/gc-n-research/` でカーソル移動、ドラッグ、ホイール、操作ボタンを確認。スマホではピンチ、2本指から1本指への移行、キャンセル後の操作、月間ラインのタップを確認する。

## 実行した確認

- `node --experimental-strip-types --test`：chart-canvas / chart-touch / overview / research の4試験ファイル、**23/23成功**。
- `pnpm --filter @workspace/gc-n-research run typecheck`：成功。
- `PORT=20373 BASE_PATH=/gc-n-research/ pnpm --filter @workspace/gc-n-research run build`：成功。既存tooltipソースマップ警告あり。
- 研究ページのワークフローのみ再起動。既存受信ワークフローは再起動していない。
- CDP Chromium：1280×900、DPR2、購入済みデータ、月間は既定の暦月・5分足・63ライン。60回の入力バースト（各8 pointermove）と8回の時間拡大を修正前後で実行。

|指標|月間・前|月間・後|日別・前|日別・後|
|---|---:|---:|---:|---:|
|カーソル中fillRect命令|148,620|60（overlayのみ）|99,660|120（overlayのみ）|
|カーソル中Canvas幅・高さ設定|120|0|120|0|
|8回の拡大中Canvas幅・高さ設定|16|0|16|0|
|全シナリオTaskDuration CPU ms|857.6|611.2|913.9|982.8|
|最終JS heap bytes|19,808,864|17,550,788|19,475,224|26,035,724|

後の480 pointermoveに対し、overlay描画60回・本体描画0回。追加100 pointermoveの前後で本体Canvasの全画素一致。DPR1→3→2切替で両層のサイズ一致も成功。

後のsetTransformからmicrotaskまでのCPU時間p95は、hover：月間0.6ms・日別0.5ms、拡大：両方4.8ms。**これは描画命令を発行する同期処理の目安であり、GPUラスタライズ・合成・実画面への表示完了時間ではない。**

2回のrAFを意図的に待つ入力検査のp95は前34.4/35.5ms、後35.7/35.9ms。待機込みのためCanvas描画時間や低遅延達成の証拠にしない。修正後の計測スクリプトではスクロール後のレイアウト安定待ちと細分計測を追加したため、CPU・heapは厳密な独立反復比較ではない。**日別の全体CPU低下は確認できていない。** 新しい透明Canvas分のbacking storeも必要であり、JS heapだけでは総描画メモリは判断できない。

証拠：
- `evidence/render-before.json`
- `evidence/render-after.json`
- `evidence/render-optimized.jpg`

既存のnative touch確認スクリプトも再利用し、402×874・DPR2で両画面のピンチ拡大縮小、2→1移行、移動、キャンセル、タップ・ライン選択、操作ボタンが成功した。Canvasの見た目も撮影確認した。

## 仕様との差分

なし。数量・価格・反応の判定基準、線の有効期間、データの欠けは変更していない。

## 終了確認・未解決

自分のCDP検証ブラウザは各スクリプトfinallyで終了。撮影用ブラウザも終了し、稼働Chromium残存なし、CDP検証ブラウザのexitを確認。追加の検証サーバー・上流WSは起動していない。研究用の既存管理サーバーは画面提供のため維持。既存 `/api/status` の上流は `stopped` だったが、本タスクでは操作していない。研究ページは静的JSON読取で製品 `/api/ws` に接続しない。

実機Safari・利用端末の実GPUでは未確認。GPU利用率、端末上の最終表示遅延、長時間のメモリは今回確認していない。「GPU化済み」「すべての端末で重さが解消した」とは扱わない。

## 次の候補

端末上でも遅い場合は、実機で初回集計・React更新・Canvas描画・合成を分離計測し、GPU移植の必要性を判断する。今回は未実施。
