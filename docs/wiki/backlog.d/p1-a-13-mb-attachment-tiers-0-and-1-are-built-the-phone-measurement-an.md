## P1 - A 13 MB attachment: Tiers 0 and 1 are built, the phone measurement and one iPhone check are left (Mi 9T, `1.2.3-alpha.4`, read 2026-10-11)

The copies, the ranking and the design are on [offline-and-weak-network 13.7](../frontend/offline-and-weak-network.md#137-the-file-leaves-the-outbox-row-bytes-in-indexeddb-a-key-in-the-row-2026-10-11). Left:

- **Phone measurement:** the 13 MB send on the Mi 9T with the `[OUTBOX] ... durable write took N ms` and `payload read in N ms` lines; peak and wait before the first byte were derived from a desktop micro-benchmark, not measured on the phone. If the wait is still long, the remaining suspects are the three upload copies (`sessionAuth.ts:245`, `media.ts:739,746`), not the row.
- **iOS WKWebView IndexedDB eviction (owed, ONE iPhone check):** kill the app with a queued 13 MB file, relaunch. Expected: either the send completes, or the bubble shows the `upload_error` card (blob missing -> parked). Nothing here ran on an iPhone.
- **Multi-tab web, the sweep:** the 10-minute grace is a clock guarding a cross-tab race no in-document set can see; a web tab enqueuing a file in the same seconds as another tab's session start, with an enqueue longer than the grace, would see a typed `upload_error` on that attachment. Not reproducible by test (needs two tabs); accepted.
- **Tier 2 (a client size cap)** stays NOT recommended; the 50 MB ceiling now costs ~3 copies of the file, not 4.7 GB.
- **Row-delete cost:** `SqliteStorage.deleteOutboxEntry` now does one extra clear-column `SELECT kind` per delete (to know whether a blob exists); microseconds, noted in case a profile ever shows the outbox. It is guarded: a failed read deletes the row and the blob anyway, never failing the cancel.
