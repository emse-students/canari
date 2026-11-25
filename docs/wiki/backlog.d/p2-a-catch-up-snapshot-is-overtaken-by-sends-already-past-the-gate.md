## Reading owed - P2 - a history catch-up is no longer thrown away by sends already past the gate

target: 1.8.1

**Seen 2026-11-24** (a new web device, prod `1.7.3`, 2 min 20 s of restore): 17 lines
`[MLS] catch-up (<group>) state DISCARDED: the live client was mutated N time(s) since the snapshot`,
N from 1 to 14.

**Built (2026-11-25).** The catch-up took the MLS lock, closed the send gate and snapshotted, while a
send that had passed the gate just before was still settling and encrypted after the snapshot. It now
closes the gate, waits out the sends already past it, then takes the lock and snapshots
([mls-desync-prevention](../protocols/mls-desync-prevention.md)). Pinned by
`BaseMlsService.sendSeam.test.ts` and `WebMlsService.catchUpSendGate.test.ts`.

**What closes it, on the first pre-release that carries it:** a NEW web device (fresh browser profile)
restoring the bench account on dev, with conversations that receive traffic during the restore, logs
NO `[MLS] catch-up (...) state DISCARDED` line; a `catch-up (...) waits for N send(s) already past the
gate` debug line, if any, is followed by the catch-up completing.
