## Decided - the owner's answers of 2026-11-07

Decisions, not open questions; this entry is deleted when the last one is carried out.

**Carried out and pruned (batch 24, 2026-11-12):** WP-D2 shipped as decided (#3115) and the
Dependances panel was cleaned up (#3125), both first in the stable `v1.6.7`. The live chat's two axes
are built: the arrival lines (#3126), and its readability over the video with the host marked
([live](../frontend/modules/live.md#the-chat-readable-over-the-video-and-the-host-mark-2026-11-07)).

- **Read-only production queries**: the lead may run read-only `SELECT` and `EXPLAIN` on the
  production database over SSH for the readings its chantiers need (the engagement thresholds, the
  daily cap, post-deploy readings). Never a write, never a schema change: anything else is still the
  delegation of [2026-11-03](owner-decisions-of-2026-11-03-evening.md).
- **Le Cercle**: the lead merges and releases its merge requests after an adversarial review and a
  green pipeline, and reports afterwards.
- **The engagement chantier ships work package by work package**, each to production after an
  adversarial review, a pass on dev and a phone reading, without waiting for the owner. The
  decisions themselves are in the engagement design page (`docs/wiki/engagement.md`, PR #3119, decisions 1 to 14).
