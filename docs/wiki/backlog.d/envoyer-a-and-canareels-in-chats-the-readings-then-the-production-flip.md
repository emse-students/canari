## "Envoyer a..." to several targets and CanaReels in chats: the 13 readings, then the production flip

target: 1.7.0

Built and merged (RC-12 the sheet, RC-13 the outbox take row, RC-14 the media-service holds with
migration 122, "Annuler/Supprimer partout" #3154), all behind `CHAT_REEL_WRITER_ENABLED` - on in
pre-release store builds and on dev web, off in production (owner, 2026-11-08).

Left, in order: the 13 bench readings of
[section 21.4](../frontend/modules/reels-in-chat.md#214-the-bench-readings-before-the-flip) on a
pre-release, then a NEW one-line flip pull request (not the stale #2861,
[21.1](../frontend/modules/reels-in-chat.md#211-the-switch-and-the-flip-pr)). Not built and not part
of the flip: the photo through the sheet (D-photo, needs a server hold change) and salons (RC-8),
both in [section 21](../frontend/modules/reels-in-chat.md#21-what-stands-between-main-and-the-production-flip-2026-11-08).

**iPhone 12 as phone B, 2026-11-16 (`1.7.0-alpha.5`, [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-sixth-sitting-170-alpha5-envoyer-a-rows-1-12-8-partial-and-the-f1-pin-path)):** row 1 PASS and row 12 PASS in French and English (one "[Media]" push with no group title, first push after the language switch). Row 8 NOT READ: the web take was landscape, so the server stored a plain post and the admin's delete never took the reel purge path; it needs a portrait take from a non-admin author.

**Mi 9T as the sender on `1.7.0-alpha.6`, 2026-11-16 ([sixth sitting](../device-verification.md#the-mi-9t-readings-of-2026-11-16-sixth-sitting-170-alpha6-envoyer-a-rows-2-3-6-and-13-from-the-canareels-tab)): the tab's camera is `/camera` (a right swipe from the feed), and "Envoyer a..." is offered on its review.** Row 2 `PASS` (one preparation, one upload, 3 of 3 went, the DM and two groups played on `beta`'s web seat). Row 3 `PASS` with the same-video comparison read on decoded frames and the adopted file id, not on bytes (the publish step's one upload, the chat hold placed before the first send, the post and the group tile both 718x1278 and 4.075 s). Row 6 `PASS` ("Supprimer partout" over three conversations, `released: HTTP 200`, three tombstones on `beta`). Row 13 `PASS` (no salon in the sheet; a salon's camera filmed nothing, a photo only). Rows 1, 8 and 12 stay owed to other sessions.
