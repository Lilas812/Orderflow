# Phase 1 受信基盤 実装・確認報告

## 実施内容

2026-10-26、承認された計画に従って `server/` に受信基盤を実装した。
Node v24.22.1 の標準WebSocket 1本でNQの約定・板を購読し、
正規化・検査・板の全量置換・約定の受信順保持・再接続・死活監視・JSON状態ページを実装した。
データの保存、履歴取得、ブラウザ向け配信、集計、画面は実装していない。

**今回の実装と3分のライブ確認は完了。Phase 1全体は未完了。**
SPEC 10節の30分連続受信はユーザーの別指示待ちであり、実行していない。
Phase 2には進まない。確認後、サーバーと上流接続は停止した。

## 変更ファイルと役割

| ファイル | 役割・変更 |
| --- | --- |
| `server/package.json` | 新しい受信サーバーパッケージ、実行・型検査・テストのコマンドと依存 |
| `server/tsconfig.json` | NodeNext、strict、noEmit、Node直接実行可能なTSの検査 |
| `server/src/config.ts` | `readConfig()`：必須キー・PORTの検査。値はエラーに出さない |
| `server/src/types.ts` | SPEC 6節のTrade・BookSnapshot・整数時刻／価格の型 |
| `server/src/logger.ts` | `createLogger()`・`makeSanitizer()`：1行JSON、キー・認証URLの除去 |
| `server/src/upstream/backoff.ts` | `reconnectDelay()`：時刻・乱数を注入する純粋な待機計算 |
| `server/src/upstream/connection.ts` | `Upstream`：接続、購読、ping応答、30秒監視、close確認後の再接続、終了 |
| `server/src/ingest/metrics.ts` | `Metrics`：type別・検査別件数、最初の5件の実例 |
| `server/src/ingest/receiver.ts` | `Receiver.receive()`・`trade()`・`snapshot()`：正規化と検査、通知・欠落区間の記録 |
| `server/src/book/state.ts` | `BookState.replace()`・`summary()`：最新板の全量置換と最良気配・段数 |
| `server/src/trades/recent.ts` | `RecentTrades.push()`・`latest()`：最大1,000件を受信順に保持、重複除去なし |
| `server/src/status/app.ts` | `createStatusApp()`・`statusSnapshot()`：機密を除いたJSON状態ページ |
| `server/src/index.ts` | `main()`・`shutdown()`：HTTP起動、SIGUSR2、SIGTERM・SIGINTによる終了 |
| `server/test/receiver.test.ts` | 正規化、板検査・全量置換、巻き戻り、約定保持、通知の通信しないテスト |
| `server/test/upstream.test.ts` | 純粋な再接続待機、偽時計・ダミーソケットでの監視・再購読・終了テスト |
| `server/test/security.test.ts` | ログ・状態出力の機密除去、設定検査のテスト |
| `server/README.md` | 起動・停止・確認手順、件数の意味と未実装範囲 |
| `server/PHASE1_REPORT.md` | この報告書。実行出力とライブ確認の証拠 |
| `pnpm-workspace.yaml` | `server` をワークスペースに追加 |
| `pnpm-lock.yaml` | 新パッケージと依存の解決結果 |
| `package.json` | 既存の全体型検査にserverを追加 |
| `artifacts/api-server/package.json` | 開発用 `dev` だけを受信サーバー起動へ切替 |
| `replit.md` | Current Status節だけ更新（内容は後述） |

事前作業で許可された変更：

- `docs/SPEC.md`：今回の添付を1文字も変えずに配置。配置直後に添付との `cmp` も成功。
- `docs/PHASE0_REPORT.md`：「## 判定」直後に指定された2行だけ追記。元との差分が2行だけであることを機械的に照合。
- `attached_assets/SPEC_(2)_1793019003994.md`・`attached_assets/SPEC_(3)_1793019614729.md` を許可どおり削除。

`scripts/src/` は変更・読み込みなし。`.replit`、artifact.toml、
デプロイのbuild/run/health設定、DB・App Storage、その他の仕様書は変更していない。
既存API Serverの開発用起動先だけを切り替えたため、本番用の旧build/start設定とは別。
今回の受信サーバーをデプロイ可能なものとして扱わない。

## 追加依存と実行方法

| 種類 | パッケージ | 実際に解決されたバージョン |
| --- | --- | --- |
| 実行時 | express | 5.3.0 |
| 開発時 | @types/express | 5.0.6 |
| 開発時 | @types/node | 24.19.2 |

TypeScript 5.9.3は既存のルート開発依存を使用。新しい実行補助パッケージは追加していない。
Node v24で `node src/index.ts` を直接実行し、別途 `tsc --noEmit` を実行する。
公式SDK、`ws`、`tsx`は新パッケージに追加していない。自動再起動も使わない。

## 確認手順

再実行は新しい実接続を作るため、他の接続を止めたうえでユーザーが必要なときに行う。
開発プレビューのURLは他人に共有しない。

1. ReplitのRunで既存の `artifacts/api-server: API Server` を起動する。
2. `/api/status` を開く。サーバーには仕様どおり `GET /status` があり、
   既存の `/api` プロキシ経由用に `/api/status` も同じハンドラーで受け付ける。
3. `upstream.state`、type別件数、検査件数、最良気配・段数、直近5約定を確認する。
   価格はティック整数、時刻はUnixマイクロ秒整数。
4. Nodeの受信プロセスに `kill -USR2 <PID>` を送る。
   `upstream_close` → `upstream_reconnect_scheduled` → `upstream_open` →
   `upstream_subscribed`、再接続回数の増加、板と約定の増加を確認する。
5. `kill -TERM <PID>` で停止し、`upstream_stopped` と `server_stopped` を確認する。
   PIDは実プロセスのコマンドと作業ディレクトリを確認して選ぶ。

通信しないコマンド：

```sh
pnpm --filter @workspace/receiver run typecheck
pnpm --filter @workspace/receiver test
pnpm run typecheck
```

## 実行した確認

### 単体テストの最終出力（そのまま）

すべてダミー入力・ダミーソケット。実際の外部接続は作らない。

```text
> @workspace/receiver@0.0.0 test /home/runner/workspace/server
> node --test test/*.test.ts

✔ ダミー：約定は秒→整数µs、価格→整数tick、sideを保持。同内容も消さない (2.451478ms)
✔ ダミー：板のサイズ0以下を段単位で除外、imbalanceは使わない (0.832235ms)
✔ ダミー：交差、並び順違反、価格重複、ティック外は板全体を棄却・件数加算 (12.188603ms)
✔ ダミー：正常な板で全量置換し、古い段を残さない (2.432757ms)
✔ ダミー：時刻巻き戻りは棄却、板と約定は別基準・同秒は許可 (0.256396ms)
✔ ダミー：壊れた形式・不正約定は採用せず、時刻の単位も推測しない (0.396165ms)
✔ ダミー：1,000件だけ受信順保持、棄却実例は種類ごとに5件まで (12.155767ms)
✔ ダミー：warning/feed/errorを件数とログに残し、欠落区間を捏造しない (0.423424ms)
✔ ダミー：ログと状態出力からキー・認証URL・key=を除去 (1.800922ms)
✔ ダミー：循環オブジェクトと改行もJSONログ1行、通常約定・板は逐次ログなし (0.55653ms)
✔ ダミー：PORTとキーを検査し、設定エラーに環境変数の値を出さない (0.891919ms)
✔ ダミー：バックオフは1,2,4…60秒、±20%、実待機上限60秒 (2.379585ms)
✔ ダミー：5分接続後に1秒へリセット、4029は60秒基準 (0.24021ms)
✔ ダミー：30秒無受信でclose、close確認前は再接続しない (7.548428ms)
✔ ダミー：ping→pong、受信で死活タイマー更新、再接続で再購読 (0.816082ms)
✔ ダミー：remote closeは1000でも再接続、停止はcloseを待ち再接続しない (0.646549ms)
✔ ダミー：backoff中の停止は予定再接続を取り消す (0.337023ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 712.604801
```

### 型検査・差分検査

```text
> @workspace/receiver@0.0.0 typecheck /home/runner/workspace/server
> tsc --noEmit
```

終了コード0。全体の `pnpm run typecheck` も終了コード0で、
libs、既存API Server、mockup-sandbox、scripts、serverの型検査が成功。
その後、4029からのバックオフが短時間の失敗で低い値に戻らないことを
純粋関数とテストで補強し、上記の最終server型検査と17件のテストを再実行した。
4029の実接続試験や、その補強後の追加ライブ実行は行っていない。

`git diff --check` 成功。
`git diff --exit-code -- scripts/src .replit docs/AGENT_RULES.md docs/UI_SPEC_HEATMAP.md docs/PHASE0_REPORT.md` 成功
（今回の実装開始時点から未変更。PHASE0_REPORTの許可された追記は前の事前作業で実施済み）。
`pnpm --filter @workspace/receiver list --depth 0` で上表の依存を確認。

```text
f3f26ea66e39d6cae728390338226b74501c91f6e41459c85de366aa98f49732  docs/SPEC.md
```

### ライブ確認

- 最初のopen：2026-10-26 13:10:56.409 UTC（日本時間22:10:56.409）。
- 3分経過時の採取：180,164ms後。約定1,224件・板710件、ping13件。
- 以下の3分時点では予期しない切断なし、検査違反・棄却0件。
- その後、確認用コマンドが `pgrep -f '^node src/index.ts$'` でPIDを見つけられず停止した。
  実際はNode実行ファイルがNixの絶対パスで表示されていたため。
  サーバーは受信を継続していた。`ps` と `/proc/<PID>/cmdline` で
  実際のNodeプロセスを確認し、サーバーは再起動せずに強制切断の確認を続行した。
- SIGUSR2：13:14:49.541 UTC。最初の接続は3分計測後も上記の確認中に継続していた。
- 13:14:51.733 UTCに再open・再購読。SIGUSR2から2,596ms後の確認で、
  再接続回数1、シグナル直前に比べて板1件・約定1件の増加を確認。
- SIGTERM：13:14:52.139 UTC。13:14:52.401 UTCにcloseイベントを受信して停止。
- シグナル操作は既存Nodeプロセスに対して実行し、別の受信プロセスは起動していない。
- 通常の板・約定は1件ずつログに出さず、アプリは実データをファイルに保存していない。
  検証用の状態JSONとテスト出力は `/tmp/phase1-*` に一時保存した。

#### 3分時点の `/status` 出力（`/api/status` 経由、整形のみ）

```json
{
  "upstream": {
    "state": "open",
    "connectedAtUs": 1793020256409000,
    "lastReceivedUs": 1793020436554000,
    "reconnectCount": 0,
    "lastClose": null,
    "retryDelayMs": null
  },
  "byType": {"welcome": 1, "ping": 13, "tick": 1224, "book": 710},
  "counts": {
    "nonPositiveBookLevels": 0,
    "crossedBook": 0,
    "bookOrder": 0,
    "duplicatePrice": 0,
    "offTick": 0,
    "timestampRollback": 0,
    "warning": 0,
    "feed": 0,
    "error": 0,
    "ticksLagged": 0,
    "invalidJson": 0,
    "invalidMessage": 0,
    "unknownType": 0,
    "rejectedBook": 0,
    "rejectedTrade": 0,
    "acceptedBook": 710,
    "acceptedTrade": 1224,
    "disconnects": 0,
    "abnormalClose": 0,
    "watchdog": 0
  },
  "examples": {},
  "lagIntervals": [],
  "book": {
    "tsUs": 1793020436000000,
    "recvUs": 1793020436554000,
    "source": "live",
    "bestBid": {"price": 117113, "size": 1},
    "bestAsk": {"price": 117116, "size": 1},
    "bidDepth": 400,
    "askDepth": 400
  },
  "tradeCount": 1000,
  "recentTrades": [
    {"tsUs": 1793020436000000, "recvUs": 1793020436483000, "seq": 1220, "price": 117115, "size": 1, "side": "sell"},
    {"tsUs": 1793020436000000, "recvUs": 1793020436483000, "seq": 1221, "price": 117114, "size": 1, "side": "sell"},
    {"tsUs": 1793020436000000, "recvUs": 1793020436518000, "seq": 1222, "price": 117111, "size": 1, "side": "sell"},
    {"tsUs": 1793020436000000, "recvUs": 1793020436518000, "seq": 1223, "price": 117111, "size": 1, "side": "sell"},
    {"tsUs": 1793020436000000, "recvUs": 1793020436522000, "seq": 1224, "price": 117113, "size": 1, "side": "buy"}
  ],
  "units": {"time": "Unix microseconds (integer)", "price": "NQ ticks (0.25)"}
}
```

同時刻・価格・枚数・方向が同じseq=1222と1223も、そのまま別の約定として保持している。
最良気配の117113 / 117116は価格÷0.25の整数であり、ドル価格そのものではない。

#### 強制切断・再接続・終了ログ（そのまま）

```json
{"recvUs":1793020489541000,"event":"upstream_close_requested","details":{"code":1000,"reason":"SIGUSR2"}}
{"recvUs":1793020489793000,"event":"upstream_network_error","details":{"state":"closing"}}
{"recvUs":1793020489794000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"SIGUSR2","recvUs":1793020489794000}}
{"recvUs":1793020489794000,"event":"upstream_reconnect_scheduled","details":{"code":1006,"reason":"SIGUSR2","delayMs":852}}
{"recvUs":1793020490647000,"event":"upstream_connecting","details":{"reconnectCount":1}}
{"recvUs":1793020491733000,"event":"upstream_open","details":{}}
{"recvUs":1793020491733000,"event":"upstream_subscribed","details":{"trades":"NQ","book":"NQ"}}
{"recvUs":1793020491734000,"event":"upstream_welcome","details":{}}
{"recvUs":1793020492139000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793020492140000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793020492401000,"event":"upstream_network_error","details":{"state":"closing"}}
{"recvUs":1793020492401000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793020492401000}}
{"recvUs":1793020492401000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793020492401000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

closeイベント後にのみ次のソケットを作成している。SIGTERM後は再接続しない。
1006は正常closeではないが、closeイベントでローカル接続の終了を確認した。
提供元の接続枠が直ちに解放されたことまでは確認できない（SPECの最大45秒残留に注意）。

## 仕様との差分

実装の仕様逸脱はなし。`/api/status` は既存プロキシ用の別名として追加し、
仕様どおりの `GET /status` も実装している。
今回の指示どおり、30分連続受信は保留し、Phase 1全体の完了とはしていない。

## 未解決・懸念

- 1006の原因は未特定。サーバー・中間経路・クライアントのいずれも除外していない。
- 3分の観測は米国寄り付き前。寄り付きの30分連続受信は未実施。
- 30秒の無受信、4029、巻き戻りや異常板、ticks_laggedはダミー単体テストで確認した。
  今回のライブでは発生しておらず、実データでその経路を確認したとはしない。
- ticks_laggedが厳密な欠落区間を示さなければ、既知の直前約定・観測時刻と
  送信元の区間フィールドを記録し、区間や時刻単位を推測しない。補完はしない。
- closeイベントが来ない場合は、新接続を作らずclosingに留まる。
  ハンドシェイクを確認できないまま接続を重ねる回避策や強制終了は実装していない。
- 状態ページは実データを含む。第三者にURLを共有しない。
- `.agents/memory/` の変更はなし。今回の判断は新しいSPECと報告に記載済み。

## replit.md の更新内容

Current Status節に次の2項目だけを追記した。

```text
- 2026-10-26：Phase 0 は未解決項目を残してユーザー判断で完了。SPEC.md を許可された新版に差し替え、PHASE0_REPORT.md に判定の追記を実施。
- 2026-10-26：server/ に Phase 1 受信基盤を実装。単体テスト17件・型検査成功、取引時間中の3分受信とSIGUSR2による再接続・再購読を確認し、サーバー停止済み。30分連続受信は未実施のためPhase 1全体は未完了。詳細は server/PHASE1_REPORT.md。
```

## 次の候補

ユーザーの別指示後、米国寄り付きに合わせて30分連続受信と切断復帰を確認する。
提案のみで実行しない。Phase 2には進まず、ここで停止する。

---

## 追加確認：2026-10-26 米国寄り付きの連続受信

### 報告

- 実施内容：既存のRun設定で受信し、5分ごとの状態・RSS・CPUを保存。23:00にSIGTERMで停止した。ユーザー確認により22:25〜23:00の35分枠で実施し、追加受信・修正・Phase 2は行っていない。
- 変更ファイル：本ファイルへの追記、`replit.md` のCurrent Statusへの追記、`data/phase1-soak/` の観測記録。コード・依存パッケージ設定・Run設定の値・デプロイ設定・`docs/`・`scripts/src/`に最終差分はない。ただし `.replit` には末尾改行の消失だけが残った（下記）。
- 確認手順：下記の表と `data/phase1-soak/resources.json`、各 `status-*.json`、`observer-events.jsonl`、`server-events.jsonl` を比較する。停止済みなので、確認のためにサーバーを再起動しない。
- 実行した確認：開始前の `ps -eo pid,ppid,comm,args`、既存Runの起動、`/api/status` の定時取得、`/proc/2106/status`・`/proc/2106/stat`によるリソース記録、SIGTERM、ワークフローログとプロセス消失の照合、保存JSONからの集計、Git差分確認。今回、単体テスト・型検査・検証スクリプトは実行していない。
- 仕様との差分：起動に時間を要し、上流接続開始は22:25:11.960。22:25の状態取得はHTTP 502で12回失敗し、その時刻のJSONは欠損。初回成功は22:26:14.334。最終JSONは停止を遅らせないため22:59:58に取得した。取得していない値は補完していない。また、下記の `.replit` 末尾改行差分が残り、許可された2ファイルだけの変更にはできなかった。
- 未解決・懸念：終了時1006の原因とフィードの完全性は未解決。最終状態取得から停止までの約2秒間の受信件数は不明。close後の提供元接続枠解放は直接確認していない。作業中に `.replit` への `[nix] packages = ["ps"]` 追加を検出し、元の設定をスキーマ検証付き置換で復元した。設定値は戻ったが、置換後に末尾の改行だけが消失している。追加の修復は行わず、その差分を報告する。ワークフローは再起動していない。
- 次の候補：なし。今回の観測結果を報告して停止する。Phase 2は開始しない。

### 開始・終了と判定

時刻は以下すべて2026-10-26の日本時間（UTC+09:00）。保存JSON内のISO時刻はUTC。

- 22:24:07のプロセス確認で、このワークスペース内に他の受信サーバー・Phase 0受信処理はなかった。別端末などの契約全体の接続数を確認したとはしない。
- 既存Run：`artifacts/api-server: API Server`。受信プロセスはPID 2106で全成功サンプルを通じて同一。
- HTTP待受：22:25:10.664。上流接続開始：22:25:11.960。再購読不要で、そのまま連続受信した。
- SIGTERM送信：23:00:00.003。上流close・`upstream_stopped`・`server_stopped`：23:00:00.291。プロセス消失確認：23:00:00.410。
- 上流openからSIGTERMまで **34分48.043秒**。最終状態の取得開始まででも **34分46.047秒**。受信中の再接続・切断・死活監視発火は0回。
- 最終状態で板8,287件（採用8,284件、拒否3件）、約定76,685件（すべて採用）。これは22:59:58時点までの件数であり、停止時の全件数ではない。
- 残っていた「取引時間中に30分連続で受信」を満たした。前回記録済みの自動再接続・再購読と単体テスト17件の結果と合わせ、Phase 1の完了条件を満たしたと判定する。今回、異常切断復帰の追加試験はしていない。Phase 0の未解決事項を解決済みとする判定ではない。

### 5分ごとの受信・リソース

板・約定は `byType.book` / `byType.tick` の累計（拒否分も含む）。括弧内は前回の成功サンプルとの差。
CPUは `/proc` のutime+stimeの差÷CLK_TCK（100）÷実測経過秒×100。1コアを100%とする区間平均で、瞬間値ではない。
22:30のCPUは補足初回記録のCPU ticks=61と22:30の154から算出した。
RSSはKiB÷1024のMiB。初回CPUは比較対象がないため区間値なし（生涯平均は0.94%）。

| 実測時刻 JST | 板 累計（増分） | 約定 累計（増分） | 再接続 累計 | RSS MiB | CPU % |
| --- | ---: | ---: | ---: | ---: | ---: |
| 22:25 | 欠損（HTTP 502） | 欠損 | 不明 | 不明 | 不明 |
| 22:26:14.334（補足初回） | 248（—） | 417（—） | 0 | 112.41 | — |
| 22:30:00.006 | 1,140（892） | 2,681（2,264） | 0 | 109.06 | 0.41 |
| 22:35:00.000 | 2,323（1,183） | 22,435（19,754） | 0 | 115.97 | 0.79 |
| 22:40:00.001 | 3,513（1,190） | 35,651（13,216） | 0 | 116.51 | 0.64 |
| 22:45:00.000 | 4,709（1,196） | 47,953（12,302） | 0 | 116.52 | 0.66 |
| 22:50:00.000 | 5,907（1,198） | 58,456（10,503） | 0 | 116.98 | 0.55 |
| 22:55:00.001 | 7,099（1,192） | 66,716（8,260） | 0 | 113.63 | 0.50 |
| 22:59:58.007（23:00枠） | 8,287（1,188） | 76,685（9,969） | 0 | 113.57 | 0.50 |

22:30の増分は22:26:14.334からの225.672秒分であり、5分全体の増分ではない。
最終区間は298.006秒。表の時刻はリソース採取・HTTPリクエスト開始時刻で、状態はその直後の応答時点。
HTTP応答の保存完了時刻は順に22:30:00.042、22:35:00.023、22:40:00.111、22:45:00.030、22:50:00.200、22:55:00.028、22:59:58.035。
サンプル間のRSS・CPUピークは測定していない。

### SPEC 5.5の各件数（累計）

`非正数` は `nonPositiveBookLevels`、`交差` は `crossedBook`、`並び` は `bookOrder`、
`重複` は `duplicatePrice`、`巻戻り` は `timestampRollback`。warning中のticks_laggedは独立に併記。

| 時刻 JST | 非正数 | 交差 | 並び | 重複 | 巻戻り | warning | ticks_lagged | feed | error | 切断 / 異常close |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 22:25 | 不明 | 不明 | 不明 | 不明 | 不明 | 不明 | 不明 | 不明 | 不明 | 不明 |
| 22:26:14.334 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:35 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:40 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:45 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:50 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:55 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| 22:59:58 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |

- 履歴1,600行：対象外。今回REST履歴を取得していないため0件確認とはしない。
- `offTick`、`invalidJson`、`invalidMessage`、`unknownType`、`rejectedTrade`、`watchdog` は全成功サンプルで0。
- `rejectedBook` は22:30まで0、22:35以降3。交差板3件を使わず、採用板のみ更新した。
- 表は停止前の状態。停止操作に伴う23:00:00.291の1006は下記ログの別事象であり、表の0件と混同しない。

### 寄り付き前後とそれ以降の受信速度

1秒あたりの受信メッセージ件数（採用件数・売買枚数ではない）。
22:25のJSONがないため、前半はプロセス起動後の累計を使い、実際に上流openとなった22:25:11.960から計算した。
HTTP応答時差を含む区間平均の概算であり、秒単位のピークではない。

| 比較区間 JST | 実測秒 | 板件数 | 板 件/秒 | 約定件数 | 約定 件/秒 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 寄り付き前後：22:25:11.960〜22:35:00.000 | 588.040 | 2,323 | 3.9504 | 22,435 | 38.1522 |
| それ以降：22:35:00.000〜22:59:58.007 | 1,498.007 | 5,964 | 3.9813 | 54,250 | 36.2148 |

補足：22:25:11.960〜22:30:00.006は板約3.9577件/秒・約定約9.3075件/秒。
22:30〜22:35は板約3.9433件/秒・約定約65.8467件/秒。寄り付き直後に約定件数が増加した。
前半・後半の板の頻度は近いが、これをフィード完全性の証明とはしない。

### 検査違反・warning・feed・errorの全記録

受信した `warning`（`ticks_lagged`を含む）・`feed`・`error`：**なし**。
保存した最終状態でも各0件、`lagIntervals` は空。欠落が一切ないと証明した意味ではない。
終了時の `upstream_network_error` は上流の `type:"error"` メッセージではなく、下記終了ログに全件を載せる。

クロス板は22:30:03.407、22:30:16.907、22:31:52.607に検出。対応するログ全3件：

```json
{"recvUs":1793021403408000,"event":"validation_issue","details":{"kind":"crossedBook","example":{"bestBid":116850,"bestAsk":116843,"recvUs":1793021403407000},"count":1}}
{"recvUs":1793021416907000,"event":"validation_issue","details":{"kind":"crossedBook","example":{"bestBid":116850,"bestAsk":116840,"recvUs":1793021416907000},"count":2}}
{"recvUs":1793021512607000,"event":"validation_issue","details":{"kind":"crossedBook","example":{"bestBid":116805,"bestAsk":116803,"recvUs":1793021512607000},"count":3}}
```

価格はNQ ticks（価格÷0.25）の整数。最初の交差例を3件とも保存しており、ほかの検査違反は記録されていない。

### 切断・再接続と終了ログ

受信中の意図しない切断・再接続はなし。終了時のみ1006を記録した。
終了処理の直前に記録された通常運転中のイベントは、上記22:31:52.607の交差板ログ（ログ出力は22:31:52.607）。
以後、shutdownまで他のイベントログはなく、22:59:58の状態では接続open・最終受信22:59:58.024だった。
終了要求からclose直前・停止までのログは以下の全6件：

```json
{"recvUs":1793023200003000,"event":"shutdown_requested","details":{"signal":"SIGTERM"}}
{"recvUs":1793023200017000,"event":"upstream_close_requested","details":{"code":1000,"reason":"shutdown"}}
{"recvUs":1793023200290000,"event":"upstream_network_error","details":{"state":"closing"}}
{"recvUs":1793023200291000,"event":"upstream_close","details":{"code":1006,"wasClean":false,"reason":"shutdown","recvUs":1793023200291000}}
{"recvUs":1793023200291000,"event":"upstream_stopped","details":{"socketClosed":true}}
{"recvUs":1793023200291000,"event":"server_stopped","details":{"upstream":"stopped","httpClosed":true}}
```

close(1000)を要求したが、正常closeハンドシェイクは確認できず、ローカルで1006・wasClean=falseとなった。
1006を提供元が送信したと断定しない。`socketClosed:true`、`httpClosed:true`とプロセス消失でローカル終了を確認した。
終了後の再接続・追加受信・起動はしていない。提供元側の接続枠解放や1006の原因は不明。

### 最後の `/api/status` 出力（原文）

`data/phase1-soak/status-20261026T230000+0900.json`。
ファイル名は23:00枠だが、実際の取得開始22:59:58.007、保存完了22:59:58.035。
停止前の出力なので `upstream.state:"open"` と `lastClose:null` はそのまま残す。停止ログによる終了確認とは別の時点。

```json
{"upstream":{"state":"open","connectedAtUs":1793021111960000,"lastReceivedUs":1793023198024000,"reconnectCount":0,"lastClose":null,"retryDelayMs":null},"byType":{"welcome":1,"ping":140,"tick":76685,"book":8287},"counts":{"nonPositiveBookLevels":0,"crossedBook":3,"bookOrder":0,"duplicatePrice":0,"offTick":0,"timestampRollback":0,"warning":0,"feed":0,"error":0,"ticksLagged":0,"invalidJson":0,"invalidMessage":0,"unknownType":0,"rejectedBook":3,"rejectedTrade":0,"acceptedBook":8284,"acceptedTrade":76685,"disconnects":0,"abnormalClose":0,"watchdog":0},"examples":{"crossedBook":[{"bestBid":116850,"bestAsk":116843,"recvUs":1793021403407000},{"bestBid":116850,"bestAsk":116840,"recvUs":1793021416907000},{"bestBid":116805,"bestAsk":116803,"recvUs":1793021512607000}]},"lagIntervals":[],"book":{"tsUs":1793023197000000,"recvUs":1793023197857000,"source":"live","bestBid":{"price":116823,"size":2},"bestAsk":{"price":116826,"size":2},"bidDepth":400,"askDepth":400},"tradeCount":1000,"recentTrades":[{"tsUs":1793023197000000,"recvUs":1793023198015000,"seq":76681,"price":116832,"size":1,"side":"buy"},{"tsUs":1793023197000000,"recvUs":1793023198024000,"seq":76682,"price":116831,"size":1,"side":"sell"},{"tsUs":1793023197000000,"recvUs":1793023198024000,"seq":76683,"price":116830,"size":1,"side":"sell"},{"tsUs":1793023197000000,"recvUs":1793023198024000,"seq":76684,"price":116830,"size":1,"side":"sell"},{"tsUs":1793023197000000,"recvUs":1793023198024000,"seq":76685,"price":116829,"size":1,"side":"sell"}],"units":{"time":"Unix microseconds (integer)","price":"NQ ticks (0.25)"}}
```

### 保存先とCurrent Statusの更新内容

- `data/phase1-soak/status-initial-20261026T132614.334Z.json`：補足初回。
- `data/phase1-soak/status-20261026T223000+0900.json`、`223500`、`224000`、`224500`、`225000`、`225500`、`230000`の同形式ファイル：定時7件。
- `data/phase1-soak/resources.json`：22:25の失敗12件と成功7件の時刻・RSS・CPU原記録。
- `data/phase1-soak/initial-resource.json`：補足初回の時刻・RSS・CPU原記録。
- `data/phase1-soak/observer-events.jsonl`：採取成功・失敗、SIGTERM、プロセス終了の記録。
- `data/phase1-soak/server-events.jsonl`：今回のRunの開始・検査違反・停止のイベントログ全件。
- `data/phase1-soak/run-metadata.json`：予定時刻・承認35分・開始前プロセス確認など。
- `data/` は既存設定でGit・デプロイ対象外。公開URLや秘密情報は記録・共有していない。

`replit.md` のCurrent Status末尾に次の1項目だけを追記した：

```text
- 2026-10-26：米国寄り付きの連続受信を22:25:11.960〜23:00:00.003 JSTの34分48.043秒実施。最終状態取得まで板8,287件・約定76,685件、受信中の再接続0回、クロス板3件を拒否。SIGTERM後23:00:00.291に上流close（1006）とサーバー停止を確認。開始時の状態取得欠損・終了2秒前の最終取得を含む詳細は server/PHASE1_REPORT.md に追記。残っていた30分連続受信条件を満たし、既存の試験結果と合わせPhase 1完了。1006の原因・フィードの完全性は未解決のまま。Phase 2は未着手。
```
