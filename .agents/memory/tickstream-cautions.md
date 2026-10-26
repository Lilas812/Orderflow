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
