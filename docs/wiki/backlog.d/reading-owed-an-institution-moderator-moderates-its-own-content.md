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
account, a mute of a student is refused with the "outside your spaces" wording, and where the
institution governs a space, no pin control is offered on a post there (`bdePinsInSpaceSql`). Any dev row written
goes to the harness's written-ids list. The admin shell staying shut, or the hide refused, is a FAIL.

**Read in part 2026-11-18 on dev, `1.7.0-alpha.11`, sitting S4 ([readings](../device-verification.md#the-web-rig-readings-of-2026-11-18-s4-170-alpha11-the-false-accusers-cost-and-the-web-rows)).** As the platform admin (`gamma`, W4), an institution's members offered "Modérer" and `delta` was granted it (permissions 128). `gamma` posted as the institution, `beta` commented and reported the post. As `delta` (W5): /admin opened on the moderation queue, "Posts signalés" listed the report, "Masquer le post" hid it (`hiddenByModeration` true) and "Restaurer" in "Posts masqués" brought it back; the student's comment under it showed "Supprimer". **Caveat:** `delta` also holds `MODERATE` in two associations, so the admin door was open already; the hide of an INSTITUTION post still needs the institution half. Seen, not filed: the hidden list names the institution post's author person, not the institution. **Left:** the door opened by the institution grant ALONE (an account with no other `MODERATE`), the mute refused with the "outside your spaces" wording (no mute control was found in the admin shell, and the second grant confounds it), and the pin control where an institution governs a space (dev has none). The grant and the hide were reverted.
