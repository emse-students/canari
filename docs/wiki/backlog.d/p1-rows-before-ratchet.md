## P1 - rows before ratchet: a live drain stores its rows only when its window closes, after a checkpoint may already hold their ratchet advance (raised by the second review of #3321, 2026-11-15)

target: 1.7.0

A live drain decrypts each frame and buffers its row in the UI's bulk-ingest buffer; the rows are
stored only when the drain's window closes (`endBulkMessageIngest`, `useMessaging.svelte.ts`). A
checkpoint is not ordered behind that close: one started by an earlier window, by a send, or by the
persister's coalescing can land while the window is still open, and it then holds the frame's ratchet
advance and its seen mark while the frame's row exists only in memory. A process kill in that window
(a browser closed, a crash, an app swiped away) loses the message for good: the device cannot decrypt
it again (`SecretReuseError` - the generation is spent on disk) and will not replay it (it is marked
seen). Principle 2 of the [charter](../../principes.md): the essential is never lost.

What already narrows it, and why that is not the fix:

- the drain's ack waits for a checkpoint covering a commit or a Welcome (`DrainAckHold`), so the
  server keeps those rows - but an application message beside them is acknowledged as soon as a
  checkpoint covers it, which can be before its row is stored;
- a demoted tab reloads only once the windows open at its demotion have closed
  (`whenBulkIngestsClosed`, [chat](../frontend/modules/chat.md)); that covers the hand-over, not a kill.

The fix is an ORDER, not a wait: a frame's row is durable before any checkpoint may claim its ratchet
advance - either the drain stores rows as it applies them (and the UI buffer is a render buffer only),
or a checkpoint exports the state only up to the last frame whose row is stored. The test that lifts
it: a drain whose checkpoint lands before its window closes, a kill simulated between the two, and
the reloaded service still holding the message (as a row, or as a frame it can decrypt again).
