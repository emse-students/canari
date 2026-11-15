## Reading owed - NOTIF-6c / NOTIF-6d: the quick reply from a BACKGROUNDED shade, and a reply that fails to send

target: 1.7.0

**What is built:** NOTIF-6c / NOTIF-6d: the quick reply from a BACKGROUNDED shade, and a reply that fails to send (NOTIF-7c/7d and NOTIF-11 passed)

**The reading that closes it:** on the Mi 9T against dev, which sends push (Firebase secret set 2026-10-21; or the local estate): `bun tools/cross-client-harness/archive/k.mjs`, the shade answered by hand, once with the link up and once with it cut

**Triage 2026-11-14 - MERGED with four entries, the same check K shade reading.** (a) **acknowledging a conversation from the shade (NOTIF-6b)**, both platforms: from a web seat send, background the app, tap "Marquer comme lu", OPEN the app - the badge must be gone; then the same with a quick REPLY; `logcat` shows `sendReadWatermark: queued+drained at=<ms>` with the SENDER's instant, never near `now`. (b) **the notification quick reply's 403**: check K steps 1-5 and K2 with the window ARMED ([check K](../device-verification.md#the-backgrounded-run-that-failed-and-the-defect-it-found)); the iOS twin is corrected identically and unproven. (c) **the Mi 9T pass D2 (#1281 a shade reply not re-announced, read watermark merged on resume) and D3 (#1282 the outbox worker)**: one `drainOutboxBackground` "sent id=" line per quick reply, with the app DEAD (a force-stopped app receives no push) and the shade reply typed by hand. **Left: Mi 9T about 40 min (all of NOTIF-6b/6c/6d, K, D2, D3, once with the link up and once cut), iPhone about 20 min (6b and the K twin, a reply typed in the expanded card through WDA).**
