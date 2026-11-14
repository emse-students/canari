## P2 - a crossed 1:1 pair: what the 1.6.11 fix left (owner's decision of 2026-11-12)

target: 1.10.0

Found in the review of #3406 as a P1: the boot merge kept the newest `updatedAt` on each side, so
two peers could each delete the other's choice on the server - both groups gone. **Fixed for
1.6.11 by (c):** a device folds only into the lowest group id, and decides nothing otherwise
([history-reconciliation](../protocols/history-reconciliation.md#a-crossed-11-pair-the-lower-id-is-never-deleted-2026-11-12), tests in
`conversations.crossedPair.test.ts`). The owner chose on 2026-11-12: (c) now, then the chantier
below, **server prevention first**.

**What is left, in order:**

1. **Server prevention.** The chat-delivery `createGroup` creates a DM without checking for a live
   1:1 between the same two people. Creation always goes through the server, so it can serialise it
   and answer the existing group, and no new crossed pair appears. Open before building: how the
   pair is known at creation (today the peer is registered after it), and what an old client does
   when it is answered an existing group it does not hold. Test: two concurrent creations for one
   pair end on one group id.
2. **One thread for the pairs that already exist (b).** Both rows and both MLS groups kept,
   presented as one thread keyed to the lowest id; each frame lands on its own row, sends go to the
   survivor, nothing is moved. No client deletes the other group on the server - its end is proven
   by the server (no member device holds undelivered frames for it, nobody has posted in it since a
   post in the survivor), never by a clock. Every reader by conversation id must become alias-aware.
3. **What (c) accepts until then:** two rows for one person when both peers' recency keeps the
   higher id (until a message in the lower group); and in a mixed pair, the new client keeping the
   lower id while the old one keeps the higher still loses both - it closes when the dev and
   production floors pass 1.6.11.
4. **One rig reading on dev:** a crossed pair, both peers rebooted with opposite recencies, ends with
   the lower group alive and no `absent-conversation` refusal for either group.
