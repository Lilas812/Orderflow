# Phase 14 見た目の作り直し

2026-10-29。実装と主要確認を実施。**全完了扱いにはしない**。通常のサーバー全テストに既存の失敗1件が残り、追加のリプレイ連続切替確認も接続上限で中断した。性能は下記のとおり、特にglowの価格ズームが重い。

## 報告

- 実施内容：glow/block、9段パレット、現在板の数字、大口板列の表示切替、設定v4と旧版移行を実装。今回承認された3点を反映した。開発の保存済みデータだけで確認した。
- 変更ファイル：下の一覧参照。依存追加なし。配信・板/約定の保存形式・公開設定は変更していない。
- 確認手順：開発Run起動後 `/?mode=replay&from=1793022000&speed=1` を開く。設定で描き方と大口板表示を切り替え、現在板の数字・本体幅・VPガイドを確認する。確認後は設定を初期値へ戻して保存し、ブラウザとサーバーを終了する。
- 実行した確認：画面133/133、サーバー直列160/160、両型検査・画面ビルド成功。通常のサーバー並列実行159/160。描画確認・固定データ性能測定・SIGTERM終了を実施。
- 仕様との差分：SPEC優先の色差と承認された補足は下記。追加確認の中断があり、すべての完了条件を確認済みとはしない。
- 未解決・懸念：glow価格ズームの負荷、既存の期限テストの並列時失敗、リプレイ連続切替後のconnection_limit、実機iPad/高DPR/長時間は未確認。
- 次の候補：glowのズーム負荷改善、既存の期限テストの負荷依存解消。ここでは実装しない。Phase 11・15には進んでいない。

## 事前確認・正本の差替え

前の依頼で、次をバイト不変で配置し、ハッシュ一致後に元の添付2件を削除した。

| 元の添付 | 配置先 |
|---|---|
| `attached_assets/SPEC_(18)_1793274211448.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(11)_1793274210065.md` | `docs/UI_SPEC_HEATMAP.md` |

削除したのはこの2件のみ。今回の追加作業では仕様書を編集していない。

```text
23eb7cfe95e5c9bd606184d45721a007ff6ba246063eb8d4894dd230058c807b  docs/SPEC.md
977d4ea7067cdd1601bab48279597489de69d0ef8a160d0a9cc9fecd393ca6fc  docs/UI_SPEC_HEATMAP.md
4ebe5fba2e6aec8d0a43e2059a1a8dbf097d45ba2612b3d9fd928bfad00e403d  docs/LONGVP_SPEC.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

Phase 10cの閾値計算、VP装飾、設定読込/保存を新版SPEC 7・7.4・9の設定と照合。Phase 14として明示された変更を除き、食い違いは見つからなかった。10c報告の機能確認済み・性能一部未達は区別して引き継いだ。

## 変更ファイルと主な関数

画面の各パスの先頭は `artifacts/heatmap/`。

| パス | 主な変更 |
|---|---|
| `src/chart/palette.ts` | `HEAT_STOPS`、256エントリ`COLOR_LUT`、`colorPosition` |
| `src/chart/glow.ts` | `GlowRaster.frame`、K/強さ/α/Gaussian/列フェード/合成・列キャッシュ |
| `src/chart/renderer.ts` | `setStyle`、`drawGlow`、`refreshScale`、共通閾値と描画内訳 |
| `src/chart/scale.ts` | 新パレット参照 |
| `src/chart/book-numbers.ts` | `bookGroupTicks`、`bookNumberRows`、数字の色と帯の終端 |
| `src/chart/current-book.ts` | `CurrentBookRenderer.draw`：棒廃止、数字・色帯、数字0件なら色帯も描かない |
| `src/chart/layout.ts` | `boardColumns`：大口板非表示76%、表示66% |
| `src/chart/trade-geometry.ts` | バブル買い/売り/同数の色 |
| `src/chart/trade-overlay.ts` | バブルα/黒縁、価格ラインと黒い下線 |
| `src/chart/delta.ts` | 正負の白/紫 |
| `src/chart/view-reset.ts` | `resetDurationSec`：ライブ3600秒、リプレイ600秒維持 |
| `src/data/settings.ts` | v4・16保存項目・新初期値・検査・style/layout変更判定 |
| `src/components/settings-form.ts` | 14表示項目、非表示2項目の保持、`resetDefaults`は全16項目 |
| `src/components/settings-ui.ts` | 描き方・大口板表示の入力、旧バー入力を非表示 |
| `src/main.ts`、`src/index.css` | レイアウト適用、非表示でも大口板追跡を継続、独立描画 |
| `test/phase14.test.ts` | 新しい計算・フェード積・食われ判定境界・列再利用・設定/レイアウト |
| `test/current-book.test.ts` | 数字と帯の終端・DPR・端で数字なしなら色帯なし |
| `test/axis-view.test.ts`、`test/chart.test.ts` | ライブ初期時間・新パレット |
| `test/colorize.test.ts`、`test/renderer.test.ts`、`test/phase10c.test.ts` | block回帰の明示旧閾値・幾何、LUT/既存スケールの維持 |
| `test/delta.test.ts`、`test/trade-geometry.test.ts`、`test/trade-overlay.test.ts` | 新色と線/縁 |
| `test/settings.test.ts`、`test/phase9-revise.test.ts` | v4・16項目・初期値 |
| `tools/phase14-check.ts` | 実保存1倍リプレイの主要画面確認と終了/初期値保存 |
| `tools/phase14-evidence.ts` | 同時刻比較・追記フレーム採取・追加確認。最後の再読込で中断 |
| `tools/phase14-gallery.ts` | 保存画像の比較HTMLと測定集計の生成 |

サーバー：

- `server/src/settings/schema.ts`：`readDocument`でv1〜3を検査してv4へ補完。旧初期4値がすべて一致する場合のみ新値へ移行。1つでも変更されていれば4値すべて保持。
- `server/src/settings/local.ts`：未保存GETとPUTをv4へ。破損原本退避・原子的保存の既存処理は維持。
- `server/test/settings-v4.test.ts`：16項目検査、v3の条件付き移行、GETで原本/updatedAt不変、PUTのみv4保存、非表示2値保持。
- `server/test/settings.test.ts`、`settings-v2.test.ts`、`settings-v3.test.ts`、`app-storage.test.ts`：現行応答版の期待をv4へ。既存の期限テストは変更していない。
- この報告書、`replit.md`のCurrent Status、`.agents/memory/phase14-display-decisions.md`：結果と口頭補足の記録。

依存追加：**なし**。フォントの外部読込追加なし。

## 仕様にない値・優先関係

今回ユーザーが決定した3点：

1. フェードの濃さは、出現倍率×取り消し倍率。該当しない倍率は1。短命な板は積のぶん薄くてよい。食われて消える場合は取り消し倍率を1とし、出現倍率は適用する。
2. 数字が1件も描けない場合、現在板の色帯も描かない。
3. 「初期値に戻す」は非表示の`bookBarPct`・`bookBarOpacity`を含む全16項目を戻す。

食われ判定はSPECどおり**消える直前の列の同価格の約定**のみ。消えた列の約定だけでは取り消しフェードを無効にしないテストを追加した。

SPECとUI_SPECの記載差は、指示されたSPEC優先を適用した：

- 同数バブル：SPEC `#808080`。UI 3.11の`#9c97b5`は採用しない。
- 現在値の点線：SPECの白・1 CSS px・4/4。UI 3.11のα/2・3指定は採用しない。
- 現在値ラベルの背景は既存SPEC側の白を維持。UI側の薄灰色変更は行わない。

## 列計算の再利用

`GlowRaster`は絶対時刻の表示バケット単位で、枚数・芯・縦ぼかし・合成RGBAを保持する。バケットは1秒、縮小時は`ceil(表示秒数/物理幅)`秒。

新列/差替え/約定の変更がバケットbにあった場合、枚数はその列、フェードと縦ぼかしは近傍、水平[1,2,1]/4合成はさらに左右1列を無効化する。全幅のGaussianを毎列行わない。

実保存リプレイのサンプルでは、全601バケットのうち、1列追加時は枚数再計算1・縦ぼかし12・合成14、`fullFlush:false`。遅れて届く約定による近傍再計算も含む別サンプルでは枚数3・ぼかし14〜15・合成16〜17。すべて`data/phase14/browser-checks.json`に保存。

価格範囲、K、時間バケット幅、U/Lo/γが変わる場合は全体を無効化する。価格ズームではこれが頻発し、重さの主因となった。`ctx.filter`は使用していない。

## 実行した確認

| コマンド/確認 | 結果 |
|---|---|
| `pnpm --filter @workspace/heatmap test` | 133/133成功 |
| `pnpm --filter @workspace/receiver test` | 159/160成功。下記既存テスト1件失敗 |
| `pnpm --filter @workspace/receiver exec node --test --test-concurrency=1 test/*.test.ts` | 160/160成功 |
| 両パッケージの`typecheck` | 成功 |
| `pnpm --filter @workspace/heatmap build` | 成功、依存追加なし |
| `node artifacts/heatmap/tools/phase14-check.ts` | `PHASE14_CHECK_PASSED` |
| `node artifacts/heatmap/tools/phase14-evidence.ts` | 比較4枚・フェード補助撮影まで取得。最後の再読込で90秒タイムアウト、終了/設定復旧は実施 |
| `node server/tools/perf/render-benchmark.ts phase14-{glow,block} ...` | 両方完走、各ブラウザ終了成功 |
| `node artifacts/heatmap/tools/phase14-gallery.ts` | 比較HTMLと集計JSONを生成 |

既存の失敗は`server/test/app-storage.test.ts:92`、応答しないアップロードの全体期限テストの`cloud.uploads.length`が期待1に対し0。変更前にも同じ失敗、単独実行では13/13成功。負荷下でアップロード開始前に50msの期限へ達する可能性があるが、これは推測であり、アプリ本体の原因を断定しない。テストも停止処理も本タスクでは変更しない。

## 画像と画面確認

比較HTML：`data/phase14/comparison.html`（画像を埋め込んだ単一ファイル）。

- `clean-{glow,block}-{10m,1h}.png`：全4枚の再生位置`1793022012000000µs`一致、speed=1。10分/1時間、同じ価格範囲160 ticks。
- `07-book-expanded.png`：24 ticks表示、1ティックまとめ。`08-book-compressed.png`：800 ticks表示、20ティックまとめ。
- `01-glow-10m.png`と`05-big-visible.png`：大口板非表示/表示、実幅922.16/800.55 CSS px。VPガイドは非表示時VPのみ、表示時大口板＋VP。
- 大口板非表示中も処理列数が進み、描画回数0のまま追跡結果が存在することを記録。最後の「同一画面で表示に切替えてrebuild不変」の追加確認は再読込が拒否されて未実施。再読込を伴うレイアウト切替の確認とは区別する。
- `fade-start-fixed.png`：117273 ticksで2→5枚となる1793021439秒付近の出現6列。
- `fade-short-fixed.png`：117240 ticksの4→5→4枚、1793021430秒の短命な板。積1/35なので薄い。
- `fade-eaten-fixed.png`：117215 ticks、1793021878秒付近。直前列に同価格約定がある消失。

上のフェード3枚は実保存データの**固定再生画像を8倍に画像拡大**したもので、ダミー接続と明記した。板/約定の合成はしていない。元は`data/perf-memory/phase14-glow/render-static/steady.png`。speed=1で操作ズームした画像と同一ではない。補助撮影`fade-appearance-cancel.png`は対象価格が価格範囲外だったため証拠に採用していない。

追加確認ではログに`hub_connection_rejected / connection_limit`が7件。`Hub.connect`の上限はpeers.size>=5だが、終了後のstatusの開いている接続一覧は外部Chromeの1件だった。この差の原因は未確定。修正せず記録した。今回の画面コード変更によるものかは断定しない。

自動プレビュー撮影`preview.jpg`は初期range読込中の瞬間。データ描画確認の証拠は初回受信完了を待った上記CDP画像を使用した。

## 性能

固定実保存データ、1280×800・DPR1、表示600秒、中心117244.5 ticks、幅160 ticks。Phase 10cと同じ保存fixture/VPと操作を使用。大口板を表示して本体66%に合わせ、左端差は1画素未満に合わせた。閾値/色はPhase 14初期値のため、10cとの単一要因の比較ではない。ローカル検証ブラウザは各測定時1台。サーバーには検証用でないWindows Chromeの開発プレビュー1接続が併存し、隔離測定ではない。外部接続制限は追加していない。

全層フレーム時間、単位ms（平均 / 最大）：

| 操作 | Phase 10c既報 | Phase 14 glow | Phase 14 block |
|---|---:|---:|---:|
| 価格ズーム | 10.49 / 47.90 | **52.77 / 350.70** | 15.23 / 50.90 |
| 価格を戻す | — | 42.38 / 363.80 | 11.30 / 24.10 |
| 時間ズーム | 9.80 / 28.30 | 15.28 / 79.80 | 12.32 / 40.90 |
| pan | 7.07 / 24.90 | 8.35 / 37.60 | 8.65 / 27.50 |
| 列追加を伴う更新（1倍リプレイ・17 depthフレーム） | — | 8.13 / 14.20 | 6.66 / 9.80 |

最後の行はライブ上流の実測ではなく、保存済み列の1倍配信による代替測定。板や約定のみの更新も同期間に届くので、純粋な「1列だけを追加する関数」の所要時間ではない。実ライブの測定は実施しないという条件を守った。

glowの価格ズーム平均52.77msのうち`colorMs`平均44.90ms。blockは1.33ms。ここに芯生成・全列の縦ぼかし・合成が含まれる。K/価格範囲の変更でキャッシュが使えなくなる。通常の新列時は近傍だけで済む一方、価格ズームは大きく重く、平均8ms/最大33msの目安を満たさない。指示どおり追加最適化は行っていない。

メモリ：

| 採取箇所 | サーバーRSS bytes | ブラウザJS heap used / total bytes |
|---|---:|---:|
| glow列追加サンプル | 456,916,992 | 35,067,279 / 69,109,435 |
| block列追加サンプル | 508,780,544 | 38,067,062 / 106,567,934 |
| 停止直前 | 652,890,112 | — |

サーバー採取最大RSS669,941,760 bytes。主要画面サンプルのJS heap used最大99,120,189 bytes。`performance.memory`はJSヒープであり、ブラウザ全体のRSSではない。GC時点や測定順も異なるため、この表だけでstyle別の総メモリ優劣を断定しない。公開実機のメモリ測定ではない。

## 設定復旧・終了

- 最終設定`data/phase14/settings-final.json`はversion4、全16項目が初期値。top5 / pct80 / γ0.5 / glow / bigOrdersVisible:false、旧2値10/.5。
- ツール用Chromium PID5038・5575・5771・6093はそれぞれ`exited:true`、CDPポート閉鎖を保存。自動撮影の別Chromiumも専用プロファイルを特定してSIGTERMで終了した。最後のプロセス一覧にChromium/Chrome残存なし。
- 停止前`/api/status`でNQPerf/HeadlessChromeの検証WSは0。残存1接続は別のWindows Chromeであり、検証ブラウザだとは扱わず、終了前に強制切断もしなかった。
- 2026-10-29 **21:30:19.650 JST**に開発PID4575へSIGTERM。ログの`server_stopped`は19.970、`upstream:"stopped"`・`httpClosed:true`、停止処理311.99ms。PID消滅を411ms後に確認し、HTTPポート閉鎖も確認。
- 上流は開始時から`upstream_disabled / production_only_rest_development`であり、今回上流WSを開いていない。そのため今回の上流closeイベントはない。
- 残った外部接続は終了処理でclose1001/shutdownを記録。開発受信プロセス停止済み。mockup-sandboxなど他のサービスは停止していない。

## 公開への反映とiPad

こちらから再Publish・公開先の設定操作は行っていない。性能と未解決事項を確認したうえで、反映する場合はユーザーが再Publishする。

公開側の設定は、v1〜3のGETでは退避/原本上書きをせずv4として返す。旧4値が1/off/20/1のままなら5/pct/80/.5へ、どれか変更済みなら4値すべて維持。次に保存したときのみファイルがv4になる。新2項目はglow/false。公開側の既存設定を確認し、必要なら設定画面で保存する。

iPadではglow/blockの価格ズーム・時間ズーム・panの追従、長時間表示時の発熱/メモリ、数字の重なり、glowの線/フェード、高DPRでの帯の終端、大口板出し入れ後のVPガイドを実機で確認してほしい。スマホ用レイアウトや長期VPは今回変更していない。
