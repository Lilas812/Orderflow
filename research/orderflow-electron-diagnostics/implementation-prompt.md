# 次工程用・実装承認案

以下はユーザーが次に承認するための指示案です。今回の調査では実行していません。

---

# Orderflow Lab — Electron診断の終了・資源監視・scenario品質契約修正

## 目的と範囲

既存Stage 1の`RUNNING_RSS_UNKNOWN`について、原因を推測で決めず、監視・終了・失敗証跡保存を分離する。同時に、既存Stage 1の正しいDelta null/NO DATAを、scenarioに対応する厳密な描画ゲートで照合する。

今回は**診断コードの限定実装とオフライン回帰だけ**を行う。新しいElectron/Chromium起動、正式Stage、負荷試験、旧profile削除は別途承認とする。

## 変更可能な7ファイル

- `apps/desktop/diagnostics/run.mjs`
- `apps/desktop/diagnostics/native.cjs`
- `apps/desktop/diagnostics/verify.ts`
- `apps/desktop/diagnostics/processMonitor.mjs`（新規）
- `apps/desktop/tests/processMonitor.test.ts`（新規）
- `apps/desktop/tests/deltaQuality.test.ts`（新規）
- `apps/desktop/tests/diagnostics.test.ts`

それ以外の変更、新schema、新依存、lockfile、設定変更が必要なら停止して追加承認を求める。

## 最初に固定するもの

1. 現在のbranch/HEAD/worktree、上記以外の製品・設定・依存SHA、既存E2/C5-R1/A4/Task29-A証跡SHAを新規専用directoryへ記録する。
2. 参考基準はmain / `2c6508edfd7db374949e8de268381d6c571c723e`。現在と違えば差分を調査し、勝手に戻さない。
3. `.agents/agent_assets_metadata.toml`の調査asset登録は管理metadataとして分類する。製品や測定条件に影響しなければこれだけで自動HOLDにしない。手動変更/復元はしない。
4. Stage 0/1の固定最終hashは以下。新実装に合わせて変更しない。
   - `43381470710c96324277770fbbd7bb8e13c896dbbc7faa4a649b0af36211dbf2`
   - `9cbb07c3c30844482ca76e6871bc584578006192cdbbe07e1603d62031a38763`
5. 残留`/tmp/orderflow-a2-1-uxLSPu`は触らない。既知のinode等は調査資料であり、削除承認や元作成時の所有証明の代わりではない。

## 実装契約A：process monitor

- 所有identity、生存確認、RSS/CPU観測を分離する。identityを得るためにVmRSSを必須にしない。
- identityにはpid/ppid/pgid/sid/uid/startTicksを持ち、候補列挙と現在readの間の不一致、PID再利用、ENOENT/ESRCH、EACCES、parse異常を区別する。
- read-check-signalのTOCTOUが完全になくなったとは主張しない。pidfd/native adapterは今回実装しない。
- 生存中RSS不明はFAILのまま。RSS未取得を0、exit確定、PASSへ変換しない。
- 退出遷移の欠測は、phase、identity、stat状態、read順序、exit/close等を残して既存wall内で有限に確認する。STOP要求/markerだけで退出証明しない。証明不能ならFAIL/HOLD。
- 「Z/X」「保持したchild終了証拠」「group空」を別々に扱う。exit/close/group空を同一視しない。
- spawn/error/exit/closeリスナーを最初のawait前に登録し、早期終了とspawn失敗を取りこぼさない。
- 所有関係不明のprocessにはシグナルを送らない。既存graceful-firstを維持し、新たなSIGKILL経路を追加しない。
- 24 process、2GiB、既存wall・標本数・file/total予算を変更しない。

## 実装契約B：shutdownと証跡

- 正常完了、SIGTERM、wall timeoutの入口を、診断専用のidempotent shutdownへまとめる。
- 新しい親子制御が必要なら診断専用の固定message型・trial identity・小さい有限容量に限定する。任意実行・任意ファイルAPIは禁止。
- pump停止、session/React/observer/layoutの解放、native証跡保存、quit、stdio drain、group空、profile回収を順序付きに観測する。
- `app.quit()`は任意async listenerを待つと仮定しない。`app.exit()`を使った場合は通常quit lifecycleを通ったと偽装しない。最終exit codeとnative FAILの両方を親が検査する。
- parentがSTOPを送る前にfailure receiptを保存する。profileはspawn前にpath/inode/dev/uid/mode/symlink確認をreceipt化する。
- 主例外、cleanup例外、evidence例外を別フィールドで保持する。phase/targetPid/cause/stack/read順序を失わない。
- `finally`後のgroup/read/profile処理が結果保存を飛ばさない構造にする。失敗Stageも集約配列に存在させる。
- writerが失敗した場合は証跡完全性FAIL、CLI nonzero。成功を捏造しない。
- 新出力先は明示指定・exclusive・専用directoryに限定し、既存A4等を上書きしない。無限appendは禁止。
- profile削除は当該新規trialの作成時receiptと現在path/inode/owner/symlink一致、所有group空が成立した場合だけ。今回のオフライン試験では専用一時領域の人工profileだけを対象にする。

## 実装契約C：Delta scenario gate

- `verify.ts`の全Stage一律`validBins>0`を、事前宣言したscenario別の品質/描画契約に置き換える。
- 単にゲートを消す、UNKNOWNを0にする、品質区間を伸ばす、fixture/referenceを書き換えることは禁止。
- 既存`deltaDrawingGate()`の全数量・品質・revision・時間/価格座標・実Canvas API照合を再利用し、弱めない。
- Stage 0：数値Delta/known-zeroの実描画が必要。
- Stage 1：実withheld binが必要。最終B83/S64/U57/Vraw204、Delta=null、V=null、NO_TRADE_COVERAGEとINCOMPLETE_CLASSIFICATION、固定意味状態hashを維持。placeholderだけでは通さない。偽0/+19や余計な数値barを拒否する。
- Stage 2：既存固定500入力とreferenceから各prefixを照合する。L2 GAP/RESYNCING/Snapshot復旧はTRADES品質復旧と別。実行していないStage 2を実機PASSにしない。
- global revision、bin訂正revision、layout generation、Canvas/context identityを分ける。
- frameの同prefix/query再生だけを独立oracleと呼ばず、既存独立reference・具体値回帰・実描画照合を併用する。

## 最低限のテスト

### monitor / orchestration

- 生存・Z/X・mm/RSS欠測・退出移行・ENOENT・権限拒否・不正stat。
- 初回identity失敗、interval失敗、stop時失敗、drain/final group失敗。
- PID/startTicks/membership変更、所有者不明へのsignal拒否。
- spawn error、exitが初期await前、exit後stdio未close、close timeout。
- graceful終了、STOP重複、wallと正常終了の競合、native結果不足。
- cleanup/profile検証/削除拒否/writer失敗でも元のfaultとStage FAILが残る。
- group空なしでprofile削除しない。別trial/symlink/inode変更対象を削除しない。
- cleanup成功でRUNNING RSS欠測のFAILをPASSへ戻さない。

fake OS / fake ChildProcess / fake clockを使い、正式driver全体のimportや自動起動を避ける。新しい実Node子プロセス試験が必要なら、その実行範囲を先に報告して承認を求める。

### Delta

- 正負/known-zero、UNKNOWN qty0/正数、coverage不足、GAP、empty。
- Stage 1正しいnullは受理、不正0/+19は拒否。
- placeholder偽装、余分/重複/欠落bin、余分な数値drawを拒否。
- global/bin/layout revision取り違え、Canvas identity違いを拒否。
- L2復旧でTrade品質を勝手に回復しない。
- 既存固定input/reference/hash、bigint/ns境界、既存期待値を維持する。

## 実行順

1. SHA/worktree/証跡を固定。
2. 新規pure monitorとfault injection tests。
3. parent/nativeへの最小配線、scenario gate。
4. 関連単独テスト。
5. 既存desktop/web/core/render回帰、`pnpm typecheck`、`pnpm build`、`git diff --check`。
6. root/storage全体回帰を行う場合は範囲を明示する。既存の時間依存失敗は原因を記録し、timeout/skip/期待値を変更しない。
7. final SHA/差分/既存証跡不変を確認して停止。

通常起動/build/testからElectron診断や本番接続が自動起動しないことを確認する。

## STOP

許可7ファイル以外の変更、新依存/設定、製品API改変、計算/reference変更が必要な場合、またはテストFAILが承認範囲内の明白な修正で解消しない場合は停止する。

オフラインPASS後も新しいElectron smoke・Stage 0/1/2・旧profile削除は実行しない。結果を報告し、その実行承認を別途求める。

TickStream、Secrets、実市場データ、Gate B-2B HOLD解除は禁止。

## 完了報告

変更7ファイル、追加/既存テスト件数、失敗も含む全結果、typecheck/build/diff、終了state遷移、RSS欠測分類、証跡保存、profile保護、Delta品質/描画契約、SHA不変、UNKNOWNを報告する。

元A4の原因不明を「再現済み原因確定」へ書き換えない。元Stage 1 FAILも保持する。
