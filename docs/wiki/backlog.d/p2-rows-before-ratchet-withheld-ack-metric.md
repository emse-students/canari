## P2 - rows before ratchet: measure the acks withheld on unstored rows, and the poison rows dropped (review of #3851, 2026-11-19)

target: 1.8.0

The follow-up the adversarial review of #3851 left once the decrypt half and the ack were built
([chat](../frontend/modules/chat.md#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)).
Its other half - telling a poison row from a transient write failure - shipped in the same pull
request ([a poison row is dropped](../frontend/modules/chat.md#a-poison-row-is-dropped-not-kept-2026-11-19)).

**A rate, not a log line.** The acks withheld on unstored rows are said once per episode (`[ACK] ...
have rows not stored ...`, then counted), and a dropped poison row says `[DB] POISON ROW` at
ERROR and `logMlsMetric({ kind: 'row_write_poison' })` - but `logMlsMetric` only prints to the local
console, behind `canari_mls_debug`. Neither reaches a place where the RATE against the population can
be read (how many devices, how often, which `errorName`). Route both counts to the server-side metrics
the client already reports (count per episode, platform, error name), so a poison class nobody
predicted - or a transient one that never clears - is found by a query and not by a support ticket.
**Size: half a day.**
