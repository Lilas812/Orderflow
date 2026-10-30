# LONG VP反映候補ツール・隔離検証報告

2026-10-31 JST。**候補作成・隔離検証済み。本番未反映。**

## 1. 今回の範囲と状態

ユーザー承認「本番書込なしで実装する」に基づく作業。
本番の既存ファイルを保全して、確定した欠損区間の補填候補をローカルへ作る。
既存の集計行が入っている区間の置換、本番へのupload/applyは実装・実行していない。
**完全な本番投入ツールや、購入履歴全体の反映完了とは扱わない。**

- 既存の製品受信・保存・画面コード、仕様正本、設定、依存、Run・デプロイ設定は変更なし。
- 本番との通信は、既存App Storageクライアントによる`prod/longvp/{NQ|GC}/days/`のlist/downloadのみ。
- TICK STREAM接続、アプリの初期化API呼出し、本番保存、Publish、既存受信の停止・再起動なし。
- 隔離購入データの元の`active.json`や約定ファイル、coverageを書き換えていない。
- 前回の高CPU、設定読取、LONG VP自動蓄積の未解明原因を解決したとは扱わない。

基点commit: `458d0533c176edc7bf407d7f93705eb5820db447`。今回のツール等は追加差分。
これは公開稼働版のcommit照合を意味しない。

## 2. 追加ファイルと関数

| ファイル | 内容 |
|---|---|
| `server/src/import/longvp-promotion.ts` | `fillDay`：銘柄・限月・区間を検証し、既存行を保護して全30分枠だけ補填。`checkGuards`：保存先の存在・ハッシュ照合 |
| `server/src/import/longvp-package.ts` | `preparePromotion`：原本のバイト単位バックアップ、候補のgzip保存・再読取・seal、失敗／再実行／排他制御。`captureInventory`：読み取り専用スナップショット。`recheckPromotion`：新しいスナップショットとの比較 |
| `server/tools/snapshot-longvp-production.ts` | list/downloadのみのCLI。既存出力ディレクトリは拒否 |
| `server/tools/prepare-longvp-promotion.ts` | ローカル候補作成・再照合CLI。`--apply`・`--upload`を含む未知の引数は拒否 |
| `server/test/longvp-promotion.test.ts` | 23件の追加試験 |
| `server/test/longvp-promotion-isolated-check.ts` | 実購入集計と本番スナップショットを使うオフライン照合 |

## 3. 安全側の採用条件

1. 入力は期待SHA-256付きの限月別日次集計。銘柄混在・同一限月日の二重指定・解析不正を拒否する。
2. 限月対応、UTC半開区間、根拠の明示が必要。限月名の文字列や現在の期近から過去の適用期間を推測しない。
3. 既存のVP行または1分足が1行でもある30分枠には足さない。既存のgapsに含まれていても、行の存在を優先して保護する。
4. 補填する30分枠は、既存側で全体が欠け、購入側で全体が取得済み、割当区間内、観測時点で終了済みであることが必要。
5. 30分より細かい欠け、境界をまたぐ枠、購入側にも欠けがある枠、行のない枠は保留。行がないだけで「完全取得の0枚」としない。
6. 旧行の内容・相対順序と既存の限月indexを維持。追加分だけindexを対応付け、時刻順に差し込む。
7. 買い・売り・不明方向を別々に保持。不明方向を買い売りへ配分しない。価格加重和は整数BigIntで計算する。
8. 1日ずつ処理し、既存LONG VP読取と同じ4MiBの展開上限を適用。月全体の価格配列や個別約定をRAMへ載せない。
9. 保存後に既存の`validateDay`と再読取で照合してから、ローカルの世代・選択ポインターを確定。原本バックアップは別に保全する。
10. 同一計画の再実行はseal・成果物・入力を照合し、同じ候補を再利用する。rename後の中断も復帰できる。選択ポインターのみ再設定する。

新規JSONはツール専用の計画・検証記録であり、製品の日次保存形式は変更していない。
根拠欄が空でないことは機械検証するが、根拠そのものが期近適用の証拠として十分かは人のレビューが必要。

## 4. 実データを使った結果

### NQ

本番の4取引日（10/22・23・26・27）のスナップショットを保全。
そのファイルに既に記録された`NQZ6`の区間だけで、購入側`NQZ26`との対応を宣言した。
年表記の対応には既存`canonical`を使用。ほかの過去日へ適用期間を広げていない。

| 取引日 | 本番スナップショット枚数 | 補填枠数 | 追加買い | 追加売り | 候補の枚数 |
|---|---:|---:|---:|---:|---:|
| 2026-10-22 | 733,666 | 10 | 27,808 | 30,373 | 791,847 |
| 2026-10-23 | 612,493 | 1 | 20,698 | 20,705 | 653,896 |
| 2026-10-26 | 561,572 | 0 | 0 | 0 | 変更なし |
| 2026-10-27 | 422,344 | 0 | 0 | 0 | 変更なし |

**追加候補は計11枠・99,584枚。**

- 対象購入集計3ファイルと本番スナップショット4ファイル、計7ファイルのハッシュ不変を確認。
- 2つの候補日について、既存分＋採用枠の全価格別買い／売り／不明数量が出力と一致。
- 旧行の内容・相対順序、既存限月indexの保持を確認。
- 取込側の元`active.json`は不変。候補作成の再実行で数量・出力ハッシュは増えない。
- 欠けは残っており「完全値」には格上げしない。NQの既存隔離取込で保留されていた行を、今回勝手に採用していない。
- 新たな過去日19日や、既存行のある重複枠は今回の採用対象外。

### GC

- 21限月・278限月日（異なる日付は23取引日）の入力を検査。
- 各入力と元`active.json`のハッシュ不変、再実行で増えないことを確認。
- 期近適用の期間を確定する根拠を今回追加できていないため、割当は空のままとした。
- 結果は`no_changes`。候補へ0枚採用。21限月を同時刻の期近として足していない。
- スキップ13,344枠は278限月日×48の**延べ枠数**であり、異なる欠損区間の数ではない。
- 既存の購入GCデータと不明方向の採用結果を変更していない。GCの方向不明を含むコピー処理は小さな入力の単体試験でも確認した。

### 保存場所

`data/longvp-promotion/isolated-20261030T163316Z/`

- `NQ-plan.json`、`GC-plan.json`：実行した入力ハッシュ・限月・区間
- `nq/active.json`、`gc/active.json`：**ローカル候補**の選択
- 各`generations/<計画ハッシュ>/manifest.json`：採用枠、スキップ理由、出力ハッシュ、反映前条件
- 各`backups/`：本番スナップショットのバイト単位コピー
- `verification.json`：実データ照合結果

本番スナップショット：

- `data/longvp-promotion-snapshots/20261030T162958Z-nq/`
- `data/longvp-promotion-snapshots/20261030T162958Z-gc/`
- 再照合：`data/longvp-promotion-snapshots/20261030T163409Z-recheck-nq/`

いずれも既存の`data/`除外対象。Publishしても自動反映されない。

## 5. 変更検出と残る競合

スナップショット取得は一覧を2回、各gzipを2回読み、観測できた一覧・本文の変化を拒否する。
SDKのlist実装は`autoPaginate:true`。今回の実通信は次の読み取りだけ。

| 操作 | list | download |
|---|---:|---:|
| NQ初回 | 2 | 8 |
| GC初回 | 2 | 0 |
| NQ再照合 | 2 | 8 |

2026-10-30 16:34:21.459 UTCの新しいスナップショットで、変更候補2日分の期待SHA-256が一致。
古いスナップショットを再利用する照合は拒否する。
新規日の期待値は「不存在」であり、反映前に同名ファイルが増えた場合も拒否する。

**これは原子的スナップショットやクラウドCASではない。**
照合直後に別の書き手が更新する競合は残るため、本番への安全な書込保証には使えない。
本番用writer、世代条件付き書込み、既存集計処理との排他は今回実装していない。

## 6. 実行コマンド・試験

```sh
# 既存ディレクトリは再利用しない。ローカル保存だけでクラウドへは書かない。
node server/tools/snapshot-longvp-production.ts \
  --symbol=NQ --out=data/longvp-promotion-snapshots/20261030T162958Z-nq
node server/tools/snapshot-longvp-production.ts \
  --symbol=GC --out=data/longvp-promotion-snapshots/20261030T162958Z-gc

node server/test/longvp-promotion-isolated-check.ts \
  --nq-inventory=data/longvp-promotion-snapshots/20261030T162958Z-nq/inventory.json \
  --gc-inventory=data/longvp-promotion-snapshots/20261030T162958Z-gc/inventory.json \
  --out=data/longvp-promotion/isolated-20261030T163316Z

# 生成済み計画の再実行（実施結果already_prepared）
node server/tools/prepare-longvp-promotion.ts \
  --plan=data/longvp-promotion/isolated-20261030T163316Z/NQ-plan.json \
  --out=data/longvp-promotion/isolated-20261030T163316Z/nq

# 再照合（GENはnq/active.jsonのgeneration）
node server/tools/prepare-longvp-promotion.ts \
  --manifest="$GEN/manifest.json" \
  --recheck=data/longvp-promotion-snapshots/20261030T163409Z-recheck-nq/inventory.json

node --test --test-concurrency=1 \
  server/test/longvp-promotion.test.ts server/test/databento-import.test.ts \
  server/test/long-vp.test.ts server/test/long-vp-app.test.ts
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver run build
node --check server/tools/prepare-longvp-promotion.ts
node --check server/tools/snapshot-longvp-production.ts
```

- 関連試験：**52/52合格**（新規23、既存29）。
- 型検査・ビルド・両CLI構文確認：成功。
- フロント成果物の主JSは`index-CdOo-ZK5.js`のまま。UI変更なし。
- 中断・例外・rename前後の失敗、実際の並行呼出し、ロック解放、入力変更、候補破損・消失、境界・未終了枠、銘柄分離、既知行の保護、数量不一致、圧縮展開上限を検証。
- 単体試験は小さな合成入力。実データ照合とは区別している。

## 7. 本番反映前に残る条件

1. 新規の過去日とGCについて、期近適用の限月・UTC区間の根拠または明示的な対象選択を確定する。
2. 既存行を含む枠や30分未満の欠けを扱う場合は、集計の数量差だけで決めず、元約定と完全性を照合する。
3. 原約定・coverage・長期集計の反映範囲を整合させる。今回作成したのはLONG VP集計候補であり、原約定の反映ではない。
4. 現行`AppLongVp`は不完全日を再構築し、`improvesDay`判定を通った場合に保存する。既存の保全判定を外さない。原約定未更新のまま集計だけ反映した場合の継続性は未検証。
5. 本番用writerと競合対策を隔離検証し、その後に本番実行の別承認を得る。今回の再照合一致を無条件の書込み許可にしない。
6. LONG VP日次自動蓄積が進まない問題は別の調査が必要。購入履歴の候補作成だけでは解消していない。

実API／Canvas画面の変更確認は今回実施していない。
確認したのは実ファイルの変換・既存製品バリデーター・数量・価格別・行順・再実行・スナップショット照合まで。
実上流ライブ、本番反映後の画面、購入データ全量の本番採用は未確認。

## 8. 終了・戻し方

- 今回の検証ブラウザ・アプリサーバー・WS接続は新規起動していない。
- 自分のスナップショット／候補作成／実データ照合Nodeプロセスの残存0を確認。
- 既存受信・プレビュー用サーバー・ユーザーのブラウザには停止操作をしていない。
- 原本や本番を変更していないため、本番データの復元操作は不要。
- 新規ツールを使わなければ既存製品への動作影響はない。既存データや作業差分の削除・resetは行っていない。
