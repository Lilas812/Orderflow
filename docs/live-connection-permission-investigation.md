# NQ Trades＋L2：非query接続・利用権限の調査

## 結論（2026-10-24）

**HOLDを維持する。調査は完了したが、LIVE接続の前提は成立していない。**

公開一次資料の現行本文と公式Node SDKソースを再確認した。公式に裏付けられた
非query WebSocket認証方式は確認できない。公開仕様は明示的にquery keyのみとし、
upgradeのAuthorizationヘッダーを読み取らない。これは「非query方式が将来も絶対に
存在しない」という証明ではなく、現時点で採用可能な公式根拠がないという判断。

このアカウントの有効性、Realtime＋L2権限、利用区分・受諾規約との適合は
**UNKNOWN**。秘密の存在、公開料金表、過去のTicks受信成功、ユーザー自身の許可で
アカウント権限を確認済みにしない。確認のための新しい接続も行っていない。

## 証拠の区分

| 項目 | 確認済みの公開仕様・既存実装 | ユーザー申告／承認 | 当該アカウント・今回の判定 |
| --- | --- | --- | --- |
| WS認証 | [S1]はquery keyのみ、upgrade Authorization非対応を明記。[S7]のstreamもqueryにキーを組み立てる。 | URL queryへのキー格納禁止。 | 条件不一致で **HOLD**。公式非query方式の存在は **UNKNOWN**。 |
| REST認証 | [S1]はBearerヘッダーをサポート。 | 新しい接続を開始しない。 | REST認証がWSでも使えるとは扱わない。REST pollingをTrades＋L2ストリームの代替として承認・採用しない。 |
| アカウント・秘密設定 | 環境スナップショットにTICKSTREAM_API_KEYという設定名がある。値は参照していない。 | 既存の設定を使用する方針。 | アカウント有効性、キーの有効性、停止の有無は **UNKNOWN**。今回は設定メタデータの独立再照会もしていない。 |
| NQ Realtime＋L2 | [S3]はbookにRealtime＋L2以上を要求。[S5]はFreeを15分遅延、Realtimeを29米ドル/月、Realtime＋L2を79米ドル/月と区別。 | 従来の許諾はNQ Ticks用。今回のデスクトップRAM受信は条件付き承認。 | 当該アカウントの有効プラン、NQの遅延なしTradesとbookの両権限は **UNKNOWN**。Realtime単独やTerminal等の同額商品をL2権限とみなさない。購入・更新はしない。 |
| 個人アプリ用途 | [S6]第5条は自身のアプリでの内部利用を条件付き許可。第5a条は非プロ利用を本人用途に制限。 | 個人用Orderflow Lab、第三者配信・再販売・公開なし。 | 利用目的は申告。アカウント区分、利用申告、追加の取引所・ベンダー条件への適合は **UNKNOWN**。個人開発という名称で非プロ資格を断定しない。 |
| 規約受諾 | 公開[S6]の更新表示は2026-09-13。第13条は受諾版を記録し、重要変更への未同意時はデータ供給が一時停止すると説明。 | この調査では受諾の証憑なし。 | 当該アカウントの受諾版・現行の供給状態は **UNKNOWN**。公開最新版を受諾済みと推定しない。 |
| RAMと保存 | [S6]第5条は保存・キャッシュを必要な範囲に制限し、取引所等の条件にも従属。 | 今回はデスクトップのread-only RAM受信・表示のみ。 | 実データ保存は不許可。旧Ticksの24時間以内削除条件をL2に拡張しない。既存の保存試験HOLDも解除しない。 |
| 公開・再配信 | [S6]第5条は生データの再配信等を禁止。第5a条は非プロ契約で世帯外表示や第三者へ出力する製品等を制限。 | 第三者提供なし。 | 公開Previewへ流さない。SDKのプロキシ推奨は再配信の許可やquery禁止の回避策ではない。 |

既存申告の参照元は `.agents/memory/live-trial-permission.md` と
`docs/live-storage-permission-investigation.md`。独立したアカウント証憑や
供給者回答ではない。今回、管理画面へのログイン・契約閲覧・問い合わせ送信はしていない。

## 非query方式の検討結果

- **WS upgradeヘッダー**：公開仕様が非対応を明記。Nodeのヘッダー送信能力だけでは成立しない。
- **最初のメッセージによる認証、Cookie、subprotocol、短期ticket**：
  [S1]–[S4]・[S7]と公開検索で公式サポートの根拠を確認できない。推測実装や実接続による探索はしない。
  ticketでもURLに秘密を移すだけなら、非query条件を満たすと勝手に判断しない。
- **公式SDKへの置換**：SDKもquery認証であり解決にならない。SDKのMITライセンスは
  ソフトウェアの許諾であって市場データのL2利用許可ではない。
- **ローカル／サーバープロキシ**：上流でquery keyを使えば禁止に抵触したまま。
  rendererから隠すだけでは今回の条件を満たさない。
- **REST Bearer**：WSヘッダー対応やL2連続受信の証明ではない。別方式への切替は今回の範囲外。

[S1]の認証例・SDKは `/v1`、[S2]のraw WS例は `/v1/stream`。
この表記差を理由に実装の接続先を切り替えたり、未記載の認証経路を推定したりしない。
[S7]は購読フィールドにも[S2]との差があるため、SDKを実行して調停することもしない。

## 既存の安全停止を確認

今回、製品コード・設定・依存を変更していない。

- `packages/tickstream-adapter/src/readOnlyFeed.ts`：
  `reviewReadOnlyConnection` は証拠がすべてCONFIRMEDでも
  `QUERY_AUTH_FORBIDDEN_BY_TASK31`、`canConnect: false`、
  `canPersistMarketData: false` を返す。UNKNOWN項目は個別の不足理由となる。
- `apps/tickstream-poc/src/readOnlyFeedSession.ts`：
  LIVE分岐はdialより前にBLOCKEDで返り、attemptsもreconnectsも0。
  キーを渡す引数・環境変数を読む処理はない。
- `AccessEvidence`のCONFIRMEDは呼び出し元から与える状態であって、
  アカウントを自動検証した証明ではない。ユーザー申告だけでCONFIRMEDを与えない。
- 従来の `.local/diagnostics/task31/report.md` は過去の診断記録として変更しない。
  今回の調査完了を、同記録の未接続・未統合状態の解消として扱わない。

## 再判定に必要な最小資料・承認

**query禁止の撤回、購入、秘密値、試し接続の承認は求めない。HOLD維持に追加承認は不要。**

再開を希望する場合に必要な資料は次の2種類に限定する。

1. **TickStream公式窓口の非query認証仕様**：
   NQ Trades＋bookに対応する正確なendpoint、認証を載せる位置・手順、
   対応するアカウント／プラン、公式資料または公式回答。
   「RESTでBearer可」ではなくWS等の当該ストリームについての回答が必要。
   非query方式がなければHOLDを継続する。問い合わせは今回送信していない。
2. **既存アカウントの秘密を除いた根拠**：
   有効なFutures Realtime＋L2以上のプラン、NQのRealtime Trades＋bookの権限、
   アカウントの有効／停止状態、利用区分・申告、受諾規約版を示す既存表示や公式回答。
   氏名、メール、アカウントID、請求・決済情報、キー、Cookie、認証URL、
   市場データ本文は除外する。これらの値をチャットや証跡へ提出しない。
   資料を提示できなければUNKNOWNのままでよい。

公式窓口へ確認する内容の例（未送信）：

> 個人専用のWindows Electronアプリで、NQの遅延なし約定とL2 bookを
> Node側だけでread-only受信しRAM内で分析・表示する予定です。注文、永続保存、
> 第三者表示・配信は行いません。キー等の秘密をURL queryに一切含めずに
> 両チャネルを受信できる公式方式はありますか。対応endpointと認証仕様をご提示ください。
> また既存アカウントのプラン・利用区分・受諾規約に照らし、この個人利用に必要な
> 権限と適用条件の確認方法をご案内ください。購入や契約変更は希望していません。

これは特別な契約の新設依頼ではない。[S6]は共通規約とアカウント権限の違いを説明し、
個別のサイドレターを提供しないとする。求めるのは既存仕様・条件の適用説明である。

資料が揃っても自動接続しない。既存の条件付きRAM受信承認の範囲と適合を再判定し、
必要な製品側の統合・安全条件を満たしてから進める。限月・品質・既存4表示への経路は
別の進行中作業に委ね、この調査で完了とはしない。恒久保存・課金・注文・公開は引き続き対象外。

## 出典と調査範囲

以下は2026-10-24に本文を取得して確認した公開一次資料。検索結果だけの推測ではない。
検索は非query方式の公式資料を探す補助として使用し、一般的なWS認証の解説を
TickStreamの対応仕様の根拠には採用していない。

- **[S1] Authentication**：https://tick-stream.xyz/docs/authentication
- **[S2] WebSocket stream**：https://tick-stream.xyz/docs/streaming
- **[S3] Level 2 depth**：https://tick-stream.xyz/docs/level2
- **[S4] SDKs & libraries**：https://tick-stream.xyz/docs/sdks
- **[S5] Pricing**：https://tick-stream.xyz/pricing
- **[S6] Terms of Service**：https://tick-stream.xyz/terms — 第5条、5a条、13条、16条。
  公式問い合わせ先は `support@tick-stream.xyz`。法的な最終判断ではない。
- **[S7] 公式Node SDKの固定ソース**：
  https://github.com/Alx90s/tickstream-node/blob/8e0e3f18b48f631d79dfe4d0c5260d251c32f331/index.js
  — GitHub公開APIのmainコミット本文・index.js差分でstreamのURL構築を確認。
  取得時のmainはこのコミット。SDKのインストール・import・実行はしていない。

公開Webページ・公開GitHub情報の読み取りのみ。データAPI、ストリーム、dashboard、
checkoutへのアクセス、秘密値の参照、注文、課金、実市場データの受信・保存はゼロ。
アカウント権限の実測やWindows実機動作は未検証であり、そのPASSは主張しない。

## オフライン確認結果

- `pnpm --filter @workspace/tickstream-adapter exec vitest run src/readOnlyFeed.test.ts -t 'documented contract and Task31 connection policy'`
  — **9 PASS、33未選択**。証拠がすべて確認済みでもquery禁止で停止し、
  不明な権限や秘密設定の欠落を推測しない既存判定を確認。
- `pnpm --filter @workspace/tickstream-poc exec vitest run src/readOnlyFeedSession.test.ts -t 'blocks LIVE before socket creation'`
  — **1 PASS、10未選択**。dialを呼ばずattempts 0で停止することを確認。
  この選択実行ではloopbackを含めソケットを開いていない。
- `git diff --check` — 終了コード0。ただし新規未追跡ファイルの本文はこのコマンドの
  検査対象に含まれない。製品差分なし。全テスト・build・ブラウザ・Electronは未実行。

後続の限月・品質・4表示統合と既存のRSS／安全停止回帰検証は既存作業の範囲。
それらと重複する新規提案や、証拠が揃う前の実接続タスクは追加しない。
