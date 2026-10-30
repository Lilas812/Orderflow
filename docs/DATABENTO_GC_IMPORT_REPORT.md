# GC購入約定の隔離取り込み

**実データ取り込み済み（隔離保存・B/A/Nを総量へ採用）。本番未反映。**

## 方向不明数量の修正（2026-10-30、現行結果）

ユーザー指定によりB/Aだけを採用した初回方針を改めた。**以下の初回記録のN除外・旧active hash・旧数量は履歴であり、現在値ではない。**

### 全量・価格別・再実行

| 項目 | 初回 | 修正後 |
|---|---:|---:|
| 標準GC採用件数 | 2,014,936 | **2,050,826** |
| 総枚数 | 2,915,632 | **2,966,996** |
| 買い | 1,454,155 | 1,454,155 |
| 売り | 1,461,477 | 1,461,477 |
| 総量に含む方向不明 | 0 | **51,364（35,890件）** |
| スプレッド | 103,620件・別保全 | 103,620件・別保全、全指標から除外 |

26CSVの検証済みステージと21限月について、全行の件数・枚数・価格加重合計・価格別のbuy/sell/N数量が一致。元CSV ordinalの厳密増加と、入力ファイル／side群ごとの順序付きhashで、内容・順序・同内容別約定の多重度を照合した。イベント時刻ではsortしないため巻き戻りも維持する。

日次CVD／VWAP・LONG VP・全量FOOTPRINTを照合。FOOTPRINTは実`FootprintStore`を1時間ずつ使い、全件・全価格・全5秒足の総量=買+売+不明、デルタ=買−売を確認した。GCZ26は2,009,413件・2,908,774枚（うちN26,698枚）、290,128非空5秒足、2,695価格が一致。他20限月も合格。保存元90ファイルと前回NQ activeは不変。

GCZ26の購入区間全体のVWAP（**未調整、同限月**）：
- 修正前：41,398.14605513526 ticks＝4,139.814605513526。
- 修正後：41,398.292500207994 ticks＝4,139.8292500208。
- 元の全B/A/NのΣpriceTicks×size÷Σsizeに一致。異なる限月をまとめた価格平均を市場VWAPとは呼ばない。

同じZIP・UTC範囲・`all-outright-v2`で再実行し、全出力hashを照合して`already_imported`。再集計・行追加なし。旧B/A-onlyとは採用方針キーを分けているので旧キャッシュを誤採用しない。

### 変更範囲

- `server/src/import/databento-install.ts::mergeIncoming/replaceHour/install`：B/AとNの分離ファイルを元CSV順にストリーム合流。Nも区間置換へ採用。原本・ステージ・スプレッドは変更しない。正常・例外・中断のいずれもstreamをfinallyで閉じる。
- `server/tools/import-databento.ts`：採用方針キーを追加し、新世代へ再生成。
- `server/src/import/databento-rebuild.ts`：Nを価格別数量・VWAP分母へ含める。
- `server/src/types.ts`／フロント`domain.ts`／`data/protocol.ts`：side=unknownを受理。既知B/Aは従来のまま。
- `server/src/vp/state.ts`、フロント`data/daily.ts`・`data/vp.ts`・`chart/vp.ts`：Nを独立数量で保存し、VP・POC・VA・VWAP・総量へ加算。CVDはbuy−sellのまま。限月不明数量とは別。
- `server/src/long-vp/{aggregate,day,objects,app-service}.ts`、フロント`long-vp/model.ts`：Nの保存・読取・merge・価格別合計・週VWAP。週CVDは既知buy−sellのみ。Nを失う再構築は保護判定で拒否する。
- フロント`data/trade-aggregate.ts`、`footprint/model.ts`：Nを独立列で保持。フットプリント総量・価格POCに含め、deltaと買売セルへ配分しない。バブルは従来のbuy+sellで判定・着色し、Nから買売色を作らない。価格ラインは実約定価格を保持する。

任意のN数量をVP／日次／長期の配列末尾へ追加。旧長の配列も新フロントは受理し、B/Aだけの出力長は変えない。**旧フロントはN拡張配列を受理できないため、公開する場合は対応フロントとサーバーが必要。今回は未公開。**

### 保存先・再現手順・戻し方

現行世代：`data/databento-gc-import/generations/c13e46e4-f6c6-4eda-898e-cb5a2c79146b/`。新active SHA-256：
`95ce0121a6061c09744f72a532d62033c878187c33298e82d7b995a912e8f988`

旧世代`cc7d31d6-b492-4995-89b0-4f8041fceed4`は残り、import.json hashは旧activeと同じ`015b894c9e62e5b5af449811a1a1f4270a459d570af3eff8e6187cbc7c8cd667`。戻す必要があれば、旧manifestと出力hashを照合して**隔離activeだけ**を旧manifestへ原子的に切り替える。今回は戻していない。

```sh
node server/tools/import-databento.ts --zip=attached_assets/GLBX-20261030-JWXTRBXPJQ_1793362749512.zip --out=data/databento-gc-import --base=data
node server/test/databento-full-check.ts --out=data/databento-gc-import
node server/test/databento-footprint-check.ts --out=data/databento-gc-import
# 同じimportコマンド再実行：already_imported、全hash不変
node --test server/test/unknown-side.test.ts
```

関連server試験34件と追加3件、保護判定を含む追加関連32件、フロント177件、両型検査・製品buildに合格。最初の追加試験はテスト側のメソッド名誤りで1件失敗し、実在する`appendLive`へ修正後3件合格。製品処理の失敗ではない。

関連仕様SHA-256：
```
b4ae18f2665f9c88dc7e954d344c403f838529e23454368305105870b1263128  docs/DATABENTO_IMPORT_SPEC.md
2e6ba512e738439a150191e45c4e37de23a2b03c6e30b39967e95607a9daa287  docs/SPEC.md
```
SPECでは内部side型と方向不明の総量／方向計算の扱いだけを追記した。上流TICK STREAM自体の提供形式は変更していない。

### 「完全値」の範囲

**購入CSVに含まれる標準GC outrightの数量・VWAPとしては全量値になった。Nの取りこぼしは解消した。** 買売方向が不明な量を含むため、デルタ・CVDは引き続き既知方向分のみ。

**購入対象期間／CME全体の完全性まで保証したものではない。** 10/24の供給condition=degraded、未提供の日時、最初のセッション冒頭2時間、最後のセッション残り、購入期間外の約定を作らない。これらの欠け・途中集計表示は維持。Nがあるという理由だけの出来高coverage欠けは解消するが、板は未補修。NQの前回隔離データは今回再生成していない。

### 今回の実画面・終了確認

固定snapshot GCZ26・2026-10-01 14:35 UTC、dummy設定・板なしの実製品読取／WS／Canvas経路で確認した（実ライブではない）。

- HEATMAP：全19,758点のAPI／DailyStateの累積が、買36,550／売36,392／N789＝**73,731枚**、CVD **+158**、VWAP **4197.107474467999**で一致。修正前72,942枚との差789がN分。VP・VWAP・CVDの実Canvas表示を確認。capture `jwqi3t`／`vtbyeg`。
- FOOTPRINT：14:33:25 UTCの5秒足が買17／売14／N1＝**32枚**、delta **+3**。実debugと画面の`VOL32 / Δ+3`が一致。capture `e55vvq`。Nを買17や売14へ混ぜていない。
- LONG VP：10/01のGC API200。vp30m 5,177行とbars1m 1,377行の双方でN1,232枚。実buildSeriesは総量**121,743枚**（既知120,511＋N1,232）、VWAP 41,983.897086485464 ticks、CVD+737で一致。画面は10/20〜10/30と当日503警告を確認したが、**今回の10/01のCanvas再確認は未完**（API／実モデル計算は確認済み）。capture `1cfqq0`。
- バブルは方向付き3枚だけが2個の買／売bubbleになり、N10枚の価格にはbubbleが出ないことを実`tradeGeometry`単体試験で確認した。今回の実購入画面上でNの買売色除外を直接確認するところまでは未了。欠け／途中集計表示・当日503・板0を正常な実ライブとは扱わない。

数量・画面・終了のJSONは`data/databento-gc-import/unknown-ui/`。PNGの指定フォルダ保存はできず、上記観察capture IDを記録。通常プレビューの`unknown-workspace-preview.jpg`は板待機表示であり、購入データの検証画像に代用しない。

Chrome PID15892のcontext.close後の残存も所有profileの親子だけを終了し、全PIDのESRCHとhub接続0を確認した。追加プレビュー撮影用Chrome PID17353の親子もESRCH。最後に隔離サーバーPID15841をSIGTERMで終了、ログ`stopped:true, connected:0`、PID消滅、18814／9233閉鎖、検証Chrome残存0を確認した。証拠は`unknown-ui/cleanup-evidence.json`、`unknown-preview-closed.json`、`unknown-cleanup.json`。

本番書込・再Publish・既存受信の停止／再起動・開発上流接続追加は行っていない。HEATMAP平均化等の保留差分も保持している。

2026-10-30。ユーザーの「GCの取り込みを先にする」に従い、HEATMAP平均化・平滑化の差分・合格結果を保持して保留し、GCを先行した。

## 入力・保存先

- 原本：`attached_assets/GLBX-20261030-JWXTRBXPJQ_1793362749512.zip`
- SHA-256：`4a26cd04d2e895e5e0bfc1c56daa298d8ecb7e7f241053923b716b5a93d6c2c0`
- metadata：GLBX.MDP3、trades、GC.FUT parent、pretty_px／pretty_ts、CSV.zst、UTC **[2026-09-30T00:00:00Z, 2026-10-30T00:00:00Z)**。26日分CSV＋metadata／condition／manifest。
- 原本は変更していない。CSVの小数価格をGCの0.10刻みの整数へ変換し、元のevent／recvナノ秒文字列を保持した。DBNの整数価格と混同していない。
- 限月は生レコードのsymbolで確認した。MGC／XAU/USDではない。GCZ26を現在限月として全過去へ割り当てていない。
- 独立入口：`data/databento-gc-import/active.json`
- 世代：`data/databento-gc-import/generations/cc7d31d6-b492-4995-89b0-4f8041fceed4/`
- activeと世代import.jsonのSHA：`015b894c9e62e5b5af449811a1a1f4270a459d570af3eff8e6187cbc7c8cd667`
- 原本ステージ・unknown・excluded・baseline・出力hash一覧を同rootに保存。前回NQのroot／activeは変更していない（NQ active SHAは`78be86793bee9dae0ee12c293a8824f74e7e6079c6301de7125f63a980e50367`のまま）。

## 全量照合

| 分類 | 件数 | 枚数・備考 |
|---|---:|---|
| 入力全体 | 2,154,446 | 親シンボルにはスプレッドも含む |
| 採用B/A | **2,014,936** | 買1,454,155／売1,461,477＝2,915,632枚 |
| 主導不明N | **35,890** | **51,364枚**。unknown gzipへ保全、推測配分なし |
| スプレッド | **103,620** | 買138,032／売154,515／不明50,570＝343,117枚、別保全 |
| 解析失敗 | 0 | 黙って捨てた行なし |
| 既存限月不明との重複保留 | 0 | NQの保留とは別の結果 |

件数合計が入力と一致。親指定全体の枚数は買1,592,187／売1,615,992／不明101,934＝3,310,113枚。通常GC outrightの原本は2,050,826件・2,966,996枚。

確認した21限月：
GCF27、GCF28、GCG27、GCG28、GCH27、GCJ27、GCJ28、GCK27、GCK28、GCM27、GCM28、GCN27、GCQ27、GCU27、GCV26、GCV27、GCX26、GCX27、GCZ26、GCZ27、GCZ28。

GCZ26は採用1,991,880件、買1,437,096／売1,444,980枚、2,695価格、506時間ファイル、23セッション。その他も限月別に保存・再集計している。限月別の件数・枚数・価格数・セッション数は`full-check.json`／`inventory.json`を参照。

採用全行の件数、枚数、weighted ticks、価格別数量、時間ファイルの順序付きhash／多重度、日次CVD／VWAP、LONG VPの買売合計が一致。同じアーカイブの再実行は出力hashを確認して`already_imported`となり、件数は増えていない。既存90ファイルのhashも一致。

**不明主導分の影響：**既存のB/AのみのTrade型へNを混ぜていないため、表示の出来高・VP・VWAPも既知主導分であって全購入数量の完全値ではない。未知のCVDを0や半々で補わない。Nのある時間は完全取得と認定しない。

conditionの10/24はdegraded。ファイルがない日、購入区間外、最初のCTセッションの冒頭2時間、最後のセッションの残りを0約定で補わない。全て途中集計・欠けを維持。**約定だけの購入なので板の空白は未補修。**

## 小区間・修正・試験

最初に[2026-09-30 00:00, 00:05)を取り込んだ。独立したCSV十進変換とGC指定の実LocalStore読取で次が一致した。

- GCZ26：230件、買186／売123枚、45価格、CVD63。
- GCG27：1件、売1枚、CVD−1。

初回pilotでは、日ファイルには存在するが指定5分内に約定のない限月で、rebuildが存在しない`trades/GC`を読みENOENTになった。**activeを更新せず停止**し、原本・baseline・未確定世代を保全した。

修正は`server/src/import/databento-rebuild.ts::rebuild`のみ。対象ディレクトリのENOENTだけを空リストとして扱い、他のI/O例外は引き続きthrowする。空限月の0件・セッションなしを試験した。空区間へ履歴を生成していない。

既存checker／画面fixtureを`--out`と限月に対応させ、GC reader／Hub／LONG VPルーターにGCを明示。NQ既定のままGCを読まない。新しい製品API・保存形式・設定versionは追加していない。

実行：
```sh
node server/tools/databento-audit.ts --zip=attached_assets/GLBX-20261030-JWXTRBXPJQ_1793362749512.zip --out=data/databento-gc-import --member=glbx-mdp3-20260930.trades.csv.zst
node server/tools/import-databento.ts --zip=attached_assets/GLBX-20261030-JWXTRBXPJQ_1793362749512.zip --out=data/databento-gc-import --base=data --from=2026-09-30T00:00:00Z --to=2026-09-30T00:05:00Z
node server/test/databento-pilot-check.ts --out=data/databento-gc-import
node server/tools/import-databento.ts --zip=attached_assets/GLBX-20261030-JWXTRBXPJQ_1793362749512.zip --out=data/databento-gc-import --base=data
node server/test/databento-full-check.ts --out=data/databento-gc-import
node server/test/databento-inventory.ts --out=data/databento-gc-import
# 全量と同一コマンドを再実行：already_imported
node server/test/databento-import-fixture.ts --out=data/databento-gc-import --contract=GCZ26 --port=18814
```

関連server試験34件、server型検査に合格。フロントはHEATMAP変更時点の177件・型検査・build成功を再利用（GC取り込み後の製品フロント変更なし）。中断・再実行・行の重複／巻き戻り／区間外保持は既存試験と前回NQの実中断結果を再利用し、GCでは小区間と全量の同一入力再実行を確認した。

仕様書SHA（今回更新後）：
```
d1ee33d11796b4a28d49fec5a6e5a0c33c814961b955b244eae3e00f3c46e834  docs/SPEC.md
2049ed433779abdd74aeb2b6b8462f88965f73495b67ff306838e88ee738ea30  docs/DATABENTO_IMPORT_SPEC.md
```
SPECの変化には保留中HEATMAPの許可済み追記を含む。GC側は親指定スプレッドの説明をNQ／GC両方へ拡張した。

## 実画面・終了確認

GCZ26、2026-10-01 14:35 UTCを基準に、実LocalStore／Hub／製品フロントを使用する隔離画面で確認する。元約定の時刻は変更しない。板なし・設定ダミー・当日LONG VP API503であり、実ライブではない。

### 実測

- HEATMAP：50,400約定、535価格、VP買36,550／売36,392＝72,942枚。日次19,609点、CVD=158、VWAP=41,971.3059965452 ticks＝4,197.13059965452。日次pointsの和とprofileが一致した。
- 実Canvasの非黒画素：価格／約定overlay17,520、VWAP1,705、VP117,248、DELTA3,724、CVD4,133。深度0・現在板0であり、板待機表示を確認。
- FOOTPRINT：実WSの最終60秒は119件。独立したGC指定LocalStore集計で、14:34:55〜14:35:00は9件、買5／売5＝10枚、直前5秒は28件、買24／売51＝75枚。画面下部の合計10／75と一致。買売内訳の正確な数値は独立集計であり、hoverは追従で基準時刻後の空足へ進んだため画面上での全内訳照合は未完。
- LONG VP：10/01のGC日次API200、契約GCZ26、1分足1,377、30分VP5,175。実画面でプロフィール・価格系列・crosshairを確認。GC選択が維持され、価格4194.6の小数1桁表示。
- LONG VPはcomplete=false、10/01のgapsは取引日全域。多くの時間に未採用のNがあるため完全取得と認定できず、既知B/Aが存在しても不完全区間になる。全日0約定や保存失敗を意味しない。不完全8日・保存なし2日の警告、当日API503もそのまま。実フィードの完全性は未保証。
- 価格軸の視覚表示はGCで確認したが、HEATMAPのaria-labelには旧NQの文言が残る。取り込みとは独立した既存の表示説明であり、今回製品コードを変更していない。

証拠：`data/databento-gc-import/browser/`の`import-status.json`、`evidence-summary.json`、`footprint-5s-localstore.json`、`longvp-day-2026-10-01.json`。観察スクリーンショットIDはHEATMAP `omarvm`、FOOTPRINT `dwiry0`、LONG VP `qori4r`。これらは観察キャプチャで、指定ディレクトリへのPNG保存はできていない。別途、通常Workspaceプレビューの状態画像だけは`workspace-preview.jpg`へ保存したが、購入GCの証拠には代用しない。

### 終了

- 確認用Chromeはcontext.close後に残ったため、所有プロファイルの親PID7447と子だけにSIGTERM。PID消滅・hub接続0を`browser/shutdown.json`で確認した。
- プレビュー撮影用に追加起動されたChromeも所有を特定して終了。親子PIDのESRCHを`preview-browser-closed.json`へ保存した。
- 最後に隔離サーバーPID7410へSIGTERM。ログは`stopped:true, connected:0`、PIDはESRCH。専用18812／18813／18814、CDP9233は閉鎖、検証Chrome残存0、import lockなし。`cleanup.json`に記録。
- 既存の通常workflowには停止／再起動を行っていない。プレビュー上のupstream stopped表示は確認したが、こちらで開発上流を接続する操作はしていない。

## 未反映・戻し方

本番書込、再Publish、既存受信の停止／再起動、上流の追加接続、購入は行っていない。通常アプリの保存先へは未採用。

元データに戻す操作は不要。隔離入口を変更する場合だけ、保全した別世代のimport.jsonを照合し、一時ファイル＋renameで隔離activeを切り替える。今回その復帰操作は実行せず、原本・baseline・未確定世代も削除しない。

HEATMAP平均化・平滑化は保留。途中結果は`docs/HEATMAP_SMOOTHING_REPORT.md`に記録し、再開時に合格済み結果を再利用する。
