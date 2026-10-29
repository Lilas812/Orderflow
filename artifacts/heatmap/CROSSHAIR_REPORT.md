# 十字カーソル 実装・開発確認

2026-10-29（JST）。対象はヒートマップと、追加承認されたLONG VPの十字カーソル。
公開・上流接続・集計形式・保存形式・設定項目/version・依存は変更していない。

## 報告

- **実施内容：** 両画面に独立した透明Canvasの十字カーソルを追加。カーソル位置の点線、縦軸の数値、時間軸の日付・時刻を表示。既存の操作・各画面の座標尺度・タイムゾーンを維持した。
- **変更ファイル：** 下記「実装」を参照。仕様書は許可された添付のCRLF→LF変換・配置だけ。Phase 14・履歴反映修正・設定計測を保持し、リセットや巻き戻しは行っていない。
- **確認手順：** 開発プレビューのHEATMAPで本体をマウス移動し、点線と両ラベル、領域外での消去を確認。LONG VPへ切り替え、価格チャートと週CVDで、それぞれ価格/CVD数値が出ることを確認。設定・画面切替で消えること、パン・ズームが維持されることを見る。添付の比較HTMLは検証時の静止画であり、操作画面ではない。公開先は未更新。
- **実行した確認：** フロント150/150試験、型検査・本番ビルド成功。CDP実ブラウザの隔離確認は両画面とも成功。下記にコマンド・値・終了記録を記載。
- **仕様との差分：** 機能上の既知の差分なし。ラベル高さは既存価格ラベルと同じ18 CSS pxを使い、軸が低い場合はその高さ以内とした。左右余白4pxを確保し、狭い縦軸では文字を軸内に収める。これは設定にはしていない。
- **未解決・懸念：** Safari/iPad/iPhoneの実機確認は未実施。ライブ追従はダミー下流に実保存列を順に渡して確認しており、実上流のライブ受信試験ではない。LONG VPは明示した架空データでの確認で、本番蓄積の完全性を検証したものではない。長時間CPU調査・保留中のglow追加確認は行っていない。
- **次の候補：** ユーザーによる再Publish後の実機確認。今回は実施しない。Phase 11/15等には進まない。

## 1. 事前状態・仕様書の配置

最初の作業確認時HEADは `60a36c94121dbb935a92ef95c4ea774b87b4f60f`。
前回公開候補を現在HEADとは仮定せず、既存変更を保持した。

最初のUI添付はCRLFのため、そのままでは指定値と不一致だった。
ユーザーの「改行コードだけCRLFからLFへ変換」の許可後、指定値
`3102939f5c52e2a7640eff04d8f166d319678f3cfa7f3e55375f9083b2ee3111` と一致を確認した。
その後、LONG VPも含む新しい2仕様への差し替え・実装の追加許可を受け、以下を配置した。

| 元の添付 | 配置先 |
| --- | --- |
| `attached_assets/Pasted--UI-SPEC-HEATMAP-md-UI-2026-10-29-5-1-LONG-VP--17932824_1793282400663.txt` | `docs/UI_SPEC_HEATMAP.md` |
| `attached_assets/Pasted--LONGVP-SPEC-md-VP-2026-10-29-4-8--1793282409310_1793282409310.txt` | `docs/LONGVP_SPEC.md` |

いずれもCRLF→LF以外は変更していない。添付自体は削除していない。
最終的な `sha256sum` 出力：

```text
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
23eb7cfe95e5c9bd606184d45721a007ff6ba246063eb8d4894dd230058c807b  docs/SPEC.md
ffc24df37acbecf9a75cfe3c9ac8edc515d27650f0087cacc7169f3ecd0f0502  docs/UI_SPEC_HEATMAP.md
eeb864a726db7d88ea184be56d18263fe2a22f1ceaa12b2c2aae797a03738e1e  docs/LONGVP_SPEC.md
```

AGENT_RULES/SPECは不変。最新版のUI 5.1・LONGVP 4.8を実装対象とした。

## 2. 実装

### ヒートマップ

- `src/chart/crosshair.ts`
  - `crosshairValues`：既存の `xToTimeUs` / `yToPriceTicks` / `formatPrice` を利用。価格は整数ティックへ丸めて0.25刻み、時刻は属する秒へ切り捨てる。データを参照せず空白にも表示する。
  - `fitCursorLabel`：文字幅と左右4px、軸の実寸からラベルの矩形を制限。点線・値は動かさない。
  - `CrosshairOverlay`：board全体の透明Canvas。水平線は本体内、垂直線は本体からデルタを通り時間軸直前まで。価格軸・時間軸のラベルも同じ専用層。`pointer-events:none`・z-index 10で既存の数字・バブル・ラベルより上。
  - `request` / `draw`：最新のclient座標を保持し、pending RAFは1つだけ。現在のrect/view/zone/DPRが同じなら再描画も省略する。自身を繰り返すループはない。
  - `hide`：leave/cancel/blur/pagehide/タブ非表示/設定/画面切替で点線とラベルを一緒に消去。タッチで常駐させない。
- `src/chart/timezone.ts`：`formatCrosshairTimeUs`。既存DisplayZoneに従うIANAタイムゾーンで `MM/DD HH:mm:ss`、24時間表示。月日・DSTもIntlを使用。
- `src/main.ts`：専用層を接続。既存描画完了・時間軸更新時に現在の座標で更新し、設定表示時に消去。debug時だけスナップショットを追加。
- `src/index.css`：専用Canvasの重なり順・入力透過を指定。

カーソルの移動処理は、LayerScheduler・キャッシュ・通信クライアントにアクセスしない。
既存pointer/wheel/double-click/touchの入力ハンドラは置換していない。

### LONG VP

- `src/long-vp/crosshair.ts`
  - `longVpCursor`：LONG VPの `LvView`（秒、調整後ティック）とlayoutから逆変換。ヒートマップ用viewportを使用せず、限月差を再適用しない。
  - `cvdScale` / `cvdY`：既存の可視CVDの最小/最大・8%余白・上下4pxを同じ変換にまとめ、通常描画とカーソルで共有。可視CVDの走査は通常描画時だけ。カーソルは保持されたスケールを逆変換し、整数へ丸める。
  - `LongVpCrosshair`：独立Canvas。縦線は価格チャートから共通時間軸まで、横線と数値ラベルはマウスのある段だけ。軸・段の境界±6px（既存divider操作領域）では非表示。専用RAFのまとめ・同一状態の省略・消去処理を持つ。
- `src/long-vp/app.ts`：描画後の更新・設定時の消去・destroy時の破棄を接続。debug時のみ通常描画/series/profile作成回数とカーソル状態を公開。

点線は両画面とも `rgba(235,232,245,0.65)`、1 CSS px、4/4 CSS px。
ラベルは背景#333333・文字#ffffff・等幅11 CSS px。価格/CVD/時刻の丸めは表示だけ。
通常の更新間隔、通信、集計結果、限月調整、設定schemaは変更していない。

### 試験・確認ツール

- `test/crosshair.test.ts`：座標、四分の一価格、属する秒、JST日付境界、CT夏時間終了、端のラベル、RAFまとめ、idle停止、view更新、消去。
- `test/long-vp-crosshair.test.ts`：調整後価格軸・秒尺度、CVDの順逆変換・負数、境界/軸除外、CVD非表示。
- `tools/crosshair-check.ts`：実保存データ・ダミー下流の実ブラウザ確認。
- `tools/long-vp-crosshair-check.ts`：架空日次データ・限月差+80tick・ローカルのダミー設定応答で実ブラウザ確認。

## 3. 実行コマンド・実際の結果

```text
pnpm --filter @workspace/heatmap test
  tests 150 / pass 150 / fail 0
pnpm --filter @workspace/heatmap typecheck
  成功
pnpm --filter @workspace/heatmap build
  成功、Vite 54 modules
node artifacts/heatmap/tools/crosshair-check.ts
  CROSSHAIR_BROWSER_PASSED
node artifacts/heatmap/tools/long-vp-crosshair-check.ts
  LONGVP_CROSSHAIR_PASSED
git diff --check
  指摘なし
```

サーバーコードは変更しておらず、サーバー全体テストは今回実行していない。
関連7試験の単独実行も成功した。

初期の試験ではNode strip-only非対応のparameter propertyで失敗し、通常フィールドへ修正した。
最初のブラウザ確認で不要なカーソル再描画を検出し、同一状態の省略を追加した。
次の追従確認は検証用rangeが未送信の未来列も返したため失敗した。製品コードではなく、ダミー下流の全range応答を同じ送信締切で制限してから最終確認が成功した。
失敗した記録も `data/crosshair/browser-check-first.json` / `browser-check-second.json` に残した。

## 4. 座標・操作の照合

### ヒートマップ（1280×800、DPR1/2）

既知位置：本体内 x=341.19781494140625、y=248.01593017578125。
view.startUs=1793021459869848、durationSec=600、centerPriceTicks=117318.5、span=160。
独立計算と表示が一致：

- 117330 tick → **29332.50**
- 1793021681000000μs → JST **10/26 22:34:41**

左右・上下端ではラベル矩形が各軸内。右の空白は最新列より未来の座標時刻となり、最新データへ吸着しない。
enter/move/leave、本体以外の軸・デルタ・VP・表示中の大口板への移動、設定表示、blur、タッチ、画面切替の消去を確認。
実ターゲット切替で `document.hidden:true`・visibilityイベント1回・カーソル非表示を確認。ハンドラの明示発火も確認。
時間ホイール、価格軸ドラッグ、パン、ダブルクリック、AUTO、大口板表示/CT変更、DPR2を確認。
カーソルの表示自体ではview/followが変わらない。

保存列5秒分の追加時、マウスを動かさずラベルと座標を再照合：

| ダミー下流モード | 追加前startUs | 追加後startUs | follow |
| --- | ---: | ---: | --- |
| replay | 1793021459925094 | 1793021465168539 | true維持 |
| live | 1793019061171367 | 1793019067028200 | true維持 |

### LONG VP（明示した架空データ）

NQZ26→NQH27の限月差+80tickを持つfixtureを使用。
調整後の表示範囲は priceLow=117272 / priceHigh=117323。カーソルの中央価格は **29324.50**。
週CVD中央は **-366**。どちらも現在の軸から独立計算して一致。
秒座標からの計算も一致し、両段の同じxで時刻 **10/22 14:44:54（CT）** が一致した。
ローソク足の実データ値やVPの価格へ吸着させていない。

時間ズーム、価格を含むパン、divider移動、週CVD off/on、ローソク足/線、週/日VP切替後の逆変換を確認。
軸・divider・時間軸での消去、設定、blur/visibilityハンドラ、タッチ、HEATMAPへ切替時の破棄を確認。
LONG VPのnative OSフォーカス切替をSafari実機で確認したものではない。

## 5. マウス移動だけの短区間

| 項目 | ヒートマップ | LONG VP |
| --- | --- | --- |
| 同期的に送った移動イベント | 100 | 100 |
| カーソル描画増分 | 1 | 1 |
| 通常描画 | depth/overlay/book/bigのカウンター不変 | baseDraws 2→2 |
| 再集計・再構築 | 大口板rebuildCount不変 | seriesBuilds 2→2、profileBuilds 2→2 |
| 通信 | fetch/下流要求数不変（4/1→4/1） | API要求5→5 |
| idle追加カーソル描画 | 0 | 0 |

ヒートマップ再色付け/glowはdepth描画から呼ばれるため、depthDrawCountが増えないことを確認した。
個々のglow内部関数へ追加の一時ログは入れていない。
LONG VPは通常Canvas描画が増えないため、期間VP・価格・VWAP・CVDの全体描画も増えていない。
通信カウンターは隔離ハーネスの観測であり、製品に通信や計測APIを追加していない。

## 6. 画像・証拠

`data/crosshair/comparison.html` は画像内包の比較HTML。

- `cursor-visible.png` / `cursor-hidden.png`：ヒートマップの表示/消去
- `cursor-dpr2.png`：DPR2
- `longvp-price-visible.png` / `longvp-cvd-visible.png`：価格/CVD
- `longvp-cursor-hidden.png` / `longvp-cvd-hidden.png`：消去/CVD off
- `browser-check.json` / `longvp-check.json`：最終ブラウザ照合・カウンター
- `comparison-preview.jpg`：画像比較HTML自体のプレビュー撮影。インタラクティブ確認の証拠は上のCDP記録・元画像である。

画像・試験出力は既存のGit/公開除外対象 `data/` に保存した。
プレビュー確認用に本番ビルド出力へ同じ比較HTMLも置いたが、アプリのソースやビルド手順へ組み込んでいない。

## 7. 終了・接続

- 最終ヒートマップ確認ブラウザ：`browser-check.json` のPIDで exited=true / portClosed=true。
- LONG VP確認ブラウザ：PID11695、exited=true / portClosed=true。実WebSocket生成0、実行例外0。
- 比較HTML撮影ブラウザ：専用profileの親PID11890へSIGTERM。そのprofileのChrome残存0を確認。
- 最後の `/api/status`：upstream=`stopped`、`phase2b.connected=0`、`connections=[]`。`data/crosshair/closure.json` に保存。
- 自分で新しい検証用受信サーバーは起動していない。既存開発サーバーは起動済みのまま保持し、再起動/停止していない。公開プロセスにも触れていない。
- 開発からTICK STREAMへ接続しておらず、上流closeイベントを発生させて確認したものではない。
- 外部接続制限は設定していない。解除する制限もない。
