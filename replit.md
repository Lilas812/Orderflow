# replit.md

## Overview

NQ先物（CME）向けの、ヒートマップ型オーダーフロー画面を作る個人用Webアプリ。
データは TICK STREAM（Realtime + L2 プラン）から取得する。将来はフットプリントなどの画面を追加する。

- 全体仕様の正本：`docs/SPEC.md`
- 画面仕様の正本：`docs/UI_SPEC_HEATMAP.md`
- 作業ルール：`docs/AGENT_RULES.md`（すべての作業に適用する）

## User Preferences

- 報告と質問は日本語で、簡潔に書く。
- 1回の依頼で1つのタスクだけを行い、終わったら止まって報告する。
- 仕様にないことを推測で埋めない。判断が必要なら質問する。
- ユーザーは情報工学の学生でコードは読める。変更点はファイル名・関数名まで具体的に書く。

## System Architecture

- サーバー：Node.js + TypeScript の1プロセス。TICK STREAM への接続（1本だけ）、正規化、板の状態管理、集計、保存、ブラウザへの配信をすべて持つ。
- ブラウザ：Vite + TypeScript。チャートは Canvas で描画する。ブラウザは TICK STREAM に直接接続しない。
- 配信：サーバー → ブラウザは WebSocket。板はサーバーで間引いてから送る。
- 保存：デプロイ環境のファイルシステムは再デプロイで消えるため、永続データは Replit App Storage に置く。
- 詳細は `docs/SPEC.md` を参照。

## External Dependencies

- TICK STREAM
  - WebSocket：`wss://stream.tick-stream.xyz/v1/stream`
  - REST：`https://api.tick-stream.xyz/v1`
  - APIキー：Secrets の `TICKSTREAM_API_KEY`（コード・ログ・ブラウザに出さない）
- Replit App Storage（永続データ）
- 公開時：Reserved VM デプロイ、アクセスは Invite only

## Protected Files

次のファイルと節は、ユーザーの明示的な許可なく変更しない。

- `docs/AGENT_RULES.md`
- `docs/SPEC.md`
- `docs/UI_SPEC_HEATMAP.md`
- この `replit.md` の Overview / User Preferences / System Architecture / External Dependencies / Protected Files 節

Agent が更新してよいのは、下の Current Status 節だけ。

## Current Status

- 2026-10-25：Phase 0 の中間報告（docs/PHASE0_REPORT.md）を作成。日曜で市場が閉まっていたため、取引時間中のライブ測定は未了。
- 2026-10-25：仕様一式を docs/ に配置し直し、SPEC.md を中間報告の内容で更新。チャットに添付された古い仕様書は使わない。
- 2026-10-26：Phase 0 は未解決項目を残してユーザー判断で完了。SPEC.md を許可された新版に差し替え、PHASE0_REPORT.md に判定の追記を実施。
- 2026-10-26：server/ に Phase 1 受信基盤を実装。単体テスト17件・型検査成功、取引時間中の3分受信とSIGUSR2による再接続・再購読を確認し、サーバー停止済み。30分連続受信は未実施のためPhase 1全体は未完了。詳細は server/PHASE1_REPORT.md。
