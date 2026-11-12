## P2 - a reply sent from the notification can be sent twice under one id when its answer is lost

Noted 2026-10-31 while moving conversations to the server's clock, and deliberately left out of that
change. A native background send (the notification quick reply, an outbox drain while the app is
shut) POSTs with a 10 s `readTimeout` (`sendQueuedMessagePush`, `CanariFirebaseMessagingService.kt`):
an answer that arrives later is read as a failure, the entry stays in `outbox_pending.ndjson`, and the
next drain - or the app adopting the orphan at login (`adoptOrphanedMirrorEntries`) - sends the SAME
`messageId` again. A missed `outbox_sent.ndjson` reconciliation does the same from the app's side.
The receivers deduplicate on the id, but the server queues a second row, so every device pays a second
decrypt, and with server-clock ordering the two copies carry two `createdAt`: which one a device keeps
decides where the message is drawn. Unmeasured: how often it happens. First step: count, on
production, queued rows sharing one `messageId` within a group
([chat](../frontend/modules/chat.md#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31)).

**Triage (batch 18, 2026-11-12): the first step as written cannot be taken.** The server never sees
a `messageId`: it is inside the MLS ciphertext, and `queued_message` / `queued_payload` carry only
the delivery record (recipient, device, group, sender, payload) - so no production query can find two
rows of one message. The count belongs where the id is known: the RECEIVER's dedup on `messageId`.
Plan, one client pull request, no agent: where an application message is dropped as already held,
log one line naming the group (short id), whether the two copies came from the same sender device,
and the gap between their server times - a resent quick reply shows as same-device copies seconds
to minutes apart. Then read that line's rate on the bench phones' logs before deciding the fix (an
idempotency key on the send, which the server can check without reading the ciphertext).
