# HEATMAP 今の板の山（2026-11-05）

ユーザーの決定：数字と色の帯は残し、今の板を価格ごとの枚数の「山」でも描く。形は塗りつぶしの山にする。色は売り紫・買い薄グレー。長さは画面内の最大の板を基準にする。

## 描き方（SPEC 7.2「今の板の山」）

- 山は、数字のいちばん左の手前（色の帯の終わり）を基準線にして、左へ伸ばす。数字は山の上に描く。
- 頂点は価格ごとに1つ、ティックの中心に置き、折れ線で結ぶ。
  - 片側の中で抜けている価格は0枚にする。
  - 両端の外に0枚の頂点を1つずつ置き、山を基準線へ戻す。
- 1ティックが1 CSS px 未満のときは、同じ画素の行の価格を最大の枚数でまとめる。
- 色は売り板が `#8a3cff`、買い板が `#d9d9d9`。塗りは不透明度0.5、縁は不透明で太さ1 CSS px。
- 長さは、画面内の最大の板（両側）をヒートマップ本体の幅の10%にし、ほかは枚数に比例させる。画面の外の板は基準に入れず、長さは10%で頭打ちにする。
- 過去を見ているときやリプレイでも、数字と同じく最新（再生位置）の板で描く。
- 10%と0.5は、以前の棒の初期値に合わせた固定の値。`bookBarPct`・`bookBarOpacity` は使わない（設定画面にも出さないまま）。

## 変更ファイル

| ファイル | 内容 |
| --- | --- |
| `artifacts/heatmap/src/chart/book-mountain.ts`（新規） | 頂点の計算 `bookMountains`、長さ `mountainLength`、描画 `drawBookMountains` |
| `artifacts/heatmap/src/chart/current-book.ts` | 色の帯のあと・数字の前に山を描く。metrics に `mountainPoints`・`mountainMaxSize` |
| `artifacts/heatmap/test/book-mountain.test.ts`（新規） | 試験5件 |
| `artifacts/heatmap/test/current-book.test.ts`・`phase9-revise.test.ts`・`phase10c.test.ts` | ダミーの描画先にパス用のメソッドを追加。phase10c の「棒なし」は四角（fillRect）に限定（山は同じ色のパスのため） |
| `artifacts/heatmap/tools/gpu-harness.ts` | 今の板の照合で、GPU 側にも今の板の層を重ねて比べる（山はどちらのモードでもこの層に描くため） |
| `docs/SPEC.md` 7.2・13、`docs/UI_SPEC_HEATMAP.md` 3.11 | 今の板の山を追記 |

## 確認

- `node --test test/*.test.ts`：209件合格。`pnpm run typecheck`：合格。`pnpm run build`：成功。
- `gpu-check.html` をヘッドレスの Chromium（SwiftShader の WebGL2）で実行：DPR1・DPR2 とも82項目すべて合格（今の板の block・glow・縮小時の線を含む）。
- ダミー（合成）データで、ヒートマップと今の板を重ねた画面を描いた（`docs/evidence/book-mountain/dummy-preview.png`）。拡大（25分×60ティック）と縮小（25分×240ティック）。描画に使った一時ページは消した。
- 確認に使った Vite とブラウザは止めた。プロセスがなく、ポートも閉じていることを確かめた。サーバー（`/api/ws`）は起動していない。

## 未確認・注意

- 実データ・実機での見た目は確かめていない。
- 縮小して深い板の壁が画面に入ると、その壁が最大になるため、現在値の近くの山は短くなる（ダミーの縮小画像で確認）。
