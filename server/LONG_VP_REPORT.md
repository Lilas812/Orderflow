# 長期VP：データ蓄積の実装報告

2026-10-28。今回の対象はデータ蓄積だけ。長期VP画面・軸のダブルクリック・生約定保存の見直しは未実装。

## 報告

- 実施内容：既存の受信サーバーに、本番限定の長期VP蓄積処理を追加。30分×価格の売買出来高、1分足OHLCと売買出来高、取引日別の取得記録・欠損、限月の切り替え記録をPostgreSQLに保存する。日次の確定にはRESTだけを使う。
- 変更ファイル：下表参照。既存のヒートマップ用App Storage保存、配信形式、画面、正本の仕様書は変更していない。開発側の上流接続禁止は今回の追加指定に従って変更した。
- 確認手順：再Publish後、`/api/status` の `phase2a.longVp` と公開ログを確認する。詳細は「公開後の確認」。今回こちらでは再Publishしていない。
- 実行した確認：サーバーテスト133/133、型検査、本番フロントエンドビルド、実RESTの1分間149約定の独立再取得・集計照合、開発DBの一時テーブルでの原子的保存・ロールバック、開発での起動・HTTP200・上流接続禁止・SIGTERM終了を確認した。
- 仕様との差分：既存正本へ長期VPの本文は差し込んでいない。添付と今回の承認・追加指定を、この機能の作業条件として適用。既存の生約定保存は維持。画面部分は指示された順番どおり未着手。
- 未解決・懸念：本番の7日分取り込み、実時刻17:10 ETのバッチ、本番DBの書き込み・費用・メモリ・CPU・所要時間は未検証。開発起動の初期化が約284秒かかった。撮影はリプレイ初期読み込み中で、リプレイ完走の証明ではない。
- 次の候補：再Publish後の蓄積確認、その後に長期VP画面。軸のダブルクリックは対象画面と自動調整の基準を確認して別タスクで扱う。

## 変更ファイル・主な関数

| ファイル | 内容 |
|---|---|
| `server/src/long-vp/calendar.ts` | `atET`・`session`・`sessionAt`・`batchDate`・`nextBatchUs`。America/New_Yorkの壁時計で18:00〜翌17:00、17:10の日次時刻を計算する。 |
| `server/src/long-vp/aggregate.ts` | `LongAggregate.add`。価格は整数ティック、時刻は整数Unixマイクロ秒。30分×価格の売買出来高と1分足を限月別に保持。時刻の巻き戻りでも始値・終値は取引時刻に従い、同じ内容の正当な複数約定を消さない。 |
| `server/src/long-vp/rest.ts` | `LongRest.roll`・`ticks`、`rollSinceUs`。`/symbols` と直近7日の `/ticks` を使用。キーはサーバー内で読む。行の検査・半開区間の絞り込み・取得失敗の扱いを持つ。 |
| `server/src/long-vp/fill.ts` | `fill`・`missing`・`mergeCoverage`・`contractAt`。不足区間だけを順次取得。取得上限に達した親応答は数えず、窓を分割して取り直す。限月の境界でも分割する。 |
| `server/src/long-vp/store.ts` | `PgLongStore.records`・`rolls`・`load`・`save`・`close`。1取引日の集計と取得記録を同じトランザクションで確定。失敗時はロールバック。取得済み集計を読んで不足分だけを足し、日単位で原子的に置換。完了済みの日は古い未完了バッチで上書きしない。 |
| `server/src/long-vp/service.ts` | `LongVpService.start`・`run`・`trade`・`snapshot`・`stop`、`productionAccumulation`。初回取り込み、日次処理、不足分の回収、当日暫定キャッシュ、状態表示、終了処理。本番判定は `REPLIT_DEPLOYMENT=1`。 |
| `server/src/index.ts` | 既存の同じ約定通知から暫定集計を更新。本番だけで蓄積と上流WSを開始。開発ではRun・SIGUSR2のどちらでも上流へ接続しない。HTTP状態値に `phase2a.longVp` を追加。既存WSのstatus形式は変えない。 |
| `lib/db/src/schema/long-vp.ts`・`index.ts` | `long_vp_sessions`・`long_vp_volumes`・`long_vp_minutes`・`long_vp_rolls` の4テーブルを定義・公開。既存テーブルの移行や置換なし。 |
| `server/package.json`・`pnpm-lock.yaml` | `pg` と開発用 `@types/pg` を直接依存に追加。既存DBパッケージと同じバージョン系列。 |
| `.replit` | DB準備に伴って環境側が `postgresql-16` とNix channelを追加。Runコマンド・公開ルーティング・VM種別・アクセス保護の設定は変更していない。 |
| `server/test/long-vp.test.ts` | 集計、ET境界・夏冬時間、取得・再開・限月境界・暫定値と確定値の分離など14テスト。 |
| `server/test/long-vp-postgres.test.ts` | 開発DBの接続内一時テーブルだけにダミーを書き、実PostgreSQLで保存・失敗時の不変・再実行・完了済み保護を確認する1テスト。 |
| `server/tools/long-vp-rest-check.ts` | WSもDBも使わない実RESTの1分照合。生約定ファイルは作らない。 |
| `replit.md` | Current Statusだけ追記。 |
| `.agents/memory/long-vp-decisions.md`・`MEMORY.md` | 本番限定、ET基準、REST確定、既存保存を勝手に変えないというユーザー指定を保存。 |

## 蓄積・確定の動き

1. 公開サーバーが起動すると、DBの取引日別記録と限月記録を読み、RESTで現行限月を確認する。開発サーバーでは起動しない。
2. 初回は直近7日内の、終了した取引日の不足区間を取り込む。再起動時は取得記録にある範囲を飛ばす。最古の取引日の一部分が7日より前なら、取得できない部分を欠けとして残す。
3. 日次は17:10 **America/New_York**。UTCの時刻を24時間ずつ足す方式ではない。初回取り込み中に日次時刻を過ぎた場合は、その完了後に追いつく処理を行う。
4. **終了した取引日の確定集計にライブのメモリ集計は一切流用しない。** 保存済みのREST集計と、新しくRESTで取り直した不足区間だけで確定する。
5. 書き込み途中に失敗すると、その取引日の集計と取得記録の双方が元のまま残る。再起動・次回バッチで不足だけを再取得する。公開の切り替えで旧新プロセスが短時間重なっても、完了済みの日を未完了の結果で戻さない。
6. 当日分は画面用の暫定メモリ集計。起動前の範囲はRESTで取り込み、初回の接続境界には不完全である印を付ける。暫定値を永続化して確定済みと偽らない。画面/APIの実装自体は次の段階。
7. 取得不能な窓は日時・理由をログと状態値に出す。7日を過ぎた欠損は `recoverable:false` になる。REST応答の取得済み記録であり、提供元内部の未申告の欠落まで保証するものではない。0件の有効応答は休場を含む「取得結果なし」として扱う。
8. 通常運転中は、起動・日次バッチ以外のDBポーリングや約定ごとのDB書き込みは行わない。接続はアイドル1秒で解放。日次バッチ内の1日ごとの複数SQLは1回のトランザクションにまとめる。初回取り込みもDBを使うため、実費を測定するまで月額は保証しない。
9. SIGTERMでは新規処理を止め、RESTを中断する。既存受信サーバーの全体10秒以内という終了予算は延長しない。新たな起動時DDL・公開時DDLスクリプトは追加していない。

### 採用した具体値

- 日次時刻：提案を承認された17:10 ET。
- 取引日：添付どおりET前日18:00〜当日17:00、半開区間。17:00〜18:00は休止。
- 取得窓：最大15分、半開区間、順次取得。`truncated` なら分割し、1秒まで分割しても上限なら欠けとする。
- `/ticks` の上限：公式REST仕様に合わせ100,000行。既存 `/history/ticks` の500,000行とは区別した。
- 通信：既存履歴処理と同じ30秒タイムアウト、通信失敗・一時HTTPエラー・429は初回を含め最大3回、間は60秒。認証失敗は即座に停止状態にしてログへ出す。キーや生の例外を出さない。
- 起動前の当日REST取り込み：対象の終端から5分が経つまで待つ。既存仕様の履歴成熟待ちと同じ扱い。
- REST処理中は1000約定ごとにイベントループへ制御を返し、同じサーバーのライブ処理を長く占有しない。1窓の行と1取引日の集計のみを処理し、生ティック7日分をメモリに保持しない。

## 限月の調査

実REST `/v1/symbols` は200で、NQについて次を返した。

```json
{"symbol":"NQ","contract":"NQZ6","contractSince":"2026-09-14T07:46:50.905071381+00:00","subscribed":true,"streaming":true}
```

直近7日がこの切り替え後なので、今回の対象はNQZ6に対応づけられる。約定行そのもののフィールドは `ts`・`price`・`size`・`side` で、限月はない。`contractSince` は内部の整数マイクロ秒に合わせ、小数のそれより細かい部分を切り捨てる。

公式資料：
- https://tick-stream.xyz/docs/symbols
- https://tick-stream.xyz/docs/rest

公式資料は、ルートNQを期近へ自動切り替えすること、`contract` と `contractSince` で切り替えを検出できること、`contractSince:null` は未検証として扱うことを説明している。将来の切り替え日時を先に決められる十分な規則までは確認できなかった。四半期の特定日を独自計算して確定値として保存しない。

限月不明・切り替え時刻不明・矛盾する記録なら `unverified_contract...` で停止または該当区間を欠けにし、勝手に限月を推定しない。次回のREST確認で新しい切り替えが分かれば記録して期間を分ける。ライブ暫定値の限月情報は日次確認時点のもので、リアルタイムのロール検出を保証しない。確定は終了後のREST情報を使う。

なお公式資料では、個別限月を指定して取得することはできず、ルートの期近の約定だけが公開・保存される。将来の画面で必要な「新旧限月の価格差による調整」は、同時点の両価格の入手方法・差の定義を別途確認する必要がある。今回、推測した調整差は保存していない。

## 実行した検証

- `pnpm --filter @workspace/receiver run test`：133テスト成功。既存118＋追加15。
- `pnpm --filter @workspace/receiver run typecheck`：成功。最後に追加したテストの型ガードも確認。
- `pnpm --filter @workspace/receiver run build`：成功。画面コードの変更なし。
- `pnpm --filter @workspace/db run push`：開発DBに4テーブルの定義を反映。既存のpublicテーブルは0件で、既存データの置換なし。
- PostgreSQLのテストは接続内の一時テーブルだけを使用。publicの4テーブルは確認時にすべて0行。開発DBに実データを蓄積していない。
- 11月1日の夏時間終了：10/31 17:10 ET＝21:10 UTC、11/1 17:10 ET＝22:10 UTC。春の切り替えと17:00・18:00の境界もテストした。
- 再起動・不足窓回復・正当な同一約定の維持・巻き戻り時のOHLC・半開区間・小数秒の限月境界を確認。ライブ暫定値に大きな出来高を入れても、DBの確定値へ入らないことをテストした。
- 取得上限、3回失敗、認証失敗、限月不明、中断、DB途中失敗、同じ日の再実行、完了済み保護を確認。

### 実RESTの1分照合

`node server/tools/long-vp-rest-check.ts`。10分以上前の1分を2回取得し、片方を直接数え、片方を新しい処理で集計した。WS接続0、DB書き込み0。

```json
{"startUs":1793187240000000,"endUs":1793187300000000,"trades":149,"volumeRows":41,"minuteRows":1,"buy":68,"sell":84,"directTrades":149,"directBuy":68,"directSell":84,"matched":true,"gaps":[]}
```

### 起動・ブラウザ・終了

- タスク開始時、開発側に既存の受信PID493があった。SIGTERMで停止し、`upstream_close code:1006`、`upstream_stopped socketClosed:true`、PID消滅を確認。本番は停止していない。
- 変更後の既存Runでは初回が起動待ちのタイムアウト。2回目は待ち時間を300秒にして起動成功。新規長期VPは開発では無効で、既存 `pipeline.initialize()` の待機中だった。ログの無効表示〜HTTP待受まで284.149秒。既存ローカル保存走査が主因と推測するが、詳細な内訳測定・高速化は今回していない。
- `/` と `/api/status` はHTTP200。上流 `state:stopped`・`reconnectCount:0`・`connectedAtUs:null`、長期VPは `enabled:false, reason:production_only`。
- SIGUSR2を送っても上流停止のまま。
- 画面の撮影は保存済みリプレイを指定したが、撮影時は初期range読み込み中。画像をリプレイ集計の一致や再生完了の証拠にはしていない。撮影ページの切断に伴い下流送信エラー2件・close1001が出た。上流の切断ではない。
- 撮影前の検証Chromiumは0。撮影で生成された9プロセスを終了し、残存ブラウザ0、`/api/ws connected:0, connections:[]` を確認。接続制限は使用していない。
- 最終PID27022へSIGTERM。`upstream_stopped socketClosed:true`、`server_stopped httpClosed:true elapsedMs:28.4353`。外部観測で約101.82ms後にPID消滅。開発側は最初から上流を開いていないため、この最終終了で上流closeイベントはない。

証拠：`data/long-vp/server-tests.log`、`dev-status.json`、`dev-final-status.json`、`runtime-events.json`、`browser-cleanup.json`、`dev-stop.json`、`dev-replay.jpg`。

## 公開後の確認

今回、公開操作・本番DBへの書き込み・本番設定の変更はしていない。既存の公開サーバーは旧コードで継続しているため、**本番での長期VP蓄積はまだ始まっていない**。

1. 既存の公開設定で再Publishする。開発DBに追加した4テーブルの定義を、通常の公開フローで本番DBへ反映する。本番データの上書きコピーは不要。起動時DDLや別の本番マイグレーションは実行しない。
2. 公開環境で本番DBが接続されていることを確認する。`phase2a.longVp.enabled:true`。`database_url_missing` または `long_vp_batch_failed` なら、テーブル・接続設定・公開ログを調べる。機密値は貼らない。
3. 公開ログの `long_vp_contract` → `long_vp_window` / `long_vp_gap` → `long_vp_session_saved` → `long_vp_batch_done` と、状態値の `running` → `waiting` を確認する。
4. `sessions` の日付・coverage・gapsを確認する。取得できない範囲を無理にcomplete扱いしない。`error` があれば理由を確認する。
5. 本番DBの4テーブルに取引日・限月・整数ティック価格・出来高が蓄積されることを確認する。
6. 17:10 ETの実行を確認する。11月1日以降はUTC時刻が1時間変わる。再起動後に完了済みの出来高が倍にならず、不足だけが回収されることも確認する。
7. 初回7日と日次それぞれの所要時間、RSS、CPU、DB使用量を測定する。小標本のREST成功だけでは、本番の完走や費用を保証できない。

Replit公式資料も参照： https://docs.replit.com/features/data-and-storage/development-and-production 。通常の再Publishでスキーマ差分を反映し、本番データを維持する。
