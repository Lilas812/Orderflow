# Phase 10a 公開準備

## 報告

- 実施内容：App Storage保存、本番の単一プロセス配信、CPU・起動以来最大RSSを追加した。実クラウドの復元、30分ライブ、3ブラウザの範囲要求を測定した。公開はしていない。
- 変更ファイル：下の「変更ファイル」参照。
- 確認手順：下の「起動と公開時の確認手順」参照。今回はPublishせず、公開環境の実測は行っていない。
- 実行した確認：事前・最終ハッシュ、サーバー106試験・画面105試験、両型検査、本番ビルド、実App Storage・本番コマンドでの確認。追加CPUスモークの停止待ちは120秒でタイムアウトした。成功と失敗を分けて下記に記録した。
- 仕様との差分：保存のバイナリ・JSONL・設定・配信の形式は変更しない。追加決定は「仕様にない値」に記録。性能目安との比較は測定結果欄。
- 未解決・懸念：定常RSSの目安超過、3台要求時のCPU増加、キャッシュを残した再起動後の再アップロードと停止待ち。Reserved VM実機・公開ルーティング・公開Secretsは未確認。1GiBで安定稼働すると結論しない。
- 次の候補：測定結果を確認してから公開可否を判断する。ここでは実装・Publish・Phase 10b/10cを進めない。

## 1. 正本の差し替えと添付の削除

元の添付 `attached_assets/SPEC_(15)_1793129568809.md` を内容を変更せず `docs/SPEC.md` に配置した。確認後、その添付だけを削除した。UI_SPECとAGENT_RULESは変更していない。

```text
93d97782d3d4631add50f5434e6fadb81f3880bd8dffe992c15d55e639c24853  docs/SPEC.md
0a3b5433944ad1b515660c224c82f93090fc424bd8a92f4e1ff5306bdc69fbb3  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

削除した添付：`attached_assets/SPEC_(15)_1793129568809.md`。プロンプトの添付は残した。既存の通常ローカル保存データには触れていない。検証専用キャッシュ等の削除は実測記録に別記する。

## 2. 保存先の選択と永続化

- `storageMode()` は `REPLIT_DEPLOYMENT === "1"` を公開先と判定する。公開先は常にApp Storage／`prod/`。`NODE_ENV=production` だけでは公開判定にしない。
- Workspaceの既定は今までどおりLocalStore／LocalSettings。開発の明示試験は `HEATMAP_STORAGE=app-storage` でApp Storage／`dev/` にする。
- `HEATMAP_STORAGE_DIR` はApp Storage実装の作業用ディスクの場所。未指定は `data/app-storage-working/`。今回だけ `data/phase10a/working/` を使用した。通常の `data/settings.json`、`data/columns`、`data/trades` と分離した。
- 同じプロジェクトのWorkspaceと公開先は同じApp Storageバケットを利用できる。別プロジェクト同士の共有と混同しない。同じバケットでも `dev/` と `prod/` が分かれる。
- SDKへ `DEFAULT_OBJECT_STORAGE_BUCKET_ID` を渡す。SDKの既定バケット自動検出が空を返すケースがあり、明示指定で通信を確認した。認証はSDK／Replitの実行環境に任せ、キーや資格情報の値は出さない。

オブジェクト名：

```text
{dev|prod}/columns/NQ/1s/YYYY-MM-DD/HH.bin.gz
{dev|prod}/trades/NQ/YYYY-MM-DD/HH.jsonl.gz
{dev|prod}/coverage.json
{dev|prod}/settings.json
{dev|prod}/settings.corrupt-<Unixマイクロ秒>.json
```

`AppStore.publish()` は完了時間の作業ファイルを一時スナップショットにしてアップロードし、再ダウンロードのSHA-256照合後にクラウドのcoverageを更新する。coverage自体も再ダウンロード照合する。失敗時は元の作業ファイルを残し、状態ページへ失敗・対象・次回時刻を出す。

クラウドの `coverage.json` が永続保存済み区間の正本であり、アップロード確認済みの区間だけを持つ。ローカルの作業用coverageは未アップロードの手元の区間も含む。再起動時にはクラウドのcoverageと実在するローカルファイルだけから作業用coverageを再構成する。ローカルの書きかけが消えれば保存済みと扱わず、履歴取得へ戻る。

`AppStore` の7日削除は無効。アップロード確認済みの48時間より古いキャッシュだけを除く。クラウドオブジェクトは自動削除しない。通常の開発LocalStoreの7日削除は変更しない。

古い要求は `.read-temporary/` のディスクへ落とし、列は `columnFileRange()`、約定は既存の行ストリームで読む。時間ファイル全体をメモリに展開しない。応答成功・失敗のfinallyで一時ファイルを消す。同時に同じ時間を読む間は参照数で保護する。

`AppSettings.put()` はクラウドの原本を確認してから保存する。破損原本は同じ接頭辞の退避オブジェクトへの保存・再DL照合が成功するまで上書きしない。退避オブジェクトを自動削除する処理はない。ローカルの設定をクラウド通信失敗時の代わりとして返すこともしない。

## 3. 変更ファイル

| ファイル | 主な関数・役割 |
|---|---|
| `docs/SPEC.md` | 指定添付への完全一致差し替えのみ |
| `server/src/store/objects.ts` | `Objects`、`ReplitObjects`、`uploadVerified()`、`storageMode()` |
| `server/src/store/app.ts` | `AppStore`、時間ファイルのアップロード、クラウドcoverage、キャッシュ／一時ディスク、再試行 |
| `server/src/store/local.ts` | 保存インターフェースの裏で差し替えられる読込フック等。LocalStoreの保存形式・7日削除は維持 |
| `server/src/store/records.ts` | `columnFileRange()`：ディスクの列レコードをストリームで選択読込 |
| `server/src/settings/app.ts` | `AppSettings`：クラウド設定、破損原本の先行退避 |
| `server/src/diagnostics/cpu.ts` | `CpuMonitor`：プロセスCPU時間／実時間、10秒・60秒平均（コア） |
| `server/src/diagnostics/memory.ts` | `snapshot()` に `rssMaxBytes` と `cpu` を追加 |
| `server/src/index.ts` | 保存実装選択。本番時のみ画面ビルドも配る |
| `server/src/pipeline.ts` | 保存実装の注入、App Storageの状態公開 |
| `server/src/status/app.ts` | `createStatusApp()`：ヘルスチェック・同ポート静的配信 |
| `server/package.json`、`pnpm-lock.yaml` | 本番build/start、追加直接依存は `@replit/object-storage` のみ |
| `server/test/app-storage.test.ts` | 「ダミー」と明記した保存・再試行・再起動・キャッシュ・破損設定の試験 |
| `server/test/memory-performance.test.ts` | 状態の追加フィールドに期待値を合わせた |
| `server/test/cpu.test.ts` | タイマー前・タイマー間のCPU平均が取得できること |
| `server/tools/perf/cdp.ts` | 3台を別Chromiumプロファイルで起動できるようポートをプロファイル名に含めた |
| `server/tools/perf/phase10a-check.ts` | 実クラウド、本番起動、ライブ照合、3台要求、終了処理の検証専用 |
| `server/tools/perf/phase10a-probe.ts` | `/proc` を100ms間隔で観測する検証専用 |
| `server/tools/perf/phase10a-analyze.ts` | 受信締切を合わせた保存行照合、性能集計 |
| `server/tools/perf/phase10a-cpu-smoke.ts` | 最終CPU診断の短い本番起動確認。停止待ち120秒のタイムアウトは下記参照 |
| `artifacts/heatmap/.replit-artifact/artifact.toml` | 本番build/startと起動ヘルスチェック |
| `artifacts/api-server/.replit-artifact/artifact.toml` | 本番の別APIサービスを無効化。開発の既存起動は維持 |
| `.replit` | デプロイ種別をReserved VMへ。Publishしていない |
| `server/PHASE10A_REPORT.md`、`replit.md` Current Status | 今回の結果 |
| `.agents/memory/` | ユーザー決定と測定後の制限解除を記録 |

設定ファイルは一時TOMLに書いてから検証・置換する手順を使った。直接書換えはしていない。`scripts/src/`、画面の見た目、受信・集計・描画の高速化、データベースは変更していない。

## 4. 起動と公開時の確認手順

本番設定：

```text
build: pnpm --filter @workspace/receiver run build
run:   pnpm --filter @workspace/receiver run start
```

`start` は `HEATMAP_SERVE_FRONTEND=1 NODE_ENV=production node src/index.ts`。Node 24の1プロセスで本番 `artifacts/heatmap/dist/public/` と `/api/status`、`/api/settings`、`/api/ws` を配信する。`PORT` で `0.0.0.0` に待受け、公開用サービスは25028、起動ヘルスチェックは `/api/healthz`。

開発の既存Runは変更せず、Vite 25028／API 8080のまま。今回の本番コマンド試験だけ `PORT=8080 HEATMAP_STORAGE=app-storage HEATMAP_STORAGE_DIR=<検証専用ディレクトリ>` を指定した。19090はブラウザ測定用のHTTP/WS透過プロキシで、本番サーバーの別プロセス構成には含めない。

公開するときにユーザーが行う順序（今回は実行しない）：

1. 本報告の性能比較・未解決事項を確認し、公開に進むか判断する。
2. Publishingを開き、Reserved VMを選び、**0.25 vCPU／1GiB** の種類を選ぶ。`.replit` の種別は `vm`。このWorkspaceでは公開実機のサイズを測定していない。
3. 上記build／run、ポート25028、`/api/healthz`、本番の受信Nodeが1つだけであることを確認する。開発用APIを別の本番プロセスとして起動しない。
4. 公開先のSecretsを確認する。WorkspaceのSecretsが公開先へ自動同期されるとは仮定しない。`TICKSTREAM_API_KEY` と `DEFAULT_OBJECT_STORAGE_BUCKET_ID` が公開先にも設定されていることを確認する。値をログやチャットへ出さない。開発試験用 `HEATMAP_STORAGE_DIR` は公開先へ持ち込まない。
5. 公開範囲を **Invite only** にし、招待対象を確認する。公開アプリURLはまだ存在しないので、Workspace URLを本番URLとして使わない。
6. 内容を確認したユーザーがPublishを押す。
7. 公開URLの `/api/healthz` が200、`/api/status` で上流の接続・購読・板／約定件数が増えること、App Storageの接頭辞が `prod/` であることを確認する。上流の認証エラーがないことと実受信の増加が、公開プロセスでキーを読めたことの確認になる。キー自体は表示しない。
8. 画面・設定保存・ライブ受信と、他端末の設定読込を確認する。公開先のRSS・CPUは別途実機で測る。Workspaceの結果を実機測定としない。

参照したReplit公式情報：App Storage（同一アプリの開発／公開間のデータ共有）、Replit App Configuration（`REPLIT_DEPLOYMENT=1`）、Secrets（公開先での確認）、Who can access your app（Invite only）、Cloud Aug 2026 Pricing Updates（0.25 vCPU／1GiBの種類）。本報告では料金の更新やSPEC本文の変更はしない。

## 5. 実行した試験

```text
pnpm --filter @workspace/receiver test       106 / 106
pnpm --filter @workspace/receiver typecheck 成功
pnpm --filter @workspace/heatmap test        105 / 105
pnpm --filter @workspace/heatmap typecheck   成功
pnpm --filter @workspace/receiver build     成功（本番Vite build）
```

`app-storage.test.ts` の6試験は通信しない「ダミー」。アップロード／再DL照合、失敗時の保持と60秒後再試行、クラウドcoverageへの未アップロード除外、prod/dev選択、失った書きかけのcoverage除外、古い時間の一時ストリームと成功／失敗後の除去、7日より前のクラウド保持、47時間保持／49時間キャッシュ除去、破損設定退避失敗時の原本不変を確認した。

本番の同じ8080ポートで `/`（HTML）、`/api/healthz`、`/api/status`、`/api/settings` が全て200。WebSocket・実画面・設定保存はブラウザ検証で確認。証拠は `data/phase10a/same-port-http.json`、`production-replay.png`、`production-live30.png`、`result.json`。`data/` はGit・公開物に含めない。

## 6. 実App Storageと性能測定

測定日は2026-10-28（日本時間）。生記録は `data/phase10a/`。本番コマンドをWorkspaceで動かした結果であり、Reserved VMを公開して測った値ではない。サーバーのアプリケーションNodeプロセスを測定し、Chromium・測定用プロキシ・pnpmランチャー・Workspace全体の使用量は合算していない。CPUをホストのコア数で割っていない。

### 6.1 実クラウド保存と再起動

最初の受信プロセスはPID3940。UTC 19時→20時（JST 04:59→05:00）をまたいだ。`dev/columns/NQ/1s/2026-10-27/19.bin.gz` は05:03:44.472 JSTに `sha256Verified:true` でアップロードされ、クラウドcoverageへ `[1793127600,1793131200)` が入った。

初回は直近3時間の板180窓を562.756秒で取得し、その後セッションVPの履歴取込が64.749秒で完了した。VPは保存分10,800秒＋API分68,310秒、取込516,200約定。履歴のネットワーク要求436回、通信失敗・再試行・未取得窓は0。

初回の履歴検査では `invalidMessage:1`／`rejectedTrade:1`、`tradeTimestampRollback:12`、`historyRepeated2Different:14`／`historyRepeated2Same:8` を記録した。これらをゼロとは報告しない。不正行の拒否・巻き戻り等の記録は既存の検査規則によるもので、今回修正していない。詳細は `result.json` の `firstComplete.phase2a.historyCounts/historyExamples`。

一旦SIGTERMで止め、クラウド確認済みの検証用キャッシュ26ファイルを消した。削除前に各SHA-256を記録した（`result.json.cacheDeleted`）。削除対象は次のとおり。接頭辞は全て `data/phase10a/working/`。

```text
columns/NQ/1s/2026-10-27/16.bin.gz
columns/NQ/1s/2026-10-27/17.bin.gz
columns/NQ/1s/2026-10-27/18.bin.gz
columns/NQ/1s/2026-10-27/19.bin.gz
trades/NQ/2026-10-26/22.jsonl.gz
trades/NQ/2026-10-26/23.jsonl.gz
trades/NQ/2026-10-27/00.jsonl.gz
trades/NQ/2026-10-27/01.jsonl.gz
trades/NQ/2026-10-27/02.jsonl.gz
trades/NQ/2026-10-27/03.jsonl.gz
trades/NQ/2026-10-27/04.jsonl.gz
trades/NQ/2026-10-27/05.jsonl.gz
trades/NQ/2026-10-27/06.jsonl.gz
trades/NQ/2026-10-27/07.jsonl.gz
trades/NQ/2026-10-27/08.jsonl.gz
trades/NQ/2026-10-27/09.jsonl.gz
trades/NQ/2026-10-27/10.jsonl.gz
trades/NQ/2026-10-27/11.jsonl.gz
trades/NQ/2026-10-27/12.jsonl.gz
trades/NQ/2026-10-27/13.jsonl.gz
trades/NQ/2026-10-27/14.jsonl.gz
trades/NQ/2026-10-27/15.jsonl.gz
trades/NQ/2026-10-27/16.jsonl.gz
trades/NQ/2026-10-27/17.jsonl.gz
trades/NQ/2026-10-27/18.jsonl.gz
trades/NQ/2026-10-27/19.jsonl.gz
```

加えて、未アップロードの当時のUTC20時の書きかけを、証拠用コピーを `data/phase10a/removed-working-proof/` に残して検証用作業ディスクから消した。

```text
data/phase10a/working/columns/NQ/1s/2026-10-27/20.bin
SHA-256 78fa13489bfed98d60faedd998364aebd8ba5b26d2378c07b5117de53e060630
data/phase10a/working/trades/NQ/2026-10-27/20.jsonl.gz
SHA-256 83df6327b12e518c9c2ee049bcfa3c2380eab0eba4e72966d0b4564ab9dd5bb8
```

再起動PID4735でクラウドから26ファイルを再取得した。失った書きかけを取得済みと誤認せず、履歴API22要求で板1,977,600行・約定7,428行を取得した。直近3時間の180窓を完了し、既存範囲は338要求を省略、不足区間だけを取得した。履歴・VPとも欠け・通信失敗0。VPは79,823秒分をファイルから40.482秒で取り込み、API追加は0、532,912約定を数えた。直近窓の5分待ちも含む再起動からの準備時間は約352秒。

再取得後の本番HTMLで実リプレイの初期配信1,799列・11,716約定とバブル等を確認した。`production-replay.png` 撮影時にはVPはまだloading表示であり、その画像をVP完了の証拠とはしない。ライブ測定開始前にはVPの `state:complete`／`loading:false` を確認した。古い48時間超の一時ディスク経路はダミー単体試験で確認したもので、実クラウドに48時間超の試験オブジェクトは作っていない。

### 6.2 RSS・CPU

| 場面 | JST | 時間 | 最大観測RSS（B／MiB） | その時点までのプロセス最大RSS（B） | CPU最大10秒平均（コア） | CPU平均 |
|---|---|---:|---:|---:|---:|---:|
| 初回・3時間の板＋セッションVP | 04:58:29.419〜05:08:58.929 | 629.510秒 | 550,768,640／525.25 | 560,336,896 | 0.822 | 0.189（5秒ログの10秒平均値の平均） |
| キャッシュ・書きかけ消失後の再起動 | 05:10:20.537〜05:16:12.500 | 351.963秒 | 491,995,136／469.20 | 491,995,136 | 0.256 | 0.0396（/proc） |
| 1画面・30分ライブ | 05:16:40.350〜05:46:40.367 | 1,800.017秒 | 596,541,440／568.91 | 598,552,576 | 0.290 | 0.0178（/proc） |
| 3ブラウザ・各60分要求 | 05:46:41.367〜05:46:52.755 | 11.388秒 | 628,051,968／598.96 | 628,051,968 | 0.894 | 1.002（/proc） |

RSSは5秒ログ・API記録と、利用できる区間の100ms `/proc` 観測の最大。任意の瞬間のピークを100ms観測だけで保証しないため、OSの起動以来最大RSSも別欄に示した。初回の100msプローブは起動全体をカバーしておらず、初回行は5秒ログ・API・OS最大RSSによる。CPU最大は同区間のログとAPIで観測した10秒平均の最大で、瞬間CPUの最大ではない。`/proc` は `CLK_TCK=100` としてユーザー＋システムCPU時間の差／経過時間を使用した。30分の `/proc` 実カバーは1,799.939秒、3台は11.331秒。

3台終了後の最終APIでは10秒平均0.957コア、SIGTERM時の最終ログでは1.015コアも記録した。表の要求終了時までの0.894だけを全工程のCPU最大とはしない。

判定：

- **定常RSS 512MBの目安は未達。** 30分のAPI観測では最小556,486,656B、終了572,669,952B（約546.14MiB）。最初だけの超過ではない。512MBを512MiBとして解釈しても超過する。
- 最大RSSは観測範囲では628,051,968Bで、768MBの目安未満。ただしRVM全体・SDK認証基盤・ランチャー等を合計した実機メモリの保証ではない。
- 30分の実CPU平均0.0178コアは0.15コア以内。一方、開始直後05:16:45の10秒平均は0.290で、全ての10秒窓が0.15以下だったわけではない。3台の範囲要求では約1コアの負荷になった。
- 0.25 vCPU／1GiBに制限した実機ではない。Workspaceのバースト性能をそのまま公開先の処理時間・余裕とはしない。米国寄り付きではなく米中部時間15:16〜15:46頃の測定であり、寄り付き最大負荷の保証でもない。

原因の候補と提案（**今回は最適化を実装していない**）：

1. 初期の履歴処理・範囲応答・gzip／バイナリ処理後のV8／ネイティブ領域の保持が候補。再起動準備時の約469MiBから画面初期読込後に約569MiBへ増え、ライブ中は終了約546MiBへ下がった。30分で単調増加する漏れは観測していないが、漏れがない証明ではない。
2. 3台同時の読込・列の符号化・圧縮の重複処理がCPU増加の候補。今回の採取プロファイルは粗いサンプリングで、特定関数にRSS超過全量を割り当てる根拠は不足する。
3. 別依頼で、範囲応答の生存バッファと圧縮の割当を計測し、共有可能な処理を検討する。推測で形式・圧縮設定・保持期間を変えない。公開前には実0.25 vCPU／1GiBでのCPU制限・総メモリ・停止猶予も確認する。

### 6.3 30分の独立照合

30分ライブ中は実アプリの `TradeAggregator` が受け取った直近約定を5秒ごとに集めた。板／約定のWebSocketを実際に受信し、接続数1を継続確認した。可視バブルの数を約定件数の代わりにしていない。

| 対象 | 約定件数 | 枚数 |
|---|---:|---:|
| 上流の受信・正規化カウンタの増分 | 3,823（生受信・採用とも） | ― |
| ブラウザのTradeAggregator | 3,823 | 4,382 |
| 保存JSONLを独立再走査 | 3,823 | 4,382（買2,061／売2,321） |
| セッションVPの増分 | ― | 4,382 |

締切は開始側 `(recvUs, seq)=(1793132198694000,9445)` を含まず、終了側 `(1793134000143000,13268)` を含む。HTTPスナップショットの取得間隔は1,800.017秒で、開始側の直前約定まで戻した受信境界間は1,801.449秒。取引所時刻では切らず、開始／終了スナップショットで採用済みだった同じ約定集合を比較した。

`result.json` にある最初の保存走査は、起動済み検証器の旧実装がseqだけで切り、再起動前の同番号の行も数えて `savedCount:7646 / savedVolume:8617 / false` とした。この原始記録は改変していない。独立解析 `phase10a-analyze.ts` は受信時刻＋同時刻内の順序で窓を切り、別プロセスの行を除外して上表の一致を確認した。正しい照合は `analysis.json.comparison` の `countsMatch:true / volumesMatch:true`。データを消したりVPを調整して一致させたものではない。

再起動後の測定終了直前は再接続・切断・warning・feed・error・ticks_lagged・検査不正・拒否・WS送信エラー・低速切断・板ドロップが全て0。`liveGaps` は25区間／計27秒を記録した（1秒単位で採用された板がなかった区間）。欠けを埋めて隠していない。30分区間だけでなく再起動以降全体の状態である。

### 6.4 3台、設定、制限解除、終了

3つの別Chromiumプロセスが実WebSocketに接続し、各初期配信後、同時に `[1793129802,1793133402)` の60分を要求した。各台とも **3,587列・45,573約定・12バイナリフレーム**、`rangeDone` の件数／チャンク数と一致、エラー0、接続数3を確認した。列が3,600でないことを補完していない。この試験は3つの実ブラウザからの配信プロトコル負荷試験であり、Canvas付きの3画面を同時操作した試験ではない。

実画面の設定ダイアログでbubbleScaleを2に保存し、APIの読込でも2を確認した。その後8項目を初期値に戻した。最終的にクラウドの `dev/settings.json` を直接再ダウンロードし、8項目全てが初期値と一致することを確認した（`cloud-settings-final.json`／`final-proof.json`）。通常のローカル設定ファイルは変更していない。

測定終了後に `data/perf-memory/isolation.json` を除去し、APIの `measurementIsolation.enabled:false / allowedOrigin:null` を確認した。許可対象ではなかった別OriginのWebSocketで実際に `hello` を受け、close1000で閉じた。その後 `/api/ws` 接続数0。単に設定ファイルを消しただけの解除判定ではない。

検証Chromium：

```text
PID5346  exited:true  portClosed:true
PID5760  exited:true  portClosed:true
PID5881  exited:true  portClosed:true
```

スクリーンショットツールが起動した別のChromiumは測定前に終了させ、親4781と子4788/4789/4823/4824/4895/4925が残っていないことを確認した（`screenshot-browser-closure.json`）。画像を撮れたことだけをブラウザ本体終了の証拠とはしない。

測定用サーバーの実終了ログ：

| PID | SIGTERM後の実上流close（JST） | 結果 |
|---|---|---|
| 3940 | 05:10:11.952 | close1006、wasClean:false、reason:shutdown、socketClosed:true。05:10:11.972 server_stopped／httpClosed:true、PID消滅 |
| 4735 | 05:46:53.996 | close1006、wasClean:false、reason:shutdown、socketClosed:true。05:46:54.016 server_stopped／httpClosed:true、PID消滅 |

close1000を要求したが、**実際の上流closeは1006**。停止時に各1件の `upstream_network_error`（state:closing）があった。運転中の予期せぬ切断・再接続とは区別した。正常close1000だったとは報告しない。

#### 追加CPUスモークの失敗と未確認事項

最後に、タイマー間のCPU診断を含めた最終ソースで短い本番起動確認を行った（PID6404、ブラウザなし、測定サーバー停止後に順次起動）。CPU診断は `unit:cores`、10秒／60秒とも有限値を取得し、設定は初期値、制限は解除済みだった。しかし、SIGTERM後の停止待ちが検証器の120秒制限を超え、`smoke_shutdown_timeout` で失敗した。これを成功扱いしていない。

05:48:09.291 JSTにSIGTERM要求、05:48:09.488に実close1006／socketClosed:true。上流は閉じたが、保存済みキャッシュを残した再起動では確認用fingerprintが起動時に空のため、完了時間ファイルの再アップロードが続いた。`server-cpu-smoke.log` は05:50:04までアップロード／停止中の記録を持つ一方、`server_stopped` はない。最終確認ではPID6404も消滅しHTTPポートも閉じていたが、この追加スモークの**全保存完了を伴う正常終了は確認できなかった**。終了経路・再アップロードの効率・本番の停止猶予との関係は未解決として残す。最適化や停止方式の変更はしていない。

30分の正式測定と3台負荷測定はこの追加起動前に完了している。CPU診断の最終調整はタイマー直後からの未採取CPU時間も表示に含めるもので、正式測定のCPU総量の独立 `/proc` 集計には影響しない。証拠は `cpu-smoke-stdout.log`、`cpu-smoke-observed.json`。保存走査の受信境界も追加起動より前なので、追加受信は照合に混ぜていない。

最終確認05:52:25.055 JST（`final-proof.json`）：上記の全対象PIDは不存在、Chromium検索結果もなし。8080・19090・9222・9223・9224は接続拒否、制限マーカーなし。通常開発用Vite／mockupの既存ワークフローは変更せず、受信サーバーは停止状態。

### 6.5 残したdevオブジェクト

最終実リストは次の28件。**クラウドから削除していない。** 破損設定はダミー試験だけであり、実クラウドに破損設定／退避オブジェクトは作っていない。

```text
dev/columns/NQ/1s/2026-10-27/16.bin.gz
dev/columns/NQ/1s/2026-10-27/17.bin.gz
dev/columns/NQ/1s/2026-10-27/18.bin.gz
dev/columns/NQ/1s/2026-10-27/19.bin.gz
dev/coverage.json
dev/settings.json
dev/trades/NQ/2026-10-26/22.jsonl.gz
dev/trades/NQ/2026-10-26/23.jsonl.gz
dev/trades/NQ/2026-10-27/00.jsonl.gz
dev/trades/NQ/2026-10-27/01.jsonl.gz
dev/trades/NQ/2026-10-27/02.jsonl.gz
dev/trades/NQ/2026-10-27/03.jsonl.gz
dev/trades/NQ/2026-10-27/04.jsonl.gz
dev/trades/NQ/2026-10-27/05.jsonl.gz
dev/trades/NQ/2026-10-27/06.jsonl.gz
dev/trades/NQ/2026-10-27/07.jsonl.gz
dev/trades/NQ/2026-10-27/08.jsonl.gz
dev/trades/NQ/2026-10-27/09.jsonl.gz
dev/trades/NQ/2026-10-27/10.jsonl.gz
dev/trades/NQ/2026-10-27/11.jsonl.gz
dev/trades/NQ/2026-10-27/12.jsonl.gz
dev/trades/NQ/2026-10-27/13.jsonl.gz
dev/trades/NQ/2026-10-27/14.jsonl.gz
dev/trades/NQ/2026-10-27/15.jsonl.gz
dev/trades/NQ/2026-10-27/16.jsonl.gz
dev/trades/NQ/2026-10-27/17.jsonl.gz
dev/trades/NQ/2026-10-27/18.jsonl.gz
dev/trades/NQ/2026-10-27/19.jsonl.gz
```

再現用コマンドの記録：

```text
node server/tools/perf/phase10a-check.ts
node server/tools/perf/phase10a-probe.ts 4521
node server/tools/perf/phase10a-analyze.ts
node server/tools/perf/phase10a-cpu-smoke.ts  # 停止待ち120秒タイムアウト
```

`result.json` が主測定の原始結果、`analysis.json` が受信境界を揃えた独立集計、`samples.jsonl`／`proc-samples.jsonl`／`server-{first,second}.log` が性能・接続ログ。今回の実装・確認はここで止め、Phase 10b／10cへ進まない。

## 7. 仕様にない値・明示承認された補足

1. アップロードの再試行待ちは60秒、120秒、240秒…、最大15分間隔。成功するまで継続する。成功確認は再ダウンロードしたSHA-256の一致。
2. キャッシュは最近48時間。それより古い要求は応答中だけ保持し、**ディスクの一時ファイル**へ置く。全体をメモリへ読み込まず、応答後に削除する。
3. 壊れたクラウド設定は同じ接頭辞の `settings.corrupt-<Unixマイクロ秒>.json` に先に退避する。退避失敗なら新設定で上書きしない。退避を自動削除しない。
4. 測定中だけ測定用以外のWebSocketを拒否してよい。3台同時の測定ブラウザも測定用に含める。測定後は必ず解除し、解除の実接続確認を報告する。

この4点はユーザーの承認・追加指定。正本の本文は事前の完全一致差し替え以外変更していない。

## 8. 停止時アップロードの修正（2026-10-28）

### 報告

- 実施内容：停止時だけの1回試行・全体10秒以内の終了を実装した。確認済みキャッシュを再起動で再送しないようにした。RSSは変更していない。
- 変更ファイル：`server/src/store/app.ts` の `initialize()`／`beginShutdown()`／`publish()`／`flush()`／`shutdownSummary()`、`server/src/store/objects.ts` の `uploadVerified()`、`server/src/index.ts` の `shutdown()`、`server/test/app-storage.test.ts`、検証専用 `server/tools/perf/phase10a-shutdown-check.ts`、本報告書、該当するAgentメモリ。依存・Run・デプロイ設定・正本は変更していない。
- 確認手順：下の本番コマンドで起動し、`/api/status` の `memory.pid` にSIGTERMを送る。ログの `app_storage_shutdown_plan`／`app_storage_shutdown_summary`／`upstream_close`／`server_stopped` を確認する。今回の実記録は `data/phase10a/shutdown-real-proof.json` と `shutdown-real-{1,2}.log`。
- 実行した確認：サーバー112/112試験・型検査成功。本番コマンドの2回の実停止は9,059.009ms／6,034.492msで、実上流close・プロセス消滅・HTTP閉鎖を確認した。
- 仕様との差分：通常運転中の再試行は従来どおり。停止時は今回の指示による例外として待ち時間を延ばす再試行をしない。保存・配信の形式は変えていない。
- 未解決・懸念：Replit公開先の強制終了までの猶予秒数は公式本文で確認できなかった。公開実機の停止試験はしていない。SDKに公開されたキャンセルAPIがないため、終了時には未決のSDK接続もプロセス終了で打ち切る。起動時の確認用ダウンロードが増える。
- 次の候補：公開後、1GiB実機で実際のRSSと停止動作を確認する。ここでは公開・RSS最適化・Phase 10bを行わない。

### 8.1 前回の停止で何が起きたか

対象は `server-cpu-smoke.log` のPID6404。05:48:09.291 JSTにSIGTERMを受け、05:48:09.488に上流が閉じていた。**App Storageの認証失敗・通信失敗・`app_storage_retry`／`app_storage_publication_error` は記録されていない。**

停止後、次の20オブジェクトは `app_storage_uploaded`／`sha256Verified:true` で順に成功していた。

```text
dev/columns/NQ/1s/2026-10-27/16.bin.gz
dev/columns/NQ/1s/2026-10-27/17.bin.gz
dev/columns/NQ/1s/2026-10-27/18.bin.gz
dev/columns/NQ/1s/2026-10-27/19.bin.gz
dev/trades/NQ/2026-10-27/00.jsonl.gz
dev/trades/NQ/2026-10-27/01.jsonl.gz
dev/trades/NQ/2026-10-27/02.jsonl.gz
dev/trades/NQ/2026-10-27/03.jsonl.gz
dev/trades/NQ/2026-10-27/04.jsonl.gz
dev/trades/NQ/2026-10-27/05.jsonl.gz
dev/trades/NQ/2026-10-27/06.jsonl.gz
dev/trades/NQ/2026-10-27/07.jsonl.gz
dev/trades/NQ/2026-10-27/08.jsonl.gz
dev/trades/NQ/2026-10-27/09.jsonl.gz
dev/trades/NQ/2026-10-27/10.jsonl.gz
dev/trades/NQ/2026-10-27/11.jsonl.gz
dev/trades/NQ/2026-10-27/12.jsonl.gz
dev/trades/NQ/2026-10-27/13.jsonl.gz
dev/trades/NQ/2026-10-27/14.jsonl.gz
dev/trades/NQ/2026-10-27/15.jsonl.gz
```

最後の成功は05:50:03.996 JSTの15時約定。旧26キャッシュのうち、残る次の6件にはその実行での完了ログがない。

```text
dev/trades/NQ/2026-10-26/22.jsonl.gz
dev/trades/NQ/2026-10-26/23.jsonl.gz
dev/trades/NQ/2026-10-27/16.jsonl.gz
dev/trades/NQ/2026-10-27/17.jsonl.gz
dev/trades/NQ/2026-10-27/18.jsonl.gz
dev/trades/NQ/2026-10-27/19.jsonl.gz
```

6件を「通信失敗」とは判定できない。未着手か進行中かも終了ログだけでは確定できない。SDK内部のHTTP再試行の有無まで、このアプリログからは分からない。

原因は `AppStore.confirmed` がメモリ内だけのMapで、既存キャッシュを残して再起動すると空になること。`publish()` は確認記録のないローカルgzipを未確認と扱い、既にクラウドにあった26件を再送対象にした。さらに旧 `flush()` は既存のpublisherを待ち、もう一度 `pump()` し、待ち時間に上限がなかった。20件の成功を順に待つうちに検証器の120秒を超えた。したがって、**記録された失敗は検証器の停止待ちタイムアウトで、特定ファイルの認証・通信失敗ではない**。認証方式・接続先・資格情報の変更はしていない。

### 8.2 修正した停止動作

1. 起動時、既存のローカルgzipとクラウドの同名オブジェクトをSHA-256で照合し、該当時間のcoverageも同じ場合だけ確認済みに戻す。名前・サイズ・mtimeだけでは確認済みとしない。クラウドの保存形式やcoverage形式に確認用の項目は追加していない。
2. SIGTERM受付時にUTC時間の境界を固定し、通常のpublisher新規起動を止める。上流を閉じてからローカル書込み・停止用アップロードを進める。時間境界を停止中に越えても、受付時の書きかけ時間は上げない。
3. 完了時間の未確認ファイルだけを各1回試す。既に進行中だったファイルもその1回として数える。失敗時に通常の60秒等のバックオフを設定せず、次へ進む。
4. 全体10秒を超えないため、受付から9秒でアップロード待ちを打ち切り、9.5秒で最終終了するガードを設けた。ファイルごとの10秒ではなく、上流close・ローカル保存・アップロード・HTTP終了を含む**プロセス全体**の予算である。
5. データアップロード・再DL照合が完了してからだけクラウドcoverageを書き、期限切れ後には新しいcoverage更新を開始しない。期限に達してSDKの要求が未決なら、未確認としてローカルに残す。サーバー終了時にプロセスを明示終了し、SDK内部の未決ソケットや待機を残さない。
6. `app_storage_shutdown_summary` に成功、残存、試行済み、進行中、受付時の時間境界を列挙する。期限超過ガードのログにも同じ一覧を出す。

SDKの要求をサーバー側で取り消せたことまで保証する方式ではない。期限切れ直前に送信済みだったデータがクラウドに存在する可能性はあるが、未確認なら取得済みとして扱わない。coverageへは確認済みデータの範囲だけを記録する。

### 8.3 同じ時間内に再起動した場合の前半

旧実装でも、停止時に書きかけ時間をアップロードする条件にはなっていなかった。05:48の旧停止でアップロードされていたのはUTC19時以前だけで、当時のUTC20時の後半だけを同名クラウドオブジェクトへ上書きしたログはない。

ローカルが残る再起動では、板は既存の同秒列を優先して新しい列を組み込み、約定は既存gzipへ追加する。前半のファイルを後半だけで置き換える処理ではない。ローカルが消えた再起動では、書きかけはクラウドcoverageにないため取得済みとはせず、起動時の取り込みで不足分を取り直す。履歴と後半を既存の合成・差込み処理でまとめ、時間が終わってからアップロードする。

追加試験では次を確認した。

- 前半を保存→停止→同じ時間に再起動→後半を追加→再停止しても、前半・後半の2列／2約定が残る。クラウドへのアップロードは0。
- 作業ディスクを別の空ディスクに替えた場合、前半は取得済みにならない。後半を受けたあと、履歴で前半を補うと、UTC境界後に上げたオブジェクトの読戻しでも前半・後半が両方残る。
- SIGTERM後にUTC境界が進んでも、受付時の書きかけは上げない。

### 8.4 公式資料での終了猶予の確認

公式検索をSIGTERM／SIGKILL／Reserved VM／graceful shutdown等で調べ、次の公式本文も取得した。

- https://docs.replit.com/features/publishing/deployment-types
- https://docs.replit.com/help/troubleshooting/deployments

**取得した公式本文には、Reserved VMのSIGTERMからSIGKILLまでの猶予秒数が記載されていなかった。** 検索の生成回答には「30秒」という回答も出たが、引用先の公式本文にその記述がなく、裏付けられなかったため確定値として採用していない。「公開先は30秒待つ」「少なくとも10秒待つ」とは報告できない。10秒より短い公式値も確認できなかったため、今回はユーザー指定の10秒以内を実装上の上限とした。実装は9.5秒のガード付き。公開環境での猶予は未確認事項として残す。Publishして実機測定することはしていない。

### 8.5 テストと本番起動での実測

```text
pnpm --filter @workspace/receiver test       112 / 112
pnpm --filter @workspace/receiver typecheck 成功
node server/tools/perf/phase10a-shutdown-check.ts 成功
```

今回追加した6試験は全て「ダミー」と明示。①アップロードが全件失敗しても各1回・再試行待ちなし、②無応答／遅延成功でも全体期限で戻りcoverageを追加しない、③既存キャッシュの再起動で再送しない／内容が異なれば確認済みにしない、④停止処理中のUTC境界、⑤通常publisherの途中で停止しても二重試行しない、⑥同じ時間内の再起動と空ディスクからの前半補完を確認した。

実測は既存の検証専用 `data/phase10a/working/` と実 `dev/` を使用し、実データを追加の本番コマンドで保存した。新しいダミーデータを実クラウドに混ぜていない。アプリの通常ローカル保存先は使用していない。

```text
PORT=8080 HEATMAP_STORAGE=app-storage HEATMAP_STORAGE_DIR=<検証専用作業先>
pnpm --filter @workspace/receiver run start
```

| 回 | PID | SIGTERM（JST） | 実上流close（JST） | server_stopped（JST） | SIGTERM→PID消滅 |
|---|---:|---|---|---|---:|
| 1 | 7406 | 06:21:21.513 | 06:21:21.799 | 06:21:30.545 | **9,059.009ms** |
| 2 | 7455 | 06:22:28.928 | 06:22:29.192 | 06:22:34.936 | **6,034.492ms** |

両回とも実close1006／`wasClean:false`／`reason:shutdown`、`upstream_stopped.socketClosed:true`、`server_stopped.httpClosed:true`。1000を要求したが実closeは1006であり、1000だったとはしない。PID消滅と8080ポートの閉鎖も確認。強制クリーンアップは使用していない。

| 回 | 確認して上がったファイル | 上がり切らずローカルへ残したファイル | クラウドcoverage |
|---|---|---|---|
| 1 | `dev/columns/NQ/1s/2026-10-27/20.bin.gz` | `dev/trades/NQ/2026-10-27/20.jsonl.gz`（deadline、作業先の同じ相対パスに残存） | UTC20時の板だけ追加。約定はUTC20時を含まない |
| 2 | `dev/trades/NQ/2026-10-27/20.jsonl.gz` | 未確認アップロードの残りなし | UTC20時の約定も確認後に追加 |

1回目は9秒の待ち打切りが働き `uploadDeadlineReached:true`、2回目はfalse。1回目は26件、2回目は27件のキャッシュをクラウド比較で確認し、それらの不要な再アップロードは0。アプリ層のバックオフ再試行は両回とも0。1回目の約定の期限切れは、今回指定した全体期限の動作であり、認証・通信障害を示すエラーは記録されていない。1回目終了後のクラウドcoverageは独立してダウンロードし、UTC20時の約定が入っていないことを確認した。

データ本体は成功分もキャッシュとして残すため、**第6.1節の26ファイル＋今回のUTC20時の板・約定の2ファイル、計28ファイルをローカルに保持している**。各実行直後の全28パスは `shutdown-real-proof.json` の各 `afterFiles` に一覧で保存した。元データを削除していない。実クラウドも28→30オブジェクトとなり、削除はしていない。

`.upload/` のスナップショットも最終時点で次の3ファイルが残っていた。これらは元の板／約定の代わりにするファイルではなく、旧検証や期限終了時に残る作業用コピー。今回の範囲では削除していない。全パスの接頭辞は `data/phase10a/working/`。

```text
.upload/0d648f7c-bcca-4a7b-a405-5c56c37fa5b9        402846 bytes
.upload/0d648f7c-bcca-4a7b-a405-5c56c37fa5b9.index      67 bytes
.upload/3f6ee8e2-3452-4a67-ab16-a52331cd51dc        118204 bytes
```

実起動した時間は米中部時間16時台の休止中で、新たなライブ板・約定は両回とも0件。実測で確認したのは上流の接続／close、保存待ちの実ファイルの処理とプロセス終了であり、新しいライブ約定の受信試験ではない。書きかけ時間に実データを受け続けながらの再起動は、今回は実市場では試せず、上記単体試験で確認した。今回ブラウザは起動していない。コンテナ内に検証Chromium・受信Nodeプロセスは残っておらず、制限マーカーもない。

証拠：

```text
data/phase10a/shutdown-tests.log
data/phase10a/shutdown-types.log
data/phase10a/shutdown-real-proof.json
data/phase10a/shutdown-real-{1,2}.log
data/phase10a/shutdown-cloud-index-{1,2}.json
data/phase10a/shutdown-local-temporary-files.json
```

RSS・画面・依存・公開設定の最適化は行っていない。公開後の1GiB実機の値を見て判断するユーザー方針を維持し、ここで停止する。
