# 専用FOOTPRINT初期版 実装報告

実施日：2026-10-30（日本時間）

## 1. 実施内容

同じアプリに **HEATMAP | FOOTPRINT | LONG VP** の3タブを実装した。FOOTPRINTは `?view=footprint` の専用Canvas画面。NQ／標準GC、5秒・15秒・30秒・1分、価格別sell／buy、OHLC、POC、出来高／デルタ、履歴状態、操作・独立カーソルまで接続した。集計コアだけの完了ではない。

既存の銘柄選択・時刻設定を共有し、閲覧位置・ズーム・追従は画面・銘柄別、足種はブラウザタブ内だけに保存する。既存のGC・十字カーソル・履歴鮮度・約定読取共有を維持した。

本番書込・Publish・契約変更・既存受信の再起動／停止・開発上流接続は行っていない。保存形式、保持期間、期限削除、板側の読取、依存、デプロイ構成は変更なし。

## 2. 変更ファイル・関数

| パス | 役割 |
| --- | --- |
| `artifacts/heatmap/src/footprint/model.ts` | `FootprintStore`：世代内の約定identity、秒×整数価格×限月の数量／先頭末尾、影響した足の再構築、POC、履歴置換、取得状態、時間・件数上限 |
| `artifacts/heatmap/src/footprint/client.ts` | `FootprintClient`：専用queryを付けた既存WS、可視範囲の逐次読取、旧socket／旧req拒否、世代・再接続、既存`HistoryFreshness`、明示再試行 |
| `artifacts/heatmap/src/footprint/app.ts`・`view.ts`・`footprint.css` | `mountFootprint`、整数価格の座標変換、Canvas本体・別cursor層、凡例、足種・限月選択、状態、パン／ピンチ／ズーム／追従／reset |
| `artifacts/heatmap/src/view-memory.ts` | `loadView`／`saveView`：画面×銘柄のタブ内閲覧状態 |
| `artifacts/heatmap/src/main.ts` | FOOTPRINT routeの遅延mount。HEATMAPの閲覧状態保存／復帰 |
| `artifacts/heatmap/src/long-vp/nav.ts`・`view-math.ts`・`app.ts` | 3タブ、専用route、LONG VPの独立閲覧状態。集計・価格調整・表示設定の計算は変更しない |
| `artifacts/heatmap/src/domain.ts`・`data/protocol.ts` | 正規化約定の任意`contract`を保持。他の既存フィールド・閾値は維持 |
| `server/src/hub/hub.ts` | `connect`／`footprintRange`：同じHubで専用配信。自動30分読取・板・VPを抑制、可視約定のchunk、世代と取得状況。通常クライアントは旧契約 |
| `server/src/pipeline.ts` | `readFootprintRange`／`ownsFootprintLive`：既存読取session、未flush tailとの現世代identity照合、取得前coverage、欠け／無約定、既存L境界によるRESTとliveの所有分離 |
| `server/src/index.ts`・`gc-runtime.ts` | NQ／GCの既存Hubへ約定専用読取を接続。上流・保存の接続は増やさない |
| `server/src/store/local.ts` | `tradeReadSession`：visitorの例外／中断を書込queue外で返し、閲覧中断でライブ保存queueを失敗状態にしない |
| `server/test/footprint.test.ts` | 配信抑制・可視要求・銘柄刻み・範囲制限・切断・tail／保存照合・L境界・中断後の保存継続 |
| `artifacts/heatmap/test/footprint.test.ts` | 数量・OHLC・POC・境界・全足種・履歴置換・限月・世代・容量・遅延応答・初回読取中の履歴完了 |
| `artifacts/heatmap/test/view-memory.test.ts` | storageを分けた画面／銘柄／sessionの隔離、同sessionの再読込、不正JSON・保存不可 |
| `server/test/footprint-fixture.ts` | 本番資源を使わないダミーの実HTTP／WS／画面確認サーバー |
| `server/test/footprint-benchmark.ts` | 固定入力・旧Hub／現Hub／FOOTPRINTの独立プロセス比較 |
| `docs/SPEC.md`・`UI_SPEC_HEATMAP.md`・`FOOTPRINT_SPEC.md` | 許可された関連箇所だけ変更、初期仕様を新規記録 |

### 整合性上の注意

- 同内容では除重しない。受信identityは現世代内だけで扱う。履歴のseqを現世代liveのseqと混ぜてsortせず、スナップショットの入力行順と未収録liveを維持する。
- 新しい世代は旧データ・pendingを破棄。同じ世代への再接続は取得済みを保持し、切断時間を未取得にする。
- Lより前は履歴側の所有。Lが決まる前の未flush tailをFOOTPRINT履歴へ混ぜず、L以降の未flush分はL決定後の読取に含める。異なる正規化のREST/liveを内容で推測除重しない。
- 初回read中のbackfill完了も、pending範囲の鮮度を失わずrangeDone後に一度だけ再確認する。毎秒の履歴pollではない。
- `coverage`は取得記録であって取引所の完全性保証ではない。`noData`の根拠は既存backfillの無約定記録。失敗や単なる未取得とは区別する。
- 最近の書込対象ファイルは既存のシリアライズ読取を維持。中断時はvisitor呼出を止めてstreamをdrainし、queue外で中断を返す。書込対象のgzipを強制破棄する変更ではない。

## 3. 確認手順

新しいサーバーコードを起動した環境で：

1. 共通ヘッダーからFOOTPRINTへ移動（`?view=footprint`）。銘柄をNQ／GC、足種を全4種類に切り替える。
2. 左sell／右buy、凡例、細いOHLC、POC枠、価格／時間軸、VOL／DELTA、限月と履歴状態を見る。
3. wheelで時間、価格軸wheel／drag・shift-wheelで価格をzoom、dragでpan、追従とresetを確認。縮小で数字を省略しても総量が消えないことを見る。
4. 本体hoverで座標ラベル、領域外・画面切替で消去。別画面から戻り、独立した閲覧位置／倍率／追従と足種を確認する。
5. orange等の未取得表示は0約定の意味ではない。再試行は既存保存を読み直し、追加REST取込を直接開始しない。

**今回、稼働中の既存受信プロセスを再起動していない。** 再ビルドだけでは、そのNodeプロセスが新しいWS handlerを読み直すわけではない。現在の公開版／旧実行プロセスでの新画面成功を確認したとはしない。反映操作は今回の範囲外。

隔離再現：

```sh
pnpm --filter @workspace/receiver run build
node server/test/footprint-fixture.ts --port=18777
# http://127.0.0.1:18777/?view=footprint&debug=1
# 終了時はこの検証PIDだけにSIGTERM
```

fixtureの画面とログには「ダミー／NO UPSTREAM」を表示する。実保存・API認証・App Storage・上流は使わない。

## 4. 実行した確認

### 4.1 試験・型検査

- 着手前：既存の約定集計・共有読取の関連18試験成功。
- `node --test --test-concurrency=1 server/test/*.test.ts`：189/189成功。
- `pnpm --filter @workspace/heatmap run test`：172/172成功。
- `pnpm run typecheck`：全workspace成功。
- `git diff --check`：成功。
- `pnpm --filter @workspace/receiver run build`：最終再ビルド成功（Vite 7.3.7、62 modules、1.56秒）。その後の全workspace型検査も成功。既存受信は再起動しない。

数量試験では価格別buy／sell、総量、delta、OHLC、POCの同数高価格、無約定の足なし、5秒12本＝同じ1分のbuy／sell、半開境界を照合。同内容別約定、時刻巻戻り、後着、繰り返し履歴置換、限月不明／既知の分離、generation更新も検査した。

### 4.2 実ブラウザ・画面証拠

ダミーの実HTTP／WSを通して確認し、主AgentもNQ・GC・LONG VPの画像を確認した。

| 項目 | 結果 |
| --- | --- |
| NQ 5秒・後着履歴 | 初回応答67約定→73約定。欠け5秒の回復と追加17枚buyを一度だけ反映。15可視足のセル、件数、OHLC、POC、volume、deltaを独立sourceと比較し不一致0 |
| 実画素の更新 | 同じpaused viewportを維持。Canvas pixel digest `321eb787`→`dc4eda07`。数値だけの検証ではない |
| 後着対象足 | 6約定、32枚、delta＋22。既存15枚に17枚buyを加算 |
| 再接続 | fixture世代1→2。73行の独立照合で不一致0。繰返す履歴で二重加算なし |
| 5秒12本と1分 | 同じ `[1793308440,1793308500)`、60約定、180枚、delta0。OHLC整数価格83999／84003／83997／84002、POC83999、価格別数量とも一致 |
| 操作 | 全4足種、UNKNOWN独立系列、数字／概要切替、時間・価格zoom、pan、追従・reset、時刻／価格cursorと領域外消去を確認 |
| 銘柄・他画面 | GC 5秒／1分、HEATMAPのcursor／pan、LONG VPのcursor／panを確認。LONG VPの不足13取引日はダミーfixtureの既知の警告 |
| 初期読取 | 可視区間の応答で表示。起動時の全2時間一括取得ではない |

描画時間の観測値：NQ 1分の平均0.8008ms／最大7.1ms、JS heap6,762,004 B。GC 5秒の平均0.987ms／最大4.9ms、heap3,891,017 B。5秒zoom操作を含むsampleは平均0.9743ms／最大5.5ms。**入力・viewport・累積回数が異なるsnapshotであり、5秒と1分の同条件Canvas比較とは扱わない。** Node集計の同条件比較は次節。

未確認を残す：nativeな非表示タブを環境で作れず、hidden pause／catchupを実操作では確認できなかった。seed用init scriptがreload／別tab試験へ干渉したため、その試行を成功扱いにしない。clean contextのNQ／5秒初期値は確認。GC／1分reload、画面別viewport復帰・別tabの完全な実ブラウザ比較、同条件の初期／更新／操作別Canvas計時は未確認。終了済みbrowserの再context作成が拒否され、これ以上の再試行はしていない。storage隔離・再読込相当・異常系は3単体試験で別途確認した。

証拠：

- `data/footprint-validation/browser-results.json`：数量・操作・pixel digest・未確認・API上の終了結果。
- Screenshot ID：前 `shjguj`、後着後 `f4kpj2`、再接続 `jsft8n`、NQ 5秒12本 `nfvkte`、同1分 `3t0ect`、GC 5秒 `8c261h`、GC 1分 `g39n4y`、HEATMAP `9jioq6`、LONG VP `32u5ex`。
- 上記IDの画像を取得ツールからファイルexportできず、FOOTPRINTの画像ファイルは保存されていない。主Agentが`f4kpj2`・`g39n4y`・`32u5ex`を表示確認した。
- 再ビルド後の既存HEATMAPの初期表示は `data/footprint-validation/heatmap-after-build.jpg` に保存。3タブとCONNECTEDを確認したが、upstream stopped／確定列待ちの画面であり、実データ表示成功の証明ではない。

### 4.3 固定入力・変更前後の負荷

上流・ネットワーク・実クラウドを使わない独立Nodeプロセス各3回。Node v24.22.1、同じNQ入力：履歴120秒12,000約定、続く20秒2,000約定、100約定/秒、板400＋400段。更新は仮想20秒を1秒刻みで進め、Hubの250ms flushを通す。測定wallは約0.1秒であり、実20秒間の常駐負荷やCPU使用率測定ではない。

`before`は着手時HEADを`/tmp/footprint-before`へread-only展開した旧Hub、`after`は現Hubの通常HEATMAP経路。FOOTPRINT 5秒／1分も同じ入力。各scopeは正常終了して接続を閉じる。

| 経路 | 本文合計B | 初期B | 更新B | 板frame数 | 履歴read回数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 変更前HEATMAP | 2,962,029 | 2,096,587 | 865,442 | 106 | 6 |
| 変更後HEATMAP | 2,962,029 | 2,096,587 | 865,442 | 106 | 6 |
| FOOTPRINT 5秒 | 1,552,016 | 1,328,374 | 223,642 | 0 | 1 |
| FOOTPRINT 1分 | 1,552,016 | 1,328,374 | 223,642 | 0 | 1 |

全12実行で14,000約定、27,999枚、buy14,000／sell13,999、delta＋1。全価格別数量のSHA-256：

`6dd29b6b542fecbd0626ea05aa07add27674ae5dd9e77f2224fff905a3ebb97d`

本文量は送信するJSON／binaryのB数で、**圧縮WSのwire量やHTTPヘッダー等を含めた通信実測ではない**。FOOTPRINTで小さいのは板を送らない・可視120秒だけ要求するためで、機能の異なる画面同士の比較。上流の通信は減らしていない。

各3回の中央値。RSS／heapは各回sample最大値の中央値。初期時間はHub初期読取・デコード・集計完了まで、更新時間は20回の入力・flush・可視集計まで。serverとクライアント集計を同一Nodeへ置き、Canvasは含めない。

| 経路 | CPU ms | wall ms | 初期 ms | 更新 ms | peak RSS B | peak heap B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 変更前HEATMAP | 134.713 | 104.285 | 62.708 | 40.585 | 140,402,688 | 27,464,904 |
| 変更後HEATMAP | 144.194 | 101.082 | 65.194 | 35.981 | 133,943,296 | 27,085,736 |
| FOOTPRINT 5秒 | 96.129 | 68.346 | 47.959 | 21.867 | 121,724,928 | 22,259,352 |
| FOOTPRINT 1分 | 93.629 | 74.086 | 47.485 | 25.043 | 121,929,728 | 22,197,384 |

短時間・少数回で、変更後HEATMAPのCPUは約7%高くwallは約3%短い。ばらつきやV8の影響を含み、改善／悪化を断定しない。実上流・長時間負荷の改善という結論は出さない。

全12実行の原結果：`data/footprint-validation/node-bench.json`。ブラウザfixture初期版の`bytes:0`はhookが呼ばれなかった未計測値であり、転送0の意味ではない。最終fixtureから誤解を招く項目を除去し、通信比較は本節の専用benchmarkだけを使用した。

再実行：

```sh
for mode in before after fp5 fp60; do
  for i in 1 2 3; do
    node --expose-gc server/test/footprint-benchmark.ts \
      --mode=$mode --baseline=/tmp/footprint-before/server/src/hub/hub.ts
  done
done
```

旧版は着手時のソースを使うこと。作業後のHEADをbeforeと呼び替えない。

### 4.4 時間・容量上限と解放

- 基礎約定キャッシュ：直近7200秒、最大300,000記録。超過時は古い秒から90%まで間欠evictし、破棄範囲を不完全として表示する。
- 取得中のrows＋concurrent liveも1要求300,000記録まで。超過は成功commitせず容量エラー／未取得として残す。永続約定を削除しない。
- 足cacheは選択中の足種だけ。足種変更で解放、時間外／遠い足を除去。異なる銘柄の基礎キャッシュは同時に累積させず、銘柄変更は旧document・socket・cursorを破棄する。
- 同じブラウザタブ内のviewportと足種は小さいsessionStorageだけに保持。サーバー設定保存項目は増やさない。
- 数字は片セル28px以上・行12px以上で表示。初期足幅92px／行16px、足幅5〜240px／行2〜30px。縮小はOHLC概要、数量は保持。POC枠1px。色比較に数量閾値・比率閾値はなし。
- データ本体描画は1000ms以上の間隔でまとめ、操作／cursorはrAF。非表示documentの描画を停止する。画面移動は専用mountだけを起動。
- 300,000記録・3000秒・600足のNode単独容量確認：GC後heap91,854,032 B（baselineとの差83,309,736 B）、RSS251,219,968 B（差163,971,072 B）。**120 B/記録等の単純計算をJS heap上限とはしない。** 一時rows・配列・Map・描画・V8を含めたブラウザRSSのハード上限ではない。GC・実機は別確認が必要。

### 4.5 終了確認

- 検証ブラウザのpages／contextsを閉じ、`browser.close()`後に`isConnected() === false`。fixtureのNQ／GC接続数は各0。
- API切断後も自分のChromium PID31409が残っていたため、専用profileと起動時刻を確認してこのPIDだけにSIGTERM。関連PID31411／31413／31416／31417／31460も消滅。
- 再ビルド確認の撮影で作られた自分のChromium PID36612も専用profileを照合してSIGTERM。関連PID36614／36616／36618／36619／36654／36655／36717／36759の消滅を確認。最終の`ps`でChrome／Chromiumプロセスなし。
- 自分のfixture PID31320はSIGTERMで終了。`fixture.stopped`ログ、PID消滅、18777接続拒否を確認。
- 既存受信PID9171は同じPID／親9170で生存。終了・再起動操作はしていない。
- OS終了結果：`data/footprint-validation/cleanup.json`。撮影API上の切断とOSプロセス消滅を別々に確認した。

## 5. 仕様との差分・制約

- 数量・状態・操作を実画面まで実装。変更した正本は関係箇所のみ。
- 足セルの非常に大きい数値はk/M表記等へ短縮する。縮小時の表示省略で集計数を削らない。
- 自動で欠けをRESTから追加取得する新jobは作らない。既存backfill／保存増加後の鮮度再検証・手動再試行を使う。
- 世代を越えたseqの永続性、厳密な秒内取引所順序、coverageによる市場完全性、未知限月の調整を主張しない。
- 高速な同期visitorが送信を積み上げた場合、待ちが16MiBを超えればその要求をエラーとして未取得のままにする。無制限に未送信データを保持しない。

## 6. 未確認・懸念

- 本番の実上流NQ／GC・実公開環境・実App Storageの通し検証はしていない。隔離の画素・数量・負荷は公開の高CPUや欠損解消の証明ではない。
- Safari／iPad実機、長時間、高密度市場入力時のCanvas・RSS、低速回線の大きな可視要求は未確認。
- 件数上限を超える広い範囲は不完全のまま表示する。全2時間が常に全件RAM保持される保証ではない。
- 実行中Nodeは再起動していないため、新handler反映もしていない。

### 6.1 仕様書SHA-256

```text
baf0a420d51914cda3e28d67d7ad1f4ad1160a34294895fa42c979ec774997df  docs/SPEC.md
5eb3a37a5e7d43cd465624f0033850ca6a7a210ce5175927f4bb1f93867bf6c0  docs/UI_SPEC_HEATMAP.md
43718204560ef3fa38a734a7ba3ae60237c5115a3ddaea87e099f8d564a27f8f  docs/FOOTPRINT_SPEC.md
```

## 7. 次のタスク候補

未確認の実ブラウザ条件の補完、および許可後の反映と実負荷確認。今回は実行せず、ここで区切る。

## 8. 残存確認の追記（2026-10-30、日本時間）

この追記で、上記の未確認項目のうち、非表示・復帰、別タブ／再読み込み、Canvas実描画比較、WSの版組合せを補完した。前回の全体合格結果は再利用し、機能を作り直していない。実ライブ・公開環境の検証済みを意味しない。

### 8.1 実施内容

- すべての市場入力は隔離fixture。127.0.0.1の18777～18781だけでサービスを起動し、TICK STREAM・本番DB・App Storageには接続していない。
- 実Chromium 140.0.7339.16をCDPで操作。別BrowserContextの窓を「非表示タブ」の代用にせず、同じ窓の別タブを前面化し、対象の実際の `document.hidden` がtrueになることを確認した。可視性を偽装するスクリプトは使っていない。
- 診断の読取り自体が足を再構築する問題だけを最小修正した。描画・集計コア・保存・WS製品仕様の変更はない。

### 8.2 変更ファイル

|ファイル|内容|
|---|---|
|`artifacts/heatmap/src/footprint/app.ts` / `mountFootprint()`|全量debug getter内の足構築をやめ、最後に描画した足への参照を返す。debug時だけ副作用のない `__footprintCounters` を公開し、終了時に削除する。|
|`server/test/footprint-fixture.ts`|手動入力、遅延応答、版別フロント／旧Hub、固定時計、TCP転送量、実Pipeline読取メソッドの無通信adapterを追加。製品の起動経路では使用しない。|
|`server/test/footprint-cdp.mjs`|所有ブラウザの起動、実タブ操作、viewport指定、PNG取得、終了確認。|
|`server/test/footprint-completion.mjs`|非表示、後着、画面切替、銘柄変更、遅延、再読み込み。未変更の合格ケースは再利用する。|
|`server/test/footprint-follow-check.mjs`|追従ONの非表示・復帰／画面切替、debug getterの非干渉確認。|
|`server/test/footprint-tab-change.mjs`|別タブで実際に5s→15s／1mボタンを操作し、両タブを再読み込み。|
|`server/test/footprint-measure-build.mjs`|旧／新の一時コピーへ同じ計測用初期viewport指定を入れてビルド。製品ソースには入れない。|
|`server/test/footprint-canvas-measure.mjs`|実Canvasを含むrAF、OS CPU・RSS、V8 heap、HTTP・WSの区間計測。|
|`server/test/footprint-ws-matrix.mjs`|実Pipeline→実Hub→ブラウザ、旧LONG VP、旧サーバーの非対応表示。|
|本報告書・`.agents/memory/footprint-decisions.md`|結果と、観測が集計を発生させない検証上の注意を追記。|

原因：従来の全量debug getterが、観測する際に足を生成していた。非表示中の再構築停止を調べる観測器として使うと、観測そのものがカウンターを増やす。最後の描画結果を返す方式にし、受信数／描画数／足構築数は専用の読取り専用getterで取得する。数量、銘柄、履歴統合、描画内容には手を入れていない。

### 8.3 確認手順と期待値

|項目|期待値|実測結果・証拠|
|---|---|---|
|ネイティブなバックグラウンド化|非表示中は描画・足構築が増えず、受信は継続|`hidden=true`。描画4→4、足構築30→30、約定69→72件。復帰後に描画5／足構築45。`acceptance.json` の `native-background`。|
|非表示中のライブ＋後着履歴|復帰で一度だけ反映し、価格セルも変わる|2約定×2枚＋後着1約定17枚を追加。対象足はVOL15→36、DELTA+1→+22、価格行に買い21枚が現れる。14本の数量を独立に再集計し不一致0。Canvas hash `2011d215`→`65d56c88`。前後PNGを目視確認。|
|閲覧位置・ズーム・追従OFF|復帰で保存値を維持|`endSec=1793340464`、`barW=92`、`rowH=16`、`centerPrice=84000`、`follow=false` が完全一致。|
|追従ON|追従を保って、復帰時は現在へ進む|非表示中は描画3→3、足構築9→9、約定0→1。復帰時もfollow=true、時刻端は10秒前進。幅／価格ズーム維持。画面切替後もfollow=true。`follow.json`。|
|全量debugの観測非干渉|読んでも足構築数が増えない|非表示中に全量getterを2回読んでも足構築数不変。|
|アプリ内の画面切替|旧画面の処理終了、共通入力継続、復帰で再読取|実装はCSS非表示ではなくdocument遷移。旧JS実行contextの破棄とFootprint getter消滅を確認。HEATMAP表示中もfixture入力4件を処理。戻ると保存viewport完全一致、74件を使う14本の照合で不一致0。|
|別タブの銘柄／足種|他タブに混ざらない|NQとGCを独立して開き、NQ→GC→NQの変更中も他方のGC／1mは維持。追加でUIボタンを操作し、NQを15s、GCを1mへ変更。両方を再読込後もNQ／15s、GC／1m。`tab-change.json`。|
|遅延応答|旧接続の応答を新銘柄に入れない|NQ要求を1600ms遅延させ、待機中にGCへ遷移。新画面の契約・価格行・数量はGCのみで、他方のGCタブも維持。`acceptance.json` の遅延receipt。|
|再読み込み|履歴二重加算・接続増殖なし|NQを2回reloadし、それぞれ72件／14本の独立数量照合で不一致0。2タブ時の接続数は各回2本。GC側も選択維持、882件を使う15本の照合で不一致0。|

画面切替とバックグラウンド化を同じものとして測っていない。画面リンクでは旧documentとその下流WSは終了し、移動先が自身の下流WSを開く。共通サーバーの市場収集・入力処理を止める操作はない。バックグラウンド化では、同じdocumentとWSが存続する。

初回NQはsessionStorageの銘柄キーが未保存でも仕様どおりNQとなる。キーに文字列NQが必ず存在することを期待する試験にはしていない。遅延NQ要求の破棄に伴う旧peerのinvalidRequests計数1は確認したが、新銘柄への数量混入や接続増殖として扱っていない。

### 8.4 Canvasの固定条件比較

#### 条件・測定範囲

- 比較元：`eabbe9011be1c86379b94123189b54f11785e212`。比較先：`9d07a120ce095a803cf301ee040e11e509ce52bf`＋今回の診断読取修正。
- Chromium 140、600×800 CSS px、DPR=1、NQ、固定120秒。同じ120約定（1件／秒、7価格、枚数1～5）、同じ120本の板列（各400買い＋400売り）をfixtureで用意。
- 固定表示区間はUnix秒 `[1793341500,1793341620)`。旧／新HEATMAPとも受信後の実際の開始位置・終了位置が同じことをassertした。
- FOOTPRINTも同じ区間。可視本数は5s=24本、1m=2本。取得・描画候補に含める範囲外の余白足は可視本数に数えていない。5sは縮小表示、1mは数量詳細表示。
- 各ケースで1回warmup後に別documentへ移り、アプリのメモリcacheが空の状態で初期表示を測る。エンジンはwarm。新旧の一時コピーに同じ初期viewport入力だけを追加し、初回hello後もその指定を復元した。製品ソース・保存形式・描画処理にはこの計測用入力を加えていない。
- 通常更新は1.1秒間隔で4約定（各2枚）を追加。全ケースとも受信数120→124をassert。操作は同じ位置で横ズーム入力4回（-70、+70、-70、+70）、間隔220ms。操作中の時間幅は変わり、各画面の幅上限もそのまま適用する。
- 初期表示区間は約1.32～1.43秒、更新約4.43秒、操作約0.91秒。原標本に実測時間を保存。
- 表の描画時間は、主Canvasへ実際にCanvas 2Dコマンドを発行するrAF callbackの時間。足の計算コアだけの測定ではなく、実描画を含むframe処理時間。Canvas命令の発行＋前処理を含み、GPU完了／画面presentの遅延ではない。補助Canvasだけを描くcallbackはこの平均に含めず、ブラウザ全体のCPU値には含める。
- CPUはブラウザ本体と子プロセスの `/proc` CPU tick差分（10ms粒度）。CPU%は1コア=100%。メモリはCDPのV8 heapと、所有ブラウザ全プロセスのRSS合計。RSSは共有ページを重複計上し得るため、実使用物理メモリやサーバー容量判断の値にはしない。
- HTTPはCDPのencoded bytes。WSはfixtureの実TCP socketの送受信byte差分（Upgrade／WS framing／圧縮後本体を含む、loopbackの非TLS）。解凍後payloadもJSONへ別記した。計測用のNode制御要求はブラウザ通信に含めない。
- 全測定区間でアプリWSは1本。他の検証ブラウザは動かしていない。既存受信への停止・制限・負荷入力はしていない。

|対象・区間|描画frame数|平均／最大 ms|ブラウザCPU ms（%）|V8 heap MiB|RSS合計 MiB|HTTP byte|WS送信／受信 byte|
|---|---:|---:|---:|---:|---:|---:|---:|
|旧HEATMAP 初期|5|7.78 / 27.30|310（21.7）|4.58|881.7|130647|17602 / 557|
|旧HEATMAP 更新|10|1.93 / 2.90|340（7.7）|4.33|951.6|0|5081 / 0|
|旧HEATMAP 操作|5|2.22 / 2.90|130（14.3）|5.25|954.6|0|296 / 0|
|新HEATMAP 初期|7|6.33 / 27.30|360（25.2）|4.74|880.1|131938|17602 / 557|
|新HEATMAP 更新|10|2.20 / 3.50|330（7.5）|4.60|946.9|0|4918 / 0|
|新HEATMAP 操作|5|2.42 / 4.20|80（8.8）|5.22|949.5|0|325 / 0|
|FOOTPRINT 5s 初期|2|6.50 / 11.30|140（10.6）|2.00|847.6|172624|2228 / 582|
|FOOTPRINT 5s 更新|4|0.98 / 1.40|120（2.7）|2.50|914.7|0|93 / 0|
|FOOTPRINT 5s 操作|4|1.02 / 1.20|20（2.2）|2.38|915.0|0|0 / 0|
|FOOTPRINT 1m 初期|3|4.57 / 10.10|140（10.6）|2.34|852.6|172624|2628 / 644|
|FOOTPRINT 1m 更新|4|0.90 / 1.10|110（2.5）|2.32|916.0|0|102 / 0|
|FOOTPRINT 1m 操作|4|0.87 / 1.00|40（4.4）|2.69|916.0|0|72 / 122|

短期1回の比較であり、「性能改善」や統計的に有意な「回帰なし」とは結論しない。新HEATMAPは更新平均+0.27ms、操作平均+0.20ms、初期CPU+50msで、同時に別指標は低下している。公開環境の高CPU・既存欠け・長時間のメモリ問題が解決したという結果でもない。

### 8.5 WSの変更理由・実経路

今回 `hub.ts`・`pipeline.ts` の製品コードは変更していない。FOOTPRINT実装で変更した理由を、上の比較元との差分で確認した。

- `hub.ts`：`view=footprint` を識別し、板／VP／従来の初期板履歴を送らない。足の数量計算に必要な正規化前提の個別約定を送り、`hello.generation` で同一／別世代を区別する。既存 `range` 要求から約定専用読取を使い、batch上限・送信待ち上限・切断時のAbortを適用する。view未指定の旧画面の経路は残す。
- `pipeline.ts` / `readFootprintRange()`：保存済み約定を既存の読取sessionで走査し、未flush分を受信識別子で重複除去して補う。coverage・欠け・確認済み無約定を付け、時刻終了だけで完全性を保証しない。`ownsFootprintLive()` はL境界で履歴／ライブを区切る。
- `storage/local.ts`：読取visitorの中断が既存の書込queueを失敗状態にしないようにする。板や他クライアントの読取を壊さないための変更。

|組合せ|実測結果|証拠・制限|
|---|---|---|
|新フロント＋新Hub＋実Pipeline読取|NQ／GCとも接続・履歴・ライブ・後着統合を独立照合し合格|18780の実WS。実 `Pipeline.readFootprintRange()`／`ownsFootprintLive()` をそのまま呼び、永続I/Oのみメモリadapter。読取5回・close5回。Pipeline constructor／上流接続は実行していない。|
|旧フロント＋新サーバー HEATMAP|120板列・120約定を描画し、更新後124約定|Canvas比較のbeforeケース。blankを成功としたのではなく、実描画カウンター・入力件数・PNGを確認。|
|旧フロント＋新サーバー LONG VP|日次VP、価格ライン、VA、週CVDのダミー1日分を表示|`old-front-longvp.png`。debugの価格域と実PNGを確認。欠けた9取引日の表示はそのまま残す。|
|新フロント＋旧Hub FOOTPRINT|非対応。合格扱いしない|旧Hubの実コードを別portで実行。世代情報のないhelloを `invalid_hello` として拒否し、close 1008。画面にERROR／「取得エラー: invalid_hello」が出る。|

FOOTPRINTを利用する反映ではフロントbundleだけでなく、対応するHub、Pipeline、Sourceの接続部分、読取sessionの変更を含むサーバーが必要。旧サーバー相手には自動再接続も起こり得るため、その構成を常用しない。旧サーバーへ接続した空画面を「データなしで正常」とは扱わない。今回は公開・再Publish・既存受信の再起動はしていない。

### 8.6 実行した確認・証拠

前回の全体試験（サーバー189件、フロント172件）の合格結果は再利用。製品の診断getter変更後、関係する `footprint.test.ts`（前後）と `view-memory.test.ts` の計22件を再実行し、22合格・失敗0。

```
node --test artifacts/heatmap/test/footprint.test.ts artifacts/heatmap/test/view-memory.test.ts server/test/footprint.test.ts
pnpm run typecheck
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver run build
```

全workspace型検査、追加fixtureのサーバー型検査、最終製品ビルドはすべて成功。ビルド成果物は `artifacts/heatmap/dist/public/`。計測用一時bundleは `/tmp/` 側であり製品成果物と区別する。

証拠は `data/footprint-completion/`：

- `acceptance.json`、`follow.json`、`tab-change.json`、`ws-matrix.json`。
- `canvas-measure.json`：主Canvas描画frameの全標本、実時間、CPU原値、heap/RSS、通信前後値、表示区間、入力数、所有ブラウザ終了結果。
- `background-before.png`／`background-after.png`：対象足の数量・価格セルの前後差。
- `canvas-before.png`／`canvas-after.png`／`canvas-fp5.png`／`canvas-fp60.png`：比較時の実描画。
- `pipeline-NQ.png`／`pipeline-GC.png`、`gc-reload.png`、`tab-gc-1m.png`。
- `old-front-longvp.png`、`old-server-incompatible.png`：互換表示と明示エラー。
- `cleanup-before.json`／`cleanup.json`：停止前の接続0、所有サーバーPID、停止後のPID・port・Chromium残存、既存プロセス生存。

試験ハーネスの修正は、初回NQの未保存キーを誤って不合格にしないこと、古くなった固定テープに最新足を要求しないこと、旧版helloによる表示位置の上書きも含めて実表示区間をassertすること、PNGが1px高にならないよう実viewportを指定すること。これらを製品不具合の修正として数えていない。成功済みの未変更ケースを段階的に再利用している。

### 8.7 仕様との差分・未確認・終了

- 新しい仕様決定はない。保護された仕様書、設定、依存、デプロイ構成は変更していない。
- 実ライブ、実際のSDK／REST／App Storageを含む統合、公開環境、長時間負荷、実機iPad Safariは今回未確認。隔離のダミー入力による結果に限定する。
- 検証用の全ブラウザは終了APIの結果だけでなく、所有PIDの終了とローカルのChrome／Chromiumプロセス残存0を確認した。検証WSは停止前に全portで0。
- 終了対象はfixtureのPID29128、29161、34055、35535、36400（途中の計測用旧PID31591も終了済み）。15:44:57 JST時点で各PID消滅、18777～18781がすべてECONNREFUSED、Chrome／Chromium残存0を確認した。事前から稼働していた7PID（174、176、268、415、28134、28181、28182）はすべて生存し、停止／再起動を行っていない。
- 上流の追加接続、実市場への入力、本番書込、公開、再Publishは行っていない。測定用の外部接続制限も新設していない。
- 次の作業は開始しない。実ライブの独立照合や実機Safari確認は、別の許可された作業として扱う。
