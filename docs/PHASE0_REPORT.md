# Phase 0 データ検証報告

## 判定
**2026-10-26 追記：ユーザーの判断により Phase 0 を完了とした。** 下の未解決項目は解決済みではなく、docs/SPEC.md 5.5 のルールで扱い、件数を見張る。
以下の「未完了」は、この追記の前の判定として残す。

**未完了。Phase 1には進まない。**

2026-10-26 に取引時間中の5分測定を1回実施し、直前10分の履歴も取得した。サイズ0の意味、板の完全性、1006の根本原因などは未解決。60分測定は実行していない。
更新した docs ファイルは本報告だけ。SPEC.md・AGENT_RULES.md・UI_SPEC_HEATMAP.md・replit.md は変更していない。未決定の集計方式・描画方式の追加判断も行っていない。

## 追加測定（2026-10-26）：実行条件と保存物

- コマンド：`node scripts/src/phase0-probe.mjs --minutes 5`。ライブ実行はこの1回のみ。Node v24.22.1、追加依存なし、Node標準WebSocket 1本、再接続なし。
- 全体：2026-10-26 10:20:50.513～10:26:25.424 UTC。
- ライブ：10:20:51.117～10:25:51.119 UTC（日本時間19:20:51～19:25:51）、300.002秒。接続から418msで最初の約定を受信し、30秒無約定の中止条件には該当しなかった。
- 履歴：同日10:10:00以上10:20:00未満 UTC（日本時間19:10～19:20）。ライブ開始直前の完了した分から10分を選択した。休場日判定や架空の埋め合わせは行っていない。
- `recvUs` は `Date.now() * 1000`。整数マイクロ秒表現だが時計の分解能はミリ秒。時刻差は受信PCと配信元の時計差・秒への丸め・通信遅延を含むので、純粋な通信遅延とは呼ばない。
- 受信メッセージは `{recvUs, raw}` のJSONLで保存。`raw` は受信した文字列を保持し、パース・正規化した内容に置き換えていない。JSONL上のエスケープはJSONとして読み戻せる。RESTはfetchで得た応答本文のバイト列をそのままgzip化した。認証ヘッダー・認証付きURLは保存しない。
- `data/` はGitと公開物から除外。検証用の一時的な記録であり、アプリ本体で板を録画する方式を採用したものではない。

保存先（すべてWorkspace内の非公開・Git管理外データ）：

| 用途 | 保存先 |
| --- | --- |
| 未加工WSメッセージ＋受信時刻 | `data/probe/ws-1793010050513000.jsonl.gz` |
| 未加工REST応答11本 | `data/probe/rest-book-<リクエスト時刻Us>.json.gz`（各ファイルの対応はsummaryのhistory.requestsに記載） |
| 接続・終了・HTTP診断ログ | `data/probe/events-1793010050513000.jsonl` |
| 実行時の集計結果 | `data/probe/summary-1793010050513000.json` |
| 保存済みデータのオフライン照合・追加分析 | `data/probe/reanalysis-1793010050513000.json` |

メッセージ解析は既存の `live()`、取得・生本文保存は `request()`、時間窓検証は `history()` に実装した。新規の `phase0-analysis.mjs` は通信から分析を切り離して再検査するため、`phase0-analysis.test.mjs` は小さなダミー入力と期待値を比較するために追加した。events・summary・reanalysisは、保存証拠と集計を後から照合するための成果物である。

## 追加測定：SPEC 5.2 の結果・根拠・確信度

| 項目 | 結果 | 根拠 | 確信度 |
| --- | --- | --- | --- |
| ライブ約定の時刻 | 557件すべて10桁。秒解釈が受信時刻と整合 | 秒解釈の差は120,000～1,111,000µs、他の3単位では約1.79×10^15µsの差。下表参照 | 高（この観測範囲）。通信遅延そのものの推定は低 |
| ライブ板の頻度・量 | 1,022件、平均3.40664件/秒。受信時刻基準の秒別最大・p99は4件 | 300.002秒、全1,601フレームを保存して再集計と一致 | 高（今回の5分）。寄り付き・60分への一般化は低 |
| サイズ0 | ライブ817,600段と採用履歴1,716,800行で0件 | 全段・全採用行を走査。例がないため「削除」「空段」等の意味は不明 | 高（未観測という事実）／低（意味） |
| 板の整合性 | 並び順違反、価格重複、買い≥売り、ティック外、サイズ負数、空側・不正段は0件。価格の飛びは325,506箇所 | ライブ1,022枚の両側400段を検査。履歴の全800行組もside/level=両側1～400の一意性を確認 | 高（検査結果）／低（フィード全体の完全性） |
| 同じtsに1,600行 | 13時刻。全13件で、前後800行が順序も内容も一致 | 2,133時刻を集計し、ts/side/level/price/size/flagを照合。各800行は両側400段、flagはすべて0 | 高（この13件）／低（全期間の原因や新旧判定） |
| 切断1006 | close(1000)を要求して応答を待っても再現 | 10:25:51.119 UTCに要求、129ms後にerrorとclose code=1006、wasClean=false | 高（再現）／低（根本原因・切断した機器の特定） |

### 約定tsの候補比較

差は `recvUs - 候補単位でµs換算したts`。候補ごとに比較しただけで、桁数による自動単位変換は採用していない。

| 解釈 | 最小差µs | 平均差µs | 中央値µs | p99差µs | 最大差µs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 秒 | 120,000 | 621,375.224 | 617,000 | 1,104,000 | 1,111,000 |
| ミリ秒 | 1.791217041484×10^15 | 1.791217132759×10^15 | 1.791217110084×10^15 | 1.791217331039×10^15 | 1.791217337486×10^15 |
| マイクロ秒 | 1.793008258525×10^15 | 1.793008349891×10^15 | 1.793008327194×10^15 | 1.793008548370×10^15 | 1.793008554823×10^15 |
| ナノ秒 | 1.793010049742×10^15 | 1.793010141108×10^15 | 1.793010118411×10^15 | 1.793010339587×10^15 | 1.793010346040×10^15 |

初回例：`ts=1793010051, recvUs=1793010051535000`。全候補の丸め前の統計はsummaryに保存。ナノ秒候補は診断用の浮動小数計算であり、整数µsの内部時刻として採用しない。

### type別件数・秒別分布・容量

| type | 件数 | 平均件数/実測秒 | 秒別最大 | 秒別p99 |
| --- | ---: | ---: | ---: | ---: |
| welcome | 1 | 0.00333 | 1 | 0 |
| ping | 21 | 0.07000 | 1 | 1 |
| book | 1,022 | 3.40664 | 4 | 4 |
| tick | 557 | 1.85665 | 25 | 13 |

warning/feed/errorメッセージは0件。JSON ping 21件に全21件pongを送った。上記のerrorメッセージ0件と、終了時のWebSocket errorイベントは別のもの。JSON解析不能は0件。

平均は件数÷300.002秒。最大・p99は接続からの1秒バケットで、ゼロ件秒と最後の2msの部分バケットを含む301バケット。p99はnearest-rank。bookの秒別件数分布は `{0:2, 1:9, 2:27, 3:93, 4:170}`。

配信元book.tsの同値出現回数は `{1回:7時刻, 2回:44時刻, 3回:92時刻, 4回:129時刻, 5回:27時刻}`。合計299時刻・1,022件で、同じ秒が複数回届く。配信元時刻の秒と受信時刻から切った秒バケットは区切りが違うため、こちらの最大5回と受信バケット最大4回を混同しない。

| 対象 | 実測byte | 同じレートが続くと仮定した1時間換算byte |
| --- | ---: | ---: |
| WS本文（制御メッセージ含む、受信文字列の連結） | 11,973,433 | 143,680,238 |
| 同上gzip（1つの連続ストリーム） | 186,895 | 2,242,725 |
| recvUs付きJSONL | 12,061,408 | 144,735,931 |
| 同上gzipファイル | 195,617 | 2,347,388 |

**1時間列は5分からの換算であり、60分実測ではない。** gzip率は記録長・チャンク分割に依存する。TCP/TLS/WebSocketヘッダー等は容量に含めない。録画はclose待機中も継続する実装だが、今回は待機中の追加フレームはなかった。

### 板の検査詳細・imbalance

- bids/asksとも段数は最小400、最大400、平均400。
- 違反の実例は未観測。価格の飛びの例：最初の板のbid index=11で29154.25から29153.75へ2ティック離れる。index=29では29149.25から29148.25へ4ティック離れる。
- 価格の飛びは注文のない価格かもしれず、直ちに段の欠落・データ欠損と断定できない。連番や期待される全価格段の定義がないため、完全性は未確定。
- imbalanceは最小-0.75、最大0.6666666666666666、平均-0.022595750629。全400段の枚数合計からの `(B-A)/(B+A)` とは一致しない（差の平均-0.269405678143）。
- 保存した1,022件をオフラインで照合すると、**最良bidのsizeと最良askのsizeだけの `(bestBidSize-bestAskSize)/(bestBidSize+bestAskSize)` が全件で厳密一致**した。誤差の最小・最大・平均は0。例：bestBidSize=1, bestAskSize=1, imbalance=0。
- これは今回のデータでの一致（確信度：高）であり、提供元の全銘柄・全期間の定義を確定するものではない。測定後、この候補を分析関数と単体テストにも追加した。今回の実行時summaryには全段由来3候補、追加の最良段候補はreanalysisに記録している。追加のライブ実行はしていない。

## 追加測定：履歴の窓結合・1,600行

60秒窓を順次取得。10窓ともHTTP 200、`truncated=false`、`history_clamped=false`。未加工1,750,400行から、それぞれの半開区間に入る1,716,800行を採用。元の応答ファイルは削除・修正せず保存した。

| 開始UTC（各60秒） | 応答行数 | 半開区間採用行数 | 800行の時刻数 | 1,600行の時刻数 | 取得＋保存ms | 分析込みms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10:10 | 171,200 | 167,200 | 205 | 2 | 5,091 | 5,223 |
| 10:11 | 174,400 | 171,200 | 212 | 1 | 2,863 | 2,997 |
| 10:12 | 169,600 | 167,200 | 205 | 2 | 2,571 | 2,698 |
| 10:13 | 169,600 | 165,600 | 203 | 2 | 2,437 | 2,525 |
| 10:14 | 152,000 | 148,800 | 182 | 2 | 2,079 | 2,155 |
| 10:15 | 183,200 | 180,000 | 221 | 2 | 3,463 | 3,560 |
| 10:16 | 180,800 | 176,800 | 221 | 0 | 2,776 | 2,867 |
| 10:17 | 188,800 | 185,600 | 232 | 0 | 2,757 | 2,842 |
| 10:18 | 182,400 | 180,000 | 223 | 1 | 2,724 | 2,827 |
| 10:19 | 178,400 | 174,400 | 216 | 1 | 2,769 | 2,855 |

合計は800行が2,120時刻、1,600行が13時刻、それ以外0。tsの逆順0件、ティック外・サイズ0とも0行。全800行組はそれぞれbid/askのlevel=1～400が一意に揃った。

1,600行の例：`ts=1793009405511892`。前半800行と後半800行はts/side/level/price/size/flagと順序がすべて同一で、flagは両方とも全0。この一致は13件すべてで確認。**異なる2組は今回はないため、新旧を区別できる証拠はない。全期間を重複除去してよいという結論や、1600行の生成原因までは確定しない。** 行の重複を消して観測を作り直していない。

### 境界の連続性

隣接する元応答が重ねて含む「境界秒」の行を出現回数込みで比較した。9境界すべてで一致、片側だけの行0。半開区間適用後は隣接窓の採用範囲が重ならない。境界をまたぐtsは以下。

| 境界UTC | 直前窓の最後ts（µs） | 次窓の最初ts（µs） | 差µs | 元応答どうしで一致した境界秒行数 |
| --- | ---: | ---: | ---: | ---: |
| 10:11 | 1793009459719665 | 1793009460008748 | 289,083 | 4,000 |
| 10:12 | 1793009519842563 | 1793009520279925 | 437,362 | 3,200 |
| 10:13 | 1793009579637735 | 1793009580269819 | 632,084 | 2,400 |
| 10:14 | 1793009639761180 | 1793009640018718 | 257,538 | 4,000 |
| 10:15 | 1793009699700365 | 1793009700034630 | 334,265 | 3,200 |
| 10:16 | 1793009759774093 | 1793009760029628 | 255,535 | 3,200 |
| 10:17 | 1793009819781083 | 1793009820019215 | 238,132 | 4,000 |
| 10:18 | 1793009879738310 | 1793009880030839 | 292,529 | 3,200 |
| 10:19 | 1793009939771498 | 1793009940026462 | 254,964 | 2,400 |

10分全体の隣接ts差は中央値255,654µs、p99=797,637µs、最大1,572,370µs。窓結合による不一致は観測していないが、元フィード自体の欠損がないと証明できる連番はない。厳密な定周期や、期待件数による欠損判定は採用していない。

履歴処理全体34,170.539ms（分析・保存・後述の上限超過試行を含む）。通常10回と上限試行1回、合計11リクエストを逐次実行した。

- `truncated=true` の半分割処理は実装し、窓の分割と1秒未満へ無理に進まない停止条件をダミー入力で確認した。ただし実データではすべてfalseで、この分岐の実API試験は未実施。
- `limit=500001` は**1回だけ試行し、HTTP 200、171,200行、truncated=falseで受理された**。同じ開始窓の500000指定と本文サイズ・行数は同じ。実際に50万行超の区間を返せること、許容上限がないことを証明したわけではない。アプリで使うlimitは確定していない。
- 429等のレート制限は未観測。観測ヘッダーはcontent-typeとdate。429/retry-after等があれば保存・記録して再試行せず停止する実装だが、実際の429を発生させる試験はしていない。

## 追加測定：1006の時系列

```json
{"recvUs":1793010351119000,"event":"observation_stop","details":{"reason":"observation_complete"}}
{"recvUs":1793010351119000,"event":"ws_close_sent","details":{"code":1000}}
{"recvUs":1793010351248000,"event":"ws_network_error","details":{}}
{"recvUs":1793010351248000,"event":"ws_close_received","details":{"code":1006,"wasClean":false,"unexpected":false,"initiator":"client_close_requested"}}
```

観測中の予期しない切断は0件。クライアントが測定終了時にclose(1000)を要求し、closeイベントを待ったが、正常な相手closeは確認できず1006になった。1006はローカルで報告される異常切断コードであり、「サーバーが1006を送った」という意味ではない。

要求からerror/closeまで129ms。15秒の診断用close待機タイムアウトには達しなかった。**「closeを待たなかっただけ」が原因とは説明できない。** パケット取得や提供元側ログがないため、サーバー・中間経路・Nodeクライアントのどこで正常closeが失われたかは不明。今回は追加のライブラリ導入・再測定・修正試行をしない。

スクリプトの終了コード0は「測定と証拠の保存を完走した」の意味で、正常closeやPhase 0完了の意味ではない。

## 追加測定：確認手順と実行した確認

通信しない確認：

```sh
node --check scripts/src/phase0-probe.mjs
node --test scripts/src/phase0-analysis.test.mjs
git check-ignore -v data/probe/ws-check.jsonl.gz data/probe/rest-check.json.gz
git diff --check
sha256sum replit.md docs/AGENT_RULES.md docs/SPEC.md docs/UI_SPEC_HEATMAP.md
```

実行結果：

- 構文チェック成功。ダミー入力の単体テスト6件成功（分布・ゼロ件秒、時刻候補比較、板異常とimbalance、半開区間と分割、出現回数を保持する比較、同一/異なる1600行）。
- 実通信は前述の5分コマンド1回。終了コード0、WS記録1本とREST本文11本を保存。
- 保存した全12gzipを展開・JSON解析。WSの件数・未圧縮byte・記録byte・本文連結gzipサイズが実行時summaryと一致。履歴の全800行組のside/levelも再検査。オフライン再分析は追加通信なし。
- Gitのdata追跡は0件。dataが.gitignoreに該当することを確認し、.replitignoreにも/data/を追加。
- 元仕様4ファイルのSHA-256はユーザー提示の期待値と一致。正本仕様は変更していない。

再確認はsummary・reanalysis・eventsを開き、必要に応じgzip本文をローカルで展開して行える。実データの第三者への表示・配布は行わない。ライブの再実行は追加接続になるので、ユーザーの次の指示を待つ。`--minutes 60` を受け付ける実装はあるが、今回は実行していない。

## 追加測定：メモリの全文と食い違い

今回 `.agents/memory/` に追加・変更した内容：**なし**。現在の3ファイル全文を以下に記載する。AGENT_RULES.md・SPEC.mdとの食い違いはなし。以前の報告本文にあったSDK採否未確定という記述は現在のメモリではなく初回報告の記述であり、本報告のSDK節で現行仕様と区別した。

`.agents/memory/MEMORY.md`：
```markdown
- [Specification handoff](phase-scope.md) — pasted project instructions and uploaded specs do not automatically replace canonical workspace files.
- [TICK STREAM verification cautions](tickstream-cautions.md) — published examples and SDK source disagree; seconds-based history pagination can stall.
- [仕様の正本](phase-scope.md) — 仕様の正本は replit.md と docs/ の4ファイル（AGENT_RULES.md、SPEC.md、UI_SPEC_HEATMAP.md、PHASE0_REPORT.md）だけ。attached_assets/ や .local/ にある同名のコピーは読まない。
```

`.agents/memory/phase-scope.md`：
```markdown
---
name: Specification handoff
description: Avoid confusing chat-provided project instructions with actual canonical files.
---

Pasting project instructions into chat or uploading revised specifications does not itself replace the canonical workspace files.

**Why:** A specification handoff stated that canonical files had already been updated, while inspection showed only a generic project template and the intermediate measurement report. Treating the handoff as proof would have used obsolete specifications.

**How to apply:** Verify file existence and contents before implementation. If the authoritative revision is unavailable, request it instead of reconstructing it from obsolete attachments. After authorized placement, compare source and destination bytes. Current scope and approval rules belong in replit.md and the canonical specifications, not duplicated here.
```

`.agents/memory/tickstream-cautions.md`：
```markdown
---
name: TICK STREAM verification cautions
description: External SDK discrepancies and API measurement limitations that should guide future verification.
---

TICK STREAM へは Node 標準の WebSocket で直接接続する。公式 Node SDK は使わない（確定）。理由は docs/SPEC.md 第4節のとおり。

**Why:** The public source inspected during Phase 0 differed from official subscription examples and had a warning path exposing part of a credential.

**How to apply:** docs/SPEC.md 第4節に従い、Node 標準の WebSocket を使い、公式 Node SDK は採用しない。

Seconds-based history pagination can repeat a page if a page is smaller than one second's rows; blindly incrementing a second can instead lose data. End-boundary seconds and repeated timestamps need investigation, not silent repair.

**Why:** Real history book requests reproduced a stationary cursor; short sampled results also included rows within the requested end second and one doubled row group.

**How to apply:** Read the Phase 0 report before implementing replay. Preserve legitimate duplicate trades and do not assume every identical timestamp identifies exactly one complete snapshot. Holiday/weekend stale snapshots are not evidence of timestamp-unit failure or active-session update rate.
```

## 追加測定：残った不明点とSPECへの反映案（未反映）

残った不明点：

1. サイズ0の意味（今回未観測）。
2. フィードの完全性と価格の飛びの意味。連番・期待板の定義なしで欠損を断定できない。
3. 1600行の生成原因、今回と違う内容の2組が届く場合の新旧判定。今回の13件の一致を全期間へ一般化しない。
4. 正常closeを要求して待っても1006になる原因と、切断が起きた場所。
5. 寄り付き・60分連続時のレートと容量、実際のtruncated/429分岐。60分測定は次の明示指示まで実行しない。

SPEC反映案（ユーザー許可後に別タスクで判断）：

- 5.1/5.2：ライブ約定のtsは今回秒解釈と整合した根拠と、板の観測レート・データ量を追加。5分からの換算と60分実測は区別する。
- 5.1/5.2/6：今回の1600行は同一の800行×2だったと記載するが、重複排除方針や異なる2組の扱いは未決定のままにする。
- 5.2：1006はclose待機後も再現、原因未特定と追記する。解決扱いにしない。
- 9：今回の9境界で半開区間結合と元応答の境界秒が整合した証拠を追加。ただしtruncated時の実API挙動は未確認。検証時のレート制限は停止し、アプリの再開方針は別に扱う。
- 5.1：imbalanceは今回最良段サイズの差比に全件一致したと候補を示す。公式定義の確認なしにアプリの計算式として確定しない。
- 500001指定の受理は記録するが、今回の応答は50万行未満のため、公式上限500000を無断変更しない。

この報告で停止する。以下は比較のために残した初回測定の記録であり、以降の「未検証」は初回時点の記述。

## 初回測定（2026-10-25）の実行条件

以下の初回測定の数値は当時の観測記録。現在の採用方針は `docs/SPEC.md` を正とし、初回の未決定事項を現在の未決定事項として扱わない。

- 実行日時：2026-10-25 05:51:46.371～05:53:03.470 UTC（日本時間14:51～14:53、日曜日）。
- 実行コマンド：`node scripts/src/phase0-probe.mjs`。
- Node.js：v24.22.1。追加依存パッケージなし。
- サーバー側のNode標準WebSocketを1本だけ使用。NQ ticksはURLで、bookは同じ接続の`op: subscribe`で購読。再接続なし。
- ライブ観測：openから60秒。接続待ちは最大10秒。
- 履歴：2026-10-23 13:30:00～13:31:00 UTC（米国株寄り付き）と16:00:00～16:01:00 UTC（通常時間として選んだ1区間）。
- 各履歴を`limit=1000`と`limit=500000`で取得。必要な箇所で秒単位の境界ページも取得。RESTは1リクエスト最大30秒。
- 生データはメモリ内のみ。stdoutは集計結果、stderrは機密を除いた診断ログ。実行時の出力は`/tmp/nq-phase0-summary.json`と`/tmp/nq-phase0-events.log`に保存したが、一時ファイルなので永続成果物ではない。
- Secret値、認証ヘッダー、認証付きURLは記録しない。ダミーデータなし。

## 1. 板メッセージ形式

### 公式資料

- ライブbookは差分ではなく毎回全量スナップショット。
- `bids` / `asks`は`[price, size][]`。最大400段／片側、最良価格順。
- メッセージは銘柄ごとに間引かれ、最大およそ7回／秒。
- 履歴は2026年6月中旬以降がおよそ250ms間隔のスナップショット。それ以前は`flag`付きの差分テープ。**両時代のリプレイ処理を共用してはいけない。**

### 実測

- ライブbookを1件受信。キーは`type, symbol, bids, asks, imbalance, ts`。通し番号はこの1件にはなかった。
- ライブはbid 212段／ask 400段。サイズ0は0件。価格÷0.25が整数でない価格も0件。
- 履歴の行は`ts, side, level, price, size, flag`。`side`はbid/ask、実測最大`level=400`、`flag`は全て0。
- 両履歴区間とも通常は同一`ts`に800行。寄り付き区間には同一`ts`に1600行となる箇所もあった。今回の集計だけでは重複スナップショットか別の理由かを判断できない。
- 履歴の並びは`ts`非減少。価格のティック整数検査は全件成功。

### 未検証

- ライブが全量置換で正しく維持できるかは、連続更新を観測していないため未検証。
- サイズ0を観測していないため、その意味は確定しない。
- 全レベルの価格順序、価格重複、クロス板、段の欠落は今回のスクリプトでは検査していない。
- 過去の差分時代の実データは取得していない。

## 2. 時刻の単位

| 対象 | 実測例 | 判定 |
| --- | --- | --- |
| ライブbook `ts` | `1792789200` | 秒として2026-10-23 21:00:00 UTCに対応。観測時には古い板 |
| 履歴book `ts` | `1792762200032390` | マイクロ秒として指定した日・時刻に対応 |
| 履歴ticks `ts` | `1792762200002900` | マイクロ秒として指定した日・時刻に対応 |
| `/ticks` `ts` | `1792762200002900` | 同じ履歴約定と一致するマイクロ秒 |
| REST `start` / `end` | `1792762200` / `1792762260` | Unix秒で指定し、HTTP 200 |
| ライブtick `ts` | 受信0件 | 未検証。公式資料は秒と記載 |

単位は資料で指定した形のまま検査し、桁数による自動推測変換はしていない。
スクリプトの受信時刻`recvUs`は`Date.now() * 1000`なので、整数マイクロ秒表現だが実際の分解能はミリ秒。

### 診断カウンターの読み方

- `invalidDocumentedSeconds=1`は「単位が不正だった」とは断定できない。今回のチェックは受信時刻との差が24時間を超える場合も数えるため、週末の古い板が該当した。
- 履歴の`invalidTimeUs`も「単位が不正」とは断定できない。`end`秒の途中まで返った行を、厳密な`end * 1_000_000`との比較で数えている。
- 寄り付きbookは3,200行、ticksは111行、通常bookは3,200行、ticksは10行がその比較に該当した。最終時刻はそれぞれ`end`の約0.90、1.00、0.91、0.89秒後だった。
- **観測事実として終了秒の小数部分まで返っている。** API境界が終了秒を丸ごと含むかは別途確認が必要。これらを加工・削除して整合したように見せていない。
- 24時間の比較は検証用の診断条件であり、アプリの遅延判定閾値として採用したものではない。

## 3. 板の更新頻度・段数

### ライブ60秒

- open成功。welcome 1件、book 1件、ping 5件、tick 0件。
- JSON pingには全5件とも`{"op":"pong"}`を送信。
- 受信フレーム合計9,239 bytes、フレーム＋改行を連結したgzipは2,219 bytes（welcome/pingを含む）。
- warning / feed / errorフレームは観測なし。これらが来た場合は型・コード・機密除去済みメッセージをログに残す。
- 60秒の観測終了処理後にネットワークエラーとclose code 1006を観測。正常なcloseハンドシェイク完了は確認できていない。原因は未特定。自動再接続は実装していない。
- 休場中の古いスナップショット1件なので、これを営業中の1秒あたり更新数やバイト数の根拠にはしない。

### 履歴（ライブ更新頻度とは別）

| 区間 | book行数 | 異なるts数 | 最大段数／片側 | 取得時間 |
| --- | ---: | ---: | ---: | ---: |
| 寄り付き | 193,600 | 241 | 400 | 5,193ms |
| 通常 | 195,200 | 244 | 400 | 4,544ms |

約61秒分を含むレスポンスの異なる`ts`数であり、約4回／秒という履歴資料の説明と整合する。ただし同一`ts`の1600行問題が残り、単純に`ts数=正しいスナップショット数`と確定できない。
営業中のライブの平常時・寄り付き更新頻度／バイト数は未測定。

## 4. 過去の板・ページ送り

- `/history/book`、`/history/ticks`、`/ticks`は今回のキーでHTTP 200。履歴の`history_clamped=false`。
- `limit=1000`ではbookは両区間とも`count=1000, truncated=true`。
- `limit=500000`は受理され、bookは193,600／195,200行、ticksは7,492／952行、全て`truncated=false`。
- 公式記載の上限は500,000行。今回は500,000指定の受理のみ確認しており、500,001以上が拒否されるかは試していない。
- 履歴bookは1行1段であり、1行で板全体が来る形式ではない。

### 重要：秒単位ページ送りの停滞

公式の`start = floor(last_ts / 1_000_000)`に従ってbookの次ページを取得したところ、
最初の1,000行が1秒未満に収まるため`start`が変わらず、**同じページが返った**。両区間で再現。

- 寄り付き1ページ目の最後：`1792762200096491`、次のstart：`1792762200`（元と同じ）。
- 通常1ページ目の最後：`1792771200404552`、次のstart：`1792771200`（元と同じ）。
- ticksの寄り付きは次のstartが1秒進んだが、その秒の既取得行も返る重なりを確認した。

したがって、そのままのループ実装は不可。次の秒へ強制的に進めると未取得行を失う可能性がある。
1秒分を十分に収められるlimit、境界での重複の取り扱い、進捗停止の検出が必要だが、方式は今回確定していない。
約定を内容だけでSet化すると同一時刻・価格・枚数・sideの正当な別約定まで消すおそれがあるため、単純なSetによる重複排除も採用していない。

## 5. 保存容量

HTTP本文はJSON配列であり、下表はレスポンス全体の保存容量ではない。
取得した行を順序を変えず`JSON.stringify(row) + "\\n"`でJSONL化し、Node標準gzipの既定設定で圧縮した値。
これは履歴行の容量であり、ライブフレームの録画容量とは形式も頻度も異なる。

| 区間・種類 | 実測JSONL bytes | 実測gzip bytes | 単純60倍JSONL bytes | 単純60倍gzip bytes |
| --- | ---: | ---: | ---: | ---: |
| 寄り付きbook | 16,004,432 | 1,155,816 | 960,265,920 | 69,348,960 |
| 寄り付きticks | 467,925 | 41,323 | 28,075,500 | 2,479,380 |
| 通常book | 16,139,047 | 1,169,003 | 968,342,820 | 70,140,180 |
| 通常ticks | 59,472 | 5,623 | 3,568,320 | 337,380 |

**右2列は推定の参考値であり、1時間の実測ではない。**
さらに終了秒が含まれ約61秒あるため、厳密な1時間レートでもない。gzipは圧縮ブロック長でも変わる。
1時間連続の生データ量、録画チャンクごとの容量、営業中ライブの保存容量は未検証。
初回測定では自前録画・保存形式・App Storage設定を決定・変更していない。その後の現行仕様9節では、アプリ本体は板の生データを録画せず、集計した列のみ保存する方針が確定している。Phase 0 の検証用保存はこれと別に扱う。

## 6. SDK調査

参照した公開ソースの`VERSION`は1.0.0。インストール・実行はしていないため、npm公開物との同一性は未確認。

- `stream(..., {channel: "book"})`という板購読機能は存在。
- ただしソースは`action: "subscribe"`を送り、公式資料の`op: "subscribe"`と違う。
- 既定の`wsBase`は`wss://stream.tick-stream.xyz/v1`で、接続箇所には`/stream`の追加が見当たらない。
- JSONのpingを読み飛ばし、`op: pong`の送信は見当たらない。
- キー形式チェックの警告がキーの先頭12文字を出力する経路がある。機密情報を出さないルールに抵触するリスク。
- `asDate()`は桁数から単位を推測する。今回の仕様では使用不可。

初回測定ではこれらを説明してユーザーの承認を得て、Node標準の生WebSocketを使用した。
その後の現行仕様4節で「TICK STREAM は Node 標準の WebSocket で直接接続し、公式 Node SDK は使わない」と確定している。ほかの未決定ライブラリまで採用を確定したものではない。

## 7. 再実行・確認手順

1. `scripts/src/phase0-probe.mjs`を開く。キーを直書きしていないこと、URLやエラー全体をログに出していないことを確認する。
2. 構文チェック：`node --check scripts/src/phase0-probe.mjs`。
3. Secretsに`TICKSTREAM_API_KEY`がある状態で`node scripts/src/phase0-probe.mjs`を実行する。実データ通信が発生し、約60秒＋REST取得時間かかる。他に接続中のツールがある場合はアカウント全体の接続上限に注意。
4. stderrの`ws_open`、`ws_control`、`ws_close`、`rest_complete`と、stdoutの`live`／`rest`／`paging`を見る。
5. 履歴の検証日時は固定であり、再実行してもライブ以外の区間は変わらない。

画面・URL・ボタンは作成していない。UIなしというPhase 0の範囲どおり。

### 実行した確認

- `node --check scripts/src/phase0-probe.mjs`：終了コード0。
- 固定start値を`new Date(seconds * 1000).toISOString()`で確認：13:30と16:00 UTCに一致。
- `node scripts/src/phase0-probe.mjs > /tmp/nq-phase0-summary.json 2> /tmp/nq-phase0-events.log`：終了コード0。上記実測を取得。
- 集計・板管理・描画ロジックはまだ作成していないので、それらの単体テストや画面確認は実施していない。
- 終了コード0は観測スクリプトが完走した意味であり、全検証項目の合格やPhase 0完了を意味しない。

## 8. 次の候補（未実施）

営業中のライブ約定・板の測定、1006切断の調査、履歴境界と同一tsの1600行の調査を行う。
追加の期間・測定時間や検証スクリプトの修正は、作業ルールに従い説明して許可を得てから行う。

## 参照元（2026-10-25に取得）

- 添付`SPEC_1792906235045.md`、`UI_SPEC_HEATMAP_1792906235045.md`、`AGENT_RULES_1792906235045.md`、`replit_1792906235046.md`。もう1つのUI仕様は同一内容。
- https://tick-stream.xyz/docs/streaming
- https://tick-stream.xyz/docs/level2
- https://tick-stream.xyz/docs/historical
- https://tick-stream.xyz/docs/sdks
- https://raw.githubusercontent.com/Alx90s/tickstream-node/main/index.js
