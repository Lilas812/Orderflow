# 比較検証用データセット v2.1 実装・実データpilot報告

## 報告

### 実施内容

独立CLI、保存元の読み取り監査、37列のX、1秒履歴、主観注釈、方向非依存Y、
時間分割チェック、新規11ファイルZIP、受入試験、NQ/GCの実データpilotまで実施した。
v1本体・API・ZIP・マーク保存・CAS・列の意味・仕様書は変更していない。
モデル学習、売買判定、自動正解化、画像生成、新規マークUI、依存追加は行っていない。

HEAD：`bdeeaf6643d2076fb80a4528ba91beadb26b551d`。
実装は新規・未コミットのresearch-v2ファイルで、HEAD単体には含まれない。
実行したソース一式のSHA-256はZIPの`manifest.code.sourceHash`へ記録した。
最終値：`9ad46968fff9e709154fe9dee98615f00062d029193a211cfbdb319af929fd29`。
本番書込・Publish・既存受信の再起動/停止・上流追加接続・GitHub送信はしていない。

### 変更ファイル

- `server/src/research-v2/model.ts`：v1型と独立したas_of・可用性・設定。
- `engine.ts`：参照価格、過去37特徴、1秒履歴、方向非依存の結果。公開APIにTurningLabelを渡さない。
- `snapshot.ts`：既存の`LocalStore.labelHourInput`を読取専用で使用。入力コピーと原本hash照合。
- `splits.ts`：複数foldとtrain結果の評価判断区間への侵入を検出。
- `export.ts`：注釈との後結合、標本dedup、CSV/品質/manifest。
- `zip.ts`：v1 ZIPのallowlistを変えない独立ZIP32 writer。
- `cli.ts`：新規・非公開出力、nice19、取消と所有一時領域の回収。
- `audit.ts`：既存取込索引・coverage・注釈窓の棚卸し。月全体の原本は再展開しない。
- `server/test/research-v2.test.ts`：新規受入試験。
- `server/research-v2/{README.md,pilot.json,verify-pilot.mjs,inspect-pilot.mjs}`：手順、固定pilot条件、再現/取消と別計算による照合。
- 本報告と、研究の目的に関するAgentメモリ。

`docs/AGENT_RULES.md`、`docs/SPEC.md`、`docs/UI_SPEC_HEATMAP.md`、`replit.md`、
既存labels・store・history・aggregateには差分なし。既存作業をreset/再適用していない。

### 保存元監査

詳細：`data/research-v2/audit-final.json`。AGENTS.mdは見つからず、正本ルールと関連仕様、
v1のfeatures/reader/export/input/zip/columns、保存元と履歴処理、既存試験・報告を参照した。

|保存元|NQ|GC|今回の扱い|
|---|---:|---:|---|
|製品のローカル`data/`相当|tick/book coverageとも0区間|同0区間|**本番にデータがないとの意味ではない**|
|以前取得した公開データのローカルコピー|tick 15,433 / book 1,391区間|tick 5,450 / book 1,900区間|現在のクラウドではない。別版として監査のみ|
|購入データの隔離generation|4限月|21限月|既存active/rebuilt/coverage索引を再利用|
|pilot対象|NQZ26、22 CTセッション|GCZ26、23 CTセッション|途中の最初/最後のセッションを完全日としない|
|pilot対象の採用済み索引件数|9,229,328件|2,009,413件|月全体を今回再走査した値ではない|
|同、方向不明の枚数|0枚|26,698枚|GC全21限月の索引合計は51,364枚|

購入原本ZIPは両方読み取り可能。原本索引のSHA-256は以下。
**今回は参照していない巨大原本ZIP全体の再ハッシュ/再展開は行っていない。**

- NQ：`20240f85041fb719e0a512929fd7242ba82e08ef1388bbdb119a3155408b5985`
- GC：`4a26cd04d2e895e5e0bfc1c56daa298d8ecb7e7f241053923b716b5a93d6c2c0`

購入元索引ではNQZ26のNは1,476枚だが、既存採用generationのNは0枚。
v2は既存取込を補修せず、採用版と原本の全量一致を主張しない。
NQのCTセッション全体のcoverage欠けも残し、VP等を完全値にしない。
全期間のUNKNOWN/MIXED件数は索引にないため未算出と明示し、pilot実走査では両方0件。
現在の本番App Storageの完全な棚卸し・hydrateは実行していない。

既存NQ/GC注釈スナップショット各5件は、coverage索引上は30分過去＋15分結果の窓を満たす。
ただし**前回の隔離UI試験用マーク**で、本人の実判断の収集済み教師ラベルではない。
索引上の窓適合は、板・初期価格・全特徴が利用できる証明でもない。

### 時刻・情報混入の境界

- `Trade.tsUs`はイベント時刻。`Receiver.receive`から`Receiver.trade`へ渡す受信時刻、
  履歴decodeで`recvUs=tsUs`とする値、購入CSVのvendor `ts_recv`を同じ証拠と扱わない。
- `ColumnAggregator`は次秒やexpire等で確定させるが、保存Columnは
  tsSec/source/bids/asksだけ。限月、実到着、実確定時刻を保存していない。
- legacy adapterはこれらからlocal arrival/finalizationを捏造しない。
  `event_time_research`はイベント時刻の探索研究用。後着・履歴・改訂が当時利用できた保証はない。
- `arrival_verified`は各レコード・板・coverageに明示的な到着/確定の根拠があるものだけ。
  同じ入力で実行したstrict pilotは有効0標本。この制限を理由に研究用pilotを中止しなかった。
- as_ofとマーク時刻・クリック価格・createdUs・実判断時刻を分離。
  legacyマークは`legacy_event_anchor`、実判断時刻はnull。futureSecondsでも実判断時刻を推定しない。
- referenceはas_of**未満**の最新実約定、選択限月、連続coverageを要求。年限不明を接続しない。
  読取範囲は現在セッションと過去系列の早い側から。そこにも参照約定がなければnull。
- Xは主観方向・クリック価格を使わず、吸収はbuy/sell両側、距離はreference基準。
  セッションVPにNを含め、方向量には配分しない。未来の板・約定を入れない。
- Yは各`[as_of,as_of+H)`の端点変化・上方向最大幅・下方向最大幅。
  完全な既知無約定だけ前値を使える。欠け・限月混在・参照不明は理由付きnull。
- 実OHLCと既知無約定の持越し価格を別列にし、欠損をゼロにしない。
  資料上の保有期間の最適性や、同時刻の別約定を重複として除く処理は導入しない。

### 確認手順

詳細は`server/research-v2/README.md`。出力先は新しい名前を指定する。

```sh
nice -n 19 node --max-old-space-size=256 server/src/research-v2/audit.ts \
  --out data/research-v2/audit-new.json
node --max-old-space-size=256 server/src/research-v2/cli.ts \
  --config server/research-v2/pilot.json --out data/research-v2/pilot-new
unzip -t data/research-v2/pilot-new/dataset/dataset-v2.zip
node --max-old-space-size=256 --test server/test/research-v2.test.ts
node --max-old-space-size=256 --test server/test/labels.test.ts
pnpm --filter @workspace/receiver run typecheck
```

### 実行した確認

#### 自動試験

新規10試験、既存v1 labels 14試験とも合格。server型検査合格。
CLIはNodeのTypeScript実行で実走査済み。製品フロントを変更しておらず、
ブラウザ/Canvas/アプリ再ビルドや実上流測定は今回行っていない。

- 完成したv2のXについて、数量・RV・セッション・VP・板・両側吸収・CVD傾き/乖離を
  非nullの手計算期待値で照合。NがPOCを動かす例、乖離=1の非ゼロ例も確認。
- kind/expectedDirection/confidence/note/クリック価格/viewMode/futureSeconds等を変更しても、
  完成出力features/historyのhash、参照価格が不変。
- as_of以降の価格・枚数・板・限月を変更してもX/history/reference不変、Yだけ変化。
- 同秒内の未来、半開区間端、巻き戻るイベント、同内容の正当な別約定、Nの扱いを確認。
- late arrival、recvUsだけの偽昇格、coverage確定証拠なし、板の限月なしを検出。
- CT17、秋DSTの25時間、未知限月、欠損/既知ゼロ、参照なし、短い結果期間を確認。
- 明示・グリッド・2注釈を同じas_ofで標本1件へ統合。グリッド幅の暗黙指定なし。
- 複数foldとtrain Yの評価判断区間への侵入を検出。testの過去窓の重なりは誤除外しない。
- ZIP CRC、11エントリ、CSV列数・ID参照、formula注入対策、整数us、再出力一致を確認。
- 正常・取消・壊れた入力例外で所有一時領域を回収。取消時に他ジョブ模擬sentinelを消さない。

#### 実データpilot

最終出力：`data/research-v2/pilot-final-01/dataset/dataset-v2.zip`。
再出力：`data/research-v2/pilot-final-02/dataset/dataset-v2.zip`。
4標本、注釈2件、過去系列7,200行、Y12行（3期限×4）、結果coverage適合12/12。
2つのsymbol/session groupだが、暦上は**同じ1取引セッション**だけで、独立4日ではない。

|銘柄/限月|as_of UTC|参照tick|参照の古さ(us)|過去30分 件数|買い枚数|売り枚数|N枚数|非null X|
|---|---|---:|---:|---:|---:|---:|---:|---:|
|NQ/NQZ26|2026-10-29 17:52:00|117926|227504|16398|11660|11597|0|27/37|
|NQ/NQZ26|2026-10-29 18:19:40|117900|4853|17099|12994|12063|0|27/37|
|GC/GCZ26|2026-10-29 17:52:00|40212|1835126|2185|1505|1466|33|31/37|
|GC/GCZ26|2026-10-29 18:24:39|40188|2940870|1654|1237|1068|24|32/37|

原本時間ファイル4本を別のgzip/JSON走査で再計算し、全7,200秒の件数・買い/売り/N枚数・
実OHLC、参照価格/時刻、全12結果の端点/上下幅/観測終了を照合、一致。
証拠：`data/research-v2/independent-quantity-check.json`。
この別計算の照合対象CSVは最終版のものともhashが一致する。
44入力ファイル（NQ22/GC22、coverageを含む）はコピー前後・終了時のhash一致。
別計算で読んだ4本もmanifestのhashと一致。入力を更新していない。

欠損は埋めていない：

- 両銘柄ともpilot対象に板レコード0件。板関連5特徴はnull。
  別の公開コピーの板や未知限月の板を任意に接続しなかった。
- NQはセッション全体のcoverage欠けにより高安・POC・VAH・VAL距離の5特徴もnull。
- 最初のGC標本は過去窓の先頭に持越せる初期実価格がなく、30分RVをnullのままにした。
  これは取得済みの無約定秒をゼロ価格とすることでも、板欠損でもない。
- strict出力：`data/research-v2/pilot-strict-01/dataset/`。
  2要求、到着/確定を検証できた標本0、結果completeも0。時計由来の特徴だけが残り得る。
- 全期間の人間判断時点を復元できず、split未設定・評価不能。UI試験マークを正解としない。

#### 再現性・資源・終了

最終2出力のCSV/JSON等のcontent hashとZIP全体SHA-256が一致。
同一入力/注釈/config/codeで、生成時刻や一時パスを含めない。

- content hash：
  `576ca42d53eb1e98f24b208629dff154c5a7039c28b7291f04bf4eef42a08359`
- ZIP SHA-256（1,049,004 bytes）：
  `f5b4864ff1bff91520958f6ab1398dad6eaa9d70ed20783f736814c63bf031cb`
- manifestは自己参照を避け、manifest以外の10同梱ファイルのhashからcontent hashを計算。
  入力hash、コードhash、allowlist等はmanifestへ別途記録する。

|実行|経過秒|user CPU秒|system CPU秒|peak RSS MiB|
|---|---:|---:|---:|---:|
|最終pilot 1|23.53|5.68|12.15|182.75|
|最終pilot 2|19.28|5.46|11.82|176.76|
|strict確認|11.16|2.99|6.95|147.15|

これは隔離CLIの値で、本番や画面の負荷改善の測定ではない。
strict確認後の変更はauditの関数説明文だけで、特徴/可用性判定の処理は変更していない。
CLIはnice19/heap256MiB、ストリーム読取。セッションVP価格上限10万、
CVDイベント上限10万、窓/グリッド上限を明記。全月rawをRAMへ載せない。
SIGKILL/OSのOOM強制終了後の自動回収までは保証していない。

取消実走査はPID1214、SIGTERM→終了コード1・`v2_cancelled`を確認。
専用working領域だけが消え、別ジョブ模擬sentinelが残ることを確認した。
その他自身のCLI PID956/1122/1185/1492/1525も`ps`で消滅を確認した。
`.v2-working-*`と試験用/tmpディレクトリの残存は0件。
他ジョブ模擬sentinelは保全確認後、試験ハーネス自身の所有物として回収した。
検証用サーバー・ブラウザ・WSは起動していない。既存workflow/受信は操作していない。
証拠：各run-metrics、`data/research-v2/pilot-verification.json`、テスト出力。
出力ディレクトリ700、ZIP600。`data/`はGit・デプロイ除外対象。

### 仕様との差分

v1正本を改訂せず、今回指示に基づく独立v2の説明書を追加した。
最小v2で採用したXは37列。v1の前セッション距離、件数z、最大個別サイズ、
スイープ/推定取消は未採用としてquality/READMEに明示し、v1から削除していない。
後から全期間分位・最適幅・対照マッチ・反転ラベルを黙って追加しない。

### 未解決・懸念

当時のarrival/finalization、現在クラウド全量、本人の判断時刻/ラベル、
pilotの板、NQセッション欠け、GC初期価格、固定splitと独立評価期間が不足する。
4標本のpilotは形式・境界・数量の検証で、学習データ充足、反転予測、
リアルタイム再現、収益性を示さない。CPU/RSS上限に近づく大規模格子は未測定。

### 次の候補（提案のみ、実装しない）

まず「本人の天底の見方」「客観的反転」「売買結果」を別の目的として定義し、
本人ラベルと十分な独立セッション、固定時間分割/侵入除外を確保する。
同じ標本・同じfoldで、集約特徴と1秒時系列を、線形・GBDT・TabPFN等で比較する。
画像を試す場合も同じas_of/標本/foldへ限定し、未来描画や注釈表示を混ぜない。
補完・標準化・分位・対照マッチ・モデル選定はtrainだけでfitする。
どの入力・モデル・バリア/ZigZagが最良かは先に決めない。
今回はその比較・訓練・取引実行には進んでいない。
