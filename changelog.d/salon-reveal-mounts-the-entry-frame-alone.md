### Fixed - opening a salon shows its last 20 messages first, and no longer floods the console

The reveal mounted 60 rows in one task instead of 20, so the stepped widen never ran; and hiding
the community rail during the open printed ~100 invalid-keyframe warnings. Reveal 340 -> 171 ms on
the desktop bench at CPU x4 ([community-open-budget](docs/wiki/frontend/community-open-budget.md#why-2914-did-not-move-the-clock-and-the-two-cuts-after-it-2026-11-07)).
