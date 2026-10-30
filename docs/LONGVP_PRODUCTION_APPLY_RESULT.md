# 公開停止後の購入LONG VP反映記録

状態：購入42日の日次反映とクラウド再読取照合が完了。公開は停止したまま。修正版の公開・起動後確認は未実施。

## 停止確認と範囲

ユーザーによる公開停止後、公開状態取得で success:true / isDeployed:false を確認した。Workspaceの停止ではなく公開側の停止を確認してから作業した。

対象：2026-10-01〜10-29の丸1日そろった取引日。NQ・GC各21日、計42日。限月はNQZ26・GCZ26（保存表記NQZ6・GCZ6）。部分日の9/30・10/30は対象外。prod/trades・coverage・rolls・設定は変更対象外。

## 停止後に新規作成した原本バックアップ

保存先：`prod/backup/longvp/20261030T173203Z-1b38caf9/`

既存原本：4ファイル（NQ4・GC0）。対象42日のうち元々存在しないもの：38。gzipを展開・再圧縮せず元バイト列を保存し、世代指定で再ダウンロードしてSHA-256一致を確認した。

クラウド台帳：`prod/backup/longvp/20261030T173203Z-1b38caf9/manifest.json`

台帳SHA-256：`f7d1e600bb57e942f8fd8c55fec903870950209e9b450479c727b7786c21ea26`

| 元ファイル | 元世代 | SHA-256 |
|---|---|---|
| prod/longvp/NQ/days/2026-10-22.json.gz | 1793249909662040 | `17d058fd659a7ad2516d0d902ac55dee2b309fc4d8a7f4b6075d80f9fae425d3` |
| prod/longvp/NQ/days/2026-10-23.json.gz | 1793257320436480 | `20295735215b10d1570502ebfc9a50de4c7ea1c51ad5be5f49180cb4d4c3c715` |
| prod/longvp/NQ/days/2026-10-26.json.gz | 1793265040729235 | `bf7091fb5004a9a12612d69d4b098c6aab13745e3497ff53f64cdbc9e5309388` |
| prod/longvp/NQ/days/2026-10-27.json.gz | 1793271984653294 | `45c4c27ec677055a9ee312e70b14b799d4235c9a3577de5dce557cb57ed20d96` |

ローカル台帳：`data/longvp-maintenance/stopped-20261030T1731-backup/backup-manifest.json`。前回調査時のバックアップも削除していない。

## 反映結果

2026-10-30 17:36:28.938 UTC（10/31 02:36:28.938 JST）に42日すべての照合が完了した。

| 銘柄 | 取引日数 | 承認一覧と一致した本番枚数 |
|---|---:|---:|
| NQ | 21 | 13,357,979 |
| GC | 21 | 2,763,027 |

既存4ファイルを置換、新規38ファイルを作成。いずれも元世代一致／不存在条件で書き込んだ。
各日についてクラウドから世代指定で読み直し、gzipハッシュ・1分足合計・VP合計・承認一覧の出来高・限月・complete:trueを確認した。
各ファイルの照合中に世代が変わっていないことも確認した。不一致0件。合計だけの照合ではない。

照合台帳：`data/longvp-maintenance/stopped-20261030T1731-apply/verified.json`

各日の照合一覧：`data/longvp-maintenance/delivery/applied-42-days.csv`
（銘柄・取引日・承認枚数・本番VP枚数・本番1分足枚数・complete・世代・SHA-256）

原本採取完了17:32:02.951 UTCから全日照合完了まで約4分26秒。
これは公開停止の操作時間、停止確認前の時間、および今後の公開・起動時間を含まない。
今回のコード変更はなく、先に合格した250テストを再実行したことにはしない。
検証根拠は実ストレージへの条件付き書込みと、書込み後の全42日の再ダウンロード照合である。

## 復元

復元が必要な場合は公開停止を維持／再確認し、今回のバックアップ台帳を使う。旧4日を元のバイト列へ条件付き復元し、元々なかった38日はこのrunのままなら条件付き削除する。他writerの更新は強制上書きしない。

手順は docs/LONGVP_PRODUCTION_MAINTENANCE.md のG節。バックアップ・候補・台帳を保全し、復元を理由に旧版を自動公開しない。

今回の原本へ戻す際の指定例（公開停止を新たに確認し、停止確認記録を更新してから実行）：

```sh
node server/tools/run-approved-longvp.ts \
  --action=restore \
  --backup=data/longvp-maintenance/stopped-20261030T1731-backup/backup-manifest.json \
  --out=data/longvp-maintenance/stopped-20261030T1731-restore \
  --stopped-proof=data/longvp-maintenance/stopped-proof.json
```

復元は今回実行していない。原本バックアップを残したまま、購入データの反映済み状態を維持している。

## 公開・起動後の確認

この作業ではPublishしない。修正版の公開と、起動後のNQ/GC受信・停止中不足分の履歴再取得・日次の継続処理は未実施。保存データの照合と、再公開後の稼働確認を混同しない。

照合後にも公開状態取得でsuccess:true / isDeployed:falseを確認した。
旧版の再開は古いキャッシュによる上書きリスクがあるため、再開対象が修正版であることの確認が必要。
検証ブラウザは使用していない。終了時のローカル検証ブラウザの稼働プロセス0を確認した。
