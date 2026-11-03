## P1 - a DM read while both devices are online never shows as read: the gateway dropped the server time of live frames (found 2026-11-03, fix in review)

Seen first as "a DM opened on the iPhone never shows as read on the sender's Mi 9T" (`1.6.3-alpha.7`).
Not iOS, not a privacy setting (there is no per-member read-receipt setting): every `read_watermark`
received LIVE is refused with `[READ] REFUSED ... the frame carries no server time to bound it`,
because the gateway rebuilt the WebSocket frame without the `createdAt` chat-delivery publishes, and
since `v1.6.0` (#2824) a server-clock mark is accepted only under its frame's server time. Measured on
dev 2026-11-03: iPhone -> Mi 9T and web -> Mi 9T stay on one check; the iPhone's own mark is refused
on the same account's web device, so the cross-device read state of a DM fails the same way. A frame
PULLED from the queue carries `createdAt`, which is why older marks did show. Mechanism and fix:
[chat](../frontend/modules/chat.md#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31).

**Owed after the fix deploys to dev:** the same two-phone reading (Mi 9T sends, iPhone opens, the Mi 9T
shows the read state within seconds), the reverse direction, and one own-device reading (iPhone reads,
the same account's web tab drops its badge without a reload). Delete this file when the stable ships.
