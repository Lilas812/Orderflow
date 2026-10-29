# 履歴反映修正の公開候補と同梱内容（公開操作なし）

## 候補の識別

- **製品コードの候補commit:** `f3cd203b81b88010273f1012511b0c57dd35952a`
  （2026-10-29 13:20:02 UTC / 22:20:02 JST）。
- 今回の実ブラウザ確認はこのcommitと同じ製品ソースから作成済みの
  `artifacts/heatmap/dist/public`を、隔離HTTPサーバーでそのまま配信する。
  製品コードの差分は追加しない。今回追加するのは検証ツールと証拠報告だけ。
- 最後の完了保存では検証専用ファイルを追加したcommitができる可能性があるが、
  製品候補の内容は上記commitから変えない。公開やcommitの切替は実施しない。

## 比較基準と限界

ローカルGitの最新`Published your App`マーカーは
`02c53c50428c5453f9d936e59712ff377643cd3c`
（2026-10-29 12:34:25 UTC / 21:34:25 JST）。
そのGit trailerには`Replit-Commit-Deployment-Build-Id:
89a3ff57-3252-472d-991d-a7584758f4ae`がある。
前調査で確認したbuild IDとの対応を示す既存メタデータだが、
**マーカーの時刻を公開起動時刻と同一視せず、稼働中の全ファイルがこのGit treeと
同一だと新たに確認したものでもない。** 今回、公開の再取得・ログ追加収集はしていない。

以下の「追加差分」はこのGitマーカー→候補の比較であって、
稼働中の実tree→候補の完全な差分を証明する一覧ではない。
公開版の正確なソース対応を確認できない部分は、前調査の「照合不能」を維持する。

## Gitマーカー以後の追加差分

|commit|内容|製品実行経路への同梱|
|---|---|---|
|`d8b3e86` 12:35:06 UTC|既存の設定保存計測|**含む**。今回の履歴修正以外のサーバー変更。下記参照|
|`f7f1a3b` 12:56:15 UTC|履歴反映・オフラインCPU調査|調査ツール・報告・メモリのみ。CPU対策や同期decode変更ではない|
|`f3cd203` 13:20:02 UTC|今回承認された履歴の限定再検証|frontendのHistoryFreshness/socket/mainと10試験、隔離比較・報告|

### 設定計測（別変更として同梱）

- `server/src/settings/trace.ts`の`SettingsTrace`と、
  `server/src/index.ts`、`server/src/status/app.ts`、
  `server/src/settings/{routes,app,local}.ts`、`server/src/store/objects.ts`のフック。
- `HEATMAP_SETTINGS_TRACE=1`を起動時に指定した場合だけ有効、最大15分、
  工程時間・切断後結果・プロセスCPU/loop等を記録する既存変更。
- 候補にコードがあることと、公開で有効に動いていることは別。
  今回は環境変数の設定・公開での有効化をしていない。
- `server/test/settings-trace.test.ts`、計測ツール2件、既存
  `SETTINGS_INVESTIGATION_REPORT.md`も同梱。
- 詳細は既存報告書。設定保存の期限・CPU/同期decode対策を今回追加したものではない。

## 既に基準treeに入っている変更（候補全体には含まれる）

**Phase 14は候補に含まれる。今回の差分で新しく追加したわけではない。**

- `7e1aeb3`（12:01:25 UTC）:
  glow/block描画、9段パレット、現在板数字、大口板列の出し入れ、
  設定v4と既存UI/サーバーschema・試験、正本へのPhase 14反映。
- `02c53c5`:
  Phase 14のフェード積、数字非表示時の帯非表示、初期値復帰等の承認済み補足、
  証拠・報告の追加。主対象は`current-book.ts`、`glow.ts`、`settings-form.ts`等。
- それ以前の長期VP画面・蓄積、保存あり起動改善、軸AUTO/操作等も親commitから保持される。
  今回それらを削除・分離・再実装していない。

したがって「履歴修正だけを含む製品tree」ではない。
最新Git公開マーカー基準で追加される別の製品変更は設定計測。
Phase 14は基準側にも存在するが、実公開版との完全一致は別途未証明なので、
公開側に既に全て反映済みと断定しない。

## 今回の修正そのもの

- 新規`artifacts/heatmap/src/data/history-freshness.ts`。
- `artifacts/heatmap/src/data/socket.ts`: 完了世代・可視範囲・pending/queueを用いた限定再検証。
- `artifacts/heatmap/src/main.ts`: follow限定の旧再読取処理を一本化、
  過去閲覧中の初回価格中心移動を抑制。
- `artifacts/heatmap/test/history-freshness.test.ts`の10試験。
- 当該比較ツール・報告・メモリ。製品サーバー・同期デコードは変更しない。

## 再確認用の読取専用コマンド

```sh
git show --no-patch --format=fuller 02c53c5
git log --oneline 02c53c5..f3cd203
git diff --name-status 02c53c5..f3cd203
git show --stat f3cd203
git diff f3cd203 -- artifacts/heatmap/src server/src
```

この一覧は公開の承認依頼ではない。公開への反映・再起動・再Publishは一切していない。
