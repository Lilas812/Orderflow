# 保存済みローカルデータの起動改善

## 範囲と承認

2026-10-29 JST。`PHASE13A_REPORT.md` 7.5節の起動時間切れを対象に調査した。
調査結果・修正案・影響範囲・コードだけを戻す方法を説明し、ユーザーから
「修正と検証を進める」の承認を得て実装した。
公開操作、長期VP画面、長時間受信の検証は行っていない。

## 原因と計画

`LocalStore.initialize()` は起動時に全板ファイルのヘッダーと全約定行を読み、
行ごとに `markCovered()` → `ranges()` を呼んでいた。`ranges()` は、そのたびに
既存区間のコピー・並べ替え・統合を行う。調査時の既存インデックスは
book 235区間、tick 4,628区間。同じ取得済み秒を10,000回追加するだけの測定でも
約1,126msを要した。約定数が増えると全行にこの費用がかかる。

ファイル走査自体はクラッシュ後の未索引行の復旧と破損検出に必要なので省略しない。
取得済みインデックスやファイルの存在だけを信じて起動する案、
初期化を背景へ移して未完成の範囲を配信する案、新しい索引形式を導入する案は採用しなかった。

比較用の読み取り専用処理（保持期限削除を無効化した調査用サブクラス）で、
全保存の走査は約4,207ms、観測秒をまとめた最後の統合は約29msだった。
板139,609秒、約定112,086秒を観測した。これは行数・完全取得秒数ではない。
変更前アプリ全体を再度284秒待つ測定は行っていないため、同条件A/Bの倍率は主張しない。

## 変更

- `src/store/local.ts` の `initialize(signal?)`：
  ファイルごとに観測秒を集めて連続区間へまとめ、走査完了後に被覆を一括統合。
  復旧したtick秒は、VP用の取得完了記録 `recordedTicks` へ入れない。
  生データ、ファイル形式、行順、重複、正常時の保持期限規則は変更しない。
- `src/store/records.ts`：
  起動用の列走査・約定読込へ任意の中断シグナルを渡せるようにした。
  中断で読込ストリームを閉じ、通常の読込経路と破損エラーは維持する。
- `src/pipeline.ts` の `initialize(signal?)`：
  保存復旧と中断確認が終わるまで定期処理を開始しない。
- `src/store/app.ts` の `initialize(signal?)`：
  基底の復旧へシグナルを引き継ぎ、クラウド初期化の処理間でも中断確認する。
  SDKの進行中要求自体を取り消す機能を追加したわけではない。
- `src/index.ts`：
  最初の非同期初期化前にSIGTERM/SIGINTハンドラーを登録。
  初期化完了後だけHTTP/WSを待ち受ける。初期化中のSIGUSR2では上流を起動しない。
  中断・破損時は初期化完了ログや待受を出さず、部分状態をflushしない。
  起動失敗は秘匿情報を含まない理由で記録し、終了コード1で停止する。
  正常なSIGTERMは従来のプロセス全体の停止期限を維持する。
- `test/startup-recovery.test.ts` / `test/startup-process.test.ts`：
  ダミー入力による復旧・中断・失敗・子プロセス停止の回帰試験。

HTTP healthzの先行成功、未準備範囲の `rangeDone`、空の復旧結果を正常完了として出す
回避策は用いていない。サーバー⇔ブラウザの形式、依存、設定、仕様正本は変更なし。

## 実施した確認

### 自動確認

- `pnpm --filter @workspace/receiver run test`：151/151成功。
- `pnpm --filter @workspace/receiver run typecheck`：成功。
- `pnpm --filter @workspace/heatmap run typecheck`：成功。
- 管理ワークフローによるビルド：成功（Vite、37 modules）。
- `git diff --check`：成功。

追加6試験では、観測tick秒と完全取得記録の区別、逆行・重複約定、既存列優先、
列/約定の走査中断、準備完了後のSIGTERM、初期化中のSIGTERM、破損gzipによる起動失敗を確認。
子プロセス3経路で、正常停止0／起動失敗1の終了コード、PID消滅、元gzipとcoverageのバイト一致を確認。
中断・破損時は `storage_initialized` / `server_listening` / `storage_stopped` を出さない。

### 既存保存での実起動

管理ワークフロー `artifacts/heatmap: web` を既存保存のまま起動。
実データ89ファイル、合計35,050,830 bytes。coverageを含む90ファイルのSHA-256を
調査前・起動後・停止後で照合し、すべて一致。元保存の削除・移行・復元は行っていない。

- 初回：`storage_initialized.elapsedMs = 4860.146584`、続いて待受成功。
- 停止ログ取得のための再起動：`4724.740441ms`、続いて待受成功。
- 開発プレビューの `/api/healthz`：HTTP成功、`{"status":"ok"}`。
- `/api/status`：storageError null、保留列/約定0、上流stopped、longVp無効。
- 画面：CONNECTED、`Connected · waiting for confirmed depth columns`、
  `Upstream stopped`。現在時刻付近に保存がなく開発上流を止めているため板待ち。
  保存リプレイ表示や長期VP画面の実証ではない。
- 撮影画像：`data/startup-check/heatmap.jpg`（Git対象外）。

### ブラウザと停止

撮影用Chromiumは撮影終了後も本体が残っていたため、親と関連crashpadへSIGTERMを送り、
捕捉した本体・子・crashpad 9 PIDの稼働残存0を確認した。プロセス一覧でもChromium残存なし。
`/api/status` の下流接続0・connections空を別途確認した。開発上流WSは一度も接続していない。

最初の管理ワークフロー停止では受信PID消滅・待受消滅・保存一致は確認したが、
アプリの正常終了ログを取得できなかった。この停止を正常処理の証拠には使わない。
再起動後、受信Nodeへ直接SIGTERMを送って次のログを確認した。

```text
2026-10-28T22:15:27.866Z shutdown_requested signal=SIGTERM
2026-10-28T22:15:27.867Z upstream_stopped socketClosed=true
2026-10-28T22:15:27.893Z server_stopped upstream=stopped httpClosed=true
  storageInitialized=true elapsedMs=26.545652 uploadDeadlineReached=false
```

受信PID消滅、サービスのLISTENソケット0、保存90ファイルのSHA-256一致を確認。
確認用の最終結果と開始前ハッシュ一覧は `data/startup-check/final.json` と
`data/startup-check/hash-manifest-before.json`（ともにGit対象外）。
受信ワークフローは停止済み。

## 再確認手順

1. 開発プレビューの管理ワークフローをRunする。
2. ログで `storage_initializing` → `storage_initialized` → `server_listening` の順を確認する。
3. プレビュー `/` と `/api/healthz`、`/api/status` を開く。
   開発上流はstoppedのままでよい。保存のない現在範囲が板待ちでも起動失敗とは区別する。
4. 正常停止の確認では受信NodeへSIGTERMを送り、`upstream_stopped` と
   `server_stopped`、PIDと待受の消滅を確認する。

## 未検証・限界

- Workspaceの既存約35MBでの起動確認であり、将来の最大保存量や2GiB本番環境の保証ではない。
- App StorageのSDK要求が止まる場合の起動中断・期限到達の追加障害試験は未実施。
  既存のクラウド再DL照合を省略していないため、その待ち時間は別に存在する。
- 公開操作、本番での日次確定・復元、長時間受信、長期VP画面は対象外。
