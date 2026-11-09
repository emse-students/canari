## History withheld from a member device that let itself in (built 2026-10-27): what is still owed

The device ask of the 2026-10-27 interim is DELETED (owner, 2026-10-31: the gate is on the user,
never the device - [the decision](a-new-device-of-a-member-enters-by-itself-with-a-history-and-a-visible.md)).
What stays from it, NARROWED on 2026-11-01 (review of #2832): a further device of a member asks
first and lets itself in when no member device can answer (D1, held shut on the server until
`minClientVersion` carries D2/D3), and is then an ordinary added device. Only a KNOWN device id
entering by its own commit under a key other than the one known for it is still said, reported and
withheld history until a member's Add of it
([the trade-off](../protocols/mls-availability-no-holder.md#the-security-trade-off-honestly),
[mls-protocol](../protocols/mls-protocol.md#a-device-of-a-member-is-added-never-asked-about-2026-10-31)).
Owed:

- **the hourly stranded report cannot tell a further device waiting for a member's device to come
  online from a stranded one**: both are a `pending` seat with no Welcome, no add in flight and no
  admission. The device knows which it is (its join answers `further_device`); the report needs that
  fact on the seat - e.g. the `welcome_request` the waiting device sends, recorded per seat - before
  its count can be read as defects again;
- **who can still be flagged honestly**: a device on a client older than the tree-based door still
  joins by itself beside its user's other devices, and is flagged wherever it was never in the group
  - the rollout's cost, until `minClientVersion` carries the door. The departure record's cap
  (`MAX_RECORDED_DEPARTURES`, 8192 per device, oldest evicted) and an observer that joined after a
  device left only widen what reads as `firstInGroup`, so they matter for those older clients alone;
- **an honest device flagged during the rollout** that then adds a new person makes that person's
  device withheld too, by this member, until another member's Add lifts it - and since 2026-10-31 no
  tap lifts a withheld device any more;
- the native background engine keeps no record of withheld devices, so it never marks a device added
  by one (`added_by_unvouched` is set by the app alone); history is answered only by the app, so
  this costs a notice, not a message;
- **a seal is for good, and an honest user can reach one**: a conversation is sealed (no history
  answered there by this member) when the native queue of device events overflowed for it. The
  queue holds 512 events and is emptied only by the app, so a phone whose background engine merges
  for a long time while the app stays closed, in busy communities, can pass it. No path unseals.
  Owed: the seals counted (each is an ERROR line naming its cause; a report of their rate per week);
  and, as a design option NOT built, a lift once every leaf added at or after the overflow's epoch
  has left the tree or been vouched for. **An ordinary sign-out or account switch can seal too**:
  device events taken from an account's state while it is being unbound seal their conversations in
  that account's record, for good, by the same rule - the option above would lift those as well;
- **two tabs of one account merge their records and err towards withholding**: a tab that loaded
  before another tab lifted a device can write that device back - a cost in availability only, never
  an answer to a device that should not have one;
- **the departed bound costs detection**: past it, a conversation is sealed and the records of its
  departed withheld devices dropped, so one of them that later comes back by itself is no longer
  known as withheld there - what it then adds gets no line. History stays closed (the seal); only
  the notice is lost;
- the Android background welcome adds a member's device since 2026-10-31 and keeps no record of
  withheld devices, so a device added from a push by a member's phone is never marked as added by
  an unvouched one; the app reads the commit when it next opens.
