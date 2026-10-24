---
name: Root NQ観測の意味論と承認境界
description: 自動ロールrootを個別限月と混同せず、人工データ限定のデスクトップ経路を扱う
---

root NQを、推定した個別限月・取引所session付きの正規イベントに付け替えない。ローカルの接続世代・受信順序番号を取引所session・provider sequence・Trade IDへ読み替えない。

**Why:** ユーザーは限月・品質を偽らないことを要求し、人工データ限定のLIVE受理・IPC・既存4表示への配線を承認した。公式Symbols資料はrootの自動ロールと個別限月を直接指定できないことを説明しており、一般資料だけで各frameの限月やsessionを確定できない。

**How to apply:** 限月・session・完全性の根拠がない場合は未解決として保持し、既存正規イベント契約を満たしたように装わない。約7Hzのcoalesced全SnapshotからTWAの完全coverageを推測しない。人工データ検証の成功を実接続・権限確認・Windows保証へ格上げしない。接続・保存の許諾境界はlive-trial-permission.mdを参照。
