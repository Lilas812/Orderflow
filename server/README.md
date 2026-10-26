# Phase 1 受信基盤

Node v24 の標準 WebSocket クライアントと Express で動く、NQ専用の1プロセス。
仕様の正本は `../docs/SPEC.md`。Phase 0 のスクリプトは読み込まない。

## 実行

Replit の Run を使用する。既存の `artifacts/api-server: API Server` が
`@workspace/receiver` を起動し、管理された `PORT` を渡す。
Secrets の `TICKSTREAM_API_KEY` が必須。キーやキー付きURLをコマンドに渡さない。
ファイル変更による自動再起動はない。

- サーバーのハンドラー：`GET /status`
- Replit の既存 `/api` プロキシ経由：`/api/status`（同一ハンドラーへの別名）
- HTTPは `0.0.0.0:$PORT`。状態ページはJSON、価格は整数NQティック、時刻は整数Unixマイクロ秒。
- 実データを含むので、開発プレビューURLも他人に共有しない。

## 通信しない検査

プロジェクト直下から：

```sh
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver test
```

テストはすべて「ダミー」と明記し、実際のTICK STREAM接続を作らない。

## 接続の制御

- `kill -USR2 <NodeプロセスID>`：上流だけcloseし、closeイベント後にバックオフして再接続・再購読。
- `kill -TERM <NodeプロセスID>` または `SIGINT`：HTTP受付を閉じ、上流closeイベントを待って終了。
- `upstream_close` → `upstream_stopped` → `server_stopped` のログを確認する。
- closeイベントが確認できなければ、新しい接続は作らない。状態は `closing` に留まり、
  `upstream_close_error` があれば記録する。正常closeを確認したようには扱わない。
- 1006はローカルの異常終了報告であり、サーバーが1006を送ったという意味ではない。

## メモリと件数

- 板は検査に合格したスナップショットで全量置換。異常板で直前の板を消さない。
- 約定は受信順で最大1,000件保持。内容による重複除去はしない。
- `seq`はプロセス内で採用した約定の通し番号。再接続ではリセットしない。
- 時刻巻き戻りは板・約定それぞれの直前の採用時刻と比較し、再接続でも基準を維持する。
- `byType`は受信メッセージ数。`counts`の検査違反は段・違反の件数、
  `rejectedBook` / `rejectedTrade` は棄却したメッセージ数。
- 実例は種類ごと最初の5件。件数はその後も加算。warning/feed/errorは毎回ログに記録。
- `ticks_lagged` は通知、直前の約定時刻、観測時刻、送信元が示した区間をログに残す。
  送信元の区間の単位や厳密な欠落区間が不明なら推測しない。補完処理は未実装。
- `lagIntervals`も最初の5件の例だけを保持し、全件は `counts.ticksLagged` に数える。
- 約定・板の生データ保存、履歴取得、ブラウザ向けWebSocket、集計、DB、App Storageは未実装。

## 残る確認

今回のライブ確認は3分と強制切断からの復帰のみ。
SPEC 10節の30分連続受信（米国寄り付き）は、ユーザーの別指示があるまで行わない。
30分条件を満たすまではPhase 1全体の完了とはしない。
