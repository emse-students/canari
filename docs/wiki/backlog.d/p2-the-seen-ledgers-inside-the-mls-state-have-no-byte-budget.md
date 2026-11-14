## P2 - the seen ledgers inside the MLS state have no byte budget, and their caps allow about 43 MB per checkpoint

target: 1.7.0

Found by the review of #2515 (2026-11-15). Since KILL-2 the seen-ciphertext ledgers travel inside the
MLS state, so EVERY checkpoint serialises, seals and writes all of them, where `localStorage` wrote
one group at a time. Their only bounds are counts (`seenLedgerBounds.ts`): 5 000 fingerprints
(`<len36>:<hash36>`, about 16 bytes in JSON) plus 5 000 row keys (`<ms>-<seq>`, about 18 bytes) per
group, and 256 groups. At the caps that is about 170 kB per ledger and **about 43 MB per checkpoint**
- against a checkpoint the send path already avoids awaiting because it costs 1.7 s on a phone. The
busiest bench profile measured 169 ledgers and 247 kB on 2026-10 (before the move).

**Why this is a defect check and not a reading.** The worst case follows from the caps by
arithmetic; no phone has to be read to know that 43 MB in every checkpoint is unacceptable. A reading
of the `app ledgers <keys>x<bytes>B` composition line on one profile would only say where that
profile stands today, and would pass while the bound stays broken.

**The budget proposed: 1 MB of `app_ledgers` in the state, at the caps** - four times the busiest
measured profile, and small next to the state itself.

**Closed by:**

1. a deterministic test (no clock) that fills every ledger to its caps with entries of the maximum
   length the shapes allow and asserts that the staged `app_ledgers` serialise to at most 1 MB. It
   fails on today's caps;
2. the fix that makes it pass: a TOTAL byte cap across ledgers, evicting the least recently written
   ledger first as `MAX_LEDGERS_PER_USER` already does, or lower caps. An eviction costs that group
   one re-walk;
3. the composition line staying as the field witness, at ERROR level when the bytes ever exceed the
   budget (a broken bound, never a routine line).

Mechanism: [mls-desync-prevention](../protocols/mls-desync-prevention.md#the-ledgers-that-describe-the-state-travel-inside-it-kill-2-2026-10-26).
