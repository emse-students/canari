## P2 - rows before ratchet: a device-key change re-seals the state without the holds (review of #3851, 2026-11-19)

target: 1.9.0

Outside the ledger the decrypt half built
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)):
`BaseMlsService.changeDeviceKey` re-seals the current state under the new key
(`changeDeviceKeyImpl`), which exports it, without the two holds `persistCheckpoint` takes - the owed
rows (`RowsOwedLedger.hold`) and the buffered rows (`holdRowsForCheckpoint`). A key change during a
drain can therefore make durable an advance whose row is only in memory.

**What closing it needs.** Take both holds around the re-seal, in `persistCheckpoint`'s order, and
refuse the change while a row stands unstored (as a checkpoint is refused); a test that a re-seal
asked while a row is owed waits for it. **Size: half a day**, Opus review.
