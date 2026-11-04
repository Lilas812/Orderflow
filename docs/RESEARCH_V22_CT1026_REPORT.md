# v2.2 NQ CT10/26標本追加と学習比較設計

## 実施内容・影響範囲・戻し方

d7d1f6eの研究結果を基準として、NQのCT2026-10-26だけをグリッドへ追加。
新しい設定と出力を作り、前回の設定・出力・研究世代を上書きしない。
原状復帰は`grid-v22-nq-purchase-only.json`と`nq-rebuilt-full-01`を再び参照するだけ。
active・製品参照先を変更していないので、データ復元・Publish・サーバー再起動は不要。

着手時HEADは`e84e6d6d39d9b600860e4cdb1669cb0fff1be392`。
d7d1f6eとの差は既存の`.agents/agent_assets_metadata.toml`の14行追加だけ。
これを保持し、製品・計算コードはd7d1f6eと同一のまま使用した。

## 変更ファイル

- `server/research-v2/add-nq-ct1026.ts`：
  `addNqCt1026()`でGCの既存CT10/26グリッドと一致する1区間だけをNQへ追加。
  元設定をcloneし、既存区間・重なりを拒否。追加を戻すと元設定にdeepEqualであることを検査。
- `server/research-v2/grid-v22-nq-ct1026.json`：新設定。
  NQZ26のroot／GC／計算／sourceKind／日付分割は従来のまま。
- `server/research-v2/verify-ct1026.mjs`：
  既存samples/features/targets/splitsの全列・順序を銘柄別にストリームSHA照合。
  共有historyの旧秒をコンパクトなseries別区間索引で選び、全列・順序をSHA照合。
  追加秒は新NQアンカーが参照する窓に限る。月全体のhistoryをRAMへ保持しない。
- `server/test/research-v2-ct1026.test.ts`：
  1,440アンカーだけの追加、元設定不変、GC不変、二重追加・重なり・異なるGC参照の拒否。
- `docs/RESEARCH_V22_MINIMAL_LEARNING_DESIGN.md`：学習比較の提案。未承認・未実施。
- この報告書と研究の承認境界に関する作業メモ。

製品コード・仕様本文・依存・公開設定・保存形式・既存世代は変更していない。

## 設定と確認方法

追加区間はCT10/26 17:00〜翌日17:00、
UTC `[2026-10-26T22:00:00Z, 2026-10-27T22:00:00Z)`。
`fromUs=1793052000000000 / toUs=1793138400000000 / stepUs=60000000`。
CT16〜17の休止もグリッドには存在するが、coverageやYが完全であると偽装しない。
追加標本数は24時間×60＝1,440。GCと同じ60秒間隔。

出力コマンド（再実行では既存を上書きしないよう新しい`--out`を指定する）：

```sh
node --max-old-space-size=256 server/src/research-v2/cli.ts \
  --config server/research-v2/grid-v22-nq-ct1026.json \
  --out data/research-v2/ct1026-full-01
node --max-old-space-size=256 server/src/research-v2/cli.ts \
  --config server/research-v2/grid-v22-nq-ct1026.json \
  --out data/research-v2/ct1026-full-02
node --max-old-space-size=256 server/research-v2/verify-batch.mjs \
  --first data/research-v2/ct1026-full-01/dataset \
  --second data/research-v2/ct1026-full-02/dataset \
  --out data/research-v2/ct1026-verification-01
node --max-old-space-size=256 server/research-v2/verify-ct1026.mjs \
  --old data/research-v2/nq-rebuilt-full-01/dataset \
  --new data/research-v2/ct1026-full-01/dataset \
  --audit data/research-v2/ct1026-audit-01 \
  --out data/research-v2/ct1026-comparison-01
node --test server/test/research-v2*.test.ts
pnpm --filter @workspace/receiver run typecheck
```

両出力の`manifest.json`・`config.json`と、
`ct1026-verification-01/verification.json`、
`ct1026-comparison-01/comparison.json`を確認すると再現性・差分の範囲を検証できる。
features/targetsは値の分析を行わず、既存行のバイト列比較だけに使った。
verify-batchはYの`missing_reason`等の品質件数を確認するが結果値・分布は分析しない。

## 実行した確認と結果

### 全期間2回出力

- 1回目：`data/research-v2/ct1026-full-01/dataset/`
- 2回目：`data/research-v2/ct1026-full-02/dataset/`
- 各フォルダに現行CSV・共有history・manifest・config・`dataset-v2.zip`を保全。
- **両方のcontent_hashが一致**：

```text
0474911e318c54115ddd8f93042c278c424f6e3144a1d9c450b1e832e34380dc
```

同じ計算コードsourceHash：
`642dbaf21e7f6c342a4408f7f32b51fb48bd525f967d69fb0be2904f69f357a7`

同じsettings_hash：
`ff6b4242782e2b1f655b490d6897280b87004c3afef0e8440a045ca4e6f088e5`

入力版は前回と全項目一致：
NQ `fdfcc5d65bb2bda194380d400d75636911d0e06cf89895a0a8c5398af9b78539`、
GC `c29d06eb71956f205048af93a81f871de51ba266a5594ab00a4b07afcb9fd866`。
計算・分割・入力世代を変えず、グリッドの1区間追加だけであることをdeepEqual検査した。
実行時Git revisionは着手時e84e6d6。今回の新設研究ツール等は作業差分の状態で実行した。

| 数量 | 前回 | 今回 | 差 |
|---|---:|---:|---:|
| samples | 64,800 | 66,240 | NQ CT10/26だけ+1,440 |
| features | 64,800 | 66,240 | 同+1,440 |
| targets | 194,400 | 198,720 | 同×3期限、+4,320 |
| splits | 64,800 | 66,240 | 同+1,440 |
| 共有history秒行 | 3,907,140 | 3,991,800 | 新標本の参照窓だけ+84,660 |

新標本の時刻は全1,440点で一意、すべてNQZ26、60秒の整数グリッド上、test所属。
増えた共有秒はNQの追加アンカーの過去1,800秒窓の和集合内だけ。
追加1,440標本に付随するfeatures・targets・splits・共有秒の増加であり、
他の日の新標本や、GCの新標本はない。legacy history.csvは今回も0行。

### 既存NQ22セッション・GC全行の完全一致

ヘッダー全列、旧標本IDの集合、抽出した全行の内容と順序を照合して合格。
ここでのSHAはCSV行末をLFとして抽出した旧行の順序付きSHAで、
「数量だけ同じ」ではなく価格・参照・マスク・特徴・Y・split等の全列を含む。
共有historyは旧seriesの秒区間で抽出し、NQ旧1,911,240行／GC1,995,900行が不変。

| 表 | NQ旧行数 | NQ旧行SHA（前後一致） | GC行数 | GC行SHA（前後一致） |
|---|---:|---|---:|---|
| samples | 31,680 | `a40a0ee9fa0eefa3ca45a26291fe30c944eecd80337652e547c1fe9a02328923` | 33,120 | `e3ab091a41787d5dc51bc8c4f7152a14bbbbd287f8e268a396b383b4fc0478ae` |
| features | 31,680 | `3ecfa98334b60e0efe444c99860e432df80055ae4947a47c7dd64663224813b0` | 33,120 | `b77fcaf61bd8f5833503b6409d133904883e4c082b300b0d84ef70214680f38e` |
| targets | 95,040 | `ef89bed177b1ffea6a932fc207f6221201396a18881ac470bc52276f1cedc6e8` | 99,360 | `66818d706f711d79f65189bd41306c84b76762971e4904f8c85af4018a227f8f` |
| splits | 31,680 | `88cf8f93f7a6ff6425624ebe37b7c013940b077771b835a7390993b54f901ab4` | 33,120 | `2872e87fe109af4c5398197db9a62fa4f151a27b14f106e46c277c9e9e5c539e` |
| 共有history | 1,911,240 | `cbee1aefecb083b3d032fc49b22b67b3ae755c6b8372f6f3d5d8d254600f93ff` | 1,995,900 | `741703dc414bfe34283666029f8d035cf2768cc23508d88a417d5721005c02ab` |

### fold別件数

| 銘柄 | fold | セッション 前→後 | 標本 前→後 |
|---|---|---:|---:|
| NQ | train | 13→13 | 18,720→18,720 |
| NQ | validation | 5→5 | 7,200→7,200 |
| NQ | test | **4→5** | **5,760→7,200** |
| GC | train | 13→13 | 18,720→18,720 |
| GC | validation | 5→5 | 7,200→7,200 |
| GC | test | 5→5 | 7,200→7,200 |

既存行のsplit・status・reasonは前回と完全一致。日付境界・purge規則を変更していない。

### 試験・資源・原本保護

- `node --test server/test/research-v2*.test.ts`：**22/22合格、失敗0**。
- `pnpm --filter @workspace/receiver run typecheck`：合格。
- 製品コード変更なし。server全体試験・UI試験・ビルドは今回の指定範囲外で、再実行していない。
- `verify-batch.mjs`：全payload SHA、content_hash、同一入力版、
  shared history重複／順序／参照、sample ID、split整合、入力1,014ファイル、
  2つのZIPの`unzip -t`も合格。
- 独立`verify-ct1026.mjs`：前述の既存全行・追加範囲の照合に合格。
  新設ツールの初回だけ、fold集計のため標本全列を保持して256MBヒープ上限でOOM停止。
  samples/splitsの逐次読み合わせへ変更し、同じ256MBヒープ上限で照合だけ再実行して合格。
  製品・計算コードや生成済み出力を直していない。出力の再生成も不要だった。
  初回失敗ログは`ct1026-audit-01/comparison-first-attempt.log`へ保存。
- 再照合は113.27秒、CPU user34.76秒／system18.28秒、peak RSS499,092KiB。
  ヒープ上限256MBはRSS全体の上限を意味しない。
- 1回目出力249.75秒・peak RSS476,828KiB、2回目269.21秒・441,476KiB。
  これは隔離CLIの資源値であり、製品のCanvasや公開サーバーの負荷比較ではない。
- 原本ZIP・旧NQ/GC世代・verified stage・active、
  新購入専用NQ世代・前回2出力・前回固定設定を含む**22,826ファイルの集合・SHAが不変**。
  `ct1026-audit-01/before.json`／`ct1026-comparison-01/protected-after.json`で証明。
  うち従来の原本・既存世代等22,237ファイルも以前の監査リストと着手前に一致した。
  製品dataへ自分の処理から書かず、稼働中受信の停止／再起動もしていない。

### 終了・残存確認

全出力・照合は終了。自分の研究CLI／node testのPID残存0を確認した。
2出力下の`.v2-working-*`／`.v2-bulk-*`／`.order-*`／`input-snapshots`と、
`*.tmp*`／`*.partial*`は0。試験用`/tmp/v2-nq-empty-*`も残存0。
失敗ログ・監査JSON・完成済みCSV/ZIPは意図した証拠として保持し、削除していない。
ブラウザ・アプリサーバー・上流／下流WSは自分では起動・作成していない。
したがって所有ブラウザ／WSの残存はなく、既存プレビューの接続数を0と偽っていない。
既存3ワークフローを停止・再起動せず、接続制限も加えていない。
新設研究ツール以外の製品コード・依存・公開設定・正本はd7d1f6eとの差分0を確認した。

GitHub mainへ新設定・ツール・試験・文書・メモをpushする。
完成データは大きいためignoredの`data/research-v2/`に保持し、Gitへ含めない。
確定したcommitとローカルHEAD／origin/mainの一致はpush後の最終報告に記載する。

## 設計書の承認事項の要約

主候補は300秒端点変化の回帰、補助候補は900秒の上昇／非上昇分類。
最初は集約特徴・NQ/GC別・定数／直前方向／線形／小型GBDTを提案。
生1秒系列・TabPFN・画像・本人ラベル・反転ラベル・売買結果は段階を分ける。
train13日／validation5日／test5日で、test結果を見て調整しない。

承認が必要なのは学習開始、目的と期限、入力・品質条件、モデル群、
前処理、評価・実用差、環境・時間／資源上限、Python等の依存、
データ受け渡し、TabPFN版／ライセンス、本人ラベル、反転定義、売買ルール等。
設計書は各項目で選択肢・推奨・理由・ユーザー判断を分けている。
**学習・モデル比較・依存追加・重量DL・売買は行っていない。**

## 仕様との差分・未解決・次の候補

- 仕様との差分：なし。今回明示承認された研究グリッド追加だけを行う。
- 5 testセッションでは小さな改善の検出や売買優位性の主張は困難。
  固定split・購入期間・既存nullを維持し、データ数の見かけで隠していない。
- 本人ラベル0のため本人の天底判断との比較は不可能。
- event_time_researchなので実際の到着・リアルタイムでの利用可能性は未検証。
- 次の候補（提案のみ）：設計書の承認後の最小比較、
  別途承認した本人判断ラベルの記録・検証。今回は着手しない。
