## P2 - the slow-link chantier: no screen waits for the network to draw (owner, 2026-11-10; starts right after 1.6.10)

**Decision.** The owner, 2026-11-10: *"a slow connection is common and a real plague"*. The chantier
starts right after `1.6.10` and is carried to the end, not abandoned at the first improvement.

**Goal.** On a slow link no screen waits for the network to draw. Every screen renders from local
state first, then revalidates ([local-first-ui](../frontend/local-first-ui.md)).

**Known gaps**, from the owner's logs `canari-log-1.6.9-20261110-2059.txt` and
`canari-log-1.6.9-20261110-1810.txt`:

1. The session refresh (4 s at the 20:58 boot, server 17 ms) gates the first reads: the feed,
   the announcement, help-seen and the birthday.
2. Some screens have no local copy: Pour toi, the bell, profiles already seen.
3. Media seen once is not kept, within a size budget.
4. Per-community triplet reads: 27 calls for 9 communities.
5. Duplicate `users/batch`, follow-statuses x8 and `devices/self` x3
   ([audit](../frontend/weak-network-audit-2026-11-10.md), section 4).

**Method.** Measure every screen on a simulated slow link before and after, as in the audit
([method](../frontend/weak-network-audit-2026-11-10.md#1-method-and-what-it-cannot-see)); the number
that closes a screen is its first paint with the network answering nothing.

Already cut on the way (PR for `1.6.10`): today's birthdays read once per Paris day, the no-op
retries silent ([birthdays](../birthdays.md)).
