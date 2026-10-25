---
name: TICK STREAM verification cautions
description: External SDK discrepancies and API measurement limitations that should guide future verification.
---

Do not assume the public Node SDK source matches the protocol documentation or npm package. Inspect the current source before adoption, especially subscription operation/path, JSON heartbeat replies, unit inference and credential-bearing warnings.

**Why:** The public source inspected during Phase 0 differed from official subscription examples and had a warning path exposing part of a credential.

**How to apply:** Revalidate against current provider sources. Do not install or select libraries without the user's required approval.

Seconds-based history pagination can repeat a page if a page is smaller than one second's rows; blindly incrementing a second can instead lose data. End-boundary seconds and repeated timestamps need investigation, not silent repair.

**Why:** Real history book requests reproduced a stationary cursor; short sampled results also included rows within the requested end second and one doubled row group.

**How to apply:** Read the Phase 0 report before implementing replay. Preserve legitimate duplicate trades and do not assume every identical timestamp identifies exactly one complete snapshot. Holiday/weekend stale snapshots are not evidence of timestamp-unit failure or active-session update rate.
