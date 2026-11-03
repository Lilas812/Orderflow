# FOOTPRINTリプレイ・HEATMAP連動の実装／隔離検証

2026-11-04。未公開。本番書込・既存受信の停止／再起動・新しい上流接続なし。
作業開始HEAD: `6473bb3e77bcbd464ab8d9ed0285296643026137`。
検証時HEAD: `5ea37140bd8e9e0df17fc58807431e3352fe68cb` と作業差分。自動チェックポイントを含むため、本変更の全体は開始HEADとの差分で確認する。
追加の転換点マークの指示は、ユーザーの優先順位確認に従い未着手。

## 実施内容

- FOOTPRINTへ既存のリプレイ操作部品を共用し、再生・停止・速度・送り・日時ジャンプ・チャート選択・ライブ復帰を接続した。
- 同一タブ・銘柄ごとに再生位置（マイクロ秒精度）・状態・速度を引き継ぐ。送り幅は従来の共通操作部品のタブ内設定を再利用。画面遷移時は旧接続を閉じて、移動先だけで接続する。
- FOOTPRINTは保存約定のみを読み、カーソルより厳密に前の約定で形成途中の足を作る。閲覧・履歴要求はカーソルの前2時間。板・VP・日次系列は送らない。

## 変更ファイル

| パス | 主な変更／関数 |
|---|---|
| `artifacts/heatmap/src/replay/shared.ts` | `loadSharedReplay`・`saveSharedReplay`・`clearSharedReplay`・`replayStart`。銘柄別sessionStorageの状態受け渡し |
| `artifacts/heatmap/src/replay/controls.ts` | `mountReplayControls`を共通transport対応、`persistForNavigation`、ライブ時の共通状態消去 |
| `artifacts/heatmap/src/data/socket.ts` | 秒途中の再開位置`headUs`を接続URLへ渡す |
| `artifacts/heatmap/src/main.ts` | HEATMAPで共通状態から開始、pagehide時に位置を引き継ぐ |
| `artifacts/heatmap/src/footprint/app.ts` | `mountFootprint`で同じ操作帯・選択を接続、再生時刻・表示の基準を仮想時計へ変更 |
| `artifacts/heatmap/src/footprint/client.ts` | `FootprintClient.startReplay`・`returnLive`、再生hello／state／世代の受理、カーソルまでの取得 |
| `artifacts/heatmap/src/footprint/model.ts` | `FootprintStore.hello`でリプレイをライブ取得済み区間と誤認しない |
| `server/src/hub/frame.ts` | `replayParams`の任意`headUs`検証 |
| `server/src/hub/hub.ts` | 制御接続の`view=footprint`を許可、従来のライブ経路を維持 |
| `server/src/hub/controlled-replay.ts` | `ControlledReplay`を画面別にし、`readWindow`・`footprintRange`は約定専用。世代・中断・部分秒の上限を維持 |
| `server/src/hub/windowed-replay.ts` | `WindowedReplay`の初期位置を秒途中まで復元 |
| `artifacts/heatmap/test/footprint.test.ts` | クライアントの再生URL・仮想時刻・未来除外・ライブ復帰 |
| `server/test/controlled-replay.test.ts` | 約定専用読取・部分秒のrange上限・板／VPを送らない試験 |
| `server/test/footprint-zoom-fixture.ts` | 既存の保存コピーfixtureへ最大同時接続数の観測追加 |
| `server/test/footprint-replay-ui.mjs` | NQ／GCの操作列・保存照合・60倍600秒の計測・終了検証 |
| `server/test/footprint-replay-handoff.mjs` | 再生中の画面間引継ぎ、足／行集約、両画面ライブ復帰の追加確認 |
| `docs/evidence/footprint-replay/` | 操作場面のPNG、`results.json`、`handoff.json` |
| `replit.md` | Current Statusだけ更新 |
| `.agents/memory/replay-time-semantics.md` | 今回承認されたFOOTPRINT拡張と、古い「HEATMAPのみ」のメモを整合 |

追加依存：なし。仕様書本文・保存形式・サーバー設定項目・ライブの配信形は変更していない。

## 配信契約の追加／適用範囲

| 方向／場所 | 今回の扱い |
|---|---|
| 接続URL | `mode=replay&view=footprint&controls=1&from=...&speed=...&paused=1`を許可。任意`headUs`は画面移動時のマイクロ秒位置。省略時は`from × 1,000,000` |
| クライアント→サーバー | 既存`op:"replay"`の`resume`・`pause`・`speed`・`step`・`seek`をFOOTPRINTにも適用。送り1／10／60秒、速度1／2／5／10／30／60倍 |
| `hello` | 既存の`mode`・`savedRange`・`replayControlled`・`replayFromSec`・`replayGeneration`・`replayHeadUs`をFOOTPRINTにも適用 |
| `replayState` | 既存の`state`・`positionUs`・`speed`・`fromSec`・`toSec`と世代・位置情報。FOOTPRINTも同じ状態機械 |
| `trades`／`rangeTrades` | 保存約定だけ。`tsUs < replayHeadUs`。同内容の別約定を内容で重複排除しない |
| `rangeDone.footprint` | `coverage`・`gaps`・`noData`・`quality`を従来と同じ意味で返す。`columns:0` |
| 送らないもの | FOOTPRINTリプレイには板バイナリ・現在板・VP・日次指標を送らない |

300秒窓、先読み1窓、世代による古い結果の無効化、サーバー全体2接続上限を共用する。範囲要求の読取中も世代・中断を確認し、512約定で送信を区切り、300秒の物理窓間でイベントループへ制御を返す。
新しい履歴REST要求は発生させない。

## 実行した確認

| コマンド | 最終結果 |
|---|---|
| `node --test --test-concurrency=1 server/test/*.test.ts` | **322／322合格**、95.8秒 |
| `pnpm --filter @workspace/heatmap test` | **196／196合格** |
| `pnpm --filter @workspace/heatmap run typecheck` | 合格 |
| `pnpm --filter @workspace/receiver run typecheck` | 合格 |
| `pnpm --filter @workspace/heatmap run build` | 合格。Vite本番ビルド |
| `node server/test/footprint-replay-ui.mjs` | NQ／GCの一連の操作と600仮想秒の保存照合合格 |
| `node server/test/footprint-replay-handoff.mjs` | NQ／GCの再生中の画面移動、集約、両画面ライブ復帰合格 |
| `git diff --check` | 合格 |

途中の並列サーバー全試験では既存App Storageの時間上限試験2件が不合格だった。製品処理や時間上限を変更せず、他試験とのCPU競合を避けた直列の全試験で322件すべて合格した。
ブラウザ検証コードの途中の誤判定（非同期hello待ち、履歴ログをpendingと扱った点、右端の余白、遷移先debug指定、ズームによる追加履歴等）は検証側を修正し、上記の最終実行で合格した。

### 境界と操作の確認

- 一時停止中の新しい再生約定0。秒途中からの1秒送りは停止位置へ正確に1,000,000µsを加算。既存試験で10／60秒送りも確認。
- 前後seekは世代を増やし、完了が遅れた旧rangeを無効化。部分秒のcursorへrange要求した試験で、同じ秒の未来の約定も除外した。
- 保存照合は件数だけでなく、元の`seq`を含む全約定の内容・順序のハッシュでも一致。内容が同じ別約定を保持する既存試験も全件合格。
- HEATMAP⇄FOOTPRINTの**停止中・再生中とも**、移動先helloの位置がタブに保存した位置とマイクロ秒単位で一致。速度2倍と再生／停止状態を維持。
- NQ／GCとも最大同時peer **1**。前の画面は閉じており、1人で2枠を占有しなかった。
- ライブ復帰後は共有再生状態が消え、HEATMAPへ移動してもlive helloで開始。
- リプレイ中のホイール縮小で5秒→300秒の表示足、1→50ティックの価格行へ自動集約。GCの31→1,766件は表示範囲の拡大による**過去履歴の追加読取**であり、同じ約定の加算ではない。
- 新規に読み込んだ履歴があるため、ズーム前後のキャッシュ件数自体を同数とは扱わない。全再生の数量一致は下記の独立照合で確認。
- 欠け・未取得を欠けのまま表示し、配信なしの秒を無約定と捏造しない。右端の空き2本分は従来の表示余白で、未来のデータではない。

## 入力と測定条件

既存`data/gpu-heatmap/production-input/manifest.json`が参照する、保存済み本番コピーを読み取りのみで使用。fixture起動時に10入力のSHA-256を照合した。
新しい本番コピー・Databento購入データ・合成市場入力は使っていない。入力のパス／ハッシュの一覧は`docs/evidence/footprint-replay/results.json`の`fixture.inputs`に記録。

保存コピーは2026-10-29 UTC15:42〜16:42。測定対象はその末尾10分、**UTC16:32〜16:42／JST翌03:32〜03:42**。
元コピー全体にNQ213秒、GC388秒の列不足があり、coverage未確認も残る。これは約定のみのリプレイであり、板の欠けを直すものではない。品質は`recorded_not_guaranteed`のまま。

Chromium 140、1280×800、DPR1、実Canvas。fixtureは上流を持たず、ハッシュ確認済み1時間コピーを起動時に読み終えた隔離単一プロセス。App Storageの冷間DL時間や公開環境の負荷を再現した測定ではない。
CPU・RSSはこの親プロセス、CPU coresはCPU時間÷経過時間。送信量は測定区間の圧縮・ヘッダーを含むWS wire量で、同時に返る可視履歴も含む。ブラウザの展開後受信量とは異なる。

### 60倍・600仮想秒

| 銘柄 | 実時間 | 親CPU時間／平均cores | 親loop最大 | WS wire送信 | FOOTPRINT描画p95／最大（標本数） | 保存照合 |
|---|---:|---:|---:|---:|---:|---|
| NQ | 10.052秒 | 0.578秒／0.0568 | 14.57ms | 120,120 bytes | **7.9／19.5ms（52）** | 7,646件・8,162枚一致 |
| GC | 10.112秒 | 0.354秒／0.0349 | 11.82ms | 17,817 bytes | **6.9／15.8ms（52）** | 534件・551枚一致 |

- NQの再生約定SHA-256: `3ae27d34a01060a03607e2428b63403ebfa16e58fb0117ab08afc33d6d1867da`
- GCの再生約定SHA-256: `236211bb1934716afe6d5a9d0df4aec91df9a2c9c57247309224a217ec45b669`
- 未来約定0、板バイナリ0、観測エラー0。サーバーadvance処理最大NQ4.53ms／GC0.77msで、測定中に50ms以上は観測しなかった。全入力・全環境で50ms未満との保証ではない。
- 参考：ブラウザTaskDuration NQ1.053秒／GC0.889秒、JS heap差分NQ6,130,728／GC5,412,760 bytes。親RSSは約596／591MB。fixtureの入力保持分を含み、製品メモリの上限評価には使わない。

## 画面の証拠・確認手順

各銘柄の以下の画像を`docs/evidence/footprint-replay/`へ保存した。

| 場面 | ファイル（先頭は`NQ-`／`GC-`） |
|---|---|
| 停止開始、再生、停止 | `footprint-replay-start.png`、`footprint-playing.png`、`footprint-paused.png` |
| 送り、速度、前後ジャンプ | `footprint-step.png`、`footprint-speed.png`、`footprint-forward.png`、`footprint-backward.png` |
| 画面間の位置引継ぎ | `heatmap-shared-replay.png`、`footprint-restored.png` |
| 足／価格行の自動集約 | `footprint-replay-grouped.png` |
| 600秒の末尾、ライブ復帰 | `footprint-60x600-end.png`、`footprint-live.png` |

描画が完了したNQ／GCの画像を確認した。復元直後の空画像は履歴描画完了を待った追加確認の画像へ差し替えた。

製品での操作：HEATMAPのURLに`?view=footprint`を付けてFOOTPRINTを開く→「リプレイ」→保存範囲の日時入力、またはチャートの選択→再生・停止・送り→HEATMAPへ移動→FOOTPRINTへ戻る→「ライブに戻る」。
公開版はまだ更新していないため、この新しいサーバーとフロントを揃えた環境で行う。旧サーバーが対応しない場合は再生失敗を表示し、空表示を成功とは扱わない。
再実行用fixture：
`node server/test/footprint-zoom-fixture.ts --port=18886 --front-root=artifacts/heatmap/dist/public --moving-clock`
（ユーザーの既存受信とは別の隔離サーバー。上流なし。）

## 終了確認

- 主検証ブラウザPID35545、追加確認PID36855はBrowser.close後に正常終了・`/proc`消滅を確認。途中で終了した検証ブラウザもfinallyで閉じ、最終確認で`footprint-cdp-`プロファイルのChromium残存なし。
- 終了前のfixtureはNQ=0／GC=0 peer。
- 所有fixture PID35330へSIGTERM。`replay_stopped {peers:0,noUpstream:true}`、終了コード0、PID消滅を確認。
- ポート18886のHTTPはcurl終了コード7（接続不能）。既存受信PID464は稼働を継続。所有していないブラウザ・サーバーは停止していない。

## 仕様にない値／仕様との差分

今回のユーザー決定として優先したもの：

1. `docs/FOOTPRINT_SPEC.md`の「最新から2時間」は、**リプレイ中のみ再生位置の前2時間**へ置き換えた。ライブの範囲は変更しない。
2. 従来の「リプレイはHEATMAPのみ」は**HEATMAPとFOOTPRINTで連動するリプレイ**へ置き換えた。共通のボタン・開始位置指定・操作帯、同一位置／状態／速度／送り幅、見えている画面の1接続、両画面ライブ復帰を採用。FOOTPRINTは約定だけ、300秒読取、全体2枠、他のライブと上流は継続する。
3. 位置を秒へ丸めて巻き戻さないため、画面遷移の状態と任意URLパラメータ`headUs`はマイクロ秒整数とした。秒指定の旧接続は従来どおり動く。共有状態は同じタブの銘柄別に保存し、設定PUTは増やさない。

上記以外の仕様との差分：なし。正本の本文は変更していない。

## 未解決・懸念

- 実上流・公開環境・実機Safariは未検証。この短い保存コピーの結果で、公開CPU問題や既存の市場データの欠けを解決したとは扱わない。
- 保存記録のcoverageと限月不明をそのまま表示する。市場の全約定が保存されているとの保証はしない。
- 公開には対応フロント／サーバーを揃える必要がある。公開操作・本番保存・既存受信の再起動は実行していない。

## replit.md Current Statusの追記

「2026-11-04：FOOTPRINTリプレイをHEATMAPと連動。停止／再生位置・速度・送り幅を同一タブで共有、約定専用・カーソル前2時間・1画面1接続。保存NQ/GCの60倍600秒は数量とハッシュ一致、描画p95 7.9/6.9ms。サーバー322・フロント196試験、両型検査、本番ビルド成功。所有ブラウザ・WS・隔離サーバー終了確認。未公開・本番無書込。詳細docs/FOOTPRINT_REPLAY_REPORT.md。」

## 次の候補

追加で受領した転換点マークのタスク（今回は着手しない）。本報告で停止する。
