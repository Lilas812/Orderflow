# 上流受信停止の診断追加・隔離検証

## 実施内容

公開HEATMAPの最新価格・約定の更新停止を、受信前の無通信・サーバーの処理詰まり・ブラウザ描画に分けるための診断を追加した。今回は診断の実装と隔離検証まで。**公開環境の根因確定・遅延修正完了ではない。**

本番書込・再Publish・既存受信の停止／再起動・追加の上流接続は行っていない。30秒のwatchdog、再接続バックオフ、購読、受信内容、配信周期、保存形式、認証、GPU描画は変更していない。研究チャートは対象外。

## 変更ファイル・関数

|ファイル|内容|
|---|---|
|`server/src/diagnostics/event-loop.ts` / `EventLoopMonitor`|Node標準の有界ヒストグラムでイベントループ遅延を記録。単位ms、標本数・窓の長さ・平均・p95・最大。未観測はnull。読取ではリセットしない|
|`server/src/diagnostics/memory.ts` / `MemoryMonitor`|既存5秒のprocess_memoryログ・snapshotにeventLoopを追加。記録後に窓をリセット、終了時に監視を解除|
|`server/src/upstream/connection.ts` / `Upstream.receiveDiagnostics`, message callback, `armWatchdog`|共有WSのメッセージ数、現在接続の最終受理時刻・経過、メッセージ間隔、同期receiveハンドラー所要時間を記録。watchdogログに実経過・超過時間を追加|
|`server/src/index.ts`|既存process_memoryのactivityへ上流診断を接続。watchdog時にもイベントループのsnapshotを付与|
|`server/src/status/app.ts`|HTTP `/status` と `/api/status` に`upstreamDiagnostics`を追加。既存WS statusの形式は変更しない|
|`server/test/upstream-diagnostics.test.ts`|新規6試験。偽ソケット・時計と隔離HTTPだけを使用|
|`server/test/upstream-diagnostics-bench.mjs`|変更前ソースと修正版を別プロセスで比較する合成マイクロベンチ|
|`server/test/memory-performance.test.ts`|既存snapshotのキー照合にeventLoopを追加|

ログに受信payload、URL、APIキーは追加しない。メッセージごとのログ・全履歴走査・新規の通信はなく、状態は固定個数の数値だけ。Node標準ヒストグラムの監視用タイマーはあるが、新たなアプリ側の定期ポーリングは追加していない。

## 診断項目の意味

- `upstreamDiagnostics.scope = shared_upstream_raw_messages`。NQ・GC共通の1本のWSで、ping等も含む**生メッセージ数**。銘柄別約定件数ではない。
- `connectionSerial`, `connectionMessages`, `connectionLastReceivedUs`, `messageAgeMs`は現在接続の状態。接続を作り直すと受理時刻・間隔をクリアし、古い接続の時刻を新しい接続の鮮度として使わない。
- `totalMessages`, `maxMessageGapMs`, `maxReceiveMs`はプロセス内の累計／最大。5秒窓の値ではない。
- `lastMessageGapMs`と`messageAgeMs`は単調時計による**messageハンドラー入口の観測**。ネットワーク上の到着時刻や取引所時刻を測定しているわけではない。
- `lastReceiveMs`は同期receiveハンドラー入口から戻るまで。既存の正規化・コールバックに加え、タイマー再予約・診断処理自体の時間も含む。純粋な正規化時間ではない。
- `upstream_watchdog.silentMs`は互換性のため30000のまま。`thresholdMs`が閾値、`elapsedMs`が予約から発火までの実経過、`overdueMs`が閾値からの超過。`armedAtUs`/`firedAtUs`はログ照合用の壁時計。
- `memory.eventLoop`とwatchdogの`eventLoop`は、既存5秒サンプル間で共有するヒストグラム。snapshotを何度読んでも他の読取の窓を消さない。watchdogの診断取得だけが失敗しても`available:false / snapshot_failed`を残し、元の再接続を妨げない。
- ヒストグラムはNode標準の既定分解能を使い、平常時でも約10msの値になり得る。現在実行中の長いコールバックは、ループへ戻って観測が進むまで反映されない場合がある。**その瞬間のmaxが小さいだけでCPU詰まりなしとは判定しない。** 実経過・超過・隣接する複数の5秒窓・CPUを合わせて読む。

## 実行した確認

1. 既存上流・メモリ・CPU関連20試験は成功。
2. 全サーバー試験を直列実行：283件中282件成功、追加試験1件失敗。原因は試験内で再接続バックオフの乱数を固定せず、1000msで必ず再接続すると思い込んだこと。**製品のバックオフは変えず、試験の乱数だけ0.5へ固定**した。
3. 修正後に追加6試験を再実行し6/6成功。変更していない他の282件の合格は再利用した。最終版の全体一括283/283再走行を実施したとは記載しない。
4. `pnpm --filter @workspace/receiver run typecheck`相当のサーバー型検査、HEATMAP型検査、receiverのbuild（HEATMAP本番ビルド）が成功。
5. `git diff --check`成功。

追加6試験の確認内容：

- メッセージ間隔250ms、同期処理7msを注入し、それぞれ正しく記録。再接続時は現在接続の値をクリアし、旧ソケットの遅延イベントは不採用。
- watchdog閾値30000msに対し、単調時計45000msの発火を注入し、実経過45000ms／超過15000ms。元どおりcloseを1回要求。
- 受信処理の例外を隠さず、失敗までの12msを記録。
- 診断snapshot失敗でもcloseを要求。
- 本物のHTTPハンドラーをloopbackの動的ポートで開き、`/status`・`/api/status`が200、追加数値・未観測nullを確認。既存WS statusの上流形式は不変。終了時にHTTP接続とlistenerを閉じる。
- 実イベントループへ80msの合成停止を入れ、最大遅延50ms以上を検出。読取の非破壊性・reset・stopも確認。

## 診断自体の負荷

コマンド：

```
node server/test/upstream-diagnostics-bench.mjs c300f3d5635bdd13debd586aa1eea4e2adc97839
```

合成のcounter-only受信処理、20万イベント、各版3回、毎500件でループへ戻る。同一の2000件のウォームアップは計時外。**実際のデータ量・正規化・保存・Canvas・公開性能を再現する試験ではない。**

変更前ソースは指定commitから一時ディレクトリへ読み出し、現在の作業ツリーは戻していない。

|項目|変更前|診断追加後|
|---|---:|---:|
|20万件のCPU時間・3回平均|154.366ms|219.898ms|
|経過時間・3回平均|164.380ms|235.822ms|
|RSS中央値|91.73MiB|92.16MiB|
|採用件数（ウォームアップ込み）|202,000|202,000|
|終了状態|全3回stopped|全3回stopped|

差はCPU約65.53ms/20万件、約**0.328µs/イベント**。空に近い処理に対しては約42%の相対増加であり、「無料の診断」と扱わない。実流量でのCPU増分は未確認。

計時後に別途入れた80ms停止では、診断追加後のヒストグラム最大は**84.08 / 84.34 / 86.70ms**。RSSの差は短命な別プロセス・ランタイム・GCの差を含み、診断の実割当量を厳密に表すものではない。

生値：`server/UPSTREAM_DIAGNOSTICS_MEASUREMENTS.json`（変更前・変更後ソースSHA-256を含む）。

## 確認手順・公開反映の境界

今回はWorkspaceにコードがあるだけで、既存の公開／開発受信プロセスには反映していない。ユーザーが別途許可して反映するまでは、公開URLに新しいフィールドがなくても異常とは限らない。

許可された反映後は、同じ時刻の`process_memory`と`upstream_watchdog`、HTTP `/api/status`を照合する。受理間隔・同期receive時間・イベントループ最大／p95・CPU・watchdog超過を並べ、外部無通信とループの処理詰まりを切り分ける。欠落区間を生成・削除したり、時刻を書き換えて最新に見せたりしない。

診断は現在のMemoryMonitor起動時に開始し、既存の5秒ログで記録される。新たな環境変数や契約・設定変更は不要。戻す場合は、この診断の追加差分だけを取り除き、公開反映は別途判断する。保存形式や購入データの復元は不要。

## 仕様との差分・未確認

受信・配信・再接続仕様との差分なし。HTTP診断の追加だけで、共通設定version・WSプロトコル・依存追加なし。

本番の受信停止の根因、実端末のGPU、公開版の受信→描画、公開の実流量での診断負荷は未確認。今回の結果を遅延改善・障害解決の証拠にはしない。

## 終了確認

すべてのテスト・比較子プロセスは終了、隔離HTTP listenerは試験のfinallyで閉鎖、偽ソケットはstop/close完了。比較用一時ディレクトリはfinallyで除去。ブラウザは起動していない。新規の上流・本番接続はなし。

既存のWorkspace受信PID464と管理ワークフローは維持した。既存受信を止めない指示を優先し、ソース変更後のワークフロー再起動は行わず、隔離試験で検証した。
