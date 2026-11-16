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


**Mi 9T, 2026-11-16, `1.7.0-alpha.6`: no row read** ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-fifth-sitting-on-170-alpha6-the-salon-badge-and-grant-rows-the-live-bars-the-push)). The sheet is offered only on the CanaReels TAB's review of a video (`sendToOffered` needs `destination === 'feed'`); the composer's camera reviews with "Suivant" and the reel viewer's "Partager" is the older salon share sheet. The tab's own camera was not reached, and rows 2 to 9 also need a third conversation account. Next sitting: find the tab's camera first, then rows 2, 3, 6, 13 with `beta` as the receiver.
