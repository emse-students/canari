## Admin tool - "Voir en tant que": a platform admin sees the feeds as one chosen member sees them

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Asked by the owner on 2026-11-19, its four answers taken the same day ([decisions](../decisions/owner-decisions-of-2026-11-19.md)).
It is a TEST tool: the audience model (campus x formation x public,
`apps/social-service/src/spaces/reader-spaces.ts`, [reform](../spaces-and-audiences-reform.md)) is
hard to check by hand, and the [audience audit](../decisions/audience-audit-2026-11-14.md) had to read it from the
code. With this a platform admin checks it on the real data.

**What was decided:**

- **Who:** platform (global) admins only, like every other moderation tool.
- **What:** the FEEDS and POSTS only - the Campus feed and its tabs, CanaReels, the institutions'
  feeds - exactly as the chosen member's reader spaces select them. **Never their messages**:
  they are end-to-end encrypted and out of reach anyway, and principle 1 of the
  [charter](../../principes.md) protects them. No events, forms, communities or profile in this
  first version.
- **Where:** a "Voir en tant que" button in the admin interface: pick a member, then the feeds
  are shown as that member's reader spaces select them. Read-only: no reaction, comment, vote or
  "seen" mark is written as the member, and none of the member's own state (read marks, ranking
  signals, the daily cap) is touched.
- **Trace:** none. The owner's words: *"Aucune trace, c'est juste un outil de tests."* The
  person is not notified, and no audit row is written. This is the owner's decision against the
  lead's recommendation (an audit-log row). Recorded here so nobody adds one by default.

**Built as (the design the lead owes):** the server computes the feed for the chosen user's reader
spaces (one implementation, the one the member's own feed uses - never a copy), behind the
global-admin guard, from an explicit `asUserId` parameter that the reading user's identity never
supplies. A test proves three things: a non-admin is refused; the admin's result equals the
member's own feed query for the same cursor; and nothing is written on the member's behalf.
Strings go through Paraglide on the first draft.

**Closed when:** it is built, and read on the web by an admin against two test accounts on
different campuses and formations, whose feeds must differ the way the model says.
