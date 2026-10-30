# GC購入約定の隔離取り込み

**実データ取り込み済み（隔離保存・B/Aのみ製品集計へ採用）。本番未反映。**

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
