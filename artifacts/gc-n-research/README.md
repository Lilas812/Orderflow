# GCZ6 N約定リサーチ

前セッション(実取引セッション)の **N(不明アグレッサー)約定のみ** の価格プロファイル(左)と、
選択セッションの実1分足(右)を **同一の価格変換・同一のy範囲** で表示する個人用リサーチチャート。
売買シグナル・自動ラベル・バックテストはありません。

## データ
- `public/research-data/index.json` と各セッションファイル(親工程が生成、静的fetch)。
- セッション = CT 17:00 → 翌17:00、ラベルは終了日。価格はtick整数 × 0.1。
- ピンクの集中価格は **前セッションのプロファイルのみ** から選択(当日データは一切使わない)。

## 操作
| 操作 | 内容 |
|---|---|
| ‹ / › ・日付欄 | 利用可能なセッション間を移動。存在しない日付は「利用できません」と表示し、自動で別日に置換しない |
| 上位N本 (既定3) | 数量上位のN価格(同数は高い価格を先にする。既存調査と同じ) |
| 最小数量 (既定1) | この数量未満の価格を除外 |
| 価格バケット (既定1tick) | 前プロファイルをtick単位でまとめて選択 |
| CT / JST | 時間軸・ツールチップの時刻表示 |
| ホイール(右ペイン) | 時間ズーム(カーソル基準) |
| ホイール(左ペイン/価格軸)・Shift+ホイール | 価格ズーム(両ペイン共通) |
| ドラッグ | 右: 時間+価格パン / 左: 価格パン |
| ボタン | 時間±・左右、価格±・上下、フィット、リセット |
| キーボード(チャートにフォーカス) | ←→ 時間パン、↑↓ 価格パン、+/− 時間ズーム、R リセット |

最初はセッション全体を表示します。拡大すると個々の1分足を詳しく確認できます。
約定のない分は空白(ギャップ)のまま表示され、フラット足は生成しません。

## データの再生成と検査
プロジェクト直下から実行します。原本は読み取り専用で、既存製品へ接続しません。

```
python artifacts/gc-n-research/scripts/export_research.py
python -m unittest discover -s artifacts/gc-n-research/scripts -p 'test_*.py' -v
node --experimental-strip-types --test artifacts/gc-n-research/scripts/research.test.mjs
pnpm --filter @workspace/gc-n-research run typecheck
PORT=20373 BASE_PATH=/gc-n-research/ pnpm --filter @workspace/gc-n-research run build
```

生成JSONはGit対象外の派生キャッシュです。別環境では既存の購入データを配置して再生成してください。
配信は研究用ページの独立したプレビューだけで、公開・本番データ反映はしていません。

## 実装
- `src/lib/research.ts` 純粋関数(バケット化・上位選択・時刻整形・検索)
- `src/hooks/use-research.ts` 静的JSON取得(セッションファイル単位でキャッシュ。`session`一致を検証してから描画)
- `src/components/research-chart.tsx` Canvas描画と操作
- `src/components/level-table.tsx`, `legend.tsx`, `src/pages/research.tsx`
