# HEATMAPリプレイUI・制御WS 実装報告

2026-11-04。未公開。本番書込・既存受信の停止／再起動・上流追加接続なし。
作業開始HEAD: `54adc440438c5491d39edbc84514b4398d9c4817`。本変更は未コミット差分。

## 実施内容

HEATMAPのNQ／GCへ、リプレイボタン、チャートでの開始位置指定、表示時刻帯の日時入力、操作帯を追加した。
初回は一時停止で開始し、再生／停止、1・2・5・10・30・60倍、停止中の1・10・60秒送り、前後ジャンプ、ライブ復帰に対応。
保存末尾で停止して「保存データの終わり」と表示する。選択用の縦線・日時は一時表示し、選択後に消す。
速度・送り幅だけをタブのsessionStorageへ保存する。設定PUT・設定version変更なし。
FOOTPRINT／LONG VPのリプレイは追加していない。

### 実装中に修正した問題

- 制御世代をJSON／バイナリへ付け、遅れた初期範囲・VP・範囲応答を新しいジャンプへ混ぜない。
  VP読取の完了後も世代を再確認し、古い結果を現行プロフィールへ代入しない。初期化は接続内で直列化する。
- 仮想時計は停止位置を保持して速度変更・再開する。秒の途中で停止した場合も、送り幅を正確に加算する。
  制御リプレイの約定は実時刻・seqで順序付けし、巻き戻る時刻のレコードも捨てず、未来へ先送りしない。
- CT17:00を跨いだ際、約定がまだなくても、旧セッションのVP／日次系列を全量通知でリセットする。
- 高倍速で約定が毎RAFへ来ると、既存の最新約定優先スケジューラーが背景を後回しにし続けた。
  修正前のNQ600秒再生では背景更新が2回だった。リプレイ中だけ同一RAFで背景も処理するよう変更。
  ライブの最新約定優先は維持。最終NQでは背景396回、GC506回。標本数が違うので旧p95との改善率は出さない。
- 末尾停止後にジャンプした際、ヘッダーへ古いENDED表示を残さない。

## 変更ファイル

| ファイル | 主な変更 |
|---|---|
| `server/src/hub/controlled-replay.ts` | ControlledReplay、世代、操作、VP／日次通知、全Hub共通の2接続枠 |
| `server/src/hub/windowed-replay.ts` | 仮想時計のpause/resume/changeSpeed/step、精密な送り、タイマー解放 |
| `server/src/hub/hub.ts` | 制御リプレイ接続・受信振分け・終了時解放。通常flushは制御接続へ送らない |
| `server/src/hub/frame.ts` | URL speed=30/60の受付 |
| `artifacts/heatmap/src/data/socket.ts` | startReplay/returnLive/replayControl、世代包絡の復号、古い応答排除 |
| `artifacts/heatmap/src/replay/{controls.ts,time.ts,replay.css}` | 操作帯、タッチ／クリック選択、JST／CT・DST、タブ内設定 |
| `artifacts/heatmap/src/main.ts` | replay state/headの反映、ジャンプ時リセット、表示時刻帯変更の追従 |
| `artifacts/heatmap/src/chart/layer-scheduler.ts` | setLatestFirst。リプレイだけ背景の飢餓を防ぐ |
| `artifacts/heatmap/test/{socket.test.ts,replay-ui.test.ts}` | 世代、未来、DST、ブロックされたstorage、高頻度描画 |
| `server/test/controlled-replay.test.ts` | 制御・正確な送り・数量・旧世代・全体2枠・CT17の回帰試験 |
| `server/test/{footprint-zoom-fixture.ts,replay-ui-measure.mjs}` | 保存コピー専用の実WS／Canvas隔離検証と計測 |
| `replit.md` | Current Statusのみ |

### 配信契約

既存 `/api/ws`（artifact base pathを付ける）上の追加。liveと旧replayのフレーム形式は変更しない。
URLの旧mode/from/speedは維持。新UIは `mode=replay&controls=1&paused=1` を使う。
銘柄は既存symbolパラメーター、未指定は既存どおりNQ。

| 方向 | 形 | 意味 |
|---|---|---|
| C→S | `{op:"replay",action:"pause"}` | 仮想時計停止 |
| C→S | `{op:"replay",action:"resume"}` | 同じ位置から再開 |
| C→S | `{op:"replay",action:"speed",speed:1\|2\|5\|10\|30\|60}` | 位置を飛ばさず速度変更 |
| C→S | `{op:"replay",action:"step",seconds:1\|10\|60}` | 停止中のみ指定秒を加算 |
| C→S | `{op:"replay",action:"seek",fromSec:<Unix秒>}` | 世代更新、初期範囲・VP・時計を再構築 |
| C→S | 既存range要求 | 過去閲覧。未来側は再生位置で制限 |
| S→C | `{type:"hello",replayControls:true,replayFromSec,replayHeadUs,replayGeneration,...}` | 保存範囲・開始位置・制御対応を通知 |
| S→C | `{type:"replay_state",state,positionUs,speed,replayGeneration,replayHeadUs,...}` | loading/paused/playing/ended/error |
| S→C | 既存VP／日次／range／error JSON＋世代・head | 現行世代のみ採用 |
| S→C | 制御接続だけ kind=4包絡 | uint8 kind=4、uint32LE世代、float64LE headUs、元のバイナリフレーム（計13バイト追加） |

一時停止中の自動配信はゼロ。明示的な操作・初期化・rangeへの応答は必要なので送る。
初期範囲読取と先読みは従来の300秒窓。全体2枠はNQ／GC共通で、読込・停止・末尾待機も接続終了まで数える。
ライブ復帰でリプレイ接続を閉じ、タブの通常接続を新規に作る。上流接続は操作しない。
新UIの操作には対応サーバーも必要。旧サーバーへ新UIだけ出すと制御未対応の警告になり、正常扱いしない。

## 確認手順

```sh
pnpm --filter @workspace/heatmap run test
node --test --test-concurrency=1 server/test/*.test.ts
node --test server/test/controlled-replay.test.ts server/test/windowed-replay.test.ts
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver run build
# 別端末・既存受信とは独立
node server/test/footprint-zoom-fixture.ts --port=18885 --moving-clock --partial-vp-ready
node server/test/replay-ui-measure.mjs
# 既存合格の接続制限・操作確認を再利用する最終測定
node server/test/replay-ui-measure.mjs --reuse-wire-checks --reuse-ui-checks
```

fixtureは原本を読むだけ。外部認証・Storage・上流WSは使わず、設定I/OもダミーGETだけ。
本物のHub、制御ハンドラー、codec、製品フロントのCanvasを使う。
sourceは保存コピーをメモリへ読んだ隔離アダプターで、本番Storage・ディスク待ち時間を再現した測定ではない。
`--reuse-*` は既存 `data/replay-ui/measurement.json` の合格済み項目を引き継ぐ。初回は指定しない。

## 実行した確認

### 試験

- フロント全195件合格。サーバー全体320件合格後、CT17境界の1件を追加し、最終関連8件合格。
  既存317件＋追加4件を確認した。変更のない全体試験を機械的に再走してはいない。
- 両TypeScript型検査・本番向けフロントビルド成功。依存・Run・デプロイ設定変更なし。
- 仮想時計停止、1/10/60秒の正確な送り（秒途中の停止を含む）、全速度、再開連続性、保存末尾。
- 前後ジャンプ、遅延した旧世代JSON／バイナリ、遅延VP代入、正当な同内容別約定、巻き戻る約定時刻。
- CT/JST日時、DSTの存在しない時刻の拒否・二重時刻の明示選択、CT17の日次リセット。
- sessionStorage例外でも操作可能。設定PUTなし。30/60倍URL。レガシーWindowedReplay4件も合格。
- NQ＋GCの2接続があると、3つ目は `replay_limit` と理由を返す。
  停止した実WSの400ms観測で自動メッセージ0。接続解放後は枠を再利用できる。

### 実ブラウザ

NQは1024×768のタッチ対応Chromiumで選択・再生・停止・10秒送り・60倍・タッチジャンプ・前後日時ジャンプ・末尾・ライブ復帰。
GCも実WSで通常再生・停止・1/10/60秒の厳密な送り、6速度、前後ジャンプ、実pointer選択、旧マーカー消去、末尾からの再ジャンプ、ライブ復帰を確認。
GCの秒途中の停止位置は1793298722174000µs。その後の送りは順に+1000000、+10000000、+60000000µsで一致。
同じ秒へ再選択しても世代が更新され、以前の縦線と選択状態が消えることをDOMと画像で確認した。

### 60倍・600仮想秒の最終実測

入力UTC `[2026-10-29 18:32:00,18:42:00)`。JST翌日03:32〜03:42。
1280×800、DPR1、同じ保存コピー、Canvas強制、各1回。初期30分・VP・先読みが届いてから計測開始。
送信量は同じ実行のserver socket.bytesWritten増分（圧縮済みWS、フレームを含み、TLS/IPは含まない）。
展開後量はブラウザで受けたJSON／バイナリのペイロード。初期化通信はこの表へ含めていない。

| 銘柄 | 実再生時間 | 親CPU user+system | 1コア換算 | イベントループ最大遅延 | 圧縮後送信量 | 展開後量 | 背景を描いたCanvas更新p95／最大 | 背景フレーム数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| NQ | 10.206秒 | 1,943.295ms | 18.84% | 11.731ms | 707,326 B | 11,410,726 B | 22.1／138.9ms | 396 |
| GC | 10.152秒 | 1,978.445ms | 19.28% | 13.640ms | 588,233 B | 9,963,754 B | 15.4／133.0ms | 506 |

全RAFのp95はNQ21.7ms／GC15.4ms。集計コア時間をCanvas時間の代用にはしていない。
親RSS終了時はNQ569,094,144 B、GC566,476,800 B（最大RSSではない。fixtureの1時間全量メモリを含む）。
再生本体のadvance呼出最大はNQ3.301ms／GC2.568ms。先読み済みなので本体中window呼出最大は0。
任意入力・初期VPを含めて常に50ms未満との保証ではない。ブラウザの最大値には上表の100ms超の外れ値が残る。

| 銘柄 | 保存コピー→配信件数 | 枚数 | 全レコード多重集合SHA-256 |
|---|---:|---:|---|
| NQ | 7,646→7,646 | 8,162→8,162 | `3ae27d34a01060a03607e2428b63403ebfa16e58fb0117ab08afc33d6d1867da` |
| GC | 534→534 | 551→551 | `236211bb1934716afe6d5a9d0df4aec91df9a2c9c57247309224a217ec45b669` |

レコードをJSONとして整列し改行で結ぶハッシュ。件数も別に照合し、同内容の正当な別約定を一意化していない。
数量・全フィールドが一致。元ファイル順は保存し直していない。制御再生の配信順だけ時刻・seqで整列する。
入力全体はUTC17:42〜18:42の1時間コピー。NQ3,387列／GC3,212列で欠けあり。欠けを補修したとは扱わない。
fixtureのVP／日次はこの1時間の部分集計であり、全セッション完備の証拠ではない。画像にも隔離・部分集計を表示した。

### 証拠

- `data/replay-ui/measurement.json`：最終数値、数量・ハッシュ、速度・送り・世代・末尾後ジャンプのassert結果。
- `data/replay-ui/NQ-{selected,playing,end,live}.png`
- `data/replay-ui/GC-{selected,normal-playing,paused,step-1,step-10,step-60,forward,backward,pick-marker,pointer-jump,playing,end,seek-after-end,live}.png`
- GCの通常操作・送り・pointer画像は操作合格時の証拠を再利用。背景優先度修正後の最終再測定画像は
  NQ/GCのselected・playing・end・liveとGCのseek-after-end。表の性能値は最終再測定だけを使った。
- タッチ対応1024×768の別ブラウザ画像ID：
  選択ymh7bp、再生0fh4lc、停止uhthbu、送りhkeku4、60倍j7ilc4、
  タッチジャンプutdcox、後方xfkzqz、前方7gyw0q、末尾zy59fl、ライブdf5r8c。
  これらは画像IDであり、ローカルファイル名ではない。
- `data/replay-ui/final-server-status.json`：停止前NQ/GC接続各0。
- `data/replay-ui/cleanup.json`：所有PID9個すべて不在、所有ブラウザprofileプロセス0、18885接続拒否。
  最終ブラウザ31872、最終fixture31824も消滅を確認。既存受信・管理workflowは停止していない。

### 入力ファイルとSHA-256

共通先頭 `data/gpu-heatmap/production-input/`。起動時に10ファイルのハッシュを照合。
購入Databento・合成入力はこのブラウザ測定に使っていない。制御時計の単体試験だけは明示的なテスト入力。

| 相対パス | SHA-256 |
|---|---|
| prod/coverage.json | ed8f6c9de3a6d8e500233bdac8253e303f3a299165488dcfad6c1d2e948ddb26 |
| prod/columns/NQ/1s/2026-10-29/17.bin.gz | 16f74a91443a50b5bb39a183e33b289fb182f23413c5b1e188a2c538aac44429 |
| prod/trades/NQ/2026-10-29/17.jsonl.gz | 41024f26c1f3a521b053a2d816ddb5f3a569c08b81f147afe73a758bc287e3e9 |
| prod/columns/NQ/1s/2026-10-29/18.bin.gz | 5b40ada21c6954f0bd559f9807f0d97fc4c77b4c0acf16034bab161d43155e57 |
| prod/trades/NQ/2026-10-29/18.jsonl.gz | 7eb72f1d90636f6e1e9b66da398fac10229a6465e433ccdc3ef67b1e653ed7ea |
| prod/instruments/GC/coverage.json | 097176419a14854f33dc92641433a4def58ec7cd079f858e067d003df1cc422b |
| prod/instruments/GC/columns/GC/1s/2026-10-29/17.bin.gz | be8ccc518ed956f44dc9d3e79cf1325a4f736de4ad96b07c204948d6bf40e871 |
| prod/instruments/GC/trades/GC/2026-10-29/17.jsonl.gz | 25a400db4860467ccae44323a95087533ca941972b8cf0914173cbde3edc23be |
| prod/instruments/GC/columns/GC/1s/2026-10-29/18.bin.gz | f5c53c6e1625c4b90dd54b553af4364785b730b97e64e38c2cc8aa0f2973255a |
| prod/instruments/GC/trades/GC/2026-10-29/18.jsonl.gz | 91683a0288176782bd4938b7d6fe519c8c6ffe5e06687069d47d298ae13c32ba |

## 仕様との差分／仕様にない値

ユーザーは今回の指示2節と3節を正本・旧メモより優先すると明示承認した。正本仕様本文は変更していない。

1. UI_SPEC_HEATMAPのツールバー「アイコン2つ」を、リプレイ追加後は3つとして扱う。
2. SPEC8.3のURL開始のみ・1/2/5/10倍を、画面からの開始と一時停止・送り・ジャンプ・30/60倍へ拡張。
   従来URLと制御なしの旧配信形式は維持。
3. 旧画面にない操作帯・JST/CT入力・一時的な選択縦線を追加。通常の十字カーソルを固定する機能ではない。
4. 初回・ジャンプ直後は停止。保存された速度・送り幅が無効／読めなければ1倍・1秒。
   DST二重時刻はUTCオフセット付き候補を利用者が選ぶ。存在しない時刻は拒否する。
5. 「停止中は何も送らない」は自動配信停止として適用し、要求への応答まで禁止しない。
   全体2枠は停止・読込・末尾接続も含める。
6. 世代はJSONと制御接続専用13バイト包絡へ付ける。通常liveのwire・設定versionは増やさない。
7. 秒途中の停止・送りで未来を送らないため、制御再生は時刻・seq順、境界までの端数バッチも送る。
   約定250ms区切りは既承認どおり仮想時間。タイマー最小1msはNode実動作に合わせる。
8. 高倍速の背景飢餓を防ぐため、リプレイ中だけ最新約定優先の別RAF分割を解除。ライブは維持。

## 未解決・懸念

- 未公開。対応フロントとサーバーを揃えて反映する必要がある。既存受信を再起動していないため、
  現在の管理previewサーバーまで新サーバーが反映済みとは扱わない。
- 実機iPad/iPhone Safari・実機GPU・DPR2/3のリプレイ操作／負荷は未確認。
  タッチ対応Chromiumの成功を実機Safariの証拠にはしない。
- 2つの高倍速再生＋別ライブ閲覧の同時負荷と、本物のTICK STREAM継続受信は今回測定していない。
  ライブ経路・上流購読を止める変更はしていないが、公開の高CPU／欠けの解決とは主張しない。
- 保存列は従来の1秒代表値。秒内の正確なL2状態は復元しない。欠けは欠けのまま。
- 初期化の全日VP・Storage I/O・任意巨大セッションのmain最大処理時間は別途未確認。
  Canvasのp95は上表だが最大100ms超は残る。p95だけで全操作が常に速いとは保証しない。
- 計測補助の最初の2実行はhello保存範囲受信前に開始操作したため停止待ちがタイムアウトした。
  hello待機へ直した。圧縮量カウンターもhandleUpgradeがconnectionイベントを発火しない経路に対応して修正し、
  数値表はその後の再測定のみ。旧0 Bを転送ゼロとは扱わない。

## 次の候補

実機Safari／GPUでのリプレイ確認と、2再生＋ライブ同時負荷の確認は別作業。
今回は公開・復旧・次フェーズへ進まず終了した。
