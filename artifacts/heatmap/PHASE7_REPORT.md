# Phase 7：セッションVP

## 報告

- 実施内容：セッションの価格別買い・売り集計、不足履歴の取り込み、新規VP配信、リプレイ、独立Canvas描画を実装。差し込み保存の修正と実データ検証を実施。**ライブVPに起動直後36枚の不足を確認し、修正許可待ちのためPhase 7は未完了。**
- 変更ファイル：下記「変更ファイル」を参照。追加依存はなし。
- 確認手順：既存RunでAPIと画面を起動し、`/?debug=1` の右端VPを見る。`/api/status` の `phase2a.vp` に進捗・欠け・集計合計が出る。リプレイは `/?mode=replay&from=<保存済み範囲内のUnix秒>&speed=1&debug=1`。VPは表示時間のpanで期間を変えず、価格軸と同じ座標で描く。
- 実行した確認：下記の自動試験・実測証拠を参照。未完了の確認を合格とは扱わない。
- 仕様との差分：ユーザーが承認した5点と、その後の保存方法の訂正を下記に明記。正本本文は指定された完全コピー以外には変更していない。書換禁止はユーザーが撤回し、既存行を保つ差し込み・一時ファイル置換を実装した。
- 未解決・懸念：ライブVPで最初の確定列より前に受信した36約定が未加算。修正前に許可を確認する。旧方式の置換前の版は現在の読取手段では確認できず、元の全行保持は証明できない。既存の上流close1006、実機Safari、公開2GiB環境は今回解決対象にしない。
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
4. 不足分は不足区間だけ取得する。15分超の区間は15分以下に分割し、SPEC 9の半開区間・truncated時の半分分割・1窓ずつの逐次取得・近い窓の5分待ち・再試行規則を守る。保存済み区間と重ねない。「保存済みファイルを書き換えない」はユーザーが撤回した。別の補完ファイルは作らず、同じ保存形式の既存約定ファイルへ不足行だけを時刻位置に差し込む。既存行の内容・順番は保持する。一時ファイル完成後に置換し、全対象データファイルの置換後にcoverage.jsonを更新する。取得済み行の保持と置換前失敗時の不変をテストする。
5. 縮小して同一画素行を合算した場合、可視行の合計の最大を全幅基準とする。縮小していない場合は全セッションのPOCが基準であり、POCが画面外でも可視最大へ置き換えない。

仕様の「更新は1秒に1回まで」をVPの描画全体に適用し、価格軸操作による再投影も最大1秒に1回へまとめる。遅延時は最後のviewportへ追随するための再描画を予約する。

## 変更ファイルと関数

追加依存：**なし**。既存のNode24・TypeScript・Canvas・wsと標準Intl/stream/zlibを利用。

| ファイル | 関数・役割 |
| --- | --- |
| `server/src/vp/state.ts` | `sessionStartSec`：Chicagoの暦日で境界を求め、DSTで23/25時間となる日を処理。`VolumeProfile`：価格別集計・変更revision・全体generation・セッションリセット。 |
| `server/src/vp/history.ts` | `coverageSegments`：取得済み区間と不足区間を半開区間で分離。`VpHistory`：既存板取り込み終了後に15分以内の窓を順次処理し、成熟待ち・分割・0行再取得・失敗窓・進捗を管理。 |
| `server/src/store/local.ts` | `recordedTickCoverage`：永続化済みの区間記録を読む。`recordedTicks/recoveringFiles`：起動時に見つけた部分ファイルの秒をVPの取得済み記録へ昇格させない。`visitTrades`：gzip JSONLを逐次走査。`replaceTradeRange`：未被覆区間だけを置換保存し、範囲外の元約定とライブ分を保ち、部分ファイルへの二重追記を防ぐ。保存形式とcoverageのJSON構造は変更しない。 |
| `server/src/store/records.ts` | `tradeFileEntries`：既存JSONLの行文字列と解析値を逐次返し、既存行の再整形を防ぐ。`tradeFileRows`は既存の読取インターフェースを維持。 |
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
| `server/tools/perf/phase7-live-compare.ts` | ライブ配信のseq境界を保存し、受信停止・ファイルflush後に全価格の買い/売りを独立照合する。 |
| `server/tools/perf/phase7-preservation-check.ts` | 修正直前に採った26ファイルの各元行が、その後も同じ内容・相対順序で残っていることを確認する。 |
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

### 差し込み保存への訂正・旧置換の調査

最新指示でユーザーが書換禁止を撤回し、同形式での差し込み・一時ファイル置換を許可した。`LocalStore.replaceTradeRange` を変更した。既存行はJSONを再生成せず元の行文字列を保持し、既存行の逆行を含む相対順序も保持する。不足行だけ時刻位置へ挿入する。全時間分の一時ファイルを先に完成させ、データ置換後にだけ区間記録を更新する。予想外に不足区間内に既存行があれば、削除・二重登録をせず明示エラーで停止する。保存形式・依存・Run設定は変更していない。

追加4試験を含むサーバー91/91成功・型検査成功。取得済み行の内容・文字列・順番、データ置換直前のcoverage未更新、rename直前失敗時の元gzipとcoverageのバイト不変、複数時間の一時書込失敗時の不変、未被覆区間内の既存行の保護を確認した。ログは `data/phase7/insertion-server-checks.log`。ファイルごとのrenameが原子的であり、複数ファイル全体を一括ロールバックする仕組みではない。

停止前の `vp_history_window` 全146件をログから集計した結果、旧方式の保存先は次の**3ファイル**。先の途中説明で5ファイルと述べたのは、開始・終了時刻から時間ごとに連続と推定した誤りだった。取得済み時間を飛ばすため、23時・00時は実際には保存対象になっていない。

| 旧方式の保存先 | 保存窓数 | 現在の約定行数 | coverage内の行数 | coverage外の行数 | API保存行数（ログ／現在の該当区間） |
| --- | ---: | ---: | ---: | ---: | ---: |
| `data/trades/NQ/2026-10-26/22.jsonl.gz` | 4 | 3,851 | 3,851 | 0 | 3,822／3,822 |
| `data/trades/NQ/2026-10-27/01.jsonl.gz` | 11 | 12,523 | 12,523 | 0 | 12／12 |
| `data/trades/NQ/2026-10-27/02.jsonl.gz` | 131 | 7,528 | 7,528 | 0 | 0／0 |

ログから確定できるのは保存先への置換成功であり、22時ファイルが初回から存在したか新規作成されたかまでは記録がない。取得済み区間内の現在行数とログ上のAPI保存件数は上表の範囲で整合した。ただしcoverage.jsonは完全取得した区間を記録するだけで、期待する約定件数は記録しない。約定0行の秒も正当であるため、coverageの秒数から元件数や元行の全保持を証明できない。

該当ファイルはGit管理外で、ローカルGit履歴・ワークスペース内バックアップに対応する置換前の版は見つからなかった。Replitのチェックポイント内に別のファイル版があるかは、現在利用できる読取手段では確認できていない。「チェックポイントにも旧版がない」とは断定しない。従って**置換前との全既存行比較は未実施・証明不可**。削除・復元はしていない。調査結果と現状ハッシュは `data/phase7/prior-replacement-audit.json`。今回の修正後の実検証用には、現時点の26約定ファイルとcoverageを `data/phase7/pre-insertion-snapshot/` に証拠としてコピーした。これはアプリが参照する補完ファイルではない。

2026-10-28 00:04 JSTに既存workflowで修正後のサーバーを再起動（PID30336）。新しい証拠は `data/phase7/final/`。待機中は検証ブラウザを閉じ、履歴進捗を記録する。実データ確認終了時または失敗時にSIGTERMで受信を終了する手順で実行中。Phase 8は開始しない。

### 修正後の実データ結果（2026-10-28）

不足区間のみを取得する方式でVP履歴を完了した。

| 指標 | 結果 |
| --- | ---: |
| 集計開始／L（Unix秒） | 1793052000／1793113484 |
| VP履歴取得開始／終了（JST） | 00:09:51.223／00:25:17.503 |
| 経過 | 926,280ms |
| ファイルから読む被覆済み秒／不足分API秒 | 58,059／3,425（合計61,484＝L−開始） |
| ファイル処理窓／API窓 | 1,608／1,551 |
| ファイル読取処理時間／API応答時間の合計 | 23,554／388,505ms |
| 取り込んだ履歴約定数 | 318,401 |
| 通信失敗による欠け／truncated分割 | 0／0 |
| API 0行窓 | 1,549（成熟した古い不足窓。初回でデータなしとして記録） |
| 完了時VP | loading:false、1,946価格、合計361,755（下記36枚不足あり） |

API応答時間・ファイル読取時間以外に、gzipへの差し込み書込、区間記録の更新、キュー待ちなどが経過時間に含まれる。経過時間をAPI通信だけの時間とは扱わない。

- 完成ライブ画面と1倍リプレイ画面を撮影し目視確認。`complete-live.png`、`replay-one-times.png`。POC/VAが表示価格範囲外なら、その範囲に白/橙の棒が見えないことは正当。
- 1倍リプレイの保存約定独立集計は305,509約定、買い163,515・売り162,204、合計325,719、1,621価格。画面の合計・価格数と一致。
- ライブの差分受信は約1秒間隔（例：1,070／1,006／1,007／1,008／1,006ms）。各変更価格に新合計を受信。
- `phase7-preservation-check.ts` で修正直前スナップショット26ファイル・769,789元行の文字列と相対順序がすべて保持された。これは**旧方式の置換前ではなく、今回の差し込み修正直前との比較**。
- 保存形式は同じgzip JSONL、補完ファイルなし。正本3件のSHA-256も上記指定値のまま。

#### ライブ照合の不一致と修正許可待ち

`phase7-live-compare.ts` が受信した最後のVP（1,946価格・合計362,011）と、同じライブseq境界までの保存行を全価格・売買別に比較したところ、保存側が合計36枚多かった。10価格の差分は、最初のL確定前に到着した36約定（各1枚、seq1〜36、recvUs1793113484354000〜1793113485302000）の価格別買い/売り合計と**完全一致**。証拠は `live-sequence-comparison.json` と `final/live-mismatch-analysis.json`。

原因：`Pipeline.trade` はseam未確定中の約定をtradeBatchに保存するがVPに加算しない。最初の確定列のcallbackでL以降のtradeBatchを残す処理はあるが、その保持分をVPへ反映していない。履歴はL未満だけなので、保持されたL以降の36約定は保存にはあるがVPだけから漏れる。

修正案：`server/src/pipeline.ts` の最初の確定列callbackで、Lによって絞った初期tradeBatchを一度だけVPへ加算する。L未満を除外する挙動、保存行、既存WS配信は変更しない。前／同秒／後の入力を使う回帰試験を追加し、同じライブseq境界で照合する。戻す場合はこの加算と試験の変更を戻す。AGENT_RULES 5に従い、**まだ修正していない**。

#### 描画・メモリと停止確認

固定保存データ（756価格、出来高78,250）のダミー接続を画面・ログに明示して描画比較した。実データ受信サーバー停止後、前回Phase 5の左端に0.0904px以内で合わせた1280×800/DPR1の比較。対象は固定フィクスチャであり、全セッションの全約定ではない。

| 操作 | 今回の全描画 平均／最大ms | VP単独のフレーム内最大ms | 前回Phase 5 平均／最大ms |
| --- | ---: | ---: | ---: |
| 価格zoom | 10.38／22.20 | 0.70 | 10.34／33.20 |
| 価格reset | 9.69／19.10 | 0.80 | — |
| pan | 6.27／28.60 | 0.40 | — |
| 時間zoom | 7.82／16.80 | 0.70 | 9.89／28.80 |

VP追加による大幅な悪化はこの固定条件では見られないが、性能目標の全面達成や実機Safari・高DPRを保証しない。実受信検証中のkernel RSS/VmHWM最大は605,614,080B（577.56MiB）。Workspaceでの値であり、2GiB公開実機の検証ではない。

00:25:46.980 JSTに上流close1006・`socketClosed:true`、00:25:47.014にHTTP終了、PID30336消滅を確認。検証ブラウザPID30379・31072・31205は各確認後に `exited:true`・`portClosed:true`、固定描画用PID31449も終了・ポート閉鎖を確認。最終のheadless Chrome本体0、8080/19090/9222/9223すべて閉鎖。検証WSは残っておらず、利用者プレビューの残存1接続もサーバー停止時のcode1001/shutdownで閉じた。外部接続制限は追加していない。

証拠：`final/browser-checks.json`、`final/preservation-check.json`、`final/stop-proof.json`、`final/result-summary.json`、`data/perf-memory/phase7-final/render-static/browser-closed.json`。ライブ照合失敗により検証用shellはexit1で終了しており、成功扱いにしない。Phase 7は未完了、Phase 8は未着手のまま停止する。
