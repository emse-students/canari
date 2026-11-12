## P2 - a crossed 1:1 pair: what the convergent boot merge left (2026-11-12)

Found in the review of #3406 as a P1: the boot merge kept the newest `updatedAt`, so the two peers
could each keep a different group and delete the other's choice on the server - both groups gone.
**Fixed:** the survivor is the lowest group id on every device, and the merge is gated on what the
device knows ([history-reconciliation](../protocols/history-reconciliation.md#a-crossed-11-pair-ends-on-the-lowest-group-id-2026-11-12)).
Tests: `conversations.crossedPair.test.ts` (both groups held, a tie, a partial re-join, an eviction
from either group, a second device, a crash between the writes, a mixed old/new pair) and
`serverGroupConversation.crossedPair.test.ts` (discovery).

**What is left, and what would close each:**

1. **A loser held back on the server stays there.** Nothing ends it: every new client ignores it
   (discovery ranks it after the survivor), and it costs one idle group row. Closed by a server rule
   (a second 1:1 for a pair whose lower one is live is retired), or by dropping the recency gate
   below once the dev and production floors pass the version carrying this fix.
2. **The recency gate is a guess at an OLD peer's view.** A 1.6.6-1.6.10 peer still keeps the newest
   `updatedAt` and deletes the other group on the server; the new client holds its own delete back
   when that rule would keep the loser, which narrows the race the old rule always had (both peers
   deleting at once) and does not close it. Closes by itself with the floor.
3. **A stale leaf only in the loser's tree holds the merge back for good** - both rows stay shown,
   nothing is lost. The count is the `[DM_MERGE] ... both rows kept: N leaf(s) of the loser are not
   in the survivor` line; read it on dev before deciding anything.
4. **A Welcome into the higher group re-keys the thread onto it live** (#3406), and the next boot
   folds it back into the lower one. Harmless while both peers hold both groups; not a convergence
   defect, a churn.
5. **No rig reading yet.** One crossed pair on dev (two accounts, each starting the DM offline, then
   both online and rebooted) must show one conversation on every device and no server delete of the
   lower group.
