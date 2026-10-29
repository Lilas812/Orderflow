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
