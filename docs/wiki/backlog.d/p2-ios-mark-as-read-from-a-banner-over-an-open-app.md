## P2 - iOS: "mark as read" from a banner over an open app is refused, and its watermark erased

The twin of the quick reply that #2843 hands to the page. `CanariHandleMarkReadAction` clears the
notification and calls `CanariSendReadWatermark`, which queues the watermark in
`outbox_pending.ndjson` and drains it natively. While the page holds a loaded MLS manager
(`canari_ios_page_holds_mls`), the foreground guard refuses that encrypt, and the page's next
`store_outbox_mirror` erases the entry. Peers never learn the read. The fix has the same shape as the
reply: hand the watermark to the page through a durable file and an event, and have the page send it
through `sendReadWatermark` ([mobile](../frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)).
Unmeasured on a phone: the action only became reachable with #2843.
