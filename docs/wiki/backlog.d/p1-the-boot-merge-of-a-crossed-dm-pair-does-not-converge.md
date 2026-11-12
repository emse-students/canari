## P1 - the boot merge of a crossed 1:1 pair does not converge between the two peers

Found in the review of #3406 (2026-11-12). Not fixed there; it needs its own pull request with an
adversarial (opus) review.

**The mechanism.** Two 1:1 groups for the same pair of people (A and B) exist when both sides
started the conversation independently. At each boot, `mergeDirectConversationDuplicates`
([conversations.ts](../../../frontend/src/lib/utils/chat/conversations.ts)) keeps the most recently
updated row by `updatedAt`. It moves the other row's messages into the kept one, deletes the other
row locally, and calls `deleteGroupOnServer` on the other group.

**Why it can diverge.**

- Each device computes the choice from LOCAL facts. A row re-keyed by a Welcome carries the old
  row's `updatedAt`, so the two rows can tie.
- The two peers can each keep a different group and delete the other's choice on the server. Both
  groups are then gone, or each person sits on a group the other no longer reads.
- Discovery ignores a second 1:1 for a peer that already has one, so nothing re-joins the split.

**Scenarios a fix must cover** (the reviewer's):

1. Both peers hold both groups.
2. A partial re-join: one peer was re-admitted to one group only.
3. A group from which one device was evicted.
4. A second device of one account, whose boot merge runs on its own.
5. A crash between the two writes (the rows moved, the losing row not yet deleted).

**What converges.** Two shapes, either of which is enough on its own:

- A key both peers compute the same way, from facts both hold: the lowest group id, or the
  server's `createdAt` of each group.
- Never deleting on the server a group the peer may still hold, and leaving that group's end to a
  server rule.

The Welcome-time move of a re-keyed 1:1's stored rows (#3406) leaves this decision to the boot
merge on purpose ([history-reconciliation](../protocols/history-reconciliation.md)).
