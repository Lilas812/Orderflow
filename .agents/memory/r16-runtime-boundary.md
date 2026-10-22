---
name: R16実行構成の承認境界
description: 有限CLI試験と未接続Data Statusについての承認範囲
---
R16の承認はライブラリ、有限CLI、負荷試験用の容量制限付き親子IPCに限る。常駐化、ブラウザとの実接続、HTTP API、WebSocket、追加ポートは別途承認が必要。

R16.1でも、SQLite transaction粒度、保存APIの意味、チェックサム検証方式、保存形式・schema、Snapshot保存復元方式の変更、追加Worker、新規外部ライブラリには事前承認が必要。

R16.1の例外として、ゲートウェイ内の最大128イベント／先頭未commit受領から10msを目標とするtransaction集約と固定IPC入力比較が承認された。128件超の単一メッセージは分割せず明示拒否する。履歴再生・R14/R15保存処理そのものの変更は未承認。

R16.2は詳細調査・測定・変更設計だけが承認された。最小限の診断コード・テストの追加は可能だが、R14/R15の保存アルゴリズム・整合性検証に影響する最適化は、変更ファイルと保証維持方法を示して追加承認を得るまで実装しない。安全確認前の長時間・大量負荷試験と、7日分の全履歴をメモリへ展開する方式は禁止。

R16.2の追加承認はE単独（索引位置の一時Map照合と旧findとの独立比較）。storageMigration.ts、新規indexVerification.test.ts、r162Diagnostics.ts、r16Worker.ts、r16Load.tsの5ファイルに限定。C*、prefix検査省略、履歴再生の増分化、bounded reader、保存形式・schema・checksum・Snapshot・保持方式の変更は含まない。効果が小さくても別の最適化を自動追加せず、結果を報告して停止する。

R16.3は調査・詳細設計と必要最小限の診断だけを承認。A（全履歴再生）、B（seen Mapコピー）、C（重複decode/checksum）を同時に変更しない。Eを維持し、固定transaction境界の診断と通常動作を区別する。選定した改善の実装は追加承認後。7日分の全イベントを無制限に保持する方式や、重複判定のID情報を省く方式は不可。調査完了後に停止し、R17には進まない。

R16.3の追加承認はC-1のみ。同一write transactionの読取り段階のmetadata再利用に限定し、全原本検証・意味的replay・INSERT後の新世代検証は維持する。viewは同時1、16,384 descriptors／serialized16MiBの暫定予算。これは有限MOCK検証に限る承認で、将来の市場データの保存件数上限ではない。公開read/replayへ上限を適用せず、通常保存にも無断で本番制限として引き継がない。超過時は明示停止し、削除・切詰め・無制限fallbackをしない。C*、seenコピー、schema、checksum、Snapshot、保持方式は別承認。

**Why（C-1の有効化境界）:** ユーザーが予算を「R16.3の有限MOCK検証に限って承認」と明示したため、通常保存を変更せず有限比較CLIで明示有効化する。

R16.4はtransaction-owned seen Map／base＋delta COWの独立プロトタイプ・差分検証・有限計測と統合設計まで。既存core reducer、EventJournalの本番経路、C-1の既定値は変更しない。100/400/1,000件から始め、安全確認後のみ2,000件。プロトタイプ速度を永続化events/sとして報告しない。本番統合、bounded reader、増分検証、durable dedupは別承認。

**Why（R16.4）:** ユーザーが、旧guardEventをoracleとして保持し、B/Cの本番統合を独立検証後に判断すると明示した。

**Why:** ユーザーは既存保存API・形式を維持し、実行構成を無断でサービス化しないことを明示した。

**How to apply:** 次工程の承認があっても通信構成の承認を自動的に含めない。CLI計測値を現在稼働中のブラウザ監視値と混同しない。
