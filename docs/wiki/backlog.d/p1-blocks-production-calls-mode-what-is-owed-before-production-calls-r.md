## P1 (blocks production `calls_mode`) - what is owed before production calls (review of #1997, 2026-10-17)

**The owner decided on 2026-10-21: the first production calls are AUDIO 1:1 ONLY, kept alive in the
background on both phones; video later.** `CALLS_COMPILED` is `true` since #2299 (2026-10-23), so
every build carries in-app calls, and production stays closed by the server's `calls_mode` (`off`)
until the readings. The fifteen blockers (B0-B14), each with its state and evidence, are on
[calls](../frontend/modules/calls.md#the-blockers-each-with-its-evidence), the only copy: the review's
crypto half (per-direction keys, AAD, the mismatch notice: #2013 ported as #2176) and the privacy text
(B5, #2183; no human review of it is owed, owner 2026-10-24) are merged.

P3, owed by WP-C11 (group calls): `refuseIfBlocked` (`calls.service.ts`) lets ANY block between the
caller and ANY other member refuse the whole call, at `initiate`, `ring` and `room-token`, and 1:1 is
enforced only by the client. Acceptable while group calls are off; WP-C11 must decide whether one
block refuses the call or only drops that member
([calls](../frontend/modules/calls.md#the-switches-agree-and-a-silent-frame-stays-unread)).
