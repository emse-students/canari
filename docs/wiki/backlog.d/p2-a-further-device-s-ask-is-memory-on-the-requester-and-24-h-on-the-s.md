## P2 - A further device's ask is memory on the requester and 24 h on the server: make it a server row (decided in review, 2026-10-30, not built) - SUPERSEDED

**Superseded the same day: a device of a member enters by itself, so it asks nobody and this row is moot - see [the 2026-10-30 decision](a-new-device-of-a-member-enters-by-itself-with-a-history-and-a-visible.md).** The reasoning below is kept for the ask that still exists in 1.5.2.

- Today a further device of a member with no seat has no durable ask. The requester re-asks on its
  cadence, about once a minute per group, and the server keeps a stored ask for 24 h.
- The real fix: store the ask as a server row, as a link's ask is (`GroupMember.awaitingAdmission`),
  and let every member's pending sweep re-raise it. The requester then stops asking once the row
  exists. Cost today: [mls-recovery-ladder](../protocols/mls-recovery-ladder.md#a-further-devices-ask-is-decided-once-and-asked-on-the-cadence).
