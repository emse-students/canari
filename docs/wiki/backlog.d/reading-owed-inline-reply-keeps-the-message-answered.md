## Reading owed - P2 - an inline reply from the Android shade keeps the message it answered above "Vous"

target: 1.8.2

Built (2026-11-26): `ReadElsewhereMarks.answerReply` re-posts the conversation's history - the
message answered included - with the reply appended under "Vous", bounded to `MAX_NOTIF_MESSAGES`,
where it used to re-post the reply ALONE on the banner Android 15+ holds after an inline answer
(owner, Android 16: the sender's message vanished from the notification). Pinned by
`ReadElsewhereMarksTest`; the mechanism is in
[social-service](../services/social-service.md) (what the answer shows).

**The reading that closes it**, on the Mi 9T (never the Pixel 6a): receive a DM from a bench account
while Canari is in the background, tap "Répondre" in the shade, send a short reply - the notification
must show the earlier message with the reply under "Vous" below it, not "Vous" alone. Then a second
message from the peer: the thread shows message, reply, new message. Note whether MIUI keeps the
banner after the reply (Android 15+ hold) or removes it (both are correct; only the content of a
banner that stays is read here).
