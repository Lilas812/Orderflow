# 試験データの期限削除：オフライン調査

調査日：2026-10-23。**調査完了。本番保存HOLDを維持する。修正・本番試験には進まない。**

## 結論

- **PASS（限定）**：正常なtrialの早期削除、SIGKILL後の新しいNodeからの削除、期限切れ約定ファイルの読込拒否、既知の一時ファイル・manifest・lockの削除、検査時に存在する稼働中leaseや不正パス等での削除拒否を合成MOCKで確認した。
- **FAIL**：削除中に新しいleaseが成立する競合、作成途中失敗、marker削除後の最終ディレクトリ削除失敗について、通常手順だけでは安全性・再試行性を満たさない反例を再現した。
- **FAIL（保証の有無）**：関連プロセスが停止したままでも期限内に自動削除する保証はない。停止後、短縮した合成期限を過ぎても原本が残り、明示削除が必要だった。これは既存の `NOT_GUARANTEED_MANUAL_CONFIRMATION_REQUIRED` という申告と一致し、その表示自体の不具合ではない。
- **UNKNOWN**：実際の管理Workflowの再起動、Replit環境全体の停止・再作成、ホスティング側の複製・バックアップの消去、供給者の保持・削除条件への契約適合性。有限コマンド再実行の結果から実Workflowや環境停止時の保証を推定しない。

## 承認範囲と実施方法

今回、ユーザーから既存コード参照と専用合成領域でのオフライン検証のみ承認を受けた。製品コード、既存テスト、設定、依存関係は変更していない。本番接続、Secrets値参照、実市場データの取得・保存、常駐化、既存DB・既存MOCK・他trial・workspaceの削除は行っていない。RSS監視診断は調査対象外とした。

調査用ハーネスは `.local/retention-investigation/probe.mjs`。`.local` は既存の `.gitignore` と `.replitignore` の両方で除外済みであり、設定の変更は不要だった。これは非公開性の保証ではなく、生成物のGit・デプロイ混入を避ける措置である。

- 各実行で `mkdtemp` により `/tmp/retention-audit-<ランダム値>/trials/<UUID>` を新規作成し、`ARTIFICIAL_PROTOCOL_TEST` のみ使用した。
- 既存ライブラリを直接読み込み、既存の `DEFAULT_LIVE_ROOT` の走査・作成・削除は実行していない。
- 親ハーネスと子Nodeは `env: {}` 相当の空環境で実行。子Nodeへ認証情報を渡していない。ネットワークAPIや公開経路検査は実行していない。
- 合成約定1件を使用。SIGKILLはappend途中の4か所で実際に送信し、終了通知を待ってから別Nodeで復旧状態と削除を確認した。
- 所有者不一致はハーネス内の `lstatSync`／`fstatSync` 戻り値への限定的注入。実ファイルのchownや別ユーザーでの実行はしていない。
- EACCES／EIO／ENOSPCと削除・lease取得の順序は、ハーネス内の限定的な同期fs差替えで再現。実環境でこれらの障害が発生したという意味ではない。
- 試験後、今回作った合成領域のみ、symlinkをたどらず個別に削除。合成領域の残留は両実行とも0。他trialの代わりに今回作った合成対照trialは、試験中の内容不変を確認してから後片付けした。

既存CLIは固定の既定保存先と子プロセスを使用するため、既存領域に触れない条件を優先し、CLI全体を起動していない。CLI分岐はコード参照、保存・期限・削除の本体は専用rootを渡した実行で確認した。実CLI親子連携の完全な再検証とは区別する。

## PASS／FAIL／UNKNOWN一覧

| 確認事項 | 判定 | 根拠・制限 |
| --- | --- | --- |
| 期限の起算点と上限 | PASS（実装事実） | `createTrial` は作成時 `issuedAtMs + retentionMs`。既定は開始から86,400,000ms、上限超過を拒否する。終了から24時間への自動延長はない。終了時刻を記録しているわけではない。供給者適合性はUNKNOWN。 |
| 早期削除 | PASS（機構） | 有効期限内でも保存→別Node復旧→即時purgeが成功。親CLIはverify後のfinallyでpurgeする構造。早期削除を24時間まで延期する設計ではない。親を強制終了するとfinally実行は保証されない。 |
| 期限ちょうどの検出 | PASS | 1ms前は対象外、期限ちょうどは期限切れ。走査と新規認可で約定ファイルを開いていないことをfs呼出しで確認。 |
| 期限切れデータの復旧拒否 | PASS | 発行済みcapabilityも期限ちょうどで `LIVE_AUTH_EXPIRED`。`recoverLive` はmanifestを読んだ後、原本を開く前に拒否。metadata読取そのものを禁止するという意味ではない。 |
| Node再起動後の期限維持 | PASS | 新しい空環境Nodeを2回起動して同じ期限切れを検出し、その後の別Nodeから単一trial削除成功。再起動で期限を更新していない。 |
| Node再起動後の復旧・早期削除 | PASS | 新しいNodeで1件VERIFIED、その後の別Nodeで残留0。永続markerだけでcapabilityを復元せず、新しい明示認可を発行する。 |
| 異常終了後の削除 | PASS（確認した4点） | 部分append後、log fsync後、manifest rename前、manifest公開後のSIGKILL。死んだPIDのleaseを持つ対象も別Nodeから削除成功。全クラッシュ点・実親CLIの強制終了を網羅した主張ではない。 |
| 原本以外の既知ファイル | PASS | `live-manifest.json`、`live-manifest.next`、`live-writer.lock`、trial marker、死んだPIDの `session.lock` まで削除。rename前SIGKILLでは実際の `.next` 残留も確認。 |
| 想定外のバックアップ・ログ等 | PASS（拒否） | `data/backup.json` を置くと削除前に `TRIAL_CONTENT_REJECTED`。未知ファイルを勝手に消さないため、その場合の期限内削除は運用対応が必要。 |
| 稼働中leaseが既にある | PASS | 実際に生存する子Nodeのleaseで `TRIAL_ACTIVE`、削除せず停止。子のSIGKILL・終了確認後に削除可能。 |
| 削除開始後に新たにlease取得 | **FAIL** | 最初のunlink直前に正規の `claimTrialLease` が成功。既存削除はデータを削除してから失敗し、`session.lock` のみ残る。事前検査だけでは排他にならない。 |
| パス・symlink等 | PASS（静的な不正状態） | traversal、workspace root、root/trial/dataのsymlink、ファイルsymlink・dangling symlink・hardlink・公開権限で、試験領域の内容を変更せず拒否。 |
| 想定外の所有者 | PASS（注入）／UNKNOWN（実UID） | root・trial・原本のlstatとmarkerのfstatで他UIDを注入し拒否を確認。実UID変更、別UIDプロセス、すべてのOS権限条件は未検証。 |
| 他trialを変更しない | PASS（合成対照） | 専用領域に作った別trialの内容・権限が不変。既存trialは試験の対照にも使っていない。 |
| unlink途中のエラーと再試行 | PASS（対象障害） | 2番目のunlinkにEACCESを注入。markerと未削除原本が残る。障害解除後のpurgeで残留0。無条件の再試行成功ではない。 |
| 作成途中の異常 | **FAIL** | marker書込みにENOSPCを注入すると空の `trial.json` が残る。purgeと全trial走査はともに `TRIAL_CONTENT_REJECTED`。親の開始通知より前の失敗であり、通知だけでは対象を特定できない。 |
| 削除の最終段階の異常 | **FAIL** | marker unlink後、trialのrmdirにEIOを注入。空ディレクトリが残り、purge再試行と全trial走査が `TRIAL_CONTENT_REJECTED`。この反例では市場payloadは残っていない。 |
| 実Workflow再起動 | **UNKNOWN** | 専用有限コマンドの再起動は確認。既存Workflowは再起動していない。既存サービスへの影響回避・設定変更禁止のため、代替試験を同等のPASSとはしない。 |
| 関連Node停止中の期限内自動削除保証 | **FAIL（保証なし）** | 書込み・復旧用Node終了後、1秒の合成期限を超えて原本が存在。明示purgeで削除。無人の期限監視・停止中の削除実行者はこの有限CLIにない。 |
| Replit環境全体の停止中 | **UNKNOWN（実測）／保証不可** | 環境停止・再作成は実行していない。この有限CLIだけで外部から削除する仕組みはなく、Node停止試験のPASSや手動対応の意図から期限内消去を保証できない。 |
| 環境・サービス側の複製消去 | **UNKNOWN** | ホスト側バックアップ、チェックポイント、ストレージ下層、外部ログ等の保持・消去は本試験で検証していない。通常unlinkは物理的な上書き消去の証拠ではない。 |
| 供給者の削除条件への適合 | **UNKNOWN** | 許容期間・起算点・複製範囲等は別調査の未確定事項。開始から24時間は実装上の保守的上限であり、契約適合期限を新たに確定するものではない。 |

## 異常終了時の残留と手動対応

以下の場所は**実装上の相対位置**。今回の合成試験で生じた残留はすべて後片付け済みであり、既存保存先に同じ残留があると判断したものではない。

| 状態・原因 | 残り得るもの | 手動対応の境界 |
| --- | --- | --- |
| capture/verifyのSIGKILL | `<root>/<trial-id>/trial.json`、`session.lock`、`data/live-ticks.bin`、manifest、writer lock、場合によりmanifest.next | 該当PIDの終了を確認し、期限切れ原本は復旧・解析しない。所有者・パス・内容に問題がないと確認した単一trialに既存purgeを使う。PID再利用等で生存扱いになる場合はlockを強制解除せず停止する。 |
| 稼働中lease | 同trialのデータ一式 | 正当な処理かを運用者が確認する。無関係なPIDをkillしない。稼働中leaseを手動で削除して突破しない。対象処理停止と終了確認後に再確認する。 |
| EACCES等による途中unlink失敗 | markerと未削除のデータ。実行順によって一部は削除済み | 対象とエラー原因を確認し、権限・媒体障害を正規の手段で解消できた場合のみ同一trialのpurgeを再試行。全削除扱いにしない。現在のCLIは一般化した理由コードのみで、元OS原因や失敗時の残留数を返さないことに注意。 |
| 不正owner/path/symlink/未知ファイル | 対象を原則未変更で残す | 実体をたどって削除しない。対象の一覧・所有者・リンク情報を記録し、想定外の対象は別途対応の承認を得る。既存DBや他trialをまとめて削除しない。 |
| marker書込み途中・作成途中 | UUIDディレクトリと空／不完全な `trial.json`。後続段階によってdata作成済みの場合もある | 通常purgeは拒否する。今回の反例では空markerのみと確認後、試験所有の当該ファイルと空ディレクトリだけ個別に削除した。実運用では認可根拠のない対象を自動修復・再認可せず、独立した記録から対象を照合する対応承認が必要。 |
| marker削除後のrmdir失敗 | 今回は空のUUIDディレクトリのみ | 認可markerがないため通常purgeは再試行不能。空・本人所有・非symlink・同一trialであることを独立確認した後、承認された手動対応でその空ディレクトリだけrmdirする。中身があれば停止。 |
| 削除とlease取得の競合 | 今回は生存PIDの `session.lock` のみ。データは既に削除された | 処理を追加起動せず、該当処理との調整が必要。期限削除の成功とも安全な停止とも扱わない。修正・再検証前に本番へ進まない。 |

既存の単一trial削除CLI（**今回は実行していない**）：

```text
pnpm --filter @workspace/tickstream-poc run gate:b2b --purge-trial <確認済みの単一UUID>
```

`gateB2Process.ts` のPURGE分岐はSecretsアクセス・preflight・captureより前にある。既定保存先は `DEFAULT_LIVE_ROOT`（ユーザーホーム下 `.local/state/orderflow-lab-live`）。任意のroot指定、全trial削除、ワイルドカード操作ではない。上記手順の記載は、今回の承認外である既存データの削除実行を許可するものではない。

**削除完了の確認**は、成功応答 `deleted: true, remainingFiles: 0` と該当trialディレクトリの不存在を組み合わせる。本試験では両方を確認した。失敗時の `cleanup: null` や理由コードのみから残留数0を推定しない。期限が迫っていても安全拒否条件を解除しない。環境へアクセスできない場合、有限CLIのみで手動削除期限を保証する方法は確認できていない。

## 原本以外の調査範囲

確認したファイル書込み経路は `gateB2Process.ts`、`gateB2Session.ts` とstorageの `liveTrialDirectory.ts`、`liveAppendStore.ts`、`liveManifest.ts`、`liveStorageQueue.ts`、`liveRecovery.ts`。この経路にSnapshot、SQLite/WAL、別バックアップの生成は見当たらない。プロジェクト全体・ホスト全体に複製がないとの証明ではない。

- `live-manifest.next` は中断時に残る実ファイルであり、原本だけ消せばよいとは扱っていない。
- manifestには件数・チェックサム・trial識別・期限等が残る。約定全文と同一でなくても削除対象に含めた。
- preflightの `privacy-canary` は別の人工trialで生成され、通常はfinallyでunlink→purgeされる。強制終了では未知ファイルとして残り、通常purgeは安全拒否する可能性がある。この経路はコード参照のみで、ネットワークを伴うpreflightは実行していない。
- CLIの標準出力には開始時のtrial ID・期限、集計・復旧・削除結果が出る。子のstdout/stderrはignoreでIPCは許可項目へ絞る設計。参照した出力経路では約定原文を出力していないが、Workflow等の実ログの内容・保持・外部転送先は調べていない。
- 今回の `.local/retention-investigation/` に残したのはハーネス、合成試験の結果・メタデータと空のstderr。実市場データは含まない。これは試験対象trialの残留には数えず、調査証拠として保持する。

## 修正が必要な対象と案（実装していない）

1. **`packages/tickstream-storage/src/liveTrialDirectory.ts`**
   - `claimTrialLease` と `purgeTrial` を同じ排他プロトコルに参加させる。検査後の再確認だけでは競合窓が残るため、削除中の新規lease取得を排除する設計が必要。既存稼働中leaseの突破や無関係なPID終了は不可。
   - `createTrial` の途中失敗時も、対象と期限を独立に特定できる作成・回収手順を設計する。不完全markerを無条件に信用しない。通常削除の許可範囲を広げるだけの回避はしない。
   - marker消失からrmdirまでの失敗について、本人所有・同一trialだけを証明して回収できる中断耐性を設計する。未知・無証明ディレクトリを自動削除するfallbackは不可。
   - path検査からunlinkまでの同時差替えも考慮する。静的symlink拒否のPASSを、すべての競合に対する保証とは扱わない。この差替え攻撃の網羅検証はUNKNOWN。
2. **`apps/tickstream-poc/src/gateB2Process.ts`**
   - 作成直後より前も含め、異常終了後に単一trialを特定できる非機密の記録方式を設計する。
   - 削除失敗を他のcapture/verify理由に埋もれさせず、許可された形式で削除失敗理由と確認済み残留状態を別項目に報告する。OSエラーの生メッセージや任意パス・データをログへ漏らさない。
   - 既定rootに触れずに実CLI親子連携を合成検証する方法を設計する。安易に本番rootの任意変更を許可しない。
3. **`packages/tickstream-storage/src/liveTrialDirectory.test.ts`／`apps/tickstream-poc/src/gateB2Process.test.ts`**
   - 上記の反例、実CLI親終了、lease取得とpurgeの競合、起動中断・削除最終中断、失敗時残留報告を、専用領域だけを使う回帰試験へ移す案。今回は既存テストも変更していない。

環境停止中の期限内削除は、この修正案だけで解決したとしない。実Workflowの隔離再起動検証や、環境停止時の削除運用・実行者について別途範囲承認が必要。常駐化、新API、外部ジョブ、設定変更を今回の調査から自動承認しない。

## 実行証拠と検証上の注意

初回記録：`.local/retention-investigation/results.json`。補足記録：`.local/retention-investigation/supplement.json`。

初回のmanifest rename前SIGKILL試験で、ハーネスが復旧statusを `PUBLISH_INTERRUPTED` と誤って期待した。実装は未公開tailを優先して `UNPUBLISHED_TAIL` を返すため、試験側の期待だけを訂正し、その項目のみ再実行した。`.next` の実残留と削除も補足実行で確認済み。他の有効な確認項目は再実行していない。補足で期限切れ既存capabilityと停止後期限超過の2項目を追加した。

統合した**独立30項目の観測・反例確認は全件成立**。これは製品要件の全件PASSではなく、上表の**4つのFAILを再現できたことを含む**。実Workflow等のUNKNOWNはこの件数に含めない。ハーネスエラーの未解消は0。stderrは両実行とも空。初回の誤期待も履歴として残した。

最終ハーネスの再実行例（合成ファイルを新規作成・後片付けするため、本番用コマンドではない）：

```text
env -i "$(command -v node)" --experimental-transform-types --disable-warning=ExperimentalWarning .local/retention-investigation/probe.mjs
```

証拠SHA-256：

```text
probe.mjs       838b12cd3d0efb5742d52a1c0754fb4f69615f372dce8c1ec5f1b592898bab4d
results.json    8b1c410021183b2bab4b47e921da359eecfe959f8652e7876c7b2c0dfbb4ad3b
supplement.json 0c98de2f551b8ab4142608ee9046b85b461a54c532e5e2a53d948a0324446fe1
```

主な根拠：`liveTrialDirectory.ts` の作成・走査・lease・purge、`liveAuthorization.ts` の期限検査、`liveRecovery.ts` の認可から原本openまでの順序、`gateB2Process.ts` のworker・finally・手動PURGE分岐。許諾判断は `docs/live-storage-permission-investigation.md` と `.agents/memory/live-trial-permission.md` に従う。調査完了を保存許諾・修正承認・本番実行承認に読み替えない。
