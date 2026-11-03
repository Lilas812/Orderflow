# coverage / publish CPU 修正

## 報告
- 実施内容：公開先を読み取り調査し、`publish` 前処理、coverage検索、起動時の限定圧縮、静かなライブ秒、空の約定補完、診断の既定値を修正。市場データ本体の移行・削除・書換え、公開操作はしていない。
- 変更ファイル：`server/src/store/{coverage,coverage-compaction,local,app}.ts`、`server/src/aggregate/columns.ts`、`server/src/pipeline.ts`、`server/src/diagnostics/main-thread.ts`、関連試験・隔離測定ツール。本書と `replit.md` の Current Status、承認事項のメモを更新。
- 確認手順：下記の再現コマンドと固定入力を使用。実上流WSは使わず、App Storageへのテスト書込みもローカルの代替実装に限定。
- 実行した確認：サーバー全317試験成功、サーバー／フロント型検査成功、フロント本番ビルド成功。前処理比較、隔離再集計と保存後の再読込照合を実施。15分測定は末尾に結果を記載する。
- 仕様との差分：以下「仕様にない値」は今回のユーザー承認による限定変更。`docs/` の正本は変更していない。
- 未解決・懸念：公開後のCPU・watchdog・欠けの改善は未検証。10/30は追加読み取りコピーで候補再集計できたが、既存集計より枚数が少なく非採用。11/02・11/03も残存欠けがあり complete:false。
- 次の候補：10/30の日次数量差の同条件照合、反映時の別writer競合保護。ユーザーが公開を判断した後の受入条件も末尾に記載。ここでは公開・本番書込・既存受信の停止／再起動を実行しない。

## 1. 公開先の根拠（読み取りのみ）

今回の起点HEADは `69b9e6e4f20dfea34aeaabb2db1415a29fa90165`。修正はその上の未コミット差分であり、GitHubへ追加pushした版や公開済み版ではない。

対象は Reserved VM / private の既存公開先。11/04 00:00 JST＝11/03 15:00 UTC以降を調査した。

| 証拠 | 結果 |
|---|---|
| 保存profile | `prod/diagnostics/cpuprofile/1793718034393-55.cpuprofile.json.gz` |
| ローカルコピー | `data/dev/coverage-publish-evidence/1793718034393-55.cpuprofile.json.gz` |
| gzip SHA-256 | `8f813a80192e18a24a99de6c5a861fe032830a3380a6605e30c69135d1ccd514` |
| 圧縮サイズ | 39,626 bytes |
| 開始／保存ログ UTC | 2026-11-03 15:00:34.563 / 15:07:04.249 |
| profileの採取sample時間 | 197.41秒。開始から保存までの壁時計時間とは別 |
| `publish()` 内callback self / total | **148.58 / 167.25秒** |
| `durable()` self / total | 0.005 / 18.35秒 |
| `intersect()` self / total | 1.73 / 18.34秒 |
| GC self | 13.10秒 |
| 15:00〜15:31 UTCログ | main_long_callback 119件、main_loop_stall 162件 |
| 5秒以上 | storage/PROMISE のcallback・stall各67件、最大約49.0秒、main CPU約47.6秒 |
| process_memory末尾付近 | main約0.98〜0.99 cores、process約1.03〜1.05 cores |

inclusive totalは親子で重複するので合算しない。主因は `publish` のcallbackで、`durable/intersect` がその中の明確な寄与。GCや別処理も残るため「公開CPU全体が解決した」とは扱わない。

private `/api/status` の未認証アクセスは307で認証画面へ転送され、直接取得できなかった。認証は弱めていない。process_memoryログは4KBで切れて automaticCpuProfile 欄までは読めなかったが、profile開始・保存ログと本体を照合した。

公開の成功build記録は `02d2e111-98eb-4277-9298-b3126fbdf505`（作成14:55:41.995、更新15:00:18.421 UTC）。これだけでGit SHAや現在のWorkspaceとの差分を特定したとは扱わない。

## 2. 修正の内容

### 2.1 publish と検索
- `coverage.ts`: ソート済み半開区間の二分探索、必要な区間だけのclip、重複しないhour列挙、durable hour Setを追加。
- `AppStore.setCloud/durable`: クラウドcoverageが変わる時に `(kind,hour)` Setを作成し、hydrate・publish等で再利用する。
- `publish`: local interval数×cloud interval数の全走査を廃止。同じhourはkindごとに一度だけ前処理する。計算ループは8msごとに `setImmediate` へ譲る。I/O awaitを含むpublish全体の壁時計時間と同期占有時間は別。
- `pump`: coverage／市場ファイルの変更、新しい閉じた時間、再試行期限、明示flush／shutdownで起動する。変化がない毎秒のmaintenanceではpublish本体を起動しない。ライブ中はcoverage自体が毎秒変わるのでpublishが毎秒必要になることはある。
- `LocalStore.covered`、`repairEmptyTradeSeconds`、重複範囲判定等の線形membershipを二分探索へ変更。
- 各銘柄のstatus `storage.coverageIntervals` にlocal/cloudのbook/tick区間数、marker、publish回数・所要時間・前処理時間を追加。

### 2.2 静かなライブ秒
- `ColumnAggregator.accept()` が受理した板のデータ時刻だけをPipelineが記録する。古くて拒否した板や壁時計によるexpireでは進めない。
- 既存の約定batchを保存した後、`confirmLiveTradeSeconds()` が、実際に保存できたlive列のうちデータ時刻で3秒経過した秒をtick取得済みにする。
- 履歴列・板のない秒を静かな秒と推測しない。hold中は書込完了・解放を待つ。通常の約定観測秒のcoverageは残す。
- 時間境界でgzip本体が既に確認済みでも、後から成熟した秒のcoverageだけは公開する。本体を再送せず、確認済みfingerprintと追加範囲を照合してindexを再DL照合付きで更新する。この追加分を取りこぼす境界ケースを試験した。

### 2.3 一度限りの起動時圧縮
- `compactStartupCoverage()` がAppStoreのローカル作業indexとクラウドindexを処理する。純粋なLocalStoreに認証やネットワーク依存を加えていない。
- tickの**内部**の穴だけを対象とする。長さ30秒以下、同銘柄bookで全秒が覆われる場合だけつなぐ。cloudでは該当する全hourがdurable tick hourであることも要求する。両端は伸ばさない。
- 元のcloud/local coverage.jsonを、バイトを変えず `{prod|dev}/backup/coverage/<UTC時刻>-<一意ID>/<銘柄>/{cloud|local}/coverage.json` に保存し、再DL・SHA-256一致を確認する。元indexが存在しない新規作成には退避対象がない。
- **両方の退避を確認してから**圧縮indexを置換する。退避失敗は `backup_failed`、index公開失敗は `index_update_failed` としてstatus/logに残し、元の区間のまま起動を続ける。index公開の通信失敗は遠隔置換の成否が不明になり得るため、退避済み原本を保ち、成功したとは報告しない。
- `tickGapCompactionVersion:1` を保存。旧readerはbook/tickを従来どおり読める。二度目は再圧縮・再退避しない。古いwriterへ戻すとmarkerが保存されない場合があるため、その後の新version起動で再退避・圧縮になり得る。
- 市場の列・約定・日次集計ファイルは、この圧縮から変更しない。短い穴の解釈を変更するだけで、欠けた約定を生成する処理ではない。

### 2.4 空補完・診断・停止
- `insertUncoveredTradeRange/insertTradeRange` は入力0件なら時間ファイルのhydrate・再走査・gzip置換をせずcoverageだけを更新する。
- 入力がある場合は既存行・順番・巻戻り・同内容の別約定を保持し、一時ファイルの置換後にcoverageを保存する既存経路を維持した。
- async_hooksによるcallback計測は既定OFF。`HEATMAP_ASYNC_HOOKS=1` で明示的に有効化できる。100msのstall timer、GC、main/process CPU、自動profileは維持。OFF時はcallbackの0件を「重いcallbackが0件」の証拠にしないようstatusに明示した。
- shutdownの期限10秒、閉じた時間だけ・各ファイル1回の試行、書きかけを上げない方針は変えていない。

## 3. 固定入力・前処理比較

前回の `data/dev/main-thread-snapshot/` を再利用した。公開の現在値ではなく、2026-11-03 13:27 UTC頃までの過去コピーである。元のmanifestと市場ファイルは変更しない。

「local再構成」は同じコピーから作った隔離AppStoreの作業indexであり、公開VMの現在のローカルindexを取得したという意味ではない。

| 銘柄 | 種別 | local再構成 前→後 | cloud 前→後 |
|---|---|---:|---:|
| NQ | book | 2,745→2,745 | 2,745→2,745 |
| NQ | tick | **21,342→1,481** | **21,342→1,481** |
| GC | book | 6,135→6,135 | 6,135→6,135 |
| GC | tick | **12,555→3,393** | **12,555→3,393** |

同じ**圧縮前**inputを旧・新の両方へ渡し、前処理の候補hour集合の一致を確認した。以下はI/O・Set初期化を除く同一入力の探索比較で、publish全体の時間ではない。

| 銘柄 | 実行 | 旧 ms | 新 ms | 旧CPU ms | 新CPU ms |
|---|---:|---:|---:|---:|---:|
| NQ | 1 | 2788.354 | 1.301 | 2800.904 | 1.254 |
| NQ | 2 | 1707.006 | 1.788 | 1691.274 | 3.743 |
| NQ | 3 | 1668.438 | 1.035 | 1676.243 | 1.090 |
| GC | 1 | 1991.262 | 0.232 | 1986.064 | 0.275 |
| GC | 2 | 1655.433 | 0.223 | 1639.030 | 0.268 |
| GC | 3 | 1696.395 | 0.240 | 1612.043 | 0.297 |

hourの検査回数はNQ 24,288→307、GC 18,731→126。完全な数値と入力hashは `data/dev/coverage-publish-compare/result.json`。Set構築・起動圧縮の別測定は `setup.json` に記録する。

Set構築はNQ 15.03ms（process CPU 17.54ms）、GC 1.03ms（CPU 0.94ms）。cloud/local両方の圧縮はNQ 42.58ms、GC 14.89ms。これらは譲渡を含む壁時計時間で、初期化の1回だけ。前処理3回比較には含めていない。SDKの認証・ネットワークの時間とは別である。

旧HEADのソースを `/tmp` に読み取り展開し、その `LocalStore` を直接ロードしてmarker入りのNQ/GC indexを読ませた。tick区間の再読込一致を確認（NQ 1,481、GC 3,393）。旧サーバー全体・上流接続は起動していない。証拠 `data/dev/coverage-publish-compare/old-reader.json`。

## 4. 欠け・LONG VP再集計

| 銘柄 | 日 | 圧縮前gap数 | 圧縮後gap数 | 前 欠け秒 | 後 欠け秒 | 残る30秒超gap数 |
|---|---|---:|---:|---:|---:|---:|
| NQ | 10/30 | 8 | 1 | 38 | 27 | 0 |
| NQ | 11/02 | 7293 | 660 | 45266 | 33127 | 219 |
| NQ | 11/03 | 2418 | 407 | 76296 | 72575 | 272 |
| GC | 10/30 | 125 | 92 | 31821 | 31722 | 85 |
| GC | 11/02 | 8188 | 2072 | 57811 | 43296 | 216 |
| GC | 11/03 | 2269 | 631 | 78759 | 74998 | 238 |

CT16〜17時の定例休止は既存の `tradingGaps()` で除外。これはcoverageに基づく過去コピーの欠け候補で、現在の公開保存・TICK STREAMの真の欠落を確定した表ではない。11/03はコピー時点より後の未収録時間も含む。30秒以下でもbook証拠が不足する穴は残す。

製品の `AppLongVp.build(recordedOnly=true)` → `serializeDay()` → `LongObjects.save()` → gzip再読込で確認した結果：

| 銘柄 | 日 | 約定件数 | 枚数 | 所要ms | 結果 |
|---|---|---:|---:|---:|---|
| NQ | 11/02 | 247447 | 267477 | 4125.5 | 保存・再読込一致、complete:false、660 gaps |
| GC | 11/02 | 66236 | 72030 | 2573.6 | 保存・再読込一致、complete:false、2072 gaps |
| NQ | 11/03 | 25384 | 26993 | 924.0 | 保存・再読込一致、complete:false、407 gaps |
| GC | 11/03 | 13222 | 14878 | 1129.9 | 保存・再読込一致、complete:false、631 gaps |
| NQ | 10/30 | 523308 | 559123 | 4220.8 | 候補の再読込一致、complete:false、1 gap。既存を置換せず |
| GC | 10/30 | 46268 | 51454 | 1498.1 | 候補の再読込一致、complete:false、92 gaps。既存を置換せず |

11/02の件数・枚数は前回報告と一致した。metadata取得は読み取り専用RESTの `/roll` のみ。実履歴REST・上流WS・本番保存は使っていない。最初のコピーに10/30の原約定がなかったため、15分測定終了後に必要な44ファイル（5,450,567 bytes）をApp Storageから読み取りだけで追加コピーした。各ファイル2回のDL・SHA一致を確認。欠落object・不安定な版はいずれも0。既存の193ファイルのコピーは変更せず、別の1時間データや購入データにも置き換えていない。

実結果：`data/dev/coverage-publish-rebuild/run-1793720818394/result.json`。最初に10/30を試して失敗した実行はstoreの失敗状態が後続へ伝わったため採用せず、新しい隔離ディレクトリで11/02→11/03→10/30の順に実行した。失敗を完成扱いにしていない。

追加原約定のmanifest・hash：`data/dev/coverage-publish-oct30-readonly/run-1793722105278/manifest.json`。
10/30の最終結果：`data/dev/coverage-publish-rebuild/run-1793722441108/result.json`。再現コマンドは次の通り。

追加コピーは現在の保存objectの版であり、前回snapshot採取時点の原約定と同一だったと保証するものではない。数量差を今回の最適化によるデータ消失と即断しない。

```sh
node server/tools/perf/coverage-publish-oct30-copy.mjs
node server/tools/perf/main-thread-rebuild.mjs --coverage-publish \
  --extra-manifest=/home/runner/workspace/data/dev/coverage-publish-oct30-readonly/run-1793722105278/manifest.json \
  2026-10-30
```

**10/30は採用していない。** 既存日次はNQ 560,902枚、GC 109,092枚。候補はそれぞれ1,779枚／57,638枚少なく、`LongObjects.save()` の非劣化判定が `saved:false` を返した。最初の照合ツールは保存後の旧値を候補と比較して `readback_quantity_mismatch` としたが、これは置換拒否を区別していなかったためで、製品の保全判定を緩めていない。ツールを直し、旧集計のhash・数量を保持したまま、候補だけ別ファイルへ保存・再読込照合した。

したがって上表の10/30の1／92 gapsは**候補の値**であり、採用済み日次ファイルがその値へ変わったわけではない。元の日次は3,730／2,906 gapsのまま保全された。数量差の由来（原約定・coverage・限月帰属等）の同一条件照合は未了で、今回のcoverage修正だけで全データが復旧したとは扱わない。

30秒超の残存区間全件は `data/dev/coverage-publish-compare/result.json` の各 `days[].remainingOver30` に開始・終了UTC・秒数を列挙する。10/30の購入／履歴再取得判断用には、GCの85区間だけでなく、NQに残る27秒とGCの短い穴も対象にする。11/06朝JSTの履歴期限が来る前に確認が必要で、本作業では購入も回復用の履歴取得も実行していない。

`setup.json` の `remainingAll` は30秒以下も含む全残存区間。大きい穴がなければ完成、とはしていない。

## 5. 試験・実行コマンド

```sh
pnpm --filter @workspace/receiver run typecheck
node --test --test-concurrency=1 server/test/*.test.ts
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/receiver run build
node server/tools/perf/coverage-publish-compare.mjs
node server/tools/perf/coverage-publish-compare.mjs --setup-only
node server/tools/perf/main-thread-rebuild.mjs --coverage-publish 2026-11-02 2026-11-03 2026-10-30
node server/tools/perf/coverage-publish-soak.mjs 900
```

追加試験はNQ/GCの静かな秒、+3秒境界、history列／板なし／逆行watermark、30秒・31秒・時間跨ぎ・book証拠なし・非durable、原本退避と再DL、旧reader・二度目no-op、退避失敗、空補完、idle／coverage変更／時間境界／flush、確認済みgzipのcoverage後着を含む。全317件成功後、cloud/local両原本と市場ファイルのバイト不変のassertを強化し、関係11件を再実行して全成功した。強化時にダミーcloudの市場object参照漏れが2件出たがfixtureを補い、製品の照合を無効化していない。製品コードは317件成功時から変更していない。既存試験で期限内停止・閉じた各ファイル1回・失敗範囲非公開・書きかけ非公開・非空補完の行保持を確認。

## 6. 仕様にない値（今回の承認）

1. ライブの実板列がある秒は、その秒+3秒以上の板**データ時刻**を受信した後、約定0件でもtick取得済みにする。壁時計・履歴列では代用しない。
2. 起動時一度、同銘柄bookに全秒の根拠がある30秒以下の内部tick gapを圧縮する。cloudはdurable tick hourに限定。事前の原本退避・再DL一致が条件。marker追加だけを保存形式の例外とする。
3. 既存async_hooks計測は既定OFF、明示フラグでON。50ms以上の同期占有を避けるため新しい計算ループの譲渡目安を8msとした。I/O待ちやGCまで8ms以内と保証するものではない。

## 7. 公開後の受入条件・戻し方（手順のみ）

- 対応サーバーを反映した後、local/cloudのbook/tick区間数、`coverageCompaction.state/backups`、marker、publish回数・時間を確認する。退避失敗・曖昧なindex公開失敗を成功扱いにしない。
- 前景ライブの鮮度を見ながら、イベントループ最大1秒以内・watchdog切断0回、定常親CPU 0.3 cores以下を確認する。隔離結果だけで公開の合格を宣言しない。
- 3時間バックフィルは30分以内、VPが待機から抜けることを確認する。REST制限や実在する欠けで未完了なら理由を残す。
- 11/02・11/03は真の欠けがなければcompleteになることを確認。本コピーでは欠けが残るので、今の時点でcompleteにはしていない。
- coverageの復帰は**稼働writerを止める許可と反映手順を別途確認した上で**行う。対象symbolの退避cloud原本をSHA照合してcoverage.jsonへ戻し、同時に対応するlocal原本を復元するか作業indexを再構成する。市場データ本体は戻さない。
- 旧コードへ戻す場合もwriter停止中に行う。新コードのままmarkerのない原本で起動すると再び退避・圧縮するため、原本を戻しただけで無効化できるとは扱わない。
- 単なるApp Storage上書きでは稼働中の古いメモリから再上書きされ得る。今回は本番の復元・停止・再公開を実行していない。
- 既存の単一writer前提を維持しており、別の稼働writerとのcoverage CASは今回追加していない。起動時圧縮と旧writerの同時更新を許さないことも反映条件とする。

## 8. 約15分の隔離実測・終了確認

予備入力の時刻単位・市場ファイル参照mappingを直した短い試行、および中止した予備runは本測定に含めない。予備run `14625` は入力adapterに必要な原本参照がなく `dummy_missing` で終了したため、manifest全件を参照するadapterに修正した。製品側で欠損を0件と握りつぶしていない。

最終run：`data/dev/coverage-publish-soak/run-1793721139778-15417/`。2026-11-03 15:52:20.157 UTC開始、測定900.0106秒（JST 11/04 00:52:20〜01:07:20頃）。生産用上流・ブラウザは使わず、loopback WS→実Upstream/MarketReceiver/Receiver→Pipeline→AppStore→実status HTTPを通した。

入力は明示した合成feed。NQ/GC各400段×両側、約4Hzの板、各250msに10約定（毎10秒に1秒だけ約定なし）、ping約10秒ごと。過去coverageと必要な原約定コピーは前回manifestから参照し、履歴RESTは空応答のダミーへ隔離。ネットワーク先はloopbackだけで、設定I/O・公開設定は操作していない。受信32,370件／銘柄なので、実市場の最大流量を再現した検証ではない。

測定では200ms以上のcallback件数を得るため、**テスト用にだけasync_hooksを明示ON**にした。公開向けの既定OFFは変更していない。合成feed生成と診断のCPUも同じプロセスに含む。

| 項目 | 結果 |
|---|---:|
| 親スレッド平均CPU | **0.04288 cores**（900秒のthreadCpuUsage差分） |
| プロセス平均CPU | 0.06544 cores |
| event-loop最大／p95 | **89.981 / 10.469 ms**（native histogram、約10msの観測間隔を含む） |
| 200ms以上callback | **0件** |
| 200ms以上timer stallログ | **0件** |
| watchdogによる切断／再接続 | **0 / 0回** |
| 終了前RSS | 375,660,544 bytes（358.3MiB、ピーク値ではない） |
| NQ / GC 入力・受理・保存後再計数 | 各 **32,370件、61,503枚**、数量一致 |
| statusサンプル | 179回。GC指定HTTPも別途200・symbol=GCを確認 |

| 銘柄 | publish回数 | 合計ms | 最大ms | 前処理最大ms |
|---|---:|---:|---:|---:|
| NQ | 442 | 4116.15 | 754.90 | 6.95 |
| GC | 897 | 11005.49 | 925.69 | 56.27 |

publish統計は準備中を含む起動後累積・shutdown前の値。publish全体と前処理の壁時計時間には非同期I/O待ち・譲渡を含む。GCの前処理56.27msを「56ms連続で同期占有」とは解釈しない。全callbackが50ms未満だったことまではこの200ms閾値の観測で証明していない。新しい長い計算ループは8ms予算で譲渡し、公開での再観測条件を残す。

**public before と隔離 after は入力・環境が異なるので、公開親CPUが0.99→0.043 coresに改善したというA/Bにはしない。** 同一入力A/Bは前処理の表だけ。実バックフィル3時間や公開での30分完了は未確認。

証拠：
- `result.json`：CPU・event loop・callback・upstream診断・cleanup
- `samples.json`：5秒ごとのmainThreadと銘柄別区間数・publish統計
- `verification.json`：保存gzipの実readerで再計数、publish推移、元snapshot193ファイルのhash不変
- `status-gc-mid.json`：GC指定の実HTTP応答
- 入力manifest SHA-256 `40051abb7a714ce0cdb44a9127bb33b7e355aa99880fe4fed54abca7a643d9c8`
- NQ index SHA-256 `08b8718273650a0039699699a638a3ae49911f411507be835dd5848ec402644b`
- GC index SHA-256 `6d9fb80f92af01723a5391aba45f30add94be5dd88f8d85c85dd36eb3656dee5`

実上流への追加接続、本番書込、公開・再公開、既存受信・workflowの再起動はしていない。自分のdummy upstreamはstopped、WS peer 0、HTTP listening:false、cleanup error 0、測定プロセスはexit 0。ブラウザは起動していないため閉じる対象なし。既存のユーザーブラウザは操作していない。終了後のOS側のPID・port確認は最終確認欄に記載する。

### 最終確認
- `os-cleanup.json`：予備PID14625・15396、本測定PID15417はすべて消滅。HTTP 46139 / fake WS 36433はともにECONNREFUSED。
- 追加コピー・再集計・旧reader確認は単発processが終了。該当する検証コマンドの残存プロセスなし。SREの調査processも終了済み。
- 検証ブラウザの起動0、残存0。ユーザーの既存接続・既存workflowは停止していない。
- 元snapshot193ファイルのhash変化0。関連する正本・Run設定・lockfileの差分なし。`replit.md` はCurrent Statusだけを更新。
- `/data/` は既存のgitignore/replitignore対象で、原約定コピー・profile・測定出力をGitやデプロイへ追加していない。原本・退避・候補は削除していない。
- 変更は未公開・未push。実ライブ、公開のCPUと鮮度、公開バックフィルの完了時間、全callbackの50ms未満保証、10/30の数量差解消は未確認のまま残す。
