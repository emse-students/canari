## P2 - rows before ratchet: a community key frame is decrypted before its seed is stored (review of #3851, 2026-11-19)

target: 1.8.0

Outside the ledger the decrypt half built
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)): a
frame of a community's Graine key-distribution group is opened by `BaseMlsService.openDistributionFrame`
(called from `routeDistributionFrame`, both the first open and the epoch-gap step loop) and takes no
`RowsOwedLedger` mark. A checkpoint can export the advance while the seed the frame carries is not
stored yet; a kill there spends the generation on disk and loses the seed, so the salon stays
unreadable until a seed answer is asked again.

**What closing it needs.** Mark the frame owed right before `openDistributionFrame` and settle it once
the seed is filed (`filed`/refused/kept), never across `stepDistributionGroup`, which applies commits
and may await a checkpoint - the same invariant `handleKnownGroup` keeps. A test in the style of
`setupMessageHandler.rowsOwed.test.ts`: a checkpoint taken while the seed's write is pending exports
only after it. **Size: 1 day**, Opus review.
