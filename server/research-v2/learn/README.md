# 集約特徴Aの隔離学習

これは研究専用で、製品の起動・依存・公開設定・保存データを変更しない。
承認範囲はtrain+validationの18セッション、拡張窓10評価日、
300秒端点回帰・900秒上昇分類・300秒値幅回帰のみ。
test、TabPFN、1秒系列/画像入力、反転・本人ラベル、売買は未承認。

## 依存の準備

通常のReplit依存追加ツールはワークフローを再起動するため使用しない。
ユーザーがReplit Shellで下記を実行し、既存Nix CPython3.12を再利用する。
virtualenv、rootのrequirements、module追加は使わない。

```sh
uv pip install \
  --python /nix/store/iizfzmqjdfvbyx82gqw92glb5zl6m4my-python3-3.12.12/bin/python3 \
  --target data/research-v2/learn-01/python-site \
  -r server/research-v2/learn/requirements.lock
```

`requirements.lock`は直接・間接依存6件の版を全て固定。
実行時にも版と`python-site`内の所在をassertする。
別のNixストアのPython3.11/3.12を使う場合は`execute.sh`のPYTHONを明示変更し、
新コード版として記録する。暗黙に3.13へ切り替えない。
ネイティブライブラリ不足なら依存エラーで停止し、製品設定は変更しない。

この環境ではpip wheelのimportに既存GCC15.2のC++/OpenMPランタイムが必要だった。
`execute.sh`が既存`/nix/store/xc0ga87wdclrx54qjaryahkkmkmqi9qz-gcc-15.2.0-lib/lib`
を研究プロセスの`LD_LIBRARY_PATH`だけへ追加する。新たなシステム依存は入れず、
製品・ワークフローの環境変数は変えない。2ライブラリのSHAを実行manifestへ記録する。

## 実行

すべてプロジェクトルートで実行する。既存出力への再書込みは拒否する。
以下は完了済みのパスを削除してやり直す指示ではない。

```sh
# 専用データルート以外に書かない。ここ以外のmkdirや移行はしない。
PYTHON=/nix/store/iizfzmqjdfvbyx82gqw92glb5zl6m4my-python3-3.12.12/bin/python3
PYTHONDONTWRITEBYTECODE=1 nice -n19 timeout -k10s 1790s "$PYTHON" \
  server/research-v2/learn/audit.py before
PYTHONDONTWRITEBYTECODE=1 nice -n19 timeout -k10s 1790s "$PYTHON" \
  server/research-v2/learn/prepare.py
bash server/research-v2/learn/execute.sh test
bash server/research-v2/learn/execute.sh run --out data/research-v2/learn-01/run-01
bash server/research-v2/learn/execute.sh run --out data/research-v2/learn-01/run-02
PYTHONDONTWRITEBYTECODE=1 nice -n19 timeout -k10s 1790s "$PYTHON" \
  server/research-v2/learn/audit.py after
PYTHONDONTWRITEBYTECODE=1 "$PYTHON" server/research-v2/learn/report.py
node --test server/test/research-v2*.test.ts
pnpm --filter @workspace/receiver run typecheck
```

依存待ちや失敗時は学習完了と報告しない。実行が30分/3GiBを超える場合も停止する。
資源は各`resources.json`にCPU user/system・peak RSS・経過秒・nice・制限値を記録。
外側timeout1790秒、10秒後強制終了で合計30分以内。
`prepare.py`は標準ライブラリだけで動作し、Y数値を読まずに台帳SHAを固定する。
共有historyは品質マスクと過去基準だけに使い、モデルへ1秒系列を入力しない。

## 固定した具体値

- QuantileRegressor：quantile=.5、alpha=.01。数値Xをtrain内標準化した後の尺度で固定。
  Ridgeとは正則化の定義が違うため、alpha=1をそのまま流用しない。探索なし。
- 分類の直前方向基準：train内で過去300秒の符号ごとにLaplace+1上昇率。
  過去値未計算/符号の学習例なしは全体のLaplace+1比率に戻して件数を記録。
- GBDT：指定設定に加えてforce_col_wise=True、全seed=20261105。
- 既存`target_end_us`（最大900秒）を全目的のpurgeへ保守的に適用。
- 統計は日を同じ順序で対応再抽出、固定2,000×10のインデックスを全比較へ共用。

## 出力と原状復帰

`data/research-v2/learn-01/`は非公開のGit対象外。
`preparation/`：固定台帳・理由集計・封印証明・採用train/validationだけのready。
`run-01/`、`run-02/`：予測・日別損失・日等重み集計/CI・較正・fold監査・警告・資源。
`audit-before/`、`audit-after/`：原本/世代/既存出力の保護・再現性・test漏洩の独立照合。
レポートは`docs/RESEARCH_V22_LEARNING_REPORT.md`。

この研究ディレクトリのコード/出力を使用しなければ元の製品動作のまま。
依存は専用siteだけに入り、グローバルパッケージを置換しない。
製品コード・設定やデータを巻き戻す操作は不要。原本/既存出力を削除しない。
Gitへはコード・lock・文書のみをpushし、dataや購入データ・予測を含めない。
