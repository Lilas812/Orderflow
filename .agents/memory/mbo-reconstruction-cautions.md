---
name: MBO reconstruction cautions
description: Historical CME MBO snapshots and limits of comparisons with saved one-second boards.
---

## スナップショットの元注文時刻を再生時計にしない

Databentoの日次MBOスナップショットのts_eventは元注文の更新時刻で、取得開始より古い場合がある。生成時刻・snapshotフラグ・イベント完了を確認し、元時刻でソートし直さない。

**Why:** 原注文時刻を現在の生成時刻と取り違えると、初期化を落としたり、過去へ板を挿入したりする。提供元のsnapshot仕様による。

**How to apply:** 過去MBOの初期化と研究用時刻の設計時に、公式snapshot仕様を確認する。人工的なsnapshotの受信時計を実ライブ到着の証拠とは扱わない。

## 抽出後のsequenceの飛びは欠落の証明にならない

限月を抽出した系列では、他instrumentの番号が除かれる。回復不能な板欠落の提供元フラグと、単なる前方ジャンプを分ける。

**Why:** チャネルの番号を単一限月の連番とみなすと、正常な抽出を大量の受信欠損と誤認する。

**How to apply:** 欠落の結論には品質フラグ・初期化・注文整合の根拠を併記する。

## 明示MBOと保存板の同一性を数量照合だけで保証しない

明示注文のMBOと、impliedを含み得る別配信元の板は一致するとは限らない。追跡できる注文状態を据え置いた1秒列は、その秒に実メッセージを受信した証拠でもない。

**Why:** 約定の完全一致や密な秒列だけでは、板の構成・限月・サンプリング・実到着の同一性は証明できない。

**How to apply:** 研究入力へ統合するときは由来・時刻基準・品質マスクを分離し、比較元の限月不明を推測で確定しない。根拠と実例はdocs/MBO_RECONSTRUCTION_REPORT.mdを参照。

## impliedのschemaを区別する

2026-11-05に確認したDatabentoのGLBX.MDP3公式資料は、realとimpliedの結合最良気配をCMBP-1/CBBOとして説明している。通常のMBO/MBPとconsolidated schemaを混同しない。side=Nのimplied約定だけではresting bookへの包含を証明できない。

**Why:** 配信元やschemaの区別を省いて「MBPならimpliedあり」と一般化すると、別ベンダーの板との不一致原因を誤って確定してしまう。

**How to apply:** 比較するschemaごとの公式定義を再確認する。TICK STREAMのL2/Symbols公開文書はfull snapshot・約7Hz上限のcoalesceを説明するが、今回implied包含は確認できなかった。詳しい未確定条件と照合方法は `docs/GC_BOARD_ALIGNMENT_DIAGNOSIS.md` にある。
