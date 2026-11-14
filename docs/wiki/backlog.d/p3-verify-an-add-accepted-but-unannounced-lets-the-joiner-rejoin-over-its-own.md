## Reading owed - an accepted but unannounced Add on the rig

target: 1.7.0

A joiner decides its door from its membership row (`readWelcomeOwedFromRow`). An Add the server
ACCEPTED whose answer the adder lost leaves the seat with `admittedAtEpoch` and the joiner's leaf in
the tree, the Welcome owed state on the adder (`owed_welcome.rs`). If the adder no longer holds the add
lock before it settles and no Welcome is queued, both facts are false: the reading is
`unhonoured-seat` and the joiner joins by external commit. **That is NOT the GRP-4 duplicate-leaf
shape**: the external commit carries the same signature key as the leaf the Add wrote, and OpenMLS
removes that leaf in the same commit - the routine rejoin of an active device that lost its state.
Pinned by `mls-core/tests/external_join.rs` (`an_admitted_joiner_joining_externally_leaves_exactly_one_leaf_for_its_key`)
and `recovery.test.ts` ("joins externally on a seat a commit admitted when neither fact holds").
What is owed is a VERIFICATION, not a decision: whether any adder path releases the lock before its
settlement (DUP-2 read `owed`, so the lock was held there), and then what the adder's late Welcome
does when it meets a joiner already in by its own commit (it should be refused as a spent key package
and taken as a redelivery). `getDeviceMemberships` carries `admittedAtEpoch` (it spreads the entity),
typed on `DeviceMembershipRow` since the review of #2466 and named in the recovery's
`unhonoured-seat` line, so a reading of the log tells an admitted seat from a stranded one. It is not
read as owed: a seat whose adder died would then wait for ever, and the join over it is safe.

**Plan (batch 13, 2026-11-11) - not a small fix, an audit plus one rig row.** (1) Read every adder path (`groupCreation.ts`, `actions.ts`, the Android background answer) for a release of the add lock before its settlement; any found is a fix of its own. (2) One rig row: an Add accepted with its answer dropped, the lock expired, the joiner in by its own external commit, then the adder's late Welcome - expected refused as a spent KeyPackage and read as a redelivery, one leaf for the key. MLS work: an agent of its own if you want it run.
