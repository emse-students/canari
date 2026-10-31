## P2 - A Welcome the device already applied is delivered again: the key-group spelling too (RMC rows, `1.5.1-alpha.7`, 2026-10-29) - CAUSE NAMED, the key-group fix is merged (#2721) and owes its rig re-read; delete at the stable

- **Named 2026-10-30, from the kept rig consoles: neither a lost ack nor a second mint.** On 11 of
  11 key-group occurrences (RM-4, RM-4b, RM-5, SALON-REVOKE-COMMIT, 2026-10-25..29), the Welcome's
  `qId` is delivered once. In each case, `externalJoin succeeded` for the same group follows within
  200 ms, and every member applies an external commit with `removes=1`.
- The device had judged its seat on a roster read made before an admitter's Add. It then built on
  the base that Add stored, and the admitter's Welcome found the group already built. The dev
  containers had been redeployed, so the server logs were gone.
- The fix judges the seat inside the join, from the seat the server serves with each attempt's base
  (`welcomeOwed: 'ask'`, [channel-encryption](../protocols/channel-encryption.md)).
- The CONVERSATION spelling (`[WELCOME] <group>... already held`, the cold-start item below) is not
  covered by this reading, and stays open.
- Rerun SALON-REVOKE-COMMIT and the RM rows after the deploy: the line must be absent.

- The handler logs the redelivery and drops it as idempotent. There are two spellings in
  `setupMessageHandler.ts`: the conversation one (`[WELCOME] <group>… already held - redelivered
  Welcome ignored (idempotent)`, already met in the cold-start item further down) and the key-group
  one (`[WELCOME] key group <group>... already held - redelivered Welcome ignored (idempotent)`).
- Read on the peer seat (W2) on dev.a062d13:
  - KICK-COMMIT, runs 3 and 4 (11:53:56, 11:58:00);
  - SALON-REVOKE-COMMIT, run 2 (12:05:12).
- The drop is safe, but the delivery is not: a Welcome the device already applied came back, so
  something upstream either sends it twice or does not see the first one consumed. The lead decided
  (2026-10-29) that it stays dirt in the rig, under the same rule as the salon rows, and is not
  forgiven.
- Owed: name what re-sends a consumed Welcome (a server redelivery whose acknowledgement was lost,
  or a second mint for the same device), and remove the second send there. The idempotent drop stays
  as the witness.
