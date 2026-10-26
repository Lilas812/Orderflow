# Phase 3 ヒートマップ本体 報告

記録日：2026-10-27 JST。対象：Phase 3 のみ。

## 報告

- 実施内容：Vite + TypeScript + Canvas 2D の画面を実装。ライブ・リプレイ、操作、軸、データ保持、診断表示を確認した。Phase 4以降の中身は未実装。
- 変更ファイル：下記一覧。サーバーのソース・テスト・依存は変更していない。
- 確認手順：下記「再確認・iPad／iPhoneの手順」。
- 実行した確認：フロント単体テスト26件成功、型検査・本番ビルド成功。実データの1倍／10倍リプレイ、ライブ、過去range、マウス・模擬タッチをブラウザで確認。
- 仕様との差分：ユーザーの計画修正に従い本体・デルタ・時間軸は54%。正本UI仕様に残る52%＋余り2%ではない。P99は注文1枚以上の実在する可視セルだけ。仕様書は差し替え後に再編集していない。
- 未解決・懸念：配信側で低速クライアント切断42件・送信失敗25件を記録した。原因は未確定。実機Safariの滑らかさ、2時間を連続表示した実機メモリ、長期安定性は未判定。初回・大幅な操作直後に描画時間が増える。iPhone幅の価格軸は狭い。
- 次の候補：低速クライアント切断・送信失敗の調査、2時間表示・高DPRの負荷確認。いずれも提案のみで今回は実施しない。Phase 4には進まない。

**判定：Phase 3の本体実装と記載のブラウザ操作は確認済み。ただし、配信安定性と実機性能を含む全面的な合格とはしない。受信サーバーは停止済み。**

## 1. 仕様書の差し替え

今回の添付から文字を変えずに配置し、SHA-256を確認した。

```text
ea5e2702e5f187b2fd79dd884a1ff4b4d47ce52dcd24a588ec2db302afa276d3  docs/SPEC.md
c2716330f23319ddbff7c0a09437537a3efdd5383c901c9538a912d1d2700741  docs/UI_SPEC_HEATMAP.md
```

配置元・削除済みの旧コピー：

- `attached_assets/SPEC_(9)_1793031995884.md` → `docs/SPEC.md`
- `attached_assets/UI_SPEC_HEATMAP_(2)_1793032002965.md` → `docs/UI_SPEC_HEATMAP.md`

作業指示の添付は削除していない。仕様参照は差し替え後の正本で行った。

## 2. 作成・変更ファイル

フロントは `artifacts/heatmap/`、プレビューのベースパスは `/`。既存API artifactの `/api` が優先され、同一オリジンの `/api/ws` に接続する。ブラウザはTICK STREAMに直接接続しない。

| ファイル（`artifacts/heatmap/` 以下） | 主な関数・役割 |
| --- | --- |
| `package.json` | dev／test／typecheck／build。フロント実行時の外部依存なし |
| `vite.config.ts` | `PORT` で起動、プロキシ先ホストを許可、`dist/public` へビルド |
| `tsconfig.json` | 単独のstrict型検査 |
| `index.html` | Vite入口、黒背景のメタ情報、外部取得しないfavicon |
| `.replit-artifact/artifact.toml` | 登録ツールが生成したartifact設定。手編集なし |
| `src/domain.ts` | `HeatColumn`／`Trade`／`Viewport`、ティック整数・マイクロ秒、表示上限 |
| `src/main.ts` | 枠、`setViewport`、`resetView`、`syncRetentionAndRequests`、`alignFollowToPhysicalPixel`、入力・debug・状態表示 |
| `src/index.css` | 固定44pxのツール枠、54/12/5/10/19%、上下79/19/2%、黒背景、空枠 |
| `src/data/protocol.ts` | `decodeFrame`／`decodeTrades`。LEバイナリの検査、秒→マイクロ秒への変換 |
| `src/data/socket.ts` | `RealtimeClient`、同一オリジンWS、hello／各種フレーム、直列range、再接続 |
| `src/data/cache.ts` | `ColumnCache`、2時間保持、履歴閲覧中の保持、欠けを含む取得範囲の管理 |
| `src/chart/coordinates.ts` | 共通の時間・価格の座標変換、表示範囲の制限 |
| `src/chart/renderer.ts` | `HeatmapRenderer.draw`、画像シフト・部分描き足し、色、DPR、独立価格軸 |
| `src/chart/tiles.ts` | `TimeTileCache`、60秒タイル、価格別最大値の木、価格投影キャッシュ、dirty strip集計 |
| `src/chart/aggregate.ts` | `computePixelMax`、物理画素の最大値参照実装、画像シフト用のスカラー処理 |
| `src/chart/scale.ts` | `viewportPositiveP99`／`positiveVisibleP99`、正の可視セルのnearest-rank P99、線形色 |
| `src/chart/gaps.ts` | `resolveColumnForDrawing`、前後が確定した1～2秒の欠けだけを描画時に埋める |
| `src/chart/timezone.ts` | `formatTimeUs`、JST／America/Chicago、夏時間 |
| `src/chart/format.ts` | ティック×0.25の価格・受信量等の書式 |
| `test/helpers.ts` | 通信しないダミー入力・バイナリ生成 |
| `test/fixtures/server-frames.json` | 既存サーバーの`encodeFrame`が生成したダミーのgolden bytes |
| `test/protocol.test.ts` | バイナリ3種、全uint32、負価格、異常フレーム、サーバー互換 |
| `test/chart.test.ts` | P99、色の頭打ち、価格・時間両方向の最大、欠け、座標、JST／DST、境界セル除外 |
| `test/cache.test.ts` | 2時間保持・過去表示、空区間、range分割、15万件約定バッチ、ID重複 |
| `test/socket.test.ts` | hello、全受信種、range、再接続、再初期化、リプレイ終了 |
| `test/renderer.test.ts` | P99不変時の再描画、投影再利用、部分描き足し、参照最大値との一致、未受信時P99 |
| `PHASE3_REPORT.md` | 本報告 |

このほか：

- `pnpm-lock.yaml`：新しいフロントの承認済み開発依存を反映。
- 管理ワークフロー `artifacts/heatmap: web`：新フロントを登録。既存APIのRunコマンドは変更なし。
- `replit.md`：Current Statusだけに今回の結果を追記。
- `.agents/memory/MEMORY.md`／`heatmap-rendering-decisions.md`：54%と正のセルだけのP99というユーザーの修正指示を記録。
- `data/phase3-checks/`：実測・スクリーンショット・状態・ログ。既存のignore対象であり、App Storageやデプロイ用データではない。

### 依存

| パッケージ | バージョン | 用途 |
| --- | --- | --- |
| `vite` | 7.3.7 | 開発サーバー・本番ビルド |
| `typescript` | 5.9.3 | 型検査 |
| `@types/node` | 25.9.9 | テスト・Vite設定の型 |

React、チャートライブラリ、外部フォントは使用しない。チャートモジュールはDOM入口や枠組みに依存しない。

## 3. 描き足しと保持

- データは秒の列として受信し、内部のイベント時刻は整数マイクロ秒、注文価格はティック整数に変換。表示の中心・拡大率は投影用の値で、受信注文の価格を浮動小数へ置換しない。
- 60秒単位で変更領域を管理。価格別の最大値を検索する木と、価格投影済みの縦プロファイルを再利用する。プロファイルLRUは48MiB以下。
- 自動追尾時は表示開始位置を物理画素に合わせる。右端の表示余白は1物理画素未満で、最新確定列は最右画素に入る。前のCanvas画像をシフトし、新規・変更タイルと露出した帯だけに`putImageData`で描き足す。
- 静止中の部分更新も変更帯だけ。任意位置へのパン、拡大率・価格範囲・DPR変更など、既存画像を正確に再利用できない場合はスカラー画像を再投影するが、保存済みの価格木・プロファイルを再利用する。平均化や画像縮小で最大値を落とさない。
- P99変化時は色を全体に付け直す。基準計算は最大1秒に1回。0枚、欠け、400段の外、表示外を除き、画面境界に接するだけのセルも除外。データ到着前の仮基準1を確定せず、最初の実データですぐ算出する。
- DPR反映後の**物理画素**ごとに時間・価格の両方の最大枚数。文字・軸もDPRを反映。
- 欠けの全長が1～2秒と確定した場合だけ前の列で描く。3秒以上なら最初の2秒も黒。末尾を無期限に伸ばさない。元の列・保存ファイルを補完しない。
- 列・約定は2時間窓。過去閲覧中はその表示窓を保ち、新しいライブ列だけで追い出さない。kind 3は最新板として保持するだけで描かない。
- 約定の同内容重複排除はしない。rangeと初期配信が重なった場合だけ`recvUs:seq`という配信識別子で二重保持を避け、同価格・同数量でも別IDの約定は残す。
- rangeは1回3600秒以下、順に要求。通信切断時は1秒から最大60秒まで待ち時間を延ばし、次のhelloで古い状態・範囲を捨てて取り直す。リプレイ終了後も接続が開いていれば過去rangeを読めるが、自動再生を再開しない。

## 4. 実行した確認

```text
pnpm install --ignore-scripts
pnpm --filter @workspace/heatmap test
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/heatmap run build
```

- 最終結果：26テスト成功／失敗0、型エラー0、本番ビルド成功。
- 最終出力：HTML 0.84KB、CSS 4.67KB、JS 38.86KB（gzip JS 12.96KB）。
- 単体テストは通信しない人工入力（ダミー）。画面・ブラウザ確認は保存済み／ライブの実データで行い、混ぜていない。
- バイナリはartifact間のソース直接importを避け、既存サーバー生成のkind 1／2／3と空応答の固定バイト列で一致を確認。
- 開始時の記録と終了時のSHA-256を比較し、サーバーのソース・テスト・packageと正本仕様3ファイル、計32ファイルに変更なし。基準は仕様差し替え後。`docs/PHASE0_REPORT.md`や以前のサーバー報告は変更していない。

### ブラウザ操作

実測詳細：`../../data/phase3-checks/browser-results.json`。1280×800のブラウザで1回の操作確認を行った。

| 確認 | 実測 |
| --- | --- |
| 1倍リプレイ | 10秒で最新列が10秒進行、保持1818→1828列 |
| 10倍リプレイ | 約10秒で100秒進行、1886→1986列 |
| ライブ | 5秒で5秒進行、1808→1813列、FOLLOW維持 |
| ホイール | 600→1232.66→2532.42秒へ時間ズーム |
| 過去への右ドラッグ | FOLLOW=false、range要求数6まで増加、古い列を取得 |
| 実際のrange | 1／33／650／124／1187／264／600秒、全件3600秒以下 |
| 価格軸ドラッグ | 160→531.22ティックへ価格ズーム |
| ダブルクリック | 600秒・160ティック・追尾へ復帰 |
| 模擬タッチ1024×768 | 1本指パン、2本指ピンチ600→337.5秒、ダブルタップで復帰 |
| レイアウト | ツール枠44px、54/12/5/10/19%、価格軸は板枠と大口枠の間で独立 |
| 375×812 | 横並び維持。価格軸約13.55pxで読みにくい。モバイル再配置は未実装 |
| `tz=ct` | America/Chicagoの10時台、同区間のJSTは0時台。CDTとJSTの14時間差 |
| debugなし | 診断パネル非表示、`window.__heatmapDebug`未定義 |

テスターが観測したJS例外・WSエラーはなし。ただし、これは**配信サーバーログにエラーがないという意味ではない**。下記の切断・送信失敗を別に記録した。

### debugの数値

平均・最大は直近30描画の窓。描画時間は集計・色計算・価格軸を含むメインの描画処理を計測する。WebSocketデコードやブラウザ合成全体の時間ではない。draw/sは実際に描いた回数であり、静止時に60へ増やす方式ではない。

| 状態 | draw/s | 平均ms | 最大ms | 列数 | 受信bytes/min |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1倍・観測終端 | 2 | 4.49 | 13.30 | 1828 | 15,064,612 |
| 10倍・観測終端 | 9 | 2.73 | 4.00 | 1986 | 17,144,150 |
| ライブ・初回を含む窓 | 2 | 8.43 | 89.30 | 1808 | 14,428,879 |
| ライブ・5秒後 | 2 | 4.12 | 6.90 | 1813 | 14,705,515 |
| 時間ズーム直後 | 3 | 5.67 | 46.70 | 1831 | 15,629,875 |
| 操作後リセット直後 | 4 | 53.52 | 188.50 | 4130 | 25,635,821 |
| その後の追尾 | 2 | 4.56 | 8.40 | 4269 | 2,977,334 |

過去パンで記録された最大は169.10ms。操作直後の大きな値を除外して「常時滑らか」とは判定しない。受信量は直近60秒の合計で、開始60秒未満はそれまでの分。初期30分の一括配信やrangeも含む。

### 保存したスクリーンショット

以下は実際に撮影したJPEG。取得直後の画像なので、上の安定後の観測値と同じ瞬間ではない。

| ファイル | 画像内debug |
| --- | --- |
| `../../data/phase3-checks/replay-1.jpg` | 3 draw/s、平均25.02ms／最大73.50ms、1799列、13761.5 KB/min |
| `../../data/phase3-checks/replay-10.jpg` | 2 draw/s、平均32.37ms／最大75.80ms、1799列、13761.5 KB/min |
| `../../data/phase3-checks/live-final.jpg` | 5 draw/s、平均18.80ms／最大78.30ms、1796列、13885.0 KB/min、P99=14 |

初期の空画面でP99=1が確定する問題は、未受信時に基準を確定しない処理と回帰テストで修正し、最後のライブ画像で確認した。初回の404はfaviconの外部取得をなくして解消。操作テスト後にこの初期表示処理、境界だけのセルのP99除外、時間軸と重なる未指定のLIVE EDGE文字を整理した。フロー全体の再試験は重ねず、26単体テスト・型検査・ビルドと最終画像で確認した。

テスターが撮った操作途中の画像はブラウザ観測IDとしてJSONに記録されており、そこに記載されたPNG名の実ファイルは作成されていない。上のJPEG3枚が実ファイルとして残る証跡。

## 5. 受信・配信側の懸念と停止

既存Runで起動した上流WebSocketは1本のみ。接続時刻02:34:16.290 JST、SIGTERMは02:58:45.985 JST。受信中の上流再接続は0回。

停止直前の`status-final.json`の配信カウンター：

```json
{"path":"/api/ws","connected":1,"totalConnections":55,"rejectedConnections":0,"droppedBoards":26,"slowClosed":42,"sendErrors":25,"invalidRequests":0,"rangeRequests":59}
```

- 02:51:41.260 JSTから`hub_slow_close`が42件。記録されたbufferedBytesは23,066,010、queuedBytesは0。
- `hub_send_error`が25件。ブラウザ側の観測だけでは見えていなかった。上流の再接続とは別の、サーバー→ブラウザ配信側の事象。
- 55接続や42切断のカウンターを、同時接続数や42台の別クライアントとは解釈しない。各ログのクライアント対応・背景ページとの関係・原因は未確定。今回、サーバーコードを変更したり再現受信を追加したりしていない。
- 既存の履歴取り込みは180窓完了。履歴tickの空応答5区間、ライブ確定列の欠け3区間をstatus・ログに保持。フロントで元データを埋めなかった。

停止ログ：

```text
02:58:45.987 shutdown_requested         signal=SIGTERM
02:58:45.987 upstream_close_requested   code=1000 reason=shutdown
02:58:46.138 upstream_network_error     state=closing
02:58:46.139 upstream_close             code=1006 wasClean=false reason=shutdown
02:58:46.139 upstream_stopped           socketClosed=true
02:58:46.269 server_stopped             upstream=stopped httpClosed=true
```

PID 7742の消滅も確認。close1000を要求したが実測closeは1006であり、正常close1000を確認したとはしない。停止後の受信サーバー再起動はしていない。

証跡：`../../data/phase3-checks/` の`baseline.json`、`status-start.json`、`status-before-browser.json`、`status-during-browser.json`、`status-final.json`、`server-events.jsonl`、`shutdown.json`、`browser-results.json`。ブラウザ記録から不要な開発用originとVite HMRフレームを除去した。

## 6. 再確認・iPad／iPhoneの手順

実機iPad／iPhone、Safariそのものでは未確認。模擬タッチの結果を実機結果とはしない。

1. APIのRun `artifacts/api-server: API Server` とフロントのRun `artifacts/heatmap: web` を起動する。受信サーバーを別プロセスで重複起動しない。現在はAPIだけ停止済みなので、再開するまでチャートの接続は切れた状態になる。
2. 同じReplitの開発プレビューをSafariで開き、末尾のパス・クエリを以下にする。公開URLではない。端末へ共有する際もキーをURLに入れない。
   - ライブ：`/?debug=1`
   - 1倍：`/?mode=replay&from=1793029450&speed=1&debug=1`
   - 10倍：`/?mode=replay&from=1793029450&speed=10&debug=1`
   - 中部時間：上のリプレイに`&tz=ct`
3. 初回履歴の受信後、直近10分と最良気配中心±80ティックを確認。1秒列が右端に増えること、空枠に板・約定等の内容が出ないことを見る。例のfromは保存データがローカルの7日保持から削除される前だけ有効。削除後は`/api/status`の保存範囲内のUnix秒を使う。
4. 1本指で過去へ移動し、FOLLOWが外れることを確認。30分より前へ進み、debugのrange数・列数の変化を見る。取得は一度に60分以下。
5. 2本指で時間ズーム。価格軸を上下にドラッグして価格ズーム。ダブルタップで直近10分・160ティック・追尾へ戻ることを確認。
6. 最初の一括読み込み、操作中、操作後10秒程度で、draw/s、平均／最大ms、列数、KB/min、CONNECTED／FOLLOWを記録。機種・iOS・縦横・DPR・URLも添える。1列毎秒の静止表示でdraw/sが1～2でも異常とは限らない。単一の最大値を安定時の性能と混ぜない。
7. iPhoneは横向きでも確認。今回はPhase 10のスマートフォン再配置を入れておらず、狭い縦画面では軸文字が読みにくい。実機で滑らかでない、接続表示が繰り返す、画面が消える場合は、その時刻と`/api/status`、配信ログを残す。
8. 確認後はAPIをSIGTERMで止め、`upstream_close`・`upstream_stopped`・`server_stopped`を確認する。

## 7. Current Status更新内容

`replit.md`のCurrent Status末尾に、Phase 3実装、26テスト・型検査・ビルド、実データの表示／操作確認、配信側42切断・25送信失敗、実機性能未確認、SIGTERM後close1006・停止、報告の場所を追記した。他の節は変更していない。
