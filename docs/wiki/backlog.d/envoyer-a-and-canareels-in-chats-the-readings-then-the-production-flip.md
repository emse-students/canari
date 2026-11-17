## "Envoyer a..." to several targets and CanaReels in chats: the 13 readings, then the production flip

target: 1.7.0

Built and merged (RC-12 the sheet, RC-13 the outbox take row, RC-14 the media-service holds with
migration 122, "Annuler/Supprimer partout" #3154), all behind `CHAT_REEL_WRITER_ENABLED` - on in
pre-release store builds and on dev web, off in production (owner, 2026-11-08).

Left, in order: the 13 bench readings of
[section 21.4](../frontend/modules/reels-in-chat.md#214-the-bench-readings-before-the-flip) on a
pre-release, then a NEW one-line flip pull request (not the stale #2861,
[21.1](../frontend/modules/reels-in-chat.md#211-the-switch-and-the-flip-pr)). Not built and not part
of the flip: salons (RC-8, moved to `1.7.1`, [reels-in-salons](reels-in-salons.md)); the photo through
the sheet was built on 2026-11-16 as ordinary image messages
([section 22](../frontend/modules/reels-in-chat.md#22-the-two-paths-owner-2026-11-16)), which also
moved the screens rows 2, 3, 11 and 13 are read on,
both in [section 21](../frontend/modules/reels-in-chat.md#21-what-stands-between-main-and-the-production-flip-2026-11-08).

**Mi 9T as the sender, 2026-11-16 ([section](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-uninstall-sitting-170-alpha5-the-seed-mirrors-wipe-and-the-envoyer-a-rows)), `v1.7.0-alpha.5` on dev (the writer switch is ON there: the sheet and the chat camera's video are offered).** `PASS`: rows 2 (one preparation, one upload, 3 of 3 went, the tiles played on `beta`'s web seat), 4 (a removed target fails alone, ONE named notice, the DM goes), 5 ("Annuler partout" withdrew three queued sends; the release path was not exercised because the take was queued before its upload began), 6, 7, 9 (a Wi-Fi cut and a kill in the upload, both resumed with the server holding k/n, k > 0), 10, 13, and 3 and 11 for the send (3: the same video rests on the adopted file id, no pixel comparison; 11: the 60 s ring was not recorded). **Not taken:** 1 and 12 (the iPhone as phone B), 8 (needs an admin seat), and the iPhone as the sender of every row. The entry stays until those and the flip pull request are done.

**iPhone 12 as phone B, 2026-11-16 (`1.7.0-alpha.5`, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-sixth-sitting-170-alpha5-envoyer-a-rows-1-12-8-partial-and-the-f1-pin-path)):** row 1 PASS and row 12 PASS in French and English (one "[Media]" push with no group title, first push after the language switch). Row 8 NOT READ: the web take was landscape, so the server stored a plain post and the admin's delete never took the reel purge path; it needs a portrait take from a non-admin author.

**Mi 9T as the sender on `1.7.0-alpha.6`, 2026-11-16 ([sixth sitting](../device-verification.md#the-mi-9t-readings-of-2026-11-16-sixth-sitting-170-alpha6-envoyer-a-rows-2-3-6-and-13-from-the-canareels-tab)): the tab's camera is `/camera` (a right swipe from the feed), and "Envoyer a..." is offered on its review.** Row 2 `PASS` (one preparation, one upload, 3 of 3 went, the DM and two groups played on `beta`'s web seat). Row 3 `PASS` with the same-video comparison read on decoded frames and the adopted file id, not on bytes (the publish step's one upload, the chat hold placed before the first send, the post and the group tile both 718x1278 and 4.075 s). Row 6 `PASS` ("Supprimer partout" over three conversations, `released: HTTP 200`, three tombstones on `beta`). Row 13 `PASS` (no salon in the sheet; a salon's camera filmed nothing, a photo only). Rows 1, 8 and 12 stay owed to other sessions.


**Mi 9T, 2026-11-16, `1.7.0-alpha.6`: no row read** ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-fifth-sitting-on-170-alpha6-the-salon-badge-and-grant-rows-the-live-bars-the-push)). The sheet is offered only on the CanaReels TAB's review of a video (`sendToOffered` needs `destination === 'feed'`); the composer's camera reviews with "Suivant" and the reel viewer's "Partager" is the older salon share sheet. The tab's own camera was not reached, and rows 2 to 9 also need a third conversation account. Next sitting: find the tab's camera first, then rows 2, 3, 6, 13 with `beta` as the receiver.

**iPhone 12, eighth sitting, 2026-11-16 (`1.7.0-alpha.6`, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-eighth-sitting-170-alpha6-the-envoyer-a-rows-2-to-8-10-11-and-13)):**

- Row 2 PASS: one take to a DM and two groups, one preparation, 3 of 3 went, played on the other seat in all three (a second group stood for the second DM: two usable accounts).
- Row 3 PASS: the chats adopt the published file (`adopts the published file`), the hold placed before the send; identity rests on the file id, no pixel comparison.
- Row 4 PASS: removed from G1 while queued offline, one named notice, 1 of 2 went, the bubble read "Non envoye : vous ne faites plus partie de cette conversation"; the toast was not seen on screen.
- Row 5 PASS for the queued case (3 withdrawn, nothing uploaded); `[UPLOAD-RELEASE]` was not exercised.
- Row 6 PASS: a plain delete of one left the other two, "Supprimer partout" cleared them all on the other seat and released the file.
- Row 7 PASS: the sender's other device offers only a plain delete and keeps the shared file.
- Row 8 PASS on the second attempt (portrait, non-admin author, admin purge, durable "supprime" after a kill with the network cut); the first attempt showed that a purge does not remove a copy a device already fetched.
- Row 9 NOT READ on the iPhone: the upload ends in 2 s and the airplane switch takes about 90 s to settle, so no upload could be cut; the Mi half is on the wiki.
- Row 10 PASS with a thin proof: the kill landed during preparation by timing, the relaunch prepared again and sent each target once.
- Row 11 PASS in a DM (60.16 s on the other seat, one bubble); the group half was not taken on the iPhone.
- Row 13 PASS: no salon in the sheet, a salon's camera yields a photo.

Rows 1 and 12 were read earlier (sixth sitting); the iPhone alone does not close all 13: row 9 and the group half of row 11 rest on the Mi 9T sitting. One P3 defect, the sheet's chip showing a raw id, fixed in the two-paths pull request ([reels-in-chat section 22](../frontend/modules/reels-in-chat.md#22-the-two-paths-owner-2026-11-16)); a read on a pre-release is owed with the other rows. The entry stays open; the flip pull request closes it.

**iPhone 12, ninth sitting, 2026-11-17 (`1.7.0-alpha.7`, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-17-ninth-sitting-170-alpha7-the-envoyer-a-rows-on-the-new-screens)): rows 2 (video AND photo), 3, 11 (DM AND group) and 13 retaken on section 22's screens, all PASS on the iPhone.** The review reads "Publier" and "Envoyer a..."; the conversation camera reads "Envoyer a <name>", the name button sends one bubble and returns to the conversation, "Ajouter des destinataires" pre-ticks it and a second target went in ONE take; a photo from the tab arrived as an ordinary image in each chosen conversation; no salon is offered. The old "a take opened its review with Suivant" oddity did not recur in seven reviews. Observed once and not separated: the idle tab camera lost its microphone 41 s after a send (`photos only` warnings), see the sitting.
