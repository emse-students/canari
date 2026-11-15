## P2 - an association's live is ended and moderated by its broadcaster alone

target: 1.9.0

**Owner, 2026-11-15** ([moderation-authority](../moderation-authority.md), decision 7): an
association's live can be ended and moderated (chat lines, viewers) by the association's other
`POST_AS_ASSO` holders, not only by the broadcaster.

**Today.** `POST /lives/:id/end`, `POST /lives/:id/removed-viewers` and the chat line hide each compare
the caller with `row.broadcasterId` (`LivesService.end`, `LivesService.removeViewer`, and `own ||
isStaff` in `LiveChatService`, `apps/social-service/src/lives/`). If the broadcaster leaves the screen
or misbehaves, the association can do nothing - while every holder already deletes the association's
posts (`isPublisherOf`, `posts/posts.service.ts`).

**The change.** ONE predicate, "speaks for this live": its broadcaster, or - for a live in an
association's or institution's name - a holder of `POST_AS_ASSO` in it (the `isPublisherOf` rule, read
from the live row's association). `end`, `removeViewer` and the chat hide read it instead of the bare
comparison. It is not a cut: a holder's end records no strike, the ladder stays the staff's. Each
refusal keeps its existing 404 `LIVE_NOT_FOUND`, so the route is no oracle. The live screen is served
a capability so a co-holder watching draws the controls.

**Proof.** `lives.integration.spec.ts` on PostgreSQL: a co-holder ends the association's live, removes
a viewer and hides a line; a holder of another association, and anyone on a personal live, gets the
404; a holder's end writes no `live_cuts` row. The `[LIVE]` rows of the
[grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
