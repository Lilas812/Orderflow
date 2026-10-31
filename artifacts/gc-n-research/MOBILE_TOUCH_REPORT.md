# 研究チャートのスマホ操作

## 実施内容

月間・日別の両研究チャートへ、2本指ピンチによる時間／価格の同時ズーム、
1本指の移動を追加した。月間ラインのタップは由来詳細を開く。
ピンチ後の指1本への移行、キャンセル、キャプチャ喪失で操作状態を整理する。
スマホ幅では価格軸を含めて収める。PCのホイール・ドラッグ・ボタンは維持。

製品コード・集計・購入データ・仕様正本・公開先の変更なし。再Publishなし。

## 変更ファイル

- `src/lib/chart-touch.ts`：`touchView`。指の中心にあるデータを基準に移動・拡縮。
- `src/hooks/use-chart-touch.ts`：`useChartTouch`。複数の指とキャプチャの管理。
  PC用ハンドラーはそのまま通し、タッチだけを扱う。
- `src/components/overview-chart.tsx`：ピンチ・移動・ラインタップを接続。
- `src/components/research-chart.tsx`：日別チャートへ同じ操作を接続。
- `src/pages/overview.tsx`：画面下の操作説明を更新。
- `scripts/chart-touch.test.mjs`、`scripts/touch_browser_check.mjs`：確認用。

## 操作方法

`/gc-n-research/overview` または日別研究ページをスマホで開く。

- 2本指を広げる：拡大。狭める：縮小。時間・価格を同時に変更。
- 1本指を動かす：チャートを移動。プロファイル／価格軸側では価格を移動。
- 月間のピンクの線をタップ：由来日・N枚数・接触履歴。
- 「フィット」：月全体へ戻す。日別は既存リセットボタン。
- ページ自体の上下スクロールは、チャートの外で行う。

## 実行した確認

```
node --experimental-strip-types --test \
  artifacts/gc-n-research/scripts/chart-touch.test.mjs \
  artifacts/gc-n-research/scripts/overview.test.mjs \
  artifacts/gc-n-research/scripts/research.test.mjs
pnpm --filter @workspace/gc-n-research run typecheck
PORT=20373 BASE_PATH=/gc-n-research/ pnpm --filter @workspace/gc-n-research run build
```

21試験合格、型検査・ビルド成功。既存tooltipのsource map警告は継続しているが、
ビルド失敗ではない。既存のデータ出力は変更せず、再生成もしていない。

Chromiumの402×874、DPR2、ネイティブタッチ入力で以下を確認：

- 両チャートのピンチイン／アウトで実際の表示範囲・拡大率が変わる。
- 両チャートがスマホ幅に収まり、価格軸が横にはみ出さない。
- 2本→1本へ移行した直後に表示が飛ばず、残った指で移動を続けられる。
- キャンセル後の新しいタップで古い移動状態が残らない。
- ピンチをライン選択と誤認せず、その後の1本指タップで詳細を開く。
- 既存ズームボタンが動作する。

途中で検証側のCDP指解放指定を修正した。ネイティブpointerイベントを記録し、
解放した指と残す指の取り違えであることを確認。製品の不具合とは扱っていない。

証拠：
- `evidence/touch-browser-check.json`
- `evidence/touch-mobile.jpg`：実タッチ確認後の画面。
- `evidence/touch-mobile-layout.jpg`：最終版のスマホ幅レイアウト。

## 終了・未確認

- 最終タッチ検証ブラウザPID6047は`Browser.close`後に終了確認。
- 最終撮影ブラウザPID6291も終了。稼働Chromium 0、CDPポート19379閉鎖を確認。
- Workspace製品の `/api/ws connected:0 / totalConnections:0`。受信PID392は継続稼働。
- 再起動したのは研究ページの配信用workflowだけ。検証用サーバー・上流接続の追加なし。
- 実機iPhone／Safari・Androidの指操作は未確認。Chromiumのタッチ入力確認と区別する。

元へ戻す場合は、上記2チャートのタッチ接続とスマホ幅の変更、操作説明の差分を外す。
データの復元や製品の変更は不要。
