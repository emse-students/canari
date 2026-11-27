## P2 - rows before ratchet: the Tauri resume's live-ahead persist bypasses both holds (review of #3851, 2026-11-19)

target: 1.8.5

Outside the ledger the decrypt half built
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)): on a
resume whose reload is skipped because the live manager is ahead of `mls.bin` (`live-ahead`),
`TauriMlsService` writes the live state with `persistState` directly, not through
`persistCheckpoint`. That write neither waits for the frames between their decrypt and their row
(`RowsOwedLedger.hold`) nor stores the buffered rows first (`holdRowsForCheckpoint`), so it can make an
advance durable whose row is only in memory - the loss the two holds exist to prevent.

**What closing it needs.** Route that write through `persistCheckpoint` (or through the same two holds
in the same order), keeping its refusal semantics; a test that a resume's live-ahead write waits for an
owed row. **Size: half a day**, Opus review (native).
