## P2 - an association's live is ended and moderated by its broadcaster alone, and no chat line is hidden after the end

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

**After the end (owner, 2026-11-15, decision 18).** A chat line is hidden by the live's moderators -
the BDE in scope, the bureau (the holders above), the institution's IM for its own live, the platform
admin - after the live ended, **as long as a report on that line is open**. Today the hide answers 410
from `endedAt` on, staff included, while a `live_chat` report keeps the checked line up to 90 days, so
the moderator can only mute. The open report is the fact that keeps the door open (durable state, no
clock): the hide reads `live_chat_reported_lines` for a pending report naming that line, marks the
line hidden wherever it is still served (the replay's chat, the kept report text is untouched for the
reviewer), and reviews the report. The broadcaster of a personal live is not named by the decision and
keeps the 410. `live_chat` reports reach the bureau's queue for its own lives. No auto-hide of chat
lines (decision 17: they stay with the broadcaster and the bureau).

**Proof.** `lives.integration.spec.ts` on PostgreSQL: a co-holder ends the association's live, removes
a viewer and hides a line; a holder of another association, and anyone on a personal live, gets the
404; a holder's end writes no `live_cuts` row; after the end, a BDE moderator in scope, a holder and the
platform admin hide a reported line, and get the 410 on a line with no open report. The `[LIVE]` rows of the
[grid spec](the-moderation-authority-grid-is-asserted-by-table-driven-specs.md).
