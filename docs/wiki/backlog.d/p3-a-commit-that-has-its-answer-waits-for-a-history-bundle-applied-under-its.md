## P3 - A commit that has its answer waits for a history bundle applied under its loan (DEV-6, `1.4.1-alpha.6`, 2026-10-26)

target: 1.9.0

The cause is to be read. On the second minted device (W6), two stray-leaf removals of the revoked
first device each got the server's answer while a frame of ANOTHER group held the loan of the MLS
mutex. Both times the borrower was a `history_bundle` system event:

```
info [21:30:12.853] [MLS_LOCK] a frame of a1c4da59… is applied while the commit of b1ecb448… awaits its answer
info [21:30:12.854] [MLS] System event 'history_bundle' from <member> in a1c4da59…
info [21:30:12.856] [MLS_LOCK] the commit of b1ecb448… has its answer - waiting for the frame applied under its loan
info [21:30:12.951] [STRAY] b1ecb448... is now at epoch 74 - the revoked leaves are gone from the tree

info [21:30:13.589] [MLS_LOCK] a frame of 10ddf2b7… is applied while the commit of 1589de4c… awaits its answer
info [21:30:13.615] [MLS_LOCK] the commit of 1589de4c… has its answer - waiting for the frame applied under its loan
info [21:30:13.674] [STRAY] 1589de4c... is now at epoch 57 - the revoked leaves are gone from the tree
```

Each merge was held for about 95 ms and 59 ms (`lendMlsLockWhile` in `mlsPerGroupScheduler.ts`).
Each wait ended without a cut or an error. A bundle's application (store, authorship check, encrypted
checkpoint) is longer than a commit's round trip, so a commit that lends to one waits for it.

Questions:

- should a frame whose application persists a checkpoint be allowed to borrow at all;
- or should the loan be bounded to frames whose cost is known.

The reclaim wait counts against the commit's lock-hold budget (`mayStartCommitRequest`). On a slow
device or a large bundle, this wait could turn a commit's outcome into "unknown".

**Seen again on `1.5.1-alpha.7`** (dev.a062d13, KICK-COMMIT, 2026-10-29): the owner seat (W1) logged
`[MLS_LOCK] the commit of cc3dc2a7… has its answer - waiting for the frame applied under its loan`
at 11:58:00. It is the kick's own commit, so it is not tied to a minted device. The cause is still
unread. Until it is read, the line stays dirt in the removal rows: it is not added to the rig's
classifier.

**Plan (batch 14, 2026-11-12) - a decision first, then MLS scheduler work.** Recommended: a frame lends nothing while its application persists an encrypted checkpoint - known only after decryption, so the loan is returned before a `history_bundle` system event is APPLIED (the store and the checkpoint run after the commit merges), rather than bounded by a clock. Built in `lendMlsLockWhile` (`mlsPerGroupScheduler.ts`) with a test that a bundle under a loan never delays the lender's merge. MLS locking: an agent of its own, with an adversarial review.
