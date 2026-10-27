# Phase 6 大口板列

2026-10-27、日本時間。Phase 6のみ。Phase 7以降は実装していない。

## 報告

- 実施内容：確定した1秒列による大口板判定・継続追跡と、専用Canvasのマゼンタ棒を実装。追跡は表示用キャッシュから独立し、過去表示でも最新の確定列を使う。
- 変更ファイル：下表参照。依存追加なし。仕様書2件の許可された無変換差し替え以外に、サーバー、配信・保存形式、Run・デプロイ設定、App Storage、DB、`scripts/src/`は変更していない。
- 確認手順：既存RunでAPIサーバーを起動し、`/?mode=replay&from=1793021400&speed=1&debug=1`を開く。初回range完了後、大口板列の棒・threshold・継続時間を見る。`bigTop=1`/`5`、`bigMinSec=0`/`30`を追加して比較。過去へ右ドラッグし、BROWSEでも大口板時刻と処理列数が進み、rebuildCountが変わらないことを見る。
- 実行した確認：画面62/62・サーバー64/64のテスト、両型検査、画面本番ビルドに成功。保存データの固定条件解析、実ブラウザの1倍リプレイ・設定変更・過去への持ち替え・ライブを確認。途中で既存APIサーバーがOOMで異常終了したが、既存Runで1回だけ再起動して未完了項目を確認。最後はSIGTERM・上流close1006・HTTP/プロセス終了を確認。
- 仕様との差分：過去表示時の判断対象については、ユーザーの計画訂正に従い「表示範囲の右端」ではなく「最新の確定列」に統一した。性能改善やサーバーの修正は行っていない。
- 未解決・懸念：既存受信サーバーのヒープ不足。価格zoomの全体最大は44.6msの観測があり、33ms目安を超える。最大フレームの完全な層別内訳は未取得。再起動後の下流sendErrors累積7件は未分類。実機iPad/Safari・高DPR・長時間の性能は未確認。ブラウザ元画像のPNG書出しはできず、画像IDを記録した。
- 次の候補：受信サーバーのOOM原因の調査、同一条件・フレーム単位での価格zoomの負荷切り分け。今回これらの修正、Phase 7の実装は行わない。

## 許可された仕様書差し替え

| 元の添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_(12)_1793082397454.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(6)_1793082395909.md` | `docs/UI_SPEC_HEATMAP.md` |

前の確認ターンで無変換コピーし、指定ハッシュとの一致後、`attached_assets/`直下の`SPEC*.md`・`UI_SPEC*.md`に該当した上記2件だけを削除した。他の添付は削除していない。

```text
d2e126a5cac469b6ecd83d0904fd3eab81b2080dd61e38bd281713a64b39bfa1  docs/SPEC.md
705a62748c6ee846e63086b20cc271cdd05e9cdc16990a6521307927598520bb  docs/UI_SPEC_HEATMAP.md
```

差し替え後のSPEC 7・7.1・7.2・7.3、UI_SPEC 3.5を確認。Phase 4・5の決定値との食い違いはない。

## ファイルと関数

`src/`・`test/`は`artifacts/heatmap/`以下。

| ファイル | 内容 |
| --- | --- |
| `src/data/big-orders.ts` | `parseBigOrderOptions()`、`bigOrderThreshold()`、`BigOrderTracker`、初回応答を管理する`BigOrderFeed` |
| `src/chart/big-orders.ts` | `visibleBigOrders()`、`bigOrderOpacity()`、`bigOrderRows()`、`BigOrderRenderer.draw()` |
| `src/chart/layer-scheduler.ts` | 独立した`big` dirty・callbackを追加。板・約定・大口板の単独更新を分離 |
| `src/main.ts` | 専用Canvas、初回・kind 1の入力、専用描画、debugの件数・閾値・時間・状態 |
| `test/big-orders.test.ts` | 閾値・URL・開始/継続/終了・範囲外・欠け・未来除外・再構築・キャッシュ独立・描画の12テスト |
| `test/layer-scheduler.test.ts` | 大口板単独、板/約定単独、同時更新の分離テストを追加 |
| `PHASE6_REPORT.md` | 本報告 |
| `replit.md` | Current Statusのみ |
| `.agents/memory/heatmap-rendering-decisions.md` | ユーザーが訂正した最新列追跡・再構築条件を記録 |

`cache.ts`・`socket.ts`・既存ヒートマップ/約定/現在板の描画実装は変更していない。一時アプリログは追加していない。

### 部品の入出力

```text
parseBigOrderOptions(search)
  → {top: {value, invalid}, minSec: {value, invalid}}
bigOrderThreshold(column, topPercent)
  → 両側の正の枚数のnearest-rank閾値。正の枚数がなければnull

new BigOrderTracker(topPercent)
  append(column)                  確定列を時刻順に反映
  rebuild(columns, cutoffUs)      cutoffUs以下の列だけで再構築
  snapshot()                     {timeUs, threshold, orders}
  orders[]                       {price, size, startedUs, durationSec, outsideSinceUs}

new BigOrderFeed(topPercent)
  beginInitial(cutoffUs)          hello時に初回応答の受け皿を開始
  accept(columns, kind, reqId)    kind 1を継続入力、kind 2は初回reqId=0のみ収集
  completeInitial()              rangeDone検査成功後に初回再構築し、同時ライブを反映
```

- `BigOrderFeed`は表示用`ColumnCache`を参照しない。初回reqId=0の列を別途収集するため、ユーザーが初回ロード中に過去へ持ち替え、表示キャッシュが列を捨てても初期化の入力を失わない。
- 通常の履歴reqIdは無視し、時間pan・範囲取り直し・価格zoom・resizeでは追跡状態を変更しない。
- `hello`で初回処理を開始するので、最初の読み込み・再接続・URLでリプレイ開始位置を変えた新しいページだけで再構築する。
- 初回はcutoffより後の列を除外し、その後は到着したkind 1だけを処理する。後から取った未来の履歴列は追跡に入らない。
- 範囲外の価格は追跡を保持するが描かない。最初に範囲外となった列の時刻から300秒で失効。期限で戻った場合も前の開始時刻を復活させず、新規開始条件を判定する。
- 3秒以上の欠けで追跡をリセット。2秒以下の欠けは追跡内だけ直前の値を適用し、保存・表示用列は加工しない。
- 通常の追跡更新は確定列だけ。価格viewport・resize等では位置合わせのため専用層も再描画する。板250ms更新・約定更新だけでは大口板層を描かない。

## 仕様にない値として決めた値

着手前の計画で示し、最新列の扱い以外はユーザーから承認された値。

- `bigTop`：有限の数値で`0 < 値 <= 100`。小数可。不正なら2、debugに「bigTop 無効」。
- `bigMinSec`：0以上の整数、任意の上限は設けない。不正なら5、debugに「bigMinSec 無効」。
- 両方とも空文字・空白・数値でない入力・無限大は不正。未指定は初期値で、無効表示なし。
- パーセンタイル：既存と同じnearest-rank法。正の枚数のない列は新規追跡しない。
- 継続時間：判定する列の時刻−開始列の時刻。開始列から5秒後に5秒条件を満たす。
- `bigMinSec=0`等で5秒未満も表示する場合、不透明度0.35。5〜300秒は指定の直線、300秒以上は1。
- 棒は現在板と同じ右端から左向き。
- 更新分離の例外は、価格位置を合わせるためのviewport・resize時の再描画。

これらを保護された仕様本文へ追記していない。

## テスト・型検査・ビルド

```text
pnpm --filter @workspace/heatmap test        62/62成功（既存49 + 新規13）
pnpm --filter @workspace/heatmap typecheck   成功
pnpm --filter @workspace/heatmap build       成功、Vite 7.3.7、23 modules
pnpm --filter @workspace/receiver test       64/64成功（着手前、サーバーは未変更）
pnpm --filter @workspace/receiver typecheck  成功
git diff --check                           指摘なし
node data/phase6-checks/analyze.ts          固定データ解析成功
```

解析スクリプトはルートpackage.jsonがtypeを指定していないため、NodeのMODULE_TYPELESS_PACKAGE_JSON警告を出した。解析は完了。依存・package.jsonは変更していない。単体テストの人工入力は「ダミー」と表示し、実データの確認と区別している。

## 固定データの比較

保存した2026-10-26 UTC13:30〜13:40（JST22:30〜22:40）を選択。寄り付き前30分を初回と同じ入力として追跡し、区間内の実保存列599件を処理した。1秒の欠けは保存のまま扱った。

次の表は画面の1倍再生を10分間観測した値ではなく、保存列を同じ追跡部品で順次解析した値。各列の最良気配中央・価格幅160ticksの範囲を使うため、価格中心が固定のブラウザ画像の件数とは異なりうる。

| bigTop | bigMinSec | 各秒の表示数 最小〜最大 | 平均 | 区間で表示した異なる価格数 | 最長継続秒 |
| --- | --- | --- | --- | --- | --- |
| 2 | 5 | 0〜7 | 2.130 | 91 | 1,049 |
| 1 | 5 | 0〜5 | 0.967 | 54 | 607 |
| 5 | 5 | 0〜18 | 7.721 | 299 | 1,865 |
| 2 | 0 | 0〜8 | 3.164 | 173 | 1,049 |
| 2 | 30 | 0〜3 | 0.886 | 37 | 1,049 |

厳密な同一条件比較：UTC13:30:30、価格中心116921ticks、価格幅160ticks、表示時間600秒。全設定で同じ保存列・判定時刻・価格範囲。

| bigTop | bigMinSec | 表示価格数 | 閾値 枚 | 最長継続秒 |
| --- | --- | --- | --- | --- |
| 2 | 5 | 2 | 9 | 31 |
| 1 | 5 | 2 | 10 | 11 |
| 5 | 5 | 4 | 6 | 64 |
| 2 | 0 | 3 | 9 | 31 |
| 2 | 30 | 1 | 9 | 31 |

正確な入力・各秒の数値・表示価格一覧は`data/phase6-checks/data-analysis.json`。解析スクリプトは同ディレクトリの`analyze.ts`。検証用データは既存のGit/デプロイ除外領域`data/`に置き、外部公開していない。

## ブラウザ確認

Chromium、1280×800、DPR1、1倍リプレイ。動く画像間の比較を固定条件A/Bとはしない。

最初の確認では初回13,339,583 bytes、4,290ms、1,799列。約8秒の観測で表示数1〜2・最長継続21〜28秒、処理列1,820→1,827。BROWSEの10秒観測で処理列1,849→1,858、rebuildCount=1を維持。最初のpanはUTC12:30〜13:00への持ち替えまでは到達していない。

### 画像

| 画像ID | 内容・限界 |
| --- | --- |
| `rmqkdc` | リセット後の表示。マゼンタの2価格と実際の現在板の棒が同じ高さ。116800/116804ticks（29200/29201）、13/10枚、継続82/26秒。履歴のLoading表示があるため、全範囲取得完了の証拠とはしない |
| `jwdjo3` | 600秒のBROWSE、追跡のrebuildCount=1維持。大口板表示2価格、最長61秒 |
| `da8v3s` | 時間方向を約99秒まで拡大 |
| `vsecl0` | 時間縮小。実際は7,200秒であり、1時間の画像とはしない。追加範囲取得中 |
| `inljmz` | 価格幅71.892634ticksへのzoom。狭い価格帯で表示対象0。全体7.98/44.60ms、大口板0.03/0.10ms（平均/最大） |
| `ghykmm` | OOM後のHTTP502・再接続待ち。正常動作の証拠にしない |

画像IDは会話内の画像であり、ワークスペースに保存したPNGではない。`data/phase6-checks/preview.jpg`は初回ロード中の画面で、完成画像の証拠には使わない。

## 性能比較と異常終了

Phase 5の価格zoomは全体平均12.45 / 最大41.90ms。今回の価格zoom画像は平均7.98 / 最大44.60msで、最大の観測値は2.7ms大きい。ただし入力・操作・サンプル時刻が異なり、直近30描画の窓が他の操作と重なる。同一条件A/Bでも悪化率の測定でもない。

同画像の現在板は平均0.17 / 最大0.60ms、大口板は平均0.03 / 最大0.10ms、直近の判定は0.10ms。別の取得サンプルはdepthのdraw6.1ms、集計1.5ms、raster3.0ms、color2.9ms。これらのサブタイマーには包含関係があり、足し合わせない。最大44.6msの当該フレームの全内訳は採れていないため、その最大値の原因を断定しない。リセット画像の別の窓では全体最大47.7msも表示された。

初回確認中、既存受信サーバーPID1002が約3.8GBのNodeヒープ上限付近で`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`、exit134で異常終了。ブラウザはHTTP502となった。2時間表示の範囲取得中だったが、範囲取得が唯一の原因とは未確定。サーバーソース・heap上限・Run設定を変更していない。

PID1002が存在しないことを確認し、既存API workflowを1回だけ再起動して未完了の確認を再開した。異常終了した最初のプロセスについてSIGTERM・close1000・正常shutdownがあったとはしない。OOMの抜粋は`data/phase6-checks/server-oom.txt`、最初のブラウザ観測は`browser.json`。

## 再起動後の残りの確認

同じブラウザ確認を継続し、先に確認したzoom操作や2時間負荷は繰り返していない。再開したシナリオ中はAPI接続を維持した。元の`browser.json`を上書きせず、追加結果を`data/phase6-checks/browser-remainder.json`に保存した。

### URL設定

以下は追加JSONの、`initialComplete=true`・`loadingRanges=0`の数値を採用。各ページは同じ開始位置・1倍再生だが採取時刻が異なる。画像とJSONも別の瞬間に採取されるため、画像内の件数・継続時間と一致しない場合がある。固定条件の比較には前掲の保存列解析を使う。

| 設定 | 判定列のUTC時刻 | 閾値 枚 | 表示価格数 | 最長秒 | 対応URLの画像ID |
| --- | --- | --- | --- | --- | --- |
| `bigTop=1` | 13:30:24 | 10 | 2 | 5 | `yd08hl` |
| `bigTop=5` | 13:30:30 | 6 | 4 | 64 | `x73lfk` |
| `bigMinSec=0` | 13:30:13 | 9 | 4 | 14 | `qqvr6o` |
| `bigMinSec=30` | 13:30:11 | 9 | 0 | 0 | `r9kpg1` |
| `bigTop=bad&bigMinSec=-1` | 13:30:15 | 8 | 1 | 16 | `pzv3r3` |

不正URLはtop=2・minSec=5、両invalidフラグtrue、正確な「bigTop 無効」「bigMinSec 無効」を確認。`bigTop=5`の最初の未完了記録（loadingRanges=1、16価格/1498秒、画像`lk4pc5`）は、完了後の記録と混ぜない。

完了した画像`x73lfk`ではtop5・閾値6・9価格・最長219秒が表示された。JSONの4価格/64秒とは時刻が異なる。画像ではマゼンタの棒、同じ高さの現在板の棒、ヒートマップの価格行がそろっていることも確認した。

### 過去への持ち替え

右ドラッグ6回で時間幅600秒のまま、開始`1793019339329272`µs（UTC約12:55:39）、右端`1793019939329272`µs（約13:05:39）へ移動。大口板の判定列はUTC約13:30:39〜13:30:44であり、画面右端より後の、実際のリプレイ位置を使っている。

- FOLLOW=false、範囲要求は1→2→3、範囲受信3,848,439 bytes、loadingRanges=0。
- 画面時間窓を固定した6回の1秒サンプルで、処理列1,839→1,844、rebuildCount=1のまま、表示3価格、最長40→45秒。
- 画像`gpxmt4`は取得完了後のBROWSE。画像の横軸はJST21:55頃〜22:05頃だが、大口板はJST22:30頃の追跡状態を表示する。意図した挙動であり、過去の列からの再構築ではない。

### ライブ

`/?debug=1`で初回完了・loadingRanges=0・CONNECTED。5秒間の167サンプル（約30ms間隔）：

- 現在板描画37→68、大口板描画19→29。
- 大口板の判定列`1793083438000000`→`1793083443000000`µs。
- 現在板の描画回数が増え、大口板が増えない隣接サンプルが19組。板250ms更新との分離を確認。
- rebuildCount=1。表示対象は0価格/0秒で、この観測区間にライブのマゼンタ棒が実際に出たとはしない。画像`kkx6ib`。
- 別時点のJSONでは最新列`1793083458000000`、現在板`1793083459000000`、大口板`1793083458000000`µs。大口板が現在板より1秒遅い確定列を使う。

ライブ画像の全体平均/最大は9.76/59.70ms（初回取得を含む窓）、現在板0.33/3.20ms、大口板0.03/0.30ms。`bigTop=5`画像の全体6.17/47.90ms、現在板0.11/0.40ms、大口板0.06/0.20ms。いずれも価格zoomの最大フレームの代用ではない。

## 起動・停止と終了時の状態

既存上流接続1本のPID1002を使用し、OOM後に旧プロセス消滅を確認して既存RunでPID3933を1回起動した。同時に別の受信プロセスを立てていない。ブラウザ確認の子はアプリ・設定・依存を変更せず、確認ページを閉じた。画面workflowは実装一式の後に1回だけ再起動した。

停止前status（再起動後の起動セッション）：

- 上流open、再接続0、採用板1,514件、採用約定403件。
- warning/feed/error/ticksLaggedと不正データ件数はすべて0。
- 下流connected=1、totalConnections=9、slowClosed=0、sendErrors=7、invalidRequests=0、rangeRequests=17。接続1本は残っていた画面接続であり、上流の接続本数ではない。
- sendErrors7件の個別原因は今回調査していない。全体を「通信エラーなし」とは報告しない。
- 履歴の180窓は処理済みだが、約定0行の後回し再取得が18窓残った状態で停止。新規起動直前の履歴が完全に取得済みとはしない。
- 停止直前に1秒の`live_column_gap`が記録された。欠けを埋めるコード変更や保存データの加工はしていない。
- 停止前RSS599,484KiB、CPU142%（`ps`のプロセス生存期間に対する値であり、瞬間CPUではない）。OOM直前の最大値の代わりには使わない。

**JST15:47:37.712**にSIGTERMを受理、**15:47:38.333**に実際の上流close1006、**15:47:38.334**に上流停止、**15:47:38.483**にHTTP終了。PID3933の消滅、API workflowのFINISHEDを確認。実際のcloseを正常close1000とはしない。

```json
{"recvUs":1793083657712000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793083657714000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793083658333000,"event":"upstream_network_error","details":{"state":"closing"}}
{"recvUs":1793083658333000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793083658333000}}
{"recvUs":1793083658334000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793083658483000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

`data/phase6-checks/`に`status-before-stop.json`、`resource-before-stop.txt`、`stop-requested.txt`、`shutdown.jsonl`を保存。画面workflowは残しているが、データを確認するにはAPIサーバーのRun再開が必要。

## Current Statusの更新内容

`replit.md`のCurrent Statusに、Phase 6の実装、最新列追跡の独立性、62+64テストと両型検査/ビルド、固定条件の比較、実リプレイ・ライブ、途中のOOMと性能/通信の懸念、最終SIGTERM/close1006/停止、Phase 7未着手を追記した。他の節は変更していない。
