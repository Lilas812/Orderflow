---
name: TICK STREAM verification cautions
description: External SDK discrepancies and API measurement limitations that should guide future verification.
---

TICK STREAM へは Node 標準の WebSocket で直接接続する。公式 Node SDK は使わない（確定）。理由は docs/SPEC.md 第4節のとおり。

**Why:** The public source inspected during Phase 0 differed from official subscription examples and had a warning path exposing part of a credential.

**How to apply:** docs/SPEC.md 第4節に従い、Node 標準の WebSocket を使い、公式 Node SDK は採用しない。

Seconds-based history pagination can repeat a page if a page is smaller than one second's rows; blindly incrementing a second can instead lose data. End-boundary seconds and repeated timestamps need investigation, not silent repair.

**Why:** Real history book requests reproduced a stationary cursor; short sampled results also included rows within the requested end second and one doubled row group.

**How to apply:** Read the Phase 0 report before implementing replay. Preserve legitimate duplicate trades and do not assume every identical timestamp identifies exactly one complete snapshot. Holiday/weekend stale snapshots are not evidence of timestamp-unit failure or active-session update rate.

同じ時刻の履歴板が常に「同じ800行の繰り返し」とは限らない。1,600行の前後が異なる場合と、同じ時刻に2,400行ある場合を実測した。

**Why:** Phase 2aの取引時間中の取得で確認した。Phase 0の同一内容だけだった小標本を、全履歴の保証として扱うと誤った板を採用する。

**How to apply:** 1,600行はSPEC 5.5の後半採用ルールに従う。2,400行の採用方法は仕様未定のため、勝手に一般化せずユーザー判断を求める。詳細な測定結果は `server/PHASE2A_REPORT.md` を参照。
