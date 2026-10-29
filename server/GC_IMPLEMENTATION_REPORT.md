# GC追加 実装・隔離検証報告

2026-10-30（日本時間）

## 1. 実施内容

現在のソースを基準に、標準COMEX金先物 **GC** をNQに追加した。MGC・XAU/USDへの置換、以前の変更の再適用、復旧タスクの再実行は行っていない。

- 共通ヘッダーにNQ／GC選択を追加。初期値NQ、sessionStorageによるタブ内保存。画面移動・再読み込みでも維持する。共通のサーバー設定は変更しない。
- 切替時は接続・カーソルを終了して文書全体を再読み込みする。前銘柄の要求・キャッシュ・遅延したBlob解析結果を、新銘柄の状態に取り込まない。
- 起動時の上流WebSocketは従来と同じ**1本**。ticksのsymbolsとbookのsubscribeに両銘柄を指定する。ブラウザの表示選択は購読を変更しない。
- Receiver・Pipeline・Hub・保存・coverage・履歴鮮度・VP・デルタ・長期集計を銘柄別にする。履歴RESTと限月メタデータ要求は、応答本文の読み取り完了まで保持する共通FIFOで調整する。ライブ処理は履歴取得の完了をawaitしない。
- NQの価格刻み0.25／小数2桁、GCの0.10／小数1桁を共通定義にした。GCの軸・板・VP・ズーム・十字カーソルにNQの価格換算を使用しない。
- GCの初回長期取得はAPIで取得可能な直近7暦日まで。週末を除く7取引日にはしない。最初の取引日の未取得部分はgapsとして残し、NQの取得記録は流用しない。
- 履歴の限月はレコード自身の情報を優先する。不明な生約定を残し、長期集計ではUNKNOWNと分類する。UNKNOWNは欠損gapsとは別。現在限月の過去への割当、メタデータ取得時刻からの開始時刻生成、不明な限月差の0埋めはしない。
- GCの調整先には確認済みの現在限月を使う。読み込めた過去ファイルの最新限月を期近の代わりにしない。現在限月は `/api/longvp/rolls?symbol=GC` の `X-LongVP-Front-Contract` ヘッダーで渡す。限月開始時刻を表すヘッダーではない。価格差不明の価格・VP・VWAPは除外し「調整不能」を表示する。価格調整不要な週CVDは受信分から計算する。
- 保存・終了・設定復旧は既存の処理を再利用。新しいチェックポイントや復旧スケジューラーは追加していない。

### 保存互換性

NQの既存パス・JSONL／列ファイル形式を維持した。GCは独立した保存先を使う。

| 対象 | GC |
| --- | --- |
| ローカル保存 | `data/instruments/GC/` 以下の `columns/GC/1s/`、`trades/GC/`、coverage |
| App Storageの作業領域 | 既存作業ルートの `instruments/GC/` 以下 |
| App Storageのオブジェクト | 既存環境prefixの `instruments/GC/columns/GC/1s/`、`instruments/GC/trades/GC/`、GC用coverage |
| 長期VP | 既存環境prefixの `longvp/GC/` |

GCの生約定は確認できたcontractを保持できる。不明なcontractを現在限月で補完しない。日次集計のcontract区間は受信レコードの帰属であり、真の限月切替時刻を推定したものではない。後日の再集計に必要な生データを残す。既存データの一括移行・削除は行っていない。

## 2. 変更ファイル

| ファイル | 主な変更箇所 |
| --- | --- |
| `lib/market/instruments.ts`、`package.json` | `INSTRUMENTS`、`marketSymbol`、`validContract`、`instrumentPrice`、UNKNOWN。外部依存なしの共通定義 |
| `server/src/ingest/{normalize,receiver,markets}.ts`、`types.ts` | GC価格の整数化、`Receiver`の銘柄分離、`MarketReceiver`の入力振分け、任意のcontract |
| `server/src/upstream/connection.ts` | `Upstream`の複数symbols指定。接続インスタンスは増やさない |
| `server/src/history/{client,decode,backfill,gate}.ts`、`vp/trade-history.ts` | symbol付きREST、GC履歴復号、共有FIFO、履歴行の限月保持 |
| `server/src/store/{local,app}.ts` | `LocalStore`／`AppStore`のGC専用root・prefix、NQ互換 |
| `server/src/{pipeline,gc-runtime,index}.ts` | GC用パイプライン生成、共通要求調整、1上流接続、両銘柄の既存終了処理 |
| `server/src/hub/hub.ts` | `Hub`、`attachHub`のsymbolルーティング、helloの刻み、全銘柄合計の既存接続上限維持 |
| `server/src/status/app.ts` | 銘柄別のREST応答、接続一覧のsymbol、`delivery.bySymbol` |
| `server/src/long-vp/{rest,objects,day,app-service,routes}.ts` | GCメタデータ・保存検査・UNKNOWN区分・7日初回取得・`frontContract`・要求ごとのサービス選択 |
| `artifacts/heatmap/src/instrument.ts`、`main.ts`、`index.css`、`long-vp/nav.ts` | 共通選択UI、タブ内保存、文書再読み込みによる切替と終了処理 |
| `artifacts/heatmap/src/data/socket.ts` | symbol付きWS URL、hello検査、旧接続の遅延結果破棄 |
| `artifacts/heatmap/src/chart/format.ts`、`long-vp/{app,crosshair,model,settings-modal,store}.ts` | 銘柄別価格、GCの限月検査・調整不能表示、現在限月確認、既存共通設定の維持 |
| `server/test/gc.test.ts`、`artifacts/heatmap/test/gc.test.ts` | 分離・価格刻み・旧形式・不明限月・履歴・WS・7日初回取得の試験 |
| `server/test/startup-process.test.ts` | 隔離した起動試験fixtureへ共通定義ディレクトリも複製 |
| `server/tools/gc-load.ts`、`artifacts/heatmap/tools/gc-check.ts` | ローカル短時間負荷比較、実Chromium隔離表示検査 |
| `pnpm-lock.yaml` | 共通定義用workspaceの登録。外部パッケージ追加なし |
| `replit.md`、`docs/{SPEC,UI_SPEC_HEATMAP,LONGVP_SPEC}.md` | 許可された銘柄・刻み・切替・GC限月不明と初回取得の関係箇所。Current Status更新 |
| `.agents/memory/performance-measurement-isolation.md` | 複数検証タブでは前面化と描画完了も確認する注意点 |

Run・デプロイ・認証・契約・課金の構成は変更していない。`docs/AGENT_RULES.md`は未変更。`GC_RECOVERY_SPEC.md`は存在しなかった。

## 3. 確認手順

```sh
pnpm --filter @workspace/receiver typecheck
node --test --test-concurrency=1 server/test/*.test.ts
node --test --test-concurrency=1 server/test/gc.test.ts server/test/long-vp-app.test.ts
pnpm --filter @workspace/heatmap typecheck
pnpm --filter @workspace/heatmap test
pnpm --filter @workspace/heatmap build
node server/tools/gc-load.ts
node server/tools/gc-load.ts --both
node artifacts/heatmap/tools/gc-check.ts
```

負荷比較は各モード2回。実ブラウザは固定NQ再生データとGCのダミーデータを使い、ブラウザ内のREST／WSを差し替える。実上流・本番DB・App Storageへ接続しない。WS振分け試験のサーバーもloopback限定。

## 4. 実行した確認

### 公式情報・読み取り専用REST

根拠：

- TICK STREAM [symbols](https://tick-stream.xyz/docs/symbols)、[streaming](https://tick-stream.xyz/docs/streaming)、[level2](https://tick-stream.xyz/docs/level2)、[limits](https://tick-stream.xyz/docs/limits)、[REST](https://tick-stream.xyz/docs/rest)、[historical](https://tick-stream.xyz/docs/historical)。
- CME [GC fact card](https://www.cmegroup.com/content/dam/cmegroup/market-regulation/files/gold-futures-and-options-fact-card.pdf)：標準GCは100トロイオンス、最小変動0.10ドル／オンス。
- CME [NQ contract specifications](https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html)：最小変動0.25指数ポイント。

| 確認対象 | 結果 |
| --- | --- |
| 提供銘柄・期近 | `/symbols` 200。NQ＝CME、NQZ6。GC＝Gold／COMEX、GCZ6。両方subscribed・streaming=true |
| GCの開始時刻 | `contractSince:null`。現在のGCZ6という識別と、その適用開始時刻は別。開始時刻は未確認のまま |
| GC quote | 200。price=4028.3、bid=4028.1、ask=4028.4。ts=1793291137（秒） |
| GC約定履歴 | 30秒窓で66行、truncated=false、history_clamped=false。例：ts=1793290506014804、price=4027.4、size=1。履歴tsはマイクロ秒。今回の行に限月情報なし |
| GC板履歴 | 1秒窓・limit=5000で5000行、truncated=true、history_clamped=false、flag=0。最初の完全な3スナップショットはいずれも買400段＋売400段。末尾の不完全な切片を完全な板とは扱わない |
| 複数購読 | 公式はticks URLの `symbols=NQ,GC` と `{"op":"subscribe","channel":"book","symbols":["NQ","GC"]}` をサポート |
| 条件 | 公式のRealtime＋L2は複数銘柄、最大3接続。ライブ板はfull snapshot。tickのRESTは直近7日・上限100000行。履歴はプランと実在範囲による。L2の履歴期間は最大5年、bookは上限500000行。truncatedは分割して扱う |

認証付きの実RESTは読み取りのみ。上記は取得時点の値であり、ライブGCのL2購読成功を実証したものではない。秘密値は記録していない。短い応答証拠は `data/gc-implementation/provider.json`。

### 試験・型検査・ビルド

| 確認 | 結果 |
| --- | --- |
| サーバー全体（直列） | 176／176合格 |
| 最終の現在限月ヘッダー対応後、GC＋長期VPの関連試験 | 21／21合格 |
| フロントエンド最終試験 | 153／153合格 |
| 両側TypeScript型検査 | 合格 |
| Vite本番ビルド | 合格 |
| GC刻み | 1000.0〜6999.9の60000個の0.1刻みを検査。不正な刻みは拒否。NQの既存規則も維持 |
| 混在入力 | NQ／GCの板・約定・巻き戻り状態を分離。GCの履歴行の限月を保持。不明開始時刻を生成しない |
| 旧データ | NQの既存保存先・旧JSONL形・読取互換を確認。GCは別root |
| GC初回長期取得 | 7暦日上限、最初の部分日の未取得範囲、不明限月でも集計処理が進むことを確認 |

初回の並列全体実行では5件失敗した。3件は起動試験fixtureに新しい共通定義がなかったためで、fixtureを修正した。残り2件は既存アップロード期限試験の並列負荷依存で、直列では合格した。この別件の期限処理自体は変更していない。全体ログ・最終関連試験・フロント試験ログは `data/gc-implementation/` に保存。

### 実Chromiumの隔離表示

- 初回NQ、NQ価格カーソル29319.00を確認。
- GC heatmapに切替え、板・バブル・VP・デルタを描画。価格カーソル4024.9（1桁）を確認。
- 再読み込み後もGC。別タブはNQのままで、片方の変更が他方へ伝播しない。
- 実際の画面リンクでGCのLONG VPへ移動。既知分の価格・VP・週VWAP・週CVDと、限月不明分の調整不能表示を確認。カーソル4029.4。
- 過去の既知限月GCJ6しかない状態で、現在限月GCZ6との価格差を与えない試験も実施。過去限月を調整先へすり替えず、価格を描かずにCVDを維持した。
- 全日を限月不明にした場合も、生データを欠損扱いせず、価格は調整不能、CVDは表示した。
- 幅420 CSS pxでヘッダーの幅376／内容幅376。横方向のはみ出しなし。実iPhone／Safariの試験ではない。
- GCの古いREST応答を650ms遅延させてNQへ切替え。切替後の要求はNQのみで、GCの価格・キャッシュ・カーソルは混入しなかった。
- 実WS生成0、外部プロバイダー要求0、ブラウザ実行エラー0。`browser.json` のpass=true。

画面証拠：

- `data/gc-implementation/nq-heatmap.png`
- `data/gc-implementation/gc-heatmap.png`
- `data/gc-implementation/gc-long-vp.png`
- `data/gc-implementation/gc-mobile.png`
- `data/gc-implementation/gc-unknown-contract.png`
- `data/gc-implementation/evidence.html`（保存画像の一覧、外部通信なし）
- `data/gc-implementation/evidence-gallery.jpg`（一覧を目視確認した画像）

GC画像はダミーデータであり、実GC相場の受信・実蓄積の証拠ではない。

### 短時間負荷比較

同じNode実行環境、各銘柄につき板7回／秒・約定100件／秒・片側400段を3秒投入。各モード2回、新しいプロセスと一時保存先で順に測定。

| モード | 1回あたり投入板／約定 | CPU平均（1コア=100%） | 終了時RSS平均 |
| --- | --- | --- | --- |
| NQのみ | 21／300 | 16.18% | 117.39 MiB |
| NQ＋GC | 42／600 | 20.12% | 120.55 MiB |

両銘柄でもNQ側の投入率は同じ。GC分だけ総投入量を増やした比較。実RESTは空応答に差し替え、ローカル保存のみ。長期7日蓄積・実App Storage・配信ブラウザを含む本番負荷の測定ではない。長時間のRSS、最大履歴応答時のライブ遅延、本番VMの必要メモリはこの値から保証できない。生値は `load.jsonl`。

### 終了・禁止事項

- 最終の検証Chromium PID18253：exited=true、確認用ポート閉鎖=true、2タブとも終了。各回の検証ブラウザもfinallyで終了した。
- 証拠一覧撮影用のChromium PID17543／17550もSIGTERMで終了し、両PID消滅、同じ一時profileの子プロセス残存なしを確認。`screenshot-browser-close.json`。
- 最終プロセス確認では検証用Chrome／Chromium・gc-check・gc-loadは残っていない。loopback試験サーバー・WSも終了した。
- 既存サーバーPID9171は作業前後で維持。SIGTERM・再起動を行っていない。
- 開発から実上流WSを追加していない。本番への書込・再Publish・デプロイ設定変更・契約変更・課金変更・既存保存データの一括移行／削除は行っていない。
- 検証ファイルは既に除外されている `data/` 配下。Git／公開対象の除外設定は変更していない。

## 5. 仕様との差分

ユーザーが許可した銘柄・刻み・切替の関係箇所と、追加回答のGC限月不明・直近7暦日・部分データの扱いを正本へ反映した。他の仕様の全文差替えや固定SHAによる旧版復元は行っていない。共通設定の項目・versionは維持した。

変更後のSHA-256：

```text
c1e5e3c0c79214838ebefa723de24b16a4c8be194d22eb7c2241bf713bdb1fe0  replit.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
fd255ccff12e32e41562f7d30479b386ccc306a4f87e4235c17bd35b4f3bd3c7  docs/SPEC.md
286f5640100d1433f06b32d493211c1c6ca3a43b40374b84bb51950eb7bb2383  docs/UI_SPEC_HEATMAP.md
60dc0d10f586f65d36c7eff060833642e417c1752f64f8af3a8e06a8ba690c19  docs/LONGVP_SPEC.md
```

## 6. 未解決・懸念

1. **実上流1本でのNQ＋GC同時ライブ受信は未検証。** 公式の購読方法と実RESTを確認し、コード・隔離試験は完了したが、ユーザーの禁止事項に従い本番再起動・再Publishをしていない。稼働中の旧サーバーへソース変更はまだ適用されていない。
2. GCのcontractSinceはnullで、今回取得した履歴行に限月がない。したがって、初回履歴の価格・VP・週VWAPが「限月不明／調整不能」になることは残る。これはデータを生成して埋めないための動作。生データ・受信分CVDは保持する。確認済み現在限月があっても、それだけで過去の帰属・価格差は確定しない。
3. 実7日分のGC取得・本番保存・再起動復元・本番長時間負荷・実Safariは未確認。本番の追加作業は行っていない。
4. 既存のアップロード期限試験の並列負荷依存は別件として残る。

## 7. 次の候補

- ユーザーが対応版を公開した後に、1本の上流で両銘柄が継続受信され、非表示側も保存されることを、許可された読み取り確認で検証する。
- GCの過去限月・切替時刻・限月差を確認できる提供情報を調べ、UNKNOWNを安全に再集計できる条件を整理する。

今回はここで停止する。上記候補の作業は実行していない。
