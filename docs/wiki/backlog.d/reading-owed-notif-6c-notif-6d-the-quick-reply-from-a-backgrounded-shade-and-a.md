## Reading owed - NOTIF-6c / NOTIF-6d: the quick reply from a BACKGROUNDED shade, and a reply that fails to send

target: 1.7.0

**What is built:** NOTIF-6c / NOTIF-6d: the quick reply from a BACKGROUNDED shade, and a reply that fails to send (NOTIF-7c/7d and NOTIF-11 passed)

**The reading that closes it:** on the Mi 9T against dev, which sends push (Firebase secret set 2026-10-21; or the local estate): `bun tools/cross-client-harness/archive/k.mjs`, the shade answered by hand, once with the link up and once with it cut

**Triage 2026-11-14 - MERGED with four entries, the same check K shade reading.** (a) **acknowledging a conversation from the shade (NOTIF-6b)**, both platforms: from a web seat send, background the app, tap "Marquer comme lu", OPEN the app - the badge must be gone; then the same with a quick REPLY; `logcat` shows `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never near `now`. (b) **the notification quick reply's 403**: check K steps 1-5 and K2 with the window ARMED ([check K](../device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)); the iOS twin is corrected identically and unproven. (c) **the Mi 9T pass D2 (#1281 a shade reply not re-announced, read watermark merged on resume) and D3 (#1282 the outbox worker)**: one `drainOutboxBackground` "sent id=" line per quick reply, with the app DEAD (a force-stopped app receives no push) and the shade reply typed by hand. **Left: Mi 9T about 40 min (all of NOTIF-6b/6c/6d, K, D2, D3, once with the link up and once cut), iPhone about 20 min (6b and the K twin, a reply typed in the expanded card through WDA).**

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, build `100601202`, the release APK sideloaded; alpha on the phone, the beta web seat as the peer; logcat kept out of the repo).** All six, by hand from the system shade:
- **6b, mark as read** (app backgrounded, alive): `sendReadWatermark: queued+drained at=<ms>` carried the instant of beta's last message (00:04:35), not the tap's (00:09:51); the app opened with the conversation's badge gone.
- **6c, the quick reply from a BACKGROUNDED shade:** `handleReply: queued`, `sendQueuedMessagePush: HTTP 201`, ONE `drainOutboxBackground: ✓ sent id=` for the reply, the read watermark at the sender's instant; beta's seat showed the reply.
- **K, the 403 window ARMED:** a fresh process (killed, relaunched, PIN entered, then HOME), a reply from the shade logged `retrievePushSecret: newer secret adopted from pending_push_secret.txt -> Keystore` and then `HTTP 201`, never 403.
- **6d, a reply that fails** (Wi-Fi and data cut): `POST failed ... stays queued`, `repostReplyPending: ... spinner cleared, actions restored`; the shade drew the reply with "non envoyé, nouvelle tentative en cours" and both actions; `OutboxRetryWorker` was enqueued, and with the radios back the reply went out ONCE (`HTTP 201`, one `sent id=`), beta saw one copy.
- **D3, the app DEAD** (HOME then `am kill`, proved dead): the push woke a new process, the shade reply logged one `sent id=` per reply.
- **D2:** at the next open the reply was not announced again (`showMessageNotification: read from the shade up to at=... -> nothing posted`), `[READ_WATERMARK] 1 entry/entries read`, and the conversation showed no unread.

**Left: the iPhone 12 half only, about 20 min (6b and the K twin, a reply typed in the expanded card through WDA).**
