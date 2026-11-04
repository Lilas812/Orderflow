# Orderflow 比較検証用データセット v2.1（独立CLI）

v1のAPI・マーク保存・3ファイルZIP・列の意味・CASに変更を加えない。
稼働receiverへ接続せず、ローカルの閉じた時間ファイルを読み取り専用でコピーする。
元ファイルの保存・復元・coverage更新・REST・上流WS・App Storage書込を行わない。

## 再実行

プロジェクト直下から、既存依存だけで実行する。`data/`はGit・デプロイの除外対象。
出力先は既存datasetのない新規名を使う。データを自動取得・購入する機能はない。

```sh
nice -n 19 node --max-old-space-size=256 server/src/research-v2/audit.ts \
  --out data/research-v2/audit-new.json
node --max-old-space-size=256 server/src/research-v2/cli.ts \
  --config server/research-v2/pilot.json --out data/research-v2/pilot-new
unzip -t data/research-v2/pilot-new/dataset/dataset-v2.zip
```

`pilot.json`は現在残る隔離取込generationへの明示参照であり、どの環境にも存在する
データと保証するものではない。パス・読み取り可能性は最初にauditで確認する。
付属するNQ/GCの注釈は前回の**UI試験用**で、本人の売買判断や教師の正解ではない。
新しいマークを採るには`annotationFile`と選択する`annotationIds`を指定する。
当時の実判断時刻は不明のまま、`event_us=tsSec*1000000`を研究用as_ofにする。

取消はCLIのPIDへSIGTERM/SIGINT。実行中のそのジョブ専用`.v2-working-*`だけを消し、
成功したdataset・別ジョブの出力・入力原本を消さない。生成日時やCPU/RSSはZIPに
入れない`run-metrics.json`へ分離。CLI自身をnice19にし、上記コマンドでheapを制限する。

## 設定と出力

- `lookbackSeconds`：初期1800、1秒の相対区間。サブ秒のas_ofも整数usで扱う。
- `horizonsSeconds`：初期60/300/900、半開区間の結果。最適期限・売買ルールではない。
- `maxDivergenceEvents`：10分の正確な時刻/sequenceソートの上限。超過はCVD乖離だけ欠損。
- 過去系列/結果期限の実装上限は各86400秒、グリッド/アンカー上限は1 sourceにつき10000点。
  価格別VPの上限は100000価格。上限を越えた場合は黙って間引かず失敗する。
- 明示`asOfUs`と注釈を同じ経路へ通す。任意の固定グリッドは
  `"grid":{"fromUs":"...","toUs":"...","stepUs":"..."}`を明記する。最適幅は自動設定しない。
- `calculation.mode`は`event_time_research`または`arrival_verified`。
  後者はローカル到着・集計確定・coverage確定の明示的証拠を必要とする。
  **現行CLIのlegacy adapterはその証拠を供給しない。** `recvUs`が小さいことだけで昇格しない。
- `splits`は初期null＝未設定・評価不能。設定例は
  `[{"fold":"train","fromUs":"...","toUs":"..."},{"fold":"test","fromUs":"...","toUs":"..."}]`。
  境界は索引監査後に利用者が固定する。全期間分位・補完・正規化・対照マッチはしない。
  同一標本の複数fold、train結果の評価判断区間への侵入は検出・除外理由へ記録。
  同foldの重なりやtestの過去特徴窓がtrainに及ぶこと自体はエラーにしない。
- 同じsymbol/contract/as_of/計算条件は標本を一つにし、複数注釈は別表で参照。
  同一symbol/contractに複数の入力版を与える設定は、任意の先勝ちを避けるため拒否する。
- samples/features/history/annotations/targets/splitsとmanifest/quality/columns/README/configを分離。
  featuresの明示allowlist以外を一括学習入力にしない。マーク未設定は負例ではない。
  futureSecondsは本人が過去に未来を見たかの証明ではない。
- referenceは選択限月のas_of未満の最新実約定。coverage欠けをまたがない。
  読取は現在セッションと過去系列範囲を対象にし、その範囲にも基準実約定がなければnull。
- 生約定・板配列・認証・ダウンロードURLはZIPに同梱しない。
  1秒OHLCは実約定だけ。既知無約定の数量0と、欠損nullを区別し、
  価格持越しは`carried_close/carried`へ分ける。
- CSVのnullは空欄。ID/us列は十進文字列として読み込む。Excel等の自動数値変換では
  16桁usが丸められるため、列型を文字列に指定する（CSV自体に浮動小数変換を加えない）。

## v2.1検証後の修正と、再実行できる照合

arrival_verifiedの証拠がない約定は、当時未到着だと断定せず、その1秒を
`coverage_mask=0`とする。数量/実OHLC/依存する特徴や参照をnullにし、
`missing_reason`を残す。証拠付きで締切後に到着/確定した約定は別計数して除外できる。

窓前の最新実約定を同限月・連続coverage・可用性で検証できれば、先頭の無約定秒の
終値だけへ初期値として持ち越す。実OHLCは作らない。`samples.csv`の
`history_initial_price_used/history_initial_price_ticks/history_initial_price_ts`と
`history.csv`の`carried_from_pre_window`に利用・由来を残す。
通常の読取で初期値が見つからない場合だけ、連続したcoverage内を1時間ずつ逆方向に
ストリーム探索する。欠損や未知限月を越えて古い値を拾い直さない。

照合対象は明示引数にする。従来のpilot-event等を暗黙に選ばない。生成済みのdatasetを
変更せず、証拠JSONは`wx`で新規作成するため、再実行時は`--out`だけ別名にできる。
inspectはdataset自身のconfigを使用する。下記の`NEW1/NEW2`は新しい出力名に置き換える。

```sh
node --max-old-space-size=256 server/src/research-v2/cli.ts \
  --config server/research-v2/pilot.json --out data/research-v2/NEW1
node --max-old-space-size=256 server/src/research-v2/cli.ts \
  --config server/research-v2/pilot.json --out data/research-v2/NEW2
node server/research-v2/verify-pilot.mjs \
  --first data/research-v2/NEW1/dataset --second data/research-v2/NEW2/dataset \
  --out data/research-v2/NEW-evidence/verify-01.json
node server/research-v2/inspect-pilot.mjs \
  --dataset data/research-v2/NEW1/dataset --out data/research-v2/NEW-evidence/inspect-01.json
node server/research-v2/compare-pilot.mjs \
  --before data/research-v2/pilot-final-01/dataset --after data/research-v2/NEW1/dataset \
  --out data/research-v2/NEW-evidence/diff-01.json
```

verifyは同じ入力・注釈・コードでのcontent_hashと各payload hashを照合し、ZIPはCRCだけ検査する。
コミット記録で変わるZIP全体SHA-256を、修正前後の再現性比較には使わない。
式の説明更新でsample_idも変わるので、前後比較はsymbol/contract/as_ofをキーにする。

採用特徴の式・単位はZIPのcolumns.md、列別欠損理由はquality.jsonに記録する。
VP/POC/VAはNも含むセッションのas_of未満だけ。吸収の買い・売り代理を両方計算し、
距離・近傍板の原点はreferenceへ統一。手動ラベル・クリック価格でX/Yを切り替えない。
前セッション距離・件数z・最大個別サイズ・スイープ・推定取消は今回の最小v2で未採用
（v1には残す）。板の限月・確定時刻が不明なら、その特徴をnullにする。

v2を使うモデル訓練・反転の自動正解化・利益/リアルタイム再現の保証は今回行わない。
戻す場合は新規`server/src/research-v2/`、`server/research-v2/`、
`server/test/research-v2.test.ts`と説明・隔離出力だけが対象。既存v1や原本を戻す必要はない。
