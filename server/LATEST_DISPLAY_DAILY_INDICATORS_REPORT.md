# 最新約定表示・HEATMAP日次CVD／VWAP 実装報告

## 1. 実施内容

2026-10-30。対象はHEATMAPの価格ライン・約定表示、日次CVD／VWAP。NQ／GC、live/follow、live/browse、replayを隔離環境で確認した。公開環境の実ライブは測定していない。

開始時点のHEADは `72763d84bde7e7a745fb8c0c42a195f4a1c6d3a2`。設定読取・LONG VP復帰・FOOTPRINT・約定読取共有の既存実装は保持した。

### 最新表示

- Hub.flushがinitializingのpeerを除外していたため、約定まで初期履歴取得完了を待っていた。ライブ約定を既存250ms周期で先行配信するよう変更した。
- 同一約定の照合はrecvUs/seqを維持。初期履歴との重複は既存のブラウザrange transactionが除く。同じ内容の別約定は除かない。
- 最新取引の描画が板の重い描画と競合した場合、最新を先のrAFで描き、板は次フレームへ送る。再色付けや全履歴取得を250ms化しない。
- followの時間基準は最新確定板／最新約定の新しい方。板の既存画像を移す場合はビットマップ移動のみ。browse中の位置は変更しない。
- DATA AGEは実データの時刻から算出し、既存status更新でも再表示する。交換所の時刻は書き換えない。

### 日次指標

- VolumeProfile.addに秒別の買い・売り・価格加重和・限月不明数量を追加。既存VPと同じ履歴取込、ライブ所有境界、リプレイを使い、新規の全日履歴ジョブは追加していない。
- CT17:00／America/Chicagoで区切り、23時間／25時間のDST境界にも対応。
- CVD＝累積買い−累積売り、VWAP＝累積価格加重和÷累積枚数。閾値前の全約定を使用し、2時間のブラウザキャッシュには依存しない。
- `daily=1`の新クライアントだけに、既存WSでsessionIndicatorsを追加。秒ごとの絶対値、symbol、session、revisionを含める。初回と世代変更は全量、それ以外は250ms周期の差分。
- 差分参照用の記録は最大512個の変更秒。通常差分はこの有界記録だけを調べる。古いpeerには全量再同期し、取引データそのものは削除しない。
- ブラウザは変更秒から後の累積だけをrAF前に更新。可視範囲の過去描画をキャッシュし、通常の同一秒更新は末尾を描く。
- 黄色VWAP、DELTAを残した1:1のCVD段、CVD独立枚数軸。初期オン、個別切替はタブ内sessionStorage。設定PUT・version変更なし。
- 「途中集計／取得分」「未調整」「限月不明数量」を表示する。完全性や限月調整を推測しない。

## 2. 変更ファイル

| ファイル | 主な変更 |
|---|---|
| server/src/hub/hub.ts | Hub.flush、初期接続：先行ライブ配信・任意の日次差分 |
| server/src/vp/state.ts | VolumeProfile.add／advance／dailyMessage：同一入力の秒別集計 |
| artifacts/heatmap/src/data/socket.ts | buildSocketUrl、handleJson：任意購読・新メッセージ採用・配信時刻 |
| artifacts/heatmap/src/data/daily.ts | DailyState：銘柄／世代照合、絶対値置換、後着時の累積補正 |
| artifacts/heatmap/src/chart/layer-scheduler.ts | LayerScheduler.request：最新優先・日次レイヤー |
| artifacts/heatmap/src/chart/daily-renderer.ts | DailyIndicatorRenderer.draw：VWAP／CVD・軸・過去画像キャッシュ |
| artifacts/heatmap/src/main.ts | 日次UI、受信→描画計測、follow画像移動、DATA AGE |
| artifacts/heatmap/src/index.css | 下段1:1、独立軸、タブ内切替 |
| docs/SPEC.md／UI_SPEC_HEATMAP.md／DAILY_INDICATORS.md | 許可された関連仕様の追記 |
| server/test/daily-indicators.test.ts／latest-delivery.test.ts | 数量・DST・先行配信・銘柄分離・互換性試験 |
| server/test/phase2b.test.ts | 許可された先行配信に合わせた旧期待値の更新 |
| server/test/latest-indicators-fixture.ts | 上流・クラウド非接続の実ハンドラーfixture |
| server/test/latest-latency-bench.mjs／daily-native-check.mjs／daily-replay-check.mjs | Canvas計測・実非表示タブ・リプレイ／GC確認 |

保存形式・coverage・依存・Run・デプロイ・共通設定には変更なし。pipeline.tsの既存seam処理も変更していない。

## 3. 確認手順・条件

- ダミーの実Receiver.receive→VolumeProfile.add→Hub→WS→コンパイル済みCanvasを使用。TICK STREAM、App Storage、本番DBには接続しない。
- 1280×800、DPR1、同じChromium、1時間表示、板1列、日次の種約定2件50枚。うち40枚は2時間より前。
- 初期履歴を各窓500ms遅らせ、初期約定1件2枚。その後32件を285ms間隔で注入。計33件65枚。両版とも最終115枚。可視幅・入力パターンを一致させた。
- 比較は各版ごとに新品fixtureを使用。指標なしは遅延修正段階の固定フロント＋旧VolumeProfile、指標ありは新フロント＋新VolumeProfile。Hubは共通で、旧クライアントはdailyを購読しない。
- 指標前の差分は `data/latest-indicators/latency-stage.patch`、ビルドも同ディレクトリ内latency-stageに保存。指標追加後に追従画像移動とDATA AGE表示の補正も含むため、総差分の比較であり指標数学処理だけのマイクロベンチではない。
- 最終の前景比較は開始／終了ともdocument.hidden=falseを確認。coldの最初の1件も除外せず別記。CPU比較の通常更新窓は約9.5秒。
- ブラウザCPUはChrome親子プロセスの/proc CPU ticks差、100ticks/sec。JSヒープと主スレッドTaskDurationも別記。WS実転送はupgrade socketのbytesWritten差で、圧縮・フレームを含み、REST注入通信は含めない。
- 最終ビルドは測定後に既存statusイベントでのDATA AGE再表示を補正した版。計算・配信・Canvas描画経路は測定版と同じ。この微小なDOM更新分の負荷は再測定していない。

## 4. 実行した確認・数字

### 段階別遅延

| 項目 | 結果 |
|---|---|
| 初期履歴待ちの受信→ブラウザ受信 | 旧版3013ms。前景比較の遅延修正版48ms、指標版41ms |
| 実Receiverの正規化 p95 | 指標前0.121ms、指標後0.112ms |
| 250ms配信待ち p95（送信時刻−元受信時刻） | 235ms → 236ms。周期は変更していない |
| ブラウザ受信→描画 p95（先行WS観測＋実描画カウンター） | 36.9ms → 36.2ms、33標本。目標100ms以内 |
| ブラウザ内の採用後→描画 p95 | 21.3ms → 22.8ms。JSON／cache採用前を含まないので上の値と区別 |
| 旧版の通常受信→描画 p95 | 35.5ms。通常描画は元々100ms以内で、主な改善対象は初期履歴による配信待ち |
| 前景cold初回受信→描画 | 指標なし40.1ms、指標あり947.4ms。初回遅延の残存を確認 |

送受信時計は同一ホスト。公開環境の時計差・ネットワーク条件や本物の上流遅延の値ではない。

### 同じ入力での指標追加差分

| 項目 | 指標なし | 指標あり |
|---|---:|---:|
| 通常更新測定窓 | 9.516秒 | 9.512秒 |
| サーバーCPU時間 | 57.541ms | 63.539ms |
| Chrome全プロセスCPU時間 | 710ms | 730ms |
| ブラウザ主スレッドTaskDuration | 315.52ms | 357.14ms |
| サーバーRSS終値 | 106.62MiB | 106.18MiB |
| JSヒープ終値 | 3.19MiB | 3.30MiB |
| Canvasフレーム時間 p95 | 2.7ms | 3.5ms |
| 通常更新のWS実転送 | 1181B | 2037B |
| 初回完了時点までのWS実転送 | 828B | 974B |

サーバーCPU増分は5.998ms／約9.5秒。短時間・小入力の比較であり、メモリ終値はGC／allocatorの影響を受ける。長時間保持量や公開CPUの解決を示さない。

生値：`data/latest-indicators/foreground-control.json`、`foreground-indicators.json`。元の修正前はbefore.json。最初の不安定なcold計測や、状態を使い回した予備測定も残し、厳密比較には使っていない。

### 数量・画素・表示状態

| 項目 | 期待値・実測・証拠 |
|---|---|
| 2時間以前を含む全日集計 | 50枚の種＋65枚＝115枚、CVD +31、VWAP 84001.42608695652 ticksで一致 |
| ライブと後着 | UI試験で115→buy3→sell7＝125枚／CVD+27。VWAP／CVDの画素も変化 |
| DELTA保持 | DELTA／CVDとも69 CSS px、1:1 |
| 履歴取得中・板未確定 | native raceで最新21003、数量161枚を初期range完了前に採用。板列は固定のまま |
| 真の非表示 | document.hidden=true。日次drawCount、overlayDrawCountが増えず、モデルは受信継続 |
| 復帰 | 非表示中buy5＋後着sell7で161→173枚、CVD+35→+33。画素変化あり、browse位置・ズーム・follow=falseを維持 |
| 別タブ・切替 | NQ .25／GC .10、数量とタブ内切替が分離。新銘柄の価格を採用し旧価格を保持しない |
| 再読み込み | VWAP off／CVD onを維持、設定PUTなし、二重加算・残存WSなし |
| GC新約定 | GC 50→sell2→52枚、CVD+30→+28、最新2700.1（27001ticks）をCanvasへ採用 |
| リプレイ | 新fixtureで実ライブを60枚、その後70枚へ増やしても、過去の再生位置では50枚／CVD+30。未来を除外 |
| 旧サーバー | 現在の未再起動プレビューでは「日次配信未対応／未受信」を表示。空表示を成功にしていない |

UI試験の証拠：`data/latest-indicators/ui-test.json`、画像ID `tdgbnc` / `oi2z7r`。
実非表示：`native-visibility-evidence.json`（元native-check.jsonも保存）、`native-nq.png`、`native-gc.png`。
リプレイとGCライブ：`replay-check.json`、`replay.png`、`native-gc-live.png`。

通常テストブラウザは両タブhidden=falseとなったため非表示の合格証拠には使わず、ネイティブの同一ウィンドウで補完した。補助スクリプトには、URLだけでGCを選べるとの誤った設定、および後着履歴を無視してリプレイ50枚を固定期待した失敗もあった。製品の不具合とは扱わず、非表示の成功結果は再利用し、リプレイは新品fixtureで独立確認した。

### 試験・型検査・ビルド

- server全197試験の初回は196合格。旧「初期履歴まで約定を待つ」期待値1件だけが不一致だった。
- 許可された先行配信へ期待値を変更し、当該phase2b suite 18/18合格。変更のない他179件の合格は再利用。
- 新しい日次5件＋実WS1件はいずれも合格。混在銘柄、同内容の別約定、時刻巻戻り、後着補正、23/25h、絶対値再送、差分再同期、旧peerを確認。
- フロント173/173合格。
- server／heatmapの型検査、`pnpm --filter @workspace/receiver run build`合格。最終再ビルド済み。
- ログは `data/latest-indicators/*tests*.log` と server-revised-expectation.log。

## 5. 仕様との差分

ユーザーが許可した表示タイミング・後方互換配信・日次指標だけを追加。仕様の関連箇所から追加仕様へ参照を付けた。

```text
3ddddb6d63df4ace37c2da945d82444a282923a4e2b37a02e1cc79c9c943e90b  docs/SPEC.md
c77d578e72e191af78b6fed38724026d44456a8a4f71504fdbe9943d10c1cf1a  docs/UI_SPEC_HEATMAP.md
0a16487a5cbbc42e0a563a72aa5ac6c3d4270fae7a3cc951d67109659a300e25  docs/DAILY_INDICATORS.md
```

数学処理を価格調整済みと偽らない。日次VWAPは生の約定価格による未調整値。既存の限月判定、設定保存、停止・復旧、保存期間は変更していない。

## 6. 未解決・懸念／終了確認

- 前景p95は目標内だが、冷間の初回描画は947msが残る。遅延全体を完全に解消したとは扱わない。
- 実市場の高流量・全日大量データ・長時間RSS・公開環境の実ライブは未確認。本測定を公開CPU問題、既存欠けの解決の証拠にしない。
- 既存の最初の確定列Lによるライブ／履歴所有権は変更していない。L確定前のVPは既存の初期取込待ちとなり、指標は途中集計を表示する。
- 公開／再Publish、本番書込、購入、既存受信の再起動／停止、開発からの上流接続追加は行っていない。
- 新フロントと旧サーバーの組合せでは日次配信は使えない。フロントだけで有効にならず、新サーバーも反映する必要がある。現在の既存プレビューはその状態かつ上流停止表示であり、機能の合格証拠には使用していない。
- 自分の各計測ChromiumはBrowser.close後にPID不在を確認。通常UI試験もPID56176の終了・残存なしを確認。ネイティブPID58287、最終GC／replay PID60211も終了・PID不在。
- スクリーンショット用に残った自分の固有profileのChromeも停止した。ほかの利用者のブラウザや既存受信には触れていない。
- fixture 18789/18790/18791/18792は終了前のNQ・GC接続が各0/0。終了したPID・port・ブラウザ確認はcleanup-before.json／cleanup-after.jsonに記録。
- 既存受信PID415は継続稼働を確認。保存データは削除していない。

## 7. 次の候補

冷間初回の描画停止と、実データ量での負荷確認は残る。今回はここで停止し、公開や既存受信の再起動は進めない。
