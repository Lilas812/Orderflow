# Databento購入約定 取り込み報告

**実データ取り込み済み（隔離保存・一部保留）。本番・通常プレビューには未反映。**

2026-10-30。公開前レビューは保留。既存の最新表示、日次CVD／VWAP、設定、LONG VP、FOOTPRINT、GC、読取共有の製品コードは変更していない。

## 1. 実施内容・入力

- 原本：`attached_assets/GLBX-20261030-NAXB9F53AX_1793358357163.zip`。原本を変更・削除していない。
- 原本SHA-256：`20240f85041fb719e0a512929fd7242ba82e08ef1388bbdb119a3155408b5985`
- 同梱metadata：GLBX.MDP3／trades、親指定`NQ.FUT`、CSV、zstd、pretty_px／pretty_ts=true、日別分割、limit=null。26個のCSV.zstを検証した。
- UTC半開区間：**[2026-09-30 00:00:00, 2026-10-30 00:00:00)**。画像ではなく、CSVのsymbolからNQZ6／NQH7／NQM7／NQZ7を確認し、それぞれNQZ26／NQH27／NQM27／NQZ27として別々に保存した。GCは同梱されていない。
- 親指定にはカレンダースプレッドも含まれる。標準NQへ混ぜず別保全。期近への切替時刻は推定していない。
- 供給conditionは10/24がdegraded。CSVが存在しない日を「確認済み0約定」と扱っていない。最初のCTセッションの開始2時間と、最後のセッションの残りは購入区間外で、完全日ではない。
- 公式形式の根拠：<https://databento.com/docs/schemas/trades.md>。B=買い主導、A=売り主導、N=不明、時刻はns。実CSVの小数価格はDBNの整数価格ではなく、BigInt整数比でNQの0.25刻みへ変換した。GCの0.10変換は隔離試験のみ。
- 元のevent／recvナノ秒文字列を保存し、アプリのµs整数へ切り捨てる。instrument_id、取引所sequence、raw symbol、入力hash、行番号も保全。同内容の別行を除重しない。

## 2. 保存先と照合結果

入口：`data/databento-import/active.json`

確定した隔離世代：
`data/databento-import/generations/9d3cfb11-ae8d-4aeb-b679-f3ef7fea1125/`

各限月の下に、既存互換の`trades/NQ/YYYY-MM-DD/HH.jsonl.gz`、coverage、日次・長期集計、価格別数量を配置した。全行をRAMへ載せずストリームで処理した。

| 限月 | 採用件数 | 買い枚数 | 売り枚数 | 既存限月不明との重複で保留したB/A件数 | 再集計セッション数 |
|---|---:|---:|---:|---:|---:|
| NQZ26 | 9,229,328 | 6,386,767 | 6,378,676 | 875,154 | 22 |
| NQH27 | 13,110 | 8,095 | 8,355 | 1,118 | 22 |
| NQM27 | 173 | 94 | 94 | 17 | 19 |
| NQZ27 | 3 | 0 | 21 | 0 | 2 |
| 合計 | **9,242,614** | **6,394,956** | **6,387,146** | **876,289** | 限月別 |

全入力10,123,321行の内訳：

- 採用B/A：9,242,614行、12,782,102枚。
- 保留B/A：876,289行、1,203,625枚。10/26〜10/28の既存限月不明との重複。既存行は置換せず、購入行は検証済みステージに保全。
- 不明主導N：38行、1,485枚（NQZ26=1,476枚、NQH27=9枚）。`unknown/<限月>/<日>/<時>.jsonl.gz`に保全。推測配分していない。
- スプレッド：4,380行、6,486枚（買3,167／売3,311／不明8）。`excluded.jsonl.gz`へ理由・元行付きで保全。
- 解析失敗：0行。上記の件数合計が入力全行と一致。

親指定の入力全体は買6,997,869／売6,994,336／不明1,493枚。通常のNQ outrightだけでは買6,994,702／売6,991,025／不明1,485枚。除外・保留分を含めて数量が一致した。

**集計への影響：**現在の製品Trade型へ渡したのは採用済みB/Aだけ。Nを除くため、VP・出来高・VWAPも全購入データの完全値ではなく既知主導分の途中集計。CVDに不明側を推測加算していない。保留範囲も0枚として埋めていない。

### ハッシュと原本保全

- `active.json`と世代の`import.json`は同一SHA-256：
  `78be86793bee9dae0ee12c293a8824f74e7e6079c6301de7125f63a980e50367`
- 全変換gzipのSHAと順序付き内容hashは`active.json`の`staged[].outputs`／`outputHashes`に記録。原本、metadata、condition、manifestも検証した。
- 既存の置換対象データは`data/databento-import/baseline/`へコピー。90ファイルを最終時点で元ファイルとSHA照合し、一致。元の`data/coverage.json`も内容一致。GCの既存データも未変更。
- `full-check.json`で、採用全行の件数・買売・weighted ticks・価格別数量・時間ファイル内の行順／多重度を照合した。NQZ26は10,519価格・460時間ファイルで一致。限月ごとの日次CVD／VWAP、LONG VPの買売合計も一致した。
- 全量再実行は`already_imported`で終了し、同じ世代を維持。内容一致の正当な別約定は行番号由来の別seqで残る。

## 3. 最初の小区間・中断復帰

最初に[2026-09-30 00:00:00, 00:05:00)だけを処理した。

- NQZ26：984件、買668／売658枚、CVD=10、66価格。
- NQH27：1件、売1枚。
- 原CSVを独立に十進整数変換した計数、実際のLocalStore読取、価格別数量、再集計が一致した。同じ5分を再実行しても増えない。

入力2ファイル検証後の意図的中断と、取り込みプロセスだけへのSIGTERMを検証。旧activeのhash・件数が変わらず、検証済みステージを再利用できた。

途中でプラットフォームからWorkspace再起動の通知があり、作業プロセスと既存開発受信が不在になった。こちらから既存受信を停止・再起動する操作はしていない。再起動の原因は未特定で、公開先への影響は確認・操作していない。

全時間ファイル保存後／集計完了前の世代は、そのまま採用しなかった。immutable baseline＋検証済み購入行から期待ストリームを再構成し、既存の隔離gzipの全行順hashと比較して再利用した。保存し直さず再集計し、全出力照合後だけactiveを原子的に更新した。未検証.partialや古い世代も削除していない。

## 4. 再集計・実画面

既存の`VolumeProfile`／`LongAggregate`で**購入範囲の全対象セッション**を処理した。直近7日で打ち切っていない。後続累積は置換後のセッション全体から作り直す。限月は別々で、既知期間へ未知の価格差0を接続していない。

製品のLocalStore、Pipelineの範囲／FOOTPRINT読取、Hubの実WS、LONG VPルーター、既存ビルド済みフロントとCanvasを使用した。設定I/Oだけはダミーに隔離。古い購入履歴が通常の7日保持で消えないよう、隔離readerのretentionを止め、表示基準を2026-10-01 14:35 UTCにした。**約定自身の時刻は動かしていない。実ライブではない。** LONG VPは購入履歴全体を読む。

| 画面 | 実測・数量照合 | 画素・証拠 |
|---|---|---|
| HEATMAP | 当日276,826件、買183,422／売185,685＝369,107枚、2,363価格。VP一致。CVD=-2,263、VWAP=123,178.7757 ticks（約30,794.6939）。38,848秒ポイント | バブル1,237、DELTA192本。価格軸操作でVWAPを可視範囲に入れ、黄457画素、CVD5,760非透明画素を確認 |
| FOOTPRINT | 実WSで60秒・1,715約定。表示中8本の5秒足について、購入行を独立集計した買売・合計と全本一致。例：14:34:55 UTCは買238／売121＝359枚 | 実セル・数量あり。unreported／recorded_not_guaranteed表示を確認 |
| LONG VP | 2026-10-01の実day API=200、1分足1,380本、30分VPレコード15,542件、gaps2 | 非黒131,613画素、週VWAP黄3,312画素。日次VP・価格系列を確認 |

画面証拠：
`data/databento-import/browser/step1-heatmap.png`、
`step2-footprint.png`、
`step3-longvp.png`。
各JSON、`summary.json`に期待値・実測値を記録した。

当日APIの503は、この隔離fixtureが実際の当日ライブを提供しないため。LONG VPの不完全3取引日・保存なし2取引日の表示を正常な完全データとして扱っていない。VP／日次のloading表示も完全性未保証の状態で、全日取得完了や実ライブの証拠にはしない。

**板は未補修。**購入schemaはtradesだけ。既存板はbaselineに保全したが限月照合しておらず、隔離fixtureからは提供しない。確認した画面でも板の描画は0行だった。

## 5. 変更ファイル・確認コマンド

新規：
- `server/src/import/databento-csv.ts`：`priceTicks`／`timestamp`／`convert`／`scanCsv`
- `server/src/import/databento-stage.ts`：`stageFile`、原本hash別ステージ・限定バッファ
- `server/src/import/databento-install.ts`：`snapshot`／`replaceHour`／`install`、保護・原子的置換・検証済み世代再利用
- `server/src/import/databento-rebuild.ts`：`rebuild`、全対象日の日次・長期再集計
- `server/tools/import-databento.ts`、`databento-audit.ts`
- `server/test/databento-import.test.ts`、`databento-pilot-check.ts`、`databento-full-check.ts`、`databento-inventory.ts`、`databento-import-fixture.ts`
- `docs/DATABENTO_IMPORT_SPEC.md`

`docs/SPEC.md`には関連仕様への参照2行だけを追記した。replit.md、AGENT_RULES、既存の製品コード、設定・依存・デプロイ構成は変更していない。

仕様書SHA：
```
53944f5d124d4ec4ad9983e2291491f0b7ac0f7371db19a413fb4fb2189b683f  docs/SPEC.md
126b0b66cd73cba61cdd703288c6c1d35102d124ae7c0508d3f6f7902ff8e8b4  docs/DATABENTO_IMPORT_SPEC.md
```

実行した主要コマンド（Node 24の組込みzstdを使用。追加インストール不要）：
```sh
# 最初の小区間
node server/tools/import-databento.ts --zip=attached_assets/GLBX-20261030-NAXB9F53AX_1793358357163.zip --out=data/databento-import --base=data --from=2026-09-30T00:00:00Z --to=2026-09-30T00:05:00Z
node server/test/databento-pilot-check.ts
# 全購入範囲
node server/tools/import-databento.ts --zip=attached_assets/GLBX-20261030-NAXB9F53AX_1793358357163.zip --out=data/databento-import --base=data
# Workspace中断後：保存済み世代の全行を再照合して再利用
node server/tools/import-databento.ts --zip=attached_assets/GLBX-20261030-NAXB9F53AX_1793358357163.zip --out=data/databento-import --base=data --resume-generation=data/databento-import/generations/9d3cfb11-ae8d-4aeb-b679-f3ef7fea1125
node server/test/databento-full-check.ts
node server/test/databento-inventory.ts
# 隔離の実画面（確認終了後は停止済み）
node server/test/databento-import-fixture.ts --port=18801 --at=2026-10-01T14:35:00Z --contract=NQZ26
```

### 実行した試験・ビルド

- 関連VP／LONG VP／FOOTPRINT範囲／import群27件、日次指標／seam／import群8件が合格（import2件は重複）。最終import2件も合格。
- 十進価格・ns精度・B/A/N・スプレッド除外、正当な同内容別行、巻き戻り、区間外の元行／順序維持、中断時の原本保全、再実行、世代再利用を確認。
- server／frontendの型検査、toolsの追加strict型検査が合格。
- `pnpm --filter @workspace/receiver run build`成功（2.07秒）。既存フロントのbundle名は変わらず`index-DehSdgVL.js`。既存機能を再適用していない。
- ログ：`data/databento-import/`の`tests*.log`、`*typecheck*.log`、`build.log`、`full-check.json`、`inventory.json`、`idempotency-full.log`。

## 6. 終了確認・戻し方

- ブラウザのBrowser.close後、残った検証用ChromiumにはSIGTERMを使用。画面確認側の全記録PIDがESRCH、プロファイル残存0、WS接続0・一覧空を確認した。
- 通常プレビューの撮影はWorkspace再起動後のworkflow停止により失敗。追加で起動された撮影用Chromiumも終了し、親・子・crashpadの全記録PIDがESRCHになった。通常workflowを起動し直していない。
- 隔離サーバーPID708はESRCH、18801への接続は拒否。import lockなし、取り込み・検証サーバーの残存なし。詳細は`cleanup.json`、`browser/shutdown.json`。
- 通常データを変更していないため、本番／元ローカルデータの復元操作は不要。隔離表示を戻す場合だけ、保全済みの別世代の`import.json`を検証後、隔離`active.json`へ一時ファイル＋renameで参照変更する。原本・baseline・世代を削除しない。
- 本番への書込・Publish・本番受信再起動、新しい上流接続、購入操作はしていない。

## 7. 未取込・未確認と次の候補

- 10/26〜10/28の限月不明重複876,289行は保留。購入ステージには保全されているが、通常のNQとして既存行を上書きしていない。
- N38行／1,485枚を既存Trade型の指標へ含める対応は未実装。完全な出来高・VWAPとは報告しない。
- スプレッド、GC購入入力、取引所フィード自体の完全性、期近切替時刻、板の補修、実ライブ、本番への反映は未確認／対象外。
- 既存の公開高CPU・既存欠け・冷間初回947msが解決した証拠にはしない。
- 次に進む場合は、保留区間の限月照合と、購入履歴を含めた公開前レビュー／反映・復帰計画を別途行う。今回は実行せず停止する。
