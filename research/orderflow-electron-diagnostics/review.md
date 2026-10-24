# 批判的自己レビュー

## 修正・照合した点

- 元RSSの原因を断定しない。共有parserのstatic経路と、元試行のstack欠落を分けた。
- 同じRUNNING_RSS_UNKNOWNは旧Node計測器にもあるため、文字列を全repoで一意の起源とはしない。
- 初期kernel調査のmaps iterator/fork sourceではstatus欠測を証明できなかった。mainline v6.18のarray.c/task_mmu.c/exit.cを追加取得し、mm/EXIT_ZOMBIEの該当経路へ限定した。
- upstream6.18と現在ホスト6.18.58、元試行kernelを同一視しない。
- Stage1のcoverageは「先頭欠落」ではなく、1.33秒の品質区間が2秒bin末尾に届かないことを保存inputから確認した。
- DeltaのNO DATAをINCOMPLETEと取り違えず、UNKNOWNとcoverage不足の両issueを記録した。
- Stage1の212行は実bin行の観測件数であり、212独立Tradeや212確定Deltaと呼ばない。
- Stage0のVALID/PROVISIONALをFINALと呼ばない。frame revisionとbin訂正revisionを分けた。
- 元native PASSはparent/Stage PASSではない。元Stage FAILは保持。
- Linux exit/Node exit/stdio close/group empty/profile削除を別条件にした。
- Windows Job completion portを終了の唯一証明にしない。root suspended起動でもbreakaway等を無条件に防げるとはしない。
- Windows working set/private commit/Linux RSSを別指標にした。
- React commit/rAF/API draw/buffer deleteをpresentation/GPU完了/driverメモリ回収の証明にしない。
- Playwright導入は最小修正に含めない。experimental/close実装の未確認を明記。
- Electron release日付のsnippet/本文差を残し、version組合せだけを採用。
- 過去の1,920件を今回実行の結果として報告しない。
- Library登録による管理metadata更新を製品変更と分けて開示する。元439ファイル全件不変という不正確な主張を避ける。

## 根拠の種類

主要結論は、ローカルコード、保存input/frame/native結果、公式API/実装の三種類で照合した。API仕様に関する主要外部主張はversion固定Electron資料、Node child/process、Linux実装3ファイル、Windows Job/creation/handle/memory資料等で相互確認した。

公式API資料は仕様のprimary sourceとして使い、販促資料・第三者の未検証ブログは根拠にしない。MDNは技術referenceとしてprimary implementationと区別した。

## 残る限界

元RSS例外の対象PID/時系列は復元不能。新しい実験をしていないため元原因確定・Stage2・Windows・実GPUの実証はできない。古い資料の一般的API意味を、対象buildでの実証と混同しない。

修正7ファイルは次の承認案であって、現在の承認範囲では実装していない。新ブラウザ/正式Stage/profile削除も別承認のまま。
