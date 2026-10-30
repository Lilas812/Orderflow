# HEATMAP平均化・平滑化：追従キャッシュ最小修正・隔離確認

## 承認後の最小修正

ユーザーの「最小修正を進める」を受けて実施。開始HEADは`01254047aef91b1e61cedd2d83e2a027b8b0dd77`、開始時の未コミット差分なし。以下の旧記録の「修正未実施・許可待ち」は、この節より前の時点の記録。

### 変更・影響・戻し方

- 製品変更は`artifacts/heatmap/src/chart/smoothing.ts::SmoothingRaster.frame`のみ。`followStartUs`と一致する格子かを調べ、各画素境界を**絶対画素番号から整数µsへ一貫して計算**する。丸めた先頭へ小数dxを繰り返し足さない。キャッシュキーは実際の境界で一致させる。
- 任意パンの非整列位置は従来の重なり境界のまま。平均の有効時間分母は`to - from`。整数µs化した境界の実際の長さを使い、既知領域の不透明度が丸め誤差で減らないようにした。数量やRGBを粗く丸めてキャッシュヒットさせる修正ではない。
- `coordinates.ts`、保存・配信・約定・VP等の集計・サーバー設定・色の保存値・48MiB上限は変更なし。既存の追従中zoom復元の課題、冷間初回最適化、他の追加機能は対象外。
- 戻す場合はこの`smoothing.ts`の今回差分のみを戻す。以前の平均化・最新表示・指標等をresetしない。データ移行／復元は不要。

### 回帰試験

`artifacts/heatmap/test/smoothing.test.ts`に追加。修正前はepoch追従試験が`width=928, block, step=2: 928 !== 1`で失敗した。

- 実epoch時刻・幅928／1856・block／glow：静止は再計算0、1～2画素進むと新規の1～2列だけ再計算。毎回、新規キャッシュで描いた全画素と一致。core再生成も50列未満。
- 既存秒の後着置換は影響する1～3列のみ再集約し、新規描画と全画素一致。
- 任意パン／往復／非整数時間幅のzoom／価格幾何／平均・最大／自動・なし変更も新規描画と全画素一致。
- 全既知100枚の画素は実epoch・両幅で、100枚・完全取得の参照色と全画素一致。既存の平均19、既知0／unknown、重み、欠損・未来除外の試験も維持。
- 全フロント**180/180合格**、フロント型検査・production build・検証コードを含むreceiver型検査・`git diff --check`合格。サーバー製品コード未変更のため全サーバー試験の機械的再実行はしていない。

### 同条件・修正前後の実WS／製品Canvas

今回の修正前distと修正後distを、それぞれ新規の自前fixture／Chromeで測定。他のビルドや検証Chromeと重ねず実行した。上流接続なし・dummy I/O、前景1タブ、1280×800 CSS、初期1796列×80価格、1800秒表示、固定上限200／下限off／gamma1、glow・平均／自動。各条件15秒＋500ms drain、250msに1約定・1秒に1板。**各61件・183枚**で入力は同じ。時刻は実行時のUTCに移動する合成入力であり実ライブではない。比較元は上記HEAD、修正後JSは`dist/public/assets/index-BGeOK7vE.js`。

| 指標 | NQ DPR1 前→後 | GC DPR2 前→後 |
|---|---:|---:|
| 実Canvas depth更新サンプル数 | 31→31 | 32→31 |
| 実Canvas depth p50 ms | 8.8→7.8 | 41.4→26.2 |
| 実Canvas depth p95 ms | **177.1→16.8** | **766.0→90.7** |
| 実Canvas depth最大 ms | 464.2→16.9 | 784.8→94.1 |
| ブラウザ受信→latest描画 p95 ms | **8.6→4.3** | **55.3→17.2** |
| サーバー送信→latest描画 p95／最大 ms | 39／276→6／8 | 642／746→83／102 |
| Chrome CPU秒 | 3.69→2.91 | 11.94→6.56 |
| Chromeプロセス群RSS標本最大MiB | 932.8→928.2 | 1165.7→1083.8 |
| JS heap標本最大MiB | 61.0→51.3 | 142.2→82.2 |
| 最終派生キャッシュMiB | 33.0→10.2 | 48.0→40.8 |
| server CPU秒 | 0.182→0.185 | 0.187→0.202 |
| WS実送信byte増分 | 7937→7950 | 7680→7888 |

通信差はバッチ化／取得窓の時刻に伴うもの。配信頻度・形式は変更していない。実Canvasは測定開始前snapshot以降のdepth=trueフレームのみで、計算コア単体や初回cold描画ではない。RSSは子プロセス合算で共有ページの重複を含む。全ブラウザのメモリ上限を48MiBにしたという意味ではない。

serverの最終数量は全条件233枚（seed50＋183）、ブラウザの約定キャッシュは62件（窓内seed1＋61）で前後一致。VP描画snapshotは周期更新の途中値を含むため、この500ms drainだけで全レイヤーの終端数量233まで照合したとは扱わない。今回の板背景の全画素一致は上記回帰試験、実Canvasの表示は下記PNGで確認した。

受信後p95 100ms目標は両条件で達成。追従の全再計算とこの短時間条件の負荷は改善したが、**高流量・長時間・本番CPU・実上流の遅延解消は未確認**。GCのサーバー送信→描画最大102msやブラウザ全体の大きなRSSも隠さず残す。

### 証拠・実行・終了

```sh
node server/test/smoothing-live-check.ts --out=data/heatmap-smoothing/follow-fix-before
pnpm --filter @workspace/heatmap test
pnpm --filter @workspace/heatmap typecheck
pnpm --filter @workspace/heatmap build
pnpm --filter @workspace/receiver typecheck
node server/test/smoothing-live-check.ts --out=data/heatmap-smoothing/follow-fix-after
git diff --check
```

- 比較データ：`data/heatmap-smoothing/follow-fix-comparison.json`、前後フォルダーの`real-ws.json`。検証ツール`server/test/smoothing-live-check.ts`は出力先指定と測定終了後の撮影のみ追加。
- 画面：`follow-fix-after/NQ-dpr1.png`、`GC-dpr2.png`。実製品Canvasで価格軸・現在板・平均／自動の凡例・板背景・最新価格・指標が描かれている。右下に「ダミー隔離」を明示。通常workspaceの`workspace.jpg`は上流stoppedの板待機画面で、実板の合格証拠とは区別する。
- 各条件の自前Chromeは`Browser.close`後に親PID消滅／9233閉鎖を確認。自前fixtureもSIGTERM後PID消滅を確認。サーバー待受消滅により自前WS接続も残らない。
- 最終撮影Chromeと子プロセスも全PID ESRCH。**検証Chromium残存0、18812／18814／18815／9233／9234すべて閉鎖**。`follow-fix-after/cleanup.json`。
- 既存受信・管理workflowの停止／再起動、上流追加接続、本番書込、再Publishは行っていない。再ビルド済み・未公開。

## 再開した残りの確認（2026-10-30）

GCの方向不明数量修正後、ユーザーの「次の候補を進めて」で再開した。候補commitは`f2eae66e83849f859e9791c7d8239e1f94192e03`。**平均化を再適用していない。今回は製品コード・設定・保存データを変更せず、検証fixture／手順／報告のみを追加した。** 既存177試験・型検査・build・16画像は有効なまま再利用した。今回追加した検証コードについてserver型検査は合格。

### 実アプリの操作確認

実製品dist、実Receiver／Hub／WS、dummy設定I/O、上流接続なし。各銘柄のseedは1796列×80明示価格、間に4秒欠損。時刻の進行で初期1800秒窓の列数が変わるため、以下の実測では実受信列数も記録する。

- 初期「平均／自動」、NQを「最大／なし」にしてreload後も保持、GCは独立して「平均／自動」、GCで変更後NQへ戻してもNQ設定を保持。openerなしの別タブは独立して初期値。全操作で**設定PUT0**、サーバーversion4／固定色上限200・gamma1は不変。
- カーソル移動12回で十字カーソルが動き、HEATMAPのdepth描画数は不変。パンでstartUs変更・follow=false、ホイールで時間幅変更、価格軸上下ドラッグで価格幅160→23.457113940856 ticks。
- 実document.hidden=trueの背景タブ中、約定3枚と後着板修正73枚を受信。depth描画数7→7、復帰後8へ増加。数量はserver VP50→53枚、ブラウザ約定キャッシュ2→3件。viewport・zoom・follow=falseは完全一致のまま。カーソルのために全板再計算はしない。
- 現在板は実Canvas.fillTextで`73`を描き、平均数量へ置換しない。画像`current-book-raw-73.png`、`restored-late-correction.png`。
- HEATMAP→FOOTPRINTは画面遷移／旧画面破棄でHEATMAP Canvasなし。共有server sourceへの次の4枚を採用し、Hub接続1のまま、NQ合計53→57枚。これを背景タブの停止と混同しない。
- 画面リンクは`debug=1`を引き継がないため、当初の戻り確認用debug待機は失敗した。製品の画面読取失敗ではない。別の限定検証で、直前のドラッグで保存されたviewportを実製品読込へ復元して確認した結果：**follow=falseでは価格幅23.457…を保持、follow=trueでは160へ戻る**。`main.ts::runHeatmap`の復元条件が`!savedHeatView.follow`であることと一致。比較元旧commitにも同じ条件が存在し、平均化の新規差分ではない。この既存課題は今回修正していない。

証拠：`data/heatmap-smoothing/remaining-ui/native-ui.json`、`native-extra.json`、`view-memory.json`とPNG。最初のPlaywright確認はfixtureの0枚行が既存wireのsize>0検査で拒否されて中断、再開時は終了済みブラウザ本体に新contextを作れず未実施。その失敗記録も保持した。その後、別の検証専用native Chromiumで上記の残項目を確認した。既知0の平均は既存単体試験で確認済みだが、**現行wireは明示0行を表現できないため実WSでの0行試験とは主張しない**。行の欠落はunknownのまま。

### 不公平だったDPR1/blockだけの再測定

専用Vite18812・単独Chrome、ビルドや他の検証ブラウザと重ねず実施。以前と同じ600列×160価格・600秒・Canvas800×400 CSS px・固定上限200／下限off／gamma1、250msごと1列の補正、各15秒59サンプル。旧は同じソースの`setSmoothing(null)`、新はmean/auto。数学や全16画像、他の既存7条件は再実行していない。

| DPR1 block | 旧 | 新 |
|---|---:|---:|
| 初回draw ms | 196.8 | 83.6 |
| 通常draw p50/p95/max ms | 0.9 / 1.5 / 1.7 | 4.0 / 5.8 / 9.6 |
| Chrome CPU秒／約15秒 | 0.68 | 0.90 |
| 最終JS heap MiB | 24.95 | 16.29 |
| 測定中通信 | 0 | 0 |

通常描画は旧より重い。初回は順序固定・単回のため冷間最適化や統計的改善とは扱わない。`data/heatmap-smoothing/fair-dpr1-block/canvas.json`。既存のglow追加CPUも未解消。

### 実WS経路・最新表示・メモリ

条件ごとに**新しいfixtureと新しいChrome**を使い、1タブ前景（開始／終了document.hidden=false、接続1）、glow／mean-auto、1280×800 CSS viewport。初期1796列、80価格。250msに1約定、毎秒1板更新、15秒＋最終drain。61約定・183枚を各条件へ入力。2つのseed約定のうち1つは初期30分窓外のためブラウザキャッシュは1→62件、日次合計は50→233枚で、欠落／二重加算なし。下記は受信後、実Canvasを更新したバッチ単位（複数約定が同一描画へまとまる場合あり）。

| 指標 | NQ DPR1 | GC DPR2 |
|---|---:|---:|
| 実測秒 | 15.57 | 15.59 |
| 受信→latest描画 p50/p95/max ms | 1.8 / **6.1** / 41.4 | 2.5 / **47.7** / 54.8 |
| 描画済みlatestバッチ数 | 61 | 58 |
| 実Canvas depth更新数 | 31 | 28 |
| 実Canvas depth p50/p95/max ms | 7.9 / **135** / 165.1 | 23.6 / **685** / **914.6** |
| server送信→描画 p95/max ms | 7 / 71 | **433 / 761** |
| 正規化 p95/max ms | 0.111 / 0.464 | 0.196 / 2.512 |
| Chrome CPU秒 | 3.53 | 10.29 |
| server CPU秒 | 0.187 | 0.177 |
| Chromeプロセス群RSS標本最大MiB | 936.2 | 1167.3 |
| JS heap標本最大MiB | 57.96 | 123.15 |
| 最終派生キャッシュMiB | 32.97 | 47.98 |
| server側WS実送信byte増分 | 7,954 | 7,868 |

RSSはChrome親子のRSS合算で共有ページの重複計上を含み、専有メモリやピークの保証ではない。heapも250ms／1秒の標本最大で精密なpeak／leak検査ではない。キャッシュ48MiBは配列本体の制限で、Canvas・一時frame・trade mask・他レイヤーを含むブラウザ全体の上限ではない。

前景の**ブラウザmessage受信後→描画p95 100ms**はこの入力で達成した。ただしサーバー送信後からの遅延は残り、低流量・単独隔離での結果を高流量／公開CPU改善の証拠としない。入力tsは秒丸めした合成データでupstreamAge p95はNQ864／GC920ms。実上流の鮮度の測定ではない。`data/heatmap-smoothing/live/real-ws.json`に全段階・FrameProfile・CPU・heap・wire・閉鎖確認を保存。

### 今回見つかった不具合：追従でキャッシュ全再計算

**合格扱いにしない。** 静止viewの既存試験では出ず、実WS追従で重いフレームが発生した。`SmoothingRaster.frame`は秒単位の浮動小数from/toをそのまま文字列キーにする一方、`followStartUs`は画素格子で計算した開始時刻を整数µsへ丸める。そのため画面が1物理画素進んでも、重なるはずの旧区間キーが一致しない。

同じimmutable列・同じ数量・同じ幾何で、追加データなしにheadだけ進める隔離再現：
- 幅928：初回928列。開始時刻不変の次3回は0列再計算。1画素進んだとき**928列全部再計算**。
- 幅1856：初回1856列。位置不変なら0列。1画素進む2回とも**1856列全部再計算**。

証拠：`data/heatmap-smoothing/live/follow-cache.json`。この再現は高さ16の純粋表示計算で、Canvas負荷測定の代用ではない。実Canvasの重いフレームと同一原因だと全て断定せず、不要な全再計算があることまでを確認した。実Canvas FrameProfileの通常更新でも重いdepth frameがあり、送信後遅延を隠さない。

最小修正案：**時間格子の安定した識別と表示位置を分離**し、1画素追従時は旧区間の集約・色を再利用する。重なり時間・端の重みは維持し、数量・色値を粗く丸めて誤魔化さない。任意パン／ズーム／後着修正／mode変更時は必要な部分だけ適切に無効化する。変更対象は表示側キャッシュと回帰試験のみ。元に戻す場合はこの表示側差分だけ戻せる。保存・配信・集計・設定PUTを変える必要はない。**製品修正は未実施、許可待ち。** 追従中zoom復元の既存課題は別件として記録し、この最小修正へ混ぜない。

### 実行・終了

```sh
pnpm --filter @workspace/receiver run typecheck
node server/test/smoothing-ui-check.ts
node server/test/smoothing-ui-check.ts --extra
node server/test/smoothing-view-memory-check.ts
node server/test/smoothing-canvas-check.ts --out=data/heatmap-smoothing/fair-dpr1-block --dpr=1 --style=block --seconds=15 --skip-images
node server/test/smoothing-live-check.ts
```

UI本体の操作pass、extraは価格zoom／現在板73／画面離脱を確認後debug消失の待機で失敗、復元条件は別の限定試験で上記結果。失敗を全UI合格と書かない。本番書込・Publish・既存workflow再起動／停止・上流追加接続なし。

### 今回の終了記録

- 操作検証Chrome19799、追加操作20492、復元条件21493、実WS21020／21189、CanvasベンチのChromeはすべてBrowser.close／親PID終了・debugポート閉鎖を確認。失敗した検証もfinallyで閉鎖している。
- 最後のfixture PID19767はHub NQ0／GC0・設定PUT0を記録してSIGTERM、PID ESRCH。性能fixtureの各PIDもそれぞれ終了。
- Vite18812も停止。最終撮影のChrome22100と子PIDもすべてESRCH。**検証Chromium残存0、18812／18814／18815／9233／9234すべて閉鎖**。`data/heatmap-smoothing/cleanup-final.json`。
- 通常workspaceプレビューの追加撮影は板待機の`workspace-preview-no-upstream.jpg`。隔離の実板確認画像・負荷測定の証拠とは混同しない。既存受信・通常workflowには停止／再起動操作なし。

---
## 以下はGC取り込みで中断する前の記録

2026-10-30。途中でGC購入ZIPが追加され、ユーザーが「GCの取り込みを先にする」を選択したため、**完了扱いにはしない**。差分・既存の合格結果を保持している。

## 現在の差分

- `src/chart/smoothing.ts`：元数量の時間重なり集約、合計／有効重み、価格方向の面積平均／最大、unknown有効面積マスク、物理画素ごとの派生キャッシュ。
- `src/chart/renderer.ts`：両styleの表示専用経路。色基準は元の実測列。リプレイcutoffより後の代表列を除外。
- `src/data/smoothing-settings.ts`、`src/main.ts`：銘柄別sessionStorage、設定画面「表示（このタブ）」、凡例。設定PUT・server versionは変更しない。
- 関連仕様：`docs/HEATMAP_SMOOTHING_SPEC.md`、`docs/SPEC.md`の縮小集約の旧案1行。
- 現在板の数量表示・板保存・約定・日次指標・FOOTPRINT・LONG VPの計算は変更しない。
- 行の省略を0とみなさない。明示0だけ既知。短い欠損の表示補間は新経路へ入れず、欠損は黒のまま。これは秒内イベントの時間平均ではなく1秒代表値の平均。

## 済んだ確認

`pnpm --filter @workspace/heatmap run typecheck`、画面関連177試験、`pnpm --filter @workspace/receiver run build`が合格。
旧rendererキャッシュの回帰試験は既存最大値経路を明示指定し、新経路には別試験を追加した。

新単体試験では平均19／最大100、端の重み、合計・有効重みの多段マージ、既知0とunknown、時間有効率込みの価格面積、拡大、後着修正、全欠損へのglow漏れなし、銘柄別設定を確認した。

## 実Canvasの暫定測定

比較元commit：`5d3b11578afb7881bbebcc009244f1a0ad814740`の旧描画経路を同じソース内の`setSmoothing(null)`で使用。外部commitへのresetやコピーはしていない。

Chrome・1280×800 viewport、Canvas800×400 CSS px、600列×160明示価格、600秒、250msごと1列の後着修正。各条件15秒、固定上限200／下限なし／gamma1。画像比較は6000秒×6000列・価格幅800ticks。保存画像16枚。

| DPR | style | 旧p50/p95/max ms | 新p50/p95/max ms | 旧→新Chrome CPU秒/約15秒 |
|---|---|---|---|---|
| 1 | block | 1.30 / 21.70 / 45.60 | 5.60 / 12.00 / 25.90 | 2.31→1.45 |
| 1 | glow | 1.10 / 1.90 / 3.60 | 6.70 / 11.60 / 12.00 | 0.60→1.13 |
| 2 | block | 2.90 / 5.40 / 10.40 | 13.80 / 19.80 / 29.00 | 1.48→2.07 |
| 2 | glow | 1.70 / 3.20 / 3.60 | 23.20 / 29.20 / 89.40 | 0.96→2.99 |

CPUは専用Chromeの親・子プロセスの`/proc` user+system時間差。GC処理はこのCanvas測定の終了後に開始した。ただし先頭の旧block条件はビルド処理と時間が重なったため、公平な性能改善の根拠には使わない。再開時は必要な条件だけ、他の処理を止めた隔離状態で再測定する。

旧→新JS heapの最終サンプル（MiB、精密なピークやリーク検査ではない）：DPR1 block 25.72→12.36、glow16.41→18.19、DPR2 block63.86→37.02、glow13.60→34.78。描画追加によるCPU増加は隠さない。

`data/heatmap-smoothing/canvas.json`に初期表示、補正更新、rAF待ちを含む合成受信→描画、キャッシュ量、通信量を記録した。測定区間はWS配信なしの合成入力なので、**実WSの最新表示p95 100msを満たした証拠にはしない**。

固定色基準で未飽和の平均と最大のRGBが異なることを実ブラウザでassertした。RGB平均や画像ぼかしは平均化の代用にしていない。

## 終了・残る確認

- 測定Chrome PID4927は終了・debug port閉鎖を確認済み（`canvas.json.closed`）。
- 設定ダミー隔離サーバーPID5493はSIGTERM、NQ／GC接続0、PID消滅を確認した。専用Vite18812も停止。既存workflow・受信には停止／再起動操作をしていない。
- **未確認**：実アプリのタブ内設定・別タブ・再読み込み、NQ／GC、現在板の数字、追従・pan・zoom・十字カーソル、非表示復帰、実WS受信→最新部分描画。GC取り込み完了後に、必要な未確認分だけ続行する。
- 合成ベンチのglow CPU増加、キャッシュ本体以外の一時画像／trade maskメモリも最終評価に含める必要がある。公開の重さが改善したとは扱わない。
- 本番書込・Publish・上流追加接続なし。
