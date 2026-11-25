## P3 - Android's alerted-messages key lacks the sender: two members in one millisecond are one message (found 2026-11-22)

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

`CanariFirebaseMessagingService.alertedKey` is `<notifKey>:<sentAt>`, and the in-shade match beside it
(`alreadyPosted`) compares the line's timestamp alone. Two members writing in one conversation in the
same millisecond are then one message: the second is "already announced" and does not sound, and in
the shade its line is taken for the first's. The iOS ledger added the sender in #3968 (review, S2:
`<conversation>:<sender>:<instant>`, [ios-notification-ownership](../frontend/ios-notification-ownership.md)).

**Why not in #3968.** The Android key is one of two predicates the comment on `ALERTED_PREFS` requires
to stay the SAME question: the shade's `style.messages` match would have to carry the sender too
(a `MessagingStyle.Message` extra, re-injected with every line), and both triggers - the push and the
socket frame's native build - would have to hand the same sender id down. That is a change to the
builder's shade contract, not to one function.

**What closes it.** The key and the in-shade match both read `(sender, sentAt)`; a test in
`dismissedNotificationReplay.test.ts` (or its successor) holds two senders in one millisecond as two
lines and two alerts; the stored keys of the older format are left to age out of the 128-key bound
(read as unknown, so at worst one message announced again, never one lost).
