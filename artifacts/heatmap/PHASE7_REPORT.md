# Phase 7：セッションVP

## 報告

- 実施内容：セッションの価格別買い・売り集計、不足履歴の取り込み、新規VP配信、リプレイ、独立Canvas描画を実装。**実データの取り込み・照合を実行中であり、この時点では完了報告ではない。**
- 変更ファイル：下記「変更ファイル」を参照。追加依存はなし。
- 確認手順：既存RunでAPIと画面を起動し、`/?debug=1` の右端VPを見る。`/api/status` の `phase2a.vp` に進捗・欠け・集計合計が出る。リプレイは `/?mode=replay&from=<保存済み範囲内のUnix秒>&speed=1&debug=1`。VPは表示時間のpanで期間を変えず、価格軸と同じ座標で描く。
- 実行した確認：下記の自動試験・実測証拠を参照。未完了の確認を合格とは扱わない。
- 仕様との差分：ユーザーが承認した5点を下記に明記。正本本文は指定された完全コピー以外には変更していない。現在の不足区間保存は既存時間ファイルを置換するため、最新指定の「保存済みのファイルは書き換えない」を満たさず、再び停止した。
- 未解決・懸念：保存済みファイルを書き換えない不足分保存の方法が未決定。VPの完成状態・最終照合・性能比較は未確認。既存の上流close1006、実機Safari、公開2GiB環境は今回解決対象にしない。
- 次の候補：Phase 8（デルタ）。今回は実装しない。

## 仕様の配置

許可された元添付を完全コピーし、次の指定SHA-256に一致した後、元添付2件のみを削除した。

| 元添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_(14)_1793104771803.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(8)_1793104770653.md` | `docs/UI_SPEC_HEATMAP.md` |

```text
db1d945329dc7383fa3a0f3b1969869bab72a4b3e17f43291f7b451974ce1adf  docs/SPEC.md
4bfb9dcc829d4689a715e4b871c38f654e904241397aadea6eb7aabec775256d  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

削除一覧は `data/phase7/deleted-spec-copies.txt`。AGENT_RULESは差し替えていない。その他の添付・保存済みデータは削除していない。

## 仕様にない値として決めた値

以下の5点は最新のユーザー指示を優先する。正本本文は変更せず、次回の仕様書差し替えで反映する。指定1は、ユーザーの説明どおりSPEC 7.4の16時取引終了に対する「休止中の扱いの補足」として扱う。

1. セッションはAmerica/Chicagoの17:00から翌日17:00直前まで。取引終了は16:00、16:00〜17:00は休止。万一その休止中に約定があれば終わる側のセッションに含める。
2. POCが同数なら高い価格を採用する。VAは上下同数なら上を先に広げる。
3. Phase 2aの取得済み区間を根拠に、不足窓だけを半開区間で取り込む。ファイルの存在だけでは完全被覆としない。通信で3回失敗した窓はHTTP状態とログに欠けとして出し、その窓を除いてloading:falseとする。
4. 不足分は不足区間だけ取得する。15分超の区間は15分以下に分割し、SPEC 9の半開区間・truncated時の半分分割・1窓ずつの逐次取得・近い窓の5分待ち・再試行規則を守る。保存済み区間と重ねず、保存済みファイルは書き換えない。**既存実装のファイル置換はこの最後の条件を満たさないため停止中。**
5. 縮小して同一画素行を合算した場合、可視行の合計の最大を全幅基準とする。縮小していない場合は全セッションのPOCが基準であり、POCが画面外でも可視最大へ置き換えない。

仕様の「更新は1秒に1回まで」をVPの描画全体に適用し、価格軸操作による再投影も最大1秒に1回へまとめる。遅延時は最後のviewportへ追随するための再描画を予約する。

## 変更ファイルと関数

追加依存：**なし**。既存のNode24・TypeScript・Canvas・wsと標準Intl/stream/zlibを利用。

| ファイル | 関数・役割 |
| --- | --- |
| `server/src/vp/state.ts` | `sessionStartSec`：Chicagoの暦日で境界を求め、DSTで23/25時間となる日を処理。`VolumeProfile`：価格別集計・変更revision・全体generation・セッションリセット。 |
| `server/src/vp/history.ts` | `coverageSegments`：取得済み区間と不足区間を半開区間で分離。`VpHistory`：既存板取り込み終了後に15分以内の窓を順次処理し、成熟待ち・分割・0行再取得・失敗窓・進捗を管理。 |
| `server/src/store/local.ts` | `recordedTickCoverage`：永続化済みの区間記録を読む。`recordedTicks/recoveringFiles`：起動時に見つけた部分ファイルの秒をVPの取得済み記録へ昇格させない。`visitTrades`：gzip JSONLを逐次走査。`replaceTradeRange`：未被覆区間だけを置換保存し、範囲外の元約定とライブ分を保ち、部分ファイルへの二重追記を防ぐ。保存形式とcoverageのJSON構造は変更しない。 |
| `server/src/pipeline.ts` | L以降のライブ約定をVPへ反映。`replayVp`：保存ファイルからセッション開始〜再生開始位置を限定区間で集計。`status/stop`：HTTP進捗と終了処理。 |
| `server/src/hub/hub.ts` | `sendVp/connect/flush`：初期rangeDone後の全体VP、変更価格だけの新合計を1秒間隔で配信。セッション・完了時は全体再送。接続ごとにリプレイ集計を分離。 |
| `server/src/hub/windowed-replay.ts` | VPだけの時刻順カーソルを追加。逆行約定も仮想位置の半開区間まで含めるが、従来のtrades配信順とタイミングは変えない。300秒の本体＋先読みの上限を維持。 |
| `server/src/index.ts` | VPの配線。HTTPにVP進捗を追加する一方、既存WS statusからはその新フィールドを除き、既存メッセージの形を維持。 |
| `artifacts/heatmap/src/data/vp.ts` | `VpState`：全置換と新合計更新の受信・検査。`valueArea`：高価格POC、隣接1ティック、70%以上、上優先を計算。 |
| `artifacts/heatmap/src/chart/vp.ts` | `vpRows`：縮小時の重複しない行合計、色優先、幅基準。`VpRenderer`：独立Canvas、3色、白い2/2点線、1秒上限と描画時間。 |
| `artifacts/heatmap/src/chart/layer-scheduler.ts` | VPだけのdirty更新を追加。他層を更新しない。 |
| `artifacts/heatmap/src/chart/frame-profile.ts` | `vpMs`を独立計測し、他の計測時間と二重加算しない。 |
| `artifacts/heatmap/src/data/socket.ts` | 新規vp/vpUpdateの受信を追加。 |
| `artifacts/heatmap/src/main.ts` | 既存19%枠にCanvas・取り込み中表示を配置。debugに価格数・POC・VA範囲・描画時間を追加。 |
| `server/test/vp.test.ts`、`server/test/windowed-replay.test.ts` | 境界・同内容の別約定・不足窓・部分ファイル・配信・成熟待ち/再試行・リプレイ上限を検査。 |
| `artifacts/heatmap/test/vp.test.ts`、`artifacts/heatmap/test/vp-renderer.test.ts` | VA・縮小合計と非縮小POC・3色/DPR/点線・1秒上限・他層分離を検査。 |
| `server/tools/perf/phase7-check.ts` | 実HTTP/WS経路の読み込み中/完了/1倍リプレイ、撮影、受信更新と保存ファイルの独立照合、ブラウザ終了証拠。 |
| `server/tools/perf/vp-recount.ts` | 本番VP集計を使わず、gzip JSONLを直接数え直す。 |
| `server/tools/perf/render-benchmark.ts`、`server/tools/perf/frozen-feed.js` | 固定保存データの描画比較にだけVPを追加供給する任意の入力。ダミー接続を画面とログに明示。 |
| `.agents/memory/vp-decisions.md`、`.agents/memory/MEMORY.md` | ユーザーが承認した正本への例外を記録。 |

## 自動試験・実データ検証

実行結果：

- `pnpm --filter @workspace/receiver test`：87/87成功。
- `pnpm --filter @workspace/receiver typecheck`：成功。
- `pnpm --filter @workspace/heatmap test`：77/77成功。
- `pnpm --filter @workspace/heatmap typecheck`：成功。
- `pnpm --filter @workspace/heatmap build`：成功。JS 64.09kB、gzip 20.88kB。
- `node --check server/tools/perf/phase7-check.ts`、`node --check server/tools/perf/vp-recount.ts`：成功。
- 実画面の「取り込み中」を撮影。使用したブラウザPID27456の終了・デバッグポート閉鎖を確認。最初のScreenshot用ブラウザPID26713も別途終了確認済み。

ログは `data/phase7/server-checks.log`、`web-checks.log`。実画面は `loading-preview.jpg` と `loading-live.png`。`browser-checks.json` のloading段階だけを実行しており、完成VPと1倍リプレイを確認済みとは扱わない。

### 取得粒度による停止

2026-10-27 22:53:15.683 JST時点、セッション開始 `1793052000` から既存3時間取り込みの開始 `1793096566` までの記録を調べた。

| 指標 | 値 |
| --- | ---: |
| 不足秒数 | 7,904秒 |
| 不足部分を連続区間ごとに900秒以内で取得する呼び出し数 | 1,536回 |
| 900秒窓で部分取得済み窓を丸ごと取り直す場合 | 17回 |

これは**直近3時間より前だけ**の比較で、全体呼び出し数ではない。成熟待ち・分割・再取得の増加分も含まない。根拠は `data/phase7/request-granularity.json`。

現在の本番コードは、不足する連続区間だけを取る承認済み方式のまま。部分取得済み15分窓を全体置換する変更はまだ実装していない。既存の板取り込みが終了する前に受信を止めたため、VP用の歴史補完は開始していない。起動時ファイル回復とVPの取得済み記録を分離する最後の変更は自動試験済みだが、今回止めたプロセスには未反映であり、再開時に既存workflowの再起動が必要。

### 一時停止の確認

2026-10-27：

| JST | 記録 |
| --- | --- |
| 22:54:31.204 | `shutdown_requested`、SIGTERM |
| 22:54:31.516 | `upstream_stopped`、`socketClosed:true` |
| 22:54:31.653 | 残存する下流接続をcode1001、reason shutdownで閉鎖 |
| 22:54:32.264 | `storage_stopped`、保存終了 |
| 22:54:32.282 | `server_stopped`、`httpClosed:true` |
| 22:54:32.768 | PID27419の終了、8080/19090/9222/9223閉鎖、headless Chrome本体0を確認 |

最後のメモリログで下流の接続数は0。`pause-stop-log-summary.json` と `pause-stop-proof.json` に保存。`pre-pause-status.json` は停止前のHTTP状態。確認用ブラウザや受信サーバーは残していない。外部接続の制限は追加していない。

停止時のVPはloading:true、656価格、買い36,893・売り36,186、合計73,079で、**未完成のライブ部分だけ**。完成したセッション出来高ではない。

証拠用の大きいJSON・画像は既存のignore対象 `data/phase7/` に置き、Gitや公開イメージに含めない。実取り込み・独立照合・性能比較の最終結果は、取得方法の承認と検証再開後に追記する。

### 不足区間方式の維持と再開

ユーザーは取得粒度の質問に「不足区間だけを維持」と回答した。取得済み範囲を含む15分窓の取り直しには変更していない。

2026-10-27 23:29 JST、既存workflowで受信を再開（PID29269）。永続化済み区間と起動時の部分ファイル回復を分離する試験済み変更も、この起動から反映した。新しい検証結果は旧起動の証拠と混ぜず `data/phase7/resumed/` に保存する。検証ツール `phase7-check.ts` には出力先と待機上限を環境変数で指定する機能だけを追加し、今回の履歴待機上限を12時間に設定した（完了まで12時間かかるという見積もりではない）。

取り込み中画面の撮影後、検証ブラウザPID29310の `exited:true`・`portClosed:true` と検証接続の消滅を確認。残った1接続はWindows Chrome156のReplitプレビューで、検証用ブラウザとは別であり閉じていない。外部接続制限は追加していない。履歴待機中は検証ブラウザを残さない。

`node --check server/tools/perf/phase7-check.ts` と `phase7-live-compare.ts` は成功。後者は配信と保存の独立全価格照合用ツールであり、照合自体は未実行。

### 最新の「保存済みファイルを書き換えない」指定による停止

現在の `LocalStore.replaceTradeRange` は不足区間のAPI結果を保存するとき、同じUTC時間の既存gzipファイルを逐次読み込み、不足区間以外を保持した一時ファイルへ書き出して置換する。取得済み区間の行は保持するが、ファイルそのものは置換するため、新しい指定4を満たさない。新しい指示を受けて即座にSIGTERMで停止し、保存済みデータの削除・復元・追加の保存方式変更は行っていない。

停止直前はVP取り込み中、API窓146回・成功区間3,784秒・ファイル読込11,258秒。これは停止前スナップショットであり最終確定件数ではない。再開から停止まで既存方式の履歴保存が既に実行されており、「既存ファイルを一度も置換していない」とは報告できない。元の行を保持する方式だが、全元ファイルとのバイト比較や復元はしていない。

23:40:06.427 JSTに上流close1006・socketClosed:true、23:40:06.467にHTTP終了を確認。PID29269消滅、8080/19090/9222/9223閉鎖、検証ブラウザPID29310終了・検証WS消滅を確認した。最終の利用者側WSもshutdown code1001で閉じた。証拠は `data/phase7/resumed/no-rewrite-stop-proof.json` と `before-no-rewrite-stop.json`。検証ツールの `fetch failed` はこの意図的停止後のHTTP終了に伴うもの。保存方法の確認前に受信を再開しない。
