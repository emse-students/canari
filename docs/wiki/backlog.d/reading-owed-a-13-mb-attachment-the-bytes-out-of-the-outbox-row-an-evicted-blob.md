## Reading owed - a 13 MB attachment: the bytes out of the outbox row, an evicted blob parked as `upload_error`

target: 1.7.0

**What is built:** a 13 MB attachment: the bytes out of the outbox row, an evicted blob parked as `upload_error` ([offline-and-weak-network 13.7](../frontend/offline-and-weak-network.md#137-the-file-leaves-the-outbox-row-bytes-in-indexeddb-a-key-in-the-row-2026-10-11))

**The reading that closes it:** on the Mi 9T, the 13 MB send with its `[OUTBOX] ... durable write took N ms` and `payload read in N ms` lines (peak, wait before the first byte, no freeze); on the iPhone 12, kill the app with a queued 13 MB file and relaunch (the send completes, or the bubble shows `upload_error`), and one real file sent on a bad link (progress, cancel, retry)

**Triage 2026-11-14 - left: the Mi 9T 13 MB send with its two log lines (about 15 min) and the iPhone kill-with-a-queued-file (Wi-Fi off, about 20 min).** "A real file sent on a bad link (progress, cancel, retry)" is DELETED: no link shaper exists on the bench, and the queued-file halves read the same code.
