---
name: デスクトップ製品方針
description: Windows 11向けElectron製品と既存Web検証基盤の位置付け
---

最終ターゲットはWindows 11のElectronデスクトップ版Orderflow Lab。既存React・WebGL2・AnalysisHubを再利用し、計算・描画エンジンを二重実装しない。Web版は引き続き動作する実装・検証基盤として維持する。

**Why:** ユーザーがWindowsデスクトップ版を最優先成果物とし、既存資産を再利用するElectron外殻の実装を明示承認した。

**How to apply:** 過去のR16有限MOCK工程に対するElectron未承認は、その工程の範囲制限であり、別途承認されたデスクトップ外殻まで禁止するものではない。保存・接続・負荷試験の承認を外殻の承認から推定しない。

診断用Canvas寸法をデスクトップ全体の固定寸法へ流用しない。Linux／仮想displayで実際に起動しても、Windows固有動作の保証にはならない。

**Why:** ユーザーが過去の再現性検証条件と実製品の表示仕様、Replit上のLinux検証とWindows実機検証を区別するよう指定した。

**How to apply:** リサイズとDPRを既存座標系で確認し、Windows実行・配布物・実モニターDPRなど未検証項目はUNKNOWNとして残す。
