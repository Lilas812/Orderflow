# GCZ6 N約定リサーチ・確認結果

## 実施内容

独立した研究用プレビュー `/gc-n-research/` を追加。既存のHEATMAP・FOOTPRINT・LONG VP、
受信サーバー、元の購入データは変更していない。本番書込・Publish・追加の上流接続なし。

## データ

- 読取元：既存 `data/unknown-side-analysis/raw.sqlite` を `mode=ro` で再利用。
- GCZ6アウトライトだけ：2,009,413件・2,908,774枚。
- そのうちN：17,533件・26,698枚。プロファイルはNだけ。
- ローソク足はB/A/Nすべての実約定から、ts_event順、同時刻では既存行ID順で生成。
- 23セッション、30,350本。UTC購入範囲 `[2026-09-30 00:00, 2026-10-30 00:00)`。
- CT17:00で区切り、終了側の日付で表示。週末は直前の実在セッションを選択。
- 9/30は冒頭2時間が対象外、10/30は冒頭2時間のみ。9/30には購入済みの前セッションがない。
  いずれも画面で明示し、未取得データ・無約定の足を生成しない。
- 元SQLiteのSHA-256は前後とも
  `880948e893f86198ce2842c4d248859da5b143b63f2ec456dcc06e7e06850305`。
- 既存 `sessions.json` のGCZ6日別N件数・枚数と一致。
- 生成JSONはGit対象外の派生キャッシュ（約4MiB）。別環境ではREADMEの手順で再生成する。

## 画面と操作

- 1つのCanvasで左右に同一の価格変換・描画上下端を使用。価格ズーム・上下移動も共通。
- 左に前セッションN数量の横棒、右に選択セッションの1分足。ライン本数・数量下限を変更可能。
- ラインは前セッションの数量上位だけから選択。同数量は高い価格優先（既存研究と同じ）。
- 初期値は上位3本・最小1枚・1tick（0.1ドル）。価格帯単位の集約も変更可能。
- 初期表示はセッション全体。時間／価格ズーム、左右／上下移動、ホイール・ドラッグ、
  CT/JST切替、クロスヘアと足のOHLC・件数・数量表示。
- データのない日付は「利用できません」と表示し、別日の足・ラインを表示しない。
- ファイルごとのクエリキー・中断signal・session一致検査で日付変更時の応答を分離。

## 実行した確認

1. `python artifacts/gc-n-research/scripts/export_research.py`
   - 上記全数量・日別数量、元データSHA前後一致を照合して成功。
2. `python -m unittest discover -s artifacts/gc-n-research/scripts -p 'test_*.py' -v`
   - 4件合格：CT17:00・DST、OHLC・正当な同一内容約定・空白分、
     週末・前日限定、不正入力の明示的失敗。
3. `node --experimental-strip-types --test artifacts/gc-n-research/scripts/research.test.mjs`
   - 4件合格：閾値・順位・価格帯数量保存、実ファイルの前日限定、分足ギャップ、CT/JST日付。
   - 10/16表示時の前日ラインは4162.5=22枚、4175.7=17枚、4178.4=14枚。
4. 独立研究アプリだけの型検査・ビルドに成功。
   - scaffold既存tooltipのsource map警告あり。ビルド失敗・実行時例外ではない。
5. ネイティブCDPによる実Chromiumの操作確認に成功。
   - 実データ4162.5=22枚を表示。
   - 時間拡大・左右移動・共通価格拡大で実表示範囲が変化。
   - 上位本数を1にして1本、最小数量を100,000にして0本へ反映。
   - 10/5選択で10/2の前日プロファイル、10/4指定で空表示・利用不可。
   - JST切替、402px幅・DPR2でCanvas 1440×800、CSS高さ400pxを確認。
   - 確認ブラウザPID2060は `Browser.close` 後に終了を確認。
   - スクリーンショット用Chromium PID1344も終了。終了確認時の稼働Chromiumプロセスは0。
   - 既存製品の接続ログは`/api/ws connected:0 / totalConnections:0`。
     研究ページは製品WebSocketへ接続しない。研究ページ配信用の独立workflowだけを稼働状態で残した。

## 画面証拠

- `evidence/session-desktop.jpg`：全セッション、前日プロファイル、両ペインの同一価格ライン。
- `evidence/mobile-verified.jpg`：モバイル修正後、実Canvas描画とJST表示。
- 最初のモバイル確認では高さが0になる問題を検出。研究ページのCanvasコンテナに
  最小高さを設けて修正し、上記実ブラウザで描画サイズと画素を確認した。

## 未確認・境界

- 実市場の支持抵抗・優位性は判定していない。反発率の再検証もしていない。
- iOS Safari実機・タッチジェスチャーは未検証。小画面では横スクロールとボタンが利用可能。
- 元データの完全性を取引所公式総量で再証明したものではない。
- 派生データだけのローカル研究ページ。製品のライブ接続や保存復旧を変更していない。

## 追加：レンジバー俯瞰（2026-11-05 UTC）

対象・定義・保存契約は [RANGE_BARS.md](RANGE_BARS.md)。
以下は既存の日別・期間俯瞰の検証とは独立した追加確認。

### 自動検査

- Python既存4＋新規生成8、Node既存23＋保存/API5＋原約定の表示位置2＝42件合格。
- 幅ちょうど、飛び値、次の約定から次足、セッション/coverage境界、取得済み無約定時間、
  同時刻/sequence/同一キーの安定順序、N、部分足、初出極値、原約定順の候補を確認。
- 保存はCRUD/繰り返しundo/再読込/独立読取、CAS同時更新・stale revision、
  破損・保存失敗・ロック・契約/パス/由来不正・cross-origin拒否・CSV/JSONを確認。
- `pnpm --filter @workspace/gc-n-research run typecheck` 合格。
- `PORT=20373 BASE_PATH=/gc-n-research/ pnpm --filter @workspace/gc-n-research run build` 合格。
  既存tooltipのsource map警告は非致命的で、今回修正しない。

### 本番成果物と保全

通常ビルドの `dist/public` はHTML 1、JS 1、CSS 1のみ。
新画面/API文字列、限月名、購入JSON、マークの混入なし。
本番previewの `range-bars` / `range-api/marks` / `research-data/index.json` は
いずれもHTTP200のSPA用HTMLで、JSON/API/新画面ではない（404とは報告しない）。
検査用preview PID3072は終了し、所有プロセス0・20474ポート閉鎖を確認。
起動時PORT指定がなかった最初のpreview試行は起動できず、PID2971系列も残存0。

原本・購入世代・既存ローカル研究JSON・製品コード・v1保存・仕様正本・artifact定義は変更しない。
初回push前は `.replit` と開始時のMBOツールが開始時のローカルcheckpointとbyte一致。
最終同期では追加指示に従いMBOツールをメイン側の現在版とbyte一致で保持し、旧ローカル版へ戻していない。
下記のキー削除指示より前の復元調査時点では、`.replit` は復元開始前・メイン側・GitHub側とのbyte一致を維持し、変更していない。
`.replit` の既存差分は `[userenv.shared]` の `DATABENTO_API_KEY` 値の差替え1行だけ
（旧値/新値とも非表示）。研究実装より前の、環境設定とMBOツール追加をまとめたcheckpoint由来。
記録だけでは設定UIの操作や担当者までは断定できない。
設定65ファイルの読取パターン検査では、既知の同項目以外の平文秘密は検出しなかった。
これはパターンで認識できない秘密の不存在証明ではない。この調査時点ではキー設定は変更していない。
その後、ユーザーが旧キーを無効化し、削除を明示承認したため、
`[userenv.shared]` の `DATABENTO_API_KEY` 1行だけを削除してGitHub mainへ反映済み。
他の`.replit`行は変更していない。過去の公開Git履歴そのものは書き換えていない。
Secrets再登録後の2026-11-05 18:32 UTCには研究Viteだけを追加で1回再起動し、
取得処理へ渡るキーが旧値と異なることと無料見積APIの認証成功を確認した。
新しいキーは設定ファイル・通常環境変数設定・Gitへ追加していない。
この再起動では研究Vite PID307→8271、開発receiver PID477は継続。
MBP-10の購入・照合結果は `docs/MBP10_CHECK_REPORT.md` に記載。
完了同期では研究説明・検証記録の競合を、訂正済みの再起動履歴を保つ形で解消した。
同期直後の全ファイル内容は、照合済みGitHub版f56649cとbyte同一であった。
研究Vite PID8271のみ同期中一時停止・再開し、receiver PID477は継続。
この同期での追加のVite再起動ログはなく、共有preview経路でも新画面HTTP200、
保存APIはJSON revision12・マーク0件を確認した。次時間の約定保存確認は指示により不要。

### 初回の研究再起動と受信証拠（最終回数は末尾の訂正を参照）

- 研究pnpm148→Vite307と、製品pnpm142→shell476→receiver477が別系列であることを直前照合。
- 16:45:34 UTC、Vite設定の変更による自動再起動1回。手動再起動は実施しない。
  Vite内部のserver再起動のためPID307は不変。receiver477・共通監督も不変。
- 公開側の別VMはPID55・上流connectionSerial40。再起動前の板件数は
  16:41:29→16:44:29 UTCでNQ184617→185120、GC163713→164183。
- 再起動後は16:47:29→16:48:29 UTCでNQ185653→185827、GC164676→164848。
  disconnect/reconnectはいずれも39のまま。板の記録を約定件数と取り違えない。
- App Storageはread-onlyで既存prodオブジェクトだけを確認。
  対象の次時間は11/05 17:00〜18:00 UTCで、16:46時点は未開始、時間ファイル未存在・coverage未確定。
  ユーザー承認により確定後に追記する。取得済みや受信停止と断定しない。
  再確認コマンド：
  `node --experimental-strip-types artifacts/gc-n-research/scripts/range-storage-evidence.mjs 1793897128907000`
  元オブジェクトを書き換えず、結果はGit除外の `data/research-range-bars/storage-evidence/report.json`。

### 画像

`data/research-range-bars/evidence/preview-desktop.jpg` でNQ40ticks・47,293足の月全体を確認。
画像取得ツールが残した所有Chromium PID3186系列を終了し、子を含め残存0を照合。
ブラウザの撮影応答だけを終了証拠とせず、closure JSONも同ディレクトリへ保存した。
操作検査・PC/スマホ別画像・フレーム測定の結果は同ディレクトリの `browser-results.json` に追記する。

### ブラウザ操作と性能の結果

所有Chromiumの独立した2つのBrowserContextで、次を確認した。
実機端末ではなく、Linuxのheadless ChromiumによるPC/スマホ幅・DPR・合成タッチである。

- 作成・編集・削除・取り消し・再読込・別contextの同じマーク/基準メモ・5秒同期。
- 古い編集revisionへのHTTP409と競合表示。別端末の変更を無言で上書きしない。
- 最初の操作スクリプトは再読込完了前に次の編集へ進み、正しく保存を拒否された。
  UIの再読込完了待機を補い、未確認だった編集以降だけを再開して成功。
- CSVの整数us、JSONの全履歴・由来・キー一致。テストマークは削除し基準メモを空の初期状態へ復元。
  テスト履歴は保全されており、現在マーク0件・revision12。ユーザーのマークを削除していない。
- NQ40→80ticksに変更しても同一ref/ID/表示位置を保全。
  使用した最初の40tick足の高値は80tick足の高安どちらでもないことも派生出力で照合。
- CT/JST、初期OFF補助線、出来高切替、前後セッション、全期間フィット、2点定規。
- スマホ相当ではCDPの異なるIDを持つ実際の2本の合成指入力で拡大を確認。
  実iPad/Safari、物理端末間の通信は確認していない。
- 既存開発 `research-data/index.json` はHTTP200のJSONでsessionsが残っている。

生成数量照合：NQ10,104,515件・買6,985,852/売6,981,940/N1,476枚、
GC2,009,413件・買1,437,096/売1,444,980/N26,698枚。
各506個の原約定ファイルとcoverage/rebuildを最終再ハッシュし、固定manifestとの不一致0。
初期足はNQ47,293本、GC22,591本、どちらも23セッション。

各条件につき120回、月全体フィット・出来高ON・補助線OFFで強制描画。
スクロール操作の応答時間や実機のフレームレート保証ではなく、
requestAnimationFrame間隔とCanvas描画命令処理の別測定である。
各銘柄の初期幅、足数、表示区間、画面/DPRを固定した。別contextの基準ポーリングは継続している。

| 条件 | 画面 / Canvas CSS / DPR | 足数・幅 | rAF中央値 / p95 / 最大 ms | 描画中央値 / p95 / 最大 ms |
|---|---|---|---|---|
| NQ PC | 1440×1100 / 1399×470 / 1 | 47,293・40ticks | 16.7 / 16.8 / 16.8 | 4.5 / 7.6 / 10.8 |
| NQスマホ相当 | 402×874 / 384×380 / 2 | 47,293・40ticks | 16.7 / 16.7 / 50.1 | 3.6 / 5.2 / 45.4 |
| GC PC | 1440×1100 / 1399×470 / 1 | 22,591・20ticks | 16.7 / 16.8 / 16.8 | 2.8 / 4.1 / 14.0 |
| GCスマホ相当 | 402×874 / 384×380 / 2 | 22,591・20ticks | 16.7 / 16.7 / 16.8 | 2.4 / 4.2 / 10.7 |

NQスマホ相当には50.1msのrAF外れ値があり、最大値を隠して「常時60fps」とはしない。
NQ40のPC標本は最初のpass、残りは未確認部分の再開passで取得。標本は混ぜて再集計していない。

画像（Git対象外、研究データとともにprivateなdata以下）：
- `evidence/nq-month-desktop.jpg` / `gc-month-desktop.jpg`
- `evidence/nq-zoom-desktop.jpg`
- `evidence/nq-mobile-chart.jpg` / `gc-mobile-chart.jpg`：チャートへスクロールした402px幅の全期間。
  スマホ全ページツール画像は生成待ちを撮ったため、合格画像としては採用しない。

終了証拠：操作用PID3397・3761、画像専用PID4317はいずれもexit0、
各所有プロセス残存0・CDP19488閉鎖。画像ツールPID3186・4092系列も終了し残存0。
最終のps照合でもChromium残存0。元からある製品画面の接続は切断していない。
操作スクリプトの最初の失敗と再開成功を、それぞれbrowser-results-first-pass.json/browser-results.jsonで区別する。
`chart-image-results.json` は再テストではなく静止画取得だけの終了証拠。

### 公開状態の限界

既存公開アプリはReserved VM、ビルド成功・招待者限定。研究変更をPublishしていない。
既知の公開研究URL/旧JSONは未認証GETで認証へ307転送。認証後の配信有無は未確認。
新ビルドの保護を、既に稼働する旧公開ビルドからデータが消えたという意味には使わない。

## 完了同期と復元の訂正・追記

最初の完了処理はメインへの同期で止まり、研究とは無関係な開始時checkpointの
`scripts/mbo_dbn.mjs` add/add競合を生じた。同時にVite設定の一時チェックアウトによる
17:04:44 UTCの予定外再起動があった。同期中断・設定復帰の17:07:44にも自動再起動が
あったことを後のログで確認した。したがって初回の「1回のみ」を最終回数とは扱わない。

ユーザーが追加1回の復元を明示承認した後、研究Vite PID307だけをSIGSTOPで一時停止。
製品receiver PID477・研究pnpm/共通監督は操作していない。
競合はMBOツールをメイン版そのままで保持し、memory indexの両方の項目を保全して解消。
研究コードと保護対象は検証済みGitHub版と一致し、`.replit`内容も不変。
SIGCONT後17:16:52 UTCに追加の自動再起動1回を確認。最終のログ上の総計は4回。
今回の復元中に手動のworkflow再起動や、さらに追加の再起動は行っていない。

復元後の確認はブラウザを新しく起動せずHTTPで実施：
- `/gc-n-research/range-bars` HTTP200。
- 配信されるAppモジュールにDEV専用range-barsルートが存在。
- `/gc-n-research/range-api/marks` HTTP200、JSON revision12・マーク0件。
- 同一originの古いrevisionによる書込要求はHTTP409。前後のrevision12は不変で、
  保存データを変えずに保存APIの競合判定応答を確認した。
- 根拠はGit除外の `data/research-range-bars/restoration.json` / `restored-http.json` と研究workflowログ。

同期後の履歴はGitHubへの研究専用1コミットとは異なる（メインプロジェクト側で再適用されたため）。
研究・設定・MBOの内容差を照合し、rootの同期由来commitをGitHubへpushしない。
GitHubへの追記は別の安全な作業ツリーから、この訂正と運用上の教訓だけを通常pushする。
新規送信オブジェクトは再度秘密パターン検査し、`.replit`変更を含むcommitは送らない。
