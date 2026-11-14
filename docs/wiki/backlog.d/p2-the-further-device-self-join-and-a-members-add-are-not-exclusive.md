## P2 - before D1 opens: a further device's self-join and a member's Add of it are not exclusive on the server

target: 1.10.0

The first condition of lifting `FURTHER_DEVICE_SELF_JOIN_OPEN`
([the gate](../protocols/mls-availability-no-holder.md#the-gate-d1-waits-for-d2-and-d3-on-every-member-client),
review of #2832). Not reachable while the door is shut.

When a further device's `welcome_request` carries `selfJoinIfNobody` and the server answers that no
member device is online, the server withdraws the stored ask from Redis
(`withdrawStoredWelcomeRequest`). It does not touch the device's `pending` row in
`dm_device_group_memberships`, which `GET mls/invitations/pending` (`getPendingInvitations`) keeps
serving. A member device that connects in that window runs `processPendingInvitations` and builds an
Add of the device, while the device builds its own external commit. Both sit on epoch E; the strict
epoch gate takes one and the loser rebuilds (`mls-core/tests/further_device_door.rs`, both orders).
That converges, and it is a race that heals - a defect by the rules.

**The fix makes the two doors exclusive where the server decides**, one of:

- a durable state on the device's row (the `status` enum is `pending | active`, so this is a
  migration: a third value, or a column) set when a `selfJoinIfNobody` ask is answered
  `no_peer_online` with the door open; `getPendingInvitations` leaves it out; the accepted external
  commit clears it (it activates the row), and so does the next plain ask;
- or the commit gate refuses an Add whose target device is in that state.

**Its test:** both orders over the real gate - the self-join answered first, then a member's pending
read (nothing served) and its Add (refused, or never built); and a member's Add accepted first, then
the device's join (`welcome_owed` on the seat served with the base, never built).
