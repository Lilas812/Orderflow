# 約定の1時間単位読取共有：実装・隔離検証

実施日：2026-10-30（日本時間）

## 1. 実施内容

`readTradeRange`から読む、**48時間より古い・時間全体がcloud coverageに記録済み・書込保留中でない約定時間**に、読取セッション内の共有スナップショットを追加した。

同じ時間の4つの15分区間では、冷たいgzip本文の取得とgzip走査・展開を各4回から1回へ減らした。確認済みローカルキャッシュがあれば本文の追加取得は0回、展開は1回。件数・枚数・全フィールド・行順の結果一致を確認した。

**本番への書込・再起動・再Publishはしていない。公開の高CPUや既存の欠けの解決とは扱わない。** 稼働中ワークフローを変更・再起動しておらず、今回のコードを既存プロセスへ読み直させてもいない。

板側、毎秒の一覧走査、gzip統合、永続保存形式、保持期間、期限削除、依存、設定、仕様書は変更していない。

## 2. 変更ファイル・関数

| ファイル | 変更内容 |
| --- | --- |
| `server/src/store/trade-read.ts` | `TradeReadPool`を追加。参照カウント、共有準備Promise、ストリームによる一度の展開、ディスク区間分割、元行番号によるmerge、解放を担当 |
| `server/src/store/app.ts` | `AppStore.tradeReadSession`：対象時間の判定と共有元の提供。非対象は既存読取へ戻す。`tradeReadStats`／`tradeReadsSettled`は隔離検証用の観測・待機手段で、HTTP/WSの形式は変更しない |
| `server/src/store/local.ts` | `tradeReadSession`の既定経路、既存の時間別走査を`visitTradeHour`へ切り出し。通常`visitTrades`のファイル順・フィルタ条件は維持 |
| `server/src/store/records.ts` | `tradeFileEntries`に任意の圧縮入力観測を追加。新経路だけ同じ読取でSHA-256と圧縮B数を記録。板の読取処理は変更しない |
| `server/src/vp/trade-history.ts` | `readTradeRange`がセッションを作り、既存の15分窓・coverage再確認・共通ロック・REST補完を維持して`reader.visit`を呼ぶ。終了は`finally`で`close` |
| `server/test/trade-read.test.ts` | 10件の隔離試験を追加 |
| `server/test/trade-read-benchmark.ts` | 既存ローカルgzipを使った変更前後・冷／確認済みキャッシュの比較。模擬Objectsだけを使用 |
| `server/TRADE_READ_OPTIMIZATION_REPORT.md` | 本報告 |
| `.agents/memory/app-storage-decisions.md` | 起動・照合と読取本文の計測を分ける方針を記録 |

### 処理の詳細

1. NQ／GCは別AppStore・別pool。キーに銘柄・時間を含むobjectパス・確認済み指紋を含める。
2. 1つの時間を取得／確認済みキャッシュからコピーし、ユニークな読取専用一時ディレクトリへ固定する。
3. gzipをストリームで最後まで1回読み、圧縮SHA-256を同じ走査で算出。15分別のディスクJSONLへ、元の行番号と元の行を一時的に書く。
4. 対象区間を読む際、必要な区間ファイルだけを読む。区間をまたぐ巻き戻りは元行番号でmergeし、ファイル内の順序を復元する。seqや内容で重複排除しない。
5. 時間ファイル名の範囲外にある既存行もspill区間に保持し、旧経路と同じ半開区間フィルタを適用する。境界をまたぐ要求で勝手に捨てない。
6. バッファは区間ごと64 KiBを目安にflush、最大5区間。文字列のsubstring／ropeが大きな入力chunkを保持しないようBufferへコピーする。これに1行・stream・V8等のメモリが加わり、RSS上限が320 KiBになる意味ではない。
7. 次の時間へ進むと古いleaseを解放する。全7日分の展開済みファイルや約定配列をRAMへ貯めない。永続ファイルは変更せず、一時ファイルは読取後に除去する。

完全なcloud coverageは「取得・保存の記録」であり、市場の全約定が存在する保証ではない。欠けを生成して埋める処理は追加していない。

### ファイルの版・鮮度

各時間のleaseは、**取得した不変スナップショットの版を最後まで使う**。gzip SHA-256はその実体の識別値。元ファイルの内容や時刻でsort／dedupしない。並行scopeは同じ共有中スナップショットを参照し、先行scopeのcloseだけでは消さない。

全lease解放後には共有実体を残さない。次のcold読取は新たに取得する。ローカルファイルが未確認・変更済みなら共有対象から除外し、既存経路へ戻す。

GCS generationの照会・条件付きGETは追加していない。共有中に外部の別writerが同名objectを上書きしたとき、新しいscopeが即座にその最新版を検知する保証はない。共有中は先行の固定版を読む。**SHAがあることと、外部の最新版generationを照合したことは別。** 今回は既存の1プロセス保存構成・要求中の版固定を維持し、恒久キャッシュにはしていない。

### 初期化・整合性・解放

- `AppStore.initialize`のcoverage取得、ローカル復旧走査、クラウド再DLによるSHA照合は変更なし。
- `Objects.download`／SDKの取得経路と、`uploadVerified`の再DL照合も変更なし。
- gzipは最後まで読み、破損・JSONエラーがあれば共有準備を成功にしない。エラーを空の約定として返さない。
- 正常・callback例外・読取abortは`finally`で参照を解放。最後の参照だけがそのsnapshot専用ディレクトリを削除する。
- **SDKの既存downloadにはAbortSignalがない。** DL待機中の中断は待機者の参照を速やかに解放するが、SDK通信自体の停止とはしていない。最後の参照がなくなった場合も、書込中の一時ファイルを競合削除せず、DLの成功／失敗が確定してから除去する。他の待機者がいればそのDLを維持する。
- 書込中・48時間内・partial coverage・held・未確認ローカルファイルは既存経路。共有中の不変実体と書き込み用ファイルは別。

## 3. 確認手順

プロジェクト直下で実行する。本番認証や本番オブジェクトへの書込を使う試験ではない。

```sh
node --test --test-concurrency=1 server/test/trade-read.test.ts
node --test --test-concurrency=1 server/test/*.test.ts
pnpm run typecheck
pnpm --filter @workspace/receiver run build
```

変更前後の計測は、既存のローカルNQ時間ファイルを読み、各ケースを独立したNodeプロセスで3回ずつ実行する。

```sh
for cached in 0 1; do
  for i in 1 2 3; do
    for mode in before after; do
      node --expose-gc server/test/trade-read-benchmark.ts \
        data/trades/NQ/2026-10-26/14.jsonl.gz \
        --mode=$mode --cached=$cached
    done
  done
done
```

`before`は現AppStoreの従来`visitTrades`を呼ぶセッション、`after`は新セッション。他のcoverage・15分窓・visit処理は同じ。元ファイルを読み替える場合は`YYYY-MM-DD/HH.jsonl.gz`の既存ローカルNQファイルを指定する。

## 4. 実行した確認

### 4.1 結果の一致

入力：`data/trades/NQ/2026-10-26/14.jsonl.gz`

- gzip：**1,014,054 B**
- 入力gzip SHA-256：`656686f0250a419f68467ca9cd1cacbbb91e5e2114339886ae3c4cadd95fedb6`
- 各ケースの返却：**103,105約定・110,588枚・4つのfileWindows**
- 順序を含む全フィールドのJSONL結果SHA-256：`801066dd9a14da8c7f769f48c16312b7b065d3c801415147f86c09fc799de587`
- cold／確認済みcache、before／after、各3回の**12結果が同一**。
- 新経路の同じ走査で得た入力SHAも元ファイルと一致。元ファイルは変更していない。

### 4.2 本文取得・走査・転送量

ここでいう「取得」は模擬Objectsの本文download呼出回数、「転送量」はコピーされたgzip本文B数。**実クラウドへ接続して測ったHTTP wire量ではない。** SDKヘッダー・認証通信・再試行の実測ではない。試験はローカルdisk adapterであり、実ネットワーク待ち時間を再現していない。

| 条件・計測区分 | 変更前 | 変更後 |
| --- | ---: | ---: |
| cold：読取本文取得 | 4回 | **1回** |
| cold：読取gzip本文量 | 4,056,216 B | **1,014,054 B（75%減）** |
| cold：gzip走査・展開 | 4回 | **1回** |
| 確認済みcache：読取本文取得／量 | 0回／0 B | **0回／0 B** |
| 確認済みcache：gzip走査・展開 | 4回 | **1回** |
| cold：初期化のindex取得 | 1回／44 B | **1回／44 B** |
| 確認済みcache：初期化index＋SHA再DL照合 | 2回／1,014,098 B | **2回／1,014,098 B** |

44 Bはこの隔離試験の1時間分coverageで、本番coverageの容量ではない。照合通信を消して読取削減に見せていない。展開回数はNode async_hooksのZLIBインスタンス数でも4→1と独立に確認し、新poolカウンタの1回と一致。

新経路の区間一時ファイル合計は11,084,053 B。入力gzipと合わせてこのsampleでは約12.10 MBの読取用ディスクが必要だった。旧経路より一時ディスク量が増える代わりに再取得・再展開を減らす。4区間のpartition読取は4回で、同じ展開済み時間全体を4回走査してはいない。全終了時に参照0・snapshot0・cleanup失敗0。

### 4.3 所要時間・CPU・メモリ

独立Nodeプロセス各3回の中央値。Node v24.22.1、`--expose-gc`、測定直前GC。RSS／heapは5ms周期と終了時の観測ピーク。CPUは`process.cpuUsage`差分のuser＋system、wallは`performance.now`。coldとはAppStore cacheなしの意味で、OS page cacheは制御していない。

| 条件 | wall ms：前→後 | CPU ms：前→後 | RSSピーク MiB：前→後 | heapピーク MiB：前→後 |
| --- | ---: | ---: | ---: | ---: |
| cold | 2,292.78 → **1,147.36** | 2,303.72 → **1,258.93** | 127.06 → **143.91** | 24.09 → **33.00** |
| 確認済みcache | 2,178.82 → **1,152.69** | 2,250.65 → **1,280.62** | 127.50 → **143.41** | 24.05 → **32.60** |

coldのwall約50%減／CPU時間約45%減。ただし**RSSピークは約16.85 MiB増**、確認済みcacheでも約15.91 MiB増えた。巨大な時間配列を保持してはいないが、stream・JSON・一時Buffer・GCを含む実測メモリは増えている。メモリ削減としては報告しない。

ばらつきもある。coldのwallは前2,231.32〜3,014.19ms、後1,127.70〜1,701.26ms。確認済みcacheは前2,159.49〜3,245.48ms、後1,108.91〜1,717.56ms。公開VMのCPU使用率・RSS・長時間安定性を測ったものではない。

### 4.4 隔離試験

追加10件：

1. GCの4窓で旧結果・枚数・同内容別約定・巻戻り・限月・microsecond境界を維持、取得／展開1回。
2. 15分区切りとずれた要求・時間境界・spillの行順・半開境界。
3. NQ／GCの同時読取と本文／SHA分離。
4. 並行scopeの共有取得・走査、先行close後も後続読取成功。
5. 読取中の版固定、全解放後の新本文取得とSHA変更。
6. callback例外・読取abort後の参照解放、後続読取成功。
7. DL待機中に片方だけ中断しても他方は成功、取得は1回。
8. 単独DL待機の中断後、遅れて完了するSDK相当の書込を待って除去。
9. 部分DL失敗・gzip破損・JSON破損を成功扱いせず、cleanup後の再取得成功。
10. 直近／partialは旧経路、起動時SHA照合を維持、確認後に変更されたローカル本文を共有しない。

実行結果：

- `node --test --test-concurrency=1 server/test/*.test.ts`：**186/186成功**、最終実行59.27秒。VP・App Storage・GC・起動復元・保存／終了・範囲／リプレイ等の既存試験を含む。
- `pnpm run typecheck`：libs、API、heatmap、sandbox、scripts、serverすべて成功。
- `pnpm --filter @workspace/receiver run build`：Vite本番ビルド成功。
- 前後12ケースの結果digest一致、独立プロセス計測完了。計測runnerの残存なしを`pgrep`で確認。
- 本試験のObjectsは模擬専用。実REST／上流WS／App Storage書込／公開操作はしていない。

実行時ログ・JSONは`/tmp/trade-read-full-tests.log`、`/tmp/trade-read-isolation/*.json`。永続的な結果は本報告に記載。

## 5. 仕様との差分

永続形式・API・取得範囲・保持期間等の仕様変更はなし。15分のREST窓と取得済み区間の再確認も維持。

内部実装として、64 KiB目安の区間Buffer、4区間＋spill、行番号付き一時JSONLを使う。これは応答中の作業ファイルであり、新しい永続保存形式・補完データではない。共有対象を完全に保存確認済みのcold時間へ限定するため、すべての古いpartial時間で1回になるわけではない。

## 6. 未解決・懸念

- **実公開環境でのSDK通信量・高CPU・長時間メモリは未測定。既存の欠けも修復していない。**
- RSSピークと一時ディスク量の増加がある。複数の異なる時間・銘柄の同時読取に必要な余裕は別途確認が必要。無制限のRAM時間キャッシュは追加していない。
- SDK download待機のabortはネットワーク中断ではなく参照解放。物理cleanupは遅いSDK処理がsettleした後。cleanup失敗はログとカウンタへ出し、成功と偽らない。
- 活動中scopeの版固定と、外部writerの最新版を即座に検知することは別。後者の強い保証には公開SDKでの世代照会／条件付き取得の別検討が必要。
- 日全体／7日全体の再走査、板の反復取得、毎秒の一覧走査、長期集計の起動時全日取得、gzip統合、期限削除は今回の対象外。

## 7. 次の候補（提案のみ）

許可された公開後の読み取り確認で、この対象経路の利用頻度・実転送量・RSS増加を確認する。今回は実施しない。

ブラウザは起動していない。独自の常駐サーバー・上流接続も起動していない。隔離試験の子プロセスは試験側で終了し、計測runnerの残存なしを確認した。既存の受信・ワークフローには停止操作を行っていない。ここで停止する。
