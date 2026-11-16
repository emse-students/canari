## "Envoyer a..." to several targets and CanaReels in chats: the 13 readings, then the production flip

target: 1.7.0

Built and merged (RC-12 the sheet, RC-13 the outbox take row, RC-14 the media-service holds with
migration 122, "Annuler/Supprimer partout" #3154), all behind `CHAT_REEL_WRITER_ENABLED` - on in
pre-release store builds and on dev web, off in production (owner, 2026-11-08).

**The flip is merged (2026-11-16):** `CHAT_REEL_WRITER_ENABLED = true` in every build, its
preconditions re-read ([21.1](../frontend/modules/reels-in-chat.md#211-the-switch-and-the-flip-pr):
the `minClientVersion` floor `1.6.6` on both estates is above every reader, so the floor does not
move and no legacy fallback text is owed). The stable carries it only if it lands before the last
`1.7.0` pre-release is cut.

Left: the 13 bench readings of
[section 21.4](../frontend/modules/reels-in-chat.md#214-the-bench-readings-before-the-flip), none
recorded yet, read on a `1.7.0` pre-release carrying the flip before the stable ships it (rows 1-13:
RC-0 on the iPhone, one take to three targets, feed and chats, a refused target, "Annuler partout",
"Supprimer partout", the sender's other device, a moderator's purge, weak network, a kill during
preparation, the chat camera's single send, the lock screen, no salon offered). Not built and not part
of the flip: the photo through the sheet (D-photo, needs a server hold change) and salons (RC-8),
both in [section 21](../frontend/modules/reels-in-chat.md#21-what-stands-between-main-and-the-production-flip-2026-11-08).
