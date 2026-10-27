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

## 9改（2026-10-28）

### 報告

- 実施内容：指定新版の正本2件へ差し替えた後、現在板の色の帯、設定可能な棒の長さ・不透明度／バブル倍率、デルタ目盛りの文字、8項目・version 2の設定を実装。初回設定GET失敗の警告が接続回復後も残る経路に、成功を確認してから適用する再取得を追加した。Phase 10には進まない。
- 変更ファイル：下表。追加依存は**なし**。受信・列・約定の保存形式、WebSocket契約、板の取得・段数・列幅、App Storage、DB、デプロイ、Run設定、`scripts/src/`、スマホレイアウト、描画高速化は変更していない。設定だけ指定どおりversion 2。
- 確認手順：既存API／画面workflowを起動し、`/?mode=replay&from=1793022000&speed=1&debug=1`を開く。読込後、最新確定列の右の色の帯と、その上の半透明の棒を確認。設定からbookBarPct=20・bookBarOpacity=1・bubbleScale=2を保存して比較。過去へpanすると帯が消える。下段目盛りは±最大／0が12px、秒数が0と同じ行の右寄せ11px。`/?debug=1`はライブ。作業終了時にはサーバーと検証ブラウザを止める。今回の確認後は停止済み。
- 実行した確認：サーバー99/99・画面105/105、両型検査、画面の本番ビルド成功。追加したデルタ文字の配置検査も13/13成功。実API・実保存データの1倍リプレイ、実ライブ、v1読込／v2保存、設定復元、固定描画5場面、メモリ、終了を確認。
- 仕様との差分：表示／設定の未実装差分なし。最初の設定GETが失敗した当時のHTTP応答が残っておらず、その失敗原因までは断定できない。今回の修正が確認できたのは「失敗後の接続回復時に未読込設定を再取得して適用し、成功後だけ警告を解除する」経路である。
- 未解決・懸念：価格zoom最大37.70ms・平均10.50ms、時間zoom平均9.68msは平均8ms／最大33ms目安を一部満たさない。実機Safari・高DPR・公開2GiB環境・長時間は未確認。上流close1006は未解決。指示中の03:40頃のスクリーンショットは今回の添付一覧に存在せず、画像に基づく当時の診断はしていない。
- 次の候補：当時の設定GET失敗のHTTP証拠が得られれば追加調査。描画の集約・色基準計算の高速化は、今回の測定を見たユーザーの別途判断後。どちらも今回は追加実装しない。

### 0. 正本の差し替え

| 元添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_(16)_1793127004823.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(10)_1793127003594.md` | `docs/UI_SPEC_HEATMAP.md` |

添付のバイト列をそのままコピー。配置時およびコード変更後の照合結果：

```text
6238938ea2912d3b01c8041d3fe8511027e90816585677b5aafc9c2a229d3965  docs/SPEC.md
0a3b5433944ad1b515660c224c82f93090fc424bd8a92f4e1ff5306bdc69fbb3  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

AGENT_RULESは差し替えず検査のみ。削除した添付は上表の2ファイルだけ。画像は削除していない。差し替え後のSPEC 7.1・7.2・9設定・10、UI 3.3・3.4・3.9・3.10・4と、replit.md／AGENT_RULES／Phase 5・8・9報告を確認。古い添付仕様や`.local/`の同名コピーを仕様として読んでいない。

### 1. 設定読込エラーの調査・修正

**再現手順**：ページ起動時の最初の`GET /api/settings`だけを503にし、以後は実APIへ通す。旧`startWithSettings()`はcatchで「設定を読めませんでした」をセットしてからWebSocketを開始し、hello／接続回復では設定を読み直さなかった。そのためチャートの接続が戻っても未読込・警告状態が残る。

**原因の仮説と根拠**：

- 残っていたブラウザconsoleには2026-10-28 03:19:55.599 JSTの上記エラーが1件。コードは初回失敗の理由を記録しないため、HTTPコード、タイムアウト、JSON検査のどれかは不明。03:40頃の画像は未添付。
- 調査時、共有プロキシ経由、開発ドメイン経由、8080直接はいずれもGET 200。保存値は正常なversion 1の5項目、`/api/status.settings`はsource=saved、readError=null、saveError=null、preservedFiles=[]だった。継続的なファイル破損を裏付ける証拠はない。
- API起動時は`pipeline.initialize()`完了後にHTTPをlistenするため、画面より遅く準備ができる場合はある。ただし**これが当時の初回失敗原因だったという点は推測**で、断定しない。

**修正方針**：事前にチャットで説明してから、`SettingsRecovery`を導入。初回失敗後、実WebSocketのhelloが来た時だけ再GETする。同時再GETは1本にまとめる。失敗中の警告を消さず、有効な応答を受け取って適用できた場合だけ解除する。周期ポーリングや無条件の警告非表示ではない。既存の10秒打切りを維持する。読み込み中に成功した保存を遅いGETで巻き戻さない世代検査も維持。

**影響範囲**：ブラウザ設定読込のみ。RESTの形の変更は指定の8項目・version 2以外なし。サーバーの起動順序、HTTPルーティング、保存方法をこの不具合対応のためには変えていない。

**回帰確認**：単体試験で初回失敗→接続時再取得→成功適用、成功まで警告保持、同時helloでもGET1本、成功後のhelloで不要な再取得なし。実ブラウザでも初回設定GETだけに「ダミー503」を注入（consoleに明記）。板・約定・以後の設定は実APIを使い、GET合計2回・適用8値一致・警告なしを確認した。この再現テストが当時の通信失敗原因を特定したという意味ではない。一時的な本番ログの追加なし。

### 変更ファイルと役割

`src/`・`test/`・`tools/`は、特記以外`artifacts/heatmap/`配下。

| ファイル | 関数・役割 |
| --- | --- |
| `src/chart/current-book.ts` | `bookBandStart`／`CurrentBookRenderer.draw`。最新確定列の右端を物理画素へ丸め、kind 3の最大段行を既存`colorize`と共通P99で着色。その後に棒を指定%・不透明度で描く。過去閲覧では帯なし。 |
| `src/chart/trade-geometry.ts` | `bubbleRadius`／`tradeGeometry`へ倍率を追加。半径と上限へ同じ倍率。 |
| `src/chart/trade-overlay.ts` | `draw`から倍率を幾何計算へ渡す。価格ライン→バブル→点線の順序は維持。 |
| `src/chart/delta.ts` | 数値12px・#d9d9d9、秒数11px・#8a8a8a。同じ中央行の左の0と右寄せの秒数が重ならない幅制限。 |
| `src/data/settings.ts` | 8値・version 2、3項目の境界／刻み検査、`settingsChanges`のbubble／book差分。 |
| `src/data/settings-recovery.ts` | 初回失敗後の接続回復時の再取得と重複防止。 |
| `src/components/settings-form.ts` | 追加3項目、約定バブル／現在の板の見出し、範囲・初期値・0.05刻みの案内。既存`settings-ui.ts`のフォーム生成・保存へ接続。 |
| `src/main.ts` | 最新列末端・3設定の配線、bookのみ／tradesのみの更新要求、hello時の設定回復。80%追尾は変更しない。 |
| `server/src/settings/schema.ts` | version 2の検査、`readDocument`で厳密な旧5項目v1のみ補完。updatedAtは維持。 |
| `server/src/settings/local.ts` | 読込時の互換変換・応答v2、次回保存v2。GETでは旧ファイルに書かず退避もしない。 |
| `server/test/settings-v2.test.ts`、`server/test/settings.test.ts` | 3項目・v1のバイト不変と退避なし・次の保存v2、既存HTTP／原子的保存試験を新版へ対応。 |
| `test/phase9-revise.test.ts` | 設定回復、8項目と刻み、倍率、色の帯の右端／非表示／既存ラスタ・LUT一致／範囲外非描画／帯→棒、棒%・不透明度。 |
| `test/current-book.test.ts` | 指定された新初期値10%・0.5の期待値へ変更。 |
| `test/delta.test.ts` | 文字色・12/11px・同じ行・右寄せ・非重複の検査。 |
| `test/settings.test.ts`、`test/settings-form.test.ts` | 8項目の入力fixture、倍率と棒設定の独立層差分。 |
| `tools/phase9-revise-check.ts` | 実API・1倍リプレイ／ライブ、撮影、1回のGET失敗注入、メモリ、初期値復元、ブラウザ終了の証拠。 |
| `docs/SPEC.md`、`docs/UI_SPEC_HEATMAP.md` | 許可された完全コピー。コピー後の本文編集なし。 |
| `.agents/memory/settings-decisions.md`、`MEMORY.md` | 正本に反映された破損退避・旧tz廃止の重複補足を整理。ユーザーが指定した最新列の参照共有条件は残す。 |
| `PHASE9_REPORT.md`、`replit.md` | この追記とCurrent Statusのみ。 |

`LayerScheduler`、ヒートマップのラスタ・集約・色基準の計算、共通LUT、CSSのCanvas積層、VP／デルタ集計は変更していない。現在板だけのdirty要求は既存の専用層を使う。描画順序は既存積層の「ヒートマップ→現在板Canvas→約定Canvas」と、現在板Canvas内部の「帯→棒」、約定Canvas内部の「価格ライン→バブル→点線」で保証する。単体試験でこれらの順序と他層に波及しないことを検査した。

### テスト・型検査・ビルド

| 実行コマンド | 結果 |
| --- | --- |
| `pnpm --filter @workspace/receiver test` | **99/99成功** |
| `pnpm --filter @workspace/receiver typecheck` | 成功 |
| `pnpm --filter @workspace/heatmap test` | **105/105成功** |
| `pnpm --filter @workspace/heatmap typecheck` | 成功 |
| `pnpm --filter @workspace/heatmap build` | 成功、34 modules |
| `node --test artifacts/heatmap/test/delta.test.ts` | 最終追加の文字配置assertも**13/13成功** |
| `node --check artifacts/heatmap/tools/phase9-revise-check.ts` | 成功 |
| `node artifacts/heatmap/tools/phase9-revise-check.ts` | `PHASE9_REVISE_CHECK_PASSED` |
| `node server/tools/perf/render-benchmark.ts phase9-revise-final artifacts/heatmap/dist/public 1793021400135557 data/phase7/benchmark-vp.json data/phase9-revise/benchmark-settings.json` | 5場面完了、ブラウザ終了 |

初回の画面試験では旧5項目fixtureが追加3項目を持たず2試験失敗した。fixtureを初期値から補う形へ直して105/105成功。後から足した文字配置assertでは浮動小数の差し引きの誤差が出たため、検証の比較に1e-9 CSS pxの許容を入れて13/13成功。製品の描画を試験都合で変更していない。`git diff --check`は環境のindex.lock保護で完了できず、成功とは扱わない／保護を迂回していない。

新3項目の両端・刻み違い・範囲外・数字でない型・NaN等、倍率0.5／3で半径1.5〜7／9〜42px、最大段による縮小、400段の外や価格の欠けは塗らないことを検査。厳密なv1ファイルのGET前後バイト一致・退避ファイルなし・readErrorなし・次のPUTでv2も検査した。既存の破損原本退避・置換前失敗・7日保持除外・URL優先の試験はすべて維持。

### 実表示・設定復元

撮影は1280×800 CSS・DPR1。画像／生結果は`data/phase9-revise/`。

| ファイル | 内容・結果 |
| --- | --- |
| `replay-defaults.png` | 実保存1倍リプレイ・追尾。帯は物理x=641から本体右端へ、棒10%・alpha0.5・バブル1倍。 |
| `replay-large.png` | 棒20%・alpha1・バブル2倍を設定UIから保存・反映。 |
| `comparison.html` | 上2画像を左右に並べた自己完結HTML。再生が止まらないため撮影時刻は異なり、同一フレーム比較ではない。 |
| `settings-eight-fields.png` | 8項目・各範囲／初期値・見出し・保存UI。 |
| `delta-scale-detail.png` | 目盛り領域を3倍で撮影。+272／0／−272、0と同じ行の右に5s。文字の非重複を目視でも確認。 |
| `replay-browse.png` | 過去へ実panし、最新列は表示右端より先、bandStart=null。現在板の棒は再生位置のまま。 |
| `live-band.png` | 実ライブ・読込完了後。設定読込警告なし、帯と半透明の棒。 |
| `app-preview.jpg` | 共有プレビューでも警告・console例外なし。ただし初期range読込中の画面であり、完成表示の証拠は上記の実CDP画像を使用。 |

ライブを100ms間隔で60回観測。ヒートマップ回数不変で現在板回数だけが増えた隣接組を**16組**確認。板の同秒更新でも描画行数575→574の変化を観測。帯は同じ現在板Canvasでその都度作り直され、価格の段は最新kind 3を使用する。これは独立更新の証拠で、板の全受信ごとの画素差を照合した試験ではない。`browser-checks.json`に観測debugの全値を保存。Runtime例外0。

実ファイルは確認開始時version 1だった。APIはv2の補完値を返し、GETだけでは原本v1のまま。設定UIで保存後v2。確認後は「初期値に戻す」→「保存」を行い、実APIとファイルで全8値の一致を確認した：

```json
{"version":2,"values":{"heatTopPct":1,"bubbleMin":10,"bubbleScale":1,"bookBarPct":10,"bookBarOpacity":0.5,"bigTopPct":2,"bigMinSec":5,"timeZone":"Asia/Tokyo"},"updatedAt":1793127410033000}
```

### メモリ

各ブラウザ値はGC要求後の`performance.memory.usedJSHeapSize`。JS以外も含む全ブラウザRSSではない。APIはその時点の`/api/status.memory`。

| 時点 | ブラウザused (B) | API RSS (B) | API heapUsed (B) |
| --- | ---: | ---: | ---: |
| リプレイ初期値 | 31,277,305 | 460,283,904 | 139,540,592 |
| 3項目変更後 | 31,325,229 | 460,283,904 | 145,695,512 |
| ライブ | 26,577,333 | 518,938,624 | 172,620,176 |
| 停止直前 | ブラウザ終了済み | 521,871,360 | 31,714,784 |

初期値→変更後は+47,924B。ただし受信列・描画状態も進んでおり、変更だけの純増とは断定しない。ライブとリプレイは別画面の状態。サーバーは履歴取込中で、長時間安定性や公開2GiB環境の保証ではない。生値・CDPヒープ内訳は`browser-checks.json`、停止直前は`status-before-stop.json`。

### 描画時間と48.00msの内訳

Phase 8／9と同じ固定実保存フィクスチャ（5,689列・71,245約定、VP756価格／出来高78,250）、1280×800 CSS・DPR1、時間600秒・中心117244.5tick／160tick、同じ操作列。受信サーバーと画面workflowを停止して実施。画面・consoleに**ダミー接続・実保存データの固定再生**と明示。今回の設定は実APIから保存した初期値v2。新仕様による帯・棒・倍率以外、可視範囲と操作条件を維持。左端差0.0903724px。

全フレーム平均／最大ms：

| 操作 | Phase 8報告値 | Phase 9 | 9改 | 9改frame数 |
| --- | ---: | ---: | ---: | ---: |
| 価格zoom | 10.18／33.50 | 10.53／32.90 | **10.50／37.70** | 63 |
| 時間zoom | 9.21／32.80 | 11.95／48.00 | **9.68／24.70** | 87 |
| pan | 6.64／13.40 | 7.72／36.90 | **7.23／23.10** | 121 |
| 価格reset（参考） | 11.60／21.30 | 10.23／19.70 | 10.30／23.20 | 64 |

steadyは前回0フレーム、今回は遅延VP更新1フレーム0.90msであり、通常の継続描画性能として比較しない。Phase 8は既存報告値を使用し再測定していない。Phase 9の生framesは今回参照できた。別時刻の単回測定なので、短縮・悪化を今回コードだけの因果効果と断定しない。**価格zoomの最大とズーム平均の目安は未達**。

Phase 9の時間zoom最大フレーム48.00ms：

| 内訳 | ms |
| --- | ---: |
| ヒートマップ | **43.00** |
| └ 集約 | **23.30** |
| └ 色基準（P99）計算 | **17.30** |
| └ ラスタ | 1.70 |
| 時間軸 | 1.60 |
| 約定 | 1.20 |
| 現在板 | 0.30 |
| 大口板 | 0.10 |
| VP | 0.70 |
| デルタ | 1.10 |

集約・色基準・ラスタはヒートマップの内数であり、二重に合計しない。このフレームで重い層はヒートマップ、特に集約と色基準計算と特定できた。ただしその計算が遅かった根本要因（GC、CPUスケジューリング等）まではこの計測から確定できない。今回最大の価格zoom37.70msもヒートマップ29.80ms（集約18.30ms／色基準8.30ms）が主体。**高速化は実装していない**。

生フレーム・各場面画像・終了証拠は`data/perf-memory/phase9-revise-final/render-static/`、前回との内訳は`data/phase9-revise/performance-comparison.json`。

### 仕様にない値

新しい色・閾値・設定項目・保存形式を推測で追加していない。数値はすべて今回の正本指定。初回設定読込失敗後の再取得は上記の不具合対応方針として事前に報告したとおり、実接続のhello時のみ／失敗状態のみ／同時1本とし、既存10秒制限を維持する。新しい周期や試行回数は設定していない。

### ブラウザ・上流の終了

| 用途 | PID | 結果 |
| --- | ---: | --- |
| 実APIの設定・リプレイ・ライブ確認 | Chromium1824 | Browser.close後exited:true、9222閉鎖、該当確認終了後のAPI接続0・一覧[]。 |
| 共有プレビュー撮影 | Chromium2050、crashpad2052／2055 | 撮影直後にSIGTERMし、3PID消滅を確認。 |
| 固定描画比較 | Chromium2277 | Browser.close後exited:true、9223閉鎖。実API／実上流接続なし。 |

最後の`/proc`走査で検証Chromium／Chrome／crashpadプロセス0。8080・9222・9223・19090・25028閉鎖。`screenshot-closed.json`、`browser-checks.json`、固定比較の`browser-closed.json`、`final-cleanup.json`へ記録。外部接続制限は今回追加していない。保存データの削除なし。

API PID1674、2026-10-28 JST：

```text
03:58:08.231 shutdown_requested SIGTERM
03:58:08.232 upstream_close_requested code=1000
03:58:08.386 upstream_close code=1006 wasClean=false reason=shutdown
03:58:08.386 upstream_stopped socketClosed=true
03:58:08.715 server_stopped httpClosed=true
```

要求コード1000ではなく**実closeは1006**。ログで上流閉鎖とHTTP停止を確認し、PID消滅・8080接続不能も確認。停止前下流connected=0、connections=[]、slowClosed=0、sendErrors=0。`shutdown.jsonl`、`stop-request.json`、`status-before-stop.json`へ保存した。測定後も受信を再開せず終了する。

### replit.md Current Statusの更新内容

9改の完了、8項目／v1互換、帯・棒・倍率・デルタ文字、読込失敗後の回復と最初の失敗原因未確定、99＋105試験・型／ビルド、1倍リプレイ／ライブ／初期値保存、性能目安の未達、メモリ、全検証ブラウザ終了、03:58:08のSIGTERM／実close1006／PID消滅を追記。Protected Filesの指定節は変更しない。Phase 10未着手で停止。
