## Reading owed - a 13 MB attachment: the bytes out of the outbox row, an evicted blob parked as `upload_error`

target: 1.7.0

**What is built:** a 13 MB attachment: the bytes out of the outbox row, an evicted blob parked as `upload_error` ([offline-and-weak-network 13.7](../frontend/offline-and-weak-network.md#137-the-file-leaves-the-outbox-row-bytes-in-indexeddb-a-key-in-the-row-2026-10-11))

**The reading that closes it:** on the Mi 9T, the 13 MB send with its `[OUTBOX] ... durable write took N ms` and `payload read in N ms` lines (peak, wait before the first byte, no freeze); on the iPhone 12, kill the app with a queued 13 MB file and relaunch (the send completes, or the bubble shows `upload_error`), and one real file sent on a bad link (progress, cancel, retry)

**Triage 2026-11-14 - left: the Mi 9T 13 MB send with its two log lines (about 15 min) and the iPhone kill-with-a-queued-file (Wi-Fi off, about 20 min).** "A real file sent on a bad link (progress, cancel, retry)" is DELETED: no link shaper exists on the bench, and the queued-file halves read the same code.

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, alpha to beta DM, a 13 000 000 byte file chosen in the system picker):** `outboxBlob.put` (13 000 000 bytes) 93 ms after the bubble was added, `payload read in 469 ms (13000000 file bytes)`, `encryptAndUpload ... single block`, upload 10.7 s, then `sent`; the bubble drew "m6-13mb.bin 12,4 Mo". The build logs no `durable write took N ms` line (the `put` line is the durable write). No freeze was measured with an instrument; the screen kept answering. A file set through CDP from a device path fails with `NotReadableError` and parks the files: that is the rig's path, not the product's. **Left: the iPhone kill-with-a-queued-file half.**
