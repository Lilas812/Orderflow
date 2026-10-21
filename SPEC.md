# SPEC.md — 独自オーダーフロー分析プラットフォーム 機能仕様書

- 文書版: 0.1.0 / 作成日: 2026-10-21 / 状態: **設計案（未実装）**
- 対象: Windows 11 / 初期銘柄 CME E-mini Nasdaq-100 Futures（NQの**個別限月**）
- 関連: `UI_SPEC.md`, `DATA_SPEC.md`, `AGENT_RULES.md`, `ROADMAP.md`, `FIRST_AGENT_PROMPT.md`
- 競合製品の画面構成は参考にするが、ロゴ・商標・ソース・アイコン・固有の画像資産は使用しない。

## 0. 仕様のステータス

| 記号 | 意味 | 扱い |
|---|---|---|
| [C] | ユーザー要求により確定 | Agentは無断変更不可 |
| [P] | 推奨する初期仮設定 | 手動テスト可能なデフォルトとして提案。実装前承認・変更可能 |
| [U] | 未確認・要意思決定 | 推測実装禁止。影響する機能はMOCKで代替または保留 |
| [G] | 将来拡張のみ | インターフェース設計まで、現段階で機能実装禁止 |

原則: 仕様「確定」は実装完了やフィードの利用可能性を意味しない。リアルタイム表示・保存・再現の実績は実データで検証するまで**未検証**である。

## 1. 製品ゴール・非ゴール

### ゴール [C]
1. 同一NQ限月の取引所由来の約定情報とL2 MBP流動性を**別データ系列**として収集する。
2. BidとAskの価格別気配数量とその変化を時間軸のヒートマップに表示する。
3. 積極約定の買い/売り数量・Deltaを正しく分類できる場合だけ表示する。
4. 元データを失わず、過去7日を読み戻し、表示フィルターや時間集計を変えて再生成できる。
5. 開発初期はMOCK専用。確認後にデータアダプターだけを差し替え、ブラウザ版をWindows .exeとして展開する。
6. 250msの描画更新周期を目標とし、受信・集計・保存・描画を別のキュー/タスクに分離する。

### 非ゴール [C]
- 初期リリースに注文機能、売買シミュレーション、注文ルーティング、ブローカー連携は含まない。
- MBOの個別注文ID、Iceberg検出、ストップ注文検出をMBPから推測しない。
- トレード推奨・収益予測・売買シグナルは作らない。
- MT5のUS100cash価格をNQ先物の価格と同一とみなさない。

## 2. 初期ユースケース / 受け入れ

| ID | 操作/結果 | 初期範囲 | 検証の要点 |
|---|---|---|---|
| UC-01 | NQ個別限月を選択してMOCK表示 | [C] | MOCKウォーターマークを常時表示 |
| UC-02 | 指値Bid/Askヒートマップ | [C] | 板0・不明・欠損を区別、過去を保持 |
| UC-03 | 最新価格の細線、価格/時間軸 | [C] | 共通時間/価格座標、30分表示 |
| UC-04 | 2秒×2Tick約定バブル | [C] | Delta色、合計枚数サイズ、途中半透明 |
| UC-05 | Deltaヒストグラム | [C] | 同じTradeイベントから算出、共通時間軸 |
| UC-06 | 現在板ラダーと数量 | [C] | Bid/Ask別、スナップショット信頼状態を明示 |
| UC-07 | 設定メニューと保存 | [C] | ライブプレビュー/キャンセル/適用/永続化 |
| UC-08 | LIVE/HISTORY切替 | [C] | スクロール後は明示的「最新」操作まで追従停止 |
| UC-09 | 7日データの保存・再表示 | [C] | 再起動検証・欠損表示・消去 |
| UC-10 | 将来TICK STREAM接続 | [U] | ベンダーAPI文書・契約・利用許諾で決定 |

## 3. 技術構成の比較と採用案

| 候補 | 長所 | 留意点 | 判断 |
|---|---|---|---|
| React + TypeScript | ReplitでWebプレビューしやすい、型で表示契約を固定 | 高頻度イベントをReact stateに毎回載せない | **採用** |
| Electron | 同じReact UIをWindowsアプリに利用、ネイティブ保存可能 | メモリ負荷・ネイティブ依存の再ビルド/署名 | **採用** |
| Tauri | 軽量、Rustバックエンドは高速 | Web試作からのバックエンド移植・ツール習得コスト | 代替候補 [U] |
| Canvas 2D | 早く試作可能 | 大規模ヒートマップの再描画コスト | 小機能・フォールバック |
| WebGL2 | GPUでタイル表示、描画負荷を一定化しやすい | テクスチャ更新、座標精度、GPU復旧設計が必要 | **ヒートマップ採用** |
| WebGPU | 新しい表現力 | Windows上のGPU/ブラウザ差異、成熟度 | [G] |
| WebSocket | Web版への配信経路として自然 | ベンダー接続手段がWSとは限らない、切断検知必要 | 内部転送用に採用、外部は未定 |
| SQLite WAL | 設定・索引・スナップショット・小規模イベント検索に便利 | 単一ライター、膨大な行単位更新は計測必要 | **メタデータ/索引採用** |
| 圧縮バイナリチャンク | 大量イベントの追記・圧縮・範囲読み込みに適する | 形式・チェックサム・障害時切り戻しが必要 | **負荷試験後に選定** [P] |

**実行形態:** pnpm workspace + Vite Web UI + TypeScript共有コア + Node.jsのローカルデータプロセス（Web試作ではReplitワークスペース内の開発サーバー）。Electron `main` で管理する本番ローカルデータプロセスと安全な`preload`インターフェースを後段で追加する。Nodeを必要としない計算関数は `packages/core` に切り出し、React描画側に板の復元責務を渡さない。

```
MOCKまたは実フィード（専用adapter）
    -> event normalizer / sequence validator / gap controller
    -> append-only raw store (先行) -> derived MBP state / trade aggregation
    -> range-query API / tile cache -> WebSocket or IPC -> React + WebGL2
                                   -> ladder / bubbles / delta / diagnostics
Electron main -> secure preload -> renderer (ファイルと認証キーに直接触れない)
```

ブラウザ開発段階でのSQLiteへのアクセスはNodeサーバー側のみ。最終版では `app.getPath('userData')` 下の専用領域とし、Replitの開発サーバーを常時稼働する本番データ収集基盤とみなさない。.exeは**Windows 11ローカルでElectron Builder等によりビルド/インストール/起動テスト**する。GitHub ActionsのWindowsランナーも代替可能だが署名・配布は別工程。バックグラウンド収集継続はアプリプロセスの稼働が前提（無人常時収集は将来のWindowsサービス要件）。

## 4. データの真実性・状態表示 [C]

- `environment`: `MOCK | LIVE | REPLAY_FROM_SAVED_DATA`。過去データの再表示は市場から再取得したリアルタイムでない。
- `source`: `MOCK_DETERMINISTIC | VENDOR_UNVERIFIED | VERIFIED_VENDOR`。
- L1（ベストBid/Ask）・L2（MBP depth）・TRADESの品質と遅延を**別々に**持つ。
- `UNKNOWN` は0枚ではない。欠損中は該当タイルを斜線または半透明の `NO DATA`、ラダーは `—` とする。
- 過去板を復元できるのは**記録開始時の有効なスナップショット以降、連続した差分がある区間のみ**。初回起動より以前の板を推測しない。
- 相場休止、場間のセッション境界、限月切替、特定レベルしか購読できないdepth制限を欠損と区別する。
- 完全板ではなく上位N段の配信時には「範囲外未観測」を0として描かない。

## 5. ヒートマップ [C]

- 初期形式 MBP。`side: BID | ASK` を明示し、更新ごとに価格別の最新表示数量を保持。実在する指値の残数量であり、約定出来高を混ぜない。
- 描画周期250msは**画面更新**周期。イベント取り込み・元イベント永続化は全件逐次処理を目標。受信量が処理能力を超えたときは無言でドロップせず、バックプレッシャー/警告/データ無効区間を設ける。
- 60秒ごとにスナップショットを保存。区間内の板変化は生イベントに基づく時間積分（`DATA_SPEC.md`）。単純な250ms描画スナップショットの平均は不可。
- 価格バケット幅: 1 / 2 / 4 / 8 Tick。時間バケット幅はズームに追従する表示用タイル [P]。常に生イベントから正確に計算可能な根拠を残す。
- 最小板数量: 50枚 [P]。閾値0でOFF。比較対象は価格×時間セル内の**既知時間に対する時間加重平均**。Bid/Askの別算出後に各色に適用。
- 現在ラダーに対する最小数量の既定値は0枚 [P]（**板数量を隠さない**）。チャートの閾値と独立して調整可能。最初は閾値だけ適用し、板厚は数値を常時表示。
- 数量は保存時に丸めず、フィルター・色計算を後段の表示処理に限定。
- 強度: ABSOLUTE / RELATIVE。RELATIVEは直近5分に観測した**時間加重・価格側別の非ゼロ数量分布**の95パーセンタイルを既定最大輝度基準にする [P]。サンプリングと重みを `DATA_SPEC.md` で明示。履歴比較にはスケール固定を推奨。
- 調整: Minimum Liquidity Volume（数値 + スライダー）、Min/Max Intensity、Liquidity Contrast、Top Contrast、色パレット、基準固定。変更後にヒートマップタイルを再生成。
- 表示色はBID緑、ASK紫。価格が横切っても**過去時点のsideで色を決め**、現在価格に対する上下だけで色を上書きしない。

## 6. 約定バブル [C]

- `2秒 × 2Tick` 集計。約定量をaggressor側に分類し、`Delta = buy - sell`。合計出来高=buy+sell（分類が完全なバブルに限る）。未知のaggressorが混入した場合は不完全表示/Delta無効として扱い、都合よく買い/売りへ配分しない。
- Delta正=緑、負=紫、ゼロ=中立グレー [P]。
- 3条件は独立ON/OFF、ONのものを**AND**: 総出来高15枚 [P]、|Delta|10枚 [C]、|Delta|/総出来高 ≥40% [P]。
- サイズ方式 `FIXED, LINEAR, SQRT, LOG`、初期SQRT、直径8〜24px [P]。数量基準固定モード／可視範囲基準モード。固定基準のほうが時点比較に優れる。
- 途中集計は不透明度0.45 [P]、確定0.92 [P]。確定条件は**イベント時刻ウォーターマーク**に基づく。遅延イベントと訂正の扱いは `DATA_SPEC.md`。
- バブル位置は集計時間区間と価格帯の**中央**。描画はヒートマップ/価格線より手前。標準モードは近接同方向を**画面上だけ**統合し、元バブルへの参照とホバー内訳を保持。
- 表示密度 ALL / STANDARD / HIGH_COMPRESSION。前面重ね順は可読性を優先し、ホバーには全構成tradeの参照情報を持つ（情報の表示制限は許可契約に従う）。

## 7. チャート / ラダー / 下部 [C]

- 時間軸: 初期直近30分、最大ズームアウトは数時間 [P: 6時間]。ホイールでマウスポインター位置をアンカーにズーム、ドラッグで平行移動。LIVE中に左へ動かすとHISTORYに移行。HISTORY中も受信と保存は継続。`最新`ボタンのみLIVEに復帰。
- 価格軸: AUTO / MANUAL。AUTOは表示時間内の**有効な価格データ**の最小/最大に上下15%（表示価格レンジに対する余白）を加える。無取引の区間では前回有効レンジを維持し、データ不足を明示。価格軸ドラッグはMANUALへ。時間追従と価格軸固定は直交。
- 座標: グローバルの `viewport(t0,t1,pmin,pmax)` を価格線・ヒートマップ・バブル・ラダーの価格位置で共用する。価格ラダーの各行は共通Y座標。
- ラダー: 現時点の板を価格の上から下へ表示、列 `Ask Qty | Price | Bid Qty`、現在ベストAsk/Bidを区別。最新表示板の深さを超えた範囲は `—`。
- 下段: 2秒Deltaヒストグラム [P]、緑/紫・0基準線、横スクロールはメインチャートと同期。Delta無効区間は欠損表示。
- Volume Profile, Delta Profile, CVD, VWAP, Big Trades, MBO, Replay, ES/GC, Alerts, Trading は [G] で初期実装外。Volume Profileは**約定総出来高**から価格別に集計し板数量を使用しない。

## 8. 設定・永続化・責務分離 [C]

- 設定画面はヒートマップ、バブル、価格ライン、チャート、データのタブ。右クリックまたは歯車から開く。
- 編集は即時プレビュー。ただし「保存」を押すまでは一時状態。「キャンセル」/Escで直前の保存済み状態に戻す。保存後は再起動して同じ表示値を復元。
- 保存形式はバージョン付きJSON。数値は範囲検証、無効値はユーザーにエラーを示す。古いバージョンからの移行は段階的にテスト。
- 設定保存先はブラウザ試作で開発用バックエンドファイル（*ブラウザlocalStorageのみで済ませない*）、Windows本番は `app.getPath('userData')` の設定DB。認証情報は設定ファイルには保存しない。

## 9. 実データ供給契約・TICK STREAM調査 [U]

**2026-10-21時点、提示された名称「TICK STREAM」の公式API仕様・正確な事業者/製品URLを確定できていない。** 名前が同じ一般的な『tick stream』を別ベンダー製品と取り違えない。架空のWS URL、エンドポイント、JSONスキーマ、認証フロー、料金を生成しない。

契約前に事業者へ書面で確認し、すべて合格するまで実データアダプターをOFFとする。

| 問合せ | 必須回答 | 開発影響 |
|---|---|---|
| 製品名/契約主体/API文書 | 公式URLとバージョン | vendor adapterの開始条件 |
| CME NQ約定ストリーム | 個別限月・約定ID・価格/枚数・時刻・aggressor側 | バブル/Deltaの可用性 |
| リアルタイムL2深さ | MBP/MBO、片側最大何レベル、implied扱い | ヒートマップ範囲と種類 |
| 初期状態と差分 | snapshot + incremental、更新タイプ/削除、適用順 | 復元可能性 |
| シーケンスと時刻 | packet/instrument/event seq、重複、ns/us/ms、TZ | 欠損と整列 |
| 切断復帰 | replay / backfill / snapshotの取得手段 | 自動再同期 |
| 過去の深さ | 過去7日のtick-by-tick L2可否、保存期限 | 開発開始時点の空白 |
| 認証と接続 | APIキー、SDK、TLS、接続制限、課金 | Node側実装 |
| 使用許諾 | 非表示処理、ローカル7日保存、再表示、開発時利用、転送/共有 | 法務ゲート |
| CMEデータ費用 | exchange fee, entitlement, non-display, historical rights | 運用コスト |

取引所CME MDP3.0にMBP/MBOやスナップショットの概念があることと、**候補ベンダーが同等情報を顧客に供給することは別**。その差異を検証する。

## 10. セキュリティ [C]

- UI/Reactへ秘密鍵を渡さない。Web試作はReplit SecretsをNodeサーバー側のみ使用。本番はWindows Credential Manager/DPAPI互換の安全な保存方式を検討し、平文を禁止。
- ログ・テストfixture・障害レポートにキーを含めない。API通信はベンダー指定の安全なプロトコルに限定。
- Electronは `nodeIntegration:false, contextIsolation:true, sandbox:true` を既定。`preload` は用途限定メソッド、任意のファイルパス実行や生IPC公開をしない。CSP設定と外部ナビゲーション拒否。
- データ再配布/公開URLでの生データ共有禁止（契約確認までは個人のMOCK開発のみ）。

## 11. 性能/品質目標 [P] と品質判定 [C]

| メトリクス | 初期目標 [P] | 判定基準 |
|---|---|---|
| 描画更新 | 250msごと（4Hz） | 99%以上の描画tickを処理、遅延を可視化 |
| 価格/数量計算 | 決定論的に一致 | fixtureの期待値と完全一致 |
| イベント受信 | 原イベント欠落なし | ID/seq監査とraw保存件数照合 |
| フレーム時間 | p95 100ms以下 | GPU使用時、測定用PCの仕様を記録 |
| データ復元 | 同じsnapshot+eventsで同じ結果 | 再起動・再計算ハッシュ一致 |
| 過負荷 | silent drop = 0 | 警報、背圧、gap表示が発火 |
| ストレージ | 7日保存が可能 | 実測容量/1日と保持日数を算出 |
| 切断復旧 | 有効な再同期を完了 | gap前後の誤結合をしない |

数値閾値は**仮目標**で、NQピークの実測データ/指定Windows機の性能を測って最終調整する。処理不能時に“全イベントを欠落なし”と嘘の表示をしないことを合格条件とする。

## 12. 未確定事項 / 決定ゲート

| 優先 | 項目 | 推奨と理由 | ゲート |
|---|---|---|---|
| P0 | 「TICK STREAM」の正確な公式リンク/料金/SDK | URL提示後だけ調査・実装。名称衝突を避ける | LIVE adapter |
| P0 | データのaggressor判定可否 | 明示フィールド優先。保証できなければDelta無効 | Delta LIVE |
| P0 | 板更新の深度とリカバリ方式 | 有効snapshot+連続seq必須 | Heatmap LIVE |
| P0 | 保存・派生表示の許諾 | 契約書を確認。7日保持は許可次第 | LIVE保存 |
| P1 | 時間バケットの初期ピクセル幅 | 2sまたは表示時刻÷表示幅。縮小時の表現を後で計測 | タイル描画 |
| P1 | Deltaの表示棒幅 | バブルと同じ2秒 [P]、比較が容易 | ヒストグラム |
| P1 | 標準バブル統合距離 | 直径の0.75倍 [P]、視認性で調整 | 密度表示 |
| P1 | 旧限月の扱い | 個別限月を手動切替。自動ロールは[G] | 複数銘柄 |
| P1 | 保存圧縮方式/チャンク長 | zstd系/5分候補、CPU/復元速度の実測で選ぶ | 7日保存 |
| P2 | 配色/ラダー列幅 | `UI_SPEC.md`記載の初期案を可変にする | UI受入 |
| P2 | GPU喪失時 | 再初期化とNO DATAではなく「描画停止」エラー | 高速化 |

## 13. 設計参考URL（照会日時: 2026-10-21）

1. DeepDOM Heatmap: https://www.deepcharts.com/helpcenter/deepdom/article/heatmap
2. DeepDOM Volume Bubbles: https://www.deepcharts.com/helpcenter/deepdom/article/volume-bubbles
3. CME MDP 3.0 MBP/MBO Incremental: https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/457227795/MDP+3.0+-+Market+Data+Incremental+Refresh+-+MBP+and+MBOFD
4. CME market data policy: https://www.cmegroup.com/market-data/license-data/market-data-policy-education-center.html
5. CME NQ contract specifications: https://www.cmegroup.com/trading/equity-index/files/emini-nasdaq-100-futures-options.pdf
6. Electron Security: https://www.electronjs.org/docs/latest/tutorial/security/
7. SQLite WAL: https://www.sqlite.org/wal.html
8. electron-builder Windows CI example: https://www.electron.build/docs/github-actions/

**注意:** 参照は設計の根拠であり、DeepDOMの宣伝上の将来予測や約定因果について正確性を保証するものではない。
