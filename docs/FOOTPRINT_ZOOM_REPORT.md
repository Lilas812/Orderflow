# FOOTPRINT縮小表示・HEATMAP価格範囲の報告

2026-11-04。実装・再ビルド済み、未公開。基準HEADは `38a46afc4d549937512cbd72b09c620989b17a63`。今回の変更は未コミット差分であり、公開版の確認やGitHubへの追加pushはしていない。

## 報告

- **実施内容**：FOOTPRINTを縮小しても売り／買いの数字セルを維持する。選択足を下限とする自動時間足と、価格行の数量合算を追加。HEATMAPの縦範囲上限を8,000ティックへ拡張。
- **結果**：フロント191試験・サーバー317試験、両型検査、本番ビルドが成功。保存コピーの実ブラウザ表示・操作は後述。WebGL実描画はこの検証ブラウザで利用できず、GPUについては未確認。
- **範囲外**：公開、本番書込、保存形式・配信形式・サーバー設定・依存・Run設定の変更、既存受信の停止／再起動、開発上流接続、研究チャートの変更はしていない。

## 変更ファイル・関数

| ファイル | 変更 |
|---|---|
| `artifacts/heatmap/src/footprint/model.ts` | `DisplayTimeframe`／`DISPLAY_TIMEFRAMES`追加。`FootprintStore.setTimeframe()`が120／300／900秒も扱う。同じ秒単位ストアから構築し、サーバー要求形式は変更しない |
| `artifacts/heatmap/src/footprint/view.ts` | `adaptTime()`・`priceGroupTicks()`追加。`zoomTimeAt()`はアンカーを保って自動足切替。`zoomPriceAt()`・`clampView()`は実plot高から8,000ティックの下限rowHを決定 |
| `artifacts/heatmap/src/footprint/rows.ts` | `groupPriceRows()`。整数ティックの倍数へ揃え、売り・買い・Nを別々に合算。合計POCは同数なら高い行。元のバーを変更しない |
| `artifacts/heatmap/src/footprint/app.ts` | `drawSummaryBar()`を除去し常に数字セル。`drawDetailBar()`・カーソル・POCラベルは合算行を使用。OHLCは元価格座標。選択足と表示足・行幅を表示。描画済みバーからカーソルを取得し、バー単位WeakMapで行を再利用 |
| 同上 | `onMove`はピンチ中点の移動も補正。ピンチ終了の二つのpointerupをダブルタップ扱いしない。追従描画にも実plot高を渡す。価格目盛の間隔を拡張 |
| `artifacts/heatmap/src/footprint/footprint.css` | 表示足・行幅の表示、操作欄の折返し |
| `artifacts/heatmap/src/domain.ts`・`chart/coordinates.ts` | HEATMAPの価格範囲上限1,600→8,000。最小8は維持 |
| `artifacts/heatmap/src/chart/book-numbers.ts` | 今の板の数字の既存まとめ幅に400以上を追加し、低い画面でも11 CSS pxを確保 |
| `artifacts/heatmap/test/footprint-zoom.test.ts` | 新しい時間足・価格行・POC・数量・不完全性・アンカー・8,000上限の試験 |
| `artifacts/heatmap/test/footprint.test.ts`・`phase14.test.ts` | 今回変更した最小セル幅／拡張まとめ幅の期待値を更新 |
| `server/test/footprint-zoom-{fixture.ts,canvas.mjs,final.mjs}` | 保存コピーだけを使う隔離ハンドラー・Canvas測定・最終確認。製品サーバーではない |
| `server/test/footprint-cdp.mjs` | 検証ブラウザの任意起動引数を追加可能にした。既存呼出しの既定動作は維持 |
| `replit.md` | Current Statusのみ追記 |

行キャッシュはバーごとに現在のまとめ幅1個だけ。元バーをキーとするWeakMapなので、足切替・後着補正・保持範囲の破棄後に古いバーを永久保持しない。秒ストアの2時間／300,000件制限、履歴持替え・欠け判定は維持。

## 仕様との差分／仕様にない値

今回の指示による明示的な上書きであり、正本仕様の本文は変更していない。

1. 旧「縮小時にOHLCサマリーへ切替」「価格行をまとめない」を今回の数字セル・時間足・価格行合算へ変更。
2. 選択ボタンは5／15／30／60秒のまま。表示用は5／15／30／60／120／300／900秒。選択足が最小。セル幅28 CSS px×2＋OHLC6＋隙間3＝最小バー幅65 CSS px。900秒・65pxでさらに縮小しない。
3. 価格行は1／2／4／5／10／20／40／50／100／200ティックから、12 CSS px以上になる最小幅。**ユーザー承認により、足りない低画面では400／800…と拡張**する。
4. **ユーザー承認により、POCは買い＋売り＋方向不明Nの総数量**を使用する。Nは買い売りの色・deltaへ配分しない。同数量なら高い価格行。
5. 時間ズームはアンカー保持のため追従を解除する。追従ボタンで復帰可能。設定PUTやサーバー設定versionは増やさない。
6. ピンチは開始時の中央時刻を移動後の中点へ対応させ、指を離してもズームをリセットしない。endSecの既存1ms丸め精度内で確認。
7. HEATMAP最大8,000ティック。背景の数量集約・色基準・DPR上限・block／glow処理自体は変更しない。

## 確認手順

1. プレビューのHEATMAPからFOOTPRINTを開く（`/?view=footprint`）。NQ／GCを選ぶ。
2. 5秒を選び時間を縮小。「5秒（表示1分）」「5秒（表示5分）」等へ変わっても、左売り／右買いの数字が残ることを見る。拡大すると5秒へ戻る。
3. 価格軸のホイール／ドラッグ、またはShift＋ホイールで縮小。「1行4ティック」「1行20ティック」と価格幅を確認。カーソルはその行の下端〜上端と合算S／Bを表示する。
4. パン・ピンチでは指／カーソルの時刻を維持。追従ボタンで最新へ戻る。15秒を選んで自動5分にした場合も、再読込後は選択15秒・表示5分が残る。
5. HEATMAP価格軸を縮小すると8,000ティックまで。今の板の数字・価格軸・価格ライン・VPは同じ価格座標を使う。

## 実行した確認

```sh
pnpm --filter @workspace/heatmap run test
node --test --test-concurrency=1 server/test/*.test.ts
pnpm --filter @workspace/heatmap run typecheck
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver run build
node server/test/footprint-zoom-fixture.ts --port=18885
node server/test/footprint-zoom-canvas.mjs
node server/test/footprint-zoom-canvas.mjs --heatmap-only
# 旧fixture終了後、同じ保存入力で部分VPの表示完了状態も確認
node server/test/footprint-zoom-fixture.ts --port=18885 --partial-vp-ready
node server/test/footprint-zoom-final.mjs
```

- フロント191/191、サーバー317/317成功。型検査・本番ビルド成功。最後のカーソルPOCラベル変更後も両型検査・ビルド成功。合格済みのサーバー全試験を機械的に再実行していない。
- 最終成果物は `dist/public/assets/index-DIoP2R1N.js`、FOOTPRINT `app-kUT1K4BL.js` 等。ビルド済みであり公開済みではない。
- 単体試験：全7表示足の元秒からの数量・delta・OHLC・POC一致、履歴再採用で増えないこと、欠けの伝播、負価格を含む価格行の倍数、Nと同数POC、8,000上限、アンカーを確認。
- 実wheel：NQ／GCで5→15→30→60→120→300→900→5秒。さらに縮小しても900秒止まり。時刻アンカーの誤差は1ms以内。
- 実touch：5秒→15秒へ自動切替をまたいだピンチ。中点移動前後の対応をassertし、指を離す前後のviewは一致。
- 実寸390×500：innerWidth／innerHeightも390／500。plot高375、rowH=0.046875、8,000ティック、400ティック/行＝18.75px。
- NQ非ゼロカーソル：4ティック行117876〜117879はS7／B7。20ティック行117860〜117879もS7／B7。GCの20ティック行40200〜40219はS1／B2。独立に元バーから合計し一致。
- NQ／GCとも、選択15秒・表示300秒・follow=falseのまま実リロード。endSec・barW・rowH・中心価格を含むviewが一致。
- ネイティブ別タブを前景化してdocument.hidden=trueを確認。5.6秒間、描画5→5、barBuilds34→34、WSはconnectedのまま。復帰時に描画再開、閲覧view不変。
- 最終8,000ティック画面：部分VPはNQ48,995枚／385価格、GC5,019枚／99価格で入力と一致。今の板は200ティックまとめ、数字NQ9／GC14行。バブルNQ20／GC3個を確認。VPは**保存1時間だけの部分集計**であり、完全なセッションVPではない。
- 大口板は既存非表示設定を維持。集約・描画の既存試験は成功したが、今回の実画面で非ゼロの大口板を表示した確認はしていない。

### 保存入力・不完全性

既存読み取り専用コピー `data/gpu-heatmap/production-input/manifest.json` を再利用。SHA-256：

```
96d32874c3d19b3132fd8eb84bc78e4bd3e67465b09f25ce119f4f386a99fb4c
```

UTC 2026-10-29 17:42〜18:42、JST 10/30 02:42〜03:42。NQ44,975件48,995枚・3,387板列、GC4,650件5,019枚・3,212板列。板の欠けはNQ213秒／GC388秒。coverageも不完全で、元の欠けを埋めたり完全扱いしていない。原本10ファイルの個別ハッシュは`ui-result.json`と`canvas-heatmap-result.json`のinputsへ記録し、fixture起動時に照合した。

再生時計を保存範囲に固定したが、元約定時刻や板列時刻は変更していない。今の板は実在する最後の保存秒の代表板を使用し、秒内イベントを再現したとは扱わない。最終VP確認の`--partial-vp-ready`は、コピー内の部分集計が完了した試験状態を送るだけで、本番VPやcoverageを更新しない。

## Canvas負荷

Chrome 140.0.7339.16、1200×900、DPR1、固定保存入力。左右4 CSS pxのパンを交互に40回。FOOTPRINTは実Canvasを描くrAF全体、HEATMAPは背景更新を伴う実描画FrameProfile.totalMsを採取した。計算コアのベンチマークではない。ただしGPU完了のfence／画面提示遅延は測っていない。

### FOOTPRINT（ms、各40描画）

| 条件 | NQ p50 / p95 / 最大 | GC p50 / p95 / 最大 |
|---|---:|---:|
| 5秒・1ティック | 1.4 / 2.8 / 7.6 | 1.5 / 3.9 / 7.4 |
| 自動1分・1ティック | 1.9 / 4.3 / 6.2 | 5.2 / 7.5 / 12.8 |
| 自動5分・1ティック | 2.2 / 5.4 / 7.7 | 9.2 / 14.1 / 17.0 |
| 5秒・4ティック/行 | 1.2 / 3.4 / 3.8 | 1.5 / 2.7 / 4.0 |
| 5秒・20ティック/行 | 1.2 / 2.1 / 2.5 | 1.5 / 2.6 / 4.2 |
| 5秒・8,000ティック範囲 | 1.4 / 2.6 / 3.7 | 1.5 / 2.8 / 5.1 |

集約を変えても保存数量やOHLCは変更しない。数値は`canvas-result.json`のFOOTPRINT各行。最終のPOCラベル文言修正とピンチ解放ガードは、この描画集約アルゴリズムを変更していない。

### HEATMAP（実Canvas更新p95、ms）

600秒の同じ表示窓。中心は保存約定からNQ117878・GC40212ティックを採用。コピー内の数量と入力ファイルは同一。

| 要求・実バックエンド | NQ 1,600 → 8,000 | GC 1,600 → 8,000 |
|---|---:|---:|
| Canvas強制・実Canvas | 331.7 → 256.6 | 262.0 → 253.9 |
| WebGL要求・**実Canvas fallback** | 276.6 → 281.0 | 254.3 → 255.8 |

各45〜51背景更新。WebGL要求の行はGPU測定ではない。8,000化の大きな悪化はこの短時間比較では見られないが、**絶対値は約254〜332msと重い**。Canvas強制時の平均heatmapMsはNQ196.8→181.5ms、GC182.3→165.1msで、負荷の大半は背景側。公開CPUやライブ停止の解決、GPU高速化の証拠とは扱わない。保持期間や画面範囲を黙って減らす対応はしていない。

計測中は部分VPのloading=true状態。後続の`final-result.json`・画像では同じ数量の部分VPを表示完了させ、価格座標と数量を別途確認した。CPU時間・heap・個別描画サンプル・層別FrameProfileはJSONに保存。

初期試行で価格中心0の空表示を計測したHEATMAP値、および個別rAFを混ぜた旧値は採用していない。実データ価格へ中心を合わせ、履歴読込完了・数量ありをassertした`canvas-heatmap-result.json`が上表の採用結果。

## 画面・証拠

`data/footprint-zoom/`（生成物、Git管理外）：

- `NQ/GC-fp5-1-full.png`、`NQ/GC-fp60-1-full.png`、`NQ/GC-fp300-1-full.png`
- `NQ/GC-fp5-4-full.png`、`NQ/GC-fp5-20-full.png`
- `NQ/GC-cursor4-final.png`、`NQ/GC-cursor20-final.png`
- `GC-mobile-8000-full.png`
- `NQ/GC-heatmap1600-canvas-full.png`、`NQ/GC-heatmap8000-canvas-full.png`
- `NQ/GC-heatmap8000-overlays-final.png`：部分VP・今の板の数字・価格線・バブル・共通価格軸
- `ui-result.json`：初回確認。4ティック**の行幅**を4ティック**の表示範囲**と取り違えた記録と、実viewport未反映の記録は合格証拠に使用していない。後続の実寸・非ゼロカーソル・画像で確認を補完
- `canvas-result.json`、`canvas-heatmap-result.json`、`final-result.json`、`cleanup-final.json`

## 未解決・懸念

- **GPU実描画は未確認**。指定したChromiumではWebGL2コンテキストが得られず、通常起動・SwiftShader許可・ANGLE指定でもfallback。`?renderer=webgl`という要求だけでGPU使用済みとしない。実GPUが使える端末での同条件確認が残る。
- 実ライブ／公開先／実機Safari／DPR2・3／長時間負荷は未確認。今回の数字で公開の重さを解決したとは判断しない。
- コピーには元から欠けがあり、VPや足を完全値とは扱わない。非ゼロ大口板の実表示は別途確認余地がある。
- Canvas fallbackの絶対負荷は高い。次の候補は、実バックエンドと表示データの存在を確認したうえで、背景側の再集約・glow・画像転送を分離測定すること。今回は先回り実装しない。

## 終了確認・保全

- 検証ブラウザPID 18472／20613／21868／22370／22783／23217は消滅し、それぞれの専用profileを使うプロセスも0。page／contextだけを閉じたという報告ではない。
- 最終fixture PID23178はNQ／GCともWS0を確認してSIGTERM。`replay_stopped`、`peers:0`、`noUpstream:true`をログ確認。PID消滅・18885待受消滅も確認。前の所有fixture PID21828もSIGTERM終了を確認。
- 作成した上流接続は0。既存受信、ユーザーのブラウザ、公開先には停止操作をしていない。アクセス制限を追加していないので解除操作も不要。
- `docs/AGENT_RULES.md`／`SPEC.md`／`UI_SPEC_HEATMAP.md`／`FOOTPRINT_SPEC.md`の本文差分なし。既存の最新表示・CVD／VWAP・設定・LONG VP等の変更は保持。
- 戻す場合は今回のフロント差分を対象にする。保存形式・API・サーバー設定を変えていないのでデータ移行／削除は不要。作業中変更を一括resetしない。

## 公開前の短縮A/B確認

ユーザーの最新指示に従い長時間測定を中断。NQ・DPR2・Canvas・1200×900 CSS px、同じ保存コピー／10分表示窓で各30秒を1回、計5回。前版は`38a46afc4d549937512cbd72b09c620989b17a63`、今回版は`b8797306829687eb8e632a5b9556bd3218f41293`。両版を独立した一時ビルドへ展開し、稼働中のビルドは置換していない。ブラウザ起動引数も前回のCanvas測定と同一。4pxの往復パンを要求間隔200msで実ハンドラーへ入力し、実Canvas背景更新のFrameProfile.totalMsを採取。初期読込・4秒待機後の30秒が集計対象。

実行順は今回8,000→前160→今回160→前1,600→今回1,600で交互。中断した長時間測定や、起動引数が未一致だった準備試行の値は下表に含めない。

| 価格幅（ティック） | 前版p95（ms） | 今回版p95（ms） | 今回／前 | 描画サンプル数（前／今回） |
|---|---:|---:|---:|---:|
| 160 | 754.4 | 677.1 | 0.90倍 | 51／54 |
| 1,600 | 670.4 | 721.1 | 1.08倍 | 53／49 |
| 8,000 | 未対応 | 672.1 | — | —／53 |

**結論：差なし（指定基準の1.5倍以上の悪化なし）。** 大きな絶対値は前版にも存在する。環境だけが原因とまでは断定しないが、今回の変更による明らかな悪化は確認されない。製品コードの修正・公開はしていない。

証拠は`data/footprint-zoom-ab/run-1793728594303/short-{input,results,table,cleanup-final}.json`。全検証ブラウザのPID・専用profile残存0、NQ／GC両fixtureのWS0、所有fixtureをSIGTERM終了、18885／18886の待受消滅を確認。中断した長時間測定の所有プロセスも消滅。既存受信・公開先には停止や書込をしていない。
