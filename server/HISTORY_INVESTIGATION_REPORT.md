# 後取得の板履歴反映・オフラインCPU切り分け

調査日: 2026-10-29。**製品の修正なし。公開操作・公開API試験・開発上流接続・実Objects/DBアクセスなし。**
数値全件は [測定付録](HISTORY_INVESTIGATION_MEASUREMENTS.md)。設定保存の公開追加計測、
長時間soak、glowや大口板描画の改善は今回実施していない。

## 1. 結論と証拠の区分

|区分|確認したこと|確認できないこと|
|---|---|---|
|コード上確認|Backfillの保存はHub.columnを呼ばない。ブラウザは初回／要求範囲の空白もcoverageに保持。完了遷移での再取得はlive/follow限定、無効化は表示範囲のみ|この経路だけでユーザー画像の各空白の由来は決められない|
|隔離再現|必須4ケース＋初回全空の5条件、回復操作別の新規状態20 run。完了追従時の可視列追加、過去閲覧・遷移非観測・表示外空白の取りこぼし、パン/ズームで非回復、reset/再接続/再読込で回復をdraw入力まで確認|Canvas画素、ユーザー端末、公開VMで同じ入力が処理されたこと|
|公開履歴確認|調査担当による既存build/revisionログの読取で、12:22:38 UTCに新build起動、前後のbuild成果物は異なる。revision別に旧PID54と新PID53を分離|ソースcommitとの対応、起動を指示した主体、個々のソース変更範囲|
|未確定|公開の約1コアを工程別に説明する証拠は不足。今回の合成入力・別CPUで同等の持続CPUは再現していない|「同期デコードが公開1コアの原因」「HeapProfilerが原因」との断定はしない|

**空白を永久欠損とは判定しない。** 初回取得時点に未保存、取得後のブラウザ鮮度、
実際の上流空応答、拒否された板、価格範囲外等は別の事象である。価格ラインは約定層であり、
板がその時刻に保存された証拠ではない。kind3の現在板重ね描画も履歴の空白を保存・補充しない。

## 2. 保存→要求→描画の経路（コード上確認）

1. `server/src/history/backfill.ts` の `Backfill.take()` は成熟待機・空応答再試行後、
   `historyColumns()`→`store.addColumns()`→`markCovered("book", start, end)`。
   `Pipeline` のライブ列callback（`store.addColumns`→`onColumn`→`Hub.column`）とは別。
2. `LocalStore.readView()` は同じ直列キュー内でディスク＋backfill保留中の確定列を返す。
   `AppStore` のread時クラウド復元は別工程。今回使用したのは新規隔離LocalStoreだけ。
3. `Hub.connect()/range()` は初回直近1800秒、追加rangeは最大3600秒、300秒chunk。
   kind2・rangeTrades・rangeDoneの契約に沿って配信する。後からstoreに列が増えただけでは通知しない。
4. `RealtimeClient.handleJson(hello)` はcacheをresetし初回範囲をcoveredにする。
   `requestVisible()` は不足範囲だけを計画し、要求中も先にcoveredにする。
   正常rangeDoneで空白coverageは残る。失敗／切断のpending解除とは区別する。
5. `main.ts:onStatus` は直前stateがrunning、新stateがcomplete、liveかつfollowのとき
   `refreshVisibleRange()`。その時点のviewportのcoverageを外し、
   `syncRetentionAndRequests()`→`client.requestVisible()`を呼ぶ。
6. kind2受信はcache→実`onColumns`、完了は実`onRangeComplete`→描画要求。
   実`LayerScheduler`のdepth callbackは`cache.columns`を`renderer.draw()`に渡す。
   今回はこの**実callbackのdraw引数とviewport内列**を記録した。cache追加のみの確認ではない。

サーバーの「再試行しても正当に空だった区間をcoveredにする」仕様は変更していない。
ブラウザのcoverageは「以前要求済み」であり「将来追加されない」という保証ではない。
両者の意味・寿命を混同しないことが必要。

## 3. 反映再現（隔離実行）

### 方法と固定入力

`server/tools/history-investigation/visibility.ts`。製品エントリポイントはimportしない。
TypeScript ASTから現行`main.ts`の関数／callbackを**原文抽出して変換・実行**した。
`onHello/onColumns/onRangeComplete/onStatus`、coverage／viewport関数、reset関数、
depth callbackは実コード。DOM表示、設定読取、価格自動合わせ、大口板追跡は副作用のないstub。
transportはメモリ内のダミー、HubとRealtimeClientの実送受信処理・フレームは製品のもの。
ネットワーク禁止preload付き。CPU測定とは別の機能再現である。

- 各runで新規LocalStore、Hub、client、cache、偽時計を作成。公開や既存保存と共有しない。
- 初回: `[1793275200,1793277000)`（12:00–12:30 UTC / 21:00–21:30 JST）。
  既知A=1793276710（12:25:10）、B=1793276990（12:29:50）、2列。
  A/Bのsizeは101/102、各側1段。部分空白を持つ応答。
- 初回後: 実`Backfill.start/run/take/historyColumns`へ偽sourceを渡し、
  a=1793276720（12:25:20、size201）、b=1793276980（12:29:40、size202）を保存。
  追加板は各側400段、元A/Bを壊さず最終store4列。初回全空だけ最終2列。
  偽時計は全窓成熟済み。実上流の待機やレートは再現しない。
- A/Bを初回最終300秒chunkに入れ、初期ロード中のcoverage変化と本件の鮮度を分離。
  初期の既知列を離れたchunkに置いた準備試行では、初期保持範囲の伸長により後のpanで
  別要求が生じ、取りこぼしを検証する前提が成立しなかった。製品のバグとは断定せず、
  その準備試行を成立したケースの証拠に数えない。

### 条件ごとの結果

要求範囲・回数・受信数・描画入力への追加時刻は測定付録の表に全件記載。

|条件|完了時の反映|その後の古い空白へのpan/zoom|
|---|---|---|
|1. live/follow、running→complete観測|表示中のbだけ新規受信・draw入力/可視に追加。既知Bも再受信|表示外aのcoveredは残り、要求0・新規列0|
|2. follow=false、完了観測|要求0、a/bとも受信しない|coveredのため要求0・描画追加0|
|3. 初回statusがcomplete|初回からcomplete、後保存後もcompleteのまま。runningを観測しないので要求0|同上|
|4. 表示外の既取得空白|完了時は直近71秒のみ無効化、bは回復するが表示外aは未受信|古い範囲のpan/zoomだけではaは反映されない|
|5. 初回全空|表示中bのみ取得。初回空白の表示外aは残る|同上|

ケース3の「後保存」は通知非観測のダミー条件であり、実backfillがcomplete後にも
処理を続けると証明したものではない。実装上は初回statusだけcomplete、statusが届かない、
runningとcompleteの間に別stateを挟む等でも同じ比較条件を満たさない。
完了stateの受信頻度・ユーザーの当時status列は未取得。

### 回復条件（各ケース×独立した新規run）

- **パン／ズームのみ**: キャッシュ内のcovered空白は再取得しない。ただし保持2時間から
  追い出された範囲、未要求範囲へ移れば不足rangeを要求する。常に無効という意味ではない。
- **追従復帰**: 実UIの時間軸reset（`resetTimeView`）は`refreshVisibleRange()`を呼ぶので、
  初期1時間へ戻る範囲にa/bが含まれ回復。単にfollow変数をtrueにする試験で代用していない。
  本体／ツールバーreset（`resetView`）もコード上同じrefreshを呼ぶが、操作実行は時間軸側。
- **再接続**: pan/zoom直後の古い空白を表示したまま、ダミーsocket close→再接続。
  新helloでcacheをreset、初回1800秒を再読取しaがdraw入力/可視に追加。
  同じtabのstatus変数が残っていてもhelloのreset経路で回復する。
- **再読込相当**: 同じ隔離状態からclient.stop/cache.reset/start、初回を再取得してaが追加。
  ブラウザ全体のreloadではなく、製品socket/clientの再生成に相当するデータ経路試験。
- 初回1800秒外を閲覧中ならhello後`retryVisible`等の追加rangeが必要になる。
  今回aは初回内。範囲外の全復帰条件や実ブラウザのイベント配線のE2Eは未実行。

受信済みでも可視外の列と、未受信の列を付録で分離した。画素の発色やglow再計算の保証ではない。

## 4. CPU・イベントループ比較

### 対象と入力

`server/tools/history-investigation/cpu.ts`。REST生入力の保存コピーは適切なものがなく、
既存ローカルfixtureは集約後の板列／約定で`historyColumns`の入力にはならないため、
**再現可能な合成REST入力**を使った。既存保存をRESTへ逆変換して実入力と称していない。

- 板1分: 4 snapshot/秒、400段×両側、240 snapshot・192,000行→60列。
  JSON展開表現16,041,601B、gzip参考1,261,465B。
- 約定1分: 1,200行（20/s）、サイズ合計2,400、200価格。
  JSON75,001B、gzip参考5,054B。ピーク時の実約定率とは同一でない。
- coverage: 900秒、完全被覆1区間と、1秒おき450区間の両方。後者は
  `coverageSegments`が900 segmentを生成。実公開の分断数は未取得。
- `decode`: 実`historyColumns`と`historyTrades`（構造検証・正規化・列集約）。
  `vp`: 実`VolumeProfile.add/message`と`coverageSegments`。
  `combined`: 両方。`idle`:同じfixtureを保持するが処理しない。
  JSON解析は別`json`条件で分離。HTTPダウンロード・response.json全体、store圧縮／
  ファイルmerge、long-VP一式、実ブラウザ配信はCPU試行には含まない。
- 同じ入力で2回warmup後、5秒間隔で6 batch、26.5秒＋終了処理。各出力件数、
  板最終snapshot値、VP総量・価格数、coverage segment数をassert。
  OFF/ONを2回ずつ、2巡目はON→OFFへ反転。全群独立Node。
- ONは既存`MemoryMonitor`そのもの。起動時sample、5秒ごとsample、
  **6回目は約25秒**でHeapProfiler取得→JSON化→隔離ファイル保存、stop時も取得。
  保存先のみこの隔離instanceで差替え。元のprofilesや製品設定は変更しない。
- CPU sampling用InspectorはON/OFF両群で共通。10ms loop histogram＋10ms timerを
  **負荷前から動かし、最終同期処理/stop後も30ms待って遅延timerを記録**。
  GCはPerformanceObserver、memoryBefore/After、process最大RSS、主要self stackを保存。
  計測CPUは個々の関数専用ではなく、V8/background GC/タイマー/記録も含む試行プロセス値。

### 公開との対応・制限

公開の参照は正本10節の共有0.5vCPU/2GiB、Workspaceは測定付録のcgroup/CPU/OSを参照。
1分板を5秒ごと（12分相当/実1分）に処理する条件は、
既存仕様5.4の1分約17万行・取得2.5〜5秒に対し、行数約1.13倍、取得5秒側に近い
供給速度を想定した比較である。ただし**公開の実入力件数/bytes/処理率はその窓に未記録**。
API待機、再試行、同居ライブ、App Storage、復元、long-VP、GCヒープ状態、
CPU共有の制限・burstが違う。合成反復で1コアになるよう回数を増やす試験はしていない。

各試行のwall/CPU/cores/throughput/loop p50/p95/p99/max/GC/RSS/主要stackは付録。
HeapProfiler差はプロセスCPU差の比較にとどめ、共有CPUを工程別へ厳密帰属しない。
ONの方が低い組もあり、順序反転してもばらつく。入力生成・gzip参考サイズ算出・warmup・
CPU profileファイルJSON保存はCPU計測窓外。heap profileの採取・JSON・writeは窓内。
今回ONのfirst/latestは206〜1,680Bと小さい（保持allocationサンプルが少ない）。
25秒時点とstop時に実ファイルが書かれ、各ONで7回のprocess_memoryとエラー0を確認したが、
この小さいJSON化負荷を公開長時間プロセスのprofileサイズへ外挿しない。
全試行に10ms監視のコストがあり、CPU samplingなしのcontrolとidleを観測負荷の目安にする。
計測時には既存receiver/Vite/言語サーバーが同居し、反映ハーネス・型検査等の短時間作業もあった。
host争奪は排除できないが、試行NodeのCPUに他PIDのCPUを加算していない。

**公開の約1コアの原因は未確定。** 今回の工程比較で同期停止の候補を絞れるが、
公開状態を再現したとはしない。

### 主な実測値（全試行終了後）

各26.53〜26.56秒、主比較16試行＋JSON2試行＋samplingなしcontrol4試行、
計22試行の測定窓合計583.89秒、試行プロセスCPU合計43,474.13ms。
各群の値は2回の単純平均。heap OFF/ON以外のCPU sampling・timer条件は共通。

|工程|heap OFF CPU ms / cores|heap ON CPU ms / cores|単一batch wall ms（OFF/ON含む）|
|---|---:|---:|---:|
|idle|1,651.51 / .06225|1,842.82 / .06940|0.00–0.07|
|decode|2,504.61 / .09441|2,893.45 / .10895|61.55–374.68|
|VP＋coverage|1,894.31 / .07140|2,067.82 / .07787|18.00–69.00|
|combined|2,590.96 / .09765|2,624.37 / .09881|73.78–380.21|

- **CPU samplingの観測負荷が無視できない**: samplingなしidleはCPU231.44ms / .00872core、
  combinedは1,117.60ms / .04213core（各2回平均）。samplingありとの差はidle約.0535core、
  combined約.0555core。この差は別Node試行・JIT/GC/host変動込みで、純粋な計測CPUとは断定しない。
  samplingありの.06〜.12coreをそのまま製品処理CPUと報告しない。
- decodeとcombinedのloop maxは最大385.09ms、timer遅れmax380.25ms。
  samplingなしcombinedもloop max243.27/301.73msで同期停止が観測され、
  CPU samplingだけによる現象ではない。p50/p95/p99は付録。
- JSON解析単体（samplingあり）はCPU2,318.18ms / .08737core、単一batch61.31〜135.82ms。
  decode条件はJSON.parseを含まないので、これを内包する値と混同しない。
- 6batchで板1,152,000行→360列、約定7,200行。decode/combinedの板throughputは
  約43,373〜43,423行/s、約定は約271行/s（処理間の待機込み）。
  1batch当たりの瞬間処理率を公開の持続取得率と同一視しない。
- 別の単発3試行でVP1,200約定のwall .28〜.77ms、完全coverage1区間の走査.011〜.028ms、
  450分断の走査16.52〜19.92ms。分断条件のprocess CPU16.77〜25.30ms、
  10ms timer遅れ6.57〜10.01ms。短区間のCPUはGC等のためwallを超えることもあり、
  公開の平均コアへ換算して原因判定しない。
- 主要self stackはdecodeの`finish/historyColumns/normalizeBook`、VP側のcoverage走査と
  flat/filter、GC、Inspector/timer等。公開同時刻のstackではない。

## 5. 公開起動とソース版の照合

公開履歴の読取は調査担当が実施。`getDeploymentInfo`の現時点結果はVM/successful/private。
前回報告のpublicという記録と現在のprivateを取り違えず、今回visibilityを変更していない。
以下は**既存telemetry**のみで、公開APIへの負荷試験は行っていない。

|対象|UTC|JST|証拠|
|---|---|---|---|
|前build `647a1c87-02bf-4eb1-9868-b2179403db6c`|10/28 23:12:51.360作成、23:16:55.809更新|10/29 08:12:51.360、08:16:55.809|build success|
|新build `89a3ff57-3252-472d-991d-a7584758f4ae`|10/29 12:19:25.550作成、12:23:13.892更新|21:19:25.550、21:23:13.892|build success|
|新区間の起動|12:22:38|21:22:38|新buildログ `starting up user application`|
|旧revisionのPID54|12:22:53.710|21:22:53.710|process_memory average10s .9585、backfill complete|
|新revisionのPID53|12:23:03.732|21:23:03.732|process_memory average10s .6374、backfill running|
|新接続の初回range|12:23:19.162|21:23:19.162|hub_range_begin phase initial|

照会範囲: build一覧100件、runtime 12:15–12:30 UTC、revision別詳細12:22–12:23:30 UTC。
旧・新区間は短時間重なり得る。PID番号大小を時間順の証拠にしない。
起動前のwatchdogを新PIDの現在状態・起動原因へ流用しない。

前build成果物は`index-cAOfUem4.css / app-YYJ7ksu9.js / index-Cje5A5xv.js`、
最後のJS95.70kB。新buildは`index-DXMzpC78.css / app-eIBlBOKz.js /
index-N_thko4P.js`、最後のJS107.95kB。**成果物が同一の単なる再起動ではない証拠**が得られた。
ただしbuildにcommit SHA/ソース版labelがなく、バックエンドを含む
**ソース変更範囲・ローカルcommitとの対応は照合不能**。起動契機を誰の操作かとは確定しない。
healthcheck500の1行だけで再起動原因としない。

出発点の同一ブラウザ履歴応答209列→約11秒後325列は、読取可能な列が増えた証拠。
今回の新しい公開API再取得ではない。追加の由来、画像撮影時刻との一致、描画への反映、
稼働ソース版はそこからは確定しない。

## 6. 設定計測の棚卸し（変更保持）

|項目|確認結果|
|---|---|
|ローカル追加版|`d8b3e86` 2026-10-29 12:35:06 UTC（21:35:06 JST）。直前Publishラベル`02c53c5` 12:34:25、チャート変更`7e1aeb3` 12:01:25は別の時刻・証拠|
|有効化|`index.ts`が起動時`HEATMAP_SETTINGS_TRACE === "1"`の場合のみSettingsTraceを生成、HTTP待受前start、最大15分、終了時stop。今回はフラグ変更しない|
|計測場所|`settings/trace.ts`、`settings/routes.ts`、`settings/app.ts`、`settings/local.ts`、`store/objects.ts:uploadVerified`、`status/app.ts`、`index.ts`|
|出力|既存loggerへ匿名request ID、queue/stage/HTTP close/保存最終結果、5秒窓CPU/loop/履歴状態。専用の永続トレースファイルは製品では追加しない。出力先は起動時logger writerに従う|
|CPUの意味|プロセス・測定窓のコア値。工程別CPUプロファイルではない。待ち時間とCPU時間を混同しない|
|既存HeapProfiler|`diagnostics/memory.ts`。明示TRACEフラグとは無関係にindex起動でstart、512KiB allocation sampling、5秒sample/6回ごと保存、`data/perf-memory/profiles/<pid>-{first,latest}.heapprofile.json`|
|既存検証|`settings-trace.test.ts`（7試験）、`settings-trace-overhead.ts`。前回の試験・値はSETTINGS_INVESTIGATION_REPORT 8節。本調査で新たな設定PUT再現はしていない|
|公開反映|12:22–12:23:30 UTCの`settings_trace_enabled`検索0件。起動時TRACE有効や追加版反映の証明にはならず、稼働中とは報告しない|

既存の設定保存・trace・Phase14製品ファイルは未変更。履歴CPU試行ではSettingsTraceを
有効にせず、既存HeapProfilerとの比較へ設定処理を混入しない。

## 7. 最小修正候補A：反映漏れ（未実装・別承認）

|候補|効果・根拠|負荷／整合性・遅延|戻し方・回帰試験|
|---|---|---|---|
|A1 完了世代に応じた限定再検証|`main.ts`と`cache.ts/socket.ts`で、running→completeだけでなく初回completeも世代識別し、その世代で未再検証の既取得範囲を表示時に一度再取得。browseを対象にし、現在表示外はpan時まで遅延。今回の3取りこぼし条件を直接対象にする|全cache削除でなく表示範囲限定。ただし全時刻の再取得なら既知板・約定も重複転送。世代につき1回で要求嵐を防ぎ、pendingと競合させない。初回completeを毎statusで再取得してはいけない|条件追加と世代管理だけ戻す。全20条件＋部分失敗・pending・再接続・初回complete反復・パン往復・保持期限・約定再取得の非重複を検証|
|A2 板保存の世代/範囲通知|サーバーで保存済み範囲の版を通知し、該当ブラウザ範囲だけ失効。完了以前の段階的保存も追える|配信契約変更が必要。秒ごとの通知/即時取得は過大なので集約が必要。今回は最小案としてA1より後。長いbackfill完了待ちを避けられるが設計判断が増える|通知/consumer追加だけ戻す。旧クライアント互換、保存完了前通知なし、失敗時非通知を試験|

**提案効果の実測**: 元の製品を変えず、独立5runで古い空白を50秒へzoomした直後に
既存`refreshVisibleRange`をハーネスから1回呼んだ。ベースラインの要求0・返却0に対し、
各1要求・50秒（全50秒が既取得重複）でaがdraw入力／可視に入った。
binary/JSON bytes、返却列／既知重複列、read区間wall/共有CPUは付録の比較表。
これはA1の世代管理自体を実装・検証したものではなく、**限定無効化の効果とコスト**の実測。

板だけでなく同範囲約定も再読取・decode・圧縮・配信される。ダミーの約定は0なので、
実トラフィックは`板payload + 約定payload + JSON制御 + WS framing`で増える。
今回の独立deflate参考値は状態引継ぎ圧縮の実転送bytesではない。
孤立LocalStoreのread/decodeコストは測れたが、AppStoreの復元I/O、実サーバーの圧縮CPU、
ネットワーク送信待ち・クラウド請求、受信側のglow／VP等の追加描画時間は未測定。
追加要求1回につき同じ50秒のstore読取が増え、Hubは今回1chunk、decode/encodeは返却列数
（将来密なら最大50列×800段）に比例して増える。ユーザー当時のbytesへは外挿しない。
例えば各秒800段がある50秒なら、現行binary表現だけで約320,459B
（50×6,409B＋frame header9B、単一chunk、圧縮前）という見積りになる。
今回の部分空白6,443Bを密な履歴の返却量と同じ扱いにしない。
保存/照合の省略、板の架空補完、サーバーの正当空応答リトライ変更は提案しない。

## 8. 最小修正候補B：CPU／同期停止（未実装・別承認）

|候補|実測との関係|副作用・回帰／戻し方|
|---|---|---|
|B1 historyColumnsの処理を完全snapshot境界で短いbatchへ分割、event loopへyield|decode条件の主要stackは`historyColumns/finish/normalizeBook`等。1分の応答で同期timer停止が生じる候補を確認。Worker追加より小さい変更候補|総CPUを減らす保証はない。履歴完成が遅れ、応答保持メモリが長くなる。800×Nの同時刻最終組・巻戻り・列最終値・順序・中断・ライブ応答維持を固定入力で比較。同期経路へ戻せる単独変更にする|
|B2 coverageSegmentsを端点の逐次走査へ置換|現実装は各segmentでranges.some/flat/filterを反復。分断450条件とcompact1条件の差を比較する候補。今回のvp全体はdecodeより小さく、公開原因とは未確定|端点重複・連続・空・範囲外・被覆状態が完全一致する差分テストが必要。公開の実分断数が少なければ利益は小さい。関数だけ戻す|
|B3 HeapProfilerの頻度・opt-in化を別途判断|ON/OFF両群と実採取/JSON/writeを比較。差のばらつきから「これを止めれば公開1コアが直る」とは言えない|診断能力を失う。GC/サンプリング有無で出力値の一致、収集停止・復帰、profile保存失敗を確認し、元の起動と周期へ戻す。今回フラグや周期を変更しない|

CPU対策と反映漏れ対策は別承認・別差分にする。反映漏れ対策は再取得負荷を増やすため、
CPU原因が未確定のまま全cacheを周期消去する案は採用しない。

## 9. 再現・変更ファイル・終了

- 追加コードは`server/tools/history-investigation/{offline,visibility,cpu,stages,summarize}.ts`のみ。
  製品からimportなし。常駐HTTP/WS・実クラウドクライアントを作らない。
  `offline.ts`はsocket接続/fetch/WebSocketを例外にする安全preload。
- 追加報告は本書と測定付録。設定計測の既存変更、仕様正本4件、依存、デプロイ構成、
  製品コード、既存settings/保存形式の変更なし。
- 生記録は既存Git/デプロイ除外`data/history-investigation-20261029/`。
  CPU profileはスタック/時間、heap sampling profileはスタック/サイズのみ。値や秘密は採取しない。
- ブラウザは未使用。draw入力確認のためにChromiumや実`/api/ws`を開いていない。
  メモリ内ダミー接続は各finallyでclose、Hub connected=0をassert。
  既存の開発receiverを自分の検証プロセスと混同して停止しない。

再実行（新しい出力名を推奨、既存証拠の上書きを避ける）:

```sh
node server/tools/history-investigation/visibility.ts data/history-investigation-NEW
for r in 1 2; do
  for mode in idle decode vp combined; do
    if [ "$r" = 1 ]; then order="off on"; else order="on off"; fi
    for heap in $order; do
      node server/tools/history-investigation/cpu.ts data/history-investigation-NEW "$mode" "$heap" "$r"
    done
  done
done
for r in 1 2; do
  for mode in idle combined; do
    node server/tools/history-investigation/cpu.ts data/history-investigation-NEW "$mode" off "$r" control
  done
  node server/tools/history-investigation/cpu.ts data/history-investigation-NEW json off "$r"
done
node server/tools/history-investigation/stages.ts data/history-investigation-NEW
node server/tools/history-investigation/summarize.ts data/history-investigation-NEW
```

測定付録生成は報告ファイルを書き換えるので、結果を残すときは先に現在の報告を保持すること。
公開・上流・実保存に対する操作はこのコマンド群に含まれない。

### 実行した確認と終了結果

- visibilityハーネス最終版: **20/20新規状態run成功**（5条件×4独立回復／提案試行）。
  最終出力は`visibility.json`、抽出原文の変換結果は`extracted-handlers.js`。
- CPU主比較のshell終了0、対照／JSON比較のshell終了0。**22/22試行出力**、
  CPU samplingあり18件の実profile、control4件の非採取を示す空profile、
  MemoryMonitor ON8件のfirst/latest計16ファイルを確認。単発VP/coverage9試行も完了。
- `node --test server/test/phase2a-fixes.test.ts server/test/phase2b.test.ts
  artifacts/heatmap/test/cache.test.ts artifacts/heatmap/test/socket.test.ts`:
  **40/40成功、skip0**。記録`regression-tests.log`。
- `cd server && ../node_modules/.bin/tsc --noEmit --allowImportingTsExtensions
  --module nodenext --target es2023 --skipLibCheck --esModuleInterop --types node
  --typeRoots ./node_modules/@types tools/history-investigation/*.ts`: **成功**。
  先にworkspaceルートのデフォルト型探索で実行した同種コマンドは、
  `hub.ts:332`の`IncomingMessage.signal`で異なるNode型定義同士の不一致が1件出た。
  依存は変更せず、製品serverが使う型探索へそろえた上記で確認した。
- 全5ツールの`node --check`成功。`git diff --check`成功。
  製品を変えていないためbuild、preview再起動、ブラウザE2Eは実行していない。
- `cleanup.json`: **2026-10-29 12:55:19.955 UTC / 21:55:19.955 JST**、
  自分のCPU試行22PIDは全て消滅、Chromium本体プロセス0、検証ブラウザ未使用、
  今回開いた実WS0、ダミーHub接続残存0。常駐検証サーバーを作っていないので
  終了対象HTTPや上流WSもない。2つの測定shellも自然終了0。
  既存receiver PID414は存在したまま、停止・再起動・切断をしていない。
- Git差分検査で`server/src`、`artifacts/heatmap/src`、`docs/`、`replit.md`、
  `.replit`、lockfileへの変更0を確認。仕様との差分はなし。
  既存の稼働プロセスによる通常ログ出力まで停止／不変化したと主張するものではない。

未解決は公開の工程別CPU原因、当時の画像と列の対応、ソース版照合、
実長時間ヒープのprofile負荷・実クラウド再取得増分。制約内の調査を終え、
反映漏れ対策と同期停止対策は上記の**提案で停止**する。
