## P2 - a group call holds one device per user: prove the second device replaces the first

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

Group-call keys are per user, so two devices of one person must never both be in one group call
(decided 2026-11-13, reversible:
[open-questions](../open-questions.md#a-group-call-holds-one-device-per-user-decided-2026-11-13-reversible)).

**The call-service half is in (WP-GC8, 2026-11-16)**: the relay's wire is written in
[calls](../frontend/modules/calls.md#one-device-per-user-the-relays-wire-wp-gc8-2026-11-16) - the
replaced device gets `PeerLeft` naming nobody, every other participant ONE
`PeerReady { peer: <same user id> }` without `resumed`, no third leg - and pinned by
`tests/p2p_signalling.rs` (a sibling in a three-party mesh, and a participant away during the
replacement).

**What is owed: the client half**, after WP-GC6 (both touch `CallService.ts`): `onPeerReady` /
`legForPeerReady` drop the leg held for a re-announced `peer` without `resumed` and build a new one,
and `CallService.p2p.test.ts` drives it with THAT wire (the same `peer`, never `bob:seat-b2`) - the
replaced device's leg closes, the call does not end. Reading: a participant switching from the phone
to the desktop mid-call, the two others keep hearing them. Delete when the client test is in.
