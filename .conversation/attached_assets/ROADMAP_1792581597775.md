# ROADMAP.md — 一工程ずつ検証する開発計画

文書版 0.1.0 / 2026-10-21 / **すべて未着手**。実装順は依存関係に従い `R00→...→R20`。**各工程はユーザーの動作確認・承認があるまで次に進まない。**

## 工程の運用方法

- `[必須]` 各工程で9項目（目的・変更ファイル・禁止範囲・実装内容・MOCK・期待値・手動確認・合格・不具合切り分け）を定義。パスは**現時点の提案**であり、既存Replitプロジェクトの構成が違えば修正範囲を再承認する。
- `*.test.ts` は対応する実装ファイルと同じ工程に含める。ユーザーが指示する前に次の工程に着手しない。
- 数値fixtureは `DATA_SPEC.md §13` を正本とし、見た目の画像一致を成功条件としない。
- `R00-R18` はMOCKだけで可能。**R19に入る前に、公式APIと許諾が完了していることを必ず確認する。**

## マイルストーン/依存関係

| フェーズ | 工程 | デモ可能になるもの | 外部契約 |
|---|---|---|---|
| 基盤 | R00–R03 | Webで状態表示 / 決定論的MOCK / 正確な板復元・欠損 | 不要 |
| 描画 | R04–R07 | TWA算術 / 共通座標 / WebGL heatmap / 強度フィルター | 不要 |
| 約定 | R08–R11 | Trade/Delta / バブル / 密度 / Delta下段 | 不要 |
| 操作 | R12–R13 | 現在板ラダー / 保存可能な設定パネル | 不要 |
| 履歴 | R14–R16 | SQLite / 7日範囲読み出し / 障害回復・性能計測 | 不要 |
| Desktop | R17 | Windows 11 .exe動作 | 不要 |
| Vendor | R18–R19 | 文書調査・実データ接続（合格後のみ） | 必要 |
| Release | R20 | 通し受け入れ・実データ負荷試験結果 | R19完了時のみ |

---

## R00 — Web雛形 + 正しいMOCK/NO DATA表示

1. **目的:** ReplitプレビューでReact/TypeScriptの画面が表示され、データ未取得を正しく示せる最小足場を作る。
2. **変更ファイル:** 新規 `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `apps/web/{package.json,index.html,vite.config.ts,tsconfig.json,src/main.tsx,src/App.tsx,src/styles.css}`, `packages/core/{package.json,tsconfig.json,src/instrument.ts,src/instrument.test.ts}`（必要なlockfile）。
3. **変更禁止:** 6仕様書の改変、外部feed、WebGL、Electron、SQLite、注文、擬似チャート値の自動生成。
4. **実装:** ViteのWeb起動、アプリ独自仮称、`MOCK • Simulated / NO DATA`、`NQ / 契約未選択`プレースホルダ、NQ tick変換の純関数、Vitest。
5. **MOCK:** 実際の価格イベントは**0件**。数値テストのみ `80000 ticks` と`0.25`。
6. **正しい結果:** 80000 ticks→20000.00、80001→20000.25、20000.50→80002 ticks。不正な0.1ポイント価格はreject。
7. **手動確認:** Replit preview起動、ブラウザのリロード、1280/1920幅、MOCK表示維持、DevToolsでエラーなし。
8. **合格条件:** 起動・TypeScript・テスト全成功。実データに見えるものや機能の先行実装がない。
9. **不具合切り分け:** workspace install → Vite host設定 → React mount → core import/型 → testsの順に切り分け。

## R01 — 正規イベントの型 + fixtureの永続的な定義

1. **目的:** sourceやUIに依存しない共通event契約を固定する。
2. **変更ファイル:** 新規 `packages/core/src/events.ts`, `packages/core/src/events.test.ts`, `packages/fixtures/{package.json,src/f01-book.ts,src/f04-trades.ts,src/index.ts}`、関連package設定。
3. **変更禁止:** R00のUIレイアウト、API接続、保存DB、レンダラ。
4. **実装:** event header（UTCns文字列/seq/ID/source/channel）、L2 snapshot/set/delete、Trade、L1、quality型とvalidation。
5. **MOCK:** F-01/F-04の固定列（乱数なし）。
6. **正しい結果:** 非整数qty、負数量、非Tick価格を拒否。fixturesは元と同順序・同件数でロード。
7. **手動確認:** `pnpm test`実行、fixture print（任意のdev diagnostic）でMOCKと時刻/数量を検査。
8. **合格条件:** 型checkとvalidation unit test、UIのMOCK表記が変わらない。
9. **切り分け:** tsconfig/pnpm alias → header schema → fixtureの時刻単位 → validationの順。

## R02 — MBP snapshot + 差分による板状態復元

1. **目的:** 価格・sideごとの「現在の板」を整数数量で再構築する。
2. **変更ファイル:** `packages/core/src/mbpBook.ts`, `mbpBook.test.ts`、必要ならfixture F-06。
3. **変更禁止:** React表示、Trade、MBO、保存DB。
4. **実装:** BID/ASKマップ、初期snapshotカバー範囲、SET/DELETE、再出現、batch順守の純状態遷移。
5. **MOCK:** F-01、F-06、同価格Bid/Ask、TOP_N制限fixture。
6. **正しい結果:** 時刻t=4はqty0、t=6はqty60、t=9はqty0。範囲外=UNKNOWN。
7. **手動確認:** 固定イベントを1件ずつ適用しconsole diagnosticで該当価格を見る。
8. **合格条件:** 再現可能な最終状態と途中state、side混線ゼロ。
9. **切り分け:** snapshotのscope → tick price key → side key → SET/DELETE適用順。

## R03 — イベント順序・重複・NO DATA区間

1. **目的:** 板のシーケンス欠落を誤表示せず、L1/L2/Trade別品質を持つ。
2. **変更ファイル:** `packages/core/src/{sequenceGuard,qualityTimeline}.ts` とテスト、F-07/F-16 fixtures。
3. **変更禁止:** 状態機械以外の既存MBP算術、UI/描画、LIVE接続。
4. **実装:** seq scope検査、冪等key、GAP/RESYNCING状態、quality intervals、snapshot再同期API。
5. **MOCK:** L2 seq10→12、Tradeは連続、L1のみ不在。
6. **正しい結果:** L2だけGAP/ラダー無効、Tradeの有効性維持。再同期snapshot後からのみVALID。
7. **手動確認:** diagnosticに3チャネルの状態を別々に出す。
8. **合格条件:** gapを0枚と扱わず、再接続だけで自動VALIDにならない。
9. **切り分け:** sequence scope/expected → duplicate判定 → snapshot覆域 → quality interval。

## R04 — TWAと価格バケットの計算

1. **目的:** 板イベントの継続時間に基づく正確な数量平均を算出する。
2. **変更ファイル:** `packages/core/src/{timeWeightedDepth,priceBins}.ts` とテスト、F-02/F-03 fixture。
3. **変更禁止:** WebGL/色/Trade計算、raw events。
4. **実装:** 半開区間、state区間積分、side別足し合わせ、coverage品質、1/2/4/8Tick。
5. **MOCK:** F-01/02/03。
6. **正しい結果:** 10秒TWA38、2秒値60/40/30/60/0、2Tick合算58、coverage0.5ならNO DATA。
7. **手動確認:** fixtureの表と関数出力を1セルごとに照合。
8. **合格条件:** 250msに丸めない、未観測を0扱いしない、計算差0（整数比の許容浮動差は1e-9）。
9. **切り分け:** イベント整列→区間境界→有効カバレッジ→価格tickグループ。

## R05 — 共通Viewport + 価格ライン

1. **目的:** 価格軸と時間軸の座標を共通化し、LIVE/HISTORYを独立制御する。
2. **変更ファイル:** `packages/core/src/viewport.ts`, `viewport.test.ts`, `apps/web/src/{components/ChartShell.tsx,components/PriceAxis.tsx,components/TimeAxis.tsx,hooks/useViewport.ts}` とCSS。
3. **変更禁止:** TWA算術、配色ロジック、WebGL実装、注文UI。
4. **実装:** zoom/pan/tickToY/timeToX・逆写像、価格AUTO/MANUAL、価格線のgap分割。初期30分。
5. **MOCK:** 固定時刻のTrade価格3点、故意のTrade GAP。
6. **正しい結果:** viewport端の時刻はx端、価格上下端はy端、gapを跨ぐ折れ線0本。
7. **手動確認:** スクロールでHISTORY、到着MOCK追加後も追従しない、最新クリックでのみ復帰。価格固定が独立。
8. **合格条件:** 逆写像の誤差<=0.5 CSSpx、最新/価格AUTOが互いのモードを壊さない。
9. **切り分け:** CSS bounds→DPR→UTC相対時刻→viewport state→ライン描画。

## R06 — WebGL2 heatmapの最小描画

1. **目的:** 計算済みTWAセルをGPUで矩形表示する。装飾的な乱数グラデーションは禁止。
2. **変更ファイル:** 新規 `packages/render/{package.json,src/heatmapRenderer.ts,src/heatmapRenderer.test.ts}`, `apps/web/src/components/HeatmapCanvas.tsx`。
3. **変更禁止:** TWA/原イベント、フィルター、実feed、設定保存。
4. **実装:** タイル/テクスチャ更新、共通座標への配置、WebGL context loss/resize処理。
5. **MOCK:** F-01の5つの2秒TWAセル。
6. **正しい結果:** 量60/40/30/60/0に対応する色強度、0は背景、gapは縞状NO DATA。
7. **手動確認:** デバッグhoverで元qty表示、ウィンドウサイズ変更、GPU断の表示。
8. **合格条件:** 色の強弱がTWAと単調対応、価格軸ずれ<=1px。
9. **切り分け:** core tile値→buffer→shader座標→palette→GPU context。

## R07 — heatmapフィルターと比較可能な強度

1. **目的:** minimum volume、相対p95、強度、パレットを**表示計算だけ**に導入する。
2. **変更ファイル:** `packages/core/src/heatmapScale.ts` とテスト、`packages/render/src/heatmapRenderer.ts`, `apps/web/src/components/HeatmapDebugControls.tsx`（仮設定UI）。
3. **変更禁止:** 原MBPデータ、TWA結果、Trade、最終設定保存機能（R13）。
4. **実装:** 閾値0/OFF・50、ABS/REL、時間重みp95、固定基準、contrast、色変更。
5. **MOCK:** F-01/02、5分窓を固定した検証データ。
6. **正しい結果:** TWA38はthreshold50で非表示、0で表示、2Tick TWA58はthreshold50で表示。qtyハッシュ不変。
7. **手動確認:** 閾値50→0→50、色変更、基準固定中にHISTORY移動。
8. **合格条件:** 可視セルが期待どおり変わるがTWA値不変、データ不足はWARMING UP。
9. **切り分け:** 集約後数量→閾値→p95サンプル/weight→shaderパレット。

## R08 — Trade集計 / Aggressor分類品質 / Delta

1. **目的:** BUY/SELLの成立約定から正しい時間/価格バケット計算を可能にする。
2. **変更ファイル:** `packages/core/src/{tradeStore,bubbleAggregate}.ts` とテスト、F-04/05/08/09/10 fixtures。
3. **変更禁止:** Heatmap・L2、UIバブル描画、CVD、実ベンダーの推測分類。
4. **実装:** 2秒×2Tick、ID重複排除、B/S/U、V、Delta、偏り率、3条件AND。
5. **MOCK:** F-04/F-05/F-08/F-09/F-10。
6. **正しい結果:** 23/4→27/+19/70.37037%。12/14→26/-2で非表示、UNKNOWNありはINCOMPLETE。
7. **手動確認:** テストのバケット一覧と期待結果をconsole outputで確認。
8. **合格条件:** 買い/売りの方向定義正しい、unknownを0として混ぜない。
9. **切り分け:** tradeId→timestamp境界→priceBin→classification→フィルターAND。

## R09 — バブル重ね描画と未確定/確定/改訂

1. **目的:** 直径・位置・透明度を計算結果に忠実にする。
2. **変更ファイル:** `packages/core/src/{bubbleSizing,bubbleFinality}.ts` とテスト、`packages/render/src/bubbleRenderer.ts`, `apps/web/src/components/BubbleTooltip.tsx`。
3. **変更禁止:** 生Trade、Trade集計の式、Heatmap、外部Feed。
4. **実装:** 8–24px SQRT、2秒/価格帯中心、ウォーターマークによる状態、hover、前面描画。
5. **MOCK:** F-04/11、受信遅延、FINAL後のtrade訂正。
6. **正しい結果:** V27のSQRT直径約16.314px、未確定opacity0.45、FINAL0.92、REVISEDのversion増。
7. **手動確認:** モックを段階送り、途中のDelta符号反転と改訂ラベルを確認。
8. **合格条件:** 同じqtyでサイズ一致、unknownは不完全表示、画像裏ではない。
9. **切り分け:** aggregate数値→sizing→watermark→viewport mapping→tooltip。

## R10 — バブル密度切替（視覚統合）

1. **目的:** ALL/STANDARD/HIGHに切り替えて視認性を確保し、情報を失わない。
2. **変更ファイル:** `packages/render/src/bubbleClustering.ts` とテスト、`apps/web/src/components/BubbleTooltip.tsx`, R09表示呼出部。
3. **変更禁止:** Trade aggregate、元イベント、閾値算術、History store。
4. **実装:** 可視viewportに対する近接・同符号クラスタ、構成バブルID保持、展開表示。
5. **MOCK:** 同方向近接3個、逆符号1個、FINAL/PROVISIONAL混合。
6. **正しい結果:** 同方向だけ合算、`ΣV`,`ΣDelta`に一致、異符号は別、ALLなら4個。
7. **手動確認:** 密度切替とzoomで一時的統合が変わる、hoverで元内訳が開ける。
8. **合格条件:** raw件数ハッシュ不変、重複/取りこぼしなく所属IDの集合一致。
9. **切り分け:** 先行filter→画面座標距離→符号→childrenIds→sum検証。

## R11 — Delta下段ヒストグラム

1. **目的:** Bubblesと同じTrade集合から時間別Delta棒を表示する。
2. **変更ファイル:** `packages/core/src/deltaTimeline.ts` とテスト、`apps/web/src/components/DeltaPanel.tsx`とスタイル。
3. **変更禁止:** Bubble/Heatmapの数値、Volume Profile、CVD、別時間軸。
4. **実装:** 2秒桶で価格を合計、0軸対称、緑/紫、不完全/未確定色、共通viewport。
5. **MOCK:** F-04(+19)とF-05(-2)＋trade gap。
6. **正しい結果:** +19/-2、gapは0棒ではなくNO DATA。バブルでフィルターアウトした-2もDelta棒には残る（バブルフィルターはDeltaに作用しない）。
7. **手動確認:** メインをpan/zoomしてDeltaと棒の時刻が完全一致。
8. **合格条件:** 別time axisを持たず、欠損と0の区別、BubblesのフィルターがDeltaに波及しない。
9. **切り分け:** 同一Trade stream→interval grouping→viewport→canvas layers。

## R12 — 現在板の価格ラダー

1. **目的:** 右側に最新Bid/Ask数量と価格行を描画する。
2. **変更ファイル:** `apps/web/src/components/{LadderPanel,LadderRow}.tsx` とCSS、必要な`packages/core/src/ladderView.ts`・テスト。
3. **変更禁止:** MBP reducer、Trade、注文ボタン、将来Profile機能。
4. **実装:** AskQty/Price/BidQty、現在best bid/ask、過密時の価格ラベル省略、gapで`—`。
5. **MOCK:** F-02とF-07、上下10Tickサンプル。
6. **正しい結果:** BID80000=該当時刻値、ASK独立、L2 GAPで数値無効。
7. **手動確認:** 同一価格のラダー行とヒートマップ横帯が1px以内で一致。
8. **合格条件:** quantity欠損を0表示しない、右サイド幅変更で位置維持。
9. **切り分け:** book state→quality→shared transform→CSS overflow。

## R13 — 設定ドロワー / 先にMOCKで保存検証

1. **目的:** 各セクションの設定をプレビューし、明示保存・再読込できるようにする。
2. **変更ファイル:** `apps/web/src/components/{SettingsDrawer,HeatmapSettings,BubbleSettings,ViewportSettings}.tsx`, `apps/web/src/hooks/useSettings.ts`, `packages/core/src/settingsSchema.ts` とテスト、開発用バックエンドに限定した `apps/local-gateway/src/settingsFileStore.ts`（別途最小Node server設定を承認）。
3. **変更禁止:** Trade/MBP raw、実feed、Electron OS store、R14のSQLite。
4. **実装:** 値域検証、即プレビュー/キャンセル/適用、versioned JSONのサーバー側保存、再起動復元。
5. **MOCK:** F-01/F-04、保存後ロードの固定値。
6. **正しい結果:** threshold50と0、bubble min15/delta10の表示一致。キャンセルで元値復帰。
7. **手動確認:** 50→0→キャンセル/保存→リロード/開発サーバー再起動で比較。
8. **合格条件:** 保存と一時プレビューを混同しない、DBやrawは不変。
9. **切り分け:** validation→local preview→server request→settings JSON→画面読み戻し。

## R14 — SQLite索引 / 60秒板スナップショット

1. **目的:** Node側のみでイベント/索引を保存し、再起動時に復元できるようにする。
2. **変更ファイル:** `packages/storage/{package.json,src/sqliteCatalog.ts,src/snapshotStore.ts,src/*.test.ts}`, `apps/local-gateway/src/storageServer.ts`（許可された最小部分）。
3. **変更禁止:** UI側DB直接アクセス、設定数値、圧縮chunk形式、実feed。
4. **実装:** WAL、snapshot metadata、最小MOCK raw persistence、checksum、単一ライター、60秒チェックポイント。
5. **MOCK:** F-01/F-07、60秒ごとの固定状態スナップショット。
6. **正しい結果:** 有効な時だけcheckpoint、gap中は有効snapshotを生成しない、再起動後F-01の38を復元。
7. **手動確認:** Nodeプロセス停止/再起動、catalogのsnapshot時刻と再構成を確認。
8. **合格条件:** SQLite破損/欠損でNO DATA表示、rawイベント数と復元一致。
9. **切り分け:** WAL→snapshot state→lastAppliedSeq→file checksum→event replay。

## R15 — 7日保持と範囲読み込み（圧縮導入は計測後）

1. **目的:** 大量イベントでも過去の必要区間だけ読み、古いデータを正しく削除する。
2. **変更ファイル:** `packages/storage/src/{segmentWriter,segmentReader,retention,rangeQuery}.ts`とテスト、catalog索引migration。
3. **変更禁止:** 計算式、原データを表示時に丸める変更、クラウドへの自動送信。
4. **実装:** 追記専用chunk＋checksum、range query、直前snapshotと連続deltaでの復元、保管期間7日（codecは計測に従う）。
5. **MOCK:** 8日分の省略タイムライン＋F-01/F-03、クラッシュ前の途中chunk。
6. **正しい結果:** 7日より古い完成chunkだけexpire、範囲復元で38、gapは残る。容量値は実測報告。
7. **手動確認:** 日付をmock clockで進め、再起動後7日範囲の検索と削除を確認。
8. **合格条件:** 保存済範囲の数値がR04と一致、容量/書込み速度を計測、破損chunkを隔離。
9. **切り分け:** catalog index→snapshot選定→chunk read→CRC→expire境界。

## R16 — 障害回復・バックプレッシャー・性能計測

1. **目的:** 受信増大時もsilently wrongな表示にならない。
2. **変更ファイル:** `apps/local-gateway/src/{eventPipeline,reconnectController,metrics}.ts` とテスト、`apps/web/src/components/DataStatus.tsx`。
3. **変更禁止:** ベンダー固有接続、Trade/MBP算術、注文操作。
4. **実装:** 独立キュー、buffer上限と警告、再同期状態、exponential backoff、metric収集、render-lag表示。
5. **MOCK:** burst 1k/10k/50k events/s試験値、seq gap、切断・遅延、書込み失敗。
6. **正しい結果:** 失われたeventがあれば必ずGAP/保存障害を表示。再接続のみでVALIDには戻らない。
7. **手動確認:** MOCK接続off/on、故意のgap/ディスク不足、Status欄を読む。
8. **合格条件:** silent dropゼロか明示品質エラー、received/applied/persistedの整合。
9. **切り分け:** transport→queue depth→write latency→sequence validator→resync logic→render。

## R17 — Electron Windowsデスクトップ化

1. **目的:** 共通React画面をWindows 11で.exe起動、ローカル保存できるようにする。
2. **変更ファイル:** 新規 `apps/desktop/{package.json,electron-builder.yml,src/main.ts,src/preload.ts}`、最小ビルド設定とパッケージング用scripts。必要ならgateway起動adapterのみ。
3. **変更禁止:** React本体の再実装、アプリに外部feedキー埋込、`nodeIntegration:true`、ユーザーデータ削除。
4. **実装:** local gateway child process / IPC経路、app data path、contextBridge限定API、win x64 build、local installer/smoke test。署名は別ゲート。
5. **MOCK:** 保存済みF-01とランタイムMOCK、外部CME接続は0。
6. **正しい結果:** .exe起動→MOCK/NO DATA識別、同じ38枚、再起動保存復旧。
7. **手動確認:** Replitからソース取得→Windows 11 `pnpm install`→`pnpm build:win`→生成Installer実行→再起動/アンインストール前の保存確認。
8. **合格条件:** Windows実機で動作・契約不要・Node権限漏洩なし。Replit上で.exeができたことにしない。
9. **切り分け:** Windows toolchain→native sqlite module rebuild→Electron main→preload IPC→gateway→renderer。

## R18 — TICK STREAMベンダー要件ゲート（実装禁止）

1. **目的:** 実データの接続に着手してよいか判定する文書検証。
2. **変更ファイル:** 新規 `VENDOR_DUE_DILIGENCE.md` のみ（仕様確定に必要な承認済み追記以外は触らない）。
3. **変更禁止:** ソケット/認証/秘密鍵・契約前のLIVE機能・仮API実装。
4. **実装:** **コード変更なし**。公式URL、NQ trades/L2 MBP、snapshot+incremental、seq、depth、aggressor、許諾、履歴、費用、障害時復旧のチェック。
5. **MOCK:** 使わない。回答サンプルが公開される場合は公式由来を検証。
6. **正しい結果:** 各項目PASS/FAIL/UNKNOWNと根拠URLまたは契約条項、接続可否GO/NO-GO。
7. **手動確認:** ベンダー書類と照合し、担当窓口に保存7日/非表示分析/個人アプリ利用を確認。
8. **合格条件:** P0全項目PASS、契約上許可明示。UNKNOWNがあればR19へ進まない。
9. **切り分け:** 製品同定→API仕様→各種subscription→ライセンス→再同期方法。

## R19 — 実ベンダーアダプター（R18 PASSが必須）

1. **目的:** 正規化eventモデルに契約済みNQリアルタイムデータを流す。
2. **変更ファイル:** `apps/local-gateway/src/adapters/<verifiedVendor>Adapter.ts`、そのテスト、許可された接続設定/health表示だけ。
3. **変更禁止:** core算術・保存形式・UXのMOCK廃止・注文API。鍵をUIに出さない。
4. **実装:** 公式APIどおり認証/購読/復元、sequenceとsnapshot同期、Trade aggressor分類品質、disconnect再同期。
5. **MOCK:** vendor公認のテストストリームまたは公式サンプル、F-01との互換性検証。
6. **正しい結果:** 仕様の各rawフィールドをlosslessまたは監査可能に変換、VALIDまで板を表示しない。実データ計算は同限月の独立資料と照合。
7. **手動確認:** Windowsローカル/許可済み環境で小時間だけ接続し、板とTrade監査ログ・sequenceと欠損を検証。
8. **合格条件:** 法的許可・認証安全・snap+delta再同期・被験ログ整合が揃う。接続成功だけでは不可。
9. **切り分け:** entitlement/auth→symbology→transport→decode→snapshot seq→normalizer→raw保存→renderer。

## R20 — 完成判定・長時間負荷/障害/ライセンス確認

1. **目的:** デモと実用を区別してリリース可否を判定する。
2. **変更ファイル:** `ACCEPTANCE_REPORT.md`, `PERFORMANCE_REPORT.md` と承認済みバグ修正対象のみ。
3. **変更禁止:** 仕様の数値や合格基準をテスト結果に合わせて緩めること、検証未済み機能の完成表記。
4. **実装:** 10分/1時間/セッション負荷、7日容量外挿、クラッシュ再起動、gap、clock、WebGL、Windows性能、保存許諾を検査。
5. **MOCK:** F-01～17と合成burst。R19合格時のみ許可された実Market data。
6. **正しい結果:** Fixtures全一致、silent drop=0または明示した無効区間、復元/遅延/容量を実測数字で報告。
7. **手動確認:** 対象Windowsスペック/映像キャプチャ/操作ログ付きの完全受け入れチェック。
8. **合格条件:** データ正確性、回復、セキュリティ、契約、性能の各ゲートPASS。
9. **切り分け:** 問題箇所をtransport / normalize / book / aggregate / store / render / UIに分類し、該当R工程へ差し戻す。

---

## 後日（初期リリースに含めない）

- Phase G1: ES/GC等の `Instrument` metadata一般化と別限月保存。
- Phase G2: 約定ベースVolume Profile / Delta Profile / CVD / VWAP。
- Phase G3: MBO利用権限と公式order-level識別が取れた場合のみ個別注文分析。
- Phase G4: 時系列Replay / アラート。
- Phase G5: 注文執行（別プロジェクト級の認証・許諾・リスク管理・UI誤操作防止を必要とする）。

**次の一手はR00だけ。** R00が合格してからR01への実装指示を別途作る。
