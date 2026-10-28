# Phase 10c 報告

2026-10-28。開発環境のみ。公開先のコード・設定・保存データを変更せず、再Publishしていない。

## 報告

- 実施内容：ヒートマップの上限・下限・コントラスト、VPの3本の線・VA帯・価格ラベル、設定version 3／14項目を実装。指定仕様書の差し替え、単体試験、実保存データの1倍リプレイ、固定条件の描画計測を実施した。
- 変更ファイル：下表参照。追加依存なし。板の取得・配信形式・板／約定の保存形式は変更していない。
- 確認手順：ユーザーが再Publishした後、設定画面で各モードを切り替え、保存・再読込を確認する。VP全域を表示して3本の線と帯・ラベルを確認する。具体的には末尾参照。
- 実行した確認：サーバー118/118、画面112/112試験成功、両型検査成功、本番ビルド成功。実画面9場面と描画計測完了。設定初期値保存、ブラウザ終了、WS接続0、SIGTERM後の上流切断とプロセス消滅を確認した。
- 仕様との差分：機能の未実装なし。正本にない表示規則2点はユーザー承認に従った。描画性能の目安に未達項目がある。
- 未解決・懸念：ズーム平均8msの目安と、時間ズーム最大33msの目安は今回の測定で未達。公開実機の長時間安定性は未検証。停止時close 1006の原因は今回調査・修正していない。
- 次の候補：ユーザーによる再Publishと反映後の確認。今回の作業はここで停止し、Phase 10dに進まない。

## 1. 正本の差し替えとSHA-256

| 元の添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_1793159335865.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_1793159335865.md` | `docs/UI_SPEC_HEATMAP.md` |

添付のバイト列を変更せず配置。AGENT_RULESは差し替えていない。配置直後、および作業終了時に次の一致を確認した。

```text
b052d9bb527220a6d2fcc447df5ca958bbc0859d9974dad67f841363c0535853  docs/SPEC.md
6294e6c12786c40abe22e1329118eea1be5011c6b9997e6fcb60fe91a9b1e1bd  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

削除した添付（指定されたSPEC／UI_SPECで始まる.mdのみ）：

- `attached_assets/SPEC_1793159335865.md`
- `attached_assets/UI_SPEC_HEATMAP_1793159335865.md`

今回の作業指示の添付は残した。仕様は配置後の正本だけを参照した。

## 2. 変更ファイルと役割

| ファイル | 主な関数・変更 |
| --- | --- |
| `docs/SPEC.md`、`docs/UI_SPEC_HEATMAP.md` | 許可された添付への完全差し替えのみ。 |
| `server/src/settings/schema.ts` | `defaults`、`validateSettings`、`readDocument`など。14項目、version 3、厳密な旧v1/v2読込と初期値補完。 |
| `server/src/settings/local.ts` | 初期文書とPUTの保存をversion 3に変更。 |
| `server/test/settings.test.ts` | 保存・初期文書のversion 3期待値。 |
| `server/test/settings-v2.test.ts` | 旧v1読込後の正規化・保存先version 3を確認。 |
| `server/test/settings-v3.test.ts` | 旧文書の互換性、追加6項目の型・境界・刻み・モードの検査。 |
| `server/test/app-storage.test.ts` | ダミーの`prod/settings.json`に置いたv2を、退避・再アップロード・原文書変更なしで読めること、PUT時v3化を追加確認。 |
| `artifacts/heatmap/src/data/settings.ts` | 14項目の型・初期値・検査・`settingsChanges`。 |
| `artifacts/heatmap/src/components/settings-form.ts` | `FIELD_SPECS`、`fieldVisible`、`parseInputs`。モード選択と入力欄の切替。 |
| `artifacts/heatmap/src/components/settings-ui.ts` | 選択欄と条件付き表示。非表示にしても入力値を保持し保存する。 |
| `artifacts/heatmap/src/components/settings-ui.css` | 非表示設定欄のレイアウト。 |
| `artifacts/heatmap/src/chart/scale.ts` | `heatThresholds`、`viewportPositivePercentile`。可視範囲の正のセルだけでU・Loを計算。 |
| `artifacts/heatmap/src/chart/renderer.ts` | `setScaleOptions`、`draw`、`colorize`。閾値・補正・ガンマ、基準計算は1秒に1回まで。初期の可視範囲外chunkでは自動Uを1に固定しない既存挙動を維持。 |
| `artifacts/heatmap/src/chart/current-book.ts` | `draw`にLo・gammaを共有。色の帯は同じLUT、棒の長さはUだけを使用。 |
| `artifacts/heatmap/src/chart/vp-decoration.ts` | `vpPriceRow`、`vpBandBounds`、`vpGuides`、`drawVpGuides`、`drawVpLabels`。物理画素行と価格ラベルの独立描画。 |
| `artifacts/heatmap/src/chart/vp.ts` | `draw`でVP内のVA背景を棒より下へ描き、独立Canvasの線・ラベルを更新する。 |
| `artifacts/heatmap/src/main.ts` | 装飾Canvasの接続、U・Loの凡例、補正時debug文言、設定反映。 |
| `artifacts/heatmap/src/index.css` | 線を大口板列〜VPだけに重ねる。ラベルの重なり順。 |
| `artifacts/heatmap/test/phase10c.test.ts` | 色・閾値・現在板・VP位置／帯／線／ラベル・設定の7試験。 |
| `artifacts/heatmap/test/phase9-revise.test.ts` | 項目数を14に更新。色帯背景の黒と売買棒を区別し、既存の描画順序検査を維持。 |
| `artifacts/heatmap/tools/phase10c-check.ts` | 実APIと実保存リプレイによる操作・撮影・保存／再読込・寸法・初期値復元・ブラウザ終了の確認。依存追加なし。 |
| `artifacts/heatmap/PHASE10C_REPORT.md` | 本報告。 |
| `replit.md` | Current Statusへの今回結果の追記のみ。 |
| `.agents/memory/MEMORY.md`、`performance-budget.md`、`vp-decoration-decisions.md` | 公開容量の古い前提の整理、今回承認された表示規則の保持。 |

### 線と帯の層

- `#vp-guides`はボードの3〜4列目（大口板・VP）、1行目だけに置く独立Canvas。枠線の内側とVP本体Canvasの上下端を一致させた。線はz-index 2で大口板の棒より上に重ねる。
- `#vp-labels`は価格軸の独立Canvas。z-index 1、既存現在値ラベルは2。中ではVAL→VAH→POCの順に描くため、POCがVAラベルより上、現在値が全てより上になる。
- VAの背景はVP自身のCanvasだけにalpha 0.12で描き、その後に棒を描く。大口板列・価格軸・ヒートマップへ背景を広げない。
- VP単独更新はこの3つのCanvasを更新するだけで、大口板の棒のCanvasは描き直さない。既存の層スケジューラの単体試験も成功。

## 3. テスト・型検査・ビルド

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter @workspace/receiver test` | 118/118成功。 |
| `pnpm --filter @workspace/heatmap test` | 112/112成功。 |
| `pnpm --filter @workspace/receiver typecheck` | 成功。 |
| `pnpm --filter @workspace/heatmap typecheck` | 成功。 |
| 管理workflowによる`pnpm --filter @workspace/receiver run build` | フロント本番ビルド成功。 |
| `pnpm --filter @workspace/heatmap build` | CSS調整後の最終本番ビルド成功。35 modules、403msの初回ビルドを含む。 |
| `node --check artifacts/heatmap/tools/phase10c-check.ts` | 成功。 |
| `node artifacts/heatmap/tools/phase10c-check.ts` | 最終実行`PHASE10C_CHECK_PASSED`。9場面完了。 |
| `node server/tools/perf/render-benchmark.ts phase10c-final artifacts/heatmap/dist/public 1793021400135557 data/phase7/benchmark-vp.json data/phase10c/benchmark-settings.json` | 5場面完了。終了証拠を保存。 |

検査内容：

- U自動／枚数固定、Loなし／下位％／枚数、Lo以下の非着色、Lo≥UでU−1へ補正。
- gamma=1の既存色回帰、0.5／2のLUT位置、現在板の色帯と一致、棒の長さがLo／gammaで変わらないこと。
- VPの線の座標・全幅・2/2点線・色／alpha、帯のクリップと端の行、ラベルの文字サイズ・POC最上位の描画順。
- 6設定の型・モード・境界・刻み、旧v1/v2の初期値補完・原文書不変、ダミーApp Storageでのv2読込後の退避／uploadなし。
- 実UIで未使用の`heatUpperSize=42`・`heatLowerSize=88`を非表示にして保存、再読込後にモードを戻して値が残ること。
- 実UIでU=42、Lo=88を指定し、debugの「下限を上限の手前に合わせた」を確認。
- 最終的に初期値14項目を保存し、GET結果がサーバーの`defaults`と完全一致すること。

初回の確認補助でVP CanvasのIDを誤記して停止したが、finallyで初期値復元とブラウザ終了を実施した。その後、実寸法検査で今回追加したCSSの行終端とラベル優先度を修正。最終の全9場面は修正後の本番ビルドで撮り直し、正常完了した。旧フレームだけを確認済みとして流用していない。

生結果：`data/phase10c/`の`server-tests.log`、`web-tests.log`、`server-types.log`、`web-types.log`、`build.log`、`browser-checks.json`、`browser-check.log`。

## 4. 実保存データの1倍リプレイ

`?mode=replay&from=1793022000&speed=1&debug=1`を開発サーバーで操作した。実際のWSと保存データを使用し、合成データを混ぜていない。再生時刻が進んだことも検査した。

比較ページ：[`data/phase10c/comparison.html`](../../data/phase10c/comparison.html)。画像を埋め込んだ単独HTMLで、6設定とVPの拡大／縮小を並べている。再生は進行するため撮影時刻が異なり、同一フレームの厳密な画素比較ではない。

| 画像（`data/phase10c/`） | 条件 |
| --- | --- |
| `01-default.png` | 初期値。 |
| `02-upper-size.png` | U=100枚に固定、Loなし、gamma=1。 |
| `03-lower-pct.png` | U自動、Lo下位20%、gamma=1。 |
| `04-lower-size.png` | U自動、Lo=5枚、gamma=1。 |
| `05-gamma-half.png` | U自動、Loなし、gamma=0.5。 |
| `06-gamma-two.png` | U自動、Loなし、gamma=2。 |
| `07-lower-clamp.png` | U=42、Lo=88を指定した補正のdebug。 |
| `08-vp-expanded.png` | 650tick表示。VA全域と3本の線・ラベルが画面内。1価格が1物理画素より大きい。 |
| `09-vp-compressed.png` | 1,300tick表示。1価格が1物理画素より小さい。 |

基本6設定と補正は1280×800 CSS px・DPR1。VP2枚はVA全域を拡大状態でも収めるため1280×1000 CSS px・DPR1。価格軸の実ドラッグで650→1,300tickへ変更し、内部状態を書き換えるデバッグsetterは足していない。

VP装飾のCanvasについて、実DOMで次を検査した：高さ・上端がVP本体と同じ、左端が大口板Canvasと同じ、右端がVP本体の右端と1px未満の差。ラベルz-index 1／現在値2も確認。

別途、共有プレビュー経路`http://127.0.0.1:80/`でも撮影し、画面とWS接続を確認した（`preview-final.jpg`）。この画像は初期rangeを読み込み中のため、完成表示の証拠は上記9枚と`browser-checks.json`とする。

## 5. 9改と同条件の描画時間

受信サーバー停止後、実保存データの固定フィクスチャで計測。画面・consoleに「ダミー接続 · 実保存データの固定再生」を表示した。上記の実WSリプレイとは別の測定。

- 5,689列・71,245約定、VP756価格／出来高78,250。
- 1280×800 CSS px・DPR1、時間幅600秒、中心117244.5tick・価格幅160tick。
- 9改と同じスクリプト・ドラッグ／wheel操作。初期設定をv3にした以外、固定入力と操作は同じ。
- 要求した左端1793021400135557µsに対する実際の差は0.0903724px。9改と同じ。

全フレームの平均／最大（ms）：

| 操作 | 9改 平均／最大 | 今回 平均／最大 | 今回frame数 |
| --- | ---: | ---: | ---: |
| 価格ズーム | 10.50 / 37.70 | **11.33 / 32.80** | 62 |
| 時間ズーム | 9.68 / 24.70 | **10.99 / 38.50** | 87 |
| pan | 7.23 / 23.10 | **6.90 / 16.30** | 121 |
| 価格リセット（参考） | 10.30 / 23.20 | 10.23 / 17.20 | 64 |

steadyは0フレームなので平均・最大を0msとして性能評価しない。操作を同じにしてもrequestAnimationFrameの発火数は異なり、価格ズームは前回63／今回62frameだった。

**平均8msの目安は価格・時間ズームで未達。最大33msの目安は時間ズームで未達。** 別時刻の単回測定のため、差を今回の実装だけの因果効果とは断定しない。範囲外の性能改善は実施していない。

生フレーム・場面画像・左端一致・ブラウザ終了証拠：`data/perf-memory/phase10c-final/render-static/`。集計：`data/phase10c/render-summary.json`。

## 6. メモリ・設定復元・停止・ブラウザ終了

`/api/status.memory`の採取値：

| 時点 | RSS (B) | heapUsed (B) | external (B) | 累積RSS最大 (B) |
| --- | ---: | ---: | ---: | ---: |
| 確認前 | 380,252,160 | 24,389,560 | 15,075,931 | 381,681,664 |
| SIGTERM直前 | 535,797,760 | 27,323,392 | 25,771,163 | 580,550,656 |

これはWorkspaceの開発受信サーバーの値で、公開共有2GiB環境の実測ではない。履歴取得も動いていたため、設定追加だけによるメモリ増加とは判断しない。初回の3時間バックフィルは180窓中92窓で停止しており、その完了やライブVPの全履歴取込は今回の確認項目としていない。

- 最終GETはversion 3、全14値が初期値と一致（`browser-checks.json.restored`）。ブラウザ内の未使用値保存テスト後も初期値へ戻した。
- 開発受信サーバーはPID **12810**の1つだけ。公開側の接続を停止・変更していない。測定中の外部WS拒否も追加していないので、解除すべき制限はない。
- 実UI確認ブラウザはfinallyで`Browser.close`し、PID終了・CDPポート閉鎖を確認。
- 共有プレビュー撮影後には、ページWSは0でも撮影用Chromiumプロセスが残ったため終了させた。`screenshot-browser-closed.json`は終了対象PID、survivors空、WS接続0を記録。
- SIGTERM直前は`/api/ws`接続0、一覧空。`sendErrors=0`、`slowClosed=0`、上流`reconnectCount=0`。
- **15:12:06.102 JST**にSIGTERM。上流close要求1000→**15:12:06.250**にclose **1006**（`wasClean:false`、`reason:shutdown`）→`upstream_stopped socketClosed:true`。closing中のnetwork_errorも記録し、正常な1000応答が返ったとは扱わない。
- `server_stopped`は15:12:06.574 JST、`httpClosed:true`、ログ上471.52ms。外からのPID消滅確認はSIGTERMから**503.32ms**。期限延長や再起動はしていない。
- 固定描画計測ブラウザPID **13790**も終了、CDPポート閉鎖を確認。最終`final-process-check.json`は実行中Chromium **0**、受信PID消滅。サーバー停止後なので最終WSは0で、追加の受信は続けていない。

証拠：`status-before.json`、`status-before-stop.json`、`browser-checks.json`、`screenshot-browser-closed.json`、`server-stopped.json`、`shutdown-events.log`、`final-process-check.json`。

## 7. 仕様にない値・規則（ユーザー承認）

1. VP価格ラベルの高さは、既存現在値ラベルと同じ**18 CSS px**。画面端では内側へ寄せる。文字は正本どおり11 CSS px。
2. **拡大時もVAH・VALの価格行全体**をVA背景に含める。縮小時も正本の指定どおり両価格を含む物理画素行まで塗る。

その他の設定値・範囲・色・alpha・点線は正本どおり。比較用の100枚／5枚は仕様の初期値、650／1,300tickは撮影時の表示範囲であり、新しい製品設定ではない。

## 8. 再Publishと反映後の確認

再Publishはユーザーが行う。今回Agentは公開操作をしていない。

1. 既存の公開アプリを再Publishする。共有2GiB・既存のアクセス保護・Secrets・App Storage設定は変更しない。
2. 公開画面を再読込し、設定に上限モード／枚数、下限モード／％／枚数、コントラストが現れることを確認する。
3. 保存済みv2がある場合、初期の読込では補完して表示されるが退避・書換はしない。保存操作後はv3になる。
4. U固定、下限20%／5枚、gamma 0.5／2を確認。モードを戻しても未使用側の値が残ること、現在板の棒の長さが下限／gammaだけでは変わらないことを確認する。
5. VPのVA全域が入る価格幅に調整し、POC白／VAH・VALオレンジの点線が大口板〜VPだけにあり、帯はVPの中だけ、価格ラベルは現在値が最優先であることを確認する。
6. `/api/status`に設定の読込・保存エラーや退避が意図せず増えていないことを確認する。公開実機のRSSや長時間安定性は別途判断する。

開発workflowは指示どおり停止済み。開発画面を再度使う場合はRunが必要。

## 9. replit.md Current Status追記

2026-10-28：Phase 10cの閾値・コントラスト、VP装飾、設定v3／14項目を実装。正本2件を指定ハッシュで差し替え。サーバー118／画面112試験、型検査・本番ビルド、実1倍リプレイ9場面と9改同条件の描画計測を実施。ズーム性能の目安に一部未達。初期値保存、WS0、ブラウザ0、SIGTERM後上流close1006／socketClosed・PID消滅確認。詳細は本報告。再PublishとPhase 10dは未実施。

## 10. 新版指示の再受領と型検査での停止（2026-10-29 JST）

### 報告

- 実施内容：今回の添付2件を、バイト列を変えず正本へ差し替えた。今回版と前版の差分はPhase 11のバブル設定・軸操作と、その説明・履歴。Phase 10cの閾値・VP装飾の仕様に変更はない。既存の実装を再確認したが、フロント型検査が不合格となったため、完了として扱わず停止した。
- 変更ファイル：`docs/SPEC.md`・`docs/UI_SPEC_HEATMAP.md` は許可された完全コピー。本報告の追記と `replit.md` のCurrent Statusのみ。アプリ・テスト・依存・起動設定・本番は未変更。
- 確認手順：`pnpm --filter @workspace/heatmap typecheck` で下記の5件を再現する。修正には許可が必要。今回新たに添付されたPhase 11は「Phase 10cが終わっていなければ作業せず報告」という条件なので未着手。
- 実行した確認：サーバー133/133・画面112/112の単体テスト成功。サーバー型検査成功。画面型検査は5件のTS2345で失敗。今回の本番ビルド・実画面撮影・描画性能測定は未実行。上記の以前の成功記録を今回の確認結果として流用しない。
- 仕様との差分：設定は指示どおり14項目・version 3のまま。20項目・version 4・軸の自動調整・見出し開閉はPhase 11として未着手。新たな製品の具体値を独自に決めていない。
- 未解決・懸念：`artifacts/heatmap/test/phase10c.test.ts` の2つのダミーVAオブジェクトに、`valueArea` の戻り値型が必須とする `included` がない。`vpBandBounds`・`vpGuides`・`drawVpGuides`・`drawVpLabels` への引数として合計5件のエラー。単体テストの成功と型検査の成功は別であり、今回は後者を満たさない。
- 次の候補：テスト用データの必須項目を補う最小修正を承認後に行い、型検査・本番ビルド・残りの画面確認を進める。描画ロジックや期待値・型の検査を緩めて隠す修正はしない。

### 仕様の配置と削除

| 元添付 | 配置先 |
|---|---|
| `attached_assets/SPEC_(16)_1793214638919.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(9)_1793214637536.md` | `docs/UI_SPEC_HEATMAP.md` |

配置直後の実行結果：

```text
7ab50532153f7295c7cf2ebc8f6690fc3774aef266a31f52d37358f9db2a3f2e  docs/SPEC.md
bb3a850c47407bb74ed9dd65bd2984d8315ef1f25d986559fea7ae772f7efd39  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

3件とも指定値と一致。AGENT_RULESは変更なし。配置・確認後、上表の添付2件だけを削除した。検索時にほかのSPEC・UI_SPECで始まる.mdはなく、削除後もなし。作業指示の添付は残した。

### 停止・接続・メモリの確認

今回、ブラウザは起動していない。ローカルChromium検索結果0。既存開発サーバーPID436へSIGTERMを送り、PID消滅・25028のHTTP接続拒否・workflow `finished` を確認した。停止前の下流はユーザー側Windows Chromeの2接続で、今回の検証ブラウザではない。終了ログの `hub_closed` と `server_stopped`、HTTPポート閉鎖により残存受信接続がないことを確認。ユーザーのブラウザプロセスを終了してはいない。

上流は起動時から `state:stopped`・`connectedAtUs:null`・`reconnectCount:0`。前回の「上流WSは本番だけ」という指定を維持しており、開発から上流へ接続していない。そのため今回の上流closeイベントはない。終了ログは `upstream:stopped, httpClosed:true, elapsedMs:295.71677`。

停止前HTTP状態値のメモリ：RSS 386,768,896 B、起動以来最大RSS 400,277,504 B、heapUsed 29,312,600 B。これは描画測定時の値ではない。接続制限は使用していない。設定の変更・PUTはしていないため、今回の初期値復元保存も未実行。

今回の検証ログは `/tmp/phase10c-repeat-server-tests.log` と `/tmp/phase10c-repeat-web-tests.log`。型検査の失敗は本節のコマンドで再現可能。再Publishは未実施であり、この型検査の修正前にPhase 10c完了とは報告しない。

## 11. 承認後の最小修正と確認完了（2026-10-29 JST）

本節が今回の最終結果。10節の型検査失敗と保留は、解決前の経緯として残す。

### 報告

- 実施内容：ユーザーの「Phase 10cを完了」の承認後、ダミーVAデータ2か所だけを修正。型検査・本番ビルド、実保存データの1倍リプレイ9場面、設定保持と初期値復元、9改と同条件の固定描画計測を完了した。
- 変更ファイル：実コードの差分は `artifacts/heatmap/test/phase10c.test.ts` の2行のみ。`included:70` と `included:100` を補った。期待値、描画処理、型定義の検査を緩めていない。本報告と `replit.md` のCurrent Statusを追記。正本の配置と添付2件の削除は10節のとおり。追加依存なし。
- 確認手順：既存Runを起動し、保存済みの `/?mode=replay&from=1793022000&speed=1&debug=1` で設定を切り替える。今回の画像集は `data/phase10c-repeat/screenshots.html`、各PNG・結果は同じディレクトリ。公開への反映が必要ならユーザーが再Publishし、8節の項目を確認する。Agentは再Publishしていない。
- 実行した確認：画面112/112テスト、画面型検査、本番ビルド、`PHASE10C_CHECK_PASSED`、固定描画5場面が成功。サーバー133/133とサーバー型検査は直前の再受領時に成功しており、サーバーコードはその後変更していない。
- 仕様との差分：設定14項目・version 3を維持。Phase 11の20項目・version 4・バブル集約設定・軸の自動調整・見出し開閉は未実装のまま。機能確認は完了したが、下記の描画性能の目安に一部未達。
- 未解決・懸念：価格・時間ズームの平均8ms、価格ズームの最大33msの目安に未達。リプレイVPに保存されていない時間帯がある。本番実機・実機Safari・高DPR・長時間安定性の新たな確認はしていない。性能や欠損を隠す変更はしていない。
- 次の候補：Phase 11は別タスクとして扱う。Phase 12aは以前の「上流WSは本番だけ」と開発ライブ測定の条件を確認してから。今回はどちらにも着手せず、ここで停止する。

### 11.1 検査コマンドと結果

| コマンド・手順 | 結果 |
|---|---|
| `pnpm --filter @workspace/receiver test` | 直前の再受領時に133/133成功。以後、サーバー変更なし。 |
| `pnpm --filter @workspace/receiver typecheck` | 同じく成功。以後、サーバー変更なし。 |
| `pnpm --filter @workspace/heatmap test` | 最小修正後に112/112成功。 |
| `pnpm --filter @workspace/heatmap typecheck` | 最小修正後に成功。10節のTS2345×5は解消。 |
| 既存管理workflowの `pnpm --filter @workspace/receiver run build` | 成功。35 modules、559ms。Runコマンドは変更なし。 |
| 既存 `phase10c-check.ts` の実行 | `PHASE10C_CHECK_PASSED`。出力先だけ `data/phase10c-repeat/` に変更してメモリ上で実行。既存ツールのファイル自体は変更なし。 |
| `node server/tools/perf/render-benchmark.ts phase10c-repeat artifacts/heatmap/dist/public 1793021400135557 data/phase7/benchmark-vp.json data/phase10c-repeat/benchmark-settings.json` | 5場面完了。 |
| `git diff --check` | 成功。 |

過去の `data/phase10c/` の証拠を上書きせず、今回の結果を別ディレクトリに保存した。比較画像は外部通信しない自己完結HTMLとして作成し、依存は追加していない。

### 11.2 実1倍リプレイの9場面

| PNG | 確認結果 |
|---|---|
| `01-default.png` | 上限自動・下限なし・gamma 1。 |
| `02-upper-size.png` | 上限100枚を設定・保存して反映。 |
| `03-lower-pct.png` | 下限を下位20％にして反映。 |
| `04-lower-size.png` | 下限5枚を設定・保存して反映。 |
| `05-gamma-half.png` | gamma 0.5を反映。 |
| `06-gamma-two.png` | gamma 2を反映。 |
| `07-lower-clamp.png` | U=42、Lo=88の補正文言を確認。この1枚は再読み込み途中（VP価格0・loadingRanges 1）で、描画完了の証拠とはしない。 |
| `08-vp-expanded.png` | 約650tick。VA全域が収まり、3本の線・帯・ラベルを確認。 |
| `09-vp-compressed.png` | 約1300tick。1物理画素に複数価格が入る状態を確認。 |

画像は `data/phase10c-repeat/` に保存。最初の6枚は1280×800 CSS px、VP2枚は1280×1000 CSS px、いずれもDPR1。最初の6枚とVP2枚はloadingRanges 0・VP756価格を確認。通常場面の再生位置は1793022003→1793022012秒へ進み、speed=1で再生していることを確認した。別時刻の画像なので、同時刻の画素差による比較とは扱わない。

U=42・Lo=88をモードで隠して保存し、再読込後も値が残ることを確認。線のCanvasの上端・高さ・左右端と、ラベル／現在値のz-indexも実DOMで検査した。Runtime例外は0。線と帯の層は2節のとおり変更していない。

共有プレビューの別撮影 `preview-current.jpg` は初期range読み込み中であり、完成表示の証拠は上記8枚と `browser-checks.json` を用いる。

リプレイログに `vp_replay_gap`（1792965600〜1793016308秒）がある。今回は手元の保存済み部分を描いており、セッション全履歴が完全であることは主張しない。REST補完・保存方式の変更は今回行っていない。

### 11.3 描画時間

受信サーバーをSIGTERMで終了し、画面・consoleに「ダミー接続 · 実保存データの固定再生」と表示する既存フィクスチャで測定した。実WSリプレイと混ぜていない。9改と同じ固定データ・1280×800・DPR1・600秒・中心117244.5tick・価格幅160tick・操作スクリプトを使用。左端一致の差は0.0903724px。使った設定は復元済みのversion 3初期値。

全フレームの描画時間（ms）：

| 操作 | 9改 平均／最大 | 今回 平均／最大 | frame数 |
|---|---:|---:|---:|
| 価格ズーム | 10.50 / 37.70 | **10.49 / 47.90** | 63 |
| 時間ズーム | 9.68 / 24.70 | **9.80 / 28.30** | 86 |
| pan | 7.23 / 23.10 | **7.07 / 24.90** | 120 |
| 価格リセット（参考） | 10.30 / 23.20 | 9.27 / 15.10 | 64 |

steadyは1フレーム・1.10msのみで、安定した平均性能の評価には使わない。価格・時間ズームの平均8msと、価格ズームの最大33msの目安は未達。今回は本体の実装を変えておらず、別時刻の単回測定であるため、差の原因を型修正と結びつけない。

証拠：`data/perf-memory/phase10c-repeat/render-static/frames.json`・各PNG・`viewport-match.json`、`data/phase10c-repeat/render-summary.json`。

### 11.4 設定復元、メモリ、ブラウザとサーバーの終了

最終GETはversion 3。全14項目がサーバーの初期値と完全一致し、`updatedAt:1793215306458000` で保存済み。

| 時点 | RSS (B) | heapUsed (B) | external (B) | 起動以来最大RSS (B) |
|---|---:|---:|---:|---:|
| UI確認前 | 430,186,496 | 66,156,376 | 11,565,405 | 430,186,496 |
| SIGTERM直前 | 515,907,584 | 54,841,816 | 11,238,320 | 519,614,464 |

Workspaceの値であり、公開2GiB実機の値ではない。UI確認中は、ユーザー側Windows Chromeの外部2接続と測定1接続があった。これは「単一画面のサーバー負荷」として評価しない。固定描画計測はサーバーを止めてから行い、外部接続の影響を分離した。外部接続拒否は使っていないため、解除する制限はない。

- UI確認のChromium PID2326：`exited:true`・CDP9222閉鎖をfinallyで確認。
- 共有プレビュー撮影が残したChromiumは、専用プロファイルが一致する7プロセスだけをSIGTERMで終了。`screenshot-browser-closed.json` の `survivors:[]`。ユーザーのPCブラウザは止めていない。
- 04:23:02.532 JST、受信PID2222へSIGTERM。02.534の `upstream_stopped socketClosed:true`、02.814／02.836の残り2接続の `hub_closed reason:shutdown`、02.847の `server_stopped httpClosed:true` を確認。ログ上313.73ms、外部からPID消滅・HTTP接続拒否を確認するまで410ms。
- 開発上流は開始から `state:stopped`・`connectedAtUs:null`・`reconnectCount:0`。接続を一度も開いておらず、新たなcloseイベントはない。以前の本番限定指定を維持した。
- 固定描画のChromium PID2751：`exited:true`・CDP9223閉鎖。最終プロセス検索はChromium0・受信サーバー0。
- 最終GET時は検証WS0・外部2接続。サーバー終了時はその2接続もcloseログを確認し、待受ポート閉鎖により残存接続0。`sendErrors:0`・`slowClosed:0`。

証拠：`before-status.json`・`final-status.json`・`browser-checks.json`・`screenshot-browser-closed.json`・`server-stopped.json`、固定描画ディレクトリの `browser-closed.json`。

### 11.5 仕様にない値とCurrent Status

新しい製品仕様の具体値は決めていない。ラベル18 CSS px・拡大時も価格行全体を塗る指定は、7節の既承認事項を維持。今回の `included:70/100` はダミー試験の入力であり、製品設定や集計方式の変更ではない。

Current Statusには、型エラー解消・画面112試験と型検査／ビルド成功・実リプレイと性能測定結果・初期値復元保存・全ブラウザと受信サーバー終了・本番未変更・Phase 11／12a未着手を追記した。
