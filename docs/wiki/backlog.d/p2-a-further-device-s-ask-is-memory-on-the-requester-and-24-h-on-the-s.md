## P2 - A further device's ask is memory on the requester and 24 h on the server: make it a server row (decided in review, 2026-10-30, not built)

**Still open as built on 2026-10-31**: a member's new device asks nobody to TAP any more, but it
still sends a `welcome_request` that a member's device answers with its automatic Add
([the decision](a-new-device-of-a-member-enters-by-itself-with-a-history-and-a-visible.md)), so a
device with no seat and no member's device online depends on its own cadence.

- Today a further device of a member with no seat has no durable ask. The requester re-asks on its
  cadence, about once a minute per group, and the server keeps a stored ask for 24 h.
- The real fix: store the ask as a server row, as a link's ask is (`GroupMember.awaitingAdmission`),
  and let every member's pending sweep re-raise it. The requester then stops asking once the row
  exists. Cost today: [mls-recovery-ladder](../protocols/mls-recovery-ladder.md#a-further-devices-request-is-answered-by-an-automatic-add).
