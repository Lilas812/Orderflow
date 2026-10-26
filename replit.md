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
- 2026-10-26：米国寄り付きの連続受信を22:25:11.960〜23:00:00.003 JSTの34分48.043秒実施。最終状態取得まで板8,287件・約定76,685件、受信中の再接続0回、クロス板3件を拒否。SIGTERM後23:00:00.291に上流close（1006）とサーバー停止を確認。開始時の状態取得欠損・終了2秒前の最終取得を含む詳細は server/PHASE1_REPORT.md に追記。残っていた30分連続受信条件を満たし、既存の試験結果と合わせPhase 1完了。1006の原因・フィードの完全性は未解決のまま。Phase 2は未着手。
- 2026-10-26：Phase 2aの列集計・履歴3時間取り込み・ローカル保存/読戻しを実装。単体テスト30件・型検査成功。履歴180窓を10分54.852秒で取得し、完了後10分21秒以上ライブ受信。保存列のランダム3秒は再取得と一致、ライブ/履歴2分は120/120秒で最良気配・全段一致。8ファイル22,129,965バイトを保存し、SIGTERM後の上流close（1006）・停止を確認。履歴68秒とライブ1秒の欠け、履歴2,400行2組の未対応、1006の原因は未解決。詳細はserver/PHASE2A_REPORT.md。Phase 2bには進んでいない。
- 2026-10-27：Phase 2aの4点を修正。逆行約定を保持し、履歴800行×Nの最後の完全な組を採用。通信失敗3回で欠けを記録、直近0行は板/約定別に後回し再取得。42テスト・型検査成功。3時間180窓を8分14.568秒で取得し、L直前60秒は最初の再取得で回復、履歴の欠け15秒。逆行約定3回を含め224,168件の履歴約定の保存を確認。旧実例5件のtsを照合、未記録2件は未確認。8ファイル10,003,996バイトを保存し、SIGTERM後close1006・停止を確認。詳細はserver/PHASE2A_REPORT.md末尾。Phase 2bは未着手。
- 2026-10-27：Phase 2bの5分待ち・/api/ws配信・リプレイ・ws-clientを実装。ws 8.22.0、@types/ws 8.18.2を追加。58テスト・型検査成功。180窓を5分3.651秒（待機込み）で取得。2台各2分で120列が全段一致、10分rangeは600列・9,582約定を742.820msで返却。10倍リプレイは保存末尾が1秒進み301秒分を終了まで確認。新しいL直前60秒・直後5分は欠け0、直前5分に1秒残存。板配信間隔の実測平均約263ms・最大約646ms、長期リプレイのメモリは未検証。SIGTERM後close1006・停止を確認。詳細はserver/PHASE2B_REPORT.md。Phase 3は未着手。
