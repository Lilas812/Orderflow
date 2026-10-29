# 履歴反映の実ブラウザ確認（隔離・製品変更なし）

## 実施条件

- 対象製品commit: **`f3cd203b81b88010273f1012511b0c57dd35952a`**。
  その製品buildを実HTTP配信し、実Hub/WS・実クライアント・実Canvas rendererを使用。
  製品entrypoint、上流、実App Storage/DBは起動・接続していない。
- 接続先は`http://127.0.0.1:25751/?debug=1`のみ。
  `server/tools/history-investigation/browser-fixture.ts`を一時起動し、
  メモリ内のダミー保存列と完了通知を使用した。
  outbound connect/fetchは禁止する既存安全preloadを利用。
- Chromium **140.0.7339.16**、1280×800、ケースごとに新しいcontext。
  画面・ページtitleに「ダミー隔離データ」を明示。
- 既知列は2列、後保存はケースごとに90列、各40段×両側、枚数400。
  比較を見やすくする隔離設定はblock、下限なし、上限500、gamma1。
  設定はfixtureのGET応答だけで、製品設定を保存していない。
  この実画素確認はblockについてで、glowの追加画素試験は実施していない。
- 後保存の前後を撮影し、Canvasの対象時間帯の実画素も比較。
  readonly debugは位置・追従・受信の補助証拠で、draw入力だけの判定ではない。

## 1. 自動追従中

- 対象帯: `[1793276400,1793276490)`（90秒）。
- `follow=true`で、初期の対象帯は黒一色。
  後保存と完了通知後、再読み込みなしで淡色の板ブロックが表示された。
- Canvas対象矩形24×577画素: 色付き **0→6,936画素**。
  初期黒13,848画素のうち6,936画素が`rgb(239,236,255)`へ変化。
- キャッシュ列数2→92、追加90列の受信、range要求数2→3。
  ナビゲーション1回・WS接続1回のまま。追加のnavigate/reloadなし。
- 表示値は前後完全一致:
  `startUs=1793274118438178`、`durationSec=3600`、
  `centerPriceTicks=80000.5`、`priceSpanTicks=160`、`follow=true`。

画像（いずれも1280×800の実PNG）:

- `data/history-browser-verification/follow-before.png`
- `data/history-browser-verification/follow-after.png`

debugパネルが板ブロック上部に重なるが、after画像で下部の表示を目視確認。
Canvas自体の画素計測はパネルとは別に行った。

## 2. 過去閲覧中

- ケース1を閉じ、隔離Hubの接続0を確認してfixtureを新規状態へreset。
- 実際のマウスdragとwheelで過去へpan・時間zoomし、`follow=false`にした。
  debug値を直接書き換えて操作を代用していない。
- 対象帯: `[1793273500,1793273590)`（90秒）。
  初回表示外から先に取得した過去区間の空白で待ち、後保存を行った。
- Canvas対象矩形47×577画素: 色付き **0→13,583画素**。
  after画像で広い淡色の板ブロックが実際に見える。
- キャッシュ列数2→92、追加90列の受信、range要求数11→12。
  このcontextのナビゲーション1回のまま、reloadなし。
  サーバーの累計接続は前ケースを含む2回。
- 前後完全一致:
  `startUs=1793272897979696`、`durationSec=1800.264945`、
  `centerPriceTicks=80000.5`、`priceSpanTicks=160`、`follow=false`。
  時間位置・ズーム・価格中心・価格幅・追従状態を維持。

画像:

- `data/history-browser-verification/browse-before.png`
- `data/history-browser-verification/browse-after.png`

## エラー・通信

両ケースともpage error、console error、失敗HTTP要求、
想定外の外向き要求は**0件**。
HubのsendErrors/invalidRequests/rejectedConnections/slowClosedも0。
fixtureの追加以外のAPI書込・公開操作・上流接続はなし。

詳細は`data/history-browser-verification/browser-results.json`。
画像はファイルとして存在し、スクリーンショットIDと混同していない。
PNGとraw JSONはGit/デプロイ除外先に保持し、画像を会話の添付として提示する。

## 終了確認

1. 両contextを閉じ、`browser.close()`後にブラウザのdisconnectedを確認。
2. その時点では専用Chromium親PID3492が残ったため、検証者が当該PIDへ
   SIGTERMを送り、PIDと専用profileのプロセス消滅を確認。
3. 隔離Hubの`connected=0`を外部から確認。
4. メイン側でもChromiumプロセスなし、PID3492消滅を確認。
5. 自分のfixture PID3426へSIGTERM。
   **2026-10-29 13:29:44.995 UTC / 22:29:44.995 JST**に
   HTTP closed・前後Hub接続0・upstreamOpened0を記録。
   PID3426消滅、HTTP25751への接続不能、背景shell終了0を確認。
6. 既存receiver PID414はそのまま。既存プロセス・利用者接続は切断していない。

終了記録: `data/history-browser-verification/server-cleanup.json`。
追加の検証ブラウザやserverを残していない。

## 今回の差分・確認

- 追加はこの報告、`HISTORY_RELEASE_CANDIDATE.md`、
  隔離`browser-fixture.ts`と画像提示のメタデータのみ。
- `git diff --exit-code f3cd203 -- artifacts/heatmap/src server/src docs replit.md
  pnpm-lock.yaml .replit`成功。**製品・正本・依存・デプロイ設定は差分0**。
- fixtureツールはserverのNode型探索でtsc成功。
  初回型検査のlog引数のunknown型1件は型注釈だけで修正し、動作変更なし。
- 製品を変更していないので、前回成功した143試験/buildは再実行していない。
- 公開候補・同梱変更の一覧は`HISTORY_RELEASE_CANDIDATE.md`。
  **Phase 14と設定計測は候補に含まれる**。前者はGit公開マーカー側にも存在、
  後者は同マーカー後の別の製品変更。

今回の代表2ケースは成功。CPU対策・追加の製品変更・公開への反映・再起動・再Publishはなし。
