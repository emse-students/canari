## P2 - iOS: "mark as read" from a banner over an open app is refused, and its watermark erased

The twin of the quick reply that #2843 hands to the page. `CanariHandleMarkReadAction` clears the
notification and calls `CanariSendReadWatermark`, which queues the watermark in
`outbox_pending.ndjson` and drains it natively. While the page holds a loaded MLS manager
(`canari_ios_page_holds_mls`), the foreground guard refuses that encrypt, and the page's next
`store_outbox_mirror` erases the entry. Peers never learn the read. The fix has the same shape as the
reply: hand the watermark to the page through a durable file and an event, and have the page send it
through `sendReadWatermark` ([mobile](../frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)).
Unmeasured on a phone: the action only became reachable with #2843.

**Brief (batch 19, 2026-11-12) - native, one agent on the strongest model, an adversarial review.**
Reuse the quick reply's hand-off rather than build a second one ([mobile](../frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)):

1. `CanariHandleMarkReadAction` asks `canari_ios_page_holds_mls` first, like
   `CanariHandleQuickReplyAction`. With no manager loaded, today's native path stands.
2. With one loaded, the action appends ONE sealed line to the same `pending_quick_replies.ndjson`,
   with a `kind` field (`reply` or `read`; a line with no `kind` is a reply, so the file stays
   readable by the build before), naming the notification's `recipientId`, the `groupId` and the
   watermark's message id; it dispatches `canari:quick-reply` as a reply does.
3. The page's take routes a `read` line to `sendReadWatermark`; the account rules of the reply
   (another account's line dropped and said, a line with no recipient refused) apply unchanged.
4. Tests: the take's unit test gains a `read` line, an unknown `kind` (dropped, logged at ERROR) and a
   line with no `kind` (a reply). The phone reading: a "Marquer comme lu" over the open app on the
   iPhone 12, and the peer's read mark observed on the Mi 9T.
