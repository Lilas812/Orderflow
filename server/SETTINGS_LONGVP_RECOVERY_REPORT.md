# 設定読取・LONG VP更新停止の切り分けと隔離修正

2026-10-30。`SETTINGS_INVESTIGATION_REPORT.md` の調査・観測を継承した追加作業。
開始時HEAD: `e6161cc3b7f84ce9b48c6a4dadafe5667fdcfd82`。開始時の作業ツリーは空。
FOOTPRINT・約定読取共有などの既存実装を維持し、以前の検証をやり直していない。
**本番書込・Publish・既存受信の再起動／停止・開発上流接続は実施していない。**
VWAP／CVD追加は対象外。以下の比較では既存の両表示もダミー設定でOFFに固定した。

## 1. 実施内容・結論

独立した2系統の問題を修正した。同一原因とは扱わない。

1. **設定**：クラウド読取の独立した一覧取得を直列で待つため、同じI/O条件でも
   10秒を超える経路を再現。必要な通信・照合を削らず並行化した。
   また、共通設定GETの例外が本文検査用400へ誤分類される問題と、
   ローカルI/O失敗が初期値200になる問題を修正。通信失敗と「未保存」を区別する。
2. **LONG VP**：実Chromeの戻る操作で、`pagehide.persisted=true` の際に
   mount・store・60秒タイマーを破棄し、`pageshow.persisted=true` で復元されない
   不具合を再現。変更前は戻った画面の本文が空、debugも消失した。
   BFCacheへ入る場合は画面の状態を保持し、復帰時は期限を過ぎた取得のみ再開する。

**公開で頻発する遅延・5xxの原因全体は未特定。今回の隔離修正で本番の高CPU、
既存の欠け、当日APIの全5xxまで解決したとは判断しない。**

## 2. 公開側の読取専用観測

公開メタデータは `vm / private / successful`。観測対象の公開revisionは
`75e2dcd5-f6fc-49d4-ab8f-28d646cb7606`、build完了06:10:44Z。
Workspaceの現在HEADと公開実行コードの一致は証明していない。

### 2.1 endpoint集計

UTC 07:16:50.715〜07:36:50.715（JST16:16:50.715〜16:36:50.715）。

| endpoint | 件数 | 4xx | 5xx | 平均ms | p50 / p95 ms |
|---|---:|---:|---:|---:|---:|
| `/api/settings` | 4 | 3 | 0 | 9,506 | 7,500 / 9,750 |
| `/api/settings/longvp` | 4 | 2 | 0 | 7,673 | 7,500 / 10,000 |
| `/api/longvp/today` | 20 | 2 | 18 | 5,987 | 4,000 / 10,000 |

これは**method混合集計**。設定GETの試行数・失敗数、Abortと400/403等を分ける
資料ではない。5xxから503の件数も分離できない。集計反映には遅延があり得る。
同窓で設定trace・設定読取エラー・long_vp状態ログを取得できず、
公開のキュー待ち・I/O別時間・イベントループ停止は未測定。

107件のprocessサンプルではCPU10秒平均0.95〜1.39コア、60秒平均1.01〜1.13コア、
RSS430〜559MiB。公開基盤のCPUメトリクス55〜67%、メモリ42〜46%。
指標の分母・平均窓が違うので同一視しない。処理別のCPU帰属は未確定。

### 2.2 認証の境界

UTC07:37:47頃、署名なしGETを計4回実行：
`/api/settings`、`/api/settings/longvp`、`/api/longvp/today?symbol=NQ`、
`/api/longvp/today?symbol=GC`。
**4/4がHTTP307のHTMLリダイレクト、622〜692ms、タイムアウト0。**
設定JSON・version・当日数量は得られなかった。認証の制限は変更していない。
この結果は「サーバーに保存済み設定がない」「当日の数量が0」の証拠ではない。

### 2.3 当日の未準備という候補

同revisionの06:10:44.451〜07:44:24.271Zに絞った追跡では、history関連297件。
取得失敗98件（NQ/book59、GC/book36、NQ/tick2、GC/tick1、network_or_timeout）、
待機68、窓の欠け30。一部の窓完了・保存成功も存在した。
`long_vp_disabled`・`long_vp_failed`・当日準備完了の状態ログは得られなかった。
build以降のtoday集計29要求は24件5xx・3件4xxだが、503かどうかは不明。

実コード上、公開の `index.ts` / `gc-runtime.ts` のready待機後に
`AppLongVp.run()` が当日保存分を構築して `todayReady` を立てる。
履歴準備が終わらず503になる可能性はあるが、公開でready状態を観測できておらず、
履歴失敗が今回の全5xxの原因だと断定しない。未準備と古い内容の200を区別する。

## 3. 変更ファイル・影響・戻し方

### サーバー

以下は`server/src/`からの相対パス。ブラウザ節は`artifacts/heatmap/src/`から。

- `settings/fetch-file.ts:fetchSettingsFile()`：exists→download/renameの順序は維持。
  それと独立したcorrupt一覧listを並行実行。**両方のsettleを待つ**ため、
  一方の同期例外・Promise拒否で次の要求が未完の`.cloud`へ競合しない。
  新しいRAMキャッシュは追加しない。
- `settings/app.ts:fetch()`、`settings/longvp.ts:read()`：上記を共用。
  GET/PUTの同一ファイル直列順序、クラウドを正本とする扱い、
  原本退避・upload・再DL/SHA照合は維持する。
- `settings/local.ts:get()`：ENOENTは引き続き「未保存」、不正JSONは仕様どおり
  退避対象の初期値。その他I/O失敗はrejectし、既知のsource/updatedAtを初期値へ
  書き換えない。GETがPUTを始めることはない。
- `settings/routes.ts`：GET読取失敗を500 JSON `settings_read_failed` へ。
  変更前は保存本文エラー用handlerへ流れて400 `invalid_settings` になっていた。
- `settings/trace.ts`、`settings/longvp.ts`、`status/app.ts`：
  既存opt-in traceをLONG VP設定へも適用。endpoint、直列キュー待ち、
  exists/download/list、保存upload/verificationを分離。
  既存の15分上限・無効時ログなしを維持。公開のフラグは変更していない。

### ブラウザ

- `data/settings-request.ts:requestSettingsDocument()`、`data/settings.ts`、
  `long-vp/settings-modal.ts`：GET/PUTの通信処理を共有。
  リダイレクト、非JSON、JSON破損、HTTP失敗、version/項目不正、10秒Timeoutを区別。
  **10秒は延長しない。通信失敗から初期値documentや自動PUTを生成しない。**
  共通設定version4、LONG VP設定version1を維持。
- `long-vp/store.ts:start()/resume()/destroy()/pollToday()`：
  startの重複防止、破棄済み／旧要求の採用防止、終了済みcontrollerの解放。
  復帰時の取得は最後の試行から60秒以上経過した場合のみ。
  再開時は旧intervalを張り直し、期限切れintervalとの二重発火を避ける。
  通常60秒周期、例外後も次周期で再取得。正常応答は行数ではなく内容ごと採用する
  既存動作を維持した（行数比較による破棄は元々存在しない）。
- `long-vp/app.ts`：BFCacheではmountを破棄しない。
  通常破棄時にはページ・visibility listenerも外す。
  debug=1時のみ、採用済み当日builtAtUsと既に導出したprofile数量を読めるようにした。
  debug読取で新たな集計は行わない。設定GET失敗とstore.startは元々独立している。

追加したfixture/test/helperは `server/test/settings-longvp-*`、
`server/test/settings-read-recovery.test.ts`、
`artifacts/heatmap/test/settings-request.test.ts`。
fixtureはloopbackのダミーObjects・一時ディレクトリ・手動約定だけを使い、
実SDKのクライアントや上流受信を起動しない。画面は「ダミー隔離」と表示。

戻す場合は今回の上記差分だけを戻す。仕様・設定schema・市場データ・coverage・
既存FOOTPRINT・保存形式・保持期間には触れない。公開へ反映する操作は今回行わない。
なおBFCache対策を戻すと、戻る操作で空画面になる既知の不具合も復活する。

## 4. 設定の変更前後測定

比較元は上記HEADのimmutable `/tmp` 展開。既存稼働サーバーではなく、
同じfixtureを旧クラス／新クラスで別port起動した。
各群とも**GET16件・PUT4件**。初回未保存、ダミー通信失敗、認証リダイレクト、
不正version、3.5秒/操作の遅延、100ms/操作の遅延、並行GETを同じ順に与えた。

| GET（各API別） | 変更前 | 変更後 |
|---|---:|---:|
| 試行 | 8 | 8 |
| 正常versionの200 | 4 | 5 |
| ダミー通信失敗 | 1 | 1 |
| 認証redirect | 1 | 1 |
| 不正versionの200（クライアントでは拒否） | 1 | 1 |
| 10秒Timeout | 1 | 0 |

故意に注入した認証・通信・version不正を成功扱いしない。
共通GETの通信失敗は400→500、LONG VP GETは引き続き500。
既知のcloud不存在だけが初期値200であり、取得失敗時に初期値は保存していない。

| 条件・HTTP本文完了ms | 共通 前→後 | LONG VP 前→後 |
|---|---:|---:|
| 保存済みGET・各I/O 3,500ms | 10,002.42 Timeout → 7,007.93成功 | 10,002.76 Timeout → 7,008.42成功 |
| 保存済みGET・各I/O 100ms | 307.03 → 205.84 | 305.35 → 205.52 |
| PUT・各I/O 100ms（照合まで） | 510.06 → 410.94 | 508.93 → 410.15 |
| 同時GET2件・各I/O 100ms | 309.63 / 613.54 → 204.93 / 407.46 | 305.44 / 608.75 → 205.76 / 406.76 |

旧共通GETの遅延要求は、クライアントAbort後もstoreは10,502.94msまで継続した。
新storeは約7,005msで完了。GETの直列性は残り、後行GETの待ちも残る。
新traceで後行GETのキュー待ちは共通202.739ms、LONG VP203.078ms。
旧共通の同条件は304.355ms。旧LONG VPはtrace未対応のため純粋なqueue実測はない。
長い先行PUT待ちの問題は以前の調査結果を再利用し、同じ10秒Abort試験を再実行していない。

| 同20操作の全測定窓 | 変更前 | 変更後 |
|---|---:|---:|
| 経過ms | 13,730.57 | 9,914.30 |
| Node CPU ms | 183.845 | 126.703 |
| 平均CPU（1コア=1） | 0.0134 | 0.0128 |
| loop p99 / max ms（10ms分解能） | 11.02 / 16.12 | 10.79 / 15.21 |
| 最終RSS bytes | 127,938,560 | 136,568,832 |

固定操作数・同I/O遅延だが総窓時間は短縮するため、CPU差をそのままCPU改善率とは
扱わない。単発のWorkspace・ダミー試験であり、公開VMの飽和を再現していない。
RSS減少も示していない。待機を重ねる改善であり、データ処理CPUの改善とは別。

通常の保存済みGETは両群ともexists1/list1/download1、PUTではupload1と
検証download1も追加で行う。全群のuploadは前後とも4回。
list全体は14→16回だが、故意のexists失敗2件でも独立listが開始するため。
正常要求の通信を省略してはいない。ダミーObjects以外には送信していない。
観測traceは旧側が共通APIのみ8要求、新側は両API計16要求であり、
CPU比較にはこの観測範囲差も含まれる。

生記録：`data/settings-longvp/http-{before-controlled,after-controlled}.json`。
最初の再現記録`http-before.json`は制御比較とは分け、比較表には使っていない。

## 5. LONG VPの経路とブラウザ検証

実コードの入口はNQが`index.ts`、GCが`gc-runtime.ts`のReceiver trade callback。
どちらも `pipeline.trade → hub.trade → longVp.trade` に渡す。
当日HTTPは `AppLongVp.today → mergeAggregates/serializeDay → longVpRouter` で、
確定日repositoryキャッシュを当日応答には使っていない。HTTPはno-store。
ブラウザは設定完了を待たず `store.start`、60秒ごとに取得、
`parseDay → store.today/revision → derive → drawProfiles`。
行数一致を理由に更新を破棄する処理は見つからなかった。

隔離では実Receiver/上流ではなく、手動約定を実`AppLongVp.trade()`へ入力した。
保存初期化・ready待機のみをダミーの当日seamで置き換え、
実`today()`・serializer・HTTP router・ブラウザ・Canvasを通す。
**実上流の受信／本番の当日採用は未検証**。

変更前の実Chrome証拠：`data/settings-longvp/baseline.json`、
`baseline-back.png`。pageshow false → pagehide true → pageshow true、
戻った後の本文は空、`__longVpDebug=null`。ブラウザPID42178はexit0。
### 5.1 変更後の期待値と実測

1280×800、DPR1。主Canvasの実寸1214×737。時計の加速・周期短縮は使わず、
通常pollの観測間隔59,992〜60,010ms、最後のnative hidden pollは60,847ms。

| UTC（JSTは+9時間） | 入力・応答の期待 | 実測・描画 |
|---|---|---|
| 07:48:07.565 | 初回。設定失敗でも当日取得は起動 | NQ50、設定500の警告、保存・初期値ボタン無効 |
| 07:49〜07:50 | 新約定なし、時刻だけを根拠に更新としない | NQ50、builtAtも主Canvas hashも不変 |
| 07:51:07.565 | NQ7枚追加を次の60秒周期で採用 | HTTP200・bar合計・profileとも57、主Canvas hash変化 |
| 07:52:07.563 | NQ11枚追加後、故意のHTTP500 | server68だが画面57を保持。前回builtAt・画素hashを維持しエラー明示 |
| 07:53:07.562 | 失敗解除＋NQ13枚を次周期で取得 | HTTP200・profile81、主Canvas hash変化。seriesBuilds6→7 |
| 銘柄選択 | NQ→GC→NQ | `symbol=GC`の応答・profile70 → `symbol=NQ`の応答・profile81。混入なし |
| native Back／reload | BFCache復帰時も画面と状態を維持 | `pagehide.persisted=true` → `pageshow.persisted=true`、本文・profile81復帰。reload後も81、server81／GC70 |
| 08:02:10.809 | 非表示のnativeタブへNQ1枚追加後、次周期取得 | 開始86→応答87。非表示のままbuiltAt更新、前面復帰・描画完了後profile87と画素に反映 |

最後の非表示ケースは、前段の81→86の観測も保持して実行した。
同じ窓のnativeタブを実際に切り替え、入力時・HTTP応答時に
**`document.hidden=true`**、復帰後falseを確認。
server・HTTP・tapeはすべて87、GC70のまま、Runtime例外0。
復帰後2つのrAFと値の収束を待つ確認は818ms。これはCDP往復を含み、
Canvas1回の描画所要時間ではない。
当該比較のseriesBuilds2→3、baseDraws3→4。viewの時間・価格boundsは完全一致した。
初期～57～81の比較でもboundsは変わらず、bars1m行数1・vp30m行数2のまま数量更新。

| ダミー当日builtAtUs | profile数量 | 主Canvas SHA-256 |
|---|---:|---|
| 1793346351519000 | 50 | `61658cb16ff771e0b75ffb4ce3a753fc17439b7b294e876225c20329572c9d04` |
| 1793346352519000 | 57 | `4c867697a19fe5d71b4132d6a3e9212a1cd4f238761dfc767edb98562dc68fbe` |
| 1793346354519000 | 81 | `2294828b0a9c1aba35091d9da1a434c4347e4bfb25692410dc89ae51dad617cb` |
| 1793346355519000 | 86（別native文書・同文書内で次行と比較） | `9f73c2fc59b67263731a1c34ac2485cc706530f00e8c78baf735cf89ea69f3af` |
| 1793346356519000 | 87 | `d0cb9d5bd82b760ebabd0da5e9d46912b07c94ee1b2eedae385190b1fb76685d` |

builtAtはfixtureの手動データ時計。最後の比較ではUTC07:45:55.519→07:45:56.519。
上表のHTTP実時計08:02:10.809と混同しない。データ時刻は同じ1分内で進め、
行数が変わらない数量更新を確認した。異なる文書同士のhash差は比較根拠にしない。

初回の両設定失敗時にNQ50は描かれ、LONG VP設定を手動で読み直した後も
ダミーupload回数は**意図したseed PUTの1回だけ**。自動PUT0。
共通設定からの時刻表示の読取は別系統なので、その初回警告は
LONG VP設定だけのretry後にも残った。両方が同時に回復したとは報告しない。
HTTP負荷比較の意図したPUT4回とは別fixtureの計数である。

### 5.2 誤判定を修正した観測と証拠

最初のPlaywright別窓は両方visibleだったため、非表示成功と数えていない。
その後nativeタブへ切り替えた。
81→86の即時観測ではstoreのbuiltAtは既に86のものへ進んでいたが、
復帰直後の派生profile・画素は81だった。描画完了を待たずに読んだ観測から
「採用が止まった」とする判定は撤回した。
86→87では実visibleを確認して2 rAF＋収束を待ち、採用・描画の両方を確認した。
この観測上の差を隠すための製品コード変更はしていない。
native helperの起動引数誤り1件もブラウザを閉じて修正し、アプリ失敗には数えていない。

証拠：
- `data/settings-longvp/ui/result.json`：統合結果（primary・native・最終settled）。
- `primary.json`：HTTP本文、debug、失敗時の保持、銘柄切替。
- `native-followup.json`：実hidden、native Back、reload、PID終了。
- `native-hidden-86.json`：未settleの即時観測も削除せず保持。
- `final-settled-87.json`：実hidden入力→60秒HTTP→復帰・2 rAF後の87枚、画素、view一致。
- PNG：`before-nq7.png`、`after-nq7.png`、`failed-poll-retained57.png`、
  `after-nq13.png`、`native-after-back.png`、`native-after-reload.png`、
  `before-hidden-nq1.png`、`after-settled-nq1.png`（すべて同ディレクトリ）。

fixtureのHTTP記録のpathはExpress router内の相対値（`/today`等）を含む。
ブラウザのnetwork記録には完全な`/api/longvp/today?symbol=...`が残る。

## 6. 実行した確認

```sh
node --test --test-concurrency=1 \
  server/test/settings.test.ts server/test/settings-trace.test.ts \
  server/test/long-vp-settings.test.ts server/test/long-vp-app.test.ts \
  server/test/settings-read-recovery.test.ts \
  artifacts/heatmap/test/settings.test.ts artifacts/heatmap/test/settings-form.test.ts \
  artifacts/heatmap/test/settings-request.test.ts artifacts/heatmap/test/long-vp.test.ts
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/receiver run build
```

関連53/53、両型検査、再ビルド成功。
その後の同期例外の待機ガード・正当なJSONへのredirect許容の強化は
変更部3/3を再確認し、両型検査も成功。認証のHTMLへのredirectは引き続き拒否する。
最後にブラウザ終了後もう一度再ビルドし、1.45秒で成功。
これら3件は既存53件の内数であり、異なる試験56件とは数えない。
初回型検査ではダミーloggerのunknown引数型3件を検出し修正済み。
製品の設定versionや依存を変更して回避してはいない。

## 7. 仕様との差分・未解決・確認手順

- 仕様との差分：なし。60秒・10秒期限・保存保証・既存設定の分離を維持。
- 未解決：公開のキュー/I/O/loop別実測、ログイン済み公開GETのJSON内容、
  5xxの内訳、実上流からの当日採用、Safari実機、長時間の負荷／メモリ。
  検証用ダミーで取得失敗を隠す補完やデータ削除・間引きはしていない。
- 公開への反映後に確認するなら、認証済み端末で両設定GETを別々に見て、
  正常JSONのversion4/1、失敗時の保存無効、当日応答の数量と画面を比較する。
  新約定のない周期は数量が変わらなくて正常。応答時刻・builtAtだけで鮮度を判断しない。
  画面切替・戻る後にも次周期の取得と描画が続くことを確認する。
  公開反映・観測フラグ有効化は今回行わず、別途許可が必要。
- 次の候補：認証済み公開観測で未特定箇所を絞ること。VWAP／CVD追加には進まない。

### 終了確認

UTC08:04:42.616、`data/settings-longvp/cleanup.json`に保存。
- 自分のfixture PID42101/43330/43347/43444はすべて不在。
- 自分のChrome PID42178/43505/44592/45069/45286/45678もすべて不在。
  primary browserはcontextを閉じただけではPID43505が残ったため、
  所有するプロファイルを確認しSIGTERM。その後のPID不在まで確認した。
  native Chromeはexit0→PID不在。全Chrome／crashpadのprocess検索も0行。
- port18782/18783/18784/18785はすべて`ECONNREFUSED`。
  fixtureにはHubも上流接続も作らず、自分のWS接続0。
  自分のHTTP listenerもないため、そのfixtureへ残るHTTP接続もない。
- 既存receiver PID415および観測済みの既存7processは全て生存。
  既存受信の停止・再起動は行っていない。
- 最後のダミーsnapshot：NQ87／GC70、cloudWrites1。
  `data/settings-longvp/fixture-final.json`。

通常の仕様・設定・保存データ・認証・公開構成を変更していない。
検証用ObjectsへのPUT以外に保存要求を送っていない。
