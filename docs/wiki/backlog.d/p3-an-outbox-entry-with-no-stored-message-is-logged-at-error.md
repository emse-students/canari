## P3 - an outbox entry with no stored message is logged at error, and a reading met it on an old entry

target: 1.8.0

Seen on the Mi 9T on `1.7.3-alpha.6` (2026-11-22), not part of any row: an ERROR-level
`[OUTBOX] <id>... is queued with no stored message - the send has nothing to show`
(`frontend/src/lib/utils/chat/outbox.ts`) for an entry that was not the sitting's reply - the outbox
also held two older entries for two other conversations. By the noise rule a line is either expected
and necessary (then not an error) or the visible end of something upstream: trace which write leaves a
queued entry with no stored message (a conversation deleted while its message waited? an adoption that
saved the queue entry and not the row?), then either fix the cause or, if the state is legitimate,
say it at the level that matches. The mechanism of the mirror is in
[chat-delivery](../services/chat-delivery.md#the-outbox-mirror-has-two-writers).
