# LONG VP日次蓄積・読み取り専用調査

> 以下は当初の読み取り専用調査と診断追加の記録。
> その後のユーザー指示により、日次の独立checkpoint・世代条件付き保存・timeout分割・原因ログを
> 開発側で修正した。最新の修正・検証結果は末尾、公開実行の手順は
> `PRODUCTION_MAINTENANCE_RUNBOOK.md` を参照。本番は未変更。

調査日：2026-10-30。最終ログ調査上限：16:55 UTC。

## 結論と確度

**原因はまだ断定していない。最有力は、日次集計の前提となっている既存履歴復元の長時間待機。**
先行履歴処理の遅延は公開ログで確認できたが、AppLongVp自身の初期化・メタデータ・ready通過のログがない。
したがって「readyで停止した」「buildや保存を一度も実行していない」とまでは断定できない。
保存障害や`improvesDay`による保全判定が原因とする証拠も得ていない。

購入履歴候補の未反映は別問題。`LONGVP_PROMOTION_TOOL_REPORT.md`の候補はローカル隔離保存であり、
本番の日次ファイルや原約定へ自動で反映されない。この調査は購入履歴の採用・反映を行わない。

## 方法・制約

公開環境の調査担当による読み取り専用テレメトリ調査と、親担当によるworkspaceのコード確認。
公開環境はVM、private、成功buildあり。最新成功revisionは
`4945e4fa-8468-4648-884e-74e01bc62266`。

- 公開ログ・build履歴の読み取りのみ。公開HTTP初期化API、上流追加接続、強制保存なし。
- 本番データ・設定・コードの書き込み、再起動、Publishなし。
- App Storageは今回再取得していない。以下の在庫は既存報告の観測値を参照する。
- ブラウザ・アプリ・WSの新規起動なし。閉じるべき検証ブラウザは作成していない。
- 読み取り専用調査時点では製品コード・設定を変更していない。
  その後、ユーザー承認を得てworkspaceに診断ログのみ追加した（後述）。公開版は変更していない。

## 参照在庫と期待時刻

前回の読み取り専用観測（2026-10-30 16:34 UTC付近）：
NQは10/22・23・26・27の4日、GCは0日。
これは保存ファイル数であり、完全日数や日次処理到達段階を示す値ではない。

日次確定境界はCT17:05。10月29日は22:05 UTC。
10月30日22:05 UTCは今回の観測時刻より先なので、10/30分の未確定そのものは異常とはしない。
境界時刻は、先行処理が未完了でも即時保存される保証ではない。

## 公開ログの証拠

以下は調査担当の取得結果。時刻はUTC。

| 時刻・範囲 | 観測 |
|---|---|
| 10/29 17:46:30 | revision `670bab2d-0aca-43c8-8f98-82d514f2d0bd`作成 |
| 10/29 17:49:57 | 同revisionで`server_listening` |
| 10/29 21:12:52 | NQの`history_complete`、180窓、elapsedMs 12,170,042（約3時間23分）。同時刻にNQの`vp_history_started` |
| 同上 | VP復元範囲はstartSec 1793224800〜endSec 1793296200（19時間50分）。同5秒窓のsymbol別検索でNQ 2件、GC 0件 |
| 10/29 22:04〜22:06 | CT17:05を含む。process_memoryのNQ backfillは`complete`。VP履歴の完了ログは確認できない |
| 10/29 23:29:14 | tickの`history_request_failed`、reason `network_or_timeout` |
| 10/29 23:30〜10/30 06:06 | 同revisionの`long_vp`・`vp_history_finished`・`history_complete`・`history_stopped`検索は全ページ取得、0件。06:05:58のprocess_memoryでもbackfillはcomplete |
| 10/29 17:45〜23:30 | GCの`history_complete`・`vp_history_started`は確認できない |
| 10/30 06:10〜08:18 | revision `75e2dcd5…`でhistory_window_completeのcounter最大NQ 28／GC 11 |
| 10/30 08:22〜10:47 | revision `2d256dfe…`で同NQ 27／GC 49 |
| 10/30 10:50〜15:51 | revision `2f26a851…`で同NQ 57／GC 62 |
| 10/30 15:51〜16:55 | 最新revision `4945e4fa…`。NQ/GCともhistory_completeなし。history_request_failed 81件（NQ 42、GC 39）、全件network_or_timeout |
| 10/30 16:54:58 | process_memoryでNQ backfillは`running` |

追加範囲10/29 23:30〜10/30 16:55全体では、
`long_vp`、`vp_history_started/finished`、`history_complete/stopped`、
`startup_failed`、`shutdown_requested`、`server_stopped`、`shutdown_deadline`の各検索結果は0件。
各検索は1ページでtruncated false、後続cursorなしとの取得結果。
history_window_completeの上記各範囲も全ページ取得。

10/30の`server_listening`は06:10:27、08:22:35、10:50:51に確認。
最新revisionは15:54:49頃の起動・その後のstorage初期化と稼働ログがあるが、
revision別のserver_listening行は取得できていない。
build切替とcounterのやり直しは観測されたが、終了理由・各切替の操作者は特定していない。

10/28のrevision `04e9ee5f-152c-483d-af52-e9745acfc053`（22:27作成、22:30 listening）、
`647a1c87-02bf-4eb1-9868-b2179403db6c`（23:12作成、23:16 listening）についても
調査担当はLONG VPイベントを確認できなかったと報告。ただし確定時刻より後の起動であり、
10/28 CT17:05の処理実行を証明するものではない。

build metadataからgit SHAを確認できないため、workspaceと公開実行コードの完全一致は未証明。
最新workspaceの購入履歴ツール等の変更にLONG VP実行コードの変更はないが、
これを公開版一致の証明とは扱わない。

## コード上の依存関係と到達判定

以下は診断ログ追加前の観測可能性。追加後のイベントは末尾に記載する。
参照：`server/src/index.ts`、`gc-runtime.ts`、`long-vp/app-service.ts`、
`long-vp/objects.ts`、`pipeline.ts`、`vp/history.ts`、`vp/trade-history.ts`。

| 段階 | 現行workspaceコード | 今回の判定 |
|---|---|---|
| 開始 | HTTP listeningでNQ/GCのstartを呼ぶ | 公開での個別startログがなく直接確認不能 |
| repository初期化 | 日次list/download、rolls読取 | AppLongVpからの段階ログなし。完了を確認不能 |
| metadata | roll取得後readyへ進む | 同上。購読成功だけではmetadata成功を証明しない |
| ready | seam確立後、backfillとvpHistoryのsettledを待つ | 先行処理の長時間未完了と整合する最有力の待機箇所。ただしAppLongVpが到達した直接証拠なし |
| 当日復元・build | ready後、当日を復元してから成熟した過去日を順に処理 | 開始ログがなく到達確認不能 |
| improvesDay | 既存ファイルがある場合にcoverage・行別数量の保全を判定 | preservedイベント未検出。原因とする証拠なし |
| save | 保存・再DL検証後にday_savedログ | day_saved未検出。保存失敗とは断定できない |
| バッチ終了 | batch_finishedログ、次回待機へ | batch_finished未検出 |

NQ/GC各pipelineは最初の列でbackfillを開始し、backfill完了後にVP履歴復元を開始する。
AppLongVpの日次処理も両方の完了待ちなので、前提処理が長時間続くと日次catch-upへ進めない構造。
稼働版切替により、その稼働中の非同期処理が最後まで進まない可能性もある。
ただしログの不在から処理段階・中断理由を断定しない。

## 影響

- 過去日の日次保存・当日復元が遅れる可能性。購読が動いていることとは両立する。
- 参照在庫で10/28・29が増えておらず、GC日次は0日だった事実と整合する。
- 既存日次や原約定の消失・破損を示す証拠は得ていない。
- 通信失敗は先行処理を遅らせる観測要因だが、通信失敗そのものの原因や上流障害までは未特定。

## 最小対応案と承認境界

1. **まず診断だけ**：AppLongVpの銘柄・run識別子・段階・経過時間を記録する。
   repository初期化、metadata、ready開始/終了、当日復元、日別build開始/終了、
   improvesDay結果、保存開始/結果を識別できるようにする。
   長時間待機時には既存のseam/backfill/VP状態を低頻度で記録する。
   キー・生payload・大量の約定/配列は出さない。
2. 振る舞い、待機順序、保存判定、データ形式、接続数は変えない。
   小さいfake依存によるオフライン試験で、待機・成功・失敗時のログと既存挙動の不変を確認する。
3. workspaceの診断ログ追加はユーザー承認を得て実装した。公開反映・再起動・本番実行は別途承認が必要。
   公開版に診断がない現状では追加観測を得られないため、原因断定は保留する。
4. ready待機が実証された場合に限り、日次catch-upをセッションVP全完了待ちから分離できるか検討する。
   共有storeの排他、ライブ/履歴の継ぎ目、成熟待ち、既存行保護、上流負荷を検証してから修正承認を得る。
   条件を外すだけの変更、強制再保存、improvesDay無効化は行わない。

この報告は原因確定・復旧完了の報告ではなく、確定できた事実と不足証拠を区別した調査記録。

## 承認済みの診断ログ追加

ユーザーが「開発側への追加を承認」を選択。待機条件変更・公開反映は承認範囲に含めない。

### 変更

- `server/src/long-vp/diagnostics.ts`：診断専用のrun ID、段階ID、経過時間、低頻度待機ログ。
- `server/src/long-vp/app-service.ts`：既存処理の開始/終了、build範囲、保存/保全/skipの判断を観測。
- `server/src/index.ts`、`server/src/gc-runtime.ts`：既存のseam相当・backfill・VP状態のスカラー値だけを診断へ供給。
- `server/test/long-vp-diagnostics.test.ts`、`server/test/long-vp-app.test.ts`：外部接続なしの試験。

既存のready、日次境界、成熟待ち、範囲取得、improvesDay、upload/re-download検証、
保存形式、接続数、再試行条件は変更していない。
追加診断のwriter失敗は元の処理を失敗させない。生の例外本文や約定payloadを診断へ渡さない。

### イベントの読み方

全てsymbolとrunIdを含む。同じrunIdとstageIdのstarted/finishedを対応付ける。
runIdは各バッチで新規発行するため、銘柄・稼働期間をまたぐ同名段階を混同しない。
外側のログには既存loggerのrecvUsが付く。

| イベント | 内容 |
|---|---|
| `long_vp_run_started` / `long_vp_run_finished` | バッチ開始・終了。finishedにcomplete/failedとelapsedMs |
| `long_vp_stage_started` / `long_vp_stage_finished` | 段階開始・終了。stage、stageId、結果、elapsedMs |
| `long_vp_stage_waiting` | 未完了の最内段階と経過時間。既存60秒tickから最大5分に1回。新しいtimerなし |
| `long_vp_decision` | improves_dayの有無/結果とsave/preserve、またはalready_completeによるskip |

段階はrepository_initialize、rolls_read、metadata、ready、today_restore、
day_prepare、build、prepared_tail、existing_day_read、save。
buildはdate、startSec、endSec、7日制限を適用したfetchStartSecを記録し、
終了時に約定件数・gapCountのみを記録する（配列は出さない）。
metadata終了はcontractCountとrollErrorを記録する。
待機ログはseamReady、backfillState、vpHistoryState、ファイル/API窓数、
importedTrades、gapCount、成熟待ち期限を含む。状態取得自体が失敗したときはcontextState=unavailable。

例えばreadyのstarted後にwaitingだけ続き、backfill=completeかつVP=runningなら、
そのrunがreadyまで到達してVP復元を待っている証拠になる。
save startedの後にfailedなら保存経路で失敗したことが分かる。
metadata終了のcompleteはメソッドが返った意味であり、未知限月の解消や全データ完全性を保証しない。
失敗の生の原因本文は出さず、既存の安全なlong_vp_failed等と併せて読む。
ログ欠落・終了行未取得だけで停止箇所を断定しない点は変わらない。

### 検証結果と未実施

- `pnpm --filter @workspace/receiver run typecheck`：成功。
- LONG VP・診断の関連試験：36件成功（追加10件、既存26件）。
- `git diff --check`：成功。
- ready中に履歴要求や日次uploadが先行しないこと、通過後の保存、
  完全日のskip、再構築で既存数量を失うときのpreserveをダミーstoreで確認。
- 初期化・metadata・ready・build・saveの各失敗段階、元例外の同一性、
  NQ/GCの識別、runの区別、5分間隔、終了後の記録停止、診断writer失敗時の不変を確認。
- 最初の追加試験は「再実行時の全upload数が不変」という誤った期待で失敗。
  元から不完全な最古日は再構築されるため、対象の完全日が再保存されない期待へ修正した。
  既存の再構築挙動を変えて試験を通したのではない。
- 公開反映・再起動、実App Storage書込、TICK STREAM接続は未実施。
  既存受信を触らず、外部接続なしの試験だけに限定する承認範囲を優先し、workflow再起動もしていない。
- フロント変更なし。ブラウザは起動しておらず、閉じ忘れとなる検証ブラウザなし。

**完了範囲は読み取り専用調査と承認済みworkspace診断追加まで。**
公開での停止段階の確定・復旧確認は未完了であり、公開実行の別承認が必要。

## 追加指示による4点の開発修正

ユーザーは、先にコードを直し、購入42日分の反映と再Publishを1回の保守でまとめるよう指示した。
以下は開発側で実装・検証した結果。上の「診断だけ」という当初範囲を明示的に拡張する指示であり、
本番停止・反映・Publishをこの作業で実行する指示ではない。

1. 日次は先行backfill/VPのsettledを待たない。加えて、既存60秒timerから独立checkpointを動かす。
   起動時、CT16:55、CT17:05以降に保存済み約定だけで集計し、履歴補完の待ち行列に入らない。
   現在日の末尾と未記録区間はgapsに残し、取れた行はcoverage不足の区間でも集計する。
   日次の不足は後の直近7日再構築で補う。取引日範囲・成熟待ちは維持した。
   NQの限月は保存済み日次の明示的な区間、閉じたroll区間、現在のmetadataの最終観測までを根拠にし、
   未確認期間へ旧限月を延長しない。未確認部分はgapとなり、metadata確認後に再集計できる。
2. 日次保存はLRUではなくクラウド最新の世代・本文を読み、最新本文とimprovesDayを比較。
   ifGenerationMatch（不存在なら0）でuploadし、その世代の再DLハッシュを検証する。
   412や世代消失・検証中の外部更新は再読取・再判定し、5回連続競合はエラーで終了。
   SDKの既存公開APIに世代条件がないため、同じsidecar認証のGCS clientを日次の世代操作に使用した。
   `@google-cloud/storage`は既存SDKが使う7.22.0と同じ版を直接依存として宣言した。
3. HistoryClientのnetwork_or_timeoutは、大きい窓なら即座に分割要求を返し、
   backfill/VP共通の範囲読取側が逐次で取り直す。1分以上の子窓だけを作る。
   既存の短い不足区間は外へ広げない。最小・端数窓は3回失敗後にgapとして進む。
   HTTP 5xxの3回上限、429のRetry-After、直近0行の初回+再取得3回、truncated分割は維持。
   失敗ログにsymbol、start/end、elapsedMsを追加した。
4. long_vp_failedには元例外のname/message/stack/causeを上限付きで記録する。
   App Storage SDKのエラーラッパーもcauseを保持する。APIキー等は既存sanitizerを通す。

### 検証

- サーバー全試験：`node --test --test-concurrency=1 server/test/*.test.ts`、**248/248成功**。
- サーバー型検査成功。開発workflowのビルド成功、server_listeningとhealthz=okを確認。
- 実タイマー相当のfake tickでCT16:55のcomplete=false、CT17:05以降の改善保存を確認。
- 別の履歴要求を未完了にした状態でもcheckpointが保存でき、
  後に保存約定が揃うと直近7日再構築で完全になることをダミー依存で確認。
- 古いLRU、初回不存在の競合、外部増量、再判定後の保存/保全、5回連続競合、一時ファイル解放を確認。
- 世代adapterのfake GCS試験で、巨大な世代文字列を丸めずに使い、
  本文の世代固定とifGenerationMatch=0/既存世代、404/412の区別を確認。
  **実クラウドへの条件付き書き込み試験は行っていない。**
- 15分窓の親を同じ幅で再試行せず分割し、1分の3回失敗区間だけをgapとし、
  次窓へ進むこと、response body失敗、abort伝播、銘柄・時間付きログを確認。
- GCの元例外・cause・stackが残り、テスト用キーが伏せられることを確認。
- NQ限月切替後にmetadataが未完了のままCT16:55 checkpointが先行しても、
  旧限月の行を新しい日に作らず、CT17:05の再構築で新限月の行を保存できることを確認。
  最終metadata観測時刻より先を推測しないこと、CT17:01には完全扱いせず17:05以降に改善することも確認。
- 開発起動ログでupstream_disabled、long_vp_disabledを確認。
  本番上流への追加接続・本番書込・公開停止・再起動・Publishは実施していない。
- UIは変更していない。開発プレビューの初期画面を撮影し、上流停止中の待機表示を確認した。
  撮影前に検証Chromiumは0。撮影で起動したChromium本体・子プロセスを終了し、
  実行中の残存ブラウザ0、下流接続0（NQ/GCとも）を確認。ユーザーのブラウザは操作していない。

保守の実行は `PRODUCTION_MAINTENANCE_RUNBOOK.md` の順序・事前条件に従い、ここでは停止する。
