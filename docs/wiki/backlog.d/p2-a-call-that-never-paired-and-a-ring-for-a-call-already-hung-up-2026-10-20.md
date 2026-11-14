## P2 - a call that never paired, and a ring for a call already hung up (2026-10-20)

target: 1.8.0

CALL-PAIR-STALL and CALL-LATE-RING, met on the bench while measuring WP-C-BG-I, both after the
Mi 9T's chat socket had gone zombie ([device readings](../device-readings-2026-10.md#found-on-the-way-not-filed-against-wp-c-bg-i)).
Owed first: the dev `call-service` log of that minute (did the callee's `Join` arrive?) and the
iPhone's exported log, before any cause is named.
