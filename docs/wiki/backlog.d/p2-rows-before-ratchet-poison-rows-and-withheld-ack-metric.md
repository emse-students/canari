## P2 - rows before ratchet: tell a poison row from a transient write failure, and measure the acks withheld on unstored rows (review of #3851, 2026-11-19)

target: 1.8.0

Follow-ups the adversarial review of #3851 left, once the decrypt half and the ack were built
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)).

1. **A poison row is not a transient failure.** A kept row write (`unstoredRowWrites`, a batch kept
   in `unstoredBatches`) is retried by every checkpoint's hold, and while it fails every checkpoint
   is refused and every application ack withheld - until a reload. A write refused for what the row
   IS (a `DataError`, a `DataCloneError`: a row the store will never take) blocks the page exactly
   like a full disk (`QuotaExceededError`) or an aborted transaction (`AbortError`), which a retry can
   pass. Classify at the throw, by `DOMException.name` - a type, never the message - and decide for
   the poison class what it owes instead of a retry that cannot land (and how the frame is still
   kept recoverable). **Size: 1 day**, with a test per class.
2. **A metric for the acks withheld on unstored rows.** The withheld acks are said once per episode
   (`[ACK] ... shown and not stored`, then counted); a `logMlsMetric` kind for them (count per
   episode, platform) would give the RATE against the population, which no log line read by hand
   gives. **Size: half a day.**
