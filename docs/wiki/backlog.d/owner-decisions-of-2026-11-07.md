## Decided - the owner's answers of 2026-11-07

Decisions, not open questions; this entry is deleted when the last one is carried out.

- **Read-only production queries**: the lead may run read-only `SELECT` and `EXPLAIN` on the
  production database over SSH for the readings its chantiers need (the engagement thresholds, the
  daily cap, post-deploy readings). Never a write, never a schema change: anything else is still the
  delegation of [2026-11-03](owner-decisions-of-2026-11-03-evening.md).
- **Governance by parent (WP-D2) ships as it is**: the associations with no parent become governed
  by the platform admin alone, and parents are set from the Dependances panel as requests arrive. No
  release waits on attaching them.
- **Le Cercle**: the lead merges and releases its merge requests after an adversarial review and a
  green pipeline, and reports afterwards.
- **The engagement chantier ships work package by work package**, each to production after an
  adversarial review, a pass on dev and a phone reading, without waiting for the owner. The
  decisions themselves are in [engagement](../engagement.md) (decisions 1 to 14).
- **The live chat** improves on two axes, readability over the video and liveliness (avatars, the
  host marked, rate-limited "X a rejoint" lines visible to every viewer). It follows the fix of the
  share sheet that opened behind the live viewer.
- **The Dependances panel** is cleaned up (owner: *"Il faut nettoyer un peu cet affichage"*): compact
  rows, the repeated audience warning folded into one summary per BDE.
