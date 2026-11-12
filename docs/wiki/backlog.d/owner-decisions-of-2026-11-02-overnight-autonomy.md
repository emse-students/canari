## Decided - the owner's answers of 2026-11-02, for the night he left the lead agent in autonomy

Decisions, not open questions; this entry is deleted when the last one is carried out.

**Carried out and pruned (batch 20, 2026-11-12):** `1.6.2` and `1.6.3` are stables (`gh release
list`; #2904's migration 044 and #2919 first ship in `v1.6.3`); `minClientVersion` reads `1.6.6` on
both estates (public `GET /api/version`); the backlog order was replaced by
[the owner's decisions of 2026-11-11](owner-decisions-of-2026-11-11.md); the video calls' bench
readings are queue item 21's.

- **CanaReels in chats** ([reels-in-chat](../frontend/modules/reels-in-chat.md)): finish what blocks
  the writer switch (RC-6, the client-version floor), read it on both bench phones, and turn the
  switch on **for dev only** if the readings pass. Production stays off until the owner says so.
- **Dependency updates and CodeQL alerts**, on every repo: fixed and merged by the lead agent, major
  versions included, once CI is green and an adversarial review has passed.
- **MiGallery faces (#443)**: an unproven chain is accepted automatically at **0.5**, not 0.62. The
  merge waits for a clean review and a dry run whose numbers are trustworthy.
- **MiGallery faces, three more answers**: a member with 3 to 14 references grows on this deploy
  from PROVEN faces only (a `suggested` face is proof only for a member holding nothing but a
  selfie); a member with no selfie is measured to their ORIGINAL references, never to ones added
  later; replacing a selfie drops the saved snapshot, so an undo returns to the new selfie.
- **Started the same night**: RC-12, the "Envoyer à..." sheet on the main camera, behind the writer
  switch; WP-F7 (register and policy) - WP-F6 was already merged (#2859, 2026-11-01), so it gets a security review after the fact instead, since its own was owed before arming and none is recorded; the content-free wake-up push,
  behind a server switch that is OFF by default
  ([entry](push-payloads-carry-nothing-for-google-and-apple.md)); one local MLS store per account
  instead of one per install ([entry](../backlog.md#owed-a-verification-and-nothing-else)).
- **For the day of 2026-11-02**, answered in the morning:
  - read-only SELECTs on the production and dev databases are always allowed to the lead agent
    (a read-only transaction, aggregates only, no name or id ever enters the repository);
  - MiGallery faces (#443) merge without the owner if the review is clean and the dry run is sane
    (no face that fails to open, convergence in under 6 passes, under 5 % of added faces between 0.45
    and 0.5 of the selfie); otherwise the owner looks first;
  - one local MLS store per account (#2919) ships to production after an A-B-A-B reading on the
    iPhone 12 bench phone;
  - the content-free wake-up push: on for dev if the Mi 9T reading passes, then production for
    ANDROID ONLY until the iOS "notifications without content" P1 is fixed;
  - member reposts: a post of a members-only association or of a list can no longer be reposted;
    existing reposts of such posts stay in the database, inert (no deletion); the consent default for
    personal posts is kept as it is;
  - the chat-reel writer goes ON in production with the next stable if both phones' readings pass and
    dev stays healthy;
  - the iOS "notifications without content" P1 is today's priority on the bench phones.
