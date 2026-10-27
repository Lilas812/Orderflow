# Phase 9：ツールバー・設定画面・設定の保存

## 完了報告（2026-10-28）

- 実施内容：Phase 9のツールバー、設定画面、5項目の検査・原子的な保存・即時反映、URL優先、表示リセットを実装した。承認された破損原本の退避、保存失敗時の非反映、最新列の共有を含む。
- 変更ファイル：下表のサーバー・画面・試験・確認ツール、この報告書、`replit.md`のCurrent Status。仕様書は許可された2件の完全コピー以外変更なし。依存追加なし。
- 確認手順：APIのGET/PUT、`/?debug=1`および`/?mode=replay&from=1793022000&speed=1&debug=1`で設定・リセットを確認する。再実行コマンドと証拠は以下。現在、受信サーバーは指示どおり停止している。
- 実行した確認：サーバー97/97、画面101/101、両方の型検査・画面本番ビルド成功。5項目別の保存・撮影、2つの別プロファイル、再起動保持、失敗時非反映、ライブ／リプレイのリセット、共有参照とブラウザメモリ、固定5場面、初期値への復元保存、全検証ブラウザ終了とSIGTERM後の上流閉鎖を確認した。
- 仕様との差分：承認された`?tz=ct`廃止と、下の「仕様にない値」を採用。Phase 7・8の今回正本化された事項には、調べた実装との差を見つけなかった（すべての過去仕様を再検証したという意味ではない）。
- 未解決・懸念：固定比較のpan最大36.90ms、時間zoom平均11.95／最大48.00msは目安を超え、Phase 8記録より悪化した。単回・別時刻の測定なので原因は断定しない。実機Safari・高DPR・公開2GiBでの長時間安定性は未確認。ライブVPは既存の履歴取り込み中。上流終了時の実close1006は既知の未解決事項。
- 次の候補：上記の未確認事項は別依頼で扱う。Phase 10には着手せず、この報告で停止する。

## 仕様書の配置・ハッシュ・削除

| 元の添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_(15)_1793122701662.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(9)_1793122700503.md` | `docs/UI_SPEC_HEATMAP.md` |

```text
d5b17d644de34c2ff7eb92f70d2e277e25c3d1bfc4b9055b411e77f3aef0f811  docs/SPEC.md
c4a5ffbfc75feef940b161b966f7bf8e74e741fcfefb3b77b49f13cd636b4bbc  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

AGENT_RULESは変更していない。`attached_assets/`を検索した時点でSPEC・UI_SPECから始まる.mdは上記2件だけであり、一致確認後にこの2件だけを削除した。プロンプトや保存データは削除していない。

## 事前のサーバー停止

調査時点で既存Run由来のAPI PID33415が稼働し、上流open・再接続0だった。承認待ちの余分な受信を続けないためSIGTERMで停止した。

- 02:41:02.764 JST：`shutdown_requested`、signal=SIGTERM。
- 02:41:03.610：実上流close1006、`upstream_stopped`のsocketClosed=true。
- 02:41:04.002：保存flush終了、pendingColumns/pendingTradesとも0、storageError=null。
- 02:41:04.018：`server_stopped`、httpClosed=true。
- 02:41:04.277：PID消滅・8080閉鎖を確認。検証ブラウザはこの事前作業では起動していない。停止時の下流接続0。

証拠：`data/phase9/preflight-status.json`、`preflight-stop.json`。停止時の1006は既知の未解決事項であり、正常close1000を確認したとは書かない。

## 実装ファイルと役割

画面の以下のパスは`artifacts/heatmap/`を基準とする。

| ファイル | 主な関数・役割 |
| --- | --- |
| `server/src/settings/schema.ts` | `validateSettings`、`validateBody`、`validDocument`。5項目、範囲、刻み、型、必須・余分な項目を検査。 |
| `server/src/settings/local.ts` | `SettingsPersistence`、`LocalSettings.get/put/snapshot`。直列化、一時ファイル→rename、破損原本のバイト不変退避、状態・ログ。 |
| `server/src/settings/routes.ts` | `settingsRouter`。GET/PUT、400の項目別理由、保存失敗500、no-store。 |
| `server/src/status/app.ts`、`server/src/index.ts` | 設定APIの接続とHTTP `/api/status.settings`。既存WebSocketメッセージは変更しない。 |
| `src/data/settings.ts` | `resolveSettings`、`settingsChanges`、`fetchSettings`、`putSettings`。初期値・保存・URLの優先、10秒制限。 |
| `src/components/settings-ui.ts`、`settings-ui.css` | `mountSettingsUi`。44pxのSVGボタン2個、native dialog、入力・破棄・初期値・保存・失敗表示。 |
| `src/components/settings-form.ts` | `SettingsForm`、`parseInputs`。未保存の入力状態と検査。閉じる際の編集中の入力も破棄。 |
| `src/main.ts` | `startWithSettings`、`applySettings`、`resetView`。初回読込後に描画開始、設定の出どころ、層別の更新、古いPUT応答による巻き戻し防止。 |
| `src/chart/layer-scheduler.ts` | `LayerScheduler.request("heat")`はヒートマップと現在板のみ。価格軸・約定・大口板・VP・デルタを巻き込まない。 |
| `src/chart/renderer.ts`、`scale.ts` | `setTopPercent`、`viewportPositiveP99`。正の可視セルで指定順位を計算。既存の最大1秒1回の更新間隔を維持。 |
| `src/data/big-orders.ts` | `BigOrderFeed.reconfigure/shareColumn/sharing`。表示範囲から独立した最新最大2時間の列参照で再構築。列・TypedArrayはコピーせず共有。 |
| `src/data/socket.ts` | `shareColumn`フック。繰り返し取得した同内容の列も共有してから表示キャッシュと追跡へ渡す。 |
| `src/chart/view-reset.ts` | `resetViewport`。600秒・160tick、ライブ確定列末端／リプレイ再生位置を80%へ戻し、現在約定価格を中央にする。 |
| `src/chart/timezone.ts`、`test/chart.test.ts` | 旧`zoneFromSearch`と旧URL検査を削除。時刻の変換・ラベル機能は維持。 |
| `server/test/settings.test.ts` | 5試験：API・検査、原子的置換・失敗、破損原本・7日対象外、同時保存。 |
| `test/settings.test.ts`、`test/settings-form.test.ts` | 合計10試験：入力、破棄・未保存、順位、層の独立、共有・保持上限・再構築、時刻、リセット、URL。 |
| `tools/phase9-check.ts` | 実API・保存約定のリプレイ・ライブによる撮影、フォーム操作、失敗注入、別プロファイル、ヒープ計測、終了確認。 |
| `server/tools/perf/static-proxy.ts` | 確認専用HTTPプロキシに設定APIの中継を追加。実通信を使い、合成ページのloopback制限を避ける。 |
| `server/tools/perf/render-benchmark.ts` | 固定比較時に実際に保存した設定JSONを応答する確認用スタブを追加。ダミー接続の表示を維持。 |
| `PHASE9_REPORT.md`、`replit.md` Current Status | この報告と進捗。プロジェクトメモリも承認済み補足の記録を更新。 |

追加依存：**なし**。Run・デプロイ設定、約定／板の保存形式、配信契約、集計の区切り、VP期間、デルタ単位は変更していない。App Storage・DB・認証は未実装。

起動時に競合していた、同じ画面ディレクトリのVite PID33293を識別してSIGTERM停止し、既存の画面workflowを再起動した。ポート・起動コマンドは変えていない。

## テスト・型検査・ビルド

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter @workspace/receiver test` | **97/97成功**（既存92＋設定5） |
| `pnpm --filter @workspace/receiver typecheck` | 成功 |
| `pnpm --filter @workspace/heatmap test` | **101/101成功**（既存91＋設定10） |
| `pnpm --filter @workspace/heatmap typecheck` | 成功 |
| `pnpm --filter @workspace/heatmap build` | 成功、33 modules |
| `node artifacts/heatmap/tools/phase9-check.ts` | 実画面の初回確認成功、13画像 |
| `node artifacts/heatmap/tools/phase9-check.ts --after-restart` | 別プロファイル・再起動保持・初期値復元・URL確認成功、3画像 |

ログ：`data/phase9/server-checks.log`、`web-checks.log`、`ui-run.log`、`ui-after-restart.log`。初期に確認ツールのプロキシ引数を逆に渡し、起動前に失敗したため修正した。ブラウザ・APIの検査失敗を成功として扱ってはいない。

サーバー試験では、未保存GETがファイルを作らないこと、400時に元ファイルが不変であること、上下限・非整数・型・欠落・余分な項目（`__proto__`も含む）、壊れたバイト列の退避一致、置換前失敗で元の設定が残ること、最後の同時保存が勝つことを確認。30日古い設定／退避ファイルも、既存市場データの保持処理で消えないことを確認した。実データの設定ファイルを意図的に壊したわけではなく、破損と書込失敗は一時ディレクトリでの試験である。

画面の層独立試験では、色→heat/bookのみ、バブル→tradesのみ、大口板→bigのみを検査。時刻は表示ラベルだけで、VP・デルタの集計状態に渡していない。設定保存時も取引所時刻の集計境界は変えない。

## 実画面と画像

以下の画像は`data/phase9/`。設定の5項目は1つずつ保存し、実APIのGET値と画面の値も比較した。通常の撮影は実通信・保存約定の1倍リプレイまたはライブで、固定性能比較のダミー接続とは別である。

| 画像 | 確認結果 |
| --- | --- |
| `settings-open.png` | 5項目・範囲・初期値・ボタン・44pxツールバー。モーダル中に約定／板は進み、背後へのホイールで拡大率は変わらない。 |
| `settings-invalid.png` | 上位%を0にすると赤い理由・保存不可。Escapeで破棄し、APIは変わらない。 |
| `bubble-min-1.png` | 10→1を保存。撮影時バブル64→2,113個（その間に再生も進んでおり厳密な同時刻比較ではない）。 |
| `heat-top-10.png` | 上位1%→10%。可視正セルの基準12→5で色が変わる。 |
| `big-top-20.png` | 大口閾値2%→20%。撮影時の大口表示0→32段。 |
| `big-min-600.png` | 継続5→600秒。撮影時32→0段。 |
| `time-zone-chicago.png` | 日本時間→米国中部時間。ラベル22:34〜22:42→08:34〜08:42。保存・約定の集計時刻は変更なし。 |
| `settings-save-failed.png` | 確認用にPUT応答500を注入。画面は閉じず理由を表示、保存値・適用値はともにbubbleMin=1のまま。 |
| `settings-load-failed.png` | モーダルGET応答500を注入。理由を表示し、保存不可。未知の値で上書きしない。 |
| `replay-reset-before.png`／`replay-reset-after.png` | 拡大・過去スクロール後、同じ再生位置へ600秒・160tickで復帰。モードや再生開始位置は変えない。 |
| `live-reset-before.png`／`live-reset-after.png` | 拡大・過去スクロール後、追尾再開、最新列末端80%（丸め差1.5px未満）、押した瞬間の現在約定価格が中央。 |
| `second-profile-after-restart.png` | 別Chromiumプロファイルで、再起動前と5値・updatedAtが同じ。 |
| `defaults-restored.png` | フォームの「初期値に戻す」→保存後、APIと画面の5値が初期値。 |
| `url-overrides.png` | bubbleMin=9999、bigTop=100、bigMinSec=0という既存検証URLの許容値を維持。3項目にURL上書き表示。旧`tz=ct`は無効で保存の日本時間を使う。 |
| `app-preview.jpg` | 共有プレビューの起動途中も確認。これは初期範囲取り込み中の撮影であり、完成読込後の比較画像としては使わない。 |

「初期値に戻す」だけ押して外側クリックで閉じても、保存・適用値が変わらないことも確認した。UI状態・撮影時のdebug・リセット座標は`browser-checks.json`と`after-restart.json`に記録。どちらもsuccess=true、検知したRuntime例外なし。

プロファイルは`/tmp/heatmap-perf-browser-34979`と`/tmp/heatmap-perf-browser-35318`で別。最初の保存完了後にAPI PID34886をSIGTERM停止し、既存workflowで再起動したPID35303へ同じJSONが残ることをGETで確認した。

最終保存：

```json
{"version":1,"values":{"heatTopPct":1,"bubbleMin":10,"bigTopPct":2,"bigMinSec":5,"timeZone":"Asia/Tokyo"},"updatedAt":1793124396298000}
```

## 列の共有とブラウザメモリ

再構築用の最新列は最大7,200本。表示キャッシュとは別のMapに**参照だけ**を持ち、同じ列のTypedArrayを複製しない。過去へ閲覧してもこの最新側の参照・追跡は捨てない。再構築はその最新参照から行う。単体試験で7,200本の保持上限と同一参照を検査した。

実測は1倍リプレイ中。各時点でGC後の`performance.memory`とCDP `Runtime.getHeapUsage`を記録した。単位MiB。JS以外も含むブラウザ全体のRSSではない。

| 時点 | performance.usedJSHeapSize | CDP usedSize | CDP backingStorageSize | 表示列 | 追跡と重なる列／同一参照 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 設定変更前 | 29.73 | 9.04 | 20.92 | 1,801 | 1,801／1,801 |
| 大口閾値変更後 | 33.15 | 10.39 | 23.05 | 1,809 | 1,809／1,809 |
| 大口継続時間変更後 | 34.41 | 11.50 | 23.08 | 1,811 | 1,811／1,811 |
| 全変更・リセット後 | 30.62 | 9.76 | 21.20 | 1,815 | 1,815／1,815 |

前後差は約+0.89MiB。ただし列の受信・描画キャッシュ・可視範囲・DOMも変わるため、設定変更だけが原因の純増量ではない。単発確認でメモリリークなしとは断言しない。共通範囲の列は全件同一オブジェクトだった。

### `/api/status`のメモリ

| 記録 | API PID | RSS (B) | heapUsed (B) | arrayBuffers (B) |
| --- | ---: | ---: | ---: | ---: |
| 初回の実画面確認後 | 34886 | 508,952,576 | 90,821,168 | 66,628,351 |
| 再起動後の別プロファイル確認後 | 35303 | 463,851,520 | 109,863,416 | 52,945,925 |
| 最終停止直前 | 35303 | 472,842,240 | 18,848,720 | 3,284,366 |

`browser-checks.json`、`after-restart.json`、`final-status.json`に生値あり。起動・バックフィル・GCの時点が違うため、Phase 8との単純な改善率にはしない。公開2GiB環境の長時間検証の代用でもない。

## 固定描画比較

受信サーバーを停止した後、同じ実保存フィクスチャ・756価格／出来高78,250のVP・1280×800・DPR1・同じ5操作を使用。前回左端との差0.09037px。設定応答には初期値へ復元して実際に保存したJSONを使用し、画面・ログに**ダミー接続・実保存データの固定再生**と明記した。

```text
node server/tools/perf/render-benchmark.ts phase9-final artifacts/heatmap/dist/public 1793021400135557 data/phase7/benchmark-vp.json data/phase9/benchmark-settings.json
```

全描画の平均／最大ms：

| 操作 | Phase 8報告値 | Phase 9 | Phase 9フレーム数 |
| --- | ---: | ---: | ---: |
| steady | 更新フレーム0 | 更新フレーム0 | 0 |
| 価格zoom | 10.18／33.50 | 10.53／32.90 | 62 |
| 価格reset | 11.60／21.30 | 10.23／19.70 | 66 |
| pan | 6.64／13.40 | 7.72／36.90 | 120 |
| 時間zoom | 9.21／32.80 | 11.95／48.00 | 86 |

steadyの0フレームを0msとは扱わない。価格resetは短縮したが、panの最大・時間zoomの平均と最大は悪化。平均8ms／最大33msの全面達成とはしない。比較元のPhase 8の生framesディレクトリはこのworkspaceで見つからず、`PHASE8_REPORT.md`に記録済みの値を使った。今回の全フレームは`data/perf-memory/phase9-final/render-static/frames.json`にある。別時刻の単回測定であり、差のすべてを今回のコードに起因すると断定しない。

同ディレクトリの`steady.png`、`price-zoom.png`、`price-reset.png`、`pan.png`、`time-zoom.png`、`viewport-match.json`、`browser-closed.json`が証拠。

## 仕様にない値・ユーザー承認の補足

1. `updatedAt`はUnixマイクロ秒の整数、保存前はnull。
2. 不正なPUTは400で`{error:"invalid_settings",fields:{項目:理由}}`。保存失敗は500。全5項目を同時保存し、最後に成功した保存を採用する。
3. 画面の設定HTTP要求は10秒で打ち切る。モーダルを開いた際にGETできなければ保存を無効にする。初回ページのGET失敗は初期値で描画し、隅とconsoleへ「設定を読めませんでした」を出す。
4. 壊れた設定はGETでは消さず初期値を使い、状態・ログへ出す。その後の保存では元バイト列を`data/settings.corrupt-<Unixマイクロ秒>.json`へ完全に残してから新しい設定を書き込む。退避先を状態・ログに記録し、退避ファイルは自動削除しない（7日削除の対象外）。
5. **既存挙動の変更**：`?tz=ct`を廃止し、表示時刻は5項目目の保存設定を使う。残すURL上書きはbubbleMin・bigTop・bigMinSecの3項目だけ。
6. 大口板の再構築用の最新列と表示列は同じオブジェクトを共有する。設定変更前後のブラウザメモリも上表へ記録した。

これらの承認事項を正本本文に書き足してはいない。今回許可された仕様書の完全コピー以降、正本3ハッシュは変更していない。

## 終了・接続の確認

| 用途 | Chromium PID | 確認 |
| --- | ---: | --- |
| 初回の設定・ライブ／リプレイ確認 | 34991 | exited:true、9222閉鎖、該当User-AgentのWS0 |
| 再起動後の別プロファイル確認 | 35330 | exited:true、9222閉鎖、該当User-AgentのWS0 |
| 共有プレビュー撮影 | 35501 | 撮影後に残っていた本体と専用crashpadをSIGTERM終了、PID消滅確認 |
| 固定描画比較 | 36115 | exited:true、9223閉鎖。実上流／実WS接続なし |

各確認の終了時にブラウザを閉じた。固定比較後のプロセス走査でも検証Chromiumの残存なし。最終停止前の`/api/ws`接続一覧は空。保存データの削除はしていない。

最終API停止（JST、2026-10-28）：

```text
03:10:07.178 shutdown_requested SIGTERM
03:10:07.178 upstream_close_requested code=1000 reason=shutdown
03:10:07.332 upstream_close code=1006 wasClean=false reason=shutdown
03:10:07.332 upstream_stopped socketClosed=true
03:10:07.353 server_stopped upstream=stopped httpClosed=true
```

API PID35303の消滅も確認。実closeは1006なので、正常終了1000とは報告しない。証拠：`final-shutdown.jsonl`、`final-stop.json`、`screenshot-browser-closed.json`。最終走査の`final-cleanup.json`ではChromiumプロセス0、8080・9222・9223の接続拒否を確認した。画面の25028もこの時点で停止している。受信サーバーは再起動せず終了する。

## replit.md Current Statusの更新内容

Phase 9の承認待ちという記述を完了へ更新。設定API／5項目／原本退避／列共有、97＋101試験と型・ビルド、別プロファイル・再起動保持・初期値保存、メモリと性能の未達、全検証ブラウザ終了、最終SIGTERM・実close1006を記録。Protected Filesの指定節は変更していない。Phase 10未着手。
