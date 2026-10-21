# DATA_SPEC.md — イベント契約・板復元・算術・保存・品質・テスト

- 文書版: 0.1.0 / 2026-10-21 / **設計文書。コード実装はしない**
- 対象: CME NQの個別限月 / 初期 `MBP` / 将来 `MBO`
- 凡例: [C] 確定要求、[P] 設計推奨・仮値、[U] ベンダー確認待ち

## 1. 守るべき不変条件（必須）

1. `RESTING_LIQUIDITY`（注文板）と `EXECUTED_VOLUME`（成立した約定）は別イベントで、計算・保存・表示のレーンを共有しない。
2. `BID`/`ASK`は板の側、`BUY`/`SELL`は**積極約定側**。 `ASK板` = `BUY約定` ではない。
3. 価格は整数tick、数量は非負整数で扱う。tickサイズは instrument metadata で定義。NQ outright [C] `1 tick = 0.25 index point`。
4. `UNKNOWN`/`OUTSIDE_DEPTH`/`GAP`/`NOT_INITIALIZED` は0枚と異なる。真の0枚は有効イベントまたは明確な削除でのみ成立。
5. 250msの画面更新ではイベントを間引かない。正確な時間加重平均は**イベント時刻における数量状態の継続区間**から計算する。
6. 表示用フィルター、価格バケット、色、密度を変えても**raw events**の内容は一切変更しない。
7. 入力順序/重複/欠損を検知できないベンダーを、そのまま「再現精度保証済」と扱わない。
8. Market dataを取引執行や約定と混同しない。約定履歴は取引所の公開Tradeでありユーザー口座の取引明細ではない。

## 2. 限月・メタデータ契約 [C]

```
Instrument {
  venue: "CME";              // NQの場合
  root: "NQ";
  contractMonth: "YYYY-MM";  // 例: YYYY-12; 自動ロールしない
  vendorSymbol: string | null; // [U] ベンダー側の実際の記号
  canonicalId: string;       // CME:NQ:YYYY-MM
  tickSizeNum: 1; tickSizeDen: 4;  // ポイント
  priceScale?: string;      // 丸め誤差回避のため十進固定小数として交換可能
  priceMultiplierUsd: 20;  // NQの契約価値。分析数量とは別。
  tradingSessionId: string; // ベンダー/取引所定義に合わせる
}
```

`priceTicks = exactPrice / 0.25 = exactPrice * 4`。逆変換 `price = priceTicks / 4`。整数に一致しない値は黙って四捨五入せず、入力検証エラー（別商品のTick仕様の可能性）。`float`を長期保存の主キーにしない。負の価格や他銘柄を考えるためバケット `floor(tick / width)` を使用し、整数除算の0方向丸めを使用しない。

同じ `NQ` でも限月が異なればstate・raw store・snapshot・chart viewportを分ける。旧限月と新限月を継ぎ足した連続チャートは初期対象外。

## 3. 原イベントと正規化イベント

**時刻とID**: `exchangeTimeNs` はUTC Unix epochナノ秒（JSONでは**十進文字列**、内部は`bigint`。JS numberでnsを保持しない）。`receiveTimeNs`（受信PC/ゲートウェイ観測）、`persistTimeNs`（永続化）、描画時間を別途保持する。信頼できる取引所時刻がない場合は時刻種別と精度を明示し、確定的な板履歴として認定しない。

```
EventHeader {
  schemaVersion: 1;
  canonicalInstrumentId: string;
  sourceId: string;          // MOCK or verified vendor ID
  channel: "L1" | "L2_MBP" | "TRADES" | "MBO";
  sessionId: string;
  exchangeTimeNs: string | null;
  receiveTimeNs: string;
  sourceTimePrecision: "ns" | "us" | "ms" | "unknown";
  sequenceScope: "PACKET" | "INSTRUMENT" | "CHANNEL" | "NONE";
  sequence: string | null;
  eventId: string;           // 安定したunique ID。生成法はアダプターで決定
  quality: "VALID" | "SUSPECT" | "GAP";
}

L2Snapshot {
  kind: "L2_SNAPSHOT";
  header: EventHeader;
  bids: Array<{priceTicks: number; qty: number}>;
  asks: Array<{priceTicks: number; qty: number}>;
  depthScope: {type:"FULL"|"TOP_N"|"PRICE_RANGE"; n?:number; minTick?:number; maxTick?:number};
  snapshotCoversSequence: string | null;
  impliedPolicy: "EXCLUDE" | "INCLUDE_SEPARATE" | "UNKNOWN";
}

L2PriceUpdate {
  kind: "L2_SET_LEVEL" | "L2_DELETE_LEVEL";
  header: EventHeader;
  side: "BID" | "ASK";
  priceTicks: number;
  qty: number;               // SETは絶対数量。DELETEは0に正規化
  updateBatchId?: string;    // 同一取引所イベントの境界 [U]
}

Trade {
  kind: "TRADE" | "TRADE_CORRECTION" | "TRADE_CANCEL";
  header: EventHeader;
  tradeId: string;
  originalTradeId?: string;
  priceTicks: number;
  qty: number;
  aggressor: "BUY" | "SELL" | "UNKNOWN";
  classification: "VENUE" | "VENDOR_DECLARED" | "DETERMINISTIC_QUOTE" | "UNKNOWN";
}

L1Quote { kind:"L1_QUOTE"; header: EventHeader;
  bestBidTick: number | null; bestAskTick: number | null;
  bidQty: number | null; askQty: number | null; }

DataQualityInterval { channel:"L1"|"L2_MBP"|"TRADES";
  startNs:string; endNs:string|null;
  status:"VALID"|"NOT_INITIALIZED"|"GAP"|"STALE"|"CLOSED"|"OUTSIDE_DEPTH";
  reason:string; evidence?:string; }
```

`L2_SET_LEVEL.qty=0` は有効な0状態として処理してよい。`DELETE` は当該価格0へ。`Snapshot` にない価格について「0」とできるのは**snapshotのカバー範囲内かつそのベンダー形式で『未列挙=注文なし』が保証される場合だけ**。TOP_Nの範囲外は`OUTSIDE_DEPTH`。同じ取引所時刻で複数の更新があれば、提供seq/atomic batch orderを尊重し、時刻の一致だけでイベント順を決めない。

### ベンダー変換の前提 [U]

- MBPの差分が絶対数量、差分数量、price levelのshift（順位）を表すか、snapshotが部分/完全かを**API文書で確認**。上記のSETを発行する前にadapter内部でその意味を復元する。
- `implied order` の含否・複数市場・implied vs outrightの重複計上を確認し、区別不可なら `UNKNOWN` として注記。
- aggressorがデータにない場合、成行方向は安易にlast price/ローソク足色だけから推測しない。過去の正確なbest quoteと時刻順が保証され、曖昧でない場合の分類は[G]候補。初期のLIVEでは `UNKNOWN` とし、Deltaを無効にする。
- 訂正/取消イベントおよび取引所のtrade match要件が不明なら、そのままTrade記録を確定しない。イベント識別が再接続で変わるvendorは重複リスクを明示する。

## 4. 受信・順序検証・状態機械

`NOT_INITIALIZED -> SNAPSHOT_READY -> LIVE_VALID -> STALE | GAP -> RESYNCING -> LIVE_VALID`

1. **L2開始:** 対象限月の有効snapshotが必要。snapshot受信まで差分を隔離バッファし、後追い適用する方法はvendor指定のseq同期アルゴリズムを使う（独自のタイミング推測禁止）。同期不能ならgap表示。
2. **更新受信:** イベントは受信時に記録し、シーケンス検証→正規化→ステート適用。冪等性キーで完全重複を除外（raw記録には重複受信と除外理由を残せる設計）。
3. **seq gap:** 連続性が保証されるseq scopeについて `expected+1` に進まない場合、gap開始。該当チャンネルの状態を無効化し、追いつくまで旧板を**現在板**として表示しない。
4. **切断:** heartbeat timeoutやsocket closeでSTALE→GAP/RESYNC。connectに成功しただけでは復帰扱いにしない。回復snapshot+連続差分を照合した時点でLIVE_VALID。
5. **不整列:** 順番入替がベンダー仕様で保証されている場合のみ許されたバッファで整列。保証なしの古いイベントは履歴の正確性を破壊するため「疑義あり」と記録し、サイレントソートをしない。
6. **部門独立:** L2 gapはL2だけを無効にし、TRADESの妥当性まで無条件に否定しない。TRADES欠損時はBubble/Deltaを無効にし、L2の履歴は保持する。L1も独立。
7. **スナップショット:** 保存snapshotは**状態が有効な時**のみ生成。開始時のsnapshotとは別に60秒ごとにローカル回復チェックポイントを記録。`snapshotAsOfTimeNs` と `lastAppliedSequence` を持つ。正確に60秒のイベントが存在しない時は実際の整合時刻を記録し、作り物の時刻をつけない。
8. **更新の不可分性:** 取引所イベントが複数更新から成る場合、batch completeを待って同一論理時刻に一括適用。フレーム中の不完全中間状態を描画しない。詳細はvendorに依存 [U]。

### 同時刻での適用規約 [P]

時間積分は左閉右開 `[t_i,t_{i+1})`。同一時刻のバッチ更新は全部適用後の状態がその直後の区間で有効。更新前の状態に時間長0を与える（積分へは寄与しない）。履歴の保存順は整列済みsequenceとeventIndexで決める。

## 5. 板の時間加重平均（TWA）

あるside・tick位置における数量を、有効状態期間に限りステップ関数 `Q_s,p(t)` とする。時間ビン `I=[a,b)` の**全期間が観測可能**な場合:

`TWA_s,p(I) = ( Σ_i Q_i × Δt_i ) / (b-a)`

ここで `Δt_i = length( I ∩ [t_i,t_{i+1}) )`。板更新時刻だけを平均する算術平均や250ms画面サンプリング値の平均は禁止。区間端を前後のイベントでクリップし、イベントがなくても既知状態が維持される時間は積分する。

**価格幅k Tickのビン** `P_j={jk,...,jk+k-1}` に対して:

`TWA_s,Pj(I) = Σ_{p∈Pj} TWA_s,p(I)`（[C] **同じside内での数量合計**。Bid/Askを混ぜない）。

レンジ内の一部tickがdepth範囲外の場合、セルを**不完全**としてマーク。確定的な0を捏造して合計しない。

**既知/不明の時間が混在する場合:** `coveredDuration` と `coverageRatio=coveredDuration/(b-a)` を保存。`partialTWA` は既知時間での積分 ÷ coveredDuration として診断用に計算してよいが、初期設定の**合格表示は coverageRatio=1 の時だけ**。それ以外は `NO DATA` を上から重ねる。既知時間だけの平均を全期間の板数量と偽らない。

### 時間加重テストfixture A（手計算可能）

NQ `tick=80000 -> price=20000.00`、side BID、単一tick。すべて同一連続セッション、有効snapshotあり。

| 時刻（秒、原点0） | イベント | イベント後のqty | 次イベントまでの継続秒 |
|---:|---|---:|---:|
| 0 | snapshot | 40 | 1 |
| 1 | SET | 80 | 2 |
| 3 | DELETE | 0 | 2 |
| 5 | SET | 60 | 3 |
| 8 | DELETE | 0 | 2 |
| 10 | ビン終了 | - | - |

`TWA[0,10) = (40×1 + 80×2 + 0×2 + 60×3 + 0×2)/10 = 38枚`。

2秒ビンごとの正解:

| ビン | TWA |
|---|---:|
| [0,2) | 60 |
| [2,4) | 40 |
| [4,6) | 30 |
| [6,8) | 60 |
| [8,10) | 0 |

`Minimum Liquidity Volume=50` の時は38枚の10秒セルを非表示、閾値0ならフィルターOFFで元の38枚を読める。これを再変更してもraw履歴は**計5件**のまま。

`tick 80001` に10秒間20枚の有効Bidがあれば、2Tick幅の `[80000,80001]` の10秒TWAは `38+20=58枚`。正規バケットIDは `floor(80000/2)=40000`。

### 欠損fixture B

上記ビン `[8,12)` に対し `[8,9)`はqty=0が有効、`[9,11)` はseq gapで不明、`[11,12)` は復旧snapshot qty=70。`
coveredDuration=2秒`, `coverageRatio=2/4=0.5`、診断 `partialTWA=(0×1+70×1)/2=35枚`。**表示結果: NO DATA、35枚の確定ヒートマップ色は描かない。**

## 6. Minimum Liquidity / 強度の数学

### 絶対量フィルター [C]

`visible = (threshold==0) OR (TWA >= threshold)`。coverage<100%のセルはフィルター判定せずNO DATA。tick幅変更後は**集約後のTWA**に閾値適用。数量50枚と色の基準は別。

### 相対基準 [P: 具体定義]

- 基準時点 `t_ref` の直近300秒 `[t_ref-300s,t_ref)` における**有効な各side/価格ビンの非ゼロ数量段階**を時間長を重みとして集計。
- 長さ加重の経験分布 `F(v) = Σ(duration_i · 1[qty_i<=v])/Σduration_i`、`p95 = inf{v:F(v)>=0.95}`。side別に算出。ビン価格幅kを揃えてから基準を計算する。
- 5分窓がデータ不足なら `WARMING UP` とし推定分布を**暫定**表示するだけ。valid coverage不足のまま「固定済基準」と表示しない。必要なデータ密度/許容欠損比は初期実装時にプロファイリングして決定 [U]。
- `FIXED_BASELINE=true` 時は保存した `(side, k, refQty, asOfTime, window)` を保持し、**HISTORYへ移動しただけでp95を取り直さない**。`Recalibrate` が押された時のみ新基準へ。
- `ABSOLUTE` は`absoluteMaxQty` [P: 200枚]。数量の比較基準として他の時刻に依存しない。

### 正規化とコントラスト [P: 数式の初期案]

`r = clamp(TWA / max(refQty,epsilon), 0,1)`。

`r < minIntensity` は完全非表示、その他 `u=clamp((r-minIntensity)/(maxIntensity-minIntensity),0,1)`。

`c=pow(u,1/liquidityContrast)`、`brightness=1-pow(1-c,topContrast)`。いずれも [0,1]。`liquidityContrast>0`,`topContrast>0`,`minIntensity<maxIntensity`。最終色は `palette(side, brightness)`。最小枚数フィルター/時間平均/元数量に一切影響しない。

95p基準、contrast、minimum thresholdは市場の「注文の本当の大きさ」を変えるわけではなく、見やすさの調整にすぎない。輝度と数量を同一視しない。

## 7. 約定量とDelta集計

### バケット定義 [C]

`timeBinId=floor(exchangeTimeMs / 2000)`、境界 `[id*2000,(id+1)*2000)`。UTC epoch基準。価格bin `priceBinId=floor(priceTicks/2)`、価格域 `[2*priceBinId, 2*priceBinId+1]`。開始境界上の約定は当該ビン、終了境界ちょうどは次ビン。

`B = Σ qty if aggressor=BUY`、`S = Σ qty if aggressor=SELL`、`U = Σ qty if UNKNOWN`、`V_raw=B+S+U`、`delta=B-S`。

**重要な仕様整合:** ユーザー指定の `Total=B+S` と `imbalance=|delta|/(B+S)` を使うのは `U=0`（すべての約定が分類済）のバブルだけ。`U>0` の場合 `INCOMPLETE_CLASSIFICATION` とし、初期仕様では色付きDeltaバブル/Deltaヒストグラムの合格判定から**除外して警告**。V_rawは別途診断表示。未知の売買方向を0枚として扱わない。

`imbalance = (V>0 ? 100*|delta|/V : null)`。V=0のバブルは生成しない。価格はtick整数で集計し、VWAPなど別指標を勝手に生成しない。

### 3条件フィルター [C]

```
pass = (!volumeEnabled || V >= 15)
    && (!deltaEnabled  || abs(delta) >= 10)
    && (!biasEnabled   || abs(delta)/V >= 0.40);
```

3項ONの初期値: 15枚 [P], 10枚 [C], 40% [P]。符号なし/UNKNOWN混入はpass=false（データ不完全をフィルター条件で隠してはいけない）。比較は>=を採用。

### バブルテストfixture C

対象時間 `[10:00:00,10:00:02)`、同一2Tick価格ビン、連続Tradeフィード、有効分類:

| 時刻 | aggressor | qty |
|---|---|---:|
| 10:00:00.300 | BUY | 12 |
| 10:00:00.800 | SELL | 4 |
| 10:00:01.700 | BUY | 11 |

期待: `B=23, S=4, V=27, Delta=+19, imbalance=19/27×100=70.370370...%`、3条件すべて通過、緑のバブル。

同じ価格で `[10:00:02,10:00:04)` に `BUY=12, SELL=14` → `V=26, delta=-2, imbalance≈7.6923%`。volume条件のみ合格、最終表示は**非表示**。ただしraw eventsは保持。

テスト: `10:00:02.000` ちょうどのTradeは後ろのビンのみへ。Trade IDを2回配送しても数値を二重加算しない。

## 8. バブル直径の関数と表示密度

直径pxの推奨 [P] 参照量 `Vref=100`、`minD=8`, `maxD=24`。`z=clamp(V/Vref,0,1)` とする:

- FIXED: `d = 16` [P]（minD/maxD範囲にクランプ、固定サイズは設定可能）
- LINEAR: `d = minD+(maxD-minD)*z`
- SQRT: `d = minD+(maxD-minD)*sqrt(z)`
- LOG: `d = minD+(maxD-minD)*ln(1+V)/ln(1+Vref)` をmin/maxへクランプ

fixture C のV=27に対し、LINEAR `12.32px`, SQRT `約16.314px`、FIXED `16px`、LOG `約19.55px`。`Vref=0`は禁止。VIEWPORT基準モードは現在見えている完全分類済バブルの最大Vを基準にする [P]。比較可能性を重視する時は `FIXED_BASELINE` を使う。視点を動かした場合、VIEWPORTモードは全サイズが再評価される旨を設定に記載。

標準/高圧縮はGPU描画前の**viewport限定のクラスタリング**。符号の異なるバブルは併合禁止、未確定と確定の混合はラベルを`MIXED`にするか統合を止める [P: 止める]。クラスタ形状は画面座標の近接距離（標準 `0.75*直径`、高圧縮 `1.5*直径` [P]）に基づき決定、代表中心は元バブルの出来高加重中心、集約値は個別バブルの合計で求め直す。`childrenIds` を元に分解表示可能。**クラスタ表示のDeltaは重み付き平均ではなくΣDelta**。過去のイベント集合は変更しない。

## 9. 未確定・確定・遅延到着の扱い

- `PROVISIONAL`: 2秒ウィンドウ中/まだウォーターマーク未到達。半透明、受信ごとにDelta色/出来高/径を更新する。
- `FINAL`: 該当チャンネルのwatermarkが `binEnd` 以上となり、連続性チェックを満たす。
- `REVISED`: FINAL後に許容される遅延Trade/訂正/取消を検知した場合。rawの変更履歴と改訂versionを保存し、該当バブル・Deltaバーを**再計算**。
- `INCOMPLETE`: Trade gap、分類不明、重複判定不能で数学的に確定できない場合。見た目だけFINALにしない。

ウォーターマーク仮案 [P] `wm=maxSeenValidExchangeEventTime - 3000ms`（許容遅延3s）。ただし**フィード無活動時に壁時計だけでwmを前進させない**。ベンダーがevent-time heartbeat/確定点を出す場合はその正しい情報を優先。ギャップやreconnect中は進めない。古いeventの「訂正」を受け入れる際はビンversionを単調増加させる。ユーザーに遅延改訂時刻が分かるようにする。`3秒` は仮値で測定して決める。

訂正の元Tradeを同定できなければ無理にマイナス約定を流さず、対象区間をINCOMPLETEにする。

## 10. Deltaヒストグラム / 価格ライン / 座標

- Deltaヒストグラムは最初は2秒単位 [P]、価格帯を統合した `D_k=Σ_priceBins Delta[k,p]`。合算対象のいずれかに分類不明またはTrade gapがある場合、その時間区間はDelta **不完全**を明示。
- 価格ラインは`Trade.priceTicks`を時刻順に描く。Trade欠損境界を越えて結ぶことは禁止。時刻が同じTradeは安定順序で一致。成行分類が不明でも最終約定価格の表示は可能。

共有座標の仕様（CSSピクセル、bounds右/上を排他的な画面端として扱う）:

```
x(t) = chartLeft + (t - tMin) / (tMax - tMin) * chartWidth

y(pTick) = chartTop + (pMaxTick - pTick) / (pMaxTick - pMinTick) * chartHeight
```

`t`差分はBigIntのUTC nsから**viewport起点との差をms等の安全な相対小数へ変換**して演算し、nsの巨大値をJS doubleで直接差し引かない。ヒートマップの矩形境界、バブル中心、価格線、ラダーの行中心は同じ `transform` 関数を参照。Mouse inverseも同じ。時間y関係は共通だがPrice axis AUTO/MANUALとTime axis LIVE/HISTORYは独立した状態変数。

AUTO価格軸は表示中の有効Trade価格の `[min,max]` を求め、`range=max-min` の上下15%の余白。単一価格なら少なくとも [P] 上下8Tick（2ポイント）の最小幅を確保。可視区間にTradeがない時は前回有効軸を保ち、`NO TRADE PRICE` 警告を表示。取引休止やgap中に偽の折線を結ばない。

## 11. 保管レイアウトとトランザクション

### ブラウザ試作とWindows本番 [P]

開発ブラウザ: ReplitのNode側開発サーバー/ファイル保存。**本番CMEデータをReplitに置かない**（契約・セキュリティ確認まで）。

Windows: `app.getPath('userData') / market-cache/` に次の例。データベースはWALモード・single writer・read-only reader。

```
market-cache/
  catalog.sqlite              # 契約限月、区間品質、offset/チェックサム、設定、snap index
  segments/CME/NQ/YYYY-MM/YYYY-MM-DD/
    trades-0001.zst            # 追記専用。形式名/コーデックは負荷試験後に確定
    mbp-0001.zst
    l1-0001.zst
  snapshots/CME/NQ/YYYY-MM/
    snap-<actual_ns>.bin       # 深度スコープ、seq、CRC付き
  diagnostics/                  # data gap、検証・圧縮統計（秘密鍵無し）
```

**初期段階では**テストfixtureをJSONLやメモリで再現し、早期にバイナリ圧縮形式を固定しない。計測後にchunk codec (zstd候補), チャンク期間（例5分）、圧縮単位、index granularityを選ぶ。ファイルは `schemaVersion`, magic, source/instrument, start/end timestamps, recordCount, checksum, encoderVersion, finalizationFlag を保持。chunk書込みは一時ファイル→fsync→rename→DB index登録の順、復元時は未完チャンクとchecksum不一致を検知して復旧/隔離する。小刻み単独fsyncによる遅延を避けつつ、耐障害レベル [U: 数秒/ゼロ損失要件] を事前に決める。

SQLite論理テーブル案:

| テーブル | 主な列/役割 |
|---|---|
| `instrument` | canonicalId, tick numerator/denominator, metadataRevision |
| `segment_catalog` | instrument, channel, startNs, endNs, path, checksum, records, bytes, status |
| `book_snapshot_index` | instrument, snapshotTimeNs, lastAppliedSeq, depthScope, segmentId, checksum |
| `quality_interval` | instrument, channel, startNs, endNs, status, reason, evidence |
| `trade_revision_index` | tradeId, targetTradeId, revision, event offset, validity |
| `saved_settings` | settingsSchemaVersion, json, updatedAt |
| `capture_sessions` | environment, vendor, startNs, endNs, bytes, tradesCount, l2Count, dropsDetected |

`segment_catalog(startNs,endNs,channel,instrument)` などに複合索引。raw eventsの巨量全件を1行ずつDBへ入れるかは負荷試験結果次第。cache tileは `schemaVersion + instrument + timeRange + priceTickRange + bucketSizes + raw revision + quality revision` をキーとし、色設定は**数量キャッシュキーに含めない**。描画テクスチャ/パレットは別cache。

### 7日保持 [C]

`retentionCutoff = UTC_now - 7*24h`。セグメント単位の削除はチャンク境界を配慮。削除前にcatalogとファイルの整合を確認、復元用snapshotが必要な区間を壊さないよう保持開始時点以前の直近**チェックポイント1個**を例外保持 [P]（契約上の保存期限と照合）。同一個別限月の再計算を7日範囲内に限定する。アプリが停止中なら再起動時にexpireするが、停止中の市場イベントを受信したことにはしない。

保存許諾がないデータは保持自体を禁止または短縮する。機密ログ/トレードイベントを無断でクラウドアップロードしない。

### 再起動/過去範囲取得 [C]

1. インデックスから対象時刻直前の**正常snapshot**を選択。
2. 同銘柄/同sessionの差分イベントをseq整合を維持して再生し、目的時刻の板を復元。
3. `quality_interval`を重ね、gapを越えた板状態の延長を禁止。
4. 価格×時間tileを必要範囲のみ生成。隣接チャンクはL2持ち越し状態の継続に必要な境界を含む。
5. 外部Tradeも同区間で照合してBubbles/Deltaを再集計。非表示フィルタを当てるのは最後。
6. chartを範囲移動しても元イベントを一切書き換えず、同じ復元結果を保証。

## 12. バックプレッシャー・障害復旧・可観測性

- 段階キュー: vendor transport -> decode -> normalized audit/durable log -> canonical state -> tile/bubble -> renderer。raw書込が間に合わない場合は利用可能なら上流pause/backpressure。上流がpause非対応なら容量超過時に**データ完全性を失ったことを記録し、無音で正確に見せない**。
- 計測: received/sec, applied/sec, duplicateCount, gapCount, maxSeqLag, queueDepth, storageFlushLag, latestEventLatency, renderFrameMs, GPUTextureMB, coverageRatio, unclassifiedTrades, dataBytes/day。
- loss of network: exponential backoff [P] 1/2/4/8/16/30s + jitter。再接続時はsnapshotを再確立しseq整合後だけvalid。limit order quantityの最後の値を現在値として恒久表示しない。
- raw record ordering: source orderとexchange timeの両方を保存し、受信/描画時刻はaudit目的。再計算時にはvendor基準で整合検証した論理順でイベントを適用。
- データとGPUが遅れた時、描画フレームは最新の整合したモデルをスキップしてよいが受信イベントはドロップしない。UIには最終モデル時刻と遅れを表示。
- 市場休止/CLOSEDは正規の営業時間/セッションルールから判定。しばらくTradeがないことだけで欠損判定しない。

## 13. テスト用fixture台帳（mockの必須シナリオ）

| ID | 内容 | 数学的期待値/品質の期待値 |
|---|---|---|
| F-01 | 単一tick 40→80→0→60→0 | `[0,10)` TWA38, 2秒サブビン 60,40,30,60,0 |
| F-02 | もう1tickに一定20を追加 | 同side 2Tick集計58 |
| F-03 | Gap [9,11)、[8,12)の例 | coverage0.5、partial35、正式表示NO DATA |
| F-04 | BUY12, SELL4, BUY11 | B23, S4, V27, delta19, imbalance70.37037% |
| F-05 | BUY12, SELL14 | V26, delta-2、3条件ANDで非表示 |
| F-06 | 一度削除した価格に再追加 | 0であった過去区間は0のまま、再追加以降のみ色付け |
| F-07 | L2 sequence 10→12 | L2 GAP、ラダー`—`、Trade自体は継続可能 |
| F-08 | Tradeイベント重複（同tradeId） | 一回分だけを集計（raw監査は重複を記録） |
| F-09 | 未分類aggressor=UNKNOWN | Bubble/DeltaはINCOMPLETE、V_rawのみ診断 |
| F-10 | 2秒境界ちょうどのTrade | 境界以降ビンだけに入る |
| F-11 | FINAL後の遅延Trade訂正 | version +1、Bubble/Delta再計算、REVISED表示 |
| F-12 | ウィンドウ操作 | LIVE→HISTORY後も取り込み継続、最新以外で戻らない |
| F-13 | フィルター50→0→50 | 元イベント件数/ハッシュ不変 |
| F-14 | 色パレット変更 | データ側のqty/delta不変、GPU RGBAのみ変わる |
| F-15 | 再起動して[0,10)取得 | F-01と完全一致、gap markerも一致 |
| F-16 | L1なし・L2正常・Trade正常 | L1だけNO DATA、他画面は正常 |
| F-17 | 限月を跨ぐシンボル切替 | 他限月のdepth/tradeが混ざらない |

テストデータには必ず`environment=MOCK`, seed, fixtureId, expectedResultSchemaVersionを付与。イベント発生順を固定、再現可能な例を基準とする。雑音付きMOCK generatorは基準fixtureと別ファイルに分離。

## 14. 7日保存容量・負荷試験計画

実測前に容量を断定しない。次の3負荷をイベント生成器で実行する [P]: `LOW=1k/s`, `MED=10k/s`, `SPIKE=50k/s`（**実際のNQレートではなく試験値**）。段階を分けて10分/1時間/1営業日を実施。Trade/L2比率・イベントsize・depthレベル・書込みflush・ディスクSSD・CPU・GPU・メモリ・Windowsバージョンを記録する。

`bytes/day = observedCompressedBytes / observedHours × 24` は**稼働が24時間相当の場合の外挿**。より正確には取引セッション時間で重み付けし、ピーク値と静穏値から7日上限を検討。別途snapshot/SQLite WAL/索引/タイルcache/クラッシュ一時ファイルの容量を合算。圧縮率、取込p95/p99遅延、メモリp95、range-query p95、描画p95、イベント完全一致率を記録。

- 10分: fixture負荷で受付件数 = 永続化ユニーク件数 + 明示した重複数、silent drops 0。
- 1時間: 継続書込み＋同時に30分/3時間の過去読み出し。SQLite reader/writer競合、WALサイズ、chunk indexを測定。
- 障害注入: 強制終了、chunk途中電源断相当、ディスク満杯、seq gap、ネット切断、GPU context lost、clock skew、trade訂正。
- 7日外挿: 観測しないイベントがある前提で安全マージン [P] 1.5×、容量不足になった場合は警告を先出し。容量しきい値 [U] はPCストレージ環境を確認後に決定。
- **LIVE受け入れゲート:** 既知の業務時間で実データを同時期の信頼できるチャート/ベンダー提供統計と照合（同限月・同side・同depth条件）。時間軸とシーケンス、snapshot起点が揃わない比較を合格扱いしない。

## 15. MBOを追加するための境界 [G]

MBPエンジンは `PriceLevelBook`, 将来のMBOは `OrderIdBook` を別実装とする。adapterが個別orderId・action・displayQty・priority/side・price・seqを**明示的に**提供するまで `OrderIdBook` は初期化しない。MBOからMBP集計を導出する場合でも、元のorder eventとderived price levelを識別し二重加算しない。個別注文の大口強調なども[G]。売買主体の実名やIceberg/stopを個別注文IDのみから断定しない。

## 16. 参照

- CME MDP MBP/MBO incremental example: https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/457227795/MDP+3.0+-+Market+Data+Incremental+Refresh+-+MBP+and+MBOFD
- CME snapshot recovery (MBO): https://cmegroupclientsite.atlassian.net/wiki/spaces/EPICSANDBOX/pages/457673198/MDP+3.0+-+Market+Data+Snapshot+-+MBOFD+and+MBOLD+Recovery
- SQLite WAL: https://www.sqlite.org/wal.html
- CME data licensing: https://www.cmegroup.com/market-data/license-data/market-data-policy-education-center.html
