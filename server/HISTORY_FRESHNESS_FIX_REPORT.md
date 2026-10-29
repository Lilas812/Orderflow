# 後取得履歴の限定再検証：実装・隔離検証

## 1. 今回の範囲

ユーザーの追加承認に基づき、前調査のA1（完了世代ごとの限定再検証）を実装した。
**CPU負荷対策・同期デコード変更は実施しない。公開変更・再起動・再Publishもなし。**
前調査報告書と数値付録は変更せず、今回分はこの報告書と
`HISTORY_FRESHNESS_MEASUREMENTS.md`に分けた。

## 2. 実装と対象範囲の根拠

### 製品差分

- `artifacts/heatmap/src/data/history-freshness.ts`（新規）:
  `HistoryFreshness`が完了情報と未再検証区間を保持する。
- `artifacts/heatmap/src/data/socket.ts`:
  liveのstatusを観測し、既存の`requestVisible`・直列range queueへ限定再検証を統合。
  hello時に世代情報をreset、replayでは無効。
- `artifacts/heatmap/src/main.ts`:
  `onStatus`のfollow限定・遷移限定の全可視coverage消去を削除し、socket側に一本化。
  `positionPriceFromData`はfollow=falseなら初回価格中心の自動設定もしない。
  初回全空の画面を利用者が先に動かした場合も、後取得板で価格位置を飛ばさない。
  ユーザーが明示した価格AUTOの従来動作は変更しない。

### 幅は50秒固定ではない

対象は次の積集合とする。

1. 既存の`syncRetentionAndRequests`が求める表示用の要求範囲。
   従来どおりdeltaの境界を含み、follow時は最新列+1秒までに制限する。
2. 完了したbackfillの`[startSec,endSec)`。
3. ブラウザで既取得とされた範囲のうち、その完了世代でまだ再検証していない部分。
4. cacheの現在の保持範囲。

サーバーは「どの秒に新しい板が増えたか」を通知していないため、
列がゼロの秒だけでなく、部分取得済みの区間も対象にする必要がある。
表示外は印だけ保持し、後のpan/zoomで必要になった部分だけ要求する。
印が失われる保持範囲外は、従来の不足範囲取得で読む。
**50秒はzoom試験条件のみ。実測した再取得幅は80秒、100秒、19秒等。**

既存statusの`startedAtUs/finishedAtUs/startSec/endSec`を世代キーに使う。
同じcompleteの反復は無視し、初めて観測した状態がcompleteでも一度対象化する。
メタデータのない旧statusではcompleteを一世代として一度扱い、
runningを再観測するまで反復しない。配信形式・サーバー・保存形式は変更していない。

### 要求の上限・競合・データ

- 同じ完了世代・保持区間は一度だけ再検証。新世代は再対象化する。
  以前の世代で未閲覧だった区間は忘れず保持し、現在cacheにない印は破棄する。
- 実際にdispatchした時だけ印を消費する。panで中止された未送信queueを
  「再検証済み」にしない。進行中の範囲とは重ねず、必要ならrangeDone後に一度読む。
- 従来の1要求最大3600秒、1進行中要求、300秒chunkを維持。
  世代対象は起動履歴の3時間と保持cacheの積集合以下で、timer/poll/無制限retryは追加しない。
- エラーで同じcompleteを再通知しても自動再試行ループにしない。
  失敗後は既存の不足coverage取得（明示操作・再接続等）に任せる。
- 列・約定は消さずcoverageだけ失効させる。直前板による空白補完はしない。
  約定は既存の範囲置換を使い、同じ約定を加算し直さない。
- 初回complete時点で既に新しい内容を読めていた場合も、読み取りと完了の厳密な順序を
  現在の契約で判定できないため、可視部分の保守的な一度の再取得はあり得る。

## 3. 隔離再現

実`Backfill → LocalStore → Hub → RealtimeClient/cache → main`のhandlerを使う。
mainはAST抽出しVMで実行、`positionPriceFromData`も実関数にした。
DOM・大口板・VP等は隔離stub、実depthがrenderer.drawへ渡した列と時間内列を記録。
**実Canvas画素／ブラウザの確認とは区別する。**

比較元は修正前commit `f7f1a3b61f8dcc3476ac98486378be88b2057d81` の
main/socketを読み込む。両版で他の入力・handler・操作列は同一。
各条件3回、毎回新しい保存先・Hub・cache・client・VM。6条件×前後＝36run。

|必須条件|修正前|修正後|
|---|---|---|
|live/follow=true、running→complete|可視bのみ、表示外aは残る|可視b、後のpanでaもdraw入力へ追加|
|follow=false、完了観測|a/bとも取らない|位置・時間幅・価格中心・価格幅・follow=falseを維持してb、pan後a|
|完了遷移を観測しない|初回completeだけでは取らない|最初に受けたcompleteでb、pan後a|
|既取得・表示外の空白へpan|古いcoveredでaなし|完了時は表示外を要求せず、pan時にa|

ケース3は、初回runningの配信を隔離transportで保留し、後保存後に初めて
completeを受け取る条件。前調査の「complete通知後、同じ通知内容のまま保存だけが増える」
人工条件とは異なる。**通知・完了情報が何も変わらない隠れた保存を検知したとは主張しない。**
この条件まで追うにはサーバーの保存世代通知などが必要で、今回は実装していない。

追加で初回全空、初回全空かつfollow=false・center81000・未自動中心設定も再現。
後者も全viewport値を厳密比較し不変、初期自動中心設定を抑制できた。
同一complete/view×10、zoom-in、pan往復は全条件で追加再検証0。
pan-away時の未来側9/19秒の通常不足取得は修正前後共通なので分けて記録した。
明示的時間resetは両版とも1要求で回復する。

## 4. 要求数・応答量・処理負荷

比較窓は「完了＋最初のpan」。初回・後保存Backfill・後の明示resetは除外。
初回1800秒に既知2列を配置、その後に識別可能な2列を追加。
追加板は各400段/側（合計1600入力行）、初期列は各1段/側。
空白以外も含む同一範囲を前後で照合した。全秒・要求・受信・draw時刻は数値付録参照。

|条件|要求数 前→後|非圧縮応答合計B 前→後|増分B|共有プロセスCPU ms 前→後（3回平均）|
|---|---:|---:|---:|---:|
|follow|1→2|6,591→13,182|6,591|2.665→4.609|
|browse|0→2|0→13,182|13,182|1.009→4.385|
|初回complete|0→2|0→13,182|13,182|0.263→2.766|
|表示外gap|1→2|6,591→13,182|6,591|2.552→3.982|
|初回全空|1→3|6,566→13,289|6,723|2.464→3.677|
|全空browse|0→2|0→13,132|13,132|0.224→4.300|

初回全空の3要求は、b受信による既存follow位置の確定で新たに必要になる19秒を別に
読むため。区間は重ならず、空の再応答後に繰り返さない。
通常4条件は完了時80秒前後を1要求、pan先100秒を1要求。
既知A/Bも各1列ずつ重複転送される。これは後取得の混在を読むためのコスト。

後の4必須条件ではLocalStore読取wall合計1.10〜1.23ms、
参考deflate wall .77〜.82ms、受信handler wall .14〜.27ms（各3回平均）。
詳細CPU・wall・timer超過は付録。小さいms値はJIT/GC/host変動込みで、
厳密な工程専用CPUや公開での増分ではない。
WebSocketの圧縮状態を再現していない独立deflateのbinaryは約2,603〜2,605B。
実WS転送量・実クラウド読取・実renderer負荷は未測定。

環境はNode24.22.1/Linux6.18.59、Xeon8581C、8CPU利用可能、
cgroup 8core/16GiB。公開の共有0.5vCPU/2GiBと異なる。
基準→修正の順、専用warmupなし。既存receiver/mockup等は止めず、
計測Node内のread・圧縮・受信区間CPUと全stage CPUを分けて記録した。
他プロセスとのCPU争奪は排除できない。今回はCPU原因の再測定・対策はしていない。

密な履歴では段数×秒数に応じて増える。例えば400段/側・100秒なら
binary約640,909B（単一chunk、圧縮前）の可能性があり、疎な今回の6,443Bを
そのまま本番の応答量見積りに使わない。全保持範囲の先行再取得や周期全消去はしない。

## 5. 確認手順・結果・保持

再現コマンド（実HTTP・上流・実保存には接続しない）:

```sh
node server/tools/history-investigation/visibility.ts data/history-investigation-fix-baseline baseline f7f1a3b61f8dcc3476ac98486378be88b2057d81
node server/tools/history-investigation/visibility.ts data/history-investigation-fix-after fixed
node server/tools/history-investigation/summarize-fix.ts data/history-investigation-fix-baseline data/history-investigation-fix-after
pnpm --filter @workspace/heatmap typecheck
pnpm --filter @workspace/heatmap test
pnpm --filter @workspace/heatmap build
```

- 前後18runずつ成功、fake WS残存0。raw JSONは上記`data/`以下（Git/デプロイ除外）。
- `history-freshness.test.ts`に10試験を追加。初回complete、pending、別世代、queue取消、
  zoom両端、失敗、約定置換、replay、保持期限、旧世代の未閲覧範囲を確認。
  既存Phase 14を含むフロント全143/143成功、skip0。
- フロント型検査・build成功。調査ツールはserverのNode型探索でtsc成功。
- 公開は未反映。実画面手順は将来の承認済み環境で、履歴取得中に過去へpanして待機し、
  完了後に同じ時間位置の追加列を確認、さらに表示外だった既取得区間へpanして確認する。
  その際、表示位置・時間幅・価格幅・follow状態が変わらないことを見る。
  この実ブラウザ確認は今回実施していない。
- `server/src/`全体（同期decode、CPU、設定計測含む）、Phase 14のrenderer/設定、
  正本、依存、デプロイ構成に差分なし。build出力は開発のローカル成果物であり再Publishなし。
- 追加の一時製品ログなし。調査ハーネスの出力はdata/と報告書だけ。

## 6. 終了・戻し方・残る限界

検証ブラウザ未使用、実検証WS0。各runのfake Hub接続0をassert。
自分の検証は短命Nodeのみで自然終了し、HTTP/上流接続プロセスを起動していない。
終了時にvisibility測定プロセス・Chromium本体がないことを確認し、
既存receiver PID414は継続したまま。公開・既存利用者接続の切断はしない。

戻す場合は今回のmain/socket差分と新規HistoryFreshnessだけを戻す。
Phase 14・設定計測・既存調査を巻き戻さない。新しい保存形式やmigrationはない。
回帰試験は上記36run・フロント143試験・型検査・build。

仕様との差分はなし（今回のユーザー承認による鮮度動作の変更）。
残る限界は、通知のない保存増加、completeにならない/通知自体が届かない状態、
実クラウド/公開での負荷、実画素・iPad操作の確認。
これらを周期取得・架空板で隠さず、今回の実装範囲外として残す。
