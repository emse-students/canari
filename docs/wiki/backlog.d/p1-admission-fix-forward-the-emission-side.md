## P1 - the admission fix-forward, slice 3: a user holding no leaf asks a member instead of entering a group conversation alone

target: 1.9.0

Slice 3 of [the admission fix-forward](../protocols/admission-fix-forward.md#the-slices-in-order),
planned 2026-11-25. **Waits on slice 2's floor** ([the fix-forward](p1-the-admission-rule-fix-forward.md),
`1.8.1`): before every client allowed to connect raises the member-side card, an asker would wait for
ever - so `1.9.0`, the version after the floor can be raised, and not `1.8.1`.

**The change.** `externalJoin` under the conversation door answers `no-leaf-of-user`
(`external_join_standing`, built by slice 1) with a new typed refusal, built before any commit, in
a GROUP conversation; `requestReAdd` then asks a member (`askAMemberToReAddUs`, the further-device
door's path) with NO self-join when nobody answers - a user with no leaf has nothing in the tree to
vouch for it ([mls-availability-no-holder](../protocols/mls-availability-no-holder.md#decisions-taken-2026-10-31)).
Never in a 1:1, where the peer IS the conversation (`entrant-direct-peer` stays legitimate). The
three legitimate producers of `admission_policy.rs` are pinned to the ask instead of the merge.

**What it proves.** The gate's TEST, then - once `minClientVersion` is this build and has served 14
days - the gate's MEASUREMENT: zero `entrant-unhonoured-seat`, `entrant-not-pending`,
`entrant-no-device-row` rows since the floor ([the gate](../protocols/admission-fix-forward.md#the-gate-that-lifts-the-refusal)).

*Size: about one week (mls-core, recovery, tests), then a store cycle for the floor.*
