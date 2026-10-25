---
name: Phase scope and approvals
description: User-approved scope and strict boundaries for the NQ heatmap project.
---

Follow the project's canonical docs/AGENT_RULES.md, docs/SPEC.md and docs/UI_SPEC_HEATMAP.md. Do not use the old chat attachments as specifications. Work on one task/phase at a time, stop with the prescribed Japanese report, and do not silently decide items marked proposed or undecided.

**Why:** The user explicitly instructed that docs/ contains the authoritative updated specifications and that old chat attachments must not be used. They approved Phase 0 only, not an all-phases implementation.

**How to apply:** Check that the canonical files exist before further implementation. If unavailable, ask for the updated files rather than reconstructing them from obsolete attachments. Directory changes, added dependencies, protected specs, behavior changes, data formats, persistence and deployment require prior explanation and permission. Follow the user's supplied replit.md instructions rather than generic scaffold guidance.

The user approved a dependency-free Node WebSocket probe, a 60-second live observation, two one-minute historical windows, a script under scripts/src and a Phase 0 report. This is not blanket permission for later phases or production technology decisions.
