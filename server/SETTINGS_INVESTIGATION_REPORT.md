# 設定保存タイムアウト・画面の重さの切り分け

調査日：2026-10-29。**動作修正なし・本番PUTなし・再公開／再起動なし。**

**追加承認後の観測コードは8節。B・Cの修正は未実施。1〜7節は初回調査の記録。**

## 1. 結論

- 対象はユーザー確認の**公開アプリ、Windows Chrome、日本時間20:45頃
  （UTC 11:45頃）**。開発プレビューのCPU値とは区別した。
- 公開の設定APIが約10秒かかる事実は確認できた。**公開の遅延箇所とCPUの
  処理別内訳は未特定**。要求ID、I/O別時間、イベントループ遅延、ブラウザ
  トレースが当時記録されておらず、後から同時刻の因果を復元できない。
- **10秒Abortは保存の取り消しではない**ことを隔離試験で確認した。応答が
  得られなかった場合、未保存ではなく「保存結果不明」と扱う必要がある。
- 現在の公開GETと、Workspaceからの同一prod設定オブジェクトの読み取りは、
  いずれも `updatedAt=1793219485052000`（UTC 10/28 20:31:25.052、
  JST 10/29 05:31:25.052）。今回の提示値とも一致しない。
  **今回の値は調査時点の永続設定には残っていない**。当該要求の到達／中断時点や、
  途中で保存され別操作に戻された可能性までは、履歴不足で証明できない。
- 保存後の大口板再構築で212msのブラウザ長時間処理を再現した。ただし提示値の
  `bigTopPct=2 / bigMinSec=5`は初期値と同じで、今回の提示値を初期値から反映した
  試験では再構築は起きていない。**ユーザーの10秒保存遅延の原因とは断定しない。**

## 2. 接続・保存経路

公開メタデータは `vm / successful / public`。想定仕様のInvite onlyとの一致は
この調査では確認していない。公開先の変更はしていない。

`artifacts/heatmap/.replit-artifact/artifact.toml`の `/`, `/api`, `/api/ws` は同じ
Nodeサービスに転送される。画面の `requestSettings()` は同じoriginの
`${BASE_URL}api/settings`へGET/PUTし、fetchからJSON読み取り・検証まで10秒Abort。
`NODE_ENV=production`だけでは公開と判定されない。

`server/src/index.ts`は以下で保存方式を選ぶ。

| 条件 | 設定保存 |
|---|---|
| `REPLIT_DEPLOYMENT=1` | `AppSettings`、`prod/settings.json` |
| 開発で`HEATMAP_STORAGE=app-storage`または`LONG_VP_DEV_ENABLE=1` | `AppSettings`、`dev/settings.json` |
| その他の開発 | `LocalSettings`、`data/settings.json` |

開発の該当環境変数は設定一覧に存在せず、既存PID 409の状態は上流`stopped`、
longVp無効、CPU 10/60秒平均0.0142/0.0165コア。起動済みプロセスの環境そのものを
採取していないため、環境一覧だけから過去の実行条件は断定しない。これを公開負荷の
反証には使わない。

`AppSettings.put()`：

1. GETと共通のPromise直列キュー待ち。
2. exists → cloud download → stagingへのrename → corrupt backup一覧list。
3. 原本検査。破損時は原本のクラウド退避・再DL照合。
4. `LocalSettings.put()`で一時ファイルwrite → fsync → rename。
5. SHA計算 → upload → 別名へdownload → SHA比較 → 検証ファイル除去。
6. PUT応答 → ブラウザJSON検証 → `onSaved` → `applySettings()` → 閉じる／描画。

`settings_saved`ログは4のローカル保存完了で、5のクラウド検証完了ではない。
HTTP切断をstoreへ伝える実装はなく、画面は保存応答成功後にのみ反映する。
大口板再構築はその後なので、通常は応答前のクラウド待ちとは別問題。

## 3. 公開の読み取り観測

公開テレメトリーの調査担当が取得した集計：

| UTC時間帯 | `/api/settings`件数 | 平均 | p50 / p95 | 4xx / 5xx |
|---|---:|---:|---:|---:|
| 11:43–11:48 | 11 | 7.96秒 | 9.17 / 10秒 | 8 / 0 |
| 11:45–11:48（上記の部分集合） | 6 | 7.18秒 | 10 / 10秒 | 4 / 0 |
| 11:48–11:51 | 3 | 9.72秒 | 8.75 / 10秒 | 2 / 0 |
| 11:49–11:50（上記の部分集合） | 1 | 9.999秒 | — | 1 / 0 |

件数はGET/PUTを区別しないendpoint集計。4xxをAbort、特定の保存要求、
アプリ自身の400と同一視しない。HTTP集計には遅れて反映される制約がある。
CPU等のメトリクス時系列問い合わせは取得エラーで使えず、CPU値はアプリログ由来。

- 11:43〜11:47頃の`process_memory`：CPU 10秒平均0.96〜1.11コア、
  60秒平均0.97〜1.04コア、RSS約370MB。
- 11:44:30.501Z：`history_wait`、`ms:60000 / reason:network_or_timeout`、
  `history_request_failed`（tick）。
- 11:45:05.493Z / 11:46:51.232Z：上流watchdog `silentMs:30000`。
- 11:49:50頃：CPU約0.98 / 0.98コア、RSS約370MB。
- 当該窓の`settings_saved`は見つからず、longvp処理の実行ログも確認できなかった。
  長期VP関連endpointの4xxは存在するが、CPUを長期VPへ帰属させる根拠ではない。
- 窓内のbuildなし。直近成功buildは10/28 23:12Z。固定コードと公開buildの
  ソース一致をハッシュで証明できてはいない。

別時刻の単発読み取り：

| 実施時刻 UTC | 観測元・対象 | 所要時間 |
|---|---|---:|
| 12:01:14頃 | Workspace → prod設定Objects（GET相当のみ） | 4,244.10ms |
| 同上 | 内訳 exists / download / list | 2,573.67 / 343.88 / 1,321.76ms |
| 12:01:42頃 | Workspace → 公開`GET /api/settings` | headers 6,388.67ms、本文完了6,391.83ms |

Objectsのuploadは試験ラッパーで禁止。取得ファイルは隔離ディレクトリのみ。
この数秒の読み取りはクラウド往復も候補である根拠だが、公開VMからの実PUTとは
接続・認証・キャッシュ・負荷・時刻が異なる。差分をCPU待ち時間と計算しない。

## 4. 隔離した保存・Abort再現

既存の並行作業にはversion 4・描画変更があったため触らず、調査開始時の確定HEAD
`e56cfed8425353d56d978524a0f52e626d82eee5`を`/tmp/settings-investigation-baseline`
へ展開。version 3の`AppSettings`、`LocalSettings`、実`settingsRouter`を使用。
Objectsだけを**ダミー**へ置換し、値とクラウド相当の出力を隔離先へ保存した。
本番・devのクラウドへPUTしない。

UTC 11:59:53〜12:00:21頃の同一run：

| 段階 | 結果 |
|---|---|
| 通常GET / PUT | 本文完了36.26 / 32.92ms |
| 通常PUT送信→サーバー到達 | 3.26ms |
| 到達→最初のObjects操作（JSON処理等含む） | 6.41ms、空キュー。純粋なqueue値とは区別 |
| 初回exists / download / list | 0.017 / 0.301 / 0.007ms（ダミー） |
| list終了→ローカル保存ログ | 12.88ms（read・validation・fsync・rename等の合計） |
| upload / verify download | 0.598 / 1.929ms（ダミー） |
| verify download終了→HTTP finish | 2.27ms（SHA・cleanup等含む） |
| 到達→HTTP finish | 26.12ms |

再DLだけに12秒のダミー遅延を注入：

- PUT A（bubbleMin=21）：10,004.94msでクライアントTimeoutError。
  HTTP `close finished:false`。この時点でローカル・ダミークラウドとも21。
- 切断後もverifyは12,000.85msまで継続しSHA検証が完了。
- 250ms後に送ったGETとPUT B（22）はサーバーに到達済みだが、
  先行PUTの検証を待った。GET本文完了11,767.75ms、PUT B 11,784.89ms。
  実ブラウザと同じ10秒予算なら、これらも先行保存の待ちだけでタイムアウトし得る。
- GETは21を返し、その後PUT Bが22を保存。最終GETは22で順序保持。
- 別途upload前の失敗を注入：PUTは500、再GETでは以前の22を維持。
  `settings_saved`だけでは永続化成功を判定できないことも確認した。

同一試験Nodeの27.91秒でCPU 743.91ms（平均約0.027コア）、
loop p99 10.99ms / max 15.30ms（10ms分解能）、GC計7回・10.13ms、
最終RSS159.18MB。したがって**CPU飽和がなくても10秒超は再現可能**。
これは設定専用サーバーであり、履歴・上流・長期VPは実行していない。
公開のCPU原因やGC寄与を再現した結果ではない。

## 5. 画面処理を分離した結果

Chromium headless、1280×800・DPR 1、Workspace、version 3のblock描画。
実保存固定fixture：2時間内5,689列・71,245約定。初期30分の実受信相当は
1,798列、データ欠けは埋めず、実WebSocketの代わりに既存frozen-feedを使用。
画面・ログは「ダミー接続・実保存固定再生・隔離設定」と表示。
実クラウド保存は使わず隔離LocalSettingsへ保存。

指定値は上限auto 5%、下限size 50、gamma 1、bubbleMin 20 / scale 3、
bookBarPct 10 / opacity .5、bigTopPct 2 / minSec 5、Asia/Tokyo。
非表示入力のheatUpperSize等は既存version 3の値を維持。

| 操作 | 通信ヘッダー待ち／本文読み取り | フレーム／長時間処理 |
|---|---|---|
| 初期値で開く | GET 4.60 / 0.40ms | 最大3.30ms、longtaskなし |
| 提示値を保存 | PUT 130.70 / 0.80ms | 最大6.60ms、longtaskなし |
| 提示値で開き直す | GET 3.80 / 0.70ms | 描画フレーム0、longtaskなし |
| 大口板minSecのみ5→6 | PUT 17.10 / 0.50ms | 描画0.10msとは別にlongtask 212ms、rebuild 210ms |
| バブル倍率のみ3→1 | PUT 12.70 / 0.70ms | overlay 0.90ms、longtaskなし |
| 上限のみ5→4% | PUT 9.20 / 0.80ms | 最大4.40ms、再色付け1.00ms |
| 提示値へ戻す | PUT 16.10 / 0.60ms | minSec戻しでlongtask 210ms |
| 提示値で時間zoom 20操作 | 設定通信なし | 35フレーム、平均8.93 / 最大19.90ms、longtaskなし |
| 提示値でpan 20操作 | 設定通信なし | 42フレーム、平均6.74 / 最大20.60ms、longtaskなし |

提示値保存では1,798列を維持し、大口板rebuildCountは1のまま。
初回反映フレームはPUT開始約140.8ms後、ヘッダー受信から約10.1ms後。
色変更では462,177画素の再色付けを観測したが数msの範囲。
下限50はこのfixtureでは上限6以上となるため実効下限5へ既存ルールで補正される。
保存値50を変更したわけではない。

別のNode単体測定で同じ実5,689列のrebuildは3回765.64 / 739.50 / 732.34ms。
これはブラウザ値ではない。7,200列最大・高DPR・公開ライブ負荷・ユーザーPCを
再現したものでもなく、数値を外挿して原因を断定しない。VPはダミー配信で
データを供給していないので通常のVP／長期VP負荷の検証には使えない。
初期ロード・実ライブ継続時の重さも未検証。

画面のGET/PUTはfetchラッパーで時刻記録し、本文clone読み取りの小さな観測負荷が
ある。ステージ間の待機1.15秒は計測時間に加算せず、フレーム値を抽出した。
開閉そのもののlayout時間は独立計測していない。longtaskは50ms以上のみ。

## 6. 根拠付きの最小修正案（未実装・要承認）

| 候補 | 根拠・内容 | 影響／回帰確認 | 元に戻す方法 |
|---|---|---|---|
| A. まず観測だけ追加 | 公開でqueue/I/O/loop/CPU内訳がない。`settings/routes.ts`、`settings/app.ts`、`store/objects.ts`、`diagnostics`に匿名request ID・queue・I/O・クラウド検証完了・応答closeを記録。数値loop/GCと短時間CPU samplingを対応させる。クライアントは操作区間longtaskと通信段階を記録 | ログ量・計測CPUが増える。秘密、本文、ヘッダー、スタック中の機密を出さず、opt-in短時間。待ちと処理時間を分ける。公開の組込み・再公開は別承認が必要 | 観測フラグ無効化／追加コードを戻す。設定形式・保存保証は変更しない |
| B. Timeout時は結果不明と伝える | 隔離で「保存済みでも10秒失敗表示」を再現。`data/settings.ts`、`settings-ui.ts`、`settings-form.ts`で通信中断と確定拒否を区別し、読戻し照合を案内。自動再保存や先行成功表示をしない | 失敗文言・再確認導線が変わるため承認が必要。読戻し失敗／キュー待ち／別端末更新／遅延成功を試験。値一致だけで元要求の成功とは断定しない | UI・error分類だけ戻す。サーバー永続化は変更しない |
| C. minSecだけならrebuildしない | `main.ts:applySettings()`は`settingsChanges.big`で一律`BigOrderFeed.reconfigure()`。minSecは描画側で使うため5→6でも212ms停止。top%変更だけ再構築する案 | 初期同期、閾値変更、URL上書き、継続時間変更の結果を比較。今回の10秒遅延は直らない可能性が高い。chunk化やWorker化は今回の最小案に含めない | 条件分岐を従来のchange.bigへ戻す |

timeout延長、照合省略、クラウドGET省略、list省略、履歴停止、初期値変更は提案に
含めない。各処理が遅い場所だと確定する前に永続化保証を変えない。
**次の変更前にA／B／Cそれぞれの許可を求める。現時点ではすべて未実施。**

## 7. 成果物・再現・終了確認

追加した調査コードは`server/tools/settings-investigation.ts`のみ。本体には未import。
一時観測はこのコードのHTTP middleware、ダミーObjectsラッパー、CDP注入のみ。
既存サーバーや公開コードには追加していない。

既存のversion 3固定チェックアウトと依存symlinkを用意した上で：

```sh
cd /tmp/settings-investigation-baseline/artifacts/heatmap
node /home/runner/workspace/artifacts/heatmap/node_modules/vite/bin/vite.js build --config vite.config.ts
cd /home/runner/workspace
node server/tools/settings-investigation.ts /tmp/settings-investigation-baseline data/settings-investigation-NEW
```

出力先は空ディレクトリ限定、version 3の14項目チェックあり。現在の並行開発コードを
そのままbaselineにしない。fixtureを新規作成し直す必要はなく、既存を読み取り使用。
調査スクリプトは通常のsrc/test型検査対象外。実行で検証した。

- 隔離build成功。調査スクリプトの保存継続・順序・失敗readback・UI値のassert成功。
- 初回実行はCDP評価でトップレベルconst再宣言の調査コードエラーが発生。
  finallyでブラウザPID 611とサーバーを終了済み。IIFEへ直した再実行は成功。
- 固定checkoutで `node --test server/test/settings.test.ts server/test/app-storage.test.ts
  artifacts/heatmap/test/settings.test.ts artifacts/heatmap/test/settings-form.test.ts`：
  28/28成功。並行作業中の全体コードを検証したという意味ではない。
- 生記録（既存のgit/deploy除外`data/`内）：
  `settings-investigation-complete/{result.json,events.json,full-rebuild.json,isolated.png}`、
  `settings-investigation-cloud-read/{timings.json,public-get.json}`。
  クラウドから取得した設定本体は隔離先のみに保持し報告書へ転記していない。
- 使用した成功runのChromium PID 793はexit確認、CDP port 9237閉鎖、
  target閉鎖確認。失敗runを含め最後のプロセス一覧でChromium残存0。
- 検証HTTPサーバーはin-process ephemeral port 42729をcloseし`listening=false`。
  この試験には実`/api/ws`の接続は0（frozen-feed使用）、上流WSコードも起動していない。
  既存PID 409は停止／再起動していない。
- 調査前後のSHA-256一致：仕様4件、`.replit`、lockfile、`data/settings.json`、
  固定fixtureのcolumns.bin/trades.json。既存の描画・設定version変更には触れていない。

未確認：ユーザー端末の当時HAR／Performance記録、公開VMの同時刻loop/GC/CPU内訳、
PUT個別段階・再DL時間、7,200列・高DPRのブラウザ実測、公開設定の過去の各版。
この不足を埋めずに「CPU飽和が保存失敗の原因」とは結論しない。

## 8. Aの観測コードのみ追加（ユーザー承認後）

### 8.1 範囲と変更ファイル

ユーザーの追加指示によって、保存経路の**計測だけ**を実装した。
初回調査で提案したB（結果不明表示）・C（大口板再構築抑制）は実施していない。
公開PUT・再起動・再Publish・クラウド検証書き込みはしていない。
この追記時点では、公開原因は依然未確定。

| ファイル／主な関数 | 追加内容 |
|---|---|
| `server/src/settings/trace.ts`（新規）`SettingsTrace` | 匿名ID、リクエスト受付／HTTP終了／保存最終結果、5秒窓のCPU・loop・履歴状態、無効化・自動停止 |
| 同上 `settingsQueue / settingsStage / settingsOperation` | AsyncLocalStorageで同じ要求へ待ち・各工程時間を帰属。本文・戻り値・例外内容を記録しない |
| `server/src/settings/routes.ts` `settingsRouter` | 任意の観測middleware、store呼出しの最終結果。入力拒否・JSON不正はHTTP結果だけを記録 |
| `server/src/settings/app.ts` `serial / get / put` | AppSettingsの直列待ち、クラウド取得（exists/download/list等込み）、upload/照合の計測 |
| `server/src/settings/local.ts` `serial / get / put` | LocalSettingsの待ち、読取／保存の所要時間。version 4を含む既存処理は維持 |
| `server/src/store/objects.ts` `uploadVerified` | 任意の観測コールバック。元ファイルSHA、upload、再DL＋SHA比較を分離 |
| `server/src/status/app.ts` `createStatusApp` | 既存の設定routerへ観測インスタンスを渡す任意引数。API本文の形式は変更なし |
| `server/src/index.ts` `main / shutdown` | 明示フラグがある場合のみ計測を生成。HTTP待受前に開始し終了時に停止。実保存方式・公開／開発をログに付ける |
| `server/test/settings-trace.test.ts`（新規） | 隔離HTTP・一時ファイル・ダミーObjectsで7試験 |
| `server/tools/settings-trace-overhead.ts`（新規） | クラウドを使わない有効／無効の負荷比較。ブラウザや上流を起動しない |
| この報告書 | 変更、検証、計測負荷、公開反映後の判定方法を追記 |

設定の値・version・形式、fsync/rename、破損退避、GET/PUTキュー順序、
upload後の再DL/SHA照合、失敗時のHTTP動作は変えていない。
フロントの10秒Abort・描画・Phase 14の既存変更・仕様正本・依存・デプロイ定義も
変更していない。計測コールバックは結果や例外をそのまま呼出元へ返す。
計測用loggerの障害だけは、保存を新たに失敗させないため計測内で隔離する。

### 8.2 有効化・停止・ログ量

- **初期状態は無効**。`HEATMAP_SETTINGS_TRACE`が起動時に正確に`1`のときだけ
  計測インスタンス・タイマー・loopヒストグラムを有効にする。
- 無効にするにはフラグを未設定または`0`にして、次回の承認済みプロセス起動時に
  適用する。**今回は環境変数も稼働プロセスも変更していない。**
- 1回の有効化はHTTP受付開始から**最大15分**。自動停止時にタイマーとloop計測を
  解放し、新規要求の記録も停止する。操作用HTTP APIや自動再起動は追加していない。
- 停止前に受け付けた保存は、元の順序で継続し、最終結果の記録を残す。
  計測停止は保存のキャンセルではない。
- リクエスト1件につき通常3行（start / operation / http）。
  検証前の入力拒否は2行。工程ごとのログは出さず、固定キーの集計にまとめる。
- 定期ログは5秒に1行、最大15分で約180行＋開始終了。
  loopは20ms分解能で、ヒストグラムは窓ごとにreset。CPU値はプロセス全体のコア数。
  各要求のCPU使用量や処理別プロファイルではない。
- セッション内の全GET/PUTを記録するため、要求数に比例してログ量は増える。
  不自然に多いアクセスがある場合は、15分上限だけで十分な対策とはみなさない。

### 8.3 ログの読み方

全イベントに`pid / environment / persistence`を付ける。
`environment`は`published`または`development`、`persistence`は`app-storage`
または`local`。時刻はUnixマイクロ秒整数、所要時間は単調時計由来のms。
UUIDはサーバー生成で、端末・ユーザー・認証情報を含まない。

| event | 主な記録・解釈 |
|---|---|
| `settings_trace_enabled / disabled` | 計測窓の境界。15分の期限はenabledの`durationSec` |
| `settings_trace_start` | `requestId / method / startedAtUs`、その時点の履歴状態 |
| `settings_trace_operation` | 同じIDの`endedAtUs / elapsedMs / result / clientDisconnected / queues / stages`。HTTP接続とは独立したstoreの最終結果 |
| `settings_trace_http` | 同じIDのHTTP開始終了・合計時間。`ok / http_error / client_disconnected`とstatus（切断時null） |
| `settings_trace_runtime` | `windowStartUs / windowEndUs / elapsedMs / cpuCores`、同じ時間窓のloop p99/max、履歴状態・累積requests/errors/retries、REST待機中か |

`queues.app.ms`と`queues.local.ms`はそれぞれ**enqueue→実行開始**の合計待ち。
AppSettingsからLocalSettingsへ入る際も同じIDだが、2つのキューの待ちを混同しない。

`stages`は工程ごとに`calls / ms / failed`のみ：

- `cloud_fetch`：ディレクトリ準備、exists、現設定download/rename、
  破損退避一覧list（クラウド取得に付随するI/O全体）。
- `local_read / local_save`：LocalSettingsのキューを出てからの処理。
  保存は入力検査、必要ならローカル破損退避、write/fsync/rename、cleanup込み。
- `source_hash / upload / verification`：元ファイルSHA、upload、
  再DLと再DLファイルSHA比較。検証用ファイルの除去時間はoperation合計に含むが
  verification工程には含めない。
- 破損原本のクラウド退避も同じ保証を維持し、`backup_`の別キーで記録する。

工程はすべての処理を完全に覆うものではない。例えばJSON解析、原本検査、
最後のcleanup、HTTP本文の送信は別に存在し、工程和を総時間と同一視しない。
`calls=0`相当の未実行工程はキー自体を出さない。

`operation.result=ok`はstoreのPromiseが正常に返った意味。
AppSettingsのPUTなら再DL照合とcleanupまで完了したことを示す。
GETで既存のローカル読取失敗→初期値経路を通った場合は`read_fallback`、
例外で返った場合は`failed`。例外メッセージは出さない。
`http.result=ok`はサーバーでレスポンス書込みが完了した意味であり、
ブラウザの受信・画面反映成功を保証しない。

start/httpにも直近のloop窓を載せるが、**loopWindow内の窓時刻**を見ること。
その要求専用に計ったloop値ではない。保存工程の間に履歴状態が変わったかは、
同時刻のruntimeログと既存の履歴ログを照合する。

### 8.4 公開反映後の確認・判定手順（未実施）

公開反映とフラグ有効化は、この報告を確認したユーザーの別承認後に判断する。
調査用PUTを公開へ送る前提にしない。通常操作で発生した要求だけでも照合可能。

1. `settings_trace_enabled`を探し、`published / app-storage`とPIDを確認する。
   developmentの記録を混ぜず、15分の計測窓内だけを対象にする。
2. 遅れたGET/PUTのstart→operation→httpを`requestId`で対応付ける。
   `startedAtUs / endedAtUs`をユーザーの時刻やAPI集計へ合わせる。
3. `queues.app.ms`が大きければ、同じPIDで先行したIDのoperation終了を調べる。
   同じキューで待っていた事実は示せるが、先行要求を原因とする判断には時系列も必要。
4. `cloud_fetch / local_save / upload / verification`のどこで待つかを分ける。
   ここで初めて次の細分化や改善案を決める。待ちを省略したり照合を削ったりしない。
5. 同じ時間範囲を覆うruntimeのCPU・loop、履歴のrunning/waitingと
   requests/errors/retriesの差分、既存`history_*`／上流ログを比較する。
   高CPUだけで設定処理のCPUと断定しない。loopの遅延とクラウドの待ちも区別する。
6. HTTPが`client_disconnected`でも、後の同じIDのoperationが
   `ok`なら「切断後にサーバー側保存完了」、`failed`なら「サーバー側処理失敗」。
   ただしupload後の検証失敗ではクラウドの値が更新済みの場合もあるため、
   `failed=元の設定のまま`とは断定しない。
7. operationがない場合は、HTTPが入力拒否だったのか、まだ処理中か、
   計測窓外／プロセス終了／ログ欠落かを確認する。未保存と決めつけない。
8. 計測終了のdisabledを確認し、それ以後に新規start/runtimeが増えないことを確認。
   既に受け付けた要求のoperation/httpが遅れて出ることは正常。

今回クライアントへ計測やIDヘッダーは追加していない。
送信前のブラウザ停止や、応答後の描画停止をこのサーバーログだけで確定することは
できない。必要になった段階で、ブラウザ記録の取得方法を別途提示する。

### 8.5 検証結果・計測負荷・終了確認

実行：

```sh
pnpm --filter @workspace/receiver run test
node --test server/test/settings-trace.test.ts
pnpm --filter @workspace/receiver run typecheck
node server/tools/settings-trace-overhead.ts
node --check server/tools/settings-trace-overhead.ts
git diff --check
```

- サーバー全体165/165成功。その後追加した2試験を含む観測専用7/7成功。
  型検査・構文検査成功。全体試験後の変更は窓時刻・保存方式の観測フィールドと
  観測テスト／負荷測定ツールであり、保存ロジックの変更ではない。
- 観測7試験：IDの混線なし、先行PUT→GET→後続PUTの値・順序一致、
  全工程と待ち時間、**実10秒Abort後の遅延成功**、
  停止後も処理中要求の最終結果が出ること、upload失敗・SHA不一致、
  不正入力／JSON、機密の非出力、Local読取fallback、無効時ログ0、
  logger障害時の保存成功、CPU負荷・loop停止検出、15分自動停止。
- 計測対象は各試験のephemeral HTTPと新規一時ディレクトリのみ。
  クラウド・上流へ接続せず、検証終了時にHTTPをclose。
  Phase 14のfrontendファイル・仕様・設定schema・依存・Run定義の差分なし。
- ブラウザは今回起動していない。前回調査のブラウザは終了済みで、
  今回確認したプロセス一覧でもChromium残存0。既存PID 409はそのまま。
  したがって既存開発プロセスにも今回の観測はまだ適用されていない。

負荷測定はWorkspaceの単一Node、実ローカルstaging I/OとダミーObjects、
GET/PUT交互100件×4群。各群20件の無効状態ウォームアップ後、
無効→有効→有効→無効の順。既存createLoggerのサニタイズ／JSON化を通し、
ローカルbufferedファイルへ出力した。

| 群 | 平均HTTP完了ms | p95 ms | 100件のCPU ms | 観測ログ |
|---|---:|---:|---:|---:|
| 無効1 | 8.637 | 17.818 | 382.095 | 0 |
| 有効1 | 8.315 | 18.038 | 421.228 | 303行／145,593B |
| 有効2 | 8.277 | 18.414 | 380.874 | 303行／145,608B |
| 無効2 | 7.244 | 14.807 | 292.093 | 0 |

有効時は約1.46KB／要求。定期ログの前に終わる短い比較なので、
303行は100件×3行＋enabled／停止時runtime／disabled。
2群を合わせた単純差は約0.36ms／要求の待ち時間、約0.64ms／要求のCPU増だが、
JIT・fsync・他プロセス・試行順の変動を含むため純粋な計測コストとは断定しない。
本番のログ収集先・ディスク・負荷も再現していない。

別のアイドル5.2秒比較：無効CPU 5.49ms・ログ0、
有効CPU 13.52ms・4行1,334B（enabled、定期runtime、停止runtime、disabled）。
単発差8.03ms／5.2秒は約0.0015コア相当だが、これも本番の負荷保証ではない。
histogram解像度20ms・5秒集計・15分上限を併せて負荷制限として扱う。

生記録は既存除外先
`data/settings-trace-overhead-1793276230420/{results.json,idle.json,0..3/trace.jsonl}`。
比較用の4HTTPサーバー（41529 / 36845 / 40525 / 35771）はclose確認済み。
新規の常駐サーバー、検証WebSocket、上流WebSocket、ブラウザは残していない。

復帰方法は、まず計測フラグを無効にするか自動期限で止める。
コードを戻す場合は8.1の観測追加だけを戻し、既存Phase 14や設定schemaには
触れない。どちらも公開プロセスへ反映する操作は別承認まで実施しない。

## 9. 設定読取とLONG VP更新停止への追加対応（2026-10-30）

本報告の調査・観測を再利用し、追加の読取失敗とLONG VP復帰を隔離修正した。
変更・前後の数値・公開観測の限界・戻し方は
`server/SETTINGS_LONGVP_RECOVERY_REPORT.md` に記録。
以前のB（保存結果不明UI）・C（大口板minSec再構築）の別改善には広げず、
本番書込・再Publish・既存受信停止／再起動を行っていない。
