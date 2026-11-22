### Fixed - a reply sent from the notifications is never queued without its message

A reply typed in the notification shade, for a conversation this phone had not stored yet, could be queued with no message to show: never sent, impossible to see or delete, and reported as an error on every start. The message is now written before its queue entry, and one already stuck gets its message back, shown failed with Retry. A reply the server refused in the background is now reported as refused, not as five server errors ([outbox mirror](docs/wiki/frontend/mobile.md#outbox-mirror)).
