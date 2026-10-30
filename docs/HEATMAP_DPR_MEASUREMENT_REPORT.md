# HEATMAP DPR追加測定（コード変更なし）

2026-10-31。測定版HEAD：`512133b4555c416a8f190ef3aefa9b2a36685b36`。製品コード・テストコード・設定・distは変更していない。既存の修正を承認された状態で測定のみ実施。以下の実装案は未実装・公開判断はユーザーが行う。

## 条件と実行方法

前回と同じ実製品dist／実Receiver→Hub→WS→Canvas。新しい自前fixture／Chromeを条件ごとに使用し、互いに／ビルドと同時実行しない。1280×800 CSS、前景1タブ、glow・時間平均／価格自動、初期1796列×80明示価格、1800秒表示、色上限200／下限off／gamma1。250msに1約定、毎秒1板、約15秒＋500ms drain。全条件61件・183枚を入力、server最終233枚、browser窓内62約定。上流なし・dummy設定I/O。実行時刻に移動する合成入力で、実ライブではない。

既存`server/test/smoothing-live-check.ts`をメモリ上で読み、**/tmpの測定用コピーだけ**にNQ DPR2／3の選択、GC専用CPU sampling、測定終了時のHub0確認を指定した。GCのみブラウザ内でCanvasのnative呼出を同じ引数・戻り値のまま時間計測するwrapperを付けた。ディスク上の製品・検証コードには書き戻していない。CPU profilerのsampling intervalは200µs。通常NQ測定にこの追加計測は入れていない。

```sh
node /tmp/smoothing-dpr-measure.mts --out=data/heatmap-smoothing/dpr-measure-nq
node /tmp/smoothing-dpr-measure.mts --profile --out=data/heatmap-smoothing/dpr-measure-gc-profile
```

一時runnerの控え：`data/heatmap-smoothing/dpr-measure-runner.txt`。元の製品JSは`artifacts/heatmap/dist/public/assets/index-BGeOK7vE.js`。今回はコードを変えていないため、既存180試験・型検査・build結果は再利用し、再ビルドしていない。

## 1. NQ DPR2／3

| 指標 | NQ DPR2 | NQ DPR3 |
|---|---:|---:|
| 実測時間（drain等含む）秒 | 15.59 | 16.35 |
| Canvas depth更新数 | 32 | 13 |
| **Canvas更新p95 ms** | **57.0** | **1329.9** |
| Canvas更新最大ms | 86.3 | 1329.9 |
| 最新描画バッチ数 | 61 | 21 |
| **受信→最新描画p95 ms** | **11.0** | **93.2** |
| 受信→最新描画最大ms | 51.7 | 176.4 |
| **Chromeプロセス群CPU秒** | **6.59** | **20.17** |

CPUはChrome親子のCPU時間の合算で、1コアの使用率ではない。DPR3では並行スレッドを含むためwall秒を上回り得る。Canvasは測定前snapshot以降のdepth=trueフレーム。latestは実描画バッチごとの指標で、各約定の独立した遅延ではない。

**DPR3の注意**：既存helperの「最新描画サンプル30以上」の条件が21バッチで未達になり、runnerは`invalid_measurement_conditions`／終了コード1を記録した。これを合格へ書き換えていない。一方、実document.hidden=false、接続1、入力61件、server233枚・browser62件・終了は確認できており、データ未達ではなく高負荷時のまとめ描画でサンプルが減っている。数値はその21バッチ／13 Canvas更新の参考p95。安定したp95推定、全約定の100ms保証とは扱わない。

DPR3の最終`recomputedColumns=2766`、cacheは50,324,856B（約48MiB上限）。DPR2の約40.8MiBの表示working setを同じCSS範囲でDPR3へ増やすと、画素比例分は約2.25倍になる。ソースでは1列追加ごとに48MiBを超えるとLRU先頭を追い出すため、**1画面分が上限に収まらず、次の読取も全missする循環**と整合する。これは前回の追従キー不一致とは別の容量問題。DPR3の重さを未解消として残す。今回、容量上限は変更していない。

## 2. GC DPR2の内訳

### 元の90.7msフレームに残っている実測値

既存`follow-fix-after/real-ws.json`のGC depthフレーム31件を並べたp95の**同じ1フレーム**：

| 層・記録項目 | ms |
|---|---:|
| HEATMAP背景全体 | **90.7** |
| └ tile同期 | 0.3 |
| └ 既存名`aggregationMs` | **90.4** |
| 現在板 | 0.6 |
| その他 | 0.1 |
| フレーム全体 | **91.4** |

このフレームでは約定／VP／DELTAの独立描画時間は記録上0。別のフレームでは更新されている。priceAxisMsは平均化経路で個別タイマーがないので、0を「価格軸の実処理なし」と解釈しない。日次VWAP／CVD等は主にotherMsへ入る。

**重要**：`HeatmapRenderer.draw`の平均化経路の`aggregationMs`は平均計算だけではない。fill、`SmoothingRaster.frame`全体、ImageData生成、putImageData、必要時の価格軸描画まで含む。rasterMs／colorMs／uploadMsの0も「負荷0」の意味ではなく未分離。従って元の90.7msを後から厳密に平均化・ぼかし・転送へ割り戻すことはできない。

### 同条件の追加プロファイルによる分離

追加GC DPR2は31 depthフレーム、Canvas p95 **51.2ms**、最大52.0ms、受信→latest p95 14.6ms、CPU7.97秒／15.59秒。これは**計測負荷を含む別run**であり、以前の90.7msを再現した同一フレームではない。負荷変動・格子位相・JIT等が異なり得るので、90.7へ比例配分したり性能改善と扱ったりしない。

この新しいp95フレーム（全体51.7ms）の内訳：

| 処理・層 | 値 | 測定の意味 |
|---|---:|---|
| 時間平均・価格投影 | 当該フレームでは独立サンプルなし | 0msという意味ではない。depth31フレーム合計で約1.3msのCPU sampling、平均約0.043ms/回 |
| ぼかし`verticalBlur` | **約0.6ms** | 同一フレームのCPU sampling推定 |
| キャッシュ照合・フェード／色変換・RGBA配列作成／全画素組立 | **約44.2ms** | `SmoothingRaster.frame`配下の残りのCPU sampling。これらの内部同士は未分離 |
| HEATMAP `putImageData` | **1.1ms** | native callの同期wall実測。GPU表示完了や通信時間ではない |
| HEATMAP fill | 0.1ms | native callの同期wall実測 |
| tile同期 | 0.2ms | 既存タイマー |
| 残りの準備・ImageData生成・GC等 | 数ms | CPUサンプルとwallの残差。GC単独は約0.9msのサンプル |
| HEATMAP背景全体 | **51.2ms** | 既存の実Canvasタイマー |
| 現在板／その他 | 0.3／0.2ms | 同じフレーム |
| 全体 | **51.7ms** | 同じフレーム |

CPUサンプルは200µs間隔で関数スタックへ帰属させた推定値で、厳密な各呼出タイマーや加算可能な別々のp95ではない。JSの色変換・画像組立と、native画像転送を分けている。minified bundleのframe内部は細粒度タイマーがないため、色変換と全画素コピーをそれぞれ正確に何msとは断定しない。

追加runの全表示フレーム（depth更新がないフレームも含む）の各層p95／最大：

- 現在板1.3／1.8ms、約定1.5／5.6ms、VP0.5／1.8ms、DELTA0.2／0.7ms、その他1.9／2.3ms。
- 分布と実行フレームが違うため、これらのp95を足して51.7msへ合わせない。depth=trueのp95を、非depthフレーム込みの小さいp95へ置き換えて説明しない。

## 3. DPR2で33ms以下を目指す案（すべて未実装）

**優先は平均化やぼかしを弱めることではなく、再利用済みの色列から毎回全画素を作り直す処理の削減。** GCの1枚は1844×1154＝約213万画素、RGBA約8.1MiB。列集約がhitしても現在は全体バッファを新規作成し、列方向のループで全画素を再配置する。

| 案 | 効果の見込み・限界 | 影響範囲・注意 |
|---|---|---|
| ① 継続RGBA／背景Canvasを保持し、追従はscroll＋dirty列と装飾周辺だけ更新 | 主対象は上の約44.2ms。仮に半分削減なら51.2→約29ms、7割なら約20msという**条件付き試算**。実測保証ではない。元の90.7から33には57.7ms削減が必要であり、今回だけで達成を保証しない | `SmoothingRaster.frame`と`HeatmapRenderer.draw`。欠損マスク、フェード／glowの近傍、eaten cut、後着修正のdirty範囲が必要。色基準・mode・zoom・resize変更は全更新へ戻す。元数量・平均式・見た目を変えない第一候補 |
| ② ImageData／RGBAを再利用し、コピー順序・配置を改善 | 新規配列とGC、全画素組立の一部が対象。今回はGC約0.9msのサンプル、その他の生成費は未分離。**単独で33msへ到達する根拠はない**。①との効果は重なるので加算しない | 同じ表示2関数。行順連続書込等は実機で比較が必要。全取得／部分取得、色の同一性、キャッシュ総量の回帰確認が必要 |
| ③ 板背景だけ実効DPRを1～1.5に制限し、軸・文字・操作は端末DPR2のまま | DPR1なら画素比例部分は約1/4、1.5なら約56%。大きい削減余地はあるが33msの実測予測値はまだない | 表示品質と平滑化の物理画素定義が変わるため**別途仕様承認が必要**。保存・指標計算は維持できるが、透過・glow・拡大表示の品質を確認する必要がある |

- ぼかしの約0.6msやnative転送約1.1msだけを削っても33msには届かない。見た目を弱めるだけの修正は優先しない。
- cache上限の引上げはDPR3の全missを抑える可能性があるが、ブラウザRAM増と交換。DPR2は表示working setが既に上限内なので、**DPR2の33ms対策として単純な上限増量は推奨しない**。
- 33msが「背景だけ」か「全レイヤー込み」かは分ける。後者には現在板・約定・VWAP／CVD等の別予算も必要。
- ①を実装する場合でも、通常runでの同条件p95、全画素一致、dirty範囲、遅延応答・後着、非表示復帰を再確認する必要がある。今回は案の提示で停止し、実装しない。

## 証拠・終了・変更なしの確認

- `data/heatmap-smoothing/dpr-measure-nq/real-ws.json`：NQ2／3の生値。DPR3のhelperエラーもそのまま保持。
- `data/heatmap-smoothing/dpr-measure-gc-profile/real-ws.json`、`GC-dpr2.cpuprofile`、`breakdown.json`：GCの生値・CPUサンプル・対応フレーム別の内訳。
- 各runnerのfinallyでBrowser.close、Chrome親PID消滅・9233閉鎖を確認。**Chromeを閉じた後のfixture Hubは全条件NQ0／GC0**。続いて自前fixtureのみSIGTERM、PID消滅を確認。
- 最終確認でもChrome28006／28191／28459、追加撮影Chrome29151と子PIDは全ESRCH。**検証Chromium残存0、18812／18814／18815／9233／9234すべて閉鎖**。`data/heatmap-smoothing/dpr-measure-cleanup.json`。
- 通常workspace撮影は上流stoppedの待機表示で、測定用実板の結果とは別。既存受信・管理workflowには停止／再起動操作をしていない。
- 本番書込・公開・再Publish・上流追加接続なし。コード・設定・仕様の変更なし。変更はこの測定報告と知見メモ、測定出力のみ。
