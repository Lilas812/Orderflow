# Phase 2b 報告

実施日：2026-10-27 JST。仕様の正本は `replit.md` と `docs/`。サーバー停止後に確定した報告。

## 報告

- 実施内容：現在に近い履歴窓の5分待ち、ブラウザ向けWebSocket配信、保存データのリプレイ、通信確認用クライアントを実装し、実データで確認した。画面は作っていない。サーバーは停止済み。
- 変更ファイル：下の一覧を参照。
- 確認手順：下のコマンド・実測記録を参照。起動は既存のRun設定を使う。起動するとTICK STREAMへ接続する。
- 実行した確認：変更前42テスト・型検査成功。変更後58テスト・型検査成功。180窓取得、2台同時に各2分、10分range、リプレイ終了、列照合、上流closeとPID消滅。詳細は後掲。
- 仕様との差分：配信契約の変更なし。ただし確認のリプレイ尺は準備から接続までに保存末尾が1秒進み、予定300秒に対して301秒になった。配信の250msはタイマーの目標値であり、実測には遅延があった。数値を後掲する。
- 未解決・懸念：L直前5分に1秒の欠け、既存の欠け、配信間隔の遅延、長期間リプレイのメモリ使用量、フィードの完全性、終了close 1006。隠して補完していない。
- 次の候補：長期間リプレイの小分け読取・メモリ確認、Phase 3。提案のみで今回着手しない。

## 1. 事前作業・承認

添付SPECをバイト同一で差し替え、指定SHA-256を確認後、添付コピーを削除した。

```text
8939bf3d28c4b49db19739c447f20d97dadd2d0bad9699e5392b377d275528ee  docs/SPEC.md
```

配置後のSPEC 8.3・9と作業指示、既存実装を照合し、構成・依存・具体的なJSONの項目名、リプレイの時間基準を計画に明示した。ユーザー回答「この計画で実装する」で承認された。

追加依存：

- 実行時：`ws` **8.22.0**。ブラウザ向けWebSocketサーバー。
- 開発時：`@types/ws` **8.18.2**。そのTypeScript型定義。
- ほかの依存は追加していない。上流接続は引き続きNode標準WebSocket。

経路は **`/api/ws`**。既存APIサービスの転送設定が `paths = ["/api"]` なので、SPECで許可された経路を使う。`/ws` のためにルーティングやRun設定を変更していない。実測ではサービスの直接ポートでなく共通プレビュー経路 `ws://localhost/api/ws` を使用する。

既存保存データは手動削除していない。既存の通常の追記・時間終了時のgzip・7日保持は継続する。旧欠けのcoverageを消して取り直す操作は行っていない。

## 2. 作った・変えたファイル

| ファイル | 関数・役割 |
| --- | --- |
| `docs/SPEC.md` | 許可された新版の配置のみ |
| `server/package.json`、`pnpm-lock.yaml` | 上記の実行・型定義依存 |
| `server/src/history/backfill.ts` | `Backfill.take/retryReady/run/snapshot`：5分待ちの別キュー、待機中の他窓継続、0行対象10分、待っている時間の保存保留 |
| `server/src/store/local.ts` | `LocalStore.readView`：書込みキュー内で保存済み＋保存待ちの確定データを一括読取。`savedRange`：実データの範囲の外枠 |
| `server/src/pipeline.ts` | 確定列の通知、`readRange`：まだ1秒の約定保存バッチにある約定も読取に含める |
| `server/src/hub/frame.ts` | `encodeFrame/decodeFrame`：9バイトヘッダー＋既存列レコード。`boardColumn`、`parseRange`、`replayParams` |
| `server/src/hub/hub.ts` | `Hub.connect/column/book/trade/flush`：初回配信、250ms配信、range、状態、混雑、5台上限。`attachHub`：HTTP Upgrade |
| `server/src/hub/replay.ts` | `Replay.start/advance/stop`：接続ごとの仮想時計、指定速度、約定のまとめ、終端停止 |
| `server/src/status/app.ts` | `statusSnapshot/createStatusApp`：既存状態に `phase2b` の配信件数を追加 |
| `server/src/index.ts` | 上流・Pipeline・Hubの接続と停止処理。上流WebSocketは1本のまま |
| `server/test/phase2b.test.ts` | 通信しない追加16テスト |
| `server/test/phase2a.test.ts`、`server/test/phase2a-fixes.test.ts` | 既存の失敗・0行テストを新しい5分待ちの後の時刻に設定。検査対象の従来の期待値は維持 |
| `server/tools/ws-client.ts` | `runClient`：下流だけに接続する計測クライアント。CLI、rangeオプション、リプレイ、種類別バイト・間隔・列順序・重なり |
| `server/tools/verify-phase2b.ts` | 実測の監視、2台同時・range・リプレイ・つなぎ目の照合、finallyでSIGTERM |
| `server/PHASE2B_REPORT.md` | 本報告 |
| `replit.md` | Current Status節のみ |
| `.agents/memory/` | 承認されたリプレイの時間基準の解釈を記録 |

`scripts/src/`、フロント、Canvas、App Storage、DB、デプロイ設定、Run設定、ほかの仕様書は変更していない。ライブの欠けを履歴で埋める機能も追加していない。

## 3. 配信の具体的な契約

### フレームとJSON

- バイナリは `kind:uint8 / reqId:uint32LE / count:uint32LE / records`。kind 1・3は1レコードかつreqId=0、kind 2は0件も許可。既存の `encodeColumns/decodeColumns` を使い回す。
- `hello`：`symbol`, `tickSize`, `columnSeconds`, `serverTimeUs`, `mode`, `savedRange`。
- `trades`：`trades: Trade[]`。`rangeTrades`：`reqId`, `trades: Trade[]`。
- `status`：`status` に従来の状態＋ `phase2b`。リプレイ終了時は `replay: {state:"ended",fromSec,toSec,speed}` を追加。
- `error`：`reqId`（対応する要求がなければnull）, `code`。利用者から来た生入力やAPIキーは返さない。
- `savedRange` は `{fromSec,toSec}` またはnull。範囲の外枠を示すもので、中の各秒にデータがあるとは意味しない。
- 時刻は `*Us` がマイクロ秒、`*Sec` が秒、測定の所要時間 `*Ms` がミリ秒。

### 初回・ライブ・range

- `hello` → kind 2（reqId=0）→ `rangeTrades`（reqId=0）→ ライブ。初回範囲は接続時の直近30分。
- 初回の非同期読込中に届く確定列・約定を一時保持する。読取に含まれた列秒とライブ約定の受信ID（recvUs＋seq）だけを照合し、重複配信を防ぐ。同じ時刻・価格・枚数・方向という理由で別約定を消さない。
- 保存待ちを読む処理は、保存キュー内で一貫したスナップショットを取る。列は保存済みが優先で、未確定秒は含めない。
- 列は確定ごと。板は250msごとに最新1件、約定は250msごとに非空バッチだけ。状態は変化時と10秒ごと。
- `range` はreqIdが1〜4,294,967,295の整数。秒は非負のuint32整数、`fromSec < toSec`、長さ3,600秒以内。範囲内の保存がない秒を埋めない。無効な要求は `error`。
- range応答はkind 2の直後に同reqIdの `rangeTrades`。同一接続の要求処理は直列化する。

### 混雑・上限・終了

- 4MBは4,194,304バイト、16MBは16,777,216バイト。上回った場合に適用する。
- 4MB超：板だけを落とし、次の最新板を待つ。列・約定は送信する。
- 16MB超：code 1013で当該接続を閉じ、`hub_slow_close` をログに出す。初回配信の保留バッファも上限に含める。
- 6台目は `error` とcode 1013で拒否する。閉じた枠は再利用できる。ライブとリプレイを合わせて5台。
- `phase2b` には接続数、累計接続、拒否、板落ち、混雑切断、送信エラー、不正要求、range要求件数を出す。
- SIGTERMで配信タイマーとリプレイを止め、ブラウザ側をcode 1001で閉じ、上流と保存処理を終了する。

### リプレイ

- `/api/ws?mode=replay&from=<秒>&speed=<1|2|5|10>`。不正値は `error` 後code 1008で閉じる。
- 初回30分は再生開始秒の直前。その後fromから、**接続時点で固定した保存末尾**まで流す。新しいライブ保存で終端を延ばさない。
- 列間隔・欠けの間隔を速度で割り、kind 1と、その列をそのまま使ったkind 3を送る。
- 約定は仮想時間の250msでまとめる（10倍速なら実時間25ms）。記録の秒を昇順に進め、同じ秒の中はseq順を保つ。マイクロ秒が逆行しても捨てず、元のTradeの時刻を書き換えない。
- 接続ごとのタイマーで動く。受信処理や他のライブ接続を待たせない。終端で終了statusを送り、リプレイの送信を止める。

## 4. 単体テスト・型検査

```text
pnpm --filter @workspace/receiver run typecheck
→ tsc --noEmit 成功

pnpm --filter @workspace/receiver test
→ tests 58 / pass 58 / fail 0

node --check server/tools/ws-client.ts
node --check server/tools/verify-phase2b.ts
→ 両方成功

# server/ にて、新規の確認ツールも個別に型検査
pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --strict --skipLibCheck --types node tools/ws-client.ts tools/verify-phase2b.ts
→ 成功
```

既存42＋追加16。テストはダミーと明示し、上流・下流のネットワーク通信なし。リプレイ・配信のタイマーは偽時計。

追加確認：kind 1/2/3のLE往復と壊れた個数、範囲検査、250msの最新板・約定バッチ、4/16MBと他接続の継続、6台目拒否、初回読取中の列・約定、空秒を埋めないrange、速度1/2/5/10の間隔・終了・逆行約定、リプレイとライブの共存、状態の変化・10秒通知、5分待ちと他窓継続、保存待ちデータの読戻し。

## 5. 確認クライアントの使い方

既存Runでサーバーが動いている間だけ実行する。APIキーは不要で、TICK STREAMに接続しない。

```sh
# 2分、共通プレビュー経路
node server/tools/ws-client.ts --seconds 120

# 範囲の要求を1回追加（数字は保存済みの実際の範囲へ置換する）
node server/tools/ws-client.ts --seconds 120 --range-from 1793028069 --range-to 1793028669

# 保存末尾まで再生。数字は保存済みの実際の開始秒へ置換する
node server/tools/ws-client.ts --mode replay --from 1793029000 --speed 10 --until-end --seconds 70
```

`--url`、`--out` も使用可能。kind 2の初回範囲、kind 1の秒順・重複とその境目、kind 3とtradesの受信間隔、種類別件数・バイト、実測開始からの1分ごとのバイトと毎分平均を出す。空約定バッチは送らないため、tradesの間隔が250msより長いだけでは欠落を意味しない。

## 6. 実測

記録先：`data/phase2b-checks/`。実行コマンド：

```sh
node server/tools/verify-phase2b.ts
```

この監視ツールから `ws-client.ts` の `runClient` を並行して呼び出した。CLIと同じ計測処理であり、下に示すJSONもCLIと同じく `columns`（全列のダイジェスト）と `latestStatus` を除いた形式。完全な記録は各JSONに残している。

### 6.1 起動・取り込み・5分待ち

起動前の `/proc` 調査で他の受信プロセス候補0、起動後の受信プロセス1本を確認。既存の `artifacts/api-server: API Server` を使用。Run設定は変更していない。

| 項目 | 結果（JST） |
| --- | --- |
| 上流open | 2026-10-27 00:41:08.845 |
| L | 1793029269 = 00:41:09 |
| 対象 | `[1793018469,1793029269)` = 10-26 21:41:09〜10-27 00:41:09 |
| 取り込み開始 | 00:41:10.191 |
| 取り込み終了 | 00:46:13.842 |
| 所要時間 | **303,651ms = 5分3.651秒**（5分待ちを含む） |
| 窓 | 180/180 |
| 保存済み省略 / REST | 304要求省略 / 56回取得（合計360） |
| 取得行 | 板5,384,800行・約定24,299行（半開区間の外へ除く行を含む） |
| 採用 | 板6,616件・約定23,939件 |
| 5分待ち | 5窓×板/約定＝10要求。全10件で取得開始がreadyAtUs以上 |
| 0行 / 0行再取得 / 通信失敗 | 0 / 0 / 0 |
| 待機中の処理 | 古い窓は00:42:12頃に180窓の走査完了。その後もライブを継続しながら期限の来た窓を取得 |
| 完了時の保留 / noData / gaps | すべて空 |

「180窓走査完了」と「取得完了」は別。後回し窓をすべて取得し終えるまでstateはrunningとし、終了時だけcompleteになる。

最後の窓（終了L）の `readyAtUs` は1793029569000000（00:46:09）。板の取得開始ログは1793029569001000であり、5分を待っている。その取得後、約定を逐次取得した。並列RESTは行っていない。詳細は `events.jsonl` と `audit.json`。

### 6.2 つなぎ目の欠け

rangeで `[L−300,L＋300)` を要求し、保存した列を実際の `/api/ws` 経由で検査した。

| 区間 | 列数 | 列のない秒 |
| --- | ---: | --- |
| L直前60秒 `[1793029209,1793029269)` | 60/60 | 0 |
| L直前5分 `[1793028969,1793029269)` | 299/300 | **1秒：1793029082（00:38:02）** |
| L直後5分 `[1793029269,1793029569)` | 300/300 | 0 |
| 前後合計10分 | 599/600 | 1 |

この範囲の約定は6,934件。00:38:02の板が保存されなかった原因は未特定。今回の履歴検査の拒否は0であり、拒否が原因だったとは言えない。休場・履歴APIの反映遅延と断定していない。

末尾10秒の連続欠けは**新しいつなぎ目では観測しなかった**。ただし前回と対象時刻が違うため、同じ秒を取り直して原因まで確認したという意味ではない。

停止後の履歴対象3時間は10,785列・列のない秒15。内訳は旧保存から残る14秒と今回の00:38:02の1秒で、旧データを消して取り直してはいない。旧00:00:58〜00:01:08の10秒もそのまま残っている。全欠けが解決したとは扱わない。

### 6.3 2台同時2分・range

| 項目 | クライアントA | クライアントB |
| --- | ---: | ---: |
| open | 00:46:14.249 | 00:46:14.251 |
| 測定終了 | 00:48:14.250 | 00:48:14.251 |
| 測定所要時間（接続前処理込み） | 120007.300ms | 120008.165ms |
| 初回列 / 初回約定 | 1799 / 24748 | 1799 / 24748 |
| ライブ列 / ライブ約定 | **120 / 2395** | **120 / 2395** |
| 列の秒順違反・重複 | 0 | 0 |
| 初回→ライブの飛び / 重なり | 0 / 0 | 0 / 0 |
| 受信総バイト | 24,109,501 | 19,290,834 |
| 最初の1分のバイト | 21,451,177 | 16,632,510 |
| 次の1分のバイト | 2,658,324 | 2,658,324 |
| 板の受信間隔の中央値 / 平均 | 251.149 / 262.914ms | 251.161 / 262.699ms |
| 板の受信間隔の最大 | 646.029ms | 645.989ms |
| 約定バッチの中央値 / 平均 | 251.497 / 372.429ms | 251.522 / 372.469ms |
| 約定バッチの最大 | 1870.590ms | 1870.718ms |

共通120秒の各列をバイナリ化しSHA-256比較：**120/120全段一致**。Aだけ/Bだけの秒はどちらも0。約定の総数も一致。ただし本確認は約定一件ごとの全内容比較ではない。

初回列はL後のライブ120列とは別枠。Aはrangeの追加応答を含むため、Bより受信バイトが多い。板の受信回数や約定バッチ数は異なっても、ライブ列と約定総数は同じだった。

range（Aから1回）：

```text
reqId: 77
範囲: [1793028069,1793028669) = 00:21:09〜00:31:09
列: 600（最初1793028069、最後1793028668）
約定: 9582
バイナリフレーム: 3845409バイト
応答完了まで: 742.819952ms
```

以下、確認クライアントの出力：

#### クライアントA

```json
{"startedAtUs":1793029574242000,"openedAtUs":1793029574249000,"finishedAtUs":1793029694250000,"elapsedMs":120007.299765,"reason":"duration","mode":"live","hello":{"type":"hello","symbol":"NQ","tickSize":0.25,"columnSeconds":1,"serverTimeUs":1793029574246000,"mode":"live","savedRange":{"fromSec":1793016308,"toSec":1793029574}},"counts":{"hello":1,"kind2":2,"rangeTrades":2,"kind1":120,"status":437,"kind3":451,"trades":318},"bytesByType":{"hello":165,"kind2":15375209,"rangeTrades":3467729,"kind1":770160,"status":1349739,"kind3":2894518,"trades":251981},"totalBytes":24109501,"bytesPerMinute":{"0":{"hello":165,"kind2":15375209,"rangeTrades":3467729,"kind1":385080,"status":660926,"kind3":1411960,"trades":150108},"1":{"kind3":1482558,"status":688813,"trades":101873,"kind1":385080}},"meanBytesPerMinuteByType":{"hello":82.49498171683156,"kind2":7687136.880893722,"rangeTrades":1733759.0330541006,"kind1":385056.576479,"status":674828.4492575425,"kind3":1447170.9666002416,"trades":125982.83629084202},"initialColumns":1799,"initialTrades":24748,"liveColumns":120,"liveTrades":2395,"initialSeam":{"lastInitialSec":1793029573,"firstLiveSec":1793029574,"missingSeconds":0,"overlap":false},"gaps":[],"violations":[],"boardInterval":{"count":450,"minMs":248.58397799998056,"maxMs":646.028684000019,"meanMs":262.91434002,"medianMs":251.14889399998356},"tradesInterval":{"count":317,"minMs":248.67411500000162,"maxMs":1870.5896509999875,"meanMs":372.4288146750789,"medianMs":251.49705599999288},"range":{"reqId":77,"columns":600,"fromSec":1793028069,"toSec":1793028669,"firstSec":1793028069,"lastSec":1793028668,"bytes":3845409,"trades":9582,"elapsedMs":742.8199519999907},"replayEnded":false,"errors":[]}
```

#### クライアントB

```json
{"startedAtUs":1793029574243000,"openedAtUs":1793029574251000,"finishedAtUs":1793029694251000,"elapsedMs":120008.16507300001,"reason":"duration","mode":"live","hello":{"type":"hello","symbol":"NQ","tickSize":0.25,"columnSeconds":1,"serverTimeUs":1793029574247000,"mode":"live","savedRange":{"fromSec":1793016308,"toSec":1793029574}},"counts":{"hello":1,"kind2":1,"rangeTrades":1,"kind1":120,"status":437,"kind3":450,"trades":317},"bytesByType":{"hello":165,"kind2":11529800,"rangeTrades":2500917,"kind1":770160,"status":1349739,"kind3":2888100,"trades":251953},"totalBytes":19290834,"bytesPerMinute":{"0":{"hello":165,"kind2":11529800,"rangeTrades":2500917,"kind1":385080,"status":660926,"kind3":1405542,"trades":150080},"1":{"kind3":1482558,"status":688813,"trades":101873,"kind1":385080}},"meanBytesPerMinuteByType":{"hello":82.49438689424098,"kind2":5764507.769777088,"rangeTrades":1250373.4217477846,"kind1":385053.8000634463,"status":674823.5834681571,"kind3":1443951.7502379233,"trades":125967.92885554362},"initialColumns":1799,"initialTrades":24748,"liveColumns":120,"liveTrades":2395,"initialSeam":{"lastInitialSec":1793029573,"firstLiveSec":1793029574,"missingSeconds":0,"overlap":false},"gaps":[],"violations":[],"boardInterval":{"count":449,"minMs":247.5828029999975,"maxMs":645.9892190000392,"meanMs":262.6989211848551,"medianMs":251.16093600000022},"tradesInterval":{"count":316,"minMs":248.1763960000244,"maxMs":1870.7175159999751,"meanMs":372.4693853512658,"medianMs":251.52244700002484},"range":null,"replayEnded":false,"errors":[]}
```

### 6.4 リプレイ

- 指定開始：1793029273（00:41:13）。準備時の保存末尾1793029573から300秒引いて決めた。
- 接続時の固定終端：1793029574（00:46:14）。保存末尾が1秒進んだため、**実際は301秒（5分＋1秒）**をspeed=10で再生した。300秒ちょうどとは記載しない。
- 初回1799列・25,968約定、その後の再生はkind 1・kind 3それぞれ301列、約定3,042件。
- 約32.050秒で終了statusを受信（接続・初回読込を含む）。列の平均受信間隔100.004ms、中央値99.975ms。欠け・重なり・順序違反0。
- 同じ間に上流の板128件・約定860件を受信。別の2台へのライブも止まらなかった。
- 約定は元のライブ秒精度のため、再生でも同じ秒へ集中し、非空バッチの平均間隔は約101msだった。空の250ms仮想バッチは送らない。25msごとに必ず非空バッチが来るという意味ではない。
- `bytesPerMinute["0"]` は約32秒の部分区間。`meanBytesPerMinuteByType` は毎分へ換算した平均であり、実際に1分受信した量ではない。

```json
{"startedAtUs":1793029574744000,"openedAtUs":1793029575520000,"finishedAtUs":1793029606794000,"elapsedMs":32049.88769199996,"reason":"replay_ended","mode":"replay","hello":{"type":"hello","symbol":"NQ","tickSize":0.25,"columnSeconds":1,"serverTimeUs":1793029575518000,"mode":"replay","savedRange":{"fromSec":1793016308,"toSec":1793029574}},"counts":{"hello":1,"kind2":1,"rangeTrades":1,"kind1":301,"kind3":301,"status":111,"trades":297},"bytesByType":{"hello":167,"kind2":11529800,"rangeTrades":2626953,"kind1":1931818,"kind3":1931818,"status":342896,"trades":316868},"totalBytes":18680320,"bytesPerMinute":{"0":{"hello":167,"kind2":11529800,"rangeTrades":2626953,"kind1":1931818,"kind3":1931818,"status":342896,"trades":316868}},"meanBytesPerMinuteByType":{"hello":312.63760098919516,"kind2":21584724.6220672,"rangeTrades":4917869.963062091,"kind1":3616520.6291481736,"kind3":3616520.6291481736,"status":641929.2384957549,"trades":593202.7026960736},"initialColumns":1799,"initialTrades":25968,"liveColumns":301,"liveTrades":3042,"initialSeam":{"lastInitialSec":1793029272,"firstLiveSec":1793029273,"missingSeconds":0,"overlap":false},"gaps":[],"violations":[],"boardInterval":{"count":300,"minMs":0.1472760000033304,"maxMs":316.61972700001206,"meanMs":100.00419508666654,"medianMs":99.97512000001734},"tradesInterval":{"count":296,"minMs":0.014598000037949532,"maxMs":334.36404900002526,"meanMs":100.93592008445931,"medianMs":99.91168100002687},"range":null,"replayEnded":true,"errors":[]}
```

計測項目名 `liveColumns/liveTrades` はこの出力ではリプレイで流れた列・約定の件数。

### 6.5 混雑・状態・未解決

停止直前の `phase2b`：

```json
{"path":"/api/ws","connected":0,"totalConnections":4,"rejectedConnections":0,"droppedBoards":1,"slowClosed":0,"sendErrors":0,"invalidRequests":0,"rangeRequests":2}
```

4接続はライブ2・リプレイ1・つなぎ目照合1。range要求2はクライアントAの10分要求と、別接続の前後10分照合。

- 4MB超による板落ちは1回。列・約定の2台一致と順序検査は上記のとおり。16MB切断・6台目拒否はダミー試験で確認したが、実測で強制発生はさせていない。
- ライブ板の受信間隔は中央値約251msだが、平均約263ms、最大約646ms。**実時間で厳密な250msを保証したとは扱わない。** 初回読込・JSON化・クライアントのデコード等の寄与は未切分。配信タイマーは処理完了から次の250msを待つため、処理時間も間隔に加わりうる。
- リプレイ板の最大316.620ms・最小0.147msも隠していない。ネットワーク・イベントループ・初回読込の影響を切り分けていない。単体試験では記録間隔/速度のタイマーを検証済み。
- 状態変化を含めたstatusを各ライブ接続へ437回送った。状態は上流の受信件数でも変わるため、10秒ごとだけではない。
- リプレイは指定範囲を開始時にまとめ読みする。今回の約5分と初回30分は検証したが、7日分や5台同時リプレイのRSS・性能は未測定。小分け読出しは今回追加していない。
- `historyExamples` の共有参照が `[circular]` になる既知の表示も変更していない。履歴異常は今回N=2の異なる組1件のみで、最後の組を採用した。検査による板・約定拒否は0。
- 上流は停止前まで板1,684件・約定5,503件、再接続0、warning/feed/error/ticks_laggedすべて0、ライブ列の欠け0。フィード全体の完全性まで証明するものではない。

### 6.6 停止

```json
{"recvUs":1793029695112000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793029695112000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793029695239000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793029695239000}}
{"recvUs":1793029695239000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793029695240000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

00:48:15.112にSIGTERM、00:48:15.240にサーバー停止。PID 6165の消滅も確認した。受信中の切断0、終了時の1006は既知の未解決事項。

停止後は8ファイル23,615,821バイト、最新確定列1793029693、保存待ち0。未確定秒1793029694は保存を強制していない。

### 6.7 記録

- `status-start.json`、`status-ready.json`、`status-after-replay.json`、`status-final.json`：状態の実出力。
- `status-<Unixミリ秒>.json`：10秒ごとの監視。
- `live-a.json`、`live-b.json`、`replay.json`：受信計測、各列ダイジェスト、最後の受信状態。
- `verification.json`：2台一致、つなぎ目前後、リプレイ中の上流受信。
- `audit.json`：5分より早い要求がないこと、3時間の保存列・欠け。
- `events.jsonl`：今回起動から停止までの構造化ログ。
- `shutdown.json`：SIGTERMとプロセス消滅時刻。

## 7. Current Status更新

```text
2026-10-27：Phase 2bの5分待ち・/api/ws配信・リプレイ・ws-clientを実装。ws 8.22.0、@types/ws 8.18.2を追加。58テスト・型検査成功。180窓を5分3.651秒（待機込み）で取得。2台各2分で120列が全段一致、10分rangeは600列・9,582約定を742.820msで返却。10倍リプレイは保存末尾が1秒進み301秒分を終了まで確認。新しいL直前60秒・直後5分は欠け0、直前5分に1秒残存。板配信間隔の実測平均約263ms・最大約646ms、長期リプレイのメモリは未検証。SIGTERM後close1006・停止を確認。詳細はserver/PHASE2B_REPORT.md。Phase 3は未着手。
```

Phase 2bの実装と今回の確認を終了する。上記の欠け・遅延・測定尺の差を残して報告し、ここで停止する。
