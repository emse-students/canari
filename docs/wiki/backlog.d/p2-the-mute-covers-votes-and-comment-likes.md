## P2 - a muted account still votes in polls and likes comments

target: 1.9.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md#sanctions), decision 9): the
mute extends to votes, comment likes and nicknames. Community and group messages stay outside it,
because each place regulates itself. Account suspension is a
[the suspension, decided 2026-11-19](a-platform-admin-suspends-an-account-in-canari.md), not this entry.

**Today.** `assertNotMuted` (`apps/social-service/src/posts/posts.controller.ts`) guards a post, a
reaction, a comment, republications, reposts and follow requests, and lives and their chat check the
mute in `lives/lives.service.ts` and `lives/live-chat.service.ts`. `votePoll` and `likeComment` (same
controller) do not. The nickname half is
[its own entry](p2-a-reported-community-nickname-reaches-the-community-moderators.md).

**The change.** `votePoll` and `likeComment` call `assertNotMuted` first, with the existing refusal and
its code. The served `canVote` and a comment's like control read the mute, so the client never offers
a gesture the server refuses. The `muteUser` docblock (`moderation/moderation.service.ts`) points at
the page's sanctions table, the one copy of what the mute covers.

**Proof.** A controller spec per route (a muted caller is refused, an unmuted one passes), and an
assertion that every participating route of `PostsController` either calls `assertNotMuted` or is
named in an explicit exemption list - so the next participating route cannot forget it. The `[MUTE]`
rows of the [grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
