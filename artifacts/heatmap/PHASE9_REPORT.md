# Phase 9：ツールバー・設定画面・設定の保存

## 事前作業の報告

- 実施内容：添付指示を読み、許可された仕様書2件の完全コピー・SHA-256確認・対象添付コピーの削除を行った。Phase 7・8の追加指定の反映箇所と実装を確認した。アプリの機能実装はまだ開始していない。
- 変更ファイル：`docs/SPEC.md`、`docs/UI_SPEC_HEATMAP.md`（指定の完全コピー）、この報告書、`replit.md`のCurrent Status。メモリは、以前の口頭指定が正本へ反映されたことを明記する。
- 確認手順：下のSHA-256を再実行して指定値と比べる。実装計画と未決定の扱いを承認後に機能実装へ進む。
- 実行した確認：指定3ファイルのSHA-256すべて一致。Phase 7・8報告、VPのL境界、取得不足の差し込み処理、ブラウザのライブ保持処理をコードと照合した。今回テスト・型検査・ビルド・画面撮影は未実施。
- 仕様との差分：今回正本に反映されたPhase 7・8の指定事項について、確認した実装との相違は見つからなかった。網羅的な再試験をした意味ではない。
- 未解決・懸念：設定APIのエラー形式・updatedAtの単位、壊れた設定ファイルがある状態での保存、既存URL `tz` の扱いは計画に含めて承認を求める。画面の管理workflowはポート25028競合で起動失敗しており、着手時に重複プロセスを切り分ける。Run設定は変更しない。
- 次の候補：承認されたPhase 9の実装だけを行う。Phase 10へは進まない。

## 仕様書の配置・ハッシュ・削除

| 元の添付 | 配置先 |
| --- | --- |
| `attached_assets/SPEC_(15)_1793122701662.md` | `docs/SPEC.md` |
| `attached_assets/UI_SPEC_HEATMAP_(9)_1793122700503.md` | `docs/UI_SPEC_HEATMAP.md` |

```text
d5b17d644de34c2ff7eb92f70d2e277e25c3d1bfc4b9055b411e77f3aef0f811  docs/SPEC.md
c4a5ffbfc75feef940b161b966f7bf8e74e741fcfefb3b77b49f13cd636b4bbc  docs/UI_SPEC_HEATMAP.md
28d8eb6a7a68ea51137a2e17f840ceedb6b7f5e58d807c5defa4b84e6fb2539c  docs/AGENT_RULES.md
```

AGENT_RULESは変更していない。`attached_assets/`を検索した時点でSPEC・UI_SPECから始まる.mdは上記2件だけであり、一致確認後にこの2件だけを削除した。プロンプトや保存データは削除していない。

## 事前のサーバー停止

調査時点で既存Run由来のAPI PID33415が稼働し、上流open・再接続0だった。承認待ちの余分な受信を続けないためSIGTERMで停止した。

- 02:41:02.764 JST：`shutdown_requested`、signal=SIGTERM。
- 02:41:03.610：実上流close1006、`upstream_stopped`のsocketClosed=true。
- 02:41:04.002：保存flush終了、pendingColumns/pendingTradesとも0、storageError=null。
- 02:41:04.018：`server_stopped`、httpClosed=true。
- 02:41:04.277：PID消滅・8080閉鎖を確認。検証ブラウザはこの事前作業では起動していない。停止時の下流接続0。

証拠：`data/phase9/preflight-status.json`、`preflight-stop.json`。停止時の1006は既知の未解決事項であり、正常close1000を確認したとは書かない。
