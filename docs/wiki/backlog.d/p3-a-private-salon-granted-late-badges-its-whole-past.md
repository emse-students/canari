## P3 - A private salon granted to a long-standing member badges its whole past as unread (review of #3682, 2026-11-16)

target: 1.7.0

**What is wrong.** `ChannelService.listUnreadCounts` (`apps/social-service/src/channels/channel.service.ts`)
counts a salon's rows after `GREATEST(readMarks[salon], clearedMarks[salon], channel_members."createdAt",
UNREAD_TRACKED_SINCE_MS)`. A member granted a PRIVATE salon long after joining the community has no
read mark there yet, so the floor is their community join or the 2026-10-08 tracking floor - and the
badge shows every non-own row of the salon since then, not the messages posted after the grant. A
reload already shows that inflated number (the server's count is what a cold start draws). Nothing
records WHEN access was granted: `channels."allowedUsers"` is a bare list, and `grantPrivateChannelAccess`
(and the access rewrite that adds a user) writes only the name.

**The question to settle**: should a salon's unread floor be the moment access was granted? The
recommended answer is yes, under principle 3 of [the charter](../../principes.md) (*your attention is
not for sale*): a badge counts what arrived for you, and a past you were just handed is history to
read at leisure, not a backlog to clear. The past stays readable (principle 2 is untouched): only
the count changes.

**The change to make, without a migration.** At every grant (`grantPrivateChannelAccess`, and the
access rewrite at the `nextAllowed` write when it adds a user), raise the grantee's
`channel_members."clearedMarks"[salon]` to the grant instant, with the same only-raise `GREATEST`
merge `clearWorkspaceUnread` uses (migration 082). `clearedMarks` is the PRIVATE floor - never the "Lu par"
receipt other members see - so it claims nothing the member did not do, and `listUnreadCounts`
already reads it: the query itself needs no change. A revoke leaves it (a re-grant raises it again).
The alternative - a `grantedAt` per (salon, user) read by the query as a fifth `GREATEST` term - costs a
migration for the same answer.

**The test that proves it**: in `channel-unread-counts.spec.ts` (or beside the grant's own spec), a
grant writes `clearedMarks[salon] = now` for the grantee and never lowers a higher one; and in
`tools/cross-client-harness/unread-communities.mjs`, which measures the SQL against the real database,
a member of a community with ten earlier rows in a private salon is granted it, a peer posts one row,
and `GET` unread counts answers `1` for that salon, not `11`.
