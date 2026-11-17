## Reading owed - an institution's moderator moderates its own content, and no student

target: 1.7.0

**What is built** (owner, 2026-11-15, decisions 3 and 4 of
[moderation-authority](../moderation-authority.md#the-decisions-of-2026-11-15-owner)): the door
`MODERATES_SOMEWHERE_SQL` opens to `MODERATE` held in an institution; the publisher predicate
`moderatesPublisherSql` ORs in the institution half (`institutionModeratesOwnSql`), so its posts, lives,
the comments under them and the comments in its name follow; `bdeModeratesUserSql` no longer counts an
institution governing a space. The client door (`holdsModerationDoor`) and the members editor
(`offersBdeOnlyFlag`: `MODERATE` offered on every institution) mirror it. Proved against PostgreSQL in
`apps/social-service/src/spaces/bde-moderation.integration.spec.ts` ("an institution's moderators");
nothing renders it in a browser.

**The reading that closes it**, on dev in a browser: as the platform admin, open an institution's
members and grant "Moderer" to a test account (the box is offered); as that account, the admin shell
opens on the moderation queue, a report on the institution's post is listed and the post hides and
comes back from its menu; a student's comment under that post shows its bin. Then, as the same
account, a mute of a student is refused with the "outside your spaces" wording. Any dev row written
goes to the harness's written-ids list. The admin shell staying shut, or the hide refused, is a FAIL.
