# 保存処理のCPU削減

## 状態・対象

実装・隔離試験済み、未公開。既存受信の再起動・停止、本番書込、再Publish、上流接続追加は行っていない。
広範囲の最適化調査はユーザー指示で中断し、既知の保存処理だけを最小変更した。
比較元commitは `2498aa2a69518fa3c5efa4f96d539b225706145e`。開始時の未コミット差分はなし。
日時：2026-10-31 JST。

## 変更

- `server/src/store/local.ts`
  - `includeRange()`：二分探索と該当区間の結合で取得済み区間を更新。`markCovered()`の約定ごとの全区間コピー・ソートを除去。既知区間内の追加は無変更と判定する。
  - `saveCoverage()`：revisionが変わったときだけ従来形式で一時書込・rename。保存待ち中の`markCovered()`や`hold()`を保存済みと誤認しない。hold/release・保持期限境界もrevisionを更新。
  - `filesChanged()`・`refreshChangedStats()`：変更パスのsizeだけを再確認。新規・gzip回転・置換・削除を反映。起動、明示的`refreshStats()`、flushの全体確認は維持。
- `server/src/store/app.ts`：hydrate、空の取得済み時間ファイル作成、確認済みキャッシュ除去も変更パスへ登録。
- 既存のアップロード、再DLによるSHA照合、再試行、cloud coverage、停止時の境界と期限は変更していない。
- ファイル形式、NQ/GCの分離、板・約定内容、保持期間、設定、描画、配信間隔は変更していない。

統計用キャッシュはファイル名とsizeだけで、本文や展開済み約定を保持しない。通常処理は既存の単一writerを前提とする。外部ツールによる直接ファイル変更を毎秒検出する用途ではない。外部保守後は既存の再起動時確認／明示的全体確認が必要。
毎秒のディレクトリ一覧走査、AppStoreのpublish・fingerprint照合は残しており、保存処理全体をイベント駆動化した変更ではない。

## 隔離比較

実行：

```sh
node server/tools/perf/maintenance-cpu-benchmark.ts \
  --before=/tmp/cpu-maintenance-baseline-1793383461333/local.ts \
  --out=data/cpu-maintenance
```

比較元は変更前に保存したLocalStore。依存importだけ実workspaceへの絶対パスへ書き換えたもので、処理は変更していない。
そのファイルのSHA-256：`0527a4a58be2702e2f9ac686aa49453a4b88115fd8e6527145711385d68330b9`。
生結果：`data/cpu-maintenance/results.json`（SHA-256：`3241e08e4e3d5ea257ca08873a5f04439367b599dcfafa76a7aa6e19e86458e6`）。
一時保存先・合成入力のみ、実REST／WS／App Storage通信なし。

各条件3回、2回目は実行順を反転。NQとGCそれぞれ12,000個の断片区間を初期状態に持つ。
これは断片の多い場合を明示的に作った入力であり、公開データの実測分布ではない。
初期化と最初のmaintenanceは計測外。
固定作業量を待ち時間なしで実行した比較であり、60秒間の実ライブ負荷ではない。

| 合成条件（NQ＋GC） | CPU時間 前→後 ms・中央値 | 所要時間 前→後 ms・中央値 | CPU時間削減 |
|---|---:|---:|---:|
| 区間更新12,000回・繰返しと巻戻りを含む | 19,828.894 → 1.480 | 17,435.990 → 1.461 | 約99.99% |
| 保存変更なし・maintenance各銘柄60回 | 1,900.391 → 871.480 | 1,626.033 → 732.909 | 約54.1% |
| 各銘柄60秒分：毎秒1列＋100約定＋maintenance | 24,281.556 → 1,699.332 | 20,347.063 → 1,503.101 | 約93.0% |

CPU時間の3回最小〜最大ms：

| 条件 | 前 | 後 |
|---|---:|---:|
| 区間更新 | 19,489.544〜20,697.955 | 1.362〜5.696 |
| 変更なし | 1,874.334〜1,903.628 | 808.376〜877.273 |
| 書込あり | 22,803.773〜24,975.442 | 1,695.186〜1,842.239 |

書込ありのイベントループ最大停止・3回中央値：210.371 → 20.873ms。
区間更新の同期ループを意図的に一気に実行した場合は17,448.305 → 11.674ms（後者は監視の約10ms分解能付近）。
変更なしのcoverage書込は120→0回、書込ありは120→120回。必要な永続化は減らしていない。
変更なし／書込あり共通で全ファイルstat集計120→0回、一覧取得360→240回。
後者でもgzip回転等の既存一覧走査は残る。

RSS終了値・3回中央値（MiB）：

| 条件 | 前 | 後 |
|---|---:|---:|
| 区間更新 | 352.8 | 356.2 |
| 変更なし | 363.4 | 347.0 |
| 書込あり | 415.6 | 353.2 |

前後・各条件を同一プロセスで順次実行しており、RSS／heapはGCと先行条件の影響を受ける。冷間独立プロセスの比較ではなく、メモリ削減の確定値とはしない。

全条件・全3回で前後の取得済み区間ハッシュが一致。変更なしは各銘柄96ファイル・5,905bytes、書込ありは98ファイル・28,325bytesで一致。
約定内容・順序・同内容別約定・巻戻り・時刻境界は下記の実読取試験で確認。
この比較はLocalStoreの該当処理の効果であり、公開環境の総CPU、履歴処理との競合、0.5コア到達、高流量の安定性を証明しない。

## 確認手順・結果

```sh
node --test --test-concurrency=1 \
  server/test/store-maintenance-cpu.test.ts server/test/memory-performance.test.ts \
  server/test/app-storage.test.ts server/test/phase2a.test.ts \
  server/test/phase2a-fixes.test.ts server/test/phase2b.test.ts \
  server/test/trade-read.test.ts server/test/vp.test.ts server/test/vp-seam.test.ts
pnpm --filter @workspace/receiver typecheck
pnpm --filter @workspace/receiver exec tsc --noEmit --target ES2023 \
  --module NodeNext --moduleResolution NodeNext --strict \
  --allowImportingTsExtensions --verbatimModuleSyntax --skipLibCheck \
  --types node tools/perf/maintenance-cpu-benchmark.ts
pnpm --filter @workspace/receiver build
git diff --check
```

- 92試験合格、失敗0。製品・試験・計測ツールの型検査、ビルド、diff検査合格。
- 2,000件の決定的乱数区間で従来の全体ソート結果と一致。隣接・橋渡し・既存包含を確認。
- 未変更indexのinode／mtime／本文不変。追加、gzip回転、保持期限境界、hold/release、空の取得済み区間、再起動、保存待ち中の区間追加を確認。
- 部分履歴の置換失敗時に既存gzip／coverage不変、既存行順・数量・同内容別約定を維持。
- ダミーApp Storageでhydrate・確認済みキャッシュ除去・空時間ファイルの統計を全体再集計と照合。
- 既存の停止期限、書きかけ非送信、再DL照合、失敗再試行、取得共有、NQ/GC分離の回帰試験を再利用・実行。
- フロントを変更しておらず、実ブラウザの追加起動・画面試験はしていない。再ビルド後も主bundleは`index-CdOo-ZK5.js`。

## 仕様との差分・戻し方

データ内容・保存形式・保持規則の変更なし。仕様書・設定・依存・Run設定の変更なし。
戻す場合は今回の`server/src/store/local.ts`と`server/src/store/app.ts`の差分のみを逆適用する。保存データ変換や削除は不要。既存の他機能をresetしない。
既存受信プロセスは再起動していないため、本修正を稼働中プロセスへ反映したとは扱わない。公開判断・公開操作はユーザーが行う。

## 終了・未確認

中断した監査の自分のブラウザはBrowser.close後にPID消滅、ダミーhubは2銘柄とも接続0、専用サーバーPID消滅、18815/9233番ポート閉鎖を確認済み。
本比較のNodeプロセスも正常終了、作成した一時データはfinallyで除去。既存受信とユーザー画面は停止していない。
未確認：公開でのCPU・履歴競合・長時間メモリ・実上流の鮮度。本変更だけで既存の欠けや公開の重さ全体が解消したとは扱わない。
