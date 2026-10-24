# Orderflow Lab Electron診断 — 調査ノート

**Status:** complete
**Depth:** Deep

## Plan

- Question: 既存証跡に基づき、RSS監視とDelta品質ゲートの停止原因を切り分け、Windows製品へ進む最小修正を設計する。
- Scope: ソース・既存証跡の読み取り、公式資料の検索、調査成果物の新規保存のみ。実装・試験起動・profile削除・市場接続はしない。
- Audience: 実装・検証責任者。
- Deliverable: 詳細技術レポート、参照資料台帳、次工程用の実装指示1本。
- Current baseline: main / 2c6508edfd7db374949e8de268381d6c571c723e、開始時clean。

## Focus Areas

| # | Area | Status | Sources |
|---|---|---|---|
| 1 | Linux procfs、終了競合、PID同一性 | complete | upstream v6.18 array/task_mmu/exit、kernel proc、pidfd |
| 2 | Node ChildProcess、例外、証跡、cleanup | complete | Node24.22.1 child_process、24.17 process/stream |
| 3 | Electron lifecycle、security、テスト | complete | Electron45固定tag、公式release、Playwright |
| 4 | Windows Job/handle、working set、負荷観測 | complete | Microsoft Learn / MicrosoftDocs |
| 5 | React/Canvas/WebGL、commitと実描画の区別 | complete | React、MDN、web.dev |

## Coverage Checklist

- [x] RSSエラー発生箇所と、記録が失われる全経路を実ソースで示す。
- [x] Linux終了競合の確認済み事項と元試行の未観測事項を分ける。
- [x] Stage別のDelta品質、reference、実描画、現行ゲートを照合する。
- [x] 過去HOLDの共通原因と、前段で検出できる試験を示す。
- [x] Linux/Windowsの所有権・資源監視adapterの契約を示す。
- [x] 最小修正ファイル、STOP条件、Stage 1→2の承認境界を示す。
- [x] 旧証跡・ソース不変、追加ブラウザ/Stage起動0を確認する（Library管理metadata登録のみ別記）。

## Findings Log

- run.mjs:108–120 の終了監視/回収は、主try/finally後かつ結果保存前。例外でStage結果保存が飛ぶ。
- process.mjs:12 がRUNNING_RSS_UNKNOWNの単一throw元。groupはtargetPid/snapshotを付けるが、親summaryはString(error)だけを保存する。
- 元試行にPID・stat/status・stackがないため、Linux競合を直接原因と確定できない。
- upstream v6.18ではproc_pid_statusのif(mm)がVmRSS出力を制御し、exit_mmがEXIT_ZOMBIE設定前。元試行原因は未確定。
- Stage1はcoverage1.33秒に対して2秒epoch bin。UNKNOWN数量57。NO DATA/nullは保存referenceと一致。
- 調査ノートのLibrary提示で管理metadataのみ自動更新。製品変更とは分けて記録する。

## Conflicts & Open Questions

- Stage 1 native PASSと親Stage FAILは異なる判定。片方を他方で代替しない。
- NO DATA referenceと「全Stageで有効Delta必須」ゲートの不一致を調査する。

## Gaps

- 元Stage 1の例外時PID/状態/stackは未保存。新規再現試験は今回行わない。
- Windows実機/物理GPU/Stage2実行は未検証。今回の研究では解消できない。
- Electron release日付は検索snippetと取得本文でOct20/21の差。version組合せは一致。日付を捏造して統一しない。

## Deliverables

- report.md：10節の技術報告。31外部資料の番号を台帳から機械生成。
- implementation-prompt.md：次工程7ファイルの承認案。今回の実装許可ではない。
- source-registry.json / sources/：取得日時、version、適用制限を含む資料台帳・保存本文。
- local-findings.json：保存済みblockのSHA/非損失復元とStage別品質の静的分析。
- baseline.json / integrity-final.json：開始時・終了時の元ソース/既存証跡SHA照合。
- review.md：確定事項/仮説、資料の限界、修正した誤解の確認。
