# v2.1 検証指摘の修正報告

## 報告

- 実施内容：到着根拠の不明と根拠付き後着を分離。RVの初期値を実約定から補完。照合ツールを引数化し、別出力先でpilotを2回生成した。
- 変更ファイル：下記のv2専用ファイル、試験、README、本報告だけ。v1、製品の受信・保存・公開設定は変更していない。
- 確認手順：根拠あり後着／根拠なしの試験、RV手計算と時間境界試験、全server試験、原本からの独立再計算、旧pilotとの差分、同入力・同コードの再現性照合。
- 実行した確認：v2専用12/12、型検査合格。server全体348件中347合格・1失敗。詳細は後述。
- 仕様との差分：v2.1の不明値・初期価格の解釈を今回の指示に合わせ修正。v1や正本仕様の置換はない。
- 未解決・懸念：LONG VPの既存経路の試験が1件失敗。修正していない。実購入データにはローカル到着・確定の証拠がなく、今回のpilotは引き続きevent_time_researchである。
- 次の候補：既存LONG VPの競合試験の切り分け、将来の到着証拠の記録方法の検討。本タスクでは実施しない。

## 1. 実行したコードと対象

実行時HEAD：`91e6605b6fb6be80584a4bd411577d958f90f0f2`＋本修正の作業差分。
生成器のコード識別値：

```text
777082732c8d3344db35fd33fb13b1ec5931e1c1673e14c27a126ad69e457daa
```

対象設定は既存の`server/research-v2/pilot.json`。既存の
`data/research-v2/pilot-final-01/dataset`と`pilot-final-02/dataset`を基準とし、
これらのファイル、既存の照合JSON・報告書は上書きしていない。

新出力：

- `data/research-v2/v21-fix-01/dataset`
- `data/research-v2/v21-fix-02/dataset`
- 新しい照合証拠：`data/research-v2/v21-fix-evidence/`

どちらも4標本・注釈2件・history 7,200行・targets 12行（完了12件）。
注釈は従来どおり隔離UI試験由来であり、実際の裁量判断のラベルとは扱わない。
学習・v1置換・本番データへの反映は行っていない。

## 2. 修正内容と試験

### 到着根拠

`server/src/research-v2/model.ts`の`hasAvailabilityEvidence/eligible`と
`engine.ts`の`SampleBuilder.accept/finish`で以下を区別する。

|状態|処理|
|---|---|
|有効な到着・確定証拠があり、締切後の到着または確定|当時未採用の約定として除外。これだけを理由に既知の秒を不明にはしない|
|証拠がない／証拠の形式が無効|当該秒のcoverage_maskを0にし、数量・OHLC・持越終値をnull。依存する窓のXや参照もnull|

後者はhistoryの`missing_reason`、参照の`reference_reason`に
`trade_arrival_or_finalization_evidence_missing`を記録する。
品質監査では`unverifiedPast`と`verifiedLatePast`を別計数する。
各特徴の欠損理由とhistoryの根拠を合わせて追跡できる。
より後の検証済み参照など、不明秒に依存しない値まで一律nullにはしない。

修正したstrict試験は、60秒中の根拠付き後着1件なら`buy_60s=59`・当該秒mask=1、
根拠なし1件なら`buy_60s=null`・当該秒mask=0を確認する。
最後の秒が根拠不明なら参照もnull。全約定の証拠がない場合も、0枚とは出さない。
vendorのrecvUsだけを到着証拠に昇格させない。

### RVの初期価格

同限月、as_of未満、初期価格から窓までのcoverageが連続し、モードの可用性条件を満たす
最新の実約定を初期価格にする。欠損・限月違い・根拠不明・締切後の初期値は使わない。

`snapshot.ts`の`Snapshot.feed`は通常の読取で候補がない場合だけ、連続coverage内の
直前の時間ファイルを1本ずつ逆方向にストリーム読取する。旧形式の根拠なしデータを
strictのために遡って救済することはない。通常の参照と同じく欠損を越えて持ち越さない。

- samplesに`history_initial_price_used/history_initial_price_ticks/history_initial_price_ts`を追加。
- historyに`carried_from_pre_window/missing_reason`を追加。
- 初期値はcarried_closeにだけ使い、実約定のない秒の実OHLC・数量は作らない。
- RVは従来どおり窓内の1秒区間終値の差の二乗和平方根（ticks）。
  窓外の価格から先頭の実約定への追加リターンを、別途1個足す変更ではない。

手計算試験：窓前価格98、先頭3秒は無約定、その後100一定ならRV30=√(0+0+4)=2。
初期値の由来、先頭3秒の持越、実OHLCなしを確認した。
欠損／限月違い／不明到着／締切後では従来どおりRV=null。
実読取経路でも直前の21時ファイルから22時の窓への初期化を確認し、原本ハッシュは不変。

### 照合ツール

- `verify-pilot.mjs`：`--first/--second/--out`を必須化。完了済みの指定datasetだけを読み、勝手に生成や取消試験を始めない。同じsourceHash・入力・注釈・payload hash・content_hashを照合。ZIPはCRC検査のみで、ZIP全体SHAは比較しない。commit識別子は記録するが一致条件にしない。
- `inspect-pilot.mjs`：`--dataset/--out`を必須化。指定dataset自身のconfigで原本をストリーム読取し、数量・OHLC・参照・持越終値・RV30・全targetsを独立照合する。初期値・参照・履歴／targetのcoverageと原本ハッシュも確認する。event_time_research専用で、legacyの証拠を補ってstrict検証したとは扱わない。
- `compare-pilot.mjs`：前後の標本を銘柄・限月・as_ofで結び、CSVごとの変更列・行数・値の例を記録。
- `csv.mjs`：引用符・CSV内改行を扱う読取ヘルパー。
- 証拠JSONは全て`wx`作成。既存のverify-02.jsonを指定した再実行はEEXISTで拒否され、既存の証拠ハッシュも不変だった。別の出力名での再実行は合格した。

## 3. 実pilotの標本別差分

日付は全て2026-10-29、時刻はUTC。RVの単位はticks。

|銘柄・限月|as_of|RV30 修正前|RV30 修正後|実際に変わった内容|
|---|---|---:|---:|---|
|NQ / NQZ26|17:52:00|214.24051904343398|214.24051904343398|市場数値の変更なし、初期値利用0|
|NQ / NQZ26|18:19:40|209.55906088737848|209.55906088737848|市場数値の変更なし、初期値利用0|
|GC / GCZ26|17:52:00|null|69.61321713582845|初期値利用1、先頭3秒のcarried_closeを40332へ、carriedを0→1へ。XはRV30だけ変更|
|GC / GCZ26|18:24:39|56.859475903318|56.859475903318|市場数値の変更なし、初期値利用0|

GC 17:52標本の初期値：
`tsUs=1793294514701643`（17:21:54.701643 UTC）、価格40332 ticks。
窓の先頭は17:22:00で、17:22:00～17:22:02の3秒が新たに持越終値を持つ。
これらは実約定として増やしていない。nonnull Xは31/37から32/37になった。

全標本に新しい初期値メタデータ3列とhistoryの2列が追加された。
式・初期化規則の識別値を更新したためsample_idとその参照列は全標本で変わる。
これは数量や標本の追加ではない。比較ツールはこのIDを前後結合キーにしない。

既存列では上表以外のX、historyの数量・実OHLC・mask、参照、Yの数値に変更なし。
注釈内容も変更なし。独立した原本再計算の結果：

|標本|過去30分の約定件数|買い枚数|売り枚数|N枚数|
|---|---:|---:|---:|---:|
|NQ 17:52|16,398|11,660|11,597|0|
|NQ 18:19:40|17,099|12,994|12,063|0|
|GC 17:52|2,185|1,505|1,466|33|
|GC 18:24:39|1,654|1,237|1,068|24|

## 4. 再現性と証拠

新しい2出力のcontent_hashは完全一致：

```text
7d6b30a093bf67578360c162e61873a3e5297e9431eb785e3a18f521d4d672af
```

入力・注釈・実行コード識別値、全payloadファイルのハッシュを照合した。
commit記録を含むZIP全体のSHA-256は再現性の比較対象にしていない。
修正前後でも凍結した入力ファイル情報は一致した。
旧pilot-final-01/02も引数化したツールで検証し、従来のcontent_hashのまま合格した。

新しい証拠ディレクトリ内：

- `verify-01.json/verify-02.json`：修正版の再現性確認。後者はcommitをpayload一致条件から除外する最終版ツールの結果。
- `baseline-verify.json`：旧pilot-finalの保全と照合。
- `inspect-01.json`：独立した数量・価格・RV・Y照合。
- `diff-01.json`：6つのCSVの標本別変更列と例。
- `output-guard.json`：既存証拠の上書き拒否。
- `process-cleanup.json`：自分の検証プロセスの終了確認。

実行コマンド（生成先・証拠名は存在するものを再利用せず、新しい名前にする）：

```sh
node --max-old-space-size=256 --test server/test/research-v2.test.ts
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver test
node --max-old-space-size=256 server/src/research-v2/cli.ts --config server/research-v2/pilot.json --out data/research-v2/v21-fix-01
node --max-old-space-size=256 server/src/research-v2/cli.ts --config server/research-v2/pilot.json --out data/research-v2/v21-fix-02
node server/research-v2/verify-pilot.mjs --first data/research-v2/v21-fix-01/dataset --second data/research-v2/v21-fix-02/dataset --out data/research-v2/v21-fix-evidence/verify-02.json
node server/research-v2/inspect-pilot.mjs --dataset data/research-v2/v21-fix-01/dataset --out data/research-v2/v21-fix-evidence/inspect-01.json
node server/research-v2/compare-pilot.mjs --before data/research-v2/pilot-final-01/dataset --after data/research-v2/v21-fix-01/dataset --out data/research-v2/v21-fix-evidence/diff-01.json
```

## 5. server全体の結果と未解決

`pnpm --filter @workspace/receiver test`：
**348件中347合格、1失敗、cancelled/skip/todo=0、14.227秒、exit 1**。
全ログは`data/research-v2/server-test-v21-fix.log`。

失敗：

```text
server/test/long-vp-app.test.ts:442
ダミー：REST待ちの間にライブ保存が済んでも衝突せず、既存行を置換しない
Error: vp_insert_existing_rows_in_missing_range
    at server/src/store/local.ts:540:23
```

この試験・LocalStore・LONG VP・起動処理はbdeeaf6から差分なし。
この既存経路の原因確定・修正は今回行っていない。
別環境で失敗したという`startup-process.test.ts`のready/cancel/corruptの3件は
Replitではすべて合格した。
v2専用12件は全体実行でも合格、型検査も合格している。

## 6. 変更範囲・終了確認

製品コードの変更は`server/src/research-v2/{model,engine,snapshot,export}.ts`だけ。
関連ファイルは`server/test/research-v2.test.ts`、
`server/research-v2/{README.md,verify-pilot.mjs,inspect-pilot.mjs,compare-pilot.mjs,csv.mjs}`、
本報告書。

購入原本・既存生成データ・v1・公開設定・既存稼働サーバーは変更していない。
依存追加・学習・Publish・上流接続追加・管理ワークフローの再起動はなし。
新出力と証拠はprivateなdata/research-v2以下でGit対象外。

自分の生成CLI PID 3196/3229は両方ESRCH（消滅）を確認した。
自分のstartup試験サーバー／research CLIに該当する残存プロセスは0。
一時snapshot残存なしは生成器の終了結果でも確認した。
今回はブラウザを起動していないため、閉じる対象のブラウザは0。
既存の稼働サーバーや他者のブラウザは停止していない。
