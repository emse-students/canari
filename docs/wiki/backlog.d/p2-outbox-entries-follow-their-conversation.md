## P2 - a queued outbox entry does not follow its conversation: a DM re-key strands it, a removal leaves it asking for a re-add for ever

target: 1.9.0

Found in the review of #3992 ([chat](../frontend/modules/chat.md#adds-to-one-conversation-are-not-serialized-so-an-add-renders-onto-the-row-as-it-is-now-2026-11-23),
"Known limits"). An outbox entry is keyed by its group id, and two events change what that group
means without telling the queue.

**(a) A DM re-key leaves its queued entries on the old group.** A Welcome into a new group for the
same DM peer (`setupMessageHandler`, `upsertConversation(joinedGroupId)`, then `runPendingRekey` and
`moveDirectConversationRows` in `conversations.ts`) moves the map entry, the stored rows and the
pending mutations onto the joined group G2 - not the queued entries. They stay addressed to G1, whose
tree this device lost (that loss is what makes the re-key happen), so they sit in the unsendable
branch asking for a re-add of G1 while the DM lives on under G2. The fix moves them in the same
re-key, under the same lock, as it moves the rows: `conversationId` rewritten to G2, the held clock
cleared so the next flush sends them.

**(b) A removal does not withdraw its group's entries.** `purgeConversation` and
`purgeLocalConversationRecord` know the group id they remove, but only the member's own delete or
leave settles the queue (`drainOutboxForExit`, before the server step). Every other remover - a
deletion by this account on another device, a never-admitted ask that ended, a phantom the server
confirms absent, the local delete of a `deletedRemotely` row - leaves the entry held, and
`requestReAdd` does not stop for a row that is gone (its `removed` guard reads the row): it is asked
again on every flush and every start, and with the account's seat still held its external join
builds the thrown-away conversation back. The fix withdraws the group's entries from the remover, on
the remover's own evidence (the group id it is removing), through the same withdrawal path as
`drainOutboxForExit` - never from an absence in the map, which (a) shows is not proof of removal.

**Tests that close it:**

- re-key while an entry is held: the entry survives, targets G2, and is sent on the next flush once
  G2 is sendable; no re-add of G1 is asked;
- re-key while an entry is mid-send on G1: the send settles first (the lane is awaited), nothing is
  sent twice;
- each non-exit remover (`systemMessageHandler` deletion by own other device, `stopRecovering`'s
  never-admitted purge, `purgePhantomConversation`, `handleDeleteGroupLocally`) withdraws exactly the
  removed group's entries - an entry of another group, and of the DM's new group after a re-key, is
  untouched (an allowlist by group id);
- after such a removal, a flush asks no re-add for the removed group.
