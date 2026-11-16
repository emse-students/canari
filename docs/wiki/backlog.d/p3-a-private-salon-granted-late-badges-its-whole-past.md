## Reading owed - a private salon granted late badges only what is posted after the grant

target: 1.7.0

**What is built** (owner's decision (12) of [2026-11-16](owner-decisions-of-2026-11-16.md), principle 3
of [the charter](../../principes.md)): every write that lets a member see a salon's past - a grant
(`grantPrivateChannelAccess`: an accepted invite, an admin join, a member added from the panel), an
access rewrite that adds a name to a private salon, a private salon made public - raises that member's
PRIVATE floor `channel_members."clearedMarks"[salon]` to the grant instant, on the database clock,
only-raise, in the grant's transaction (`ChannelService.floorUnreadAtGrant`). No migration, no query
change (`listUnreadCounts` already reads the floor), the "Lu par" read mark untouched, the past still
readable. Before, a member granted a salon long after joining the community was badged every row
since their community join. Mechanism and locks:
[chat](../frontend/modules/chat.md#a-salons-badge-starts-at-the-grant-owner-2026-11-16).

**Proven by tests, not yet read live:** `channel-grant-unread-floor.integration.spec.ts` on PostgreSQL
(ten rows of past, a grant, one row after it: the count is 1, not 11; a higher floor is never lowered;
the rewrite adding a name and the salon made public), `channel-access-announcement.spec.ts` (who is
floored per kind of rewrite, and the lock mode), `distribution-group.spec.ts` (the admin join).

**The reading that closes it:** on dev, `bun tools/cross-client-harness/unread-communities.mjs run
grantlate` (the owner of a community makes a fresh private salon, posts ten messages, grants the reader
through the access panel, posts one more; the reader restarts): the reader's badge on that salon reads
`1`, its floor is written and one row lies after it, and its read mark has not moved. Or by hand on a
bench phone: an account granted a private salon with history sees a badge of what follows only.
