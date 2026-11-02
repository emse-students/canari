## Decided - the owner's answers of 2026-11-02, for the night he left the lead agent in autonomy

Decisions, not open questions; this entry is deleted when the last one is carried out.

- **`1.6.2`**: the stable ships its pre-release without the owner's own reading.
- **`1.6.3`** carries migration 044 (#2904, the commit-time floor, approved by the owner's hand
  merge): pre-release, then stable, cut by the lead agent if dev stays healthy after the migration.
- **CanaReels in chats** ([reels-in-chat](../frontend/modules/reels-in-chat.md)): finish what blocks
  the writer switch (RC-6, the client-version floor), read it on both bench phones, and turn the
  switch on **for dev only** if the readings pass. Production stays off until the owner says so.
- **Dependency updates and CodeQL alerts**, on every repo: fixed and merged by the lead agent, major
  versions included, once CI is green and an adversarial review has passed.
- **MiGallery faces (#443)**: an unproven chain is accepted automatically at **0.5**, not 0.62. The
  merge waits for a clean review and a dry run whose numbers are trustworthy.
