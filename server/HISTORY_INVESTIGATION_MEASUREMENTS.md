# 後取得履歴・CPU測定の数値付録

ダミー隔離入力。生成元: server/tools/history-investigation/summarize.ts。
時刻はUnix秒・範囲は半開区間。drawは実mainのdepthコールバックがrenderer.drawへ渡した列で、画素検証ではない。
全生記録: data/history-investigation-20261029/。JSON/CPU profile/heap profileはGit・デプロイ除外先。

## 初期値

main.ts SHA-256: 18c0f26cc315a441b7c49a3f1ba2e1533cb12c53fc4c9f23fadc9a01bfa712af

初回範囲: [1793275200,1793277000)、既知A=1793276710 (size101)、B=1793276990 (size102)。
後保存a=1793276720 (size201)、b=1793276980 (size202)、各400段×両側。
初回A/Bは各1段×両側。初回空応答ケースのみA/Bなし。追加板は全ケース同じ2列。
初期の既知2列を最終300秒chunkに同居させ、初期ロード中のcoverage変化と後保存時の鮮度を分離した。

## 必須ケースの完了時

要求欄は初回reqId0以外の明示range。受信列は重複既知列を含む。描画追加は新しいIDのみ。

|ケース|初回列数|初回明示range|追加保存|完了後range範囲/回数|受信列数|draw入力追加数/時刻|画面内追加数/時刻|
|---|---:|---|---:|---|---:|---|---|
|follow-transition|2|なし|2|[1793276911,1793276991)/1|2|1/1793276980|1/1793276980|
|browse-transition|2|[1793277000,1793277020)|2|なし/0|0|0/なし|0/なし|
|first-status-complete|2|なし|2|なし/0|0|0/なし|0/なし|
|offscreen-gap|2|なし|2|[1793276920,1793276991)/1|2|1/1793276980|1/1793276980|
|initial-empty|0|[1793277000,1793277020)|2|[1793276920,1793277020)/1|1|1/1793276980|1/1793276980|

## 全ケース・独立回復試験

各回復操作は初期状態から独立したrun。回復前はpan→zoomで古い空白を表示。
同じrunの回復済みcacheを後続の回復証拠として使っていない。
各初回はreqId0で[1793275200,1793277000)を6chunkで読む。
recvはkind2列数（既知列を含む）。draw/可視は全対象時刻。
JSON bytesはhello/status/rangeTrades/rangeDone等、binary bytesはkind2アプリpayload。WSヘッダーは含まない。

|ケース/独立回復|操作|要求範囲|要求回数|受信列|binary / JSON bytes|draw入力時刻|可視時刻|
|---|---|---|---:|---:|---:|---|---|
|follow-transition/follow-reset|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|follow-transition/follow-reset|complete|[1793276911,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|follow-transition/follow-reset|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/follow-reset|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/follow-reset|follow-reset|[1793274105,1793276991)|1|4|12958 / 545|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720,1793276980,1793276990|
|follow-transition/reconnect|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|follow-transition/reconnect|complete|[1793276911,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|follow-transition/reconnect|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/reconnect|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/reconnect|reconnect|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|follow-transition/reload|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|follow-transition/reload|complete|[1793276911,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|follow-transition/reload|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/reload|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/reload|reload|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|follow-transition/candidate-pan-refresh|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|follow-transition/candidate-pan-refresh|complete|[1793276911,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|follow-transition/candidate-pan-refresh|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/candidate-pan-refresh|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|follow-transition/candidate-pan-refresh|candidate-pan-refresh|[1793276700,1793276750)|1|2|6443 / 148|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|browse-transition/follow-reset|initial|[1793277000,1793277020)|1|2|113 / 752|1793276710,1793276990|1793276990|
|browse-transition/follow-reset|complete|なし|0|0|0 / 72|1793276710,1793276990|1793276990|
|browse-transition/follow-reset|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/follow-reset|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/follow-reset|follow-reset|[1793274105,1793276991)|1|4|12958 / 545|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720,1793276980,1793276990|
|browse-transition/reconnect|initial|[1793277000,1793277020)|1|2|113 / 752|1793276710,1793276990|1793276990|
|browse-transition/reconnect|complete|なし|0|0|0 / 72|1793276710,1793276990|1793276990|
|browse-transition/reconnect|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/reconnect|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/reconnect|reconnect|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|browse-transition/reload|initial|[1793277000,1793277020)|1|2|113 / 752|1793276710,1793276990|1793276990|
|browse-transition/reload|complete|なし|0|0|0 / 72|1793276710,1793276990|1793276990|
|browse-transition/reload|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/reload|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/reload|reload|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|browse-transition/candidate-pan-refresh|initial|[1793277000,1793277020)|1|2|113 / 752|1793276710,1793276990|1793276990|
|browse-transition/candidate-pan-refresh|complete|なし|0|0|0 / 72|1793276710,1793276990|1793276990|
|browse-transition/candidate-pan-refresh|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/candidate-pan-refresh|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|browse-transition/candidate-pan-refresh|candidate-pan-refresh|[1793276700,1793276750)|1|2|6443 / 148|1793276710,1793276720,1793276990|1793276710,1793276720|
|first-status-complete/follow-reset|initial|なし|0|2|104 / 605|1793276710,1793276990|1793276990|
|first-status-complete/follow-reset|complete|なし|0|0|0 / 0|1793276710,1793276990|1793276990|
|first-status-complete/follow-reset|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/follow-reset|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/follow-reset|follow-reset|[1793274105,1793276991)|1|4|12958 / 545|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720,1793276980,1793276990|
|first-status-complete/reconnect|initial|なし|0|2|104 / 605|1793276710,1793276990|1793276990|
|first-status-complete/reconnect|complete|なし|0|0|0 / 0|1793276710,1793276990|1793276990|
|first-status-complete/reconnect|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/reconnect|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/reconnect|reconnect|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|first-status-complete/reload|initial|なし|0|2|104 / 605|1793276710,1793276990|1793276990|
|first-status-complete/reload|complete|なし|0|0|0 / 0|1793276710,1793276990|1793276990|
|first-status-complete/reload|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/reload|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/reload|reload|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|first-status-complete/candidate-pan-refresh|initial|なし|0|2|104 / 605|1793276710,1793276990|1793276990|
|first-status-complete/candidate-pan-refresh|complete|なし|0|0|0 / 0|1793276710,1793276990|1793276990|
|first-status-complete/candidate-pan-refresh|pan|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/candidate-pan-refresh|zoom|なし|0|0|0 / 0|1793276710,1793276990|1793276710|
|first-status-complete/candidate-pan-refresh|candidate-pan-refresh|[1793276700,1793276750)|1|2|6443 / 148|1793276710,1793276720,1793276990|1793276710,1793276720|
|offscreen-gap/follow-reset|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|offscreen-gap/follow-reset|complete|[1793276920,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|offscreen-gap/follow-reset|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/follow-reset|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/follow-reset|follow-reset|[1793274105,1793276991)|1|4|12958 / 545|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720,1793276980,1793276990|
|offscreen-gap/reconnect|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|offscreen-gap/reconnect|complete|[1793276920,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|offscreen-gap/reconnect|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/reconnect|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/reconnect|reconnect|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|offscreen-gap/reload|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|offscreen-gap/reload|complete|[1793276920,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|offscreen-gap/reload|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/reload|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/reload|reload|なし|0|4|12922 / 605|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|offscreen-gap/candidate-pan-refresh|initial|なし|0|2|104 / 604|1793276710,1793276990|1793276990|
|offscreen-gap/candidate-pan-refresh|complete|[1793276920,1793276991)|1|2|6443 / 220|1793276710,1793276980,1793276990|1793276980,1793276990|
|offscreen-gap/candidate-pan-refresh|pan|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/candidate-pan-refresh|zoom|なし|0|0|0 / 0|1793276710,1793276980,1793276990|1793276710|
|offscreen-gap/candidate-pan-refresh|candidate-pan-refresh|[1793276700,1793276750)|1|2|6443 / 148|1793276710,1793276720,1793276980,1793276990|1793276710,1793276720|
|initial-empty/follow-reset|initial|[1793277000,1793277020)|1|0|63 / 715|なし|なし|
|initial-empty/follow-reset|complete|[1793276920,1793277020)|1|1|6418 / 220|1793276980|1793276980|
|initial-empty/follow-reset|pan|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/follow-reset|zoom|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/follow-reset|follow-reset|[1793274090,1793276981)|1|2|12908 / 545|1793276720,1793276980|1793276720,1793276980|
|initial-empty/reconnect|initial|[1793277000,1793277020)|1|0|63 / 715|なし|なし|
|initial-empty/reconnect|complete|[1793276920,1793277020)|1|1|6418 / 220|1793276980|1793276980|
|initial-empty/reconnect|pan|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/reconnect|zoom|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/reconnect|reconnect|なし|0|2|12872 / 605|1793276720,1793276980|1793276720|
|initial-empty/reload|initial|[1793277000,1793277020)|1|0|63 / 715|なし|なし|
|initial-empty/reload|complete|[1793276920,1793277020)|1|1|6418 / 220|1793276980|1793276980|
|initial-empty/reload|pan|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/reload|zoom|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/reload|reload|なし|0|2|12872 / 605|1793276720,1793276980|1793276720|
|initial-empty/candidate-pan-refresh|initial|[1793277000,1793277020)|1|0|63 / 715|なし|なし|
|initial-empty/candidate-pan-refresh|complete|[1793276920,1793277020)|1|1|6418 / 220|1793276980|1793276980|
|initial-empty/candidate-pan-refresh|pan|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/candidate-pan-refresh|zoom|なし|0|0|0 / 0|1793276980|なし|
|initial-empty/candidate-pan-refresh|candidate-pan-refresh|[1793276700,1793276750)|1|1|6418 / 148|1793276720,1793276980|1793276720|

## 提案だけの可視50秒再検証の負荷

同じ初期・保存・pan/zoom条件に対して、既存refreshVisibleRangeを試験ハーネスから1回呼んだ比較。
製品へ条件追加はしていない。ベースラインzoomの追加要求/返却bytesは全ケース0。
独立deflate列はフレームごとにdeflateRawした参考値で、状態引継ぎWS圧縮の実転送量ではない。
read CPUは同じプロセスの当該await区間であり厳密な工程専用CPUではない。

|ケース|追加要求|要求秒数/重複既取得秒数|返却列/既知重複列|binary/JSON bytes増|独立deflate binary bytes|read wall/共有CPU ms|
|---|---:|---|---|---:|---:|---:|
|follow-transition|1|50/50|2/1|6443/148|1299|0.65/0.66|
|browse-transition|1|50/50|2/1|6443/148|1299|0.56/0.59|
|first-status-complete|1|50/50|2/1|6443/148|1301|3.07/5.56|
|offscreen-gap|1|50/50|2/1|6443/148|1299|0.65/0.57|
|initial-empty|1|50/50|1/0|6418/148|1283|0.58/0.57|

## CPU・loop（各行は独立Node）

6 batches、2 warmup、予定26.5秒。onは既存MemoryMonitor(HeapProfiler含む)、
controlのみCPU samplingなし。他行はinspector CPU samplingあり。
CPUはその試行Node全体（V8/background/計測含む）。cores=CPU秒/wall秒。
GCはPerformanceObserver通知分、RSS最大にはfixture生成とwarmupも含む。

|試行|wall秒|CPU ms|cores|入力rows/s(板)|batch ms min–max|loop p50/p95/p99/max ms|timer遅れmax ms|GC 回/ms|最大RSS MiB|
|---|---:|---:|---:|---:|---|---|---:|---|---:|
|combined-off-1|26.53|2639.79|0.0995|43421.62|88.57–284.71|10.01/11.03/11.67/294.39 |284.17|19/82.72|323.82|
|combined-off-1-control|26.53|944.11|0.0356|43422.88|69.96–240.60|10.15/10.31/11.63/243.27 |233.16|19/57.05|324.59|
|combined-off-2|26.53|2542.13|0.0958|43414.89|83.60–380.21|9.95/11.01/11.10/385.09 |380.25|19/68.74|329.16|
|combined-off-2-control|26.53|1291.08|0.0487|43421.19|78.81–280.42|10.15/10.36/12.08/301.73 |291.64|19/111.63|325.15|
|combined-on-1|26.56|2417.15|0.0910|43379.06|73.78–121.10|9.98/11.03/11.45/123.34 |113.35|22/92.37|322.58|
|combined-on-2|26.56|2831.59|0.1066|43372.61|85.50–253.28|9.99/11.03/11.95/256.25 |246.16|22/129.50|329.30|
|decode-off-1|26.53|2396.68|0.0903|43421.91|61.55–187.38|9.98/11.03/11.23/190.97 |180.93|18/31.24|288.17|
|decode-off-2|26.53|2612.53|0.0985|43422.76|65.04–283.82|10.00/11.02/11.40/286.00 |275.91|14/93.80|328.40|
|decode-on-1|26.56|3302.49|0.1244|43378.69|68.62–374.68|10.02/11.03/11.91/379.58 |369.42|19/183.59|308.61|
|decode-on-2|26.56|2484.41|0.0935|43376.66|72.78–116.78|9.99/11.02/11.53/125.57 |115.52|17/105.50|328.01|
|idle-off-1|26.53|1556.99|0.0587|0.00|0.00–0.00|9.98/11.02/11.21/14.67 |4.67|0/0.00|181.42|
|idle-off-1-control|26.53|217.47|0.0082|0.00|0.00–0.00|10.15/10.29/11.18/45.45 |34.35|0/0.00|182.52|
|idle-off-2|26.53|1746.04|0.0658|0.00|0.00–0.06|9.99/11.02/11.40/23.59 |13.60|0/0.00|186.58|
|idle-off-2-control|26.53|245.40|0.0092|0.00|0.00–0.01|10.16/10.31/10.89/16.49 |6.48|0/0.00|182.28|
|idle-on-1|26.55|1755.66|0.0661|0.00|0.00–0.00|9.97/11.02/11.49/18.58 |8.84|3/32.43|175.57|
|idle-on-2|26.55|1929.98|0.0727|0.00|0.00–0.07|9.98/11.00/11.31/46.43 |36.43|3/62.95|219.03|
|json-off-1|26.53|2260.41|0.0852|0.00|65.62–110.73|9.97/11.03/11.56/125.04 |115.05|5/24.19|279.13|
|json-off-2|26.53|2375.95|0.0896|0.00|61.31–135.82|9.98/11.03/11.40/136.97 |136.83|5/31.63|279.35|
|vp-off-1|26.53|1830.05|0.0690|0.00|18.69–68.64|9.98/11.02/11.62/79.23 |69.35|7/6.39|234.67|
|vp-off-2|26.53|1958.57|0.0738|0.00|18.64–69.00|9.99/11.02/11.53/72.81 |62.82|7/7.49|240.16|
|vp-on-1|26.55|1922.65|0.0724|0.00|18.00–19.39|9.98/11.03/11.33/27.33 |17.34|10/42.76|234.55|
|vp-on-2|26.56|2212.99|0.0833|0.00|18.75–56.05|9.99/11.01/11.56/67.70 |57.66|10/59.79|239.74|

## 入力・実行環境

```json
{
  "input": {
    "dummy": true,
    "bookRows": 192000,
    "snapshots": 240,
    "columns": 60,
    "depthPerSide": 400,
    "seconds": 60,
    "tickRows": 1200,
    "coverageSeconds": 900,
    "fragmentedIntervals": 450,
    "bookJsonBytes": 16041601,
    "bookGzipBytes": 1261465,
    "tickJsonBytes": 75001,
    "tickGzipBytes": 5054
  },
  "environment": {
    "node": "v24.22.1",
    "os": "6.18.59",
    "platform": "linux",
    "cpu": "INTEL(R) XEON(R) PLATINUM 8581C CPU @ 2.30GHz",
    "availableParallelism": 8,
    "cpuCount": 8,
    "cpuMax": "800000 100000\n",
    "memoryMax": "17179869184\n"
  }
}
```

## VP/coverageの単発分離（2 warmup後、各3回）

900秒/450分断は同じ入力。反復して飽和させず各1処理。CPU区間が短くV8/GC/測定誤差を含む。

|工程|回|wall ms|共有プロセスCPU ms|区間平均cores|10ms timer遅れms|
|---|---:|---:|---:|---:|---:|
|vp|1|0.77|1.07|1.388|0.15|
|vp|2|0.77|1.15|1.497|0.00|
|vp|3|0.28|0.27|0.937|0.00|
|compact|1|0.01|0.01|0.948|0.23|
|compact|2|0.03|0.03|1.015|0.20|
|compact|3|0.03|0.03|0.937|0.25|
|fragmented|1|16.59|16.77|1.010|7.24|
|fragmented|2|19.92|25.30|1.270|10.01|
|fragmented|3|16.52|16.81|1.017|6.57|

## HeapProfiler採取の実出力

全ON試行でprocess_memoryは7行、memory_profile_errorなし。firstは6回目の約25秒、latestはstop時。保持サンプルが小さいため公開の長時間ヒープに外挿しない。

|試行|first bytes|latest bytes|first→latest ms|
|---|---:|---:|---:|
|combined-on-1|206|206|1379|
|combined-on-2|206|206|1237|
|decode-on-1|1680|1680|1116|
|decode-on-2|206|206|1378|
|idle-on-1|206|206|1497|
|idle-on-2|729|729|1467|
|vp-on-1|206|206|1473|
|vp-on-2|206|206|1423|
## CPU主要self stack（sampling時間、上位12。CPU msへの厳密な換算ではない）

### combined-off-1

- 25502.97 ms: (idle) :0
- 253.31 ms: finish file://server/src/history/decode.ts:16
- 153.21 ms: work file://server/tools/history-investigation/cpu.ts:38
- 149.65 ms: coverageSegments file://server/src/vp/trade-history.ts:9
- 92.39 ms: (garbage collector) :0
- 86.13 ms: (program) :0
- 57.89 ms: post node:inspector:115
- 50.50 ms: normalizeBook file://server/src/ingest/normalize.ts:18
- 42.92 ms: side file://server/src/ingest/normalize.ts:28
- 35.84 ms: processTimers node:internal/timers:603
- 33.85 ms: sides file://server/src/history/decode.ts:54
- 27.13 ms: listOnTimeout node:internal/timers:623
### combined-off-2

- 25458.56 ms: (idle) :0
- 270.77 ms: finish file://server/src/history/decode.ts:16
- 194.06 ms: work file://server/tools/history-investigation/cpu.ts:41
- 129.03 ms: coverageSegments file://server/src/vp/trade-history.ts:9
- 76.06 ms: normalizeBook file://server/src/ingest/normalize.ts:18
- 70.98 ms: (garbage collector) :0
- 70.08 ms: side file://server/src/ingest/normalize.ts:28
- 69.63 ms: (program) :0
- 53.24 ms: post node:inspector:115
- 32.96 ms: listOnTimeout node:internal/timers:623
- 31.12 ms: sides file://server/src/history/decode.ts:54
- 29.98 ms: (anonymous) file://server/src/history/decode.ts:30
### combined-on-1

- 25764.81 ms: (idle) :0
- 166.01 ms: finish file://server/src/history/decode.ts:16
- 103.18 ms: coverageSegments file://server/src/vp/trade-history.ts:9
- 99.25 ms: (garbage collector) :0
- 87.80 ms: work file://server/tools/history-investigation/cpu.ts:38
- 72.11 ms: (program) :0
- 62.56 ms: post node:inspector:115
- 53.13 ms: normalizeBook file://server/src/ingest/normalize.ts:18
- 27.87 ms: sides file://server/src/history/decode.ts:54
- 26.44 ms: (anonymous) file://server/src/history/decode.ts:31
- 22.47 ms: processTimers node:internal/timers:603
- 20.30 ms: emitBeforeScript node:internal/async_hooks:518
### combined-on-2

- 25515.85 ms: (idle) :0
- 255.25 ms: finish file://server/src/history/decode.ts:16
- 147.61 ms: (garbage collector) :0
- 147.07 ms: work file://server/tools/history-investigation/cpu.ts:41
- 145.00 ms: coverageSegments file://server/src/vp/trade-history.ts:9
- 65.30 ms: (program) :0
- 61.92 ms: normalizeBook file://server/src/ingest/normalize.ts:18
- 59.45 ms: post node:inspector:115
- 39.60 ms: side file://server/src/ingest/normalize.ts:28
- 27.71 ms: processTimers node:internal/timers:603
- 26.85 ms: (anonymous) file://server/src/history/decode.ts:30
- 19.99 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:77
### decode-off-1

- 25770.65 ms: (idle) :0
- 186.00 ms: finish file://server/src/history/decode.ts:16
- 74.87 ms: side file://server/src/ingest/normalize.ts:28
- 63.18 ms: (anonymous) file://server/src/history/decode.ts:30
- 61.91 ms: (program) :0
- 58.41 ms: post node:inspector:115
- 53.24 ms: (garbage collector) :0
- 52.09 ms: historyColumns file://server/src/history/decode.ts:11
- 49.79 ms: (anonymous) file://server/src/history/decode.ts:62
- 38.85 ms: sides file://server/src/history/decode.ts:54
- 37.87 ms: (anonymous) file://server/src/history/decode.ts:31
- 22.21 ms: listOnTimeout node:internal/timers:623
### decode-off-2

- 25526.44 ms: (idle) :0
- 233.69 ms: finish file://server/src/history/decode.ts:16
- 199.31 ms: work file://server/tools/history-investigation/cpu.ts:41
- 105.27 ms: side file://server/src/ingest/normalize.ts:28
- 97.50 ms: (garbage collector) :0
- 64.17 ms: (program) :0
- 61.77 ms: post node:inspector:115
- 58.90 ms: (anonymous) file://server/src/history/decode.ts:30
- 48.61 ms: normalizeBook file://server/src/ingest/normalize.ts:18
- 37.18 ms: processTimers node:internal/timers:603
- 35.85 ms: (anonymous) file://server/src/history/decode.ts:31
- 26.95 ms: listOnTimeout node:internal/timers:623
### decode-on-1

- 25115.66 ms: (idle) :0
- 331.81 ms: finish file://server/src/history/decode.ts:16
- 299.32 ms: historyColumns file://server/src/history/decode.ts:11
- 197.43 ms: (garbage collector) :0
- 143.94 ms: side file://server/src/ingest/normalize.ts:28
- 96.53 ms: (program) :0
- 62.54 ms: normalizeBook file://server/src/ingest/normalize.ts:18
- 61.87 ms: post node:inspector:115
- 57.42 ms: (anonymous) file://server/src/history/decode.ts:30
- 36.80 ms: (anonymous) file://server/src/history/decode.ts:31
- 34.89 ms: sides file://server/src/history/decode.ts:54
- 34.54 ms: processTimers node:internal/timers:603
### decode-on-2

- 25798.37 ms: (idle) :0
- 139.26 ms: finish file://server/src/history/decode.ts:16
- 116.53 ms: (garbage collector) :0
- 89.47 ms: (program) :0
- 69.00 ms: (anonymous) file://server/src/history/decode.ts:30
- 65.54 ms: post node:inspector:115
- 64.49 ms: historyColumns file://server/src/history/decode.ts:11
- 62.39 ms: side file://server/src/ingest/normalize.ts:28
- 42.81 ms: (anonymous) file://server/src/history/decode.ts:31
- 26.38 ms: processTimers node:internal/timers:603
- 19.32 ms: listOnTimeout node:internal/timers:623
- 16.53 ms: sides file://server/src/history/decode.ts:54
### idle-off-1

- 26394.33 ms: (idle) :0
- 58.30 ms: (program) :0
- 40.22 ms: post node:inspector:115
- 18.89 ms: processTimers node:internal/timers:603
- 17.97 ms: listOnTimeout node:internal/timers:623
- 12.63 ms: popAsyncContext node:internal/async_hooks:562
- 12.28 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:68
- 10.07 ms: emitBeforeScript node:internal/async_hooks:518
- 8.53 ms: insert node:internal/timers:426
- 6.67 ms: wrappedFn node:internal/errors:538
- 5.56 ms: getLibuvNow :0
- 4.45 ms: emitAfterScript node:internal/async_hooks:526
### idle-off-2

- 26372.25 ms: (idle) :0
- 62.90 ms: (program) :0
- 46.19 ms: post node:inspector:115
- 41.08 ms: processTimers node:internal/timers:603
- 14.94 ms: listOnTimeout node:internal/timers:623
- 13.59 ms: popAsyncContext node:internal/async_hooks:562
- 8.45 ms: emitBeforeScript node:internal/async_hooks:518
- 6.83 ms: (anonymous) node:internal/validators:547
- 5.73 ms: insert node:internal/timers:426
- 5.59 ms: wrappedFn node:internal/errors:538
- 5.50 ms: pushAsyncContext node:internal/async_hooks:548
- 4.52 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:77
### idle-on-1

- 26375.61 ms: (idle) :0
- 65.08 ms: (program) :0
- 44.05 ms: post node:inspector:115
- 32.03 ms: (garbage collector) :0
- 21.11 ms: processTimers node:internal/timers:603
- 16.14 ms: popAsyncContext node:internal/async_hooks:562
- 12.32 ms: listOnTimeout node:internal/timers:623
- 9.95 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:68
- 8.91 ms: insert node:internal/timers:426
- 7.79 ms: getLibuvNow :0
- 6.64 ms: emitBeforeScript node:internal/async_hooks:518
- 5.50 ms: (anonymous) node:internal/validators:547
### idle-on-2

- 26273.06 ms: (idle) :0
- 94.88 ms: (program) :0
- 62.93 ms: (garbage collector) :0
- 45.22 ms: post node:inspector:115
- 42.18 ms: processTimers node:internal/timers:603
- 27.41 ms: listOnTimeout node:internal/timers:623
- 19.23 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:76
- 17.05 ms: popAsyncContext node:internal/async_hooks:562
- 10.13 ms: emitBeforeScript node:internal/async_hooks:518
- 6.96 ms: now node:internal/perf/performance:137
- 6.86 ms: insert node:internal/timers:426
- 4.56 ms: getLibuvNow :0
### json-off-1

- 25837.18 ms: (idle) :0
- 450.41 ms: work file://server/tools/history-investigation/cpu.ts:41
- 72.37 ms: (program) :0
- 60.52 ms: post node:inspector:115
- 43.44 ms: (garbage collector) :0
- 34.67 ms: processTimers node:internal/timers:603
- 23.35 ms: listOnTimeout node:internal/timers:623
- 16.38 ms: now :0
- 11.28 ms: popAsyncContext node:internal/async_hooks:562
- 10.65 ms: pushAsyncContext node:internal/async_hooks:548
- 9.31 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:77
- 8.91 ms: now node:internal/perf/performance:137
### json-off-2

- 25733.84 ms: (idle) :0
- 525.05 ms: work file://server/tools/history-investigation/cpu.ts:42
- 89.94 ms: (program) :0
- 65.90 ms: post node:inspector:115
- 65.13 ms: (garbage collector) :0
- 39.65 ms: processTimers node:internal/timers:603
- 30.41 ms: listOnTimeout node:internal/timers:623
- 16.56 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:78
- 11.09 ms: insert node:internal/timers:426
- 7.93 ms: popAsyncContext node:internal/async_hooks:562
- 5.58 ms: pushAsyncContext node:internal/async_hooks:548
- 5.53 ms: peek node:internal/linkedlist:10
### vp-off-1

- 26161.51 ms: (idle) :0
- 194.27 ms: work file://server/tools/history-investigation/cpu.ts:38
- 61.38 ms: (program) :0
- 56.22 ms: post node:inspector:115
- 32.56 ms: processTimers node:internal/timers:603
- 24.13 ms: listOnTimeout node:internal/timers:623
- 13.38 ms: wrappedFn node:internal/errors:538
- 12.90 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:68
- 8.92 ms: popAsyncContext node:internal/async_hooks:562
- 7.88 ms: (garbage collector) :0
- 7.73 ms: pushAsyncContext node:internal/async_hooks:548
- 6.69 ms: emitBeforeScript node:internal/async_hooks:518
### vp-off-2

- 26143.25 ms: (idle) :0
- 196.15 ms: work file://server/tools/history-investigation/cpu.ts:41
- 74.02 ms: (program) :0
- 54.81 ms: post node:inspector:115
- 36.07 ms: processTimers node:internal/timers:603
- 22.05 ms: popAsyncContext node:internal/async_hooks:562
- 20.17 ms: listOnTimeout node:internal/timers:623
- 8.90 ms: (garbage collector) :0
- 7.75 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:77
- 7.50 ms: (anonymous) node:internal/validators:547
- 6.70 ms: emitBeforeScript node:internal/async_hooks:518
- 5.67 ms: now :0
### vp-on-1

- 26224.21 ms: (idle) :0
- 106.24 ms: work file://server/tools/history-investigation/cpu.ts:38
- 79.09 ms: (program) :0
- 48.27 ms: post node:inspector:115
- 41.22 ms: (garbage collector) :0
- 37.61 ms: processTimers node:internal/timers:603
- 19.44 ms: listOnTimeout node:internal/timers:623
- 11.12 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:68
- 10.36 ms: popAsyncContext node:internal/async_hooks:562
- 9.00 ms: emitBeforeScript node:internal/async_hooks:518
- 7.86 ms: wrappedFn node:internal/errors:538
- 6.74 ms: insert node:internal/timers:426
### vp-on-2

- 26081.30 ms: (idle) :0
- 189.06 ms: work file://server/tools/history-investigation/cpu.ts:41
- 90.96 ms: (program) :0
- 62.92 ms: (garbage collector) :0
- 55.78 ms: post node:inspector:115
- 54.32 ms: processTimers node:internal/timers:603
- 22.37 ms: listOnTimeout node:internal/timers:623
- 18.46 ms: (anonymous) file://server/tools/history-investigation/cpu.ts:77
- 11.15 ms: popAsyncContext node:internal/async_hooks:562
- 7.04 ms: emitBeforeScript node:internal/async_hooks:518
- 5.60 ms: peek node:internal/linkedlist:10
- 5.60 ms: getLibuvNow :0
