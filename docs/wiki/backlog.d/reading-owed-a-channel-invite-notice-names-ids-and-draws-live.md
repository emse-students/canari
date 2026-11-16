## Reading owed - a salon invitation's notice still reads as a sentence, live and from history (2026-11-16)

target: 1.7.0

**What is built:** every reader (live frame and history page) draws a salon `memberAdded` notice from
`{ "newUsers": [id] }` as well as from the legacy sentence
([chat](../frontend/modules/chat.md#a-salons-membership-notice-carries-ids-2026-11-16)); the inviter
still SENDS the sentence (`CHANNEL_NOTICE_IDS_WRITER_ENABLED` is `false` until the floor reads ids).
The id shape is proven by unit tests on both decode sites only.

**The reading that closes it:** on dev, an admin invites account B into a salon; account C reads the
notice centred, on the live frame AND after a reload (history); the row neither counts as unread nor
rings. Also open a salon whose history holds an OLDER sentence notice: it still reads as that
sentence. Any raw `{"newUsers"...}` text on screen is a FAIL. The id shape's own reading belongs to
the flip ([entry](a-salon-invitation-notice-sends-ids-once-the-floor-reads-them.md)).


**Mi 9T half, read 2026-11-16 on `1.7.0-alpha.6` ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-fifth-sitting-on-170-alpha6-the-salon-badge-and-grant-rows-the-live-bars-the-push)): `PASS` for what the bench could stage.** `beta` invited `alpha` (a non-member, after `alpha` left) from the members panel; the thread read the notice centred and neutral as a sentence, with no raw `{"newUsers"...}`, no unread badge and no ring on any salon, and the same line after a document reload. The writer still sends the sentence, so the "older sentence notice" is that very shape. **Left: an account C that is neither the inviter nor the invitee** (the bench's only other accounts are the iPhone's), on any client.
